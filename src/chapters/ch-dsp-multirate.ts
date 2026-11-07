// Changing the rate (level Signal processing): how do you filter at a thousandth of the price? Decimation and its aliases, polyphase, interpolation, half-band filters and the CIC, with a CIC and a
// polyphase decimator in gates (lib/multirate.ts) compared with dsp/multirate.ts every clock, and resampling held to scipy's upfirdn and resample_poly (tests/dsp-multirate.test.ts). Costs on this page are measured.

import { cicGrowth, cicWidth, halfBand, nonZero } from '../dsp/multirate';
import { cicDecimator, POLY_SPEC, polyDecimator } from '../lib/multirate';
import { treeMul } from '../lib/muldiv';
import { stats } from '../sim/stats';
import { ALIAS_R, branchWidget, cascade, cascadeWidget, CASCADE_R, CIC_IN, CIC_N, CIC_ORDER, CIC_NULL, CIC_R, cicScene, cicWidget, dropWidget, growthWidget, polyScene, rateApi, upWidget } from '../widgets/dspmultirate';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(Math.round(x));
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const MUL8 = () => nands(treeMul(8, true));
const RM = POLY_SPEC.R * POLY_SPEC.M;

export const chMultirate: Chapter = {
  id: 'multirate', num: numOf('multirate'), title: 'Changing the rate', level: 'Signal processing',
  blurb: 'How do you filter at a thousandth of the price? Decimation, interpolation, polyphase, half-band and CIC filters, with a CIC and a polyphase decimator in gates and their register growth measured.',
  goals: [
    'say what keeping every R-th sample does to a spectrum, and what must come first',
    'cut a filter into branches, and say why the same answer costs R times less',
    'derive a CIC from a moving average, and size its registers from N log₂ R',
    'price a large rate change as one filter, as branches, and as a cascade',
  ],
  builds: ['signals', 'carriers', 'muldiv'],
  recap: {
    keep: [
      'Keeping every R-th sample folds everything above the new half-rate into the band, for good. So the filter comes first, and it runs at the high rate.',
      'A filter that only feeds a decimator wastes R − 1 of every R results. Polyphase skips them: each branch holds every R-th tap, and the answer is the same: to the bit in integers, to rounding in floating point.',
      'Interpolating is the same idea from the other side: zeros between samples make images, and a filter removes them. Half-band filters halve the rate with half their taps zero.',
      'A CIC is N moving averages rearranged into integrators and combs: adders and registers, no multiplier, no sample memory. Its registers wrap and that is harmless, if they hold N log₂ R more bits than the input.',
      'A CIC droops and only rejects near its nulls. So it does the large rate change cheaply, and a short ordinary filter at the low rate finishes the job.',
    ],
    check: [
      {
        question: 'A decimator by 8 uses a 64-tap filter. How many multiplications does each input sample cost, done by branches?',
        options: ['8', '64', '512', '1'],
        answer: 0,
        explain: 'One output in eight is computed, for 64 products, so 64 / 8 = 8 for each input sample.',
        why: ['', 'That is what the direct form spends, computing outputs that are then dropped.', 'That multiplies where it should divide.', 'One multiplication an input sample would mean only 8 products an output, and this filter has 64 taps.'],
      },
      {
        question: 'A CIC\'s integrators overflow constantly. Why does the output stay right?',
        options: ['Only differences of them reach the output', 'The combs clamp each sum before it can do harm', 'The input is too small for them ever to overflow', 'A CIC is only right on average, over many outputs'],
        answer: 0,
        explain: 'Two\'s complement differences are right even across a wrap. Adding and subtracting modulo 2^w gives the true answer modulo 2^w. As long as the true output fits in w bits, the wraps on the way cancel exactly.',
        why: ['', 'Nothing in it saturates, and saturating would destroy the very arithmetic that makes it work.', 'A running sum of anything but zero overflows sooner or later.', 'It is exact, bit for bit. The tests compare it with a plain FIR.'],
      },
      {
        question: 'Why does a CIC usually have a short ordinary filter after it?',
        options: ['It droops, and rejects well only near its nulls', 'It cannot lower the rate without some help', 'Its output has the wrong sign at the low rate', 'Its registers need clearing from time to time'],
        answer: 0,
        explain: 'The response is (sin(πRf) / (R sin(πf)))^N, which falls across the kept band. A filter there can flatten it and supply the sharp edge, and that filter runs at a low rate, where multiplications are few.',
        why: ['', 'It does lower the rate. What it lacks is a flat band and a sharp edge.', 'Its gain is positive at DC, and it is fixed.', 'They never need clearing: the wraps cancel.'],
      },
    ],
  },
  steps: [
    {
      title: 'Most of the samples are not needed',
      get body() {
        const r = cascade();
        return `
        <p>A radio's front end samples at a high rate because the whole band has to fit through it. After <a href="#/c/signals/7">the mixer</a> has moved one station to zero, that station is a sliver of what was sampled, and every sample of the rest is a waste of everything downstream.</p>
        <p>Filtering is multiplications a second, so the price is taps × rate. Lower the rate by R, and everything after it costs R times less. The chapter's goal is one job: drop the rate by ${CASCADE_R}, keep 40 % of the new rate and hold back what would fold by 50 dB. Done as a single filter at the input's rate, that takes ${n0(r[0].mults)} multiplications for each input sample. By the end it will take ${r[3].mults.toFixed(2)}, about a thousandth of that, with the same mask.</p>`;
      },
      challenge: {
        kind: 'quiz', question: 'Why does lowering a signal\'s rate early make the rest of a chain cheaper?',
        options: ['A filter\'s price is taps × rate', 'Filters are not needed at low rates', 'Multipliers are physically smaller at low rates', 'It adds bits of precision to the samples'],
        answer: 0,
        explain: 'At a lower rate there are R times fewer outputs to compute, and the band you kept is all those samples need to carry.',
        why: ['', 'They do need filters. But those filters run less often.', 'A multiplier is the same size. It is just used less often, so it can be shared.', 'Changing the rate alone adds none.'],
      },
    },
    {
      title: 'Throwing samples away',
      body: `
        <p>Keep every R-th sample and discard the rest. That is <strong>decimation</strong> at its simplest, and it is cheap. It also has the problem <a href="#/c/signals/5">sampling</a> always has: the new rate has a new half-rate, and whatever lay above it folds down into the band. It cannot be told apart from what belonged there, and nothing later can remove it.</p>
        <p>So the filter has to come first, and it has to run at the old rate, where it is at its most expensive. Everything in this chapter is about paying less for that one filter.</p>
        <div class="try">Move the tone past the line at ${256 / 2 / ALIAS_R} and watch it land somewhere new. Then listen to a sweep both ways. Without the filter it rises, falls, rises and falls again, and those tones are not in the input.</div>`,
      widget: dropWidget,
      challenge: {
        kind: 'quiz', question: 'A tone at 0.3 of the input\'s rate is decimated by 4 with no filter. Where does it land, as a share of the new rate?',
        options: ['0.2, folded', '0.3, unchanged', '1.2, above the new rate', 'Nowhere: it vanishes'],
        answer: 0,
        explain: '0.3 × 4 = 1.2 cycles for each kept sample, and 1.2 cycles a sample looks exactly like 0.2. The tone does not go away. It goes somewhere it should not be.',
        why: ['', 'The new rate is four times lower, so everything moves up in share of it.', 'No frequency above 0.5 of a rate can be seen at that rate. It folds.', 'That is exactly what a filter would do, and there is none here.'],
      },
    },
    {
      title: 'Why compute what you throw away?',
      body: `
        <p>Filter, then keep one output in R. That means R − 1 of every R outputs were computed by a full set of multiplications, and then dropped. <strong>Polyphase</strong> simply does not compute them.</p>
        <p>Write down one output that survives, y[Rk] = Σ h[j] x[Rk − j], and sort its terms by j mod R. Taps 0, R, 2R, … only ever meet samples at positions divisible by R. Taps 1, R + 1, … only meet those one before that. So each group of taps can become a <em>branch</em> that receives every R-th input sample, and runs at the low rate. Together the branches compute the same sum, each once per output.</p>
        <p>This is not an approximation: the same products are added in another order. In integers, as in the gates below, the two agree to every bit. In floating point they differ only by rounding in the last place, and both match scipy's <code>upfirdn</code> that closely. What changes is the count: N taps now take N / R multiplications for each input sample, where the direct form takes N.</p>
        <div class="try">Set R to 8 and 64 taps. Each branch now holds only a few taps. Read how few multipliers would do, if one branch runs on each clock.</div>`,
      widget: branchWidget,
      challenge: {
        kind: 'quiz', question: 'What does polyphase change about the filter\'s output?',
        options: ['Nothing: the same products, in another order', 'It adds a small error, the price of its speed', 'It lowers the stopband by a few decibels', 'It shifts the passband down by the factor R'],
        answer: 0,
        explain: 'Only the results that would have been thrown away are skipped. Everything that survives is computed in full.',
        why: ['', 'There is no approximation anywhere in it.', 'The taps are the same taps, so the response is the same response.', 'Same taps again.'],
      },
    },
    {
      title: 'Branches in gates',
      get body() {
        const { R, M, w } = POLY_SPEC;
        return `
        <p>Here is one: ${w}-bit samples, ${w}-bit taps, ÷ ${R} over ${RM} taps. A count of ${R} says which branch the next sample goes to. There are ${R} rows of ${M} registers, and each only loads on its own turn. ${M} multipliers read whichever branch loaded last, through multiplexers, and small ROMs give them that branch's taps. The ${R}-branch sum builds up in one register and becomes an output.</p>
        <p>It is ${n0(nands(polyDecimator(POLY_SPEC)))} NANDs. The multipliers are ${n0(M * MUL8())} of that, against ${n0(RM * MUL8())} for the ${RM} a direct filter on this clock would need. Sample storage is the same either way, since every sample still has to be held somewhere. So the saving is all in the multipliers, and it grows with R.</p>
        <p>Nothing here rounds or saturates: the sum is held in full, ${2 * w + Math.round(Math.log2(RM))} bits. Where the word should come down is a choice for whatever reads it.</p>
        <div class="try">Run the tone in the band, then the one past the new half-rate. The first passes at about full size. The second is what the filter exists to stop.</div>`;
      },
      scene: polyScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the tone past the new half-rate through the gates, with every clock agreeing with the model, and see it stopped.',
        check: (st) => { const a = rateApi.get(st); return !!a && a.agrees() && a.lastTone() === 3 / 8 && a.peak() < 0.1; },
        hints: ['The panel has two tones. Three-eighths of the rate is well past an eighth, the new half-rate.'],
        answer: 'Three-eighths of the input\'s rate is in the filter\'s stopband, so the sum of each group comes out small: under a tenth of the input.',
        solve: (st) => { rateApi.get(st)?.runTone(3 / 8); },
      },
    },
    {
      title: 'Going up, and halving',
      get body() {
        const hb = halfBand(23);
        return `
        <p>Going up by L is the mirror image. Put L − 1 zeros between samples, and the spectrum stays the same but now repeats: the zeros made <strong>images</strong>. A low-pass filter at the new rate removes them, and in doing so fills in the zeros. Most of its inputs are zeros, and multiplying by those is a waste, so again the taps split into branches, and each output needs only every L-th tap. Any rational rate change works this way: up by L, filter, down by M, with one filter doing both jobs. Compared with scipy's <code>resample_poly</code> at 3 / 2, 2 / 3 and 5, the model here agrees to rounding.</p>
        <p>Dropping by exactly two has a special filter. Put the cut-off at a quarter of the rate, and a windowed sinc has a zero at every even distance from its middle. So a ${hb.length}-tap <strong>half-band</strong> filter has only ${nonZero(hb)} that are not zero, and the symmetric ones share a multiplier, so its price is ${(nonZero(hb) - 1) / 2 + 1} multipliers, under a third of its length. Its edge is broad, centred on a quarter of the rate, which is why it suits a stage with plenty of room left. It takes several in a row to go far.</p>
        <div class="try">Move the tone and watch its images. Then see how little of them gets past the filter.</div>`;
      },
      widget: upWidget,
      challenge: {
        kind: 'quiz', question: 'Why is a half-band filter so cheap?',
        options: ['About half its taps are exactly zero', 'It has no multiplier at all, only adders', 'It runs at a quarter of the input\'s rate', 'Its taps are all exact powers of two'],
        answer: 0,
        explain: 'sin(2π · ¼ · t) / t is zero at every even t, so about half the taps vanish, and since the rest are symmetric, folding halves those.',
        why: ['', 'It still multiplies by the taps that remain.', 'It runs at the input\'s rate, or half of it by branches.', 'They come from a sinc and a window, so they are not.'],
      },
    },
    {
      title: 'A moving average, rearranged',
      body: `
        <p>What if the filter needed no multipliers? The cheapest low-pass there is, a moving average of R samples, has every tap equal to 1. Its sum can be kept running: add the new sample, take off the oldest. That is y[n] = y[n−1] + x[n] − x[n−R]: an <em>integrator</em>, then a <em>comb</em> that subtracts a delayed copy.</p>
        <p>Now put the integrator before the rate change and the comb after it. The comb's R-sample delay at the high rate becomes a single-sample delay at the low rate, so there is no line of R samples anymore. Stack N of each and you have N moving averages in a row: a <strong>cascaded integrator-comb</strong>, or CIC, as Eugene Hogenauer set it out in 1981. It is N adders running at the high rate, then N subtractors at the low rate, and no multiplier at all.</p>
        <p>Its response is the moving average's to the power N, (sin(πRf) / (R sin(πf)))^N. Each multiple of the new rate has a null, and those are exactly the frequencies that would fold onto DC. So what is about to alias is what it stops best. But it droops across the band, and between nulls it rejects much less.</p>
        <div class="try">Raise N and watch the sidelobes fall. Read the droop too: it gets worse as N goes up.</div>`,
      widget: cicWidget,
      challenge: {
        kind: 'quiz', question: 'Where are a CIC\'s nulls, and why are they in a useful place?',
        options: ['At multiples of the new rate', 'At the new half-rate, where the band ends', 'At DC, so that it removes any offset', 'Nowhere: a moving average has none'],
        answer: 0,
        explain: 'A moving average of R samples cancels anything that completes whole cycles in R samples. Those are the multiples of the new rate, exactly what would otherwise fold onto DC.',
        why: ['', 'The response there is only moderately down. That is why a CIC cannot make the band\'s edge by itself.', 'At DC it has its full gain, R^N.', 'The numerator goes to zero at each of them.'],
      },
    },
    {
      title: 'Sums that wrap',
      get body() {
        const g = cicGrowth(4, 16), w = cicWidth(CIC_N, CIC_R, CIC_IN);
        return `
        <p>A running sum of a constant grows for ever, so it overflows, and it will. That seems fatal, and it does no harm at all. The output is only ever a difference of those sums, and two's complement differences are right modulo the word. If the true result fits, every wrap on the way cancels exactly. It would be wrong to saturate here, since a clamped register has lost the very number that the comb needs.</p>
        <p>So the only sizing that matters is the output's. Hogenauer's paper gives the gain as (RM)^N, where M is the comb's delay, 1 here, so the registers grow by <strong>N log₂ R</strong> bits: ${g} bits at order 4 and ÷ 16. It also shows that every stage needs that top bit, integrators and combs alike. Here the gain is a power of two, so the output word is exactly full at the worst input, and the widget runs that input: the most negative word, held. The paper goes on to work out how many low bits each later stage can drop, and this design does not attempt it. All ${w} bits run all the way through.</p>
        <div class="try">Take a bit off and watch the output go wrong, while the integrator wraps just the same at the right width.</div>`;
      },
      widget: growthWidget,
      challenge: {
        kind: 'quiz', question: 'At order 3 and ÷ 8, how many bits must a CIC\'s registers have for 8-bit samples?',
        options: ['17: eight, plus 3 × log₂ 8', '11: eight, plus log₂ 8', '32: eight, plus 3 × 8', '8: the wraps see to the rest'],
        answer: 0,
        explain: 'The gain is 8³ = 512, which is nine more bits. The worst input then just fills a 17-bit word.',
        why: ['', 'That covers one moving average. There are three.', 'Growth goes with the logarithm of R, not R.', 'The wraps cancel only if the true result fits in the word. Here it would not.'],
      },
    },
    {
      title: 'A CIC in gates',
      get body() {
        return `
        <p>This scene is order ${CIC_N}, ÷ ${CIC_R}, from ${CIC_IN}-bit samples, ${n0(nands(cicDecimator(CIC_N, CIC_R, CIC_IN)))} NANDs. There is no multiplier and it stores no samples. The integrators' adders run at the input's full rate, so they set the clock. The combs load only on the count's strobe, so what they compute has ${CIC_R} clocks to settle if it needs them.</p>
        <p>Every register here, integrator or comb, is the same width, and nothing rounds or saturates.</p>
        <div class="try">Run the tone in the band. Then run the one on the first null, at one-eighth: eight samples hold one whole cycle, and the sum of a cycle is nothing.</div>`;
      },
      scene: cicScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the tone on the first null through the gates, with every clock agreeing with the model: it stops completely.',
        check: (st) => { const a = rateApi.get(st); return !!a && a.agrees() && a.lastTone() === CIC_NULL && a.peak() === 0; },
        hints: ['The panel has three tones. One of them completes exactly one cycle in each group of eight samples.'],
        answer: `One-eighth of the rate is whole cycles in R = ${CIC_R} samples, so each moving average sums to exactly 0. The input's rounding repeats every eight samples too, so the output is 0 to the bit once the design has filled.`,
        solve: (st) => { rateApi.get(st)?.runTone(CIC_NULL); },
      },
    },
    {
      title: 'The whole job, priced',
      get body() {
        const r = cascade();
        return `
        <p>Back to the job from the start: ÷ ${CASCADE_R}, keep 40 % of the new rate, hold back 50 dB from 60 %. The taps below are not estimated. Each is the fewest that meet that mask, found by designing a filter of each length and measuring it, with the windowed design from <a href="#/c/signals/3">the signals chapter</a>. Better design methods would shorten every row, and the ratios would change little.</p>
        <p>A single filter takes ${n0(r[0].mults)} multiplications for each input. Cut into branches, ${r[1].mults.toFixed(1)}. Halving six times comes to ${r[2].mults.toFixed(1)}, since the early stages have plenty of room and need few taps. A CIC taking the first ÷ 16 for nothing leaves only a ÷ 4 filter at a sixteenth of the rate, at ${r[3].mults.toFixed(2)}. That is about a thousandth of the first row, from reordering the work rather than from a cleverer filter.</p>
        <p>This flatters the CIC in one way, and it has to be said: multiplications are all the table counts, so its adders go free, and they run at the input's full rate. The order matters too. Order ${CIC_ORDER} is the one that fits this mask: order 2 lets too much alias through, and order 4 droops past the half decibel the mask allows. A tighter band than this would need a small inverse of the droop in the last filter. Still, this is why a software radio's front end looks the way it does. A later chapter builds one.</p>`;
      },
      widget: cascadeWidget,
      challenge: {
        kind: 'quiz', question: 'A chain lowers the rate by 1 000 with 60 dB of alias rejection, on a chip with a very fast clock and little area. What goes first?',
        options: ['A CIC, for most of the rate change', 'A long ordinary filter at the input\'s rate', 'A chain of half-bands, one after another', 'Nothing: drop the rate, and filter later'],
        answer: 0,
        explain: 'Its cost barely depends on R, and it needs no multipliers at the rate where they would be most expensive. A short filter after it, at a low rate, sets the band\'s edge.',
        why: ['', 'That is the design this chapter set out to avoid.', 'A half-band is a fine later stage, but each one still multiplies, and a thousand needs ten of them.', 'Whatever folds then can never be removed.'],
      },
    },
  ],
};
