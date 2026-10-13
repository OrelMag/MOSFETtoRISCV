// A netlist builder for the 6502's blocks (Appendix A). Instances are wired by net name; bits of a
// multi-bit pin are `name[i]` (the builder adds the splitter); a block is laid out on a grid and
// its nets are drawn as named labels, the way a large schematic names its control lines instead of
// drawing them. Small cells are drawn by hand elsewhere; this is for the blocks above them.

import { symbolGeom } from '../../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef, SymbolSpec } from '../../sim/types';
import { define, merger, splitter } from '../define';
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
  /** Names of the bits of a bus pin (default name[i]): a bundle of named lines, drawn as one bus outside. */
  bits?: Record<string, string[]>;
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
  const bitName = (port: string, i: number) => spec.bits?.[port]?.[i] ?? `${port}[${i}]`;
  const placed: { name: string; def: ComponentDef; label?: string }[] = [];
  const ones = (w: number) => Array(w).fill(1);
  // multi-bit pins of the block: a splitter for an input (its outputs are the bits `name[i]`), a
  // merger for an output or a bus (the bits flow into the pin), so every part reaches a pin
  for (const p of spec.ports) {
    if (p.width === 1) { end(p.name, p.name); continue; }
    const name = `${p.name}_bits`;
    end(`__${p.name}`, p.name);
    // a bus the blocks inside share whole (an internal bus brought out) needs no splitter
    const used = !!spec.bits?.[p.name] || insts.some((it) => Object.values(it.conns).some((c) => (Array.isArray(c) ? c : [c]).some((n) => n.startsWith(`${p.name}[`))));
    if (!used) continue;
    if (p.dir === 'in') {
      placed.push({ name, def: splitter(ones(p.width)) });
      end(`__${p.name}`, `${name}.in`);
      for (let i = 0; i < p.width; i++) end(bitName(p.name, i), `${name}.o${i}`);
    } else {
      placed.push({ name, def: merger(ones(p.width)) });
      end(`__${p.name}`, `${name}.out`);
      for (let i = 0; i < p.width; i++) end(bitName(p.name, i), `${name}.i${i}`);
    }
  }
  for (const it of insts) {
    placed.push({ name: it.name, def: it.def, label: it.label });
    for (const p of it.def.ports) {
      const c = it.conns[p.name];
      if (p.width === 1) {
        end(c as string, `${it.name}.${p.name}`);
      } else if (Array.isArray(c)) {
        // an instance's bus port from separate nets: a merger into an input, a splitter out of an output
        const m = `${it.name}_${p.name}`;
        end(`__${m}`, `${it.name}.${p.name}`);
        if (p.dir === 'in') {
          placed.push({ name: m, def: merger(ones(p.width)) });
          end(`__${m}`, `${m}.out`);
          c.forEach((n, i) => end(n, `${m}.i${i}`));
        } else {
          placed.push({ name: m, def: splitter(ones(p.width)) });
          end(`__${m}`, `${m}.in`);
          c.forEach((n, i) => end(n, `${m}.o${i}`));
        }
      } else {
        if (portW.get(c) !== undefined && portW.get(c) !== p.width) throw new Error(`${spec.id}: ${it.name}.${p.name} width`);
        end(portW.has(c) ? `__${c}` : c, `${it.name}.${p.name}`);
      }
    }
  }
  // rails used by name: one symbol each, drawn with labels like every net
  for (const [net, def] of [['VDD', VDD], ['GND', GND]] as const) {
    if (!ends.has(net)) continue;
    placed.push({ name: net.toLowerCase(), def });
    end(net, `${net.toLowerCase()}.p`);
  }
  // grid placement: each column as wide as its symbols and their longest labels on each side
  const netName = (n: string) => (n.startsWith('__') ? n.slice(2) : n);
  const labelOf = new Map<string, number>();
  for (const [net, es] of ends) for (const e of es) labelOf.set(e, Math.max(labelOf.get(e) ?? 0, tagLen(netName(net))));
  const lab = (i: { name: string; def: ComponentDef }, exit: string) =>
    Math.max(0, ...i.def.ports.filter((p) => symbolGeom(i.def).ports[p.name].exit === exit).map((p) => labelOf.get(`${i.name}.${p.name}`) ?? 0));
  const rows = spec.rows ?? Math.max(1, Math.ceil(Math.sqrt(placed.length)));
  const at = new Map<string, [number, number]>();
  let x = 0;
  for (let c = 0; c * rows < placed.length; c++) {
    const col = placed.slice(c * rows, (c + 1) * rows);
    const left = Math.max(0, ...col.map((i) => lab(i, 'left')));
    const right = Math.max(0, ...col.map((i) => lab(i, 'right')));
    const w = Math.max(...col.map((i) => symbolGeom(i.def).w));
    const x0 = Math.ceil(x + left + 1);
    let y = 0;
    for (const i of col) {
      const g = symbolGeom(i.def);
      y += Math.max(2, lab(i, 'up') ? 3 : 0) + 1;
      at.set(i.name, [x0, Math.ceil(y)]);
      y = Math.ceil(y) + g.h + Math.max(1, lab(i, 'down') ? 3 : 0);
    }
    x = x0 + w + right + 2;
  }
  const instances: InstanceDef[] = placed.map((i) => ({ name: i.name, def: i.def, at: at.get(i.name), label: i.label }));
  const nets: NetDef[] = [...ends].map(([name, es]) => {
    const nd: NetDef = { name: netName(name), ends: es, tags: true };
    const c = caps.get(name);
    if (c !== undefined) nd.cap = c;
    return nd;
  });
  // the block's own pins: inputs and buses on the left, outputs on the right, stacked
  const pins: Record<string, [number, number]> = {};
  const leftW = Math.max(0, ...spec.ports.filter((p) => p.dir !== 'out').map((p) => tagLen(p.name)));
  const rightW = Math.max(0, ...spec.ports.filter((p) => p.dir === 'out').map((p) => tagLen(p.name)));
  let yl = 2, yr = 2;
  for (const p of spec.ports) {
    if (p.dir === 'out') { pins[p.name] = [Math.ceil(x + rightW + 2), yr]; yr += 2; } else { pins[p.name] = [-Math.ceil(leftW + 2), yl]; yl += 2; }
  }
  return { level: 'switch' as const, instances, nets, pins };
}
