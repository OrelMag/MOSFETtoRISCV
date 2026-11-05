// The lane core drawn with wires (lib/lanes.ts laneCore). One decoder, n lanes: the point of the GPU chapters is that
// every lane receives the same signals, so they are wires. The decode blocks sit above the lanes; each broadcast signal
// leaves its port along a row and drops down a trunk of its own beside the lanes, with a stub into every lane's pin.
// Trunks are ordered by the height of their rows (the highest row on the outermost trunk), so no row crosses a trunk on
// the way; the lanes' outputs reach the one-hot multiplexers in columns ordered to cross as little as they can. Control
// is quiet. Only placement and routing hints are set here: instances, nets and ends are the generator's.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef } from '../sim/types';

export type Pt = [number, number];
interface Inst { name: string; def: ComponentDef; at?: Pt }

/** Broadcast signals in trunk order, outermost trunk first: [the net's driver, the lanes' port]. */
const BROADCAST: [string, string][] = [
  ['ctl.aluSrcA', 'aluSrcA'], ['ctl.aluSrcB', 'aluSrcB'], ['ctl.resultSrc', 'resultSrc'], ['ctl.aluCtl', 'aluCtl'],
  ['sdec.isCsr', 'isCsr'], ['sdec.csrSel', 'csrSel'], ['sdec.csrS', 'csrS'],
  ['si.o1', 'rd'], ['si.o3', 'rs1'], ['si.o4', 'rs2'], ['plus4.y', 'pcPlus4'], ['pc.q', 'pc'], ['imm.imm', 'imm'], ['dm.rd', 'readData'],
];
/** The multiplexers that gather the lanes' outputs, top to bottom. */
const GATHER = ['lA', 'lB', 'mWd', 'lAlu', 'mAd', 'lF'];
const QUIET = ['regWrite', 'immSrc', 'aluSrcA', 'aluSrcB', 'memWrite', 'resultSrc', 'branch', 'jump', 'jalr', 'aluCtl', 'isCsr', 'csrSel', 'csrS', 'op', 'funct3', 'funct7', 'isTmc', 'isSplit', 'isJoin', 'isPred'];

export interface LaneLayout { at: Map<string, Pt>; pins: Record<string, Pt>; lx: number; ly: (k: number) => number; pcRow: number; back: number; bottom: number }

export function laneWiredLayout(n: number): LaneLayout {
  const at = new Map<string, Pt>();
  const put = (name: string, x: number, y: number) => at.set(name, [x, y]);
  // the lanes, one under the other, their thread ids beside them
  const lx = 158, y0 = 54, pitch = 40;
  const ly = (k: number) => y0 + pitch * k;
  const bottom = ly(n - 1) + 34;
  // the fetch row beside the lanes' first two, the decoders above
  const F = 73;
  put('pcmux', 14, F); put('jmux', 30, F + 3); put('pc', 42, F + 4); put('imem', 60, F + 5); put('plus4', 60, F + 12); put('si', 82, F + 1);
  put('ctl', 96, 2); put('sdec', 96, 28); put('csrA', 91, 44); put('imm', 100, F + 20);
  // control: small gates, then the sequencer, SIMT control and the leader, the write enables
  put('rs', 154, 10); put('nr1', 158, 12); put('isLoad', 164, 10); put('isMemG', 178, 11); put('rw', 174, 1);
  put('mseq', 192, 2); put('simt', 192, 18);
  put('wsel', 222, 2); put('wf', 228, 12); put('weg', 232, 3); put('we', 246, 2);
  put('nst', 216, 14); put('pcen', 224, 19);
  for (let i = 0; i < n; i++) { put(`lane${i}`, lx, ly(i)); put(`tid${i}`, lx - 8, ly(i) + 29); }
  // the gathering multiplexers in a column, then the memory and the next PC
  const gx = 212, step = 20;
  GATHER.forEach((m, i) => put(m, gx, y0 + 2 + step * i));
  put('pm', gx + 4, y0 + 1 + step * GATHER.length);
  const fy = y0 + 2 + step * 5;
  put('lead', gx, y0 + 2 + step * 6 + 12);
  put('fs', 232, fy + 1); put('npc', 244, fy - 6); put('target', 246, fy + 16); put('gndT', 240, fy + 24); put('clr0', 264, fy + 16); put('gndJ', 260, fy + 19);
  put('dwe', 244, y0 + 50); put('dm', 252, y0 + 46);
  const back = 292;
  return { at, pins: { clk: [2, 50], pcOut: [back + 8, 2], retire: [back + 8, 5], maskOut: [back + 8, 8] }, lx, ly, pcRow: F + 18, back, bottom };
}

interface GWire { y0: number; ys: number[]; x?: number }

/** Crossings between gather wires: out of a lane along y0, down column x, into the pins at ys. */
function crossings(wires: (GWire & { x: number })[], x0: number, x1: number): number {
  type Seg = { net: number; h: boolean; c: number; a: number; b: number };
  const segs: Seg[] = [];
  wires.forEach((w, net) => {
    segs.push({ net, h: true, c: w.y0, a: x0, b: w.x });
    segs.push({ net, h: false, c: w.x, a: Math.min(w.y0, ...w.ys), b: Math.max(w.y0, ...w.ys) });
    for (const y of w.ys) segs.push({ net, h: true, c: y, a: w.x, b: x1 });
  });
  let k = 0;
  for (const h of segs) if (h.h) for (const v of segs) {
    if (v.h || v.net === h.net) continue;
    const lo = Math.min(h.a, h.b), hi = Math.max(h.a, h.b);
    if (v.c > lo && v.c < hi && h.c > v.a && h.c < v.b) k++;
  }
  return k;
}

/** A column per gather wire, by pairwise swaps from the order of their rows (deterministic). */
function columns(wires: GWire[], x0: number, x1: number): number[] {
  const m = wires.length, slots = Array.from({ length: m }, (_, i) => x0 + 4 + 1.5 * i);
  const order = wires.map((_, i) => i).sort((a, b) => wires[a].y0 - wires[b].y0);
  const xs = (o: number[]) => { const out = new Array<number>(m); o.forEach((w, i) => (out[w] = slots[i])); return out; };
  const cost = (o: number[]) => { const x = xs(o); return crossings(wires.map((w, i) => ({ ...w, x: x[i] })), x0, x1); };
  let best = cost(order);
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      [order[i], order[j]] = [order[j], order[i]];
      const c = cost(order);
      if (c < best) { best = c; improved = true; } else [order[i], order[j]] = [order[j], order[i]];
    }
    if (!improved) break;
  }
  return xs(order);
}

/** Pairs inside the control cluster and the fetch row that are drawn as wires too (driver > sink). */
const LOCAL = [
  'pcmux.y>jmux.a', 'jmux.y>pc.d', 'si.o4>csrA.i0', 'si.o5>csrA.i1', 'pc.q>imem.addr', 'imem.data>si.in', 'ctl.resultSrc>rs.in', 'rs.o0>isLoad.a', 'rs.o1>nr1.a', 'nr1.y>isLoad.b',
  'isLoad.y>isMemG.a', 'ctl.regWrite>rw.a', 'wsel.y>weg.a', 'wf.out>weg.b', 'weg.y>we.in', 'nst.y>pcen.a', 'gndT.y>target.cin', 'gndJ.y>clr0.zero',
  'lF.y>fs.in', 'dwe.y>dm.we', 'mAd.y>dm.addr', 'mWd.y>dm.wd',
  'fs.o0>npc.zero', 'fs.o1>npc.neg', 'fs.o2>npc.ovf', 'fs.o3>npc.carry', 'tid0.y>lane0.tid', 'tid1.y>lane1.tid', 'tid2.y>lane2.tid', 'tid3.y>lane3.tid', 'csrA.out>sdec.csr', 'mseq.served>wsel.b',
];

/** Set the routing hints of the lane core's nets (placed instances, nets as the generator made them). */
export function wireLaneCore(n: number, instances: Inst[], nets: NetDef[], lay: LaneLayout): void {
  const inst = new Map(instances.map((i) => [i.name, i]));
  const P = (end: string): Pt => {
    const [nm, port] = end.split('.');
    const i = inst.get(nm)!, g = symbolGeom(i.def).ports[port].pos;
    return [i.at![0] + g[0], i.at![1] + g[1]];
  };
  const net = (drv: string) => nets.find((x) => x.ends[0] === drv)!;
  const wired = new Set<string>(LOCAL);
  const route = (drv: string, sink: string, via: Pt[]) => {
    const nt = net(drv);
    nt.via = { ...nt.via, [sink]: via };
    wired.add(`${drv}>${sink}`);
  };
  // broadcast: along the row, down the trunk, a stub into each lane's pin
  const X0 = 146, dx = 1.5;
  BROADCAST.slice(0, -1).forEach(([drv, port], t) => {
    for (const s of net(drv).ends.slice(1)) {
      const m = /^lane(\d+)\.(\w+)$/.exec(s);
      if (m && m[2] === port) route(drv, s, [[X0 - dx * t, P(s)[1]]]);
    }
  });
  // the PC: down beside the fetch row, then along its own row (y = F + 18) under the ROM
  {
    const nt = net('pc.q'), t = BROADCAST.findIndex((b) => b[0] === 'pc.q');
    route('pc.q', 'plus4.a', [[55, P('plus4.a')[1]]]);
    for (const s of nt.ends.slice(1)) if (/^lane/.test(s)) route('pc.q', s, [[55, lay.pcRow], [X0 - dx * t, lay.pcRow], [X0 - dx * t, P(s)[1]]]);
  }
  // the instruction's fields up to the decoders, in columns: the lower the row, the further right
  route('si.o0', 'ctl.op', [[86, P('ctl.op')[1]]]); route('si.o0', 'sdec.op', [[86, P('sdec.op')[1]]]);
  route('si.o2', 'ctl.funct3', [[88, P('ctl.funct3')[1]]]); route('si.o2', 'sdec.funct3', [[88, P('sdec.funct3')[1]]]);
  route('si.o3', 'sdec.rs1', [[88.5, P('sdec.rs1')[1]]]);
  route('si.o4', 'csrA.i0', [[89, P('csrA.i0')[1]]]);
  route('si.o5', 'ctl.funct7', [[90, P('ctl.funct7')[1]]]); route('si.o5', 'csrA.i1', [[90, P('csrA.i1')[1]]]);
  route('imem.data', 'imm.instr', [[77, P('imm.instr')[1]]]);
  // the SIMT decode into SIMT control, each row up to its pin: the lower the row, the further right
  ['isTmc', 'isSplit', 'isJoin', 'isPred'].forEach((p, i) => route(`sdec.${p}`, `simt.${p}`, [[160 + 2 * i, P(`simt.${p}`)[1]]]));
  route('isMemG.y', 'mseq.isMem', [[187, P('mseq.isMem')[1]]]);
  route('mseq.stall', 'nst.a', [[214, P('nst.a')[1]]]);
  // the leader's select down a collector beside the multiplexers, into each one's bottom pin
  for (const s of net('lead.y').ends.slice(1)) route('lead.y', s, [[229, P(s)[1] + 2], [P(s)[0], P(s)[1] + 2]]);
  route('ctl.resultSrc', 'rs.in', [[150, P('rs.in')[1]]]);
  route('ctl.regWrite', 'rw.a', [[170, P('rw.a')[1]]]);
  route('ctl.memWrite', 'isMemG.b', [[148, 16], [172, 16], [172, P('isMemG.b')[1]]]);
  // the next-PC feedback: PC + 4 under the fetch row, the targets and the select along the bottom, up the left edge
  {
    const left = (name: string) => P(`pcmux.${name}`);
    const low = lay.bottom + 8;
    route('plus4.y', 'pcmux.d0', [[68, 98], [3, 98], [3, left('d0')[1]]]);
    route('plus4.y', 'pcmux.d3', [[68, 98], [6, 98], [6, left('d3')[1]]]);
    route('target.s', 'pcmux.d1', [[262, P('target.s')[1]], [262, low + 9], [4, low + 9], [4, left('d1')[1]]]);
    route('clr0.out', 'pcmux.d2', [[274, P('clr0.out')[1]], [274, low + 6], [5, low + 6], [5, left('d2')[1]]]);
    route('npc.pcSrc', 'pcmux.s', [[260, P('npc.pcSrc')[1]], [260, low + 3], [P('pcmux.s')[0], low + 3]]);
  }
  // the memory's data comes back along the bottom and up the last trunk
  {
    const x = X0 - dx * (BROADCAST.length - 1), bottom = lay.bottom + 8, rx = lay.back;
    for (const s of net('dm.rd').ends.slice(1)) if (/^lane/.test(s)) route('dm.rd', s, [[rx, P('dm.rd')[1]], [rx, bottom], [x, bottom], [x, P(s)[1]]]);
  }
  // gather: lane k's outputs into the multiplexers' port k, in columns
  const gw: { drv: string; y0: number; ys: number[]; sinks: string[] }[] = [];
  for (let k = 0; k < n; k++) for (const o of ['rd1', 'rd2', 'aluY', 'flags', 'nz']) {
    const drv = `lane${k}.${o}`, sinks = net(drv).ends.slice(1).filter((s) => /^(lA|lB|mWd|lAlu|mAd|lF|pm)\./.test(s));
    if (sinks.length) gw.push({ drv, y0: P(drv)[1], ys: sinks.map((s) => P(s)[1]), sinks });
  }
  const cols = columns(gw, lay.lx + 14, P('lA.d0')[0]);
  gw.forEach((w, i) => w.sinks.forEach((s, j) => route(w.drv, s, [[cols[i], w.ys[j]]])));
  for (const nt of nets) {
    const rest = nt.ends.slice(1).filter((s) => !wired.has(`${nt.ends[0]}>${s}`));
    if (rest.length === nt.ends.length - 1) nt.tags = true;
    else if (rest.length) nt.tags = rest;
    else delete nt.tags;
  }
  for (const nt of nets) if (QUIET.includes(nt.name ?? '')) nt.quiet = true;
}
