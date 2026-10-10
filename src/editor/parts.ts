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
import { ROM_LEAF_K, romLevels, wordsHash } from '../lib/bigmem';

export type PartResult = ComponentDef | { error: string };

export const isError = (r: PartResult): r is { error: string } => 'error' in r;

/**
 * Widest pin, splitter field or display. Values stay exact at any width (pins hold BigInt-backed
 * PinValues, inputs are driven bit by bit); this only bounds a typo. The library's widest port
 * is a 229-bit pipeline register.
 */
export const MAX_WIDTH = 1024;
/**
 * Largest RAM: 2^16 words. Up to 2^6 it is gates (decoder, registers, mux tree); beyond, a lookup
 * whose banks open down to such gate-level banks (lib/bigmem.ts).
 */
export const MAX_RAM_K = 16;
/** Widest splitter / merger pin spacing (the library's tall fans and multiplier rows use up to 18). */
export const MAX_PITCH = 32;
/** Largest ROM: 2^16 words (simulated as a lookup; its mux trees are built when opened, banks of 2^8 beyond that). */
export const MAX_ROM_K = 16;

const okWidth = (w: unknown): w is number => Number.isInteger(w) && (w as number) >= 1 && (w as number) <= MAX_WIDTH;

export function partDef(ref: PartRef, chipDef: (id: string) => ComponentDef | undefined): PartResult {
  if ('lib' in ref) {
    const d = resolveComponent(ref.lib) ?? defIndex().get(ref.lib);
    return d ?? { error: `unknown library part '${ref.lib}'` };
  }
  if ('chip' in ref) return chipDef(ref.chip) ?? { error: `unknown chip '${ref.chip}'` };
  if ('split' in ref || 'merge' in ref) {
    const ws = 'split' in ref ? ref.split : ref.merge;
    if (!Array.isArray(ws) || !ws.length || !ws.every(okWidth)) return { error: `splitter / merger: widths must be 1–${MAX_WIDTH}` };
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
    if (!okWidth(w)) return { error: `display: width must be 1–${MAX_WIDTH}` };
    if (!(ref.display in DISPLAY_LABEL)) return { error: `unknown display '${ref.display}'` };
    return display(ref.display, w);
  }
  if ('key' in ref) {
    if (typeof ref.key !== 'string' || !ref.key.length || ref.key.length > MAX_KEY_LENGTH) return { error: 'key: the name of a keyboard key' };
    return keyPart(ref.key);
  }
  if ('keyboard' in ref) return KEYBOARD;
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

const DISPLAY_LABEL: Record<DisplayKind, string> = { led: 'LED', seg7: '7-seg', hex: 'HEX', value: 'value', halt: 'HALT', buzzer: 'BUZZ' };

/** LEDs per row of an LED bank, and the pitch of its grid (grid units). */
const LEDS_PER_ROW = 8;
export const LED_PITCH = 1.4;

/** An LED bank of w LEDs: rows of 8 (most significant bit first), in a box of even height. */
export function ledGrid(w: number): { cols: number; rows: number; w: number; h: number } {
  const cols = Math.min(w, LEDS_PER_ROW), rows = Math.ceil(w / LEDS_PER_ROW);
  const even = (x: number) => 2 * Math.ceil(x / 2);
  return { cols, rows, w: Math.max(4, even(cols * LED_PITCH + 1.2)), h: Math.max(2, even(rows * LED_PITCH + 0.6)) };
}

/**
 * The tone of a buzzer for the value on its input, in Hz (0: silent). A 1-bit buzzer sounds A4
 * (440 Hz) while its input is 1; a wider one plays MIDI note v (69 = A4, 60 = middle C), up to 127.
 */
export function buzzerHz(width: number, v: number): number {
  if (v <= 0) return 0;
  if (width === 1) return 440;
  return 440 * 2 ** ((Math.min(v, 127) - 69) / 12);
}
const dispCache = new Map<string, ComponentDef>();

const DISPLAY_SUMMARY: Partial<Record<DisplayKind, string>> = {
  halt: 'Stops Run after the step where its input reads non-zero (any bit 1). Pure view: no gates, no delay.',
  buzzer: 'Sounds while its input is non-zero: 1 bit plays A4 (440 Hz), a bus plays MIDI note v (69 = A4, 60 = middle C). Pure view: no gates, no delay.',
};

/** Id prefix of the halt part's defs: the run loop finds them in any simulation's hierarchy by it. */
export const HALT_PREFIX = 'disp_halt_';

/**
 * A pure view: an alias box with no aliases, so it joins nothing, costs nothing, is no leaf of
 * any simulation and emits nothing in Verilog. The editor reads the value of the net on `a`.
 * The halt part is one too: the circuit cannot tell it is there, only the run loop reads it.
 */
function display(kind: DisplayKind, w: number): ComponentDef {
  const id = `disp_${kind}_${w}`;
  let d = dispCache.get(id);
  if (d) return d;
  const box = kind === 'led' ? ledGrid(w) : kind === 'halt' || kind === 'buzzer' ? { w: 4, h: 2 } : null;
  d = {
    id, name: kind === 'halt' ? 'Halt' : kind === 'buzzer' ? 'Buzzer' : kind === 'led' && w > 1 ? `LED bank (${w})` : `Display (${DISPLAY_LABEL[kind]})`,
    category: 'plumbing',
    summary: DISPLAY_SUMMARY[kind] ?? 'Shows the value on its input. Pure view: no gates, no delay.',
    ports: [{ name: 'a', width: w, dir: 'in' }],
    symbol: { kind: 'box', label: DISPLAY_LABEL[kind], ...(box ? { w: box.w, h: box.h } : {}) },
    prim: 'alias', alias: [],
  };
  dispCache.set(id, d);
  return d;
}

// ---- external sources: keys and the keyboard ------------------------------------------------
// Inputs from outside the circuit (isExternal): behaviours with no structure, so they cost
// nothing and have no Verilog, and leaves of every simulation, whose private state the editor
// sets through Sim.poke (EditorSim.setKey / typeKey). The run loop finds them in any
// simulation's hierarchy by their ids, like the halt parts.

/** Id prefix of key parts (`key_` + the key's code points in hex, '_' between them). */
export const KEY_PREFIX = 'key_';
export const KEYBOARD_ID = 'keyboard';
/** Longest key name accepted ('ArrowLeft', 'MediaTrackNext', …; a typo stays short). */
export const MAX_KEY_LENGTH = 32;
/** Keys a keyboard part holds at most; further ones are dropped until the circuit takes some. */
export const KEYBOARD_DEPTH = 16;

/** Private state of a key leaf: 1 while held. */
export interface KeyState { v: 0 | 1 }
/** Private state of a keyboard leaf: the waiting key codes, oldest first. */
export interface KeyboardState { q: number[] }

/** Keys that modify others, or are the editor's own: a key part cannot listen to them. */
const RESERVED_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock',
  'Hyper', 'Super', 'Symbol', 'SymbolLock', 'OS', 'Dead', 'Unidentified', 'Escape']);

/**
 * A key as a key part names it, from KeyboardEvent.key: a character (letters lowercase, so Shift
 * does not matter) or a named key ('Enter', 'ArrowUp', 'F1'); null for modifiers and Escape.
 */
export function normalizeKey(key: string): string | null {
  if (RESERVED_KEYS.has(key) || !key.length || key.length > MAX_KEY_LENGTH) return null;
  return [...key].length === 1 ? key.toLowerCase() : key;
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '⏎', Backspace: '⌫', Tab: '⇥', Delete: 'Del',
};

/** How a key is shown on its part and in the properties. */
export function keyLabel(bind: string): string {
  return KEY_NAMES[bind] ?? ([...bind].length === 1 ? bind.toUpperCase() : bind);
}

/** Codes of the named keys a keyboard part reports (printable characters are their ASCII code). */
export const KEY_CODES: Record<string, number> = { Enter: 10, Backspace: 8, Tab: 9, Delete: 127, ArrowUp: 128, ArrowDown: 129, ArrowLeft: 130, ArrowRight: 131 };

/** The 8-bit code a keyboard part reports for KeyboardEvent.key, or null for a key it ignores. */
export function keyCode(key: string): number | null {
  if (key in KEY_CODES) return KEY_CODES[key];
  if ([...key].length !== 1) return null;
  const c = key.codePointAt(0)!;
  return c >= 32 && c < 127 ? c : null;
}

/** What a keyboard code looks like on the part's face. */
export function codeGlyph(code: number): string {
  const named = Object.entries(KEY_CODES).find(([, c]) => c === code);
  if (named) return KEY_NAMES[named[0]] ?? named[0];
  if (code === 32) return '␣';
  return code > 32 && code < 127 ? String.fromCharCode(code) : code.toString(16).toUpperCase().padStart(2, '0');
}

const keyCache = new Map<string, ComponentDef>();

/** The key a key part's definition listens to (null for any other definition). */
export function keyBindOf(def: ComponentDef): string | null {
  if (!def.id.startsWith(KEY_PREFIX)) return null;
  return def.id.slice(KEY_PREFIX.length).split('_').map((hex) => String.fromCodePoint(parseInt(hex, 16))).join('');
}

/** A key part: q = 1 while the key `bind` is held. */
export function keyPart(bind: string): ComponentDef {
  const id = `${KEY_PREFIX}${[...bind].map((c) => c.codePointAt(0)!.toString(16)).join('_')}`;
  let d = keyCache.get(id);
  if (d) return d;
  const label = keyLabel(bind);
  d = {
    id, name: `Key ${label}`, category: 'plumbing',
    summary: `1 while the ${label} key is held (letters ignore Shift; rebind it in the properties). An input from outside the circuit: no gates, nothing in Verilog.`,
    ports: [{ name: 'q', width: 1, dir: 'out', doc: '1 while the key is held' }],
    symbol: { kind: 'box', label, w: 4, h: 2, noPortLabels: true },
    behavior: { init: (): KeyState => ({ v: 0 }), eval: (_ins, s) => [(s as KeyState).v] },
  };
  keyCache.set(id, d);
  return d;
}

/** The keyboard part: typed keys wait in order until the circuit takes them. */
export const KEYBOARD: ComponentDef = {
  id: KEYBOARD_ID, name: 'Keyboard', category: 'plumbing',
  summary: `Keys typed while the circuit runs (or with Type on) wait here in order, ${KEYBOARD_DEPTH} at most. code: the oldest `
    + '(ASCII; Enter 10, Backspace 8, Tab 9, Delete 127, arrows 128–131; 0 when none). ready: 1 while one waits. ack = 1 removes it, '
    + 'sampled at every rising clock edge (without a clock: whenever the logic has settled). An input from outside the circuit: no gates, nothing in Verilog.',
  ports: [
    { name: 'ack', width: 1, dir: 'in', doc: 'Removes the key in code: read at each rising clock edge, or continuously without a clock' },
    { name: 'code', width: 8, dir: 'out', doc: 'The oldest waiting key (0 when none)' },
    { name: 'ready', width: 1, dir: 'out', doc: '1 while a key waits' },
  ],
  symbol: { kind: 'box', label: '', w: 8, h: 4 },
  behavior: {
    init: (): KeyboardState => ({ q: [] }),
    eval: (_ins, s) => { const q = (s as KeyboardState).q; return [q[0] ?? 0, q.length ? 1 : 0]; },
  },
};

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
  if (lang !== 'asm' && lang !== 'hex' && lang !== 'rv16') return { error: `ROM: unknown language '${String(lang)}'` };
  if (lang === 'rv16' && (w !== 16 || addr !== 'word')) return { error: 'ROM: RV16 programs need 16-bit words, word addressed' };
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
  const content = Uint32Array.from({ length: N }, (_, i) => (words[i] ?? fill) >>> 0);
  // A large ROM is keyed by two independent hashes of its words, not by all of them.
  const big = k > ROM_LEAF_K;
  const key = `${k}/${w}/${addr}/${big ? wordsHash(content) : content.join(',')}`;
  const hit = romCache.get(key);
  if (hit) {
    romCache.delete(key);
    romCache.set(key, hit);
    return hit;
  }
  const rv = addr === 'rv32';
  const d = big
    ? romLevels(k, w, rv, content, `sb_rom${k}x${w}${rv ? 'b' : ''}_${wordsHash(content)}`, (ks, _w, slice) => romTree(ks, w, false, Array.from(slice)))
    : romTree(k, w, rv, Array.from(content));
  romCache.set(key, d);
  if (romCache.size > ROM_CACHE_SIZE) romCache.delete(romCache.keys().next().value!);
  return d;
}

/** A ROM of 2^k ≤ 2^8 words as one mux tree of constants (uncached: wordRom's, and a large ROM's banks). */
function romTree(k: number, w: 8 | 16 | 32, rv: boolean, content: number[]): ComponentDef {
  const N = 2 ** k;
  const M = muxTree(k, w, 4);
  const mg = symbolGeom(M);
  // Built when first opened: a large ROM has up to 256 of these banks.
  const netlist = () => {
    const consts = new Map<number, ComponentDef>();
    const constOf = (v: number) => consts.get(v) ?? consts.set(v, buildConstant(w, v)).get(v)!;
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
    return { pins: { addr: [0, mg.h + 7] as [number, number], data: [16 + mg.w + 6, mg.ports.y.pos[1]] as [number, number] }, instances, nets };
  };
  const hex = (v: number) => `0x${v.toString(16).padStart(w / 4, '0')}`;
  return {
    id: `sb_rom${k}x${w}${rv ? 'b' : ''}_${fnv(content)}`, name: `ROM ${N}×${w}`, category: 'memory',
    summary: `${N} words of ${w} bits, read-only: a ${N}:1 multiplexer tree whose inputs are tied to constants.`
      + (rv ? ' Byte addressed like a PC: word = addr / 4.' : ' Word addressed.'),
    ports: [{ name: 'addr', width: rv ? 32 : k, dir: 'in' }, { name: 'data', width: w, dir: 'out' }],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : content[(rv ? Math.floor(a / 4) : a) % N]], delay: 3 * k },
    preferBehavior: true,
    spec: ([a]) => [content[(rv ? Math.floor(a / 4) : a) % N]],
    netlist,
    notes: `Simulated as a lookup table. Its structure is the real circuit: ${N - 1} two-input multiplexers in ${k} levels, `
      + `their inputs wired to the program's bits. Words: ${content.slice(0, 8).map(hex).join(' ')}${N > 8 ? ' …' : ''}`,
  };
}
