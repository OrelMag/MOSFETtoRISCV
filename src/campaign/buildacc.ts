// Act 3's optional level "A first computer" (chapter 'firstcomputer'): the eight-instruction accumulator machine without
// its ROM. The learner's chip takes the instruction word on instr and shows its PC on pc; the bench is the ROM, one
// program per BitSim lane (the chapter's three, then random ones), and compares pc, out and halt with the golden model
// (acc8/acc8.ts) after every clock. Given parts: the reference's own building blocks (the register, incrementer,
// multiplexers, adder / subtractor, zero test, decoder, comparator, gates and the RAM). No DOM.

import { ACC_OPS, ACC_PROGRAMS, AccISS, accAssemble } from '../acc8/acc8';
import type { BuildChallenge, CustomRun, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { ACC8_CORE, ACC_CTL } from '../lib/acc8';
import type { ComponentDef } from '../sim/types';
import { analyzeTiming } from '../sim/timing';
import { flatten } from '../sim/flatten';
import { bitBench, gateBench } from './corecheck';

/** Clocks each program runs: past the end of the chapter's longest (1 + … + 10, 91 clocks). */
export const ACC_BENCH_CLOCKS = 120;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random ROM of 32 words, jumps a little rarer so a program does not fall into a short loop at once. */
export function accRandomRom(seed: number): number[] {
  const r = rng(seed);
  return Array.from({ length: 32 }, () => {
    let w = Math.floor(r() * 256);
    while ((w >> 5 === 5 || w >> 5 === 6) && r() < 0.6) w = Math.floor(r() * 256);
    return w;
  });
}

const NAMED: [string, number[]][] = [
  ['6 × 7', accAssemble(ACC_PROGRAMS.mul)],
  ['the countdown', accAssemble(ACC_PROGRAMS.countdown)],
  ['1 + … + 10', accAssemble(ACC_PROGRAMS.sum)],
];

/** The bench's programs: the chapter's three, then random ROMs up to 32 (one BitSim word). */
export const ACC_BENCH_PROGRAMS: [string, number[]][] = [
  ...NAMED, ...Array.from({ length: 29 }, (_, i): [string, number[]] => [`random program ${i + 1}`, accRandomRom(1000 + i)]),
];

export function accBench(def: ComponentDef): CustomRun {
  const progs = ACC_BENCH_PROGRAMS;
  const b = bitBench(def);
  const benches = b ? [{ bench: b, lanes: progs.map((_, i) => i) }] : progs.map((_, i) => ({ bench: gateBench(def), lanes: [i] }));
  const failures: string[] = [], failed = new Set<number>();
  for (const { bench, lanes } of benches) {
    const iss = lanes.map((i) => new AccISS(progs[i][1]));
    const rows = (p: string) => bench.get(p).slice(0, lanes.length);
    const fill = (v: number[]) => [...v, ...new Array(Math.max(0, bench.lanes - v.length)).fill(0)];
    bench.set('clk', fill(lanes.map(() => 0)));
    for (let c = 0; c < ACC_BENCH_CLOCKS; c++) {
      bench.settle();
      const pcs = rows('pc');
      lanes.forEach((i, l) => {
        if (failed.has(i)) return;
        const m = iss[l];
        if (pcs[l] !== m.pc) { failed.add(i); failures.push(`${progs[i][0]}: before clock ${c + 1}, pc is ${pcs[l]}, the golden model's is ${m.pc}`); }
      });
      bench.set('instr', fill(lanes.map((i, l) => progs[i][1][iss[l].pc] ?? 0)));
      bench.settle();
      const halt = rows('halt');
      lanes.forEach((i, l) => {
        if (failed.has(i)) return;
        const m = iss[l], w = m.word, want = +(ACC_OPS[w >> 5] === 'JMP' && (w & 31) === m.pc);
        if (halt[l] !== want) { failed.add(i); failures.push(`${progs[i][0]}: at pc ${m.pc} (${ACC_OPS[w >> 5]} ${w & 31}) halt is ${halt[l]}, should be ${want}`); }
      });
      bench.set('clk', fill(lanes.map(() => 1)));
      bench.settle();
      bench.set('clk', fill(lanes.map(() => 0)));
      bench.settle();
      const outs = rows('out');
      lanes.forEach((i, l) => {
        if (failed.has(i)) return;
        const m = iss[l], w = m.word;
        m.step();
        if (outs[l] !== m.out) { failed.add(i); failures.push(`${progs[i][0]}: after clock ${c + 1} (${ACC_OPS[w >> 5]}${ACC_OPS[w >> 5] === 'OUT' ? '' : ` ${w & 31}`}), out is ${outs[l]}, the golden model's is ${m.out}`); }
      });
    }
  }
  const report = analyzeTiming(flatten(def, { mode: 'gate' }));
  return {
    failures: failures.slice(0, 3), tested: progs.length, cycles: progs.length * ACC_BENCH_CLOCKS,
    ...(report ? { period: report.period } : {}), failed: [...failed].sort((a, b) => a - b),
  };
}

const pins: PinSpec[] = [
  { name: 'clk', dir: 'in', width: 1, clock: true }, { name: 'instr', dir: 'in', width: 8 },
  { name: 'pc', dir: 'out', width: 5 }, { name: 'out', dir: 'out', width: 8 }, { name: 'halt', dir: 'out', width: 1 },
];

/** The reference's building blocks (given to the level): every distinct library part of ACC8_CORE and its control. */
export function accGives(): string[] {
  const ids = new Set<string>();
  for (const d of [ACC8_CORE, ACC_CTL]) for (const i of d.netlist!().instances) if (i.def !== ACC_CTL && !i.def.prim?.startsWith('alias')) ids.add(i.def.id);
  return [...ids].sort();
}

let answer: ChipDoc[] | null = null;

export const BUILDACC: Record<string, () => BuildChallenge> = {
  m_acc: () => ({
    id: 'm_acc', title: 'A first computer', level: 'sequential', allowed: 'nand',
    brief: `The eight-instruction machine of the chapter, without its ROM: at every rising edge of <code>clk</code> it executes
      the 8-bit word on <code>instr</code> (op = bits 7–5: LDA ADD SUB STA LDI JMP JZ OUT; x = bits 4–0) and its PC moves on,
      shown on <code>pc</code>. <code>out</code> is the OUT register; <code>halt</code> = 1 while instr is a JMP to the PC.
      A 32-byte RAM at address x holds the data; everything powers on at 0. The bench is the ROM: ${ACC_BENCH_PROGRAMS.length}
      programs, ${ACC_BENCH_CLOCKS} clocks each, against the golden model.`,
    ports: pins,
    check: { kind: 'custom', describe: `${ACC_BENCH_PROGRAMS.length} programs (the chapter's three and random ones), ${ACC_BENCH_CLOCKS} clocks each, pc / out / halt every clock`, run: (def) => accBench(def), unit: 'program' },
    answer: () => (answer ??= (() => {
      const ctl = docFromDef(ACC_CTL, { id: 'u_ref_cp_m_acc_ctl', name: 'Control' });
      if ('error' in ctl) throw new Error(`reference m_acc control: ${ctl.error}`);
      const doc = docFromDef(ACC8_CORE, { id: 'u_ref_cp_m_acc', name: 'First computer ref', refOf: (d) => (d === ACC_CTL ? { chip: ctl.id } : undefined) });
      if ('error' in doc) throw new Error(`reference m_acc: ${doc.error}`);
      return [ctl, { ...doc, notes: `Reference answer. ${ACC8_CORE.summary}` }];
    })()),
  }),
};
