// Numbers that fit: the signal processing level's first chapter. Words with a point, wrap against saturate, rounding, guard bits, where the gain goes,
// what fixed point saves. The gates are lib/fixedpt.ts, compared with dsp/fixed.ts in tests/dsp-fixed.test.ts; what the text claims is tests/dsp-fixed-chapter.test.ts.

import { guardBits, roundingNoise } from '../dsp/fixed';
import { chainSnr, overflowRun, roundingRun, runningSum } from '../dsp/fixeddemos';
import { rca } from '../lib/combinational';
import { clampWord, fracMultiplier, satAdder } from '../lib/fixedpt';
import { treeMul } from '../lib/muldiv';
import { stats } from '../sim/stats';
import { chainWidget, costRows, costWidget, mulScene, overflowWidget, qWidget, roundingWidget, satScene, SUM_SETS, wrapOrderWidget } from '../widgets/dspfixed';
import { dspRows, DSP_LEVEL } from './dspladder';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (v: number) => groupNum(v);
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const db = (v: number) => `${v.toFixed(1)} dB`;
const WRAP6 = overflowRun(6, 16, 'wrap').snrDb, SAT6 = overflowRun(6, 16, 'sat').snrDb, SCALE6 = overflowRun(6, 16, 'scale').snrDb;
const row = (name: string) => costRows().find((r) => r[0].startsWith(name))![1];
const ladder = () => `<table class="dsp-ladder"><tr><th>Chapter</th><th>Title</th><th>The question</th></tr>${dspRows().map((r) => `<tr><td class="n">${r.num}</td><td><a href="#/c/${r.id}/0">${r.title}</a></td><td>${r.asks}</td></tr>`).join('')}</table>`;

export const chFixed: Chapter = {
  id: 'fixed', num: numOf('fixed'), title: 'Numbers that fit', level: DSP_LEVEL,
  blurb: 'What a signal processor does when a sum will not fit: Q formats, wrap against saturate with one in gates, rounding and its bias, guard bits, and where to put a gain.',
  goals: [
    'read a word in Q format, and say what its range and step are',
    'choose between wrapping and saturating, and build a saturating adder from one guard bit and a clamp',
    'keep a product\'s bits straight, round it once, and name the one input pair that overflows',
    'tell which rounding biases a long sum, and how many guard bits an accumulator needs',
    'place a chain\'s gains so that a word\'s bits are not thrown away',
  ],
  builds: ['binary', 'muldiv', 'signals'],
  recap: {
    keep: [
      'Qm.f is the same two\'s complement word with a point in a chosen place: range and step are fixed when the design is. A DSP word is usually a fraction, Q1.(w−1), from −1 to just below +1, because a product of two fractions stays one.',
      `Past full scale an adder wraps, which is free and sounds broken. A saturating adder is an adder one bit wider, a test on the top two bits, and a mux: ${n0(row('16-bit saturating'))} NANDs against ${n0(row('16-bit adder'))} at 16 bits.`,
      'A product of two Q1.(w−1) words has two sign bits, so it comes down by w − 1, not w. Keep every bit, round once at the end. Only −1 × −1 overflows.',
      'Truncation is biased by about half a step and a long sum shows it as a steady drift; half-up on ties a little; ties-to-even not at all. Each rounding adds noise of variance q² / 12 whichever rule is used.',
      `While a sum's final value fits, wrapping along the way cannot hurt, and saturating along the way can. An accumulator of n products needs log₂ n guard bits: ${guardBits(256)} for ${256}.`,
      'A gain of 1 made from a shift down and a shift up keeps its bits only if the up comes first, and that needs headroom. Scale late and keep the word full.',
    ],
    check: [
      {
        question: 'Two Q1.15 words are multiplied in a 32-bit result. Which 16 bits are the Q1.15 answer?',
        options: ['Bits 30 down to 15', 'Bits 31 down to 16', 'Bits 15 down to 0', 'Any 16 bits: only the scale changes'],
        answer: 0,
        explain: 'The product is Q2.30, so its point sits below bit 30 and it has two sign bits. Bit 31 only repeats bit 30, except for −1 × −1.',
        why: ['', 'That keeps the spare sign bit and halves every answer.', 'Those are the bits lost to rounding, and they say almost nothing about the size.', 'The point has a definite place, and only one choice keeps Q1.15.'],
      },
      {
        question: 'An FIR filter wraps part way through its sum of products, but its final answer is known to fit. What is wrong with the output?',
        options: ['Nothing: arithmetic modulo 2^w gets the same low bits in any order', 'It is off by the amount that wrapped', 'It is noisy until the next sample', 'Its sign is wrong'],
        answer: 0,
        explain: 'Every step is correct modulo 2^w. A value that fits in w bits is fixed by its residue, so the excursion leaves no trace.',
        why: ['', 'A wrap removes exactly 2^w, and a later wrap, or the true sum fitting, gives it back.', 'No memory of the excursion remains in the word.', 'If the final value fits, the top bit is its true sign.'],
      },
      {
        question: 'A chain cuts a signal by 8 and later raises it by 8. The signal only ever reaches a tenth of full scale. What is the better order?',
        options: ['Up first, then down: nothing is lost, and the peak stays in range', 'Down first, to leave headroom', 'Either: the overall gain is 1', 'Neither: it needs a floating-point word'],
        answer: 0,
        explain: 'A tenth of full scale times 8 still fits, so going up first drops nothing. Going down first throws three bits away and the later gain cannot bring them back.',
        why: ['', 'There is plenty of headroom already, and those three bits are about 18 dB.', 'The overall gain is the same, and the rounding noise is not.', 'Fixed point holds it with room to spare.'],
      },
    ],
  },
  steps: [
    {
      title: 'A word and its point',
      get body() {
        return `
        <p>This level takes the signals of the Communication chapters and asks how to compute with them for real: in words of a fixed size, at a price, with sound and pictures you can check. <a href="#/c/signals/0">Chapter ${numOf('signals')}</a> gave you a sample, a spectrum and a filter. <a href="#/c/noise/0">Chapter ${numOf('noise')}</a> gave you noise, and <a href="#/c/carriers/0">chapter ${numOf('carriers')}</a> the FFT in gates. Nothing is repeated here. What each chapter asks:</p>
        ${ladder()}
        <p><a href="#/c/binary/0">Chapter ${numOf('binary')}</a> introduced fixed point: an integer that means x / 2ᶠ. Signal processing uses one form of it above all, the <strong>fraction</strong>. Q1.15 has 16 bits, one before the point and that one is the sign, so its range is −1 to just under +1 in steps of 2⁻¹⁵. The notation counts the sign among the integer bits.</p>
        <p>Why fractions? Because two of them multiply to something that is still less than 1, so a product can always be brought back to the same format. Integers do the reverse: products grow out of the word. The hardware does not know about any of this. The same adder serves every format, and the format is a promise the designer keeps.</p>
        <div class="try">Set 8 bits with 7 after the point, and find the word for −1, and the largest word. Then give the format 4 bits after the point, and read what the same word now means.</div>`;
      },
      widget: qWidget,
      challenge: {
        kind: 'quiz', question: 'What is the largest value in Q1.15, and what is its step?',
        options: ['1 − 2⁻¹⁵, in steps of 2⁻¹⁵', '1, in steps of 2⁻¹⁵', '2 − 2⁻¹⁴, in steps of 2⁻¹⁴', '32 767, in steps of 1'],
        answer: 0,
        explain: 'The largest word is 0111…1, 32 767, meaning 32 767 / 32 768. −1 fits and +1 does not: two\'s complement has one more negative value than positive.',
        why: ['', 'There is no word for +1, which is the reason this chapter exists.', 'That is the range of Q2.14.', 'That is the same word read as an integer. The point moves the meaning.'],
      },
    },
    {
      title: 'Wrap or saturate',
      get body() {
        return `
        <p>An adder's natural behaviour past full scale is to <strong>wrap</strong>: the largest positive word plus one gives the most negative. You met this as the overflow flag in <a href="#/c/binary/0">chapter ${numOf('binary')}</a>, where the program has to notice. In a signal it arrives as a jump from one rail to the other, about as violent an error as a word can make.</p>
        <p>A <strong>saturating</strong> word stops at the rail instead. It is still wrong, and it is much less wrong: a clipped peak in place of a full-scale step. A third way is to shift down first, by as many bits as the worst peak needs. That never overflows, and it spends bits that a short word cannot spare.</p>
        <p>Here are two tones with gain, stored in a word. At +6 dB and 16 bits, wrapping leaves a signal-to-error ratio of ${db(WRAP6)}, saturating ${db(SAT6)}, and shifting down one bit ${db(SCALE6)}. Play them and hear whether your ears agree with the figures.</p>
        <div class="try">At +6 dB and 16 bits compare Wrap with Saturate, then Scale down first. Then take the word down to 6 bits and find the gain at which Scale down first starts to beat Saturate.</div>`;
      },
      widget: overflowWidget,
      more: {
        pitfall: '<p>Saturating everywhere. A clamp in the middle of a calculation throws information away that a later term would have cancelled. <em>Wrapping can be right</em>, a few steps on, shows this happening.</p>',
        real: '<p>Plenty of parts offer both. A saturation mode bit in a DSP\'s status register is common, and the RISC-V vector extension has saturating add instructions (vsadd). This chapter\'s audio is computed by the model; nothing here runs through a simulator in real time.</p>',
      },
      challenge: {
        kind: 'quiz', question: 'A tone peaks 10 % over full scale. Roughly what does each rule do to it?',
        options: ['Saturating flattens the tops; wrapping throws them to the opposite rail', 'Both flatten the tops', 'Wrapping flattens the tops; saturating inverts them', 'Neither changes it until the peak is twice full scale'],
        answer: 0,
        explain: 'A value just over the top, stored by wrapping, reads as nearly −1: a jump of almost two full scales. Saturating leaves it at the top.',
        why: ['', 'Wrapping has no idea of a top: it keeps the low bits.', 'That has the two the wrong way round.', 'Any value past the word\'s range does not fit, whatever the margin.'],
      },
    },
    {
      title: 'A saturating adder',
      get body() {
        const sat = nands(satAdder(8)), add = nands(rca(9)), cl = nands(clampWord(8));
        return `
        <p>To know whether a sum fits, compute it with one more bit. <span data-show="xa xb">Two wires copy each input's sign upward</span>, which costs nothing. <span data-show="add">An adder one bit wider</span>, its carry-in tied to 0, cannot overflow, since the sum of two w-bit words always fits in w + 1.</p>
        <p>Now read the top two bits of the sum. If they agree the value fits in w bits and the upper one is redundant. If they differ it does not fit, and the top bit is its true sign. <span data-show="clamp">The clamp</span> does exactly that: an XOR on the two bits, the limit made from wires (the sign on top, its inverse below, so 100…0 or 011…1), and a mux. Open it.</p>
        <p>At 8 bits that is ${sat} NANDs: ${add} for the adder and ${cl} for the clamp. Most of the clamp is the mux, one per bit, and every result pays that whether it overflowed or not, along with the mux's delay. <code>sat</code> tells the outside that it happened, and a real part usually makes that bit sticky, so that a program can look afterwards.</p>
        <div class="try">Set a = 100, b = 20, and read the sum. Raise b until <code>sat</code> lights. Then try two negative words: a = 156 and b = 156 mean −100 each, and y reads 128, which means −128. The bar under the circuit shows words unsigned, in the number base you pick at the top of the page.</div>`;
      },
      scene: satScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Drive the adder into its upper limit: sat = 1 and y = 127.',
        check: (st) => st.value('sat') === 1 && st.value('y') === 127,
        hints: ['The inputs are 8-bit two\'s complement, so 127 is the largest positive word.', 'Two positive words whose sum passes 127 will do.'],
        answer: 'Any two positive words summing past 127, such as a = 100 and b = 100. The 9-bit sum is 0 1100 1000: its top two bits differ and the top one is 0, so the clamp gives 0111 1111.',
        solve: (st) => st.setInputs({ a: 100, b: 100 }),
      },
    },
    {
      title: 'Multiplying fractions',
      get body() {
        const m = nands(treeMul(8, true)), all = nands(fracMultiplier(8));
        return `
        <p>Multiply two Q1.7 words and <span data-show="mul">the multiplier</span> gives 16 bits, Q2.14. A fraction times a fraction is a fraction, so the upper integer bit almost always repeats the sign. To get back to Q1.7, the product comes down by 7 places, one fewer than half the word. Forget that and every answer is half what it should be, which is a classic bug in fixed-point code. A shift by a constant is <span data-show="hi lo">wires</span>.</p>
        <p>Dropped bits are not simply gone. <span data-show="round">The rounder</span> adds the first dropped bit back, which is round half up, and it does so once, at the end. Rounding the terms of a sum one by one would add noise for each. Inside each butterfly, the FFT of <a href="#/c/carriers/0">chapter ${numOf('carriers')}</a> follows the same rule.</p>
        <p>The upper sign bit earns its place in one case. −1 × −1 = +1, and +1 does not exist in this format. <span data-show="clamp">The clamp</span> is there for that one input pair out of 65 536. Leave it out and −1 × −1 gives −1, so a filter with a coefficient of −1 can flip the sign of a full-scale sample. That bug tends to stay hidden until a test finally drives the rail.</p>
        <p>In all ${n0(all)} NANDs, of which the signed multiplier is ${n0(m)}. Multipliers are the expensive thing in this level. The later chapters on machines are about sharing one.</p>
        <div class="try">Set a = 96 and b = 64 in the bar under the circuit (0.75 × 0.5) and read y = 48 (0.375). Then find the pair that lights <code>sat</code>.</div>`;
      },
      scene: mulScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Find the product the clamp exists for: sat = 1.',
        check: (st) => st.value('sat') === 1,
        hints: ['Only one pair of words has a product that does not fit.', 'The word 128 means −1 here.'],
        answer: 'a = b = 128, which is −1 × −1. The answer +1 has no word, so the clamp gives 127, the nearest there is.',
        solve: (st) => st.setInputs({ a: 128, b: 128 }),
      },
    },
    {
      title: 'Rounding',
      get body() {
        const t = roundingRun('trunc', 3), c = roundingRun('convergent', 3), u = roundingRun('half-up', 3);
        return `
        <p>Dropping bits is the cheapest rounding there is, and it always goes down, so its error has a mean of about half a step. That looks harmless. Now run a long sum: a filter's output, an integrator, a level meter. A small constant error adds up in a straight line, and the plot below shows it.</p>
        <p>Adding the first dropped bit back, <strong>round half up</strong>, centres the error, except on exact ties, which always go up: half an input step, much smaller than truncation's once a few bits are dropped. Sending ties to the even neighbour, <strong>convergent rounding</strong>, removes that as well, for the price of one more test on the bits.</p>
        <p>With 3 bits dropped from this signal, the mean error is ${t.mean.toFixed(2)} input steps for truncation, ${u.mean.toFixed(2)} for half up and ${c.mean.toFixed(2)} for ties to even. Notice that the variance hardly moves, ${t.variance.toFixed(2)} against ${c.variance.toFixed(2)}: each rule adds about the noise power you met in <a href="#/c/signals/6">the rounding step</a>, q² / 12, here ${roundingNoise(8).toFixed(2)}. The rule only changes where the mean sits.</p>
        <div class="try">Raise the bits dropped and watch truncation's drift grow with the step. Which line stays nearest zero?</div>`;
      },
      widget: roundingWidget,
      more: {
        derive: '<p>Dropping s bits from a busy word leaves a remainder spread evenly over 0 … 2ˢ − 1, with mean (2ˢ − 1) / 2 and variance (4ˢ − 1) / 12 in input steps. Half up shifts the remainders by half a step: the mean becomes +½ of an input step, from the one tie that always goes up. Ties to even splits those ties evenly, and the mean is 0.</p>',
      },
      challenge: {
        kind: 'quiz', question: 'A level meter sums a million rounded samples. Which rule is most likely to show a false reading?',
        options: ['Truncation', 'Round half up', 'Ties to even', 'They are the same: each has the same noise power'],
        answer: 0,
        explain: 'Noise power adds slowly and at random. A bias adds in a straight line: a million times half a step.',
        why: ['', 'Its bias is far smaller: half an input step against half a dropped step.', 'It has no bias at all on a busy signal.', 'The noise power is about the same. The mean is what differs.'],
      },
    },
    {
      title: 'Wrapping can be right',
      get body() {
        const r = runningSum(SUM_SETS[0].xs, 8);
        return `
        <p>Saturating sounds strictly better than wrapping. Inside a long sum it is the other way round. Two's complement addition is arithmetic modulo 2ʷ, so every intermediate result is correct modulo 2ʷ, however far it strayed. If the final answer fits, it comes out right.</p>
        <p>Below, eight words are added in an 8-bit accumulator. The true sum climbs to ${Math.max(...r.truth)} and ends at ${r.truth[r.truth.length - 1]}. Wrapping ends at ${r.wrapped[r.wrapped.length - 1]}, which is right. Saturating ends at ${r.clamped[r.clamped.length - 1]}. It clipped what it could not hold and never got it back.</p>
        <p>So the usual design is an accumulator that does not clamp while summing, wider than the word, and one clamp at the end. The extra bits are <strong>guard bits</strong>. A sum of n products, each of magnitude under 1, needs up to log₂ n more bits above the point: ${guardBits(256)} guard bits for 256 terms. That is why a 16-bit DSP commonly has a 40-bit accumulator: 32 for a product plus 8 guard bits.</p>
        <div class="try">Compare the first two sets of words with the third. Then widen the accumulator on the third until both rules give the true sum.</div>`;
      },
      widget: wrapOrderWidget,
      challenge: {
        kind: 'quiz', question: 'A filter with 1 024 taps sums products of Q1.15 words, each Q2.30. How many bits does the accumulator need so that no worst-case input can overflow?',
        options: ['42: 32 for a product and 10 guard bits', '32: a product already fits', '40: the usual width', '64: double the word'],
        answer: 0,
        explain: 'log₂ 1024 = 10 guard bits above the 32-bit product. In practice a filter\'s taps sum to much less than 1 024 in magnitude, so fewer may do; the worst case is the safe number.',
        why: ['', 'One product fits, and two can already exceed it.', '8 guard bits cover 256 terms at full scale.', 'That is safe, and it costs far more adder than it needs.'],
      },
    },
    {
      title: 'Where the gain goes',
      get body() {
        const lv = 0.1, s = 3, w = 16, d = chainSnr(lv, s, w, 'down first'), u = chainSnr(lv, s, w, 'up first');
        return `
        <p>Every shift down throws bits away, and each throw adds rounding noise at that point in the chain. Later gain raises that noise along with the signal. So the place to attenuate is late, and the place to amplify is early, as long as the signal still fits.</p>
        <p>Take a tone peaking at a tenth of full scale in a 16-bit word, and a gain of 1 made from a shift of ${s} bits down and ${s} up. Down first leaves ${db(d)}. Up first leaves ${db(u)}, the most this word could give at that level. Push the peak higher and up first starts to clip, and a clip costs far more than a rounding. That trade is what <strong>scaling a chain</strong> means: keep the word as full as you can without ever passing the top.</p>
        <p>How do you know the top? Three ways, from strictest down. The sum of the absolute values of the impulse response bounds the peak for any input at all. A bound on gain at any one frequency covers tones. A measured or assumed peak covers what you expect, and that is what most audio equipment does. Each is a bet about the input, and each later chapter that builds a filter makes one of them.</p>
        <div class="try">At −20 dBFS and a 3-bit shift read both orders. Raise the signal until up first falls below down first.</div>`;
      },
      widget: chainWidget,
      challenge: {
        kind: 'quiz', question: 'A filter\'s impulse response sums, in absolute value, to 3.2. The input may be any Q1.15 signal. What guarantees no overflow at the output?',
        options: ['Shift the input down by 2 bits', 'Shift the output down by 2 bits after it has overflowed', 'Nothing is needed: the input is under 1', 'Saturate the input'],
        answer: 0,
        explain: 'The worst output is 3.2 times the input\'s peak, so the input has to be below 1 / 3.2. Two bits gives 1 / 4. A wider accumulator with a shift at the end would keep those bits, for more adder.',
        why: ['', 'Once the value has wrapped in a word this wide, a shift cannot undo it.', 'The output can reach 3.2 times the input.', 'The input is already in range, and that says nothing about the output.'],
      },
    },
    {
      title: 'Fixed or floating',
      get body() {
        return `
        <p>Floating point moves the point for you, so why all of this? Compare the parts, counted from their gates. A float32 number has 24 bits of precision, so a fair comparison is 24 bits of fixed point. A float32 adder is ${n0(row('float32 adder'))} NANDs against ${n0(row('24-bit saturating'))} for a 24-bit saturating adder. A float32 multiplier is ${n0(row('float32 multiplier'))} against ${n0(row('Q1.23'))} for Q1.23, and most of that is the multiplier both must have. A filter does little else but add and multiply, so the adder's ratio matters a great deal, and a float's alignment and normalization add delay as well.</p>
        <p>What you get for it is range: with the moving point of <a href="#/c/float/0">chapter ${numOf('float')}</a>, the exponent does the scaling the last two steps did by hand. Which you choose follows from who is paying. A part sold by the million and running from a tiny battery counts its bits. A large core with a floating-point unit already paid for does not.</p>
        <p>This level works in fixed point because that is where the design decisions are, and where a learner can see them. The same filters run in floats too, and the widgets' models mostly do: they exist to give a reference to compare the words with.</p>`;
      },
      widget: costWidget,
      more: {
        pitfall: '<p>Believing floats are exact where fixed point is not. A float32 has 24 bits of mantissa, so a large running total stops changing when a small term arrives. A 40-bit accumulator holds that sum exactly.</p>',
      },
      challenge: {
        kind: 'quiz', question: 'A sum of many small terms is kept in float32, and it has grown large. What can happen to a new small term?',
        options: ['It can vanish entirely, rounded away against the large total', 'It overflows the mantissa and gives infinity', 'It is added exactly, since floats have enormous range', 'It turns the sum negative'],
        answer: 0,
        explain: 'Below about 2⁻²⁴ of the total, a term rounds to nothing. Range is not the same as precision. An accumulator with guard bits has no such floor.',
        why: ['', 'Infinity needs the exponent to run out, which takes around 2¹²⁸.', 'Range and precision are different things: a float has 24 bits at any scale.', 'Floats round; they do not wrap.'],
      },
    },
  ],
};
