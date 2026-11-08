// CORDIC in gates (chapter "Turning by shifting"): three adders and wiring per stage, no multiplier. A stage's shifts are only how the wires are laid, so the pipeline costs adders and
// registers; the iterative form swaps the stages for a shifter, a table and a count, and takes n clocks a result. dsp/cordic.ts is compared with both, every clock (tests/dsp-cordic.test.ts).

import { atanTable, type CordicSpec } from '../dsp/cordic';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, addSub } from './combinational';
import { define } from './define';
import { cut, placed } from './fft';
import { XOR, NOT, MUX2, OR, AND } from './gates';
import { lookupRom } from './modem';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { laid } from './layered';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkPort: PortDef = { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true };

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const tag = (s: CordicSpec) => `${s.w}_${s.z}_${s.n}`;

/** Lays out what a Builder made as a component with these ports, inputs on the left and outputs on the right. */
function built(b: Builder, ports: PortDef[]): { pins: Record<string, [number, number]>; instances: typeof b.instances; nets: ReturnType<Builder['nets']> } {
  const R = b.right;
  let li = 0, ri = 0;
  const pins: Record<string, [number, number]> = {};
  for (const p of ports) {
    if (p.side === 'bottom') pins[p.name] = [8, b.height + 3];
    else if (p.dir === 'in') pins[p.name] = [0, 2 + 3 * li++];
    else pins[p.name] = [R, 2 + 3 * ri++];
  }
  return { pins, instances: b.instances, nets: b.nets() };
}

/** Wiring: a word moved down i places, sign kept: an arithmetic shift right, costing nothing. */
const shiftWire = (b: Builder, w: number, i: number, from: string, name: string): string =>
  (i === 0 ? from : b.op1(placed(w - i, 0, w), [b.op1(cut(w, i, w - i), [from], undefined, `${name}c`)], `≫ ${i}`, name));

/** The half-turn: negates x and y when `flip`, and turns the angle's top bit. Rotating, flip is the angle's two top bits differing; vectoring, x's sign. */
export function cordicHalfTurn(s: CordicSpec): ComponentDef {
  return memo(`cordic_half_${s.w}_${s.z}`, () => {
    const b = new Builder(10, 10, 6);
    b.pins('x', 'y', 'z', 'rotate');
    const zero = b.op1(constWord(s.w, 0), [], 'zero', 'zero');
    const zt = b.op1(cut(s.z, s.z - 1, 1), ['z'], 'top', 'zt'), zn = b.op1(cut(s.z, s.z - 2, 1), ['z'], 'next', 'zn'), sx = b.op1(cut(s.w, s.w - 1, 1), ['x'], 'x < 0', 'sx');
    b.next();
    const past = b.op1(XOR, [zt, zn], 'past ±90°', 'past');
    b.next();
    const flip = b.op1(MUX2, [sx, past, 'rotate'], 'half-turn?', 'flip');
    b.next();
    const nx = b.op(addSub(s.w), [zero, 'x', flip], '±x', 'nx'), ny = b.op(addSub(s.w), [zero, 'y', flip], '±y', 'ny');
    const low = b.op1(cut(s.z, 0, s.z - 1), ['z'], 'the rest', 'zl');
    const top = b.op1(XOR, [zt, flip], 'top bit turned', 'ztf');
    b.next();
    const mz = b.op1(mergeTop(s.z), [low, top], undefined, 'mz');
    b.next();
    b.wire(`${nx}.s`, 'xo'); b.wire(`${ny}.s`, 'yo'); b.wire(mz, 'zo');
    const ports = [bus('x', s.w, 'in'), bus('y', s.w, 'in'), bus('z', s.z, 'in'), bit('rotate', 'in'), bus('xo', s.w, 'out'), bus('yo', s.w, 'out'), bus('zo', s.z, 'out')];
    return define({
      id: `cordic_half_${s.w}_${s.z}`, name: 'CORDIC: the half-turn', category: 'arithmetic',
      summary: 'The stages reach about ±99.9°, so anything further first turns by 180°: both coordinates negated, and the top bit of the angle flipped, which is half a turn when the word is a full one.',
      ports, symbol: { kind: 'box', label: '180°', w: 8 }, netlist: () => built(b, ports),
    });
  });
}

/** Wiring: a word and one more bit on top. */
function mergeTop(w: number): ComponentDef {
  return memo(`cordic_top${w}`, () => define({
    id: `cordic_top${w}`, name: `Wiring: ${w - 1} bits and a top bit`, category: 'plumbing',
    summary: 'Only wires.', ports: [bus('a', w - 1, 'in'), bit('t', 'in'), bus('y', w, 'out')], symbol: { kind: 'box', label: 'top', w: 4, h: 2 }, prim: 'alias',
    alias: Array.from({ length: w }, (_, i): [string, number, string, number] => (i === w - 1 ? ['t', 0, 'y', i] : ['a', i, 'y', i])),
  }));
}

/** The three adders every form shares, on shifted copies already made: x ∓ yₛ, y ± xₛ, z ∓ a. Which way comes from z's sign or y's. */
function stageCore(b: Builder, s: CordicSpec, x: string, y: string, z: string, xs: string, ys: string, atan: string, rotate: string, tagName = ''): { x: string; y: string; z: string } {
  const zs = b.op1(cut(s.z, s.z - 1, 1), [z], 'z < 0', `zsgn${tagName}`), ys0 = b.op1(cut(s.w, s.w - 1, 1), [y], 'y < 0', `ysgn${tagName}`);
  const nz = b.op1(NOT, [zs], 'z ≥ 0', `nz${tagName}`);
  b.next();
  const d = b.op1(MUX2, [ys0, nz, rotate], 'which way', `d${tagName}`);
  const nd = b.op1(NOT, [d], undefined, `nd${tagName}`);
  b.next();
  const ax = b.op(addSub(s.w), [x, ys, d], 'x ∓ y≫i', `ax${tagName}`), ay = b.op(addSub(s.w), [y, xs, nd], 'y ± x≫i', `ay${tagName}`), az = b.op(addSub(s.z), [z, atan, d], 'z ∓ atan', `az${tagName}`);
  return { x: `${ax}.s`, y: `${ay}.s`, z: `${az}.s` };
}

/** Stage i: the shifts are wires and the angle a constant, so all it costs is three adders. */
export function cordicStage(s: CordicSpec, i: number): ComponentDef {
  return memo(`cordic_stage${tag(s)}_${i}`, () => {
    const b = new Builder(10, 10, 6);
    b.pins('x', 'y', 'z', 'rotate');
    const xs = shiftWire(b, s.w, i, 'x', 'xs'), ys = shiftWire(b, s.w, i, 'y', 'ys');
    const a = b.op1(constWord(s.z, atanTable(s)[i]), [], `atan 2^−${i}`, 'atan');
    b.next();
    const r = stageCore(b, s, 'x', 'y', 'z', xs, ys, a, 'rotate');
    b.next();
    b.wire(r.x, 'xo'); b.wire(r.y, 'yo'); b.wire(r.z, 'zo');
    const ports = [bus('x', s.w, 'in'), bus('y', s.w, 'in'), bus('z', s.z, 'in'), bit('rotate', 'in'), bus('xo', s.w, 'out'), bus('yo', s.w, 'out'), bus('zo', s.z, 'out')];
    return define({
      id: `cordic_stage${tag(s)}_${i}`, name: `CORDIC stage ${i}`, category: 'arithmetic',
      summary: `Turn by atan 2^−${i}, one way or the other: x and y each add a copy of the other moved down ${i} place${i === 1 ? '' : 's'}, and z takes off the angle. Three adders, and the shifts are wires.`,
      ports, symbol: { kind: 'box', label: `÷${2 ** i}`, w: 8 }, netlist: () => built(b, ports),
    });
  });
}

/** One clock per stage, a result every clock. */
export function cordicPipeline(s: CordicSpec): ComponentDef {
  return memo(`cordic_pipe${tag(s)}`, () => {
    const b = new Builder(10, 12, 6);
    b.pins('x', 'y', 'z', 'rotate', 'clk');
    const one = b.op(TIE1, [], 'always load', 'one');
    const en = `${one}.y`;
    const regs = (xn: string, yn: string, zn: string, rn: string, k: number) => {
      b.next();
      const rx = b.op(register(s.w), [xn, en, 'clk'], `x${k}`, `rx${k}`), ry = b.op(register(s.w), [yn, en, 'clk'], `y${k}`, `ry${k}`), rz = b.op(register(s.z), [zn, en, 'clk'], `z${k}`, `rz${k}`);
      const rr = b.op(register(1), [rn, en, 'clk'], undefined, `rr${k}`);
      b.next();
      return { x: `${rx}.q`, y: `${ry}.q`, z: `${rz}.q`, r: `${rr}.q` };
    };
    const h = b.op(cordicHalfTurn(s), ['x', 'y', 'z', 'rotate'], 'half-turn', 'half');
    let st = regs(`${h}.xo`, `${h}.yo`, `${h}.zo`, 'rotate', 0);
    for (let i = 0; i < s.n; i++) {
      const g = b.op(cordicStage(s, i), [st.x, st.y, st.z, st.r], `stage ${i}`, `st${i}`);
      st = regs(`${g}.xo`, `${g}.yo`, `${g}.zo`, st.r, i + 1);
    }
    b.wire(st.x, 'xo'); b.wire(st.y, 'yo'); b.wire(st.z, 'zo');
    const ports = [bus('x', s.w, 'in'), bus('y', s.w, 'in'), bus('z', s.z, 'in'), bit('rotate', 'in'), clkPort, bus('xo', s.w, 'out'), bus('yo', s.w, 'out'), bus('zo', s.z, 'out')];
    return define({
      id: `cordic_pipe${tag(s)}`, name: `CORDIC, pipelined (${s.n} stages)`, category: 'arithmetic',
      summary: `A half-turn and ${s.n} stages with registers between them: one result every clock, ${s.n + 1} clocks after its input. No multiplier anywhere.`,
      ports, symbol: { kind: 'box', label: 'CORDIC', w: 10 }, netlist: laid(b, { keepOrder: true }),
    });
  });
}

/** A shifter that keeps the sign: log₂ w stages of multiplexers, each moving the word by a power of two or not. */
export function arithShifter(w: number, k: number): ComponentDef {
  return memo(`cordic_sar${w}_${k}`, () => {
    const b = new Builder(10, 10, 6);
    b.pins('a', 'sh');
    let v = 'a';
    for (let j = 0; j < k; j++) {
      const on = b.op1(cut(k, j, 1), ['sh'], `by ${2 ** j}`, `s${j}`);
      const moved = b.op1(placed(w - 2 ** j, 0, w), [b.op1(cut(w, 2 ** j, w - 2 ** j), [v], undefined, `c${j}`)], undefined, `p${j}`);
      b.next();
      v = b.op1(busMux2(w), [v, moved, on], undefined, `m${j}`);
      b.next();
    }
    b.wire(v, 'y');
    const ports = [bus('a', w, 'in'), bus('sh', k, 'in'), bus('y', w, 'out')];
    return define({
      id: `cordic_sar${w}_${k}`, name: `${w}-bit arithmetic shifter`, category: 'arithmetic',
      summary: 'Moves a word down by the amount on sh and copies the sign in above. A pipelined stage needs none of this: its shift is fixed, so it is wires.',
      ports, symbol: { kind: 'box', label: '≫', w: 6 },
      spec: ([a, sh]) => { const sv = a >= 2 ** (w - 1) ? a - 2 ** w : a; return [((Math.floor(sv / 2 ** sh) % 2 ** w) + 2 ** w) % 2 ** w]; },
      netlist: () => built(b, ports),
    });
  });
}

const bitsFor = (n: number) => Math.ceil(Math.log2(n));

/** One stage over and over: two shifters, a table of angles, a count of the stages and a busy flag. Far smaller, n clocks a result. */
export function cordicIterative(s: CordicSpec): ComponentDef {
  return memo(`cordic_iter${tag(s)}`, () => {
    const k = bitsFor(s.n), b = new Builder(10, 12, 6);
    b.pins('x', 'y', 'z', 'rotate', 'start', 'clk');
    const rx = b.add(register(s.w), 'x', 'rx'), ry = b.add(register(s.w), 'y', 'ry'), rz = b.add(register(s.z), 'z', 'rz');
    const rr = b.add(register(1), undefined, 'rr'), busy = b.add(register(1), 'busy', 'rb');
    const cnt = b.add(register(k), 'stage', 'rc');
    b.next();
    const h = b.op(cordicHalfTurn(s), ['x', 'y', 'z', 'rotate'], 'half-turn', 'half');
    b.next();
    const rom = b.op1(lookupRom(`cordic_atan${tag(s)}`, 'ROM: the angles', k, s.z, Array.from({ length: 2 ** k }, (_, i) => atanTable(s)[i] ?? 0), 'atan 2^−i for each stage, as a share of a turn.'), [`${cnt}.q`], 'angle', 'rom');
    const xs = b.op1(arithShifter(s.w, k), [`${rx}.q`, `${cnt}.q`], 'x ≫ i', 'sx'), ys = b.op1(arithShifter(s.w, k), [`${ry}.q`, `${cnt}.q`], 'y ≫ i', 'sy');
    b.next();
    const r = stageCore(b, s, `${rx}.q`, `${ry}.q`, `${rz}.q`, xs, ys, rom, `${rr}.q`);
    b.next();
    // what each register takes: a start loads the half-turn, a busy clock the stage's result, and otherwise it holds
    const load = b.op1(OR, ['start', `${busy}.q`], 'load?', 'load');
    const mx = b.op1(busMux2(s.w), [r.x, `${h}.xo`, 'start'], undefined, 'mx'), my = b.op1(busMux2(s.w), [r.y, `${h}.yo`, 'start'], undefined, 'my'), mz = b.op1(busMux2(s.z), [r.z, `${h}.zo`, 'start'], undefined, 'mz');
    const last = b.op1(eqConst(k, s.n - 1), [`${cnt}.q`], 'last stage', 'last');
    const nl = b.op1(NOT, [last], undefined, 'nl'), ns = b.op1(NOT, ['start'], undefined, 'ns');
    b.next();
    b.wire(mx, `${rx}.d`); b.wire(load, `${rx}.en`); b.wire('clk', `${rx}.clk`);
    b.wire(my, `${ry}.d`); b.wire(load, `${ry}.en`); b.wire('clk', `${ry}.clk`);
    b.wire(mz, `${rz}.d`); b.wire(load, `${rz}.en`); b.wire('clk', `${rz}.clk`);
    b.wire('rotate', `${rr}.d`); b.wire('start', `${rr}.en`); b.wire('clk', `${rr}.clk`);
    // busy: set by a start, cleared after the last stage
    const keep = b.op1(AND, [`${busy}.q`, nl], undefined, 'keep');
    const nb = b.op1(OR, ['start', keep], undefined, 'nb');
    const one = b.op(TIE1, [], undefined, 'one');
    b.wire(nb, `${busy}.d`); b.wire(`${one}.y`, `${busy}.en`); b.wire('clk', `${busy}.clk`);
    // the count: back to 0 on a start or after the last stage, else up
    const inc = b.op1(countUp(k), [`${cnt}.q`], undefined, 'inc');
    const zero = b.op1(constWord(k, 0), [], undefined, 'c0');
    const toZero = b.op1(busMux2(k), [inc, zero, b.op1(NOT, [b.op1(AND, [nl, ns], undefined, 'go')], undefined, 'stop')], undefined, 'mc');
    b.wire(toZero, `${cnt}.d`); b.wire(load, `${cnt}.en`); b.wire('clk', `${cnt}.clk`);
    b.next();
    b.wire(`${rx}.q`, 'xo'); b.wire(`${ry}.q`, 'yo'); b.wire(`${rz}.q`, 'zo'); b.wire(`${busy}.q`, 'busy');
    const ports = [bus('x', s.w, 'in'), bus('y', s.w, 'in'), bus('z', s.z, 'in'), bit('rotate', 'in'), bit('start', 'in'), clkPort, bus('xo', s.w, 'out'), bus('yo', s.w, 'out'), bus('zo', s.z, 'out'), bit('busy', 'out')];
    return define({
      id: `cordic_iter${tag(s)}`, name: `CORDIC, iterative (${s.n} clocks a result)`, category: 'sequential',
      summary: 'The same three adders used once a clock, with shifters and a table where the stages had wires and constants. Start it, wait for busy to fall, and read the result.',
      ports, symbol: { kind: 'box', label: 'CORDIC', w: 10 }, netlist: () => built(b, ports),
    });
  });
}

/** Is this word `v`? */
function eqConst(k: number, v: number): ComponentDef {
  return memo(`cordic_is${k}_${v}`, () => {
    const b = new Builder(8, 8, 4);
    b.pins('a');
    let acc = '';
    for (let j = 0; j < k; j++) {
      const c = b.op1(cut(k, j, 1), ['a'], undefined, `b${j}`), t = (v >> j) & 1 ? c : b.op1(NOT, [c], undefined, `n${j}`);
      acc = acc ? b.op1(AND, [acc, t], undefined, `a${j}`) : t;
    }
    b.next();
    b.wire(acc, 'y');
    const ports = [bus('a', k, 'in'), bit('y', 'out')];
    return define({ id: `cordic_is${k}_${v}`, name: `Is it ${v}?`, category: 'arithmetic', summary: 'An AND of the bits, inverted where the number has a 0.', ports, symbol: { kind: 'box', label: `=${v}`, w: 4 }, spec: ([a]) => [a === v ? 1 : 0], netlist: () => built(b, ports) });
  });
}

/** The count's + 1, wrapping. */
function countUp(k: number): ComponentDef {
  return memo(`cordic_up${k}`, () => {
    const b = new Builder(8, 8, 4);
    b.pins('a');
    const gnd = b.op(TIE0, [], undefined, 'z');
    const one = b.op1(constWord(k, 1), [], undefined, 'c1');
    b.next();
    const s = b.op(addSub(k), ['a', one, `${gnd}.y`], undefined, 'add');
    b.next();
    b.wire(`${s}.s`, 'y');
    const ports = [bus('a', k, 'in'), bus('y', k, 'out')];
    return define({ id: `cordic_up${k}`, name: '+ 1', category: 'arithmetic', summary: 'The stage count\'s next value.', ports, symbol: { kind: 'box', label: '+1', w: 4 }, spec: ([a]) => [(a + 1) % 2 ** k], netlist: () => built(b, ports) });
  });
}

