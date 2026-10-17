// Fan-out of a NAND-mapped design, counted from its structure: for every 1-bit net, how many NAND inputs read it.
// The technology setting (lib/tech.ts) prices fan-out: a relay has four contacts, so a net read by more than four
// NAND inputs needs another coil per four more; a tube's plate drives only a few dividers before its levels fail,
// so a wider net needs cathode followers. Counted per definition and memoized like stats(): nets wholly inside a
// part are summed once, and only the counts on its ports travel up to the parent, so a design with hundreds of
// thousands of NANDs and a lazily built memory costs one pass over its distinct parts, never a flattening.

import { stats } from './stats';
import { type ComponentDef, netlistOf } from './types';

/** A part's fan-out as seen from outside it. */
export interface FanInfo {
  /** Per port, per bit: NAND inputs inside the part reading that bit's net. */
  reads: Record<string, number[]>;
  /** Port bits joined inside (a wiring box, a pass-through): [port, bit, port, bit]. */
  links: [string, number, string, number][];
  /** NAND inputs read per net, as a histogram of the nets wholly inside: k → number of nets. */
  hist: Map<number, number>;
}

const cache = new WeakMap<ComponentDef, FanInfo>();

function zeros(def: ComponentDef): Record<string, number[]> {
  const r: Record<string, number[]> = {};
  for (const p of def.ports) r[p.name] = new Array(p.width).fill(0);
  return r;
}

const addHist = (into: Map<number, number>, from: Map<number, number>, times = 1) => {
  for (const [k, n] of from) into.set(k, (into.get(k) ?? 0) + n * times);
};

/**
 * The fan-out structure of a part. A NAND reads each input once; a part priced analytically (statsOf: the Doom
 * WAD ROM) or with no structure (a behaviour, an external source, a transistor primitive) reads each input bit
 * once and has no inner nets.
 */
export function fanInfo(def: ComponentDef): FanInfo {
  const hit = cache.get(def);
  if (hit) return hit;
  const info: FanInfo = { reads: zeros(def), links: [], hist: new Map() };
  cache.set(def, info);
  if (def.prim === 'alias') {
    for (const [pa, ba, pb, bb] of def.alias ?? []) info.links.push([pa, ba, pb, bb]);
    return info;
  }
  const nl = def.prim || def.statsOf ? null : netlistOf(def);
  if (!nl) {
    // A leaf: a NAND, or anything with no NAND structure, reads each input bit once.
    for (const p of def.ports) if (p.dir === 'in') info.reads[p.name].fill(def.prim === 'nand' || stats(def).nands > 0 ? 1 : 0);
    return info;
  }

  // Local bits: the part's own port bits first, then each net's bits; union-find joins them.
  const parent: number[] = [];
  const count: number[] = [];
  const make = () => (parent.push(parent.length), count.push(0), parent.length - 1);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const own: Record<string, number[]> = {};
  for (const p of def.ports) own[p.name] = Array.from({ length: p.width }, make);
  const childPorts = new Map<string, Record<string, number[]>>();
  for (const net of nl.nets) {
    let bits: number[] | null = null;
    for (const end of net.ends) {
      const dot = end.indexOf('.');
      const inst = dot < 0 ? null : end.slice(0, dot), port = dot < 0 ? end : end.slice(dot + 1);
      const target = inst === null ? own[port] : (childPorts.get(inst) ?? childPorts.set(inst, {}).get(inst)!)[port];
      if (inst === null) {
        if (!target) throw new Error(`${def.id}: net references unknown port '${port}'`);
        bits ??= Array.from({ length: target.length }, make);
        bits.forEach((b, i) => union(b, target[i]));
      } else {
        const cp = childPorts.get(inst)!;
        if (cp[port]) {
          bits ??= Array.from({ length: cp[port].length }, make);
          bits.forEach((b, i) => union(b, cp[port][i]));
        } else {
          const w = nl.instances.find((x) => x.name === inst)?.def.ports.find((q) => q.name === port)?.width;
          if (w === undefined) throw new Error(`${def.id}: net references unknown end '${end}'`);
          bits ??= Array.from({ length: w }, make);
          cp[port] = bits;
        }
      }
    }
  }
  for (const inst of nl.instances) {
    const c = fanInfo(inst.def);
    const cp = childPorts.get(inst.name) ?? {};
    const bitsOf = (port: string) => (cp[port] ??= Array.from({ length: inst.def.ports.find((q) => q.name === port)!.width }, make));
    for (const [port, rs] of Object.entries(c.reads)) {
      const bits = bitsOf(port);
      rs.forEach((k, i) => (count[bits[i]] += k));
    }
    for (const [pa, ba, pb, bb] of c.links) union(bitsOf(pa)[ba], bitsOf(pb)[bb]);
    addHist(info.hist, c.hist);
  }
  // Sum the reads per joined net; a net touching a port goes up (to the first port bit on it), the rest stay here.
  const total = new Map<number, number>();
  for (let b = 0; b < parent.length; b++) if (count[b]) total.set(find(b), (total.get(find(b)) ?? 0) + count[b]);
  const portOf = new Map<number, [string, number]>();
  for (const p of def.ports) {
    own[p.name].forEach((b, i) => {
      const r = find(b);
      const first = portOf.get(r);
      if (!first) portOf.set(r, [p.name, i]);
      else info.links.push([first[0], first[1], p.name, i]);
    });
  }
  for (const [r, k] of total) {
    const at = portOf.get(r);
    if (at) info.reads[at[0]][at[1]] += k;
    else info.hist.set(k, (info.hist.get(k) ?? 0) + 1);
  }
  return info;
}

/** Every net of the design with the NAND inputs reading it: the inner nets and the top level's ports. */
export function fanHistogram(def: ComponentDef): Map<number, number> {
  const f = fanInfo(def);
  const h = new Map(f.hist);
  // Ports joined inside count once (the first bit of each link group carries the reads).
  for (const rs of Object.values(f.reads)) for (const k of rs) if (k) h.set(k, (h.get(k) ?? 0) + 1);
  return h;
}

/** Σ over the design's nets of extra(k), k = NAND inputs reading the net. */
export function fanSum(def: ComponentDef, extra: (k: number) => number): number {
  let s = 0;
  for (const [k, n] of fanHistogram(def)) s += n * extra(k);
  return s;
}
