// What the right-click menu says about a wire, DOM-free: who drives it and who reads it at this level (read off the
// netlist's ends), and its value in each radix, exact at any width. Derived, so it cannot drift from the drawing.

import { B0, B1, BZ, type Bit, type ComponentDef, netlistOf, parseEnd } from '../sim/types';
import { formatBits } from '../sim/values';
import { groupDigits } from '../sim/numfmt';
import { packBig } from '../sim/values';

export interface NetEnd {
  /** The instance at this level (null: a port of the level itself). */
  inst: string | null;
  port: string;
  /** As shown: `alu.y`, or the port's name. */
  label: string;
}

export interface NetFacts {
  name: string;
  drivers: NetEnd[];
  sinks: NetEnd[];
  /** Two-way ends (a transistor's source and drain, a shared bus): neither driver nor reader until the solver says. */
  both: NetEnd[];
}

/** The ends of net `idx` of a netlist, by direction. Inside the level, its own inputs drive and its outputs read. */
export function factsOf(def: ComponentDef, idx: number): NetFacts | null {
  const nl = netlistOf(def);
  const net = nl?.nets[idx];
  if (!nl || !net) return null;
  const f: NetFacts = { name: net.name ?? net.ends[0] ?? `net ${idx}`, drivers: [], sinks: [], both: [] };
  for (const end of net.ends) {
    const { inst, port } = parseEnd(end);
    const p = inst === null ? def.ports.find((q) => q.name === port) : nl.instances.find((i) => i.name === inst)?.def.ports.find((q) => q.name === port);
    const e: NetEnd = { inst, port, label: end };
    if (!p || p.dir === 'inout') f.both.push(e);
    else if ((p.dir === 'out') === (inst !== null)) f.drivers.push(e);
    else f.sinks.push(e);
  }
  return f;
}

/** Children this net goes into: where it continues below this level, for "Highlight the whole net". */
export const crossings = (f: NetFacts): string[] => [...f.sinks, ...f.both].filter((e) => e.inst !== null).map((e) => e.label);

export interface ValueRow {
  /** The radix's short name. */
  k: 'val' | 'hex' | 'dec' | 'bin';
  /** As shown (a wide word folded). */
  text: string;
  /** What Copy takes: the whole value, no separators. */
  copy: string;
  /** A bit that is neither 0 nor 1 (or a nibble holding one): the view marks it. */
  unknown: boolean;
}

/** Past this a word folds to its two ends. */
const FOLD_BITS = 64;
const fold = (s: string, n: number) => (s.length <= 2 * n + 1 ? s : `${s.slice(0, n)} … ${s.slice(-n)}`);

/** One row for a bit, else hex, decimal and binary. X and Z are per bit in binary, per nibble in hex. */
export function valueRows(bits: ArrayLike<Bit | number>): ValueRow[] {
  const w = bits.length;
  if (!w) return [];
  let x = 0, z = 0;
  for (let i = 0; i < w; i++) {
    if (bits[i] === BZ) z++;
    else if (bits[i] !== B0 && bits[i] !== B1) x++;
  }
  const unknown = x + z > 0;
  if (w === 1) {
    const t = formatBits(bits, 'bin').toUpperCase();
    return [{ k: 'val', text: t, copy: t, unknown }];
  }
  const hexText = formatBits(bits, 'hex');
  const hexPlain = hexText.replace(/_/g, '');
  const bin = formatBits(bits, 'bin').replace(/^0b/, '');
  const binPlain = bin.replace(/_/g, '');
  const big = w > FOLD_BITS;
  const rows: ValueRow[] = [
    { k: 'hex', text: big ? `0x${fold(hexPlain.slice(2), 8)}` : hexText, copy: hexPlain, unknown },
    { k: 'dec', ...decimal(bits, x, z), unknown },
    { k: 'bin', text: big ? fold(binPlain, 32).replace(/(?<=[01xz]{4})(?=(?:[01xz]{4})+(?:\s|$))/g, ' ') : bin.replace(/_/g, ' '), copy: binPlain, unknown },
  ];
  return rows;
}

function decimal(bits: ArrayLike<Bit | number>, x: number, z: number): { text: string; copy: string } {
  const w = bits.length;
  if (x + z) {
    const what = [x ? `${x} X` : '', z ? `${z} Z` : ''].filter(Boolean).join(', ');
    const t = z === w ? 'Z: nothing drives it' : `unknown (${what} of ${w} bits)`;
    return { text: t, copy: t };
  }
  const u = packBig(bits as ArrayLike<number>)!;
  const uText = groupDigits(u);
  const full = bits[w - 1] === B1 ? `${uText} or ${groupDigits(u - (1n << BigInt(w))).replace('-', '−')}` : uText;
  return { text: fold(full, 24), copy: bits[w - 1] === B1 ? `${u} ${u - (1n << BigInt(w))}` : String(u) };
}

/** The menu's fan-out line: ends at this level, and inputs reading the net once flattened (every bit of a bus). */
export function fanText(f: NetFacts, readers: number, transistors: boolean): string {
  const here = f.sinks.length + f.both.length;
  return `${here} here, ${groupDigits(readers)} ${transistors ? 'gate' : 'NAND'} input${readers === 1 ? '' : 's'} flat`;
}
