// The FPGA export's block-RAM memories against asynchronous ones (editor/fpga.ts, vexport's memClock). A testbench
// wires a ROM into the address of a RAM (a chain of two memories, the case a clock-edge read would break), both
// exported with memClock, beside plain asynchronous arrays; clk is mem_clk / 32, the stimulus changes right after
// each rising edge of clk, and at every edge the RAM's dout must equal the asynchronous array's. Yosys flattens the
// testbench to gates (memories mapped to flip-flops), and a small event evaluator runs the netlist with two clocks:
// mem_clk toggled from outside, the flip-flops clocked by clk (a flip-flop's output) fired in the delta after it.
// Needs Yosys (YOSYS env var, or yowasp-yosys from pip). Exits 1 on any difference.
// Run: npx vite-node scripts/fpga-memcheck.ts (~3 min; CYCLES=n shorter; NEGATIVE=1 corrupts the reference: must then fail)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/lib';
import { bigRamWithInit } from '../src/lib/bigmem';
import { wordRom } from '../src/editor/parts';
import { synthVerilog } from '../src/sim/vexport';

type Bit = number | '0' | '1' | 'x';
interface YCell { type: string; connections: Record<string, Bit[]> }

const K = 9, W = 16;
const words = Array.from({ length: 2 ** K }, (_, i) => (i * 2654435761 + 12345) >>> 16 & 0xffff);
const ramInit = Array.from({ length: 2 ** 9 }, (_, i) => (i * 40503 + 7) & 0xffff);
const rom = synthVerilog(wordRom(K, 16, 'word', words), 'rom_fpga', { memClock: true, powerOnZero: true });
const ram = synthVerilog(bigRamWithInit(K, W, ramInit), 'ram_fpga', { memClock: true, powerOnZero: true });
const tb = `
module tb(input mem_clk, output reg err = 0);
  reg [4:0] div = 0;
  always @(posedge mem_clk) div <= div + 1'b1;
  wire clk = div[4];
  reg [31:0] lf = 32'h1234567;
  always @(posedge clk) lf <= {lf[30:0], lf[31] ^ lf[21] ^ lf[1] ^ lf[0]};
  wire [${K - 1}:0] ra = lf[${K}:1];            // the ROM's address
  wire we = lf[12] & lf[13];
  wire [${W - 1}:0] din = lf[28:13];
  wire [${W - 1}:0] rdata, dout;
  rom_fpga r (.addr(ra), .data(rdata), .mem_clk(mem_clk));
  ram_fpga m (.addr(rdata[${K - 1}:0]), .din(din), .we(we), .clk(clk), .dout(dout), .mem_clk(mem_clk));
  // the asynchronous reference
  reg [${W - 1}:0] rrom [0:${2 ** K - 1}];
  reg [${W - 1}:0] rram [0:${2 ** K - 1}];
  initial begin
${words.map((v, i) => `    rrom[${i}] = ${W}'h${v.toString(16)};`).join('\n')}
${ramInit.map((v, i) => `    rram[${i}] = ${W}'h${v.toString(16)};`).join('\n')}
  end
  wire [${K - 1}:0] a2 = rrom[ra][${K - 1}:0];
  always @(posedge clk) begin
    if (rdata != rrom[ra]) err <= 1;
    if (dout != rram[a2]) err <= 1;
    if (we${process.env.NEGATIVE ? ' & lf[5]' : ''}) rram[a2] <= din;
  end
endmodule
`;
const dir = join('layout', 'fpga', 'memcheck');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'dut.v'), `${rom.verilog}\n${ram.verilog}\n${tb}`);
const local = join(process.env.APPDATA ?? '', 'Python/Python313/Scripts/yowasp-yosys.exe');
const yosys = process.env.YOSYS ?? (existsSync(local) ? local : 'yowasp-yosys');
execFileSync(yosys, ['-q', '-p', 'read_verilog -sv dut.v; hierarchy -top tb; proc; flatten -noscopeinfo; memory; opt_clean; techmap; opt -fast; opt_clean -purge; write_json tb.json'], { cwd: dir, stdio: 'inherit' });

const mod = JSON.parse(readFileSync(join(dir, 'tb.json'), 'utf8')).modules.tb as {
  ports: Record<string, { bits: Bit[] }>; cells: Record<string, YCell>; netnames: Record<string, { bits: Bit[]; attributes: Record<string, string> }>;
};
const val = new Map<number, number>();
const get = (b: Bit) => (b === '1' ? 1 : b === '0' || b === 'x' ? 0 : val.get(b) ?? 0);
// power-on values (the testbench's `initial`s and `reg x = 0`)
for (const n of Object.values(mod.netnames)) {
  const init = n.attributes?.init;
  if (init) n.bits.forEach((b, i) => { if (typeof b === 'number') val.set(b, init[init.length - 1 - i] === '1' ? 1 : 0); });
}
const cells = Object.values(mod.cells);
const ffs = cells.filter((c) => /^\$_S?DFF/.test(c.type)).map((c) => {
  const m = /^\$_(?:DFF_P|DFFE_P([NP])|SDFF_P([NP])([01])|SDFF(C?)E_P([NP])([01])([NP]))_$/.exec(c.type);
  if (!m) throw new Error(`unsupported flip-flop: ${c.type}`);
  return { c, enPol: m[1] ?? m[7], rPol: m[2] ?? m[5], rVal: Number(m[3] ?? m[6] ?? 0), enFirst: m[4] === 'C', prevC: 0 };
});
const comb = cells.filter((c) => !/^\$_S?DFF/.test(c.type));
const driver = new Map<number, YCell>();
for (const c of comb) driver.set(c.connections.Y[0] as number, c);
const order: YCell[] = [];
const mark = new Map<YCell, number>();
const visit = (c: YCell) => {
  const m = mark.get(c);
  if (m === 2) return;
  if (m === 1) throw new Error('combinational loop');
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
      case '$_MUX_': y = get(c.connections.S[0]) ? B : A; break;
      default: throw new Error(`unsupported cell ${c.type}`);
    }
    val.set(c.connections.Y[0] as number, y);
  }
};
const memBit = mod.ports.mem_clk.bits[0] as number;
const errBit = mod.ports.err.bits[0];
const tick = () => {
  val.set(memBit, 1);
  for (let delta = 0; delta < 8; delta++) {
    evalComb();
    // every flip-flop whose clock rose since it last looked fires, all on the values before any of them changes
    const fire = ffs.filter((f) => { const c = get(f.c.connections.C[0]); const r = c === 1 && f.prevC === 0; f.prevC = c; return r; });
    if (!fire.length) break;
    const next = fire.map(({ c: f, enPol, rPol, rVal, enFirst }) => {
      const q = get(f.connections.Q[0]);
      const en = !enPol || get(f.connections.E[0]) === (enPol === 'P' ? 1 : 0);
      const reset = !!rPol && get(f.connections.R[0]) === (rPol === 'P' ? 1 : 0);
      if (enFirst && !en) return q;
      if (reset) return rVal;
      return en ? get(f.connections.D[0]) : q;
    });
    fire.forEach((f, k) => val.set(f.c.connections.Q[0] as number, next[k]));
  }
  val.set(memBit, 0);
  evalComb();
  for (const f of ffs) f.prevC = get(f.c.connections.C[0]);
};
evalComb();
for (const f of ffs) f.prevC = get(f.c.connections.C[0]);
const cycles = Number(process.env.CYCLES ?? 600);
for (let i = 0; i < 32 * cycles; i++) tick();
const bad = get(errBit);
console.log(`memcheck: ${cycles} clk cycles (clk = mem_clk / 32), ${ffs.length} flip-flops, ${comb.length} gates: ${bad ? 'DIFFERENT from the asynchronous memories' : 'ROM → RAM chain equal to the asynchronous memories at every clk edge'}`);
process.exit(bad ? 1 : 0);
