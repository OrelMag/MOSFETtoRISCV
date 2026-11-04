// How routers learn their tables (chapter 51), on a network that is a model: routers and links with a cost, no packets. Distance vector
// in synchronous rounds (what RIP does) and link state (what OSPF does: flood every link's state, then Dijkstra). The network is invented,
// and labelled so; the site never touches the learner's real one (roadmap decision 6).

export interface Link { a: number; b: number; cost: number }
export interface Topology { names: string[]; at: [number, number][]; links: Link[] }

/** Seven routers, in a 600 × 300 drawing. Invented: no address or name here belongs to anything real. */
export const NET7: Topology = {
  names: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  at: [[60, 150], [190, 60], [190, 240], [320, 150], [450, 60], [450, 240], [550, 150]],
  links: [{ a: 0, b: 1, cost: 1 }, { a: 0, b: 2, cost: 4 }, { a: 1, b: 2, cost: 2 }, { a: 1, b: 3, cost: 5 }, { a: 2, b: 3, cost: 1 }, { a: 3, b: 4, cost: 3 }, { a: 3, b: 5, cost: 2 }, { a: 4, b: 5, cost: 1 }, { a: 4, b: 6, cost: 2 }, { a: 5, b: 6, cost: 6 }],
};
/** The textbook chain for counting to infinity: A - B - C. */
export const CHAIN3: Topology = { names: ['A', 'B', 'C'], at: [[100, 80], [300, 80], [500, 80]], links: [{ a: 0, b: 1, cost: 1 }, { a: 1, b: 2, cost: 1 }] };

/** RIP's infinity: a cost of 16 means unreachable, which bounds the count at the price of the network's diameter. */
export const INFINITY = 16;

const linkKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
export type Down = ReadonlySet<string>;
export const downKey = linkKey;
const upLinks = (t: Topology, down?: Down) => t.links.filter((l) => !down?.has(linkKey(l.a, l.b)));

function neighbours(t: Topology, n: number, down?: Down): { to: number; cost: number }[] {
  return upLinks(t, down).flatMap((l) => (l.a === n ? [{ to: l.b, cost: l.cost }] : l.b === n ? [{ to: l.a, cost: l.cost }] : []));
}

export interface Dijkstra { dist: number[]; prev: number[]; next: number[]; order: number[] }

/** Shortest paths from src. `next` is the first hop, which is all a router installs; -1 is unreachable or src itself. */
export function dijkstra(t: Topology, src: number, down?: Down): Dijkstra {
  const n = t.names.length, dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false), order: number[] = [];
  dist[src] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    done[u] = true; order.push(u);
    for (const e of neighbours(t, u, down)) if (dist[u] + e.cost < dist[e.to]) { dist[e.to] = dist[u] + e.cost; prev[e.to] = u; }
  }
  const next = dist.map((d, i) => {
    if (i === src || d === Infinity) return -1;
    let x = i;
    while (prev[x] !== src) x = prev[x];
    return x;
  });
  return { dist, prev, next, order };
}

/** Flooding one router's links: each router forwards a new report on every link but the one it came in on, once. Messages sent. */
export function floodMessages(t: Topology, origin: number, down?: Down): number {
  const seen = new Set([origin]);
  let frontier: { at: number; from: number }[] = [{ at: origin, from: -1 }], msgs = 0;
  while (frontier.length) {
    const nextF: typeof frontier = [];
    for (const f of frontier) for (const e of neighbours(t, f.at, down)) {
      if (e.to === f.from) continue;
      msgs++;
      if (!seen.has(e.to)) { seen.add(e.to); nextF.push({ at: e.to, from: f.at }); }
    }
    frontier = nextF;
  }
  return msgs;
}

/** Everybody floods once: what link state costs to (re)converge from nothing. */
export const floodAll = (t: Topology, down?: Down): number => t.names.reduce((a, _, i) => a + floodMessages(t, i, down), 0);

/** Distance vector: every router tells its neighbours its whole table each round, and believes them. */
export class DistVec {
  dist: number[][];
  via: number[][];
  down = new Set<string>();
  rounds = 0;
  messages = 0;
  constructor(public t: Topology, public poison = false) {
    const n = t.names.length;
    this.dist = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : INFINITY)));
    this.via = Array.from({ length: n }, () => new Array<number>(n).fill(-1));
  }
  /** What n tells neighbour m: with poison reverse, a route through m comes back as unreachable. */
  advertised(n: number, m: number, dest: number): number {
    return this.poison && this.via[n][dest] === m ? INFINITY : this.dist[n][dest];
  }
  /** One round, all at once. Returns whether any table changed. */
  round(): boolean {
    const n = this.t.names.length, nd = this.dist.map((r) => [...r]), nv = this.via.map((r) => [...r]);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const nb = neighbours(this.t, i, this.down);
      this.messages += nb.length;
      for (let d = 0; d < n; d++) {
        if (d === i) continue;
        let best = INFINITY, via = -1;
        for (const e of nb) {
          const c = Math.min(INFINITY, e.cost + this.advertised(e.to, i, d));
          if (c < best) { best = c; via = e.to; }
        }
        if (best !== nd[i][d] || via !== nv[i][d]) changed = true;
        nd[i][d] = best; nv[i][d] = via;
      }
    }
    this.dist = nd; this.via = nv; this.rounds++;
    return changed;
  }
  /** Rounds until nothing changes (bounded: a count to infinity ends at 16). */
  settle(limit = 64): number {
    let k = 0;
    while (k < limit && this.round()) k++;
    return k;
  }
  fail(a: number, b: number): void { this.down.add(linkKey(a, b)); }
  repair(a: number, b: number): void { this.down.delete(linkKey(a, b)); }
}
