// Colour per net: a net's hue depends only on its identity (name, else its ends in any order),
// stays clear of the X red and spreads over the allowed range; nets drawn side by side are pushed
// apart (spreadHues) while the others keep their own hue.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { pipelinedCpu, singleCycleCpu } from '../src/lib';
import { netlistOf } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { type HueNet, netHue, netKey, spreadHues } from '../src/view/nethue';

const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const line = (key: string, y: number, x0 = 0, x1 = 30): HueNet => ({ key, polys: [[[x0, y], [x1, y]]] });
/** Two keys whose own hues are within 10° of each other. */
function twins(): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; ; i++) {
    const k = `n${i}`, h = netHue(k);
    for (let d = -9; d <= 9; d++) { const t = seen.get(h + d); if (t) return [t, k]; }
    seen.set(h, k);
  }
}

describe('net hues', () => {
  it('come from the name, else the ends in any order', () => {
    expect(netKey({ name: 'pc', ends: ['a.y', 'b.a'] })).toBe('pc');
    expect(netKey({ ends: ['b.a', 'a.y'] })).toBe(netKey({ ends: ['a.y', 'b.a'] }));
    expect(netHue('pc')).toBe(netHue('pc'));
  });

  it('stay in 40°–320° and spread over it', () => {
    const hues = Array.from({ length: 400 }, (_, i) => netHue(`fa${i}.cout`));
    for (const h of hues) expect(h >= 40 && h <= 320 && Number.isInteger(h)).toBe(true);
    const buckets = new Set(hues.map((h) => Math.floor((h - 40) / 20)));
    expect(buckets.size).toBe(15); // every 20° bucket of the range is used
  });

  it('push neighbours with close hues apart and leave the others alone', () => {
    const [a, b] = twins();
    const hues = spreadHues([line(a, 0), line(b, 1), line(`${b}'`, 40), line('far', 80)]);
    expect(dist(hues[0], hues[1])).toBeGreaterThanOrEqual(60);
    expect(hues[0] === netHue(a) || hues[1] === netHue(b)).toBe(true); // one of them keeps its own
    expect(hues[2]).toBe(netHue(`${b}'`)); // far from both
    expect(hues[3]).toBe(netHue('far'));
    // A crossing makes neighbours too, and the result does not depend on the order of the nets.
    const cross: HueNet[] = [line(a, 5), { key: b, polys: [[[10, 0], [10, 20]]] }];
    const h2 = spreadHues(cross), h3 = spreadHues([...cross].reverse()).reverse();
    expect(dist(h2[0], h2[1])).toBeGreaterThanOrEqual(60);
    expect(h3).toEqual(h2);
  });

  it('leave no two neighbouring nets of a CPU within 20°', () => {
    const w = assemble(PROGRAMS[0].source).words;
    for (const def of [singleCycleCpu(w), pipelinedCpu(w)]) {
      const nl = netlistOf(def)!;
      const routed = routeNetlist(def, nl).nets;
      const hues = spreadHues(routed.map((n) => ({ key: netKey(nl.nets[n.index]), polys: n.paths })));
      // Neighbours: a point of one within a unit of the other's polyline (axis-aligned segments).
      const near = (p: readonly number[], q: HueNet['polys']) => q.some((poly) => poly.some((v, i) => i > 0 &&
        p[0] >= Math.min(v[0], poly[i - 1][0]) - 1 && p[0] <= Math.max(v[0], poly[i - 1][0]) + 1 &&
        p[1] >= Math.min(v[1], poly[i - 1][1]) - 1 && p[1] <= Math.max(v[1], poly[i - 1][1]) + 1));
      for (let i = 0; i < routed.length; i++) for (let j = i + 1; j < routed.length; j++) {
        const pts = routed[i].paths.flatMap((p) => p.flatMap((v, k) => k ? [v, [(v[0] + p[k - 1][0]) / 2, (v[1] + p[k - 1][1]) / 2]] : [v]));
        if (pts.some((p) => near(p, routed[j].paths))) expect(dist(hues[i], hues[j]), `${def.id}: ${netKey(nl.nets[routed[i].index])} / ${netKey(nl.nets[routed[j].index])}`).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
