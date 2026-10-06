// Physical design in miniature: every NAND of a flattened netlist becomes a standard cell, a
// simulated-annealing placer puts the cells on a grid of sites, and a maze router (Lee's
// algorithm, Dijkstra with costs) connects the pins on two metal layers: layer 0 runs only
// horizontally, layer 1 only vertically, and a via joins them.

import type { ComponentDef } from './types';
import { flatten } from './flatten';

export interface Problem {
  /** Per cell: the nets on pins a, b, y. */
  cells: [number, number, number][];
  /** Chip-level pins: inputs on the left edge, outputs on the right. */
  io: { net: number; name: string; side: 'L' | 'R' }[];
  /** Nets with at least two terminals. */
  nets: number[];
}

export function problemOf(def: ComponentDef): Problem {
  const d = flatten(def);
  const cells: [number, number, number][] = [];
  for (const l of d.leaves) if (l.kind === 'nand') cells.push([l.inputs[0][0], l.inputs[1][0], l.outputs[0][0]]);
  const io: Problem['io'] = [];
  for (const p of def.ports) d.root.ports[p.name].forEach((net, i) => io.push({ net, name: p.width > 1 ? `${p.name}${i}` : p.name, side: p.dir === 'out' ? 'R' : 'L' }));
  const count = new Map<number, number>();
  const bump = (n: number) => count.set(n, (count.get(n) ?? 0) + 1);
  cells.forEach((c) => { bump(c[0]); if (c[1] !== c[0]) bump(c[1]); bump(c[2]); });
  io.forEach((p) => bump(p.net));
  return { cells, io, nets: [...count].filter(([, k]) => k >= 2).map(([n]) => n) };
}

/** Routing tracks per placement site, each way. */
export const SITE = 6;
type P = [number, number];

export class Layout {
  readonly cols: number;
  readonly rows: number;
  readonly W: number;
  readonly H: number;
  /** Site of each cell. */
  site: number[];
  private terms = new Map<number, { cell?: number; pin?: number; io?: number }[]>();
  private seed = 7;

  constructor(readonly prob: Problem) {
    const n = prob.cells.length;
    this.cols = Math.ceil(Math.sqrt(n * 1.25));
    this.rows = Math.ceil((n * 1.25) / this.cols);
    this.W = this.cols * SITE + 6;
    this.H = Math.max(this.rows * SITE, Math.ceil(prob.io.length / 2) * 3) + 2;
    this.site = prob.cells.map((_, i) => i);
    prob.cells.forEach((c, i) => c.forEach((net, k) => this.addTerm(net, { cell: i, pin: k })));
    prob.io.forEach((p, i) => this.addTerm(p.net, { io: i }));
  }

  private addTerm(net: number, t: { cell?: number; pin?: number; io?: number }) {
    if (!this.terms.has(net)) this.terms.set(net, []);
    const list = this.terms.get(net)!;
    // the same cell may connect a net to both inputs (an inverter): one terminal is enough
    if (t.cell !== undefined && t.pin === 1 && list.some((u) => u.cell === t.cell && u.pin === 0)) return;
    list.push(t);
  }

  rand(): number {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    return this.seed / 2 ** 32;
  }

  /** Grid origin of a site. */
  siteXY(s: number): P { return [3 + (s % this.cols) * SITE, 1 + Math.floor(s / this.cols) * SITE]; }

  pinXY(t: { cell?: number; pin?: number; io?: number }): P {
    if (t.io !== undefined) {
      const p = this.prob.io[t.io];
      const same = this.prob.io.filter((q) => q.side === p.side);
      const k = same.indexOf(p), gap = Math.max(1, Math.floor((this.H - 2) / (same.length + 1)));
      return [p.side === 'L' ? 0 : this.W - 1, Math.min(this.H - 2, 1 + gap * (k + 1))];
    }
    const [x, y] = this.siteXY(this.site[t.cell!]);
    return t.pin === 0 ? [x + 1, y + 1] : t.pin === 1 ? [x + 1, y + 3] : [x + 3, y + 2];
  }

  terminals(net: number): P[] { return (this.terms.get(net) ?? []).map((t) => this.pinXY(t)); }

  hpwl(net: number): number {
    const ps = this.terminals(net);
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  }

  totalHpwl(): number { return this.prob.nets.reduce((a, n) => a + this.hpwl(n), 0); }

  randomize(): void {
    const sites = [...Array(this.cols * this.rows).keys()];
    for (let i = sites.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [sites[i], sites[j]] = [sites[j], sites[i]]; }
    this.site = this.prob.cells.map((_, i) => sites[i]);
  }

  /** Simulated annealing: swap two sites (one may be empty), accept worse moves with probability e^(−Δ/T). */
  anneal(moves: number, T: number): number {
    const nSites = this.cols * this.rows;
    const owner = new Array<number>(nSites).fill(-1);
    this.site.forEach((s, c) => (owner[s] = c));
    const netsOf = (c: number) => (c < 0 ? [] : this.prob.cells[c].filter((n) => this.prob.nets.includes(n)));
    for (let m = 0; m < moves; m++) {
      const s1 = Math.floor(this.rand() * nSites), s2 = Math.floor(this.rand() * nSites);
      const c1 = owner[s1], c2 = owner[s2];
      if (s1 === s2 || (c1 < 0 && c2 < 0)) continue;
      const affected = [...new Set([...netsOf(c1), ...netsOf(c2)])];
      const before = affected.reduce((a, n) => a + this.hpwl(n), 0);
      if (c1 >= 0) this.site[c1] = s2;
      if (c2 >= 0) this.site[c2] = s1;
      const delta = affected.reduce((a, n) => a + this.hpwl(n), 0) - before;
      if (delta <= 0 || this.rand() < Math.exp(-delta / T)) { owner[s1] = c2; owner[s2] = c1; }
      else { if (c1 >= 0) this.site[c1] = s1; if (c2 >= 0) this.site[c2] = s2; }
    }
    return this.totalHpwl();
  }
}

export interface RouteResult {
  /** Per routed net: grid points with their layer, as connected paths. */
  paths: Map<number, [number, number, number][][]>;
  failed: number[];
  wirelength: number;
  vias: number;
}

/** Route every net on the two-layer grid. Nets are routed shortest first; failures are retried first. */
export function route(lay: Layout, order?: number[]): RouteResult {
  const { W, H } = lay;
  const N = W * H * 2;
  const occ = new Int32Array(N);
  const id = (x: number, y: number, l: number) => (l * H + y) * W + x;
  const nets = order ?? [...lay.prob.nets].sort((a, b) => lay.hpwl(a) - lay.hpwl(b));
  // reserve every pin (both layers) for its own net
  for (const n of lay.prob.nets) for (const [x, y] of lay.terminals(n)) { occ[id(x, y, 0)] = n + 1; occ[id(x, y, 1)] = n + 1; }
  const res: RouteResult = { paths: new Map(), failed: [], wirelength: 0, vias: 0 };
  const dist = new Float64Array(N), prev = new Int32Array(N);
  for (const net of nets) {
    const ts = lay.terminals(net);
    const tree = new Set<number>([id(ts[0][0], ts[0][1], 0)]);
    const want = new Set(ts.slice(1).map(([x, y]) => id(x, y, 0)));
    for (const t of [...want]) if (tree.has(t)) want.delete(t);
    const paths: [number, number, number][][] = [];
    let ok = true;
    while (want.size) {
      dist.fill(Infinity);
      prev.fill(-1);
      // a small bucket queue: costs are 1 (wire) and 3 (via)
      const buckets: number[][] = [[]];
      for (const t of tree) { dist[t] = 0; buckets[0].push(t); }
      let found = -1;
      for (let d = 0; d < buckets.length && found < 0; d++) {
        const b = buckets[d];
        if (!b) continue;
        for (let k = 0; k < b.length; k++) {
          const u = b[k];
          if (dist[u] !== d) continue;
          if (want.has(u)) { found = u; break; }
          const l = u >= W * H ? 1 : 0, r = u - l * W * H, x = r % W, y = Math.floor(r / W);
          const relax = (v: number, c: number) => {
            if (occ[v] !== 0 && occ[v] !== net + 1) return;
            const nd = d + c;
            if (nd < dist[v]) { dist[v] = nd; prev[v] = u; (buckets[nd] ??= []).push(v); }
          };
          if (l === 0) { if (x > 0) relax(u - 1, 1); if (x < W - 1) relax(u + 1, 1); relax(id(x, y, 1), 3); }
          else { if (y > 0) relax(u - W, 1); if (y < H - 1) relax(u + W, 1); relax(id(x, y, 0), 3); }
        }
      }
      if (found < 0) { ok = false; break; }
      const path: [number, number, number][] = [];
      for (let v = found; v >= 0; v = tree.has(v) ? -1 : prev[v]) {
        const l = v >= W * H ? 1 : 0, r = v - l * W * H;
        path.push([r % W, Math.floor(r / W), l]);
        if (tree.has(v)) break;
      }
      for (let i = 1; i < path.length; i++) { if (path[i][2] !== path[i - 1][2]) res.vias++; else res.wirelength++; }
      for (const [x, y, l] of path) { const v = id(x, y, l); occ[v] = net + 1; tree.add(v); }
      paths.push(path);
      want.delete(found);
    }
    if (ok) res.paths.set(net, paths);
    else res.failed.push(net);
  }
  return res;
}

/** Route, then retry with the failed nets first (a crude rip-up and reroute). */
export function routeAll(lay: Layout, attempts = 4): RouteResult {
  let r = route(lay);
  for (let a = 1; a < attempts && r.failed.length; a++) {
    const rest = lay.prob.nets.filter((n) => !r.failed.includes(n)).sort((x, y) => lay.hpwl(x) - lay.hpwl(y));
    const next = route(lay, [...r.failed, ...rest]);
    if (next.failed.length < r.failed.length) r = next;
    else break;
  }
  return r;
}
