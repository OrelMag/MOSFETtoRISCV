// The HDL tab's links (sim/verilog.ts verilogLines, sim/vhdl.ts vhdlLines, view/hdllines.ts): over the whole registry, every
// line has one owner or none, the text is the plain generators' text, and each placed module is on exactly one line of its own.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { rca } from '../src/lib/combinational';
import { isExternal, netlistOf } from '../src/sim/types';
import { structuralVerilog, verilogLines } from '../src/sim/verilog';
import { structuralVhdl, vhdlLines } from '../src/sim/vhdl';
import { firstLineOf, instanceAt, linesByInstance } from '../src/view/hdllines';

const defs = [...registry.values()].filter((d) => netlistOf(d) && d.prim !== 'alias' && d.prim !== 'nand');

describe('linked HDL source', () => {
  for (const [lang, gen, plain] of [['Verilog', verilogLines, structuralVerilog], ['VHDL', vhdlLines, structuralVhdl]] as const) {
    it(`${lang}: one owner per line, the plain text, every placed module on exactly one line`, () => {
      for (const d of defs) {
        const src = gen(d)!;
        expect(src.text, d.id).toBe(plain(d));
        const lines = src.text.split('\n');
        expect(src.owners.length, d.id).toBe(lines.length);
        const nl = netlistOf(d)!;
        const names = new Set(nl.instances.map((i) => i.name));
        for (const o of src.owners) if (o !== null) expect(names.has(o), `${d.id}: ${o}`).toBe(true);
        const by = linesByInstance(src);
        for (const inst of nl.instances) {
          const c = inst.def;
          // a module or entity placed by name (not a primitive written as an assign, a switch or a comment)
          if (c.prim || isExternal(c)) continue;
          const own = by.get(inst.name) ?? [];
          expect(own.length, `${d.id}: ${inst.name}`).toBe(1);
          if (lang === 'VHDL') expect(lines[own[0]], `${d.id}: ${inst.name}`).toContain(': entity work.');
          expect(firstLineOf(src, inst.name)).toBe(own[0]);
          expect(instanceAt(src, own[0])).toBe(inst.name);
        }
        // no instantiation is left without its owner
        if (lang === 'VHDL') lines.forEach((l, i) => { if (l.includes(': entity work.')) expect(src.owners[i], `${d.id} line ${i}`).not.toBeNull(); });
      }
    });
  }

  it('the 4-bit ripple adder: a click on fa1\'s line lights fa1, and fa1 scrolls to it', () => {
    const d = rca(4);
    const v = verilogLines(d)!;
    const at = firstLineOf(v, 'fa1')!;
    expect(v.text.split('\n')[at]).toMatch(/\bfa1\b/);
    expect(instanceAt(v, at)).toBe('fa1');
    expect(instanceAt(v, 0)).toBeNull();
  });
});
