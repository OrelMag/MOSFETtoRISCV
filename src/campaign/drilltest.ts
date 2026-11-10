// The test-set drill (t_tests, docs/PLAN-VERIFY.md): small gate-level blocks whose stuck-at faults the learner catches with
// as few input vectors as possible, checked by the fault simulator (sim/faultsim.ts), the smallest set found exactly. The
// faults are the chapter's: every input bit and every NAND output stuck at 0 or at 1. No DOM.

import { FULL_ADDER, HALF_ADDER } from '../lib/combinational';
import { CONSENSUS } from '../lib/dft';
import { AND, MUX2, NOR, OR, XNOR, XOR } from '../lib/gates';
import { allVectors, coveredBy, detect, detectable, exactCover, faultModel, faultName, type Detection, type FaultModel } from '../sim/faultsim';
import { inPorts, type ComponentDef } from '../sim/types';
import type { Drill, Question } from './drills';

/** The blocks asked about: NAND drawings of one to three 1-bit inputs. */
export const TEST_BLOCKS: { def: ComponentDef; name: string }[] = [
  { def: AND, name: 'the AND gate (a NAND and an inverter)' },
  { def: OR, name: 'the OR gate (two inverters into a NAND)' },
  { def: NOR, name: 'the NOR gate (an OR and an inverter)' },
  { def: XOR, name: 'the 4-NAND XOR' },
  { def: XNOR, name: 'the XNOR (the 4-NAND XOR and an inverter)' },
  { def: MUX2, name: 'the 2:1 multiplexer (4 NANDs)' },
  { def: HALF_ADDER, name: 'the half adder (XOR and AND)' },
  { def: FULL_ADDER, name: 'the 9-NAND full adder' },
  { def: CONSENSUS, name: 'the consensus circuit y = a·b + ¬a·c, with the redundant term b·c' },
];

export interface BlockFaults {
  m: FaultModel;
  d: Detection;
  /** Faults some vector detects. */
  testable: number[];
  /** A smallest set of vectors detecting every testable fault (exact). */
  smallest: number[];
  /** Input names, first port first: the order a vector is written in. */
  names: string[];
}

const cache = new Map<string, BlockFaults>();
export function blockFaults(def: ComponentDef): BlockFaults {
  let b = cache.get(def.id);
  if (!b) {
    const m = faultModel(def);
    if (typeof m === 'string') throw new Error(`${def.id}: ${m}`);
    const d = detect(m, allVectors(m));
    const testable = detectable(d, m.faults.length);
    const smallest = exactCover(d, m.faults.length);
    if (!smallest) throw new Error(`${def.id}: no exact cover`);
    b = { m, d, testable, smallest, names: inPorts(def).map((p) => p.name) };
    cache.set(def.id, b);
  }
  return b;
}

/** A vector as typed: the input bits in port order, the first port's bit leftmost ("011" = a 0, b 1, cin 1). */
export const vectorText = (b: BlockFaults, v: number): string => b.names.map((_, i) => (v >> i) & 1).join('');

/** The learner's vectors: words of 0 / 1, one bit per input (separated by spaces, commas or semicolons). */
export function parseVectors(b: BlockFaults, s: string): number[] | string {
  const words = s.trim().split(/[\s,;]+/).filter(Boolean);
  if (!words.length) return 'Give at least one vector.';
  const out: number[] = [];
  for (const w of words) {
    if (!/^[01]+$/.test(w) || w.length !== b.names.length) return `"${w}": write ${b.names.length} bits, ${b.names.join(' ')} in that order.`;
    const v = [...w].reduce((acc, c, i) => acc | (Number(c) << i), 0);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Why a set is not the answer, or nothing when it is: complete (every testable fault) and no larger than the smallest. */
export function judgeSet(b: BlockFaults, vecs: number[]): string | undefined {
  const caught = new Set(coveredBy(b.d, b.m.faults.length, vecs));
  const missed = b.testable.filter((f) => !caught.has(f));
  if (missed.length) return `${missed.length} fault${missed.length > 1 ? 's' : ''} escape${missed.length > 1 ? '' : 's'}, for example ${faultName(b.m, missed[0])}.`;
  if (vecs.length > b.smallest.length) return `Every fault is caught, with ${vecs.length} vectors: ${b.smallest.length} are enough.`;
  return undefined;
}

const sites = (b: BlockFaults) => b.m.sites.length;

function smallestQuestion(r: () => number): Question {
  const blk = TEST_BLOCKS[Math.floor(r() * TEST_BLOCKS.length)];
  const b = blockFaults(blk.def), untestable = b.m.faults.length - b.testable.length;
  return {
    prompt: `Give a smallest set of input vectors that catches every stuck-at fault of <b>${blk.name}</b> that any vector can catch. Write each vector as the bits <code>${b.names.join(' ')}</code>.`,
    placeholder: b.names.map(() => '0').join('') + ' ' + b.names.map(() => '1').join(''),
    check: (a) => {
      const v = parseVectors(b, a);
      if (typeof v === 'string') return { ok: false, why: v };
      const why = judgeSet(b, v);
      return why ? { ok: false, why } : { ok: true };
    },
    answer: b.smallest.map((v) => vectorText(b, v)).join(' '),
    explain: `${sites(b)} nets (${b.names.length} inputs and ${sites(b) - b.names.length} NAND outputs), so ${b.m.faults.length} faults${untestable ? `, ${untestable} of which no vector shows: it sits on the redundant term` : ''}. ${b.smallest.length} vectors catch the rest; each one activates some faults (drives the net to the opposite of its stuck value) and carries the difference to an output.`,
  };
}

function countQuestion(r: () => number): Question {
  const blk = TEST_BLOCKS[Math.floor(r() * TEST_BLOCKS.length)];
  const b = blockFaults(blk.def);
  const n = b.m.faults.length;
  return {
    prompt: `How many stuck-at faults does <b>${blk.name}</b> have? Count every input bit and every NAND's output, each stuck at 0 and at 1 (an inverter is a NAND with its inputs joined).`,
    placeholder: 'a number',
    check: (a) => {
      const x = Number(a.trim());
      if (!Number.isInteger(x)) return { ok: false, why: 'A whole number.' };
      if (x === n / 2) return { ok: false, why: `That is the number of nets; each can be stuck at 0 or at 1.` };
      return x === n ? { ok: true } : { ok: false, why: `${b.names.length} inputs and ${sites(b) - b.names.length} NANDs.` };
    },
    answer: String(n),
    explain: `${b.names.length} inputs + ${sites(b) - b.names.length} NAND outputs = ${sites(b)} nets, two faults each: ${n}.`,
  };
}

export const testset: Drill = {
  id: 'testset', title: 'Catch every fault', goal: 4,
  how: 'A stuck-at fault holds one net at 0 or 1 whatever drives it. A vector catches it when some output differs from the good circuit\'s. Write vectors as bits in the order given (<code>011 101</code>), as few as catch every fault a vector can catch; counts as a number.',
  make: (r) => (r() < 0.75 ? smallestQuestion(r) : countQuestion(r)),
};
