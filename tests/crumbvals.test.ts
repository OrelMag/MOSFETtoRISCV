import { describe, expect, it } from 'vitest';
import { rca } from '../src/lib/combinational';
import { merger } from '../src/lib/define';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { ViewCtx } from '../src/view/context';
import { crumbText, crumbTitle, crumbValues } from '../src/view/crumbvals';
import { set } from './util';

/** The chain of levels down a path, as the breadcrumb holds it. */
function chain(root: ViewCtx, path: string[]): ViewCtx[] {
  const out = [root];
  for (const name of path) out.push(out[out.length - 1].child(name)!);
  return out;
}

const texts = (c: ViewCtx[]) => crumbValues(c).map((v) => (v ? crumbText(v, 'hex') : null));

describe('the breadcrumb’s live values', () => {
  it('follows one signal down: the bus in hex at the top, the bit where it was sliced, then the gate', () => {
    const sim = new GateSim(flatten(rca(8)));
    set(sim, { a: 0x0f, b: 0x01, cin: 0 });
    const root = new ViewCtx(sim, sim.design.root);
    const c = chain(root, ['fa4', 'g8']);
    expect(texts(c)).toEqual(['s = 0x10', 'bit [4] = 1', 'y = 1']);
    const v = crumbValues(c);
    expect(crumbTitle(v[1]!, 'fa4', 'rca8')).toBe('fa4.s: bit 4 of rca8.s');
    expect(c[2].isSubSim).toBe(true); // the NAND's transistors, driven by its parent
    // live: the values follow the simulation
    set(sim, { b: 0x00 });
    c[2].sync();
    expect(texts(c)).toEqual(['s = 0x0F', 'bit [4] = 0', 'y = 0']);
  });

  it('picks the output carrying the level below, and leaves the top blank when its pins do not carry it', () => {
    const sim = new GateSim(flatten(rca(8)));
    set(sim, { a: 0x0f, b: 0x01, cin: 0 });
    const c = chain(new ViewCtx(sim, sim.design.root), ['fa4', 'g9']);
    // g9 drives fa4's carry out, an internal net of the adder
    expect(texts(c)).toEqual([null, 'cout = 0', 'y = 0']);
  });

  it('names a run of bits', () => {
    const top: ComponentDef = {
      id: 't_crumb_two_adders', name: 'Two adders', category: 'arithmetic',
      ports: [
        { name: 'a', width: 4, dir: 'in' }, { name: 'b', width: 4, dir: 'in' }, { name: 'c', width: 4, dir: 'in' },
        { name: 'd', width: 4, dir: 'in' }, { name: 'ci', width: 1, dir: 'in' }, { name: 's', width: 8, dir: 'out' },
      ],
      symbol: { kind: 'box' },
      netlist: () => ({
        instances: [
          { name: 'lo', def: rca(4), at: [4, 0] },
          { name: 'hi', def: rca(4), at: [4, 12] },
          { name: 'm', def: merger([4, 4]), at: [30, 6] },
        ],
        nets: [
          { name: 'a', ends: ['a', 'lo.a'] }, { name: 'b', ends: ['b', 'lo.b'] },
          { name: 'c', ends: ['c', 'hi.a'] }, { name: 'd', ends: ['d', 'hi.b'] },
          { name: 'ci', ends: ['ci', 'lo.cin', 'hi.cin'] },
          { name: 'sl', ends: ['lo.s', 'm.i0'] }, { name: 'sh', ends: ['hi.s', 'm.i1'] },
          { name: 's', ends: ['m.out', 's'] },
        ],
      }),
    };
    const sim = new GateSim(flatten(top));
    set(sim, { a: 1, b: 2, c: 3, d: 4, ci: 0 });
    const c = chain(new ViewCtx(sim, sim.design.root), ['hi', 'fa2']);
    expect(texts(c)).toEqual(['s = 0x73', 'bits [7:4] = 0x7', 'bit [2] = 1']);
    expect(crumbTitle(crumbValues(c)[1]!, 'hi', 'Two adders')).toBe('hi.s: bits 7:4 of Two adders.s');
  });
});
