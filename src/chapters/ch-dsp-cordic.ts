// Turning by shifting (level Signal processing): can you rotate with no multiplier? CORDIC, iterative and pipelined, in gates (lib/cordic.ts), compared with dsp/cordic.ts every clock and with
// Math at every angle a word can hold (tests/dsp-cordic.test.ts). The costs on this page are measured from the gates, and the table's baseline is the same sine ROM the modem chapter uses.

import { cordicStretch, type CordicSpec } from '../dsp/cordic';
import { cordicIterative, cordicPipeline, cordicStage } from '../lib/cordic';
import { NCO, SINE_ROM } from '../lib/modem';
import { treeMul } from '../lib/muldiv';
import { register } from '../lib/sequential';
import { stats } from '../sim/stats';
import { cordicApi, cordicBits, cordicScene, costWidget, romBits, rotateWidget, SCENE_SPEC, sineRom, vectorWidget, wordsWidget } from '../widgets/dspcordic';
import { numOf } from './order';
import type { Chapter } from './types';

const n0 = (x: number) => x.toLocaleString('en').replace(/,/g, ' ');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const S: CordicSpec = { w: 14, z: 14, n: 12 };
const K = 1 / cordicStretch(24);
const MUL = () => nands(treeMul(16, true));
const STAGE = () => nands(cordicStage(S, 3));
/** x, y, z and the mode bit, after the half-turn and after each stage. */
const PIPE_REGS = () => (SCENE_SPEC.n + 1) * (2 * nands(register(SCENE_SPEC.w)) + nands(register(SCENE_SPEC.z)) + nands(register(1)));

export const chCordic: Chapter = {
  id: 'cordic', num: numOf('cordic'), title: 'Turning by shifting', level: 'Signal processing',
  blurb: 'Can you rotate with no multiplier? CORDIC: a vector turned by adding shifted copies of itself, iterative and pipelined in gates, with sine, arctangent and magnitude, against a ROM of sines.',
  goals: [
    'turn a vector by adding shifted copies of it, and say why the angles are atan 2^−i',
    'state where the gain of 1.6468 comes from, and why it is paid once, up front',
    'run the same stages backwards for arctangent and magnitude',
    'price a pipelined and an iterative CORDIC against a table of sines, in NANDs and in clocks',
  ],
  builds: ['muldiv', 'modem', 'signals'],
  recap: {
    keep: [
      'A rotation is four multiplications. Choosing angles whose tangent is 2^−i turns them into shifts, so each stage is a pair of adders and wiring.',
      'Every stage turns one way or the other, never not at all. So the vector grows by the same factor whatever the angle, and starting from 0.607253 pays for it once.',
      'Rotating steers the angle to 0 and reads sine and cosine. Vectoring steers y to 0 and reads arctangent and magnitude. They are the same three adders, with a different test.',
      'Stages give about a bit each. The word has to grow with them, because every stage truncates.',
      'A table is unbeatable while it is small, and doubles with each address bit. CORDIC grows with the square of the accuracy, so past about 6 bits it wins, unless the table is interpolated.',
    ],
    check: [
      {
        question: 'Why does CORDIC use the angles atan 1, atan ½, atan ¼ and so on?',
        options: ['Their tangents are powers of two', 'They add up to exactly 90°', 'Only those angles fit in a small ROM', 'They keep the vector\'s length at 1'],
        answer: 0,
        explain: 'A rotation has a factor of tan θ on each cross term. With tan θ = 2^−i, that multiplication is a shift, and a shift is wiring.',
        why: ['', 'They add up to about 99.9°, which is why a half-turn has to handle the rest of the circle.', 'A ROM could hold any angle. What matters is what the angle does to the multiplications.', 'The length grows at every stage. That is the gain the start value pays for.'],
      },
      {
        question: 'Why can the gain be paid in advance, by a single constant?',
        options: ['Every stage always runs, either way', 'The gain is exactly 1 after 16 stages', 'The ROM of angles corrects it as it goes', 'Each stage divides the vector back down'],
        answer: 0,
        explain: 'A stage multiplies the length by √(1 + 2^−2i) whichever way it turned, since cos(−θ) = cos θ. Only if a stage could be skipped would the gain depend on the angle.',
        why: ['', 'It tends to about 1.6468, and stays there.', 'The angles only steer. They never touch the length.', 'Nothing divides. Each stage lengthens, which is why x and y need headroom.'],
      },
      {
        question: 'You need a sine to about 12 bits at one result a clock. Which do you price first?',
        options: ['A pipelined CORDIC', 'An iterative CORDIC', 'A full-period ROM with 2^6 words', 'Four tree multipliers'],
        answer: 0,
        explain: 'A plain table of that accuracy costs several times more. With no interpolation it gains about a bit per address bit, and doubles its size each time. At 12 bits the pipeline is the smaller of the two, and it also gives arctangent and magnitude.',
        why: ['', 'It is by far the smallest, and it takes 17 clocks a result, not one.', 'Sixty-four words give about 3 bits.', 'Multipliers still need the sine and cosine they are to multiply by.'],
      },
    ],
  },
  steps: [
    {
      title: 'A rotation is four multiplications',
      get body() {
        return `
        <p>Turning a vector (x, y) by θ takes four products: x′ = x cos θ − y sin θ, y′ = y cos θ + x sin θ. A mixer needs this, and so does a phase-locked loop, a beamformer, and an FFT's butterfly. In <a href="#/c/muldiv/5">the multiplier chapter</a>'s tree form, 16 × 16 costs ${n0(MUL())} NANDs, so one rotation in a clock is ${n0(4 * MUL())} NANDs, and that is before anybody has found the sine and cosine.</p>
        <p>Finding them has been a table so far. <a href="#/c/modem/2">The modem's oscillator</a> looks up a 64-entry ROM of 6-bit samples, ${n0(nands(SINE_ROM))} NANDs of its ${n0(nands(NCO))}, and that is fine for a modem. Each extra bit of angle doubles the table.</p>
        <p>In 1959 Jack Volder of Convair published an answer built for real-time airborne computing. <strong>CORDIC</strong>, the COordinate Rotation DIgital Computer, starts here: take out cos θ, and what is left is x′ = cos θ (x − y tan θ), y′ = cos θ (y + x tan θ). If tan θ is a power of two, each multiplication is a shift. And a shift, as <a href="#/c/signals/4">the filter in gates</a> showed, is only how the wires are laid.</p>
        <p>So never turn by the angle you want. Turn by a sequence of fixed angles, atan 1, atan ½, atan ¼, …, each one way or the other, until the sum comes close enough.</p>`;
      },
      challenge: {
        kind: 'quiz', question: 'Which part of a rotation does choosing tan θ = 2^−i remove?',
        options: ['The two multiplications by tan θ', 'The cos θ in front of them', 'The need for any adder', 'The need to know the angle\'s sign'],
        answer: 0,
        explain: 'With cos θ factored out, the cross terms carry tan θ. A power of two there is wiring. The cos θ is what is left over, as a gain, and the next steps deal with it.',
        why: ['', 'That factor stays, and becomes the gain of the whole process.', 'The adders are exactly what is left.', 'The sign is what decides which way each stage turns.'],
      },
    },
    {
      title: 'One way or the other',
      body: `
        <p>Keep the angle still to go in a third register, z. At stage i, look at its sign. If z ≥ 0, turn by +atan 2^−i and take that from z. If z < 0, turn the other way and add it. Three additions a stage:</p>
        <pre>x′ = x − d · (y ≫ i)
y′ = y + d · (x ≫ i)
z′ = z − d · atan 2^−i          d = +1 if z ≥ 0, else −1</pre>
        <p>The first stages turn by 45°, then 26.57°, 14.04°, 7.13°, each a little over half the last, which is why the later ones can always make up for what the earlier ones overshot. So z closes in on 0 by about a bit a stage. It is a search, like long division, and it always has to go somewhere: there is no "leave this one out".</p>
        <p>The angles add up to about 99.9°, so the stages alone reach only that far either side of the axis. The rest of the circle is cheap. Past ±90° the two top bits of the angle differ, and then a half-turn goes first: negate x and y, and flip the top bit of z, which is half a turn since the whole word is one turn. An angle held this way wraps at the circle by itself, as an adder does at its word.</p>
        <div class="try">Set stages to 0 and step up one at a time. Watch the angle left halve. Then try 170°, and see the half-turn.</div>`,
      widget: rotateWidget,
      challenge: {
        kind: 'quiz', question: 'An angle of 120° is asked for. What happens first?',
        options: ['A half-turn, leaving −60°', 'Stages run until they reach 99.9°', 'The ROM looks up 120° directly', 'Nothing: it ends 20.1° out'],
        answer: 0,
        explain: 'The top two bits of 120° differ, since it is past 90°. Turning by 180° leaves −60°, which the stages can reach. Negating and flipping one bit are all it costs.',
        why: ['', 'A stage has to turn, and nothing limits it there. The half-turn is there so that never arises.', 'The only table holds the fixed angles, not the target.', 'That would be so without the half-turn, and it is why there is one.'],
      },
    },
    {
      title: 'The gain nobody can avoid',
      body: `
        <p>Each stage drops a cos θ, so it lengthens the vector by 1 / cos(atan 2^−i) = √(1 + 2^−2i). That is 1.414 at stage 0, 1.118 at stage 1, and rapidly nearer 1. Over many stages the product settles at ${(1 / K).toFixed(4)}.</p>
        <p>Here the "one way or the other" pays off. Every stage runs, whatever the angle, and cos(−θ) = cos θ. So the gain never depends on what was asked for, and it can be paid once, before anything starts: to get cosine and sine, begin at x = ${K.toFixed(6)}, y = 0, and no multiplier is needed at the end.</p>
        <p>The vector grows along the way. An input with both coordinates at full scale is √2 long, and stretched that becomes ${(Math.SQRT2 / K).toFixed(2)} times the range of either one, so x and y need two more bits at the top. Nothing here saturates: the sizing keeps it from having to.</p>
        <p>The chapter's other unavoidable fact is truncation. Moving a word down i places drops bits, and the model and the gates drop them the same way: toward −∞, because an arithmetic shift is wiring and has nowhere to round.</p>
        <div class="try">Clear "Start from 0.6073", and watch the vector leave the circle. Then put it back.</div>`,
      widget: rotateWidget,
      challenge: {
        kind: 'quiz', question: 'If a design skipped stages when z was already small, what would it lose?',
        options: ['The constant gain', 'Nothing: fewer stages is just faster', 'The half-turn at the start', 'The ROM of angles'],
        answer: 0,
        explain: 'It is exactly because every stage always runs that the gain is one fixed number. Skip some and each angle gets its own gain, so a real multiplication would be needed at the end.',
        why: ['', 'It would save clocks, and pay for them with the multiplier CORDIC exists to avoid.', 'The half-turn is decided before any stage.', 'The table is still needed for the stages that run.'],
      },
    },
    {
      title: 'A stage is three adders',
      get body() {
        return `
        <p>Here is what the formula costs. Stage 3 of a 14-bit design is ${n0(STAGE())} NANDs, and all but a handful are in its adders. There are three <a href="#/c/adders/5">adder / subtractors</a>, for x, y and z, whose subtract lines come from one test. The shifts are wiring, and atan 2^−3 is a constant tied to the rails. Open one and look: a part labelled ≫ 3 costs nothing.</p>
        <p>The pipeline puts a register after each stage, plus a half-turn at the front. So it takes ${SCENE_SPEC.n + 1} clocks to fill, and from then on one result leaves on every clock. This one is ${SCENE_SPEC.w} bits with ${SCENE_SPEC.n} stages, ${n0(nands(cordicPipeline(SCENE_SPEC)))} NANDs, of which ${n0(PIPE_REGS())} are its registers.</p>
        <div class="try">Run a full turn. The output traces a sine and a cosine, ${SCENE_SPEC.n + 1} clocks late, with the model checked at every clock.</div>`;
      },
      scene: cordicScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run a full turn through the gates, with every clock agreeing with the model.',
        check: (st) => { const a = cordicApi.get(st); return !!a && a.clocks() > 0 && a.agrees(); },
        hints: ['The panel beside the circuit has one button.'],
        answer: `Sixty-four angles go in, one a clock. Each result comes out ${SCENE_SPEC.n + 1} clocks after its angle, so the curves start late and the last angles need extra clocks to clear.`,
        solve: (st) => { cordicApi.get(st)?.run(); },
      },
    },
    {
      title: 'Run it backwards',
      body: `
        <p>Change one thing: instead of steering z to 0, steer y to 0, so each stage turns the vector toward the x axis. It is the same stage with a different test: d comes from y's sign and not z's. Now z starts at 0 and adds up every turn that was made.</p>
        <p>When y has reached 0, the vector lies along the axis, so x holds its length, still stretched by ${(1 / K).toFixed(4)}, and z holds its angle. That is <strong>vectoring</strong>: arctangent and magnitude from the same three adders, where a table of arctangents would need two inputs, and a magnitude would need two multipliers and a square root.</p>
        <p>Both are wanted constantly. The phase of a received sample is an arctangent, so it decides a QPSK symbol or an FM station's audio, as a later chapter on a software radio will use. The length of a complex sample is what any spectrum displays. A pipelined design can take either mode on each clock, since the mode bit travels through the registers with its data.</p>
        <div class="try">Drag x negative. A half-turn happens first, here because x < 0, since the stages only reach ±99.9° of the axis.</div>`,
      widget: vectorWidget,
      challenge: {
        kind: 'quiz', question: 'In vectoring mode, where do arctangent and magnitude come out?',
        options: ['Angle in z, stretched length in x', 'Angle in y, length in z', 'Angle in x, length in y', 'Both are held in z'],
        answer: 0,
        explain: 'y is driven to 0, so the whole length ends up in x, stretched as ever. z has summed the turns, which is the angle the vector started at.',
        why: ['', 'y is what is steered to 0, so it holds neither.', 'x is a length. An angle is only ever in z.', 'z only ever holds an angle.'],
      },
    },
    {
      title: 'What the words buy',
      get body() { return `
        <p>Three lengths have to be chosen together, and all three can be measured. The test below runs every angle the word can hold, so this is not a sample. It takes the worst of sine and cosine against Math's.</p>
        <p><strong>Stages</strong> set how much angle is left: about atan 2^−(n−1) at the end, so a bit each. <strong>Angle bits</strong> set how well that angle can be held, and how well the table's constants can: each of n constants is off by up to half a step. <strong>Word bits</strong> set how much truncation hurts: each stage throws away up to one LSB, and later stages stretch it. That is why a 14-bit word with 12 stages keeps only about ${cordicBits(S).toFixed(0)} good bits.</p>
        <p>So stages beyond the word's length buy nothing, and a word longer than the stages can use costs adders for nothing. You can hold a few guard bits below the result you want, and check here how many it takes. The worst case the chips add up is a bound, and the real figure comes well inside it.</p>
        <div class="try">Hold word and angle at 14 and step the stages from 6 to 16. Then hold stages at 12 and take the word from 10 up. Find where each stops helping.</div>`; },
      widget: wordsWidget,
      challenge: {
        kind: 'quiz', question: 'At 14-bit words and 14 stages, adding stages stops improving the error. What should grow next?',
        options: ['The word and the angle', 'The number of half-turns', 'The start value', 'Nothing: CORDIC stops at 14 bits'],
        answer: 0,
        explain: 'Truncation and the angle\'s rounding now set the limit. Each stage halves the angle left over only until that is smaller than the rounding each stage adds. After that, extra stages add rounding without removing error.',
        why: ['', 'One half-turn is all a circle needs.', 'That sets the scale of the result, not its error.', 'Nothing limits it but the words. Longer ones go on working.'],
      },
    },
    {
      title: 'Against a table',
      get body() {
        const it = cordicIterative(S), pi = cordicPipeline(S);
        return `
        <p>So is it worth it? The table below measures both. The ROM is the modem's design at larger sizes, its worst error found by reading between the entries, and the CORDIC's found at every angle.</p>
        <p>While the accuracy is low the table wins, by far. Sixty-four words at ${romBits(6).toFixed(1)} bits take ${n0(nands(sineRom(6)))} NANDs, and nothing else comes close. But each added bit doubles it, and 4 096 words reach ${n0(nands(sineRom(12)))}. A pipeline grows as the square of the accuracy: more stages times wider adders. A ${S.w}-bit one with ${S.n} stages takes ${n0(nands(pi))} NANDs for ${cordicBits(S).toFixed(1)} bits. Between those, at about 5 or 6 bits, they cross.</p>
        <p>The table is not at its best here, in fairness. Using the symmetry of a sine and storing only a quarter divides it by about four, and interpolating between entries with a small multiplier does much more, so a real design would move that crossing up by a few bits. A table also gives only a sine. CORDIC also gives arctangent and magnitude from the same gates, and it can rotate any vector and not only a unit one.</p>
        <p>When a result is not needed on every clock, the iterative form goes a long way further. One stage with two shifters, a table of angles and a counter: ${n0(nands(it))} NANDs at the same ${S.w} bits, for ${S.n + 1} clocks a result: the start, then ${S.n} stages. That is about one-${Math.round(nands(pi) / nands(it))}th of the area for one-${S.n + 1}th of the rate. The shifters are now real multiplexers, where in the pipeline they were wires, so its area × time is ${(nands(it) * (S.n + 1) / nands(pi)).toFixed(1)} times the pipeline's. Choosing between them is the old trade from the multiplier chapter, in a new place.</p>`;
      },
      widget: costWidget,
      challenge: {
        kind: 'quiz', question: 'A design needs one sine every 32 clocks, at 12 bits, and area is what matters. Which fits best?',
        options: ['The iterative form', 'A pipelined CORDIC', 'A 4 096-word full-period ROM', 'Four tree multipliers and a table'],
        answer: 0,
        explain: 'Twelve bits takes about 16 stages, so 17 clocks a result, which fits comfortably in 32. The throughput a pipeline offers would go unused.',
        why: ['', 'It delivers a result on every clock, which this design would just wait for, and pays in registers.', 'Even that reaches only about 9 bits, at many times the area.', 'It costs several times the iterative form, and still needs a sine from somewhere.'],
      },
    },
  ],
};
