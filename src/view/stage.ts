// The stage: a scene (root component + inputs) simulated live, viewed through a schematic
// that can drill into any instance, with input controls, clock, propagation animation and
// the inspector. Chapters and the workbench are thin wrappers around it.

import { shortStatus } from './statustext';
import { DualSim } from '../sim/dualsim';
import { type FlatDesign, findNode, flatten, flattenAsync, type HierNode } from '../sim/flatten';
import { fmtCount, LoadPlan } from '../sim/loadplan';
import { nextTask } from '../sim/tasks';
import { LoadCard } from './loadcard';
import { GateSim, LOAD_TICKS } from '../sim/gatesim';
import { OverlayBar, nextOverlay, overlayLegend } from './overlaybar';
import { OVERLAY_KINDS, OVERLAY_LABEL, type OverlayKind, type OverlayResult, activityOverlay, costOverlay, depthOverlay, energyOverlay, loadOverlay, overlayRefusal, slackOverlay, unknownOverlay } from './overlays';
import type { DelayModel } from '../sim/delay';
import { SwitchSim } from '../sim/switchsim';
import { needsSwitchLevel } from '../sim/harness';
import { completeEdge, type Edge, fmtTime, lowerClock, riseEdge, stepEdge } from '../sim/edge';
import { PowerMeter } from '../sim/power';
import { RELAY_STEP_MS } from '../phys/relay';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import type { PowerOnMode, Sim, SimState } from '../sim/sim';
import { B0, B1, BZ, type Bit, type ComponentDef, inPorts, netlistOf, outPorts, type PortDef } from '../sim/types';
import { formatBits, formatNumber, mask, pack, packBig, type Radix, unpackBig } from '../sim/values';
import { LogicAnalyzer, netKey } from './analyzer';
import { h, hintBadge, icon } from '../ui/dom';
import { menuKeys } from '../ui/menukeys';
import { applyTheme, settings } from '../ui/settings';
import { copyText, emptyView, encodeView, isEmptyView, linkTo, setViewTarget, splitView, takePendingView, type ViewFocus, type ViewState } from '../ui/viewlink';
import { switchSim, ViewCtx } from './context';
import { type CrumbValue, crumbTitle, crumbValues, paintCrumbVals } from './crumbvals';
import { Inspector, inspectorChoice } from './inspector';
import { LABEL_UNITS, MIN_TEXT_PX } from './legible';
import type { LivePower } from './powerpanel';
import { closePopover, editNumber, syncPopover } from './popover';
import { chooseFolds, KEEP_SCALE_OPENED, COVER_GAP, fitBox, fitMinW, freeArea, KEEP_SCALE, roomBeside, showReadable, startFolded, type Rect } from './camera';
import { pinGeoms, symbolRects } from './route';
import { applyLayout, arranged, arrangedCount, asideOf, layoutOf } from './layout';
import { drawnNetlist } from './wirefirst';
import { type NotePin, SchematicView } from './schematic';
import { BB_MARGIN, BB_READ_PX, type BbChip, type BbDrill, type BreadboardLayout, drillCrumbs, drillOf, drillPane, layoutBounds } from './bblayout';
import { BreadboardView, drillNotes, pinCard, type WireLook } from './breadboard';
import { bindKeys, matches, shortcutAllowed } from '../ui/keys';
import { type CursorItem, firstItem, nextInDir } from './kcursor';
import './stagekeys';
import { isMenuKey, type MenuEntry } from '../ui/menu';
import type { ElsewhereHost, ExplainHost, MeasureHost } from './tracemenu';
import { powerOff } from './truthrule';
import { WhyPanel } from './whypanel';
import { memGridPanel } from '../widgets/memgrid';
import { modelLeaf } from '../widgets/modelleaf';
import { findMemories } from './memfind';
import { markJump } from '../ui/returnto';

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
  /** Leave these outputs out of the readout strip (a scene with a panel that shows them better). */
  hiddenOutputs?: string[];
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
  /**
   * 'load': GateSim times each NAND by its load, in tenths of a unit (docs/PLAN-FINEDELAY.md). A chapter scene is on the unit
   * model unless it says so; the workbench follows settings.loadDelay (Stage.delayFromSetting).
   */
  delay?: 'unit' | 'load';
  /**
   * false: no Memory contents panel. A scene that declares no panels gets one by itself when its circuit holds a memory
   * (view/memfind.ts: a RAM, a register file, a cache's arrays …); a scene with panels of its own decides for itself.
   */
  memory?: false;
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
/** A phone's stage (hugPhone): the least canvas it keeps, the badge's room above the drawing, and the tallest cover it shrinks under. */
const HUG_MIN_PX = 260, HUG_TOP_PX = 48, HUG_COVER_PX = 90;
/** The top bar a scrolled phone stage sits under: hugPhone lets a tall circuit's stage grow to the screen's bottom. */
const PHONE_TOPBAR_PX = 70;
/** The stage's touch hint hides itself after this long untouched (it sits over the circuit's room). */
const HINT_AUTO_MS = 8000;
const HISTORY_MAX = 100;
/** A link's clock cycles are replayed for at most this long (ms); a note says how many ran. */
const REPLAY_MS = 1500;
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

/** A build still going after this long shows its progress card (a quicker one never flashes it). */
const LOAD_CARD_MS = 300;
/** Width a challenge note or the Why? card needs beside a left panel before the right dock, else it does not move there. */
const NOTE_ROOM = 240;

export class Stage {
  readonly el: HTMLElement;
  readonly inspector: Inspector;
  scene: Scene | null = null;
  /** A big scene waiting for its "Building…" cue to paint (load), and the load it belongs to. */
  private pending: Scene | null = null;
  /** Where the pending scene opens (load's `at`), if not its own Scene.path. */
  private pendingAt: string[] | undefined;
  private loadSeq = 0;
  private card: LoadCard | null = null;
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
  /** Over the canvas while the level shows the learner's arrangement (Original, Reset), or one a redraw set aside. */
  private layoutPill: HTMLElement;
  private lockBtn!: HTMLButtonElement;
  /** The how-to line at the canvas's bottom left, kept clear of the panels (placeHint). */
  private hint: HTMLElement;
  /** The challenge note's size when the cover was last synced (a note that comes or grows refits a fitted view). */
  private notesKey = '';
  /** rightInset() when the cover was last synced: a fold, unfold or width change refits a fitted view. */
  private inset = 0;
  /** The automatic clock started this scene and the learner has done nothing since (autoRunning). */
  private autoRun = false;
  private status: HTMLElement;
  private leaf: { name: string; widget: Widget } | null = null;
  private widget: { w: Widget; host: HTMLElement } | null = null;
  private panels: Widget[] = [];
  /** Watches the scene's panels: folded, unfolded or resized, the fit makes room (syncCover). */
  private panelSize = new ResizeObserver(() => { this.growFold(); this.syncCover(); });
  /** The scene's foldable panels still wait for their first layout to decide whether they start folded. */
  private foldPending = false;
  /** The canvas width the folds were last decided at (0: not laid out yet). */
  private foldWidth = 0;
  /** Each open foldable panel's height when the folds were last decided (growFold). */
  private foldHeights = new WeakMap<HTMLElement, number>();
  /** The inspector's fold waits for the first layout of the scene (autoInspector). */
  private inspPending = false;
  /** A scene being loaded whose inspector fold is still to be guessed once the stage has a size (guessInspector). */
  private inspGuess: { scene: Scene; at?: string[] } | null = null;
  private anim: ReturnType<typeof setInterval> | null = null;
  private runClock: ReturnType<typeof setInterval> | null = null;
  private runBtn: HTMLElement | null = null;
  private changeStart = 0;
  private lastSettle: number | null = null;
  private listeners = new Set<() => void>();
  private navListeners = new Set<(path: string[]) => void>();
  readonly analyzer = new LogicAnalyzer();
  private probeMode = false;
  /** Where each probe lane was clicked (instance path + net index), for a link to this view; cleared with the lanes. */
  private probeRefs = new Map<number, { path: string[]; net: number }>();
  private probeBtn: HTMLButtonElement;
  private whyBtn: HTMLButtonElement;
  /** Why? mode: a click on a wire explains its value (view/whypanel.ts). */
  private why: WhyPanel;
  private timingBtn: HTMLButtonElement;
  private panesBtn: HTMLButtonElement;
  private moreBtn: HTMLButtonElement;
  private readBtn!: HTMLButtonElement;
  /** Zoom to readable is in force: the how-to line gives way (it sat over the drawing's parts). */
  private readZoom = false;
  /** Aborted by destroy(): the document listeners this stage added. */
  private life = new AbortController();
  /** The overlay bar (view/overlays.ts): the kind on, its legend over the canvas, the delay model Slack uses, Activity's window. */
  private ovBar: OverlayBar;
  private ovKind: OverlayKind | null = null;
  private ovLegend: HTMLElement | null = null;
  private ovModel: DelayModel | null = null;
  private ovCache = new Map<string, { design: FlatDesign; r: OverlayResult | null }>();
  private ovWin: { sim: GateSim; base: Uint32Array; cycles: number; changes: number; sig: string } | null = null;
  private ovLast = 0;
  private ovTimer = 0;
  private ovListeners = new Set<() => void>();
  /** While a legend shows: the panels and notes it keeps clear of change size (a fold, a panel filling in) → placed again. */
  private ovRO: ResizeObserver | null = null;
  private ovRaf = 0;
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
  /**
   * A "find it" step's accusation rows for a wire (widgets/findfault.ts sets it while its panel is up): given the wire's
   * flat nets and name, the rows that lead its right-click menu.
   */
  accuser: ((flat: readonly number[], name: string) => MenuEntry[]) | null = null;
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
  /** The learner's fold choice on the right when the drill folded the panels (a different one at the end: theirs stands). */
  private drillChoice: boolean | undefined;
  private viewSeg: HTMLElement;
  private wireSeg: HTMLElement;
  /** A chip opened from the boards: its DIP pins, live, in the bottom-left dock. */
  private pins: { path: string; el: HTMLElement; update(sim: Sim): void } | null = null;
  private beforeEdge(): void { this.edgeHooks.forEach((h) => h.before?.()); }
  private afterEdge(): void { this.edgeHooks.forEach((h) => h.after?.()); }

  constructor(inspector: Inspector) {
    this.inspector = inspector;
    // Unseen (its room kept) until the first scene's fold is known: the page paints before the chapter's module has the
    // scene, and an open inspector shown then would fold under the reader's eyes (guessInspector).
    inspector.el.classList.add('insp-wait');
    window.setTimeout(() => this.revealInspector(), 1500);
    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Hierarchy' });
    const btn = (ic: string, title: string, fn: () => void, cls = '') =>
      h('button', { class: `btn ghost icon-only${cls}`, title, 'aria-label': title, onclick: fn }, icon(ic, 16));
    this.probeBtn = h('button', { class: 'btn ghost sm toggle probe-btn keep', title: 'Probe mode (P): click any wire to add it to the timing diagram', onclick: () => this.setProbeMode(!this.probeMode) },
      icon('probe', 15), h('span', { class: 'lbl' }, 'Probe')) as HTMLButtonElement;
    this.ovBar = new OverlayBar((k) => this.setOverlay(k));
    this.why = new WhyPanel({
      ctx: () => this.ctx,
      light: (names) => (names.length ? this.view.highlight(names, true) : this.view.highlight(this.ctx === this.rootCtx ? this.scene?.highlight ?? [] : [])),
      selectNet: (i) => this.view.selectNet(i),
      toggled: (on) => {
        this.whyBtn.classList.toggle('on', on);
        this.canvas.classList.toggle('probing', on || this.probeMode);
        if (on && this.probeMode) this.setProbeMode(false);
        // the card covers the canvas's top-left corner: a fitted circuit moves clear of it, and back when it closes
        if (on) this.placeWhy();
        else this.view.setCover(this.covers(), true);
      },
    });
    new ResizeObserver(() => this.why.on && (this.placeWhy(), this.view.setCover(this.covers()))).observe(this.why.el);
    this.whyBtn = h('button', { class: 'btn ghost sm toggle why-btn keep', title: 'Why? (W): click any wire to trace its value back to the inputs that decide it, or see what each part is for', onclick: () => this.why.setOn(!this.why.on) },
      icon('why', 15), h('span', { class: 'lbl' }, 'Why?')) as HTMLButtonElement;
    this.timingBtn = h('button', { class: 'btn ghost sm toggle', title: 'Timing diagram: probed nets and ports over time', onclick: () => this.showAnalyzer(!this.el.classList.contains('with-analyzer')) },
      icon('wave', 15), h('span', { class: 'lbl' }, 'Timing')) as HTMLButtonElement;
    const remix = this.remixBtn = h('button', { class: 'btn ghost sm remix-btn', title: 'Open in Sandbox: an editable copy of the circuit on screen, as one of your own chips', onclick: () => this.remix() },
      icon('chip', 15), h('span', { class: 'lbl' }, 'Open in Sandbox'));
    // The level on screen as an image file (view/image.ts, loaded on first use).
    const imgMenu = h('div', { class: 'pal-menu img-menu', role: 'menu' });
    const showImg = (on: boolean) => { imgMenu.classList.toggle('open', on); imgBtn.setAttribute('aria-expanded', String(on)); };
    const imgItem = (kind: 'svg' | 'png', label: string, hint: string) => h('button', { role: 'menuitem', onclick: () => {
      showImg(false);
      this.exportImage(kind);
    } }, h('span', null, h('b', null, label), h('small', null, hint)));
    const linkItem = h('button', { role: 'menuitem', onclick: () => {
      showImg(false);
      void this.copyViewLink();
    } }, h('span', null, h('b', null, 'Copy link to this view'), h('small', null, 'Chapter step, opened part, inputs, probes and clock cycles')));
    imgMenu.append(imgItem('svg', 'Image as SVG', 'This level, whole, as drawn in the current theme'), imgItem('png', 'Image as PNG', 'The same at 2× resolution'), linkItem);
    const imgBtn: HTMLElement = h('button', { class: 'btn ghost sm share-btn', title: 'Share this view: an image of this level (SVG or PNG), or a link that reopens it as it is now', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e: Event) => {
      e.stopPropagation();
      showImg(!imgMenu.classList.contains('open'));
    } }, icon('image', 15), h('span', { class: 'lbl' }, 'Share'));
    document.addEventListener('pointerdown', (e) => {
      if (!imgMenu.contains(e.target as Node) && !imgBtn.contains(e.target as Node)) showImg(false);
    }, { signal: this.life.signal });
    // The learner's layout of this level (view/layout.ts): unravel its pointers, reset it.
    const layoutBtn = h('button', {
      class: 'btn ghost sm', title: 'Layout: unravel pointers into wires, or reset this level (drag a part or a wire to move it)', 'aria-haspopup': 'menu',
      onclick: (e: Event) => {
        if (this.view.menuOpen) return this.view.closeMenu();
        const b = e.currentTarget as HTMLElement, r = b.getBoundingClientRect();
        this.view.layoutMenu(r.left, r.bottom + 6, b);
      },
    }, icon('move', 15), h('span', { class: 'lbl' }, 'Layout'));
    // The layout lock (settings.moveParts): one switch for every stage and look inside, also in View options; locked, a
    // drag on a part pans. On by default with a mouse, off on a touch screen.
    const lockBtn = this.lockBtn = h('button', { class: 'btn ghost sm toggle lock-btn', 'aria-pressed': 'false', onclick: () => settings.set('moveParts', !settings.moveParts) }) as HTMLButtonElement;
    this.syncLock();
    const offLock = settings.onChange(() => this.syncLock());
    this.life.signal.addEventListener('abort', () => offLock());
    // The side panes (narrative or library, inspector) fold away for a full-width circuit; the
    // choice is a setting (data-wide on <html>), so it holds across steps and pages.
    this.panesBtn = h('button', { class: 'btn ghost icon-only toggle panes-btn', onclick: () => {
      settings.set('wide', !settings.wide);
      applyTheme();
    } }, icon('sidebar', 16)) as HTMLButtonElement;
    this.syncPanesBtn();
    const imgWrap = h('div', { class: 'pal-wrap' }, imgBtn, imgMenu);
    menuKeys(imgWrap, imgMenu, imgBtn, () => showImg(false));
    // offered only while the overview is under ~2.5 px per unit (camera.ts offerReadable), hidden at or above it
    const readBtn = this.readBtn = h('button', { class: 'btn ghost sm keep zoom-read', hidden: true, title: 'Zoom to readable: about 3 px per grid unit from the inputs; drag to pan, Fit returns to the overview', 'aria-label': 'Zoom to readable', onclick: () => this.zoomReadable() }, icon('zoomin', 15), h('span', { class: 'lbl' }, 'Zoom to readable')) as HTMLButtonElement;
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
      { els: [readBtn], items: [{ label: 'Zoom to readable', hint: 'About 3 px per grid unit, from the inputs; drag to pan', icon: 'zoomin', run: () => this.zoomReadable() }] },
      { els: [zoomOut, zoomIn], items: [{ label: 'Zoom out', icon: 'minus', run: () => this.zoomBy(1.25) }, { label: 'Zoom in', icon: 'plus', run: () => this.zoomBy(0.8) }] },
      { els: [imgWrap], items: [
        { label: 'Image as SVG', hint: 'This level, whole, as drawn in the current theme', icon: 'image', run: () => this.exportImage('svg') },
        { label: 'Image as PNG', hint: 'The same at 2× resolution', icon: 'image', run: () => this.exportImage('png') },
        { label: 'Copy link to this view', hint: 'Step, part, inputs, probes, clock cycles', icon: 'link', run: () => void this.copyViewLink() }] },
      { els: [layoutBtn], items: [{ label: 'Layout…', hint: 'Unravel pointers into wires, or reset this level', icon: 'move', run: () => {
        const r = more.getBoundingClientRect();
        this.view.layoutMenu(r.left, r.bottom + 6);
      } }] },
      { els: [lockBtn], items: [{ label: 'Move parts by dragging', hint: 'Off: a drag on a part pans', icon: 'unlock', on: () => settings.moveParts, run: () => settings.set('moveParts', !settings.moveParts) }] },
      { els: [remix], items: [{ label: 'Open in Sandbox', hint: 'An editable copy of the circuit on screen', icon: 'chip', run: () => this.remix() }] },
      { els: [this.timingBtn], items: [{ label: 'Timing diagram', icon: 'wave', on: () => pressed(this.timingBtn), run: () => this.timingBtn.click() }] },
      { els: [this.probeBtn], items: [{ label: 'Probe mode (P)', icon: 'probe', on: () => pressed(this.probeBtn), run: () => this.probeBtn.click() }] },
      { els: [this.whyBtn], items: [{ label: 'Why? (W)', icon: 'why', on: () => pressed(this.whyBtn), run: () => this.whyBtn.click() }] },
      { els: [this.ovBar.el], items: OVERLAY_KINDS.map((k) => ({ label: `Overlay: ${OVERLAY_LABEL[k]}`, hint: this.ovRefusals()[k], icon: 'wave', on: () => this.ovKind === k, run: () => this.setOverlay(this.ovKind === k ? null : k) })) },
    ];
    // Schematic | Breadboard (a scene with Scene.breadboard), and the jumpers' look while the boards are shown
    const segBtn = (label: string, title: string, fn: () => void) => h('button', { title, 'aria-pressed': 'false', onclick: fn }, label);
    this.viewSeg = h('div', { class: 'seg bb-view', role: 'group', 'aria-label': 'View', hidden: true },
      segBtn('Schematic', 'The circuit as a schematic you can open level by level', () => this.showBoards(false)),
      segBtn('Breadboard', 'The circuit as built: chips on breadboards, every LED a net of the same simulation', () => this.showBoards(true)));
    this.wireSeg = h('div', { class: 'seg bb-wires bb-only', role: 'group', 'aria-label': 'Wire colours', hidden: true },
      segBtn('Wires as built', 'Jumpers in their own colours', () => this.setWires('built')),
      segBtn('By value', 'Jumpers coloured by value, as on the schematics', () => this.setWires('value')),
      segBtn('No wires', 'Hide the jumpers between the chips', () => this.setWires('none')));
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
    for (const b of [imgWrap, layoutBtn, lockBtn, this.probeBtn, this.whyBtn, this.ovBar.el]) b.classList.add('sch-only');
    // zoom and Fit work on the boards too (their own camera)
    const upBtn = btn('up', 'Up one level (Esc)', () => this.up()), fitBtn = btn('fit', 'Fit to screen', () => (this.boardOn ? this.board.fitAll() : this.view.fit()));
    upBtn.classList.add('sch-only');
    const bar = this.bar = h('div', { class: 'stage-bar unfit' },
      this.viewSeg, this.crumbs, this.wireSeg, remix, imgWrap, layoutBtn, lockBtn, this.probeBtn, this.whyBtn, this.ovBar.el, this.timingBtn, moreWrap,
      upBtn, readBtn, zoomOut, zoomIn, fitBtn,
      this.panesBtn);
    this.canvas = h('div', { class: 'canvas' });
    this.levelBadge = h('div', { class: 'level-badge' });
    this.layoutPill = h('div', { class: 'layout-pill sch-only', hidden: true, role: 'status' });
    this.dock = h('div', { class: 'panel-dock' });
    // Touch: dblclick comes from a double tap; the Layout button stands in for the right-click menu.
    this.hint = hintBadge('double-click a part to open it · drag a part or a wire to move it (shift: pick several; the lock on the bar stops it) · right-click for layout · drag to pan · wheel or pinch to zoom',
      'double-tap a part: open · drag: pan (unlocked: tap a part or wire, then drag it) · pinch: zoom', 'stage', '', HINT_AUTO_MS);
    this.canvas.append(this.levelBadge, this.layoutPill, this.hint, this.dock, this.board.el, this.why.el);
    this.controls = h('div', { class: 'controls unfit' });
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
      why: (i) => {
        this.why.setOn(true);
        this.why.netClick(i);
      },
      inspect: (c) => {
        this.select(c);
        this.showInspector();
        this.inspector.openAt('info');
      },
      explain: (c) => this.explain(c),
      measure: (t) => this.measure(t),
      up: () => this.up(),
      elsewhere: (t) => this.elsewhere(t),
      accuse: (flat, name) => this.accuser?.(flat, name) ?? [],
      layoutChanged: () => this.syncLayoutPill(),
    });
    this.view.onCamera(() => this.syncReadable());
    this.view.arrange = true;
    this.view.pickable = true;
    this.view.trace = true;
    this.view.badge = () => {
      const c = this.canvas.getBoundingClientRect();
      // the LEVEL tag and, under it, the layout pill: one corner the fit keeps clear when the circuit would reach it
      const rs = [!this.levelBadge.classList.contains('yield') && this.levelBadge.getBoundingClientRect(), !this.layoutPill.hidden && this.layoutPill.getBoundingClientRect()]
        .filter((r): r is DOMRect => !!r && r.width > 0);
      if (!rs.length) return null;
      const x0 = Math.min(...rs.map((r) => r.left)), y0 = Math.min(...rs.map((r) => r.top));
      return { x: x0 - c.left, y: y0 - c.top, w: Math.max(...rs.map((r) => r.right)) - x0, h: Math.max(...rs.map((r) => r.bottom)) - y0 };
    };
    // Tab-reachable (and S or the skip link focus it, ui/quicknav.ts): its keys work while it has focus
    this.el.tabIndex = 0;
    this.el.setAttribute('aria-label', 'Circuit');
    this.view.menuBack = this.el;
    this.el.addEventListener('keydown', (e) => {
      if (this.pending) return;
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      // on the circuit, or a control of its drawing: a button or a panel with the focus keeps the browser's own menu
      if (isMenuKey(e) && !this.boardOn && (e.target === this.el || this.view.el.contains(e.target as Node))) {
        e.preventDefault();
        this.view.keyMenu(e.target === this.el ? this.view.cursorEl() : e.target as Element);
        return;
      }
      // the part cursor, run, step and zoom: only while the circuit itself has the focus (a panel's or a 3D model's own keys stay theirs)
      if (e.target === this.el && !this.boardOn && this.cursorKey(e)) { e.preventDefault(); return; }
      // the learner's layout: undo / redo, and Esc lets go of picked parts before it goes up a level
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        if (this.view.undo(k === 'y' || e.shiftKey)) e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && this.view.dropGroup()) return;
      if (e.key === 'Escape' && this.pathLit) {
        this.pathLit = false;
        // the scene's own highlight belongs to its top level, as Why? puts it back
        this.view.highlight(this.ctx === this.rootCtx ? this.scene?.highlight ?? [] : []);
        return;
      }
      if (matches(e, 'stage.probe') && shortcutAllowed(e)) this.setProbeMode(!this.probeMode);
      if (matches(e, 'stage.why') && shortcutAllowed(e) && !this.boardOn) this.why.setOn(!this.why.on);
      if (e.key === 'Escape' && this.why.on) {
        this.why.setOn(false);
        return;
      }
      if (e.key === 'Escape' && this.probeMode) {
        this.setProbeMode(false);
        return;
      }
      // Alt+Backspace is the top bar's way back (ui/returnto.ts)
      if (e.key === 'Escape' || (e.key === 'Backspace' && !e.altKey)) {
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
      // the workbench follows the Load-dependent delay setting: a scene on the other model is built again, at the same level
      if (this.scene && this.sim?.kind === 'gate' && (this.sim.ticksPerUnit ?? 1) !== (this.delayOf(this.scene) === 'load' ? LOAD_TICKS : 1)) {
        this.load(this.scene, this.path.length ? this.path : undefined);
        return;
      }
      this.refresh();
    });
    this.view.radix = settings.radix;
    this.inspector.radix = settings.radix;
    // The canvas also changes size during a run (the bottom bar rewraps as values and the status
    // change): a view the learner zoomed into must survive that.
    new ResizeObserver(() => {
      this.guessInspector();
      this.autoInspector();
      // a new width (a window resized, a side pane shown or hidden) decides the folds again; a height-only change (the
      // bottom bar rewrapping during a run) does not, or panels would fold and unfold as values change
      const w = this.canvas.clientWidth;
      if (w !== this.foldWidth && this.foldWidth > 0 && this.view.fitted) this.foldPending = true;
      this.foldWidth = w;
      this.autoFold();
      this.inset = this.rightInset();
      this.drillLayout();
      this.layoutDock(false);
      this.yieldBadge();
      this.view.resized();
      this.syncReadable();
      this.fitBar();
      this.fitControls();
      this.hugPhone();
      // The bars are laid out once before this first fit (their buttons with their words): they stay invisible until then,
      // or dropping the words counted as a layout shift of the whole bar and the run row on every load.
      if (this.canvas.clientWidth > 0) {
        this.bar.classList.remove('unfit');
        this.controls.classList.remove('unfit');
      }
      this.placeLegend();
    }).observe(this.canvas);
    // a chapter's challenge note (ui/stagenotes.ts, put over the canvas by the page) comes, grows and goes: the boards'
    // caption and top follow it (boardCover)
    const notesSize = new ResizeObserver(() => this.syncCover());
    const watchNotes = () => { for (const n of this.canvas.querySelectorAll(':scope > .stage-notes')) notesSize.observe(n); };
    new MutationObserver(watchNotes).observe(this.canvas, { childList: true });
    watchNotes();
    this.life.signal.addEventListener('abort', () => notesSize.disconnect());
    // web fonts change every label's width without resizing the canvas (a weight first used later loads later)
    document.fonts?.addEventListener('loadingdone', () => {
      this.fitBar();
      this.fitControls();
    }, { signal: this.life.signal });
    // F: the circuit alone (every panel and the inspector folded); a second press gives them back
    this.life.signal.addEventListener('abort', bindKeys({
      'stage.fold': () => this.focusMode(),
      // O: the next overlay that applies here, Shift O: off (not on the boards, which have none)
      'stage.overlay': (e) => (this.ctx && !this.boardOn ? this.setOverlay(nextOverlay(this.ovKind, this.ovRefusals(), e.shiftKey)) : false),
    }));
  }

  /** The panels' and the inspector's fold before focusMode() put them away (null: not in focus mode). */
  private focusSaved: { open: HTMLElement[]; inspector: boolean } | null = null;

  /** F: fold every open panel and the inspector for the circuit alone, or restore them as they were. */
  private focusMode(): void {
    if (this.focusSaved) {
      for (const el of this.focusSaved.open) el.classList.remove('collapsed');
      this.inspector.setFolded(this.focusSaved.inspector, false);
      this.focusSaved = null;
    } else {
      const open = this.panels.map((p) => p.el).filter((el) => !el.classList.contains('collapsed') && (el.dataset.dock === 'right' || el.dataset.fold));
      this.focusSaved = { open, inspector: this.inspector.folded };
      for (const el of open) el.classList.add('collapsed');
      this.inspector.setFolded(true, false);
    }
    this.syncCover();
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

  /** A widget on the stage changed what a challenge checks (widgets/asmlab.ts): run the listeners, as a refresh would. */
  notify(): void {
    this.listeners.forEach((f) => f());
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
  /** The inspector shown, its fold decided (or nothing left to decide it from). */
  private revealInspector(): void {
    this.inspector.el.classList.remove('insp-wait');
  }

  showWidget(w: Widget | null): void {
    if (w) this.revealInspector();
    // a widget in the canvas's place (a page's "unknown component"): nothing for the Why? card to explain
    if (w) this.why.setOn(false);
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
    this.syncReadable();
    if (!w) return;
    this.stopAnim();
    this.stopClock();
    const host = h('div', { class: 'widget-host' }, w.el);
    this.canvas.append(host);
    this.widget = { w, host };
  }

  /** A big scene is still being built (load): there is no simulation to act on yet. */
  get loading(): boolean {
    return this.pending !== null;
  }

  /** The scene on the stage, or the big one being built for it (load). */
  get target(): Scene | null {
    return this.pending ?? this.scene;
  }

  /**
   * Show a scene. A big one (BUSY_GATES) is built in slices that let the page paint between them, under a card that
   * names the phases and counts through the longest (view/loadcard.ts); the card only appears when the build is
   * still going after LOAD_CARD_MS. Until it is done the old scene's place is empty and `scene` is still the old one
   * (`target` is the new one). `at`: open this path instead of Scene.path (a drill path from the address bar), which
   * stays the scene's opening view. `builtMs`: how long the caller took to make the scene's definitions, shown as the
   * first phase.
   */
  load(scene: Scene, at?: string[], builtMs = 0): void {
    const seq = ++this.loadSeq;
    const t0 = performance.now();
    this.inspGuess = { scene, at };
    this.guessInspector();
    const st = stats(scene.root);
    const size = st.nands + st.transistors / 4;
    if (size < BUSY_GATES) {
      this.pending = null;
      this.setBuilding(false);
      this.busy(null);
      this.build(scene, at);
      return;
    }
    this.pending = scene;
    this.pendingAt = at;
    this.stopAnim();
    this.stopClock();
    this.busy(null);
    const plan = new LoadPlan();
    plan.completed('hierarchy', builtMs + (performance.now() - t0));
    const what = st.nands ? `${fmtCount(st.nands)} NAND gates` : `${fmtCount(st.transistors)} transistors`;
    const card = new LoadCard(plan, 'Building the circuit from gates',
      `${what}: everything you will see is built from these parts, nothing on screen is drawn by hand.`);
    this.card = card;
    // only a build that takes a while shows the card; a quick one never flashes it
    const showTimer = window.setTimeout(() => {
      if (this.card === card) this.canvas.append(card.el);
    }, LOAD_CARD_MS);
    // The bar and the run controls still belong to the scene being replaced (or to none): nothing to press until it is up.
    this.setBuilding(true);
    this.buildSliced(scene, at, seq, plan, card).catch((err) => {
      // as the synchronous build's: an uncaught error (the page's handlers report it), not a silently empty stage
      this.pending = null;
      setTimeout(() => { throw err; });
    }).finally(() => {
      clearTimeout(showTimer);
      if (this.card === card) this.busy(null);
      if (seq === this.loadSeq) this.setBuilding(false);
    });
  }

  private setBuilding(on: boolean): void {
    this.bar.inert = on;
    this.controls.inert = on;
    this.el.toggleAttribute('aria-busy', on);
  }

  /** The load card over the canvas (null removes it). */
  private busy(card: LoadCard | null): void {
    this.card?.remove();
    this.card = card;
  }

  /** build(), in slices: the same steps, with the page free to paint between them (and a newer load able to overtake). */
  private async buildSliced(scene: Scene, at: string[] | undefined, seq: number, plan: LoadPlan, card: LoadCard): Promise<void> {
    const alive = () => seq === this.loadSeq;
    // the card is repainted on each slice, so a count that moves is seen to move
    const slice = async () => {
      card.paint();
      await nextTask();
    };
    plan.enter('flatten');
    await slice();
    if (!alive()) return;
    const level = this.beginBuild(scene);
    const design = await flattenAsync(scene.root, { mode: level, ...this.flattenOptions() }, (p) => plan.report(p.done, p.total, p.linking), slice);
    if (!alive()) return;
    plan.enter('engine');
    await slice();
    if (!alive()) return;
    this.pending = null;
    this.makeEngine(scene, design, level);
    plan.enter('draw');
    await slice();
    if (!alive()) return;
    this.drawScene(scene, at, design);
    plan.finish();
  }

  private flattenOptions() {
    return { expand: (d: ComponentDef, n: HierNode) => n.parent === null || !d.preferBehavior };
  }

  private build(scene: Scene, at?: string[]): void {
    const level = this.beginBuild(scene);
    // The root is always its structure, even one simulated as a lookup elsewhere (a large RAM opened
    // in the workbench); such parts below it stay leaves and open onto their own sub-simulation.
    const design = flatten(scene.root, { mode: level, ...this.flattenOptions() });
    this.makeEngine(scene, design, level);
    this.drawScene(scene, at, design);
  }

  /** Let go of the last scene; returns the level (gate or switch) the new one is simulated at. */
  private beginBuild(scene: Scene): 'gate' | 'switch' {
    this.edgeHooks.clear();
    this.historyHooks.clear();
    this.resetHooks.clear();
    this.history = [];
    this.showWidget(null);
    this.stopAnim();
    this.stopClock();
    closePopover();
    this.release();
    this.scene = null;
    return needsSwitchLevel(scene.root) ? 'switch' : 'gate';
  }

  /**
   * Follow settings.loadDelay for scenes that do not choose (the workbench sets this); a chapter's scenes stay on the unit
   * model unless a step asks (Scene.delay), so what the prose quotes in gate delays holds for every reader.
   */
  delayFromSetting = false;

  /** The delay model a scene is simulated with. */
  delayOf(scene: Scene): 'unit' | 'load' {
    return scene.delay ?? (this.delayFromSetting && settings.loadDelay ? 'load' : 'unit');
  }

  /** The simulation of a flattened design, powered on and settled. */
  private makeEngine(scene: Scene, design: FlatDesign, level: 'gate' | 'switch'): void {
    this.scene = scene;
    const delay = { delay: this.delayOf(scene) };
    const sim: Sim = level === 'switch' ? switchSim(design, scene.engine === 'nmos')
      : scene.engine === 'cycle' ? new DualSim(design, delay) : new GateSim(design, delay);
    if (sim instanceof DualSim) sim.preferFast = true;
    for (const [k, v] of Object.entries(scene.inputs ?? {})) sim.setInput(k, v);
    sim.reset(scene.powerOn ?? 'zero');
    sim.settle();
    this.sim = sim;
    this.edge = null;
    this.cycles = 0;
    this.probeRefs.clear();
    // toggles counted from the start (an increment per change), so the inspector's Power section has the whole run
    this.meter = sim instanceof GateSim ? new PowerMeter(sim) : null;
    this.meterFrom = 0;
    this.meterPeriod = undefined;
    this.rootCtx = new ViewCtx(sim, design.root);
    this.lastSettle = null;
    this.period = null;
    this.lateEvents = 0;
  }

  /** The drawing, controls and panels of a scene whose simulation is up. */
  private drawScene(scene: Scene, at: string[] | undefined, design: FlatDesign): void {
    // a Why? card is about the nets it was opened on: a new scene closes it (the Timing panel is a setting and stays)
    this.why.setOn(false);
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
    this.panels = this.panelsOf(scene).map((f) => f(this));
    for (const p of this.panels) (p.el.dataset.dock === 'left' ? this.dock : this.canvas).append(p.el);
    for (const p of this.panels) if (p.el.dataset.dock === 'right' || p.el.dataset.fold) this.foldable(p.el);
    for (const p of this.panels) this.panelSize.observe(p.el);
    this.foldPending = true;
    this.autoFold();
    this.inset = this.rightInset();
    this.layoutDock(false);
    this.view.fit();
    this.hugPhone();
    this.inspGuess = null;
    this.revealInspector();
    this.inspPending = true;
    this.autoInspector();
    this.refresh();
    // A link's view (ui/viewlink.ts): inputs, probes and cycles replayed; a replayed run is left paused where it ends.
    const link = takePendingView();
    setViewTarget(this);
    if (link) this.restoreView(link);
    if (settings.autoClock && scene.autoClock !== false && !link?.cycles) { this.startClock(); this.autoRun = this.clockRunning; }
    this.readyHooks.forEach((f) => f());
  }

  private readyHooks = new Set<() => void>();
  /** Called each time a scene has been built and drawn (the first-run coach marks wait for it). */
  onReady(f: () => void): () => void {
    this.readyHooks.add(f);
    return () => this.readyHooks.delete(f);
  }

  /** The scene's panels, and Memory contents when it declares none and its circuit holds a memory (not on NmosSim). */
  private panelsOf(scene: Scene): ScenePanel[] {
    if (scene.panels?.length) return scene.panels;
    if (scene.memory === false || scene.engine === 'nmos' || !this.rootCtx) return [];
    return findMemories(this.rootCtx.sim, this.rootCtx.node).length ? [memGridPanel] : [];
  }

  /**
   * Let go of the last scene before the next one is built: two designs of chapter graphics's size at once
   * (each about half a gigabyte) are more than some browsers allow a tab, and the tab died.
   */
  private release(): void {
    this.panelSize.disconnect();
    this.panels.forEach((p) => { p.destroy?.(); p.el.remove(); });
    this.panels = [];
    this.panelPause = null;
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
  goTo(path: string[], notify = true, gates = false): void {
    // another level: a path lit on this one is gone with it
    this.pathLit = false;
    if (!this.rootCtx) return;
    this.closeLeaf();
    let ctx = this.rootCtx;
    let leafName: string | null = null;
    for (let i = 0; i < path.length; i++) {
      const name = path[i];
      if (!gates && i === path.length - 1 && ctx.node.children?.get(name)?.def.modelPanel) { leafName = name; break; }
      const c = ctx.child(name);
      if (!c) {
        const def = ctx.node.children?.get(name)?.def;
        if (def && (def.prim === 'nmos' || def.prim === 'pmos') && i === path.length - 1) leafName = name;
        break;
      }
      ctx = c;
    }
    this.ctx = ctx;
    this.why.levelChanged();
    this.selected = null;
    // a drill path (a chip opened, Back / Forward to one) is a schematic's, beside its board while the learner
    // follows the boards; back at the top from there, the boards again
    if (this.boardOn && ctx !== this.rootCtx) this.setBoardShown(false);
    if (ctx === this.rootCtx && this.drill && boardChoice) this.setBoardShown(true);
    else this.syncDrill();
    this.syncPins();
    this.view.cover = this.covers();
    this.view.show(ctx, ctx === this.rootCtx);
    this.syncLayoutPill();
    this.paintOverlay();
    // another level, another shape: which panels stay open is decided again for it (autoFold), the learner's own folds held
    // (foldChoice). A wide reorder buffer opened under the CPU and Out of order panels was fitted ~45 px tall.
    if (notify && this.panels.some((p) => p.el.dataset.fold === 'narrow')) this.refold();
    // a drill folds the right-docked panels (the board and the schematic want the room, at any width), and the top level
    // gets them back as they were, unless the learner folded or unfolded one by hand meanwhile (foldChoice)
    if (this.drillFold) {
      this.drillFold = false;
      const open = this.panels.filter((p) => p.el.dataset.dock === 'right' && p.el.dataset.fold && !p.el.classList.contains('collapsed'));
      if (open.length) {
        this.drillChoice = foldChoice.get('right');
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
    this.updateNoteMarks();
    if (notify) this.navListeners.forEach((f) => f(this.path));
  }

  /** The learner's notes pinned to parts of the level shown (ui/notes.ts); the page that owns the notes sets it. */
  noteMarks: ((path: string[]) => NotePin[]) | null = null;

  /** Draw the markers again (a note was added, moved or deleted, or the level changed). */
  updateNoteMarks(): void {
    this.view.setNotePins(this.noteMarks && !this.leaf ? this.noteMarks(this.path) : []);
  }

  /** The part selected on the level shown, if any. */
  get selectedInst(): string | null {
    return this.leaf ? null : this.selected;
  }

  /** The scene's input values and clock cycles so far: what a note pinned here remembers. */
  get sceneState(): { inputs: Record<string, number>; cycle: number } {
    const inputs: Record<string, number> = {};
    for (const p of this.scene?.root.ports ?? []) if (p.dir === 'in' && this.sim) inputs[p.name] = this.getInput(p.name);
    return { inputs, cycle: this.cycles };
  }

  /** Show a pinned note's place: open its level, put the inputs back, select its part. */
  showPin(pin: { path: string[]; inst?: string; inputs?: Record<string, number> }): void {
    this.openPath(pin.path);
    const known = new Set((this.scene?.root.ports ?? []).filter((p) => p.dir === 'in').map((p) => p.name));
    const inputs = Object.fromEntries(Object.entries(pin.inputs ?? {}).filter(([k]) => known.has(k)));
    if (Object.keys(inputs).length) this.setInputs(inputs);
    if (pin.inst && this.ctx?.node.children?.has(pin.inst)) {
      this.view.select(pin.inst);
      this.select(pin.inst);
      this.view.focusInst(pin.inst);
    }
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
    if (def && (def.prim === 'nmos' || def.prim === 'pmos' || def.modelPanel)) {
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
    this.syncReadable();
    if (this.syncDrill()) this.view.setCover(this.covers(), true);
    const [sch, bb] = [...this.viewSeg.querySelectorAll('button')];
    sch.classList.toggle('on', !on);
    sch.setAttribute('aria-pressed', String(!on));
    bb.classList.toggle('on', on);
    bb.setAttribute('aria-pressed', String(on));
    if (on) this.setProbeMode(false);
    this.syncPins();
    // the boards have no overlay: its legend goes, and comes back with the schematic
    if (this.ovKind) this.paintOverlay();
    this.fitBar();
  }

  private setWires(w: WireLook): void {
    wireChoice = w;
    this.board.wires = w;
    [...this.wireSeg.querySelectorAll('button')].forEach((b, i) => {
      const on = (['built', 'value', 'none'] as const)[i] === w;
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
      if (foldChoice.get('right') === this.drillChoice) for (const el of this.drillFolded) el.classList.remove('collapsed');
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

  /** A path lit from the menu: Esc puts the scene's own highlight back first. */
  private pathLit = false;

  /** The right-click menu's Measure for a net or a part of the level on screen. */
  private measure(t: ViewFocus): MeasureHost {
    const ctx = this.ctx!, sim = this.sim;
    const sub = ctx.sim !== sim;
    const sw = !sim || sim.kind !== 'gate';
    const cycle = sim instanceof DualSim;
    const timing = sw ? 'Switch level has no gate delay. A relay scene counts relay steps instead.'
      : sub ? 'Timing covers the scene’s own design, and this leaf is outside it. Look from the level above.'
        : { design: sim!.design, at: ctx.path };
    const light = (paths: string[][]) => {
      const n = this.view.lightPaths(paths);
      this.pathLit = n > 0;
      this.flashNow(n ? `Slowest path: ${n} part${n === 1 ? '' : 's'} lit · Esc clears` : 'Its slowest path stays inside it');
    };
    if ('inst' in t) {
      const off = powerOff(ctx.node.children?.get(t.inst)?.def, !sub && !sw && !cycle);
      const power = off ? off : cycle ? 'The cycle engine counts no toggles, so there is no power to read.'
        : sw ? 'Power is counted from gate toggles, and this level has none.'
          : sub ? 'Power is counted on the scene’s GateSim, and this leaf has its own simulation.'
            : () => { this.select(t.inst); this.showInspector(); this.inspector.openAt('power'); };
      return { timing, light, power };
    }
    const nets = this.flatNets(t.net);
    const probe = cycle ? 'Cycle engine: values at clock edges only, so there is no gate time to plot.'
      : sw ? 'Switch level has no gate time: the solver returns settled values.'
        : !nets ? 'A separate lock-step simulation. Probe its ports from the level above.'
          : (() => {
            const hit = this.analyzer.probeFor(netKey(nets));
            // a port's own lane is already this net
        const port = this.analyzer.lanes.find((l) => !l.probe && netKey(l.nets) === netKey(nets));
        if (port && !hit) return `Its lane is already in the Timing panel: ${port.label}.`;
        return hit ? { label: 'Remove its probe', run: () => this.analyzer.remove(hit.id) }
              : { label: 'Add a probe and timing lane', run: () => { this.addProbe(ctx, t.net, nets); this.showAnalyzer(true); } };
          })();
    const toggles = cycle ? 'The cycle engine counts no toggles, so there is no power to read.'
      : sw ? 'Power is counted from gate toggles, and this level has none.'
        : !nets ? 'Power is counted on the scene’s GateSim, and this leaf has its own simulation.'
          : () => {
            const tg = (sim as GateSim).toggles;
            return tg ? nets.reduce((a, n) => a + (tg[n] ?? 0), 0) : null;
          };
    return { probe, timing, light, toggles };
  }

  /** The right-click menu's Explain for a part or (null) this level. */
  private explain(c: string | null): { def: ComponentDef; host: ExplainHost } | null {
    const def = c ? this.ctx?.node.children?.get(c)?.def : this.ctx?.def;
    if (!def) return null;
    const at = (section: 'truth' | 'used') => () => {
      this.select(c);
      this.showInspector();
      this.inspector.openAt(section);
    };
    const go = (href: string) => {
      markJump();
      location.hash = href;
    };
    return { def, host: {
      truth: at('truth'), used: at('used'),
      openCodex: (id) => go(`#/campaign/codex/${id}`),
      openChapter: go,
    } };
  }

  /** The right-click menu's Take it elsewhere for a part, a wire or (null) this level. */
  private elsewhere(t: ViewFocus | null): ElsewhereHost | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const inst = t && 'inst' in t ? t.inst : null;
    const def = t && 'net' in t ? null : inst ? ctx.node.children?.get(inst)?.def ?? null : ctx.def;
    const say = (msg: string) => this.flashNow(msg);
    return {
      def, say,
      ...(this.scene?.noRemix ? {} : { sandbox: { label: 'Open in Sandbox', run: () => this.remix(def ?? undefined) } }),
      verilog: true,
      ...(def ? { image: inst
        // the child's simulation is built on the click: a menu must open at once on a large block
        ? (def.netlist ? (kind: 'svg' | 'png') => {
          const child = ctx.child(inst);
          return child ? import('./image').then((m) => m.exportInside(child, this.view.el, kind)) : say('It has no inside to draw');
        } : 'It has no inside to draw.')
        : (kind: 'svg' | 'png') => this.exportImage(kind) } : {}),
      link: { label: 'Copy a link to this view', hint: t ? 'Opens here, with this one picked out' : 'Step, part, inputs, probes, clock cycles', run: () => void this.copyViewLink(t ?? undefined) },
    };
  }

  /** A part or the level on screen as a new sandbox chip (remix.ts is loaded on demand), then go there. */
  private remix(what?: ComponentDef): void {
    const shown = what ?? this.ctx?.def;
    if (!shown) return;
    // as the learner arranged it: moved parts, unravelled pointers drawn as wires
    const lay = layoutOf(shown.id), authored = netlistOf(shown), nl = authored && drawnNetlist(shown, authored);
    const def: ComponentDef = nl ? { ...shown, netlist: () => applyLayout(nl, lay) } : shown;
    import('../editor/remix').then((m) => {
      const r = m.remixIntoStorage(def);
      if ('error' in r) this.setStatus(h('span', { class: 'pulse warn' }), `Cannot open in the sandbox: ${r.error}`);
      else {
        markJump();
        location.hash = `#/sandbox/${r.id}`;
      }
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
    if (!this.ctx) return;
    const ctx = this.ctx;
    const node = ctx.node.children!.get(name)!, def = node.def;
    if (!def.modelPanel && !this.leafFactory) return;
    const li = node.leafIndex;
    const widget = def.modelPanel
      ? modelLeaf(def, { state: () => (li === undefined ? undefined : ctx.sim.leafState(li)), gates: def.netlist ? () => this.goTo([...ctx.path, name], true, true) : undefined })
      : this.leafFactory!(def, () => ctx.transistorGate(name));
    const host = h('div', { class: 'widget-host' }, widget.el);
    widget.el = host;
    this.canvas.append(host);
    this.leaf = { name, widget };
    this.syncReadable();
    this.levelBadge.textContent = def.modelPanel ? 'level: a model, not transistors' : 'level: a single transistor';
  }

  private closeLeaf(): void {
    if (!this.leaf) return;
    this.leaf.widget.destroy?.();
    this.leaf.widget.el.remove();
    this.leaf = null;
    this.syncReadable();
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

  /** Says what the keyboard cursor reached (a polite live region inside the stage). */
  private sayEl: HTMLElement | null = null;
  private say(text: string): void {
    if (!this.sayEl) { this.sayEl = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }); this.el.append(this.sayEl); }
    const el = this.sayEl;
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 30);
  }

  /** The cursor's item in words; a top-level pin drawn as a colour only (one bit) gets its value from the simulation. */
  private cursorWords(): string {
    const t = this.view.cursorText(), it = this.view.cursor;
    if (!it || it.kind !== 'pin' || t.includes('=') || this.ctx !== this.rootCtx || !this.sim?.design.root.ports[it.name]) return t;
    const n = this.value(it.name);
    return `${t} = ${Number.isFinite(n) && n >= 0 ? n : 'X'}`;
  }

  /**
   * The stage's keys while the circuit itself has the focus (ui/keys.ts, the stage group): the part cursor (arrows, Home,
   * End), ↵ / Space on what it stands on, Ctrl ↵ run, . > , pulse / step / back, + − 0 zoom. True when the key was taken.
   */
  private cursorKey(e: KeyboardEvent): boolean {
    const v = this.view;
    const mod = e.ctrlKey || e.metaKey;
    const arrow = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[e.key as 'ArrowLeft'];
    const land = (it: CursorItem | null) => {
      if (!it) return;
      v.setCursor(it);
      if (it.kind === 'inst') this.select(it.name);
      this.say(this.cursorWords());
    };
    if (arrow && !mod && !e.altKey) {
      const cur = v.cursor;
      land(cur ? nextInDir(v.cursorItems(), cur, arrow) ?? cur : firstItem(v.cursorItems()));
      return true;
    }
    if ((e.key === 'Home' || e.key === 'End') && !mod) { land(firstItem(v.cursorItems(), e.key === 'Home' ? 'in' : 'out')); return true; }
    if (e.key === 'Enter' && mod) {
      if (!this.runBtn) this.say('No clock on this circuit to run');
      else this.runBtn.click();
      return true;
    }
    const it = v.cursor;
    if ((e.key === 'Enter' || e.key === ' ') && it && !mod) {
      if (it.kind === 'pin' && it.dir !== 'out' && v.drivable) {
        const pin = this.ctx?.def.ports.find((p) => p.name === it.name);
        if (pin && pin.width > 1) {
          if (e.key === ' ') return false;
          const r = v.cursorEl()?.getBoundingClientRect();
          if (r) this.editInput(it.name, r);
        } else this.toggleInput(it.name);
        setTimeout(() => this.say(this.cursorWords()), 50);
      } else if (it.kind === 'inst' && e.key === 'Enter' && this.ctx?.canOpen(it.name)) this.open(it.name);
      else this.say(this.cursorWords());
      return true;
    }
    if (mod || e.altKey || !shortcutAllowed(e)) return false;
    const again = () => { if (v.cursor) setTimeout(() => this.say(this.cursorWords()), 50); };
    if (matches(e, 'cursor.pulse')) { if (this.runBtn) { this.pulse(); again(); } else this.say('No clock on this circuit'); return true; }
    if (matches(e, 'cursor.step')) { if (this.sim?.kind === 'gate' || this.relayTime) { this.stepOnce(); again(); } return true; }
    if (matches(e, 'cursor.back')) { if (this.back()) again(); else this.say('Nothing to go back to'); return true; }
    if (matches(e, 'cursor.zoomin')) { v.zoom(0.8); return true; }
    if (matches(e, 'cursor.zoomout')) { v.zoom(1.25); return true; }
    if (matches(e, 'cursor.fit')) { v.fit(); return true; }
    return false;
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
    }, () => { const b = this.sim?.getInputBits(port); return (b && packBig(b)) ?? 0n; });
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
    // a clock left high by hand: no edge, but the panels' models would step. Settled even with a period: lowered and
    // raised at one instant (the next edge due now), transport delay would cancel the pulse
    lowerClock(sim, clk);
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
  runCycles(n: number, stop?: () => boolean, flowMs = 0, quiet = false): number {
    const clk = this.clockPort();
    if (!clk || !this.sim) return 0;
    this.stopClock();
    this.finishEdge(false);
    this.stopAnim();
    let i = 0;
    for (; i < n && !(stop && stop()); i++) this.cycle(clk);
    this.lastSettle = null;
    // quiet: the caller repaints when it wants to (a game's screen runs far faster than the page can redraw the stage)
    if (!quiet) this.refreshFlowing(flowMs);
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
    if (on) this.why.setOn(false);
    this.probeMode = on;
    this.probeBtn.classList.toggle('on', on);
    this.canvas.classList.toggle('probing', on || this.why.on);
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
    if (this.why.netClick(idx)) return true;
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
    this.addProbe(this.ctx, idx, nets);
    return true;
  }

  private addProbe(ctx: ViewCtx, idx: number, nets: number[]): void {
    const net = netlistOf(ctx.def)!.nets[idx];
    const name = net.name ?? net.ends.find((e) => !e.includes('.')) ?? net.ends[0];
    const where = ctx.path;
    const lane = this.analyzer.add({
      label: [...where.slice(-1), name].join('.'), title: [...where, name].join('.'),
      nets, width: nets.length, color: this.analyzer.nextColor(), probe: true, clock: false,
    });
    this.probeRefs.set(lane.id, { path: [...where], net: idx });
  }

  // ---- a link to this view -----------------------------------------------------------------

  /** What differs from the scene as loaded: input values, probed nets, clock cycles run. */
  viewState(): ViewState {
    const v = emptyView();
    const sim = this.sim, scene = this.scene;
    if (!sim || !scene) return v;
    const clk = this.clockPort();
    for (const p of inPorts(scene.root)) {
      if (p.name === clk || scene.hiddenInputs?.includes(p.name)) continue;
      const bits = sim.getInputBits(p.name);
      if (!bits || bits.some((b) => b !== B0 && b !== B1)) continue;
      const now = packBig(bits);
      if (now === null) continue;
      const start = scene.inputs?.[p.name];
      if (now !== BigInt(start ?? 0)) v.inputs[p.name] = now;
    }
    if (sim.kind === 'gate' && !(sim instanceof DualSim)) {
      for (const lane of this.analyzer.lanes) {
        const ref = lane.probe ? this.probeRefs.get(lane.id) : undefined;
        if (ref) v.probes.push(ref);
      }
    }
    v.cycles = clk ? this.cycles : 0;
    return v;
  }

  /** The hash that reopens this view: the route (kept current by the page) plus the suffix. */
  viewHash(): string {
    return splitView(location.hash).route + encodeView(this.viewState());
  }

  isLive(): boolean {
    return !!this.sim && this.el.isConnected;
  }

  /** Copy the link to this view (`focus`: picking this part or wire out); the status line says what it holds. */
  async copyViewLink(focus?: ViewFocus): Promise<void> {
    const v = this.viewState();
    if (focus) v.focus = focus;
    const url = linkTo(splitView(location.hash).route + encodeView(v));
    const what = focus ? 'this part or wire picked out' : isEmptyView(v) ? 'this view' : [Object.keys(v.inputs).length ? 'inputs' : '', v.probes.length ? 'probes' : '', v.cycles ? `${v.cycles} cycle${v.cycles === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    if (await copyText(url)) this.flashNow(`Link copied (${what})`);
    else window.prompt('Copy this link (Ctrl+C):', url);
  }

  private flashNow(msg: string): void {
    this.flash = msg;
    this.updateControls();
  }

  /**
   * Apply a link's view to the scene just built: inputs, probes, then the clock cycles replayed as fast pulses (the input
   * changes made between them are not replayed, only their end state). Capped by a time budget; a note says what was cut.
   */
  restoreView(v: ViewState): void {
    const sim = this.sim, scene = this.scene;
    if (!sim || !scene) return;
    const clk = this.clockPort();
    const ports = new Map(inPorts(scene.root).map((p) => [p.name, p] as const));
    let skipped = 0;
    for (const [name, val] of Object.entries(v.inputs)) {
      const p = ports.get(name);
      if (!p || name === clk || scene.hiddenInputs?.includes(name)) { skipped++; continue; }
      sim.setInputBits(name, unpackBig(val, p.width));
    }
    if (Object.keys(v.inputs).length) sim.settle();
    if (v.probes.length && sim.kind === 'gate' && !(sim instanceof DualSim) && this.rootCtx) {
      for (const ref of v.probes) {
        let ctx: ViewCtx | null = this.rootCtx;
        for (const n of ref.path) ctx = ctx?.child(n) ?? null;
        const nets = ctx?.node.nets?.[ref.net];
        if (!ctx || !nets || !netlistOf(ctx.def)?.nets[ref.net]) { skipped++; continue; }
        this.addProbe(ctx, ref.net, [...nets]);
      }
      if (this.analyzer.lanes.some((l) => l.probe)) this.showAnalyzer(true, false);
    } else if (v.probes.length) skipped += v.probes.length;
    let note = '';
    if (v.cycles > 0 && clk) {
      const deadline = performance.now() + REPLAY_MS;
      const done = this.runCycles(v.cycles, () => performance.now() > deadline);
      if (done < v.cycles) note = `Link opened: replayed ${done} of ${v.cycles} clock cycles (the rest would take too long here)`;
    }
    this.history = [];
    this.refresh();
    if (v.focus && !this.boardOn && !this.view.showTarget(v.focus)) skipped++;
    if (skipped && !note) note = `Link opened; ${skipped} item${skipped === 1 ? '' : 's'} in it no longer match this circuit`;
    if (note) this.flashNow(note);
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
    if ((sim.ticksPerUnit ?? 1) !== 1) { this.startTimedAnim(sim); return; }
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

  /**
   * Slow motion under load-dependent delay: a step goes to the next change, which may be a tenth of a unit on or two
   * units on, so each waits in proportion to the time it advanced (a unit lasts what one gate delay lasts at the unit
   * model): a heavily loaded gate is visibly slower. stopAnim clears it (a timeout id, cleared like an interval's).
   */
  private startTimedAnim(sim: Sim): void {
    const unitMs = 1000 / settings.speed;
    const tick = () => {
      const t0 = sim.time;
      const more = sim.step();
      const dt = Math.max(0.1, sim.time - t0);
      if (!more) {
        this.stopAnim();
        this.lastSettle = sim.time - this.changeStart;
      }
      this.refreshFlowing(0.95 * unitMs * dt);
      if (more && sim.busy()) this.anim = setTimeout(tick, unitMs * Math.max(0.1, (sim.nextEventTime?.() ?? sim.time + 1) - sim.time)) as unknown as ReturnType<typeof setInterval>;
    };
    tick();
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

  /** A panel's own Slow run is going (widgets/slowctl.ts): the bar shows it as running, and its Pause stops it. */
  private panelPause: (() => void) | null = null;
  setPanelRun(pause: (() => void) | null): void {
    this.panelPause = pause;
    this.syncRunBtn();
  }

  private syncRunBtn(): void {
    const b = this.runBtn;
    if (!b) return;
    const on = !!this.runClock || !!this.panelPause;
    // unchanged: every runCycles comes through here, and fitControls forces a layout of the page
    if (b.getAttribute('aria-pressed') === String(on)) return;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren(icon(on ? 'pause' : 'play', 14), h('span', { class: 'lbl', 'data-pad': on ? 'Run' : 'Pause' }, on ? 'Pause' : 'Run'));
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
    const outs = outPorts(root).filter((p) => !(this.scene!.hiddenOutputs ?? []).includes(p.name));
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
      this.runBtn = h('button', { class: 'btn sm toggle', title: `Run the clock (${1000 / RUN_MS} cycles per second) / pause it (also a panel's Slow run)`, onclick: () => (this.panelPause ? this.panelPause() : this.runClock ? this.stopClock() : this.startClock()) }) as HTMLButtonElement;
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
    this.backBtn = labelled('ghost', 'Step back (stage): undo the last clock cycle, gate step or input change. A panel’s own Step back undoes one of its steps', 'stepBack', 'Step back', () => this.back()) as HTMLButtonElement;
    acts.append(this.backBtn);
    if (this.sim?.kind === 'gate' || this.relayTime) {
      acts.append(labelled('ghost', this.relayTime ? 'Advance one relay step (every armature follows its coil)' : 'Advance one gate delay', 'step', 'Step', () => this.stepOnce()));
    }
    acts.append(labelled('ghost', 'Reset (stage): power-cycle the whole circuit and clear its panels', 'reset', this.scene!.resetLabel ?? 'Reset', () => this.powerCycle()));
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
    this.panelPause?.(); // a panel's Slow run ended with the run it belonged to
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
    else if (busy) msg = `propagating… t = ${fmtTime(sim, sim.time - this.changeStart)}`;
    else if (this.lastSettle !== null && this.relayTime) msg = `settled in ${this.lastSettle} relay step${this.lastSettle === 1 ? '' : 's'} (${(this.lastSettle * RELAY_STEP_MS).toFixed(1)} ms)`;
    else if (this.lastSettle !== null && sim.kind === 'gate') {
      // under load-dependent delay the time is in units with tenths (a unit = a NAND driving one input)
      const loaded = (sim.ticksPerUnit ?? 1) !== 1, word = loaded ? 'unit' : 'delay';
      msg = `${this.clockPort() && this.cycles ? 'edge ' : ''}settled in ${fmtTime(sim, this.lastSettle)} ${word}${this.lastSettle === 1 ? '' : 's'}${loaded ? ' (load-dependent delay)' : ''}`;
    }
    else msg = this.relayTime ? 'relays at rest' : sim.kind === 'switch' ? 'solved instantly' : 'settled';
    const warn = sim.unstable || (!!this.period && this.lateCount > 0);
    this.setStatus(h('span', { class: `pulse${busy ? ' busy' : ''}${warn ? ' warn' : ''}` }), msg);
  }

  /** The status line: a dot and a message, cut with an ellipsis where the bar is short of room (the whole of it is the tooltip). */
  private setStatus(dot: HTMLElement, msg: string): void {
    const t = this.status.lastElementChild as HTMLElement | null;
    if (t && this.status.childElementCount === 3 && this.status.children[1].textContent === msg && (this.status.firstElementChild as HTMLElement).className === dot.className) return;
    const short = shortStatus(msg);
    this.status.replaceChildren(dot, h('span', { class: 'status-txt status-full' }, msg), h('span', { class: 'status-txt status-short' }, short));
    this.status.title = msg;
  }

  // ---- rendering --------------------------------------------------------------------------

  refresh(): void {
    syncPopover();
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
    this.why.update();
    this.tickOverlay();
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
        level: this.hdlLevel(ctx.def),
      });
    } else {
      this.inspector.show({ def: ctx.def, portBits: (p) => ctx.portBits(p), instance: ctx.path[ctx.path.length - 1], power: () => this.livePower(ctx, ctx.node), level: this.hdlLevel(ctx.def) });
    }
  }

  /** The inspector's HDL tab links the level's source to this drawing: a line lights its instance in focus, as the prose's
   *  named parts do; cleared, the scene's own highlight comes back. */
  private hdlLevel(def: ComponentDef): { def: ComponentDef; light: (names: string[]) => void } {
    return {
      def,
      light: (names) => {
        if (this.ctx?.def !== def) return;
        if (names.length) this.highlight(names, true);
        else this.highlight(this.ctx === this.rootCtx ? this.scene?.highlight ?? [] : []);
      },
    };
  }

  /** The whole scene's switching activity since it loaded (or a Reset, a step back, Restart): the Power panel's. Null off GateSim. */
  power(): LivePower | null {
    return this.rootCtx ? this.livePower(this.rootCtx, this.rootCtx.node) : null;
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
    if (paintCrumbVals(this.crumbVals, settings.radix)) this.markSqueezed();
  }

  /** A level above the open one, shrunk to a few letters (app.css), would clip its value pill to an empty blob: it drops the pill
   *  (.squeezed) and keeps its name's first letters; the value stays in the open level's chain below. Measured with the pill shown. */
  private markSqueezed(): void {
    const items = [...this.crumbs.querySelectorAll<HTMLElement>(':scope > button')];
    for (const b of items.slice(0, -1)) {
      if (!b.querySelector('.val')) continue;
      b.classList.remove('squeezed');
      if (b.scrollWidth > b.clientWidth + 1) b.classList.add('squeezed');
    }
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

  /** Drop the bar's button labels (all but Probe and Why?, then those too; icons and tooltips remain) when the open level's name would otherwise be
   *  cut; measured with the labels shown, so they come back once there is room. Still cut, the least used
   *  buttons move into a More menu a group at a time (shedGroups: zoom, image, layout, sandbox, timing, probe),
   *  and only then (a phone: the buttons take the whole bar, the name read "4…") the hierarchy gets a row of
   *  its own above the buttons (.stacked), every button back in the bar. The levels above the open one shrink
   *  first (app.css): cut with an ellipsis, their names in their tooltips. */
  private fitBar(): void {
    this.fitBarItems();
    this.markSqueezed();
  }

  private fitBarItems(): void {
    const bar = this.bar;
    const moreWrap = this.moreBtn.parentElement!;
    bar.classList.remove('compact', 'tight', 'stacked');
    for (const g of this.shedGroups) g.els.forEach((el) => el.classList.remove('shed'));
    moreWrap.hidden = true;
    // only what the bar shows (not a scene's hidden Open in Sandbox, nor a phone's zoom buttons)
    const live = this.shedGroups.filter((g) => g.els.some((el) => el.offsetWidth > 0));
    const shed = (k: number) => live.forEach((g, i) => g.els.forEach((el) => el.classList.toggle('shed', i < k)));
    const items = [...this.crumbs.querySelectorAll('button')];
    // every item of the bar inside its right edge (their own boxes: a menu open below one does not count). Checked even
    // with no hierarchy yet: while a large scene loads the bar has its buttons but no names, and with every label shown it
    // ran past the edge until the scene arrived (the smoke caught it under load on #/c/ooo/5)
    const edge = bar.getBoundingClientRect().right + 1;
    const inside = () => [...bar.children].every((c) => !(c as HTMLElement).offsetWidth || c.getBoundingClientRect().right <= edge);
    const cur = items.at(-1);
    const crumbs = this.crumbs;
    const fits = () => inside() && (!cur || (cur.scrollWidth <= cur.clientWidth + 1 && crumbs.scrollWidth <= crumbs.clientWidth + 1 && cur.offsetTop <= items[0].offsetTop + 2));
    if (fits()) return this.toggleMore(false);
    bar.classList.add('compact');
    if (fits()) return this.toggleMore(false);
    bar.classList.add('tight');
    if (fits()) return this.toggleMore(false);
    moreWrap.hidden = false;
    for (let k = 1; k <= live.length; k++) {
      shed(k);
      if (fits()) return;
    }
    // no hierarchy to give a row of its own: keep everything that can go in More there
    if (!cur) return;
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

  /** The overlay on (null: none): the stage bar's, O / Shift O, the Timing panel's heat toggle. */
  get overlayKind(): OverlayKind | null {
    return this.ovKind;
  }

  /** Listen to the overlay being turned on, off or changed (the Timing panel's heat toggle follows it). */
  onOverlay(f: () => void): () => void {
    this.ovListeners.add(f);
    return () => this.ovListeners.delete(f);
  }

  /** What this scene runs on, for which overlays apply. */
  private ovRefusals(): Partial<Record<OverlayKind, string>> {
    const sim = this.sim, ctx = this.ctx;
    if (!sim || !ctx) return {};
    const c = { level: sim.kind, engine: this.scene?.engine, sub: ctx.sim !== sim } as const;
    const out: Partial<Record<OverlayKind, string>> = {};
    for (const k of OVERLAY_KINDS) {
      const why = overlayRefusal(k, c);
      if (why) out[k] = why;
    }
    return out;
  }

  /**
   * Turn an overlay on (null: off). It stays on across levels and scenes until turned off, and is never on at a page
   * load (settings.overlay only remembers where O starts). `model`: the delay model Slack uses (the Timing panel's).
   */
  setOverlay(kind: OverlayKind | null, model?: DelayModel): void {
    if (model) this.ovModel = model;
    if (kind && this.ovRefusals()[kind]) kind = null;
    if ((kind === 'activity' || kind === 'energy') && kind !== this.ovKind) this.ovWin = null;
    this.ovKind = kind;
    if (kind && settings.overlay !== kind) settings.set('overlay', kind);
    this.paintOverlay();
    this.ovListeners.forEach((f) => f());
  }

  /** Tint the current view's instances by slack (sim/slack.ts slackHeat; null clears): the Slack overlay. */
  heat(map: Map<string, { band: number; tip: string }> | null): void {
    this.view.heat(map);
  }

  /**
   * The legend goes in the first corner where it covers no panel, challenge note or Why? card: bottom right (clear of
   * the right-docked panels), bottom left, top left under the level badge, top right. None free: the same corners with
   * the legend compact (its note left to the tooltip), then down to its title line, then the corner where it covers the least. On a phone app.css
   * lays it across the bottom.
   */
  private placeLegend(): void {
    const L = this.ovLegend;
    if (!L) return;
    L.style.cssText = '';
    L.classList.remove('compact', 'mini');
    if (window.matchMedia('(max-width: 760px)').matches) return;
    const c = this.canvas.getBoundingClientRect();
    const blocks = [...this.panels.map((p) => p.el), this.why.el, ...this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')]
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const spots = ['', 'left:12px;right:auto', 'left:12px;right:auto;top:44px;bottom:auto', 'top:44px;bottom:auto'];
    let best = { css: '', size: '', cost: Infinity };
    for (const size of ['', 'compact', 'mini']) {
      L.classList.remove('compact', 'mini');
      if (size) L.classList.add(size);
      for (const css of spots) {
        L.style.cssText = css;
        const r = L.getBoundingClientRect();
        const out = Math.max(0, c.left - r.left) + Math.max(0, r.right - c.right) + Math.max(0, c.top - r.top) + Math.max(0, r.bottom - c.bottom);
        let cost = out * 1e4;
        for (const b of blocks) cost += Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)) * Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
        if (cost === 0) return;
        if (cost < best.cost) best = { css, size, cost };
      }
    }
    L.classList.remove('compact', 'mini');
    if (best.size) L.classList.add(best.size);
    L.style.cssText = best.css;
  }

  /** Live overlays (Activity, Unknown) follow the simulation, at most every 100 ms; a level redrawn without its marks gets them back. */
  private tickOverlay(): void {
    if (!this.ovKind) return;
    const live = this.ovKind === 'activity' || this.ovKind === 'energy';
    if (live) this.countActivity();
    const stale = !this.view.el.classList.contains('ov');
    if (!stale && !live && this.ovKind !== 'unknown') return;
    const wait = 100 - (performance.now() - this.ovLast);
    if (stale || wait <= 0) return this.paintOverlay();
    if (!this.ovTimer) this.ovTimer = window.setTimeout(() => { this.ovTimer = 0; this.paintOverlay(); }, wait);
  }

  /** Activity's window: toggles since the overlay came on, over the clock cycles or input changes since. */
  private countActivity(): { units: number; clocked: boolean } | null {
    const sim = this.sim;
    if (!(sim instanceof GateSim)) return null;
    const ins = this.scene?.root.ports.filter((p) => p.dir === 'in') ?? [];
    const sig = ins.map((p) => sim.getInputBits(p.name).join('')).join('|');
    if (!this.ovWin || this.ovWin.sim !== sim) {
      if (!sim.toggles) sim.countToggles();
      this.ovWin = { sim, base: new Uint32Array(sim.toggles!), cycles: this.cycles, changes: 0, sig };
    } else if (sig !== this.ovWin.sig) {
      this.ovWin.sig = sig;
      this.ovWin.changes++;
    }
    const clocked = !!this.clockPort();
    return { units: clocked ? this.cycles - this.ovWin.cycles : this.ovWin.changes, clocked };
  }

  /** Compute the overlay for the level on screen and draw it with its legend (static ones are cached per level). */
  private paintOverlay(): void {
    if (this.ovTimer) { clearTimeout(this.ovTimer); this.ovTimer = 0; }
    this.ovLast = performance.now();
    const ctx = this.ctx, sim = this.sim, kind = this.ovKind;
    this.ovBar.set(kind, this.ovRefusals());
    let r: OverlayResult | null = null;
    if (kind && ctx && sim && !this.boardOn && !this.leaf && !this.ovRefusals()[kind]) {
      const design = ctx.sim.design, key = `${kind}|${this.ovModel ?? (settings.loadDelay ? 'load' : 'unit')}|${ctx.path.join('.')}`;
      if (kind === 'slack' || kind === 'load' || kind === 'cost' || kind === 'depth') {
        const hit = this.ovCache.get(key);
        if (hit && hit.design === design) r = hit.r;
        else {
          const model = this.ovModel ?? (settings.loadDelay ? 'load' : 'unit');
          r = kind === 'slack' ? slackOverlay(design, ctx.path, model) : kind === 'depth' ? depthOverlay(design, ctx.node, model)
            : kind === 'cost' ? costOverlay(ctx.node, ctx.sim.kind) : loadOverlay(design, ctx.node);
          this.ovCache.set(key, { design, r });
        }
      } else if (kind === 'unknown') r = unknownOverlay(ctx.sim, ctx.node);
      else {
        const w = this.countActivity();
        if (w && this.ovWin) r = kind === 'energy' ? energyOverlay(design, ctx.node, this.ovWin.sim.toggles!, this.ovWin.base, w.units, w.clocked)
          : activityOverlay(ctx.node, this.ovWin.sim.toggles!, this.ovWin.base, w.units, w.clocked);
      }
    }
    this.view.overlay(r);
    const old = this.ovLegend;
    this.ovLegend = r ? overlayLegend(r, () => this.setOverlay(null)) : null;
    if (old && this.ovLegend) old.replaceWith(this.ovLegend);
    else if (old) old.remove();
    else if (this.ovLegend) this.canvas.append(this.ovLegend);
    this.placeLegend();
    this.ovRO?.disconnect();
    if (this.ovLegend) {
      this.ovRO ??= new ResizeObserver(() => {
        if (!this.ovRaf) this.ovRaf = requestAnimationFrame(() => { this.ovRaf = 0; this.placeLegend(); });
      });
      for (const el of [...this.panels.map((p) => p.el), this.why.el, ...this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')]) this.ovRO.observe(el);
    }
    // the legend came or went: a fitted circuit moves clear of it
    if (!!old !== !!this.ovLegend) this.view.setCover(this.covers(), true);
  }

  /** Draw instances of the current view as removed (a tour's "before"); [] restores them. */
  ghost(names: string[]): void {
    this.view.ghost(names);
  }

  /** The screen rectangle around instances of the current view (null: none drawn). */
  instRect(names: string[]): DOMRect | null {
    return this.view.instRect(names);
  }

  /** Put an element over the canvas (a tour's caption), or take it away. */
  overlay(el: HTMLElement, on = true): void {
    if (on) this.canvas.append(el);
    else el.remove();
  }

  /** The canvas's screen rectangle. */
  get canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  /** How many steps Back can undo now: a tour notes it before each beat and backs up to it. */
  get historyDepth(): number {
    return this.history.length;
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
   * With `data-fold="narrow"` a panel may start folded (autoFold; `data-keep="open"`: the step's text is about it, so it
   * starts open unless the stage has no room beside it at all; `"folded"`: another panel is the step's, this one waits), unless the learner already folded or unfolded
   * one on that side by hand (foldChoice, kept for the page's life).
   */
  private foldable(el: HTMLElement): void {
    const title = el.querySelector(':scope > h4');
    title?.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      if (el.dataset.fold) foldChoice.set(el.dataset.dock ?? '', el.classList.contains('collapsed'));
    });
  }

  /**
   * The inspector starts folded to a rail beside a circuit too large to read: one whose block labels would render under
   * MIN_TEXT_PX at the fit with the inspector open (view/legible.ts: its names would be fixed-size stand-ins, all else
   * hidden). Decided once per scene, from an open inspector; the learner's own fold or unfold (inspectorChoice) always
   * wins and is applied to every scene. Waits where nothing is laid out yet or the inspector is not a column
   * (full-width panes, a phone), and for the boards. The room it frees lets the scene's panels be chosen again.
   */
  /**
   * autoInspector's decision guessed before the build, so a big scene (built in slices, drawn up to a second later) does
   * not move the prose and the stage when it appears: the level that will be drawn, framed from its parts' boxes and pins
   * alone (no flatten, no routing), in the canvas with the inspector open. Made at the first layout after load() (on a
   * first visit the page is not in the document yet), before anything paints. The scene's panels are not made yet and
   * they only shrink the circuit, so they are left out, which can only guess "open" where the draw then folds (the late
   * fold of before), never the other way. autoInspector still decides at the draw, unfolding and folding within one task:
   * nothing paints in between, so a right guess moves nothing.
   */
  private guessInspector(): void {
    const g = this.inspGuess;
    if (!g) return;
    const insp = this.inspector, { scene, at } = g;
    if (inspectorChoice() !== null || (scene.breadboard && boardChoice) || (this.scene && !this.view.fitted)) { this.inspGuess = null; this.revealInspector(); return; }
    let def: ComponentDef | undefined = scene.root;
    for (const name of at ?? scene.path ?? []) def = def && netlistOf(def)?.instances.find((i) => i.name === name)?.def;
    const nl = def && netlistOf(def);
    if (!def || !nl) { this.inspGuess = null; this.revealInspector(); return; }
    const was = insp.folded;
    if (was) insp.setFolded(false, true);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    // not laid out yet, or the inspector is not a column here (a phone's drawer, full-width panes): the next layout
    if (W <= 0 || H <= 0 || insp.el.offsetWidth <= 0) {
      if (was) insp.setFolded(true, true);
      if (W > 0) this.revealInspector(); // laid out, but no column to fold: a drawer
      return;
    }
    this.inspGuess = null;
    this.revealInspector();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number, w: number, h: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
    for (const { r } of symbolRects(nl)) grow(r.x, r.y, r.w, r.h);
    for (const p of pinGeoms(def, nl).values()) grow(p.pos[0] - 3, p.pos[1] - 1, 6, 2);
    if (!Number.isFinite(x0)) { if (was) insp.setFolded(true, true); return; }
    // the margins schematic.ts frames with
    const m = 3, vb = fitBox({ x: x0 - m, y: y0 - m - 1, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m + 1 }, W, H);
    const px = W / vb.w;
    insp.setFolded(px > 0 && px * LABEL_UNITS < MIN_TEXT_PX, true);
  }

  private autoInspector(): void {
    if (!this.inspPending) return;
    const insp = this.inspector, choice = inspectorChoice();
    if (choice !== null) {
      this.inspPending = false;
      if (insp.folded !== choice) insp.setFolded(choice, false);
      return;
    }
    if (this.boardOn || this.canvas.clientWidth <= 0) return;
    if (!this.view.fitted) { this.inspPending = false; return; } // the learner zoomed or panned first
    if (insp.folded) insp.setFolded(false, true); // a scene that folded it by itself: today's layout, then measure
    if (insp.el.offsetWidth <= 0) return;
    this.inspPending = false;
    // a panel the step's text is about (data-keep="open") gets the room first: the inspector folds to its rail (a click opens it)
    if (this.panels.some((p) => p.el.dataset.keep === 'open' && p.el.dataset.dock === 'right')) {
      insp.setFolded(true, true);
      this.foldPending = true;
      this.autoFold();
      this.inset = this.rightInset();
      this.view.fit();
      return;
    }
    this.view.fit();
    const s = this.view.pxPerUnit();
    if (!(s > 0 && s * LABEL_UNITS < MIN_TEXT_PX)) return;
    insp.setFolded(true, true);
    this.foldPending = true;
    this.autoFold();
    this.inset = this.rightInset();
    this.view.fit();
  }

  /**
   * A level below the top is shown and an open foldable panel grew since the folds were decided (the Out of order panel fills
   * its table as the core runs: decided at load with it a third as tall): decide again, folding only (a panel never reopens by
   * itself, so nothing flaps). The top level keeps today's behaviour: its panels were sized for it.
   */
  private growFold(): void {
    if (!this.ctx || this.ctx === this.rootCtx || !this.view.fitted || this.foldPending) return;
    const grown = this.panels.some((p) => p.el.dataset.fold === 'narrow' && !p.el.classList.contains('collapsed') && p.el.offsetHeight > (this.foldHeights.get(p.el) ?? Infinity) + 24);
    if (grown) this.refold(true);
  }

  /** Decide the folds again (a drill: the level now shown has its own shape), and fit a fitted view to what is left. */
  private refold(onlyMore = false): void {
    if (!this.view.fitted) return;
    this.foldPending = true;
    this.autoFold(onlyMore);
    this.inset = this.rightInset();
    this.layoutDock(false);
    this.view.cover = this.covers();
    this.view.fit();
  }

  /** Decide, once the canvas and the scene's panels have a size, which foldable panels start folded: as many
   *  open as leave the circuit at least KEEP_SCALE of its size with them all folded (chooseFolds), and none on the
   *  right leaving it less than FOLD_BESIDE_PX (a laptop between the side panes, a phone). Each choice is laid out
   *  and measured (a bottom-left panel's shape follows the room beside the right dock). */
  private autoFold(onlyMore = false): void {
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
      return lay && mask !== all && s < (lay.readPx ?? BB_READ_PX) ? null : s;
    };
    const shut = fold.map((p) => p.el.classList.contains('collapsed'));
    const mine = (keep: boolean) => fold.map((p, i) => (onlyMore && shut[i] ? true : null) ?? foldChoice.get(p.el.dataset.dock ?? '') ?? (keep && p.el.dataset.keep === 'open' ? false : keep && p.el.dataset.keep === 'folded' ? true : null));
    // a level below the top (opened, or linked to): the panels may cost it less (KEEP_SCALE_OPENED)
    const keep = this.ctx && this.ctx !== this.rootCtx ? KEEP_SCALE_OPENED : KEEP_SCALE;
    let pick = chooseFolds(fold.length, scaleOf, mine(true), keep);
    // data-keep is a preference: where no layout with those panels open is allowed (a phone), the usual rules decide
    // ... and where they would leave the circuit under KEEP_SCALE of its size with every panel folded (three panels over a
    // pipeline left ~230 px of it): the usual rule decides, a panel the step's text is about included
    const kept = scaleOf(pick);
    if (kept === null || (fold.length > 2 && kept < keep * (scaleOf(all) ?? 0))) pick = chooseFolds(fold.length, scaleOf, mine(false), keep);
    apply(pick);
    for (const p of fold) if (!p.el.classList.contains('collapsed')) this.foldHeights.set(p.el, p.el.offsetHeight);
  }

  /** A panel changed size (folded, unfolded, grew): make room for it, refitting a still-fitted view when the
   *  right dock's width changed or a panel now covers part of the circuit. */
  private zoomReadable(): void {
    this.readZoom = true;
    this.view.zoomReadable();
    this.placeHint();
  }

  /** Show Zoom to readable only while the schematic's overview is drawn too small to read; the bar refits when it comes or goes. */
  private syncReadable(): void {
    if (!this.view || !this.readBtn) return;
    // the learner is back at the overview (Fit, a new level or scene): the hint line may return
    if (this.readZoom && this.view.fitted) { this.readZoom = false; this.placeHint(); }
    const on = showReadable({ px: this.view.pxPerUnit(), boards: this.boardOn, leaf: !!this.leaf, widget: this.el.classList.contains('widget-mode') });
    if (this.readBtn.hidden !== on) return;
    this.readBtn.hidden = !on;
    this.fitBar();
  }

  /** The lock on the bar shows settings.moveParts: pressed (and "Locked") when a drag on a part pans. */
  private syncLock(): void {
    const b = this.lockBtn, locked = !settings.moveParts;
    b.classList.toggle('on', locked);
    b.setAttribute('aria-pressed', String(locked));
    b.setAttribute('aria-label', 'Lock the layout');
    b.title = locked ? 'Layout locked: a drag on a part pans and nothing moves. Click to move parts and wires by dragging (also in View options)'
      : 'Parts and wires move when dragged. Click to lock the layout: a drag then pans (also in View options)';
    b.replaceChildren(icon(locked ? 'lock' : 'unlock', 15), h('span', { class: 'lbl' }, locked ? 'Locked' : 'Lock'));
  }

  /**
   * The layout pill over the canvas: the level shows the learner's arrangement (what it changed, the chapter's drawing on
   * request, a reset), or a redraw of the level set one aside (bring it back or let it go). Hidden otherwise.
   */
  private syncLayoutPill(): void {
    const p = this.layoutPill, v = this.view, id = this.ctx?.def.id;
    const lay = id ? layoutOf(id) : undefined;
    const act = (label: string, title: string, a: Parameters<SchematicView['layoutAction']>[0]) =>
      h('button', { type: 'button', class: 'btn sm ghost', title, onclick: () => v.layoutAction(a) }, label);
    p.replaceChildren();
    p.classList.remove('warn');
    if (!id || this.leaf) {
      // nothing
    } else if (asideOf(id)) {
      p.classList.add('warn');
      p.append(h('span', { class: 'lp-text' }, 'Redrawn since you arranged it: the new drawing'),
        act('Bring mine back', 'Your arrangement of the earlier drawing, over this one (Ctrl+Z undoes it)', 'restore'),
        act('Dismiss', 'Keep the new drawing and forget your earlier arrangement', 'dismiss'));
    } else if (v.original) {
      p.append(h('span', { class: 'lp-text' }, 'The chapter’s drawing'), act('Back to mine', 'Your arrangement of this level again', 'mine'));
    } else if (arranged(lay)) {
      const c = arrangedCount(lay);
      const what = [c.parts && `${c.parts} part${c.parts > 1 ? 's' : ''} moved`, c.wires && `${c.wires} wire${c.wires > 1 ? 's' : ''} reshaped`,
        c.pointers && `${c.pointers} pointer${c.pointers > 1 ? 's' : ''} changed`].filter(Boolean).join(', ');
      p.append(h('span', { class: 'lp-text' }, icon('move', 13), `Your layout: ${what}`),
        act('Original', 'Show the chapter’s drawing of this level (yours stays saved)', 'original'),
        act('Reset', 'This level as the chapter drew it; your colours stay (Ctrl+Z undoes it)', 'reset'));
    }
    p.hidden = !p.childElementCount;
  }

  /** The LEVEL tag gives way to a panel (a folded right-docked strip too) that would sit over it: half a tag is worse than none.
   *  Where a panel and the tag meet depends on the stage's width, so it is measured, not a media query. */
  private yieldBadge(): void {
    const b = this.levelBadge;
    b.classList.remove('yield');
    const r = b.getBoundingClientRect();
    if (!(r.width > 0)) return;
    const hit = this.panels.some((p) => { const q = p.el.getBoundingClientRect(); return q.width > 0 && q.height > 0 && q.left < r.right + 6 && q.right > r.left - 6 && q.top < r.bottom + 4 && q.bottom > r.top - 4; });
    b.classList.toggle('yield', hit);
  }

  private syncCover(): void {
    this.autoFold();
    const inset = this.rightInset();
    const notes = [...this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')].map((n) => n.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => Math.round(r.width) + 'x' + Math.round(r.bottom)).join();
    const refit = inset !== this.inset || notes !== this.notesKey;
    this.inset = inset;
    this.notesKey = notes;
    // the challenge note keeps clear of the right-docked panels, folded ones too (app.css .stage-notes)
    const covered = this.panels.filter((p) => p.el.dataset.dock === 'right').map((p) => p.el.offsetWidth).filter((w) => w > 0);
    this.canvas.style.setProperty('--panel-inset', `${covered.length ? Math.max(...covered) + 24 : 0}px`);
    this.clearNotesOfPanels();
    this.yieldBadge();
    this.placeWhy();
    this.placeLegend();
    this.boardCover();
    this.drillLayout();
    this.dockOut();
    this.placeHint();
    this.view.setCover(this.covers(), refit);
  }

  /** A challenge note drawn at the canvas's top left (app.css .stage-notes with a right-docked panel) must not sit on a
   *  left-docked panel that starts at the top (a size picker): it moves right of the panel (--note-left). Where that
   *  leaves it no room before the right dock (a tall left panel beside the CPU panel squashed it to two words), it stays
   *  at the left and the left dock starts below it instead. */
  private clearNotesOfPanels(): void {
    this.dock.style.removeProperty('top');
    const notes = this.canvas.querySelector<HTMLElement>(':scope > .stage-notes');
    if (!notes) return;
    notes.style.removeProperty('--note-left');
    if (getComputedStyle(notes).left === 'auto') return; // top right: clear of the left panels already
    const c = this.canvas.getBoundingClientRect();
    let left = 0, bottom = 0;
    for (const n of notes.children) {
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      bottom = Math.max(bottom, r.bottom - c.top);
      for (const p of this.panels) {
        if (p.el.dataset.dock === 'right') continue;
        const q = p.el.getBoundingClientRect();
        if (q.width > 0 && q.height > 0 && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom) left = Math.max(left, q.right - c.left + 12);
      }
    }
    if (!left) return;
    if (c.width - left - this.panelInset() >= NOTE_ROOM) notes.style.setProperty('--note-left', `${left}px`);
    else this.dock.style.top = `${bottom + 8}px`;
  }

  /** --panel-inset: what the right-docked panels take from the canvas's right edge (syncCover). */
  private panelInset(): number {
    return parseFloat(this.canvas.style.getPropertyValue('--panel-inset')) || 0;
  }

  /** The Why? card (top left) must not sit on a challenge note drawn there (a right-docked panel sends the note left)
   *  or on a left-docked panel that starts at the top: it moves right of such a panel (--why-left), then below the
   *  notes it would still cover (--why-top). With no room right of the panel it stays over it (the learner opened it).
   *  Along the bottom (a phone) it is clear of both. */
  private placeWhy(): void {
    const el = this.why.el;
    el.style.removeProperty('--why-left');
    el.style.removeProperty('--why-top');
    if (!this.why.on) return;
    const c = this.canvas.getBoundingClientRect();
    const hits = (r: DOMRect, q: DOMRect) => q.width > 0 && q.height > 0 && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom;
    let r = el.getBoundingClientRect();
    if (r.top - c.top > c.height / 2) return;
    let left = 0;
    for (const p of this.panels) if (p.el.dataset.dock !== 'right' && hits(r, p.el.getBoundingClientRect())) left = Math.max(left, p.el.getBoundingClientRect().right - c.left + 12);
    if (left && c.width - left - this.panelInset() >= NOTE_ROOM) el.style.setProperty('--why-left', `${left}px`);
    r = el.getBoundingClientRect();
    let top = 0;
    // horizontally only: the card is moved down, so a note it would cover once moved counts too
    for (const n of this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')) {
      const q = n.getBoundingClientRect();
      if (q.width > 0 && q.height > 0 && r.left < q.right && q.left < r.right && q.top - c.top < c.height / 2) top = Math.max(top, q.bottom - c.top + 8);
    }
    if (top) el.style.setProperty('--why-top', `${top}px`);
  }

  /** The boards keep clear of the right-docked panels that are open; a folded one is only its title, so the boards
   *  run under it, starting below it (--bb-inset, --bb-top: breadboard.css). */
  private boardCover(): void {
    const c = this.canvas.getBoundingClientRect();
    const right = this.panels.filter((p) => p.el.dataset.dock === 'right' && p.el.offsetWidth > 0);
    const open = right.filter((p) => !p.el.classList.contains('collapsed')).map((p) => p.el.offsetWidth);
    const folded = right.filter((p) => p.el.classList.contains('collapsed')).map((p) => p.el.getBoundingClientRect().bottom - c.top);
    this.canvas.style.setProperty('--bb-inset', `${open.length ? Math.max(...open) + 24 : 0}px`);
    const capr = open.length ? [] : right.filter((p) => p.el.classList.contains('collapsed')).map((p) => p.el.offsetWidth + 12);
    const tops = open.length ? [] : folded;
    // a chapter's challenge note over the canvas's top (ui/stagenotes.ts) too; the caption stops short of one on the right
    const hr = this.board.el.getBoundingClientRect();
    for (const n of this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')) {
      const r = n.getBoundingClientRect();
      if (r.height > 0) tops.push(r.bottom - c.top);
      if (r.height > 0 && hr.width > 0 && r.left - hr.left > hr.width / 3) capr.push(hr.right - r.left + 12);
    }
    this.canvas.style.setProperty('--bb-capr', `${capr.length ? Math.max(...capr) : 0}px`);
    this.canvas.style.setProperty('--bb-top', `${tops.length ? Math.max(...tops) + 6 : 0}px`);
  }

  /** Where the scene's panels and the how-to line sit on the canvas (px from its top-left corner): what the fit
   *  keeps clear. */
  /**
   * A phone: the stage only as tall as its circuit needs. A wide circuit fitted to a 390 px width was a strip of drawing
   * in a 72vh box of empty canvas. Computed from the width alone (the fit's scale), so the resize it causes changes
   * nothing; between HUG_MIN_PX of canvas and the stage's own height. Off for a widget, the boards, a drilled level,
   * panels in the phone's flow and panels over the canvas (they need the room).
   */
  private hugPhone(): void {
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
    const covers = narrow ? this.covers() : [];
    const off = !narrow || this.el.classList.contains('widget-mode') || this.boardOn || !!this.drill
      || !!this.canvas.querySelector("[data-phone='flow']:not(.collapsed)") || covers.some((r) => r.h > HUG_COVER_PX);
    if (off) {
      if (this.el.style.height) this.el.style.height = '';
      return;
    }
    const b = this.view.contentBox(), W = this.canvas.clientWidth;
    if (!(b.w > 0 && b.h > 0 && W > 0)) return;
    const drawing = (b.h * W) / Math.max(b.w, fitMinW(34, W));
    // what the fit keeps clear (the how-to line, a challenge note) and the level badge above
    const need = Math.max(HUG_MIN_PX, drawing + covers.reduce((t, r) => t + r.h + 2 * COVER_GAP, 0) + HUG_TOP_PX);
    this.el.style.height = '';
    const full = this.el.clientHeight, canvasH = this.canvas.clientHeight;
    if (need < canvasH - 2) this.el.style.height = `${Math.round(full - canvasH + need)}px`;
    else if (need > canvasH + 2) {
      // A tall circuit (an ALU, a register file) fitted by its height uses a sliver of the width: give the canvas what the
      // screen under the top bar leaves after the stage bar and the (capped) controls band, so the circuit and its inputs
      // share one screen, no more than the circuit needs.
      const bar = this.el.querySelector<HTMLElement>(':scope > .stage-bar')?.offsetHeight ?? 57;
      const room = window.innerHeight - PHONE_TOPBAR_PX - bar - this.controls.offsetHeight - 8;
      if (room > canvasH) this.el.style.height = `${Math.round(full - canvasH + Math.min(room, need))}px`;
    }
  }

  private covers(hint = true): Rect[] {
    const c = this.canvas.getBoundingClientRect();
    const out: Rect[] = [];
    for (const el of [...this.panels.map((p) => p.el), ...(hint ? [this.hint] : []), ...(this.drill ? [this.board.el] : []), this.why.el, ...(this.ovLegend ? [this.ovLegend] : [])]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
    }
    // a chapter's challenge note (ui/stagenotes.ts) hides what it sits on: the fit keeps clear of it too
    for (const n of this.canvas.querySelectorAll<HTMLElement>(':scope > .stage-notes > *')) {
      const r = n.getBoundingClientRect();
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
    // beside the drill pane it starts right of it (breadboard.css)
    const left = this.drill && !this.el.classList.contains('bb-stacked') ? parseFloat(this.canvas.style.getPropertyValue('--bb-drill-w')) + 12 || 12 : 12;
    // Its one-line width, measured shown (a hidden element is 0 px wide).
    this.hint.hidden = false;
    this.hint.style.maxWidth = `${W - left - 12}px`;
    const natural = this.hint.offsetWidth;
    // Only the bottom panels under the line lift it. Panels well to its right (side by side in a row) leave it at
    // the bottom, wrapped short of them: it floated mid-canvas above a pipeline diagram far to its right.
    const all = [...this.dock.children].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    const beside = all.filter((r) => r.left - c.left >= left + Math.min(natural, 360) + 12);
    const docked = all.filter((r) => !beside.includes(r));
    const bottom = docked.length ? H - Math.min(...docked.map((r) => r.top - c.top)) + 6 : 10;
    // A line or two above `bottom`: the right panels reaching that low push its right edge in.
    const lineTop = H - bottom - 40;
    let right = 12;
    for (const p of this.panels) {
      if (p.el.dataset.dock !== 'right') continue;
      const r = p.el.getBoundingClientRect();
      if (r.width > 0 && r.bottom - c.top > lineTop) right = Math.max(right, c.right - r.left + 12);
    }
    for (const r of beside) if (r.top - c.top < H - bottom) right = Math.max(right, c.right - r.left + 12);
    this.hint.style.bottom = `${bottom}px`;
    this.hint.style.maxWidth = `${W - right - left}px`;
    // a drill stacked on a narrow canvas leaves the schematic a strip: the line would take a third of it
    this.hint.hidden = this.hint.dataset.off === '1' || this.readZoom || W - right - left < 160 || (docked.length > 0 && lineTop < H / 2)
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
