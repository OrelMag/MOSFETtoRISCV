// The Reed-Solomon decoder in gates, for "Codes near the limit". The rules are comm/rsrtl.ts's header, register for register; tests/comm-rsdec.test.ts compares
// every register every clock. One Berlekamp-Massey iteration a clock: 3t + 2 general multipliers (lib/rs.ts gfMulGates), one a term of the discrepancy, γ λ_j and δ b_(j-1)
// per coefficient, four more in the inverse, one in Forney's formula. Everything else multiplies by constants, which are only XORs. Generators are memoized by (nsym, n).

import { rsCntWidth, rsKWidth, gfInvChain, RS_PHASE } from '../comm/rsrtl';
import { gfMul, gfPow } from '../comm/rs';
import { xorPlan } from '../comm/crc';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { busMux2, decoder, equal, incrementer, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { fanout } from './fastadd';
import { AND, NOR, NOT, OR } from './gates';
import { clearableRegister } from './pipeline';
import { gfConst, gfMulGates, xorColumns } from './rs';
import { register } from './sequential';
import { TIE0 } from './transistors';
import { notBus } from './viterbi';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Pins down each side of a drawing, three units apart. */
function pinsOf(ins: readonly string[], outs: readonly string[], right: number): Record<string, [number, number]> {
  const p: Record<string, [number, number]> = {};
  ins.forEach((n, i) => { p[n] = [0, 3 + 3 * i]; });
  outs.forEach((n, i) => { p[n] = [right, 3 + 3 * i]; });
  return p;
}

/** a^(2^times): squaring is linear over GF(2) too, so an XOR network. */
export function gfSquare(times: number): ComponentDef {
  return memo(`gfsq${times}`, () => {
    const pow = (x: number) => { let y = x; for (let i = 0; i < times; i++) y = gfMul(y, y); return y; };
    const rows: bigint[] = new Array<bigint>(8).fill(0n);
    for (let j = 0; j < 8; j++) { const v = pow(1 << j); for (let i = 0; i < 8; i++) if ((v >> i) & 1) rows[i] |= 1n << BigInt(j); }
    const b = new Builder(16, 18, 4);
    b.pins('a');
    const sp = b.op(splitter(ones(8)), ['a']);
    const outs = xorColumns(b, xorPlan(rows, 8, true), Array.from({ length: 8 }, (_, i) => `${sp}.o${i}`));
    b.wire(b.op1(merger(ones(8)), outs), 'y');
    return define({
      id: `gfsq${times}`, name: times === 1 ? 'GF(256) squarer' : `GF(256) squarer, ${times} times`, category: 'arithmetic',
      summary: 'Squaring in GF(256) is linear over GF(2): (a + b)² = a² + b², because the cross term appears twice and cancels. So it takes no multiplier, only XORs.',
      ports: [bus('a', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: times === 1 ? 'x²' : `x^${2 ** times}` },
      spec: ([a]) => [pow(a)],
      netlist: () => ({ pins: { a: [0, 12], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** a⁻¹ = a^254: exponents 2^i - 1 by the addition chain 1, 2, 3, 6, 7, then one squaring. Four general multipliers. */
export function gfInvGates(): ComponentDef {
  return memo('gfinv', () => {
    const M = gfMulGates(), b = new Builder(16, 18, 4);
    b.pins('a');
    const s1 = b.op1(gfSquare(1), ['a']); b.next();
    const b2 = b.op1(M, [s1, 'a'], 'a³'); b.next();
    const s2 = b.op1(gfSquare(1), [b2]); b.next();
    const b3 = b.op1(M, [s2, 'a'], 'a⁷'); b.next();
    const s3 = b.op1(gfSquare(3), [b3]); b.next();
    const b6 = b.op1(M, [s3, b3], 'a⁶³'); b.next();
    const s4 = b.op1(gfSquare(1), [b6]); b.next();
    const b7 = b.op1(M, [s4, 'a'], 'a¹²⁷'); b.next();
    b.wire(b.op1(gfSquare(1), [b7]), 'y');
    return define({
      id: 'gfinv', name: 'GF(256) inverter', category: 'arithmetic',
      summary: 'Every non-zero element has a²⁵⁵ = 1, so a⁻¹ = a²⁵⁴. Squarings cost only XORs, so an addition chain reaches it with four multiplications. 0 maps to 0.',
      ports: [bus('a', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: 'x⁻¹' },
      spec: ([a]) => [gfInvChain(a)],
      netlist: () => ({ pins: { a: [0, 6], y: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** A byte register whose clear means 1: the stored value is the byte with bit 0 inverted, so λ₀, b₀ and γ reset to 1 with the same clear as the rest. */
export function rsRegOne(): ComponentDef {
  return memo('rsreg1', () => {
    const b = new Builder(16, 18, 4);
    b.pins('d', 'en', 'clr', 'clk');
    const sd = b.op(splitter(ones(8), 2), ['d']); b.next();
    const nd = b.op1(NOT, [`${sd}.o0`]); b.next();
    const md = b.op1(merger(ones(8), 2), [nd, ...Array.from({ length: 7 }, (_, i) => `${sd}.o${i + 1}`)]); b.next();
    const q = b.op1(clearableRegister(8), [md, 'en', 'clr', 'clk']); b.next();
    const sq = b.op(splitter(ones(8), 2), [q]); b.next();
    const nq = b.op1(NOT, [`${sq}.o0`]); b.next();
    b.wire(b.op1(merger(ones(8), 2), [nq, ...Array.from({ length: 7 }, (_, i) => `${sq}.o${i + 1}`)]), 'q');
    return define({
      id: 'rsreg1', name: 'Byte register that clears to 1', category: 'sequential',
      summary: 'A clearable register with an inverter either side of bit 0: clearing it stores a 0 there, which reads as the byte 1.',
      ports: [bus('d', 8, 'in'), bit('en', 'in'), bit('clr', 'in'), clk(), bus('q', 8, 'out')], symbol: { kind: 'box', label: 'REG=1' },
      netlist: () => ({ pins: { ...pinsOf(['d', 'en', 'clr', 'clk'], [], b.right), q: [b.right, 9] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Put an instance (named, or the owner of a "inst.port" end) at x, y. */
const put = (b: Builder, end: string, x: number, y: number): void => {
  const i = b.instances.find((v) => v.name === end || v.name === end.slice(0, end.indexOf('.')));
  if (i) i.at = [x, y];
};

/** ×c, or nothing at all when c = 1. */
const times = (b: Builder, x: string, c: number): string => (c === 1 ? x : b.op1(gfConst(c), [x]));

/** The start constant of coefficient j: position n - 1 is the first byte sent. */
const startOf = (n: number, j: number): number => gfPow(-(n - 1) * j);

/** One syndrome in the ring: Horner on the way in, a rotation afterwards. */
export function rsRingStage(k: number): ComponentDef {
  return memo(`rsring${k}`, () => {
    const b = new Builder(16, 18, 4);
    b.pins('d', 'next', 'rx', 'rot', 'rst', 'clk');
    const h = times(b, 'reg.q', gfPow(k)); b.next();
    const sum = b.op1(bitwise('xor', 8), [h, 'd'], 'Horner'); b.next();
    const pick = b.op1(busMux2(8), ['next', sum, 'rx']);
    const load = b.op1(OR, ['rx', 'rot']); b.next();
    b.name('reg.q', 'q', true);
    b.op(clearableRegister(8), [pick, load, 'rst', 'clk'], `S${k}`, 'reg');
    b.wire('reg.q', 'q');
    return define({
      id: `rsring${k}`, name: `RS syndrome ring, stage ${k}`, category: 'sequential',
      summary: `While the word arrives: S' = S · α^${k} + d, the word evaluated at α^${k}. Afterwards the ring rotates, one syndrome a clock, so that Berlekamp-Massey sees them in order.`,
      ports: [bus('d', 8, 'in'), bus('next', 8, 'in'), bit('rx', 'in'), bit('rot', 'in'), bit('rst', 'in'), clk(), bus('q', 8, 'out')], symbol: { kind: 'box', label: `S${k}` },
      netlist: () => ({ pins: { ...pinsOf(['d', 'next', 'rx', 'rot', 'rst', 'clk'], [], b.right), q: [b.right, 9] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The discrepancy: δ = λ₀ w₀ + Σ mask[j] λ_j w_j, a general multiplier a term. */
export function rsDelta(t: number): ComponentDef {
  return memo(`rsdelta${t}`, () => {
    const b = new Builder(16, 18, 4), M = gfMulGates(), X = bitwise('xor', 8), A = bitwise('and', 8), F = fanout(8);
    const inNames = [...Array.from({ length: t + 1 }, (_, j) => `l${j}`), ...Array.from({ length: t + 1 }, (_, j) => `w${j}`), 'm'];
    b.pins(...inNames);
    // a row a term: the mask bit (a splitter with a row's pitch), the AND that gates S, the multiplier; the XOR tree sits between its pairs
    const sm = b.op(splitter(ones(t), 10), ['m']); b.next();
    const fans: string[] = [], ands: string[] = [];
    const gated = Array.from({ length: t + 1 }, (_, j) => {
      if (j === 0) return 'w0';
      const f = b.op1(F, [`${sm}.o${j - 1}`]), a = b.op1(A, [`w${j}`, f]);
      fans.push(f); ands.push(a);
      return a;
    });
    b.next();
    let terms = gated.map((w, j) => b.op1(M, [`l${j}`, w], `λ${j} × S`));
    const row = (j: number) => 2 + 10 * j, yOut = new Map<string, number>(terms.map((e, j) => [e, row(j) + 3]));
    put(b, sm, 16, 12);
    terms.forEach((e, j) => put(b, e, 56, row(j)));
    ands.forEach((e, k) => { put(b, e, 38, row(k + 1) + 1); put(b, fans[k], 26, row(k + 1) + 4); });
    for (let x = 72; terms.length > 1; x += 16) {
      b.next();
      const next: string[] = [];
      for (let i = 0; i + 1 < terms.length; i += 2) {
        const e = b.op1(X, [terms[i], terms[i + 1]]), y = Math.round((yOut.get(terms[i])! + yOut.get(terms[i + 1])!) / 2) - 3;
        put(b, e, x, y); yOut.set(e, y + 3); next.push(e);
      }
      if (terms.length & 1) next.push(terms[terms.length - 1]);
      terms = next;
    }
    b.wire(terms[0], 'y');
    return define({
      id: `rsdelta${t}`, name: `RS discrepancy, ${t + 1} terms`, category: 'arithmetic',
      summary: 'What the error locator predicts for the next syndrome, plus that syndrome. Zero: the locator already explains it. In the Ω pass the same sum gives Ω, and the mask stops the window wrapping round.',
      ports: [...Array.from({ length: t + 1 }, (_, j) => bus(`l${j}`, 8, 'in')), ...Array.from({ length: t + 1 }, (_, j) => bus(`w${j}`, 8, 'in')), bus('m', t, 'in'), bus('y', 8, 'out')],
      symbol: { kind: 'box', label: 'δ' },
      spec: (v) => {
        let s = gfMul(v[0], v[t + 1]);
        for (let j = 1; j <= t; j++) if ((v[2 * t + 2] >>> (j - 1)) & 1) s ^= gfMul(v[j], v[t + 1 + j]);
        return [s];
      },
      netlist: () => ({ pins: { ...Object.fromEntries(inNames.map((n, i) => [n, [0, n === 'm' ? 12 + 5 * t : i <= t ? row(i) + 2 : row(i - t - 1) + 8] as [number, number]])), y: [Math.max(...b.instances.map((i) => i.at![0] + symbolGeom(i.def).w)) + 4, yOut.get(terms[0])!] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** One coefficient of the locator: λ_j and b_j with what updates them. Berlekamp-Massey, then the jump to the first byte, then a Chien step a clock. */
export function rsLamSlice(j: number, n: number): ComponentDef {
  return memo(`rslam${j}_${n}`, () => {
    const b = new Builder(16, 18, 4), M = gfMulGates(), Mx = busMux2(8), R = j === 0 ? rsRegOne() : clearableRegister(8);
    const ins = j ? ['bin', 'gamma', 'delta', 'bm', 'swap', 'ini', 'ch', 'rst', 'clk'] : ['gamma', 'bm', 'swap', 'ini', 'ch', 'rst', 'clk'];
    b.pins(...ins);
    b.name('lam.q', 'l', true); b.name('bb.q', 'b', true);
    const g = b.op1(M, ['lam.q', 'gamma'], 'γ λ');
    const d = j ? b.op1(M, ['delta', 'bin'], 'δ b') : '';
    b.next();
    const upd = j ? b.op1(bitwise('xor', 8), [g, d]) : g;
    b.next();
    const k0 = times(b, 'lam.q', startOf(n, j)), k1 = times(b, 'lam.q', gfPow(j));
    b.next();
    const m1 = b.op1(Mx, [upd, k0, 'ini']);
    b.next();
    const m2 = b.op1(Mx, [m1, k1, 'ch']);
    const or1 = b.op1(OR, ['bm', 'ini']), anyL = b.op1(OR, [or1, 'ch']);
    const nb = j ? b.op1(Mx, ['bin', 'lam.q', 'swap']) : b.op1(bitwise('and', 8), ['lam.q', b.op1(fanout(8), ['swap'])]);
    b.next();
    b.op(R, [m2, anyL, 'rst', 'clk'], `λ${j}`, 'lam');
    b.op(R, [nb, 'bm', 'rst', 'clk'], `b${j}`, 'bb');
    b.wire('lam.q', 'l'); b.wire('bb.q', 'b');
    // j > 0, left to right: the two products and their sum, the two constant steps beside the muxes that choose among them, the registers;
    // each part level with the pin it feeds (the shared constants stay on labels)
    if (j) {
      put(b, g, 16, 2); put(b, d, 16, 12); put(b, upd, 30, 3);
      put(b, k0, 40, 12); put(b, k1, 40, 24); put(b, m1, 50, 4); put(b, m2, 62, 5);
      put(b, or1, 56, 13); put(b, anyL, 68, 14); put(b, nb, 66, 23);
      put(b, 'lam', 78, 12); put(b, 'bb', 78, 24);
    }
    return define({
      id: `rslam${j}_${n}`, name: `RS locator, coefficient ${j}`, category: 'sequential',
      summary: `λ' = γ λ + δ b, inversionless: nothing is ever divided, so the coefficients are scaled by a known factor that the error values cancel. b waits with the last locator that made progress.`,
      ports: [...(j ? [bus('bin', 8, 'in')] : []), bus('gamma', 8, 'in'), ...(j ? [bus('delta', 8, 'in')] : []), bit('bm', 'in'), bit('swap', 'in'), bit('ini', 'in'), bit('ch', 'in'), bit('rst', 'in'), clk(), bus('l', 8, 'out'), bus('b', 8, 'out')],
      symbol: { kind: 'box', label: `λ${j}` },
      netlist: () => ({ pins: j ? { ...pinsOf(ins, [], 0), l: [102, 16], b: [102, 28] } : pinsOf(ins, ['l', 'b'], b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** One coefficient of Ω: shifted in, then stepped with the locator's constants. */
export function rsOmSlice(i: number, n: number): ComponentDef {
  return memo(`rsom${i}_${n}`, () => {
    const b = new Builder(16, 18, 4), Mx = busMux2(8);
    const ins = ['in', 'om', 'ini', 'ch', 'rst', 'clk'];
    b.pins(...ins);
    b.name('reg.q', 'q', true);
    const k0 = times(b, 'reg.q', startOf(n, i)), k1 = times(b, 'reg.q', gfPow(i));
    b.next();
    const m1 = b.op1(Mx, ['in', k0, 'ini']);
    b.next();
    const m2 = b.op1(Mx, [m1, k1, 'ch']);
    const or1 = b.op1(OR, ['om', 'ini']), load = b.op1(OR, [or1, 'ch']);
    b.next();
    b.op(clearableRegister(8), [m2, load, 'rst', 'clk'], `Ω${i}`, 'reg');
    b.wire('reg.q', 'q');
    // left to right, each part level with the pin it feeds
    put(b, k0, 14, 6); put(b, m1, 28, 4); put(b, k1, 34, 14); put(b, m2, 46, 5); put(b, or1, 40, 22); put(b, load, 50, 23); put(b, 'reg', 62, 6);
    return define({
      id: `rsom${i}_${n}`, name: `RS error evaluator, coefficient ${i}`, category: 'sequential',
      summary: 'Ω shifts in from the discrepancy unit, then takes the same constant steps as the locator coefficient of the same power, so its sum is Ω at the position under test.',
      ports: [bus('in', 8, 'in'), bit('om', 'in'), bit('ini', 'in'), bit('ch', 'in'), bit('rst', 'in'), clk(), bus('q', 8, 'out')], symbol: { kind: 'box', label: `Ω${i}` },
      netlist: () => ({ pins: { ...pinsOf(ins, [], 0), q: [86, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Chien and Forney at one position: root when the locator's terms sum to 0, e = (Σ Ω terms) / (Σ odd locator terms). */
export function rsForney(t: number): ComponentDef {
  return memo(`rsforney${t}`, () => {
    const b = new Builder(16, 18, 4), X = bitwise('xor', 8);
    const inNames = [...Array.from({ length: t + 1 }, (_, j) => `l${j}`), ...Array.from({ length: t }, (_, j) => `o${j}`)];
    b.pins(...inNames);
    const chain = (xs: string[]) => { let s = xs[0]; for (let i = 1; i < xs.length; i++) s = b.op1(X, [s, xs[i]]); return s; };
    const l = Array.from({ length: t + 1 }, (_, j) => `l${j}`);
    const even = chain(l.filter((_, j) => !(j & 1))), odd = chain(l.filter((_, j) => j & 1)), value = chain(Array.from({ length: t }, (_, j) => `o${j}`));
    b.name(odd, 'odd', true); b.name(value, 'value', true); b.name(even, 'even', true);
    b.next();
    const all = b.op1(X, [even, odd]);
    const inv = b.op1(gfInvGates(), [odd]);
    b.next();
    b.wire(b.op1(isZero(8), [all], 'Λ = 0?'), 'root');
    b.wire(b.op1(gfMulGates(), [value, inv], 'Ω / odd'), 'e');
    return define({
      id: `rsforney${t}`, name: `RS Chien and Forney, t = ${t}`, category: 'arithmetic',
      summary: 'Is this position a root of the locator, and what is the error if so? The locator\'s odd terms are X⁻¹ times its derivative, and the X in Forney\'s formula cancels it, so one multiplication and one inversion do.',
      ports: [...Array.from({ length: t + 1 }, (_, j) => bus(`l${j}`, 8, 'in')), ...Array.from({ length: t }, (_, j) => bus(`o${j}`, 8, 'in')), bit('root', 'out'), bus('e', 8, 'out')],
      symbol: { kind: 'box', label: 'FORNEY' },
      spec: (v) => {
        let even = 0, odd = 0, value = 0;
        for (let j = 0; j <= t; j++) { if (j & 1) odd ^= v[j]; else even ^= v[j]; }
        for (let j = 0; j < t; j++) value ^= v[t + 1 + j];
        return [(even ^ odd) === 0 ? 1 : 0, gfMul(value, gfInvChain(odd))];
      },
      netlist: () => ({ pins: pinsOf(inNames, ['root', 'e'], b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The phases and the counter that ends each. */
export function rsControl(nsym: number, n: number): ComponentDef {
  return memo(`rsctl${nsym}_${n}`, () => {
    const t = nsym / 2, cw = rsCntWidth(nsym, n), b = new Builder(16, 18, 4), E = equal(cw);
    const ins = ['en', 'rst', 'clk'], outs = ['rx', 'bm', 'om', 'ini', 'ch', 'done', 'bmlast', 'ph', 'cnt'];
    b.pins(...ins);
    b.name('phr.q', 'ph', true); b.name('cntr.q', 'cnt', true);
    const dec = b.op(decoder(3), ['phr.q'], 'phase');
    const P = RS_PHASE, ph = (p: number) => `${dec}.y${p}`;
    const eqAt = (v: number) => b.op1(E, ['cntr.q', b.op1(constWord(cw, v), [])]);
    b.next();
    const eqN = eqAt(n - 1), eqB = eqAt(nsym - 1), eqT = eqAt(t - 1);
    b.next();
    const rx = b.op1(AND, [ph(P.RX), 'en']), l0 = b.op1(AND, [rx, eqN]), bmlast = b.op1(AND, [ph(P.BM), eqB]), l2 = b.op1(AND, [ph(P.OM), eqT]), l4 = b.op1(AND, [ph(P.CH), eqN]);
    b.next();
    const last = b.op1(OR, [b.op1(OR, [b.op1(OR, [l0, bmlast]), b.op1(OR, [l2, l4])]), ph(P.INI)]);
    b.name(last, 'last', true);
    const run = b.op1(OR, [b.op1(OR, [rx, ph(P.BM)]), b.op1(OR, [ph(P.OM), ph(P.CH)])]);
    b.next();
    const clr = b.op1(OR, ['rst', last]);
    b.op(incrementer(cw), ['cntr.q'], undefined, 'ci');
    b.op(incrementer(3), ['phr.q'], undefined, 'pi');
    b.next();
    b.op(clearableRegister(cw), ['ci.y', run, clr, 'clk'], 'counter', 'cntr');
    b.op(clearableRegister(3), ['pi.y', last, 'rst', 'clk'], 'phase', 'phr');
    b.next();
    b.wire(rx, 'rx'); b.wire(ph(P.BM), 'bm'); b.wire(ph(P.OM), 'om'); b.wire(ph(P.INI), 'ini'); b.wire(ph(P.CH), 'ch'); b.wire(ph(P.DONE), 'done'); b.wire(bmlast, 'bmlast');
    b.wire('phr.q', 'ph'); b.wire('cntr.q', 'cnt');
    return define({
      id: `rsctl${nsym}_${n}`, name: `RS decoder control, RS(${n}, ${n - nsym})`, category: 'sequential',
      summary: `One counter and a phase register: ${n} clocks to take the word, ${nsym} for Berlekamp-Massey, ${t} for Ω, one to jump to the first position, ${n} to send the word back.`,
      ports: [bit('en', 'in'), bit('rst', 'in'), clk(), bit('rx', 'out'), bit('bm', 'out'), bit('om', 'out'), bit('ini', 'out'), bit('ch', 'out'), bit('done', 'out'), bit('bmlast', 'out'), bus('ph', 3, 'out'), bus('cnt', cw, 'out')],
      symbol: { kind: 'box', label: 'RS CTL' },
      netlist: () => ({ pins: pinsOf(ins, outs, b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** k = r - 2L and the verdict: swap when δ ≠ 0 and 2L ≤ r, and at the end every root must have been found. */
export function rsKUnit(nsym: number): ComponentDef {
  return memo(`rsk${nsym}`, () => {
    const w = rsKWidth(nsym), b = new Builder(16, 18, 4), Mx = busMux2(w);
    const ins = ['dz', 'bm', 'ch', 'root', 'done', 'rst', 'clk'];
    b.pins(...ins);
    b.name('kr.q', 'k', true);
    const sp = b.op(splitter(ones(w), 2), ['kr.q']), neg = `${sp}.o${w - 1}`;
    const inv = b.op1(notBus(w), ['kr.q']);
    const one = b.op1(constWord(w, 1), []), two = b.op1(constWord(w, 2), []);
    b.next();
    const swap = b.op1(NOR, [neg, 'dz'], 'swap');
    b.name(swap, 'swap', true);
    const stepBy = b.op1(Mx, [one, two, 'ch']);
    const z = b.op1(TIE0, []);
    b.next();
    const add = b.op(rca(w), ['kr.q', stepBy, z]);
    const chroot = b.op1(AND, ['ch', 'root']);
    const swapBm = b.op1(AND, [swap, 'bm']);
    b.next();
    const next = b.op1(Mx, [`${add}.s`, inv, swapBm]);
    const load = b.op1(OR, ['bm', chroot]);
    b.next();
    b.op(clearableRegister(w), [next, load, 'rst', 'clk'], 'k', 'kr');
    b.next();
    const full = b.op1(equal(w), ['kr.q', b.op1(constWord(w, nsym), [])], 'k = 2t');
    b.next();
    const nf = b.op1(NOT, [full]);
    b.next();
    b.wire(b.op1(AND, [nf, 'done']), 'fail');
    b.wire(swap, 'swap'); b.wire('kr.q', 'k');
    return define({
      id: `rsk${nsym}`, name: `RS decoder length and verdict, ${nsym} syndromes`, category: 'sequential',
      summary: 'Berlekamp-Massey asks whether 2L ≤ r. Holding k = r - 2L makes that its sign bit, and a swap sends k to -k - 1, which is just inverting every bit. Each root found adds 2: k reaches 2t exactly when the locator had all its roots, which a locator too long for its registers never does.',
      ports: [bit('dz', 'in'), bit('bm', 'in'), bit('ch', 'in'), bit('root', 'in'), bit('done', 'in'), bit('rst', 'in'), clk(), bit('swap', 'out'), bus('k', w, 'out'), bit('fail', 'out')],
      symbol: { kind: 'box', label: 'k' },
      netlist: () => ({ pins: pinsOf(ins, ['swap', 'k', 'fail'], b.right), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** mask[j] = 1 once j ≤ the phase's step: a shift register of 1s. */
export function rsMask(t: number): ComponentDef {
  return memo(`rsmask${t}`, () => {
    const b = new Builder(16, 18, 4);
    const ins = ['en', 'clr', 'clk'];
    b.pins(...ins);
    b.name('reg.q', 'q', true);
    const sp = b.op(splitter(ones(t), 2), ['reg.q']);
    const one = b.op1(constWord(1, 1), []);
    b.next();
    const m = b.op1(merger(ones(t), 2), [one, ...Array.from({ length: t - 1 }, (_, i) => `${sp}.o${i}`)]);
    b.next();
    b.op(clearableRegister(t), [m, 'en', 'clr', 'clk'], 'mask', 'reg');
    b.wire('reg.q', 'q');
    return define({
      id: `rsmask${t}`, name: `RS window mask, ${t} bits`, category: 'sequential',
      summary: 'Lets term j of the discrepancy count only from step j on. The window sits on the ring, so without this an early step would read the far end of the ring as if it were an earlier syndrome.',
      ports: [bit('en', 'in'), bit('clr', 'in'), clk(), bus('q', t, 'out')], symbol: { kind: 'box', label: 'MASK' },
      netlist: () => ({ pins: { ...pinsOf(ins, [], b.right), q: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The word kept while it is worked on: n byte registers in a row. */
export function rsBuffer(n: number): ComponentDef {
  return memo(`rsbuf${n}`, () => {
    const b = new Builder(8, 8, 2), R = register(8);
    const ins = ['d', 'en', 'clk'];
    b.pins(...ins);
    let prev = 'd';
    for (let i = 0; i < n; i++) { const nm = `r${i}`; b.op(R, [prev, 'en', 'clk'], undefined, nm); prev = `${nm}.q`; b.next(); }
    b.next();
    b.wire(prev, 'q');
    return define({
      id: `rsbuf${n}`, name: `Byte shift register, ${n} bytes`, category: 'sequential',
      summary: 'Holds the word while the decoder works out what is wrong with it. Most of a shortened decoder\'s flip-flops are here.',
      ports: [bus('d', 8, 'in'), bit('en', 'in'), clk(), bus('q', 8, 'out')], symbol: { kind: 'box', label: `${n} BYTES` },
      netlist: () => ({ pins: { ...pinsOf(ins, [], b.right), q: [b.right, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * RS(n, n - nsym): word in, n clocks with en = 1 after a reset; corrected word out with valid = 1, first byte first; done, and fail if it could not be corrected.
 * Everything is on labels: its parts talk to all of each other, and a drawing of wires would be nothing but wires.
 */
export function rsDecoder(nsym = 10, n = 26): ComponentDef {
  return memo(`rsdec${nsym}_${n}`, () => {
    const t = nsym / 2;
    if (nsym % 2 || t < 2 || n <= nsym || n > 255) throw new Error(`rsDecoder: no RS(${n}, ${n - nsym}) here (t ≥ 2)`);
    const b = new Builder(12, 24, 4), Ring = Array.from({ length: nsym }, (_, k) => rsRingStage(k));
    b.pins('d', 'en', 'rst', 'clk');
    // every driver a label: parts are placed in reading order, not by what they drive
    const tag = (drv: string, name: string) => b.name(drv, name, true);
    tag('ctl.rx', 'rx'); tag('ctl.bm', 'bm'); tag('ctl.om', 'om'); tag('ctl.ini', 'ini'); tag('ctl.ch', 'ch'); tag('ctl.done', 'done'); tag('ctl.bmlast', 'bmlast');
    for (let k = 0; k < nsym; k++) tag(`s${k}.q`, `S${k}`);
    for (let j = 0; j <= t; j++) { tag(`l${j}.l`, `lam${j}`); tag(`l${j}.b`, `b${j}`); }
    for (let i = 0; i < t; i++) tag(`o${i}.q`, `om${i}`);
    tag('dl.y', 'delta'); tag('gam.q', 'gamma'); tag('kk.swap', 'swap'); tag('mk.q', 'mask'); tag('fr.root', 'root'); tag('fr.e', 'e'); tag('rot.y', 'rot'); tag('dz.z', 'dz'); tag('mc.y', 'mclr');
    b.op(rsControl(nsym, n), ['en', 'rst', 'clk'], 'control', 'ctl');
    b.op(OR, ['ctl.bm', 'ctl.om'], undefined, 'rot');
    b.op(OR, ['rst', 'ctl.bmlast'], undefined, 'mc');
    b.op(rsMask(t), ['rot.y', 'mc.y', 'clk'], undefined, 'mk');
    b.op(rsKUnit(nsym), ['dz.z', 'ctl.bm', 'ctl.ch', 'fr.root', 'ctl.done', 'rst', 'clk'], 'verdict', 'kk');
    b.next();
    for (let k = 0; k < nsym; k++) {
      if (k === Math.ceil(nsym / 2)) b.next();
      b.op(Ring[k], ['d', `s${(k + 1) % nsym}.q`, 'ctl.rx', 'rot.y', 'rst', 'clk'], `syndrome ${k}`, `s${k}`);
    }
    b.next();
    b.op(rsDelta(t), [...Array.from({ length: t + 1 }, (_, j) => `l${j}.l`), 's0.q', ...Array.from({ length: t }, (_, j) => `s${nsym - j - 1}.q`), 'mk.q'], 'discrepancy', 'dl');
    b.op(isZero(8), ['dl.y'], undefined, 'dz');
    b.op(AND, ['ctl.bm', 'kk.swap'], undefined, 'gen');
    b.op(rsRegOne(), ['dl.y', 'gen.y', 'rst', 'clk'], 'γ', 'gam');
    b.next();
    for (let j = 0; j <= t; j++) {
      if (j === Math.ceil((t + 1) / 2)) b.next();
      const inputs = j ? [`l${j - 1}.b`, 'gam.q', 'dl.y'] : ['gam.q'];
      b.op(rsLamSlice(j, n), [...inputs, 'ctl.bm', 'kk.swap', 'ctl.ini', 'ctl.ch', 'rst', 'clk'], undefined, `l${j}`);
    }
    b.next();
    for (let i = 0; i < t; i++) b.op(rsOmSlice(i, n), [i + 1 < t ? `o${i + 1}.q` : 'dl.y', 'ctl.om', 'ctl.ini', 'ctl.ch', 'rst', 'clk'], undefined, `o${i}`);
    b.next();
    b.op(rsForney(t), [...Array.from({ length: t + 1 }, (_, j) => `l${j}.l`), ...Array.from({ length: t }, (_, j) => `o${j}.q`)], 'Chien, Forney', 'fr');
    b.op(OR, ['ctl.rx', 'ctl.ch'], undefined, 'bufen');
    b.op(rsBuffer(n), ['d', 'bufen.y', 'clk'], 'the word', 'buf');
    b.next();
    const f = b.op1(fanout(8), ['fr.root']);
    const fix = b.op1(bitwise('and', 8), ['fr.e', f]);
    b.next();
    b.wire(b.op1(bitwise('xor', 8), ['buf.q', fix]), 'out');
    b.wire('ctl.ch', 'valid'); b.wire('ctl.done', 'done'); b.wire('kk.fail', 'fail');
    // Hand-placed: rows read left to right and each chain of neighbours (the ring, b, Ω, the output) is a staircase, one step a
    // box, so that its wires run straight. What every part reads (controls, S, λ, δ, γ) stays on labels.
    const half = Math.ceil(nsym / 2), at: Record<string, [number, number]> = {
      ctl: [12, 2], rot: [12, 26], mc: [12, 32], mk: [22, 26],
      dl: [134, 4], dz: [146, 16], gen: [146, 36], gam: [156, 34],
      fr: [124, 136], bufen: [132, 130], buf: [146, 128], u0: [142, 146], u1: [152, 147], u2: [170, 146], kk: [184, 128],
    };
    for (let k = 0; k < nsym; k++) { const r = k >= half ? nsym - 1 - k : half - 1 - k; at[`s${k}`] = [42 + 17 * r, (k >= half ? 4 : 32) + 2 * r]; }
    for (let j = 0; j <= t; j++) at[`l${j}`] = [42 + 17 * j, j === 0 ? 64 : 70 + 8 * (j - 1)];
    for (let i = 0; i < t; i++) at[`o${i}`] = [42 + 15 * (t - 1 - i), 128 + 4 * (t - 1 - i)];
    for (const i of b.instances) i.at = at[i.name] ?? i.at;
    // the ends a net keeps on labels (the others are wires; none: all wires), by driver
    const keep: Record<string, (ends: string[]) => string[]> = { 'mc.y': () => [], 'fr.e': () => [], 'rot.y': (e) => e.slice(1).filter((x) => x !== 'mk.en'), 'dl.y': (e) => e.slice(1).filter((x) => x !== 'dz.a') };
    for (let k = 1; k < nsym; k++) if (k !== half) keep[`s${k}.q`] = (e) => e.filter((x) => x.startsWith('dl.'));
    for (let j = 0; j < t; j++) keep[`l${j}.b`] = () => [];
    for (let i = 1; i < t; i++) keep[`o${i}.q`] = (e) => e.filter((x) => x.startsWith('fr.'));
    keep['o0.q'] = () => [];
    keep['fr.root'] = (e) => e.filter((x) => x.startsWith('kk.'));
    const nets = () => b.nets().map((x) => {
      const k = keep[x.ends[0]];
      if (!k) return x;
      const tags = k(x.ends);
      const { tags: _t, ...rest } = x;
      return tags.length ? { ...rest, tags } : rest;
    });
    const pins = { d: [0, 3] as [number, number], en: [0, 11] as [number, number], rst: [0, 14] as [number, number], clk: [0, 17] as [number, number], out: [180, 148] as [number, number], fail: [200, 137] as [number, number], valid: [200, 140] as [number, number], done: [200, 143] as [number, number] };
    return define({
      id: `rsdec${nsym}_${n}`, name: `Reed-Solomon decoder, RS(${n}, ${n - nsym})`, category: 'arithmetic',
      summary: `Corrects any ${t} wrong bytes in ${n}. Syndromes as the word arrives, the error locator by Berlekamp-Massey in ${nsym} clocks, Ω in ${t}, then every position tested as the word goes back out: ${2 * n + nsym + t + 1} clocks in all. fail says it could not, and only at the end.`,
      ports: [bus('d', 8, 'in'), bit('en', 'in'), bit('rst', 'in'), clk(), bus('out', 8, 'out'), bit('valid', 'out'), bit('done', 'out'), bit('fail', 'out')],
      symbol: { kind: 'box', label: 'RS DEC' },
      netlist: () => ({ pins, instances: b.instances, nets: nets() }),
    });
  });
}
