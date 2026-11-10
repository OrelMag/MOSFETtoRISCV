// The VHDL view (sim/vhdl.ts) over the whole registry: every netlist emits, identifiers are legal VHDL-93 and unique
// (case-insensitively) where they share a namespace, every port map names the ports of the entity it instantiates, and a
// hierarchy file declares each entity before it is used. scripts/vhdl-check.ts (CI: .github/workflows/vhdl.yml) has GHDL
// analyse and elaborate a set of designs; these tests need no VHDL tool.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { bigRam } from '../src/lib/bigmem';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { entityName, structuralVhdl, vhdlHierarchy, vhdlIdent, vhdlPorts } from '../src/sim/vhdl';

const LEGAL = /^[A-Za-z](_?[A-Za-z0-9])*$/;

/** Port names an entity declares, by entity name (from the generated text: what a tool would see). */
function declaredPorts(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/entity (\w+) is\n(?:  port \(\n([\s\S]*?)\n  \);\n)?end entity/g))
    out.set(m[1].toLowerCase(), (m[2] ?? '').split(';\n').filter(Boolean).map((l) => l.trim().split(' : ')[0].toLowerCase()));
  return out;
}

describe('VHDL identifiers', () => {
  it('sanitizes to legal basic identifiers, never a reserved word', () => {
    for (const s of ['a', 'q_n', 'Q', 'w3.ff0', '_x', '9lives', 'in', 'out', 'signal', 'a__b_', '', 'π', 'dout[3]'])
      expect(vhdlIdent(s), s).toMatch(LEGAL);
    expect(vhdlIdent('in')).toBe('in_x');
    expect(vhdlIdent('a__b_')).toBe('a_b');
  });

  it('gives distinct definitions distinct entity names', () => {
    const seen = new Map<string, string>();
    for (const d of registry.values()) {
      const k = entityName(d).toLowerCase();
      expect(seen.get(k) ?? d.id, k).toBe(d.id);
      seen.set(k, d.id);
    }
  });
});

describe('every registered netlist', () => {
  const defs = [...registry.values()].filter((d) => netlistOf(d) && d.prim !== 'alias');

  it('emits an entity and an architecture with legal, unique names', () => {
    for (const d of defs) {
      const v = structuralVhdl(d);
      expect(v, d.id).toBeTruthy();
      const text = v!;
      expect(text, d.id).toContain(`entity ${entityName(d)} is`);
      expect(text.match(/^architecture /gm)?.length, d.id).toBe(1);
      expect(/[^\x20-\x7e\n]/.test(text), `${d.id}: only ASCII (VHDL-93 refuses → even in a comment)`).toBe(false);
      const names: string[] = [];
      for (const m of text.matchAll(/^ {2}signal (\S+) :/gm)) names.push(m[1]);
      for (const m of text.matchAll(/^ {2}(\S+) : entity work\./gm)) names.push(m[1]);
      for (const m of text.matchAll(/^ {4}(\S+) : (?:in|out|inout) /gm)) names.push(m[1]);
      for (const n of names) expect(n, `${d.id}: ${n}`).toMatch(LEGAL);
      const lower = names.map((n) => n.toLowerCase());
      expect(new Set(lower).size, `${d.id}: a name used twice`).toBe(lower.length);
    }
  });

  it('maps every instance\'s ports by the names its entity declares', () => {
    for (const d of defs) {
      const { text } = vhdlHierarchy(d);
      const ports = declaredPorts(text);
      for (const m of text.matchAll(/: entity work\.(\w+) port map \((.*)\);/g)) {
        const want = ports.get(m[1].toLowerCase());
        expect(want, `${d.id}: entity ${m[1]} declared`).toBeTruthy();
        const formals = m[2].split(', ').map((a) => a.split(' => ')[0].toLowerCase());
        expect(formals.sort(), `${d.id}: ${m[1]}`).toEqual([...want!].sort());
      }
    }
  });
});

describe('a hierarchy file', () => {
  it('declares each entity once, before the first architecture that uses it', () => {
    for (const id of ['rca4', 'alu32', 'reg8', 'ram8x6', 'dff']) {
      const d = registry.get(id);
      expect(d, id).toBeTruthy();
      const { text, entities } = vhdlHierarchy(d!);
      const decl = [...text.matchAll(/^entity (\w+) is/gm)].map((m) => [m[1].toLowerCase(), m.index!] as const);
      expect(decl.length, id).toBe(entities);
      expect(new Set(decl.map(([n]) => n)).size, id).toBe(decl.length);
      const at = new Map(decl);
      for (const m of text.matchAll(/entity work\.(\w+)/g)) expect(at.get(m[1].toLowerCase())!, `${id}: ${m[1]}`).toBeLessThan(m.index!);
      expect(text.indexOf('entity nand2 is'), id).toBe(text.indexOf('entity '));
    }
  });

  it('names the parts below the gate level instead of instantiating them', () => {
    const v = structuralVhdl(registry.get('inv_cmos')!)!;
    expect(v).toMatch(/PMOS transistor/);
    expect(v).not.toMatch(/entity work\.(nmos|pmos)/);
  });
});

describe('what has no gates to export', () => {
  it('a behaviour leaf (a big RAM) is an entity with its ports and a comment architecture, declared before it is used', () => {
    const d = bigRam(8, 8);
    expect(d.preferBehavior && d.behavior).toBeTruthy();
    const { text } = vhdlHierarchy(d);
    const name = entityName(d);
    expect(text).toContain(`entity ${name} is\n  port (`);
    expect(text).toContain(`architecture behaviour of ${name} is\nbegin\n  -- `);
    const pn = vhdlPorts(d);
    expect([...declaredPorts(text).get(name.toLowerCase())!].sort()).toEqual(d.ports.map((p) => pn.get(p.name)!.toLowerCase()).sort());
    // placed in a design: declared before the architecture that uses it, port-mapped by the names it declares
    const top: ComponentDef = {
      id: 't_vhdl_wrap', name: 'wrap', category: 'memory', symbol: { kind: 'box' }, ports: d.ports,
      netlist: () => ({ instances: [{ name: 'm', def: d }], nets: d.ports.map((p) => ({ ends: [p.name, `m.${p.name}`] })) }),
    };
    const t = vhdlHierarchy(top).text;
    expect(t.indexOf(`entity ${name} is`)).toBeGreaterThanOrEqual(0);
    expect(t.indexOf(`entity ${name} is`)).toBeLessThan(t.indexOf(`entity work.${name} port map`));
    const map = t.match(new RegExp(`entity work\\.${name} port map \\((.*)\\);`))![1];
    expect(map.split(', ').map((a) => a.split(' => ')[0].toLowerCase()).sort()).toEqual([...declaredPorts(t).get(name.toLowerCase())!].sort());
  });
  it('a primitive below the gate level (ferrite cores) is a comment, never an undeclared entity', () => {
    const { text } = vhdlHierarchy(registry.get('core_plane4')!);
    const used = [...text.matchAll(/: entity work\.(\w+) /g)].map((m) => m[1].toLowerCase());
    const declared = declaredPorts(text);
    for (const e of used) expect(declared.has(e), `entity ${e} declared`).toBe(true);
    expect(text.match(/-- c\d\d: ferrite core on /g)?.length).toBe(16);
  });
  it('a bidirectional pin (the transmission gate) is an inout port, joined to its signal with a comment, port-mapped from a parent', () => {
    const g = registry.get('tgate')!;
    const inout = g.ports.filter((p) => p.dir === 'inout').map((p) => p.name);
    expect(inout.length).toBeGreaterThan(0);
    const { text } = vhdlHierarchy(g);
    const pn = vhdlPorts(g);
    for (const p of inout) {
      expect(text).toContain(`    ${pn.get(p)} : inout std_logic`);
      expect(text).toContain(`  -- ${pn.get(p)} is bidirectional: joined to `);
    }
    // its switches are comments, never entities
    expect(text).not.toMatch(/entity work\.(nmos|pmos)\b/);
    const name = entityName(g);
    const top: ComponentDef = {
      id: 't_vhdl_inout', name: 'inout wrap', category: 'switch', symbol: { kind: 'box' }, ports: g.ports,
      netlist: () => ({ instances: [{ name: 'tg', def: g }], nets: g.ports.map((p) => ({ ends: [p.name, `tg.${p.name}`] })) }),
    };
    const t = vhdlHierarchy(top).text;
    const map = t.match(new RegExp(`entity work\\.${name} port map \\((.*)\\);`))![1];
    expect(map.split(', ').map((a) => a.split(' => ')[0].toLowerCase()).sort()).toEqual([...declaredPorts(t).get(name.toLowerCase())!].sort());
    for (const p of inout) expect(t).toContain(`    ${vhdlPorts(top).get(p)} : inout std_logic`);
  });
});
