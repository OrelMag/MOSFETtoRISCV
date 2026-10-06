// Level 9b: caches. A small direct-mapped data cache in front of a slow main memory, built from
// the same RAM arrays, comparators and multiplexers as everything else, and the parallel tag
// compare of a set-associative cache.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { busMux2, equal, incrementer } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { ram } from './memory';
import { register } from './sequential';
import { TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Cycles a load miss stalls the CPU: 4 cycles of memory latency, then a 4-word burst. */
export const MISS_PENALTY = 8;

/**
 * Main memory (2^k words) behind a direct-mapped, write-through, no-write-allocate data cache of
 * 2^ib lines × 4 words. Same ports as the plain data memory plus re (this is a load) and stall.
 * A load miss raises stall for 8 cycles: a 3-bit counter waits 4 cycles (memory latency), then
 * copies the 4 words of the line one per cycle, and on the last one writes the tag and valid bit.
 * The next cycle hits.
 */
export function cachedMemory(k = 6, ib = 2): ComponentDef {
  return memo(`dcache${k}_${ib}`, () => {
    const t = k - 2 - ib, la = ib + 2;
    const MEM = ram(k, 32), DATA = ram(la, 32), TAGS = ram(ib, t + 1), CNT = register(3), INC = incrementer(3);
    const MA = busMux2(k), DA = busMux2(la), DD = busMux2(32), EQ = equal(t);
    const mg = symbolGeom(MEM), dg = symbolGeom(DATA), tg = symbolGeom(TAGS);
    const x1 = 30, x2 = x1 + 14, x3 = x2 + Math.max(dg.w, tg.w) + 14, x4 = x3 + 16;
    const yT = 2, yD = yT + tg.h + 12, yM = yD + dg.h + 14, yC = yM + mg.h + 10;
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter([2, 2, ib, t, 30 - k]), at: [4, 20] },
      { name: 'wa', def: merger([2, ib, t]), at: [12, yM + 6] },
      { name: 'fa', def: merger([2, ib, t]), at: [16, yM + 14] },
      { name: 'oa', def: merger([2, ib]), at: [12, yD + 6] },
      { name: 'ca', def: merger([2, ib]), at: [16, yD + 12] },
      { name: 'tv', def: merger([t, 1]), at: [x1, yT + 2] },
      { name: 'one', def: TIE1, at: [x1 - 6, yT + 6] },
      { name: 'tags', def: TAGS, at: [x2, yT], label: 'tag + valid array' },
      { name: 'st', def: splitter([t, 1]), at: [x3 - 8, yT + 4] },
      { name: 'eq', def: EQ, at: [x3, yT], label: 'tag match' },
      { name: 'hitg', def: AND, at: [x4, yT + 4] },
      { name: 'da', def: DA, at: [x1, yD + 4], label: 'line / fill' },
      { name: 'dd', def: DD, at: [x1, yD + 14], label: 'store / fill data' },
      { name: 'data', def: DATA, at: [x2, yD], label: 'data array' },
      { name: 'ma', def: MA, at: [x1, yM + 4], label: 'fill address' },
      { name: 'ram', def: MEM, at: [x2, yM], label: 'main memory' },
      { name: 'cnt', def: CNT, at: [x2, yC], label: 'miss counter' },
      { name: 'inc', def: INC, at: [x3, yC] },
      { name: 'sc', def: splitter([2, 1]), at: [x3 - 6, yC + 10] },
      { name: 'cs', def: splitter([1, 1]), at: [x3 + 8, yC + 10] },
      { name: 'nhit', def: NOT, at: [x4, yT + 12] },
      { name: 'stall', def: AND, at: [x4 + 6, yT + 12] },
      { name: 'fill', def: AND, at: [x4, yC] },
      { name: 'l01', def: AND, at: [x4, yC + 6] },
      { name: 'last', def: AND, at: [x4 + 6, yC + 4] },
      { name: 'whit', def: AND, at: [x4, yD + 16] },
      { name: 'dwe', def: OR, at: [x4 + 6, yD + 14] },
    ];
    const nets: NetDef[] = [
      { name: 'addr', ends: ['addr', 'sa.in'] },
      { name: 'offset', ends: ['sa.o1', 'wa.i0', 'oa.i0'], tags: true },
      { name: 'index', ends: ['sa.o2', 'wa.i1', 'fa.i1', 'oa.i1', 'ca.i1', 'tags.addr'], tags: true },
      { name: 'tag', ends: ['sa.o3', 'wa.i2', 'fa.i2', 'tv.i0', 'eq.a'], tags: true },
      { name: 'wordAddr', ends: ['wa.out', 'ma.a'] },
      { name: 'fillAddr', ends: ['fa.out', 'ma.b'] },
      { name: 'memAddr', ends: ['ma.y', 'ram.addr'] },
      { name: 'lineAddr', ends: ['oa.out', 'da.a'] },
      { name: 'fillLine', ends: ['ca.out', 'da.b'] },
      { name: 'dataAddr', ends: ['da.y', 'data.addr'] },
      { name: 'wd', ends: ['wd', 'ram.din', 'dd.a'], tags: ['dd.a'] },
      { name: 'memWord', ends: ['ram.dout', 'dd.b'], tags: true },
      { name: 'dataIn', ends: ['dd.y', 'data.din'] },
      { name: 'we', ends: ['we', 'ram.we', 'whit.a'], tags: ['whit.a'] },
      { ends: ['one.y', 'tv.i1'] },
      { name: 'tagIn', ends: ['tv.out', 'tags.din'] },
      { name: 'stored', ends: ['tags.dout', 'st.in'] },
      { name: 'storedTag', ends: ['st.o0', 'eq.b'] },
      { name: 'valid', ends: ['st.o1', 'hitg.b'], tags: true },
      { name: 'match', ends: ['eq.eq', 'hitg.a'] },
      { name: 'hit', ends: ['hitg.y', 'nhit.a', 'whit.b', 'hit'], tags: ['whit.b', 'hit'] },
      { name: 'miss', ends: ['nhit.y', 'stall.b'] },
      { name: 're', ends: ['re', 'stall.a'] },
      { name: 'stall', ends: ['stall.y', 'cnt.en', 'ma.s', 'da.s', 'dd.s', 'fill.a', 'stall'], tags: true },
      { name: 'count', ends: ['cnt.q', 'inc.a', 'sc.in'], tags: ['inc.a', 'sc.in'] },
      { name: 'count+1', ends: ['inc.y', 'cnt.d'], tags: true },
      { name: 'burstWord', ends: ['sc.o0', 'fa.i0', 'ca.i0', 'cs.in'], tags: true },
      { name: 'burst', ends: ['sc.o1', 'fill.b'], tags: true },
      { name: 'c0', ends: ['cs.o0', 'l01.a'], tags: true },
      { name: 'c1', ends: ['cs.o1', 'l01.b'], tags: true },
      { name: 'word3', ends: ['l01.y', 'last.b'], tags: true },
      { name: 'fillWe', ends: ['fill.y', 'dwe.b', 'last.a'], tags: true },
      { name: 'storeHit', ends: ['whit.y', 'dwe.a'], tags: true },
      { name: 'dataWe', ends: ['dwe.y', 'data.we'], tags: true },
      { name: 'lastWord', ends: ['last.y', 'tags.we'], tags: true },
      { name: 'rd', ends: ['data.dout', 'rd'] },
      { name: 'clk', ends: ['clk', 'ram.clk', 'data.clk', 'tags.clk', 'cnt.clk'], tags: true },
    ];
    const right = x4 + 20;
    return define({
      id: `dcache${k}_${ib}`, name: `${4 * 2 ** k}-byte memory with a ${16 * 2 ** ib}-byte cache`, category: 'memory',
      summary: `Main memory of ${2 ** k} words behind a direct-mapped cache of ${2 ** ib} lines × 4 words (write-through, no write-allocate). Address = tag (${t} bits) | index (${ib}) | word offset (2) | byte (2). A load that misses stalls ${MISS_PENALTY} cycles: 4 cycles of memory latency, then the line arrives one word per cycle.`,
      ports: [bus('addr', 32, 'in'), bus('wd', 32, 'in'), bit('we', 'in'), bit('re', 'in'), bit('clk', 'in', 'bottom', true), bus('rd', 32, 'out'), bit('stall', 'out'), bit('hit', 'out')],
      symbol: { kind: 'box', label: 'D-CACHE + MEM' },
      netlist: () => ({
        pins: { addr: [0, 24], wd: [0, yD + 18], we: [0, yD + 22], re: [0, yT + 14], clk: [0, yC + 8], rd: [right, yD + dg.ports.dout.pos[1]], stall: [right, yT + 13], hit: [right, yT + 5] },
        instances, nets,
      }),
      hdl: {
        verilog: `module dcache #(parameter int K = ${k}, IB = ${ib}) (input logic clk, we, re, input logic [31:0] addr, wd,
                                            output logic [31:0] rd, output logic stall, hit);
  localparam int T = K - 2 - IB;
  logic [31:0] mem [2**K];  logic [31:0] data [2**(IB+2)];  logic [T:0] tagv [2**IB];  logic [2:0] count;
  wire [1:0] off = addr[3:2];  wire [IB-1:0] idx = addr[IB+3:4];  wire [T-1:0] tag = addr[K+1:IB+4];
  assign hit   = tagv[idx][T] && tagv[idx][T-1:0] == tag;
  assign stall = re && !hit;
  assign rd    = data[stall ? {idx, count[1:0]} : {idx, off}];
  always_ff @(posedge clk) begin
    if (we) mem[addr[K+1:2]] <= wd;                         // write-through
    if (we && hit) data[{idx, off}] <= wd;                  // keep a cached copy current
    if (stall) begin
      count <= count + 1;                                   // 0-3: latency, 4-7: burst
      if (count[2]) data[{idx, count[1:0]}] <= mem[{tag, idx, count[1:0]}];
      if (count == 3'd7) tagv[idx] <= {1'b1, tag};
    end
  end
endmodule`,
      },
    });
  });
}

/**
 * Two-way set-associative lookup: both ways of the selected set are compared at once, and the
 * matching way's data is selected. The hit logic is two comparators and a multiplexer.
 */
export function wayLookup2(t: number, w: number): ComponentDef {
  return memo(`way2_${t}_${w}`, () => {
    const EQ = equal(t), MX = busMux2(w);
    const eg = symbolGeom(EQ);
    return define({
      id: `way2_${t}_${w}`, name: '2-way tag compare', category: 'memory',
      summary: 'The set index reads both ways at once; two comparators check both tags in parallel; the hitting way steers the data multiplexer. More ways: more comparators and a wider multiplexer, in the same time.',
      ports: [bus('tag', t, 'in'), bit('v0', 'in'), bus('tag0', t, 'in'), bus('d0', w, 'in'), bit('v1', 'in'), bus('tag1', t, 'in'), bus('d1', w, 'in'),
        bit('hit', 'out'), bit('way', 'out'), bus('data', w, 'out')],
      symbol: { kind: 'box', label: '2-WAY' },
      spec: ([tag, v0, t0, d0, v1, t1, d1]) => {
        const h0 = v0 && t0 === tag ? 1 : 0, h1 = v1 && t1 === tag ? 1 : 0;
        return [h0 | h1, h1, h1 ? d1 : d0];
      },
      netlist: () => ({
        pins: { tag: [0, 4], v0: [0, 14], tag0: [0, 8], d0: [0, eg.h + 22], v1: [0, eg.h + 14], tag1: [0, eg.h + 10], d1: [0, eg.h + 26], hit: [52, 8], way: [52, eg.h + 12], data: [52, eg.h + 24] },
        instances: [
          { name: 'e0', def: EQ, at: [10, 2], label: 'way 0' },
          { name: 'e1', def: EQ, at: [10, eg.h + 8], label: 'way 1' },
          { name: 'h0', def: AND, at: [28, 6] },
          { name: 'h1', def: AND, at: [28, eg.h + 10] },
          { name: 'any', def: OR, at: [40, 7] },
          { name: 'mx', def: MX, at: [40, eg.h + 18] },
        ],
        nets: [
          { name: 'tag', ends: ['tag', 'e0.a', 'e1.a'] },
          { name: 'tag0', ends: ['tag0', 'e0.b'] }, { name: 'tag1', ends: ['tag1', 'e1.b'] },
          { name: 'eq0', ends: ['e0.eq', 'h0.a'] }, { name: 'eq1', ends: ['e1.eq', 'h1.a'] },
          { name: 'v0', ends: ['v0', 'h0.b'] }, { name: 'v1', ends: ['v1', 'h1.b'] },
          { name: 'hit0', ends: ['h0.y', 'any.a'] },
          { name: 'hit1', ends: ['h1.y', 'any.b', 'mx.s', 'way'] },
          { name: 'hit', ends: ['any.y', 'hit'] },
          { name: 'd0', ends: ['d0', 'mx.a'] }, { name: 'd1', ends: ['d1', 'mx.b'] },
          { name: 'data', ends: ['mx.y', 'data'] },
        ],
      }),
    });
  });
}
