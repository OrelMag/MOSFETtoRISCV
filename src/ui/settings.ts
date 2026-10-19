// User settings and progress, persisted per browser (best effort: storage may be unavailable).

import type { Radix } from '../sim/values';

export type Theme = 'auto' | 'light' | 'dark';
/** What one slow-mode tick advances: a gate delay, a clock cycle, or a retired instruction. */
export type TraceLevel = 'gate' | 'cycle' | 'instr';
export type Palette = 'default' | 'cb' | 'lsim' | 'contrast' | 'print';

/** Wire palettes (colours live in styles/palettes.css). */
export const PALETTES: { id: Palette; name: string; blurb: string }[] = [
  { id: 'default', name: 'Default', blurb: 'Orange 1, grey 0, blue buses' },
  { id: 'cb', name: 'Colour-blind safe', blurb: 'Okabe–Ito: blue 1, vermillion X, green buses' },
  { id: 'lsim', name: 'Logic Sim', blurb: 'Red 1, near-black 0, bold flat wires' },
  { id: 'contrast', name: 'High contrast', blurb: 'Thick wires, strong 0/1 difference' },
  { id: 'print', name: 'Print', blurb: 'No hue: heavy 1, thin dashed 0, dotted X' },
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
  /** Timing panel open (stays open across scenes). */
  analyzer: boolean;
  /** Gate delays per second when animating propagation. */
  speed: number;
  /** CPU slow mode: the step unit, and steps (cycles or instructions) per second. */
  traceLevel: TraceLevel;
  traceRate: number;
  /** chapterId → indices of visited steps */
  visited: Record<string, number[]>;
  /** "chapterId:step" → solved */
  solved: Record<string, boolean>;
  /** Campaign map: optional acts unfolded (true) or folded (false) by the learner; absent: the default. */
  openActs: Record<string, boolean>;
}

const KEY = 'mosfet2riscv:v1';
const defaults: State = { theme: 'auto', palette: 'default', radix: 'hex', animate: false, modules: true, wide: false, wireFlow: true, netColors: true, vivid: true, board: true, cartoon: true, vividNets: true, looks: 1, glossary: true, simpleWires: false, autoClock: true, analyzer: false, speed: 12, traceLevel: 'instr', traceRate: 2, visited: {}, solved: {}, openActs: {} };

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

const state = load();
const listeners = new Set<() => void>();

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
  get analyzer() { return state.analyzer; },
  get speed() { return state.speed; },
  get traceLevel() { return state.traceLevel; },
  get traceRate() { return state.traceRate; },
  set<K extends 'theme' | 'palette' | 'radix' | 'animate' | 'modules' | 'wide' | 'wireFlow' | 'netColors' | 'board' | 'cartoon' | 'glossary' | 'simpleWires' | 'autoClock' | 'analyzer' | 'speed' | 'traceLevel' | 'traceRate'>(k: K, v: State[K]): void {
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
  onChange(f: () => void): () => void {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  visit(chapter: string, step: number): void {
    const v = (state.visited[chapter] ??= []);
    if (!v.includes(step)) {
      v.push(step);
      save();
    }
  },
  visited(chapter: string): number[] {
    return state.visited[chapter] ?? [];
  },
  solve(key: string): void {
    state.solved[key] = true;
    save();
  },
  isSolved(key: string): boolean {
    return !!state.solved[key];
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
  if (state.vivid) root.setAttribute('data-look', 'vivid');
  else root.removeAttribute('data-look');
  if (state.vivid && state.board) root.setAttribute('data-board', 'dark');
  else root.removeAttribute('data-board');
  if (state.vivid && state.cartoon) root.setAttribute('data-parts', 'cartoon');
  else root.removeAttribute('data-parts');
}
