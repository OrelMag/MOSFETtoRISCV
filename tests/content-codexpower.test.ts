// The Power chapter's codex entries quote measured numbers (codexpower.ts, codexmorepow.ts, clockgating's in codex.ts / codexmore1.ts):
// each is recomputed here from bench/powercosts.json and the chapter's widgets. And the clock-gate level's bench passes its reference
// and fails a bare AND.

import { describe, expect, it } from 'vitest';
import { CODEX, codexById } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { CODEX_POWER, POWER_AWAITING_LEVELS, TAUGHT_POWER } from '../src/campaign/codexpower';
import { CHECKS } from '../src/campaign/codexcheck';
import { icgBench, RV16_ICG } from '../src/campaign/buildpow';
import { NODES } from '../src/campaign/nodes';
import { define } from '../src/lib/define';
import { AND } from '../src/lib/gates';
import { NAND2_UM2, UTILIZATION } from '../src/lib/tech';
import { stats } from '../src/sim/stats';
import { atSpeed, FRONT_CPUS, POWER } from '../src/widgets/power';
import { PS_PER_NAND } from '../src/sim/timing';

const text = (id: string) => `${codexById(id)!.body} ${JSON.stringify(moreOf(id) ?? {})}`;
const has = (id: string, s: string) => expect(text(id), `${id} quotes ${s}`).toContain(s);
const fix = (x: number, d: number) => x.toFixed(d);

describe('Power codex numbers', () => {
  const { plain, gated } = POWER;
  it('leakage by state', () => {
    has('leakstate', `${Math.round(plain.leakUw.hp)} µW`);
    has('leakstate', `${Math.round(plain.leakUw.lp * 1000)} nW`);
  });
  it('power gating', () => {
    const be = (id: 'hp' | 'lp') => (plain.wakePj * 1e-12) / (plain.leakUw[id] * 1e-6);
    has('powergating', `${fix(plain.wakePj, 1)} pJ`);
    has('powergating', `${Math.round(be('hp') * 1e9)} ns`);
    has('powergating', `${Math.round(be('hp') / (plain.period * PS_PER_NAND * 1e-12))} cycles`);
    has('powergating', `${Math.round(be('lp') * 1e6)} µs`);
  });
  it('DVFS at 4 ns per instruction', () => {
    const at = (id: string) => atSpeed(FRONT_CPUS.find((c) => c.id === id)!, 4)!;
    has('dvfs', `${fix(at('pipe-bal').v, 2)} V for ${fix(at('pipe-bal').pj, 1)} pJ`);
    has('dvfs', `${fix(at('sc').v, 2)} V for ${fix(at('sc').pj, 1)} pJ`);
  });
  it('minimum-energy point', () => {
    const m = POWER.minimum.hp, v = POWER.atVdd.hp;
    has('minenergy', `${fix(m.dynPj + m.leakPj, 1)} pJ per instruction at ${m.v} V and ${Math.round(m.mhz)} MHz`);
    has('minenergy', `${fix(v.dynPj + v.leakPj, 1)} pJ at 0.9 V and ${Math.round(v.mhz)} MHz`);
  });
  it('dark silicon', () => {
    const v = POWER.atVdd.hp, area = (plain.nands * NAND2_UM2) / UTILIZATION / 1e6, w = (v.dynPj + v.leakPj) * 1e-12 * v.mhz * 1e6;
    has('darksilicon', `${fix(w / area, 1)} W/mm²`);
    has('darksilicon', `${Math.round((w / area) * 100)} W`);
    has('darksilicon', `${Math.round((100 * 15) / ((w / area) * 100))} %`);
  });
  it('clock gating', () => {
    for (const id of ['clockgating']) {
      has(id, `${plain.pj.toFixed(2)}`);
      has(id, `${gated.pj.toFixed(2)}`);
    }
  });
  it('entries are taught in Power, have two questions, and await a level', () => {
    for (const e of CODEX_POWER) {
      expect(TAUGHT_POWER[e.id]).toBe('power');
      expect(CHECKS[e.id]?.length).toBe(2);
      expect(POWER_AWAITING_LEVELS.has(e.id)).toBe(true);
      expect(NODES.some((n) => n.codex?.includes(e.id)), `${e.id} is in a level now: drop it from POWER_AWAITING_LEVELS`).toBe(false);
    }
    expect(CODEX.filter((e) => TAUGHT_POWER[e.id]).length).toBe(CODEX_POWER.length);
  });
});

describe('clock gate level', () => {
  it('the reference passes at 7 NANDs, a bare AND fails', () => {
    expect(icgBench(RV16_ICG).failures).toEqual([]);
    expect(stats(RV16_ICG).nands).toBe(7);
    const bare = icgBench(define({
      id: 'test_bare_clock_and', name: 'bare AND', category: 'sequential', symbol: { kind: 'box' },
      ports: [{ name: 'en', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in' }, { name: 'gclk', width: 1, dir: 'out' }],
      netlist: () => ({ pins: { en: [0, 1], clk: [0, 3], gclk: [8, 2] }, instances: [{ name: 'and', def: AND, at: [2, 0] }], nets: [{ ends: ['en', 'and.a'] }, { ends: ['clk', 'and.b'] }, { ends: ['and.y', 'gclk'] }] }),
    }));
    expect(bare.failures.length).toBe(1);
  });
});
