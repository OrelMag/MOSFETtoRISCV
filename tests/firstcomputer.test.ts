// Chapter 'firstcomputer' and level m_acc: every number the text quotes held to the gates and the golden model, the
// panel's follower in step with the gates, the level's bench passing the reference and failing broken machines.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { ACC_PROGRAMS, accAssemble } from '../src/acc8/acc8';
import { accBench, accGives } from '../src/campaign/buildacc';
import { nodeById } from '../src/campaign/nodes';
import { ACC_COST, ACC_LOGIC, MUL_RV } from '../src/chapters/ch-firstcomputer';
import { ACC8_CORE, ACC8_MUL, ACC_CTL, ACC_FIXED_COUNTDOWN, accMachine } from '../src/lib/acc8';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stats } from '../src/sim/stats';
import { pack } from '../src/sim/values';
import { analyzeTiming } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';
import { AccFollower } from '../src/widgets/acc8';

describe('first computer: the chapter\'s numbers', () => {
  const n = (name: string) => stats(ACC8_MUL.netlist!().instances.find((i) => i.name === name)!.def).nands;
  it('costs, part by part, are the gates\'', () => {
    expect(n('acc')).toBe(ACC_COST.acc);
    expect(n('outr')).toBe(ACC_COST.out);
    expect(n('pc')).toBe(ACC_COST.pc);
    expect(n('inc')).toBe(ACC_COST.inc);
    expect(n('jmux')).toBe(ACC_COST.jmux);
    expect(n('alu')).toBe(ACC_COST.alu);
    expect(n('mux1')).toBe(ACC_COST.mux);
    expect(n('mux2')).toBe(ACC_COST.mux);
    expect(n('zero')).toBe(ACC_COST.zero);
    expect(n('ctl')).toBe(ACC_COST.ctl);
    expect(stats(ACC_CTL).nands).toBe(ACC_COST.ctl);
    expect(n('self') + n('hlt')).toBe(ACC_COST.halt);
    expect(n('rom')).toBe(ACC_COST.rom);
    expect(n('ram')).toBe(ACC_COST.ram);
    expect(stats(ACC8_MUL).nands).toBe(ACC_COST.total);
    expect(ACC_LOGIC).toBe(ACC_COST.total - ACC_COST.rom - ACC_COST.ram);
  });
  it('the period and its critical path are static timing\'s', () => {
    const t = analyzeTiming(flatten(ACC8_MUL))!;
    expect(t.period).toBe(ACC_COST.period);
    const at = Object.fromEntries(t.stages.map((s) => [s.inst, s.arrival]));
    expect(at).toMatchObject(ACC_COST.path);
  });
  it('the RV32I loop it is compared with retires 4 instructions a round and ends with 42', () => {
    expect(MUL_RV.loop).toBe(4);
    expect(MUL_RV.instrs).toBeLessThan(40);
  });
  it('the level\'s par is the reference\'s', () => {
    const node = nodeById('m_acc')!;
    expect(node.par).toEqual({ nand: stats(ACC8_CORE).nands, period: analyzeTiming(flatten(ACC8_CORE))!.period });
    expect(accGives()).toContain('ram32x8');
  });
});

describe('first computer: the panel and the level', () => {
  it('the follower stays in step with the gates on the chapter\'s programs', () => {
    for (const p of Object.keys(ACC_PROGRAMS) as (keyof typeof ACC_PROGRAMS)[]) {
      const words = accAssemble(ACC_PROGRAMS[p]);
      const sim = new GateSim(flatten(accMachine(words)));
      sim.setInput('clk', 0);
      sim.reset('zero');
      sim.settle();
      const f = new AccFollower(words);
      for (let c = 0; c < 100; c++) {
        f.before(sim);
        sim.setInput('clk', 1); sim.settle();
        f.after(sim);
        sim.setInput('clk', 0); sim.settle();
      }
      expect(f.mismatch, p).toBeNull();
    }
  });

  it('the bench passes the reference core and fails broken ones', () => {
    expect(accBench(ACC8_CORE).failures).toEqual([]);
    // A machine whose adder always subtracts (sub tied to the PC's constant 1) must fail.
    const broken = (mut: (n: ReturnType<NonNullable<ComponentDef['netlist']>>) => void, id: string): ComponentDef => {
      const nl = ACC8_CORE.netlist!();
      const copy = { ...nl, instances: [...nl.instances], nets: nl.nets.map((x) => ({ ...x, ends: [...x.ends] })) };
      mut(copy);
      return { ...ACC8_CORE, id, netlist: () => copy };
    };
    const noSub = broken((nl) => {
      const sub = nl.nets.find((x) => x.name === 'sub')!;
      sub.ends = sub.ends.filter((e) => e !== 'alu.sub');
      nl.nets.find((x) => x.name === 'one')!.ends.push('alu.sub');
    }, 'acc8_core_allsub');
    expect(accBench(noSub).failures.length).toBeGreaterThan(0);
  });
});

describe('first computer: the fixed countdown circuit that opens the chapter', () => {
  const NANDS = 287; // upDownCounter(8) 264 + isZero(8) 22 + one NOT; the chapter quotes stats() of it, this pins that
  it('costs what the chapter says', () => {
    expect(stats(ACC_FIXED_COUNTDOWN).nands).toBe(NANDS);
  });
  it('after load shows 5, 4, 3, 2, 1, 0 and then holds', () => {
    const sim = new GateSim(flatten(ACC_FIXED_COUNTDOWN));
    const out = () => pack(sim.getBits(sim.design.root.ports.out));
    sim.setInput('clk', 0); sim.setInput('load', 0); sim.settle();
    sim.reset('zero'); sim.settle();
    const pulse = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
    pulse(); pulse();
    expect(out()).toBe(0); // not loaded: it sits at 0
    sim.setInput('load', 1); sim.settle(); pulse();
    expect(out()).toBe(5);
    sim.setInput('load', 0); sim.settle();
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) { pulse(); seen.push(out()); }
    expect(seen).toEqual([4, 3, 2, 1, 0, 0, 0, 0]);
    sim.setInput('load', 1); sim.settle(); pulse(); // and it can be loaded again
    expect(out()).toBe(5);
  });
});
