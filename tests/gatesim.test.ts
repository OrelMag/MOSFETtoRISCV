// GateSim limits: the event wheel holds 64 time slots, so a leaf delay must stay below 64.

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
  it('refuses a delay the event wheel cannot hold instead of clamping it', () => {
    expect(() => new GateSim(flatten(slowBuffer(64)))).toThrow(/exceeds the event wheel/);
  });
});
