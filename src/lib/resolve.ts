// Look up any component by id, including parameterized ones (rca8, ram16x8, …), and the
// parameter families shown in the workbench.

import { type ComponentDef, netlistOf } from '../sim/types';
import type { FpFormat } from '../sim/fpref';
import { addSub, andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { registry } from './define';
import { ram } from './memory';
import { alu, bitwise, isZero, orN, shifter, zext } from './alu';
import { singleCycleCpu } from './cpu';
import { addSubFast, koggeStone } from './fastadd';
import { regfile } from './regfile';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { counter, register } from './sequential';
import { arrayDiv, arrayMul, condNegate, csa, divStep, seqDivider, treeMul } from './muldiv';
import { fpAdd, fpCompare, fpMul, fpUnpack, lzc, shiftLeft } from './fpu';
import { cachedMemory, wayLookup2 } from './cache';
import { bankedMemory } from './lsu';
import { clearableRegister } from './pipeline';
import { boothMul, pipeMul, seqMul } from './multiply';
import { bcdAdder, carrySelect, carrySkip } from './adders';
import { cam, fifo, pla, regfileMP, romArray, stack } from './storage';
import { sramArray, sramColumn } from './arrays';
import { wbCache } from './cache2';
import { clockDivider, lfsr, ringCounter, shiftRegister, upDownCounter } from './seqparts';
import { srt4Divider, srt4Step } from './srt4';
import { iterCtrl, nrArrayDiv, nrDivStep, nrSeqDivider, srtDivider, srtStep } from './divide';
import { absValue, demux, eccChannel, encoder, hammingDec, hammingEnc, magComparator, parity, popcount, priorityEncoder } from './coding';

const log2 = (n: number) => Math.round(Math.log2(n));

// Ids that are not (or not only) family members.
const patterns: [RegExp, (m: RegExpMatchArray) => ComponentDef][] = [
  [/^rca(\d+)$/, (m) => rca(+m[1])],
  [/^addsub(\d+)$/, (m) => addSub(+m[1])],
  [/^inc(\d+)$/, (m) => incrementer(+m[1])],
  [/^and(\d+)$/, (m) => andN(+m[1])],
  [/^dec(\d)(e?)(?:_p(\d+))?$/, (m) => decoder(+m[1], m[2] === 'e', m[3] ? +m[3] : 0)],
  [/^mux2x(\d+)$/, (m) => busMux2(+m[1])],
  [/^mux2tree(\d+)$/, (m) => muxTree(1, +m[1])],
  [/^mux(\d+)x(\d+)(?:_p(\d+))?$/, (m) => muxTree(log2(+m[1]), +m[2], m[3] ? +m[3] : 2)],
  [/^reg(\d+)$/, (m) => register(+m[1])],
  [/^counter(\d+)$/, (m) => counter(+m[1])],
  [/^ram(\d+)x(\d+)$/, (m) => ram(log2(+m[1]), +m[2])],
  [/^alu(\d+)(ks)?$/, (m) => alu(+m[1], m[2] ? 'ks' : 'rca')],
  [/^ks(\d+)$/, (m) => koggeStone(+m[1])],
  [/^regfile(\d+)x(\d+)$/, (m) => regfile(log2(+m[1]), +m[2])],
  [/^cpu_(\w+)$/, (m) => singleCycleCpu(assemble(PROGRAMS.find((p) => p.id === m[1])?.source ?? '').words)],
  [/^shift(\d+)$/, (m) => shifter(+m[1])],
  [/^zero(\d+)$/, (m) => isZero(+m[1])],
  [/^(and|or|xor)x(\d+)$/, (m) => bitwise(m[1] as 'and' | 'or' | 'xor', +m[2])],
];

type Resolver = (id: string) => ComponentDef | undefined;
let userResolver: Resolver | null = null;

/** Where user chips (ids `u_…`, made in the sandbox) come from; null removes it. */
export function setUserResolver(f: Resolver | null): void {
  userResolver = f;
}

/**
 * Can `id` be rebuilt from its name alone (a family member or a generator pattern), so that a
 * stored reference still resolves on a fresh page load before anything has generated it?
 */
export function regenerable(id: string): boolean {
  return !!familyOf(id) || patterns.some(([re]) => re.test(id));
}

export function resolveComponent(id: string): ComponentDef | undefined {
  if (userResolver && id.startsWith('u_')) {
    const u = userResolver(id);
    if (u) return u;
  }
  const hit = registry.get(id);
  if (hit) return hit;
  const f = familyOf(id);
  if (f) return f.fam.make(f.values);
  for (const [re, make] of patterns) {
    const m = id.match(re);
    if (m) {
      try {
        return make(m);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface Param {
  name: string;
  values: number[];
  initial: number;
  label?: (v: number) => string;
}

export interface Family {
  id: string;
  name: string;
  category: string;
  params: Param[];
  /** The id make(p) will have, computed without building anything (so the index stays cheap). */
  key: (p: Record<string, number>) => string;
  make: (p: Record<string, number>) => ComponentDef;
}

type P = Record<string, number>;
const bits = (values: number[], initial: number): Param => ({ name: 'bits', values, initial });
const count = (name: string, values: number[], initial: number): Param => ({ name, values, initial });
const flag = (name: string, on: string, off: string): Param => ({ name, values: [0, 1], initial: 0, label: (v) => (v ? on : off) });
const FORMATS: FpFormat[] = [{ E: 3, M: 4 }, { E: 4, M: 3 }, { E: 5, M: 10 }, { E: 8, M: 23 }];
const FMT_NAMES = ['E3M4 (8-bit)', 'E4M3 (8-bit)', 'binary16', 'float32'];
const format: Param = { name: 'format', values: [0, 1, 2, 3], initial: 0, label: (v) => FMT_NAMES[v] };
const fmt = (p: P) => FORMATS[p.format];
const OPS = ['and', 'or', 'xor'] as const;
const ROMS = ['squares', 'seg7', 'sine'], PLAS = ['fa', 'seg7'];

/** A family with one `bits` parameter. */
const nBit = (id: string, name: string, category: string, values: number[], initial: number, key: (n: number) => string, make: (n: number) => ComponentDef): Family =>
  ({ id, name, category, params: [bits(values, initial)], key: (p) => key(p.bits), make: (p) => make(p.bits) });
const float = (id: string, name: string, make: (f: FpFormat) => ComponentDef): Family =>
  ({ id, name, category: 'arithmetic', params: [format], key: (p) => `${id}${fmt(p).E}_${fmt(p).M}`, make: (p) => make(fmt(p)) });

export const families: Family[] = [
  // arithmetic
  nBit('rca', 'Ripple-carry adder', 'arithmetic', [1, 2, 4, 8, 16], 4, (n) => `rca${n}`, rca),
  nBit('addsub', 'Adder / subtractor', 'arithmetic', [2, 4, 8, 16], 8, (n) => `addsub${n}`, addSub),
  nBit('inc', 'Incrementer', 'arithmetic', [2, 4, 8, 16], 4, (n) => `inc${n}`, incrementer),
  {
    id: 'alu', name: 'ALU', category: 'arithmetic', params: [bits([4, 8, 16, 32], 8), flag('adder', 'Kogge–Stone', 'ripple carry')],
    key: (p) => `alu${p.bits}${p.adder ? 'ks' : ''}`, make: (p) => alu(p.bits, p.adder ? 'ks' : 'rca'),
  },
  nBit('ks', 'Kogge–Stone adder', 'arithmetic', [4, 8, 16, 32], 8, (n) => `ks${n}`, koggeStone),
  nBit('csel', 'Carry-select adder', 'arithmetic', [8, 16, 32], 16, (n) => `csel${n}_4`, (n) => carrySelect(n)),
  nBit('cskip', 'Carry-skip adder', 'arithmetic', [8, 16, 32], 16, (n) => `cskip${n}_4`, (n) => carrySkip(n)),
  { id: 'bcd', name: 'BCD adder', category: 'arithmetic', params: [count('digits', [2, 3, 4], 2)], key: (p) => `bcd${p.digits}`, make: (p) => bcdAdder(p.digits) },
  nBit('addsubks', 'Fast adder / subtractor', 'arithmetic', [4, 8, 16, 32], 8, (n) => `addsubks${n}`, addSubFast),
  nBit('shift', 'Barrel shifter', 'arithmetic', [4, 8, 16, 32], 8, (n) => `shift${n}`, shifter),
  nBit('shl', 'Left shifter', 'arithmetic', [4, 8, 16, 32], 8, (n) => `shl${n}_${log2(n)}`, (n) => shiftLeft(n, log2(n))),
  nBit('lzc', 'Leading-zero counter', 'arithmetic', [2, 4, 8, 16, 32], 8, (n) => `lzc${n}`, lzc),
  nBit('cneg', 'Conditional negate', 'arithmetic', [4, 8, 16, 32], 8, (n) => `cneg${n}`, condNegate),
  nBit('csa', 'Carry-save adder', 'arithmetic', [2, 4, 8, 16], 4, (n) => `csa${n}`, csa),
  nBit('amul', 'Array multiplier', 'arithmetic', [2, 4, 8, 16], 4, (n) => `amul${n}`, arrayMul),
  {
    id: 'wmul', name: 'Wallace-tree multiplier', category: 'arithmetic', params: [bits([4, 8, 16], 8), flag('signed', 'signed', 'unsigned')],
    key: (p) => `wmul${p.bits}${p.signed ? 's' : ''}`, make: (p) => treeMul(p.bits, p.signed === 1),
  },
  nBit('bmul', 'Booth multiplier (signed)', 'arithmetic', [4, 8, 16, 32], 8, (n) => `bmul${n}`, boothMul),
  nBit('divstep', 'Division step (restoring)', 'arithmetic', [2, 4, 8, 16, 32], 4, (n) => `divstep${n}${n >= 16 ? 'f' : ''}`, (n) => divStep(n)),
  nBit('adiv', 'Array divider', 'arithmetic', [2, 4, 8, 16], 4, (n) => `adiv${n}`, arrayDiv),
  nBit('nrstep', 'Division step (non-restoring)', 'arithmetic', [2, 4, 8, 16, 32], 4, (n) => `nrstep${n}${n >= 16 ? 'f' : ''}`, (n) => nrDivStep(n)),
  nBit('nrdiv', 'Non-restoring array divider', 'arithmetic', [2, 4, 8, 16], 4, (n) => `nrdiv${n}`, nrArrayDiv),
  nBit('srt4step', 'Radix-4 SRT division step', 'arithmetic', [4, 8, 16, 32], 8, (n) => `srt4step${n}`, srt4Step),
  nBit('srtstep', 'SRT division step', 'arithmetic', [4, 8, 16, 32], 8, (n) => `srtstep${n}`, srtStep),
  float('fpun', 'Float unpack', fpUnpack),
  float('fpadd', 'Float adder / subtractor', fpAdd),
  float('fpmul', 'Float multiplier', fpMul),
  float('fpcmp', 'Float comparator', fpCompare),
  nBit('popcnt', 'Population count', 'arithmetic', [2, 4, 8, 16, 32], 8, (n) => `popcnt${n}`, popcount),
  nBit('abs', 'Absolute value', 'arithmetic', [4, 8, 16, 32], 8, (n) => `abs${n}`, absValue),
  // gates
  { id: 'pla', name: 'PLA (AND + OR planes)', category: 'gate', params: [{ name: 'function', values: [0, 1], initial: 0, label: (v) => PLAS[v] }], key: (p) => `pla_${PLAS[p.function]}`, make: (p) => pla(PLAS[p.function]) },
  nBit('parity', 'Parity', 'gate', [3, 4, 8, 16, 32], 8, (n) => `parity${n}`, parity),
  { id: 'hamenc', name: 'Hamming SEC-DED encoder', category: 'gate', params: [count('data bits', [4, 8, 16], 8)], key: (p) => `hamenc${p['data bits']}`, make: (p) => hammingEnc(p['data bits']) },
  { id: 'hamdec', name: 'Hamming SEC-DED decoder', category: 'gate', params: [count('data bits', [4, 8, 16], 8)], key: (p) => `hamdec${p['data bits']}`, make: (p) => hammingDec(p['data bits']) },
  { id: 'ecc', name: 'SEC-DED round trip', category: 'gate', params: [count('data bits', [4, 8, 16], 8)], key: (p) => `ecc${p['data bits']}`, make: (p) => eccChannel(p['data bits']) },
  { id: 'and', name: 'Wide AND', category: 'gate', params: [count('inputs', [3, 4, 5, 6, 8], 4)], key: (p) => `and${p.inputs}`, make: (p) => andN(p.inputs) },
  { id: 'or', name: 'Wide OR', category: 'gate', params: [count('inputs', [3, 4, 8, 16, 32], 4)], key: (p) => `or${p.inputs}`, make: (p) => orN(p.inputs) },
  {
    id: 'bitwise', name: 'Bitwise operation', category: 'gate',
    params: [{ name: 'op', values: [0, 1, 2], initial: 0, label: (v) => OPS[v].toUpperCase() }, bits([4, 8, 16, 32], 8)],
    key: (p) => `${OPS[p.op]}x${p.bits}`, make: (p) => bitwise(OPS[p.op], p.bits),
  },
  nBit('zero', 'Zero detect', 'gate', [4, 8, 16, 32], 8, (n) => `zero${n}`, isZero),
  // routing
  {
    id: 'dec', name: 'Decoder', category: 'routing',
    params: [bits([1, 2, 3, 4], 2), flag('enable', 'with enable', 'no enable')],
    key: (p) => `dec${p.bits}${p.enable ? 'e' : ''}`, make: (p) => decoder(p.bits, p.enable === 1),
  },
  nBit('mux2x', 'Bus multiplexer 2:1', 'routing', [2, 4, 8, 16], 4, (n) => `mux2x${n}`, busMux2),
  {
    id: 'mux', name: 'Multiplexer tree', category: 'routing',
    params: [count('inputs', [2, 4, 8, 16], 4), bits([1, 2, 4, 8], 1)],
    key: (p) => (p.inputs === 2 ? `mux2tree${p.bits}` : `mux${p.inputs}x${p.bits}`), make: (p) => muxTree(log2(p.inputs), p.bits),
  },
  {
    id: 'cmp', name: 'Magnitude comparator', category: 'routing', params: [bits([2, 4, 8, 16, 32], 4), flag('signed', 'signed', 'unsigned')],
    key: (p) => `cmp${p.bits}${p.signed ? 's' : ''}`, make: (p) => magComparator(p.bits, p.signed === 1),
  },
  { id: 'prienc', name: 'Priority encoder', category: 'routing', params: [count('inputs', [2, 4, 8, 16, 32], 8)], key: (p) => `prienc${p.inputs}`, make: (p) => priorityEncoder(p.inputs) },
  { id: 'enc', name: 'Encoder', category: 'routing', params: [count('inputs', [4, 8, 16], 8)], key: (p) => `enc${p.inputs}`, make: (p) => encoder(p.inputs) },
  {
    id: 'demux', name: 'Demultiplexer', category: 'routing', params: [count('outputs', [2, 4, 8], 4), bits([1, 4, 8], 1)],
    key: (p) => `demux${p.outputs}x${p.bits}`, make: (p) => demux(log2(p.outputs), p.bits),
  },
  nBit('eq', 'Equality comparator', 'routing', [2, 4, 8, 16, 32], 4, (n) => `eq${n}`, equal),
  // sequential
  nBit('reg', 'Register', 'sequential', [1, 2, 4, 8, 16], 4, (n) => `reg${n}`, register),
  nBit('creg', 'Register with clear', 'sequential', [1, 4, 8, 16, 32], 4, (n) => `creg${n}`, clearableRegister),
  nBit('counter', 'Counter', 'sequential', [2, 3, 4, 8], 4, (n) => `counter${n}`, counter),
  nBit('smul', 'Iterative multiplier', 'sequential', [4, 8, 16, 32], 8, (n) => `smul${n}`, seqMul),
  nBit('pmul', 'Pipelined multiplier', 'sequential', [4, 8, 16, 32], 8, (n) => `pmul${n}`, pipeMul),
  nBit('updown', 'Up/down counter', 'sequential', [2, 4, 8, 16], 4, (n) => `updown${n}`, upDownCounter),
  nBit('shreg', 'Universal shift register', 'sequential', [4, 8, 16], 4, (n) => `shreg${n}`, shiftRegister),
  nBit('lfsr', 'LFSR', 'sequential', [3, 4, 5, 8, 16], 4, (n) => `lfsr${n}`, lfsr),
  nBit('ring', 'Ring counter', 'sequential', [3, 4, 8], 4, (n) => `ring${n}`, (n) => ringCounter(n)),
  nBit('johnson', 'Johnson counter', 'sequential', [3, 4, 8], 4, (n) => `johnson${n}`, (n) => ringCounter(n, true)),
  { id: 'clkdiv', name: 'Ripple clock divider', category: 'sequential', params: [count('stages', [1, 2, 3, 4, 8], 3)], key: (p) => `clkdiv${p.stages}`, make: (p) => clockDivider(p.stages) },
  nBit('sdiv', 'Iterative divider', 'sequential', [4, 8, 16, 32], 8, (n) => `sdiv${n}`, seqDivider),
  nBit('nrsdiv', 'Iterative non-restoring divider', 'sequential', [4, 8, 16, 32], 8, (n) => `nrsdiv${n}`, nrSeqDivider),
  nBit('srt4div', 'Iterative radix-4 SRT divider', 'sequential', [4, 8, 16, 32], 8, (n) => `srt4div${n}`, srt4Divider),
  nBit('srtdiv', 'Iterative SRT divider', 'sequential', [4, 8, 16, 32], 8, (n) => `srtdiv${n}`, srtDivider),
  nBit('iter', 'Iteration control', 'sequential', [4, 8, 16, 32], 8, (n) => `iter${n}`, iterCtrl),
  // memory
  {
    id: 'ram', name: 'Memory (RAM)', category: 'memory',
    params: [count('words', [4, 8, 16, 32, 64], 16), bits([4, 8, 16], 8)],
    key: (p) => `ram${p.words}x${p.bits}`, make: (p) => ram(log2(p.words), p.bits),
  },
  {
    id: 'rom', name: 'ROM (decoder + OR plane)', category: 'memory', params: [{ name: 'contents', values: [0, 1, 2], initial: 0, label: (v) => ROMS[v] }],
    key: (p) => `rom_${ROMS[p.contents]}`, make: (p) => romArray(ROMS[p.contents]),
  },
  {
    id: 'fifo', name: 'FIFO', category: 'memory', params: [count('words', [4, 8, 16], 4), bits([4, 8], 8)],
    key: (p) => `fifo${p.words}x${p.bits}`, make: (p) => fifo(log2(p.words), p.bits),
  },
  {
    id: 'stack', name: 'Stack', category: 'memory', params: [count('words', [4, 8, 16], 4), bits([4, 8], 8)],
    key: (p) => `stack${p.words}x${p.bits}`, make: (p) => stack(log2(p.words), p.bits),
  },
  {
    id: 'cam', name: 'Content-addressable memory', category: 'memory', params: [count('entries', [2, 4, 8], 4), bits([4, 8], 4)],
    key: (p) => `cam${p.entries}x${p.bits}`, make: (p) => cam(log2(p.entries), p.bits),
  },
  {
    id: 'rfmp', name: 'Multi-ported register file', category: 'memory',
    params: [count('registers', [4, 8], 4), count('read ports', [2, 4], 4), count('write ports', [1, 2], 2)],
    key: (p) => `rfmp${p.registers}x8_${p['read ports']}r${p['write ports']}w`, make: (p) => regfileMP(log2(p.registers), 8, p['read ports'], p['write ports'] as 1 | 2),
  },
  {
    id: 'regfile', name: 'Register file', category: 'memory',
    params: [count('registers', [4, 8, 16, 32], 8), bits([4, 8, 16, 32], 8)],
    key: (p) => `regfile${p.registers}x${p.bits}`, make: (p) => regfile(log2(p.registers), p.bits),
  },
  {
    id: 'bmem', name: 'Byte-banked memory', category: 'memory', params: [count('words', [16, 32, 64], 16)],
    key: (p) => `bmem${log2(p.words)}`, make: (p) => bankedMemory(log2(p.words)),
  },
  {
    id: 'sram', name: 'SRAM array (transistor level)', category: 'memory',
    params: [count('rows', [2, 4, 8], 4), count('columns', [1, 2, 4, 8], 4)],
    key: (p) => `sram${p.rows}x${p.columns}`, make: (p) => sramArray(p.rows, p.columns),
  },
  { id: 'sramcolio', name: 'SRAM column with I/O', category: 'memory', params: [count('cells', [2, 4, 8], 4)], key: (p) => `sramcolio${p.cells}`, make: (p) => sramColumn(p.cells) },
  {
    id: 'dcache', name: 'Memory with a cache', category: 'memory',
    params: [count('memory words', [64, 128, 256], 64), count('cache lines', [2, 4, 8], 4)],
    key: (p) => `dcache${log2(p['memory words'])}_${log2(p['cache lines'])}`,
    make: (p) => cachedMemory(log2(p['memory words']), log2(p['cache lines'])),
  },
  {
    id: 'wbcache', name: 'Memory with a write-back cache', category: 'memory',
    params: [count('cache lines', [4, 8], 4), count('ways', [1, 2], 1)],
    key: (p) => `wbcache6_${Math.round(Math.log2(p['cache lines'] / p.ways))}_${p.ways}`,
    make: (p) => wbCache(6, Math.round(Math.log2(p['cache lines'] / p.ways)), p.ways as 1 | 2),
  },
  {
    id: 'way2', name: '2-way tag compare', category: 'memory',
    params: [count('tag bits', [2, 3, 4, 8], 3), bits([4, 8, 32], 8)],
    key: (p) => `way2_${p['tag bits']}_${p.bits}`, make: (p) => wayLookup2(p['tag bits'], p.bits),
  },
  // wiring
  nBit('zext', 'Zero-extend 1 → n', 'plumbing', [2, 4, 8, 32], 8, (n) => `zext${n}`, zext),
];

export function combos(f: Family): P[] {
  let out: P[] = [{}];
  for (const p of f.params) out = out.flatMap((o) => p.values.map((v) => ({ ...o, [p.name]: v })));
  return out;
}

export const initialParams = (f: Family): P => Object.fromEntries(f.params.map((p) => [p.name, p.initial]));

let index: Map<string, { fam: Family; values: P }> | null = null;

/** The family (and parameter values) that generates this id, if any. */
export function familyOf(id: string): { fam: Family; values: P } | null {
  if (!index) {
    index = new Map();
    for (const fam of families) for (const values of combos(fam)) {
      const k = fam.key(values);
      if (!index.has(k)) index.set(k, { fam, values });
    }
  }
  return index.get(id) ?? null;
}

/** Every component reachable from the registry, including generated sub-components. */
export function reachableDefs(): ComponentDef[] {
  const seen = new Set<ComponentDef>();
  const visit = (d: ComponentDef) => {
    if (seen.has(d)) return;
    seen.add(d);
    for (const i of netlistOf(d)?.instances ?? []) visit(i.def);
  };
  for (const d of registry.values()) visit(d);
  return [...seen];
}

let defs: { size: number; map: Map<string, ComponentDef> } | null = null;

/**
 * id → definition over reachableDefs(). Rebuilt when the registry has grown (generators
 * register as they are first called), so a stored design can find any part by id.
 */
export function defIndex(): Map<string, ComponentDef> {
  if (!defs || defs.size !== registry.size) {
    const map = new Map<string, ComponentDef>();
    for (const d of reachableDefs()) if (!map.has(d.id)) map.set(d.id, d);
    defs = { size: registry.size, map };
  }
  return defs.map;
}
