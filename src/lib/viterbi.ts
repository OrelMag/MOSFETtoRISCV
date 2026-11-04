// Chapter 47's convolutional code in gates: the encoder (a shift register and two XOR trees) and a Viterbi decoder for any K, one add-compare-select
// and one register-exchange survivor per state. The rules are comm/conv.ts's header; tests/comm-codes-gates.test.ts compares every metric, select
// and output every clock with that model, at K = 3 and at K = 7, hard and with three-bit levels.

import { convStep, defaultDepth, metricWidth, statesOf, CONV_K3, type ConvSpec } from '../comm/conv';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { busMux2, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { NOT, XOR } from './gates';
import { clearableRegister } from './pipeline';
import { DFFE, register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

const tagOf = (s: ConvSpec) => `${s.K}_${s.g[0].toString(8)}_${s.g[1].toString(8)}`;

/** Inverters on every bit of a bus. */
export function notBus(w: number): ComponentDef {
  return memo(`notbus${w}`, () => {
    const P = 4, mid = (P * w) / 2;
    const instances: InstanceDef[] = [{ name: 'sp', def: splitter(ones(w), P), at: [4, 2] }, { name: 'mg', def: merger(ones(w), P), at: [16, 2] }];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sp.in'] }, { name: 'y', ends: ['mg.out', 'y'] }];
    for (let i = 0; i < w; i++) {
      instances.push({ name: `n${i}`, def: NOT, at: [9, 2 + P * i + 1] });
      nets.push({ name: `a${i}`, ends: [`sp.o${i}`, `n${i}.a`] }, { name: `y${i}`, ends: [`n${i}.y`, `mg.i${i}`] });
    }
    const M = 2 ** w - 1;
    return define({
      id: `notbus${w}`, name: `${w}-bit inverter`, category: 'gate', summary: `One NOT per bit, ${w} NANDs.`,
      ports: [bus('a', w, 'in'), bus('y', w, 'out')], symbol: { kind: 'box', label: 'NOT', w: 6, h: 4 },
      spec: ([a]) => [M - a],
      netlist: () => ({ pins: { a: [0, 2 + mid], y: [22, 2 + mid] }, instances, nets }),
    });
  });
}

/** The encoder: u and the K - 1 flip-flops of state through each generator's XOR tree. a and b follow u at once; en clocks u in. */
export function convEncoder(s: ConvSpec = CONV_K3): ComponentDef {
  return memo(`convenc${tagOf(s)}`, () => {
    const g = symbolGeom(DFFE), xg = symbolGeom(XOR), n = s.K - 1, PX = g.w + 8, X0 = 10, Y0 = 4;
    const rowA = Y0 + g.h + 6, rowB = rowA + 8, stepX = xg.w + 6;
    const nameOf = (b: number) => (b === s.K - 1 ? 'u' : `s${b}`); // reg bit: K - 1 is the input, K - 2 the newest flip-flop
    const instances: InstanceDef[] = [];
    const nets: NetDef[] = [];
    const sinks = new Map<number, string[]>();
    const tap = (b: number, sink: string) => { if (!sinks.has(b)) sinks.set(b, []); sinks.get(b)!.push(sink); };
    let width = 0;
    const trees = [s.g[0], s.g[1]].map((poly, t) => {
      const bits: number[] = [];
      for (let b = s.K - 1; b >= 0; b--) if ((poly >> b) & 1) bits.push(b);
      const pre = t ? 'xb' : 'xa', y = t ? rowB : rowA;
      for (let i = 1; i < bits.length; i++) {
        instances.push({ name: `${pre}${i}`, def: XOR, at: [X0 + stepX * (i - 1), y] });
        if (i === 1) tap(bits[0], `${pre}${i}.a`);
        else nets.push({ name: `${pre}w${i}`, ends: [`${pre}${i - 1}.y`, `${pre}${i}.a`] });
        tap(bits[i], `${pre}${i}.b`);
      }
      width = Math.max(width, X0 + stepX * (bits.length - 1));
      return { last: `${pre}${bits.length - 1}.y`, y };
    });
    for (let i = 0; i < n; i++) instances.push({ name: `ff${s.K - 2 - i}`, def: DFFE, at: [X0 + PX * i, Y0] });
    const en = ['en'], ck = ['clk'];
    for (let i = 0; i < n; i++) { const b = s.K - 2 - i; en.push(`ff${b}.en`); ck.push(`ff${b}.clk`); }
    for (let b = s.K - 1; b >= 0; b--) {
      const ends = b === s.K - 1 ? ['u'] : [`ff${b}.q`];
      if (b > 0) ends.push(`ff${b - 1}.d`);
      ends.push(...(sinks.get(b) ?? []));
      nets.push({ name: nameOf(b), ends, tags: true });
    }
    nets.push({ name: 'en', ends: en, tags: true }, { name: 'clk', ends: ck, tags: true });
    const R = Math.max(X0 + PX * n, width) + 4;
    nets.push({ name: 'a', ends: [trees[0].last, 'a'] }, { name: 'b', ends: [trees[1].last, 'b'] });
    return define({
      id: `convenc${tagOf(s)}`, name: `Convolutional encoder, ${s.name}`, category: 'gate',
      summary: `Rate 1/2: each input bit makes two output bits, the parity of the input and the last ${n} bits under generators ${s.g[0].toString(8)} and ${s.g[1].toString(8)} octal. ${n} flip-flops and a few XOR gates.`,
      ports: [bit('u', 'in'), bit('en', 'in'), clk(), bit('a', 'out'), bit('b', 'out')], symbol: { kind: 'box', label: 'CONV' },
      netlist: () => ({ pins: { u: [0, Y0 + 2], en: [0, Y0 + 6], clk: [0, Y0 + 9], a: [R, trees[0].y + 2], b: [R, trees[1].y + 2] }, instances, nets }),
    });
  });
}

/** The four branch metrics: for each expected pair, the sum over both levels of the level or its complement. */
export function vitBranch(q: number, w: number): ComponentDef {
  return memo(`vitbm${q}_${w}`, () => {
    const A = rca(q), N = notBus(q), ag = symbolGeom(A), ng = symbolGeom(N), pad = w - q - 1;
    const Mg = merger(pad > 0 ? [q, 1, pad] : [q, 1], 2), mg = symbolGeom(Mg), P = Math.max(ag.h, mg.h) + 4, XA = 22, XM = XA + ag.w + 6, XR = XM + mg.w + 6;
    const instances: InstanceDef[] = [{ name: 'n0', def: N, at: [8, 2] }, { name: 'n1', def: N, at: [8, 2 + ng.h + 4] }, { name: 'tie', def: TIE0, at: [XA - 5, 0] }];
    if (pad > 0) instances.push({ name: 'zero', def: constWord(pad, 0), at: [XM - 4, 2 + P * 4] });
    const pairs = [[0, 0], [0, 1], [1, 0], [1, 1]];
    const nets: NetDef[] = [];
    const r0 = ['r0', 'n0.a'], r1 = ['r1', 'n1.a'], nr0 = ['n0.y'], nr1 = ['n1.y'], cin = ['tie.y'], zero = ['zero.y'];
    pairs.forEach(([e0, e1], i) => {
      const nm = `${e0}${e1}`, y = 2 + P * i;
      instances.push({ name: `add${nm}`, def: A, at: [XA, y] }, { name: `m${nm}`, def: Mg, at: [XM, y] });
      (e0 ? nr0 : r0).push(`add${nm}.a`);
      (e1 ? nr1 : r1).push(`add${nm}.b`);
      cin.push(`add${nm}.cin`);
      if (pad > 0) zero.push(`m${nm}.i2`);
      nets.push({ name: `sum${nm}`, ends: [`add${nm}.s`, `m${nm}.i0`] }, { name: `c${nm}`, ends: [`add${nm}.cout`, `m${nm}.i1`], tags: true }, { name: `b${nm}`, ends: [`m${nm}.out`, `b${nm}`] });
    });
    nets.push({ name: 'r0', ends: r0, tags: true }, { name: 'r1', ends: r1, tags: true }, { name: 'nr0', ends: nr0, tags: true }, { name: 'nr1', ends: nr1, tags: true }, { name: 'cin', ends: cin, tags: true });
    if (pad > 0) nets.push({ name: 'zero', ends: zero, tags: true });
    const pins: Record<string, [number, number]> = { r0: [0, 2 + ng.ports.a.pos[1]], r1: [0, 6 + ng.h + ng.ports.a.pos[1]] };
    pairs.forEach(([e0, e1], i) => { pins[`b${e0}${e1}`] = [XR, 2 + P * i + mg.ports.out.pos[1]]; });
    const max = 2 ** q - 1;
    return define({
      id: `vitbm${q}_${w}`, name: `Branch metrics, ${q}-bit levels`, category: 'arithmetic',
      summary: 'How far the received pair is from each of the four pairs the encoder can send: with hard decisions the Hamming distance, with soft levels the sum of each level\'s distance from its sure value. Four adders and two inverters, shared by every state.',
      ports: [bus('r0', q, 'in'), bus('r1', q, 'in'), bus('b00', w, 'out'), bus('b01', w, 'out'), bus('b10', w, 'out'), bus('b11', w, 'out')], symbol: { kind: 'box', label: 'BM' },
      spec: ([a, b]) => pairs.map(([e0, e1]) => (e0 ? max - a : a) + (e1 ? max - b : b)),
      netlist: () => ({ pins, instances, nets }),
    });
  });
}

/** Add, compare, select: two candidates, the sign of their w-bit difference (the metrics wrap), the winner. A tie takes m0's. */
export function vitAcs(w: number): ComponentDef {
  return memo(`vitacs${w}`, () => {
    const A = rca(w), N = notBus(w), M = busMux2(w), S = splitter([w - 1, 1], 2);
    const ag = symbolGeom(A), ng = symbolGeom(N), mg = symbolGeom(M), sg = symbolGeom(S);
    const X0 = 8, Y1 = ag.h + 8, Y2 = Y1 + ag.h + 6, XN = X0 + ag.w + 8, XS = XN + ng.w + 6, XP = XS + ag.w + 6, XM = XS + 6, R = Math.max(XP + sg.w + 8, XM + mg.w + 8);
    const instances: InstanceDef[] = [
      { name: 'add0', def: A, at: [X0, 3], label: 'm0 + b0' },
      { name: 'add1', def: A, at: [X0, Y1], label: 'm1 + b1' },
      { name: 'nc0', def: N, at: [XN, Y2] },
      { name: 'cmp', def: A, at: [XS, Y2], label: 'c1 − c0' },
      { name: 'one', def: TIE1, at: [XS - 2, Y2 - 5] },
      { name: 'zero', def: TIE0, at: [X0 - 5, 0] },
      { name: 'top', def: S, at: [XP, Y2] },
      { name: 'pick', def: M, at: [XM, 3], label: 'winner' },
    ];
    const nets: NetDef[] = [
      { name: 'm0', ends: ['m0', 'add0.a'] }, { name: 'b0', ends: ['b0', 'add0.b'], tags: true },
      { name: 'm1', ends: ['m1', 'add1.a'], tags: true }, { name: 'b1', ends: ['b1', 'add1.b'], tags: true },
      { name: 'cin', ends: ['zero.y', 'add0.cin', 'add1.cin'], tags: true },
      { name: 'c0', ends: ['add0.s', 'nc0.a', 'pick.a'], tags: true },
      { name: 'c1', ends: ['add1.s', 'cmp.a', 'pick.b'], tags: true },
      { name: 'nc', ends: ['nc0.y', 'cmp.b'] },
      { name: 'one', ends: ['one.y', 'cmp.cin'], tags: true },
      { name: 'diff', ends: ['cmp.s', 'top.in'] },
      { name: 'sel', ends: ['top.o1', 'pick.s', 'sel'], tags: true },
      { name: 'm', ends: ['pick.y', 'm'] },
    ];
    const H = 2 ** w, H2 = H / 2;
    return define({
      id: `vitacs${w}`, name: `Add-compare-select, ${w}-bit metrics`, category: 'arithmetic',
      summary: `The Viterbi decoder's core: extend the two paths into this state, keep the cheaper. The metrics wrap at ${w} bits, so the comparison is the top bit of the w-bit difference: three ${w}-bit adders and a multiplexer.`,
      ports: [bus('m0', w, 'in'), bus('b0', w, 'in'), bus('m1', w, 'in'), bus('b1', w, 'in'), bus('m', w, 'out'), bit('sel', 'out')], symbol: { kind: 'box', label: 'ACS' },
      spec: ([m0, b0, m1, b1]) => { const c0 = (m0 + b0) % H, c1 = (m1 + b1) % H, s = (c1 - c0 + H) % H >= H2 ? 1 : 0; return [s ? c1 : c0, s]; },
      netlist: () => ({ pins: { m0: [0, 3 + ag.ports.a.pos[1]], b0: [0, 3 + ag.ports.b.pos[1]], m1: [0, Y1 + ag.ports.a.pos[1]], b1: [0, Y1 + ag.ports.b.pos[1]], m: [R, 3 + mg.ports.y.pos[1]], sel: [R, Y2 + 2] }, instances, nets }),
    });
  });
}

/** One state: its ACS, its metric register, its survivor register, which takes the winner's survivor shifted left with this state's input bit below. */
export function vitSlice(w: number, D: number, u: number): ComponentDef {
  return memo(`vitslice${w}_${D}_${u}`, () => {
    const ACS = vitAcs(w), MR = clearableRegister(w), SM = busMux2(D), SR = register(D), SP = splitter([D - 1, 1], 2), MG = merger([1, D - 1], 2);
    const a = symbolGeom(ACS), r = symbolGeom(MR), sm = symbolGeom(SM), sr = symbolGeom(SR), sp = symbolGeom(SP), mg = symbolGeom(MG);
    const X1 = 8, X2 = X1 + a.w + 10, Y2 = Math.max(a.h, r.h) + 8, X3 = X1 + sm.w + 6, X4 = X3 + sp.w + 6, X5 = X4 + mg.w + 6, R = Math.max(X2 + r.w + 8, X5 + sr.w + 8);
    const instances: InstanceDef[] = [
      { name: 'acs', def: ACS, at: [X1, 2] },
      { name: 'mreg', def: MR, at: [X2, 2], label: 'path metric' },
      { name: 'pick', def: SM, at: [X1, Y2] },
      { name: 'cut', def: SP, at: [X3, Y2] },
      { name: 'bit', def: u ? TIE1 : TIE0, at: [X4 - 3, Y2 - 3] },
      { name: 'join', def: MG, at: [X4, Y2] },
      { name: 'sreg', def: SR, at: [X5, Y2], label: 'survivor' },
    ];
    const nets: NetDef[] = [
      { name: 'm0', ends: ['m0', 'acs.m0'] }, { name: 'b0', ends: ['b0', 'acs.b0'] }, { name: 'm1', ends: ['m1', 'acs.m1'] }, { name: 'b1', ends: ['b1', 'acs.b1'] },
      { name: 'next', ends: ['acs.m', 'mreg.d'] },
      { name: 'sel', ends: ['acs.sel', 'pick.s', 'sel'], tags: true },
      { name: 's0', ends: ['s0', 'pick.a'] }, { name: 's1', ends: ['s1', 'pick.b'] },
      { name: 'win', ends: ['pick.y', 'cut.in'] },
      { name: 'low', ends: ['cut.o0', 'join.i1'] },
      { name: 'u', ends: ['bit.y', 'join.i0'] },
      { name: 'snext', ends: ['join.out', 'sreg.d'] },
      { name: 'en', ends: ['en', 'mreg.en', 'sreg.en'], tags: true },
      { name: 'rst', ends: ['rst', 'mreg.clr'], tags: true },
      { name: 'clk', ends: ['clk', 'mreg.clk', 'sreg.clk'], tags: true },
      { name: 'm', ends: ['mreg.q', 'm'] }, { name: 's', ends: ['sreg.q', 's'] },
    ];
    return define({
      id: `vitslice${w}_${D}_${u}`, name: `Viterbi state, ${w}-bit metric, ${D}-bit survivor (input ${u})`, category: 'sequential',
      summary: `One trellis state: the cheaper of its two incoming paths, the metric of that path, and the ${D} most recent input bits along it. Register exchange: every state's survivor is rewritten every clock, which is why it is simple and why it is large.`,
      ports: [bus('m0', w, 'in'), bus('b0', w, 'in'), bus('m1', w, 'in'), bus('b1', w, 'in'), bus('s0', D, 'in'), bus('s1', D, 'in'), bit('en', 'in'), bit('rst', 'in'), clk(), bus('m', w, 'out'), bus('s', D, 'out'), bit('sel', 'out')],
      symbol: { kind: 'box', label: `S${u}` },
      netlist: () => ({ pins: { m0: [0, 2 + a.ports.m0.pos[1]], b0: [0, 2 + a.ports.b0.pos[1]], m1: [0, 2 + a.ports.m1.pos[1]], b1: [0, 2 + a.ports.b1.pos[1]], s0: [0, Y2 + sm.ports.a.pos[1]], s1: [0, Y2 + sm.ports.b.pos[1]], en: [0, Y2 + sm.h + 3], rst: [0, Y2 + sm.h + 6], clk: [0, Y2 + sm.h + 9], m: [R, 2 + r.ports.q.pos[1]], s: [R, Y2 + sr.ports.q.pos[1]], sel: [R, Y2 + sr.h + 3] }, instances, nets }),
    });
  });
}

export interface ViterbiGates { q?: number; depth?: number }

/** The decoder. Every state's slice is one box, the trellis is the labels between them: m<i>, s<i> a state's metric and survivor, b<e0><e1> a branch metric. */
export function viterbi(s: ConvSpec = CONV_K3, o: ViterbiGates = {}): ComponentDef {
  const q = o.q ?? 1, D = o.depth ?? defaultDepth(s.K), w = metricWidth(s.K, q), n = statesOf(s);
  return memo(`viterbi${tagOf(s)}_${q}_${D}`, () => {
    const BM = vitBranch(q, w), bg = symbolGeom(BM), S0 = vitSlice(w, D, 0), g = symbolGeom(S0), T = splitter([D - 1, 1], 2), tg = symbolGeom(T);
    const cols = n <= 4 ? 2 : 8, PX = g.w + 12, PY = g.h + 6, X0 = bg.w + 18, Y0 = 3;
    const instances: InstanceDef[] = [{ name: 'bm', def: BM, at: [8, Y0], label: 'branch metrics' }];
    const nets: NetDef[] = [{ name: 'r0', ends: ['r0', 'bm.r0'] }, { name: 'r1', ends: ['r1', 'bm.r1'] }];
    const bEnds = new Map<string, string[]>([['00', ['bm.b00']], ['01', ['bm.b01']], ['10', ['bm.b10']], ['11', ['bm.b11']]]);
    const mE: string[][] = [], sE: string[][] = [], en = ['en'], rst = ['rst'], ck = ['clk'];
    for (let i = 0; i < n; i++) { mE.push([`u${i}.m`]); sE.push([`u${i}.s`]); }
    const mask = n - 1;
    for (let ns = 0; ns < n; ns++) {
      const u = ns >>> (s.K - 2), p0 = (ns << 1) & mask, p1 = p0 | 1, nm = `u${ns}`;
      instances.push({ name: nm, def: vitSlice(w, D, u), at: [X0 + PX * (ns % cols), Y0 + PY * Math.floor(ns / cols)], label: `state ${ns.toString(2).padStart(s.K - 1, '0')}` });
      for (const [j, p] of [p0, p1].entries()) {
        const e = convStep(s, p, u);
        bEnds.get(`${e.a}${e.b}`)!.push(`${nm}.b${j}`);
        mE[p].push(`${nm}.m${j}`);
        sE[p].push(`${nm}.s${j}`);
      }
      en.push(`${nm}.en`); rst.push(`${nm}.rst`); ck.push(`${nm}.clk`);
    }
    for (const [k, ends] of bEnds) if (ends.length > 1) nets.push({ name: `b${k}`, ends, tags: true });
    for (let i = 0; i < n; i++) { nets.push({ name: `m${i}`, ends: mE[i], tags: true }); if (i === 0) sE[i].push('top.in'); nets.push({ name: `s${i}`, ends: sE[i], tags: true }); }
    nets.push({ name: 'en', ends: en, tags: true }, { name: 'rst', ends: rst, tags: true }, { name: 'clk', ends: ck, tags: true }, { name: 'out', ends: ['top.o1', 'out'] });
    const XT = X0 + PX * cols;
    instances.push({ name: 'top', def: T, at: [XT, Y0] });
    return define({
      id: `viterbi${tagOf(s)}_${q}_${D}`, name: `Viterbi decoder, ${s.name}, ${q}-bit levels`, category: 'sequential',
      summary: `Maximum-likelihood decoding by dynamic programming: ${n} states, each with an add-compare-select, a ${w}-bit metric that wraps, and a ${D}-bit survivor. out is the oldest bit of state 0's survivor, the input bit from ${D} steps ago.`,
      ports: [bus('r0', q, 'in'), bus('r1', q, 'in'), bit('en', 'in'), bit('rst', 'in'), clk(), bit('out', 'out')], symbol: { kind: 'box', label: 'VITERBI' },
      netlist: () => ({ pins: { r0: [0, Y0 + bg.ports.r0.pos[1]], r1: [0, Y0 + bg.ports.r1.pos[1]], en: [0, Y0 + bg.h + 3], rst: [0, Y0 + bg.h + 6], clk: [0, Y0 + bg.h + 9], out: [XT + tg.w + 6, Y0 + tg.ports.o1.pos[1]] }, instances, nets }),
    });
  });
}
