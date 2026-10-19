import { describe, expect, it } from 'vitest';
import '../src/lib';
import { GateSim } from '../src/sim/gatesim';
import { flatten } from '../src/sim/flatten';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import type { GateSet } from '../src/hdl/yosys';
import { parseYosysLog, synthesize } from '../src/hdl/yosys';
import { importYosysJson, parseFf } from '../src/hdl/yosysjson';
import { compiledTop, importVerilog } from './hdlkit';
import { alu } from '../src/lib/alu';
import { rca } from '../src/lib/combinational';
import { koggeStone } from '../src/lib/fastadd';
import { counter, register } from '../src/lib/sequential';
import { shiftRegister } from '../src/lib/seqparts';
import { inPorts, netlistOf, outPorts, type ComponentDef } from '../src/sim/types';
import { routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { singleCycleCpu } from '../src/lib/cpu';
import { synthVerilog } from '../src/sim/vexport';
import { exportHdl } from '../src/sim/svexport';
import { assemble } from '../src/riscv/asm';

const ADD4 = `module add4(input [3:0] a, b, input ci, output [3:0] s, output co);
  assign {co, s} = a + b + ci;
endmodule`;

const TOP = `${ADD4}
module cnt(input clk, rst, en, output reg [2:0] q);
  always @(posedge clk or posedge rst) if (rst) q <= 0; else if (en) q <= q + 1;
endmodule
module top(input clk, input [3:0] a, b, output [3:0] s, output co, output [2:0] q, output m);
  add4 u(.a(a), .b(b), .ci(1'b0), .s(s), .co(co));
  cnt c(.clk(clk), .rst(a[0]), .en(b[0]), .q(q));
  assign m = a[1] ? b[2] : b[3];
endmodule`;

describe('Verilog → sandbox chips', () => {
  for (const gates of ['std', 'nand', 'aoi'] as GateSet[]) {
    it(`a 4-bit adder (${gates}) adds every pair`, async () => {
      const imp = await importVerilog(ADD4, { gates });
      expect(imp.chips.map((c) => c.name)).toEqual(['add4']);
      const { def } = compiledTop(imp);
      expect(def.ports.map((p) => `${p.name}:${p.width}`)).toEqual(['a:4', 'b:4', 'ci:1', 's:4', 'co:1']);
      const sim = simulate(def);
      forEachInput(def, ([a, b, ci]) => {
        const sum = a + b + ci;
        expect(evalOnce(sim, [a, b, ci])).toEqual([sum & 15, sum >> 4]);
      });
      const kinds = new Set(imp.chips[0].parts.map((p) => ('lib' in p.ref ? p.ref.lib : Object.keys(p.ref)[0])));
      if (gates === 'nand') for (const k of kinds) expect(['nand', 'not', 'split', 'merge', 'tie0', 'tie1']).toContain(k);
    }, 60_000);
  }

  it('keeps the hierarchy: modules as chips, instances as placed chips', async () => {
    const imp = await importVerilog(TOP);
    expect(imp.chips.map((c) => c.name).sort()).toEqual(['add4', 'cnt', 'top']);
    const top = imp.chips[2];
    expect(top.name).toBe('top'); // placed chips come first
    expect(imp.top).toBe(top.id);
    const placed = top.parts.filter((p) => 'chip' in p.ref).map((p) => p.id).sort();
    expect(placed).toEqual(['c', 'u']);
    expect(top.pins.find((p) => p.name === 'clk')!.kind).toBe('clock');
  }, 60_000);

  it('a counter with async reset and enable counts like the Verilog', async () => {
    const imp = await importVerilog(TOP);
    const { def } = compiledTop(imp);
    const sim = new GateSim(flatten(def));
    sim.reset('zero');
    const set = (a: number, b: number) => { sim.setInput('a', a); sim.setInput('b', b); };
    const q = () => sim.getBits(sim.design.root.ports.q).reduce<number>((v, bit, i) => v + (bit === 1 ? 2 ** i : 0), 0);
    let model = 0;
    sim.setInput('clk', 0);
    set(1, 0); sim.settle(); model = 0; // async reset
    expect(q()).toBe(0);
    let seed = 7;
    for (let i = 0; i < 60; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const rst = i % 17 === 5 ? 1 : 0, en = (seed >> 8) & 1;
      set(rst, en);
      sim.settle();
      if (rst) model = 0;
      sim.setInput('clk', 1); sim.settle();
      if (!rst && en) model = (model + 1) & 7;
      expect(q()).toBe(model);
      sim.setInput('clk', 0); sim.settle();
    }
  }, 60_000);

  it('turns Yosys messages into line diagnostics', async () => {
    const r = await synthesize({ 'top.v': 'module top(input a, output y);\n  assign y = a\nendmodule\n' });
    expect(r.json).toBeUndefined();
    expect(r.diags[0]).toMatchObject({ level: 'error', file: 'top.v', line: 3 });
    expect(r.diags[0].msg).toContain('endmodule');
    expect(parseYosysLog("top.v:2: Warning: Identifier `\\b' is implicitly declared.")).toEqual([
      { level: 'warn', msg: "Identifier `b' is implicitly declared.", file: 'top.v', line: 2 },
    ]);
  }, 60_000);

  it('refuses what has no part, plainly', () => {
    const word = { modules: { m: { ports: { a: { direction: 'input', bits: [2, 3] }, y: { direction: 'output', bits: [4, 5] } },
      cells: { x: { type: '$add', connections: { A: [2, 3], B: [2, 3], Y: [4, 5] } } } } } };
    expect(importYosysJson(word)).toEqual({ error: expect.stringContaining('word-level cell') });
    const lut = { modules: { m: { ports: { a: { direction: 'input', bits: [2] } }, cells: { x: { type: 'LUT6', connections: {} } } } } };
    expect(importYosysJson(lut)).toEqual({ error: expect.stringContaining('LUT6') });
    expect(importYosysJson({ format: 'mosfet2riscv-sandbox' })).toEqual({ error: expect.any(String) });
  });
});

// Every storage cell the importer builds, against Yosys's definition of it (simcells.v), on random stimulus.
describe('Yosys storage cells as library parts', () => {
  const FFS: string[] = [];
  for (const c of 'PN') FFS.push(`$_DFF_${c}_`);
  for (const c of 'PN') for (const e of 'PN') FFS.push(`$_DFFE_${c}${e}_`);
  for (const c of 'PN') for (const r of 'PN') for (const v of '01') {
    FFS.push(`$_DFF_${c}${r}${v}_`, `$_SDFF_${c}${r}${v}_`, `$_DLATCH_${c}${r}${v}_`);
    for (const e of 'PN') FFS.push(`$_DFFE_${c}${r}${v}${e}_`, `$_SDFFE_${c}${r}${v}${e}_`, `$_SDFFCE_${c}${r}${v}${e}_`);
  }
  for (const c of 'PN') FFS.push(`$_DLATCH_${c}_`);

  for (const t of FFS) {
    it(t, () => {
      const f = parseFf(t);
      if (!f || 'refuse' in f) throw new Error(`not parsed: ${t}`);
      const ports: Record<string, { direction: 'input' | 'output'; bits: number[] }> = {
        C: { direction: 'input', bits: [2] }, D: { direction: 'input', bits: [3] }, Q: { direction: 'output', bits: [6] },
      };
      const con: Record<string, number[]> = { D: [3], Q: [6], [f.latch ? 'E' : 'C']: [2] };
      if (f.en) { ports.E = { direction: 'input', bits: [4] }; con.E = [4]; }
      if (f.arst || f.srst) { ports.R = { direction: 'input', bits: [5] }; con.R = [5]; }
      const imp = importYosysJson({ modules: { m: { ports, cells: { ff: { type: t, connections: con } } } } });
      if ('error' in imp) throw new Error(imp.error);
      const { def } = compiledTop(imp);
      const sim = new GateSim(flatten(def));
      sim.reset('zero');
      const pol = (neg: boolean | undefined, v: number) => (neg ? 1 - v : v);
      const inp = { C: f.clkNeg ? 1 : 0, D: 0, E: 0, R: pol(f.arst?.neg ?? f.srst?.neg, 0) };
      const apply = () => { for (const [k, v] of Object.entries(inp)) if (ports[k]) sim.setInput(k, v); sim.settle(); };
      apply();
      // Model state starts at what the circuit powered on to (its own power-on value, inverted for a set flop).
      let q = sim.getBits(sim.design.root.ports.Q)[0] as number;
      expect(q === 0 || q === 1).toBe(true);
      let seed = t.length * 977;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >> 16) & 1;
      for (let i = 0; i < 80; i++) {
        const clkWas = pol(f.clkNeg, inp.C);
        // change data / enable / reset with the clock steady, then toggle the clock
        inp.D = rnd(); inp.E = rnd(); inp.R = pol(f.arst?.neg ?? f.srst?.neg, i % 7 === 3 ? 1 : (rnd() & rnd()));
        apply();
        const en = !f.en || pol(f.en.neg, inp.E) === 1;
        const r = pol(f.arst?.neg ?? f.srst?.neg, inp.R) === 1;
        if (f.latch) {
          if (f.arst && r) q = f.arst.val;
          else if (clkWas) q = inp.D;
        } else if (f.arst && r) q = f.arst.val;
        expect(sim.getBits(sim.design.root.ports.Q)[0], `${t} step ${i} (data)`).toBe(q);
        inp.C = 1 - inp.C;
        apply();
        const rising = pol(f.clkNeg, inp.C) === 1;
        if (f.latch) {
          if (f.arst && r) q = f.arst.val;
          else if (rising) q = inp.D;
        } else if (f.arst && r) q = f.arst.val;
        else if (rising) {
          if (f.srst && r && (!f.srst.ce || en)) q = f.srst.val;
          else if (en) q = inp.D;
        }
        expect(sim.getBits(sim.design.root.ports.Q)[0], `${t} step ${i} (clock)`).toBe(q);
      }
    });
  }
});

const FIB_LOOP = ['li a0, 0', 'li a1, 1', 'loop: add a2, a0, a1', 'mv a0, a1', 'mv a1, a2', 'sw a0, 0(zero)', 'j loop'].join('\n');

// The roadmap's round trip: Verilog we export, through Yosys and back, must simulate equal to the original, every
// output every cycle (combinational parts: every input, or random ones past ~9 bits). Both exporters: the synthesizable
// one (vexport.ts, flip-flops as processes) and the structural one the sandbox's File ▸ Export Verilog writes
// (svexport.ts 'structure': the hierarchy down to NAND cells).
function sameOutputs(name: string, orig: ComponentDef, def: ComponentDef, cycles: number): void {
  const ins = inPorts(orig), outs = outPorts(orig);
  expect(def.ports.map((p) => `${p.dir}:${p.name}:${p.width}`).sort()).toEqual(orig.ports.map((p) => `${p.dir}:${p.name}:${p.width}`).sort());
  const a = new GateSim(flatten(orig)), b = new GateSim(flatten(def));
  a.reset('zero'); b.reset('zero');
  const read = (s: GateSim) => outs.map((p) => s.getBits(s.design.root.ports[p.name]).join(''));
  let seed = 12345;
  const rnd = (w: number) => { let v = 0; for (let i = 0; i < w; i++) { seed = (seed * 1103515245 + 12345) >>> 0; v = v * 2 + ((seed >> 16) & 1); } return v; };
  const clock = ins.find((p) => p.clock);
  const steps = cycles || Math.min(2 ** ins.reduce((n, p) => n + p.width, 0), 600);
  for (let i = 0; i < steps; i++) {
    for (const p of ins) if (p !== clock) { const v = rnd(p.width); a.setInput(p.name, v); b.setInput(p.name, v); }
    if (clock) { a.setInput(clock.name, 0); b.setInput(clock.name, 0); }
    a.settle(); b.settle();
    expect(read(b), `${name} step ${i}`).toEqual(read(a));
    if (clock) {
      a.setInput(clock.name, 1); b.setInput(clock.name, 1);
      a.settle(); b.settle();
      expect(read(b), `${name} step ${i} after the edge`).toEqual(read(a));
    }
  }
}

const EXPORTERS: [string, (d: ComponentDef) => { text: string; top: string }][] = [
  ['synthesizable', (d) => ({ text: synthVerilog(d, 'dut').verilog, top: 'dut' })],
  ['structural (File ▸ Export Verilog)', (d) => { const f = exportHdl(d, 'structure'); return { text: f.text, top: f.top }; }],
];

describe('export → Yosys → import round trip', () => {
  const CASES: [string, () => ComponentDef, number][] = [
    ['rca(6)', () => rca(6), 0],
    ['alu(4)', () => alu(4), 0],
    ['koggeStone(8)', () => koggeStone(8), 0],
    ['counter(4)', () => counter(4), 40],
    ['register(4)', () => register(4), 40],
    ['shiftRegister(4)', () => shiftRegister(4), 60],
    // a program that loops forever: fib into a0, store, jump back
    ['the single-cycle RV32I CPU', () => singleCycleCpu(assemble(FIB_LOOP).words), 200],
  ];
  for (const [how, exp] of EXPORTERS) {
    describe(how, () => {
      for (const [name, make, cycles] of CASES) {
        it(name, async () => {
          const orig = make();
          const { text, top } = exp(orig);
          const { def } = compiledTop(await importVerilog(text, { top }));
          sameOutputs(name, orig, def, cycles);
        }, 120_000);
      }
    });
  }

  // The other way round: a chip drawn from Verilog, exported with File ▸ Export Verilog and imported again.
  it('a Verilog chip exported and imported again', async () => {
    const first = compiledTop(await importVerilog(TOP)).def;
    const f = exportHdl(first, 'structure');
    const again = compiledTop(await importVerilog(f.text, { top: f.top })).def;
    sameOutputs('top, twice', first, again, 60);
  }, 120_000);
});

// The drawing: no two nets on one line, no part on another (the checks every library schematic passes).
describe('imported drawings', () => {
  const check = (imp: Awaited<ReturnType<typeof importVerilog>>) => {
    for (const [id, def] of imp.drawn) {
      const nl = netlistOf(def)!;
      expect(symbolOverlaps(nl), id).toEqual([]);
      expect(wireOverlaps(routeNetlist(def, nl).nets), id).toEqual([]);
    }
  };
  it('a hierarchy of small modules', async () => check(await importVerilog(TOP)), 60_000);
  it('the single-cycle RV32I CPU, exported and imported back, in under a few seconds', async () => {
    const { verilog } = synthVerilog(singleCycleCpu([0x00000013]), 'dut');
    const t = performance.now();
    const imp = await importVerilog(verilog, { top: 'dut' });
    expect(imp.chips.length).toBeGreaterThan(40);
    expect(performance.now() - t).toBeLessThan(15_000);
    check(imp);
  }, 120_000);
});
