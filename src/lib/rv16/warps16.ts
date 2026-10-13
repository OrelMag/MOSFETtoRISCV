// Act 9's second half (roadmap Phase 15, 3c): the coalescer and the two-warp core, each built only
// from parts its level unlocks, so each is that level's reference.
//
//   COAL16     four word addresses and the mask in: the line of the lowest active lane (a line is four
//              RV16 words, address bits 15 … 2), the active lanes in it (served now), the rest (left)
//
// The serving rule is chapter 29's (lib/warpmem.ts serveLanes, 16-byte lines of RV32 bytes): the leader
// picks the line, every active lane in it rides along.

import type { ComponentDef, PortDef } from '../../sim/types';
import { constWord } from '../alu';
import { Builder } from '../builder';
import { equal } from '../combinational';
import { define, merger, ones, splitter } from '../define';
import { AND, NOT, OR } from '../gates';
import { bitwise } from '../wide';
import { NL } from './lanes16';
import { RV16_MUX4 } from './logic';

const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const L = [0, 1, 2, 3];
const each = (p: string) => L.map((i) => `${p}${i}`);

// ---- coalescer ---------------------------------------------------------------------------------------

/** Line of a word address: four 16-bit words share address bits 15 … 2. */
export const lineOf16 = (a: number) => (a & 0xffff) >>> 2;

/**
 * One access of the coalescer: the leader (lowest active lane) picks the line; served = the active lanes
 * in it, left = the other active lanes. No lane active: nothing served, line = lane 3's (a don't-care).
 */
export function coalesce16(addrs: number[], mask: number): { line: number; served: number; left: number } {
  const lead = L.find((i) => (mask >> i) & 1) ?? 3;
  const line = lineOf16(addrs[lead]);
  let served = 0;
  for (const i of L) if ((mask >> i) & 1 && lineOf16(addrs[i]) === line) served |= 1 << i;
  return { line, served, left: mask & ~served & 15 };
}

export const COAL16: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins(...each('a'), 'mask');
  const m = b.op(splitter(ones(NL), 2), ['mask'], 'lanes');
  const mb = (i: number) => `${m}.o${i}`;
  const hi = L.map((i) => `${b.op(splitter([2, 14], 2), [`a${i}`], `a${i} → line`)}.o1`);
  b.next();
  // the leader: 0 if m0, 1 if m1, 2 if m2, else 3 (as the mask's)
  const n0 = b.op1(NOT, [mb(0)]), n1 = b.op1(NOT, [mb(1)]), n2 = b.op1(NOT, [mb(2)]);
  b.next();
  const lo = b.op1(AND, [n0, b.op1(OR, [mb(1), n2])], 'lead bit 0');
  const hiB = b.op1(AND, [n0, n1], 'lead bit 1');
  b.next();
  const lead = b.op1(merger([1, 1], 2), [lo, hiB], 'leader');
  const z2 = b.op1(constWord(2, 0), []);
  const zs = L.map((i) => b.op1(merger([2, 14], 2), [z2, hi[i]], `line ${i}`));
  b.next();
  const ll = b.name(b.op1(RV16_MUX4, [...zs, lead], 'leader\'s line'), 'lline', true);
  b.next();
  const lsp = b.op(splitter([2, 14], 2), [ll]);
  const eq = [1, 2, 3].map((i) => b.op1(equal(14), [hi[i], `${lsp}.o1`], `lane ${i} same line?`));
  b.next();
  // lane 0, when active, is the leader: always in its own line
  const sv = [mb(0), ...[1, 2, 3].map((i, k) => b.op1(AND, [mb(i), eq[k]], `serve ${i}`))];
  b.next();
  const served = b.name(b.op1(merger(ones(NL), 2), sv, 'served'), 'served', true);
  b.next();
  b.wire(`${lsp}.o1`, 'line');
  b.wire(served, 'served');
  b.wire(b.op1(bitwise('xor', NL), ['mask', served], 'left = mask − served'), 'left');
  const R = b.right;
  return define({
    id: 'rv16_coal4', name: 'Coalescer (4 lanes, RV16)', category: 'memory',
    summary: 'One access for every lane whose word is in the same line: the leader (lowest active lane) picks the line (address bits 15 … 2: four 16-bit words), three 14-bit equality comparators find the other active lanes in it (served) and the rest wait for the next access (left).',
    ports: [...each('a').map((p) => bus(p, 16, 'in')), bus('mask', NL, 'in'), bus('line', 14, 'out'), bus('served', NL, 'out'), bus('left', NL, 'out')],
    symbol: { kind: 'box', label: 'COALESCER' },
    spec: (v) => {
      const r = coalesce16(v.slice(0, 4), v[4]);
      return [r.line, r.served, r.left];
    },
    netlist: () => ({ pins: { ...pinsAt([...each('a'), 'mask'], 0, 6), ...pinsAt(['line', 'served', 'left'], R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

