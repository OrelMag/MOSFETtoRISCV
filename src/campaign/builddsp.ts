// Act 13's build levels (Signals, the Signal processing level's optional act): a saturating adder, a biquad, Goertzel for one
// tone, a CIC decimator, a CORDIC stage and a sigma-delta loop, each checked against the chapter's model (dsp/). The reference
// answers are the chapters' library circuits drawn as chips. The MAC with guard bits and the circular address wait for the
// MAC unit and the DSP core. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { cordicStage as cordicModel, type CordicSpec } from '../dsp/cordic';
import { atanTable } from '../dsp/cordic';
import { wrapTo } from '../dsp/fixed';
import { cordicStage } from '../lib/cordic';
import { clampWord, satAdder } from '../lib/fixedpt';
import type { ComponentDef } from '../sim/types';
import { leafGives, pinsOf, refOf } from './buildcomm';

/** The word of the saturating adder level: 8 bits, so Check runs every pair (65 536). */
export const SAT_W = 8;
export const SAT_REF = (): ComponentDef => satAdder(SAT_W);
export const SAT_CLAMP = (): ComponentDef => clampWord(SAT_W);
/** The adder's parts, the clamp's included: the clamp itself is what the level builds. */
export const satGives = leafGives(SAT_REF, () => [SAT_CLAMP()]);

/** The CORDIC stage level: 5-bit x and y, a 5-bit angle (32 steps a turn), the stage that moves by 1 place: 5 + 5 + 5 + 1 = 16 inputs, so Check runs all 65 536. */
export const CORDIC_SPEC: CordicSpec = { w: 5, z: 5, n: 4 };
export const CORDIC_I = 1;
export const CORDIC_REF = (): ComponentDef => cordicStage(CORDIC_SPEC, CORDIC_I);
/** The stage's parts (adders, wiring, the angle constant): the stage itself is what the level builds. */
export const cordicGives = leafGives(CORDIC_REF, () => []);
/** The chapter's model on packed words: x, y, z as unsigned bit patterns, rotate 1 steers z to 0, 0 steers y to 0. */
export function cordicSpec([x, y, z, rot]: number[]): number[] {
  const s = CORDIC_SPEC, sg = (v: number, w: number) => wrapTo(v, w);
  const r = cordicModel({ x: sg(x, s.w), y: sg(y, s.w), z: sg(z, s.z) }, CORDIC_I, atanTable(s)[CORDIC_I], s, rot ? 'rotate' : 'vector');
  const u = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
  return [u(r.x, s.w), u(r.y, s.w), u(r.z, s.z)];
}

export const BUILDDSP: Record<string, () => BuildChallenge> = {
  sp_sat: () => ({
    id: 'sp_sat', title: 'Saturating adder', level: 'gates', allowed: 'nand',
    brief: `<b>a</b> and <b>b</b> are ${SAT_W}-bit two's complement words (−128 … 127). Make <b>y</b> = a + b when it fits, and the nearest end of the range when it does not: 127 + 1 is 127, −100 − 100 is −128. <b>sat</b> is 1 exactly when y was clamped. `
      + 'Check runs all 65 536 pairs against the chapter\'s model.',
    ports: pinsOf(SAT_REF()),
    check: { kind: 'table', spec: (ins) => SAT_REF().spec!(ins) },
    answer: refOf('sp_sat', SAT_REF, 'Saturating adder', () => [[SAT_CLAMP(), 'Clamp']]),
  }),

  // ---- sp_biquad (its entry goes below this line)

  // ---- sp_goertzel

  // ---- sp_cic

  // ---- sp_cordic
  sp_cordic: () => ({
    id: 'sp_cordic', title: 'A CORDIC stage', level: 'gates', allowed: 'nand',
    brief: `One stage of a CORDIC rotator, the one that moves by 1 place (angle atan ½): <b>x</b>, <b>y</b> are ${CORDIC_SPEC.w}-bit two's complement, <b>z</b> a ${CORDIC_SPEC.z}-bit angle in which ${2 ** CORDIC_SPEC.z} steps are a full turn (atan ½ is ${atanTable(CORDIC_SPEC)[CORDIC_I]} of them). `
      + 'Turn the vector by that angle one way or the other: <b>xo</b> = x ∓ (y ≫ 1), <b>yo</b> = y ± (x ≫ 1), <b>zo</b> = z ∓ atan ½, where ≫ drops bits toward −∞. '
      + 'With <b>rotate</b> = 1 the upper sign is taken when z ≥ 0, driving z toward 0; with rotate = 0 it is taken when y &lt; 0, driving y toward 0. Check runs every input (65 536) against the model of the chapter.',
    ports: pinsOf(CORDIC_REF()),
    check: { kind: 'table', spec: cordicSpec },
    answer: refOf('sp_cordic', CORDIC_REF, 'CORDIC stage'),
  }),

  // ---- sp_sd

};
