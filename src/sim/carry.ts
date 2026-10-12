// Carrying state across a rebuild. An editor recompiles the circuit into a new ComponentDef on
// every structural edit and flattens it again; flat net ids mean nothing across two flattenings,
// but the hierarchy does: a net is identified by where it shows up (instance path + port name,
// or instance path + internal net). matchNets() maps every flat net of a new design to the flat
// net of an old design that played the same role, so a simulator can copy its values over.

import type { FlatDesign, HierNode } from './flatten';
import { netlistOf } from './types';

/**
 * For each flat net of `next`, the flat net of `prev` it corresponds to (-1: none).
 *
 * Both hierarchies are walked together, children matched by instance name. At each matched pair
 * of nodes, ports are matched by name (same width and direction) and, when both nodes were
 * expanded, internal nets by index (same definition) or else by unique name (same width). One new
 * net is usually reached from several places (a wire is a port of its driver, of each sink and
 * of every box it crosses); where the candidates disagree, which only happens where the wiring
 * changed, the most specific one wins: a leaf's output port (its driver, the place where the
 * value is produced) first, then the deepest match.
 */
export function matchNets(next: FlatDesign, prev: FlatDesign): Int32Array {
  const map = new Int32Array(next.netCount).fill(-1);
  const prio = new Int32Array(next.netCount).fill(-1);
  const put = (nets: readonly number[], olds: readonly number[], p: number): void => {
    for (let i = 0; i < nets.length; i++) {
      if (p > prio[nets[i]]) {
        prio[nets[i]] = p;
        map[nets[i]] = olds[i];
      }
    }
  };
  const DRIVER = 1 << 30;

  const visit = (n: HierNode, o: HierNode): void => {
    const depth = n.path.length;
    for (const p of n.def.ports) {
      const q = o.def.ports.find((x) => x.name === p.name);
      if (!q || q.width !== p.width || q.dir !== p.dir) continue;
      put(n.ports[p.name], o.ports[q.name], n.leafIndex !== undefined && p.dir === 'out' ? DRIVER : 2 * depth);
    }
    if (n.nets && o.nets) {
      if (n.def === o.def || (n.def.id === o.def.id && n.nets.length === o.nets.length)) {
        n.nets.forEach((bits, i) => { if (o.nets![i].length === bits.length) put(bits, o.nets![i], 2 * depth + 1); });
      } else {
        const named = (nodeDef: HierNode['def'], nets: number[][]) => {
          const m = new Map<string, number[] | null>();
          netlistOf(nodeDef)!.nets.forEach((nd, i) => {
            if (nd.name) m.set(nd.name, m.has(nd.name) ? null : nets[i]); // null: ambiguous
          });
          return m;
        };
        const om = named(o.def, o.nets);
        for (const [name, bits] of named(n.def, n.nets)) {
          const ob = om.get(name);
          if (bits && ob && ob.length === bits.length) put(bits, ob, 2 * depth + 1);
        }
      }
    }
    if (n.children && o.children) {
      for (const [name, c] of n.children) {
        const oc = o.children.get(name);
        if (oc) visit(c, oc);
      }
    }
  };
  visit(next.root, prev.root);
  return map;
}

/** Root input ports present in both designs with the same width: their names. */
export function sharedInputs(next: FlatDesign, prev: FlatDesign): string[] {
  return next.root.def.ports
    .filter((p) => p.dir === 'in' && prev.root.def.ports.some((q) => q.name === p.name && q.dir === 'in' && q.width === p.width))
    .map((p) => p.name);
}
