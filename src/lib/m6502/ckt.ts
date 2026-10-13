// A netlist builder for the 6502's blocks (Appendix A). Instances are wired by net name; bits of a
// multi-bit pin are `name[i]` (the builder adds the splitter); a block is laid out on a grid and
// its nets are drawn as named labels, the way a large schematic names its control lines instead of
// drawing them. Small cells are drawn by hand elsewhere; this is for the blocks above them.

import { symbolGeom } from '../../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef, SymbolSpec } from '../../sim/types';
import { define, splitter } from '../define';
import { GND, VDD } from '../transistors';

/** Width of a label as the router draws it (route.ts tagGeom), plus its stub. */
const tagLen = (name: string) => 1.4 + name.length * 0.48 + 0.9;

export interface BlockSpec {
  id: string;
  name: string;
  summary: string;
  ports: PortDef[];
  symbol?: SymbolSpec;
  notes?: string;
  /** Instances per column (default: a square-ish grid). */
  rows?: number;
}

export class Ckt {
  protected insts: { name: string; def: ComponentDef; conns: Record<string, string | string[]>; label?: string }[] = [];
  protected caps = new Map<string, number | true>();

  /** Add an instance; each port gets a net name (a w-bit port: w names, or one name of a w-bit net). */
  add(name: string, def: ComponentDef, conns: Record<string, string | string[]>, label?: string): string {
    for (const p of def.ports) if (!(p.name in conns)) throw new Error(`${name} (${def.id}): port ${p.name} not connected`);
    this.insts.push({ name, def, conns, label });
    return name;
  }
  /** Mark nets as capacitive (stored charge); a number is the relative capacitance (a bus: 20). */
  cap(nets: string[], w: number | true = true): void {
    for (const n of nets) this.caps.set(n, w);
  }

  build(spec: BlockSpec): ComponentDef {
    const insts = this.insts.slice();
    const caps = new Map(this.caps);
    return define({
      id: spec.id, name: spec.name, category: 'cell', summary: spec.summary, ports: spec.ports,
      symbol: spec.symbol ?? { kind: 'box', label: spec.name },
      notes: spec.notes,
      netlist: () => layout(spec, insts, caps),
    });
  }
}

function layout(spec: BlockSpec, insts: { name: string; def: ComponentDef; conns: Record<string, string | string[]>; label?: string }[],
  caps: Map<string, number | true>) {
  const ends = new Map<string, string[]>();
  const end = (net: string, e: string) => {
    let l = ends.get(net);
    if (!l) ends.set(net, (l = []));
    l.push(e);
  };
  const portW = new Map(spec.ports.map((p) => [p.name, p.width]));
  const instances: InstanceDef[] = [];
  // multi-bit pins of the block: a splitter each, its outputs are the bits `name[i]`
  const splits: string[] = [];
  for (const p of spec.ports) {
    if (p.width === 1) { end(p.name, p.name); continue; }
    const s = `${p.name}_bits`;
    splits.push(s);
    instances.push({ name: s, def: splitter(Array(p.width).fill(1)), at: [0, 0] });
    end(`__${p.name}`, p.name);
    end(`__${p.name}`, `${s}.in`);
    for (let i = 0; i < p.width; i++) end(`${p.name}[${i}]`, `${s}.o${i}`);
  }
  for (const it of insts) {
    for (const p of it.def.ports) {
      const c = it.conns[p.name];
      if (p.width === 1) {
        end(c as string, `${it.name}.${p.name}`);
      } else if (Array.isArray(c)) {
        // bits of an instance's bus port from separate nets: a merger / splitter in between
        const m = `${it.name}_${p.name}`;
        instances.push({ name: m, def: splitter(Array(p.width).fill(1)), at: [0, 0] });
        end(`__${m}`, `${m}.in`);
        end(`__${m}`, `${it.name}.${p.name}`);
        c.forEach((n, i) => end(n, `${m}.o${i}`));
      } else {
        if (portW.get(c) !== undefined && portW.get(c) !== p.width) throw new Error(`${spec.id}: ${it.name}.${p.name} width`);
        end(portW.has(c) ? `__${c}` : c, `${it.name}.${p.name}`);
      }
    }
  }
  // grid placement: column width from the symbols and their longest labels
  const all = [...insts.map((i) => ({ name: i.name, def: i.def, label: i.label })),
    ...instances.map((i) => ({ name: i.name, def: i.def, label: undefined }))];
  const labelOf = new Map<string, number>();
  for (const [net, es] of ends) for (const e of es) labelOf.set(e, Math.max(labelOf.get(e) ?? 0, tagLen(net.startsWith('__') ? net.slice(2) : net)));
  const rows = spec.rows ?? Math.max(1, Math.ceil(Math.sqrt(all.length)));
  const at = new Map<string, [number, number]>();
  let x = 2;
  for (let c = 0; c * rows < all.length; c++) {
    const col = all.slice(c * rows, (c + 1) * rows);
    const geo = col.map((i) => symbolGeom(i.def));
    const left = Math.max(0, ...col.flatMap((i) => i.def.ports.filter((p) => symbolGeom(i.def).ports[p.name].exit === 'left').map((p) => labelOf.get(`${i.name}.${p.name}`) ?? 0)));
    const right = Math.max(0, ...col.flatMap((i) => i.def.ports.filter((p) => symbolGeom(i.def).ports[p.name].exit === 'right').map((p) => labelOf.get(`${i.name}.${p.name}`) ?? 0)));
    const w = Math.max(...geo.map((g) => g.w));
    let y = 2;
    col.forEach((i, k) => {
      const g = geo[k];
      const up = i.def.ports.some((p) => g.ports[p.name].exit === 'up') ? 3 : 1.5;
      const down = i.def.ports.some((p) => g.ports[p.name].exit === 'down') ? 3 : 1;
      y += up;
      at.set(i.name, [Math.ceil(x + left), Math.ceil(y)]);
      y = Math.ceil(y) + g.h + down;
    });
    x = Math.ceil(x + left) + w + right + 2;
  }
  for (const i of insts) instances.push({ name: i.name, def: i.def, at: at.get(i.name), label: i.label });
  // rails used by name: one symbol each, its net drawn as labels like the rest
  const rails: [string, ComponentDef][] = [['VDD', VDD], ['GND', GND]];
  for (const [net, def] of rails) {
    if (!ends.has(net)) continue;
    instances.push({ name: net.toLowerCase(), def, at: [Math.ceil(x) + 2, net === 'VDD' ? 2 : 6] });
    end(net, `${net.toLowerCase()}.p`);
  }
  for (const i of instances) if (splits.includes(i.name) || i.at![0] === 0) i.at = at.get(i.name);
  const nets: NetDef[] = [...ends].map(([name, es]) => {
    const nd: NetDef = { name: name.startsWith('__') ? name.slice(2) : name, ends: es, tags: true };
    const c = caps.get(name);
    if (c !== undefined) nd.cap = c;
    return nd;
  });
  // the block's own pins: inputs on the left edge, outputs on the right, stacked
  const pins: Record<string, [number, number]> = {};
  let yl = 2, yr = 2;
  for (const p of spec.ports) {
    if (p.dir === 'out') { pins[p.name] = [x + 6, yr]; yr += 3; } else { pins[p.name] = [-6, yl]; yl += 3; }
  }
  return { level: 'switch' as const, instances, nets, pins };
}
