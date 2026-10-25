// Acts 6–8's learner-facing text (whys, cases, lessons, thread data, end cards): every number it quotes is
// measured here, from the levels' pars, the library and runs of the reference cores on the benches' programs,
// and the thread is filled for every level of the three acts.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { ACT_ENDS } from '../src/campaign/actends';
import { caseOf } from '../src/campaign/cases';
import { corePeriod, type CoreTest, memLeaf, runCore } from '../src/campaign/corecheck';
import { coreTests, mdTests, pipeTests, predictTests, sysTests } from '../src/campaign/coretests';
import { dependents } from '../src/campaign/graph';
import { LESSONS } from '../src/campaign/lessons';
import { NODES, nodeById } from '../src/campaign/nodes';
import { NUDGES } from '../src/campaign/nudges';
import { PUZZLES, runPuzzle } from '../src/campaign/puzzles';
import { threadOf } from '../src/campaign/thread';
import { resolveComponent } from '../src/lib/resolve';
import { rv16Core } from '../src/lib/rv16/cpu';
import { rv16Pipe, type Rv16PipeOptions } from '../src/lib/rv16/pipe';
import { rv16SysCore } from '../src/lib/rv16/system';
import { CAUSE } from '../src/riscv/rv16/isa16';
import { flatten } from '../src/sim/flatten';
import { logicDepth, stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';
import { type ComponentDef, netlistOf } from '../src/sim/types';

/** As the texts write numbers: a space between thousands. */
const sp = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plain = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const par = (id: string) => nodeById(id)!.par!;
const why = (id: string) => plain(nodeById(id)!.why);
const cs = (id: string) => { const c = caseOf(id)!; return plain(`${c.problem} ${c.without ?? ''} ${c.cost ?? ''} ${(c.alts ?? []).map((a) => `${a.name} ${a.note ?? ''}`).join(' ')}`); };
const lib = (id: string) => { const d = resolveComponent(id)!; return { nand: stats(d).nands, depth: logicDepth(d)! }; };
const pct = (a: number, b: number) => Math.round(100 * (1 - a / b));
const more = (a: number, b: number) => Math.round(100 * (a / b - 1));
const ACTS = [6, 7, 8];
const mine = NODES.filter((n) => ACTS.includes(n.act));

const pipe = (o: Partial<Rv16PipeOptions>) => rv16Pipe({ fwd: true, stall: true, flush: true, ...o });
const time = (def: ComponentDef, tests: CoreTest[], system = false) => {
  const r = runCore(def, 'gate', { rv16i: true, tests: () => tests, budget: { cpi: 4, extra: 20 }, system });
  expect(r.failures).toEqual([]);
  const period = corePeriod(def)!, cycles = r.cycles!;
  return { nand: stats(def).nands, period, cycles, time: period * cycles };
};
const pregs = (d: ComponentDef) => netlistOf(d)!.instances.filter((i) => i.def.id === 'rv16_preg').length;

describe('acts 6–8: the thread is filled', () => {
  it('every level has pitfalls and a clause for every level that builds on it', () => {
    for (const n of mine) {
      const t = threadOf(n.id);
      expect(t?.pitfalls?.length, `${n.id} pitfalls`).toBeGreaterThanOrEqual(2);
      expect(t!.pitfalls!.length, `${n.id} pitfalls`).toBeLessThanOrEqual(4);
      for (const d of dependents(n.id)) expect(t?.usedFor?.[d.id], `${n.id} → ${d.id}`).toBeTruthy();
    }
  });

  it('acts 6 and 7 name the blocks they go into; the FP units stand alone', () => {
    for (const n of mine.filter((m) => m.act !== 8)) expect(threadOf(n.id)?.uses?.length || n.anatomy?.length, `${n.id} uses`).toBeTruthy();
    for (const n of mine.filter((m) => m.id.startsWith('o_fp'))) expect(threadOf(n.id)?.uses, n.id).toBeUndefined();
  });

  it('build and core levels have a nudge and 2–4 tips; the FP builds link to the float chapter', () => {
    for (const n of mine.filter((m) => m.kind === 'build' || m.kind === 'core' || m.kind === 'program' || m.kind === 'drill')) {
      expect(NUDGES[n.id], `${n.id} nudge`).toBeTruthy();
      expect(n.tips.length, `${n.id} tips`).toBeGreaterThanOrEqual(2);
      expect(n.tips.length, `${n.id} tips`).toBeLessThanOrEqual(4);
    }
    for (const n of mine.filter((m) => m.id.startsWith('o_fp') || m.id === 'n_float')) expect(n.chapters?.some((l) => l.chapter === 'float'), n.id).toBe(true);
    for (const n of mine.filter((m) => m.kind !== 'lesson' && m.id !== 'o_mc')) expect(n.chapters?.length, `${n.id} chapter link`).toBeTruthy();
  });

  it('every why is short: problem, cost, next', () => {
    for (const n of mine) expect(n.why.split(/\s+/).length, n.id).toBeLessThanOrEqual(95);
  });

  it('the lessons and the float drill have cases', () => {
    for (const id of ['pi_lesson', 'y_lesson', 'o_lesson', 'n_float']) expect(caseOf(id)?.problem, id).toBeTruthy();
    for (const id of ['o_fpmul', 'o_fpcmp', 'o_fpcvt']) expect(caseOf(id)?.without, id).toBeTruthy();
  });
});

describe('act 6: the numbers', () => {
  const core3 = time(rv16Core(true), coreTests(3)), core4 = time(rv16Core(true, true), coreTests(3));
  const c4pipe = time(rv16Core(true, true), pipeTests(2));

  it('the pipeline register and the stages', () => {
    const p0 = rv16Pipe({ fwd: false, stall: false, flush: false }), p4 = pipe({}), fin = pipe({ sys: true });
    const reg = par('pi_reg').nand!;
    expect(lib('rv16_preg').nand).toBe(reg);
    expect([pregs(p0), pregs(p4), pregs(fin)]).toEqual([12, 15, 16]);
    expect(why('pi_reg')).toContain(`${reg} NANDs, and the finished RV16 places 16 of them, ${sp(16 * reg)} NANDs, a third of the chip. Pipeline I places the first twelve`);
    const third = (16 * reg) / par('y_final').nand!;
    expect(third).toBeGreaterThan(0.3);
    expect(third).toBeLessThan(0.36);
    expect(plain(LESSONS.pipe)).toContain(`${reg} NANDs each, twelve in Pipeline I (${sp(12 * reg)} NANDs), sixteen in the finished chip (${sp(16 * reg)}, a third of it)`);
    expect(cs('pi_lesson')).toContain(`the 15 pipeline registers ${sp(15 * reg)} of it`);
    const p = par('pi_core0');
    expect(why('pi_core0')).toContain(`${sp(p.nand!)} NANDs at period ${p.period}, but the two nops after every instruction make it ${sp(p.cycles!)} cycles`);
  });

  it('E is the slowest stage of Pipeline I, most of it the ripple ALU', () => {
    const p0 = rv16Pipe({ fwd: false, stall: false, flush: false });
    const bench: ComponentDef = {
      id: 'c678_bench', name: 'bench', category: 'cpu', symbol: { kind: 'box' },
      ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
      netlist: () => ({
        instances: [{ name: 'core', def: p0 }, { name: 'imem', def: memLeaf('c678_imem', 'imem') }, { name: 'dmem', def: memLeaf('c678_dmem', 'dmem') }],
        nets: [{ ends: ['clk', 'core.clk'] }, { ends: ['rst', 'core.rst'] }, { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
          { ends: ['core.daddr', 'dmem.addr'] }, { ends: ['dmem.data', 'core.drdata'] }],
      }),
    };
    const r = analyzeTiming(flatten(bench, { mode: 'gate' }))!;
    expect(r.period).toBe(par('pi_core0').period);
    const alu = netlistOf(p0)!.instances.find((i) => i.label === 'ALU')!.name;
    const on = r.path.map((p, k) => ({ p, k })).filter(({ p }) => p.node[0] === 'core' && p.node[1] === alu);
    const span = on[on.length - 1].p.arrival - (on[0].k ? r.path[on[0].k - 1].arrival : 0);
    expect(span).toBeGreaterThan(r.period / 2);
    expect(plain(LESSONS.pipe)).toContain(`the slowest stage by far, ${r.period} delays, most of them the ripple ALU, so the period falls from ${par('c_core3').period} to ${r.period}`);
    expect(plain(LESSONS.pipe)).toContain(`That is ${par('c_core3').period} delays on Core III and ${core4.period} on Core IV`);
  });

  it('forwarding, the stall, the flush', () => {
    const p0 = par('pi_core0'), p1 = par('pi_core1'), p2 = par('pi_core2'), p3 = par('pi_core3'), f = par('pi_fwd'), h = par('pi_haz');
    expect(why('pi_fwd')).toContain(`${f.nand} NANDs, but its ${f.depth} delays land on E, period ${p0.period} → ${p1.period}`);
    expect(why('pi_core1')).toContain(`+${p1.nand! - p0.nand!} NANDs and period ${p1.period}, and the ${pipeTests(1).length} programs fall from ${sp(p0.cycles!)} cycles to ${p1.cycles}`);
    expect(why('pi_haz')).toContain(`${h.nand} NANDs`);
    expect(why('pi_core2')).toContain(`+${p2.nand! - p1.nand!} NANDs, period unchanged, ${p1.cycles} → ${p2.cycles} cycles`);
    expect(p2.period).toBe(p1.period);
    expect(why('pi_core3')).toContain(`+${sp(p3.nand! - p2.nand!)} NANDs, and every taken branch or jump costs two cycles, ${sp(p3.cycles!)} on Core III's ${coreTests(3).length} programs against ${sp(core3.cycles)}`);
    const L = plain(LESSONS.pipe);
    expect(L).toContain(`Two nops after every instruction: ${sp(p0.cycles!)} cycles on ${pipeTests(0).length} programs`);
    expect(L).toContain(`the unit is ${f.nand} NANDs, but its ${f.depth} delays land on E (period ${p0.period} → ${p1.period}), and the nops go: ${p1.cycles} cycles`);
    expect(L).toContain(`(Pipeline III: a ${h.nand}-NAND hazard unit, ${p2.cycles} cycles)`);
    expect(L).toContain(`${sp(p3.cycles!)} cycles on Core III's ${coreTests(3).length} programs against its ${sp(core3.cycles)}`);
  });

  it('the pipelines against Core IV on the same programs', () => {
    const p1 = time(pipe({ stall: false, flush: false }), pipeTests(1)), p2 = time(pipe({ flush: false }), pipeTests(2));
    expect(c4pipe).toMatchObject({ cycles: 824, period: core4.period });
    expect(p1.time).toBeGreaterThan(c4pipe.time);
    expect(cs('pi_core1')).toContain(`runs these programs in ${sp(c4pipe.time)} (${c4pipe.cycles} cycles at period ${c4pipe.period})`);
    expect(cs('pi_core2')).toContain(`${sp(p2.time)} NAND delays, 11% less than on Core II and still ${more(p2.time, c4pipe.time)}% more than on Core IV (${sp(c4pipe.time)})`);
    const p4 = time(pipe({}), coreTests(3)), pr = time(pipe({ predict: true }), coreTests(3)), k = time(pipe({ fast: true }), coreTests(3));
    expect(cs('pi_core3')).toContain(`Core IV (${sp(core4.time)}) beats it outright. Branch prediction wins back cycles (${sp(pr.cycles)} here) but adds period (${pr.period}): ${sp(pr.time)}. Kogge–Stone adders in E win back the period instead: ${k.period}, ${sp(k.time)} NAND delays, ${pct(k.time, core4.time)}% faster than Core IV`);
    expect(pr.time).toBeGreaterThan(core4.time);
    expect(caseOf('pi_core3')!.alts!.find((a) => a.nand)!.nand).toBe(k.nand);
    expect(cs('pi_core3')).toContain(`the same ${sp(p4.cycles)} cycles: ${sp(k.time)} NAND delays`);
    // the act's end card, the lesson's case
    expect(plain(ACT_ENDS[6].can)).toContain(`make it pay (${pct(k.time, core4.time)}% faster than Core IV), branch prediction alone does not`);
    expect(cs('pi_lesson')).toContain(`Core IV: ${sp(core4.time)} NAND delays on the ${coreTests(3).length} programs, one instruction per ${core4.period}-delay cycle`);
    expect(cs('pi_lesson')).toContain(`Pipeline IV is ${sp(p4.nand)} NANDs against Core IV's ${sp(core4.nand)}`);
    expect(cs('pi_lesson')).toContain(`${sp(p4.cycles)} cycles at period ${p4.period}, ${sp(p4.time)} NAND delays. Kogge–Stone adders in E (${sp(k.nand)} NANDs) bring the period to ${k.period} and the time to ${sp(k.time)}`);
  });

  it('branch prediction, measured against Pipeline IV and Core IV', () => {
    const t = predictTests(), p4 = time(pipe({}), t), pr = time(pipe({ predict: true }), t), prk = time(pipe({ predict: true, fast: true }), t);
    const c4 = time(rv16Core(true, true), t), b = par('o_bpred');
    expect([pr.nand, pr.period, pr.cycles]).toEqual([b.nand, b.period, b.cycles]);
    expect(why('o_bpred')).toContain(`+${pr.nand - p4.nand} NANDs, period ${pr.period}, and ${pct(pr.cycles, p4.cycles)}% fewer cycles on these ${t.length} programs`);
    expect(pr.time).toBeGreaterThan(c4.time);
    expect(prk.time).toBeLessThan(c4.time);
    expect(cs('o_bpred')).toContain(`Core IV runs these programs in ${sp(c4.time)} NAND delays (${sp(c4.cycles)} cycles at period ${c4.period}), this pipeline in ${sp(pr.time)}`);
    expect(cs('o_bpred')).toContain(`${sp(prk.nand)} NANDs at period ${prk.period}: ${sp(prk.time)}, ${pct(prk.time, c4.time)}% faster than Core IV`);
    expect(plain(LESSONS.pipe)).toContain(`${pct(pr.cycles, p4.cycles)}% fewer on its loop programs, at period ${pr.period}, still slower than Core IV on its own`);
  });

  it('multicycle', () => {
    const m = par('o_mc'), c3 = par('c_core3');
    expect(why('o_mc')).toContain(`period ${c3.period} → ${m.period}, but Core III's programs take ${sp(m.cycles!)} cycles instead of ${sp(c3.cycles!)}, ${((m.period! * m.cycles!) / (c3.period! * c3.cycles!)).toFixed(1)} times as long`);
  });
});

describe('act 7: the numbers', () => {
  const exc = [...sysTests(false), ...pipeTests(3)], all = [...sysTests(true), ...pipeTests(3)];
  const c3 = par('c_core3'), trap = par('y_trap'), p4 = par('pi_core3'), p5 = par('y_ptrap'), fin = par('y_final');

  it('the single-cycle system core and the CSR file', () => {
    const csr = par('y_csr').nand!;
    expect(lib('rv16_csr').nand).toBe(csr);
    expect(why('y_csr')).toContain(`${sp(csr)} NANDs, more than a third of Core III`);
    expect(csr / c3.nand!).toBeGreaterThan(1 / 3);
    expect(why('y_lesson')).toContain(`for ${sp(trap.nand! - c3.nand!)} NANDs over Core III`);
    expect(why('y_trap')).toContain(`+${sp(trap.nand! - c3.nand!)} NANDs over Core III, period ${trap.period}`);
    expect(par('y_irq').nand).toBe(trap.nand);
    expect(why('y_irq')).toContain('Taking it costs 0 NANDs');
    expect(why('p_handler')).toContain(`${par('p_handler').size} words in the reference`);
  });

  it('Pipeline V and the finale', () => {
    expect(why('y_ptrap')).toContain(`+${sp(p5.nand! - p4.nand!)} NANDs over Pipeline IV, period ${p5.period}`);
    const irq1 = time(rv16SysCore(true), all, true), f = time(pipe({ sys: true }), all, true);
    const fp = time(pipe({ sys: true, predict: true }), all, true), fk = time(pipe({ sys: true, fast: true }), all, true);
    expect(f.nand).toBe(fin.nand);
    expect(why('y_final')).toContain(`${fin.nand! - p5.nand!} NANDs, ${sp(fin.nand!)} in all`);
    expect(why('y_final')).toContain(`The ${all.length} programs take ${sp(f.time)} NAND delays against ${sp(irq1.time)} on the single-cycle core with interrupts, and that ${pct(f.time, irq1.time)}% is all a ripple-adder pipeline wins; with Kogge–Stone adders in E it would be ${pct(fk.time, irq1.time)}%`);
    expect(cs('y_final')).toContain(`${sp(fp.nand)} NANDs, period ${fp.period}, ${sp(fp.cycles)} cycles, ${sp(fp.time)} NAND delays`);
    expect(cs('y_final')).toContain(`${sp(fk.nand)} NANDs, period ${fk.period}, ${sp(fk.time)}, ${pct(fk.time, irq1.time)}% faster than the single-cycle core`);
    const alts = caseOf('y_final')!.alts!.filter((a) => a.nand);
    expect(alts.map((a) => a.nand)).toEqual([fp.nand, fk.nand]);
    expect(alts.map((a) => a.note)).toEqual([`period ${fp.period}, ${sp(fp.cycles)} cycles: ${sp(fp.time)} NAND delays`, `period ${fk.period}, ${sp(fk.cycles)} cycles: ${sp(fk.time)} NAND delays`]);
    expect(time(pipe({ sys: 'exc' }), exc, true).nand).toBe(p5.nand);
    expect(plain(ACT_ENDS[7].can)).toContain(`${sp(fin.nand!)} NANDs at period ${fin.period}`);
  });

  it('the traps lesson and its case', () => {
    const L = plain(LESSONS.traps), csr = par('y_csr').nand!;
    expect(L).toContain(`${CAUSE.illegal} an illegal instruction, ${CAUSE.breakpoint} ebreak, ${CAUSE.ecall} ecall, 0x${CAUSE.external.toString(16).toUpperCase().replace('X', 'x')} the external`);
    expect(CAUSE.external & 0x8000).toBeTruthy();
    expect(L).toContain(`the CSR file (${sp(csr)} NANDs), exceptions (${sp(trap.nand! - c3.nand!)} over Core III) and the interrupt (0 more NANDs`);
    expect(L).toContain(`(${sp(p5.nand! - p4.nand!)} over Pipeline IV); the finale adds the interrupt for ${fin.nand! - p5.nand!} more, ${sp(fin.nand!)} NANDs in all`);
    expect(cs('y_lesson')).toContain(`the CSR file ${sp(csr)} NANDs, exceptions ${sp(trap.nand! - c3.nand!)} over Core III in all, interrupts nothing more. In the pipeline: ${sp(p5.nand! - p4.nand!)} over Pipeline IV for precise exceptions, then ${fin.nand! - p5.nand!} for the interrupt. The finale is ${sp(fin.nand!)} NANDs`);
    expect(plain(threadOf('y_final')!.pitfalls!.join(' '))).toContain(`0x${CAUSE.external.toString(16).toUpperCase().replace('X', 'x')}`);
  });
});

describe('act 8: the numbers', () => {
  const sw = runPuzzle(PUZZLES.p_mul, PUZZLES.p_mul.ref).results.map((r) => r.steps);
  const range = `${Math.min(...sw)} to ${Math.max(...sw)}`;
  const avg = Math.round(sw.reduce((a, b) => a + b, 0) / sw.length);
  const c3 = par('c_core3'), mc = par('o_mcore'), arr16 = lib('amul16'), arr8 = par('o_mularr');

  it('multiply and divide', () => {
    for (const id of ['o_lesson', 'o_mulseq', 'o_mcore']) expect(why(id), id).toContain(`${range} instructions`);
    expect(why('o_lesson')).toContain(`its period from ${c3.period} to ${mc.period}`);
    expect(why('o_mcore')).toContain(`period ${c3.period} → ${mc.period}, and code without a single multiply runs ${(mc.period! / c3.period!).toFixed(2)} times slower`);
    expect(lib('amul8')).toEqual({ nand: arr8.nand, depth: arr8.depth });
    expect(why('o_mularr')).toContain(`${arr8.nand} NANDs, ${arr8.depth} deep at 8 × 8, and ${sp(arr16.nand)} NANDs, ${arr16.depth} deep at 16 × 16`);
    expect(why('o_mularr')).toContain('A shift-and-add unit takes 18 cycles a product');
    expect(why('o_mularr')).toContain(`what ${arr16.depth} delays do`);
    const adiv = lib('adiv16'), d = par('o_div');
    expect(why('o_div')).toContain(`${sp(adiv.nand)} NANDs on a ${adiv.depth}-deep path`);
    expect(why('o_div')).toContain(`${sp(d.nand!)} NANDs, period ${d.period}, 18 cycles a quotient`);
    expect(plain(LESSONS.arith)).toContain(`in one pass is ${sp(adiv.nand)} NANDs on a ${adiv.depth}-deep path, so it iterates (${sp(d.nand!)} NANDs, 18 cycles)`);
    const dc = par('o_dcore');
    expect(why('o_dcore')).toContain(`${sp(dc.nand!)} NANDs at period ${dc.period}, and the ${mdTests('all').length} programs take ${sp(dc.cycles!)} cycles`);
    expect(cs('o_lesson')).toContain(`${range} instructions per 16-bit product in the Act 4 puzzle, ${avg} on average`);
    expect(cs('o_lesson')).toContain(`Shift-and-add: ${sp(par('o_mulseq').nand!)} NANDs, 18 cycles a product. The 16 × 16 array: ${sp(arr16.nand)} NANDs, ${arr16.depth} deep, and in the core a period of ${mc.period} against ${c3.period}`);
    expect(lib('smul16').nand).toBe(par('o_mulseq').nand);
    expect(cs('o_lesson')).toContain(`The FP adder is ${sp(par('o_fpadd').nand!)} NANDs, the FP multiplier ${sp(par('o_fpmul').nand!)}`);
    expect(cs('o_fpmul')).toContain(`(${range} instructions by shift and add on RV16I)`);
  });

  it('the floating-point ladder', () => {
    const max = (2 - 2 ** -10) * 2 ** 15;
    expect(why('n_float')).toContain(`stops at ${sp(2 ** 15 - 1)}`);
    expect(why('n_float')).toContain(`reaches ${sp(max)} and keeps 11 significant bits`);
    expect(cs('n_float')).toContain(`up to ${sp(max)}`);
    expect(cs('n_float')).toContain(`unpack (${par('o_fpunpack').nand} NANDs)`);
    expect(cs('n_float')).toContain(`normalize & round (${sp(par('o_fpnorm').nand!)})`);
    const nd = (id: string) => `${sp(par(id).nand!)} NANDs, depth ${par(id).depth}`;
    expect(why('o_fpunpack')).toContain(nd('o_fpunpack'));
    expect(why('o_fpround')).toContain(nd('o_fpround'));
    expect(why('o_fpsticky')).toContain(nd('o_fpsticky'));
    expect(why('o_fplzc')).toContain(`${par('o_fplzc').nand} NANDs at depth ${par('o_fplzc').depth}`);
    expect(why('o_fpnorm')).toContain(nd('o_fpnorm'));
    expect(par('o_fpnorm').nand! / par('o_fpadd').nand!).toBeGreaterThan(0.5);
    expect(why('o_fpadd')).toContain(`${nd('o_fpadd')}, normalize & round ${sp(par('o_fpnorm').nand!)} of them`);
    expect(why('o_fpmul')).toContain(`${sp(par('o_fpmul').nand!)} NANDs at depth ${par('o_fpmul').depth}, against the adder's ${par('o_fpadd').depth}`);
    expect(why('o_fpmul')).toContain(`the binary32 multiplier is ${sp(lib('fpmul8_23').nand)} NANDs`);
    expect(why('o_fpcmp')).toContain(nd('o_fpcmp'));
    expect(why('o_fpcvt')).toContain(nd('o_fpcvt'));
    expect(plain(threadOf('o_fpnorm')!.usedFor!.o_fpadd)).toContain(`${sp(par('o_fpnorm').nand!)} of the adder's ${sp(par('o_fpadd').nand!)} NANDs`);
    // no RV16 core runs them: no level of any act requires an FP unit
    const fp = new Set(mine.filter((n) => n.id.startsWith('o_fp')).map((n) => n.id));
    for (const n of NODES) if (n.kind === 'core') for (const r of n.requires) expect(fp.has(r), `${n.id} requires ${r}`).toBe(false);
  });
});
