// The sandbox editor: one object that owns the workspace (with undo), the compiled chips, the
// live simulation, and the panels around the canvas. Tools, palette and properties talk to it;
// later phases plug in through the registries (palette groups, property sections, toolbar
// actions) and the slots it exposes.
//
// Every change goes through edit() / editWs() (an undo step), a transaction (a drag: one step)
// or volatile() (open tabs, input values: saved, never undone). refresh() then brings the
// library, view, simulation and panels up to date; during a drag it runs once per frame.

import { setUserResolver } from '../lib/resolve';
import type { Vec } from '../sim/geometry';
import type { PowerOnMode } from '../sim/sim';
import { type ComponentDef, netlistOf } from '../sim/types';
import { describeBits } from '../sim/values';
import { h, icon } from '../ui/dom';
import { settings } from '../ui/settings';
import { closePopover } from '../view/popover';
import type { Compiled, Diag } from './compile';
import { History } from './history';
import { UserLibrary } from './library';
import { chipDeps, type ChipDoc, type DefOf, type PartRef, type PinValue, type Workspace } from './model';
import type { Sel } from './ops';
import { PalettePanel } from './palette';
import { isError, partDef } from './parts';
import { PropsPanel } from './props';
import { EditorSim, HZ_STEPS, type RunMode } from './runtime';
import { activeChip, closeChip, keepVolatile, newChip, openChip, setPinValue } from './session';
import { loadWorkspace, saveWorkspace } from './store';
import { Tools } from './tools';
import { EditorView } from './view';
import { Buzzers } from './audio';

export interface ToolbarAction {
  id: string;
  title: string;
  icon: string;
  /** Text after the icon (omit for an icon-only button). */
  label?: string;
  order: number;
  run(ed: Editor): void;
  enabled?(ed: Editor): boolean;
  /** A toggle that is on (drawn pressed). */
  active?(ed: Editor): boolean;
}

const actions: ToolbarAction[] = [];

/** Something that lives as long as an editor (an analysis panel, ...); returns its cleanup. */
export type EditorPlugin = (ed: Editor) => (() => void) | void;
const plugins: EditorPlugin[] = [];

/** Run `p` on every editor created from now on. */
export function registerEditorPlugin(p: EditorPlugin): void {
  plugins.push(p);
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
registerToolbarAction({ id: 'fit', title: 'Fit to screen', icon: 'fit', order: 50, run: (ed) => ed.view.fit(ed.defOf) });
registerToolbarAction({ id: 'help', title: 'Keyboard shortcuts (?)', icon: 'info', order: 90, run: (ed) => ed.showHelp() });

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
  readonly slots: { overlay: HTMLElement; bottom: HTMLElement; top: HTMLElement };
  /** Autosave: 'saving' while a save is pending, else the result of the last one. */
  saveState: { state: 'saved' | 'saving' | 'error'; reason?: string } = { state: 'saved' };
  sel: Sel = {};
  compiled!: Compiled;

  private canvas: HTMLElement;
  private tabs: HTMLElement;
  private actionsEl: HTMLElement;
  private controls: HTMLElement;
  private status: HTMLElement;
  private toastEl: HTMLElement;
  private tipEl: HTMLElement;
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

  constructor(chipId?: string) {
    let ws = loadWorkspace();
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
    this.canvas.append(overlay, this.toastEl, this.tipEl,
      h('div', { class: 'hint-badge sb-hint' }, 'drag from a pin to wire · L pointer · wheel zoom · Space+drag pan · ? shortcuts'));
    this.slots = { overlay, bottom: h('div', { class: 'sb-bottom' }), top: h('div', { class: 'sb-top-slot' }) };

    this.sim = new EditorSim({ gateRate: () => settings.speed });
    this.sim.onChange = () => this.simChanged();
    this.sim.onHalt = () => this.halted();

    this.palette = new PalettePanel(() => ({ ws: this.ws, chipId: this.chipId, canPlace: (c) => this.lib.canPlace(this.chipId, c) }), {
      pick: (item, e) => this.tools.pickFromPalette(item, e),
      purist: () => !!this.ws.purist,
      setPurist: (v) => this.volatile({ ...this.ws, ...(v ? { purist: true } : { purist: undefined }) }),
    });
    this.props = new PropsPanel(this);

    this.tabs = h('div', { class: 'sb-tabs', role: 'tablist' });
    this.actionsEl = h('div', { class: 'sb-actions' });
    this.status = h('div', { class: 'status' });
    this.controls = h('div', { class: 'controls sb-controls' });
    const center = h('section', { class: 'sb-center' }, this.canvas, this.slots.bottom, this.controls);
    this.el = h('div', { class: 'sandbox' },
      h('div', { class: 'sb-top' }, this.tabs, this.slots.top, this.actionsEl), this.palette.el, center, this.props.el);

    this.tools = new Tools(this);
    this.buildControls();
    this.unsub = settings.onChange(() => {
      this.view.radix = settings.radix;
      this.repaint();
    });
    this.resize = new ResizeObserver(() => {
      if (!this.fitted && this.canvas.clientWidth > 0) {
        this.fitted = true;
        this.view.fit(this.defOf);
      }
    });
    this.resize.observe(this.canvas);
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

  /** Saved but never undone: open tabs, input values, the purist toggle. */
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
    if (switched && this.fitted) this.view.fit(this.defOf);
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
    const pk = JSON.stringify([id, !!ws.purist, Object.values(ws.chips).map((c) => [c.id, c.name, c.hue, chipDeps(c), c.pins.map((p) => p.dir)])]);
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
    this.repaint();
    this.simListeners.forEach((f) => f());
  }

  /** Called after every repaint (live views over the simulation: look inside, inspector). */
  readonly paintHooks = new Set<() => void>();

  /** Values on screen from the simulation. */
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

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const r = saveWorkspace(this.ws);
    if (!r.ok && r.reason !== this.saveError) this.toast(r.reason, 'err');
    this.saveError = r.ok ? '' : r.reason;
    this.setSaveState(r.ok ? { state: 'saved' } : { state: 'error', reason: r.reason });
  }

  // ---- chrome ------------------------------------------------------------------------------

  private renderTabs(): void {
    const ws = this.ws;
    if (this.trail.length && (this.trail[this.trail.length - 1] !== this.chipId || this.trail.some((t) => !ws.chips[t]))) this.trail = [];
    const key = JSON.stringify([ws.open, this.chipId, ws.open.map((o) => ws.chips[o]?.name), this.trail, this.trail.map((t) => ws.chips[t]?.name)]);
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
    for (const id of ws.open) {
      const c = ws.chips[id];
      if (!c) continue;
      const on = id === this.chipId;
      const tab = h('div', { class: `sb-tab${on ? ' on' : ''}`, role: 'tab', 'aria-selected': String(on), title: c.name, 'data-chip': id },
        h('button', { class: 'sb-tab-name', onclick: () => this.openChip(id) }, icon('chip', 13), c.name));
      if (ws.open.length > 1) tab.append(h('button', { class: 'sb-tab-x', title: `Close ${c.name}`, 'aria-label': `Close ${c.name}`, onclick: () => this.closeTab(id) }, icon('close', 12)));
      this.tabs.append(tab);
    }
    const others = Object.values(ws.chips).filter((c) => !ws.open.includes(c.id));
    if (others.length) {
      const sel = h('select', { class: 'sb-open', 'aria-label': 'Open a chip', title: 'Open another of your chips' },
        h('option', { value: '' }, `Open… (${others.length})`), others.map((c) => h('option', { value: c.id }, c.name))) as HTMLSelectElement;
      sel.addEventListener('change', () => sel.value && this.openChip(sel.value));
      this.tabs.append(sel);
    }
    this.tabs.append(h('button', { class: 'btn ghost sm sb-new', title: 'A new empty chip', onclick: () => this.newChip() }, icon('plus', 14), 'New chip'));
  }

  /** Redraw the top bar's buttons (a toggle changed state). */
  renderActions(): void {
    this.actionsEl.replaceChildren();
    for (const a of actions) {
      const b = h('button', { class: `btn ghost ${a.label ? 'sm' : 'icon-only'}`, title: a.title, 'aria-label': a.title, 'data-action': a.id, onclick: () => a.run(this) },
        icon(a.icon, 16), a.label ? h('span', null, a.label) : null) as HTMLButtonElement;
      if (a.enabled && !a.enabled(this)) b.disabled = true;
      if (a.active) {
        const on = a.active(this);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      this.actionsEl.append(b);
    }
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
      this.rateSel.addEventListener('change', () => { sim.hz = Number(this.rateSel.value); });
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
    this.toast(sim.hasClock ? `Halted after cycle ${sim.cycles}` : `Halted at t = ${sim.time}`);
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
    bits.push(h('span', { class: `sb-level ${c?.mode ?? 'gate'}`, title: c?.mode === 'switch' ? 'Contains transistors: solved switch by switch' : 'Gates only: event-driven, one NAND delay each' }, c?.mode === 'switch' ? 'switch level' : 'gate level'));
    if (!sim.sim) bits.push(h('span', { class: 'pulse warn' }), sim.pending ? 'building…' : 'not simulated');
    else {
      bits.push(h('span', { class: `pulse${sim.running ? ' busy' : ''}${sim.unstable ? ' warn' : ''}` }));
      if (sim.unstable) bits.push('oscillating');
      if (sim.halted) bits.push(h('span', { class: 'sb-halted', title: 'A halt part reads 1: Run stops after every step until it reads 0' }, 'halted'));
      if (sim.hasClock) bits.push(`${sim.cycles} cycles`);
      if (sim.sim.kind === 'gate') bits.push(`t = ${sim.time}`);
      if (sim.running && sim.mode === 'cycle' && sim.hasClock) bits.push(`${fmtHz(sim.achievedHz)}`);
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
    this.tipEl.textContent = `${name}${bits && bits.length > 1 ? `[${bits.length - 1}:0]` : ''} = ${val}`;
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

  showHelp(): void {
    const keys: [string, string][] = [
      ['Drag from a pin or port', 'draw a wire; click empty canvas to add a corner'],
      ['Space or /', 'flip the wire\'s L (while drawing)'],
      ['Backspace', 'remove the last corner (while drawing)'],
      ['Click a pin, port, pointer or wire', 'finish the wire (on a wire: a branch)'],
      ['Ctrl/Alt + drag a wire', 'start a branch from it'],
      ['Drag a wire', 'reshape it: a corner moves, a segment slides (a simple connection bends)'],
      ['Double-click a corner', 'remove that bend'],
      ['Wire colours ▸ Simple connections', 'new wires run straight between the points you click'],
      ['L', 'place a pointer (same name = same net)'],
      ['Click a selected pointer / double-click', 'jump to the next pointer with that name'],
      ['T', 'place a comment · double-click one to edit it'],
      ['Click a selected name · double-click a name', 'rename a part or pin where it is drawn'],
      ['F2', 'rename the selected part, pin or pointer (a comment: edit its text)'],
      ['Right-click', 'actions for what is under the cursor (or the canvas)'],
      ['Drag empty canvas', 'select with a rubber band (Shift: add)'],
      ['Shift + click', 'add to / remove from the selection'],
      ['Space + drag, middle drag, two fingers', 'pan · wheel or pinch: zoom'],
      ['Ctrl+Z · Ctrl+Shift+Z / Ctrl+Y', 'undo · redo'],
      ['Ctrl+C · X · V · D · A', 'copy · cut · paste · duplicate · select all'],
      ['Delete / Backspace', 'delete the selection'],
      ['F', 'flip the selection left–right'],
      ['Arrows (Shift: ×5)', 'nudge the selection'],
      ['Ctrl+Enter', 'run / pause the simulation'],
      ['Esc', 'cancel · clear the selection'],
    ];
    const close = () => ov.remove();
    const ov = h('div', { class: 'sb-help', role: 'dialog', 'aria-label': 'Keyboard shortcuts', onclick: (e: Event) => { if (e.target === ov) close(); } },
      h('div', { class: 'panel' },
        h('div', { class: 'sb-help-head' }, h('h3', null, 'Sandbox shortcuts'), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
        h('dl', null, keys.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))));
    this.el.append(ov);
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    (ov.querySelector('button') as HTMLButtonElement).focus();
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
    if (this.frame) cancelAnimationFrame(this.frame);
    closePopover();
  }
}

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
