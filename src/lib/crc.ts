// Chapter modem's CRC hardware: the register's next-state function as XOR trees (crcNext), and the register around it (crcUnit).
// The XOR network is read off the golden model (comm/crc.ts nextMatrix): the next state is linear in the state and the
// data, so bit i of it is the XOR of the inputs its row names. One bit a clock is the textbook shift register with a tap
// at each 1 of the generator; w bits at once is the same function applied w times, collapsed into one network.

import { evalPlan, nextMatrix, stepBits, xorPlan, CRC32_REFLECTED, type XorPlan } from '../comm/crc';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2 } from './combinational';
import { define, merger, ones, splitter } from './define';
import { OR, XOR } from './gates';
import { register } from './sequential';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

const hex = (v: number, n: number) => v.toString(16).padStart(Math.ceil(n / 4), '0').toUpperCase();
export const crcTag = (n: number, poly: number, w: number, share: boolean) => `crc${n}_${hex(poly, n)}_${w}${share ? 's' : ''}`;

const plans = new Map<string, XorPlan>();
/** The plan behind crcNext (cached): XOR2 gates and levels. */
export function crcPlan(n: number, poly: number, w: number, share: boolean): XorPlan {
  const k = crcTag(n, poly, w, share);
  let p = plans.get(k);
  if (!p) plans.set(k, (p = xorPlan(nextMatrix(n, poly, w), n + w, share)));
  return p;
}

/**
 * The register's next state: q (n bits) and d (w bits, the first bit sent in bit 0) to next. Combinational, XOR2 gates only.
 * `share`: common pairs of terms computed once (fewer gates, possibly deeper).
 */
export function crcNext(n = 32, poly = CRC32_REFLECTED, w = 8, share = true): ComponentDef {
  return memo(`next${crcTag(n, poly, w, share)}`, () => {
    const plan = crcPlan(n, poly, w, share), inputs = n + w;
    const level: number[] = new Array<number>(inputs).fill(0);
    plan.pairs.forEach(([a, b], k) => { level[inputs + k] = Math.max(level[a], level[b]) + 1; });
    const b = new Builder(8, 10, 2);
    b.pins('q', 'd');
    const sq = b.op(splitter(ones(n)), ['q']);
    const sd = b.op(splitter(ones(w)), ['d']);
    const src = (id: number) => (id < n ? `${sq}.o${id}` : `${sd}.o${id - n}`);
    const gate: string[] = [];
    const drv = (id: number) => (id < inputs ? src(id) : gate[id - inputs]);
    for (let lv = 1; lv <= plan.depth; lv++) {
      b.next();
      plan.pairs.forEach(([x, y], k) => {
        if (level[inputs + k] !== lv) return;
        gate[k] = b.op1(XOR, [drv(x), drv(y)]);
      });
    }
    b.next();
    const outs = plan.out.map((o) => drv(o));
    b.wire(b.op1(merger(ones(n)), outs), 'next');
    const id = `next${crcTag(n, poly, w, share)}`;
    return define({
      id, name: `CRC-${n} next state, ${w} bit${w > 1 ? 's' : ''} a step${share ? ' (shared terms)' : ''}`, category: 'gate',
      summary: `The register after ${w} bit${w > 1 ? 's' : ''}: every output bit is the XOR of some of the ${n} state bits and ${w} data bits, read off the generator 0x${hex(poly, n)} (reflected, least significant bit first). ${plan.gates} XOR gates in ${plan.depth} level${plan.depth > 1 ? 's' : ''}${share ? ', common pairs shared' : ''}.`,
      ports: [bus('q', n, 'in'), bus('d', w, 'in'), bus('next', n, 'out')],
      symbol: { kind: 'box', label: `CRC${n}+${w}` },
      spec: ([q, d]) => [stepBits(q, d, w, poly, n)],
      netlist: () => ({ pins: { q: [0, 2 + n], d: [0, 6 + n + w], next: [b.right, 2 + n] }, instances: b.instances, nets: unblocked(b, share ? Infinity : LONG) }),
    });
  });
}

/** The separate-terms block: 23 shared lines without this, none with it, 87 of 263 nets labels (63 before). */
const LONG = 250;

/**
 * The Builder's nets, with every wire that would cut through a gate drawn as labels instead: a single-sink net jumping a column
 * of XORs runs level with its ends, so a gate of a column between them standing across that band would sit on it. Also one whose
 * ends are more than `long` units apart (the separate-terms block, LONG): its tall XOR trees ran 200-300-unit wires down one channel, two on one line.
 * (Wires-first, view/wirefirst.ts, draws any of them as a wire again where one runs clear.)
 */
function unblocked(b: Builder, long = Infinity): NetDef[] {
  const at = new Map(b.instances.map((i) => [i.name, i]));
  const where = (end: string): [number, number] | null => {
    const k = end.indexOf('.');
    if (k < 0) return null;
    const i = at.get(end.slice(0, k))!, g = symbolGeom(i.def);
    return [i.at![0], i.at![1] + g.ports[end.slice(k + 1)].pos[1]];
  };
  return b.nets().map((n) => {
    if (n.tags || n.ends.length !== 2) return n;
    const a = where(n.ends[0]), s = where(n.ends[1]);
    if (!a || !s) return n;
    const y0 = Math.min(a[1], s[1]) - 0.5, y1 = Math.max(a[1], s[1]) + 0.5;
    const hit = b.instances.some((i) => { const [x, y] = i.at!, h = symbolGeom(i.def).h; return x > a[0] && x < s[0] && y < y1 && y + h > y0; });
    return hit || y1 - y0 > long ? { ...n, tags: true as const } : n;
  });
}

/** Software model of crcNext, from the plan (what the gates compute). */
export const crcNextRef = (n: number, poly: number, w: number, share: boolean, q: number, d: number): number =>
  Number(evalPlan(crcPlan(n, poly, w, share), n + w, BigInt(q) | (BigInt(d) << BigInt(n))));

/**
 * A CRC generator: n flip-flops, init loads all ones (whatever en says), en shifts w data bits in (the first sent in d[0]) at a rising
 * clock edge. q is the register; fcs = ~q is the check sequence as it goes on the wire (least significant byte first).
 */
export function crcUnit(n = 32, poly = CRC32_REFLECTED, w = 1, share = true): ComponentDef {
  return memo(`unit${crcTag(n, poly, w, share)}`, () => {
    const NEXT = crcNext(n, poly, w, share), REG = register(n), MX = busMux2(n), K = constWord(n, 2 ** n - 1), FC = bitwise('xor', n);
    const ng = symbolGeom(NEXT), mg = symbolGeom(MX), rg = symbolGeom(REG), fg = symbolGeom(FC);
    const y0 = 4, xn = 14, xm = xn + ng.w + 14, xr = xm + mg.w + 10, xf = xr + rg.w + 12, R = xf + fg.w + 12;
    const instances: InstanceDef[] = [
      { name: 'step', def: NEXT, at: [xn, y0 + 6], label: `${w} bit${w > 1 ? 's' : ''} a clock` },
      { name: 'init', def: MX, at: [xm, y0 + 6], label: 'init: all ones' },
      { name: 'reg', def: REG, at: [xr, y0] },
      { name: 'k', def: K, at: [xm - 10, y0 + 6 + mg.h + 6] },
      { name: 'ld', def: OR, at: [xr - 12, y0 + 24], label: 'load' },
      { name: 'fc', def: FC, at: [xf, y0 + rg.h + 4], label: 'FCS = ~q' },
    ];
    const yc = Math.max(y0 + 32, ...instances.map((i) => i.at![1] + symbolGeom(i.def).h)) + 3;
    const nets: NetDef[] = [
      { name: 'd', ends: ['d', 'step.d'] },
      { name: 'next', ends: ['step.next', 'init.a'] },
      { name: 'ones', ends: ['k.y', 'init.b', 'fc.b'], tags: true },
      { name: 'init', ends: ['init', 'init.s', 'ld.b'], tags: true },
      { name: 'dnext', ends: ['init.y', 'reg.d'] },
      { name: 'en', ends: ['en', 'ld.a'] },
      { name: 'load', ends: ['ld.y', 'reg.en'] },
      // under every part: from its pin below the drawing straight across, then up into the register's clock
      { name: 'clk', ends: ['clk', 'reg.clk'], via: { 'reg.clk': [[xr + rg.ports.clk.pos[0], yc]] } },
      { name: 'q', ends: ['reg.q', 'step.q', 'fc.a', 'q'], tags: true },
      { name: 'fcs', ends: ['fc.y', 'fcs'] },
    ];
    return define({
      id: `unit${crcTag(n, poly, w, share)}`, name: `CRC-${n} generator, ${w} bit${w > 1 ? 's' : ''} a clock${share ? ' (shared terms)' : ''}`, category: 'sequential',
      summary: `A ${n}-bit register holding the running CRC (reflected generator 0x${hex(poly, n)}), initialised to all ones, taking ${w} bit${w > 1 ? 's' : ''} per enabled clock edge through a network of XOR gates. fcs is the complement of q: the check sequence to append; after a received frame that ends with its own FCS, q is a constant that says it arrived whole.`,
      ports: [bus('d', w, 'in'), bit('en', 'in'), bit('init', 'in'), bit('clk', 'in', 'bottom', true), bus('q', n, 'out'), bus('fcs', n, 'out')],
      symbol: { kind: 'box', label: `CRC${n}` },
      netlist: () => ({ pins: { d: [0, y0 + 6 + ng.ports.d.pos[1]], en: [0, y0 + 24], init: [0, y0 + 28], clk: [0, yc], q: [R, y0 + rg.ports.q.pos[1]], fcs: [R, y0 + rg.h + 4 + fg.ports.y.pos[1]] }, instances, nets }),
    });
  });
}
