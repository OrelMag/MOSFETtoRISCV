// Dead parts: instances of a netlist whose outputs reach none of the component's outputs. Such a
// part costs transistors and can never matter (a stray copy, a wire that was never drawn, a
// result nobody reads); on a crowded schematic it also looks connected when it is not.

import { type ComponentDef, type Netlist, parseEnd } from './types';

const drives = (d: ComponentDef['ports'][number]['dir']) => d !== 'in';

/**
 * Names of the instances from which no path leads to an output (or inout) port of the component,
 * in netlist order. Walks backwards from those ports: a part is live when one of its outputs is on
 * a live net, and then every net on its inputs is live. A part with no outputs at all (a display,
 * a buzzer, a halt) is a sink of its own and always live. Wiring boxes (splitters, mergers) count
 * like any part, so a bus split into bits that are all unused is dead as well.
 */
export function deadInstances(nl: Netlist, ports: ComponentDef['ports']): string[] {
  const inst = new Map(nl.instances.map((i) => [i.name, i]));
  const portDir = new Map(ports.map((p) => [p.name, p.dir]));
  // Per net: its ends; per instance: its nets on driving ports and on reading ports.
  const outNets = new Map<string, number[]>();
  const inNets = new Map<string, number[]>();
  const live = new Set<string>();
  const liveNet = new Set<number>();
  const netParts = nl.nets.map(() => [] as string[]); // instances driving each net
  nl.nets.forEach((n, ni) => {
    for (const e of n.ends) {
      const { inst: name, port } = parseEnd(e);
      if (name === null) {
        const d = portDir.get(port);
        if (d && drives(d)) liveNet.add(ni);
        continue;
      }
      const i = inst.get(name);
      const p = i?.def.ports.find((q) => q.name === port);
      if (!p) continue;
      if (drives(p.dir)) {
        (outNets.get(name) ?? outNets.set(name, []).get(name)!).push(ni);
        netParts[ni].push(name);
      }
      if (p.dir !== 'out') (inNets.get(name) ?? inNets.set(name, []).get(name)!).push(ni);
    }
  });

  const work: number[] = [...liveNet];
  const wake = (name: string) => {
    if (live.has(name)) return;
    live.add(name);
    for (const ni of inNets.get(name) ?? []) if (!liveNet.has(ni)) { liveNet.add(ni); work.push(ni); }
  };
  for (const i of nl.instances) if (!i.def.ports.some((p) => drives(p.dir))) wake(i.name);
  while (work.length) for (const name of netParts[work.pop()!]) wake(name);
  return nl.instances.filter((i) => !live.has(i.name)).map((i) => i.name);
}

const kept = new WeakMap<ComponentDef, Map<string, ComponentDef>>();

/**
 * The component with only the named ports, and without the parts that served only the others: a level's reference
 * answer drawn from a library part with more outputs than the level checks (a Kogge–Stone adder's overflow, an FP
 * unit's flags), so that its cost, and so par, is that of what the level asks for. Memoized per def and port set.
 */
export function keepPorts(def: ComponentDef, names: readonly string[]): ComponentDef {
  const key = [...names].sort().join(',');
  const per = kept.get(def) ?? kept.set(def, new Map()).get(def)!;
  let d = per.get(key);
  if (d) return d;
  const want = new Set(names);
  const ports = def.ports.filter((p) => want.has(p.name));
  d = {
    ...def, id: `${def.id}__${key.replace(/,/g, '_')}`, ports,
    spec: undefined, behavior: undefined, hdl: undefined,
    netlist: () => {
      const nl = def.netlist!();
      const dead = new Set(deadInstances(nl, ports));
      const keepEnd = (e: string) => { const { inst, port } = parseEnd(e); return inst === null ? want.has(port) : !dead.has(inst); };
      const nets = nl.nets.map((n) => ({ ...n, ends: n.ends.filter(keepEnd), tags: Array.isArray(n.tags) ? n.tags.filter(keepEnd) : n.tags }))
        .filter((n) => n.ends.length > 1);
      const pins = nl.pins && Object.fromEntries(Object.entries(nl.pins).filter(([k]) => want.has(k)));
      return { ...nl, pins, instances: nl.instances.filter((i) => !dead.has(i.name)), nets };
    },
  };
  per.set(key, d);
  return d;
}
