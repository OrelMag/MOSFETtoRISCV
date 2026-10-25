// Synthesizable Verilog for the whole hierarchy below a component, for real tools (Yosys, OpenROAD):
// one module per ComponentDef, NAND as a continuous assignment, flip-flops (`ff`: the master–slave
// DFF, a user chip ticked as one) as clocked processes (a synthesis tool cannot use cross-coupled
// NAND loops as storage), constant ties as 1'b0 / 1'b1, splitters and mergers as bit slices, a part
// with its own `hdl.synth` body (a large RAM / ROM: a `reg mem [..]` array) as that body. Plain
// Verilog-2005 with identifiers sanitized, so any tool reads it.
// externalPorts (the FPGA export): a sandbox part outside the circuit (a key, a switch bank, an LED, a display, a
// console: isExternal) becomes ports of every module above it, up to the top, so the board can drive its outputs
// and show its inputs; without it the part is a comment and its outputs are left undriven.

import { type ComponentDef, isExternal, isSwitchPrim, netlistOf, parseEnd, type PortDef } from './types';

const KEYWORDS = new Set(('always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config deassign default defparam design disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive endspecify endtable endtask event for force forever fork function generate genvar highz0 highz1 if ifnone incdir include initial inout input instance integer join large liblist library localparam macromodule medium module nand negedge nmos nor noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup pulsestyle_onevent pulsestyle_ondetect rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor logic bit byte int priority unique final do')
  .split(' '));

export function ident(s: string, fallback: string): string {
  let t = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (!t || /^[0-9]/.test(t) || /^_+$/.test(t)) t = fallback;
  if (KEYWORDS.has(t)) t += '_';
  return t;
}

const range = (w: number) => (w > 1 ? `[${w - 1}:0] ` : '');

/** A flip-flop (`ff`) whose only ports are d, q, clk (and en): exported as a process. */
export const ffLeaf = (def: ComponentDef) => {
  const ff = def.ff;
  return ff && def.ports.every((p) => [ff.d, ff.q, ff.clk, ff.en].includes(p.name)) ? ff : undefined;
};

/** Leaves of the exported hierarchy: written as behaviour, not expanded. */
function leafBody(def: ComponentDef, opts: ExportOptions = {}): string[] | null {
  if (def.id === 'nand') return ['  assign y = ~(a & b);'];
  const ff = ffLeaf(def);
  if (ff) {
    const n = (port: string) => portNameOf(def, port);
    const body = [`  always @(posedge ${n(ff.clk)}) ${ff.en ? `if (${n(ff.en)}) ` : ''}${n(ff.q)} <= ${n(ff.d)};`];
    return opts.powerOnZero ? [`  initial ${n(ff.q)} = 0;`, ...body] : body;
  }
  if (def.id === 'tie0' || def.id === 'tie1') return [`  assign ${def.ports[0].name} = 1'b${def.id === 'tie1' ? 1 : 0};`];
  // its own synthesizable body (a large memory as an array), the structure below it not exported
  if (def.hdl?.synth) return def.hdl.synth;
  return null;
}

/** A port of the exported top module (its Verilog name); `external`: one punched up from a sandbox part inside. */
export interface TopPort {
  name: string; dir: 'in' | 'out' | 'inout'; width: number; clock: boolean;
  external?: { path: string; part: string; port: string };
}
export interface ExportResult { verilog: string; modules: number; top: string; ports: TopPort[] }
/**
 * powerOnZero: every flip-flop starts at 0, as our reset('zero') does. Without it a flip-flop that is never written
 * holds an undefined value a synthesis tool may replace by any constant, so a cross-check against our simulation would
 * compare a value Verilog leaves open. Off for real flows (an ASIC flip-flop has no initial value).
 */
/**
 * externalPorts: external parts become ports (see the header); ioPart: more parts treated so (the sandbox's displays,
 * pure views drawn as alias boxes that join nothing).
 */
export interface ExportOptions { powerOnZero?: boolean; externalPorts?: boolean; ioPart?: (d: ComponentDef) => boolean }
const isIo = (d: ComponentDef, opts: ExportOptions) => !!opts.externalPorts && (isExternal(d) || !!opts.ioPart?.(d));

/** A port a module gains for an external part below it: `path` the instances down to the part, `port` its port. */
interface ExtPort { name: string; dir: 'in' | 'out'; width: number; path: string[]; port: string; part: ComponentDef }

export function synthVerilog(root: ComponentDef, topName?: string, opts: ExportOptions = {}): ExportResult {
  const names = new Map<ComponentDef, string>();
  const used = new Set<string>();
  const order: ComponentDef[] = [];
  const nameOf = (d: ComponentDef) => {
    let n = names.get(d);
    if (!n) {
      n = d === root && topName ? topName : ident(d.id, 'm');
      if (d.id === 'nand') n = 'nand2_cell';
      while (used.has(n)) n += '_';
      used.add(n);
      names.set(d, n);
    }
    return n;
  };
  const visit = (d: ComponentDef) => {
    if (names.has(d) && order.includes(d)) return;
    nameOf(d);
    if (!leafBody(d, opts)) {
      if (isSwitchPrim(d)) {
        throw new Error(`${d.name}: transistors, rails, resistors and capacitors are not synthesizable (export the exact structure instead)`);
      }
      const nl = netlistOf(d);
      if (!nl) throw new Error(`${d.id}: no netlist and no behaviour for export`);
      for (const i of nl.instances) if (i.def.prim !== 'alias' && !isExternal(i.def)) visit(i.def);
    }
    if (!order.includes(d)) order.push(d);
  };
  visit(root);

  // the ports each module gains for the external parts below it (memoized: one list per module)
  const extMemo = new Map<ComponentDef, ExtPort[]>();
  const extOf = (d: ComponentDef): ExtPort[] => {
    if (!opts.externalPorts || leafBody(d, opts)) return [];
    let list = extMemo.get(d);
    if (list) return list;
    list = [];
    const used = new Set(d.ports.map((p) => portNameOf(d, p.name)));
    const add = (raw: string, e: Omit<ExtPort, 'name'>) => {
      let n = ident(raw, 'x');
      while (used.has(n)) n += '_';
      used.add(n);
      list!.push({ ...e, name: n });
    };
    for (const inst of netlistOf(d)?.instances ?? []) {
      const c = inst.def;
      if (isIo(c, opts)) {
        for (const p of c.ports) {
          if (p.dir === 'inout') continue;
          add(`x_${inst.name}_${p.name}`, { dir: p.dir === 'in' ? 'out' : 'in', width: p.width, path: [inst.name], port: p.name, part: c });
        }
      } else if (c.prim !== 'alias' && !isExternal(c)) {
        for (const e of extOf(c)) add(`x_${inst.name}_${e.name.replace(/^x_/, '')}`, { ...e, path: [inst.name, ...e.path] });
      }
    }
    extMemo.set(d, list);
    return list;
  };

  const out: string[] = [`// Generated by MOSFET → RISC-V from the schematics. Top: ${nameOf(root)}`, ''];
  for (const d of order) out.push(moduleText(d, nameOf, opts, extOf), '');
  const ports: TopPort[] = [
    ...root.ports.map((p) => ({ name: portNameOf(root, p.name), dir: p.dir, width: p.width, clock: !!p.clock })),
    ...extOf(root).map((e) => ({
      name: e.name, dir: e.dir, width: e.width, clock: false, external: { path: e.path.join('.'), part: e.part.name, port: e.port },
    })),
  ];
  return { verilog: out.join('\n'), modules: order.length, top: nameOf(root), ports };
}

function moduleText(def: ComponentDef, nameOf: (d: ComponentDef) => string, opts: ExportOptions, extOf: (d: ComponentDef) => ExtPort[]): string {
  const portName = new Map<string, string>();
  const used = new Set<string>();
  for (const p of def.ports) {
    let n = ident(p.name, 'p');
    while (used.has(n)) n += '_';
    used.add(n);
    portName.set(p.name, n);
  }
  const leaf = leafBody(def, opts);
  const isReg = (p: PortDef) => !!leaf && p.name === ffLeaf(def)?.q;
  const lines: string[] = [];
  const ext = extOf(def);
  for (const e of ext) used.add(e.name);
  lines.push(`module ${nameOf(def)} (${[...def.ports.map((p) => portName.get(p.name)), ...ext.map((e) => e.name)].join(', ')});`);
  for (const p of def.ports) lines.push(`  ${p.dir === 'in' ? 'input' : p.dir === 'out' ? 'output' : 'inout'} ${isReg(p) ? 'reg ' : ''}${range(p.width)}${portName.get(p.name)};`);
  for (const e of ext) lines.push(`  ${e.dir === 'in' ? 'input' : 'output'} ${range(e.width)}${e.name};  // ${e.part.name} ${e.path.join('.')}: ${e.port}`);
  if (leaf) {
    lines.push(...leaf, 'endmodule');
    return lines.join('\n');
  }
  const nl = netlistOf(def)!;
  const widthOf = (end: string): number => {
    const { inst, port } = parseEnd(end);
    if (inst === null) return def.ports.find((p) => p.name === port)!.width;
    return nl.instances.find((i) => i.name === inst)!.def.ports.find((p) => p.name === port)!.width;
  };
  const netName: string[] = [];
  const assigns: string[] = [];
  nl.nets.forEach((net, i) => {
    const own = net.ends.map(parseEnd).filter((e) => e.inst === null).map((e) => e.port);
    if (own.length) {
      // a net touching several ports: the first input (or the first port) drives the others
      const drv = own.find((p) => def.ports.find((q) => q.name === p)!.dir === 'in') ?? own[0];
      netName.push(portName.get(drv)!);
      for (const o of own) if (o !== drv) assigns.push(`  assign ${portName.get(o)} = ${portName.get(drv)};`);
      return;
    }
    let n = ident(net.name ?? '', `n${i}`);
    if (n === `n${i}` || used.has(n)) n = `${n === `n${i}` ? '' : `${n}_`}n${i}`;
    while (used.has(n)) n += '_';
    used.add(n);
    lines.push(`  wire ${range(widthOf(net.ends[0]))}${n};`);
    netName.push(n);
  });
  const endNet = new Map<string, string>();
  nl.nets.forEach((net, i) => net.ends.forEach((e) => endNet.set(e, netName[i])));
  const instUsed = new Set<string>(used);
  for (const inst of nl.instances) {
    const c = inst.def;
    const conn = (port: string) => endNet.get(`${inst.name}.${port}`);
    if (isIo(c, opts)) {
      // the part's pins are this module's ports: its inputs leave as outputs, its outputs come in as inputs
      for (const e of ext) {
        if (e.path.length !== 1 || e.path[0] !== inst.name) continue;
        const n = conn(e.port);
        if (e.dir === 'out') assigns.push(`  assign ${e.name} = ${n ?? `${e.width}'d0`};`);
        else if (n) assigns.push(`  assign ${n} = ${e.name};`);
      }
      continue;
    }
    if (c.prim === 'alias') {
      // pure wiring: one assign per aliased bit, from the input side to the output side
      const width = (port: string) => c.ports.find((p) => p.name === port)!.width;
      const dir = (port: string) => c.ports.find((p) => p.name === port)!.dir;
      const bitOf = (port: string, b: number) => { const n = conn(port); return n ? (width(port) > 1 ? `${n}[${b}]` : n) : null; };
      for (const [pa, ba, pb, bb] of c.alias ?? []) {
        const [src, sb, dst, db] = dir(pa) === 'in' ? [pa, ba, pb, bb] : [pb, bb, pa, ba];
        if (dir(src) !== 'in' || dir(dst) !== 'out') continue;
        const from = bitOf(src, sb), to = bitOf(dst, db);
        if (from && to) assigns.push(`  assign ${to} = ${from};`);
      }
      continue;
    }
    if (isExternal(c)) {
      lines.push(`  // ${inst.name}: ${c.name} (a sandbox part outside the circuit, not hardware): its outputs are left undriven`);
      continue;
    }
    let iname = ident(inst.name, 'u');
    while (instUsed.has(iname)) iname += '_';
    instUsed.add(iname);
    const args = c.ports.map((p) => `.${portNameOf(c, p.name)}(${conn(p.name) ?? ''})`);
    // the child's external ports, wired to ours of the same part
    for (const e of extOf(c)) {
      const mine = ext.find((x) => x.path.length === e.path.length + 1 && x.path[0] === inst.name && x.port === e.port && x.path.every((s, k) => k === 0 || s === e.path[k - 1]));
      args.push(`.${e.name}(${mine?.name ?? ''})`);
    }
    lines.push(`  ${nameOf(c)} ${iname} (${args.join(', ')});`);
  }
  lines.push(...assigns, 'endmodule');
  return lines.join('\n');
}

/** Port names as sanitized in the child's module (deterministic: same rule as moduleText). */
function portNameOf(def: ComponentDef, port: string): string {
  const used = new Set<string>();
  for (const p of def.ports) {
    let n = ident(p.name, 'p');
    while (used.has(n)) n += '_';
    used.add(n);
    if (p.name === port) return n;
  }
  return port;
}
