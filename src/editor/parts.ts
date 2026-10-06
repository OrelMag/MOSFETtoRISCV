// What a placed part is: a PartRef resolved to a ComponentDef. Library parts and user chips are
// looked up; wiring, constants and displays are small memoized defs made here. None of the
// editor-only defs goes through define(): they must not appear in the library registry (the
// workbench lists it, and defIndex() would offer them as library parts).

import { merger, ones, splitter } from '../lib/define';
import { ram } from '../lib/memory';
import { defIndex, resolveComponent } from '../lib/resolve';
import { TIE0, TIE1 } from '../lib/transistors';
import type { ComponentDef, NetDef } from '../sim/types';
import type { DisplayKind, PartRef } from './model';

export type PartResult = ComponentDef | { error: string };

export const isError = (r: PartResult): r is { error: string } => 'error' in r;

/** Widest bus the sandbox builds (constants, displays, RAM words). */
export const MAX_WIDTH = 64;
/** Largest RAM: 2^6 words (the structure is a decoder, registers and a mux tree, all drawn). */
export const MAX_RAM_K = 6;

const okWidth = (w: unknown): w is number => Number.isInteger(w) && (w as number) >= 1 && (w as number) <= MAX_WIDTH;

export function partDef(ref: PartRef, chipDef: (id: string) => ComponentDef | undefined): PartResult {
  if ('lib' in ref) {
    const d = resolveComponent(ref.lib) ?? defIndex().get(ref.lib);
    return d ?? { error: `unknown library part '${ref.lib}'` };
  }
  if ('chip' in ref) return chipDef(ref.chip) ?? { error: `unknown chip '${ref.chip}'` };
  if ('split' in ref || 'merge' in ref) {
    const ws = 'split' in ref ? ref.split : ref.merge;
    if (!Array.isArray(ws) || !ws.length || !ws.every(okWidth)) return { error: 'splitter / merger: widths must be 1–64' };
    const pitch = ref.pitch ?? 2;
    if (!(pitch > 0 && pitch <= 8)) return { error: 'splitter / merger: bad pitch' };
    return 'split' in ref ? splitter(ws, pitch) : merger(ws, pitch);
  }
  if ('const' in ref) {
    const { width, value } = ref.const;
    if (!okWidth(width) || width > 53) return { error: 'constant: width must be 1–53' };
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) return { error: `constant: ${value} does not fit in ${width} bits` };
    return width === 1 ? (value ? TIE1 : TIE0) : constant(width, value);
  }
  if ('display' in ref) {
    const w = ref.width ?? 1;
    if (!okWidth(w)) return { error: 'display: width must be 1–64' };
    if (!(ref.display in DISPLAY_LABEL)) return { error: `unknown display '${ref.display}'` };
    return display(ref.display, w);
  }
  if ('ram' in ref) {
    const { k, w } = ref.ram;
    if (!Number.isInteger(k) || k < 1 || k > MAX_RAM_K) return { error: `RAM: 2^k words with k = 1–${MAX_RAM_K}` };
    if (!okWidth(w) || w > 32) return { error: 'RAM: word width must be 1–32' };
    return ram(k, w);
  }
  if ('rom' in ref) return { error: 'ROM: not yet available' };
  return { error: 'unknown part kind' };
}

// ---- constants -----------------------------------------------------------------------------

const constCache = new Map<string, ComponentDef>();

/**
 * A w-bit constant: the library's constWord (bits tied to VDD / GND through a merger), rebuilt
 * here because constWord registers every value it is asked for.
 */
function constant(w: number, v: number): ComponentDef {
  const id = `sb_const${w}_${v.toString(16)}`;
  let d = constCache.get(id);
  if (d) return d;
  const nets: NetDef[] = [{ name: 'y', ends: ['m.out', 'y'] }];
  const zeros = ['z.y'], onesE = ['o.y'];
  for (let i = 0; i < w; i++) (Math.floor(v / 2 ** i) % 2 ? onesE : zeros).push(`m.i${i}`);
  if (zeros.length > 1) nets.push({ name: 'gnd', ends: zeros, trunk: 4 });
  if (onesE.length > 1) nets.push({ name: 'vdd', ends: onesE, trunk: 5 });
  const hex = `0x${v.toString(16).toUpperCase()}`;
  const nl = {
    pins: { y: [12, w / 2] as [number, number] },
    instances: [
      { name: 'z', def: TIE0, at: [0, 0] as [number, number] },
      { name: 'o', def: TIE1, at: [0, 3] as [number, number] },
      { name: 'm', def: merger(ones(w), 1), at: [8, 0] as [number, number] },
    ],
    nets,
  };
  d = {
    id, name: `Constant ${hex}`, category: 'plumbing',
    summary: 'Wires tied to VDD (1) or GND (0): a constant costs no gates.',
    ports: [{ name: 'y', width: w, dir: 'out' }],
    symbol: { kind: 'box', label: w > 4 ? hex : v.toString(2).padStart(w, '0'), w: 6, h: 2 },
    behavior: { eval: () => [v] },
    spec: () => [v],
    netlist: () => nl,
  };
  constCache.set(id, d);
  return d;
}

// ---- displays ------------------------------------------------------------------------------

const DISPLAY_LABEL: Record<DisplayKind, string> = { led: 'LED', seg7: '7-seg', hex: 'HEX', value: 'value' };
const dispCache = new Map<string, ComponentDef>();

/**
 * A pure view: an alias box with no aliases, so it joins nothing, costs nothing, is no leaf of
 * any simulation and emits nothing in Verilog. The editor reads the value of the net on `a`.
 */
function display(kind: DisplayKind, w: number): ComponentDef {
  const id = `disp_${kind}_${w}`;
  let d = dispCache.get(id);
  if (d) return d;
  d = {
    id, name: `Display (${DISPLAY_LABEL[kind]})`, category: 'plumbing',
    summary: 'Shows the value on its input. Pure view: no gates, no delay.',
    ports: [{ name: 'a', width: w, dir: 'in' }],
    symbol: { kind: 'box', label: DISPLAY_LABEL[kind], ...(kind === 'led' ? { w: 4, h: 2 } : {}) },
    prim: 'alias', alias: [],
  };
  dispCache.set(id, d);
  return d;
}
