// User settings and progress, persisted per browser (best effort: storage may be unavailable).

import type { Radix } from '../sim/values';

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
  /** Coach-mark tours finished or skipped (ui/coachmarks.ts): "stage", "sandbox". */
  coachDone: Record<string, boolean>;
  /** Stop animations whatever the system says (the system's own preference is always honoured: ui/motion.ts). */
  reduceMotion: boolean;
  wireScale: WireScale;
  grid: GridStyle;
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
  /** chapterId → indices of visited steps */
  visited: Record<string, number[]>;
  /** The chapter step viewed last (the home page's Continue). */
  last?: { chapter: string; step: number };
  /** "chapterId:step" → solved */
  solved: Record<string, boolean>;
  /** Campaign map: optional acts unfolded (true) or folded (false) by the learner; absent: the default. */
  openActs: Record<string, boolean>;
}

const KEY = 'mosfet2riscv:v1';
const defaults: State = { theme: 'auto', palette: 'default', radix: 'hex', animate: false, modules: true, wide: false, wireFlow: true, netColors: true, vivid: true, board: true, cartoon: true, vividNets: true, looks: 1, glossary: true, simpleWires: false, autoClock: true, loadDelay: false, singleKeys: true, minimap: true, reduceMotion: false, wireScale: 'normal', grid: 'dots', coachDone: {}, textSize: 100, narrowText: false, analyzer: false, speed: 12, traceLevel: 'instr', traceRate: 2, visited: {}, solved: {}, openActs: {} };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const st: State = { ...defaults, looks: 0, ...JSON.parse(raw) };
      // Settings saved before the vivid look and cartoon parts became the default get them once; turned off since, they stay off.
      if (st.looks < 1) {
        if (!st.vivid && !st.netColors) st.vividNets = true;
        if (!st.vivid) st.netColors = true;
        st.vivid = true; st.cartoon = true; st.looks = 1;
      }
      return st;
    }
  } catch { /* private mode, blocked storage, ... */ }
  return { ...defaults };
}

/** What the View options menu holds, and so what its reset puts back: never progress, the theme or the panes. */
const VIEW_KEYS = ['palette', 'modules', 'wireFlow', 'netColors', 'vivid', 'board', 'cartoon', 'vividNets', 'glossary', 'simpleWires', 'autoClock', 'loadDelay', 'singleKeys', 'minimap', 'reduceMotion', 'wireScale', 'grid', 'textSize', 'narrowText'] as const;
export type ViewState = Pick<State, (typeof VIEW_KEYS)[number]>;

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
  get glossary() { return state.glossary; },
  get simpleWires() { return state.simpleWires; },
  get autoClock() { return state.autoClock; },
  get singleKeys() { return state.singleKeys; },
  get loadDelay() { return state.loadDelay; },
  get minimap() { return state.minimap; },
  get reduceMotion() { return state.reduceMotion; },
  get wireScale() { return state.wireScale; },
  get grid() { return state.grid; },
  get textSize() { return state.textSize; },
  get narrowText() { return state.narrowText; },
  get analyzer() { return state.analyzer; },
  get speed() { return state.speed; },
  get traceLevel() { return state.traceLevel; },
  get traceRate() { return state.traceRate; },
  set<K extends 'theme' | 'palette' | 'radix' | 'animate' | 'modules' | 'wide' | 'wireFlow' | 'netColors' | 'board' | 'cartoon' | 'glossary' | 'simpleWires' | 'autoClock' | 'loadDelay' | 'singleKeys' | 'minimap' | 'reduceMotion' | 'wireScale' | 'grid' | 'textSize' | 'narrowText' | 'analyzer' | 'speed' | 'traceLevel' | 'traceRate'>(k: K, v: State[K]): void {
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
  if (state.vivid) root.setAttribute('data-look', 'vivid');
  else root.removeAttribute('data-look');
  if (state.vivid && state.board) root.setAttribute('data-board', 'dark');
  else root.removeAttribute('data-board');
  if (state.vivid && state.cartoon) root.setAttribute('data-parts', 'cartoon');
  else root.removeAttribute('data-parts');
}
