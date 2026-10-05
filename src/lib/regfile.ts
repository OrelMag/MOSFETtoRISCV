// Level 6: the register file. 2^k registers of w bits, register 0 hard-wired to zero (as
// RISC-V's x0), one write port (decoder + enables, like the memory) and two read ports.
// The register outputs are bundled into one wide bus that feeds both read ports, the usual
// way to draw "every word goes to every read port" without crossing wires.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { decoder, muxTree } from './combinational';
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

export function regfile(k: number, w: number): ComponentDef {
  return memo(`rf${k}x${w}`, () => {
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

    const instances: InstanceDef[] = [
      { name: 'dec', def: D, at: dAt },
      { name: 'x0', def: Z, at: [xR + rg.w - zg.w, qY(0) - zg.ports.y.pos[1]], label: 'x0 = 0' },
      { name: 'bundle', def: merger(Array(N).fill(w), P), at: [xQ, mqTop] },
      { name: 'rp1', def: RP, at: rp1At },
      { name: 'rp2', def: RP, at: rp2At },
    ];
    const nets: NetDef[] = [{ name: 'q0', ends: ['x0.y', 'bundle.i0'] }];
    const wd = ['wd'], clk = ['clk'];
    for (let i = 1; i < N; i++) {
      instances.push({ name: `w${i}`, def: R, at: [xR, rTop(i)], label: `x${i}` });
      nets.push({ name: `en${i}`, ends: [`dec.y${i}`, `w${i}.en`] });
      nets.push({ name: `q${i}`, ends: [`w${i}.q`, `bundle.i${i}`] });
      wd.push(`w${i}.d`);
      clk.push(`w${i}.clk`);
    }
    const bottom = Math.max(rTop(N - 1) + rg.h, dAt[1] + dg.h, rp2At[1] + rpg.h) + 3;
    const sel1x = rp1At[0] + rpg.ports.sel.pos[0], sel2x = rp2At[0] + rpg.ports.sel.pos[0];
    nets.push(
      { name: 'wa', ends: ['wa', 'dec.a'] },
      { name: 'we', ends: ['we', 'dec.en'] },
      { name: 'wd', ends: wd, trunk: xR - 3 },
      { name: 'clk', ends: clk, trunk: xR + rg.w + 2 },
      { name: 'regs', ends: ['bundle.out', 'rp1.words', 'rp2.words'], trunk: xP - 3 },
      { name: 'ra1', ends: ['ra1', 'rp1.sel'], via: { 'rp1.sel': [[sel1x - 0, bottom + 4]] } },
      { name: 'ra2', ends: ['ra2', 'rp2.sel'], via: { 'rp2.sel': [[sel2x, bottom + 6]] } },
      { name: 'rd1', ends: ['rp1.y', 'rd1'] },
      { name: 'rd2', ends: ['rp2.y', 'rd2'] },
    );
    const outX = xP + rpg.w + 6;
    return define({
      id: `regfile${N}x${w}`, name: `Register file (${N} × ${w})`, category: 'memory',
      summary: `${N} registers of ${w} bits; x0 always reads 0. Two read ports (two operands per instruction) and one write port, all in one cycle.`,
      ports: [
        bus('ra1', k, 'in'), bus('ra2', k, 'in'), bus('wa', k, 'in'), bus('wd', w, 'in'), bit('we', 'in'),
        bit('clk', 'in', 'bottom', true), bus('rd1', w, 'out'), bus('rd2', w, 'out'),
      ],
      symbol: { kind: 'box', label: 'REGISTERS' },
      netlist: () => ({
        pins: {
          wa: [0, dAt[1] + dg.ports.a.pos[1]], we: [0, dAt[1] + dg.ports.en.pos[1]],
          wd: [0, bottom], clk: [0, bottom + 2], ra1: [0, bottom + 4], ra2: [0, bottom + 6],
          rd1: [outX, rp1At[1] + rpg.ports.y.pos[1]], rd2: [outX, rp2At[1] + rpg.ports.y.pos[1]],
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
