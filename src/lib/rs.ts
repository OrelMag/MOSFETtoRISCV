// Chapter modem's Reed-Solomon in gates: multiplying by a constant in GF(256) is linear over GF(2), so it is an XOR network read off the golden model
// (comm/crc.ts xorPlan, as the CRC's); the encoder is the textbook LFSR over bytes, one such multiplier a generator coefficient; the syndrome unit
// evaluates the received word at each root. A general multiplier sizes what a decoder would need: the decoder itself is only in comm/rs.ts.
// tests/comm-codes-gates.test.ts compares every register every clock, and the encoder ends on the published QR check bytes.

import { xorPlan, type XorPlan } from '../comm/crc';
import { gfMul, gfPow, rsGenerator } from '../comm/rs';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { busMux2 } from './combinational';
import { define, merger, ones, splitter } from './define';
import { fanout } from './fastadd';
import { AND, XOR } from './gates';
import { clearableRegister } from './pipeline';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);
const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** One gate of an XOR network as built: its output driver and the two it reads. */
export interface XorGate { out: string; srcs: [string, string] }

/**
 * Lay out an XOR network's gates to cross as little as it allows: each column's gates sit on a 6-unit pitch about the sources' middle, and
 * their order is searched (swaps that reduce the crossings of the straight lines between pins, wires skipping a column counted heavily).
 * Sources stay where they are and the merger follows the last gates. Only instance `at` changes.
 */
export function arrangeXor(b: Builder, gates: XorGate[], outs: string[], merge: string): void {
  if (!gates.length) return;
  const U = 3, byName = new Map(b.instances.map((i) => [i.name, i]));
  const instOf = (end: string) => byName.get(end.slice(0, end.indexOf('.')))!;
  const colOf = new Map<number, XorGate[]>();
  for (const g of gates) { const x = instOf(g.out).at![0]; (colOf.get(x) ?? colOf.set(x, []).get(x)!).push(g); }
  const xs = [...colOf.keys()].sort((p, q) => p - q), cols = xs.map((x) => colOf.get(x)!);
  const mi = byName.get(merge)!, mg = symbolGeom(mi.def), gg = symbolGeom(instOf(gates[0].out).def);
  const srcY = gates.flatMap((g) => g.srcs).filter((d) => !gates.some((x) => x.out === d)).map((d) => instOf(d).at![1] + symbolGeom(instOf(d).def).ports[d.slice(d.indexOf('.') + 1)].pos[1]);
  const mid = (Math.min(...srcY) + Math.max(...srcY)) / 2;
  // a gate's place is a slot of U units (a gate is two slots tall, so neighbours are two apart at least), about the middle of the sources
  const slotOf = new Map<XorGate, number>();
  let mOff = 0;
  cols.forEach((c) => c.forEach((g, i) => slotOf.set(g, 2 * i - (c.length - 1))));
  const place = () => {
    for (const [g, k] of slotOf) instOf(g.out).at![1] = Math.round(mid - gg.h / 2 + k * U);
    const ys = outs.map((o, i) => pinOf(o)[1] - mg.ports[`i${i}`].pos[1]);
    mi.at![1] = Math.round(ys.reduce((p, q) => p + q, 0) / ys.length) + mOff;
  };
  const pinOf = (end: string): [number, number] => { const i = instOf(end), p = symbolGeom(i.def).ports[end.slice(end.indexOf('.') + 1)].pos; return [i.at![0] + p[0], i.at![1] + p[1]]; };
  const edges = (): [[number, number], [number, number], string][] => [
    ...gates.flatMap((g) => g.srcs.map((d, k): [[number, number], [number, number], string] => [pinOf(d), [instOf(g.out).at![0], instOf(g.out).at![1] + gg.ports[k ? 'b' : 'a'].pos[1]], d])),
    ...outs.map((o, i): [[number, number], [number, number], string] => [pinOf(o), [mi.at![0], mi.at![1] + mg.ports[`i${i}`].pos[1]], o]),
  ];
  const fan = new Map<string, number>();
  for (const [, , d] of edges()) fan.set(d, (fan.get(d) ?? 0) + 1);
  const nearSource = (d: string) => gates.some((g) => g.out === d) || fan.get(d)! > 1;
  const ori = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const cost = () => {
    place();
    const es = edges();
    let c = 0;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const [a, b2, da] = es[i], [c2, d2, dc] = es[j];
      if (da === dc || (a[0] === c2[0] && a[1] === c2[1]) || (b2[0] === d2[0] && b2[1] === d2[1])) continue;
      if (ori(a, b2, c2) * ori(a, b2, d2) < 0 && ori(c2, d2, a) * ori(c2, d2, b2) < 0) c++;
    }
    // a wire skipping a column runs under that column's gates
    // a wire that skips a column runs level across it, at the sink's height when its vertical is by the driver (xorTrunks), else at the driver's
    for (const [a, b2, d] of es) {
      const y = nearSource(d) ? b2[1] : a[1];
      for (const gs of cols) { const x = instOf(gs[0].out).at![0]; if (a[0] < x && b2[0] > x + gg.w && gs.some((g) => y > instOf(g.out).at![1] - 1 && y < instOf(g.out).at![1] + gg.h + 1)) c += 3; }
    }
    return c * 100 + es.reduce((p, [a, b2]) => p + Math.abs(a[1] - b2[1]), 0) / 10;
  };
  // start from the barycentre of each gate's sources, then swap or shift gates while it helps
  for (const c of cols) {
    c.sort((p, q) => (pinOf(p.srcs[0])[1] + pinOf(p.srcs[1])[1]) - (pinOf(q.srcs[0])[1] + pinOf(q.srcs[1])[1]));
    c.forEach((g, i) => slotOf.set(g, 2 * i - (c.length - 1)));
  }
  let best = cost();
  const shiftMerger = () => { for (const d of [-3, -2, -1, 1, 2, 3]) { const k = mOff; mOff += d; const v = cost(); if (v < best) { best = v; return true; } mOff = k; } return false; };
  for (let again = true, rounds = 0; again && rounds < 12; rounds++) {
    again = shiftMerger();
    for (const c of cols) for (const g of c) {
      const k0 = slotOf.get(g)!;
      for (const k of [k0 - 3, k0 - 2, k0 - 1, k0 + 1, k0 + 2, k0 + 3]) {
        const other = c.find((x) => x !== g && Math.abs(slotOf.get(x)! - k) < 2);
        if (other) { // swap with a neighbour that is in the way, when it is the exact place
          if (slotOf.get(other) !== k) continue;
          slotOf.set(g, k); slotOf.set(other, k0);
          if (c.some((x) => c.some((y) => x !== y && Math.abs(slotOf.get(x)! - slotOf.get(y)!) < 2))) { slotOf.set(g, k0); slotOf.set(other, k); continue; }
          const v = cost();
          if (v < best) { best = v; again = true; break; }
          slotOf.set(g, k0); slotOf.set(other, k);
        } else {
          slotOf.set(g, k);
          const v = cost();
          if (v < best) { best = v; again = true; break; }
          slotOf.set(g, k0);
        }
      }
    }
  }
  place();
  const top = Math.min(2, ...b.instances.map((i) => i.at![1]));
  if (top < 2) for (const i of b.instances) i.at![1] += 2 - top;
}

/** The builder's nets, those a gate drives with their vertical run in the gap right after it (not mid-way, where a wire skipping a column would run into that column's gates). */
const xorTrunks = (b: Builder, gates: XorGate[]): NetDef[] => {
  const at = new Map(b.instances.map((i) => [i.name, i.at![0]]));
  const x = (end: string) => at.get(end.slice(0, end.indexOf('.')))!;
  return b.nets().map((n) => {
    if (!n.ends[0].includes('.') || n.ends.length < 2) return n;
    if (gates.some((g) => g.out === n.ends[0])) return { ...n, trunk: x(n.ends[0]) + 7 };
    return { ...n, trunk: n.ends.length > 2 ? x(n.ends[0]) + 4 : x(n.ends[1]) - 4 }; // a source's: by it, or by its one sink
  });
};

/** The plan's XOR gates over `srcs`, one column per level; returns each output's driver. */
export function xorColumns(b: Builder, plan: XorPlan, srcs: string[], gates?: XorGate[]): string[] {
  const inputs = srcs.length, level = new Array<number>(inputs).fill(0), gate: string[] = [];
  plan.pairs.forEach(([x, y], k) => { level[inputs + k] = Math.max(level[x], level[y]) + 1; });
  const drv = (id: number) => (id < inputs ? srcs[id] : gate[id - inputs]);
  for (let lv = 1; lv <= plan.depth; lv++) {
    b.next();
    plan.pairs.forEach(([x, y], k) => { if (level[inputs + k] === lv) { gate[k] = b.op1(XOR, [drv(x), drv(y)]); gates?.push({ out: gate[k], srcs: [drv(x), drv(y)] }); } });
  }
  b.next();
  return plan.out.map((o) => drv(o));
}

/** y = a · c in GF(256): each output bit an XOR of input bits. */
export function gfConst(c: number): ComponentDef {
  return memo(`gfc${hex2(c)}`, () => {
    const rows: bigint[] = new Array<bigint>(8).fill(0n);
    for (let j = 0; j < 8; j++) { const v = gfMul(1 << j, c); for (let i = 0; i < 8; i++) if ((v >> i) & 1) rows[i] |= 1n << BigInt(j); }
    const b = new Builder(8, 10, 2), P = 6;
    b.pins('a');
    const sp = b.op(splitter(ones(8), P), ['a']);
    const gates: XorGate[] = [];
    const outs = xorColumns(b, xorPlan(rows, 8, true), Array.from({ length: 8 }, (_, i) => `${sp}.o${i}`), gates);
    const mg = b.op(merger(ones(8), P), outs);
    b.wire(`${mg}.out`, 'y');
    arrangeXor(b, gates, outs, mg);
    const pa = symbolGeom(splitter(ones(8), P)).ports.in.pos[1] + 2, py = b.instances.find((i) => i.name === mg)!.at![1] + symbolGeom(merger(ones(8), P)).ports.out.pos[1];
    return define({
      id: `gfc${hex2(c)}`, name: `GF(256) × 0x${hex2(c)}`, category: 'arithmetic',
      summary: `Multiplies a byte by the constant 0x${hex2(c)} in GF(256), field polynomial 0x11D. No multiplier is involved: the map is linear over GF(2), so every output bit is the XOR of a fixed set of input bits.`,
      ports: [bus('a', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: `×${hex2(c)}` },
      spec: ([a]) => [gfMul(a, c)],
      netlist: () => ({ pins: { a: [0, pa], y: [b.right, py] }, instances: b.instances, nets: xorTrunks(b, gates) }),
    });
  });
}

/** A general GF(256) multiplier: 64 ANDs of bit pairs, then XOR trees (each product bit a fixed set of pairs). */
export function gfMulGates(): ComponentDef {
  return memo('gfmul', () => {
    const rows: bigint[] = new Array<bigint>(8).fill(0n);
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { const v = gfMul(1 << x, 1 << y); for (let i = 0; i < 8; i++) if ((v >> i) & 1) rows[i] |= 1n << BigInt(8 * x + y); }
    const b = new Builder(8, 10, 2);
    b.pins('a', 'b');
    const sa = b.op(splitter(ones(8)), ['a']), sb = b.op(splitter(ones(8)), ['b']);
    b.next();
    const srcs: string[] = [];
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) srcs.push(b.op1(AND, [`${sa}.o${x}`, `${sb}.o${y}`]));
    const outs = xorColumns(b, xorPlan(rows, 64, true), srcs);
    b.wire(b.op1(merger(ones(8)), outs), 'y');
    return define({
      id: 'gfmul', name: 'GF(256) multiplier', category: 'arithmetic',
      summary: 'Multiplies two bytes in GF(256), field polynomial 0x11D: the 64 bit products, each XORed into the output bits the reduction sends it to. What a Reed-Solomon decoder needs many of; an encoder only multiplies by constants.',
      ports: [bus('a', 8, 'in'), bus('b', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: 'GF×' },
      spec: ([x, y]) => [gfMul(x, y)],
      netlist: () => ({ pins: { a: [0, 10], b: [0, 40], y: [b.right, 30] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** One LFSR stage: q' = in ^ (f · c), a byte register that clears. */
export function rsStage(c: number): ComponentDef {
  return memo(`rsstage${hex2(c)}`, () => {
    const G = gfConst(c), X = bitwise('xor', 8), R = clearableRegister(8);
    const gg = symbolGeom(G), xg = symbolGeom(X), rg = symbolGeom(R), X1 = 6, X2 = X1 + gg.w + 6, X3 = X2 + xg.w + 6, Rt = X3 + rg.w + 6;
    const yMul = 3, yX = Math.max(1, yMul + gg.ports.y.pos[1] - xg.ports.b.pos[1]), yR = Math.max(1, yX + xg.ports.y.pos[1] - rg.ports.d.pos[1]);
    const yB = Math.max(yMul + gg.h, yX + xg.h, yR + rg.h) + 2;
    const instances: InstanceDef[] = [{ name: 'mul', def: G, at: [X1, yMul] }, { name: 'sum', def: X, at: [X2, yX] }, { name: 'reg', def: R, at: [X3, yR] }];
    const nets: NetDef[] = [
      { name: 'in', ends: ['in', 'sum.a'], tags: true }, { name: 'f', ends: ['f', 'mul.a'] }, { name: 'fm', ends: ['mul.y', 'sum.b'] }, { name: 'next', ends: ['sum.y', 'reg.d'] },
      { name: 'en', ends: ['en', 'reg.en'], tags: true }, { name: 'clr', ends: ['clr', 'reg.clr'], tags: true }, { name: 'clk', ends: ['clk', 'reg.clk'], tags: true }, { name: 'q', ends: ['reg.q', 'q'] },
    ];
    return define({
      id: `rsstage${hex2(c)}`, name: `RS encoder stage, coefficient 0x${hex2(c)}`, category: 'sequential',
      summary: `One byte of the division's remainder: the next stage's byte plus the feedback times the generator coefficient 0x${hex2(c)}.`,
      ports: [bus('in', 8, 'in'), bus('f', 8, 'in'), bit('en', 'in'), bit('clr', 'in'), clk(), bus('q', 8, 'out')], symbol: { kind: 'box', label: `×${hex2(c)}` },
      netlist: () => ({ pins: { in: [0, yB], f: [0, yMul + gg.ports.a.pos[1]], en: [0, yB + 3], clr: [0, yB + 6], clk: [0, yB + 9], q: [Rt, yR + rg.ports.q.pos[1]] }, instances, nets }),
    });
  });
}

const PER_ROW = 5;

/** The encoder: msg = 1 takes a data byte, passes it to out and divides; msg = 0 shifts the remainder out, highest register first. */
export function rsEncoder(nsym = 10): ComponentDef {
  return memo(`rsenc${nsym}`, () => {
    const g = rsGenerator(nsym), St = rsStage(g[1]), sg = symbolGeom(St), X = bitwise('xor', 8), A = bitwise('and', 8), M = busMux2(8), F = fanout(8), Z = constWord(8, 0);
    const xg = symbolGeom(X), ag = symbolGeom(A), mg = symbolGeom(M), PX = Math.max(...g.slice(1).map((c) => symbolGeom(rsStage(c)).w)) + 12, PY = sg.h + 8, X0 = 12, Y0 = Math.max(ag.h, mg.h) + 12;
    const Xa = X0 + xg.w + 12, Xm = Xa + ag.w + 12;
    const instances: InstanceDef[] = [
      { name: 'fsum', def: X, at: [X0, 3], label: 'd + top' },
      { name: 'fan', def: F, at: [Xa - 8, ag.h + 3] },
      { name: 'fgate', def: A, at: [Xa, 3], label: 'feedback' },
      { name: 'pass', def: M, at: [Xm, 3], label: 'data, then check bytes' },
      { name: 'zero', def: Z, at: [2, Y0 + 2] },
    ];
    const f: string[] = ['fgate.y'], en = ['en'], clr = ['clr'], ck = ['clk'];
    const nets: NetDef[] = [
      { name: 'd', ends: ['d', 'fsum.a', 'pass.b'], tags: true },
      { name: 'fraw', ends: ['fsum.y', 'fgate.a'] },
      { name: 'msg', ends: ['msg', 'fan.in', 'pass.s'], tags: true },
      { name: 'fanw', ends: ['fan.out', 'fgate.b'], tags: true },
      { name: 'out', ends: ['pass.y', 'out'] },
    ];
    // stage i holds state[i]: drawn lowest power first, so the bytes shift towards the top register in reading order
    for (let k = 0; k < nsym; k++) {
      const i = nsym - 1 - k, nm = `s${i}`;
      instances.push({ name: nm, def: rsStage(g[i + 1]), at: [X0 + PX * (k % PER_ROW), Y0 + PY * Math.floor(k / PER_ROW)] });
      f.push(`${nm}.f`); en.push(`${nm}.en`); clr.push(`${nm}.clr`); ck.push(`${nm}.clk`);
    }
    nets.push({ name: 'z', ends: ['zero.y', `s${nsym - 1}.in`], tags: true });
    for (let i = 0; i + 1 < nsym; i++) nets.push({ name: `q${i + 1}`, ends: [`s${i + 1}.q`, `s${i}.in`], tags: true });
    nets.push({ name: 'top', ends: ['s0.q', 'fsum.b', 'pass.a'], tags: true }, { name: 'f', ends: f, tags: true }, { name: 'en', ends: en, tags: true }, { name: 'clr', ends: clr, tags: true }, { name: 'clk', ends: ck, tags: true });
    const R = Xm + mg.w + 6;
    return define({
      id: `rsenc${nsym}`, name: `Reed-Solomon encoder, ${nsym} check bytes`, category: 'arithmetic',
      summary: `Polynomial division over GF(256) by a shift register of bytes: ${nsym} registers, a constant multiplier per generator coefficient, one feedback byte. It is the CRC's circuit with bytes for bits.`,
      ports: [bus('d', 8, 'in'), bit('msg', 'in'), bit('en', 'in'), bit('clr', 'in'), clk(), bus('out', 8, 'out')], symbol: { kind: 'box', label: 'RS ENC' },
      netlist: () => ({ pins: { d: [0, 4], msg: [0, 7], en: [0, 10], clr: [0, 13], clk: [0, 16], out: [Math.max(R, X0 + PX * PER_ROW), 3 + mg.ports.y.pos[1]] }, instances, nets }),
    });
  });
}

/** One syndrome: S' = S · α^j + d, a Horner evaluation of the received word at the root α^j. */
export function rsSynStage(j: number): ComponentDef {
  return memo(`rssyn${j}`, () => {
    const G = gfConst(gfPow(j)), X = bitwise('xor', 8), R = clearableRegister(8);
    const gg = symbolGeom(G), xg = symbolGeom(X), rg = symbolGeom(R), X1 = 12, X2 = X1 + gg.w + 6, X3 = X2 + xg.w + 6, Rt = X3 + rg.w + 18;
    const yMul = 3, yX = Math.max(1, yMul + gg.ports.y.pos[1] - xg.ports.a.pos[1]), yR = Math.max(1, yX + xg.ports.y.pos[1] - rg.ports.d.pos[1]), yB = Math.max(yMul + gg.h, yR + rg.h, yX + xg.h) + 2;
    const instances: InstanceDef[] = [{ name: 'mul', def: G, at: [X1, yMul] }, { name: 'sum', def: X, at: [X2, yX] }, { name: 'reg', def: R, at: [X3, yR] }];
    const nets: NetDef[] = [
      { name: 'fm', ends: ['mul.y', 'sum.a'] }, { name: 'd', ends: ['d', 'sum.b'], tags: true }, { name: 'next', ends: ['sum.y', 'reg.d'] },
      { name: 'en', ends: ['en', 'reg.en'], tags: true }, { name: 'clr', ends: ['clr', 'reg.clr'], tags: true }, { name: 'clk', ends: ['clk', 'reg.clk'], tags: true },
      { name: 's', ends: ['reg.q', 'mul.a', 's'], tags: true },
    ];
    return define({
      id: `rssyn${j}`, name: `RS syndrome ${j}`, category: 'sequential',
      summary: `The received word evaluated at α^${j}, one byte a clock: the register times 0x${hex2(gfPow(j))}, plus the byte. A code word leaves it at 0.`,
      ports: [bus('d', 8, 'in'), bit('en', 'in'), bit('clr', 'in'), clk(), bus('s', 8, 'out')], symbol: { kind: 'box', label: `S${j}` },
      netlist: () => ({ pins: { d: [0, yB], en: [0, yB + 3], clr: [0, yB + 6], clk: [0, yB + 9], s: [Rt, yR + rg.ports.q.pos[1]] }, instances, nets }),
    });
  });
}

/** The receiver's check: all 2t syndromes, and ok when every one is 0. */
export function rsSyndrome(nsym = 10): ComponentDef {
  return memo(`rssynd${nsym}`, () => {
    const Mg = merger(new Array<number>(nsym).fill(8), 2), mg = symbolGeom(Mg), Z = isZero(8 * nsym), zg = symbolGeom(Z);
    const SW = Math.max(...Array.from({ length: nsym }, (_, j) => symbolGeom(rsSynStage(j)).w)), PY = symbolGeom(rsSynStage(0)).h + 3, X0 = 10, X1 = X0 + SW + 10, X2 = X1 + mg.w + 6;
    const yz = Math.max(2, 2 + mg.ports.out.pos[1] - zg.ports.a.pos[1]);
    const instances: InstanceDef[] = [{ name: 'all', def: Mg, at: [X1, 2] }, { name: 'zero', def: Z, at: [X2, yz] }];
    const d = ['d'], en = ['en'], clr = ['clr'], ck = ['clk'], nets: NetDef[] = [];
    for (let j = 0; j < nsym; j++) {
      instances.push({ name: `s${j}`, def: rsSynStage(j), at: [X0, 2 + PY * j] });
      d.push(`s${j}.d`); en.push(`s${j}.en`); clr.push(`s${j}.clr`); ck.push(`s${j}.clk`);
      nets.push({ name: `s${j}`, ends: [`s${j}.s`, `all.i${j}`], tags: true });
    }
    nets.push({ name: 'd', ends: d, tags: true }, { name: 'en', ends: en, tags: true }, { name: 'clr', ends: clr, tags: true }, { name: 'clk', ends: ck, tags: true }, { name: 'bytes', ends: ['all.out', 'zero.a'], tags: true }, { name: 'ok', ends: ['zero.z', 'ok'] });
    return define({
      id: `rssynd${nsym}`, name: `Reed-Solomon check, ${nsym} syndromes`, category: 'arithmetic',
      summary: `Evaluates the received word at each of the generator's ${nsym} roots as it arrives. All zero: it is a code word. Not zero: the ${nsym} bytes are what a decoder starts from.`,
      ports: [bus('d', 8, 'in'), bit('en', 'in'), bit('clr', 'in'), clk(), bit('ok', 'out')], symbol: { kind: 'box', label: 'RS SYN' },
      netlist: () => ({ pins: { d: [0, 3], en: [0, 6], clr: [0, 9], clk: [0, 12], ok: [X2 + zg.w + 6, yz + zg.ports.z.pos[1]] }, instances, nets }),
    });
  });
}
