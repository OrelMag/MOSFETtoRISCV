// Download-ready HDL for any component: every module of its hierarchy in one file, plus an
// optional self-checking testbench whose vectors come from our own simulator.
//
// Two flavours:
//  - 'structure': exactly the schematics. Each module is its structural netlist; NAND and the
//    tie cells are one-line assigns (their transistor netlists are below gate level). Latches and
//    flip-flops stay cross-coupled NAND loops, as drawn. Switch-level designs (the transistor
//    chapters) keep nmos/pmos primitives, resistors are rtran, capacitive nets trireg. Good for
//    reading and for event simulators (Icarus).
//  - 'synth': vexport's synthesizable Verilog-2005 (flip-flops as clocked processes), for Yosys,
//    Verilator and FPGA tools.

import { evalOnce, forEachInput, inputBits, simulate } from './harness';
import { type ComponentDef, inPorts, isSwitchPrim, netlistOf, outPorts } from './types';
import { moduleName, structuralVerilog } from './verilog';
import { logicDepth, stats } from './stats';
import { ident, synthVerilog } from './vexport';

export type HdlFlavor = 'structure' | 'synth';

export interface HdlFile {
  filename: string;
  text: string;
  top: string;
  modules: number;
  /** Vectors in the testbench (0 = none). */
  vectors: number;
}

const LEAF: Record<string, string> = {
  nand: 'module nand2 (\n  input  logic a,\n  input  logic b,\n  output logic y\n);\n  assign y = ~(a & b);\nendmodule',
  tie0: 'module tie0 (\n  output logic y\n);\n  assign y = 1\'b0;\nendmodule',
  tie1: 'module tie1 (\n  output logic y\n);\n  assign y = 1\'b1;\nendmodule',
};

/** Every module below (and including) root, children before parents. */
function structureModules(root: ComponentDef): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (d: ComponentDef, isRoot: boolean) => {
    const name = moduleName(d);
    if (seen.has(name)) return;
    seen.add(name);
    if (!isRoot && LEAF[d.id]) {
      out.push(LEAF[d.id]);
      return;
    }
    const nl = netlistOf(d);
    if (!nl) throw new Error(`${d.name} has no structure to export`);
    for (const i of nl.instances) {
      if (i.def.prim === 'alias' || isSwitchPrim(i.def)) continue; // written inline (verilog.ts)
      visit(i.def, false);
    }
    out.push(structuralVerilog(d)!);
  };
  visit(root, true);
  return out;
}

/** Can this component get a combinational testbench (a pure function of its inputs)? */
export function testableComb(def: ComponentDef): boolean {
  if (!netlistOf(def) || def.ports.some((p) => p.dir === 'inout' || p.width > 32 || p.clock)) return false;
  try {
    logicDepth(def); // throws on feedback: latches, flip-flops, memories
    return stats(def).nands > 0;
  } catch {
    return false;
  }
}

/** Input vectors: every combination up to 12 input bits, else n pseudo-random ones. */
function vectors(def: ComponentDef, n = 256): number[][] {
  const out: number[][] = [];
  if (inputBits(def) <= 12) {
    forEachInput(def, (ins) => out.push([...ins]));
    return out;
  }
  let seed = 0x2545f491;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
  const ins = inPorts(def);
  // Corners first (all zeros, all ones), then random words.
  out.push(ins.map(() => 0), ins.map((p) => 2 ** p.width - 1));
  while (out.length < n) out.push(ins.map((p) => (p.width >= 32 ? rnd() : rnd() % 2 ** p.width)));
  return out;
}

const lit = (w: number, v: number) => `${w}'h${v.toString(16)}`;

function testbench(def: ComponentDef, top: string): { text: string; count: number } {
  const ins = inPorts(def), outs = outPorts(def);
  const sim = simulate(def);
  const vecs = vectors(def);
  const name = (p: string) => ident(p, 'p');
  const range = (w: number) => (w > 1 ? ` [${w - 1}:0]` : '');
  const lines: string[] = [];
  lines.push(`// Self-checking testbench: ${vecs.length} vectors, expected values computed by the site's own`);
  lines.push(`// gate-level simulation of ${def.name}. Plain Verilog-2005: iverilog <file> && vvp a.out`);
  lines.push(`module ${top}_tb;`);
  for (const p of ins) lines.push(`  reg${range(p.width)} ${name(p.name)};`);
  for (const p of outs) lines.push(`  wire${range(p.width)} ${name(p.name)};`);
  lines.push(`  integer errors = 0;`);
  lines.push(`  ${top} dut (${[...ins, ...outs].map((p) => `.${name(p.name)}(${name(p.name)})`).join(', ')});`);
  lines.push('');
  lines.push('  initial begin');
  for (const v of vecs) {
    const exp = evalOnce(sim, v);
    const set = ins.map((p, i) => `${name(p.name)} = ${lit(p.width, v[i])};`).join(' ');
    const chk = outs.map((p, i) => `${name(p.name)} !== ${lit(p.width, exp[i])}`).join(' || ');
    const msg = outs.map((p) => `${p.name}=%h`).join(' ');
    lines.push(`    ${set} #10;`);
    lines.push(`    if (${chk}) begin errors = errors + 1; $display("mismatch at ${ins.map((p, i) => `${p.name}=${v[i].toString(16)}`).join(' ')}: ${msg}", ${outs.map((p) => name(p.name)).join(', ')}); end`);
  }
  lines.push(`    if (errors == 0) $display("PASS: ${vecs.length} vectors");`);
  lines.push(`    else $display("FAIL: %0d of ${vecs.length} vectors", errors);`);
  lines.push('    $finish;');
  lines.push('  end');
  lines.push('endmodule');
  return { text: lines.join('\n'), count: vecs.length };
}

export function exportHdl(def: ComponentDef, flavor: HdlFlavor, withTb = false): HdlFile {
  const top = moduleName(def);
  let body: string;
  let modules: number;
  if (flavor === 'synth') {
    const r = synthVerilog(def, top);
    body = r.verilog;
    modules = r.modules;
  } else {
    const mods = structureModules(def);
    body = [`// ${def.name}: every module of its hierarchy, exactly as drawn on the site.`, `// Top module: ${top}. NAND = nand2.`, '', mods.join('\n\n')].join('\n');
    modules = mods.length;
  }
  let vectorsCount = 0;
  if (withTb && testableComb(def)) {
    const tb = testbench(def, top);
    body += '\n\n' + tb.text;
    vectorsCount = tb.count;
  }
  return { filename: `${top}.${flavor === 'synth' ? 'v' : 'sv'}`, text: body + '\n', top, modules, vectors: vectorsCount };
}
