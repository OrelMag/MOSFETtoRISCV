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
  /** Every net drawn in a hue of its own (brightness still shows the value); off by default. */
  netColors: boolean;
  /** Sandbox: new wires are simple connections, straight from point to point at any angle (off: horizontal and vertical legs). */
  simpleWires: boolean;
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
}

const KEY = 'mosfet2riscv:v1';
const defaults: State = { theme: 'auto', palette: 'default', radix: 'hex', animate: false, modules: true, wide: false, wireFlow: true, netColors: false, simpleWires: false, analyzer: false, speed: 12, traceLevel: 'instr', traceRate: 2, visited: {}, solved: {} };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
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
  get simpleWires() { return state.simpleWires; },
  get analyzer() { return state.analyzer; },
  get speed() { return state.speed; },
  get traceLevel() { return state.traceLevel; },
  get traceRate() { return state.traceRate; },
  set<K extends 'theme' | 'palette' | 'radix' | 'animate' | 'modules' | 'wide' | 'wireFlow' | 'netColors' | 'simpleWires' | 'analyzer' | 'speed' | 'traceLevel' | 'traceRate'>(k: K, v: State[K]): void {
    state[k] = v;
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
  resetProgress(): void {
    state.visited = {};
    state.solved = {};
    save();
    // The campaign keeps its own key (campaign/progress.ts CAMPAIGN_KEY); its page reloads it.
    try {
      localStorage.removeItem('mosfet2riscv:campaign:v1');
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
}
