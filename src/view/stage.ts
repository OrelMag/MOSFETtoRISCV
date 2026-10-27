// The stage: a scene (root component + inputs) simulated live, viewed through a schematic
// that can drill into any instance, with input controls, clock, propagation animation and
// the inspector. Chapters and the workbench are thin wrappers around it.

import { DualSim } from '../sim/dualsim';
import { findNode, flatten, type HierNode } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { SwitchSim } from '../sim/switchsim';
import { needsSwitchLevel } from '../sim/harness';
import { completeEdge, type Edge, riseEdge, stepEdge } from '../sim/edge';
import { PowerMeter } from '../sim/power';
import { RELAY_STEP_MS } from '../phys/relay';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import type { PowerOnMode, Sim, SimState } from '../sim/sim';
import { B0, B1, BZ, type Bit, type ComponentDef, inPorts, netlistOf, outPorts, type PortDef } from '../sim/types';
import { formatBits, formatNumber, mask, pack, packBig, type Radix, unpackBig } from '../sim/values';
import { LogicAnalyzer, netKey } from './analyzer';
import { h, hintBadge, icon } from '../ui/dom';
import { applyTheme, settings } from '../ui/settings';
import { switchSim, ViewCtx } from './context';
import { type CrumbValue, crumbTitle, crumbValues, paintCrumbVals } from './crumbvals';
import { Inspector } from './inspector';
import type { LivePower } from './powerpanel';
import { closePopover, editNumber } from './popover';
import { chooseFolds, freeArea, roomBeside, startFolded, type Rect } from './camera';
import { applyLayout, layoutOf } from './layout';
import { SchematicView } from './schematic';
import { BB_MARGIN, BB_READ_PX, type BbChip, type BbDrill, type BreadboardLayout, DRILL_STACK_PX, drillCrumbs, drillOf, drillPane, layoutBounds } from './bblayout';
import { BreadboardView, drillNotes, pinCard, type WireLook } from './breadboard';
import { matches, shortcutAllowed } from '../ui/keys';

export interface Scene {
  root: ComponentDef;
  inputs?: Record<string, number>;
  /** Open this deep on load (instance names). */
  path?: string[];
  highlight?: string[];
  /** Name of the clock input (gets Pulse / Run buttons). Defaults to any port marked clock or named clk. */
  clock?: string;
  powerOn?: PowerOnMode;
  /** Extra overlay panels. */
  panels?: ScenePanel[];
  /** Hide these inputs from the control bar (driven by the chapter). */
  hiddenInputs?: string[];
  /** Always animate propagation in this scene, regardless of the global setting. */
  animate?: boolean;
  /** Open the timing panel (logic analyzer) on load. */
  analyzer?: boolean;
  /** false: the clock stays still on load whatever settings.autoClock says (an exercise counted in Pulses from the start). */
  autoClock?: boolean;
  /**
   * 'cycle': settle on the cycle engine (DualSim, sim/dualsim.ts): the same values after every clock edge, many times
   * faster on a design of hundreds of thousands of gates, but no gate-delay time, so no probes or timing diagram.
   * Stepping and slow-motion edges still run on GateSim.
   * 'nmos': a transistor-level design too large for SwitchSim (Appendix A's 6502) on NmosSim, the
   * event-driven switch-level engine.
   */
  engine?: 'cycle' | 'nmos';
  /** No Open in Sandbox: the circuit is larger than a sandbox chip can hold (Appendix B's Doom computer). */
  noRemix?: boolean;
  /**
   * The circuit as built on breadboards (view/bblayout.ts): the stage bar gets a Schematic | Breadboard toggle and the
   * scene opens on the boards (unless it opens deeper, or the learner last chose the schematic).
   */
  breadboard?: BreadboardLayout;
  /** The bottom bar's Reset (a power cycle) under another name: 'Power cycle' where the circuit has a RESET of its own. */
  resetLabel?: string;
}

export interface Widget {
  el: HTMLElement;
  update?(): void;
  destroy?(): void;
}

/** A panel overlaid on the canvas that reads the live scene (e.g. the memory grid). */
export type ScenePanel = (stage: Stage) => Widget;

/** Factory for "leaf" explainers, e.g. opening a single MOSFET. */
export type LeafWidgetFactory = (def: ComponentDef, gate: () => Bit) => Widget;

const LEVEL_NAME: Record<string, string> = {
  transistor: 'transistors', cell: 'transistors', relay: 'relays', tube: 'tubes', gate: 'gates', arithmetic: 'gates & blocks',
  routing: 'gates & blocks', sequential: 'latches & flip-flops', memory: 'memory', plumbing: 'wiring', cpu: 'processor',
};

/** Steps Back can undo (each a full copy of the simulation's state). */
const HISTORY_MAX = 100;
/** The stage's Run: one clock cycle every RUN_MS (2 Hz, slow enough to follow every edge), high for the first half. */
const RUN_MS = 500;
/** The open part's pins shown in the bar's read-only row (the rest are in the inspector's Info). */
const INNER_PINS = 10;

/** Panel state that Back restores together with the simulation (a golden model, a trace log). */
export interface HistoryHook {
  save(): unknown;
  restore(s: unknown): void;
}

interface Checkpoint {
  sim: SimState;
  /** time · evaluations · cycles: what the state looked like (an unchanged one is not saved twice) */
  key: string;
  cycles: number;
  edge: StageEdge | null;
  edgePeriod: number;
  nextEdge: number;
  lateEvents: number;
  lateCount: number;
  lastSettle: number | null;
  changeStart: number;
  panels: [HistoryHook, unknown][];
}

/** A rising edge; `held`: Run's high half, settled and its after hooks run, waiting for the fall. */
type StageEdge = Edge & { held?: boolean };

/** The direction mark of the bottom bar: before an input's name (into the circuit), after an output (out of it). */
const DIR = () => h('span', { class: 'dir', 'aria-hidden': 'true' }, '▸');

/** The learner's last fold or unfold of a foldable panel on each side (see Stage.foldable): later scenes follow it. */
const foldChoice = new Map<string, boolean>();

/** The learner's last choice between a scene's breadboards and its schematic, and of the jumpers' look (the page's life). */
let boardChoice = true;
let wireChoice: WireLook = 'built';

/** Scenes at least this big (NAND gates plus a quarter of the transistors) are built behind a "Building…" cue
 *  painted first: flattening, simulating and drawing chapter 14's CPU (56 000 NANDs) holds the page half a second. */
export const BUSY_GATES = 10_000;

/** Run `f` once the browser has painted what is on screen now: a frame, then a task. (A hidden tab paints no
 *  frames: there it runs after the frame the tab next shows.) */
function afterPaint(f: () => void): void {
  requestAnimationFrame(() => setTimeout(f, 0));
}

export class Stage {
  readonly el: HTMLElement;
  readonly inspector: Inspector;
  scene: Scene | null = null;
  /** A big scene waiting for its "Building…" cue to paint (load), and the load it belongs to. */
  private pending: Scene | null = null;
  /** Where the pending scene opens (load's `at`), if not its own Scene.path. */
  private pendingAt: string[] | undefined;
  private loadSeq = 0;
  private busyEl: HTMLElement | null = null;
  private remixBtn!: HTMLButtonElement;
  sim: Sim | null = null;
  rootCtx: ViewCtx | null = null;
  ctx: ViewCtx | null = null;
  private view: SchematicView;
  private crumbs: HTMLElement;
  private bar: HTMLElement;
  private controls: HTMLElement;
  /** Drilled in, the bar says whose pins it drives (the top level's), and shows the open part's own pins read-only. */
  private scopeEl: HTMLElement | null = null;
  private innerEl: HTMLElement | null = null;
  private innerFor: ViewCtx | null = null;
  private innerVals: { el: HTMLElement; port: PortDef }[] = [];
  private crumbVals: { el: HTMLElement; v: CrumbValue }[] = [];
  private canvas: HTMLElement;
  /** Bottom-left stack for panels with `data-dock="left"` (see layoutDock). */
  private dock: HTMLElement;
  private levelBadge: HTMLElement;
  /** The how-to line at the canvas's bottom left, kept clear of the panels (placeHint). */
  private hint: HTMLElement;
  /** rightInset() when the cover was last synced: a fold, unfold or width change refits a fitted view. */
  private inset = 0;
  /** The automatic clock started this scene and the learner has done nothing since (autoRunning). */
  private autoRun = false;
  private status: HTMLElement;
  private leaf: { name: string; widget: Widget } | null = null;
  private widget: { w: Widget; host: HTMLElement } | null = null;
  private panels: Widget[] = [];
  /** Watches the scene's panels: folded, unfolded or resized, the fit makes room (syncCover). */
  private panelSize = new ResizeObserver(() => this.syncCover());
  /** The scene's foldable panels still wait for their first layout to decide whether they start folded. */
  private foldPending = false;
  private anim: ReturnType<typeof setInterval> | null = null;
  private runClock: ReturnType<typeof setInterval> | null = null;
  private runBtn: HTMLElement | null = null;
  private changeStart = 0;
  private lastSettle: number | null = null;
  private listeners = new Set<() => void>();
  private navListeners = new Set<(path: string[]) => void>();
  readonly analyzer = new LogicAnalyzer();
  private probeMode = false;
  private probeBtn: HTMLButtonElement;
  private timingBtn: HTMLButtonElement;
  private panesBtn: HTMLButtonElement;
  private moreBtn: HTMLButtonElement;
  /** Aborted by destroy(): the document listeners this stage added. */
  private life = new AbortController();
  private moreMenu: HTMLElement;
  /** The bar's buttons fitBar may move into More, in that order, with what each does there. */
  private shedGroups: { els: HTMLElement[]; items: { label: string; hint?: string; icon: string; on?: () => boolean; run: () => void }[] }[] = [];
  /** Fixed clock period in gate delays (null: every edge waits for the logic to settle). */
  private period: number | null = null;
  private nextEdge = 0;
  /** Events still pending at the last rising edge (fixed period only). */
  private lateEvents = 0;
  private lateCount = 0;
  /** Per-output radix chosen by clicking its value (else the global setting). */
  private outRadix = new Map<string, Radix>();
  private flash: string | null = null;
  private selected: string | null = null;
  leafFactory: LeafWidgetFactory | null = null;
  /** Rising clock edges since the scene was loaded or reset. */
  cycles = 0;
  /** Toggles of the scene's simulation, counted once the inspector's Power section asks (from cycle meterFrom). */
  private meter: PowerMeter | null = null;
  private meterFrom = 0;
  private meterPeriod: number | null | undefined;
  /** Observers of every rising clock edge: before (inputs still old) and after it settled. */
  readonly edgeHooks = new Set<{ before?: () => void; after?: () => void }>();
  /** The rising edge in progress (slow mode plays it one gate delay at a time). */
  private edge: StageEdge | null = null;
  private edgePeriod = 0;
  /** Panels' own state saved with every checkpoint and put back by back(). */
  readonly historyHooks = new Set<HistoryHook>();
  /** Panels' own state put back to its start by powerCycle() (Reset). */
  readonly resetHooks = new Set<() => void>();
  private history: Checkpoint[] = [];
  private backBtn: HTMLButtonElement | null = null;
  /** The breadboard view (Scene.breadboard), its toggles in the bar, and whether it is the one shown. */
  private board: BreadboardView;
  private boardOn = false;
  /** A chip (or a board's module) opened from the boards: its board beside its inside (Stage.syncDrill). */
  private drill: BbDrill | null = null;
  private drillFold = false;
  /** The panels the drill folded (unfolded again when it ends). */
  private drillFolded: HTMLElement[] = [];
  private viewSeg: HTMLElement;
  private wireSeg: HTMLElement;
  /** A chip opened from the boards: its DIP pins, live, in the bottom-left dock. */
  private pins: { path: string; el: HTMLElement; update(sim: Sim): void } | null = null;
  private beforeEdge(): void { this.edgeHooks.forEach((h) => h.before?.()); }
  private afterEdge(): void { this.edgeHooks.forEach((h) => h.after?.()); }

  constructor(inspector: Inspector) {
    this.inspector = inspector;
    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Hierarchy' });
    const btn = (ic: string, title: string, fn: () => void, cls = '') =>
      h('button', { class: `btn ghost icon-only${cls}`, title, 'aria-label': title, onclick: fn }, icon(ic, 16));
    this.probeBtn = h('button', { class: 'btn ghost sm toggle probe-btn', title: 'Probe mode (P): click any wire to add it to the timing diagram', onclick: () => this.setProbeMode(!this.probeMode) },
      icon('probe', 15), h('span', { class: 'lbl' }, 'Probe')) as HTMLButtonElement;
    this.timingBtn = h('button', { class: 'btn ghost sm toggle', title: 'Timing diagram: probed nets and ports over time', onclick: () => this.showAnalyzer(!this.el.classList.contains('with-analyzer')) },
      icon('wave', 15), h('span', { class: 'lbl' }, 'Timing')) as HTMLButtonElement;
    const remix = this.remixBtn = h('button', { class: 'btn ghost sm remix-btn', title: 'Open in Sandbox: an editable copy of the circuit on screen, as one of your own chips', onclick: () => this.remix() },
      icon('chip', 15), h('span', { class: 'lbl' }, 'Open in Sandbox'));
    // The level on screen as an image file (view/image.ts, loaded on first use).
    const imgMenu = h('div', { class: 'pal-menu img-menu', role: 'menu' });
    const imgItem = (kind: 'svg' | 'png', label: string, hint: string) => h('button', { role: 'menuitem', onclick: () => {
      imgMenu.classList.remove('open');
      this.exportImage(kind);
    } }, h('span', null, h('b', null, label), h('small', null, hint)));
    imgMenu.append(imgItem('svg', 'SVG', 'This level, whole, as drawn in the current theme'), imgItem('png', 'PNG', 'The same at 2× resolution'));
    const imgBtn = h('button', { class: 'btn ghost sm', title: 'Export this level as an image (SVG or PNG)', 'aria-haspopup': 'menu', onclick: (e: Event) => {
      e.stopPropagation();
      imgMenu.classList.toggle('open');
    } }, icon('image', 15), h('span', { class: 'lbl' }, 'Image'));
    document.addEventListener('pointerdown', (e) => {
      if (!imgMenu.contains(e.target as Node) && !imgBtn.contains(e.target as Node)) imgMenu.classList.remove('open');
    }, { signal: this.life.signal });
    // The learner's layout of this level (view/layout.ts): unravel its pointers, reset it. The menu closes on any
    // press outside it, this button's too: a press that found it open only closes it.
    let layoutWasOpen = false;
    const layoutBtn = h('button', {
      class: 'btn ghost sm', title: 'Layout: unravel pointers into wires, or reset this level (drag a part or a wire to move it)', 'aria-haspopup': 'menu',
      onpointerdown: () => (layoutWasOpen = this.view.menuOpen),
      onclick: (e: Event) => {
        if (layoutWasOpen) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.view.layoutMenu(r.left, r.bottom + 6);
      },
    }, icon('move', 15), h('span', { class: 'lbl' }, 'Layout'));
    // The side panes (narrative or library, inspector) fold away for a full-width circuit; the
    // choice is a setting (data-wide on <html>), so it holds across steps and pages.
    this.panesBtn = h('button', { class: 'btn ghost icon-only toggle panes-btn', onclick: () => {
      settings.set('wide', !settings.wide);
      applyTheme();
    } }, icon('sidebar', 16)) as HTMLButtonElement;
    this.syncPanesBtn();
    const imgWrap = h('div', { class: 'pal-wrap' }, imgBtn, imgMenu);
    const zoomOut = btn('minus', 'Zoom out', () => this.zoomBy(1.25), ' zoom-btn');
    const zoomIn = btn('plus', 'Zoom in', () => this.zoomBy(0.8), ' zoom-btn');
    // More: the buttons fitBar takes off a bar too narrow for them and the open level's name, as menu items
    const moreMenu = this.moreMenu = h('div', { class: 'pal-menu stage-more-menu', role: 'menu', 'aria-label': 'More tools' });
    const more = this.moreBtn = h('button', {
      class: 'btn ghost icon-only stage-more', title: 'More tools (the bar has no room for them)', 'aria-label': 'More tools',
      'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e: Event) => {
        e.stopPropagation();
        this.toggleMore(!moreMenu.classList.contains('open'));
      },
    }, icon('more', 16)) as HTMLButtonElement;
    const moreWrap = h('div', { class: 'pal-wrap stage-more-wrap', hidden: true }, more, moreMenu);
    document.addEventListener('pointerdown', (e) => {
      if (!moreWrap.contains(e.target as Node)) this.toggleMore(false);
    }, { signal: this.life.signal });
    moreMenu.addEventListener('keydown', (e) => {
      const items = [...moreMenu.querySelectorAll<HTMLElement>('button')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.toggleMore(false);
        more.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });
    const pressed = (b: HTMLElement) => b.classList.contains('on');
    // the order they go in: the least used first (a wheel or a pinch zooms; Up, Fit and the panes stay)
    this.shedGroups = [
      { els: [zoomOut, zoomIn], items: [{ label: 'Zoom out', icon: 'minus', run: () => this.zoomBy(1.25) }, { label: 'Zoom in', icon: 'plus', run: () => this.zoomBy(0.8) }] },
      { els: [imgWrap], items: [
        { label: 'Image as SVG', hint: 'This level, whole, as drawn in the current theme', icon: 'image', run: () => this.exportImage('svg') },
        { label: 'Image as PNG', hint: 'The same at 2× resolution', icon: 'image', run: () => this.exportImage('png') }] },
      { els: [layoutBtn], items: [{ label: 'Layout…', hint: 'Unravel pointers into wires, or reset this level', icon: 'move', run: () => {
        const r = more.getBoundingClientRect();
        this.view.layoutMenu(r.left, r.bottom + 6);
      } }] },
      { els: [remix], items: [{ label: 'Open in Sandbox', hint: 'An editable copy of the circuit on screen', icon: 'chip', run: () => this.remix() }] },
      { els: [this.timingBtn], items: [{ label: 'Timing diagram', icon: 'wave', on: () => pressed(this.timingBtn), run: () => this.timingBtn.click() }] },
      { els: [this.probeBtn], items: [{ label: 'Probe mode (P)', icon: 'probe', on: () => pressed(this.probeBtn), run: () => this.probeBtn.click() }] },
    ];
    // Schematic | Breadboard (a scene with Scene.breadboard), and the jumpers' look while the boards are shown
    const segBtn = (label: string, title: string, fn: () => void) => h('button', { title, 'aria-pressed': 'false', onclick: fn }, label);
    this.viewSeg = h('div', { class: 'seg bb-view', role: 'group', 'aria-label': 'View', hidden: true },
      segBtn('Schematic', 'The circuit as a schematic you can open level by level', () => this.showBoards(false)),
      segBtn('Breadboard', 'The circuit as built: chips on breadboards, every LED a net of the same simulation', () => this.showBoards(true)));
    this.wireSeg = h('div', { class: 'seg bb-wires bb-only', role: 'group', 'aria-label': 'Wire colours', hidden: true },
      segBtn('Wires as built', 'Jumpers in their own colours', () => this.setWires('built')),
      segBtn('By value', 'Jumpers coloured by value, as on the schematics', () => this.setWires('value')));
    this.board = new BreadboardView({
      toggle: (port, bit) => {
        const p = this.scene?.root.ports.find((q) => q.name === port);
        if (!p) return;
        if (p.width === 1) this.toggleInput(port);
        else this.setInput(port, this.getInput(port) ^ (1 << bit));
      },
      input: (port) => this.getInput(port),
      open: (path) => this.openFromBoard(path),
      select: () => this.showInspector(),
      // the right-docked panels (a folded one's strip too) and a challenge note float over the boards
      covers: () => [
        ...this.panels.filter((p) => p.el.dataset.dock === 'right').map((p) => p.el.getBoundingClientRect()),
        ...[...this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')].map((n) => n.getBoundingClientRect()),
      ],
    });
    for (const b of [imgWrap, layoutBtn, this.probeBtn]) b.classList.add('sch-only');
    // zoom and Fit work on the boards too (their own camera)
    const upBtn = btn('up', 'Up one level (Esc)', () => this.up()), fitBtn = btn('fit', 'Fit to screen', () => (this.boardOn ? this.board.fitAll() : this.view.fit()));
    upBtn.classList.add('sch-only');
    const bar = this.bar = h('div', { class: 'stage-bar' },
      this.viewSeg, this.crumbs, this.wireSeg, remix, imgWrap, layoutBtn, this.probeBtn, this.timingBtn, moreWrap,
      upBtn, zoomOut, zoomIn, fitBtn,
      this.panesBtn);
    this.canvas = h('div', { class: 'canvas' });
    this.levelBadge = h('div', { class: 'level-badge' });
    this.dock = h('div', { class: 'panel-dock' });
    // Touch: dblclick comes from a double tap; the Layout button stands in for the right-click menu.
    this.hint = hintBadge('double-click a part to open it · drag a part or a wire to move it (shift: pick several) · right-click for layout · drag to pan · wheel or pinch to zoom',
      'double-tap a part: open · drag: move / pan (a wire: tap it first) · pinch: zoom', 'stage');
    this.canvas.append(this.levelBadge, this.hint, this.dock, this.board.el);
    this.controls = h('div', { class: 'controls' });
    this.status = h('div', { class: 'status' });
    this.el = h('section', { class: 'stage' }, bar, this.canvas, this.analyzer.el, this.controls);
    this.analyzer.onClose = () => this.showAnalyzer(false);
    this.analyzer.onLanesChange = () => this.view.drawProbes();
    this.view = new SchematicView(this.canvas, {
      open: (c) => this.open(c),
      select: (c) => this.select(c),
      toggleInput: (p) => this.toggleInput(p),
      editInput: (p, r) => this.editInput(p, r),
      netClick: (i) => this.netClick(i),
      probeOf: (i) => this.probeOf(i),
    });
    this.view.arrange = true;
    // Tab-reachable (and S or the skip link focus it, ui/quicknav.ts): its keys work while it has focus
    this.el.tabIndex = 0;
    this.el.setAttribute('aria-label', 'Circuit');
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      // the learner's layout: undo / redo, and Esc lets go of picked parts before it goes up a level
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        if (this.view.undo(k === 'y' || e.shiftKey)) e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && this.view.dropGroup()) return;
      if (matches(e, 'stage.probe') && shortcutAllowed(e)) this.setProbeMode(!this.probeMode);
      if (e.key === 'Escape' && this.probeMode) {
        this.setProbeMode(false);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        this.up();
      }
    });
    settings.onChange(() => {
      this.syncPanesBtn();
      this.analyzer.radix = settings.radix;
      this.view.radix = settings.radix;
      this.inspector.radix = settings.radix;
      this.board.radix = settings.radix;
      this.refresh();
    });
    this.view.radix = settings.radix;
    this.inspector.radix = settings.radix;
    // The canvas also changes size during a run (the bottom bar rewraps as values and the status
    // change): a view the learner zoomed into must survive that.
    new ResizeObserver(() => {
      this.autoFold();
      this.inset = this.rightInset();
      this.drillLayout();
      this.layoutDock(false);
      this.view.resized();
      this.fitBar();
      this.fitControls();
    }).observe(this.canvas);
    // web fonts change every label's width without resizing the canvas (a weight first used later loads later)
    document.fonts?.addEventListener('loadingdone', () => {
      this.fitBar();
      this.fitControls();
    }, { signal: this.life.signal });
  }

  /** Open or close the bar's More menu, filled with the shed buttons' actions as they stand now. */
  private toggleMore(open: boolean): void {
    const menu = this.moreMenu, more = this.moreBtn;
    if (open === menu.classList.contains('open')) return;
    menu.classList.toggle('open', open);
    more.setAttribute('aria-expanded', String(open));
    if (!open) return;
    menu.replaceChildren();
    for (const g of this.shedGroups) {
      if (!g.els[0].classList.contains('shed') || g.els[0].hidden) continue;
      for (const it of g.items) {
        const on = it.on?.();
        menu.append(h('button', {
          role: on === undefined ? 'menuitem' : 'menuitemcheckbox', ...(on === undefined ? {} : { 'aria-checked': String(on) }),
          onclick: () => {
            this.toggleMore(false);
            it.run();
          },
        }, icon(it.icon, 16), h('span', null, h('b', null, it.label), it.hint ? h('small', null, it.hint) : null)));
      }
    }
    menu.querySelector<HTMLElement>('button')?.focus();
  }

  private syncPanesBtn(): void {
    const t = settings.wide ? 'Show the side panes' : 'Hide the side panes: the circuit full width';
    this.panesBtn.classList.toggle('on', settings.wide);
    this.panesBtn.title = t;
    this.panesBtn.setAttribute('aria-label', t);
    this.panesBtn.setAttribute('aria-pressed', String(settings.wide));
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  onNavigate(f: (path: string[]) => void): () => void {
    this.navListeners.add(f);
    return () => this.navListeners.delete(f);
  }

  /** Replace the schematic with a bespoke widget (null returns to schematic mode). */
  showWidget(w: Widget | null): void {
    if (w && this.pending) {
      // a widget step came before the big scene was built: it wins
      this.loadSeq++;
      this.pending = null;
      this.busy(null);
    }
    if (this.widget) {
      this.widget.w.destroy?.();
      this.widget.host.remove();
      this.widget = null;
    }
    this.el.classList.toggle('widget-mode', !!w);
    if (!w) return;
    this.stopAnim();
    this.stopClock();
    const host = h('div', { class: 'widget-host' }, w.el);
    this.canvas.append(host);
    this.widget = { w, host };
  }

  /** The scene on the stage, or the big one being built for it (load). */
  get target(): Scene | null {
    return this.pending ?? this.scene;
  }

  /**
   * Show a scene. A big one (BUSY_GATES) first puts a "Building…" cue over the canvas and is built once that has
   * painted, a frame later: building is one synchronous stretch of up to a second, which would otherwise freeze the
   * page with no sign of why. Until then the old scene stays (under the cue) and `scene` is still the old one.
   * `at`: open this path instead of Scene.path (a drill path from the address bar), which stays the scene's opening view.
   */
  load(scene: Scene, at?: string[]): void {
    const seq = ++this.loadSeq;
    const st = stats(scene.root);
    const size = st.nands + st.transistors / 4;
    if (size < BUSY_GATES) {
      this.pending = null;
      this.busy(null);
      this.build(scene, at);
      return;
    }
    this.pending = scene;
    this.pendingAt = at;
    this.stopAnim();
    this.stopClock();
    this.busy(st.nands ? `Building the circuit: ${st.nands.toLocaleString()} NAND gates…` : 'Building the circuit…');
    afterPaint(() => {
      if (seq !== this.loadSeq) return;
      this.pending = null;
      try {
        this.build(scene, at);
      } finally {
        this.busy(null);
      }
    });
  }

  /** The "Building…" cue over the canvas (null removes it). */
  private busy(text: string | null): void {
    this.busyEl?.remove();
    this.busyEl = text === null ? null
      : h('div', { class: 'stage-busy', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'stage-busy-box' }, h('span', { class: 'stage-busy-spin', 'aria-hidden': 'true' }), text));
    if (this.busyEl) this.canvas.append(this.busyEl);
  }

  private build(scene: Scene, at?: string[]): void {
    this.edgeHooks.clear();
    this.historyHooks.clear();
    this.resetHooks.clear();
    this.history = [];
    this.showWidget(null);
    this.stopAnim();
    this.stopClock();
    closePopover();
    this.release();
    this.scene = scene;
    const level = needsSwitchLevel(scene.root) ? 'switch' : 'gate';
    // The root is always its structure, even one simulated as a lookup elsewhere (a large RAM opened
    // in the workbench); such parts below it stay leaves and open onto their own sub-simulation.
    const design = flatten(scene.root, { mode: level, expand: (d, n) => n.parent === null || !d.preferBehavior });
    const sim: Sim = level === 'switch' ? switchSim(design, scene.engine === 'nmos')
      : scene.engine === 'cycle' ? new DualSim(design) : new GateSim(design);
    if (sim instanceof DualSim) sim.preferFast = true;
    for (const [k, v] of Object.entries(scene.inputs ?? {})) sim.setInput(k, v);
    sim.reset(scene.powerOn ?? 'zero');
    sim.settle();
    this.sim = sim;
    this.edge = null;
    this.cycles = 0;
    // toggles counted from the start (an increment per change), so the inspector's Power section has the whole run
    this.meter = sim instanceof GateSim ? new PowerMeter(sim) : null;
    this.meterFrom = 0;
    this.meterPeriod = undefined;
    this.rootCtx = new ViewCtx(sim, design.root);
    this.lastSettle = null;
    this.period = null;
    this.lateEvents = 0;
    this.setProbeMode(false);
    this.initAnalyzer();
    const start = at ?? scene.path ?? [];
    if (scene.breadboard) {
      this.board.show(scene.breadboard, design.root);
      this.board.radix = settings.radix;
    }
    this.viewSeg.hidden = !scene.breadboard;
    this.wireSeg.hidden = !scene.breadboard;
    this.setWires(wireChoice);
    this.setBoardShown(!!scene.breadboard && boardChoice && !start.length);
    this.goTo(start, false);
    this.buildControls();
    this.remixBtn.hidden = !!scene.noRemix;
    this.view.highlight(scene.highlight ?? []);
    this.board.highlight(scene.highlight ?? [], true);
    this.panels = (scene.panels ?? []).map((f) => f(this));
    for (const p of this.panels) (p.el.dataset.dock === 'left' ? this.dock : this.canvas).append(p.el);
    for (const p of this.panels) if (p.el.dataset.dock === 'right' || p.el.dataset.fold) this.foldable(p.el);
    for (const p of this.panels) this.panelSize.observe(p.el);
    this.foldPending = true;
    this.autoFold();
    this.inset = this.rightInset();
    this.layoutDock(false);
    this.view.fit();
    this.refresh();
    if (settings.autoClock && scene.autoClock !== false) { this.startClock(); this.autoRun = this.clockRunning; }
  }

  /**
   * Let go of the last scene before the next one is built: two designs of chapter 34's size at once
   * (each about half a gigabyte) are more than some browsers allow a tab, and the tab died.
   */
  private release(): void {
    this.panelSize.disconnect();
    this.panels.forEach((p) => { p.destroy?.(); p.el.remove(); });
    this.panels = [];
    this.closeLeaf();
    this.view.clear();
    this.board.clear();
    this.dropPins();
    this.drill = null;
    this.el.classList.remove('bb-drill', 'bb-stacked');
    this.inspector.clear();
    this.analyzer.detach();
    this.sim = null;
    this.rootCtx = null;
    this.ctx = null;
    this.meter = null;
    this.edge = null;
  }

  /** Navigate to a path of instance names from the root. */
  goTo(path: string[], notify = true): void {
    if (!this.rootCtx) return;
    this.closeLeaf();
    let ctx = this.rootCtx;
    let leafName: string | null = null;
    for (let i = 0; i < path.length; i++) {
      const name = path[i];
      const c = ctx.child(name);
      if (!c) {
        const def = ctx.node.children?.get(name)?.def;
        if (def && (def.prim === 'nmos' || def.prim === 'pmos') && i === path.length - 1) leafName = name;
        break;
      }
      ctx = c;
    }
    this.ctx = ctx;
    this.selected = null;
    // a drill path (a chip opened, Back / Forward to one) is a schematic's, beside its board while the learner
    // follows the boards; back at the top from there, the boards again
    if (this.boardOn && ctx !== this.rootCtx) this.setBoardShown(false);
    if (ctx === this.rootCtx && this.drill && boardChoice) this.setBoardShown(true);
    else this.syncDrill();
    this.syncPins();
    this.view.cover = this.covers();
    this.view.show(ctx, ctx === this.rootCtx);
    // a drill begun where the right-docked panels leave no room for two columns but folded would: they fold (unless
    // the learner folded or unfolded one by hand), and unfold again when the drill ends
    if (this.drillFold) {
      this.drillFold = false;
      const W = this.canvas.clientWidth;
      const open = this.panels.filter((p) => p.el.dataset.dock === 'right' && p.el.dataset.fold && !p.el.classList.contains('collapsed'));
      if (open.length && !foldChoice.has('right') && W - this.inset < DRILL_STACK_PX && W >= DRILL_STACK_PX) {
        for (const p of open) p.el.classList.add('collapsed');
        this.drillFolded = open.map((p) => p.el);
        this.inset = this.rightInset();
      }
      this.drillLayout();
      this.view.setCover(this.covers(), true);
    }
    // Another level, another shape: the how-to line may fit beside it now, or no longer.
    if (this.placeHint()) {
      this.view.cover = this.covers();
      this.view.fit();
    }
    if (ctx === this.rootCtx && this.scene) {
      this.view.highlight(this.scene.highlight ?? []);
      this.board.highlight(this.scene.highlight ?? []);
    }
    if (leafName) this.openLeaf(leafName);
    this.renderCrumbs();
    this.showInspector();
    if (notify) this.navListeners.forEach((f) => f(this.path));
  }

  get path(): string[] {
    const p = this.ctx?.path ?? [];
    return this.leaf ? [...p, this.leaf.name] : p;
  }

  /** The path on screen, or the one a scene still being built will open on. */
  get targetPath(): string[] {
    return this.pending ? this.pendingAt ?? this.pending.path ?? [] : this.path;
  }

  /** Open `path` unless it is open already (Back / Forward to a drill path); a scene still being built opens there. */
  openPath(path: string[]): void {
    if (this.pending) {
      this.pendingAt = path;
      return;
    }
    const cur = this.path;
    if (path.length !== cur.length || path.some((x, i) => x !== cur[i])) this.goTo(path);
  }

  open(child: string): void {
    if (!this.ctx) return;
    const def = this.ctx.node.children?.get(child)?.def;
    if (def && (def.prim === 'nmos' || def.prim === 'pmos')) {
      this.openLeaf(child);
      this.renderCrumbs();
      this.showInspector();
      this.navListeners.forEach((f) => f(this.path));
      return;
    }
    if (!this.ctx.canOpen(child)) return;
    this.goTo([...this.ctx.path, child]);
  }

  up(): void {
    if (this.leaf) {
      this.closeLeaf();
      this.renderCrumbs();
      this.navListeners.forEach((f) => f(this.path));
      return;
    }
    if (this.ctx?.parent) this.goTo(this.ctx.parent.path);
  }

  // ---- the breadboard view ----------------------------------------------------------------

  /** Schematic | Breadboard, by the learner: remembered for the next scene that has boards. */
  showBoards(on: boolean): void {
    if (!this.scene?.breadboard) return;
    boardChoice = on;
    if (on && this.ctx !== this.rootCtx) this.goTo([]);
    this.setBoardShown(on);
    this.refresh();
  }

  /** The bar's zoom buttons: on the boards while they are shown, else on the schematic. */
  private zoomBy(f: number): void {
    if (this.boardOn) this.board.zoom(f);
    else this.view.zoom(f);
  }

  /** The boards are on screen (the schematic is not painted meanwhile). */
  get boardsShown(): boolean {
    return this.boardOn;
  }

  private setBoardShown(on: boolean): void {
    this.boardOn = on;
    this.el.classList.toggle('bb-mode', on);
    if (this.syncDrill()) this.view.setCover(this.covers(), true);
    const [sch, bb] = [...this.viewSeg.querySelectorAll('button')];
    sch.classList.toggle('on', !on);
    sch.setAttribute('aria-pressed', String(!on));
    bb.classList.toggle('on', on);
    bb.setAttribute('aria-pressed', String(on));
    if (on) this.setProbeMode(false);
    this.syncPins();
    this.fitBar();
  }

  private setWires(w: WireLook): void {
    wireChoice = w;
    this.board.wires = w;
    [...this.wireSeg.querySelectorAll('button')].forEach((b, i) => {
      const on = (i === 0) === (w === 'built');
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  /**
   * The drill pane: while the learner follows the boards (boardChoice) and the schematic shows a chip or a module the
   * boards hold, its board zoomed beside it (a left column, or the top part of a narrow canvas: drillPane), with the
   * breadcrumb and the chip's pins; the schematic fits the rest. True when it came or went.
   */
  private syncDrill(): boolean {
    const lay = this.scene?.breadboard, ctx = this.ctx;
    const d = lay && ctx && boardChoice && !this.boardOn ? drillOf(lay, ctx.path) : null;
    const changed = !!d !== !!this.drill;
    if (d && !this.drill) this.drillFold = true;
    if (!d && this.drill && this.drillFolded.length) {
      if (!foldChoice.has('right')) for (const el of this.drillFolded) el.classList.remove('collapsed');
      this.drillFolded = [];
    }
    this.drill = d;
    this.el.classList.toggle('bb-drill', !!d);
    this.board.el.hidden = !(this.boardOn || d);
    if (d && ctx) {
      this.drillLayout();
      const root = this.sim?.design.root;
      this.board.drill(d, drillCrumbs(d, ctx.path, (p) => (root && findNode(root, p)?.def.name) ?? ''), (to) => (to === 'boards' ? this.showBoards(true) : this.goTo(to)));
      if (this.sim) {
        this.board.sim = this.sim;
        this.board.update(this.sim);
      }
    } else this.board.drill(null);
    return changed;
  }

  /** The drill pane's size on this canvas (--bb-drill-w / -h, breadboard.css), beside the right-docked panels. */
  private drillLayout(): void {
    if (!this.drill) return;
    this.boardCover();
    // stacked, the pane starts below a folded panel's strip (--bb-top): it shares what is left with the schematic
    const top = parseFloat(this.canvas.style.getPropertyValue('--bb-top')) || 0;
    const p = drillPane(this.canvas.clientWidth, this.canvas.clientHeight - top, this.inset);
    this.el.classList.toggle('bb-stacked', p.stacked);
    this.canvas.style.setProperty('--bb-drill-w', `${p.w}px`);
    this.canvas.style.setProperty('--bb-drill-h', `${p.h}px`);
  }

  /** A chip or a board's module double-clicked: its schematic, through the drill path (one history entry per level). */
  private openFromBoard(path: string[]): void {
    this.setBoardShown(false);
    this.goTo(path);
    this.refresh();
  }

  /** The chip open on the schematic, if the boards list it with a pin map. */
  private pinnedChip(): BbChip | null {
    if (this.drill) return this.drill.chip?.pins ? this.drill.chip : null;
    const lay = this.scene?.breadboard, ctx = this.ctx;
    if (!lay || !ctx || this.boardOn || this.leaf) return null;
    const key = ctx.path.join('.');
    for (const b of lay.boards) for (const c of b.chips) if (c.pins && c.path && c.path.join('.') === key) return c;
    return null;
  }

  /** Show (or drop) the pin card of the chip open on the schematic. */
  private syncPins(): void {
    const d = this.drill;
    const chip = this.pinnedChip();
    const key = d ? `drill:${d.board.title}:${d.chip?.path?.join('.') ?? ''}` : chip?.path?.join('.') ?? '';
    if (this.pins?.path === key && (chip || d)) return;
    this.dropPins();
    const root = this.sim?.design.root;
    const node = chip?.path && root ? findNode(root, chip.path) : null;
    const card = chip && node ? pinCard(chip, node, () => this.showBoards(true)) : null;
    if (d) {
      // under the board: the pins, and what the chip (or the board) is
      const at = d.chip?.path ?? d.board.module;
      const def = at && root ? findNode(root, at)?.def : undefined;
      const el = h('div', { class: 'bb-drill-cards' }, card?.el, drillNotes(d, def));
      this.pins = { path: key, el, update: (sim) => card?.update(sim) };
      this.board.drillFoot.replaceChildren(el);
      if (this.sim) card?.update(this.sim);
      return;
    }
    if (!card) return;
    this.pins = { path: key, ...card };
    this.dock.append(card.el);
    if (this.sim) card.update(this.sim);
    this.layoutDock();
  }

  private dropPins(): void {
    if (!this.pins) return;
    const docked = this.pins.el.parentElement === this.dock;
    this.pins.el.remove();
    this.pins = null;
    if (docked) this.layoutDock();
  }

  /** The level on screen as a new sandbox chip (remix.ts is loaded on demand), then go there. */
  private remix(): void {
    const shown = this.ctx?.def;
    if (!shown) return;
    // as the learner arranged it: moved parts, unravelled pointers drawn as wires
    const lay = layoutOf(shown.id), nl = netlistOf(shown);
    const def: ComponentDef = lay && nl ? { ...shown, netlist: () => applyLayout(nl, lay) } : shown;
    import('../editor/remix').then((m) => {
      const r = m.remixIntoStorage(def);
      if ('error' in r) this.setStatus(h('span', { class: 'pulse warn' }), `Cannot open in the sandbox: ${r.error}`);
      else location.hash = `#/sandbox/${r.id}`;
    }, (e) => this.setStatus(h('span', { class: 'pulse warn' }), `The sandbox could not load: ${String(e)}`));
  }

  private exportImage(kind: 'svg' | 'png'): void {
    const def = this.ctx?.def;
    if (!def) return;
    const fail = (e: unknown) => this.setStatus(h('span', { class: 'pulse warn' }), `Cannot export the image: ${e instanceof Error ? e.message : String(e)}`);
    import('./image').then((m) => m.exportSchematic(this.view, def.name, kind)).catch(fail);
  }

  select(child: string | null): void {
    this.selected = child;
    this.showInspector();
  }

  private openLeaf(name: string): void {
    if (!this.leafFactory || !this.ctx) return;
    const ctx = this.ctx;
    const def = ctx.node.children!.get(name)!.def;
    const widget = this.leafFactory(def, () => ctx.transistorGate(name));
    const host = h('div', { class: 'widget-host' }, widget.el);
    widget.el = host;
    this.canvas.append(host);
    this.leaf = { name, widget };
    this.levelBadge.textContent = 'level: a single transistor';
  }

  private closeLeaf(): void {
    if (!this.leaf) return;
    this.leaf.widget.destroy?.();
    this.leaf.widget.el.remove();
    this.leaf = null;
  }

  // ---- inputs ------------------------------------------------------------------------------

  private clockPort(): string | null {
    const r = this.scene?.root;
    if (!r) return null;
    if (this.scene!.clock) return this.scene!.clock;
    const p = r.ports.find((q) => q.dir === 'in' && (q.clock || q.name === 'clk'));
    return p?.name ?? null;
  }

  setInput(port: string, value: number): void {
    if (!this.sim) return;
    this.checkpoint();
    this.sim.setInput(port, value);
    this.propagate();
  }

  setInputs(values: Record<string, number>): void {
    if (!this.sim) return;
    this.checkpoint();
    for (const [k, v] of Object.entries(values)) this.sim.setInput(k, v);
    this.propagate();
  }

  getInput(port: string): number {
    return this.sim?.getInput(port) ?? 0;
  }

  /** Packed value of a root port (-1 if any bit is X/Z). */
  value(port: string): number {
    if (!this.sim) return -1;
    return pack(this.sim.getBits(this.sim.design.root.ports[port]));
  }

  toggleInput(port: string): void {
    this.checkpoint();
    const v = this.getInput(port) ? 0 : 1;
    if (port === this.clockPort()) {
      this.stopClock();
      this.finishEdge(false);
    }
    const edge = v === 1 && port === this.clockPort();
    if (edge) {
      this.beforeEdge();
      this.cycles++;
      this.sim?.setInput(port, 1);
      this.sim?.settle();
      this.afterEdge();
      this.lastSettle = null;
      this.refresh();
      return;
    }
    this.setInput(port, v);
  }

  private editInput(port: string, anchor: DOMRect): void {
    const p = this.scene!.root.ports.find((q) => q.name === port)!;
    // bit by bit: a wide port (a pipeline register's 97-bit word) stays exact
    const bits = this.sim?.getInputBits(port);
    editNumber(anchor, port, p.width, (bits && packBig(bits)) ?? 0n, (v) => {
      if (!this.sim) return;
      this.checkpoint();
      this.sim.setInputBits(port, unpackBig(v, p.width));
      this.propagate();
    });
  }

  /**
   * One full clock cycle. With no fixed period every half waits until the logic has
   * settled; with a period P the rising edge comes every P gate delays whether or not
   * the logic is done (which is how real hardware fails when overclocked).
   */
  private cycle(clk: string): void {
    this.rise(clk);
    completeEdge(this.sim!, this.edge!);
    this.fall();
  }

  /** Raise the clock (the edge hooks' `before` runs first); the logic has not moved yet. */
  private rise(clk: string): void {
    const sim = this.sim!;
    let end: number | null = null;
    if (this.period && sim.runUntil) {
      const P = this.period;
      const E = Math.max(sim.time, this.nextEdge);
      sim.runUntil(E);
      this.lateEvents = sim.busy() ? 1 : 0;
      if (this.lateEvents) {
        this.lateCount++;
        this.analyzer.markLate(E);
      }
      end = E + Math.ceil(P / 2);
      this.edgePeriod = P;
    }
    this.beforeEdge();
    this.edge = riseEdge(sim, clk, end);
    this.changeStart = this.edge.start;
    this.cycles++;
  }

  /** End of the high phase: the edge hooks' `after`, then the falling half of the cycle. */
  private fall(): void {
    const sim = this.sim!;
    const e = this.edge!;
    this.edge = null;
    if (!e.held) this.afterEdge();
    if (e.end !== null) {
      // e.start is the edge time E; the next one comes at E + P (the period the edge started with).
      const P = this.edgePeriod;
      sim.setInput(e.clk, 0);
      sim.runUntil!(e.start + P);
      this.nextEdge = e.start + P;
      this.lastSettle = null;
      return;
    }
    // Measure the rising edge: that is when the flip-flops launch new values through the logic.
    this.lastSettle = sim.time - e.start;
    sim.setInput(e.clk, 0);
    sim.settle();
  }

  /** A rising edge is being played one gate delay at a time (Run's settled high half is not one). */
  get inEdge(): boolean {
    return !!this.edge && !this.edge.held;
  }

  /** Slow mode: raise the clock and show the instant of the edge; edgeStep() plays the rest. */
  startEdge(): boolean {
    const clk = this.clockPort();
    if (!clk || !this.sim) return false;
    this.stopClock();
    this.checkpoint();
    this.finishEdge(false);
    this.stopAnim();
    this.rise(clk);
    this.refresh();
    return true;
  }

  /** Slow mode: one gate delay of the edge in progress. Returns true while it is still propagating. */
  edgeStep(flowMs: number): boolean {
    if (!this.edge || !this.sim) return false;
    this.checkpoint();
    const more = stepEdge(this.sim, this.edge);
    if (!more) this.fall();
    this.refreshFlowing(flowMs);
    return more;
  }

  /** Complete a slow-mode edge at once (before anything else touches the clock). */
  finishEdge(refresh = true): void {
    if (!this.edge || !this.sim) return;
    completeEdge(this.sim, this.edge);
    this.fall();
    if (refresh) this.refresh();
  }

  /** One full clock cycle by hand (a running clock pauses), then refresh (changed wires show a travelling front for flowMs). */
  pulse(flowMs = 0): void {
    this.stopClock();
    this.tick(flowMs);
  }

  /** Run: half a clock period, the rising edge (settled) or the fall, so the clock is seen high for half of it. */
  private halfTick(): void {
    const clk = this.clockPort();
    if (!clk || !this.sim) return;
    this.stopAnim();
    if (this.edge) {
      this.fall();
      this.refresh();
      return;
    }
    const auto = this.autoRun;
    this.checkpoint();
    this.autoRun = auto; // the running clock is not the learner
    this.rise(clk);
    const e = this.edge!;
    completeEdge(this.sim, e);
    // The edge is over: panels (golden model, trace, energy) take it now, so the fall changes nothing they
    // show; holding them until the fall made them flip between two layouts every half period.
    e.held = true;
    if (e.end === null) this.lastSettle = this.sim.time - e.start;
    this.afterEdge();
    this.refresh();
  }

  /** One full clock cycle. */
  private tick(flowMs = 0): void {
    const clk = this.clockPort();
    if (!clk || !this.sim) return;
    this.checkpoint();
    this.finishEdge(false);
    this.stopAnim();
    this.cycle(clk);
    this.refreshFlowing(flowMs);
  }

  /** Run n clock cycles as fast as possible, refreshing the view once at the end. */
  runCycles(n: number, stop?: () => boolean, flowMs = 0): number {
    const clk = this.clockPort();
    if (!clk || !this.sim) return 0;
    this.stopClock();
    this.finishEdge(false);
    this.stopAnim();
    let i = 0;
    for (; i < n && !(stop && stop()); i++) this.cycle(clk);
    this.lastSettle = null;
    this.refreshFlowing(flowMs);
    return i;
  }

  /** Clock period in gate delays (null: wait for the logic to settle at every edge). */
  setPeriod(p: number | null): void {
    this.period = p && p > 1 ? Math.round(p) : null;
    if (this.sim) this.nextEdge = this.sim.time;
    this.lateEvents = 0;
    this.lateCount = 0;
    this.updateControls();
  }

  // ---- probes & timing ---------------------------------------------------------------------

  private initAnalyzer(): void {
    const sim = this.sim!;
    // the analyzer listens to every change with its time: on a DualSim that would keep it on GateSim
    const gate = sim.kind === 'gate' && !(sim instanceof DualSim);
    this.timingBtn.hidden = !gate;
    this.probeBtn.hidden = !gate;
    if (!gate) {
      this.analyzer.detach();
      this.showAnalyzer(false, false);
      return;
    }
    const r = this.scene!.root;
    const clk = this.clockPort();
    const ports = [...r.ports].sort((a, b) => Number(b.name === clk) - Number(a.name === clk)).slice(0, 8);
    this.analyzer.radix = settings.radix;
    this.analyzer.setLanes(ports.map((p) => ({
      label: p.name, title: p.name, nets: [...sim.design.root.ports[p.name]], width: p.width,
      color: -1, probe: false, clock: p.name === clk,
    })));
    this.analyzer.attach(sim);
    this.showAnalyzer(!!this.scene!.analyzer || settings.analyzer, false);
  }

  showAnalyzer(on: boolean, remember = true): void {
    this.el.classList.toggle('with-analyzer', on);
    this.timingBtn.classList.toggle('on', on);
    if (remember) settings.set('analyzer', on);
    if (on) this.analyzer.update();
  }

  private setProbeMode(on: boolean): void {
    if (on && (this.sim?.kind !== 'gate' || this.sim instanceof DualSim)) return;
    this.probeMode = on;
    this.probeBtn.classList.toggle('on', on);
    this.canvas.classList.toggle('probing', on);
    if (on && !this.el.classList.contains('with-analyzer')) this.showAnalyzer(true);
  }

  /** Flat nets of a net in the current view, if it lives in the scene's own simulation. */
  private flatNets(idx: number): number[] | null {
    const ctx = this.ctx;
    if (!ctx || ctx.sim !== this.sim) return null;
    return ctx.node.nets?.[idx] ? [...ctx.node.nets[idx]] : null;
  }

  private probeOf(idx: number): { color: number; label: string } | null {
    const nets = this.flatNets(idx);
    const lane = nets && this.analyzer.probeFor(netKey(nets));
    return lane ? { color: lane.color, label: lane.label } : null;
  }

  /** In probe mode a click on a wire adds (or removes) a probe instead of selecting. */
  private netClick(idx: number): boolean {
    if (!this.probeMode || !this.ctx) return false;
    const nets = this.flatNets(idx);
    if (!nets) {
      this.flash = 'This level is a separate lock-step simulation: probe its ports from the level above.';
      this.updateControls();
      return true;
    }
    const hit = this.analyzer.probeFor(netKey(nets));
    if (hit) {
      this.analyzer.remove(hit.id);
      return true;
    }
    const nl = netlistOf(this.ctx.def)!;
    const net = nl.nets[idx];
    const name = net.name ?? net.ends.find((e) => !e.includes('.')) ?? net.ends[0];
    const where = this.ctx.path;
    this.analyzer.add({
      label: [...where.slice(-1), name].join('.'), title: [...where, name].join('.'),
      nets, width: nets.length, color: this.analyzer.nextColor(), probe: true, clock: false,
    });
    return true;
  }

  /** A switch-level design with relays: its time is relay steps, played like gate delays. */
  private get relayTime(): boolean {
    return this.sim instanceof SwitchSim && this.sim.hasRelays;
  }

  private propagate(): void {
    if (!this.sim) return;
    this.changeStart = this.sim.time;
    if ((settings.animate || this.scene?.animate) && (this.sim.kind === 'gate' || this.relayTime)) {
      this.startAnim();
    } else {
      this.sim.settle();
      this.lastSettle = this.sim.time - this.changeStart;
      this.refresh();
    }
  }

  private startAnim(): void {
    this.stopAnim();
    const sim = this.sim!;
    const tick = () => {
      if (!sim.step()) {
        this.stopAnim();
        this.lastSettle = sim.time - this.changeStart;
      }
      this.refreshFlowing(950 / settings.speed);
    };
    tick();
    if (sim.busy()) this.anim = setInterval(tick, 1000 / settings.speed);
  }

  stopAnim(): void {
    if (this.anim) clearInterval(this.anim);
    this.anim = null;
  }

  /** Stop the stage's own Run (the CPU panel's slow mode takes over the clock). */
  stopClock(): void {
    if (this.runClock) {
      clearInterval(this.runClock);
      this.runClock = null;
      // a run stopped while the clock is high: finish that cycle
      this.finishEdge();
    }
    this.syncRunBtn();
  }

  /** The stage's own Run: a full clock cycle every RUN_MS (the automatic clock starts it on load). */
  startClock(): void {
    this.autoRun = false; // a Run by hand (load sets it again for the automatic one)
    if (this.runClock || !this.clockPort() || !this.sim || this.widget) return;
    this.runClock = setInterval(() => this.halfTick(), RUN_MS / 2);
    this.syncRunBtn();
  }

  /** Running only because the automatic clock started it: a Try condition that holds now was not the learner's doing. */
  get autoRunning(): boolean {
    return this.autoRun && this.runClock !== null;
  }

  get clockRunning(): boolean {
    return this.runClock !== null;
  }

  private syncRunBtn(): void {
    const b = this.runBtn;
    if (!b) return;
    const on = !!this.runClock;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren(icon(on ? 'pause' : 'play', 14), h('span', { class: 'lbl' }, on ? 'Pause' : 'Run'));
    b.setAttribute('aria-label', on ? 'Pause the clock' : 'Run the clock');
    this.fitControls();
  }

  /** Step one gate delay (works whether or not animation is on). */
  stepOnce(): void {
    if (!this.sim) return;
    this.stopClock();
    this.checkpoint();
    this.stopAnim();
    if (!this.sim.step()) this.lastSettle = this.sim.time - this.changeStart;
    this.refreshFlowing(Math.max(350, 950 / settings.speed));
  }

  private stateKey(): string {
    const sim = this.sim!;
    return `${sim.time}·${sim.evaluations}·${this.cycles}`;
  }

  /**
   * Remember the state before a step, an edge or an input change, for back(). The stage's own
   * controls take one before acting; a panel that drives several of them as one step (Run to
   * halt, an instruction) takes one first, and the ones inside it then find nothing changed.
   */
  checkpoint(): void {
    // the learner acted (every control saves a step for Back first): the circuit is no longer only running by itself
    this.autoRun = false;
    if (!this.sim) return;
    const key = this.stateKey();
    if (this.history[this.history.length - 1]?.key === key) return;
    this.history.push({
      sim: this.sim.saveState(), key, cycles: this.cycles, edge: this.edge && { ...this.edge }, edgePeriod: this.edgePeriod,
      nextEdge: this.nextEdge, lateEvents: this.lateEvents, lateCount: this.lateCount, lastSettle: this.lastSettle,
      changeStart: this.changeStart, panels: [...this.historyHooks].map((h) => [h, h.save()]),
    });
    if (this.history.length > HISTORY_MAX) this.history.shift();
  }

  get canBack(): boolean {
    return this.history.length > 0;
  }

  /** Undo the last step, clock edge or input change (and whatever a panel saved with it). */
  back(): boolean {
    const c = this.history.pop();
    const sim = this.sim;
    if (!c || !sim) return false;
    this.stopAnim();
    this.stopClock();
    sim.restoreState(c.sim);
    this.cycles = c.cycles;
    this.restartMeter();
    this.edge = c.edge && { ...c.edge };
    this.edgePeriod = c.edgePeriod;
    this.nextEdge = c.nextEdge;
    this.lateEvents = c.lateEvents;
    this.lateCount = c.lateCount;
    this.lastSettle = c.lastSettle;
    this.changeStart = c.changeStart;
    for (const [h, st] of c.panels) if (this.historyHooks.has(h)) h.restore(st);
    this.analyzer.rewind(sim.time);
    this.refresh();
    return true;
  }

  /** Refresh after one gate delay: changed wires show the new value travelling as a front. */
  private refreshFlowing(ms: number): void {
    this.view.flowMs = ms;
    this.refresh();
    this.view.flowMs = 0;
  }

  private buildControls(): void {
    const c = this.controls;
    c.replaceChildren();
    this.runBtn = null;
    this.innerEl = h('div', { class: 'ctl-inner', role: 'group', hidden: true });
    this.scopeEl = h('span', { class: 'ctl-scope', hidden: true });
    this.innerFor = null;
    // the pins in a box of their own: no box on a wide screen (display: contents), one scrolled line on a phone (app.css)
    const pins = h('div', { class: 'ctl-pins' }, this.scopeEl);
    c.append(this.innerEl, pins);
    const root = this.scene!.root;
    const ins = inPorts(root).filter((p) => !(this.scene!.hiddenInputs ?? []).includes(p.name));
    const clk = this.clockPort();
    if (ins.some((p) => p.name !== clk)) pins.append(h('span', { class: 'label' }, 'Inputs'));
    for (const p of ins) {
      if (p.name === clk) continue;
      pins.append(p.width === 1 ? this.bitToggle(p) : this.numInput(p));
    }
    const outs = outPorts(root);
    if (outs.length) {
      // One sunken strip, so the label wraps together with its readouts.
      pins.append(h('span', { class: 'ctl-group out-strip' }, h('span', { class: 'label' }, 'Outputs'),
        outs.map((p) => (p.width === 1 ? this.bitLamp(p) : this.numOutput(p)))));
    }
    // The clock, the stepping buttons and the status are one row that wraps as a whole below the pins (never a lone
    // Reset or status on a row of its own); the status grows into what is left of it and is cut with an ellipsis
    // rather than wrapping, so a message changing length during a run never resizes the canvas. fitControls drops
    // the buttons' labels where that saves a row.
    const acts = h('span', { class: 'ctl-acts' });
    const labelled = (cls: string, title: string, ic: string, text: string, fn: () => void) =>
      h('button', { class: `btn sm ${cls}`, title, 'aria-label': text, onclick: fn }, icon(ic, 14), h('span', { class: 'lbl' }, text));
    if (clk) {
      acts.append(h('span', { class: 'label', style: 'margin-left:6px' }, 'Clock'));
      acts.append(this.bitToggle(root.ports.find((q) => q.name === clk)!));
      acts.append(labelled('', 'One full clock cycle (pauses a running clock)', 'clock', 'Pulse', () => this.pulse()));
      this.runBtn = h('button', { class: 'btn sm toggle', title: `Run the clock (${1000 / RUN_MS} cycles per second) / pause it`, onclick: () => (this.runClock ? this.stopClock() : this.startClock()) }) as HTMLButtonElement;
      this.syncRunBtn();
      acts.append(this.runBtn);
      if (this.sim?.runUntil) {
        const per = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'settle', 'aria-label': 'Clock period in gate delays', value: this.period ?? '' }) as HTMLInputElement;
        per.addEventListener('change', () => {
          const n = parseInt(per.value, 10);
          this.setPeriod(Number.isFinite(n) ? n : null);
          per.value = this.period ? String(this.period) : '';
        });
        acts.append(h('label', { class: 'period', title: 'Clock period in gate delays. Empty: each edge waits until the logic has settled. A number: edges come on time, settled or not.' }, 'period', per));
      }
    }
    this.backBtn = labelled('ghost', 'Step back: undo the last step, clock cycle or input change', 'stepBack', 'Back', () => this.back()) as HTMLButtonElement;
    acts.append(this.backBtn);
    if (this.sim?.kind === 'gate' || this.relayTime) {
      acts.append(labelled('ghost', this.relayTime ? 'Advance one relay step (every armature follows its coil)' : 'Advance one gate delay', 'step', 'Step', () => this.stepOnce()));
    }
    acts.append(labelled('ghost', 'Power-cycle the circuit', 'reset', this.scene!.resetLabel ?? 'Reset', () => this.powerCycle()));
    c.append(h('span', { class: 'ctl-run' }, acts, this.status));
    this.fitControls();
  }

  /**
   * Drop the bottom bar's button labels (icons, tooltips and accessible names remain) when its controls would
   * otherwise take another row or run past the bar's edge; measured with the labels shown, so they come back once
   * there is room. Buttons on a row of their own that fit there keep their words.
   */
  private fitControls(): void {
    const c = this.controls, run = c.querySelector<HTMLElement>(':scope > .ctl-run');
    c.classList.remove('compact', 'tight');
    if (!run || !c.offsetWidth) return;
    const first = [...c.querySelectorAll<HTMLElement>('.ctl-pins, .ctl-pins > *, :scope > .ctl-run')].find((k) => k.offsetWidth > 0)!;
    const cut = () => run.scrollWidth > run.clientWidth + 1;
    const wrapped = () => first !== run && run.offsetTop > first.offsetTop + 2;
    const wasCut = cut();
    if (!wasCut && !wrapped()) return;
    c.classList.add('compact');
    // icons only where they save a row or keep the buttons in the bar; a row of their own anyway: keep the words
    if (!wasCut && wrapped()) c.classList.remove('compact');
    // a phone: still too wide without the words, the buttons wrap within their row
    else if (cut()) c.classList.add('tight');
  }

  powerCycle(): void {
    if (!this.sim || !this.scene) return;
    this.stopAnim();
    this.stopClock();
    this.edge = null;
    this.cycles = 0;
    this.sim.reset(this.scene.powerOn ?? 'zero');
    this.restartMeter();
    this.sim.settle();
    this.lastSettle = null;
    this.nextEdge = this.sim.time;
    this.lateEvents = 0;
    this.analyzer.attach(this.sim);
    this.history = [];
    this.resetHooks.forEach((r) => r());
    this.refresh();
  }

  private bitToggle(p: PortDef): HTMLElement {
    // A switch: the knob slides along its track (1 to the right).
    return h('button', { class: 'in-toggle', role: 'switch', 'aria-checked': 'false', 'data-port': p.name, title: `Toggle ${p.name} (input)`, onclick: () => this.toggleInput(p.name) },
      DIR(), h('span', { class: 'track' }, h('span', { class: 'knob' })), p.name);
  }

  private numInput(p: PortDef): HTMLElement {
    const inp = h('input', { type: 'text', 'data-port': p.name, spellcheck: 'false', 'aria-label': p.name }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const t = inp.value.trim().toLowerCase();
      const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : parseInt(t, 10);
      if (!Number.isNaN(n)) this.setInput(p.name, ((n % (mask(p.width) + 1)) + mask(p.width) + 1) % (mask(p.width) + 1));
    });
    const bump = (d: number) => this.setInput(p.name, (this.getInput(p.name) + d + mask(p.width) + 1) % (mask(p.width) + 1));
    return h('span', { class: 'in-num', title: `${p.name} (input)` }, DIR(), p.name,
      h('button', { title: '−1', onclick: () => bump(-1) }, '−'), inp, h('button', { title: '+1', onclick: () => bump(1) }, '+'),
      h('button', { title: 'Edit bits', onclick: (e: Event) => this.editInput(p.name, (e.currentTarget as HTMLElement).getBoundingClientRect()) }, '⋯'));
  }

  /** A 1-bit output: a lamp (inputs are switches: what you set and what you read look different). */
  private bitLamp(p: PortDef): HTMLElement {
    return h('span', { class: 'out-lamp', 'data-out': p.name, title: `${p.name} (output)` }, h('span', { class: 'knob' }), p.name, DIR());
  }

  /** A bus output: its value; click to cycle hex → bin → dec → signed for this output. */
  private numOutput(p: PortDef): HTMLElement {
    const val = h('button', { class: 'v', title: 'Click to change the radix of this output' });
    val.addEventListener('click', () => {
      const order: Radix[] = ['hex', 'bin', 'dec', 'sdec'];
      this.outRadix.set(p.name, order[(order.indexOf(this.outRadixOf(p)) + 1) % order.length]);
      this.updateControls();
    });
    return h('span', { class: 'out-num', 'data-out': p.name, title: `${p.name} (output)` }, p.name, val, DIR());
  }

  private outRadixOf(p: PortDef): Radix {
    return this.outRadix.get(p.name) ?? (settings.radix === 'bin' && p.width > 8 ? 'hex' : settings.radix);
  }

  private updateControls(): void {
    if (!this.sim) return;
    const root = this.sim.design.root;
    for (const el of this.controls.querySelectorAll<HTMLElement>('[data-out]')) {
      const p = this.scene!.root.ports.find((q) => q.name === el.dataset.out)!;
      const bits = this.sim.getBits(root.ports[p.name]);
      // floating (every bit Z: a tri-state output let go) is not unknown
      const z = bits.every((b) => b === BZ), x = !z && bits.some((b) => b !== B0 && b !== B1);
      el.classList.toggle('vx', x);
      el.classList.toggle('vz', z);
      if (p.width === 1) el.classList.toggle('v1', bits[0] === B1);
      else el.querySelector('.v')!.textContent = formatBits(bits, this.outRadixOf(p));
    }
    for (const el of this.controls.querySelectorAll<HTMLElement>('.in-toggle')) {
      const v = this.getInput(el.dataset.port!);
      el.classList.toggle('v1', v === 1);
      el.setAttribute('aria-checked', String(v === 1));
    }
    for (const el of this.controls.querySelectorAll<HTMLInputElement>('.in-num input')) {
      const p = this.scene!.root.ports.find((q) => q.name === el.dataset.port)!;
      if (document.activeElement !== el) el.value = formatNumber(this.getInput(p.name), p.width, settings.radix === 'bin' && p.width > 8 ? 'hex' : settings.radix);
      // as wide as the value (monospace): a 32-bit word in hex no longer clips; 6 characters at least, as before
      el.style.width = `calc(${Math.max(6, el.value.length)}ch + 18px)`;
    }
    if (this.backBtn) this.backBtn.disabled = !this.history.length;
    this.syncScope();
    this.syncCrumbVals();
    const sim = this.sim;
    const busy = sim.busy();
    let msg: string;
    if (this.flash) {
      msg = this.flash;
      this.flash = null;
    } else if (this.period && this.cycles && !this.anim && !sim.unstable) {
      msg = this.lateCount
        ? `period ${this.period}: ${this.lateCount} edge${this.lateCount > 1 ? 's' : ''} came while the logic was still switching`
        : `period ${this.period}: logic settled before every edge`;
    } else if (sim.unstable && this.relayTime) msg = 'oscillating: the relays never settle';
    else if (sim.unstable) msg = 'race detected: resolved (metastability)';
    else if (busy && this.relayTime) msg = `switching… relay step ${sim.time - this.changeStart}`;
    else if (busy) msg = `propagating… t = ${sim.time - this.changeStart}`;
    else if (this.lastSettle !== null && this.relayTime) msg = `settled in ${this.lastSettle} relay step${this.lastSettle === 1 ? '' : 's'} (${(this.lastSettle * RELAY_STEP_MS).toFixed(1)} ms)`;
    else if (this.lastSettle !== null && sim.kind === 'gate') msg = `${this.clockPort() && this.cycles ? 'clock edge ' : ''}settled in ${this.lastSettle} gate delay${this.lastSettle === 1 ? '' : 's'}`;
    else msg = this.relayTime ? 'relays at rest' : sim.kind === 'switch' ? 'switch level: solved instantly' : 'settled';
    const warn = sim.unstable || (!!this.period && this.lateCount > 0);
    this.setStatus(h('span', { class: `pulse${busy ? ' busy' : ''}${warn ? ' warn' : ''}` }), msg);
  }

  /** The status line: a dot and a message, cut with an ellipsis where the bar is short of room (the whole of it is the tooltip). */
  private setStatus(dot: HTMLElement, msg: string): void {
    const t = this.status.lastElementChild as HTMLElement | null;
    if (t && this.status.childElementCount === 2 && t.textContent === msg && (this.status.firstElementChild as HTMLElement).className === dot.className) return;
    this.status.replaceChildren(dot, h('span', { class: 'status-txt' }, msg));
    this.status.title = msg;
  }

  // ---- rendering --------------------------------------------------------------------------

  refresh(): void {
    if (!this.ctx) return;
    // only the view on screen is painted (the other catches up when it is shown)
    if (this.boardOn) {
      this.board.sim = this.sim;
      this.boardCover();
      this.board.update(this.sim);
    } else {
      this.view.update();
      // the drilled board beside the schematic stays live
      if (this.drill) {
        this.board.sim = this.sim;
        this.board.update(this.sim);
      }
    }
    if (this.pins && this.sim) this.pins.update(this.sim);
    this.leaf?.widget.update?.();
    this.panels.forEach((p) => p.update?.());
    this.analyzer.update();
    this.showInspector();
    this.updateControls();
    if (!this.leaf) this.levelBadge.textContent = `level: ${LEVEL_NAME[this.levelOf()] ?? 'blocks'}`;
    this.listeners.forEach((f) => f());
  }

  private levelOf(): string {
    const nl = this.ctx ? netlistOf(this.ctx.def) : undefined;
    if (!nl) return 'gate';
    // a relay or tube circuit (prologue P1, P2): its parts are relays or tubes, not transistors
    if (nl.level === 'switch') {
      const st = stats(this.ctx!.def);
      return st.transistors ? 'transistor' : st.relays ? 'relay' : st.triodes + st.diodes ? 'tube' : 'transistor';
    }
    const kinds = nl.instances.filter((i) => i.def.prim !== 'alias').map((i) => i.def);
    if (kinds.every((d) => d.prim === 'nand')) return 'gate';
    return this.ctx!.def.category;
  }

  private showInspector(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // a chip selected on the boards
    const chip = this.boardOn ? this.board.selected : null;
    const node = chip?.path && this.sim ? findNode(this.sim.design.root, chip.path) : null;
    if (chip?.path && node && this.sim) {
      const sim = this.sim, path = chip.path;
      this.inspector.show({
        def: node.def, instance: chip.ref ? `${chip.ref} (${path.join('.')})` : path.join('.'),
        portBits: (p) => sim.getBits(node.ports[p]),
        canOpen: true, onOpen: () => this.openFromBoard(path),
        power: () => this.livePower(this.rootCtx!, node),
      });
      return;
    }
    const sel = this.leaf ? this.leaf.name : this.selected;
    const child = sel ? ctx.node.children?.get(sel) : undefined;
    if (child) {
      this.inspector.show({
        def: child.def, instance: sel!,
        portBits: (p) => ctx.sim.getBits(child.ports[p]),
        canOpen: !this.leaf && (ctx.canOpen(sel!) || child.def.prim === 'nmos' || child.def.prim === 'pmos'),
        onOpen: () => this.open(sel!),
        power: () => this.livePower(ctx, child),
      });
    } else {
      this.inspector.show({ def: ctx.def, portBits: (p) => ctx.portBits(p), instance: ctx.path[ctx.path.length - 1], power: () => this.livePower(ctx, ctx.node) });
    }
  }

  /** The scene's switching activity for a node of its own gate-level simulation (an opened NAND's or ROM's sub-simulation has none). */
  private livePower(ctx: ViewCtx, node: HierNode): LivePower | null {
    const sim = this.sim;
    if (!(sim instanceof GateSim) || ctx.sim !== sim) return null;
    if (!this.meter || this.meter.sim !== sim) {
      this.meter = new PowerMeter(sim);
      this.meterFrom = this.cycles;
    }
    if (this.meterPeriod === undefined) this.meterPeriod = this.clockPort() ? analyzeTiming(sim.design)?.period ?? null : null;
    return {
      meter: this.meter, node, cycles: this.cycles - this.meterFrom, ...(this.meterPeriod ? { period: this.meterPeriod } : {}),
      restart: () => this.restartMeter(),
    };
  }

  private restartMeter(): void {
    if (!this.meter) return;
    this.meter.reset();
    this.meterFrom = this.cycles;
  }

  private renderCrumbs(): void {
    const c = this.crumbs;
    c.replaceChildren();
    if (!this.rootCtx) return;
    const chain: { label: string; kind: string; path: string[] }[] = [];
    const levels: ViewCtx[] = [];
    let ctx: ViewCtx | null = this.ctx;
    while (ctx) {
      const name = ctx.path[ctx.path.length - 1];
      chain.unshift({ label: name ?? ctx.def.name, kind: name ? ctx.def.name : '', path: ctx.path });
      levels.unshift(ctx);
      ctx = ctx.parent;
    }
    if (this.leaf) {
      const def = this.ctx!.node.children!.get(this.leaf.name)!.def;
      chain.push({ label: this.leaf.name, kind: def.name, path: this.path });
    }
    const vals = crumbValues(levels);
    this.crumbVals = [];
    chain.forEach((item, i) => {
      if (i) c.append(h('span', { class: 'sep' }, '›'));
      const last = i === chain.length - 1;
      const v = vals[i];
      const el = v ? h('span', { class: 'val' }) : null;
      if (el && v) this.crumbVals.push({ el, v });
      c.append(h('button', { class: last ? 'cur' : '', onclick: () => (last ? null : this.goTo(item.path)) },
        item.label, item.kind ? h('span', { class: 'kind' }, item.kind) : null, el));
      // The name may be cut with an ellipsis (app.css): the tooltip keeps it whole.
      const title = item.kind ? `${item.label} (${item.kind})` : item.label;
      (c.lastChild as HTMLElement).title = v ? `${title}\n${crumbTitle(v, item.label, chain[i - 1]?.label ?? '')}` : title;
    });
    this.syncCrumbVals();
    this.fitBar();
    this.syncScope();
  }

  /** The breadcrumb's values follow the simulation (crumbvals.ts). */
  private syncCrumbVals(): void {
    paintCrumbVals(this.crumbVals, settings.radix);
  }

  /**
   * The bottom bar always drives the top level's pins. Drilled in, the canvas shows a part whose pins often have
   * the same names (a, b, cin, s inside an adder's fa0): the bar then says whose pins it holds, and a read-only row
   * above it shows the open part's own pins, live.
   */
  private syncScope(): void {
    const scope = this.scopeEl, inner = this.innerEl, ctx = this.ctx, root = this.rootCtx;
    if (!scope || !inner || !ctx || !root) return;
    const deep = ctx !== root || !!this.leaf;
    const was = scope.hidden;
    scope.hidden = !deep;
    if (was === deep) this.fitControls();
    if (deep && !scope.childElementCount) {
      scope.append(h('span', { class: 'label' }, 'Pins of'), h('b', null, root.def.name));
      scope.title = `These inputs and outputs are the pins of the whole ${root.def.name} (the top level), not of the part open on the canvas`;
    }
    const showInner = ctx !== root && !this.leaf;
    inner.hidden = !showInner;
    if (!showInner) {
      this.innerFor = null;
      return;
    }
    if (this.innerFor !== ctx) {
      this.innerFor = ctx;
      const name = ctx.path[ctx.path.length - 1];
      const ports = [...inPorts(ctx.def), ...outPorts(ctx.def)];
      const shown = ports.slice(0, INNER_PINS);
      this.innerVals = [];
      inner.setAttribute('aria-label', `Pins of ${name} (read-only)`);
      inner.replaceChildren(h('span', { class: 'label' }, 'Inside'), h('b', null, name), h('span', { class: 'kind' }, ctx.def.name), h('span', { class: 'ro' }, 'read-only'));
      shown.forEach((p, i) => {
        if (i && p.dir === 'out' && shown[i - 1].dir !== 'out') inner.append(h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'));
        const el = h('i');
        this.innerVals.push({ el, port: p });
        inner.append(h('span', { class: 'ctl-pin', title: `${name}.${p.name} (${p.dir === 'out' ? 'output' : 'input'} of ${ctx.def.name})` }, p.name, el));
      });
      if (ports.length > shown.length) inner.append(h('span', { class: 'more' }, `+${ports.length - shown.length} more in Info`));
    }
    for (const { el, port } of this.innerVals) {
      const bits = ctx.portBits(port.name);
      const txt = formatBits(bits, port.width === 1 ? 'bin' : settings.radix === 'bin' && port.width > 8 ? 'hex' : settings.radix);
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('v1', port.width === 1 && bits[0] === B1);
    }
  }

  /** Drop the bar's button labels (icons and tooltips remain) when the open level's name would otherwise be
   *  cut; measured with the labels shown, so they come back once there is room. Still cut, the least used
   *  buttons move into a More menu a group at a time (shedGroups: zoom, image, layout, sandbox, timing, probe),
   *  and only then (a phone: the buttons take the whole bar, the name read "4…") the hierarchy gets a row of
   *  its own above the buttons (.stacked), every button back in the bar. The levels above the open one shrink
   *  first (app.css): cut with an ellipsis, their names in their tooltips. */
  private fitBar(): void {
    const bar = this.bar;
    const moreWrap = this.moreBtn.parentElement!;
    bar.classList.remove('compact', 'stacked');
    for (const g of this.shedGroups) g.els.forEach((el) => el.classList.remove('shed'));
    moreWrap.hidden = true;
    // only what the bar shows (not a scene's hidden Open in Sandbox, nor a phone's zoom buttons)
    const live = this.shedGroups.filter((g) => g.els.some((el) => el.offsetWidth > 0));
    const shed = (k: number) => live.forEach((g, i) => g.els.forEach((el) => el.classList.toggle('shed', i < k)));
    const items = [...this.crumbs.querySelectorAll('button')];
    if (!items.length) return this.toggleMore(false);
    const cur = items[items.length - 1];
    const crumbs = this.crumbs;
    const fits = () => cur.scrollWidth <= cur.clientWidth + 1 && crumbs.scrollWidth <= crumbs.clientWidth + 1 && cur.offsetTop <= items[0].offsetTop + 2;
    if (fits()) return this.toggleMore(false);
    bar.classList.add('compact');
    if (fits()) return this.toggleMore(false);
    moreWrap.hidden = false;
    for (let k = 1; k <= live.length; k++) {
      shed(k);
      if (fits()) return;
    }
    shed(0);
    moreWrap.hidden = true;
    this.toggleMore(false);
    bar.classList.add('stacked');
  }

  /** Open `path` and highlight (and bring into view) the instance `name` inside it. */
  reveal(path: string[], name: string): void {
    this.goTo(path);
    this.view.highlight([name]);
    this.view.focusInst(name);
  }

  /** Bring instances of the current view (`pin:<name>` for pins) into view, framed: a part pinned from a chapter's text. */
  frame(names: string[]): void {
    this.view.frameInsts(names);
  }

  /** Highlight instances in the current view (empty list clears). */
  highlight(names: string[], focus = false): void {
    this.view.highlight(names, focus);
    // the boards light what the schematic would (names of the root's instances: a module's board, a chip)
    if (this.ctx === this.rootCtx) this.board.highlight(names);
  }

  /** Tint the current view's instances by slack (sim/slack.ts slackHeat; null clears); dropped on navigation. */
  heat(map: Map<string, { band: number; tip: string }> | null): void {
    this.view.heat(map);
  }

  /** Colour nets of the current view (index in its netlist → classes); cleared on navigation. */
  markNets(marks: Map<number, string>): void {
    this.view.markNets(marks);
  }

  /**
   * A right-docked panel (`data-dock="right"`) floats over the canvas's right edge; the stage owns its
   * folding: a click on its title folds it to that title or unfolds it, and the fit leaves room for it
   * while it is unfolded (syncInset). A bottom-left panel (`data-dock="left"`) is the stage's to fold only with
   * `data-fold` (the others fold themselves: one listener each, or a click would fold and unfold at once).
   * With `data-fold="narrow"` a panel may start folded (autoFold), unless the learner already folded or unfolded
   * one on that side by hand (foldChoice, kept for the page's life).
   */
  private foldable(el: HTMLElement): void {
    const title = el.querySelector(':scope > h4');
    title?.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      if (el.dataset.fold) foldChoice.set(el.dataset.dock ?? '', el.classList.contains('collapsed'));
    });
  }

  /** Decide, once the canvas and the scene's panels have a size, which foldable panels start folded: as many
   *  open as leave the circuit at least KEEP_SCALE of its size with them all folded (chooseFolds), and none on the
   *  right leaving it less than FOLD_BESIDE_PX (a laptop between the side panes, a phone). Each choice is laid out
   *  and measured (a bottom-left panel's shape follows the room beside the right dock). */
  private autoFold(): void {
    if (!this.foldPending) return;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const fold = this.panels.filter((p) => p.el.dataset.fold === 'narrow').slice(0, 4);
    if (W <= 0 || H <= 0 || fold.some((p) => p.el.offsetWidth <= 0)) return;
    this.foldPending = false;
    const apply = (mask: number) => {
      fold.forEach((p, i) => p.el.classList.toggle('collapsed', ((mask >> i) & 1) === 1));
      this.inset = this.rightInset();
      this.drillLayout();
      this.dockOut();
    };
    // the boards, while shown, are what has to fit (their extent in holes: only the aspect matters here)
    const lay = this.boardOn ? this.scene?.breadboard : undefined;
    const box = lay ? layoutBounds(lay) : this.view.contentBox();
    const bw = lay ? box.w + 2 * BB_MARGIN : Math.max(box.w, 34), bh = Math.max(box.h + (lay ? 2 * BB_MARGIN : 0), 1);
    const all = (1 << fold.length) - 1;
    const scaleOf = (mask: number): number | null => {
      apply(mask);
      if (fold.some((p, i) => !((mask >> i) & 1) && p.el.dataset.dock === 'right' && startFolded(W, p.el.offsetWidth))) return null;
      const r = freeArea(W, H, this.covers(false), bw, bh);
      const s = r ? Math.min(r.w / bw, r.h / bh) : 0;
      // the boards are fine print: a panel stays open only beside boards that still read whole (a laptop folds it)
      return lay && mask !== all && s < BB_READ_PX ? null : s;
    };
    apply(chooseFolds(fold.length, scaleOf, fold.map((p) => foldChoice.get(p.el.dataset.dock ?? '') ?? null)));
  }

  /** A panel changed size (folded, unfolded, grew): make room for it, refitting a still-fitted view when the
   *  right dock's width changed or a panel now covers part of the circuit. */
  private syncCover(): void {
    this.autoFold();
    const inset = this.rightInset();
    const refit = inset !== this.inset;
    this.inset = inset;
    // the challenge note keeps clear of the right-docked panels, folded ones too (app.css .stage-notes)
    const covered = this.panels.filter((p) => p.el.dataset.dock === 'right').map((p) => p.el.offsetWidth).filter((w) => w > 0);
    this.canvas.style.setProperty('--panel-inset', `${covered.length ? Math.max(...covered) + 24 : 0}px`);
    this.boardCover();
    this.drillLayout();
    this.dockOut();
    this.placeHint();
    this.view.setCover(this.covers(), refit);
  }

  /** The boards keep clear of the right-docked panels that are open; a folded one is only its title, so the boards
   *  run under it, starting below it (--bb-inset, --bb-top: breadboard.css). */
  private boardCover(): void {
    const c = this.canvas.getBoundingClientRect();
    const right = this.panels.filter((p) => p.el.dataset.dock === 'right' && p.el.offsetWidth > 0);
    const open = right.filter((p) => !p.el.classList.contains('collapsed')).map((p) => p.el.offsetWidth);
    const folded = right.filter((p) => p.el.classList.contains('collapsed')).map((p) => p.el.getBoundingClientRect().bottom - c.top);
    this.canvas.style.setProperty('--bb-inset', `${open.length ? Math.max(...open) + 24 : 0}px`);
    const capr = right.filter((p) => p.el.classList.contains('collapsed')).map((p) => p.el.offsetWidth + 12);
    this.canvas.style.setProperty('--bb-capr', `${capr.length && !open.length ? Math.max(...capr) : 0}px`);
    const tops = open.length ? [] : folded;
    // a chapter's challenge note over the canvas's top-left corner (ui/stagenotes.ts) too
    for (const n of this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')) {
      const r = n.getBoundingClientRect();
      if (r.height > 0) tops.push(r.bottom - c.top);
    }
    this.canvas.style.setProperty('--bb-top', `${tops.length ? Math.max(...tops) + 6 : 0}px`);
  }

  /** Where the scene's panels and the how-to line sit on the canvas (px from its top-left corner): what the fit
   *  keeps clear. */
  private covers(hint = true): Rect[] {
    const c = this.canvas.getBoundingClientRect();
    const out: Rect[] = [];
    for (const el of [...this.panels.map((p) => p.el), ...(hint ? [this.hint] : []), ...(this.drill ? [this.board.el] : [])]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
    }
    return out;
  }

  /** The how-to line: above the bottom-left panels, and wrapped short of the right-docked panels beside it (it was
   *  cut off under the CPU panel); hidden when that leaves it no room, or would lift it into the canvas's top half
   *  (a tall bottom-left panel, a phone), where it would cost the circuit more room than it is worth, or when it
   *  would leave the circuit no free area (a short canvas: the fit would take the whole canvas and the line would
   *  hide the bottom pins). True when it was shown or hidden. */
  private placeHint(): boolean {
    const was = this.hint.hidden;
    const H = this.canvas.clientHeight, W = this.canvas.clientWidth;
    const c = this.canvas.getBoundingClientRect();
    const docked = [...this.dock.children].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    const bottom = docked.length ? H - Math.min(...docked.map((r) => r.top - c.top)) + 6 : 10;
    // A line or two above `bottom`: the right panels reaching that low push its right edge in.
    const lineTop = H - bottom - 40;
    let right = 12;
    for (const p of this.panels) {
      if (p.el.dataset.dock !== 'right') continue;
      const r = p.el.getBoundingClientRect();
      if (r.width > 0 && r.bottom - c.top > lineTop) right = Math.max(right, c.right - r.left + 12);
    }
    this.hint.style.bottom = `${bottom}px`;
    // beside the drill pane it starts right of it (breadboard.css)
    const left = this.drill && !this.el.classList.contains('bb-stacked') ? parseFloat(this.canvas.style.getPropertyValue('--bb-drill-w')) + 12 || 12 : 12;
    this.hint.style.maxWidth = `${W - right - left}px`;
    // a drill stacked on a narrow canvas leaves the schematic a strip: the line would take a third of it
    this.hint.hidden = this.hint.dataset.off === '1' || W - right - left < 160 || (docked.length > 0 && lineTop < H / 2)
      || (!!this.drill && this.el.classList.contains('bb-stacked'));
    if (!this.hint.hidden && !roomBeside(this.view.contentBox(), W, H, this.covers())) this.hint.hidden = true;
    return this.hint.hidden !== was;
  }

  /** Screen space the unfolded right-docked panels cover (with their 12 px margin and a 12 px gap).
   *  Measured live: a scene's panels are built before the stage is laid out, when they are 0 px wide. */
  private rightInset(): number {
    const widths = this.panels.filter((p) => p.el.dataset.dock === 'right' && !p.el.classList.contains('collapsed'))
      .map((p) => p.el.offsetWidth).filter((w) => w > 0);
    return widths.length ? Math.max(...widths) + 24 : 0;
  }

  /** Lay the bottom-left panels out again (a panel that changes size calls it), and keep the circuit and the
   *  how-to line clear of them (`refit`: false when the caller fits next anyway). */
  layoutDock(refit = true): void {
    this.dockOut();
    this.placeHint();
    if (refit) this.view.setCover(this.covers());
    else this.view.cover = this.covers();
  }

  /** Bottom-left panels sit beside the right dock: side by side when they fit, else stacked, each
   *  shrinking and scrolling. Several scenes combine two of them (I/O or pipeline + static timing). */
  private dockOut(): void {
    const panels = [...this.dock.children] as HTMLElement[];
    if (!panels.length) return;
    const inset = this.inset;
    // Too narrow beside the right dock: overlap it rather than squeeze the panels to nothing.
    this.dock.style.right = `${inset && this.canvas.clientWidth - inset - 12 >= 260 ? inset : 12}px`;
    this.dock.classList.remove('row');
    const need = panels.reduce((a, p) => a + p.offsetWidth, 0) + 8 * (panels.length - 1);
    this.dock.classList.toggle('row', need <= this.dock.clientWidth);
  }

  /** Bits of a root port as 0/1 booleans (helper for challenges). */
  high(port: string): boolean {
    return this.sim?.getBits(this.sim.design.root.ports[port])[0] === B1;
  }

  destroy(): void {
    this.loadSeq++;
    this.pending = null;
    this.showWidget(null);
    this.stopAnim();
    this.stopClock();
    this.panels.forEach((p) => p.destroy?.());
    this.leaf?.widget.destroy?.();
    closePopover();
    this.life.abort();
  }
}
