// The test levels (chapter "How do you know it works?", docs/PLAN-VERIFY.md): t_scan, a 4-bit scan register built from the
// flip-flop and the multiplexer the learner has; its pins, a long clocked sequence checked against a JS model, and the
// reference answer drawn as a sandbox chip. t_tests is a drill (drilltest.ts). No DOM.

import { type BuildChallenge, type PinSpec, type SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { Builder } from '../lib/builder';
import { merger, ones, splitter } from '../lib/define';
import { MUX2 } from '../lib/gates';
import { RV16_DFF } from '../lib/rv16/logic';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

/** The scan register's next state: se = 1 shifts si into bit 0 and every bit up one; se = 0 loads d. so is q3. */
export const scanNext = (q: number, d: number, si: number, se: number): number => (se ? ((q << 1) | si) & 15 : d & 15);

/** t_scan's test: shifts in, captures, shifts out, random mixes; q and so after every edge. */
export function scanSeq(n = 48): SeqStep[] {
  const r = rng(29);
  let q = 0;
  const st: SeqStep[] = [];
  const step = (d: number, si: number, se: number) => {
    q = scanNext(q, d, si, se);
    st.push({ set: { d, si, se }, tick: true, expect: { q, so: q >> 3 } });
  };
  step(0b1010, 0, 0);
  for (const b of [0, 0, 1, 1]) step(0b1111, b, 1); // shift 0011 in, most significant bit first, while d says otherwise
  step(0b0011, 1, 0); // capture
  for (const b of [1, 1, 0, 1]) step(0, b, 1); // shift 1101 in, the capture out at so
  for (let i = 0; i < n; i++) step(Math.floor(r() * 16), r() < 0.5 ? 1 : 0, r() < 0.6 ? 1 : 0);
  return st;
}

/** The reference: per bit a 2:1 multiplexer (d or the bit below, si for bit 0) in front of a 9-NAND flip-flop: 13 NANDs a bit. */
const SCAN4_REF: ComponentDef = (() => {
  const b = new Builder(6, 10, 4);
  b.pins('d', 'si', 'se', 'clk');
  const sd = b.op(splitter(ones(4), 6), ['d'], undefined, 'sd');
  b.next();
  for (let i = 0; i < 4; i++) b.op(MUX2, [`${sd}.o${i}`, '', 'se'], i === 0 ? 'si or d' : `q${i - 1} or d`, `m${i}`);
  b.next();
  for (let i = 0; i < 4; i++) b.op(RV16_DFF, [`m${i}.y`, 'clk'], `q${i}`, `f${i}`);
  b.wire('si', 'm0.b');
  for (let i = 1; i < 4; i++) b.wire(b.name(`f${i - 1}.q`, `q${i - 1}`, true), `m${i}.b`);
  b.next();
  b.wire(b.op1(merger(ones(4), 6), ['f0.q', 'f1.q', 'f2.q', 'f3.q'], undefined, 'mq'), 'q');
  b.wire('f3.q', 'so');
  return {
    id: 'scan4_ref', name: '4-bit scan register', category: 'custom',
    summary: 'q ← se ? (q << 1 | si) : d at each rising edge, so = q3: a multiplexer in front of each flip-flop, chained q → the next bit\'s mux.',
    ports: [
      { name: 'd', width: 4, dir: 'in' }, { name: 'si', width: 1, dir: 'in' }, { name: 'se', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true },
      { name: 'q', width: 4, dir: 'out' }, { name: 'so', width: 1, dir: 'out' },
    ],
    symbol: { kind: 'box', label: 'SCAN4' },
    netlist: () => ({ pins: {}, instances: b.instances, nets: b.nets() }),
  };
})();

let answer: ChipDoc[] | undefined;
const scanAnswer = (): ChipDoc[] => {
  if (!answer) {
    const doc = docFromDef(SCAN4_REF, { id: 'u_ref_cp_t_scan', name: '4-bit scan register ref' });
    if ('error' in doc) throw new Error(`reference t_scan: ${doc.error}`);
    answer = [{ ...doc, notes: `Reference answer. ${SCAN4_REF.summary}` }];
  }
  return answer;
};

export const BUILDT: Record<string, () => BuildChallenge> = {
  t_scan: () => ({
    id: 't_scan', title: '4-bit scan register', level: 'sequential', allowed: 'nand',
    brief: 'At a rising edge of <code>clk</code>: with <code>se</code> = 0, <b>q ← d</b> (the normal register); with se = 1, <b>q ← q shifted up one, si into bit 0</b> (the scan chain). <b>so</b> = q[3], the bit that leaves the chain next. Tested over 58 cycles of shifts and captures.',
    ports: pins([['d', 4], ['si'], ['se'], ['clk']], [['q', 4], ['so']], 'clk'), check: { kind: 'sequence', steps: scanSeq() },
    answer: scanAnswer,
  }),
};
