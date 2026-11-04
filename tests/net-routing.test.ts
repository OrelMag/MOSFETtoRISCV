// Chapter 51's routing protocols on the model network: Dijkstra against an independent exhaustive search, distance vector against Dijkstra
// after it settles, counting to infinity and what poison reverse does about it, the flooding count.

import { describe, expect, it } from 'vitest';
import { CHAIN3, dijkstra, DistVec, downKey, floodAll, floodMessages, INFINITY, NET7, type Topology } from '../src/net/routing';

/** Every simple path: the definition of shortest, independent of Dijkstra. */
function brute(t: Topology, s: number, d: number, down?: Set<string>): number {
  let best = Infinity;
  const walk = (u: number, c: number, seen: Set<number>) => {
    if (u === d) { best = Math.min(best, c); return; }
    for (const l of t.links) {
      if (down?.has(downKey(l.a, l.b))) continue;
      const v = l.a === u ? l.b : l.b === u ? l.a : -1;
      if (v >= 0 && !seen.has(v)) { seen.add(v); walk(v, c + l.cost, seen); seen.delete(v); }
    }
  };
  walk(s, 0, new Set([s]));
  return best;
}

describe('link state', () => {
  it('Dijkstra is the shortest path from every router, whichever link is down', () => {
    const n = NET7.names.length;
    const cases: (Set<string> | undefined)[] = [undefined, ...NET7.links.map((l) => new Set([downKey(l.a, l.b)]))];
    for (const down of cases) for (let s = 0; s < n; s++) {
      const r = dijkstra(NET7, s, down);
      for (let d = 0; d < n; d++) expect(r.dist[d]).toBe(brute(NET7, s, d, down));
    }
  });
  it('the first hop leads along a shortest path', () => {
    for (let s = 0; s < 7; s++) {
      const r = dijkstra(NET7, s);
      for (let d = 0; d < 7; d++) {
        if (d === s) continue;
        const h = r.next[d], l = NET7.links.find((x) => (x.a === s && x.b === h) || (x.b === s && x.a === h))!;
        expect(l.cost + dijkstra(NET7, h).dist[d]).toBe(r.dist[d]);
      }
    }
  });
  it('flooding sends a report over each link at least once, at most twice', () => {
    const links = NET7.links.length;
    for (let o = 0; o < 7; o++) {
      const m = floodMessages(NET7, o);
      expect(m).toBeGreaterThanOrEqual(links);
      expect(m).toBeLessThanOrEqual(2 * links);
    }
    expect(floodMessages(CHAIN3, 0)).toBe(2);
    expect(floodAll(CHAIN3)).toBe(2 + 2 + 2);
  });
});

describe('distance vector', () => {
  it('settles on the same costs as Dijkstra, in about the network\'s diameter of rounds', () => {
    const dv = new DistVec(NET7);
    const k = dv.settle();
    expect(k).toBeLessThanOrEqual(7);
    for (let s = 0; s < 7; s++) expect(dv.dist[s]).toEqual(dijkstra(NET7, s).dist);
  });
  it('good news travels fast: a repaired link settles in a few rounds', () => {
    const dv = new DistVec(NET7);
    dv.settle();
    dv.fail(3, 4); dv.settle();
    dv.repair(3, 4);
    expect(dv.settle()).toBeLessThanOrEqual(5);
    for (let s = 0; s < 7; s++) expect(dv.dist[s]).toEqual(dijkstra(NET7, s).dist);
  });
  it('bad news counts to infinity on a chain', () => {
    const dv = new DistVec(CHAIN3);
    dv.settle();
    expect(dv.dist[0][2]).toBe(2);
    dv.fail(1, 2);
    const history: number[] = [];
    for (let k = 0; k < 30 && dv.round(); k++) history.push(dv.dist[1][2]);
    expect(history.length).toBeGreaterThanOrEqual(10);
    expect(history[0]).toBe(3);
    expect(dv.dist[0][2]).toBe(INFINITY);
    expect(dv.dist[1][2]).toBe(INFINITY);
    expect(history.every((v, i) => i === 0 || v >= history[i - 1])).toBe(true);
  });
  it('poison reverse ends it at once on the chain', () => {
    const dv = new DistVec(CHAIN3, true);
    dv.settle();
    dv.fail(1, 2);
    expect(dv.settle()).toBeLessThanOrEqual(2);
    expect(dv.dist[0][2]).toBe(INFINITY);
  });
  it('the round counts chapter 51 prints', () => {
    const net = new DistVec(NET7); net.settle();
    expect(net.rounds).toBe(6);
    const chain = new DistVec(CHAIN3); chain.settle(); chain.fail(1, 2);
    expect(chain.settle()).toBe(15);
    const poison = new DistVec(CHAIN3, true); poison.settle(); poison.fail(1, 2);
    expect(poison.settle()).toBe(2);
  });
  it('the rounds and messages the chapter quotes', () => {
    const dv = new DistVec(NET7);
    const k = dv.settle();
    expect(dv.messages).toBe((k + 1) * 2 * NET7.links.length);
    expect(floodAll(NET7)).toBeLessThanOrEqual(7 * 2 * NET7.links.length);
  });
});
