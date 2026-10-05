// Level 4: addressable memory (primer Appendix C). N = 2^k words of W bits:
//   write path: decoder(addr) AND we → one word's load enable
//   storage:    N registers
//   read path:  N:1 multiplexer tree selected by addr
// The three parts share one row pitch so every wire is a straight line.

import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { define } from './define';
import { decoder, muxTree } from './combinational';
import { register } from './sequential';

const cache = new Map<string, ComponentDef>();

export function ram(k: number, w: number): ComponentDef {
  const key = `${k}x${w}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const N = 2 ** k;
  const R = register(w);
  const rg = symbolGeom(R);
  const pitch = Math.max(rg.h + 4, 10);
  const D = decoder(k, true, pitch);
  const M = muxTree(k, w, pitch);
  const dg = symbolGeom(D), mg = symbolGeom(M);

  const dAt: [number, number] = [6, 2];
  const dOut = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1];
  const xR = dAt[0] + dg.w + 8;
  // Register i is placed so its enable lines up with decoder output i.
  const rTop = (i: number) => dOut(i) - rg.ports.en.pos[1];
  const xM = xR + rg.w + 7;
  // Mux input i lines up with register i's q.
  const mTop = rTop(0) + rg.ports.q.pos[1] - mg.ports.d0.pos[1];

  const instances: InstanceDef[] = [
    { name: 'dec', def: D, at: dAt },
    { name: 'rmux', def: M, at: [xM, mTop] },
  ];
  const nets: NetDef[] = [];
  const din = ['din'], clk = ['clk'];
  for (let i = 0; i < N; i++) {
    instances.push({ name: `w${i}`, def: R, at: [xR, rTop(i)] });
    nets.push({ name: `en${i}`, ends: [`dec.y${i}`, `w${i}.en`] });
    nets.push({ name: `q${i}`, ends: [`w${i}.q`, `rmux.d${i}`] });
    din.push(`w${i}.d`);
    clk.push(`w${i}.clk`);
  }
  const bottom = Math.max(rTop(N - 1) + rg.h, dAt[1] + dg.h, mTop + mg.h) + 3;
  const addrY = dAt[1] + dg.ports.a.pos[1];
  const sx = xM + mg.ports.s.pos[0];
  nets.push({ name: 'addr', ends: ['addr', 'dec.a', 'rmux.s'], via: { 'rmux.s': [[2, addrY], [2, bottom + 2], [sx, bottom + 2]] } });
  nets.push({ name: 'we', ends: ['we', 'dec.en'] });
  nets.push({ name: 'din', ends: din, trunk: xR - 3 });
  nets.push({ name: 'clk', ends: clk, trunk: xR + rg.w + 2 });
  nets.push({ name: 'dout', ends: ['rmux.y', 'dout'] });

  const def = define({
    id: `ram${N}x${w}`, name: `${N}×${w} memory`, category: 'memory',
    summary: `${N} words of ${w} bits (${N * w} bits). Writing: the decoder enables exactly one word when we = 1. Reading: a multiplexer tree selects the addressed word.`,
    ports: [
      { name: 'addr', width: k, dir: 'in' },
      { name: 'din', width: w, dir: 'in' },
      { name: 'we', width: 1, dir: 'in' },
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true },
      { name: 'dout', width: w, dir: 'out' },
    ],
    symbol: { kind: 'box', label: `RAM ${N}×${w}` },
    netlist: () => ({
      pins: {
        addr: [0, addrY], we: [0, dAt[1] + dg.ports.en.pos[1]],
        din: [0, bottom], clk: [0, bottom + 4],
        dout: [xM + mg.w + 4, mTop + mg.ports.y.pos[1]],
      },
      instances, nets,
    }),
    hdl: {
      verilog: `module ram #(parameter int K = ${k}, W = ${w}) (
  input  logic [K-1:0] addr,
  input  logic [W-1:0] din,
  input  logic         we, clk,
  output logic [W-1:0] dout);
  logic [W-1:0] mem [0:2**K-1];
  always_ff @(posedge clk) if (we) mem[addr] <= din;   // write: decoder + enables
  assign dout = mem[addr];                             // read: multiplexer tree
endmodule`,
    },
  });
  cache.set(key, def);
  return def;
}
