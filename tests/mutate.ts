// Netlist surgery for mutant tests: a copy of a definition's top level with one wire tied to a constant, or one part swapped.

import { define } from '../src/lib/define';
import { TIE0, TIE1 } from '../src/lib/transistors';
import type { ComponentDef, InstanceDef, NetDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';

let n = 0;
function copy(def: ComponentDef, edit: (instances: InstanceDef[], nets: NetDef[]) => void, tag: string): ComponentDef {
  const nl = netlistOf(def)!;
  const instances = nl.instances.map((i) => ({ ...i }));
  const nets = nl.nets.map((x) => ({ ...x, ends: [...x.ends] }));
  edit(instances, nets);
  return define({ ...def, id: `mut_${def.id}_${tag}_${n++}`, netlist: () => ({ ...nl, instances, nets }) } as ComponentDef);
}

/** The net ends (`inst.port` or a pin) of the nets that hold `end`. */
export const netsOf = (def: ComponentDef, end: string): string[][] => netlistOf(def)!.nets.filter((x) => x.ends.includes(end)).map((x) => x.ends);

/** `end` (an instance port or a pin) is cut from its wire and held at `value`; the rest of the wire stays as it was. */
export function tie(def: ComponentDef, end: string, value: 0 | 1): ComponentDef {
  return copy(def, (instances, nets) => {
    const at = nets.findIndex((x) => x.ends.includes(end));
    if (at < 0) throw new Error(`no net holds ${end}`);
    nets[at] = { ...nets[at], ends: nets[at].ends.filter((e) => e !== end) };
    const name = `mut_tie${n}`;
    instances.push({ name, def: value ? TIE1 : TIE0, at: [0, 0] });
    nets.push({ name, ends: [`${name}.y`, end] });
  }, `tie${end}`);
}

/** Every end of the wire that drives `from` (a pin or an instance port) except `from` itself moves to a constant: the wire's sinks see `value`. */
export function hold(def: ComponentDef, from: string, value: 0 | 1): ComponentDef {
  return copy(def, (instances, nets) => {
    const at = nets.findIndex((x) => x.ends.includes(from));
    if (at < 0) throw new Error(`no net holds ${from}`);
    const sinks = nets[at].ends.filter((e) => e !== from && e.includes('.'));
    nets[at] = { ...nets[at], ends: nets[at].ends.filter((e) => !sinks.includes(e)) };
    const name = `mut_hold${n}`;
    instances.push({ name, def: value ? TIE1 : TIE0, at: [0, 0] });
    nets.push({ name, ends: [`${name}.y`, ...sinks] });
  }, `hold${from}`);
}

/** An instance replaced by another definition with the same port names. */
export function swap(def: ComponentDef, inst: string, by: ComponentDef): ComponentDef {
  return copy(def, (instances) => {
    const i = instances.findIndex((x) => x.name === inst);
    if (i < 0) throw new Error(`no instance ${inst}`);
    instances[i] = { ...instances[i], def: by };
  }, `swap${inst}`);
}

/** The driver `end` of a wire is replaced by a constant: everything the wire reached sees `value`. */
export function force(def: ComponentDef, end: string, value: 0 | 1): ComponentDef {
  return copy(def, (instances, nets) => {
    const at = nets.findIndex((x) => x.ends.includes(end));
    if (at < 0) throw new Error(`no net holds ${end}`);
    const name = `mut_force${n}`;
    nets[at] = { ...nets[at], ends: nets[at].ends.map((e) => (e === end ? `${name}.y` : e)) };
    instances.push({ name, def: value ? TIE1 : TIE0, at: [0, 0] });
  }, `force${end}`);
}
