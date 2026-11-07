// Filters that learn (level Signal processing): how do you cancel an echo you cannot measure? The Wiener solution against scipy's solve_toeplitz, LMS and NLMS, an echo canceller and an equalizer on labelled models, and an LMS filter in gates
// (lib/sigmadelta.ts) compared with dsp/adaptive.ts every clock. The far end is a public-domain LibriVox reading (dsp/echofigs.ts); the echo path and room noise are models. No G.168 compliance is claimed.

import { runEqualizer } from '../dsp/adaptive';
import { ECHO_FIGS as E, ROOM_NOISE } from '../dsp/echofigs';
import { lmsFilter, lmsTap } from '../lib/sigmadelta';
import { treeMul } from '../lib/muldiv';
import { stats } from '../sim/stats';
import { bowlWidget, CHANNELS, echoWidget, eqWidget, ECHO_TAPS, LMS_SPEC, LMS_TARGET, lmsApi, lmsScene } from '../widgets/dspadaptive';
import { numOf } from './order';
import type { Chapter } from './types';

const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const minus = (t: string) => t.replace(/-/g, '−');

export const chAdaptive: Chapter = {
  id: 'adaptive', num: numOf('adaptive'), title: 'Filters that learn', level: 'Signal processing',
  blurb: 'How do you cancel an echo you cannot measure? The Wiener solution, LMS and NLMS, an echo canceller and an equalizer you can hear and see converge, and an LMS tap in gates.',
  goals: [
    'state what the best filter depends on, and solve for it',
    'walk down the error with LMS, and say what limits the step',
    'cancel an echo through a path nobody measured, and say what near-end talk does to it',
    'price learning in gates: what a tap costs beside a tap that does not learn',
  ],
  builds: ['noise', 'serial', 'zplane', 'muldiv'],
  recap: {
    keep: [
      'The best FIR in the mean-square sense depends only on the input\'s autocorrelation and its correlation with what you want: R w = p. Toeplitz, so n² work by Levinson.',
      'LMS needs neither. It moves each tap by μ e x, and its average is a walk down the same bowl. It costs two multipliers a tap where a fixed filter needs one.',
      'The step has a limit of 2 over the energy in the filter\'s samples, 2 / (N σ²) for a steady input and set by the loudest stretch for speech, so a loud input can break a filter that was stable. NLMS divides by the input\'s power, so its step limit does not care.',
      'An echo canceller works because the far-end signal is known and the path is linear. Near-end talk looks like huge error, so a practical one stops learning while someone is talking there.',
      'An equalizer learns from a known preamble, and then from its own decisions. It cannot invert a channel with a zero on the unit circle.',
    ],
    check: [
      {
        question: 'What does LMS need to know in advance about the signal it is filtering?',
        options: ['Nothing: only a step size', 'Its autocorrelation', 'Its correlation with d', 'The impulse response it seeks'],
        answer: 0,
        explain: 'Each update uses only the current samples and the current error. The correlations are what the Wiener solution needs, and LMS averages its way to the same place without them.',
        why: ['', 'The Wiener solution needs that, and LMS does not.', 'That too is for the Wiener solution.', 'If you knew it you would not need to learn.'],
      },
      {
        question: 'A plain LMS canceller is stable, then the far end talks ten times louder and it diverges. What does that say?',
        options: ['Its step limit depends on power', 'Its filter is too short for the path', 'The echo path has changed', 'It needs more bits'],
        answer: 0,
        explain: 'The limit goes as 2 / (N σ²). Ten times the amplitude is a hundred times the power, so a step that was safe no longer is. NLMS fixes this by dividing the step by the input\'s power.',
        why: ['', 'A short filter leaves echo, and it stays stable.', 'Nothing here says it has, and a change would only send it learning.', 'Bits are what the fixed-point version wants, and this is in real numbers.'],
      },
      {
        question: 'Why does an echo canceller stop learning when someone talks at the near end?',
        options: ['Their voice lands in the error', 'Their voice raises the far end\'s power', 'The microphone turns off', 'It saves multiplications'],
        answer: 0,
        explain: 'Near-end speech lands in the error. It has nothing to do with the far-end signal, so the update pushes the filter away from the answer. Holding the filter still while it lasts protects what has been learned.',
        why: ['', 'The far end\'s signal is not changed by anything said at the near end.', 'It stays on, because the near-end voice is what the call is for.', 'It does, but that is not the reason.'],
      },
    ],
  },
  steps: [
    {
      title: 'An echo nobody can measure',
      body: `
        <p>A speaker at your end plays what the far end said. It comes back through the room and into your microphone, and the far end hears itself a moment later. The room is a filter, and if you knew its impulse response you could run the same signal through a copy, subtract it, and be done. You know the far-end signal exactly. What you do not know is the filter. It changes when someone moves, and you cannot stop the call to measure it.</p>
        <p>So a filter has to find its own coefficients from the signals going past. The same need turns up elsewhere: <a href="#/c/serial/6">a fast serial link's equalizer</a> fixes a channel, and there that filter was set by hand. This chapter takes the same structure and lets it learn.</p>
        <p>The far end in this chapter is a real voice: four seconds of a LibriVox reading of the Gettysburg Address, whose recordings LibriVox releases into the public domain, and a second of the same reader's next sentence stands in for someone talking at your end. The echo path is a seeded model, and so is the room noise at the microphone, about 50 dB below full scale. Every claim here has its number on the screen. The figures are for this voice on these paths.</p>`,
      challenge: {
        kind: 'quiz', question: 'Which of these does the canceller have, and which must it find?',
        options: ['It has the far-end signal, and must find the path', 'It has the path, and must find the signal', 'It has both from the start, so nothing is left to find', 'It must find both'],
        answer: 0,
        explain: 'The signal it is about to play is known to the bit. The room is what nobody has measured.',
        why: ['', 'The path is what changes, and nobody has it.', 'If it had both, a fixed filter would do.', 'It is sending that signal, so it knows it.'],
      },
    },
    {
      title: 'The best a filter can do',
      body: `
        <p>Say an FIR filter w takes input x and should produce d, and you judge it by the mean of the squared error. That mean is a bowl in the coefficients: a quadratic, with one bottom. Set its slope to zero and you have the <strong>Wiener solution</strong>:</p>
        <pre>R w = p
R: x's autocorrelation
p: x with d</pre>
        <p>It takes no knowledge of how d was made: only those two sets of correlations. For a stationary input, R is Toeplitz, so Levinson's recursion solves it in about n² operations where a general solver takes n³. Compared with scipy's <code>solve_toeplitz</code> here, it agrees to 8 places.</p>
        <p>So the question has an answer, for a known input and a fixed path. Two things are wrong with it in a call: the statistics have to be estimated first, and by then the path has changed. It is the target, and also what proves a learning filter has got there.</p>`,
      challenge: {
        kind: 'quiz', question: 'What does the Wiener solution depend on?',
        options: ['Only the two correlations', 'How d was produced', 'The phase of every single sample', 'The word length'],
        answer: 0,
        explain: 'Only R and p. Any way of making d that gives the same correlations gives the same best filter.',
        why: ['', 'It needs no model of that, and that is its power.', 'The correlations average that away.', 'The solution is in real numbers. Word length is a question for its implementation.'],
      },
    },
    {
      title: 'One step downhill, per sample',
      body: `
        <p>Don't solve for the bottom: walk to it. The slope of the bowl needs those expected values, but one sample gives a noisy estimate: −2 e x. In 1960 Widrow and Hoff took that seriously, and <strong>LMS</strong> is the result:</p>
        <pre>e = d − Σ wₖ xₖ
wₖ ← wₖ + μ e xₖ</pre>
        <p>That is one more multiply per tap, and nothing else: no correlations, no matrix, no idea what the signal is. Any one step may go the wrong way, and on average they go downhill.</p>
        <p>Colour matters. A white input makes a round bowl, so every coefficient converges at one speed. A coloured one makes a long narrow valley, and the walk crosses it quickly and creeps along it slowly. Speech is very coloured.</p>
        <div class="try">Start with colour 0 and watch the path run straight in. Then raise the colour, and watch it slide down the valley. Raise the step until it leaves.</div>`,
      widget: bowlWidget,
      challenge: {
        kind: 'quiz', question: 'Why does a coloured input make LMS slow?',
        options: ['One step size must suit a long bowl', 'It has fewer samples each second', 'It costs more multiplications', 'Colour changes the Wiener solution it seeks'],
        answer: 0,
        explain: 'Each direction converges at a rate set by its own curvature. The step is limited by the steepest, so the flattest crawls. The ratio is the spread of the correlation matrix\'s eigenvalues.',
        why: ['', 'Sample rate has nothing to do with colour.', 'Each step costs the same.', 'It may move the solution, but that does not slow the walk to it.'],
      },
    },
    {
      title: 'An echo canceller',
      get body() {
        return `
        <p>Now the real case, with the far end's sound through the hidden path: ${ECHO_TAPS} taps, ${ECHO_TAPS * 2} multiplications a sample. The figure of merit is <strong>echo return loss enhancement</strong>, how far the echo has come down, and it reaches ${E.erle.toFixed(0)} dB here over the last quarter of the run, where the room noise, ${(20 * Math.log10(ROOM_NOISE)).toFixed(0)} dB of full scale, sets the floor. Standards such as ITU-T G.168 set tests for this. This is a teaching model, and it does not claim to meet them.</p>
        <p>The plain form has a problem you can provoke. A step shrinks the error only while μ is below 2 over the energy in the filter's samples, which is 2 / (N σ²) for a steady input. A voice is not steady. This one's average power would allow ${E.avgAllows.toFixed(2)}, its loudest ${ECHO_TAPS} samples allow only ${E.loudestAllows.toFixed(3)}, and the loudest stretch is what counts. That limit is a guarantee, not the edge: this run still converges at ${E.stillConverges} times it and has fallen apart at ${E.diverges} times it. Either way it is set by how loud the far end happens to be at its worst. <strong>NLMS</strong> divides the step by the power in the filter, so its stability and its rate of convergence do not depend on loudness. Its μ can then be between 0 and 2. What it reaches still does, because the room noise stays put: a quiet far end sits closer to it.</p>
        <p>Too short a filter leaves what it cannot reach: ${E.erle32.toFixed(0)} dB with 32 taps. And then someone at your end talks. To the filter, that voice is a huge error it should fix, so it wrecks what it has learned. Over the last second of the run, which starts just before the voice ends, it is still only at ${E.talkOn.toFixed(0)} dB with learning left on, against ${E.talkHeld.toFixed(0)} when it stopped. This model tells the filter exactly when someone talks. A real one has to detect it, and that is where most of the hard work in a real canceller is.</p>
        <div class="try">Turn off Normalized, then raise the far end's loudness to ${E.loudDiverges}, and see that a step that suits one level does not suit another. Turn Normalized back on, and the same loudness only lifts the voice further above the room noise. Then add talk at the near end, and try stopping the learning.</div>`;
      },
      widget: echoWidget,
      challenge: {
        kind: 'quiz', question: 'A canceller has 32 taps on a 128-tap path, and has fully converged. What limits it?',
        options: ['The tail it has no taps for', 'Its step size', 'The far end\'s colour and its pauses', 'NLMS being too slow'],
        answer: 0,
        explain: 'Echo after the 32nd sample cannot be subtracted by any setting of those taps. It stays there as the floor, however long the filter runs.',
        why: ['', 'A smaller step gets closer to the same floor, and no further.', 'Colour sets how fast it gets there, not where the floor is.', 'It has already converged, so speed is no longer the question.'],
      },
    },
    {
      title: 'An equalizer',
      get body() {
        const g = runEqualizer({ channel: CHANNELS[0].h, taps: 15, delay: 8, mu: 0.05, n: 12000, seed: 5, train: 4000 }), z = runEqualizer({ channel: CHANNELS[2].h, taps: 15, delay: 8, mu: 0.05, n: 12000, seed: 5, train: 4000 });
        return `
        <p>Turn it round: rather than copying a path to subtract it, learn the path's inverse. Send known symbols, and let d be those symbols, delayed. This is the training sequence you meet at the start of a Wi-Fi frame or a modem's call, and the equalizer is the filter from <a href="#/c/serial/6">Fast serial links</a>, now finding its own taps.</p>
        <p>After training it can go on learning from its own decisions, on the bet that they are nearly all right. That tracks a slowly changing line with no more training. On this channel a gap of ${minus(g.openingBefore.toFixed(2))} on the line (shut, since it is below 0) becomes ${g.opening.toFixed(2)} after it, with no symbols wrong.</p>
        <p>There is a limit: a filter cannot bring back what the channel removed. The channel 0.5 + z⁻¹ + 0.5 z⁻² has a double zero at half the rate, on the unit circle, and no stable filter has a pole there to cancel it. It gets ${z.wrongAfter} symbols wrong here, and leaves a gap of ${minus(z.opening.toFixed(2))}.</p>
        <div class="try">Try all three channels. Then cut the training short on the milder one and find where it stops being enough.</div>`;
      },
      widget: eqWidget,
      challenge: {
        kind: 'quiz', question: 'Why can a linear equalizer not fix a channel with a zero on the unit circle?',
        options: ['Its inverse needs a pole on the circle', 'It needs a longer run of training symbols', 'The channel has too few taps', 'Zeros only arise in noise'],
        answer: 0,
        explain: 'A pole on the circle is not stable, and that frequency has gone from the signal in any case. An FIR can only approximate the inverse, and it amplifies whatever is left near there.',
        why: ['', 'No length of training brings back a frequency that never arrived.', 'It is the channel\'s shape that counts, and this one has three.', 'They arise from the channel\'s taps, with no noise needed.'],
      },
    },
    {
      title: 'A tap in gates',
      get body() {
        const t = lmsTap(LMS_SPEC), f = lmsFilter(LMS_SPEC), mul = nands(treeMul(LMS_SPEC.w, true));
        return `
        <p>Here is what learning costs. A tap holds a sample and a coefficient, and has a multiplier for its share of the output. Learning adds a second multiplier, for e × x, and an adder. So one LMS tap is ${n0(nands(t))} NANDs at ${LMS_SPEC.w} bits, of which ${n0(2 * mul)} are multipliers. Four of them with the sums come to ${n0(nands(f))}. A fixed filter would have half the multipliers, so a learning filter is about twice the price, and this is why a design often learns on a few taps or takes turns.</p>
        <p>The words have their own effects. Each update is e × x moved down ${LMS_SPEC.s} places and rounded half up, the bit below the cut going in as the adder's carry, at no cost in gates. Plain truncation would be worse than it sounds: it takes one off any small negative product, so the coefficients slide away with nothing to stop them. Rounded, an update inside ±${2 ** (LMS_SPEC.s - 1)} is zero and the coefficient stays put. That is a <em>dead zone</em>: a quiet input leaves the filter short of its target, and it is why an adaptive filter's coefficients need more bits than its samples. The output has the same care: the products are summed with all their bits, which is why the sums are ${2 * LMS_SPEC.w} bits wide, and rounded once at the end. Too large a step wraps a word instead of saturating it, and the filter falls apart at once, as nothing in the design catches it. It is compared with an integer model at every clock.</p>
        <div class="try">Learn. Four coefficients walk from zero to ${minus(LMS_TARGET.join(', '))}, a filter the design was never told about, in a few dozen clocks. Then learn from a quiet input, and see where the dead zone leaves them.</div>`;
      },
      scene: lmsScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Let the gates learn the filter, with every clock agreeing with the model and the output within 10 dB of d.',
        check: (st) => { const a = lmsApi.get(st); return !!a && a.clocks() > 0 && a.agrees() && a.errorDb() < -10; },
        hints: ['The panel beside the circuit has one button.'],
        answer: 'x goes through an unknown filter to make d. The error between d and the filter\'s output moves each coefficient a little at every clock. After a few dozen clocks the coefficients are close to the target, as far as the dead zone lets them come.',
        solve: (st) => { lmsApi.get(st)?.run(); },
      },
    },
  ],
};
