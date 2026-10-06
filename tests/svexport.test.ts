import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { alu } from '../src/lib/alu';
import { decoder, muxTree, rca } from '../src/lib/combinational';
import { koggeStone } from '../src/lib/fastadd';
import { counter, DFF } from '../src/lib/sequential';
import { singleCycleCpu } from '../src/lib/cpu';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { exportHdl, testableComb } from '../src/sim/svexport';
import { inPorts, outPorts, type ComponentDef } from '../src/sim/types';

describe('HDL export', () => {
  it('writes every module once, children first, with a testbench for combinational parts', () => {
    const f = exportHdl(rca(4), 'structure', true);
    expect(f.filename).toBe('rca4.sv');
    const mods = [...f.text.matchAll(/^module (\w+)/gm)].map((m) => m[1]);
    expect(new Set(mods).size).toBe(mods.length);
    expect(mods[mods.length - 1]).toBe('rca4_tb');
    expect(mods.indexOf('nand2')).toBeLessThan(mods.indexOf('rca4'));
    expect(f.vectors).toBe(512);
    expect(f.text).toContain('PASS: 512 vectors');
  });

  it('offers testbenches only for loop-free logic', () => {
    expect(testableComb(rca(4))).toBe(true);
    expect(testableComb(DFF)).toBe(false);
    expect(testableComb(counter(4))).toBe(false);
  });

  it('exports a whole CPU (structure and synthesizable)', () => {
    const cpu = singleCycleCpu([0x00000013]);
    expect(exportHdl(cpu, 'structure').modules).toBeGreaterThan(30);
    expect(exportHdl(cpu, 'synth').text).toMatch(/always @\(posedge clk\)/);
  });
});

// Independent check with Yosys (skipped where it is not installed, e.g. CI): synthesize the
// exported structure to Yosys's own gate cells, evaluate that netlist here, and compare it with our
// simulation on every input combination.
const yosys = process.env.YOSYS ?? join(process.env.APPDATA ?? '', 'Python/Python313/Scripts/yowasp-yosys.exe');
const haveYosys = existsSync(yosys);

type YBit = number | '0' | '1' | 'x';
interface YCell { type: string; connections: Record<string, YBit[]> }

function yosysEval(def: ComponentDef): (ins: number[]) => number[] {
  const dir = mkdtempSync(join(tmpdir(), 'svx-'));
  const f = exportHdl(def, 'structure');
  writeFileSync(join(dir, f.filename), f.text);
  execFileSync(yosys, ['-q', '-p', `read_verilog -sv ${f.filename}; synth -flatten -top ${f.top}; write_json out.json`], { cwd: dir });
  const mod = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).modules[f.top] as { ports: Record<string, { bits: YBit[] }>; cells: Record<string, YCell> };
  const cells = Object.values(mod.cells).filter((c) => c.type !== '$scopeinfo');
  const ops: Record<string, (a: number, b: number, s?: number) => number> = {
    $_AND_: (a, b) => a & b, $_NAND_: (a, b) => 1 - (a & b), $_OR_: (a, b) => a | b, $_NOR_: (a, b) => 1 - (a | b),
    $_XOR_: (a, b) => a ^ b, $_XNOR_: (a, b) => 1 - (a ^ b), $_ANDNOT_: (a, b) => a & (1 - b), $_ORNOT_: (a, b) => a | (1 - b),
    $_NOT_: (a) => 1 - a, $_BUF_: (a) => a, $_MUX_: (a, b, s) => (s ? b : a),
  };
  for (const c of cells) if (!ops[c.type]) throw new Error(`unexpected cell ${c.type}`);
  return (ins) => {
    const val = new Map<number, number>();
    const get = (b: YBit) => (b === '1' ? 1 : b === '0' || b === 'x' ? 0 : val.get(b) ?? -1);
    inPorts(def).forEach((p, i) => mod.ports[p.name].bits.forEach((b, k) => val.set(b as number, Math.floor(ins[i] / 2 ** k) % 2)));
    // Relax until every cell output is known (cells are not in topological order).
    for (let pending = cells.length, guard = 0; pending > 0 && guard < 10000; guard++) {
      pending = 0;
      for (const c of cells) {
        const y = c.connections.Y[0] as number;
        if (val.has(y)) continue;
        const a = get(c.connections.A[0]), b = c.connections.B ? get(c.connections.B[0]) : 0, s = c.connections.S ? get(c.connections.S[0]) : 0;
        if (a < 0 || b < 0 || s < 0) { pending++; continue; }
        val.set(y, ops[c.type](a, b, s));
      }
    }
    return outPorts(def).map((p) => mod.ports[p.name].bits.reduce<number>((acc, b, k) => acc + get(b) * 2 ** k, 0));
  };
}

describe.skipIf(!haveYosys)('HDL export through Yosys', () => {
  for (const def of [rca(4), decoder(3, true), muxTree(2, 2), koggeStone(4), alu(4)]) {
    it(`${def.id}: Yosys netlist ≡ our simulation on every input`, () => {
      const ref = simulate(def);
      const ys = yosysEval(def);
      forEachInput(def, (ins) => expect(ys(ins), `${def.id}(${ins})`).toEqual(evalOnce(ref, ins)));
    });
  }
});

describe.skipIf(!haveYosys)('HDL export parses in Yosys', () => {
  const check = (def: ComponentDef, flavor: 'structure' | 'synth') => {
    const dir = mkdtempSync(join(tmpdir(), 'svx-'));
    const f = exportHdl(def, flavor);
    writeFileSync(join(dir, f.filename), f.text);
    execFileSync(yosys, ['-q', '-p', `read_verilog -sv ${f.filename}; hierarchy -check -top ${f.top}`], { cwd: dir });
  };
  it('a counter (NAND loops) and a whole CPU, both flavours', () => {
    check(counter(4), 'structure');
    const cpu = singleCycleCpu([0x00000013]);
    check(cpu, 'structure');
    check(cpu, 'synth');
  }, 120000);
});
