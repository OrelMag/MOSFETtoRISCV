// Slack per part (Phase 20's slack heatmap, DOM-free). For every leaf, and every boundary flip-flop, the longest
// register-to-register path through it: arrival at its output + the longest remaining path from there to a capture
// point (setup included). A part's slack is the critical path's length minus that: 0 on the critical path, from its
// launching flip-flop to its capturing one, and the time a path through it could still grow before it set the clock.
// Arrival times are timing.ts's (the same graph), so unit and load delay both work. A design without flip-flops is
// timed input to output instead (the root's outputs as capture points, no setup).

import type { DelayModel } from './delay';
import type { FlatDesign } from './flatten';
import { SETUP, timingGraph } from './timing';

export interface SlackMap {
  model: DelayModel;
  /** The critical path's length (the clock period; input → output for a combinational design). */
  period: number;
  /** Clocked (register to register) or combinational (inputs to outputs). */
  clocked: boolean;
  /** Every timed leaf and flip-flop (hierarchical path) with the longest path through it. */
  items: { path: string[]; through: number }[];
}

const cache = { unit: new WeakMap<FlatDesign, SlackMap | null>(), load: new WeakMap<FlatDesign, SlackMap | null>(), drawn: new WeakMap<FlatDesign, SlackMap | null>() };

/** The longest path through every part of a design, once per design and delay model; null when nothing is timed. */
export function slackOf(design: FlatDesign, model: DelayModel = 'unit'): SlackMap | null {
  let r = cache[model].get(design);
  if (r === undefined) cache[model].set(design, (r = compute(design, model)));
  return r;
}

function compute(design: FlatDesign, model: DelayModel): SlackMap | null {
  let g = timingGraph(design, { delay: model });
  const clocked = g.captures.length > 0;
  if (!clocked) g = timingGraph(design, { delay: model, outputs: true });
  const { leaves, excluded, captures, tin, delays, arr, qSource } = g;
  if (!captures.length) return null;
  const nets = design.netCount;

  // The latest a capture point needs a net, counted back from it: remaining[net] = the longest path from the net
  // to a capture (its setup included). -Infinity: no capture is reached.
  const capBase = new Float64Array(nets).fill(-Infinity);
  for (const c of captures) capBase[c.net] = Math.max(capBase[c.net], c.pin ? 0 : SETUP);
  // Readers of each net (compressed rows), over the leaves a path goes through.
  const count = new Int32Array(nets + 1);
  leaves.forEach((_, d) => { if (!excluded[d]) for (const p of tin[d]) for (const n of p) count[n + 1]++; });
  for (let i = 0; i < nets; i++) count[i + 1] += count[i];
  const readers = new Int32Array(count[nets]), fill = count.slice(0, nets);
  leaves.forEach((_, d) => { if (!excluded[d]) for (const p of tin[d]) for (const n of p) readers[fill[n]++] = d; });

  const rem = new Float64Array(nets).fill(NaN);
  const state = new Uint8Array(nets);
  // Iterative DFS forward (as timing.ts's arrival backward); a net on the stack (a combinational loop) adds nothing.
  const remOf = (start: number): number => {
    if (!Number.isNaN(rem[start])) return rem[start];
    const stack = [start];
    while (stack.length) {
      const net = stack[stack.length - 1];
      if (!Number.isNaN(rem[net])) { stack.pop(); continue; }
      if (state[net] === 0) {
        state[net] = 1;
        for (let k = count[net]; k < count[net + 1]; k++) {
          for (const p of leaves[readers[k]].outputs) for (const o of p) if (Number.isNaN(rem[o]) && state[o] === 0) stack.push(o);
        }
        continue;
      }
      let best = capBase[net];
      for (let k = count[net]; k < count[net + 1]; k++) {
        const d = readers[k];
        for (const p of leaves[d].outputs) for (const o of p) {
          const r = Number.isNaN(rem[o]) ? -Infinity : rem[o];
          if (r + delays[d] > best) best = r + delays[d];
        }
      }
      rem[net] = best;
      stack.pop();
    }
    return rem[start];
  };

  let period = 0;
  for (const c of captures) period = Math.max(period, arr(c.net) + (c.pin ? 0 : SETUP));
  const items: SlackMap['items'] = [];
  // Leaves: the latest of their outputs' arrival + remaining.
  leaves.forEach((l, d) => {
    if (excluded[d]) return;
    let t = -Infinity;
    for (const p of l.outputs) for (const o of p) {
      const r = remOf(o);
      if (r > -Infinity) t = Math.max(t, arr(o) + r);
    }
    if (t > -Infinity) items.push({ path: l.node.path, through: t });
  });
  // Flip-flops: paths they capture (arrival at d / en + setup) and launch (clk-to-q + remaining from q).
  const ff = new Map<string, { path: string[]; through: number }>();
  const put = (path: string[], t: number) => {
    const k = path.join('.'), e = ff.get(k);
    if (!e) ff.set(k, { path, through: t });
    else if (t > e.through) e.through = t;
  };
  for (const c of captures) if (!c.pin) put(c.dff, arr(c.net) + SETUP);
  for (const [q, path] of qSource) {
    const r = remOf(q);
    if (r > -Infinity) put(path, arr(q) + r);
  }
  items.push(...ff.values());
  return { model, period, clocked, items };
}

/**
 * Slack of each instance drawn at a level (`at`: its path from the root): the critical path's length minus the
 * longest path through any part inside the instance. Instances no timed path crosses are absent.
 */
export function slackAt(s: SlackMap, at: readonly string[]): Map<string, number> {
  const k = at.length, worst = new Map<string, number>();
  for (const it of s.items) {
    const p = it.path;
    if (p.length <= k || at.some((x, i) => p[i] !== x)) continue;
    const name = p[k];
    if (it.through > (worst.get(name) ?? -Infinity)) worst.set(name, it.through);
  }
  const out = new Map<string, number>();
  // (a tiny negative from float sums under the load model reads as 0)
  for (const [name, t] of worst) out.set(name, Math.max(0, s.period - t));
  return out;
}

/** Heat bands, hottest first: on the critical path, then within 10 %, 25 %, 50 % of it, then more. */
export const SLACK_BANDS = [0, 0.1, 0.25, 0.5] as const;
export const SLACK_BAND_LABELS = ['critical', '< 10 %', '< 25 %', '< 50 %', 'more'] as const;

/** The band (0 = critical … 4 = plenty of slack) of a slack, as a fraction of the period. */
export function slackBand(slack: number, period: number): number {
  const f = period > 0 ? slack / period : 1;
  if (f <= 1e-9) return 0;
  for (let b = 1; b < SLACK_BANDS.length; b++) if (f < SLACK_BANDS[b]) return b;
  return SLACK_BANDS.length;
}
