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

describe('the coalescer (k_coal)', () => {
  it('serves the leader\'s line: the codex example\'s four rows', async () => {
    const { coalesce16 } = await import('../src/lib/rv16/warps16');
    expect(coalesce16([0x100, 0x101, 0x102, 0x103], 0b1111)).toEqual({ line: 0x40, served: 0b1111, left: 0 });
    expect(coalesce16([0x102, 0x103, 0x104, 0x105], 0b1111)).toEqual({ line: 0x40, served: 0b0011, left: 0b1100 });
    expect(coalesce16([0x100, 0x104, 0x108, 0x10c], 0b1111)).toEqual({ line: 0x40, served: 0b0001, left: 0b1110 });
    expect(coalesce16([0x7f3, 0x100, 0x101, 0x102], 0b1110)).toEqual({ line: 0x40, served: 0b1110, left: 0 });
    expect(coalesce16([1, 2, 3, 4], 0)).toMatchObject({ served: 0, left: 0 });
  });

  it('a sequencer looping on left serves every lane once, in as many accesses as lines', async () => {
    const { coalesce16, lineOf16 } = await import('../src/lib/rv16/warps16');
    const { rng } = await import('../src/campaign/drills');
    const r = rng(7);
    for (let k = 0; k < 200; k++) {
      const base = Math.floor(r() * 0x10000);
      const addrs = [0, 1, 2, 3].map(() => (base + Math.floor(r() * 12)) & 0xffff);
      const mask = Math.floor(r() * 16);
      let left = mask, accesses = 0, seen = 0;
      while (left) {
        const s = coalesce16(addrs, left);
        expect(s.served & seen).toBe(0);
        seen |= s.served;
        left = s.left;
        accesses++;
      }
      expect(seen).toBe(mask);
      const lines = new Set([0, 1, 2, 3].filter((i) => (mask >> i) & 1).map((i) => lineOf16(addrs[i])));
      expect(accesses).toBe(lines.size);
    }
  });

  it('the numbers its case quotes: 467 NANDs, depth 27; chapter 29\'s access unit 5 870, depth 58', async () => {
    const { COAL16 } = await import('../src/lib/rv16/warps16');
    const { accessUnit } = await import('../src/lib/warpmem');
    const { logicDepth, stats } = await import('../src/sim/stats');
    expect([stats(COAL16).nands, logicDepth(COAL16)]).toEqual([467, 27]);
    expect([stats(accessUnit(4)).nands, logicDepth(accessUnit(4))]).toEqual([5870, 58]);
  });
});

describe('the two-warp bench (k_warps)', async () => {
  const { runWarps, warpGolden, warpPeriod } = await import('../src/campaign/warpcheck');
  const { warpTests } = await import('../src/campaign/lanetests');
  const { RV16_WARPS, WARP_PORTS } = await import('../src/lib/rv16/warps16');
  const wspec = (tests: CoreSpec['tests']): CoreSpec => ({ tests, budget: { cpi: 1, extra: 4 }, lanes: 4, warps: 2 });
  const only = (...names: string[]) => () => warpTests().filter((t) => names.includes(t.name));
  /** The reference core with one output replaced by a constant. */
  const forced = (port: string, value: number): ComponentDef => ({
    id: `forced_${port}`, name: 'forced', category: 'cpu', symbol: { kind: 'box' }, ports: WARP_PORTS,
    netlist: () => {
      const w = WARP_PORTS.find((p) => p.name === port)!.width;
      const nets = WARP_PORTS.filter((p) => p.name !== port).map((p) => ({ ends: p.dir === 'in' ? [p.name, `c.${p.name}`] : [`c.${p.name}`, p.name] }));
      return {
        instances: [{ name: 'c', def: RV16_WARPS }, { name: 'k', def: { id: `k${w}_${value}`, name: String(value), category: 'routing', symbol: { kind: 'box' }, ports: [{ name: 'y', width: w, dir: 'out' }], behavior: { eval: () => [value] } } as ComponentDef }],
        nets: [...nets, { ends: ['k.y', port] }],
      };
    },
  });

  it('the reference core passes every program at one instruction per turn', () => {
    const r = runWarps(RV16_WARPS, 'gate', wspec(warpTests));
    expect(r.failures).toEqual([]);
    expect(r.tested).toBe(31);
    expect(r.cycles).toBe(2093);
  });

  it('a lane core without the warp pins is told which are missing', () => {
    expect(runWarps(rv16Lanes(true), 'gate', wspec(warpTests)).failures[0]).toMatch(/missing pins: warp, lwe, lwa, lwd0/);
  });

  it('a core that never writes the returning loads fails at the first load, naming warp, lane and instruction', () => {
    const r = runWarps(forced('lwe', 0), 'gate', wspec(only('two warps: loads')));
    expect(r.failures[0]).toMatch(/two warps: loads: warp 0, lane \d \(tid \d\)'s register write #5 is a1 \(x4\) ← .* on rwe at cycle \d+ .* expected a1 \(x4\) ← .* from "lw a1, 0\(a0\)"/);
  });

  it('a core that reports the wrong warp fails on the other warp\'s first write', () => {
    const r = runWarps(forced('warp', 0), 'gate', wspec(only('two warps: tid')));
    expect(r.failures[0]).toMatch(/warp 0, lane 0 \(tid 0\)'s register write #2 is t0 \(x6\) ← 0x0004/);
  });

  it('"bar waits" tells a working barrier from none: without it warp 1 reads before warp 0 writes', () => {
    const t = warpTests().find((x) => x.name === 'two warps: bar waits')!;
    const g = warpGolden(t), nop = warpGolden({ name: 'nop', src: t.src!.replace(/^(\w+:)?\s+bar\b/gm, (_, l) => `${l ?? ''}        addi x0, x0, 0`) });
    expect(nop.regs.slice(4)).not.toEqual(g.regs.slice(4));
    expect(g.regs[4].at(-1)!.value).toBe(8); // tid 4 read lane 0's 7, plus 1
    expect(nop.regs[4].at(-1)!.value).toBe(1);
  });

  it('the event-driven bench agrees with the bit-parallel one', () => {
    const tests = only('two warps: loads', 'two warps: bar waits', 'two warps: an ended warp');
    const a = runWarps(RV16_WARPS, 'gate', wspec(tests)), b = runWarps(RV16_WARPS, 'gate', wspec(tests), 'gate');
    expect(b.failures).toEqual(a.failures);
    expect(b.cycles).toBe(a.cycles);
  }, 120000);

  it('the numbers the level quotes: 30 163 NANDs (17 544 of lane registers), period 95, 2 160 turns, 59 idle', async () => {
    const { stats } = await import('../src/sim/stats');
    const { VRF16 } = await import('../src/lib/rv16/lanes16');
    const { assemble16 } = await import('../src/riscv/rv16/asm16');
    const { Warps16 } = await import('../src/riscv/rv16/warps16');
    const { decode16 } = await import('../src/riscv/rv16/isa16');
    expect(stats(RV16_WARPS).nands).toBe(30163);
    expect(stats(RV16_WARPS).nands - stats(rv16Lanes(true)).nands).toBe(12326);
    expect(2 * stats(VRF16).nands).toBe(17544);
    expect(warpPeriod(RV16_WARPS)).toBe(95);
    let turns = 0, alone = 0, idle = 0;
    for (const t of warpTests()) {
      const a = assemble16(t.src!);
      const m = new Warps16(a.words, {}, a.data);
      while (!m.halted) {
        const s = m.step();
        if (!s.step) idle++;
        else alone += decode16(s.step.instr).spec?.name === 'lw' ? 2 : 1; // one warp alone: a stall per load
      }
      turns += m.steps;
    }
    expect([turns, alone, idle]).toEqual([2160, 2229, 59]);
  });
});
