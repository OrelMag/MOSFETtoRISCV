// Chapter 26's quoted numbers, recomputed from the models (riscv/ilp.ts, ooomodel.ts, scoreboard.ts), so the prose
// cannot drift from them.

import { describe, expect, it } from 'vitest';
import { chOoo } from '../src/chapters/ch-ooo';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { dataflow, traceOf } from '../src/riscv/ilp';
import { oooRun, type OooConfig } from '../src/riscv/ooomodel';
import { OOO_PROGRAMS, SCOREBOARD_SOURCE } from '../src/riscv/oooprograms';
import { Scoreboard } from '../src/riscv/scoreboard';
import RESULTS from '../src/bench/results.json';
import { CRC4_BRANCHLESS, CRC4_BUDGET, CRC4_SOURCE, CRC4_VALUE, DUAL_SOURCE, SELECT_ORDER, STORE_SOURCE } from '../src/chapters/ch-ooo';
import { geoMean, meanOf, runOf } from '../src/bench/summary';
import { crc32, xorshift32 } from '../src/riscv/benchprograms';
import { GRID_PROGRAMS, GRID_ROBS, gridConfig, MEASURED_CPUS } from '../src/widgets/ooo';
import { tick } from './yieldtick';
import { AGE8, iqEntry, issueQueue, RAT, RAT_ROW, reorderBuffer, SELECT8, STORE_QUEUE, TAG } from '../src/lib/ooo';
import { oooCpu, PAY } from '../src/lib/ooocore';
import { equal } from '../src/lib/combinational';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import { pack } from '../src/sim/values';

const PW = PAY.reduce((a, [, w]) => a + w, 0);

const OPTS = { dmemWords: 64, imemWords: 128 };
const words = (id: string) => assemble(OOO_PROGRAMS.find((p) => p.id === id)?.source ?? BENCHMARKS.find((b) => b.id === id)!.source).words;
const cpi = (id: string, cfg: Partial<OooConfig> = {}) => { const s = oooRun(words(id), cfg, OPTS); return s.cycles / s.instructions; };
const text = [...chOoo.steps.map((s) => s.body), ...chOoo.recap!.keep].join(' ').replace(/\s+/g, ' ');
const quoted = (v: string) => expect(text, v).toContain(v);
const LONG = { lat: { alu: 1, load: 4, mul: 4, div: 19 } };

describe('chapter 26: the numbers it quotes', () => {
  it('dataflow ceilings', () => {
    const ipc = (id: string) => dataflow(traceOf(words(id), OPTS)).ipc;
    expect(ipc('fib').toFixed(1)).toBe('10.3');
    expect(ipc('sort').toFixed(1)).toBe('10.6');
    expect(Math.round(ipc('matmul'))).toBe(87);
    expect(ipc('crc').toFixed(1)).toBe('3.8');
    for (const v of ['fib 10.3', 'sort 10.6', 'matmul 87', 'crc 3.8']) quoted(v);
  });

  it('the best pipeline\'s mean CPI on the benchmark set', () => {
    const cpu = RESULTS.cpus.find((c) => c.id === 'pipe-bal-bp')!;
    const runs = cpu.runs.filter((r) => ['fib', 'sort', 'matmul', 'crc'].includes(r.bench));
    expect((runs.reduce((a, r) => a + r.cycles / r.instructions, 0) / runs.length).toFixed(2)).toBe('1.26');
    quoted('CPI 1.26');
  });

  it('in order against out of order', () => {
    expect(cpi('dot', { inorder: true }).toFixed(2)).toBe('1.14');
    expect(cpi('dot').toFixed(2)).toBe('0.91');
    expect(cpi('dot', { inorder: true, ...LONG }).toFixed(2)).toBe('1.60');
    expect(cpi('dot', LONG).toFixed(2)).toBe('1.10');
    expect(cpi('chains', { inorder: true }).toFixed(2)).toBe('4.13');
    expect(cpi('chains').toFixed(2)).toBe('3.72');
    for (const v of ['1.14 against 0.91', '1.60 against 1.10', '4.13 against 3.72']) quoted(v);
  });

  it('the scoreboard: Hennessy and Patterson\'s table', () => {
    const sb = new Scoreboard(assemble(SCOREBOARD_SOURCE).words, { alu: 2, load: 1, mul: 10, div: 40 });
    sb.run();
    const add = sb.ins[5];
    expect([add.issue, add.read, add.exec, add.write]).toEqual([13, 14, 16, 22]);
    expect(sb.ins[4].read).toBe(21);
    expect(sb.ins[1].issue).toBe(5);
    quoted('cycle 16');
    quoted('cycle 22');
  });

  it('speculation on fib', () => {
    const btb = oooRun(words('fib'), { predict: 'btb' }, OPTS), core = oooRun(words('fib'), {}, OPTS);
    expect(btb.mispredicts).toBe(613);
    expect(core.mispredicts).toBe(287);
    expect((btb.cycles / btb.instructions).toFixed(2)).toBe('1.29');
    expect((core.cycles / core.instructions).toFixed(2)).toBe('0.99');
    expect(cpi('fib', { recover: 'resolve' }).toFixed(2)).toBe('0.92');
    expect(cpi('fib', { predict: 'perfect' }).toFixed(2)).toBe('0.63');
    for (const v of ['613', '287', 'from 1.29 to 0.99', '0.92', '0.63']) quoted(v);
  });
});

const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands.toLocaleString('en').replace(/,/g, ' ');
const sceneOf = (title: string) => {
  const sc = chOoo.steps.find((s) => s.title === title)!.scene!;
  return typeof sc === 'function' ? sc() : sc;
};
/** A scene's root on GateSim with its inputs: set / get by port name. */
const runScene = (title: string) => {
  const sc = sceneOf(title), sim = simulate(sc.root);
  const r = { sc, set: (k: string, v: number) => sim.setInput(k, v), settle: () => sim.settle(), get: (p: string) => pack(sim.getBits(sim.design.root.ports[p])) };
  for (const [k, v] of Object.entries(sc.inputs!)) r.set(k, v);
  r.settle();
  return r;
};

describe('chapter 26: the gate-level steps', () => {
  it('what each unit costs', () => {
    const core = oooCpu(assemble(DUAL_SOURCE).words, { imemK: 6, dmemK: 6 });
    const part = (n: string) => nands(netlistOf(core)!.instances.find((i) => i.name === n)!.def);
    const want: [string, string][] = [['rename table', nands(RAT)], ['row', nands(RAT_ROW)], ['entry', nands(iqEntry(PW))], ['queue', nands(issueQueue(PW))],
      ['select', nands(SELECT8)], ['age', nands(AGE8)], ['rob', nands(reorderBuffer(43, 65))], ['sq', nands(STORE_QUEUE)],
      ['btb', part('btb')], ['rf', part('rf')], ['div', part('div')], ['ras', part('ras')]];
    expect(Object.fromEntries(want)).toEqual({ 'rename table': '12 443', row: '275', entry: '4 247', queue: '56 888', select: '280', age: '1 536', rob: '70 541', sq: '8 544',
      btb: '35 662', rf: '35 463', div: '16 742', ras: '10 824' });
    for (const [, v] of want) quoted(v);
    expect(part('rob')).toBe(nands(reorderBuffer(43, 65)));
    expect(part('iq')).toBe(nands(issueQueue(PW)));
    expect(logicDepth(SELECT8)).toBe(11);
    quoted('11 levels');
    expect(PW).toBe(119);
    // the comparators are a small part of an entry
    expect(4 * stats(equal(TAG)).nands).toBeLessThan(stats(iqEntry(PW)).nands / 20);
  });

  it('the benchmark figures', () => {
    const cpu = (id: string) => RESULTS.cpus.find((c) => c.id === id)!;
    const n = (id: string) => cpu(id).nands.toLocaleString('en').replace(/,/g, ' ');
    expect([n('ooo'), n('pipe-2w'), n('pipe-m-bal-bp')]).toEqual(['359 262', '193 768', '141 655']);
    expect([cpu('ooo').period, cpu('pipe-2w').period]).toEqual([93, 80]);
    const cpis = (id: string) => ['fib', 'sort', 'matmul', 'matmul-m', 'crc'].map((b) => { const r = cpu(id).runs.find((x) => x.bench === b)!; return (r.cycles / r.instructions).toFixed(2); });
    expect(cpis('ooo')).toEqual(['0.99', '0.77', '1.28', '0.84', '0.99']);
    expect(cpis('pipe-2w')).toEqual(['1.13', '1.01', '1.05', '1.09', '0.97']);
    for (const v of ['359 262', '193 768', '141 655', '93 NAND delays', 'fib 0.99, sort 0.77, matmul 1.28, matmul-m 0.84, crc 0.99', '1.13, 1.01, 1.05, 1.09, 0.97', "pipeline's 80"]) quoted(v);
  });

  it("the rename table scene: slot 1 sees slot 0's tag, then a pulse maps both", () => {
    const r = runScene('The rename table in gates');
    expect([r.get('a1v'), r.get('a1t')]).toEqual([1, 3]);
    r.set('clk', 1); r.settle(); r.set('clk', 0); r.set('we0', 0); r.set('we1', 0); r.set('rs1_0', 5); r.set('rs2_0', 6); r.settle();
    expect([r.get('a0v'), r.get('a0t'), r.get('b0v'), r.get('b0t')]).toEqual([1, 3, 1, 4]);
  });

  it('the wakeup scene: a pulse fills the entry, a tag on bus 0 wakes it before the edge', () => {
    const r = runScene('Wakeup (Tomasulo, IBM 360/91, 1967)');
    r.set('clk', 1); r.settle(); r.set('clk', 0); r.settle();
    expect([r.get('valid'), r.get('ready')]).toEqual([1, 0]);
    r.set('alloc', 0); r.set('bv0', 1); r.settle();
    expect([r.get('ready'), r.get('opA'), r.get('opB')]).toEqual([1, 42, 7]);
  });

  it('the select scene: the oldest candidate wins', () => {
    const r = runScene('Choosing who goes'), sc = r.sc;
    expect(r.get('grant')).toBe(1 << 6);
    r.set('cand', sc.inputs!.cand & ~(1 << 6)); r.settle();
    expect(r.get('grant')).toBe(1 << 3);
    expect(SELECT_ORDER.indexOf(6)).toBeLessThan(SELECT_ORDER.indexOf(3));
  });

  it('loads and stores: every load takes its value from the store queue', () => {
    const words = assemble(STORE_SOURCE).words;
    const design = flatten(oooCpu(words, { imemK: 6, dmemK: 6 }));
    const sim = new GateSim(design);
    sim.setInput('clk', 0); sim.settle();
    const k = design.root.children!, on = (i: string, p: string) => sim.getBits(k.get(i)!.ports[p])[0] === 1;
    let loads = 0, fwd = 0;
    for (let t = 0; t < 400 && sim.getBits(design.root.ports.halted)[0] !== 1; t++) {
      if (on('ld2', 'y')) { loads++; if (on('sq', 'fwdHit')) fwd++; }
      clockCycle(sim);
    }
    expect(loads).toBeGreaterThanOrEqual(8);
    expect(fwd).toBe(loads);
    // the last store drains from the store queue once it commits
    for (let t = 0; t < 4; t++) clockCycle(sim);
    expect(cpuState(sim).dmem[16]).toBe(36);
  }, 120_000);
});

describe('chapter 26: measured, and code that helps the hardware', () => {
  const cpu = (id: string) => RESULTS.cpus.find((c) => c.id === id)!;
  it('the four CPUs: CPI, delays per instruction, energy, Pollack', () => {
    const row = (id: string) => { const c = cpu(id), m = meanOf(c, 'cpi'); return { cpi: m.toFixed(2), d: (m * c.period).toFixed(1), pj: meanOf(c, 'epi').toFixed(1) }; };
    expect(MEASURED_CPUS.map(row)).toEqual([{ cpi: '1.00', d: '106.0', pj: '47.6' }, { cpi: '1.26', d: '99.6', pj: '66.6' }, { cpi: '1.04', d: '83.1', pj: '71.0' }, { cpi: '0.99', d: '92.3', pj: '133.6' }]);
    const mm = (id: string) => { const r = runOf(cpu(id), 'matmul-m')!; return ((r.cycles / r.instructions) * cpu(id).period).toFixed(0); };
    expect([mm('ooo'), mm('pipe-2w')]).toEqual(['78', '88']);
    const area = cpu('ooo').nands / cpu('pipe-m-bal-bp').nands;
    expect([area.toFixed(2), Math.sqrt(area).toFixed(2), (99.6 / 92.3).toFixed(2), (cpu('ooo').nands / cpu('pipe-2w').nands).toFixed(2), (133.6 / 71.0).toFixed(1)]).toEqual(['2.54', '1.59', '1.08', '1.85', '1.9']);
    for (const v of ['0.99', 'against the dual-issue pipeline\'s 80', '92.3 delays against 83.1, and the pipeline 99.6', '78 against 88', '2.54×', '133.6 pJ', '1.59×', '1.08×', '1.85× the NANDs']) quoted(v);
  });

  it('width × window on the model', () => {
    const grid = (w: number, r: number) => geoMean(GRID_PROGRAMS.map(words).map((ws) => { const s = oooRun(ws, gridConfig(w, r), OPTS); return s.cycles / s.instructions; })).toFixed(2);
    expect([16, 32, 64].map((r) => grid(2, r))).toEqual(['0.96', '0.96', '0.96']);
    expect([grid(4, 16), grid(4, 32)]).toEqual(['0.83', '0.79']);
    expect(GRID_ROBS.map((r) => grid(1, r))).toEqual(['1.36', '1.36', '1.36', '1.36']);
    for (const v of ['0.96 at 16, 32 and 64', '0.83 at 16 and 0.79 at 32', '(1.36)']) quoted(v);
  });

  it('crc without its branch, on the model', () => {
    const crc = BENCHMARKS.find((b) => b.id === 'crc')!.source;
    const free = crc.replace('        beqz t5, next\n        xor  a0, a0, a1\nnext:   addi t4, t4, -1', '        neg  t5, t5\n        and  t5, t5, a1\n        xor  a0, a0, t5\n        addi t4, t4, -1');
    expect(free).not.toBe(crc);
    const run = (src: string, cfg: Partial<OooConfig> = {}) => oooRun(assemble(src).words, cfg, OPTS);
    const [a, b] = [run(crc), run(free)];
    expect([a.instructions, a.cycles, a.mispredicts, b.instructions, b.cycles, b.mispredicts]).toEqual([3049, 3021, 290, 3819, 2330, 21]);
    expect([run(crc, { inorder: true }).cycles, run(free, { inorder: true }).cycles]).toEqual([3045, 2370]);
    for (const v of ['290 mispredictions in 3 049', '3 819 instructions instead of 3 049', '2 330 cycles instead of 3 021', '3 045 → 2 370']) quoted(v);
  });

  it('the challenge\'s CRC on the gates: 807 cycles with the branch, under the budget without', async () => {
    const want = crc32(xorshift32(0x2545f491, 4));
    expect(want).toBe(CRC4_VALUE);
    const gates = async (src: string) => {
      const design = flatten(oooCpu(assemble(src).words, { imemK: 6, dmemK: 6 })), sim = new GateSim(design);
      sim.setInput('clk', 0); sim.settle();
      let t = 0;
      for (; t < 3000 && sim.getBits(design.root.ports.halted)[0] !== 1; t++) { clockCycle(sim); if (t % 200 === 0) await tick(); }
      const a0 = cpuState(sim).x[10];
      for (let k = 0; k < 4; k++) clockCycle(sim); // the store drains from the store queue
      return { cycles: t, a0, crc: cpuState(sim).dmem[4] };
    };
    const m = (src: string) => oooRun(assemble(src).words, {}, { dmemWords: 64, imemWords: 64 });
    expect([m(CRC4_SOURCE).cycles, m(CRC4_SOURCE).instructions, m(CRC4_SOURCE).mispredicts]).toEqual([807, 769, 81]);
    expect([m(CRC4_BRANCHLESS).cycles, m(CRC4_BRANCHLESS).instructions, m(CRC4_BRANCHLESS).mispredicts]).toEqual([610, 963, 9]);
    const [a, b] = [await gates(CRC4_SOURCE), await gates(CRC4_BRANCHLESS)];
    expect([a.a0, b.a0, a.crc, b.crc]).toEqual([want, want, want, want]);
    expect(a.cycles).toBeGreaterThanOrEqual(CRC4_BUDGET);
    expect(b.cycles).toBeLessThan(CRC4_BUDGET);
    quoted('807 cycles');
  }, 300_000);
});
