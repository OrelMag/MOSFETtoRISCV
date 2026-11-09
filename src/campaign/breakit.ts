// Break-it levels (docs/PLAN-ONI.md D2): FIND IT. The drawing is the earlier level's own reference answer, right, and a
// fault is planted in its silicon (BuildChallenge.planted: a net stuck at 0 or 1, never drawn). Check runs with the fault
// and shows the failing cases, which are the clues; it never passes. The learner names the fault with the fault brush
// (B: "It is stuck at 0 here"), and an accusation is right when it looks the same from outside on every case of the test
// (editor/challenges.ts symptomsDiffer); each wrong one costs a star (par: no wrong accusation). No DOM.

import type { BuildChallenge, PlantedFault } from '../editor/challenges';
import type { CampaignNode, ChapterLink } from './types';

interface Find {
  id: string;
  /** The level whose block it breaks: its reference answer is the drawing, its check the test. */
  after: string;
  title: string;
  /** HTML: the report (the level's why). */
  report: string;
  tips: string[];
  planted: PlantedFault;
  /** HTML: what the fault was and how it showed (Show answer, the after-pass card). */
  fault: string;
  marks: string[];
  codex?: string[];
  chapters?: ChapterLink[];
}

const STUCK = 'Stuck at: a manufacturing defect, not a design mistake. A short to a rail, an open via, a gate oxide that broke down: the net reads one value whatever drives it. The drawing is right, so reading it finds nothing; the outputs are the clue. Which cases fail, and how, narrows it to the nets that could make exactly those cases wrong; a fault you plant yourself on a guess shows whether it would. Chip testers do this with scan chains and test vectors chosen so every stuck-at fault changes some output.';


const FINDS: Find[] = [
  {
    id: 'x_add4', after: 'a_add4', title: 'A carry that never comes',
    report: 'Your 4-bit adder came back from the fab and some of its sums are wrong. The drawing is the one that passed; something in the silicon is not. Check shows which sums fail. Find the net and name it with the fault brush (B): a wrong accusation costs a star.',
    tips: ['Only sums that carry out of bit 1 are wrong. Which nets carry that?', 'Every wrong sum is 4 too small: a carry into bit 2 is lost.', 'The carry into fa2 (fa1’s cout) is stuck at 0.'],
    planted: { kind: 'stuck0', end: 'fa2.cin' },
    fault: 'The carry into bit 2 (fa1.cout → fa2.cin) was stuck at 0: every sum whose bit-1 column carried came out 4 too small, and the carry out never rose for those.',
    marks: ['fa2'], codex: ['fulladder'],
  },
  {
    id: 'x_dec', after: 'g_dec', title: 'Two lines at once',
    report: 'A decoder from the same wafer: for some addresses two output lines are high at once. The drawing is right. Find the fault and name it with the fault brush (B).',
    tips: ['Which line is high in every failing case, whatever the address?', 'y5 reads 1 even with en = 0.', 'y5’s gate output is stuck at 1.'],
    planted: { kind: 'stuck1', end: 'y5.y' },
    fault: 'Output line 5 (gate y5) was stuck at 1: high for every address and with the decoder disabled, so every other address lit two lines.',
    marks: ['y5'],
  },
  {
    id: 'x_cnt', after: 's_cnt4', title: 'A bit that never rises',
    report: 'A counter that skips: it runs 0, 1, 2, 3 and then back to 0 … and some counts never come. The drawing is right. Find the fault and name it with the fault brush (B); the timing panel shows which bit never moves.',
    tips: ['Watch q bit by bit: one of them never becomes 1.', 'q[2] stays 0. Is that bit stored wrong, or is it never asked to be 1?', 'Bit 2 of the register’s d input is stuck at 0.'],
    planted: { kind: 'stuck0', end: 'reg.d', bit: 2 },
    fault: 'Bit 2 of the register’s input (reg.d[2]) was stuck at 0: the incrementer asked for 4 and the register stored 0, so the count wrapped from 3 to 0.',
    marks: ['reg'],
  },
  {
    id: 'x_core', after: 'c_core3', title: 'One bit of B',
    report: 'Your RV16I core runs some programs and fails others. The drawing passed; this die does not. The CPU bench names the first instruction that went wrong; from there, find the net and name it with the fault brush (B). Here an accusation has to name the very net, one bit wide.',
    tips: ['Which instructions go wrong: those with an immediate, or those reading rs2 too?', 'The results are off by 8 when the second operand has bit 3 clear.', 'Bit 3 of the ALU’s b input is stuck at 1.'],
    planted: { kind: 'stuck1', end: 'u6.b', bit: 3 },
    fault: 'Bit 3 of the ALU’s second operand (u6.b[3]) was stuck at 1: any operation whose b had bit 3 clear got 8 more in b (an add 8 too much, a compare that could flip, a branch that went the wrong way).',
    marks: ['u6'],
  },
];

export const BREAK_IT_IDS = FINDS.map((f) => f.id);

function findChallenge(f: Find, target: () => BuildChallenge): () => BuildChallenge {
  return () => {
    const t = target();
    return {
      ...t, id: f.id, title: f.title,
      brief: `The block is drawn right and a fault is planted in it: a net stuck at 0 or at 1. Check shows the failing cases. Name the net with the fault brush (B): a click on its wire, then “It is stuck at 0 here” or “… at 1”. The test is the one “${t.title}” passed. ${t.brief}`,
      // the reference answer is the drawing (start); its sub-chips keep their ids
      start: () => t.answer(), planted: [f.planted],
    };
  };
}

/** The break-it nodes, given the levels they hang off (act: the Debugging act). */
export function breakItNodes(byId: Map<string, CampaignNode>, act: number): Map<string, CampaignNode> {
  const out = new Map<string, CampaignNode>();
  for (const f of FINDS) {
    const a = byId.get(f.after);
    if (!a?.base) throw new Error(`break it ${f.id}: no build level ${f.after}`);
    out.set(f.after, {
      id: f.id, act, title: f.title, kind: a.kind === 'core' ? 'core' : 'build', optional: true, requires: [f.after],
      why: f.report, tips: f.tips, codex: f.codex ?? [], par: { wrong: 0 }, ...(f.chapters ? { chapters: f.chapters } : {}),
      bug: { after: f.after, fault: f.fault, kind: 'stuck at', lesson: STUCK, marks: f.marks, find: true },
      base: findChallenge(f, a.base),
    });
  }
  return out;
}
