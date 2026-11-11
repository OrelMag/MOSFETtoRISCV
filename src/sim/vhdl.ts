// Structural VHDL-93 generated from a netlist: the circuit on screen, as an entity and an architecture that instantiates
// its parts by direct entity instantiation (`entity work.x`). The VHDL twin of sim/verilog.ts, made the same way:
//   - every net is a signal of its own; an input port drives its net, an output port is driven from its net, so no
//     output is ever read inside the architecture (VHDL-93 forbids that);
//   - splitters and mergers (prim 'alias') are concurrent assignments of bit ranges, free as in the simulation;
//   - the NAND is the brick: entity nand2 with y <= a nand b, so the hierarchy bottoms out where the gates' Verilog does;
//   - parts below the gate level (transistors, relays, tubes, capacitors, sense amplifiers) and the world outside the
//     circuit (keys, consoles, screens) have no VHDL: they are comments naming their nets, as in the Verilog.
// No VHDL tool runs in the tests (tests/vhdl.test.ts checks names and port maps); scripts/vhdl-check.ts has GHDL analyse and
// elaborate a set of designs and simulate the combinational ones against ours, in CI (.github/workflows/vhdl.yml), outside the
// deploy gate.

import { type ComponentDef, isExternal, netlistOf, parseEnd, type PortDef } from './types';
import { expandLines, type HdlLines } from './verilog';

/** VHDL's reserved words (VHDL-93), which an identifier must not be. */
const RESERVED = new Set(('abs access after alias all and architecture array assert attribute begin block body buffer bus case component '
  + 'configuration constant disconnect downto else elsif end entity exit file for function generate generic group guarded if impure in '
  + 'inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package port '
  + 'postponed procedure process pure range record register reject rem report return rol ror select severity signal shared sla sll sra '
  + 'srl subtype then to transport type unaffected units until use variable wait when while with xnor xor').split(' '));

/**
 * A legal VHDL basic identifier for s: letters, digits and single underscores, starting with a letter, not ending with an
 * underscore, not a reserved word. VHDL is case-insensitive, so callers compare names lowercased.
 */
export function vhdlIdent(s: string, fallback = 'n'): string {
  let t = s.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!t) t = fallback;
  if (!/^[A-Za-z]/.test(t)) t = `${fallback}_${t}`;
  if (RESERVED.has(t.toLowerCase())) t = `${t}_x`;
  return t;
}

/** ASCII text for a comment: VHDL-93 allows only ISO 8859-1 in a source file, comments included (GHDL refuses →, which is not in it); ASCII keeps every tool safe. */
const ASCII: Record<string, string> = { '→': '->', '←': '<-', '↔': '<->', '×': 'x', '·': '.', '≤': '<=', '≥': '>=', '≠': '/=',
  '–': '-', '—': '-', '−': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', 'µ': 'u', 'μ': 'u', 'π': 'pi',
  ' ': ' ', ' ': ' ', ' ': ' ', '²': '^2', '√': 'sqrt', '≈': '~', '±': '+/-', '⊕': 'xor', '¬': 'not ', '∧': 'and', '∨': 'or' };
export function vhdlText(s: string): string {
  return s.replace(/[^\x20-\x7e\n]/g, (c) => ASCII[c] ?? (c.normalize('NFD').replace(/[^\x20-\x7e]/g, '') || '?'));
}

const ENTITY_NAME: Record<string, string> = { nand: 'nand2' };

export function entityName(def: ComponentDef): string {
  return ENTITY_NAME[def.id] ?? vhdlIdent(def.id, 'e');
}

const typeOf = (w: number) => (w > 1 ? `std_logic_vector(${w - 1} downto 0)` : 'std_logic');
const modeOf = (p: PortDef) => (p.dir === 'in' ? 'in' : p.dir === 'out' ? 'out' : 'inout');

function entityDecl(def: ComponentDef, names: (p: PortDef) => string): string[] {
  const lines = [`entity ${entityName(def)} is`];
  if (def.ports.length) {
    lines.push('  port (');
    lines.push(def.ports.map((p) => `    ${names(p)} : ${modeOf(p)} ${typeOf(p.width)}`).join(';\n'));
    lines.push('  );');
  }
  lines.push(`end entity ${entityName(def)};`);
  return lines;
}

/** Unique, case-insensitive names out of one namespace. */
class Names {
  private used = new Set<string>();
  take(want: string): string {
    let t = want, k = 1;
    while (this.used.has(t.toLowerCase())) t = `${want}_${k++}`;
    this.used.add(t.toLowerCase());
    return t;
  }
}

const portNames = new WeakMap<ComponentDef, Map<string, string>>();
/** A component's port names in VHDL, unique case-insensitively: the entity declares them and every port map uses them. */
function portsOf(def: ComponentDef): Map<string, string> {
  let m = portNames.get(def);
  if (!m) {
    const names = new Names();
    m = new Map(def.ports.map((p) => [p.name, names.take(vhdlIdent(p.name))]));
    portNames.set(def, m);
  }
  return m;
}

/** The VHDL name of each of def's ports (the entity's and every port map's). */
export function vhdlPorts(def: ComponentDef): ReadonlyMap<string, string> {
  return portsOf(def);
}

/** The NAND gate: the brick every gate-level hierarchy ends in. */
export const NAND2_VHDL = [
  '-- NAND, the brick: at transistor level two PMOS in parallel and two NMOS in series',
  'library ieee;',
  'use ieee.std_logic_1164.all;',
  '',
  'entity nand2 is',
  '  port (',
  '    a : in std_logic;',
  '    b : in std_logic;',
  '    y : out std_logic',
  '  );',
  'end entity nand2;',
  '',
  'architecture gate of nand2 is',
  'begin',
  '  y <= a nand b;',
  'end architecture gate;',
].join('\n');

/** This component's entity and its structural architecture (null: it has no netlist to show). */
export function structuralVhdl(def: ComponentDef): string | null {
  return vhdlLines(def)?.text ?? null;
}

/** structuralVhdl with, for every line, the instance it declares or wires (null: not an instance's). */
export function vhdlLines(def: ComponentDef): HdlLines | null {
  if (def.prim === 'nand') return { text: NAND2_VHDL, owners: NAND2_VHDL.split('\n').map(() => null) };
  const nl = netlistOf(def);
  if (!nl) return null;
  const names = new Names();
  const portName = portsOf(def);
  for (const v of portName.values()) names.take(v);
  const pn = (p: PortDef) => portName.get(p.name)!;

  const widthOf = (end: string): number => {
    const { inst, port } = parseEnd(end);
    if (inst === null) return def.ports.find((p) => p.name === port)!.width;
    return nl.instances.find((i) => i.name === inst)!.def.ports.find((p) => p.name === port)!.width;
  };
  // A signal per net, named after the net (or s<i>); the ports connect to it below.
  const sig: string[] = [];
  const decls: string[] = [];
  const body: { s: string; o: string | null }[] = [];
  let cur: string | null = null;
  const at = (t: string) => ({ s: t, o: cur });
  nl.nets.forEach((net, i) => {
    const s = names.take(net.name ? `s_${vhdlIdent(net.name)}` : `s${i}`);
    sig.push(s);
    decls.push(`  signal ${s} : ${typeOf(widthOf(net.ends[0]))};`);
    for (const e of net.ends.map(parseEnd)) {
      if (e.inst !== null) continue;
      const p = def.ports.find((q) => q.name === e.port)!;
      if (p.dir === 'in') body.push(at(`  ${s} <= ${pn(p)};`));
      else if (p.dir === 'out') body.push(at(`  ${pn(p)} <= ${s};`));
      else body.push(at(`  -- ${pn(p)} is bidirectional: joined to ${s} (several drivers resolve on std_logic)`));
    }
  });
  const endSig = new Map<string, string>();
  nl.nets.forEach((net, i) => net.ends.forEach((e) => endSig.set(e, sig[i])));

  const instName = (n: string) => names.take(`u_${vhdlIdent(n, 'u')}`);
  const undriven = (w: number) => {
    const s = names.take('s_nc');
    decls.push(`  signal ${s} : ${typeOf(w)};  -- unconnected input`);
    return s;
  };
  for (const inst of nl.instances) {
    cur = inst.name;
    const c = inst.def;
    const conn = (port: string) => endSig.get(`${inst.name}.${port}`) ?? '';
    const w = (port: string) => c.ports.find((p) => p.name === port)!.width;
    if (c.prim === 'alias') {
      // runs of bits from the box's input side to its output side, one assignment each
      const sel = (s: string, port: string, hi: number, lo: number) => (w(port) === 1 ? s : hi === lo ? `${s}(${lo})` : `${s}(${hi} downto ${lo})`);
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
        if (a && b) body.push(at(`  ${sel(a, p0.dst, p0.db + n - 1, p0.db)} <= ${sel(b, p0.src, p0.sb + n - 1, p0.sb)};`));
        k += n;
      }
      continue;
    }
    const nets = () => c.ports.map((p) => conn(p.name) || '(open)').join(', ');
    if (c.prim === 'vdd' || c.prim === 'gnd') {
      const n = conn('p');
      if (n) body.push(at(`  ${n} <= '${c.prim === 'vdd' ? '1' : '0'}';  -- ${c.prim === 'vdd' ? 'VDD' : 'GND'}`));
      continue;
    }
    // every other primitive is below the gate level (switches, analog parts, a magnetic core): a comment, never an entity
    if (c.prim && c.prim !== 'nand') {
      const what: Record<string, string> = {
        nmos: 'NMOS transistor', pmos: 'PMOS transistor', dep: 'depletion load', res: 'resistor', cap: 'capacitor', fgmos: 'floating-gate transistor',
        relay: 'relay', triode: 'triode', diode: 'vacuum diode', sense: 'sense amplifier', vhalf: 'VDD/2 source', core: 'ferrite core',
      };
      body.push(at(`  -- ${inst.name}: ${what[c.prim] ?? c.name} on ${nets()} (below the gate level: VHDL has no switches)`));
      continue;
    }
    if (isExternal(c)) {
      body.push(at(`  -- ${inst.name}: ${c.name} (${c.modelPanel ? 'a model of a cable or other medium' : 'a sandbox part outside the circuit'}, not hardware): ${nets()}`));
      continue;
    }
    const formal = portsOf(c);
    // an input left unconnected gets a signal nothing drives ('U', our X): VHDL-93 refuses `open` on an input without a default
    const map = c.ports.map((p) => `${formal.get(p.name)} => ${conn(p.name) || (p.dir === 'in' ? undriven(p.width) : 'open')}`);
    body.push(at(`  ${instName(inst.name)} : entity work.${entityName(c)} port map (${map.join(', ')});`));
  }

  const head = [`-- ${def.name}: generated from the schematic`, 'library ieee;', 'use ieee.std_logic_1164.all;', ''];
  head.push(...entityDecl(def, pn), '');
  head.push(`architecture structure of ${entityName(def)} is`);
  head.push(...decls);
  head.push('begin');
  const out = expandLines([...head.map((t) => ({ s: t, o: null })), ...body, { s: 'end architecture structure;', o: null }]);
  return { text: vhdlText(out.text), owners: out.owners };
}

/**
 * The whole hierarchy in one file, leaves first, so an analyser can read it top to bottom: every distinct definition
 * below `def` once. A behavioural leaf (a ROM, a large RAM, a model) gets its entity and an architecture saying so.
 */
export function vhdlHierarchy(def: ComponentDef): { text: string; entities: number; filename: string } {
  const order: ComponentDef[] = [];
  const seen = new Set<string>();
  const visit = (d: ComponentDef) => {
    if (seen.has(d.id) || d.prim === 'alias') return;
    seen.add(d.id);
    const nl = d.prim === 'nand' ? null : netlistOf(d);
    if (nl && !(d.preferBehavior && d.behavior)) for (const i of nl.instances) visit(i.def);
    order.push(d);
  };
  visit(def);
  const parts: string[] = [];
  for (const d of order) {
    const s = d.prim === 'nand' ? NAND2_VHDL : d.preferBehavior && d.behavior ? null : structuralVhdl(d);
    if (s) { parts.push(s); continue; }
    if (d.prim || isExternal(d)) continue; // below the gate level, or outside the circuit: comments where used
    const pn = portsOf(d);
    parts.push([`-- ${d.name}: simulated by its behaviour here (no structure to export)`, 'library ieee;', 'use ieee.std_logic_1164.all;', '',
      ...entityDecl(d, (p) => pn.get(p.name)!), '', `architecture behaviour of ${entityName(d)} is`, 'begin', `  -- ${d.summary ?? d.name}`, 'end architecture behaviour;'].join('\n'));
  }
  return { text: vhdlText(parts.join('\n\n') + '\n'), entities: parts.length, filename: `${entityName(def)}.vhd` };
}
