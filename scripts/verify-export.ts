// Cross-check the Verilog export: Yosys synthesizes an exported CPU to a gate netlist, an independent
// cycle-based simulator (below) runs that netlist, and every output port is compared cycle by cycle
// with our own gate-level simulation of the same design under the same inputs.
// Designs: the dual-core on every multi-core program, the system CPU (RV32I + Zicsr, MMIO, traps,
// interrupts) and the RV32IM system CPU on their programs, with irq pulses and switch changes driven
// on both sides.
// Needs Yosys (YOSYS env var, or yowasp-yosys from pip).
// Run: npx vite-node scripts/verify-export.ts [all | <design> | <design>:<program> | <program>] [cycles]
// (designs: multi, sys, sys-m). Exits 1 on any difference, so CI can gate the deploy on it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dualCore, systemCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle } from '../src/riscv/cosim';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { synthVerilog } from '../src/sim/vexport';

type Bit = number | '0' | '1' | 'x';
interface YCell { type: string; connections: Record<string, Bit[]> }
interface YPort { direction: 'input' | 'output' | 'inout'; bits: Bit[] }
type Values = Record<string, number>;
interface Check { design: string; id: string; top: () => ComponentDef; cycles: number; inputs: (c: number) => Values }

const words = (list: { id: string; source: string }[], id: string) => assemble(list.find((p) => p.id === id)!.source).words;
// the switches change every 50 cycles, so a program reading them sees new values
const switches = (c: number) => [0x5a, 0xa5, 0x3c][Math.floor(c / 50) % 3];
const sysInputs = (irqAt: number[]) => (c: number): Values => ({ irq: irqAt.includes(c) ? 1 : 0, switches: switches(c) });
// run lengths and irq pulses as in tests/system.test.ts
const sysCycles = (id: string) => (id === 'timer' ? 260 : id === 'irq' ? 120 : 140);
const sysIrq = (id: string) => (id === 'irq' ? [60, 90] : []);

const CHECKS: Check[] = [
  ...MC_PROGRAMS.map((p): Check => ({ design: 'multi', id: p.id, top: () => dualCore(words(MC_PROGRAMS, p.id)), cycles: 300, inputs: () => ({}) })),
  ...SYSTEM_PROGRAMS.map((p): Check => ({
    design: 'sys', id: p.id, top: () => systemCpu(words(SYSTEM_PROGRAMS, p.id)), cycles: sysCycles(p.id), inputs: sysInputs(sysIrq(p.id)),
  })),
  { design: 'sys', id: 'gcd', top: () => systemCpu(words(PROGRAMS, 'gcd')), cycles: 120, inputs: sysInputs([]) },
  ...M_PROGRAMS.map((p): Check => ({
    design: 'sys-m', id: p.id, top: () => systemCpu(words(M_PROGRAMS, p.id), { m: true }), cycles: p.id === 'mcorner' ? 600 : 700, inputs: sysInputs([]),
  })),
  // interrupts on the M CPU too: its retire output and the divider's stall are in the comparison
  ...['timer', 'irq'].map((id): Check => ({
    design: 'sys-m', id, top: () => systemCpu(words(SYSTEM_PROGRAMS, id), { m: true }), cycles: sysCycles(id), inputs: sysInputs(sysIrq(id)),
  })),
];

const arg = process.argv[2] ?? 'multi:lock', cyclesArg = process.argv[3] ? Number(process.argv[3]) : undefined;
const chosen = CHECKS.filter((k) => arg === 'all' || arg === k.design || arg === `${k.design}:${k.id}` || arg === k.id);
if (!chosen.length) {
  console.log(`nothing matches ${arg}; checks: ${CHECKS.map((k) => `${k.design}:${k.id}`).join(' ')}`);
  process.exit(1);
}
// pip's yowasp-yosys: on PATH on Linux (CI), under the user's Python scripts on Windows
const local = join(process.env.APPDATA ?? '', 'Python/Python313/Scripts/yowasp-yosys.exe');
const yosys = process.env.YOSYS ?? (existsSync(local) ? local : 'yowasp-yosys');
const failed = chosen.filter((k) => !verify(k)).map((k) => `${k.design}:${k.id}`);
if (failed.length) console.log(`differences on: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);

function verify(check: Check): boolean {
  const top = check.top(); // program ROMs inside, so the netlist is self-contained
  const cycles = cyclesArg ?? check.cycles;
  const dir = 'layout/verify';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dut.v'), synthVerilog(top, 'dut').verilog);
  execFileSync(yosys, ['-q', '-p', 'read_verilog dut.v; hierarchy -top dut; synth -flatten -top dut; write_json dut.json'], { cwd: dir, stdio: 'inherit' });

  const mod = JSON.parse(readFileSync(join(dir, 'dut.json'), 'utf8')).modules.dut as { ports: Record<string, YPort>; cells: Record<string, YCell> };
  const val = new Map<number, number>();
  const get = (b: Bit) => (b === '1' ? 1 : b === '0' || b === 'x' ? 0 : val.get(b) ?? 0);
  const cells = Object.values(mod.cells);
  // rising-edge flip-flops, with or without an enable of either polarity: anything else (a falling edge,
  // a set / reset) would be simulated wrongly below, so it is refused
  const seq = cells.filter((c) => c.type.startsWith('$_DFF'));
  const oddFf = [...new Set(seq.map((c) => c.type))].filter((t) => !['$_DFF_P_', '$_DFFE_PP_', '$_DFFE_PN_'].includes(t));
  if (oddFf.length) throw new Error(`unsupported flip-flops: ${oddFf}`);
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
  // every output port is compared; every input but the clock is driven from the check's stimulus
  const outputs = top.ports.filter((p) => p.dir === 'out').map((p) => p.name);
  const inputs = top.ports.filter((p) => p.dir === 'in' && p.name !== 'clk').map((p) => p.name);
  for (const name of [...outputs, ...inputs]) if (!mod.ports[name]) throw new Error(`port ${name} missing from the synthesized netlist`);
  const stimulus = (c: number) => {
    const v = check.inputs(c);
    for (const name of inputs) if (!(name in v)) throw new Error(`${check.design}: no stimulus for input ${name}`);
    return v;
  };
  const portVal = (name: string) => mod.ports[name].bits.reduce((a: number, b, i) => a + get(b) * 2 ** i, 0);
  const theirs: Values[] = [];
  for (let c = 0; c < cycles; c++) {
    const v = stimulus(c);
    for (const name of inputs) mod.ports[name].bits.forEach((b, i) => { if (typeof b === 'number') val.set(b, Math.floor(v[name] / 2 ** i) % 2); });
    evalComb();
    theirs.push(Object.fromEntries(outputs.map((s) => [s, portVal(s)])));
    const next = seq.map((f) => {
      const en = f.connections.E ? get(f.connections.E[0]) : 1;
      const active = f.type.startsWith('$_DFFE_PN') ? en === 0 : en === 1;
      return active ? get(f.connections.D[0]) : get(f.connections.Q[0]);
    });
    seq.forEach((f, k) => val.set(f.connections.Q[0] as number, next[k]));
  }

  // our model under the same inputs, sampled at the same point (just before each rising edge)
  const sim = new GateSim(flatten(top));
  sim.setInput('clk', 0);
  sim.settle();
  const ours: Values[] = [];
  for (let c = 0; c < cycles; c++) {
    const v = stimulus(c);
    for (const name of inputs) sim.setInput(name, v[name]);
    sim.settle();
    ours.push(Object.fromEntries(outputs.map((s) => [s, pack(sim.getBits(sim.design.root.ports[s]))])));
    clockCycle(sim);
  }
  let diffs = 0;
  const show = (r: Values) => outputs.map((s) => `${s}=${r[s].toString(16)}`).join(' ');
  for (let c = 0; c < cycles; c++) {
    if (outputs.some((s) => theirs[c][s] !== ours[c][s]) && diffs++ < 5) console.log(`cycle ${c}:\n  Yosys ${show(theirs[c])}\n  ours  ${show(ours[c])}`);
  }
  console.log(`${check.design}:${check.id}: ${cycles} cycles, ${seq.length} flip-flops, ${comb.length} gates after Yosys synthesis; ${diffs} differences from our model`);
  return diffs === 0;
}
