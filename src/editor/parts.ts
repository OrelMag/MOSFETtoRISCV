// What a placed part is: a PartRef resolved to a ComponentDef. Library parts and user chips are
// looked up; wiring, constants and displays are small memoized defs made here. None of the
// editor-only defs goes through define(): they must not appear in the library registry (the
// workbench lists it, and defIndex() would offer them as library parts).

import { muxTree } from '../lib/combinational';
import { merger, ones, splitter } from '../lib/define';
import { symbolGeom } from '../sim/geometry';
import { defIndex, resolveComponent } from '../lib/resolve';
import { TIE0, TIE1 } from '../lib/transistors';
import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';
import type { DisplayKind, PartRef } from './model';
import { ramWithInit, romImage } from './memory';

export type PartResult = ComponentDef | { error: string };

export const isError = (r: PartResult): r is { error: string } => 'error' in r;

/** Widest bus the sandbox builds (constants, displays, RAM words). */
export const MAX_WIDTH = 64;
/** Largest RAM: 2^6 words (the structure is a decoder, registers and a mux tree, all drawn). */
export const MAX_RAM_K = 6;
/** Widest splitter / merger pin spacing (the library's tall fans use up to 14). */
export const MAX_PITCH = 16;
/** Largest ROM: 2^8 words (simulated as a lookup; its mux tree is only built when opened). */
export const MAX_ROM_K = 8;

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
    if (!(pitch > 0 && pitch <= MAX_PITCH)) return { error: 'splitter / merger: bad pitch' };
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
    const { k, w, init } = ref.ram;
    if (!Number.isInteger(k) || k < 1 || k > MAX_RAM_K) return { error: `RAM: 2^k words with k = 1–${MAX_RAM_K}` };
    if (!okWidth(w) || w > 32) return { error: 'RAM: word width must be 1–32' };
    return ramWithInit(k, w, init);
  }
  if ('rom' in ref) return romPart(ref.rom);
  return { error: 'unknown part kind' };
}

// ---- constants -----------------------------------------------------------------------------

const constCache = new Map<string, ComponentDef>();

/**
 * A w-bit constant: the library's constWord (bits tied to VDD / GND through a merger), rebuilt
 * here because constWord registers every value it is asked for.
 */
function constant(w: number, v: number): ComponentDef {
  const id = constId(w, v);
  let d = constCache.get(id);
  if (!d) constCache.set(id, (d = buildConstant(w, v)));
  return d;
}

const constId = (w: number, v: number) => `sb_const${w}_${v.toString(16)}`;

/** The uncached constant (a ROM builds its own words, so they go away with the ROM). */
function buildConstant(w: number, v: number): ComponentDef {
  const id = constId(w, v);
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
  return {
    id, name: `Constant ${hex}`, category: 'plumbing',
    summary: 'Wires tied to VDD (1) or GND (0): a constant costs no gates.',
    ports: [{ name: 'y', width: w, dir: 'out' }],
    symbol: { kind: 'box', label: w > 4 ? hex : v.toString(2).padStart(w, '0'), w: 6, h: 2 },
    behavior: { eval: () => [v] },
    spec: () => [v],
    netlist: () => nl,
  };
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

// ---- read-only memory ----------------------------------------------------------------------

type RomRef = Extract<PartRef, { rom: unknown }>['rom'];

/** Most recently used ROMs, by content: editing a program makes a new ROM, and the old ones go. */
const ROM_CACHE_SIZE = 16;
const romCache = new Map<string, ComponentDef>();

function romPart(r: RomRef): PartResult {
  const { k, w, addr, lang, src } = r;
  if (!Number.isInteger(k) || k < 1 || k > MAX_ROM_K) return { error: `ROM: 2^k words with k = 1–${MAX_ROM_K}` };
  if (w !== 8 && w !== 16 && w !== 32) return { error: 'ROM: word width must be 8, 16 or 32' };
  if (addr !== 'word' && addr !== 'rv32') return { error: `ROM: unknown addressing '${String(addr)}'` };
  if (addr === 'rv32' && w !== 32) return { error: 'ROM: byte addressing (rv32) needs 32-bit words' };
  if (lang !== 'asm' && lang !== 'hex') return { error: `ROM: unknown language '${String(lang)}'` };
  if (typeof src !== 'string') return { error: 'ROM: no program' };
  const p = romImage(r);
  if (p.error) return { error: p.error };
  return wordRom(k, w, addr, p.words);
}

/** FNV-1a over the words (enough to tell programs apart in a 16-entry cache; the key holds all). */
function fnv(words: number[]): string {
  let h = 2166136261;
  for (const x of words) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/**
 * A ROM of 2^k words of w bits: a multiplexer tree whose data inputs are constants, the library
 * rom() generalized. 'word': the address is the word index (k bits). 'rv32': the address is a
 * 32-bit byte address like a PC (word = addr[k+1:2]) and unused words are NOPs, exactly as the
 * CPU's instruction memory. Simulated as a lookup (preferBehavior), delay = the tree's depth.
 * Built here, not with rom() / constWord(), because those register every program's words in
 * the library registry for good.
 */
export function wordRom(k: number, w: 8 | 16 | 32, addr: 'word' | 'rv32', words: number[]): ComponentDef {
  const N = 2 ** k;
  const fill = addr === 'rv32' ? 0x00000013 : 0;
  const content = Array.from({ length: N }, (_, i) => (words[i] ?? fill) >>> 0);
  const key = `${k}/${w}/${addr}/${content.join(',')}`;
  const hit = romCache.get(key);
  if (hit) {
    romCache.delete(key);
    romCache.set(key, hit);
    return hit;
  }
  const M = muxTree(k, w, 4);
  const mg = symbolGeom(M);
  const consts = new Map<number, ComponentDef>();
  const constOf = (v: number) => consts.get(v) ?? consts.set(v, buildConstant(w, v)).get(v)!;
  const rv = addr === 'rv32';
  const instances: InstanceDef[] = [{ name: 'mux', def: M, at: [16, 0] }];
  const sel: [number, number] = [16 + mg.ports.s.pos[0], mg.h + 7];
  const nets: NetDef[] = rv
    ? [{ name: 'addr', ends: ['addr', 'sa.in'] }, { name: 'index', ends: ['sa.o1', 'mux.s'], via: { 'mux.s': [sel] } }]
    : [{ name: 'addr', ends: ['addr', 'mux.s'], via: { 'mux.s': [sel] } }];
  if (rv) instances.unshift({ name: 'sa', def: splitter([2, k, 30 - k]), at: [3, mg.h + 6] });
  nets.push({ name: 'data', ends: ['mux.y', 'data'] });
  content.forEach((v, i) => {
    instances.push({ name: `c${i}`, def: constOf(v), at: [8, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
    nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
  });
  const hex = (v: number) => `0x${v.toString(16).padStart(w / 4, '0')}`;
  const d: ComponentDef = {
    id: `sb_rom${k}x${w}${rv ? 'b' : ''}_${fnv(content)}`, name: `ROM ${N}×${w}`, category: 'memory',
    summary: `${N} words of ${w} bits, read-only: a ${N}:1 multiplexer tree whose inputs are tied to constants.`
      + (rv ? ' Byte addressed like a PC: word = addr / 4.' : ' Word addressed.'),
    ports: [{ name: 'addr', width: rv ? 32 : k, dir: 'in' }, { name: 'data', width: w, dir: 'out' }],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : content[(rv ? Math.floor(a / 4) : a) % N]], delay: 3 * k },
    preferBehavior: true,
    spec: ([a]) => [content[(rv ? Math.floor(a / 4) : a) % N]],
    netlist: () => ({
      pins: { addr: [0, mg.h + 7], data: [16 + mg.w + 6, mg.ports.y.pos[1]] },
      instances, nets,
    }),
    notes: `Simulated as a lookup table. Its structure is the real circuit: ${N - 1} two-input multiplexers in ${k} levels, `
      + `their inputs wired to the program's bits. Words: ${content.slice(0, 8).map(hex).join(' ')}${N > 8 ? ' …' : ''}`,
  };
  romCache.set(key, d);
  if (romCache.size > ROM_CACHE_SIZE) romCache.delete(romCache.keys().next().value!);
  return d;
}
