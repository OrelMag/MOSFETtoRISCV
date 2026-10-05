// Structural SystemVerilog generated from a netlist: exactly the circuit on screen.

import { type ComponentDef, netlistOf, parseEnd, type PortDef } from './types';

const MODULE_NAME: Record<string, string> = { nand: 'nand2' };

export function moduleName(def: ComponentDef): string {
  return MODULE_NAME[def.id] ?? def.id;
}

const range = (w: number) => (w > 1 ? `[${w - 1}:0] ` : '');

export function structuralVerilog(def: ComponentDef): string | null {
  const nl = netlistOf(def);
  if (!nl) return null;
  const sw = nl.level === 'switch';
  const lines: string[] = [];
  const portDecl = (p: PortDef) => `  ${p.dir === 'in' ? 'input ' : p.dir === 'out' ? 'output' : 'inout '} logic ${range(p.width)}${p.name}`;
  lines.push(`// ${def.name}: generated from the schematic`);
  lines.push(`module ${moduleName(def)} (`);
  lines.push(def.ports.map(portDecl).join(',\n'));
  lines.push(');');

  const portNames = new Set(def.ports.map((p) => p.name));
  const widthOf = (end: string): number => {
    const { inst, port } = parseEnd(end);
    if (inst === null) return def.ports.find((p) => p.name === port)!.width;
    return nl.instances.find((i) => i.name === inst)!.def.ports.find((p) => p.name === port)!.width;
  };
  // Name each net: its own port if it touches one, else its declared name, else n<i>.
  const used = new Set(portNames);
  const netName: string[] = [];
  const decls: string[] = [];
  const assigns: string[] = [];
  nl.nets.forEach((net, i) => {
    const own = net.ends.map(parseEnd).filter((e) => e.inst === null).map((e) => e.port);
    let name: string;
    if (own.length) {
      name = own[0];
      for (const extra of own.slice(1)) assigns.push(`  assign ${extra} = ${name};`);
    } else {
      name = net.name && !used.has(net.name) ? net.name : `n${i}`;
      while (used.has(name)) name += '_';
      used.add(name);
      decls.push(`  logic ${range(widthOf(net.ends[0]))}${name};`);
    }
    netName.push(name);
  });
  const endNet = new Map<string, string>();
  nl.nets.forEach((net, i) => net.ends.forEach((e) => endNet.set(e, netName[i])));

  if (sw) lines.push('  supply1 vdd_rail;  supply0 gnd_rail;');
  lines.push(...decls);
  if (decls.length) lines.push('');

  for (const inst of nl.instances) {
    const c = inst.def;
    const conn = (port: string) => endNet.get(`${inst.name}.${port}`) ?? '';
    if (c.prim === 'alias') {
      // splitter / merger → assigns with bit slices
      const pins = c.ports;
      const one = pins.find((p) => p.name === 'in' || p.name === 'out')!;
      let bit = 0;
      for (const p of pins) {
        if (p === one) continue;
        const slice = p.width > 1 ? `[${bit + p.width - 1}:${bit}]` : `[${bit}]`;
        const a = conn(p.name), b = conn(one.name);
        if (a && b) assigns.push(one.name === 'in' ? `  assign ${a} = ${b}${slice};` : `  assign ${b}${slice} = ${a};`);
        bit += p.width;
      }
      continue;
    }
    if (c.prim === 'vdd' || c.prim === 'gnd') {
      const n = conn('p');
      if (n) assigns.push(`  assign ${n} = ${c.prim === 'vdd' ? 'vdd_rail' : 'gnd_rail'};`);
      continue;
    }
    if (c.prim === 'nmos' || c.prim === 'pmos') {
      lines.push(`  ${c.prim} ${inst.name} (${conn('d') || '/*nc*/'}, ${conn('s') || '/*nc*/'}, ${conn('g') || '/*nc*/'});`);
      continue;
    }
    const args = c.ports.map((p) => `.${p.name}(${conn(p.name)})`);
    lines.push(`  ${moduleName(c)} ${inst.name} (${args.join(', ')});`);
  }
  if (assigns.length) {
    lines.push('');
    lines.push(...assigns);
  }
  lines.push('endmodule');
  return lines.join('\n');
}
