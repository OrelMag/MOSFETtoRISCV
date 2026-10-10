// Storage clusters for the cycle engine (cyclesim.ts): which NANDs of a flat design to tabulate
// as one state machine (ffmacro.ts), found from the structure alone, so a flip-flop drawn from
// NANDs in the sandbox, a latch with a reset or the library's DFF are all recognized the same way
// (a `ff` mark is never trusted, and not needed).
//
// Storage is short loops: the cross-coupled gates of a latch (at most SHORT gates around). Longer
// loops pass through storage (a counter's q → adder → d) and are ordinary logic once the storage is
// cut out. So a round finds the loops among gates outside clusters (strongly connected NANDs), and
// seeds a cluster with each group of gates on short loops (or with a whole loop that has none: a
// ring oscillator); a cluster then takes in a NAND whose output only it reads (a latch's input
// gates, the clock inverter inside a flip-flop, the inverter of d) when that gate reads a net that
// follows a pin of the chip or adds no input, and a latch takes in another whose outputs only it
// reads (the master into the slave: pairs within the deepest instance first, so a chain of
// flip-flops drawn flat stays a chain). Rounds repeat while loops remain. Gates that compute data
// in front of a flip-flop stay outside: they are logic. A cluster has at most MAX_IN inputs.
//
// Nets that follow a pin of the chip through a chain of inverters (`chain*`: the pin itself, its
// inverse, a buffer) change exactly that many delays after the pin; the cycle engine schedules
// them in its tables instead of guessing when they arrive.

import type { FlatDesign, HierNode } from './flatten';
import { MAX_IN } from './ffmacro';

/** NANDs in one cluster at most. */
export const MAX_GATES = 160;
/** Inverters in a chain from a pin at most. */
export const MAX_CHAIN = 4;
/** A loop of at most this many gates is storage; longer ones go through storage. */
const SHORT = 6;
/** A seed of at most this many gates is a latch, which may pair with another. */
const LATCH = 6;
/** Gates one search for a short loop visits at most (a missed loop is found in a later round). */
const SEARCH = 1024;
const ROUNDS = 8;

export interface Cluster {
  /** Its NAND leaves, ascending. */
  leaves: number[];
  /** Local net → design net. */
  nets: number[];
  /** a, b, y of each gate (local nets, in leaf order). */
  gates: number[];
  /** Local nets read and not driven inside (in order of first use), and those driven inside and read outside. */
  ins: number[];
  outs: number[];
  /** The lowest instance holding all of it. */
  node: HierNode;
  /** Its structure: two clusters with the same key share a table. */
  key: string;
}

export interface Clusters {
  clusters: Cluster[];
  /** Per net: the root input pin it follows through inverters (−1: none), how many, and whether inverted. */
  chainRoot: Int32Array;
  chainDelay: Uint8Array;
  chainParity: Uint8Array;
  /** The leaf driving each net (−1: none). */
  driver: Int32Array;
  /** Readers of each net (leaves, CSR). */
  rdStart: Int32Array;
  rdList: Int32Array;
}

export function findClusters(design: FlatDesign): Clusters | { reason: string } {
  const leaves = design.leaves, L = leaves.length, n = design.netCount;
  const isNand = Uint8Array.from(leaves, (l) => (l.kind === 'nand' ? 1 : 0));
  const ga = Int32Array.from(leaves, (l) => (l.kind === 'nand' ? l.inputs[0][0] : -1));
  const gb = Int32Array.from(leaves, (l) => (l.kind === 'nand' ? l.inputs[1][0] : -1));
  const gy = Int32Array.from(leaves, (l) => (l.kind === 'nand' ? l.outputs[0][0] : -1));
  const driver = new Int32Array(n).fill(-1);
  leaves.forEach((l, li) => { for (const p of l.outputs) for (const net of p) driver[net] = li; });
  const rdStart = new Int32Array(n + 1);
  for (const l of leaves) for (const p of l.inputs) for (const net of p) rdStart[net + 1]++;
  for (let i = 0; i < n; i++) rdStart[i + 1] += rdStart[i];
  const rdList = new Int32Array(rdStart[n]);
  {
    const at = rdStart.slice(0, n);
    leaves.forEach((l, li) => { for (const p of l.inputs) for (const net of p) rdList[at[net]++] = li; });
  }

  // chains of inverters (a NAND with both inputs on one net) from the root input pins
  const chainRoot = new Int32Array(n).fill(-1), chainDelay = new Uint8Array(n), chainParity = new Uint8Array(n);
  const work: number[] = [];
  for (const p of design.root.def.ports) {
    if (p.dir !== 'in') continue;
    for (const net of design.root.ports[p.name]) { chainRoot[net] = net; work.push(net); }
  }
  while (work.length) {
    const x = work.pop()!;
    if (chainDelay[x] >= MAX_CHAIN) continue;
    for (let i = rdStart[x]; i < rdStart[x + 1]; i++) {
      const g = rdList[i];
      if (!isNand[g] || ga[g] !== x || gb[g] !== x || chainRoot[gy[g]] >= 0) continue;
      const y = gy[g];
      chainRoot[y] = chainRoot[x];
      chainDelay[y] = chainDelay[x] + 1;
      chainParity[y] = chainParity[x] ^ 1;
      work.push(y);
    }
  }

  const cl = new Int32Array(L).fill(-1);
  const members: number[][] = [], alive: boolean[] = [], single: boolean[] = [];
  const free = (g: number) => isNand[g] === 1 && cl[g] < 0;
  const where = (gs: number[]) => {
    const node = lca(gs);
    return node.path.join('.') || 'the chip';
  };
  const lca = (gs: number[]): HierNode => {
    const p0 = leaves[gs[0]].node.path;
    let k = p0.length;
    for (const g of gs) {
      const p = leaves[g].node.path;
      let i = 0;
      while (i < k && i < p.length && p[i] === p0[i]) i++;
      k = i;
    }
    let node = leaves[gs[0]].node;
    while (node.path.length > k && node.parent) node = node.parent;
    return node;
  };

  /** Loops among the gates outside clusters: strongly connected sets (Tarjan, iterative), and self-loops. */
  const index = new Int32Array(L), low = new Int32Array(L), onStack = new Uint8Array(L);
  const loops = (): number[][] => {
    index.fill(-1);
    const stack: number[] = [], found: number[][] = [];
    let counter = 0;
    for (let v = 0; v < L; v++) {
      if (!free(v) || index[v] >= 0) continue;
      const calls: [number, number][] = [[v, rdStart[gy[v]]]];
      index[v] = low[v] = counter++;
      stack.push(v);
      onStack[v] = 1;
      while (calls.length) {
        const top = calls[calls.length - 1], u = top[0], end = rdStart[gy[u] + 1];
        if (top[1] < end) {
          const w = rdList[top[1]++];
          if (!free(w)) continue;
          if (index[w] < 0) {
            index[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = 1;
            calls.push([w, rdStart[gy[w]]]);
          } else if (onStack[w] && index[w] < low[u]) low[u] = index[w];
          continue;
        }
        calls.pop();
        if (calls.length) {
          const p = calls[calls.length - 1][0];
          if (low[u] < low[p]) low[p] = low[u];
        }
        if (low[u] !== index[u]) continue;
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w);
        } while (w !== u);
        if (comp.length > 1 || ga[u] === gy[u] || gb[u] === gy[u]) found.push(comp.sort((a, b) => a - b));
      }
    }
    return found.sort((a, b) => a[0] - b[0]);
  };

  /** Groups of the gates of a loop that lie on short loops (a short loop joins its gates). */
  const mark = new Int32Array(L), seen = new Int32Array(L), parent = new Int32Array(L), dist = new Uint8Array(L);
  let stamp = 0, sccId = 0;
  const shortLoops = (scc: number[]): number[][] => {
    sccId++;
    for (const g of scc) mark[g] = sccId;
    const up = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while (up.get(r) !== r) r = up.get(r)!;
      for (let y = x; y !== r;) { const nx = up.get(y)!; up.set(y, r); y = nx; }
      return r;
    };
    const join = (a: number, b: number) => {
      if (!up.has(a)) up.set(a, a);
      if (!up.has(b)) up.set(b, b);
      up.set(find(a), find(b));
    };
    /** A gate reading g's output that g reads (a cross-coupled pair), or −1. */
    const partnerOf = (g: number): number => {
      for (let i = rdStart[gy[g]]; i < rdStart[gy[g] + 1]; i++) {
        const w = rdList[i];
        if (mark[w] === sccId && w !== g && (ga[g] === gy[w] || gb[g] === gy[w])) return w;
      }
      return -1;
    };
    for (const g of scc) {
      if (ga[g] === gy[g] || gb[g] === gy[g]) { join(g, g); continue; }
      // a cross-coupled pair, cheaply; else a breadth-first search for the shortest loop through g
      const w0 = partnerOf(g);
      if (w0 >= 0) { join(g, w0); continue; }
      stamp++;
      const queue = [g];
      seen[g] = stamp;
      dist[g] = 0;
      let visits = 0;
      search: for (let h = 0; h < queue.length && visits < SEARCH; h++) {
        const u = queue[h];
        if (dist[u] >= SHORT) continue;
        for (let i = rdStart[gy[u]]; i < rdStart[gy[u] + 1]; i++) {
          const w = rdList[i];
          if (mark[w] !== sccId) continue;
          if (w === g) {
            for (let x = u; x !== g; x = parent[x]) join(g, x);
            break search;
          }
          if (seen[w] === stamp) continue;
          seen[w] = stamp;
          parent[w] = u;
          dist[w] = dist[u] + 1;
          queue.push(w);
          visits++;
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (const g of up.keys()) {
      const r = find(g);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(g);
    }
    return [...groups.values()].map((x) => x.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  };

  const inside = (net: number, c: number) => driver[net] >= 0 && cl[driver[net]] === c;
  const inputsOf = (c: number): Set<number> => {
    const s = new Set<number>();
    for (const g of members[c]) {
      if (!inside(ga[g], c)) s.add(ga[g]);
      if (!inside(gb[g], c)) s.add(gb[g]);
    }
    return s;
  };
  const readOnlyBy = (net: number, c: number) => {
    for (let i = rdStart[net]; i < rdStart[net + 1]; i++) if (cl[rdList[i]] !== c) return false;
    return true;
  };
  /** Take in, until nothing changes, the gates only a cluster reads that follow a pin or add no input. */
  const absorb = (): void => {
    for (let changed = true; changed;) {
      changed = false;
      for (let c = 0; c < members.length; c++) {
        if (!alive[c]) continue;
        let ins = inputsOf(c);
        for (const x of [...ins]) {
          const d = driver[x];
          if (!ins.has(x) || d < 0 || !free(d) || !readOnlyBy(x, c) || members[c].length >= MAX_GATES) continue;
          const add = [...new Set([ga[d], gb[d]])].filter((v) => !ins.has(v) && !inside(v, c));
          const count = ins.size - 1 + add.length;
          if (count > Math.max(MAX_IN, ins.size)) continue;
          if (count > ins.size && chainRoot[ga[d]] < 0 && chainRoot[gb[d]] < 0) continue;
          cl[d] = c;
          members[c].push(d);
          ins = inputsOf(c);
          changed = true;
        }
      }
    }
  };
  /** A latch whose outputs only another latch reads joins it (the deepest common instances first). */
  const pair = (): void => {
    const pairs: [number, number, number][] = [];
    for (let b = 0; b < members.length; b++) {
      if (!alive[b] || !single[b]) continue;
      const readers = new Set<number>();
      for (const g of members[b]) for (let i = rdStart[gy[g]]; i < rdStart[gy[g] + 1]; i++) if (cl[rdList[i]] !== b) readers.add(cl[rdList[i]]);
      const c = readers.size === 1 ? [...readers][0] : -1;
      if (c >= 0 && single[c]) pairs.push([lca([...members[b], ...members[c]]).path.length, b, c]);
    }
    pairs.sort((x, y) => y[0] - x[0] || members[x[1]][0] - members[y[1]][0]);
    for (const [, b, c] of pairs) {
      if (!single[b] || !single[c] || !alive[b] || !alive[c] || members[b].length + members[c].length > MAX_GATES) continue;
      const before = Math.max(MAX_IN, inputsOf(b).size, inputsOf(c).size);
      for (const g of members[b]) cl[g] = c;
      if (inputsOf(c).size > before) {
        for (const g of members[b]) cl[g] = b;
        continue;
      }
      members[c].push(...members[b]);
      members[b] = [];
      alive[b] = false;
      single[c] = false;
    }
  };

  for (let round = 0; ; round++) {
    const found = loops();
    if (!found.length) break;
    if (round >= ROUNDS) return { reason: `${where(found[0])}: loops within loops the cycle engine cannot cut into storage` };
    for (const scc of found) {
      const groups = shortLoops(scc);
      if (!groups.length) {
        if (scc.length > MAX_GATES) return { reason: `${where(scc)}: a loop of ${scc.length} gates with no latch in it` };
        groups.push(scc);
      }
      for (const g of groups) {
        const c = members.length;
        members.push(g.slice());
        alive.push(true);
        single.push(g.length <= LATCH);
        for (const x of g) cl[x] = c;
      }
    }
    absorb();
    pair();
    absorb();
  }

  const clusters: Cluster[] = [];
  for (let c = 0; c < members.length; c++) {
    if (!alive[c]) continue;
    const gs = members[c].sort((a, b) => a - b);
    const local = new Map<number, number>(), nets: number[] = [];
    const id = (net: number) => {
      let k = local.get(net);
      if (k === undefined) { k = nets.length; local.set(net, k); nets.push(net); }
      return k;
    };
    const gates: number[] = [];
    for (const g of gs) gates.push(id(ga[g]), id(gb[g]), id(gy[g]));
    const driven = new Set(gs.map((g) => gy[g]));
    const ins: number[] = [], outs: number[] = [];
    for (let k = 0; k < nets.length; k++) {
      const net = nets[k];
      if (!driven.has(net)) ins.push(k);
      else if (!readOnlyBy(net, c)) outs.push(k);
    }
    const node = lca(gs);
    const at = node.path.join('.') || 'the chip';
    if (ins.length > MAX_IN) return { reason: `${at}: storage with ${ins.length} inputs (the cycle engine tabulates at most ${MAX_IN}: draw each flip-flop as a chip of its own)` };
    if (gs.length > MAX_GATES) return { reason: `${at}: storage of ${gs.length} gates (the cycle engine tabulates at most ${MAX_GATES})` };
    clusters.push({ leaves: gs, nets, gates, ins, outs, node, key: `${gates.join(',')}|${ins.join(',')}|${outs.join(',')}` });
  }
  return { clusters, chainRoot, chainDelay, chainParity, driver, rdStart, rdList };
}
