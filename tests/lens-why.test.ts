// Track 2b of the zoom lens (docs/transparent/DESIGN.md): Why? and Break a part across the rim. A trace clicked inside an
// opened box that reaches its rim continues on the outer level, and one clicked outside that reaches the box continues
// inside: each side names the same causes as the drilled level would. The lens's Each part table is the drilled level's.
import { describe, expect, it } from 'vitest';
import { rca } from '../src/lib';
import { ablate } from '../src/sim/ablate';
import { acrossRim, explainNets } from '../src/sim/explain';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { ViewCtx } from '../src/view/context';
import { levelAblation } from '../src/view/whypanel';

function scene(def: ComponentDef, inputs: Record<string, number>): ViewCtx {
  const s = new GateSim(flatten(def, { mode: 'gate' }));
  s.reset('zero');
  for (const [k, v] of Object.entries(inputs)) s.setInput(k, v);
  s.settle();
  return new ViewCtx(s, s.design.root);
}

/** The level's wire with this end, as a click on it there would pick it. */
const wireAt = (ctx: ViewCtx, end: string) => netlistOf(ctx.def)!.nets.findIndex((n) => n.ends.includes(end));

const said = (r: { lines: string[] }) => r.lines;

describe('a trace across the rim', () => {
  const ADD = rca(4);
  // a + b with carries rippling through fa1: its cin is 1, decided outside it
  const top = scene(ADD, { a: 0b0011, b: 0b0001, cin: 0 });
  const box = 'fa1';
  const lens = top.child(box)!;
  const side = (c: ViewCtx) => ({ sim: c.sim, node: c.node });

  it('from inside the box to the outer level: the causes are the drilled outer level\'s', () => {
    // fa1's sum, traced inside it
    const inner = explainNets(lens.sim, lens.node.nets![wireAt(lens, 's')], lens.node);
    expect(inner.steps.some((s) => s.inst === null && s.port === 'cin')).toBe(true);
    const cross = acrossRim(inner.steps, 'inner', side(lens), side(top), box);
    const cin = cross.find((c) => c.port === 'cin')!;
    expect(cin).toBeTruthy();
    // drilled: the outer level on screen, a click on the wire into fa1.cin
    const drilled = explainNets(top.sim, top.node.nets![wireAt(top, 'fa1.cin')], top.node);
    expect(said(cin)).toEqual(said(drilled));
    expect(cin.steps.map((s) => `${s.inst}.${s.port}`)).toEqual(drilled.steps.map((s) => `${s.inst}.${s.port}`));
    // and it reaches the outer level's input pins, which the inner trace alone cannot name
    expect(cin.steps.some((s) => s.kind === 'pin')).toBe(true);
    // every input the inner trace rests on crosses, and nothing else does
    const ports = inner.steps.filter((s) => s.inst === null).map((s) => s.port).sort();
    expect(cross.map((c) => c.port).sort()).toEqual(ports);
  });

  it('from the outer level into the box: the causes are the drilled inner level\'s', () => {
    const outer = explainNets(top.sim, top.node.nets![wireAt(top, 'fa1.cout')], top.node);
    const cross = acrossRim(outer.steps, 'outer', side(lens), side(top), box);
    const cout = cross.find((c) => c.port === 'cout')!;
    expect(cout).toBeTruthy();
    const drilled = explainNets(lens.sim, lens.node.nets![wireAt(lens, 'cout')], lens.node);
    expect(said(cout)).toEqual(said(drilled));
    // only the box's own outputs cross
    for (const c of cross) expect(c.from.inst).toBe(box);
  });

  it('a step of another part does not cross', () => {
    const outer = explainNets(top.sim, top.node.nets![wireAt(top, 'fa0.cout')], top.node);
    expect(acrossRim(outer.steps, 'outer', side(lens), side(top), box)).toEqual([]);
  });

  it('follows the values: after an input changes the crossing says the new ones', () => {
    const t = scene(ADD, { a: 0b0011, b: 0b0001, cin: 0 });
    const l = t.child(box)!;
    t.sim.setInput('a', 0b0000);
    t.sim.settle();
    const inner = explainNets(l.sim, l.node.nets![wireAt(l, 's')], l.node);
    const cin = acrossRim(inner.steps, 'inner', side(l), side(t), box).find((c) => c.port === 'cin')!;
    expect(said(cin)).toEqual(said(explainNets(t.sim, t.node.nets![wireAt(t, 'fa1.cin')], t.node)));
    expect(cin.lines[0]).toMatch(/= 0/);
  });
});

describe('Break a part in the lens', () => {
  it('the table of the level a lens shows equals the drilled level\'s', () => {
    const top = scene(rca(4), { a: 5, b: 9, cin: 1 });
    const lens = top.child('fa2')!;
    const a = levelAblation(lens);
    expect(typeof a).not.toBe('string');
    // drilled: the stage's own level on screen is that child
    expect(a).toEqual(ablate(lens.node.def));
    expect(a).toEqual(levelAblation(top.child('fa2')!));
    if (typeof a !== 'string') {
      expect(a.parts.map((p) => p.inst).sort()).toEqual([...lens.node.children!.keys()].filter((n) => lens.node.children!.get(n)!.def.prim !== 'alias').sort());
      // the 9-NAND full adder's own table: 8 rows, two outputs; its last gate serves cout alone, the three before it s alone
      expect(a.rows).toBe(8);
      expect(a.outputs).toEqual(['s', 'cout']);
      expect(a.parts.find((p) => p.inst === 'g9')!.serves).toEqual(['cout']);
      for (const g of ['g6', 'g7', 'g8']) expect(a.parts.find((p) => p.inst === g)!.serves).toEqual(['s']);
    }
  });

  it('is off, with the reason, on a level too wide for a truth table (the CPU\'s ALU)', async () => {
    const { ablationRefusal } = await import('../src/sim/ablate');
    const { alu } = await import('../src/lib');
    expect(ablationRefusal(alu(32))).toBe('68 input bits: the table would have 2^68 rows (at most 12 bits)');
  });
});

describe('a cover growing beside an open lens', () => {
  it('shrinks it into the free stage instead of stepping in', async () => {
    const { freeStage, growPlan, openPlan } = await import('../src/view/lensplan');
    const canvas = { w: 962, h: 611 }, extent = { w: 78, h: 146 }, box = { x: 264, y: 140, w: 115, h: 168 };
    const opened = openPlan(box, extent, 4, freeStage(canvas, [], extent))!;
    // the Why? card grows down the left with a long trace: the free stage is the strip beside it
    const free = freeStage(canvas, [{ x: 12, y: 12, w: 380, h: 560 }], extent);
    // zoomed on since it opened: the lens has grown to nearly the whole canvas
    const g = growPlan({ plan: opened, boxH: box.h / 1.6 }, box, extent, free);
    expect(g.handoff).toBe(true);
    const shrunk = openPlan(box, extent, Infinity, free)!;
    expect(shrunk).toBeTruthy();
    const r = shrunk.rect;
    expect(r.x >= free.x && r.y >= free.y && r.x + r.w <= free.x + free.w + 1e-6 && r.y + r.h <= free.y + free.h + 1e-6).toBe(true);
  });
});
