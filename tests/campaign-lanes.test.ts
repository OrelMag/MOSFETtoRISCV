import { describe, expect, it } from 'vitest';
import { laneGolden, lanePeriod, runLanes } from '../src/campaign/lanecheck';
import { simdTests, simtTests } from '../src/campaign/lanetests';
import { leaderOf, LANE_PORTS, rv16Lanes, StackModel } from '../src/lib/rv16/lanes16';
import type { CoreSpec } from '../src/campaign/corecheck';
import type { ComponentDef } from '../src/sim/types';

const spec = (tests: CoreSpec['tests']): CoreSpec => ({ tests, budget: { cpi: 1, extra: 4 }, lanes: 4 });

describe('lane core test programs', () => {
  it('every program halts on the lane golden model with strict initialisation, and lanes differ', () => {
    for (const t of simtTests()) {
      const g = laneGolden(t, 4);
      expect(g.steps, t.name).toBeGreaterThan(3);
      // the lanes write different values somewhere: a core that broadcasts lane 0 would fail
      const firsts = g.regs.map((r) => JSON.stringify(r.map((e) => e.value)));
      expect(new Set(firsts).size, t.name).toBeGreaterThan(1);
    }
  });
});

describe('the lane bench', () => {
  const SIMD = rv16Lanes(false), SIMT = rv16Lanes(true);

  it('the reference cores pass their programs at one instruction per cycle', () => {
    for (const [def, tests] of [[SIMD, simdTests], [SIMT, simtTests]] as const) {
      const r = runLanes(def, 'gate', spec(tests));
      expect(r.failures, def.id).toEqual([]);
      expect(r.tested).toBe(tests().length);
    }
  });

  it('the SIMD core fails the split programs, naming the lane and the instruction', () => {
    const r = runLanes(SIMD, 'gate', spec(simtTests));
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.join('\n')).toMatch(/split.*lane \d/);
    expect(r.failed!.every((i) => simtTests()[i].name.includes('split') || simtTests()[i].name.includes('tmc in'))).toBe(true);
  });

  it('a core that lets masked lanes write fails tmc', () => {
    // the SIMD core with every lane's write enable forced on: the mask is ignored
    const leaky: ComponentDef = {
      id: 'leaky_simd', name: 'leaky', category: 'cpu', symbol: { kind: 'box' }, ports: LANE_PORTS,
      netlist: () => {
        const ports = LANE_PORTS.map((p) => p.name);
        const nets = ports.filter((p) => p !== 'rwe').map((p) => ({ ends: LANE_PORTS.find((q) => q.name === p)!.dir === 'in' ? [p, `c.${p}`] : [`c.${p}`, p] }));
        return {
          instances: [{ name: 'c', def: SIMD }, { name: 'k', def: { id: 'k15', name: '15', category: 'routing', symbol: { kind: 'box' }, ports: [{ name: 'y', width: 4, dir: 'out' }], behavior: { eval: () => [15] } } as ComponentDef }],
          nets: [...nets, { ends: ['k.y', 'rwe'] }],
        };
      },
    };
    const r = runLanes(leaky, 'gate', spec(() => simdTests().filter((t) => t.name === 'tmc')));
    expect(r.failures.join('\n')).toMatch(/tmc: lane \d makes an extra register write|tmc: lane \d's register write/);
  });

  it('the event-driven bench agrees with the bit-parallel one', () => {
    const tests = () => simtTests().filter((t) => !t.name.startsWith('random')).slice(0, 4).concat(simtTests().slice(-3));
    const a = runLanes(SIMT, 'gate', spec(tests)), b = runLanes(SIMT, 'gate', spec(tests), 'gate');
    expect(b.failures).toEqual(a.failures);
    expect(b.cycles).toBe(a.cycles);
  });

  it('measures the period with the four memories in the path', () => {
    const p = lanePeriod(SIMT)!;
    expect(p).toBeGreaterThan(60);
    expect(p).toBeLessThan(200);
  });

  it('reports missing pins instead of failing a program', () => {
    expect(runLanes(rv16Lanes(false), 'switch', spec(simdTests)).failures[0]).toMatch(/switch level/);
  });
});

describe('the models behind the build levels', () => {
  it('the leader is the lowest active lane', () => {
    expect([0b0001, 0b0110, 0b1100, 0b1000, 0].map((m) => leaderOf(m))).toEqual([
      { lead: 0, any: 1 }, { lead: 1, any: 1 }, { lead: 2, any: 1 }, { lead: 3, any: 1 }, { lead: 3, any: 0 }]);
  });

  it('the stack model runs if / else like the golden model', () => {
    const m = new StackModel();
    const base = { rst: 0, split: 0, join: 0, mask: 15, p: 0, pc1: 0 };
    expect(m.out({ ...base, split: 1, p: 0b1010 })).toMatchObject({ ld: 1, nmask: 0b1010 });
    m.edge({ ...base, split: 1, p: 0b1010, pc1: 0x21 });
    expect(m.out({ ...base, join: 1, mask: 0b1010 })).toEqual({ ld: 1, nmask: 0b0101, jump: 1, jpc: 0x21 });
    m.edge({ ...base, join: 1 });
    expect(m.out({ ...base, join: 1, mask: 0b0101 })).toMatchObject({ ld: 1, nmask: 15, jump: 0 });
    m.edge({ ...base, join: 1 });
    expect(m.entries).toEqual([]);
  });
});
