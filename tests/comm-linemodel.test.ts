// Roadmap decision 3: on a gate-level scene a line opens onto its model's panel, the one box that does not end in transistors.

import { describe, expect, it } from 'vitest';
import { FSK_LINK, serialLine, SERDES_LINK } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { ViewCtx } from '../src/view/context';
import { bitsInFlight } from '../src/widgets/modelleaf';

const rootOf = (def: ComponentDef) => { const sim = new GateSim(flatten(def)); sim.reset('zero'); return { sim, ctx: new ViewCtx(sim, sim.design.root) }; };

describe('a line part opens onto its model', () => {
  it('the serial line: no structure, still openable, and its state is the bits in flight', () => {
    const { sim, ctx } = rootOf(SERDES_LINK);
    const name = [...ctx.node.children!.keys()].find((n) => ctx.node.children!.get(n)!.def.modelPanel === 'serial')!;
    expect(name).toBeDefined();
    expect(ctx.canOpen(name)).toBe(true);
    expect(ctx.child(name)).toBeNull();
    const li = ctx.node.children!.get(name)!.leafIndex!;
    expect(bitsInFlight(sim.leafState(li))?.length).toBe(serialDelay(ctx.node.children!.get(name)!.def));
  });
  it('the telephone line: its registers stay reachable under the panel', () => {
    const { ctx } = rootOf(FSK_LINK);
    const c = ctx.node.children!.get('line')!;
    expect(c.def.modelPanel).toBe('phone');
    expect(ctx.child('line')).not.toBeNull();
  });
  it('the delay buffer is what the panel reads as bits in flight', () => {
    expect(serialLine(3).modelPanel).toBe('serial');
    expect(bitsInFlight(undefined)).toBeNull();
    expect(bitsInFlight({ q: [1, 0] })).toEqual([1, 0]);
    expect(bitsInFlight({ buf: [1] })).toEqual([1]);
  });
});

function serialDelay(def: ComponentDef): number { return Number(/^serline(\d+)$/.exec(def.id)![1]); }
