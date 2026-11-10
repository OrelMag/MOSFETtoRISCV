// Names for a Builder level's unnamed nets, from what drives them. A net without a name is drawn, when it is a pointer, as
// "n<index>" (view/route.ts), which tells a reader nothing. Opt-in per level (the virtual-memory units, lib/vm.ts): a net
// driven by a named instance takes its name ('mie.q' → mie), a splitter labelled with its fields that field ('V R W X U . A
// D . PPN' → R), another splitter's output the bit range of what it splits ('satp[21:0]'), a decoder's output the value it
// decodes ('high nibble = 3'), an inverter's ¬ of its input, else the driver's label. Anything else keeps no name, and a
// name already taken is not reused. Only names change: instances, nets and their order are the Builder's own.
import { parseEnd, type InstanceDef, type Netlist } from '../sim/types';
import type { Builder } from './builder';

const auto = /^u\d+$/;
const single = new Set(['q', 'y', 'out', 'eq', 's']);

export function autoNames(nl: Netlist): Netlist {
  const inst = new Map(nl.instances.map((i) => [i.name, i]));
  const byDriver = new Map(nl.nets.map((n) => [n.ends[0], n]));
  const intoPort = (i: InstanceDef, port: string) => nl.nets.find((n) => n.ends.slice(1).includes(`${i.name}.${port}`));
  const seen = new Set<string>();
  const nameOf = (end: string): string | undefined => {
    const net = byDriver.get(end);
    if (net?.name) return net.name;
    if (seen.has(end)) return undefined;
    seen.add(end);
    const { inst: iname, port } = parseEnd(end);
    if (iname === null) return port;
    const i = inst.get(iname);
    if (!i) return undefined;
    const outs = i.def.ports.filter((p) => p.dir === 'out');
    const src = (p: string) => { const n = intoPort(i, p); return n && (n.name ?? nameOf(n.ends[0])); };
    const alias = i.def.prim === 'alias';
    if (alias && i.label) {
      const words = i.label.split(/,\s*|\s+/), k = outs.findIndex((p) => p.name === port);
      if (words.length === outs.length && k >= 0 && /[A-Za-z]/.test(words[k])) return words[k];
    }
    if (alias && i.def.ports.filter((p) => p.dir === 'in').length === 1 && outs.length > 1) {
      const k = outs.findIndex((p) => p.name === port), lo = outs.slice(0, k).reduce((t, p) => t + p.width, 0), w = outs[k]?.width ?? 1;
      const s = src(i.def.ports.find((p) => p.dir === 'in')!.name);
      return s && (w === 1 ? `${s}[${lo}]` : `${s}[${lo + w - 1}:${lo}]`);
    }
    if (/^dec/.test(i.def.id) && /^y\d+$/.test(port)) { const s = i.label?.split(' ')[0] ?? src('a'); return s && `${s}=${port.slice(1)}`; }
    if (i.def.id === 'not' && port === 'y') { const s = src('a'); return s && `¬${s}`; }
    const who = !auto.test(iname) ? iname : alias ? undefined : i.label;
    if (who && !who.includes('\n')) return single.has(port) ? who : `${who}.${port}`;
    return undefined;
  };
  // a name already taken (by the author or an earlier net here) is not reused: two pointer groups with one label would read as one net
  const used = new Set(nl.nets.flatMap((n) => (n.name ? [n.name] : [])));
  return { ...nl, nets: nl.nets.map((n) => {
    const m = n.name ? undefined : nameOf(n.ends[0]);
    if (!m || used.has(m)) return n;
    used.add(m);
    return { ...n, name: m };
  }) };
}

/** Names a Builder's unnamed nets by autoNames before it is laid out, so the layout makes room for the labels. Returns b. */
export function nameNets<B extends Builder>(b: B): B {
  const before = b.nets(), after = autoNames({ pins: {}, instances: b.instances, nets: before }).nets;
  after.forEach((n, i) => { if (n.name && !before[i].name) b.name(n.ends[0], n.name); });
  return b;
}
