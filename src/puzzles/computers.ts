// The computers a puzzle can be started on without wiring anything: the sandbox's CPUs with a program ROM,
// a little RAM where the ISA has loads, a halt detector and the two puzzle ports already connected. Each is
// built as a netlist (Builder) and drawn as a chip document (docFromDef), so it opens, edits and checks like
// a chip the learner drew. Their I/O, which the reference programs (refs.ts) follow:
//
//   4-bit (4004)  RDR reads the next word from IN (A ← data), WRR writes A to OUT (any port), JCN TN / TZ
//                 test `ready` on the TEST pin (TN: a word waits). A word of 8 bits comes as two nibbles,
//                 high first, and leaves the same way. Halts on JUN to itself.
//   RV16          lw rd, -4(x0) reads IN (0xFFFC), sw rs, -3(x0) writes OUT (0xFFFD); 64 words of RAM at
//                 0 … 63. Halts on `halt` (jal x0, 0).
//   RV32I         lw from 0x8000_0000 reads IN, sw to 0x8000_0004 writes OUT (lui s0, 0x80000 then 0(s0) /
//                 4(s0)); 64 words of RAM at 0 … 0xFC. Halts on `j .`.
//
// A chip of the learner's own gets the two ports (and a halt part when it has none) placed beside it,
// unwired: wiring them to its I/O is part of the puzzle.

import { constWord } from '../lib/alu';
import { Builder } from '../lib/builder';
import { busMux2, equal } from '../lib/combinational';
import { CPU4_ACC, CPU4_ALU, CPU4_DECODE, CPU4_PC, CPU4_REGS } from '../lib/cpu4';
import { merger, splitter } from '../lib/define';
import { AND, NOT } from '../lib/gates';
import { resolveComponent } from '../lib/resolve';
import { RV16_CORE } from '../lib/rv16/cpu';
import { EQ16 } from '../lib/rv16/logic';
import { TIE0, TIE1 } from '../lib/transistors';
import type { ComponentDef, PortDef } from '../sim/types';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartDoc, PartRef } from '../editor/model';
import { isError, partDef } from '../editor/parts';
import { puzzleIn, puzzleOut, puzzlePortOf } from '../editor/puzzleparts';
import { symbolGeom } from '../sim/geometry';

/** The computers offered ready-wired, and the ISA their ROM speaks. */
export type RefCpu = 'cpu4' | 'rv16' | 'rv32';

export interface RefComputer {
  id: RefCpu;
  name: string;
  /** The ROM's language (editor/program.ts). */
  lang: 'cpu4' | 'rv16' | 'asm';
  /** Bits of the puzzle ports. */
  width: number;
  /** What a program does to read, write and halt (HTML). */
  io: string;
}

export const REF_COMPUTERS: RefComputer[] = [
  {
    id: 'cpu4', name: '4-bit CPU (4004)', lang: 'cpu4', width: 4,
    io: '<code>RDR</code> reads the next nibble from IN, <code>WRR</code> writes A to OUT, <code>JCN TN</code> jumps while a nibble waits (TEST = ready). An 8-bit word comes as two nibbles, high first, and leaves the same way. <code>JUN</code> to itself halts.',
  },
  {
    id: 'rv16', name: 'RV16 single-cycle', lang: 'rv16', width: 16,
    io: '<code>lw rd, -4(x0)</code> reads IN, <code>sw rs, -3(x0)</code> writes OUT; 64 words of RAM at 0 … 63; <code>halt</code> stops.',
  },
  {
    id: 'rv32', name: 'RV32I single-cycle', lang: 'asm', width: 32,
    io: '<code>lui s0, 0x80000</code>, then <code>lw rd, 0(s0)</code> reads IN and <code>sw rs, 4(s0)</code> writes OUT; 64 words of RAM at 0 … 0xFC; <code>j .</code> halts.',
  },
];

export const REF_BY_ID = new Map(REF_COMPUTERS.map((c) => [c.id, c]));

/** The program ROM of a puzzle computer: 256 words. */
export const PUZZLE_ROM_K = 8;

export function romRefOf(cpu: RefCpu, src: string): PartRef {
  if (cpu === 'rv32') return { rom: { k: PUZZLE_ROM_K, w: 32, addr: 'rv32', lang: 'asm', src } };
  return { rom: { k: PUZZLE_ROM_K, w: 16, addr: 'word', lang: cpu === 'cpu4' ? 'cpu4' : 'rv16', src } };
}

function must<T extends object>(r: T | { error: string }): T {
  if ('error' in r) throw new Error(`puzzle computer: ${r.error}`);
  return r;
}

const HALT_REF: PartRef = { display: 'halt', width: 1 };
const RAM16_REF: PartRef = { ram: { k: 6, w: 16 } };
const RAM32_REF: PartRef = { ram: { k: 6, w: 32 } };
const CLK: PortDef = { name: 'clk', width: 1, dir: 'in', clock: true };

/** The netlist of a puzzle computer around `rom` (the ROM part's own def). */
function computerDef(cpu: RefCpu, rom: ComponentDef): ComponentDef {
  const halt = must(partDef(HALT_REF, () => undefined));
  const b = new Builder(10, 12, 6);
  b.pins('clk');
  if (cpu === 'cpu4') {
    // cpu4() (lib/cpu4.ts) without its output ports: the switches' input is PUZZLE IN, WRR writes PUZZLE OUT.
    const r = b.op(rom, [''], 'program', 'rom');
    const instr = b.name(`${r}.data`, 'instr', true);
    const fl = b.op(splitter([8, 4, 4], 4), [instr], 'fields');
    const lo = b.name(`${fl}.o0`, 'lo', true), opa = b.name(`${fl}.o1`, 'opa', true);
    const hi = b.op1(merger([4, 4], 2), [opa, b.name(`${fl}.o2`, 'opr', true)], 'OPR:OPA');
    const isJun = b.op1(equal(8), [hi, b.op1(constWord(8, 0x40), [], 'JUN')], 'JUN?');
    const self = b.op(equal(8), [lo, ''], 'to itself?');
    b.next();
    const pin = b.op(puzzleIn(4), ['', 'clk'], 'puzzle in', 'pzin');
    const dec = b.op(CPU4_DECODE, [instr, '', '', b.name(`${pin}.ready`, 'ready', true), ''], 'Decode', 'dec');
    const c = (n: string) => b.name(`${dec}.${n}`, n, true);
    const regs = b.op(CPU4_REGS, [opa, '', lo, c('rwe'), c('winc'), c('pwe'), 'clk'], 'Index regs', 'regs');
    const rr = b.name(`${regs}.r`, 'r', true), pair = b.name(`${regs}.pair`, 'pair', true);
    b.wire(b.name(`${regs}.rz`, 'rz', true), `${dec}.rz`);
    b.op(halt, [b.name(b.op1(AND, [isJun, `${self}.eq`], 'halt'), 'halts', true)], 'halt', 'halt');
    b.next();
    const alu = b.op(CPU4_ALU, ['', rr, '', c('xa'), c('inv'), c('bk'), c('k'), c('cin'), c('f'), c('csel'), c('orcy'), c('cconst')], 'ALU 4', 'alu');
    const acc = b.op(CPU4_ACC, [b.name(`${alu}.y`, 'result', true), rr, opa, b.name(`${pin}.data`, 'in', true), c('asel'), c('awe'), b.name(`${alu}.cout`, 'cyn', true), c('cwe'), 'clk'], 'Acc & carry', 'acc');
    const a = b.name(`${acc}.a`, 'a', true), cy = b.name(`${acc}.cy`, 'cy', true);
    for (const s of [`${dec}.acc`, `${regs}.a`, `${alu}.a`]) b.wire(a, s);
    for (const s of [`${dec}.cy`, `${alu}.cy`]) b.wire(cy, s);
    // RDR is the only instruction with asel = 3 (A ← the input): it takes the word.
    const as = b.op(splitter([1, 1], 2), [c('asel')], 'asel');
    b.wire(b.name(b.op1(AND, [`${as}.o0`, `${as}.o1`], 'RDR?'), 'read', true), `${pin}.read`);
    b.next();
    const pcs = b.op(CPU4_PC, [c('pcsel'), lo, pair, c('push'), c('pop'), 'clk'], 'PC & stack', 'pcs');
    const pc = b.name(`${pcs}.pc`, 'pc', true);
    b.wire(pc, `${r}.addr`);
    b.wire(pc, `${self}.b`);
    b.op(puzzleOut(4), [a, c('wrr'), 'clk'], 'puzzle out', 'pzout');
  } else if (cpu === 'rv16') {
    const ram = must(partDef(RAM16_REF, () => undefined));
    const core = b.op(RV16_CORE, ['clk', b.op1(TIE0, [], 'no reset'), '', ''], 'RV16 core', 'cpu');
    const daddr = b.name(`${core}.daddr`, 'daddr', true), dw = b.name(`${core}.dwdata`, 'dwdata', true), dwe = b.name(`${core}.dwe`, 'dwe', true);
    b.next();
    const ps = b.op(splitter([PUZZLE_ROM_K, 16 - PUZZLE_ROM_K], 4), [`${core}.pc`], 'pc');
    const r = b.op(rom, [`${ps}.o0`], 'program', 'rom');
    const instr = b.name(`${r}.data`, 'instr', true);
    const ds = b.op(splitter([6, 9, 1], 4), [daddr], 'address');
    const isIn = b.op1(EQ16, [daddr, b.op1(constWord(16, 0xfffc), [], 'IN')], '= IN');
    const isOut = b.op1(EQ16, [daddr, b.op1(constWord(16, 0xfffd), [], 'OUT')], '= OUT');
    const os = b.op(splitter([4, 12], 4), [instr], 'opcode');
    const isLw = b.op1(equal(4), [`${os}.o0`, b.op1(constWord(4, 6), [], 'LW')], 'lw?');
    const isHalt = b.op1(EQ16, [instr, b.op1(constWord(16, 0x000c), [], 'halt')], 'halt?');
    b.next();
    const ramWe = b.op1(AND, [dwe, b.op1(NOT, [b.name(`${ds}.o2`, 'io', true)])], 'RAM write');
    const outWe = b.op1(AND, [dwe, isOut], 'OUT write');
    const read = b.op1(AND, [isLw, isIn], 'IN read');
    b.op(halt, [isHalt], 'halt', 'halt');
    b.next();
    const m = b.op(ram, [`${ds}.o0`, dw, ramWe, 'clk'], 'data (64 words)', 'ram');
    const pin = b.op(puzzleIn(16), [read, 'clk'], 'puzzle in', 'pzin');
    b.op(puzzleOut(16), [dw, outWe, 'clk'], 'puzzle out', 'pzout');
    b.next();
    b.wire(b.op1(busMux2(16), [`${m}.dout`, `${pin}.data`, isIn], 'read data'), `${core}.drdata`);
    b.wire(instr, `${core}.instr`);
  } else {
    const ram = must(partDef(RAM32_REF, () => undefined));
    const core = b.op(resolveComponent('rv32i_core')!, ['clk', '', b.op1(constWord(32, 0), [], 'hart 0'), '', b.op1(TIE1, [], 'granted')], 'RV32I core', 'cpu');
    const addr = b.name(`${core}.memAddr`, 'addr', true), dw = b.name(`${core}.memWData`, 'wdata', true);
    const we = b.name(`${core}.memWE`, 'we', true), req = b.name(`${core}.memReq`, 'req', true);
    b.next();
    const r = b.op(rom, [b.name(`${core}.pcOut`, 'pc', true)], 'program', 'rom');
    const instr = b.name(`${r}.data`, 'instr', true);
    const as = b.op(splitter([2, 6, 23, 1], 4), [addr], 'address');
    const bs = b.op(splitter([2, 1, 29], 4), [addr], 'bit 2');
    const isHalt = b.op1(resolveComponent('eq32')!, [instr, b.op1(constWord(32, 0x6f), [], 'j .')], 'halt?');
    b.next();
    const io = b.name(`${as}.o3`, 'io', true), b2 = b.name(`${bs}.o1`, 'b2', true);
    const isIn = b.op1(AND, [io, b.op1(NOT, [b2])], '= IN');
    const isOut = b.op1(AND, [io, b2], '= OUT');
    const load = b.op1(AND, [req, b.op1(NOT, [we])], 'load');
    b.op(halt, [isHalt], 'halt', 'halt');
    b.next();
    const ramWe = b.op1(AND, [we, b.op1(NOT, [io])], 'RAM write');
    const outWe = b.op1(AND, [we, isOut], 'OUT write');
    const read = b.op1(AND, [load, isIn], 'IN read');
    b.next();
    const m = b.op(ram, [`${as}.o1`, dw, ramWe, 'clk'], 'data (64 words)', 'ram');
    const pin = b.op(puzzleIn(32), [read, 'clk'], 'puzzle in', 'pzin');
    b.op(puzzleOut(32), [dw, outWe, 'clk'], 'puzzle out', 'pzout');
    b.next();
    b.wire(b.op1(busMux2(32), [`${m}.dout`, `${pin}.data`, io], 'read data'), `${core}.memRData`);
    b.wire(instr, `${core}.instr`);
  }
  return {
    id: `pz_${cpu}`, name: 'puzzle computer', category: 'cpu', symbol: { kind: 'box', label: 'COMPUTER' },
    ports: [CLK],
    netlist: () => ({ pins: { clk: [0, 4] }, instances: b.instances, nets: b.nets() }),
  };
}

/** A ready-wired puzzle computer as a chip document, its ROM holding `src`. */
export function computerChip(cpu: RefCpu, id: string, name: string, src: string): ChipDoc {
  const romRef = romRefOf(cpu, src);
  const rom = must(partDef(romRef, () => undefined));
  const halt = must(partDef(HALT_REF, () => undefined));
  const ram16 = must(partDef(RAM16_REF, () => undefined)), ram32 = must(partDef(RAM32_REF, () => undefined));
  const def = computerDef(cpu, rom);
  const doc = must(docFromDef(def, {
    id, name,
    refOf: (d) => {
      if (d === rom) return romRef;
      if (d === halt) return HALT_REF;
      if (d === ram16) return RAM16_REF;
      if (d === ram32) return RAM32_REF;
      if (d === TIE0) return { const: { width: 1, value: 0 } };
      if (d === TIE1) return { const: { width: 1, value: 1 } };
      const pz = puzzlePortOf(d);
      if (pz) return { puzzle: pz.kind, width: pz.width };
      return undefined;
    },
  }));
  return { ...doc, notes: `${REF_BY_ID.get(cpu)!.name} ready for the puzzles. ${stripTags(REF_BY_ID.get(cpu)!.io)}` };
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

/**
 * A copy of the learner's chip `doc` for a puzzle: the same parts and wires, the two puzzle ports (`width`
 * bits) and, if it has none, a halt part, placed unwired to the right of everything.
 */
export function copyForPuzzle(doc: ChipDoc, id: string, name: string, width: number, hasHalt: boolean): ChipDoc {
  const defOf = (r: PartRef) => partDef(r, () => undefined);
  let right = 0, top = Infinity;
  for (const p of doc.parts) {
    const d = defOf(p.ref);
    const w = d && !isError(d) ? symbolGeom(d).w : 6;
    right = Math.max(right, p.at[0] + w);
    top = Math.min(top, p.at[1]);
  }
  for (const p of doc.pins) right = Math.max(right, p.at[0] + 2);
  if (!Number.isFinite(top)) top = 2;
  const x = Math.ceil(right / 2) * 2 + 8;
  const used = new Set(doc.parts.map((p) => p.id));
  const free = (base: string) => { let n = base, i = 2; while (used.has(n)) n = `${base}${i++}`; used.add(n); return n; };
  const add: PartDoc[] = [
    { id: free('pzin'), ref: { puzzle: 'in', width }, at: [x, top], label: 'puzzle in' },
    { id: free('pzout'), ref: { puzzle: 'out', width }, at: [x, top + 10], label: 'puzzle out' },
  ];
  if (!hasHalt) add.push({ id: free('halt'), ref: HALT_REF, at: [x, top + 20] });
  return {
    ...structuredClone(doc), id, name, parts: [...structuredClone(doc.parts), ...add],
    notes: `A copy of “${doc.name}” for a puzzle: wire PUZZLE IN (data, ready; read = 1 at a rising clock edge takes a word) and PUZZLE OUT (data, we, clk) to your CPU's I/O, and the halt part to something that reads 1 when the program is done.${doc.notes ? `\n\n${doc.notes}` : ''}`,
  };
}
