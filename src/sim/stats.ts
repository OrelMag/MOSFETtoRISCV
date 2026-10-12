// Cost of a component, measured from its structure: NAND count, transistor count, and the
// logic depth (longest input → output path in NAND delays) for combinational parts.

import { flatten } from './flatten';
import { needsSwitchLevel } from './harness';
import { type ComponentDef, netlistOf } from './types';

export interface Stats {
  nands: number;
  transistors: number;
  /** Resistors (pull-ups, pull-downs) and capacitors: switch-level parts, not transistors. */
  resistors: number;
  capacitors: number;
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
  const zero = { nands: 0, transistors: 0, resistors: 0, capacitors: 0, parts: 0, descendants: 0, levels: 0 };
  if (def.prim === 'nand') s = { ...zero, nands: 1, transistors: 4, parts: 4, descendants: 4, levels: 1 };
  else if (def.prim === 'nmos' || def.prim === 'pmos') s = { ...zero, transistors: 1 };
  else if (def.prim === 'res') s = { ...zero, resistors: 1 };
  else if (def.prim === 'cap') s = { ...zero, capacitors: 1 };
  else if (def.prim) s = zero;
  else {
    const nl = netlistOf(def);
    s = { ...zero };
    if (nl) {
      for (const inst of nl.instances) {
        const c = stats(inst.def);
        s.nands += c.nands;
        s.transistors += c.transistors;
        s.resistors += c.resistors;
        s.capacitors += c.capacitors;
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
    // an edge-triggered behaviour (a large RAM) is storage, like a loop of gates
    let cyclic = d.leaves.some((l) => !!l.def.behavior?.seq);
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

const fbCache = new WeakMap<ComponentDef, boolean>();

/**
 * Does the component remember (outputs depend on history)? At gate level: a cycle. At switch
 * level logicDepth does not apply (gate-mode flattening rejects MOSFETs), so: a capacitive net,
 * or a cycle between channel-connected groups (nets joined by transistor channels, cut at rails
 * and inputs), where a group feeds a gate in the next one. Cross-coupled inverters form such a cycle.
 */
export function hasFeedback(def: ComponentDef): boolean {
  if (!needsSwitchLevel(def)) return logicDepth(def) === null;
  if (def.prim) return false;
  const hit = fbCache.get(def);
  if (hit !== undefined) return hit;
  const d = flatten(def, { mode: 'switch' });
  let result = d.caps.size > 0 || d.leaves.some((l) => !!l.def.behavior?.seq);
  if (!result) {
    const source = new Uint8Array(d.netCount);
    for (const l of d.leaves) if (l.kind === 'vdd' || l.kind === 'gnd') source[l.terminals![0]] = 1;
    for (const p of def.ports) if (p.dir === 'in') for (const n of d.root.ports[p.name]) source[n] = 1;
    const parent = Int32Array.from({ length: d.netCount }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const fets = d.leaves.filter((l) => l.kind === 'nmos' || l.kind === 'pmos').map((l) => l.terminals!);
    for (const [, a, b] of fets) if (!source[a] && !source[b]) parent[find(a)] = find(b);
    // a resistor joins its ends into one channel-connected group too (it has no gate to feed)
    for (const l of d.leaves) {
      const [a, b] = l.terminals ?? [];
      if (l.kind === 'res' && !source[a] && !source[b]) parent[find(a)] = find(b);
    }
    const edges = new Map<number, Set<number>>();
    const edge = (from: number, to: number) => {
      if (source[from] || source[to]) return;
      const f = find(from);
      if (!edges.has(f)) edges.set(f, new Set());
      edges.get(f)!.add(find(to));
    };
    for (const [g, a, b] of fets) edge(g, source[a] ? b : a);
    // behavioural leaves inside a switch-level design: every input may affect every output
    for (const l of d.leaves) if (!l.terminals) for (const i of l.inputs.flat()) for (const o of l.outputs.flat()) edge(i, o);
    const state = new Uint8Array(d.netCount); // 0 new, 1 visiting, 2 done
    const cyclic = (g: number): boolean => {
      if (state[g]) return state[g] === 1;
      state[g] = 1;
      for (const h of edges.get(g) ?? []) if (cyclic(h)) return true;
      state[g] = 2;
      return false;
    };
    result = [...edges.keys()].some(cyclic);
  }
  fbCache.set(def, result);
  return result;
}
