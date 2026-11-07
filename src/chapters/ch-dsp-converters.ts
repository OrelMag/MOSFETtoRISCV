// Converters (level Signal processing): how does one bit make 16? Flash, SAR, an R-2R ladder and jitter as labelled models of analogue parts; a sigma-delta loop's digital arithmetic in gates, with the CIC of
// Changing the rate decimating its bits (lib/sigmadelta.ts, dsp/converters.ts, compared every clock). The identity V = z⁻¹U + (1 − z⁻¹)²E is checked exactly on the loop's own error (tests/dsp-converters.test.ts).

import { enob, idealSqnrDb, jitterLimitDb, SD_GUARD, SD_LIMIT, sdErrorPower, sdLinearModelDb, sdMeasuredDb, sdPeak } from '../dsp/converters';
import { cicWidth } from '../dsp/multirate';
import { sdConverter, sdModulator } from '../lib/sigmadelta';
import { stats } from '../sim/stats';
import { adcApi, adcScene, CHAIN, chainEnob, clipWidget, jitterWidget, ladderWidget, sarWidget, SCENE_CHAIN, sdWidget } from '../widgets/dspconverters';
import { numOf } from './order';
import type { Chapter } from './types';

const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const MOD = (w = CHAIN.w) => nands(sdModulator(2, w));
const WHOLE = () => nands(sdConverter(CHAIN.order, CHAIN.w, CHAIN.N, CHAIN.R));

export const chConverters: Chapter = {
  id: 'converters', num: numOf('converters'), title: 'Converters', level: 'Signal processing',
  blurb: 'How does one bit make 16? Flash, SAR and R-2R as models, what a shaky clock costs, and sigma-delta in gates with a CIC decimating its bits, effective bits measured.',
  goals: [
    'say what flash and SAR each pay for, and read linearity from a staircase',
    'work out what a clock\'s jitter leaves of a fast signal, whatever the bits',
    'explain how feedback pushes quantization noise out of the band',
    'measure a sigma-delta chain\'s effective bits, and say where the textbook\'s model is out',
  ],
  builds: ['signals', 'noise', 'zplane', 'multirate', 'fixed'],
  recap: {
    keep: [
      'Effective bits are (SNDR − 1.76) / 6.02: what an ideal converter would need to do as well. The bits on the datasheet\'s front page are only an upper limit.',
      'Flash decides in a clock with 2^b − 1 comparators. SAR takes b clocks on one comparator, and a DAC that has to be as good as the result.',
      'A ladder\'s worst step is usually at the middle, where every bit changes at once and the MSB\'s error shows. Linearity is matching, and matching is area.',
      'Jitter sets a limit of −20 log₁₀(2π f σ), whatever the bits. It gets worse with signal frequency, not sample rate.',
      'Sigma-delta trades rate for bits: a one-bit loop pushes its noise up in frequency, and a filter removes it and lowers the rate. In theory order 2 gains 15 dB for each doubling and order 1 gains 9. Order 2 measures close to that, and order 1 wanders.',
    ],
    check: [
      {
        question: 'A 16-bit converter measures 74 dB of SNDR on a sine. What are its effective bits?',
        options: ['About 12', 'About 16', 'About 74', 'About 8'],
        answer: 0,
        explain: '(74 − 1.76) / 6.02 is 12. The other four bits are there, and what they say is noise.',
        why: ['', 'That is how many bits it delivers, not how many are right.', 'That is the same quantity in decibels.', 'That would be about 50 dB.'],
      },
      {
        question: 'A design has 1 ps of clock jitter. Which input is hurt more?',
        options: ['A 100 MHz input at any rate', 'A 1 MHz input at the same rate', 'Either: only the sample rate counts', 'Neither: jitter only moves the samples'],
        answer: 0,
        explain: 'A timing error turns into a voltage error through the signal\'s slope, and the slope goes with frequency. A hundred times the frequency costs 40 dB.',
        why: ['', 'Its slope is a hundred times smaller.', 'The formula has the signal\'s frequency in it, and no sample rate at all.', 'Moving a sample on a slope changes its value. That is the error.'],
      },
      {
        question: 'What does the feedback in a sigma-delta loop do to the quantizer\'s error?',
        options: ['Moves most of it above the band', 'Removes it altogether, given time', 'Lowers the total of it', 'Adds it to the input'],
        answer: 0,
        explain: 'The output is z⁻¹U + (1 − z⁻¹)²E. The error is all still there, and (1 − z⁻¹)² is small at low frequencies and large at high ones.',
        why: ['', 'It is still there: the identity holds to the bit.', 'A shaped error has more total power, not less. It is just in a place a filter can reach.', 'That is the one thing it does not do to the band that is kept.'],
      },
    ],
  },
  steps: [
    {
      title: 'What a converter is judged by',
      body: `
        <p>The DSP core of the last chapter, like everything before it, began with samples already there. A converter is where they come from, and it is the one part of the chain that has to be analogue. Most of this chapter is therefore models, labelled as such: comparators, capacitors and resistors with seeded errors. The sigma-delta arithmetic at the end is exact and in gates.</p>
        <p><a href="#/c/signals/6">Rounding</a> gave the limit: a perfect b-bit converter on a full-scale sine reaches 6.02 b + 1.76 dB. So a real one is judged backwards. Measure its signal to noise and distortion, SNDR, and ask how many bits a perfect converter would need to do as well: <strong>effective bits</strong>, ENOB = (SNDR − 1.76) / 6.02. Rounding a sine to 12 bits should reach ${idealSqnrDb(12).toFixed(1)} dB, and the tests hold this chapter's measurement to within 1.5 dB of that on rounded sines.</p>
        <p>The bits on the front of the data sheet are the bits it delivers. Effective bits are how many of them are right, and at high input frequencies they fall, as you will see.</p>`,
      challenge: {
        kind: 'quiz', question: 'A converter delivers 14 bits. Its SNDR is 62 dB. What do you tell the system designer?',
        options: ['Plan on about 10 bits', 'Plan on 14 bits', 'Plan on 62 bits', 'It cannot be known from that'],
        answer: 0,
        explain: '(62 − 1.76) / 6.02 is 10. Four of the delivered bits are below the noise.',
        why: ['', 'They are delivered, and not all of them are right.', 'That confuses decibels with bits.', 'SNDR is exactly the figure that says.'],
      },
    },
    {
      title: 'Compare, and compare again',
      body: `
        <p>A <strong>flash</strong> converter is the direct way: a comparator at every step of the ladder, all deciding at once. It takes one clock and 2^b − 1 comparators, and each added bit doubles the input's load and the power. Eight bits is 255 comparators. Past that it is rarely worth it.</p>
        <p>A <strong>SAR</strong> converter is a binary search: one comparator, and a <strong>DAC</strong>, a digital-to-analog converter, which turns a code back into a level. Try the top bit, ask whether the input is above that level, keep or clear it, and go on. So b clocks, one comparator, and a DAC to build, usually from binary-weighted capacitors whose charge is the sum of those it holds.</p>
        <p>The catch is that the DAC has to be as accurate as the result. Its largest capacitor is half of the total, and an error of 1 % in it is 1.3 codes at 8 bits. Past about 12 bits, trimming or calibration starts to matter.</p>
        <div class="try">Step the input and read the search. Then add capacitor error, and watch the code move away from the right one.</div>`,
      widget: sarWidget,
      challenge: {
        kind: 'quiz', question: 'Going from 8 to 12 bits, what grows sixteen times in a flash and hardly at all in a SAR?',
        options: ['The number of comparators', 'The number of clocks it takes', 'The noise', 'The sample rate'],
        answer: 0,
        explain: '255 becomes 4 095 comparators. The SAR keeps its one, and adds four clocks.',
        why: ['', 'It is the SAR whose clocks grow, and only from 8 to 12.', 'Noise has to fall, by 24 dB, for those bits to mean anything, in both of them.', 'Sample rate is a choice, and it is not set by the bit count alone.'],
      },
    },
    {
      title: 'The way back: a ladder',
      body: `
        <p>Going from a word to a voltage has an elegant answer in the <strong>R-2R ladder</strong>. Each bit switches a 2R resistor between 0 and the reference, and series R's join them. Looking back from any node, the rest of the ladder looks like 2R, so each bit's contribution halves on its way along, and only two values of resistor are needed.</p>
        <p>The widget solves the ladder node by node with each resistor seeded off by its σ. Judge a staircase by two figures. <strong>DNL</strong> is how far each step is from one LSB, and a step of less than zero means it went backwards. <strong>INL</strong> is how far each output is from the straight line between the ends.</p>
        <p>The worst step usually comes at the middle of the range: going from 0111 1111 to 1000 0000, every bit changes at once and all the errors meet. With every resistor about 1 % out, that step is typically 1 to 2 LSBs off at 8 bits: the median over 200 such ladders is 1.2 LSBs, and the one drawn first here, at 1.9, is worse than most. Matching is a matter of area, and that is the real price of a converter's bits.</p>
        <div class="try">Raise σ to 3 % and try other ladders. Find one that goes backwards, then bring σ down until none does.</div>`,
      widget: ladderWidget,
      challenge: {
        kind: 'quiz', question: 'Why is a ladder\'s worst step usually in the middle of its range?',
        options: ['Every bit changes there at once', 'The reference is noisiest at half', 'The switches are slowest at half', 'It is not: every step is alike'],
        answer: 0,
        explain: 'Going from 0111… to 1000… turns the MSB on and all the others off, and that step is the difference of their errors. Everywhere else fewer bits change.',
        why: ['', 'The reference is the same at every code in this model.', 'This is a static figure, so speed has no part in it.', 'Move σ up and read which code the worst one is before.'],
      },
    },
    {
      title: 'A shaky clock',
      get body() {
        return `
        <p>Every sample is taken at a moment, and no clock is perfectly on time. A sample taken σ seconds off on a slope reads wrong by that slope times σ. A sine's slope at full scale is 2π f, so the error goes with the <em>signal's</em> frequency, and the limit is −20 log₁₀(2π f σ) dB, whatever the converter's bits and whatever its sample rate.</p>
        <p>The figure is unforgiving. At 1 ps of jitter a 1 MHz input is limited to ${jitterLimitDb(1e6, 1e-12).toFixed(0)} dB, about ${enob(jitterLimitDb(1e6, 1e-12)).toFixed(0)} effective bits, about what the best chain in this chapter measures. A 100 MHz input gets ${jitterLimitDb(1e8, 1e-12).toFixed(0)} dB: about ${((jitterLimitDb(1e8, 1e-12) - 1.76) / 6.02).toFixed(0)} bits, however many are delivered. That is why a converter sampling a radio's band directly costs far more in its clock than its arithmetic.</p>
        <div class="try">Hold jitter at 10 ps, and raise the frequency. The measured figure follows the formula, on a sine sampled with seeded errors.</div>`;
      },
      widget: jitterWidget,
      challenge: {
        kind: 'quiz', question: 'Sampling a 70 MHz band instead of 7 MHz, with the same clock, costs how much at the jitter limit?',
        options: ['20 dB', '6 dB', '3 dB', 'Nothing: it depends on bits'],
        answer: 0,
        explain: 'Ten times the frequency is ten times the slope, which is 20 dB, or more than three effective bits.',
        why: ['', 'That would be a doubling of frequency.', 'That is a doubling of power, and this is amplitude going up tenfold.', 'The limit does not mention bits at all.'],
      },
    },
    {
      title: 'One bit, and feedback',
      get body() {
        const a = sdMeasuredDb(2, 64, 0.5), m = sdLinearModelDb(2, 64, 0.5), pw = sdErrorPower(2, 0.5), m2 = sdLinearModelDb(2, 64, 0.5, pw);
        return `
        <p>So far every bit has been paid for in matching. <strong>Sigma-delta</strong> takes another way: one bit, whose two levels cannot be out of line with each other, sampled far faster than the signal needs. Rate is cheap, and it can be traded for bits.</p>
        <p>Feed the error back through an integrator. The loop adds up input minus output, and decides from the sign of that sum, so that over time the bits' average follows the input. That is order 1. This chapter's loop has two integrators in a row, order 2: with u the input and v the output (+ or − full scale),</p>
        <pre>y₁ ← y₁ + u − v
y₂ ← y₂ + y₁ − v
v  = + full scale if y₂ ≥ 0, else − full scale</pre>
        <p>In symbols, with the quantizer's error E:</p>
        <pre>V = z⁻¹ U + (1 − z⁻¹)² E</pre>
        <p>The signal comes through with a delay. The error comes through a filter, (1 − z⁻¹)², that is nearly zero at low frequencies and largest at half the rate. The tests check this as an identity, to the bit, on the error the loop recorded. Nothing has been removed, only moved, and filtering it out is a job from an earlier chapter. Here oversampling alone buys 3 dB a doubling, and shaping adds 6 dB for each order: in theory <strong>9 dB at order 1, 15 at order 2</strong>. Order 2 measures about 13 to 16 at half of full scale, from 16 to 256 times the rate, and less near the top. Order 1 wanders between 6 and 11, since its noise is less like noise: it falls into patterns tied to the input.</p>
        <p>The textbook's sum treats the quantizer as added white noise. That gets the slope right and the level close: at 64 times the rate and half of full scale it predicts ${m.toFixed(1)} dB, and the loop measures ${a.toFixed(1)}. Most of the gap is one assumption you can measure. A step of 2 should give an error power of 1/3, and this loop's error has ${pw.toFixed(2)}: with that figure the sum gives ${m2.toFixed(1)}. What is left is an error that is neither white nor independent of its input.</p>
        <p>Now the top of the range. This loop goes on following while the input is under full scale, but its integrators grow as it nears it: their peak is about ${sdPeak(2, 0.5).toFixed(0)} full scales at half of full scale, ${sdPeak(2, 0.8).toFixed(0)} at 0.8 and ${sdPeak(2, SD_LIMIT).toFixed(0)} at ${SD_LIMIT}, and on a steady full-scale input it has no bound. The error grows too, so the measured figure falls well before the words run out: ${sdMeasuredDb(2, 64, 0.8).toFixed(0)} dB at 0.8 and ${sdMeasuredDb(2, 64, SD_LIMIT).toFixed(0)} dB at ${SD_LIMIT}. ${SD_GUARD} bits above the input hold ${2 ** SD_GUARD} full scales, so for a tone or a steady input ${SD_LIMIT} is where this design's slider stops. That is not a promise for every input: a hard step is worse, and a square wave of ±0.85 can already reach the wrap. An analogue integrator clips at its supply far sooner, which makes a real part's usable range a design question of its own.</p>
        <div class="try">At order 2, step the oversampling from 16 to 128 and read the gain each time. Then raise the input level towards ${SD_LIMIT}, and watch the noise come up.</div>`;
      },
      widget: sdWidget,
      challenge: {
        kind: 'quiz', question: 'A second-order loop reaches 70 dB at some rate. What does doubling the rate buy?',
        options: ['About 15 dB', 'About 3 dB', 'About 6 dB', 'About 9 dB'],
        answer: 0,
        explain: 'Oversampling alone gives 3 dB a doubling, and each order of shaping adds 6. Measure it in the widget: at middling levels it runs near that, and it falls away as the input nears the top.',
        why: ['', 'That is what plain oversampling gives, with no feedback.', 'That is one order of shaping alone, without the band narrowing.', 'That is an order-1 loop.'],
      },
    },
    {
      title: 'The loop in gates, and its CIC',
      get body() {
        const { N, R } = SCENE_CHAIN;
        return `
        <p>In a real converter the integrators are analogue, and that is where its noise and its limit come from. Here they are words, so that the arithmetic can be compared exactly. The one-bit DAC costs nothing: the words for + and − full scale differ only in their top bits, so it is the decision's inverse on some wires. The loop drawn here, at ${SCENE_CHAIN.w} bits, is ${n0(MOD(SCENE_CHAIN.w))} NANDs, and at ${CHAIN.w} bits it is ${n0(MOD())}. Its integrators have the ${SD_GUARD} extra bits the last step worked out, and the tests hold the model to a tone or a steady input of ${SD_LIMIT}, and these gates to the model.</p>
        <p>What leaves is a bit at the high rate. <a href="#/c/multirate/7">The CIC from the rate chapter</a> takes it from there, unchanged. Each bit goes in as +1 or −1, a two-bit word, and its registers grow to ${cicWidth(N, R, 2)} bits by N log₂ R. A CIC of one order more than the loop is the usual choice, since the noise rises at the loop's order, and it needs to fall faster than that.</p>
        <div class="try">Run a tone. Look at the strip of bits at the bottom: they do not look like a sine, and yet their running average follows it.</div>`;
      },
      scene: adcScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run a tone through the converter, with every clock agreeing with the models.',
        check: (st) => { const a = adcApi.get(st); return !!a && a.clocks() > 0 && a.agrees(); },
        hints: ['The panel beside the circuit has one button.'],
        answer: 'The loop turns the tone into bits, and the CIC turns those into words at a low rate. The gates hold every value the models hold, at every clock.',
        solve: (st) => { adcApi.get(st)?.run(); },
      },
    },
    {
      title: 'Many bits from one',
      get body() {
        return `
        <p>Now measure the chain. At ${CHAIN.R} times the rate, order ${CHAIN.order} and a CIC of order ${CHAIN.N}, a tone at half of full scale gives ${chainEnob().toFixed(1)} effective bits, read from words at the low rate. At ÷ 128 it is ${chainEnob(128).toFixed(1)}, and at ÷ 256 it is ${chainEnob(256).toFixed(1)}, past the 16 bits the chapter set out for, at about ${(((chainEnob(256) - chainEnob()) / 2) * 6.02).toFixed(0)} dB a doubling. Being judged on a half-scale tone, these read about a bit lower than the same noise would against full scale. Those are figures for this chain, this input and this digital arithmetic. A real part has analogue noise in its integrators that this one lacks, and that is usually what stops it. The ${n0(WHOLE())} NANDs at ÷ ${CHAIN.R} take the place of a matched array of 2^b elements.</p>
        <p>You can hear what the filter does. Both clips below come from the same bits. Keeping every ${CHAIN.R}th bit and nothing else folds all that high-frequency noise down over the tone. Through the CIC, the noise goes and the tone stays. Those are model clips, and the gates above have been shown equal to that model.</p>
        <p>Audio converters do this because high rates are cheap and matching is not, and it has the same price as any other trade here: this design only reaches a low frequency, and takes its time.</p>`;
      },
      widget: clipWidget,
      challenge: {
        kind: 'quiz', question: 'Why does keeping every 64th bit sound so much worse than the CIC, from the same bits?',
        options: ['The noise folds down over the tone', 'It has fewer bits per second', 'It has lost the tone itself along the way', 'The CIC adds its own signal'],
        answer: 0,
        explain: 'Nearly all the noise power sits above the band. With no filter first, decimation folds it into the band, as this level\'s rate chapter showed.',
        why: ['', 'Both clips play at the same rate, so that is true of neither one more than the other.', 'The tone is still there, under the noise.', 'It adds nothing. It takes averages of what is there.'],
      },
    },
  ],
};
