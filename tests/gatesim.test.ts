// GateSim limits: the event wheel grows to hold any leaf delay below MAX_RING (2^16 ticks); a longer one is refused.

import { describe, expect, it } from 'vitest';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef, PortDef } from '../src/sim/types';
import { out, set } from './util';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });

function slowBuffer(delay: number): ComponentDef {
  const buf: ComponentDef = {
    id: `t_buf_${delay}`, name: 'buffer', category: 'gate',
    ports: [bit('a', 'in'), bit('y', 'out')], symbol: { kind: 'box' },
    behavior: { delay, eval: ([a]) => [a] },
  };
  return {
    id: `t_top_${delay}`, name: 'top', category: 'gate', ports: [bit('a', 'in'), bit('y', 'out')], symbol: { kind: 'box' },
    netlist: () => ({ instances: [{ name: 'b', def: buf }], nets: [{ ends: ['a', 'b.a'] }, { ends: ['b.y', 'y'] }] }),
  };
}

describe('GateSim delays', () => {
  it('runs a behavioural leaf at its declared delay', () => {
    const sim = new GateSim(flatten(slowBuffer(63)));
    set(sim, { a: 1 });
    expect(out(sim, 'y')).toBe(1);
  });
  it('grows the event wheel for a delay past its 64 slots, at the exact time', () => {
    const sim = new GateSim(flatten(slowBuffer(200)));
    set(sim, { a: 0 });
    const t0 = sim.time;
    sim.setInput('a', 1);
    sim.runUntil(t0 + 199);
    expect(out(sim, 'y')).toBe(0);
    sim.runUntil(t0 + 200);
    expect(out(sim, 'y')).toBe(1);
  });

  it('refuses a delay the event wheel cannot hold instead of clamping it', () => {
    expect(() => new GateSim(flatten(slowBuffer(1 << 16)))).toThrow(/exceeds the event wheel/);
  });
});
