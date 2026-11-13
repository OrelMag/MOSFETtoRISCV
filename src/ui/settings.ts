// User settings and progress, persisted per browser (best effort: storage may be unavailable).

import type { Radix } from '../sim/values';
import { moveProgress, STEP_MOVES } from '../chapters/stepmoves';
import { setLegibleOptions } from './legibleopts';

export type Theme = 'auto' | 'light' | 'dark';
/** What one slow-mode tick advances: a gate delay, a clock cycle, or a retired instruction. */
export type TraceLevel = 'gate' | 'cycle' | 'instr';
/** The prose size choices, percent. */
export const TEXT_SIZES = [90, 100, 110, 120, 130] as const;
export type Palette = 'default' | 'cb' | 'lsim' | 'contrast' | 'print';

/** Wire thickness over whatever the look draws (styles/app.css --wire-user). */
export type WireScale = 'thin' | 'normal' | 'thick';
/** The canvas's grid: points, lines, or a bare canvas. */
export type GridStyle = 'dots' | 'lines' | 'off';
/** Block names drawn at a fixed size once their own label is too small (view/legible.ts): none, 12 px, or 16 px. */
export type ZoomNames = 'off' | 'normal' | 'large';
const ZOOM_NAME_K: Record<ZoomNames, number> = { off: 0, normal: 1, large: 4 / 3 };

/** Wire palettes (colours live in styles/palettes.css). */
export const PALETTES: { id: Palette; name: string; blurb: string }[] = [
  { id: 'default', name: 'Default', blurb: 'Orange 1, grey 0, blue buses' },
  { id: 'cb', name: 'Colour-blind safe', blurb: 'Okabe–Ito: blue 1, vermillion X, green buses' },
  { id: 'lsim', name: 'Logic Sim', blurb: 'Red 1, near-black 0, bold flat wires' },
  { id: 'contrast', name: 'High contrast', blurb: 'Thick wires, strong 0/1 difference' },
  { id: 'print', name: 'Monochrome', blurb: 'No hue (reads in grey or on paper): heavy 1, thin dashed 0, dotted X' },
];

interface State {
  theme: Theme;
  palette: Palette;
  radix: Radix;
  animate: boolean;
  /** Tint library boxes by kind (arithmetic, memory, ...); off: all boxes plain. */
  modules: boolean;
  /** Chapter pages: the narrative and inspector hidden, the stage full width. */
  wide: boolean;
  /** Bits flow along the wires that carry them (off: wires are only coloured). */
  wireFlow: boolean;
  /** Every net drawn in a hue of its own (brightness still shows the value); on by default with the vivid look. */
  netColors: boolean;
  /** Vivid look (Turing Complete style, styles/vivid.css): filled bright parts, thicker wires. */
  vivid: boolean;
  /** With the vivid look: the circuit on a dark board in either theme (off: the theme's canvas). */
  board: boolean;
  /** With the vivid look: cartoon parts (shadows, gloss, category icons, rounded outlines and lettering). */
  cartoon: boolean;
  /** With cartoon parts: transistors inside gates (view/cmosdraw.ts). */
  workingGates: boolean;
  /** The vivid look switched colour per net on (so switching it off turns that off again). */
  vividNets: boolean;
  /** Defaults revision the stored settings were last brought up to (1: the vivid look and cartoon parts on). */
  looks: number;
  /** Codex terms in the chapters' prose are marked, their summary shown on hover. */
  glossary: boolean;
  /** Sandbox: new wires are simple connections, straight from point to point at any angle (off: horizontal and vertical legs). */
  simpleWires: boolean;
  /** A circuit with a clock starts running (slowly) when it is opened: sandbox chips, campaign levels, chapter scenes. */
  autoClock: boolean;
  /** Single character-key shortcuts (F, /, [, ? …) on; off: only Ctrl/⌘ combinations, Esc and the like (WCAG 2.1.4). */
  singleKeys: boolean;
  /** Timing panels and the inspector open on load-dependent delay (sim/delay.ts) instead of unit delay. */
  loadDelay: boolean;
  /** Sandbox: the minimap at the canvas corner (M); it hides itself while the whole chip is in view. */
  minimap: boolean;
  /** A drag moves parts on the stage; null: off on a touch screen. */
  moveParts: boolean | null;
  /** Zooming into a block opens its inside over it (view/lens.ts); null: the device default (off while it is new; never on a touch screen yet). */
  zoomOpen: boolean | null;
  /** View options ▸ Opened blocks without colour: a block the lens shows open (view/lens.ts inside-on) drops its module colour (lens.css). */
  lensPlain: boolean;
  /** Coach-mark tours finished or skipped (ui/coachmarks.ts): "stage", "sandbox". */
  coachDone: Record<string, boolean>;
  /** Stop animations whatever the system says (the system's own preference is always honoured: ui/motion.ts). */
  reduceMotion: boolean;
  wireScale: WireScale;
  grid: GridStyle;
  /** Text on the schematics; hidden, each still shows under the pointer where it can (app.css data-hide). */
  portNames: boolean;
  partNames: boolean;
  modelNames: boolean;
  busValues: boolean;
  tapRanges: boolean;
  /** Zoomed out: block names at a fixed readable size over their blocks, and text too small to read hidden (view/legible.ts). */
  zoomNames: ZoomNames;
  hideSmall: boolean;
  /** Prose size in the chapter pane, percent of the designed size (TEXT_SIZES); schematics never scale. */
  textSize: number;
  /** The chapter pane's text held to a comfortable line length (about 62 characters), centred where the pane is wider. */
  narrowText: boolean;
  /** Timing panel open (stays open across scenes). */
  analyzer: boolean;
  /** Gate delays per second when animating propagation. */
  speed: number;
  /** CPU slow mode: the step unit, and steps (cycles or instructions) per second. */
  traceLevel: TraceLevel;
  traceRate: number;
  /** The overlay used last (view/overlays.ts): where O starts. Never on at load. */
  overlay: string;
  /** chapterId → indices of visited steps */
  visited: Record<string, number[]>;
  /** The chapter step viewed last (the home page's Continue). */
  last?: { chapter: string; step: number };
  /** "chapterId:step" → solved */
  solved: Record<string, boolean>;
  /** Batches of chapters/stepmoves.ts already applied to the progress. */
  moved?: number;
  /** Campaign map: optional acts unfolded (true) or folded (false) by the learner; absent: the default. */
  openActs: Record<string, boolean>;
}

const KEY = 'mosfet2riscv:v1';
const defaults: State = { theme: 'auto', palette: 'default', radix: 'hex', animate: false, modules: true, wide: false, wireFlow: true, netColors: true, vivid: true, board: true, cartoon: true, workingGates: true, vividNets: true, looks: 1, glossary: true, simpleWires: false, autoClock: true, loadDelay: false, singleKeys: true, minimap: true, moveParts: null, zoomOpen: null, lensPlain: false, reduceMotion: false, wireScale: 'normal', grid: 'dots', portNames: true, partNames: true, modelNames: true, busValues: true, tapRanges: true, zoomNames: 'normal', hideSmall: true, coachDone: {}, textSize: 100, narrowText: false, analyzer: false, speed: 12, traceLevel: 'instr', traceRate: 2, overlay: 'slack', visited: {}, solved: {}, openActs: {} };

/**
 * The stored fields that have the right shape, the rest left out (so they take their defaults): a damaged or hand-edited
 * blob (a backup file) must never stop every page from loading. Records lose only their bad entries.
 */
function coerce(raw: unknown): Partial<State> {
  if (typeof raw != 'object' || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>, out: Record<string, unknown> = {};
  const isRec = (v: unknown): v is Record<string, unknown> => typeof v == 'object' && v !== null && !Array.isArray(v);
  const rec = <T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> | undefined =>
    isRec(v) ? Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== '__proto__' && ok(x))) as Record<string, T> : undefined;
  const bool = (x: unknown): x is boolean => typeof x == 'boolean';
  const steps = (x: unknown): x is unknown[] => Array.isArray(x);
  const ONE_OF: Partial<Record<keyof State, readonly unknown[]>> = {
    theme: ['auto', 'light', 'dark'], palette: PALETTES.map((p) => p.id), radix: ['hex', 'bin', 'dec', 'sdec'], wireScale: ['thin', 'normal', 'thick'],
    grid: ['dots', 'lines', 'off'], zoomNames: ['off', 'normal', 'large'], traceLevel: ['gate', 'cycle', 'instr'], textSize: TEXT_SIZES,
  };
  for (const [k, d] of Object.entries(defaults) as [keyof State, unknown][]) {
    const v = r[k], one = ONE_OF[k];
    if (v === undefined) continue;
    if (one) { if (one.includes(v)) out[k] = v; }
    else if (k === 'visited') {
      const vs = rec(v, steps);
      if (vs) out[k] = Object.fromEntries(Object.entries(vs).map(([c, s]) => [c, s.filter((i): i is number => Number.isInteger(i) && (i as number) >= 0)]));
    } else if (k === 'solved' || k === 'coachDone' || k === 'openActs') { const b = rec(v, bool); if (b) out[k] = b; }
    else if (d === null) { if (v === null || typeof v == 'boolean') out[k] = v; }
    else if (typeof d == 'number') { if (typeof v == 'number' && Number.isFinite(v) && (k === 'looks' || v > 0)) out[k] = v; }
    else if (typeof v == typeof d) out[k] = v;
  }
  if (Number.isInteger(r.moved) && (r.moved as number) >= 0) out.moved = r.moved;
  const last = r.last;
  if (isRec(last) && typeof last.chapter == 'string' && Number.isInteger(last.step) && (last.step as number) >= 0) out.last = { chapter: last.chapter, step: last.step as number };
  return out as Partial<State>;
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      let parsed: unknown;
      // Text that is not JSON is kept aside before the next save writes the defaults over it (as the sandbox keeps its own).
      try { parsed = JSON.parse(raw); } catch { localStorage.setItem(KEY + ':unreadable', raw); throw new Error('unreadable settings'); }
      const st: State = { ...defaults, looks: 0, ...coerce(parsed) };
      // Settings saved before the vivid look and cartoon parts became the default get them once; turned off since, they stay off.
      if (st.looks < 1) {
        if (!st.vivid && !st.netColors) st.vividNets = true;
        if (!st.vivid) st.netColors = true;
        st.vivid = true; st.cartoon = true; st.looks = 1;
      }
      return moveProgress(st);
    }
  } catch { /* private mode, blocked storage, ... */ }
  return { ...defaults, moved: STEP_MOVES.length };
}

/** What the View options menu holds, and so what its reset puts back: never progress, the theme or the panes. */
/** A touch screen (the coarse pointer): the lens is not built for it yet (view/lens.ts). */
export const coarsePointer = (): boolean => typeof matchMedia == 'function' && matchMedia('(pointer: coarse)').matches;

const VIEW_KEYS = ['palette', 'modules', 'wireFlow', 'netColors', 'vivid', 'board', 'cartoon', 'workingGates', 'vividNets', 'glossary', 'simpleWires', 'autoClock', 'loadDelay', 'singleKeys', 'minimap', 'moveParts', 'zoomOpen', 'lensPlain', 'reduceMotion', 'wireScale', 'grid', 'portNames', 'partNames', 'modelNames', 'busValues', 'tapRanges', 'zoomNames', 'hideSmall', 'textSize', 'narrowText'] as const;
export type ViewState = Pick<State, (typeof VIEW_KEYS)[number]>;

/** What a preset decides: how the circuits look and how large the prose reads, never how the site behaves (shortcuts, new wires, the clock). */
const LOOK_KEYS = ['palette', 'modules', 'wireFlow', 'netColors', 'vivid', 'board', 'cartoon', 'workingGates', 'reduceMotion', 'wireScale', 'grid', 'portNames', 'partNames', 'busValues', 'tapRanges', 'zoomNames', 'hideSmall', 'textSize'] as const;
type LookKey = (typeof LOOK_KEYS)[number];
export type PresetId = 'standard' | 'classroom' | 'print' | 'plain';

/** Each preset names only what differs from the defaults. */
export const PRESETS: { id: PresetId; name: string; blurb: string; theme?: Theme; look: Partial<Pick<State, LookKey>> }[] = [
  { id: 'standard', name: 'Standard', blurb: 'The look the site ships with', look: {} },
  { id: 'classroom', name: 'Classroom', blurb: 'For a projector: high contrast, thick wires, larger text, no motion', look: { palette: 'contrast', cartoon: false, wireFlow: false, reduceMotion: true, wireScale: 'thick', zoomNames: 'large', textSize: 120 } },
  { id: 'print', name: 'Paper', blurb: 'Light and monochrome, for screenshots that will be printed: no colour fills, no grid, no motion', theme: 'light', look: { palette: 'print', vivid: false, board: false, cartoon: false, modules: false, netColors: false, wireFlow: false, reduceMotion: true, grid: 'off' } },
  { id: 'plain', name: 'Plain', blurb: 'A textbook schematic: outlined parts, one wire colour, nothing moving along the wires', look: { vivid: false, board: false, cartoon: false, modules: false, netColors: false, wireFlow: false } },
];

const pickView = (from: State): ViewState => Object.fromEntries(VIEW_KEYS.map((k) => [k, from[k]])) as unknown as ViewState;

const state = load();
const listeners = new Set<() => void>();

/** Progress exists: ask the browser to keep the data (ui/persist.ts; once per load, after the page has settled). */
let kept = false;
function progressMade(): void {
  if (kept) return;
  kept = true;
  setTimeout(() => { void import('./persist').then((m) => m.keepProgress()); }, 3000);
}
if (Object.keys(state.visited).length) progressMade();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export const settings = {
  get theme() { return state.theme; },
  get palette() { return state.palette; },
  get radix() { return state.radix; },
  get animate() { return state.animate; },
  get modules() { return state.modules; },
  get wide() { return state.wide; },
  get wireFlow() { return state.wireFlow; },
  get netColors() { return state.netColors; },
  get vivid() { return state.vivid; },
  get board() { return state.board; },
  get cartoon() { return state.cartoon; },
  get workingGates() { return state.workingGates; },
  get glossary() { return state.glossary; },
  get simpleWires() { return state.simpleWires; },
  get autoClock() { return state.autoClock; },
  get singleKeys() { return state.singleKeys; },
  get loadDelay() { return state.loadDelay; },
  get minimap() { return state.minimap; },
  get moveParts(): boolean { return state.moveParts ?? !(typeof matchMedia == 'function' && matchMedia('(pointer: coarse)').matches); },
  /** Open blocks as you zoom: off by default while it is new. Null stays off on a touch screen when phase 3 turns it on with a mouse (DESIGN.md item 6). */
  get zoomOpen(): boolean { return state.zoomOpen ?? false; },
  /** Strictly true: the saved value is merged without per-key checks (load), so anything else reads as off. */
  get lensPlain(): boolean { return state.lensPlain === true; },
  get reduceMotion() { return state.reduceMotion; },
  get wireScale() { return state.wireScale; },
  get grid() { return state.grid; },
  get portNames() { return state.portNames; },
  get partNames() { return state.partNames; },
  get modelNames() { return state.modelNames; },
  get busValues() { return state.busValues; },
  get tapRanges() { return state.tapRanges; },
  get zoomNames() { return state.zoomNames; },
  get hideSmall() { return state.hideSmall; },
  get textSize() { return state.textSize; },
  get narrowText() { return state.narrowText; },
  get analyzer() { return state.analyzer; },
  get speed() { return state.speed; },
  get traceLevel() { return state.traceLevel; },
  get overlay() { return state.overlay; },
  get traceRate() { return state.traceRate; },
  set<K extends 'theme' | 'palette' | 'radix' | 'animate' | 'modules' | 'wide' | 'wireFlow' | 'netColors' | 'board' | 'cartoon' | 'workingGates' | 'glossary' | 'simpleWires' | 'autoClock' | 'loadDelay' | 'singleKeys' | 'minimap' | 'moveParts' | 'zoomOpen' | 'lensPlain' | 'reduceMotion' | 'wireScale' | 'grid' | 'portNames' | 'partNames' | 'modelNames' | 'busValues' | 'tapRanges' | 'zoomNames' | 'hideSmall' | 'textSize' | 'narrowText' | 'analyzer' | 'speed' | 'traceLevel' | 'traceRate' | 'overlay'>(k: K, v: State[K]): void {
    state[k] = v;
    // Colour per net set by hand: the vivid look no longer owns it.
    if (k === 'netColors') state.vividNets = false;
    save();
    listeners.forEach((f) => f());
  },
  /** The vivid look on or off; on, it turns colour per net on too, and off again when it goes (unless set since). */
  setVivid(on: boolean): void {
    if (on === state.vivid) return;
    state.vivid = on;
    if (on && !state.netColors) { state.netColors = true; state.vividNets = true; }
    else if (!on && state.vividNets) state.netColors = false;
    if (!on) state.vividNets = false;
    save();
    listeners.forEach((f) => f());
  },
  /** The menu's options as they are now, to give back to setView. */
  view(): ViewState {
    return pickView(state);
  },
  /** Several options at once: one save, one notification. */
  setView(v: Partial<ViewState>): void {
    Object.assign(state, v);
    save();
    listeners.forEach((f) => f());
  },
  /** A preset: the look decided, the behaviour options left alone (the theme too unless it names one). */
  applyPreset(id: PresetId): void {
    const p = PRESETS.find((x) => x.id === id)!;
    const look = Object.fromEntries(LOOK_KEYS.map((k) => [k, p.look[k] ?? defaults[k]])) as Pick<State, LookKey>;
    if (p.theme) state.theme = p.theme;
    this.setView({ ...look, vividNets: look.vivid && look.netColors });
  },
  /** The preset the look matches now (null: changed by hand). A preset naming a theme asks for it too. */
  preset(): PresetId | null {
    const on = PRESETS.find((p) => (!p.theme || p.theme === state.theme) && LOOK_KEYS.every((k) => state[k] === (p.look[k] ?? defaults[k])));
    return on?.id ?? null;
  },
  /** Every option in the menu back to its default; progress and the theme stay. */
  resetView(): void {
    this.setView(pickView(defaults));
  },
  onChange(f: () => void): () => void {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  visit(chapter: string, step: number): void {
    const v = (state.visited[chapter] ??= []);
    const moved = state.last?.chapter !== chapter || state.last.step !== step;
    if (moved) state.last = { chapter, step };
    if (!v.includes(step)) v.push(step);
    else if (!moved) return;
    save();
    progressMade();
  },
  /** The chapter step viewed last, if any. */
  lastStep(): { chapter: string; step: number } | undefined {
    return state.last;
  },
  visited(chapter: string): number[] {
    return state.visited[chapter] ?? [];
  },
  solve(key: string): void {
    state.solved[key] = true;
    save();
    progressMade();
  },
  isSolved(key: string): boolean {
    return !!state.solved[key];
  },
  /** Has the learner finished or skipped the coach-mark tour `id`? */
  coachDone(id: string): boolean {
    return !!state.coachDone[id];
  },
  setCoachDone(id: string, done = true): void {
    if (done) state.coachDone[id] = true;
    else delete state.coachDone[id];
    save();
  },
  /** An optional campaign act as the learner left it: open, folded, or never set (undefined). */
  actOpen(act: number): boolean | undefined {
    return state.openActs[act];
  },
  setActOpen(act: number, open: boolean): void {
    state.openActs[act] = open;
    save();
  },
  resetProgress(): void {
    state.visited = {};
    state.solved = {};
    delete state.last;
    save();
    // The campaign and the puzzles keep their own keys (campaign/progress.ts CAMPAIGN_KEY, puzzles/grade.ts PUZZLES_KEY).
    try {
      localStorage.removeItem('mosfet2riscv:campaign:v1');
      localStorage.removeItem('mosfet2riscv:sandbox:puzzles');
    } catch { /* ignore */ }
    listeners.forEach((f) => f());
  },
};

export function applyTheme(): void {
  // the schematics' zoomed-out names and small text (view/legible.ts): not attributes, the plan is computed per view
  setLegibleOptions({ names: ZOOM_NAME_K[state.zoomNames] ?? 1, hideSmall: state.hideSmall !== false });
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  if (state.palette === 'default') root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', state.palette);
  if (state.modules) root.removeAttribute('data-modules');
  else root.setAttribute('data-modules', 'plain');
  root.toggleAttribute('data-wide', state.wide);
  if (state.wireFlow) root.removeAttribute('data-wireflow');
  else root.setAttribute('data-wireflow', 'off');
  if (state.netColors) root.setAttribute('data-netcolors', 'on');
  else root.removeAttribute('data-netcolors');
  // Prose only: app.css applies these to the chapter pane's text (zoom), never to a drawn circuit.
  const size = TEXT_SIZES.includes(state.textSize as 100) ? state.textSize : 100;
  if (size === 100) root.style.removeProperty('--prose-scale');
  else root.style.setProperty('--prose-scale', String(size / 100));
  root.toggleAttribute('data-narrow-text', state.narrowText);
  root.toggleAttribute('data-reduce-motion', state.reduceMotion);
  if (state.wireScale === 'normal') root.removeAttribute('data-wires');
  else root.setAttribute('data-wires', state.wireScale);
  if (state.grid === 'dots') root.removeAttribute('data-grid');
  else root.setAttribute('data-grid', state.grid);
  const hide = [!state.portNames && 'ports', !state.partNames && 'parts', !state.busValues && 'values', !state.tapRanges && 'taps'].filter(Boolean);
  if (hide.length) root.setAttribute('data-hide', hide.join(' '));
  else root.removeAttribute('data-hide');
  if (state.vivid) root.setAttribute('data-look', 'vivid');
  else root.removeAttribute('data-look');
  if (state.vivid && state.board) root.setAttribute('data-board', 'dark');
  else root.removeAttribute('data-board');
  if (state.vivid && state.cartoon) root.setAttribute('data-parts', 'cartoon');
  else root.removeAttribute('data-parts');
  if (state.vivid && state.cartoon && state.workingGates) root.setAttribute('data-gates', 'cmos');
  else root.removeAttribute('data-gates');
  // lens.css: only a box carrying inside-on reacts, so with the lens off this matches nothing
  if (state.lensPlain === true) root.setAttribute('data-lens-fill', 'plain');
  else root.removeAttribute('data-lens-fill');
}
