// The numbers the campaign's order rests on, measured: Core IV is where the critical path is
// first fixed (the ripple ALU is 50 of Core III's 98 delays), and the pipeline that follows only
// beats it once E's adders are fast too. The texts quoting them are checked against the measurement.

import { describe, expect, it } from 'vitest';
import { corePeriod, type CoreTest, memLeaf, runCore } from '../src/campaign/corecheck';
import { coreTests, pipeTests, sysTests } from '../src/campaign/coretests';
import { caseOf } from '../src/campaign/cases';
import { WALKS } from '../src/campaign/walks';
import { rv16SysCore } from '../src/lib/rv16/system';
import { LESSONS } from '../src/campaign/lessons';
import { nodeById } from '../src/campaign/nodes';
import '../src/lib';
import { rv16Core } from '../src/lib/rv16/cpu';
import { rv16Pipe, type Rv16PipeOptions } from '../src/lib/rv16/pipe';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';
import { type ComponentDef, netlistOf } from '../src/sim/types';

/** Thousands with a thin space, as the texts write them (1 236, 93 936). */
const sp = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** The delays the core's instance labelled `label` adds to its critical path, with the bench's memories. */
function span(core: ComponentDef, label: string): number {
  const bench: ComponentDef = {
    id: `order_bench_${core.id}`, name: 'bench', category: 'cpu', symbol: { kind: 'box' },
    ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
    netlist: () => ({
      instances: [{ name: 'core', def: core }, { name: 'imem', def: memLeaf('o_imem', 'imem') }, { name: 'dmem', def: memLeaf('o_dmem', 'dmem') }],
      nets: [{ ends: ['clk', 'core.clk'] }, { ends: ['rst', 'core.rst'] }, { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        { ends: ['core.daddr', 'dmem.addr'] }, { ends: ['dmem.data', 'core.drdata'] }],
    }),
  };
  const r = analyzeTiming(flatten(bench, { mode: 'gate' }))!;
  const inst = netlistOf(core)!.instances.find((i) => i.label === label)!.name;
  const on = r.path.map((p, k) => ({ p, k })).filter(({ p }) => p.node[0] === 'core' && p.node[1] === inst);
  const first = on[0].k;
  return on[on.length - 1].p.arrival - (first ? r.path[first - 1].arrival : 0);
}

const time = (def: ComponentDef, tests: CoreTest[] = coreTests(3), system = false) => {
  const r = runCore(def, 'gate', { rv16i: true, tests: () => tests, budget: { cpi: 2.5, extra: 10 }, system });
  expect(r.failures).toEqual([]);
  const period = corePeriod(def)!;
  const cycles = r.cycles!;
  return { nand: stats(def).nands, period, cycles, time: period * cycles };
};
const pipe = (o: Partial<Rv16PipeOptions>) => rv16Pipe({ fwd: true, stall: true, flush: true, ...o });

describe('Core IV and the pipeline', () => {
  const core3 = time(rv16Core(true)), core4 = time(rv16Core(true, true));
  const p4 = time(pipe({})), p4fast = time(pipe({ fast: true }));

  it('the ripple ALU is 50 of Core III\'s 98 delays; Core IV keeps the cycles', () => {
    expect(core3).toMatchObject({ period: 98, cycles: 1236 });
    expect(span(rv16Core(true), 'ALU')).toBe(50);
    expect(core4).toMatchObject({ period: 76, cycles: 1236, nand: 4938 });
    expect(nodeById('c_fast')!.why).toContain(`period is ${core3.period} NAND delays, and 50 of them are the ripple ALU`);
    expect(nodeById('c_fast')!.why).toContain(`the same ${sp(core4.cycles)} cycles`);
    expect(nodeById('c_fast')!.optional).toBeFalsy();
    expect(nodeById('o_fastadd')!.optional).toBeFalsy();
  });

  it('the pipeline loses to Core IV with ripple adders and wins with Kogge–Stone adders in E', () => {
    expect(p4).toMatchObject({ period: 78, cycles: 1495 });
    expect(p4fast.cycles).toBe(p4.cycles);
    expect(p4.time).toBeGreaterThan(core4.time);
    expect(p4fast.time).toBeLessThan(core4.time);
    const why = nodeById('pi_lesson')!.why;
    expect(why).toContain(`Core IV runs at ${core4.period} delays a cycle`);
    expect(why).toContain(`take ${sp(p4.cycles)} cycles instead of ${sp(core3.cycles)}`);
    expect(why).toContain(`is ${p4.period} delays`);
    expect(why).toContain(`period ${p4fast.period}, ${sp(p4fast.time)} NAND delays against Core IV's ${sp(core4.time)}`);
    const body = LESSONS.pipe;
    const pct = (a: number, b: number) => Math.round(100 * (1 - a / b));
    expect(body).toContain(`that is ${p4.period} delays, and the pipeline is ${pct(p4.time, core3.time)}% faster`);
    expect(body).toContain(`its period falls to ${p4fast.period}, and it beats Core IV by ${pct(p4fast.time, core4.time)}%, for ${sp(p4fast.nand)} NANDs against ${sp(core4.nand)}`);
  });
});

describe('the finale in two levels', () => {
  const exc = [...sysTests(false), ...pipeTests(3)], all = [...sysTests(true), ...pipeTests(3)];
  const p5 = time(pipe({ sys: 'exc' }), exc, true), fin = time(pipe({ sys: true }), all, true);
  const trap1 = time(rv16SysCore(false), exc, true), irq1 = time(rv16SysCore(true), all, true);
  const text = (id: string) => WALKS[id].map((s) => s.text).join(' ') + ' ' + caseOf(id)!.cost;

  it('Pipeline V takes exceptions only; the finale adds the interrupt for 7 NANDs', () => {
    expect(nodeById('y_ptrap')!.par).toEqual({ nand: p5.nand, period: p5.period, cycles: p5.cycles });
    expect(nodeById('y_final')!.par).toEqual({ nand: fin.nand, period: fin.period, cycles: fin.cycles });
    expect(nodeById('y_final')!.requires).toEqual(expect.arrayContaining(['y_ptrap', 'y_irq', 'p_handler']));
    expect(fin.nand - p5.nand).toBe(7);
    for (const [id, m, single, n] of [['y_ptrap', p5, trap1, exc.length], ['y_final', fin, irq1, all.length]] as const) {
      const t = text(id);
      expect(t, id).toContain(`${sp(m.nand)} NANDs`);
      expect(t, id).toContain(`the ${n} programs`);
      expect(t, id).toContain(`take ${sp(m.cycles)} cycles, ${sp(m.time)} NAND delays, against ${sp(single.time)} on the single-cycle core`);
      expect(t, id).toContain(`(${sp(single.cycles)} cycles at period ${single.period})`);
    }
    expect(caseOf('y_final')!.cost).toContain(`${fin.nand - p5.nand} over Pipeline V`);
  });

  it('a predicting pipeline may keep its prediction in the finale', () => {
    const r = runCore(pipe({ sys: true, predict: true }), 'gate', { rv16i: true, tests: () => all, budget: { cpi: 2.5, extra: 10 }, system: true });
    expect(r.failures).toEqual([]);
  });
});
