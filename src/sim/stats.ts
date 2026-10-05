// Cost of a component, measured from its structure: NAND count, transistor count, and the
// logic depth (longest input → output path in NAND delays) for combinational parts.

import { flatten } from './flatten';
import { type ComponentDef, netlistOf } from './types';

export interface Stats {
  nands: number;
  transistors: number;
  /** Number of instances one level down. */
  parts: number;
  /** Total number of components in the hierarchy below (all levels). */
  descendants: number;
  /** Hierarchy levels below this component (0 for primitives). */
  levels: number;
}

const cache = new WeakMap<ComponentDef, Stats>();

export function stats(def: ComponentDef): Stats {
  const hit = cache.get(def);
  if (hit) return hit;
  let s: Stats;
  if (def.prim === 'nand') s = { nands: 1, transistors: 4, parts: 4, descendants: 4, levels: 1 };
  else if (def.prim === 'nmos' || def.prim === 'pmos') s = { nands: 0, transistors: 1, parts: 0, descendants: 0, levels: 0 };
  else if (def.prim) s = { nands: 0, transistors: 0, parts: 0, descendants: 0, levels: 0 };
  else {
    const nl = netlistOf(def);
    s = { nands: 0, transistors: 0, parts: 0, descendants: 0, levels: 0 };
    if (nl) {
      for (const inst of nl.instances) {
        const c = stats(inst.def);
        s.nands += c.nands;
        s.transistors += c.transistors;
        if (inst.def.prim !== 'alias') {
          s.parts++;
          s.descendants += 1 + c.descendants;
          s.levels = Math.max(s.levels, 1 + c.levels);
        }
      }
    }
  }
  cache.set(def, s);
  return s;
}

const depthCache = new WeakMap<ComponentDef, number | null>();

/**
 * Longest path from any input to any output, in NAND delays. Returns null when the
 * component contains feedback (it is sequential, so "depth" is not meaningful).
 */
export function logicDepth(def: ComponentDef): number | null {
  if (depthCache.has(def)) return depthCache.get(def)!;
  let result: number | null = null;
  try {
    const d = flatten(def, { mode: 'gate' });
    const driverOf = new Int32Array(d.netCount).fill(-1);
    d.leaves.forEach((l, i) => l.outputs.forEach((p) => p.forEach((n) => (driverOf[n] = i))));
    const memo = new Int32Array(d.leaves.length).fill(-1);
    const state = new Uint8Array(d.leaves.length); // 0 new, 1 visiting, 2 done
    let cyclic = false;
    const leafDepth = (li: number): number => {
      if (state[li] === 2) return memo[li];
      if (state[li] === 1) {
        cyclic = true;
        return 0;
      }
      state[li] = 1;
      let m = 0;
      for (const p of d.leaves[li].inputs) for (const n of p) if (driverOf[n] >= 0) m = Math.max(m, leafDepth(driverOf[n]));
      const own = d.leaves[li].kind === 'nand' ? 1 : (d.leaves[li].def.behavior?.delay ?? 0);
      memo[li] = m + own;
      state[li] = 2;
      return memo[li];
    };
    let max = 0;
    for (const p of def.ports) {
      if (p.dir !== 'out') continue;
      for (const n of d.root.ports[p.name]) if (driverOf[n] >= 0) max = Math.max(max, leafDepth(driverOf[n]));
    }
    result = cyclic ? null : max;
  } catch {
    result = null;
  }
  depthCache.set(def, result);
  return result;
}
