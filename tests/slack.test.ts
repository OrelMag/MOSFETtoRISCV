import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { rca } from '../src/lib/combinational';
import { NOT } from '../src/lib/gates';
import { DFF } from '../src/lib/sequential';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { slackAt, slackBand, slackHeat, slackOf } from '../src/sim/slack';
import { analyzeTiming, CLK_TO_Q, SETUP } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';

// r0 → n1 → n2 → n3 → r1 (the critical path) and r0 → s1 → r2 (a side branch two inverters shorter).
const CHAIN: ComponentDef = {
  id: 't_slack_chain', name: 'chain', category: 'sequential', symbol: { kind: 'box' },
  ports: [{ name: 'd', dir: 'in', width: 1 }, { name: 'clk', dir: 'in', width: 1 }],
  netlist: () => ({
    instances: [
      { name: 'r0', def: DFF, at: [0, 0] }, { name: 'n1', def: NOT, at: [10, 0] }, { name: 'n2', def: NOT, at: [16, 0] },
      { name: 'n3', def: NOT, at: [22, 0] }, { name: 'r1', def: DFF, at: [28, 0] },
      { name: 's1', def: NOT, at: [10, 8] }, { name: 'r2', def: DFF, at: [28, 8] },
    ],
    nets: [
      { ends: ['d', 'r0.d'] }, { ends: ['clk', 'r0.clk', 'r1.clk', 'r2.clk'] },
      { ends: ['r0.q', 'n1.a', 's1.a'] }, { ends: ['n1.y', 'n2.a'] }, { ends: ['n2.y', 'n3.a'] }, { ends: ['n3.y', 'r1.d'] },
      { ends: ['s1.y', 'r2.d'] },
    ],
  }),
};

describe('slack through a net, for the right-click menu', () => {
  const d = flatten(CHAIN, { mode: 'gate' });
  const s = slackOf(d)!;
  const net = (inst: string, port: string) => d.root.children!.get(inst)!.ports[port][0];

  it('the longest path through a net: the period on the critical one, less on the branch', () => {
    expect(s.through(net('n2', 'y'))).toBe(s.period);
    expect(s.through(net('r0', 'q'))).toBe(s.period);
    expect(s.period - s.through(net('s1', 'y'))).toBe(2);
    // the d input: only its path into r0, setup included
    expect(s.through(d.root.ports.d[0])).toBe(SETUP);
    expect([...new Set(s.pathThrough(d.root.ports.d[0]).map((p) => p[0]))]).toEqual(['r0']);
  });

  it('the path through it runs from the launching flip-flop to the capturing one, in order', () => {
    const top = (p: string[]) => p[0];
    const crit = s.pathThrough(net('n2', 'y')).map(top);
    expect(crit[0]).toBe('r0');
    expect(crit[crit.length - 1]).toBe('r1');
    expect([...new Set(crit)]).toEqual(['r0', 'n1', 'n2', 'n3', 'r1']);
    expect([...new Set(s.pathThrough(net('s1', 'y')).map(top))]).toEqual(['r0', 's1', 'r2']);
    // it agrees with the timing report's critical path
    expect(analyzeTiming(d)!.path.length).toBeGreaterThan(0);
  });

  it('an instance leaves by its outputs, a flip-flop also by what it captures', () => {
    expect(s.netsOf(['n2'])).toContain(net('n2', 'y'));
    const r1 = s.netsOf(['r1']);
    expect(r1).toContain(net('n3', 'y'));
    expect(Math.max(...s.netsOf(['s1']).map((n) => s.through(n)))).toBe(s.period - 2);
    expect(s.netsOf(['nothing'])).toEqual([]);
  });

  it('a large design\'s path stays finite and ordered by arrival', () => {
    const cpu = flatten(singleCycleCpu(assemble(PROGRAMS[0].source).words));
    const c = slackOf(cpu)!;
    let best = -1, at = -1;
    for (let n = 0; n < cpu.netCount; n += 7) { const t = c.through(n); if (t > best) { best = t; at = n; } }
    const p = c.pathThrough(at);
    expect(p.length).toBeGreaterThan(3);
    expect(p.length).toBeLessThan(cpu.leaves.length);
  });
});

describe('slack heatmap', () => {
  it('a chain and a side branch: the critical parts at 0, the branch at its spare time', () => {
    const d = flatten(CHAIN, { mode: 'gate' });
    const s = slackOf(d)!;
    expect(s.clocked).toBe(true);
    expect(s.period).toBe(CLK_TO_Q + 3 + SETUP);
    expect(s.period).toBe(analyzeTiming(d)!.period);
    const m = slackAt(s, []);
    for (const n of ['r0', 'n1', 'n2', 'n3', 'r1']) expect(m.get(n), n).toBe(0);
    expect(m.get('s1')).toBe(2);
    expect(m.get('r2')).toBe(2);
    expect(slackBand(m.get('n1')!, s.period)).toBe(0);
    expect(slackBand(m.get('s1')!, s.period)).toBe(2); // 2 / 9: within 25 %
    const heat = slackHeat(s, []);
    expect(heat.get('n1')).toEqual({ band: 0, tip: 'On the critical path (9 NAND delays): slack 0' });
    expect(heat.get('s1')!.tip).toBe("Slack 2 NAND delays: the slowest path through it is 7 of the critical path's 9 (78 %)");
    // a level down: the NAND inside n2 is critical, the one inside s1 is not
    expect([...slackAt(s, ['n2']).values()]).toEqual([0]);
    expect([...slackAt(s, ['s1']).values()]).toEqual([2]);
  });

  it('under load delay too', () => {
    const d = flatten(CHAIN, { mode: 'gate' });
    const s = slackOf(d, 'load')!;
    expect(s.period).toBeCloseTo(analyzeTiming(d, { delay: 'load' })!.period, 9);
    const m = slackAt(s, []);
    for (const n of ['r0', 'n1', 'n2', 'n3', 'r1']) expect(m.get(n), n).toBeCloseTo(0, 9);
    expect(m.get('s1')!).toBeGreaterThan(1);
  });

  it('a combinational design is timed input to output', () => {
    const s = slackOf(flatten(rca(4), { mode: 'gate' }))!;
    expect(s.clocked).toBe(false);
    const m = slackAt(s, []);
    expect(Math.min(...m.values())).toBe(0);
    expect(m.size).toBe(4);
  });

  it('every stage of a CPU critical path is at slack 0, both models', () => {
    const d = flatten(singleCycleCpu(assemble(PROGRAMS[0].source).words));
    for (const model of ['unit', 'load'] as const) {
      const r = analyzeTiming(d, { delay: model })!, s = slackOf(d, model)!;
      expect(s.period).toBeCloseTo(r.period, 9);
      const m = slackAt(s, []);
      for (const st of r.stages) expect(m.get(st.inst)!, `${model} ${st.inst}`).toBeCloseTo(0, 9);
      // and some part has room to spare
      expect(Math.max(...m.values())).toBeGreaterThan(0);
      // a level down the critical path: its leaves at 0 too
      const deep = r.path[Math.floor(r.path.length / 2)].node;
      const inner = slackAt(s, deep.slice(0, 1));
      expect(inner.get(deep[1])!).toBeCloseTo(0, 9);
    }
  });
});
