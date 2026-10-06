// Structural SystemVerilog generated from a netlist: exactly the circuit on screen.

import { type ComponentDef, netlistOf, parseEnd, type PortDef } from './types';
import { ident } from './vexport';

const MODULE_NAME: Record<string, string> = { nand: 'nand2' };

export function moduleName(def: ComponentDef): string {
  return MODULE_NAME[def.id] ?? ident(def.id, 'm');
}

/** Port, net and instance names as legal (System)Verilog identifiers. */
const id = (s: string) => ident(s, 'n');

const range = (w: number) => (w > 1 ? `[${w - 1}:0] ` : '');

export function structuralVerilog(def: ComponentDef): string | null {
  const nl = netlistOf(def);
  if (!nl) return null;
  const sw = nl.level === 'switch';
  const lines: string[] = [];
  const portDecl = (p: PortDef) => `  ${p.dir === 'in' ? 'input ' : p.dir === 'out' ? 'output' : 'inout '} logic ${range(p.width)}${id(p.name)}`;
  lines.push(`// ${def.name}: generated from the schematic`);
  lines.push(`module ${moduleName(def)} (`);
  lines.push(def.ports.map(portDecl).join(',\n'));
  lines.push(');');

  const portNames = new Set(def.ports.map((p) => id(p.name)));
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
    const own = net.ends.map(parseEnd).filter((e) => e.inst === null).map((e) => id(e.port));
    let name: string;
    if (own.length) {
      name = own[0];
      for (const extra of own.slice(1)) assigns.push(`  assign ${extra} = ${name};`);
    } else {
      name = net.name && !used.has(id(net.name)) ? id(net.name) : `n${i}`;
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

  // Instances share the namespace with nets: rename an instance that clashes (e.g. 'zero').
  const instName = (n: string) => {
    let t = id(n);
    while (used.has(t)) t = `u_${t}`;
    used.add(t);
    return t;
  };
  for (const inst of nl.instances) {
    const c = inst.def;
    const conn = (port: string) => endNet.get(`${inst.name}.${port}`) ?? '';
    if (c.prim === 'alias') {
      // Wiring boxes (splitters, mergers, shifts, reversals): one assign per run of bits, from
      // the box's input side to its output side.
      const w = (port: string) => c.ports.find((p) => p.name === port)!.width;
      const sel = (net: string, port: string, hi: number, lo: number) =>
        w(port) === 1 ? net : hi === lo ? `${net}[${lo}]` : `${net}[${hi}:${lo}]`;
      const pairs = (c.alias ?? []).map(([pa, ba, pb, bb]) => {
        const aIn = c.ports.find((p) => p.name === pa)!.dir === 'in';
        return aIn ? { src: pa, sb: ba, dst: pb, db: bb } : { src: pb, sb: bb, dst: pa, db: ba };
      }).sort((x, y) => x.dst.localeCompare(y.dst) || x.db - y.db);
      for (let k = 0; k < pairs.length;) {
        const p0 = pairs[k];
        let n = 1;
        while (k + n < pairs.length && pairs[k + n].dst === p0.dst && pairs[k + n].src === p0.src
          && pairs[k + n].db === p0.db + n && pairs[k + n].sb === p0.sb + n) n++;
        const a = conn(p0.dst), b = conn(p0.src);
        if (a && b) assigns.push(`  assign ${sel(a, p0.dst, p0.db + n - 1, p0.db)} = ${sel(b, p0.src, p0.sb + n - 1, p0.sb)};`);
        k += n;
      }
      continue;
    }
    if (c.prim === 'vdd' || c.prim === 'gnd') {
      const n = conn('p');
      if (n) assigns.push(`  assign ${n} = ${c.prim === 'vdd' ? 'vdd_rail' : 'gnd_rail'};`);
      continue;
    }
    if (c.prim === 'nmos' || c.prim === 'pmos') {
      lines.push(`  ${c.prim} ${instName(inst.name)} (${conn('d') || '/*nc*/'}, ${conn('s') || '/*nc*/'}, ${conn('g') || '/*nc*/'});`);
      continue;
    }
    const args = c.ports.map((p) => `.${id(p.name)}(${conn(p.name)})`);
    lines.push(`  ${moduleName(c)} ${instName(inst.name)} (${args.join(', ')});`);
  }
  if (assigns.length) {
    lines.push('');
    lines.push(...assigns);
  }
  lines.push('endmodule');
  return lines.join('\n');
}
