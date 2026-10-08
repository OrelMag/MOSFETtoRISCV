// Cross-check the Verilog export: Yosys synthesizes the exported dual-core to a gate netlist,
// an independent cycle-based simulator (below) runs that netlist, and the result is compared cycle
// by cycle with our own gate-level simulation of the same design.
// Needs Yosys (YOSYS env var, or yowasp-yosys from pip). Run: npx vite-node scripts/verify-export.ts [program | all] [cycles]
// Exits 1 on any difference, so CI can gate the deploy on it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dualCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle } from '../src/riscv/cosim';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { synthVerilog } from '../src/sim/vexport';

type Bit = number | '0' | '1' | 'x';
interface YCell { type: string; connections: Record<string, Bit[]> }

const arg = process.argv[2] ?? 'lock', cycles = Number(process.argv[3] ?? 300);
// pip's yowasp-yosys: on PATH on Linux (CI), under the user's Python scripts on Windows
const local = join(process.env.APPDATA ?? '', 'Python/Python313/Scripts/yowasp-yosys.exe');
const yosys = process.env.YOSYS ?? (existsSync(local) ? local : 'yowasp-yosys');
const ids = arg === 'all' ? MC_PROGRAMS.map((p) => p.id) : [arg];
const failed = ids.filter((id) => !verify(id));
if (failed.length) console.log(`differences on: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);

function verify(id: string): boolean {
  const words = assemble(MC_PROGRAMS.find((p) => p.id === id)!.source).words;
  const top = dualCore(words); // program ROMs inside, so the netlist is self-contained
  const dir = 'layout/verify';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dut.v'), synthVerilog(top, 'dut').verilog);
  execFileSync(yosys, ['-q', '-p', 'read_verilog dut.v; hierarchy -top dut; synth -flatten -top dut; write_json dut.json'], { cwd: dir, stdio: 'inherit' });

  const mod = JSON.parse(readFileSync(join(dir, 'dut.json'), 'utf8')).modules.dut as { ports: Record<string, { bits: Bit[] }>; cells: Record<string, YCell> };
  const val = new Map<number, number>();
  const get = (b: Bit) => (b === '1' ? 1 : b === '0' || b === 'x' ? 0 : val.get(b) ?? 0);
  const cells = Object.values(mod.cells);
  const seq = cells.filter((c) => c.type.startsWith('$_DFF'));
  const comb = cells.filter((c) => !c.type.startsWith('$_DFF') && c.type !== '$scopeinfo'); // $scopeinfo only records hierarchy
  const known = ['$_AND_', '$_NAND_', '$_OR_', '$_NOR_', '$_XOR_', '$_XNOR_', '$_ANDNOT_', '$_ORNOT_', '$_NOT_', '$_BUF_', '$_MUX_'];
  const odd = [...new Set(comb.map((c) => c.type))].filter((t) => !known.includes(t));
  if (odd.length) throw new Error(`unsupported cells: ${odd}`);
  // levelize: every combinational cell after the cells driving it
  const driver = new Map<number, YCell>();
  for (const c of comb) driver.set(c.connections.Y[0] as number, c);
  const order: YCell[] = [];
  const mark = new Map<YCell, number>();
  const visit = (c: YCell) => {
    const m = mark.get(c);
    if (m === 2) return;
    if (m === 1) throw new Error('combinational loop in the synthesized netlist');
    mark.set(c, 1);
    for (const [pin, bits] of Object.entries(c.connections)) if (pin !== 'Y') for (const b of bits) if (typeof b === 'number' && driver.has(b)) visit(driver.get(b)!);
    mark.set(c, 2);
    order.push(c);
  };
  comb.forEach(visit);
  const evalComb = () => {
    for (const c of order) {
      const A = get(c.connections.A?.[0] ?? '0'), B = get(c.connections.B?.[0] ?? '0');
      let y: number;
      switch (c.type) {
        case '$_AND_': y = A & B; break;
        case '$_NAND_': y = 1 - (A & B); break;
        case '$_OR_': y = A | B; break;
        case '$_NOR_': y = 1 - (A | B); break;
        case '$_XOR_': y = A ^ B; break;
        case '$_XNOR_': y = 1 - (A ^ B); break;
        case '$_ANDNOT_': y = A & (1 - B); break;
        case '$_ORNOT_': y = A | (1 - B); break;
        case '$_NOT_': y = 1 - A; break;
        case '$_BUF_': y = A; break;
        default: y = get(c.connections.S[0]) ? B : A; // $_MUX_
      }
      val.set(c.connections.Y[0] as number, y);
    }
  };
  const signals = ['pc0', 'pc1', 'retire0', 'retire1'];
  const portVal = (name: string) => mod.ports[name].bits.reduce((a: number, b, i) => a + get(b) * 2 ** i, 0);
  const theirs: Record<string, number>[] = [];
  for (let c = 0; c < cycles; c++) {
    evalComb();
    theirs.push(Object.fromEntries(signals.map((s) => [s, portVal(s)])));
    const next = seq.map((f) => {
      const en = f.connections.E ? get(f.connections.E[0]) : 1;
      const active = f.type.startsWith('$_DFFE_PN') ? en === 0 : en === 1;
      return active ? get(f.connections.D[0]) : get(f.connections.Q[0]);
    });
    seq.forEach((f, k) => val.set(f.connections.Q[0] as number, next[k]));
  }

  // our model, sampled at the same point (just before each rising edge)
  const sim = new GateSim(flatten(top));
  sim.setInput('clk', 0);
  sim.settle();
  const ours: Record<string, number>[] = [];
  for (let c = 0; c < cycles; c++) {
    ours.push(Object.fromEntries(signals.map((s) => [s, pack(sim.getBits(sim.design.root.ports[s]))])));
    clockCycle(sim);
  }
  let diffs = 0;
  const show = (r: Record<string, number>) => `pc0=${r.pc0.toString(16)} pc1=${r.pc1.toString(16)} retire=${r.retire0}${r.retire1}`;
  for (let c = 0; c < cycles; c++) {
    if (signals.some((s) => theirs[c][s] !== ours[c][s]) && diffs++ < 5) console.log(`cycle ${c}: Yosys ${show(theirs[c])} · ours ${show(ours[c])}`);
  }
  console.log(`${id}: ${cycles} cycles, ${seq.length} flip-flops, ${comb.length} gates after Yosys synthesis; ${diffs} differences from our model`);
  return diffs === 0;
}
