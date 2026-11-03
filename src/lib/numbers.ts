// Chapter 5's circuits: what a number costs in hardware before any adder exists. Negation from the gates of
// chapter 4 (no half adders yet), widening and constant shifts as pure wiring.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { define, merger, ones, splitter } from './define';
import { OR, XOR } from './gates';
import { TIE0 } from './transistors';

const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

function memo<A extends unknown[]>(f: (...a: A) => ComponentDef): (...a: A) => ComponentDef {
  const cache = new Map<string, ComponentDef>();
  return (...a: A) => {
    const k = JSON.stringify(a);
    let d = cache.get(k);
    if (!d) cache.set(k, (d = f(...a)));
    return d;
  };
}

/**
 * −a without an adder: ¬a + 1 keeps every bit up to and including the lowest 1 and inverts every bit above it,
 * so y[i] = a[i] XOR (a[i−1] OR … OR a[0]). The ORs ripple down a staircase like a carry.
 */
export const negator = memo((n: number): ComponentDef => {
  const P = 8, OX = (i: number) => 6 + 8 * i, XX = OX(n - 1) + 4, MX = XX + 8;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), P), at: [3, 1] },
    { name: 'my', def: merger(ones(n), P), at: [MX, 0] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] },
    { name: 'y', ends: ['my.out', 'y'] },
  ];
  // any_i = a[i] | … | a[0]: any_0 is a[0] itself
  const any = (i: number) => (i === 0 ? 'sa.o0' : `or${i}.y`);
  const sinks = new Map<string, string[]>([['sa.o0', ['my.i0']]]);
  const to = (drv: string, sink: string) => { if (!sinks.has(drv)) sinks.set(drv, []); sinks.get(drv)!.push(sink); };
  for (let i = 1; i < n; i++) {
    instances.push({ name: `x${i}`, def: XOR, at: [XX, 2 + P * i] });
    to(any(i - 1), `x${i}.a`);
    to(`sa.o${i}`, `x${i}.b`);
    nets.push({ name: `y${i}`, ends: [`x${i}.y`, `my.i${i}`] });
    if (i < n - 1) {
      instances.push({ name: `or${i}`, def: OR, at: [OX(i), 6 + P * i] });
      to(`sa.o${i}`, `or${i}.a`);
      to(any(i - 1), `or${i}.b`);
    }
  }
  for (const [d, ss] of sinks) nets.push({ name: d === 'sa.o0' ? 'a0' : d.startsWith('sa.') ? `a${d.slice(4)}` : `any${d.slice(2, -2)}`, ends: [d, ...ss] });
  const M = mask(n);
  return define({
    id: `negate${n}`, name: `${n}-bit negator`, category: 'arithmetic',
    summary: 'Two\'s-complement negation from XORs and ORs: every bit above the lowest 1 is inverted, the rest pass.',
    ports: [bus('a', n, 'in'), bus('y', n, 'out')],
    symbol: { kind: 'box', label: '−a' },
    spec: ([a]) => [(M + 1 - a) & M],
    netlist: () => ({ pins: { a: [0, 1 + (P * n) / 2], y: [MX + 4, (P * n) / 2] }, instances, nets }),
  });
});

/** Widen m bits to n two ways at once: s copies the top bit (sign extension), z fills with 0 (zero extension). */
export const extender = memo((m: number, n: number): ComponentDef => {
  const Z = 2 * n + 6;
  const instances: InstanceDef[] = [
    { name: 'ss', def: splitter(ones(m)), at: [6, 0] },
    { name: 'ms', def: merger(ones(n)), at: [16, 0], label: 'sign' },
    { name: 'sz', def: splitter(ones(m)), at: [6, Z] },
    { name: 'mz', def: merger(ones(n)), at: [16, Z], label: 'zero' },
    { name: 'gnd', def: TIE0, at: [9, Z + 2 * m + 1] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'ss.in', 'sz.in'], trunk: 3 },
    { name: 's', ends: ['ms.out', 's'] },
    { name: 'z', ends: ['mz.out', 'z'] },
    { name: 'gnd', ends: ['gnd.y', ...Array.from({ length: n - m }, (_, i) => `mz.i${m + i}`)], trunk: 13 },
  ];
  for (let i = 0; i < m; i++) {
    const top = i === m - 1 ? Array.from({ length: n - m }, (_, k) => `ms.i${m + k}`) : [];
    nets.push({ name: i === m - 1 ? 'sign' : `s${i}`, ends: [`ss.o${i}`, `ms.i${i}`, ...top], trunk: i === m - 1 ? 13 : undefined });
    nets.push({ name: `z${i}`, ends: [`sz.o${i}`, `mz.i${i}`] });
  }
  const top = 2 ** (m - 1), fill = mask(n) - mask(m);
  return define({
    id: `extend${m}_${n}`, name: `Extend ${m}→${n} bits`, category: 'plumbing',
    summary: `Sign extension copies bit ${m - 1} into bits ${n - 1}…${m}; zero extension ties them to 0. Both are wiring: no gates.`,
    ports: [bus('a', m, 'in'), bus('s', n, 'out'), bus('z', n, 'out')],
    symbol: { kind: 'box', label: 'EXT' },
    spec: ([a]) => [a & top ? a + fill : a, a],
    netlist: () => ({ pins: { a: [1, Z / 2 + m / 2], s: [20, n], z: [20, Z + n] }, instances, nets }),
  });
});

/** The three shifts by one place, each a splitter and a merger offset by one row: wiring, no gates. */
export const shifts1 = memo((n: number): ComponentDef => {
  const H = 2 * n + 8;
  const instances: InstanceDef[] = [];
  const nets: NetDef[] = [];
  const aEnds = ['a'];
  // block k: out[i] = in[i + d], so its merger sits d rows below its splitter and every wire runs straight
  const blocks: { k: string; d: number; fill: 'zero' | 'sign' }[] = [
    { k: 'sll', d: -1, fill: 'zero' }, { k: 'srl', d: 1, fill: 'zero' }, { k: 'sra', d: 1, fill: 'sign' },
  ];
  blocks.forEach(({ k, d, fill }, b) => {
    const Y = 4 + H * b;
    instances.push({ name: `s_${k}`, def: splitter(ones(n)), at: [6, Y] });
    instances.push({ name: k, def: merger(ones(n)), at: [16, Y + 2 * d] });
    aEnds.push(`s_${k}.in`);
    nets.push({ name: k, ends: [`${k}.out`, k] });
    for (let i = 0; i < n; i++) {
      const src = i + d; // out[i] = in[i + d]
      if (src < 0 || src >= n) continue;
      const extra = fill === 'sign' && src === n - 1 ? [`${k}.i${n - 1}`] : [];
      nets.push({ name: `${k}${i}`, ends: [`s_${k}.o${src}`, `${k}.i${i}`, ...extra] });
    }
    if (fill === 'zero') {
      const gap = d < 0 ? 0 : n - 1;
      instances.push({ name: `z_${k}`, def: TIE0, at: [11, Y + 2 * d + 2 * gap] });
      nets.push({ ends: [`z_${k}.y`, `${k}.i${gap}`] });
    }
  });
  nets.unshift({ name: 'a', ends: aEnds, trunk: 3 });
  const M = mask(n), top = 2 ** (n - 1);
  return define({
    id: `shifts1_${n}`, name: `${n}-bit shifts by one`, category: 'plumbing',
    summary: 'Shift left, logical right and arithmetic right by one place: each a splitter and a merger one row apart. Wiring, no gates.',
    ports: [bus('a', n, 'in'), bus('sll', n, 'out'), bus('srl', n, 'out'), bus('sra', n, 'out')],
    symbol: { kind: 'box', label: '≪ ≫' },
    spec: ([a]) => [(a * 2) & M, a >>> 1, (a >>> 1) | (a & top)],
    netlist: () => ({
      pins: { a: [1, 4 + H + n], sll: [20, 2 + n], srl: [20, 6 + H + n], sra: [20, 6 + 2 * H + n] },
      instances, nets,
    }),
  });
});

export const NEGATE4 = negator(4);
export const EXTEND4_8 = extender(4, 8);
export const SHIFTS8 = shifts1(8);
