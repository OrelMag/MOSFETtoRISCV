// Chapter 47's Reed-Solomon in gates: multiplying by a constant in GF(256) is linear over GF(2), so it is an XOR network read off the golden model
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

/** The plan's XOR gates over `srcs`, one column per level; returns each output's driver. */
export function xorColumns(b: Builder, plan: XorPlan, srcs: string[]): string[] {
  const inputs = srcs.length, level = new Array<number>(inputs).fill(0), gate: string[] = [];
  plan.pairs.forEach(([x, y], k) => { level[inputs + k] = Math.max(level[x], level[y]) + 1; });
  const drv = (id: number) => (id < inputs ? srcs[id] : gate[id - inputs]);
  for (let lv = 1; lv <= plan.depth; lv++) {
    b.next();
    plan.pairs.forEach(([x, y], k) => { if (level[inputs + k] === lv) gate[k] = b.op1(XOR, [drv(x), drv(y)]); });
  }
  b.next();
  return plan.out.map((o) => drv(o));
}

/** y = a · c in GF(256): each output bit an XOR of input bits. */
export function gfConst(c: number): ComponentDef {
  return memo(`gfc${hex2(c)}`, () => {
    const rows: bigint[] = new Array<bigint>(8).fill(0n);
    for (let j = 0; j < 8; j++) { const v = gfMul(1 << j, c); for (let i = 0; i < 8; i++) if ((v >> i) & 1) rows[i] |= 1n << BigInt(j); }
    const b = new Builder(8, 10, 2);
    b.pins('a');
    const sp = b.op(splitter(ones(8)), ['a']);
    const outs = xorColumns(b, xorPlan(rows, 8, true), Array.from({ length: 8 }, (_, i) => `${sp}.o${i}`));
    b.wire(b.op1(merger(ones(8)), outs), 'y');
    return define({
      id: `gfc${hex2(c)}`, name: `GF(256) × 0x${hex2(c)}`, category: 'arithmetic',
      summary: `Multiplies a byte by the constant 0x${hex2(c)} in GF(256), field polynomial 0x11D. No multiplier is involved: the map is linear over GF(2), so every output bit is the XOR of a fixed set of input bits.`,
      ports: [bus('a', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: `×${hex2(c)}` },
      spec: ([a]) => [gfMul(a, c)],
      netlist: () => ({ pins: { a: [0, 12], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
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
      id: `rsenc${nsym}`, name: `Reed-Solomon encoder, ${nsym} check bytes`, category: 'sequential',
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
      id: `rssynd${nsym}`, name: `Reed-Solomon check, ${nsym} syndromes`, category: 'sequential',
      summary: `Evaluates the received word at each of the generator's ${nsym} roots as it arrives. All zero: it is a code word. Not zero: the ${nsym} bytes are what a decoder starts from.`,
      ports: [bus('d', 8, 'in'), bit('en', 'in'), bit('clr', 'in'), clk(), bit('ok', 'out')], symbol: { kind: 'box', label: 'RS SYN' },
      netlist: () => ({ pins: { d: [0, 3], en: [0, 6], clr: [0, 9], clk: [0, 12], ok: [X2 + zg.w + 6, yz + zg.ports.z.pos[1]] }, instances, nets }),
    });
  });
}
