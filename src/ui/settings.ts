// User settings and progress, persisted per browser (best effort: storage may be unavailable).

import type { Radix } from '../sim/values';

export type Theme = 'auto' | 'light' | 'dark';

interface State {
  theme: Theme;
  radix: Radix;
  animate: boolean;
  /** Gate delays per second when animating propagation. */
  speed: number;
  /** chapterId → indices of visited steps */
  visited: Record<string, number[]>;
  /** "chapterId:step" → solved */
  solved: Record<string, boolean>;
}

const KEY = 'mosfet2riscv:v1';
const defaults: State = { theme: 'auto', radix: 'hex', animate: false, speed: 12, visited: {}, solved: {} };

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
  get radix() { return state.radix; },
  get animate() { return state.animate; },
  get speed() { return state.speed; },
  set<K extends 'theme' | 'radix' | 'animate' | 'speed'>(k: K, v: State[K]): void {
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
}
