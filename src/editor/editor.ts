// The sandbox editor: one object that owns the workspace (with undo), the compiled chips, the
// live simulation, and the panels around the canvas. Tools, palette and properties talk to it;
// later phases plug in through the registries (palette groups, property sections, toolbar
// actions) and the slots it exposes.
//
// Every change goes through edit() / editWs() (an undo step), a transaction (a drag: one step)
// or volatile() (open tabs, input values: saved, never undone). refresh() then brings the
// library, view, simulation and panels up to date; during a drag it runs once per frame.

import { setUserResolver } from '../lib/resolve';
import { bodyKey, isGenerated } from './hdl';
import type { Vec } from '../sim/geometry';
import type { PowerOnMode } from '../sim/sim';
import { WEAK_H, weakTag } from '../sim/switchsim';
import { type ComponentDef, netlistOf } from '../sim/types';
import { describeBits } from '../sim/values';
import { coarsePointer, h, hintBadge, icon, placeMenu } from '../ui/dom';
import { showKeySheet } from '../ui/keyhelp';
import { settings } from '../ui/settings';
import { closePopover } from '../view/popover';
import type { Compiled, Diag } from './compile';
import { addFolder, findFolder, folderGroups, moveToFolder, newFolderName, renameFolder } from './folders';
import { History } from './history';
import { UserLibrary } from './library';
import { chipDeps, type ChipDoc, type DefOf, type PartRef, type PinValue, type Workspace } from './model';
import type { Sel } from './ops';
import { PalettePanel, toggleFavorite, type PaletteItem } from './palette';
import { isError, keyLabel, partDef } from './parts';
import { MAIN_PROJECT, projectKey, readProjects, touchProject } from './projects';
import { PropsPanel } from './props';
import { AUTO_HZ, EditorSim, HZ_STEPS, type RunMode } from './runtime';
import { activeChip, closeChip, keepVolatile, newChip, openChip, setPinValue } from './session';
import { loadWorkspace, saveWorkspace } from './store';
import { shedActions } from './toolbarfit';
import { Tools } from './tools';
import { EditorView } from './view';
import { Buzzers } from './audio';

export interface ToolbarAction {
  id: string;
  title: string;
  icon: string;
  /** Text after the icon (omit for an icon-only button). */
  label?: string;
  /** Its name in the toolbar's More menu (default: label, else title). */
  menu?: string;
  order: number;
  run(ed: Editor): void;
  enabled?(ed: Editor): boolean;
  /** A toggle that is on (drawn pressed). */
  active?(ed: Editor): boolean;
  /** Only on a campaign level screen. */
  levelOnly?: boolean;
}

const actions: ToolbarAction[] = [];

export interface EditorOptions {
  /**
   * A campaign level screen around one chip: tabs only for it and the chips it uses (no other
   * chips, no New chip), the toolbar actions listed in `actions`, the palette locked to purist
   * (the level's rule) without the groups in `hideGroups`, and the properties panel shown over the
   * canvas while something is selected or while pinned. `first`: the palette groups listed first (default: the
   * unlocked parts, the library's NAND, wiring, constants, My chips).
   */
  level?: { chipId: string; actions: readonly string[]; hideGroups?: readonly string[]; first?: readonly string[] };
  /** The project whose workspace is loaded and saved (projects.ts); default: the current one, the first for a level. */
  project?: string;
}

/** Something that lives as long as an editor (an analysis panel, ...); returns its cleanup. */
export type EditorPlugin = (ed: Editor) => (() => void) | void;
const plugins: EditorPlugin[] = [];

/** Run `p` on every editor created from now on. */
export function registerEditorPlugin(p: EditorPlugin): void {
  plugins.push(p);
}

/** Other kinds of new chip, offered beside New chip (hdlui.ts: a Verilog chip). */
export interface NewChipKind { label: string; hint: string; icon: string; run(ed: Editor): void }
const newChipKinds: NewChipKind[] = [];
export function registerNewChipKind(k: NewChipKind): void {
  newChipKinds.push(k);
}

/** Extra diagnostics of the current chip (lint), listed and drawn with the compiler's. */
export type DiagSource = (ed: Editor) => Diag[];
const diagSources: DiagSource[] = [];

export function registerDiagSource(f: DiagSource): void {
  diagSources.push(f);
}

/** Add a button to the editor's top bar (or replace the one with the same id). */
export function registerToolbarAction(a: ToolbarAction): void {
  const i = actions.findIndex((q) => q.id === a.id);
  if (i >= 0) actions[i] = a;
  else actions.push(a);
  actions.sort((x, y) => x.order - y.order);
}

registerToolbarAction({ id: 'undo', title: 'Undo (Ctrl+Z)', icon: 'undo', order: 10, run: (ed) => ed.undo(), enabled: (ed) => ed.history.canUndo });
registerToolbarAction({ id: 'redo', title: 'Redo (Ctrl+Shift+Z)', icon: 'redo', order: 20, run: (ed) => ed.redo(), enabled: (ed) => ed.history.canRedo });
registerToolbarAction({ id: 'zout', title: 'Zoom out', icon: 'minus', order: 30, run: (ed) => ed.view.cam.zoom(1.25) });
registerToolbarAction({ id: 'zin', title: 'Zoom in', icon: 'plus', order: 40, run: (ed) => ed.view.cam.zoom(0.8) });
registerToolbarAction({ id: 'fit', title: 'Fit to screen', icon: 'fit', order: 50, run: (ed) => ed.fitView() });
registerToolbarAction({ id: 'props', title: 'Properties of the selection or the chip', icon: 'sidebar', label: 'Properties', order: 85, levelOnly: true, run: (ed) => ed.toggleProps(), active: (ed) => ed.propsPinned });
registerToolbarAction({ id: 'help', title: 'Keyboard shortcuts (?)', menu: 'Keyboard shortcuts', icon: 'info', order: 90, run: (ed) => ed.showHelp() });

const withChip = (ws: Workspace, doc: ChipDoc): Workspace => ({ ...ws, chips: { ...ws.chips, [doc.id]: doc } });

/**
 * The workspace as the library compiles it: without input values, which only drive the
 * simulation. Toggling an input then recompiles nothing (the library keys chips by content).
 */
const stripped = new WeakMap<ChipDoc, ChipDoc>();
function compiledView(ws: Workspace): Workspace {
  const chips: Record<string, ChipDoc> = {};
  for (const [id, doc] of Object.entries(ws.chips)) {
    let s = stripped.get(doc);
    if (!s) {
      s = doc.pins.some((p) => p.value !== undefined) ? { ...doc, pins: doc.pins.map(({ value: _v, ...p }) => p) } : doc;
      stripped.set(doc, s);
    }
    chips[id] = s;
  }
  return { ...ws, chips };
}

export class Editor {
  readonly el: HTMLElement;
  readonly history: History<Workspace>;
  readonly lib = new UserLibrary();
  sim: EditorSim;
  readonly view: EditorView;
  readonly palette: PalettePanel;
  readonly props: PropsPanel;
  readonly tools: Tools;
  /** Where later phases put things: over the canvas, between the canvas and the run bar, and in the top bar. */
  readonly slots: { overlay: HTMLElement; bottom: HTMLElement; top: HTMLElement; left: HTMLElement };
  /** Autosave: 'saving' while a save is pending, else the result of the last one. */
  saveState: { state: 'saved' | 'saving' | 'error'; reason?: string } = { state: 'saved' };
  sel: Sel = {};
  compiled!: Compiled;

  readonly canvas: HTMLElement;
  private topEl: HTMLElement;
  private tabs: HTMLElement;
  private actionsEl: HTMLElement;
  /** The toolbar's overflow: actions shedActions moved off a narrow bar. */
  private moreBtn: HTMLButtonElement;
  private moreMenu: HTMLElement | null = null;
  private partsBtn: HTMLButtonElement;
  private topResize: ResizeObserver;
  private controls: HTMLElement;
  private status: HTMLElement;
  private toastEl: HTMLElement;
  private tipEl: HTMLElement;
  /** Shown over a chip with nothing on it: where to start. */
  private emptyEl: HTMLElement;
  private lastWs: Workspace | null = null;
  /** The view shows a drag in progress (a cancelled drag must be redrawn). */
  private dragDrawn = false;
  private lastChip = '';
  private tabsKey = '';
  private paletteKey = '';
  private frame = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveError = '';
  private listeners = new Set<() => void>();
  private unsub: () => void;
  private resize: ResizeObserver;
  private fitted = false;
  private refCache = new WeakMap<object, ComponentDef | null>();
  /** Simulations of recently open chips (least recent first), and the chip this.sim belongs to. */
  private sims = new Map<string, EditorSim>();
  private simChip = '';

  /** A campaign level screen: see EditorOptions.level. */
  readonly level: EditorOptions['level'];
  /** The level's own chip: level.chipId names the walkthrough's chip while it is shown (levelwalk.ts). */
  private readonly levelHome: string | undefined;
  /** The project this editor loads and saves. */
  readonly project: string;

  constructor(chipId?: string, opts: EditorOptions = {}) {
    this.level = opts.level;
    this.levelHome = opts.level?.chipId;
    this.project = opts.project ?? (opts.level ? MAIN_PROJECT : readProjects().current);
    let ws = loadWorkspace(undefined, projectKey(this.project));
    if (!ws.open.length) ws = { ...ws, open: [Object.keys(ws.chips)[0]] };
    if (chipId && ws.chips[chipId]) ws = openChip(ws, chipId);
    this.history = new History(ws);

    this.canvas = h('div', { class: 'sb-canvas' });
    this.view = new EditorView(this.canvas);
    this.view.sound = (tones) => this.buzzers.set(tones);
    this.view.radix = settings.radix;
    this.toastEl = h('div', { class: 'sb-toast', role: 'status', 'aria-live': 'polite' });
    this.tipEl = h('div', { class: 'wire-tip' });
    const overlay = h('div', { class: 'sb-overlay' });
    // A toolbar action, shown when one is registered (the page imports the plugins after the editor).
    const act = (id: string, label: string, ic: string) => h('button', { class: 'btn sm', 'data-for': id,
      onclick: () => this.actionsEl.querySelector<HTMLElement>(`[data-action=${id}]`)?.click() }, icon(ic, 14), label);
    this.emptyEl = h('div', { class: 'sb-empty-chip', hidden: true },
      h('h3', null, 'An empty chip'),
      h('p', null, coarsePointer()
        ? 'Tap a part in the Parts list, then tap the canvas to place it: an Input, a NAND and an Output make a first circuit. Wire them by dragging from pin to pin.'
        : 'Drag a part from the palette: an Input, a NAND and an Output make a first circuit. Wire them by dragging from pin to pin.'),
      h('div', { class: 'row' }, act('examples', 'Examples', 'book'), act('challenges', 'Challenges', 'flag'), act('puzzles', 'Puzzles', 'puzzle')));
    // Touch (tools.ts): one finger wires, moves and draws a band; two fingers pan and zoom (camera.ts).
    this.canvas.append(overlay, this.emptyEl, this.toastEl, this.tipEl,
      hintBadge('drag from a pin to wire · L pointer · wheel zoom · Space+drag pan · ? shortcuts',
        'drag from a pin: wire · double-tap: open · pinch: zoom', 'sandbox', ' sb-hint'));
    this.slots = { overlay, bottom: h('div', { class: 'sb-bottom' }), top: h('div', { class: 'sb-top-slot' }), left: h('div', { class: 'sb-left' }) };

    this.sim = new EditorSim({ gateRate: () => settings.speed });
    this.sim.onChange = () => this.simChanged();
    this.sim.onHalt = () => this.halted();

    this.palette = new PalettePanel(() => ({ ws: this.ws, chipId: this.chipId, canPlace: (c) => this.lib.canPlace(this.chipId, c),
      level: this.level ? [this.level.chipId, this.levelHome!] : undefined }), {
      pick: (item, e) => this.pickPart(item, e),
      arm: (item, key) => {
        this.tools.arm(item, key);
        if (this.partsDrawer) this.showParts(false);
        this.toast(`${item.name}: click the canvas to place it (Esc cancels)`);
      },
      purist: () => !!this.level || !!this.ws.purist,
      setPurist: (v) => this.volatile({ ...this.ws, ...(v ? { purist: true } : { purist: undefined }) }),
      toggleFavorite: (key) => {
        const favorites = toggleFavorite(this.ws.favorites, key);
        this.volatile({ ...this.ws, ...(favorites.length ? { favorites } : { favorites: undefined }) });
      },
      locked: !!this.level,
      newFolder: this.level ? undefined : () => void this.newFolder(),
      renameFolder: this.level ? undefined : (from, to) => this.renameFolder(from, to),
      hidden: (g) => !!this.level?.hideGroups?.includes(g),
      first: this.level ? this.level.first ?? ['unlocked', 'lib', 'wiring', 'const', 'mine'] : undefined,
      closed: this.level ? ['io', 'disp'] : undefined,
    });
    this.props = new PropsPanel(this);

    this.tabs = h('div', { class: 'sb-tabs', role: 'tablist' });
    this.actionsEl = h('div', { class: 'sb-actions' });
    this.moreBtn = h('button', { class: 'btn ghost sm sb-more', title: 'More tools', 'aria-label': 'More tools', 'aria-haspopup': 'menu', 'aria-expanded': 'false', hidden: true,
      onclick: () => this.toggleMore() }, icon('more', 16), h('span', null, 'More')) as HTMLButtonElement;
    // On a phone the palette is a drawer under the top bar, closed until this button opens it (editor.css).
    this.palette.el.id = 'sb-palette';
    this.partsBtn = h('button', { class: 'btn sm sb-parts-btn', title: 'Show or hide the parts list', 'aria-controls': 'sb-palette', 'aria-expanded': 'false',
      onclick: () => this.showParts(!this.el.classList.contains('pal-open')) }, icon('plus', 15), 'Parts') as HTMLButtonElement;
    this.status = h('div', { class: 'status' });
    this.controls = h('div', { class: 'controls sb-controls' });
    const center = h('section', { class: 'sb-center' }, h('div', { class: 'sb-mid' }, this.slots.left, this.canvas), this.slots.bottom, this.controls);
    this.topEl = h('div', { class: 'sb-top' }, this.partsBtn, this.tabs, this.slots.top, this.actionsEl);
    this.el = h('div', { class: this.level ? 'sandbox sb-levelmode' : 'sandbox' }, this.topEl, this.palette.el, center, this.props.el);

    this.tools = new Tools(this);
    this.buildControls();
    this.unsub = settings.onChange(() => {
      this.view.radix = settings.radix;
      this.repaint();
    });
    this.resize = new ResizeObserver(() => {
      if (!this.fitted && this.canvas.clientWidth > 0) {
        this.fitted = true;
        this.fitView();
      }
    });
    this.resize.observe(this.canvas);
    // The toolbar's More menu follows the top bar's width (tabs and slot items change it too: renderTabs, fitActions).
    // The autosave indicator (fileui.ts) arrives in slots.top after the constructor, and web fonts change every width.
    let topW = 0, slotW = 0;
    this.topResize = new ResizeObserver(() => {
      if (this.topEl.clientWidth === topW && this.slots.top.offsetWidth === slotW) return;
      topW = this.topEl.clientWidth;
      slotW = this.slots.top.offsetWidth;
      this.fitActions();
    });
    this.topResize.observe(this.topEl);
    this.topResize.observe(this.slots.top);
    document.fonts?.ready.then(() => this.fitSoon(), () => {});
    this.refresh();
    for (const p of plugins) {
      const off = p(this);
      if (off) this.cleanups.push(off);
    }
  }

  private cleanups: (() => void)[] = [];
  private simListeners = new Set<() => void>();

  /** Called whenever the simulation changed (values, a rebuild, a reset, another chip's sim). */
  onSimChange(f: () => void): () => void {
    this.simListeners.add(f);
    return () => this.simListeners.delete(f);
  }

  // ---- state -------------------------------------------------------------------------------

  get ws(): Workspace {
    return this.history.current;
  }
  get chipId(): string {
    return activeChip(this.ws);
  }
  get doc(): ChipDoc {
    return this.ws.chips[this.chipId];
  }

  /** The definition a placed part resolves to (undefined: unresolved). */
  readonly defOf: DefOf = (p) => this.defOfRef(p.ref);

  defOfRef(ref: PartRef): ComponentDef | undefined {
    if ('chip' in ref) return this.lib.defOf(ref.chip);
    let d = this.refCache.get(ref);
    if (d === undefined) {
      let r;
      try {
        r = partDef(ref, (id) => this.lib.defOf(id));
      } catch (e) {
        r = { error: String(e) };
      }
      d = isError(r) ? null : r;
      this.refCache.set(ref, d);
    }
    return d ?? undefined;
  }

  /** Change the current chip: one undo step. */
  edit(f: (doc: ChipDoc) => ChipDoc): void {
    const doc = this.doc;
    const next = f(doc);
    if (next === doc) return;
    // A chip drawn from Verilog or a truth table: its body follows the source (name, colour, notes, face and comments stay editable).
    if (isGenerated(this.ws, doc.id) && bodyKey(next) !== bodyKey(doc)) {
      this.toast(`${doc.name} is drawn from ${doc.table ? 'a truth table: edit the table' : 'Verilog: edit its text'}, or Detach it to draw on it`, 'err');
      if (this.history.inTransaction) this.view.render(doc, this.defOf);
      return;
    }
    if (this.history.inTransaction) this.history.update(withChip(this.ws, next));
    else this.history.push(withChip(this.ws, next));
    this.changed();
  }

  /** Change the workspace: one undo step. */
  editWs(f: (ws: Workspace) => Workspace): void {
    const next = f(this.ws);
    if (next === this.ws) return;
    this.history.push(next);
    this.changed();
  }

  /** File a chip in a folder of My chips (made if missing; before `before` in it), or take it out (null): one undo step. */
  fileChip(id: string, folder: string | null, before?: string): void {
    const ws = this.ws;
    this.editWs((w) => moveToFolder(w, id, folder, before));
    if (this.ws === ws || before) return;
    const name = ws.chips[id]?.name ?? id;
    this.toast(folder === null ? `${name} is in no folder now` : `${name} is in ${findFolder(this.ws, folder)?.name ?? folder}`);
  }

  /** A new folder of My chips, its name ready to type over in the palette. */
  newFolder(): string | null {
    const r = addFolder(this.ws, newFolderName(this.ws));
    if ('error' in r) {
      this.toast(`Cannot add a folder: ${r.error}`, 'err');
      return null;
    }
    this.palette.renameSoon(r.name);
    this.editWs(() => r.ws);
    return r.name;
  }

  /** Rename a folder: one undo step. Returns why the name cannot be used, or null. */
  renameFolder(from: string, to: string): string | null {
    const r = renameFolder(this.ws, from, to);
    if ('error' in r) return r.error;
    this.editWs(() => r.ws);
    return null;
  }

  /** A drag: begin(), edit() on every move, commit() (or cancel()). */
  begin(): void {
    this.history.begin();
  }
  commit(): void {
    this.history.commit();
    this.changed();
  }
  cancel(): void {
    this.history.cancel();
    this.changed();
  }

  /** Saved but never undone: open tabs, input values, the purist toggle, palette favorites. */
  volatile(ws: Workspace): void {
    if (ws === this.ws) return;
    this.history.replace(ws);
    this.changed();
  }

  undo(): void {
    const cur = this.ws;
    const prev = this.history.undo();
    if (!prev) return;
    this.history.replace(keepVolatile(prev, cur));
    this.changed();
  }

  redo(): void {
    const cur = this.ws;
    const next = this.history.redo();
    if (!next) return;
    this.history.replace(keepVolatile(next, cur));
    this.changed();
  }

  select(sel: Sel): void {
    this.sel = sel;
    this.view.setSelection(sel);
    this.props.update();
    if (this.level) this.el.classList.toggle('props-sel', this.selCount > 0);
  }

  /** Level screen: the properties panel pinned open (it also shows while something is selected). */
  propsPinned = false;
  toggleProps(): void {
    this.propsPinned = !this.propsPinned;
    this.el.classList.toggle('props-on', this.propsPinned);
    this.renderActions();
  }

  get selCount(): number {
    const s = this.sel;
    return (s.parts?.length ?? 0) + (s.pins?.length ?? 0) + (s.wires?.length ?? 0) + (s.labels?.length ?? 0) + (s.comments?.length ?? 0);
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  // ---- tabs --------------------------------------------------------------------------------

  openChip(id: string): void {
    if (!this.ws.chips[id]) return;
    closePopover();
    this.tools.cancel();
    this.volatile(openChip(this.ws, id));
  }

  closeTab(id: string): void {
    this.volatile(closeChip(this.ws, id));
  }

  newChip(): void {
    const r = newChip(this.ws);
    this.tools.cancel();
    this.history.push(r.ws);
    this.changed();
  }

  /** Drive an input pin, or a bidirectional one (undefined: release it to Z). */
  setPinValue(pinId: string, v: PinValue | undefined): void {
    const pin = this.doc.pins.find((p) => p.id === pinId);
    if (!pin) return;
    this.volatile(setPinValue(this.ws, this.chipId, pinId, v));
    if (pin.dir === 'inout') this.sim.driveInout(pin, v);
    else if (v !== undefined) this.sim.setInput(pin, v);
  }

  /**
   * The chips opened by "Edit chip", from the one it started in to the active one: the tab bar
   * shows it as a breadcrumb with Back. Opening a chip any other way leaves it behind.
   */
  trail: string[] = [];

  /** Open a placed chip for editing, remembering where it was placed (Back returns there). */
  editChip(id: string): void {
    if (!this.ws.chips[id] || id === this.chipId) return;
    const from = this.chipId;
    this.trail = this.trail[this.trail.length - 1] === from ? [...this.trail, id] : [from, id];
    this.openChip(id);
  }

  back(): void {
    if (this.trail.length < 2 || this.trail[this.trail.length - 1] !== this.chipId) return;
    const trail = this.trail.slice(0, -1);
    const to = trail[trail.length - 1];
    this.trail = trail.length > 1 ? trail : [];
    if (this.ws.chips[to]) this.openChip(to);
  }

  // ---- refresh -----------------------------------------------------------------------------

  /** Something changed: refresh now, or once per frame during a drag. */
  changed(): void {
    if (!this.history.inTransaction) return this.refresh();
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh(); });
  }

  refresh(): void {
    const ws = this.ws;
    if (ws === this.lastWs && !this.dragDrawn) return;
    // A drag only moves things: connectivity, diagnostics and the simulation stay as they are,
    // so only the drawing follows (compiling every frame would also re-derive transistor chips).
    if (this.history.inTransaction && this.lastWs && activeChip(this.lastWs) === this.chipId) {
      this.view.render(ws.chips[this.chipId], this.defOf);
      this.dragDrawn = true;
      return;
    }
    this.dragDrawn = false;
    this.lastWs = ws;
    this.lib.update(compiledView(ws));
    setUserResolver(this.lib.resolver());
    const id = this.chipId;
    const doc = ws.chips[id];
    this.compiled = this.lib.compiled(id)!;
    const switched = id !== this.lastChip;
    if (switched) {
      this.lastChip = id;
      this.sel = {};
      const want = `#/sandbox/${id}`;
      // A share link (#/sandbox/s/…) stays in the address bar until it is imported or dismissed.
      if (/^#\/sandbox(?!\/s\/)/.test(location.hash) && location.hash !== want) history.replaceState(null, '', want);
    }
    this.sel = prune(this.sel, doc);
    this.view.render(doc, this.defOf);
    this.emptyEl.hidden = !!this.level || !!doc.hdl || !!(doc.pins.length || doc.parts.length || doc.wires.length || doc.labels.length || doc.comments?.length);
    if (!this.emptyEl.hidden) for (const b of this.emptyEl.querySelectorAll<HTMLElement>('[data-for]')) b.hidden = !actions.some((a) => a.id === b.dataset.for);
    if (switched && this.fitted) this.fitView();
    this.view.setSelection(this.sel);
    for (const [k, v] of this.sims) if (!ws.chips[k]) { v.destroy(); this.sims.delete(k); }
    if (switched && !this.simChip) this.simChip = id; // the first chip: the constructor's simulation
    else if (switched) {
      // Another chip, another simulation: its own if it was open recently (a latch keeps its
      // bit across tab switches), else a fresh one. The one left behind is paused and kept.
      const old = this.sim;
      old.onChange = () => {};
      old.onHalt = () => {};
      old.pause();
      this.sims.set(this.simChip, old);
      let s = this.sims.get(id);
      this.sims.delete(id);
      if (!s) {
        s = new EditorSim({ gateRate: () => settings.speed });
        s.mode = old.mode;
        s.hz = old.hz;
        s.powerOn = old.powerOn;
      }
      while (this.sims.size > KEEP_SIMS) {
        const [k, v] = this.sims.entries().next().value!;
        v.destroy();
        this.sims.delete(k);
      }
      s.onChange = () => this.simChanged();
      s.onHalt = () => this.halted();
      this.sim = s;
      this.simChip = id;
      this.buildControls();
    }
    this.sim.update(this.compiled, doc.pins);
    this.view.setDiags(this.diags);
    this.repaint();
    this.renderTabs();
    this.renderActions();
    const pk = JSON.stringify([id, !!ws.purist, ws.favorites, ws.folders, Object.values(ws.chips).map((c) => [c.id, c.name, c.hue, chipDeps(c), c.pins.map((p) => p.dir)])]);
    if (pk !== this.paletteKey) {
      this.paletteKey = pk;
      this.palette.render();
    }
    this.props.update();
    this.scheduleSave();
    this.listeners.forEach((f) => f());
  }

  /** Every diagnostic of the current chip: the compiler's, the simulator's and the registered sources' (lint). */
  get diags(): Diag[] {
    return [...(this.compiled?.diags ?? []), ...this.sim.diags, ...diagSources.flatMap((f) => f(this))];
  }

  private simDiagKey = '';
  private simChanged(): void {
    const k = JSON.stringify(this.sim.diags);
    if (k !== this.simDiagKey) {
      this.simDiagKey = k;
      this.view.setDiags(this.diags);
      this.props.update(true);
    }
    this.autoClock();
    this.repaint();
    this.simListeners.forEach((f) => f());
  }

  /** A rate picked in the run bar: the automatic clock starts at it rather than AUTO_HZ. */
  private rateChosen = false;

  /** settings.autoClock: a clocked chip starts running the first time it is simulated (EditorSim.autoStart). */
  private autoClock(): void {
    const sim = this.sim;
    if (!settings.autoClock || sim.autoTried || !sim.autoStart(this.rateChosen ? sim.hz : this.doc.hz ?? AUTO_HZ)) return;
    if (this.rateSel && sim.mode === 'cycle') this.rateSel.value = String(sim.hz);
  }

  /** Called after every repaint (live views over the simulation: look inside, inspector). */
  readonly paintHooks = new Set<() => void>();

  /** Values on screen from the simulation. */
  /** Fit the chip into the canvas, beside the docked drawer when one is open. */
  fitView(): void {
    this.view.fit(this.defOf, parseFloat(this.slots.overlay.style.getPropertyValue('--dock-space')) || 0);
  }

  repaint(): void {
    this.view.paint(this.sim.sim ? this.sim : null, this.sim.built);
    this.updateStatus();
    this.paintHooks.forEach((f) => f());
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
    if (this.saveState.state === 'saved') this.setSaveState({ state: 'saving' });
  }

  private saveWatchers = new Set<() => void>();
  /** Called when saveState changes. */
  onSave(f: () => void): () => void {
    this.saveWatchers.add(f);
    return () => this.saveWatchers.delete(f);
  }
  private setSaveState(st: Editor['saveState']): void {
    this.saveState = st;
    this.saveWatchers.forEach((f) => f());
  }

  /** Never save again (local data was just deleted: the page reloads, and its closing must not write the workspace back). */
  stopSaving(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saving = false;
  }
  private saving = true;

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.saving) return;
    const r = saveWorkspace(this.ws, undefined, projectKey(this.project));
    if (r.ok) touchProject(this.project, this.ws);
    if (!r.ok && r.reason !== this.saveError) this.toast(r.reason, 'err');
    this.saveError = r.ok ? '' : r.reason;
    this.setSaveState(r.ok ? { state: 'saved' } : { state: 'error', reason: r.reason });
  }

  // ---- chrome ------------------------------------------------------------------------------

  private renderTabs(): void {
    const ws = this.ws;
    if (this.trail.length && (this.trail[this.trail.length - 1] !== this.chipId || this.trail.some((t) => !ws.chips[t]))) this.trail = [];
    const key = JSON.stringify([ws.open, this.chipId, ws.open.map((o) => ws.chips[o]?.name), ws.open.map((o) => !!ws.chips[o]?.hdl), this.trail, this.trail.map((t) => ws.chips[t]?.name), ws.folders, Object.keys(ws.chips).length]);
    if (key === this.tabsKey) return;
    this.tabsKey = key;
    this.tabs.replaceChildren();
    if (this.trail.length > 1) {
      // Where "Edit chip" came from: Back, then the path of chips (each one opens).
      const from = ws.chips[this.trail[this.trail.length - 2]].name;
      const crumbs = h('nav', { class: 'sb-trail', 'aria-label': 'Opened from' },
        h('button', { class: 'btn ghost sm sb-back', title: `Back to ${from}`, onclick: () => this.back() }, icon('chevL', 13), 'Back'));
      this.trail.forEach((id, i) => {
        if (i) crumbs.append(h('span', { class: 'sep' }, '›'));
        const last = i === this.trail.length - 1;
        crumbs.append(h('button', { class: last ? 'cur' : '', title: last ? 'Editing' : `Back to ${ws.chips[id].name}`, disabled: last,
          onclick: () => { if (!last) { this.trail = i ? this.trail.slice(0, i + 1) : []; this.openChip(id); } } }, ws.chips[id].name));
      });
      this.tabs.append(crumbs);
    }
    const shown = this.level ? this.levelTabs() : ws.open;
    for (const id of shown) {
      const c = ws.chips[id];
      if (!c) continue;
      const on = id === this.chipId;
      const tab = h('div', { class: `sb-tab${on ? ' on' : ''}`, role: 'tab', 'aria-selected': String(on), title: c.name, 'data-chip': id },
        h('button', { class: 'sb-tab-name', title: c.name, onclick: () => this.openChip(id) }, icon('chip', 13), h('span', { class: 'sb-tab-label' }, c.name), c.hdl ? h('span', { class: 'sb-tab-hdl', title: 'Drawn from Verilog' }, '.v') : null));
      if (shown.length > 1 && id !== this.level?.chipId) tab.append(h('button', { class: 'sb-tab-x', title: `Close ${c.name}`, 'aria-label': `Close ${c.name}`, onclick: () => this.closeTab(id) }, icon('close', 12)));
      this.tabs.append(tab);
    }
    if (this.level) return;
    const others = Object.values(ws.chips).filter((c) => !ws.open.includes(c.id));
    if (others.length) {
      const opt = (c: ChipDoc) => h('option', { value: c.id }, c.name);
      const sel = h('select', { class: 'sb-open', 'aria-label': 'Open a chip', title: 'Open another of your chips' },
        h('option', { value: '' }, `Open… (${others.length})`),
        folderGroups(ws, (c) => !ws.open.includes(c.id)).flatMap((g) => (!g.chips.length ? [] : g.name === null ? g.chips.map(opt) : [h('optgroup', { label: g.name }, g.chips.map(opt))]))) as HTMLSelectElement;
      sel.addEventListener('change', () => sel.value && this.openChip(sel.value));
      this.tabs.append(sel);
    }
    // New chip and its ▾ in one group that stays in view at the end of the tabs when they scroll (editor.css)
    const grp = h('span', { class: 'sb-new-grp' }, h('button', { class: 'btn ghost sm sb-new', title: 'A new empty chip', onclick: () => this.newChip() }, icon('plus', 14), 'New chip'));
    if (newChipKinds.length) {
      const more: HTMLButtonElement = h('button', { class: 'btn ghost sm sb-new-more', title: 'Other kinds of new chip', 'aria-label': 'Other kinds of new chip', 'aria-haspopup': 'menu',
        onclick: () => this.newChipMenu(more) }, icon('chevD', 12));
      grp.append(more);
    }
    this.tabs.append(grp);
  }

  /** New chip ▾: an empty chip or one of the registered kinds. */
  private newChipMenu(anchor: HTMLElement): void {
    this.el.querySelector('.sb-newmenu')?.remove();
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', away, true); };
    const away = (e: Event) => { if (!menu.contains(e.target as Node) && e.target !== anchor) close(); };
    const item = (label: string, hint: string, ic: string, run: () => void) => h('button', { role: 'menuitem', onclick: () => { close(); run(); } },
      icon(ic, 16), h('span', null, h('b', null, label), h('small', null, hint)));
    const menu = h('div', { class: 'sb-menu sb-newmenu', role: 'menu', 'aria-label': 'New chip' },
      item('Empty chip', 'draw it from parts', 'plus', () => this.newChip()),
      ...newChipKinds.map((k) => item(k.label, k.hint, k.icon, () => k.run(this))));
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } });
    this.el.append(menu);
    const r = anchor.getBoundingClientRect();
    placeMenu(menu, r, Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)));
    document.addEventListener('pointerdown', away, true);
    menu.querySelector('button')?.focus();
  }

  /** Level screen: the level's chip first, then the open chips it places (directly or deeper). */
  private levelTabs(): string[] {
    const ws = this.ws;
    const top = this.level!.chipId;
    const uses = new Set<string>();
    const walk = (id: string) => {
      for (const d of ws.chips[id] ? chipDeps(ws.chips[id]) : []) if (!uses.has(d)) { uses.add(d); walk(d); }
    };
    walk(top);
    return [top, ...ws.open.filter((id) => id !== top && uses.has(id))];
  }

  /** The toolbar actions this editor shows (a level screen: its own list). */
  barActions(): ToolbarAction[] {
    const only = this.level?.actions;
    return actions.filter((a) => (only ? only.includes(a.id) : !a.levelOnly));
  }

  /** Redraw the top bar's buttons (a toggle changed state). */
  renderActions(): void {
    // a toggle redraws the bar: the focus stays on the button pressed (or More, if it moved there)
    const a = document.activeElement;
    const focused = a instanceof HTMLElement && a !== this.moreBtn && this.actionsEl.contains(a) ? a.dataset.action : undefined;
    this.actionsEl.replaceChildren();
    for (const a of this.barActions()) {
      const b = h('button', { class: `btn ghost ${a.label ? 'sm' : 'icon-only'}`, title: a.title, 'aria-label': a.title, 'data-action': a.id, onclick: () => a.run(this) },
        icon(a.icon, 16), a.label ? h('span', null, a.label) : null) as HTMLButtonElement;
      if (a.enabled && !a.enabled(this)) b.disabled = true;
      if (a.active) {
        const on = a.active(this);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      // the last fit's choice until the next frame measures again: no flash of a full bar
      b.hidden = this.shed.has(a.id);
      this.actionsEl.append(b);
    }
    this.moreBtn.hidden = !this.shed.size;
    this.actionsEl.append(this.moreBtn);
    if (focused) {
      const b = this.actionsEl.querySelector<HTMLElement>(`[data-action="${CSS.escape(focused)}"]`);
      (b && !b.hidden ? b : this.moreBtn).focus({ preventScroll: true });
    }
    if (this.moreMenu) this.fillMore();
    this.fitSoon();
  }

  // ---- the toolbar's More menu -------------------------------------------------------------

  /** Actions in the More menu (toolbarfit.ts shedActions). */
  private shed = new Set<string>();
  private fitFrame = 0;

  private fitSoon(): void {
    if (!this.fitFrame) this.fitFrame = requestAnimationFrame(() => { this.fitFrame = 0; this.fitActions(); });
  }

  /**
   * Move the least used actions into More until the rest fit: beside the chip tabs (which keep room
   * for the open tab, Open… and New chip), or below 1000 px on a row of their own (editor.css).
   */
  private fitActions(): void {
    const top = this.topEl, bar = this.actionsEl;
    if (!top.isConnected || !top.clientWidth) return;
    const btns = [...bar.querySelectorAll<HTMLButtonElement>(':scope > [data-action]')];
    for (const b of btns) b.hidden = false;
    this.moreBtn.hidden = false;
    const moreW = this.moreBtn.offsetWidth;
    const px = (v: string) => parseFloat(v) || 0;
    const cs = getComputedStyle(top);
    let room = top.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
    if (!matchMedia('(max-width: 1000px)').matches) {
      const gap = px(cs.columnGap);
      const essential = [...this.tabs.children].filter((el) => el.matches('.sb-tab.on, .sb-open, .sb-new-grp, .sb-trail')) as HTMLElement[];
      const tabsGap = px(getComputedStyle(this.tabs).columnGap);
      const tabsNeed = essential.reduce((s, el) => s + el.offsetWidth, 0) + tabsGap * Math.max(0, essential.length - 1);
      const others = [this.partsBtn, this.slots.top].filter((el) => el.offsetWidth > 0);
      room -= Math.min(tabsNeed, room / 2) + others.reduce((s, el) => s + el.offsetWidth + gap, 0) + gap;
    }
    this.shed = shedActions(btns.map((b) => ({ id: b.dataset.action!, w: b.offsetWidth })), room, moreW, px(getComputedStyle(bar).columnGap));
    for (const b of btns) b.hidden = this.shed.has(b.dataset.action!);
    this.moreBtn.hidden = !this.shed.size;
    if (!this.shed.size) this.closeMore();
    else if (this.moreMenu) this.fillMore();
  }

  /** Where an action's own menu opens: its button, or More when it is in there. */
  actionAnchor(id: string): HTMLElement | null {
    const b = this.actionsEl.querySelector<HTMLElement>(`[data-action="${id}"]`);
    return b && !b.hidden ? b : this.shed.has(id) ? this.moreBtn : b;
  }

  private toggleMore(): void {
    if (this.moreMenu) return this.closeMore();
    const menu = this.moreMenu = h('div', { class: 'sb-menu sb-more-menu', role: 'menu', 'aria-label': 'More tools' });
    this.fillMore();
    this.el.append(menu);
    const r = this.moreBtn.getBoundingClientRect();
    placeMenu(menu, r, Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)));
    this.moreBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.moreAway, true);
    document.addEventListener('keydown', this.moreKey, true);
    menu.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }

  private fillMore(): void {
    const menu = this.moreMenu!;
    menu.replaceChildren();
    for (const a of this.barActions()) {
      if (!this.shed.has(a.id)) continue;
      const on = a.active?.(this);
      const item = h('button', { role: a.active ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': a.active ? String(!!on) : null, class: on ? 'on' : null, title: a.title,
        onclick: () => { this.closeMore(); a.run(this); } }, icon(a.icon, 16), h('span', null, h('b', null, a.menu ?? a.label ?? a.title))) as HTMLButtonElement;
      if (a.enabled && !a.enabled(this)) item.disabled = true;
      menu.append(item);
    }
  }

  private readonly moreAway = (e: Event) => {
    if (!this.moreMenu?.contains(e.target as Node) && !this.moreBtn.contains(e.target as Node)) this.closeMore();
  };
  private readonly moreKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    this.closeMore();
    this.moreBtn.focus();
  };

  private closeMore(): void {
    if (!this.moreMenu) return;
    this.moreMenu.remove();
    this.moreMenu = null;
    this.moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.moreAway, true);
    document.removeEventListener('keydown', this.moreKey, true);
  }

  // ---- the phone's parts drawer --------------------------------------------------------------

  /** Open or close the palette drawer (a phone; wider screens always show the palette). */
  showParts(on: boolean): void {
    this.el.classList.toggle('pal-open', on);
    this.partsBtn.setAttribute('aria-expanded', String(on));
  }

  /**
   * A press on a palette item. In the phone's drawer a tap (no drag) arms the part and closes the
   * drawer, so the next tap on the canvas places it; a drag out of the open drawer works as on a desktop.
   */
  private pickPart(item: PaletteItem, e: PointerEvent): void {
    this.tools.pickFromPalette(item, e);
    if (!this.partsDrawer) return;
    const up = () => {
      document.removeEventListener('pointerup', up);
      const st = this.tools.state;
      if (st.k !== 'place' || st.drag) return;
      this.showParts(false);
      this.palette.clearSearch(); // the drawer reopens on the whole palette, not on this search's results
      this.placeHint = `Tap the canvas to place ${item.name}`;
      this.toast(this.placeHint);
    };
    document.addEventListener('pointerup', up);
  }

  /** The phone's tap-to-place hint while it may be on screen. */
  private placeHint = '';

  /** The armed part was placed or let go: its tap-to-place hint goes at once rather than after the toast's time. */
  endPlaceHint(): void {
    if (this.placeHint && this.toastEl.textContent === this.placeHint) {
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastEl.className = 'sb-toast';
    }
    this.placeHint = '';
  }

  /** The palette is a drawer (editor.css, max-width 760px) and open. */
  private get partsDrawer(): boolean {
    return this.el.classList.contains('pal-open') && matchMedia('(max-width: 760px)').matches;
  }

  private readonly buzzers = new Buzzers();
  private runBtn!: HTMLButtonElement;
  private rateSel!: HTMLSelectElement;

  private buildControls(): void {
    const c = this.controls;
    c.replaceChildren();
    const sim = this.sim;
    const seg = h('div', { class: 'seg', title: 'Cycle: the clock runs at a rate in Hz. Gate: one gate delay per tick, to watch signals propagate.' });
    for (const [m, label] of [['cycle', 'Cycle'], ['gate', 'Gate delay']] as [RunMode, string][]) {
      seg.append(h('button', { class: sim.mode === m ? 'on' : '', 'data-mode': m, onclick: () => { sim.setMode(m); this.buildControls(); } }, label));
    }
    this.runBtn = h('button', { class: 'btn sm toggle sb-run', title: 'Run / pause (Ctrl+Enter)', onclick: () => this.toggleRun() }) as HTMLButtonElement;
    const step = h('button', { class: 'btn sm ghost', title: sim.mode === 'cycle' ? 'One clock cycle' : 'One gate delay', onclick: () => sim.stepOnce() }, icon('step', 14), 'Step');
    if (sim.mode === 'cycle') {
      this.rateSel = h('select', { 'aria-label': 'Clock rate', title: 'Clock rate' },
        HZ_STEPS.map((hz) => h('option', { value: String(hz), selected: hz === sim.hz }, Number.isFinite(hz) ? `${hz >= 1000 ? `${hz / 1000} k` : hz} Hz` : 'max'))) as HTMLSelectElement;
      this.rateSel.addEventListener('change', () => { sim.hz = Number(this.rateSel.value); this.rateChosen = true; });
    } else {
      this.rateSel = h('select', { 'aria-label': 'Gate delays per second', title: 'Gate delays per second' },
        [1, 2, 4, 8, 12, 25, 50, 100].map((v) => h('option', { value: String(v), selected: v === settings.speed }, `${v} delays/s`))) as HTMLSelectElement;
      this.rateSel.addEventListener('change', () => settings.set('speed', Number(this.rateSel.value)));
    }
    const pon = h('select', { 'aria-label': 'Power-on state', title: 'What storage holds at power-on: 0, unknown (X), or random like real silicon' },
      (['zero', 'x', 'random'] as PowerOnMode[]).map((m) => h('option', { value: m, selected: m === sim.powerOn }, m === 'zero' ? 'to 0' : m === 'x' ? 'to X' : 'random'))) as HTMLSelectElement;
    pon.addEventListener('change', () => { sim.powerOn = pon.value as PowerOnMode; });
    const reset = h('button', { class: 'btn sm ghost', title: 'Power-cycle the circuit', onclick: () => sim.reset(pon.value as PowerOnMode) }, icon('reset', 14), 'Reset');
    c.append(seg, this.runBtn, step, h('span', { class: 'sb-rate' }, this.rateSel), reset, h('span', { class: 'sb-rate' }, pon), this.status);
    this.updateStatus();
  }

  toggleRun(): void {
    if (this.sim.running) this.sim.pause();
    else this.sim.start();
  }

  /** A halt part stopped Run. */
  private halted(): void {
    const sim = this.sim;
    this.toast(sim.hasClock ? `Halted after cycle ${sim.cycles}` : sim.engine === 'gate' ? `Halted at t = ${sim.time}` : 'Halted');
  }

  private updateStatus(): void {
    const sim = this.sim;
    if (!this.runBtn) return;
    const label = sim.running ? 'Pause' : 'Run';
    if (this.runBtn.dataset.state !== label) {
      this.runBtn.dataset.state = label;
      this.runBtn.replaceChildren(icon(sim.running ? 'pause' : 'play', 14), label);
      this.runBtn.classList.toggle('on', sim.running);
    }
    const c = this.compiled;
    const bits: (string | HTMLElement)[] = [];
    const fast = sim.engine === 'cycle';
    bits.push(h('span', { class: `sb-level ${c?.mode ?? 'gate'}`, title: c?.mode === 'switch' ? 'Contains transistors: solved switch by switch'
      : fast ? 'Gates only, on the cycle engine: flip-flops looked up in tables, the rest evaluated level by level. The same values after every settle as the event-driven simulation, which takes over for gate mode, probes and stepping'
        : 'Gates only: event-driven, one NAND delay each' }, c?.mode === 'switch' ? 'switch level' : fast ? 'gate level · cycle engine' : 'gate level'));
    if (!sim.sim) bits.push(h('span', { class: 'pulse warn' }), sim.pending ? 'building…' : 'not simulated');
    else {
      bits.push(h('span', { class: `pulse${sim.running ? ' busy' : ''}${sim.unstable ? ' warn' : ''}` }));
      if (sim.unstable) bits.push('oscillating');
      if (sim.halted) bits.push(h('span', { class: 'sb-halted', title: 'A halt part reads 1: Run stops after every step until it reads 0' }, 'halted'));
      const keys = sim.keyBinds.map(keyLabel);
      if (sim.hasKeyboard) keys.push('⌨');
      if (keys.length) {
        bits.push(h('span', { class: 'sb-keys', title: `${sim.keyBinds.length ? 'Key parts listen to these keys: hold one to drive them' : ''}${sim.keyBinds.length && sim.hasKeyboard ? '. ' : ''}${sim.hasKeyboard ? 'Keyboard part: typed keys reach it while the circuit runs or with Type on' : ''}` }, keys.join(' ')));
      }
      if (sim.hasClock) bits.push(`${sim.cycles} cycles`);
      // gate delays only count on the event-driven engine (the cycle engine has no time)
      if (sim.engine === 'gate') bits.push(`t = ${sim.time}`);
      if (sim.running && sim.mode === 'cycle' && sim.hasClock) {
        // what the clock really ran at over the last second; the setting too when it falls short
        const short = Number.isFinite(sim.hz) && sim.achievedHz < 0.9 * sim.hz;
        bits.push(h('span', { title: 'Clock cycles simulated per second, measured over the last second' }, `${fmtHz(sim.achievedHz)}${short ? ` of ${fmtHz(sim.hz)}` : ''}`));
      }
    }
    const key = bits.map((b) => (typeof b === 'string' ? b : b.outerHTML)).join('|');
    if (this.status.dataset.key === key) return;
    this.status.dataset.key = key;
    this.status.replaceChildren(...bits.map((b) => (typeof b === 'string' ? h('span', null, b) : b)));
  }

  /** The value of the wire under the cursor (null hides it), like the schematic's tooltip. */
  hoverWire(id: string | null, e?: PointerEvent): void {
    if (!id || !e) return void (this.tipEl.style.opacity = '0');
    const bits = this.sim.wireBits(id);
    const built = this.sim.built;
    const net = built?.netOfWire.get(id) ?? -1;
    const nd = built && net >= 0 ? netlistOf(built.def)?.nets[net] : undefined;
    const name = nd?.name ?? nd?.ends[0] ?? id;
    const val = bits ? describeBits(bits) : 'not connected';
    const wk = this.sim.wireWeak(id);
    const weak = wk ? ` (${weakTag(wk)}: a weak ${wk === WEAK_H ? '1 an NMOS passed, VDD − Vt' : '0 a PMOS passed, Vt'})` : '';
    this.tipEl.textContent = `${name}${bits && bits.length > 1 ? `[${bits.length - 1}:0]` : ''} = ${val}${weak}`;
    const r = this.canvas.getBoundingClientRect();
    this.tipEl.style.left = `${e.clientX - r.left + 14}px`;
    this.tipEl.style.top = `${e.clientY - r.top + 14}px`;
    this.tipEl.style.opacity = '1';
  }

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  toast(msg: string, level: 'info' | 'err' = 'info'): void {
    this.toastEl.textContent = msg;
    this.toastEl.className = `sb-toast show ${level}`;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.className = 'sb-toast'), 2800);
  }

  /** Inline name entry over the canvas at a world point (pointer names), with suggestions. */
  promptName(at: Vec, initial: string, names: string[], done: (name: string | null) => void): void {
    this.slots.overlay.querySelector('.sb-prompt')?.remove();
    const m = this.view.svg.getScreenCTM();
    const r = this.canvas.getBoundingClientRect();
    const pt = m ? new DOMPoint(at[0], at[1]).matrixTransform(m) : new DOMPoint(r.left + 40, r.top + 40);
    const list = h('datalist', { id: 'sb-names' }, names.map((n) => h('option', { value: n })));
    const input = h('input', { type: 'text', value: initial, list: 'sb-names', spellcheck: 'false', 'aria-label': 'Pointer name', placeholder: 'name' }) as HTMLInputElement;
    const box = h('div', { class: 'sb-prompt', style: `left:${pt.x - r.left + 8}px;top:${pt.y - r.top - 16}px` }, input, list,
      h('small', null, names.length ? 'Enter: same name = same net' : 'Enter to place'));
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      box.remove();
      const v = input.value.trim();
      done(ok && v ? v : null);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    this.slots.overlay.append(box);
    input.focus();
    input.select();
  }

  /**
   * Edit a name where it is drawn: an input laid over `target` (a name on the canvas), with the
   * current text selected. Enter or leaving the field commits, Esc cancels (done(null)).
   */
  editInline(target: Element, initial: string, opts: { label: string; names?: string[] }, done: (v: string | null) => void): void {
    this.slots.overlay.querySelector('.sb-prompt, .sb-inline')?.remove();
    const t = target.getBoundingClientRect();
    const r = this.canvas.getBoundingClientRect();
    const list = opts.names?.length ? h('datalist', { id: 'sb-inline-names' }, opts.names.map((n) => h('option', { value: n }))) : null;
    const input = h('input', {
      type: 'text', class: 'sb-inline', value: initial, spellcheck: 'false', 'aria-label': opts.label, ...(list ? { list: 'sb-inline-names' } : {}),
      style: `left:${t.left - r.left - 4}px;top:${t.top - r.top + t.height / 2 - 12}px;width:${Math.max(90, t.width + 40)}px`,
    }) as HTMLInputElement;
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      input.remove();
      list?.remove();
      done(ok ? input.value.trim() : null);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    this.slots.overlay.append(input);
    if (list) this.slots.overlay.append(list);
    input.focus();
    input.select();
  }

  /** True while a name or comment is being typed over the canvas. */
  get typingOnCanvas(): boolean {
    return !!this.slots.overlay.querySelector('.sb-prompt, .sb-inline');
  }

  /**
   * Multi-line text entry over the canvas at a world point (comments): Enter commits, Shift+Enter
   * starts a new line, Esc cancels, leaving the box commits. Blank text comes back as ''.
   */
  promptText(at: Vec, initial: string, done: (text: string | null) => void): void {
    this.slots.overlay.querySelector('.sb-prompt')?.remove();
    const m = this.view.svg.getScreenCTM();
    const r = this.canvas.getBoundingClientRect();
    const pt = m ? new DOMPoint(at[0], at[1]).matrixTransform(m) : new DOMPoint(r.left + 40, r.top + 40);
    const lines = initial.split('\n');
    const area = h('textarea', {
      spellcheck: 'true', 'aria-label': 'Comment', placeholder: 'comment',
      rows: String(Math.min(12, Math.max(2, lines.length))), cols: String(Math.min(60, Math.max(24, ...lines.map((l) => l.length + 2)))),
    }, initial) as HTMLTextAreaElement;
    const box = h('div', { class: 'sb-prompt sb-prompt-text', style: `left:${pt.x - r.left}px;top:${pt.y - r.top}px` }, area,
      h('small', null, 'Enter: done · Shift+Enter: new line · Esc: cancel'));
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      box.remove();
      done(ok ? area.value.trim() : null);
    };
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    area.addEventListener('blur', () => finish(true));
    this.slots.overlay.append(box);
    area.focus();
    area.select();
  }

  /** The sandbox's key sheet (ui/keyhelp.ts, drawn from the key table ui/keys.ts), the mouse gestures folded under it. */
  showHelp(): void {
    showKeySheet({
      title: 'Sandbox keys', sub: 'Keys act on the canvas whenever focus is not in a text field or a panel.',
      groups: ['place', 'wire', 'select', 'edit', 'view', 'panels'], taken: new Set(this.sim.keyBinds), mouse: MOUSE_HELP, cls: 'sb-keysheet',
    });
  }

  destroy(): void {
    this.save();
    this.cleanups.forEach((f) => f());
    this.sim.destroy();
    this.buzzers.destroy();
    this.sims.forEach((s) => s.destroy());
    this.tools.destroy();
    this.unsub();
    this.resize.disconnect();
    this.topResize.disconnect();
    this.closeMore();
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    if (this.frame) cancelAnimationFrame(this.frame);
    closePopover();
  }
}

/** The sandbox's mouse gestures (its keys are in the key table, ui/keys.ts). */
const MOUSE_HELP: [string, string][] = [
  ['Drag from a pin or port', 'draw a wire; click empty canvas to add a corner'],
  ['Click or tap an input knob', 'toggle it (a drag from its port side draws a wire, from the far side moves it)'],
  ['Click a pin, port, pointer or wire', 'finish the wire (on a wire: a branch)'],
  ['Ctrl/Alt + drag a wire', 'start a branch from it'],
  ['Drag a wire', 'reshape it: a corner moves, a segment slides (a simple connection bends)'],
  ['Double-click a corner', 'remove that bend'],
  ['Right-click a wire ▸ Add a bend here', 'a new corner on the cursor: move it, click to drop it'],
  ['Wire colours ▸ Simple connections', 'new wires run straight between the points you click'],
  ['☆ on a palette item', 'pin it to Favorites at the top of the palette (★ unpins)'],
  ['Click a selected pointer / double-click', 'jump to the next pointer with that name'],
  ['Double-click a comment', 'edit it'],
  ['Click a selected name · double-click a name', 'rename a part or pin where it is drawn'],
  ['Right-click', 'actions for what is under the cursor (or the canvas)'],
  ['Drag empty canvas', 'select with a rubber band (Shift: add)'],
  ['Shift + click', 'add to / remove from the selection'],
  ['Space + drag, middle drag, two fingers', 'pan · wheel or pinch: zoom'],
  ['A key a Key part listens to', 'drives it while held (and is not a shortcut while that chip is open)'],
  ['Any key, while running or with Type on', 'is typed into the chip\'s Keyboard parts'],
];

/** Simulations kept for chips that are not the active tab. */
const KEEP_SIMS = 4;

const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz.toFixed(hz < 10 ? 1 : 0)} Hz`);

/** The selection without objects that no longer exist. */
function prune(sel: Sel, doc: ChipDoc): Sel {
  const keep = (ids: string[] | undefined, xs: { id: string }[]) => {
    if (!ids?.length) return undefined;
    const r = ids.filter((id) => xs.some((x) => x.id === id));
    return r.length ? r : undefined;
  };
  const out: Sel = {};
  const parts = keep(sel.parts, doc.parts), pins = keep(sel.pins, doc.pins), wires = keep(sel.wires, doc.wires), labels = keep(sel.labels, doc.labels);
  const comments = keep(sel.comments, doc.comments ?? []);
  if (parts) out.parts = parts;
  if (pins) out.pins = pins;
  if (wires) out.wires = wires;
  if (labels) out.labels = labels;
  if (comments) out.comments = comments;
  const same = (a?: string[], b?: string[]) => (a?.length ?? 0) === (b?.length ?? 0);
  return same(out.parts, sel.parts) && same(out.pins, sel.pins) && same(out.wires, sel.wires) && same(out.labels, sel.labels)
    && same(out.comments, sel.comments) ? sel : out;
}
