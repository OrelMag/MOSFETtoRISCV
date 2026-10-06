// User settings and progress, persisted per browser (best effort: storage may be unavailable).

import type { Radix } from '../sim/values';

export type Theme = 'auto' | 'light' | 'dark';
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
  /** Timing panel open (stays open across scenes). */
  analyzer: boolean;
  /** Gate delays per second when animating propagation. */
  speed: number;
  /** chapterId → indices of visited steps */
  visited: Record<string, number[]>;
  /** "chapterId:step" → solved */
  solved: Record<string, boolean>;
}

const KEY = 'mosfet2riscv:v1';
const defaults: State = { theme: 'auto', palette: 'default', radix: 'hex', animate: false, analyzer: false, speed: 12, visited: {}, solved: {} };

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
  get analyzer() { return state.analyzer; },
  get speed() { return state.speed; },
  set<K extends 'theme' | 'palette' | 'radix' | 'animate' | 'analyzer' | 'speed'>(k: K, v: State[K]): void {
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
    listeners.forEach((f) => f());
  },
};

export function applyTheme(): void {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  if (state.palette === 'default') root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', state.palette);
}
