// Level 6: the register file. 2^k registers of w bits, register 0 hard-wired to zero (as
// RISC-V's x0), one write port (decoder + enables, like the memory) and two read ports.
// The register outputs are bundled into one wide bus that feeds both read ports, the usual
// way to draw "every word goes to every read port" without crossing wires.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { busMux2, decoder, muxTree } from './combinational';
import { OR } from './gates';
import { define, merger, splitter } from './define';
import { register } from './sequential';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** One read port: unbundle the word bus and select one word with a multiplexer tree. */
export function readPort(k: number, w: number): ComponentDef {
  return memo(`rp${k}x${w}`, () => {
    const N = 2 ** k, P = 4;
    const M = muxTree(k, w, P);
    const mg = symbolGeom(M);
    const sTop = 2 + mg.ports.d0.pos[1] - P / 2;
    return define({
      id: `readport${N}x${w}`, name: `Read port (${N} × ${w})`, category: 'routing',
      summary: `Unbundles all ${N} words and lets the select lines pick one: a ${N}:1 multiplexer tree of ${w}-bit words.`,
      ports: [bus('words', N * w, 'in'), bus('sel', k, 'in', 'bottom'), bus('y', w, 'out')],
      symbol: { kind: 'box', label: 'READ' },
      netlist: () => ({
        pins: { words: [1, sTop + (N * P) / 2], sel: [1, 2 + mg.h + 4], y: [12 + mg.w + 6, 2 + mg.ports.y.pos[1]] },
        instances: [
          { name: 'unbundle', def: splitter(Array(N).fill(w), P), at: [6, sTop] },
          { name: 'mux', def: M, at: [12, 2] },
        ],
        nets: [
          { name: 'words', ends: ['words', 'unbundle.in'] },
          ...Array.from({ length: N }, (_, i): NetDef => ({ name: `r${i}`, ends: [`unbundle.o${i}`, `mux.d${i}`] })),
          { name: 'sel', ends: ['sel', 'mux.s'], via: { 'mux.s': [[12 + mg.ports.s.pos[0], 2 + mg.h + 4]] } },
          { name: 'y', ends: ['mux.y', 'y'] },
        ],
      }),
    });
  });
}

/**
 * A register's write select for two write ports: written when either port's decoder picks it (OR), and
 * with port 1's data when port 1 does (port 1 wins: in a dual-issue CPU it carries the younger instruction).
 */
export function writeSelect(w: number): ComponentDef {
  return memo(`wsel${w}`, () => {
    const MX = busMux2(w);
    return define({
      id: `wsel${w}`, name: `Write select (2 ports, ${w} bits)`, category: 'routing',
      summary: 'Picks what a register of a two-write-port file loads: enabled when either write port addresses it, with port 1\'s data when port 1 does (the younger instruction wins).',
      ports: [bit('y0', 'in'), bit('y1', 'in'), bus('wd0', w, 'in'), bus('wd1', w, 'in'), bus('d', w, 'out'), bit('en', 'out')],
      symbol: { kind: 'box', label: 'WR', w: 4, h: 8, portPos: { y0: 1, y1: 3, wd0: 5, wd1: 7, d: 2, en: 4 }, noPortLabels: true },
      spec: ([y0, y1, a, b]) => [y1 ? b : a, y0 || y1 ? 1 : 0],
      netlist: () => ({
        pins: { y0: [0, 10], y1: [0, 4], wd0: [0, 1], wd1: [0, 2], d: [16, 3], en: [16, 11] },
        instances: [{ name: 'mux', def: MX, at: [8, 0] }, { name: 'or', def: OR, at: [8, 9] }],
        nets: [
          { name: 'wd0', ends: ['wd0', 'mux.a'] }, { name: 'wd1', ends: ['wd1', 'mux.b'] },
          { name: 'y1', ends: ['y1', 'mux.s', 'or.b'], via: { 'mux.s': [[4, 4], [4, 7], [10, 7]] }, trunk: 4 },
          { name: 'y0', ends: ['y0', 'or.a'] },
          { name: 'd', ends: ['mux.y', 'd'] }, { name: 'en', ends: ['or.y', 'en'] },
        ],
      }),
    });
  });
}

/**
 * The register file of a dual-issue CPU: 2^k registers of w bits with x0 = 0, four read ports (two
 * instructions, two operands each) and two write ports; when both write one register, port 1 wins.
 * Registers are w1 … w(2^k − 1), as in regfile(), so every reader of a register file reads this one too.
 */
export function regfile2w(k: number, w: number): ComponentDef {
  return memo(`rf2w${k}x${w}`, () => {
    const N = 2 ** k, R = register(w), rg = symbolGeom(R);
    const P = Math.max(rg.h + 4, 10);
    const D = decoder(k, true, P), dg = symbolGeom(D);
    const WS = writeSelect(w), wg = symbolGeom(WS);
    const RP = readPort(k, w), rpg = symbolGeom(RP);
    const Z = constWord(w, 0), zg = symbolGeom(Z);
    const dAt: [number, number] = [6, 2];
    const dOut = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1];
    // a row: the write select's y0 level with the decoder's output, its d / en level with the register's
    const sTop = (i: number) => dOut(i) - wg.ports.y0.pos[1];
    const xS = dAt[0] + dg.w + 10, xR = xS + wg.w + 6;
    const rTop = (i: number) => sTop(i) + wg.ports.d.pos[1] - rg.ports.d.pos[1];
    const qY = (i: number) => rTop(i) + rg.ports.q.pos[1];
    const xQ = xR + rg.w + 6, mqTop = qY(0) - P / 2, busY = mqTop + (N * P) / 2;
    const xP = xQ + 10;
    const rpAt = (j: number): [number, number] => [xP, busY - rpg.ports.words.pos[1] + j * (rpg.h + 10)];
    const d1At: [number, number] = [dAt[0], dAt[1] + dg.h + 8];
    const instances: InstanceDef[] = [
      { name: 'dec0', def: D, at: dAt, label: 'write port 0' },
      { name: 'dec1', def: D, at: d1At, label: 'write port 1' },
      { name: 'x0', def: Z, at: [xR + rg.w - zg.w, qY(0) - zg.ports.y.pos[1]], label: 'x0 = 0' },
      { name: 'bundle', def: merger(Array(N).fill(w), P), at: [xQ, mqTop] },
      ...[0, 1, 2, 3].map((j): InstanceDef => ({ name: `rp${j + 1}`, def: RP, at: rpAt(j) })),
    ];
    const nets: NetDef[] = [{ name: 'q0', ends: ['x0.y', 'bundle.i0'] }];
    const wd0 = ['wd0'], wd1 = ['wd1'], clk = ['clk'];
    for (let i = 1; i < N; i++) {
      instances.push({ name: `ws${i}`, def: WS, at: [xS, sTop(i)] }, { name: `w${i}`, def: R, at: [xR, rTop(i)], label: `x${i}` });
      nets.push(
        { name: `p0w${i}`, ends: [`dec0.y${i}`, `ws${i}.y0`] },
        { name: `p1w${i}`, ends: [`dec1.y${i}`, `ws${i}.y1`], tags: true },
        { name: `d${i}`, ends: [`ws${i}.d`, `w${i}.d`] }, { name: `en${i}`, ends: [`ws${i}.en`, `w${i}.en`] },
        { name: `q${i}`, ends: [`w${i}.q`, `bundle.i${i}`] },
      );
      wd0.push(`ws${i}.wd0`); wd1.push(`ws${i}.wd1`); clk.push(`w${i}.clk`);
    }
    const bottom = Math.max(d1At[1] + dg.h, rTop(N - 1) + rg.h, rpAt(3)[1] + rpg.h) + 4;
    nets.push(
      { name: 'wa0', ends: ['wa0', 'dec0.a'], tags: ['dec0.a'] }, { name: 'we0', ends: ['we0', 'dec0.en'], tags: ['dec0.en'] },
      { name: 'wa1', ends: ['wa1', 'dec1.a'], tags: ['dec1.a'] }, { name: 'we1', ends: ['we1', 'dec1.en'], tags: ['dec1.en'] },
      { name: 'wd0', ends: wd0, trunk: xS - 3 }, { name: 'wd1', ends: wd1, trunk: xS - 6 },
      { name: 'clk', ends: clk, trunk: xR + rg.w + 2 },
      { name: 'regs', ends: ['bundle.out', ...[1, 2, 3, 4].map((j) => `rp${j}.words`)], trunk: xP - 3 },
      ...[1, 2, 3, 4].flatMap((j): NetDef[] => [
        { name: `ra${j}`, ends: [`ra${j}`, `rp${j}.sel`], tags: [`rp${j}.sel`] },
        { name: `rd${j}`, ends: [`rp${j}.y`, `rd${j}`] },
      ]),
    );
    const outX = xP + rpg.w + 6;
    const ins = ['wa0', 'we0', 'wd0', 'wa1', 'we1', 'wd1', 'ra1', 'ra2', 'ra3', 'ra4'];
    return define({
      id: `regfile${N}x${w}_4r2w`, name: `Register file (${N} × ${w}, 4 read, 2 write ports)`, category: 'memory',
      summary: `${N} registers of ${w} bits, x0 always reads 0. Four read ports (two instructions, two operands each) and two write ports, all in one cycle: each register's write select takes either port, and port 1 (the younger instruction) wins when both write one register.`,
      ports: [
        bus('wa0', k, 'in'), bit('we0', 'in'), bus('wd0', w, 'in'), bus('wa1', k, 'in'), bit('we1', 'in'), bus('wd1', w, 'in'),
        ...[1, 2, 3, 4].map((j) => bus(`ra${j}`, k, 'in')), bit('clk', 'in', 'bottom', true),
        ...[1, 2, 3, 4].map((j) => bus(`rd${j}`, w, 'out')),
      ],
      symbol: { kind: 'box', label: 'REGISTERS 4R 2W' },
      netlist: () => ({
        pins: {
          ...Object.fromEntries(ins.map((n, i) => [n, [0, bottom + 2 * i] as [number, number]])), clk: [0, bottom + 2 * ins.length],
          ...Object.fromEntries([1, 2, 3, 4].map((j) => [`rd${j}`, [outX, rpAt(j - 1)[1] + rpg.ports.y.pos[1]] as [number, number]])),
        },
        instances, nets,
      }),
      hdl: {
        verilog: `always_ff @(posedge clk) begin
  if (we0 && wa0 != 0) x[wa0] <= wd0;
  if (we1 && wa1 != 0) x[wa1] <= wd1;   // port 1 last: it wins a register both write
end
assign rd1 = (ra1 == 0) ? '0 : x[ra1];   // likewise rd2, rd3, rd4`,
      },
    });
  });
}

/**
 * zero = false: register 0 is an ordinary register (the floating-point file has no hard-wired f0).
 * reads = 3 adds a third read port (rs3 of the fused multiply-add instructions).
 */
export function regfile(k: number, w: number, zero = true, reads: 2 | 3 = 2): ComponentDef {
  return memo(`rf${k}x${w}${zero ? '' : 'f'}${reads === 3 ? '_3r' : ''}`, () => {
    const pre = zero ? 'x' : 'f';
    const N = 2 ** k;
    const R = register(w);
    const rg = symbolGeom(R);
    const P = Math.max(rg.h + 4, 10);
    const D = decoder(k, true, P);
    const dg = symbolGeom(D);
    const RP = readPort(k, w);
    const rpg = symbolGeom(RP);
    const Z = constWord(w, 0);
    const zg = symbolGeom(Z);

    const dAt: [number, number] = [6, 2];
    const dOut = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1];
    const xR = dAt[0] + dg.w + 8;
    const rTop = (i: number) => dOut(i) - rg.ports.en.pos[1];
    const qY = (i: number) => rTop(i) + rg.ports.q.pos[1];
    const xQ = xR + rg.w + 6;
    const mqTop = qY(0) - P / 2;
    const busY = mqTop + (N * P) / 2;
    const xP = xQ + 8;
    const rp1At: [number, number] = [xP, busY - rpg.ports.words.pos[1]];
    const rp2At: [number, number] = [xP, rp1At[1] + rpg.h + 10];
    const rp3At: [number, number] = [xP, rp2At[1] + rpg.h + 10];

    const instances: InstanceDef[] = [
      { name: 'dec', def: D, at: dAt },
      ...(zero ? [{ name: 'x0', def: Z, at: [xR + rg.w - zg.w, qY(0) - zg.ports.y.pos[1]] as [number, number], label: 'x0 = 0' }] : []),
      { name: 'bundle', def: merger(Array(N).fill(w), P), at: [xQ, mqTop] },
      { name: 'rp1', def: RP, at: rp1At },
      { name: 'rp2', def: RP, at: rp2At },
      ...(reads === 3 ? [{ name: 'rp3', def: RP, at: rp3At }] : []),
    ];
    const nets: NetDef[] = zero ? [{ name: 'q0', ends: ['x0.y', 'bundle.i0'] }] : [];
    const wd = ['wd'], clk = ['clk'];
    for (let i = zero ? 1 : 0; i < N; i++) {
      instances.push({ name: `w${i}`, def: R, at: [xR, rTop(i)], label: `${pre}${i}` });
      nets.push({ name: `en${i}`, ends: [`dec.y${i}`, `w${i}.en`] });
      nets.push({ name: `q${i}`, ends: [`w${i}.q`, `bundle.i${i}`] });
      wd.push(`w${i}.d`);
      clk.push(`w${i}.clk`);
    }
    const bottom = Math.max(rTop(N - 1) + rg.h, dAt[1] + dg.h, (reads === 3 ? rp3At : rp2At)[1] + rpg.h) + 3;
    const sel1x = rp1At[0] + rpg.ports.sel.pos[0], sel2x = rp2At[0] + rpg.ports.sel.pos[0], sel3x = rp3At[0] + rpg.ports.sel.pos[0];
    nets.push(
      { name: 'wa', ends: ['wa', 'dec.a'] },
      { name: 'we', ends: ['we', 'dec.en'] },
      { name: 'wd', ends: wd, trunk: xR - 3 },
      { name: 'clk', ends: clk, trunk: xR + rg.w + 2 },
      { name: 'regs', ends: ['bundle.out', 'rp1.words', 'rp2.words', ...(reads === 3 ? ['rp3.words'] : [])], trunk: xP - 3 },
      // ra1 climbs left of rp2 and crosses into the gap between the ports, under rp1.sel.
      { name: 'ra1', ends: ['ra1', 'rp1.sel'], via: { 'rp1.sel': [[xP - 1.5, bottom + 4], [xP - 1.5, rp1At[1] + rpg.h + 5], [sel1x, rp1At[1] + rpg.h + 5]] } },
      // with a third port below rp2, ra2 must not climb through it: it goes up the left side like ra1
      { name: 'ra2', ends: ['ra2', 'rp2.sel'], via: { 'rp2.sel': reads === 3 ? [[xP - 4.5, bottom + 6], [xP - 4.5, rp2At[1] + rpg.h + 5], [sel2x, rp2At[1] + rpg.h + 5]] : [[sel2x, bottom + 6]] } },
      { name: 'rd1', ends: ['rp1.y', 'rd1'] },
      { name: 'rd2', ends: ['rp2.y', 'rd2'] },
    );
    if (reads === 3) nets.push({ name: 'ra3', ends: ['ra3', 'rp3.sel'], via: { 'rp3.sel': [[sel3x, bottom + 8]] } }, { name: 'rd3', ends: ['rp3.y', 'rd3'] });
    const outX = xP + rpg.w + 6;
    return define({
      id: `regfile${N}x${w}${zero ? '' : '_f'}${reads === 3 ? '_3r' : ''}`, name: `${zero ? 'Register file' : 'Floating-point register file'} (${N} × ${w}${reads === 3 ? ', 3 read ports' : ''})`, category: 'memory',
      summary: `${N} registers of ${w} bits${zero ? '; x0 always reads 0' : ' (f0 is an ordinary register)'}. ${reads === 3 ? 'Three read ports (fused multiply-add reads three operands)' : 'Two read ports (two operands per instruction)'} and one write port, all in one cycle.`,
      ports: [
        bus('wa', k, 'in'), bus('ra1', k, 'in'), bus('ra2', k, 'in'), ...(reads === 3 ? [bus('ra3', k, 'in')] : []), bus('wd', w, 'in'), bit('we', 'in'),
        bit('clk', 'in', 'bottom', true), bus('rd1', w, 'out'), bus('rd2', w, 'out'), ...(reads === 3 ? [bus('rd3', w, 'out')] : []),
      ],
      symbol: { kind: 'box', label: zero ? 'REGISTERS' : 'FP REGISTERS' },
      netlist: () => ({
        pins: {
          wa: [0, dAt[1] + dg.ports.a.pos[1]], we: [0, dAt[1] + dg.ports.en.pos[1]],
          wd: [0, bottom], clk: [0, bottom + 2], ra1: [0, bottom + 4], ra2: [0, bottom + 6],
          rd1: [outX, rp1At[1] + rpg.ports.y.pos[1]], rd2: [outX, rp2At[1] + rpg.ports.y.pos[1]],
          ...(reads === 3 ? { ra3: [0, bottom + 8] as [number, number], rd3: [outX, rp3At[1] + rpg.ports.y.pos[1]] as [number, number] } : {}),
        },
        instances, nets,
      }),
      hdl: {
        verilog: `module regfile #(parameter int K = ${k}, W = ${w}) (
  input  logic [K-1:0] ra1, ra2, wa,
  input  logic [W-1:0] wd,
  input  logic         we, clk,
  output logic [W-1:0] rd1, rd2);
  logic [W-1:0] x [1:2**K-1];                        // x0 does not exist: it reads as 0
  always_ff @(posedge clk) if (we && wa != 0) x[wa] <= wd;
  assign rd1 = (ra1 == 0) ? '0 : x[ra1];
  assign rd2 = (ra2 == 0) ? '0 : x[ra2];
endmodule`,
      },
    });
  });
}
