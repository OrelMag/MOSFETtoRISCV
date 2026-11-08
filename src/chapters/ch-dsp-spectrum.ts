// Measuring a spectrum: why a pure tone shows a skirt, the windows that shape it, resolution against dynamic range, spectrograms, overlap-save fast
// convolution, and Goertzel in gates decoding DTMF. The model is dsp/spectrum.ts (held to scipy by tests/dsp-spectrum.test.ts); the one part in gates is
// lib/goertzel.ts. Every number in the text is computed from them; what the text claims is tests/dsp-spectrum-chapter.test.ts.

import { binsBreakEven, bestBlock, bestBlockFor, crossoverTaps, DTMF_FS, dtmfFreqs, fftRealMults, goertzelCoef, olsMults, resolvingSep, resolvingSepAt, skirtAt, stateBits, stateGain, weakestSeen, windowFigures, type WinKind } from '../dsp/spectrum';
import { goertzelCell } from '../lib/goertzel';
import { fftStream } from '../lib/fft';
import { treeMul } from '../lib/muldiv';
import { stats } from '../sim/stats';
import { dtmfCoefs, dtmfScene, DTMF_N, goertzelWidget, leakStats, leakageWidget, misreads, olsWidget, padWidget, minSamples, PAD_GAP, resolveWidget, spectrogramWidget, windowsWidget } from '../widgets/dspspectrum';
import { DSP_LEVEL } from './dspladder';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const nf = (v: number, d = 1) => v.toFixed(d).replace('-', '−');
const n0 = (v: number) => groupNum(Math.round(v));
const F = (k: WinKind) => windowFigures(k, 128);
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;

/** Every figure the text quotes, from the model and the gates. Lazy: the gate counts build a few designs. */
export function spectrumFacts() {
  const Cs = dtmfCoefs(), gain = Math.max(...Cs.map((C) => stateGain(C, DTMF_N))), best = bestBlockFor(dtmfFreqs(), DTMF_FS, 256);
  return {
    rect: F('rect'), hann: F('hann'), blackman: F('blackman'), bh: F('blackmanharris'),
    sepRect: resolvingSep(64, 'rect'), sepHann: resolvingSep(64, 'hann'), sepBlackman: resolvingSep(64, 'blackman'),
    skirt10: { rect: skirtAt('rect', 10, 64), hann: skirtAt('hann', 10, 64), blackman: skirtAt('blackman', 10, 64) },
    weak6: { rect: weakestSeen(64, 6, 'rect'), hann: weakestSeen(64, 6, 'hann'), blackman: weakestSeen(64, 6, 'blackman') },
    leakFar: { db: 20 * Math.log10(leakStats(10.5, 'rect').far), oneSkirt: -20 * Math.log10(Math.PI * 16.5) },
    phase90: { rect: resolvingSepAt(64, 'rect', Math.PI / 2), hann: resolvingSepAt(64, 'hann', Math.PI / 2) }, phase180: { rect: resolvingSepAt(64, 'rect', Math.PI) },
    leak10: leakStats(10, 'rect'), leak105: leakStats(10.5, 'rect'), leak125: leakStats(12.5, 'rect'),
    minRect: minSamples('rect'), minHann: minSamples('hann'),
    cross: crossoverTaps(),
    cell: nands(goertzelCell()), cellMul: nands(treeMul(16, true, 30)), mul: nands(treeMul(16, true)), fft256: nands(fftStream(256, 12)),
    gain, bits: stateBits(Cs, DTMF_N), best, perKey: dtmfFreqs().length * (DTMF_N + 1),
    mis60: misreads(60), mis200: misreads(200),
  };
}

export const chSpectrum: Chapter = {
  id: 'spectrum', num: numOf('spectrum'), title: 'Measuring a spectrum', level: DSP_LEVEL,
  blurb: 'Why a pure tone shows a skirt: leakage, windows and what they trade, resolution against the number of samples, spectrograms, fast convolution by overlap-save, and a Goertzel cell in gates decoding a keypad.',
  goals: [
    'say where a tone\'s skirt comes from, and why it vanishes when the block holds a whole number of cycles',
    'choose a window by its main lobe, its sidelobes and its noise bandwidth, and say what each costs',
    'tell resolution (two tones close together) from dynamic range (a weak tone near a strong one), and say why zero padding buys neither',
    'trade time detail against frequency detail in a spectrogram, and compute the cost of overlap',
    'filter with a long FIR by blocks (overlap-save), and say how many taps make that cheaper',
    'build one frequency detector from a recurrence in gates, size its state word, and decide when it beats an FFT',
  ],
  builds: ['signals', 'carriers', 'fixed', 'zplane'],
  get recap() {
    const f = spectrumFacts();
    return {
      keep: [
        'A block of N samples is the signal times a rectangle, and a product in time is a convolution in frequency: every tone is drawn as the rectangle\'s transform, a main lobe two bins wide with sidelobes that fall 6 dB for each doubling of distance (in a real block the mirror image at negative frequency adds its own skirt, and the curve levels off near −30 dB from about 8 bins out). A tone that fits the block a whole number of times puts all the other bins on zeros of that skirt, which is the only reason it looks clean.',
        `A window tapers the block's edges. The skirt falls faster and the main lobe widens: ${nf(f.rect.mainLobeBins, 0)} bins and ${nf(f.rect.sidelobeDb)} dB for the rectangle, ${nf(f.hann.mainLobeBins, 0)} and ${nf(f.hann.sidelobeDb)} for Hann, ${nf(f.bh.mainLobeBins, 0)} and ${nf(f.bh.sidelobeDb)} for four-term Blackman–Harris. The window also raises the noise floor (Hann ${nf(f.hann.enbw, 2)} bins of noise bandwidth) and softens the loss for a tone between bins.`,
        `Resolution is how close two equal tones can be and still show a dip: ${nf(f.sepRect, 2)} bins for the rectangle, ${nf(f.sepHann, 2)} for Hann. Dynamic range is how weak a tone can be beside a strong one: set by the skirt. Windows trade one for the other. Only more samples shrink a bin, so zero padding interpolates the picture and resolves nothing.`,
        'A spectrogram is a column of windowed spectra a hop apart. The frame length sets both details at once: frequency detail goes as fs / N, time detail as N / fs. A signal that moves during a frame is smeared, and overlap costs one more transform per hop.',
        `Overlap-save filters by blocks of N with M taps: the last M − 1 inputs are repeated, the first M − 1 outputs of a block are circular wrap-around and are thrown away, and L = N − M + 1 come out. With the best power-of-two block it costs fewer real multiplications a sample than the direct form from ${f.cross} taps.`,
        `Goertzel is one bin as a second-order recurrence: one multiplication a sample, three at the end, any frequency. An FFT beats K Goertzels from about 2 log₂ N bins. Its state grows like the filter's impulse response sums: ${nf(f.gain, 0)} at the worst DTMF tone, ${f.bits} bits for 8-bit inputs.`,
      ],
      check: [
        {
          question: 'You zero pad a 64-sample block to 4 096 points before the FFT. What did that do?',
          options: ['Evaluated the same continuous spectrum at more points: smoother curve, same main lobe', 'Made the main lobe 64 times narrower', 'Reduced the sidelobes by 36 dB', 'Added 4 032 samples of information'],
          answer: 0,
          explain: 'The zeros add no information. The transform of the block is one fixed curve, and padding only reads it at finer steps.',
          why: ['', 'The lobe\'s width in cycles a sample is set by the number of real samples, 1 / 64.', 'Sidelobes belong to the window, and padding does not change the window.', 'The zeros are not measurements.'],
        },
        {
          question: 'A tone 40 dB below another sits 10 bins from it. Which window shows it?',
          options: ['Hann: its skirt there is under −60 dB', 'Rectangular: it has the narrowest main lobe', 'Neither: 40 dB is too weak for any window', 'Both, equally: the distance is outside either main lobe'],
          answer: 0,
          explain: `At 10 bins the rectangle's skirt is ${nf(skirtAt('rect', 10, 64))} dB, above the weak tone, which hides under it. Hann's is ${nf(skirtAt('hann', 10, 64))} dB.`,
          why: ['', 'The narrow lobe helps resolve equal tones, not find a weak one: that is set by the skirt\'s height.', 'It is a matter of the skirt\'s level, and some windows reach −90 dB.', 'The lobes do not matter at 10 bins. The sidelobes do, and they differ by tens of dB.'],
        },
        {
          question: 'A decoder needs 8 frequencies out of a 256-sample block. Goertzel or an FFT?',
          options: ['Goertzel: 8 bins is under the break-even of 16', 'FFT: it computes every bin in N log N', 'FFT: Goertzel only works at bin centres', 'Goertzel: it needs no multiplications'],
          answer: 0,
          explain: `One bin costs N real multiplications; the FFT's ${n0(fftRealMults(256))} (counted at 4 per butterfly) buys all of them. Break-even is ${nf(binsBreakEven(256), 0)} bins.`,
          why: ['', 'Computing 129 bins to keep 8 pays for 121 you throw away.', 'It works at any frequency: c = 2 cos(2πf) takes any f. Off a bin centre it leaks like the FFT does.', 'It needs one a sample.'],
        },
      ],
    };
  },
  steps: [
    {
      title: 'A tone that is not a line',
      get body() {
        const f = spectrumFacts();
        return `
        <p><a href="#/c/signals/1">Chapter ${numOf('signals')}</a> drew a tone as one line, and its spectrum view showed clean lines because it kept a whole number of cycles in the block. That was a convenience. The z-plane gave a filter's response exactly, from its coefficients; a spectrum measured from real samples is not exact, and this chapter is about why and what to do about it. A real measurement has the block it has, and the tone does not fit it. Here are 64 samples of a tone.</p>
        <p>A block of N samples gives N <strong>bins</strong>: bin k is the transform at k whole cycles a block, so bins are f<sub>s</sub> / N apart. Looking through a block is multiplying the signal by a rectangle. Multiplication in time is convolution in frequency, so every line in the true spectrum is replaced by the rectangle's own transform: a <strong>main lobe</strong> two bins wide around the tone, and smaller <strong>sidelobes</strong> either side that fall 6 dB for each doubling of distance (the window's own transform, plotted alone in the next step). The grey line is the transform of the real block; the transform computes it only at the bins, the dots.</p>
        <p>At 10 bins the block holds exactly ten cycles, all the other bins fall on zeros of the curve, and the spectrum is one clean bin reading 1. Move to 10.5: the largest bin reads ${nf(f.leak105.top, 3)} and <strong>all ${f.leak105.above60} bins</strong> read above −60 dB. At 12.5 the two bins either side of the tone read ${nf(f.leak125.top, 2)} each. This is <strong>leakage</strong>, and it is not noise and not a fault of the tone: it is what a cut-off sinusoid looks like. A tone of amplitude 1 reading ${nf(f.leak105.top, 2)} is ${nf(-20 * Math.log10(f.leak105.top), 1)} dB low: a peak read straight off a bin can be wrong by that much.</p>
        <div class="try">Set the tone to 10 bins and count the bins above −60 dB. Then 10.5, then 10.25. Slide slowly from 10 to 10.5 and watch the dots: the skirt does not move, the bins slide along it.</div>`;
      },
      widget: () => leakageWidget(['rect']),
      more: {
        get derive() {
          const f = spectrumFacts();
          return `<p>The grey line is not exactly one rectangle's transform. A real cosine is two exponentials, at +f and at −f, so the mirror image's skirt adds in, and the block is periodic. Out to about 8 bins the line follows the 6 dB rule; then it levels off near −30 dB instead of falling on. At 10.5 the bin 16 past the tone's nearest bin reads ${nf(f.leakFar.db)} dB, where a single skirt alone, 16.5 bins away, would read ${nf(f.leakFar.oneSkirt)} dB.</p>`;
        },
      },
      challenge: {
        kind: 'quiz', question: 'A 64-sample block holds a tone of 12.5 cycles under a rectangular window. What does its spectrum show?',
        options: ['About 0.64 at bins 12 and 13, and a skirt that falls slowly on both sides', 'One bin of 1.0 at bin 12.5', 'Nothing between bins: it is not on a bin', 'A single bin at 13 with all other bins zero'],
        answer: 0,
        explain: 'The tone sits halfway between two bins, so both read the rectangle\'s transform at half a bin, close to 2 / π = 0.64, and every other bin reads a point further out on the skirt.',
        why: ['', 'There is no bin 12.5. The transform only has whole bins.', 'The energy is there, spread over bins: a block cannot hide it.', 'A single nonzero bin needs the tone on the bin. It is between.'],
      },
    },
    {
      title: 'A window is a choice of skirt',
      get body() {
        const f = spectrumFacts();
        return `
        <p>A rectangle cuts the tone off hard, and the hardest cut makes the slowest skirt. Taper the block to zero at its edges first, and the skirt falls faster. The price is paid in the main lobe: tapering throws away samples near the edges, so the block counts as shorter and the lobe gets wider.</p>
        <p>The table is computed from the windows themselves. Going down it: the rectangle has a ${nf(f.rect.mainLobeBins, 0)}-bin lobe and its highest sidelobe is ${nf(f.rect.sidelobeDb)} dB; Hann ${nf(f.hann.mainLobeBins, 0)} bins and ${nf(f.hann.sidelobeDb)} dB; Blackman ${nf(f.blackman.mainLobeBins, 0)} and ${nf(f.blackman.sidelobeDb)}; the four-term Blackman–Harris ${nf(f.bh.mainLobeBins, 0)} and ${nf(f.bh.sidelobeDb)} dB. Each step down in sidelobes costs lobe width, and none of these four wins on both. The Kaiser window has a knob: β = 8 here, between Hann and Blackman–Harris, and raising it trades the same way.</p>
        <p>Two more columns matter when you measure. <strong>Noise bandwidth</strong> is the width of the rectangle that would pass the same white noise as a bin: ${nf(f.hann.enbw, 2)} bins for Hann, so the noise floor in a Hann spectrum reads ${nf(10 * Math.log10(f.hann.enbw), 1)} dB higher than the rectangle's for the same noise. And the <strong>loss at half a bin</strong> is how far a tone reads low when it falls between two bins: ${nf(f.rect.scallopDb, 2)} dB for the rectangle, ${nf(f.hann.scallopDb, 2)} for Hann, ${nf(f.bh.scallopDb, 2)} for Blackman–Harris. The spectra in this chapter divide by half the window's sum, so a tone on a bin reads its true amplitude whatever the window, to within 0.01 %.</p>
        <p>These are the periodic windows, the form for analysis, which repeat without a seam when a block follows a block. The symmetric form, with both ends equal, is the one used for filter taps; it is not needed here.</p>
        <div class="try">Step through the windows and watch the skirt on the right. Which has the narrowest lobe, and which the lowest sidelobes? Find the window that loses least for a tone between bins.</div>`;
      },
      widget: windowsWidget,
      more: {
        derive: '<p>A window of the cosine family is w[n] = a₀ − a₁cos(2πn/N) + a₂cos(4πn/N) − …. Each term shifts a copy of the rectangle\'s transform by one bin, and the signs and weights are chosen so the copies\' sidelobes cancel. That cancellation widens the lobe, which is the whole trade. The noise bandwidth has a closed form: (a₀² + Σ aₖ² / 2) / a₀², which is 1.5 for Hann and the test holds the sums to it.</p>',
      },
      challenge: {
        kind: 'quiz', question: 'Which of the rectangular, Hann and Blackman–Harris windows loses most amplitude for a tone half a bin off a bin centre?',
        options: [`The rectangular, ${nf(F('rect').scallopDb, 1)} dB`, `Hann, ${nf(F('hann').scallopDb, 1)} dB`, `Blackman–Harris, ${nf(F('blackmanharris').scallopDb, 1)} dB`, 'None: a tone loses nothing between bins'],
        answer: 0,
        explain: 'The narrower the lobe, the faster it falls away from the tone, and half a bin off is on its shoulder. A wide lobe is flatter there.',
        why: ['', 'Hann\'s lobe is twice as wide as the rectangle\'s, so it is flatter at half a bin.', 'Its lobe is widest of the three, so it loses least.', 'Between bins the peak is not on any bin, and every bin reads below it.'],
      },
    },
    {
      title: 'What the skirt hides',
      get body() {
        const f = spectrumFacts();
        return `
        <p>Two limits meet in a spectrum. <strong>Resolution</strong> asks how close two equal tones can be and still show as two. <strong>Dynamic range</strong> asks how weak a tone can be beside a strong one and still show at all. The window sets both, and in opposite directions.</p>
        <p>Resolution first. Two equal tones, in phase at the middle of the block, count as resolved when the spectrum between them falls 3 dB below both. That needs ${nf(f.sepRect, 2)} bins of separation under the rectangle, ${nf(f.sepHann, 2)} under Hann and ${nf(f.sepBlackman, 2)} under Blackman, found by searching the model in steps of 0.05 bin. The rectangle's narrow lobe resolves best. The phase matters: a quarter turn apart the same search gives ${nf(f.phase90.rect, 2)} bins for the rectangle and ${nf(f.phase90.hann, 2)} for Hann, and in opposite phase the tones cancel between them and read as two at ${nf(f.phase180.rect, 2)} bins. A resolution figure is a figure for tones in phase.</p>
        <p>Dynamic range next. A tone 10 bins away meets the first tone's skirt: ${nf(f.skirt10.rect)} dB under the rectangle, ${nf(f.skirt10.hann)} under Hann and ${nf(f.skirt10.blackman)} under Blackman. A second tone weaker than that is buried. The widget calls it <em>seen</em> when it stands at least 6 dB above that skirt, so a tone at −40 dB is seen under Hann and hidden under the rectangle. The skirt figure is the top of the skirt's lobes, the highest point within half a bin: the rectangle's and Hann's skirts have exact zeros at whole-number separations, and a weak tone sitting on one would show well below the skirt, which is a coincidence and not a margin to count on. At 6 bins the weakest tone each window still shows is ${nf(f.weak6.rect, 0)} dB for the rectangle, ${nf(f.weak6.hann, 0)} for Hann and ${nf(f.weak6.blackman, 0)} for Blackman. Resolution and dynamic range pull opposite ways: the window that resolves best hides the most.</p>
        <p>There is no better window to choose, only a choice about what you expect to find. And a bin is fs / N wide, so neither limit moves without more samples, as the next step shows.</p>
        <div class="try">With the rectangle set the second tone to −40 dB and the separation to 10 bins: hidden. Switch to Hann: seen. Then set the second tone to 0 dB and the separation to 2 bins: which windows show two peaks? Hamming draws a faint dip, shallower than the 3 dB the rule asks, and the chip says so.</div>`;
      },
      widget: resolveWidget,
      challenge: {
        kind: 'quiz', question: 'Two equal tones are 2 bins apart. Which of the six windows resolves them with a 3 dB dip?',
        options: ['Only the rectangular', 'Hann and Hamming', 'All six: 2 bins is wider than a bin', 'None: no window resolves tones under 3 bins apart'],
        answer: 0,
        explain: `The rectangle needs ${nf(resolvingSep(64, 'rect'), 2)} bins. Hamming needs ${nf(resolvingSep(64, 'hamming'), 2)}, Hann ${nf(resolvingSep(64, 'hann'), 2)}, and the rest more.`,
        why: ['', 'Their lobes are twice as wide as the rectangle\'s, and they need more than 2 bins.', 'The bin is the transform\'s spacing, and what matters is the main lobe, which is wider than a bin for every tapered window.', 'The rectangle does it at 1.55.'],
      },
    },
    {
      title: 'More points are not more resolution',
      get body() {
        const f = spectrumFacts();
        return `
        <p>The usual cure for a coarse picture is to append zeros to the block and take a longer FFT. It does make the picture smooth, and the smooth curve is the same one the dots were already on. The transform of the block is one fixed curve, and an FFT of the block padded to P points reads it at P places. Nothing about the block changed, so the lobe's width in cycles a sample, set by the number of real samples, did not either.</p>
        <p>Here two tones sit ${PAD_GAP} cycles a sample apart. At 32 samples that is ${nf(PAD_GAP * 32, 2)} of a bin, well inside any lobe, so they are one lump whatever the padding. They separate when the gap reaches the resolving distance: ${nf(f.sepRect, 2)} bins for the rectangle, which takes ${f.minRect} samples, and ${nf(f.sepHann, 2)} for Hann, which takes ${f.minHann}. To tell tones (in phase) Δf apart, with Δf in cycles a sample, you must watch for about 1.55 / Δf samples with a rectangle and 2.45 / Δf with Hann. With Δf in hertz it is 1.55 / Δf seconds and 2.45 / Δf, whatever the sample rate.</p>
        <p>Padding is still worth doing, for three reasons: a peak read between bins is closer to its true height, an FFT wants a power of two, and the picture is easier on the eye. It must not be read as precision.</p>
        <div class="try">Take Hann at 32 samples and raise the padding from ×1 to ×16: the curve smooths and stays one lump. Then raise the samples until two peaks appear, and note the number. Do it again with the rectangle.</div>`;
      },
      widget: padWidget,
      challenge: {
        kind: 'quiz', question: `64 samples at 8 kHz, a Hann window, zero padded to 4 096 points. Roughly how far apart must two tones be to separate?`,
        options: [`${n0(resolvingSep(64, 'hann') * 8000 / 64)} Hz: ${nf(resolvingSep(64, 'hann'), 2)} bins of 125 Hz`, '2 Hz: the padded bin width', '125 Hz: one bin of the 64-sample block', '8 000 Hz / 4 096 times 4'],
        answer: 0,
        explain: 'The bin that matters is the unpadded one, 8 000 / 64 = 125 Hz, and Hann needs about 2.45 of them.',
        why: ['', 'The padded bins are 1.95 Hz apart, but each tone is still a lobe of the same width.', 'One bin is below Hann\'s main lobe, which is 4 bins wide.', 'That mixes the padded spacing with a lobe count: the lobe is set by the unpadded block.'],
      },
    },
    {
      title: 'Time and frequency at once',
      get body() {
        return `
        <p>A spectrum of the whole signal says what is in it and not when. A <strong>spectrogram</strong> cuts the signal into frames, windows each, takes the spectrum of each and stacks them: time across, frequency up, level as colour. The frames overlap, because a window is small at its edges and an event there would be under-weighted. Level is dB against a tone of amplitude 1, from −70 dB (dark) to 0 dB (pale); each frame is drawn at its middle, so the first and last half-frame, which no whole frame is centred on, stay blank. This one is a rising chirp, a steady tone and two short bursts.</p>
        <p>One choice, the frame length N, sets both details. In frequency, Hann's main lobe is 4 bins of 8 000 / N Hz: ${n0(4 * 8000 / 32)} Hz wide at 32 samples and ${nf(4 * 8000 / 512, 1)} Hz at 512. In time a frame is N / 8 000 s long: 4 ms and 64 ms. The two are tied by the product of the length and the width, and no choice makes both small. A signal that changes during a frame is smeared: the chirp sweeps ${nf(0.37 * 32 * 32 / 2048, 1)} bin within one 32-sample frame and ${nf(0.37 * 512 * 512 / 2048, 0)} bins within one of 512, so at 32 it does not move during a frame and is still a broad diagonal band, wide because the lobe is 1 kHz, while at 512 each frame shows it as a band 47 bins tall and the line becomes a staircase. The steady tone does the opposite: a sharp line at 512, a thick band at 32.</p>
        <p>Overlap costs. At a hop of N / 2 every sample away from the ends is in two frames, so the signal costs about twice the transforms; at 7/8 overlap, about eight times. The chip counts a little less (1.75 and 6.3 at 512 samples) because the ends are in fewer frames. With Hann at 50 % the frames add back to a constant, which is why that pairing is the usual one. Sound: the clip plays the signal from the model.</p>
        <div class="try">Go from a frame of 32 samples to 512 and watch the steady tone sharpen while the chirp turns into a staircase. Then pick the frame that shows both the bursts and the tone least badly.</div>`;
      },
      widget: spectrogramWidget,
      challenge: {
        kind: 'quiz', question: 'You shorten the frame from 512 to 64 samples to see when a burst starts. What do you give up?',
        options: ['Frequency detail: the lobe goes from 62.5 Hz to 500 Hz wide', 'Nothing: shorter frames are strictly faster', 'Time detail: bursts get blurrier', 'Dynamic range: sidelobes rise'],
        answer: 0,
        explain: 'The lobe is 4 bins of fs / N, eight times wider at 64 than at 512. The window shape, and so the sidelobes, is the same.',
        why: ['', 'It is faster, but not free: the lobe is eight times wider.', 'A shorter frame places events in time more tightly, not less.', 'The sidelobe level is the window\'s, and does not depend on its length.'],
      },
    },
    {
      title: 'Filtering by blocks',
      get body() {
        const f = spectrumFacts();
        return `
        <p><a href="#/c/zplane/0">Chapter ${numOf('zplane')}</a> priced a long FIR at one multiplication a tap, for every output sample. Convolution in time is multiplication in frequency, so the filter can run through an FFT, a product and an inverse FFT. The signal never ends, though, so it goes in blocks, and a block of N samples through M taps has a snag: the product gives a <em>circular</em> convolution (the one <a href="#/c/carriers/0">chapter ${numOf('carriers')}</a> used to undo a channel), which wraps the tail of the response round to the front. The last N − M + 1 outputs of such a block are right and the first M − 1 are wrong.</p>
        <p><strong>Overlap-save</strong> keeps the right ones. Each block repeats the last M − 1 inputs of the block before it, so the wrong outputs fall on samples already finished, and are thrown away. A block yields L = N − M + 1 new samples. The widget compares with the direct form and the difference is a rounding error, under 10⁻⁹: the method is exact, and the chip beside it shows what the first M − 1 samples of a block would have been without the discard.</p>
        <p>Cost, counted per output sample with 4 real multiplications for each of the FFT's complex ones and no savings from real input: the direct form M; blocks 4 (2 · (N/2) log₂ N + N) / L. At 33 taps the best block of ${bestBlock(33)} costs ${nf(olsMults(33, bestBlock(33)))}, more than 33. Blocks win from ${f.cross} taps, and the more taps the larger the win: at 60 taps ${nf(olsMults(60, bestBlock(60)))}.</p>
        <p>In gates the picture changes, because hardware multipliers are cheap to repeat. Counted from the designs, a streaming 256-point FFT is ${n0(f.fft256)} NANDs, and two of them back to back make ${n0(2 * f.fft256)} before the complex multiplier. A filter of 128 taps with a block of 256 yields 129 samples per block, and a streaming FFT takes a clock for each of its 256 points, so about half a sample a clock. The direct form with 128 16 × 16 multipliers in parallel is ${n0(128 * f.mul)} NANDs and one sample per clock. These are sums of parts: nothing here builds the two together and the buffer that overlaps blocks is not counted. Counted that way, with a complex multiplier of four 16 × 16 ones (${n0(2 * f.fft256 + 4 * f.mul)} NANDs in all), the blocks are the smaller circuit here, and the direct form is about twice as fast: blocks win on multiplications and on area, the parallel direct form on throughput.</p>
        <div class="try">At 33 taps try every block size: the direct form is always cheaper. Raise the taps to 55 with a block of 256: blocks win. Read the second error chip: the first M − 1 samples are wrong by a lot and the rest are exact.</div>`;
      },
      widget: olsWidget,
      challenge: {
        kind: 'quiz', question: '128 taps and a block of 512. How many new output samples does each block give, and how many outputs are thrown away?',
        options: ['385 new, 127 thrown away', '512 new, none thrown away', '384 new, 128 thrown away', '129 new, 383 thrown away'],
        answer: 0,
        explain: 'L = N − M + 1 = 385. The first M − 1 = 127 outputs of each block are circular wrap-around.',
        why: ['', 'A block of 512 outputs 512, and 127 of them are wrong.', 'The discard is M − 1, not M.', 'That is the case of 128 taps in a block of 256.'],
      },
    },
    {
      title: 'One bin, cheaply: Goertzel',
      get body() {
        const f = spectrumFacts();
        return `
        <p>Sometimes the spectrum is not the question. A keypad tone is one of eight frequencies, and the FFT's 129 bins are mostly thrown away. <strong>Goertzel</strong> computes one bin. Run the recurrence s[n] = x[n] + c s[n−1] − s[n−2], with c = 2 cos(2πf), over the block. After N samples the last two values give the power at f: s₁² + s₂² − c s₁ s₂. That is one multiplication a sample, and at the end three if it is factored as s₁² + s₂ (s₂ − c s₁), four as written, and exactly the DFT's value at that frequency. The widget prints the ratio against the direct sum, which is 1 to nine places.</p>
        <p>On the plane of <a href="#/c/zplane/4">chapter ${numOf('zplane')}</a> it is a pole pair at radius 1 on the frequency: a resonator that never decays. It rings up to a matching tone linearly, and stays small for others, which is why the top plot grows for a tone on the setting and not for one away from it. The frequency is not tied to a bin: c takes any value, so Goertzel can sit between an FFT's bins. Off a bin centre it leaks, as every transform does, so the block length is worth choosing. For the eight keypad tones at 8 kHz and N up to 256, the block of ${f.best.N} puts the worst tone ${nf(f.best.worst, 2)} bin off a centre; at 192 it is more than 0.4.</p>
        <p>Against the FFT, K bins cost K (N + 3) multiplications, and an FFT of N points costs about 2 N log₂ N at 4 real multiplications to a butterfly. Leaving out the 3, which moves the answer by under 5 %, they are equal at K = 2 log₂ N: ${nf(binsBreakEven(256), 0)} bins for 256 samples, ${nf(binsBreakEven(64), 0)} for 64. A decoder for 8 tones is on the Goertzel side.</p>
        <div class="try">Set the tone to 1 000 Hz and Goertzel to 1 000 Hz: the state climbs steadily. Move Goertzel to 1 300 Hz: it stays small. Then set the block to 192 and back to 205 and watch the dots, an FFT's bins: at 192 a 1 000 Hz tone sits on a bin, so every other dot falls on a null of the curve, and at 205 they are spread along it.</div>`;
      },
      widget: goertzelWidget,
      more: {
        derive: `<p>Run the recursion with the input x and take the transform of its last two states: y[N] = s[N] − e^(−jω) s[N−1] is the DFT sum up to a phase factor of unit size, and s[N] = c s[N−1] − s[N−2] when the input has ended. Squaring the size gives s₁² + s₂² − c s₁ s₂. The coefficient c = ${nf(goertzelCoef(697 / 8000), 4)} for 697 Hz at 8 kHz.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A decoder needs 8 frequencies from each 256-sample block. How should it compute them?',
        options: ['Eight Goertzels: 8 is under the break-even of 16 bins', 'An FFT: Goertzel can only find frequencies that fall on a bin', 'An FFT: it is always cheaper', 'Eight DFT sums: they need no recurrence'],
        answer: 0,
        explain: 'The FFT gets every bin for about 2 N log₂ N multiplications, and the Goertzels get eight for 8 N. They meet at 16.',
        why: ['', 'c = 2 cos(2πf) takes any f. Only the leakage depends on whether f is on a bin.', 'It computes 129 bins to keep 8.', 'Each DFT sum is N complex products. A Goertzel is N real ones.'],
      },
    },
    {
      title: 'A keypad in gates',
      get body() {
        const f = spectrumFacts();
        return `
        <p>A keypad key sounds two tones at once, one from a group of four rows and one from four columns. The frequencies are 697, 770, 852 and 941 Hz for the rows and 1 209, 1 336, 1 477 and 1 633 Hz for the columns, the standard push-button (DTMF) frequencies; ITU-T Q.23 is the recommendation usually cited for them. A decoder finds the strongest tone in each group.</p>
        <p>The cell is <span data-show="mul">one multiplier</span> by the coefficient, <span data-show="rnd">a rounder</span> that brings the product back to the 16-bit word (the coefficient is Q2.14, so the product carries 14 bits after the point), <span data-show="a1 a2">two adders</span> making s[n] = x + c s₁ − s₂, <span data-show="r1 r2">two registers</span> and <span data-show="m1 m2">a clear</span>. The coefficient is an input, so the same ${n0(f.cell)} NANDs serve all eight tones: ${n0(f.cellMul)} of those are the 16 × 16 multiplier. Opened, it is the recurrence drawn as gates.</p>
        <p>The state word comes from <a href="#/c/fixed/6">chapter ${numOf('fixed')}</a>'s rule, guard bits by the worst case. The state is the input times the filter's impulse response, so its largest value is 128.5 times the sum of the response's sizes over the block: 128 for an input of −128, the most negative 8-bit sample, and half a step for the rounding at each sample. The worst tone sums to ${nf(f.gain, 1)}, so ${nf(128.5 * f.gain, 0)} must fit: ${f.bits} bits, and the 16-bit word holds it with ${nf(100 * (1 - (128.5 * f.gain) / 32768), 1)} % to spare. A 15-bit word overflows on the worst input. Eight bits of input became sixteen of state. A partial sum inside the update, such as x + c s₁, may wrap past the word and that is harmless, because the final s[n] fits and the arithmetic is modulo 2ʷ (<a href="#/c/fixed/5">the argument for wrapping</a>). The model and the gates agree at every clock for the extremes.</p>
        <p>One cell does the eight tones one after another. A key's block of ${DTMF_N} samples is replayed eight times, each with a clear and a coefficient: ${n0(f.perKey)} clocks per key. At 8 kHz the block lasts ${nf(DTMF_N / 8, 1)} ms, so the clock must run at least ${nf(f.perKey / (DTMF_N / 8000) / 1000, 1)} kHz, and the block must be stored. Eight cells would do it at the sample rate for ${n0(8 * f.cell)} NANDs. A 256-point streaming FFT, counted in the step on filtering by blocks, is ${n0(f.fft256)}.</p>
        <p>The panel runs the real gates through all eight tones and compares the state words with the model at every clock. The final power, three or four multiplications, is done by the panel from the gates' words, not in gates, and its dB are against a tone of amplitude 1 landing on the setting. The decision is our own rule, not a standard's: the strongest tone in each group must be 4 times the runner-up in power and above the power of an amplitude-10 tone. With noise ±60 every key reads right; at ±200, clipped to a byte, the keys ${f.mis200.join(' ')} do not read back.</p>
        <div class="try">Press 5, then each of the other keys, and read the bars. Then take the noise to ±200 and find a key that misreads. Play a key and listen for its two tones.</div>`;
      },
      scene: dtmfScene,
      lit: '',
      challenge: {
        kind: 'quiz', question: 'The input is 8 bits. Why does the Goertzel state need 16?',
        options: ['The resonator adds up the block: its worst case is about 250 times an input, 8 more bits', 'Two registers make twice the width', 'The coefficient is 16 bits wide', 'To avoid rounding the product'],
        answer: 0,
        explain: `A resonator on a matching tone keeps adding. The sum of the impulse response is ${nf(spectrumFacts().gain, 0)} at the worst tone, and log₂ of that is about 8.`,
        why: ['', 'Each register holds one state, and the width depends on how big a state gets.', 'The coefficient\'s width sets its resolution, not the state\'s range.', 'The product is rounded once whatever the width.'],
      },
    },
  ],
};
