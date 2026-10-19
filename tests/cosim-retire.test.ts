// How many instructions retire at the next edge (riscv/cosim.ts retireCount / retirePc), for every way a CPU says
// it: none (one a cycle), a 1-bit validW / retire, and a wider retire that counts the instructions retiring together
// (a CPU that retires several a cycle); detectCpu takes a 2-bit retire pin as such a CPU.

import { describe, expect, it } from 'vitest';
import { detectCpu } from '../src/editor/cpu';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { emptyWorkspace } from '../src/editor/model';
import { retireCount, retirePc, retiring } from '../src/riscv/cosim';
import type { HierNode } from '../src/sim/flatten';
import type { Bit } from '../src/sim/types';

/** A simulation of a root whose ports sit on nets 0, 1, …, holding `bits`. */
function fake(ports: Record<string, number[]>, bits: Bit[]) {
  const root = { ports } as unknown as HierNode;
  return { sim: { getBits: (nets: number[]) => nets.map((n) => bits[n]), design: { root } } as never, root };
}

describe('retireCount', () => {
  it('no retire output: one instruction every cycle', () => {
    const { sim } = fake({}, []);
    expect(retireCount(sim)).toBe(1);
    expect(retiring(sim)).toBe(true);
  });

  it('a 1-bit validW or retire: 0 or 1', () => {
    expect(retireCount(fake({ validW: [0] }, [1]).sim)).toBe(1);
    expect(retireCount(fake({ retire: [0] }, [0]).sim)).toBe(0);
    expect(retiring(fake({ retire: [0] }, [0]).sim)).toBe(false);
  });

  it('a 2-bit retire is the count, least significant bit first; an X bit counts as 0', () => {
    for (const [bits, n] of [[[0, 0], 0], [[1, 0], 1], [[0, 1], 2], [[1, 1], 3], [[2, 1], 2]] as [Bit[], number][])
      expect(retireCount(fake({ retire: [0, 1] }, bits).sim), JSON.stringify(bits)).toBe(n);
  });

  it('validW wins over retire (a pipeline with both)', () => {
    expect(retireCount(fake({ validW: [0], retire: [1, 2] }, [0, 1, 1]).sim)).toBe(0);
  });
});

describe('retirePc', () => {
  const word = (v: number) => Array.from({ length: 32 }, (_, i) => ((v >>> i) & 1) as Bit);
  const nets = Array.from({ length: 32 }, (_, i) => i), nets2 = nets.map((n) => n + 32);

  it('pcW0 (the oldest of several) before pcW; null without either', () => {
    const { sim, root } = fake({ pcW0: nets, pcW: nets2 }, [...word(0x40), ...word(0x44)]);
    expect(retirePc(sim, root)).toBe(0x40);
    const one = fake({ pcW: nets }, word(0x8000_0010));
    expect(retirePc(one.sim, one.root)).toBe(0x8000_0010);
    const none = fake({}, []);
    expect(retirePc(none.sim, none.root)).toBeNull();
  });
});

describe('detectCpu: a 2-bit retire pin', () => {
  it('counts the instructions retiring together and is checked like a pipeline', () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'fetch')!);
    const doc = ws.chips[id];
    const pin = { ...doc.pins.find((p) => p.dir === 'out') ?? doc.pins[0], id: 'p_retire', name: 'retire', dir: 'out' as const, width: 2 };
    const d = detectCpu({ ...doc, pins: [...doc.pins, pin] })!;
    expect(d.retire).toEqual({ pin: 'p_retire' });
    expect(d.pipeline).toBe(true);
  });
});
