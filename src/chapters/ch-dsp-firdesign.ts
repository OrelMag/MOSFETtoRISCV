// FIR design: how few taps meet a mask. Linear phase, the window method, Parks–McClellan, taps as words, folding and the transposed form, constants in
// signed digits, and one multiplier shared over the taps in gates. The design tools are dsp/firdesign.ts (held to scipy by tests/dsp-firdesign.test.ts); the gates are
// lib/firmac.ts; every number in the text is computed by `figures()` below, and tests/dsp-firdesign-chapter.test.ts pins each one against the widgets' sliders.

import { binaryDigits, csdAdders, csdOf, deltaPass, deltaStop, dB, fewestFrac, foldedMults, gainOf, guardFor, guardForN, kaiserLengthEstimate, linearDelay, MASK, maskReport, remezLowpass, sceneMac, SCENE_MASK, tapValues, tapWords } from '../dsp/firdesign';
import { firCosts, firMac } from '../lib/firmac';
import { stats } from '../sim/stats';
import { windowDesign } from '../widgets/dspfir';
import { chapterDesign, csdApi, csdScene, csdTap, csdTotals, designRows, designsWidget, macApi, macOf, macScene, MAC_TONES, pmTaps, remezWidget, structureWidget, symmetryWidget, windowTable, windowWidget, wordsWidget } from '../widgets/dspfir';
import { DSP_LEVEL } from './dspladder';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (v: number) => groupNum(Math.round(v));
const nf = (v: number, d = 2) => v.toFixed(d).replace('-', '−');
const dbs = (v: number) => `${nf(v, 1)} dB`;

/** Every number the text quotes, computed once when a step first reads it (nothing at import: the designs and the gate counts take a moment). */
let memo: ReturnType<typeof compute> | null = null;
export const figures = () => (memo ??= compute());
/** Where the Kaiser design meets the mask and where it does not, from its first meeting length up: runs of lengths. */
function kaiserRuns(beta: number): { from: number; to: number; ok: boolean }[] {
  const runs: { from: number; to: number; ok: boolean }[] = [];
  const first = windowTable().find((r) => r.kind === 'kaiser')!.any!;
  for (let n = first; n <= first + 10; n++) {
    const ok = maskReport(windowDesign('kaiser', n, beta)).ok, last = runs[runs.length - 1];
    if (last && last.ok === ok) last.to = n; else runs.push({ from: n, to: n, ok });
  }
  return runs;
}
function compute() {
  const ch = chapterDesign(), dp = deltaPass(MASK), ds = deltaStop(MASK), width = MASK.stop - MASK.pass;
  const pm = (n: number) => maskReport(pmTaps(n));
  const win = windowTable(), at = (k: string) => win.find((r) => r.kind === k)!.n, any = (k: string) => win.find((r) => r.kind === k)!.any;
  const stop = (k: 'hamming' | 'rectangular', n: number) => maskReport(windowDesign(k, n, 0)).stopDb;
  const ham = [61, 101, 201, 301].map((n) => stop('hamming', n)), rect = [101, 1001].map((n) => stop('rectangular', n));
  const hw = macOf(ch.hwTaps), hwq = maskReport(tapValues(hw.taps, hw.frac)), c114 = macOf(ch.taps), c114q = maskReport(tapValues(c114.taps, c114.frac));
  const q15 = maskReport(tapValues(tapWords(ch.taps, 15, 40), 15));
  const ff = fewestFrac(ch.taps)!, big = Math.max(...ch.taps.map(Math.abs));
  const costs = firCosts(hw), byName = (p: string) => costs.find((c) => c.name.startsWith(p))!;
  const rows = designRows(), scene = sceneMac(), sceneNands = stats(firMac(scene.cfg)).nands, sceneCosts = firCosts(scene.cfg);
  const gains = Object.fromEntries(MAC_TONES.map(([, f]) => [f, gainOf(tapValues(scene.cfg.taps, scene.cfg.frac), f)])) as Record<number, number>;
  return {
    dp, ds, width, ch, pm113: pm(113), pm114: pm(114), pm115: pm(115), kaiser: ch.kaiser, kaiserRep: maskReport(ch.kaiser.taps),
    est: kaiserLengthEstimate(dp, ds, width), win, hann: at('hann'), blackman: at('blackman'), kaiserOdd: at('kaiser'), hamming: at('hamming'), hannAny: any('hann'), blackmanAny: any('blackman'), kaiserAny: any('kaiser')!, hammingAny: any('hamming'), ham, rect, runs: kaiserRuns(ch.kaiser.beta), tone2: dB(gainOf(ch.taps, 0.2)),
    hw, hwq, c114, c114q, q15, ff, big, spare: Math.floor(Math.log2(1 / big)), sumAbs: hw.taps.reduce((a, c) => a + Math.abs(c), 0) / 2 ** hw.frac,
    guardSum: guardFor(hw.taps, 16), guardN: guardForN(ch.hwN),
    costs, direct: byName('Direct'), folded: byName('Folded:'), foldedCsd: byName('Folded, taps'), transposed: byName('Transposed'), shared: byName('One multiplier'),
    csd: csdTotals(), scene, sceneNands, sceneCosts, gains, accBits: 2 * scene.cfg.w + scene.cfg.guard,
    iters: remezLowpass(ch.n).iterations,
    rows, tDirect: rows.find((r) => r.design !== 'Kaiser window' && r.structure.startsWith('Direct'))!, tFolded: rows.find((r) => r.design !== 'Kaiser window' && r.structure.startsWith('Folded:'))!,
    tCsd: rows.find((r) => r.design !== 'Kaiser window' && r.structure.startsWith('Folded, taps'))!, tShared: rows.find((r) => r.design !== 'Kaiser window' && r.cycles > 1)!,
    pmKaiserDirect: 1 - rows[0].nands / rows.find((r) => r.design === 'Kaiser window' && r.structure.startsWith('Direct'))!.nands,
    pmKaiserShared: 1 - rows.find((r) => r.design !== 'Kaiser window' && r.cycles > 1)!.nands / rows.find((r) => r.design === 'Kaiser window' && r.cycles > 1)!.nands,
  };
}

export const chFirDesign: Chapter = {
  id: 'firdesign', num: numOf('firdesign'), title: 'FIR design', level: DSP_LEVEL,
  blurb: 'How few taps meet a mask: linear phase, windows, Parks–McClellan, taps as words, folding, constants in signed digits, and one multiplier shared over the taps in gates.',
  goals: [
    'read a filter specification as a mask, in cycles a sample, and say what symmetric taps cost in delay',
    'design with a window and with Parks–McClellan, and say why a window needs more taps for the same mask',
    'round taps to words and size the accumulator\'s guard bits from the taps themselves',
    'fold, transpose and time-share a filter, and price each from its gates',
    'replace a fixed tap by shifts and adders, and say when that pays',
  ],
  builds: ['signals', 'zplane', 'fixed', 'spectrum', 'muldiv'],
  get recap() {
    const F = figures();
    return {
      keep: [
        `A mask is a passband edge, a stopband edge and two ripples. Frequency here is cycles a sample, so 0.20 of Nyquist is ${nf(MASK.pass, 2)} and 0.25 of it is ${nf(MASK.stop, 3)}. The mask of this chapter, 0.1 dB of ripple and 60 dB of rejection, allows 1 ± ${nf(F.dp, 5)} and ${nf(F.ds, 3)}.`,
        'Symmetric taps give linear phase: (N − 1) / 2 samples of delay at every frequency. The amplitude is then a cosine polynomial with about N / 2 free numbers, which is also why folding halves the multiplications.',
        `A window designs both bands to the same ripple, so it spends passband accuracy the mask never asked for. Kaiser's needs ${F.kaiserAny} (${F.kaiserOdd} if the length must be odd); Parks–McClellan, which weights the bands as the mask does, needs ${F.ch.n}.`,
        `Taps are integers. Rounding them adds ripple of its own: the ${F.ch.n}-tap design misses the mask by ${nf(F.c114q.stopDb + 60, 2)} dB in 16-bit words, and ${F.ch.hwN} taps meet it. An accumulator needs the guard bits Σ|tap| asks for (${F.guardSum} here), not the ${F.guardN} that log₂ N would give.`,
        `The same filter can be built folded (${foldedMults(F.ch.hwN)} multipliers instead of ${F.ch.hwN}), transposed (no long adder chain, wide registers), with taps as shifts and adders (no multiplier at all), or on one multiplier in ${F.ch.hwN} clocks a sample: ${n0(F.shared.nands)} NANDs against ${n0(F.direct.nands)}.`,
        `Choose by the samples a second you need. A parallel build makes a sample a clock, at the clock its longest path allows (${nf(F.tDirect.maxMhz, 0)} MHz for the direct form, a sum of parts); one multiplier takes N clocks and runs at ${nf(F.tShared.maxMhz, 0)} MHz, so ${nf(F.tShared.maxMhz / F.ch.hwN, 1)} million samples a second at most.`,
      ],
      check: [
        {
          question: 'A symmetric FIR of 64 taps runs at 8 kHz. How long is its delay at 100 Hz, and at 3 kHz?',
          options: [`${nf((linearDelay(64) / 8000) * 1000, 1)} ms at both`, `${nf((64 / 8000) * 1000, 1)} ms at both`, `${nf((linearDelay(64) / 8000) * 1000, 1)} ms at 100 Hz and less at 3 kHz`, 'It depends on the passband ripple'],
          answer: 0,
          explain: 'Linear phase means one delay for all frequencies: (64 − 1) / 2 = 31.5 samples, and at 8 kHz that is 31.5 / 8000 = 3.9 ms.',
          why: ['', 'That is the whole length, 64 samples; the delay is half of it.', 'Not for a symmetric filter; one delay for every frequency is what linear phase means.', 'Ripple is the gain\'s business; the delay comes from the length alone.'],
        },
        {
          question: 'Why does a Kaiser-window design need more taps than Parks–McClellan for a mask with 0.1 dB of passband ripple and 60 dB of stopband?',
          options: ['The window gives both bands one ripple, so it makes the passband far better than asked', 'Windows cannot make a sharp transition at all', 'Parks–McClellan uses complex taps', 'Kaiser windows are not symmetric'],
          answer: 0,
          explain: 'The mask lets the passband vary by 0.0058 and the stopband by 0.001. A window design ends up near 0.001 in both. Parks–McClellan weights the two bands as the mask does, and spends the slack on a narrower transition.',
          why: ['', 'It can; the transition width falls as 1 / N for any window.', 'The taps are real and symmetric.', 'They are symmetric, which is why they have linear phase.'],
        },
        {
          question: 'A 115-tap filter must produce 48 000 samples a second on one multiplier. What is the slowest clock that works?',
          options: [`${nf((F.ch.hwN * 48000) / 1e6, 2)} MHz`, '48 kHz', `${nf((F.ch.hwN * 48000) / 50 / 1000, 0)} kHz`, `${nf((F.ch.hwN * 24000) / 1e6, 2)} MHz`],
          answer: 0,
          explain: `One multiplication a clock and ${F.ch.hwN} of them a sample: ${F.ch.hwN} × 48 000 = ${nf((F.ch.hwN * 48000) / 1e6, 2)} million a second, well under the ${nf(F.tShared.maxMhz, 0)} MHz the gates can run at. Folding would halve it, at the price of a pre-adder and a second read of the ring, and the gates in this chapter do not fold.`,
          why: ['', 'That is one multiplication a sample.', 'That is about two clocks a sample, far too few for this many taps.', 'That assumes folding, which this design does not do.'],
        },
      ],
    };
  },
  steps: [
    {
      title: 'A mask, and mirror-image taps',
      get body() {
        const F = figures();
        return `
        <p>A filter is specified by a <strong>mask</strong>, not by a formula: a passband where the gain must stay within a ripple of 1, a stopband where it must stay under a ceiling, and a transition between them where nothing is promised. Ours: pass to 0.20 of Nyquist, stop from 0.25 of it, 0.1 dB of ripple, 60 dB of rejection. This site counts frequency in cycles a sample, so Nyquist is 0.5 and the edges are ${nf(MASK.pass, 2)} and ${nf(MASK.stop, 3)}: a transition ${nf(F.width, 3)} wide, ${nf(100 * F.width / 0.5, 0)} % of Nyquist. Ripple of 0.1 dB peak to peak is a gain within 1 ± ${nf(F.dp, 5)}, and it is centred on 1: a passband that wandered between 0.99 and 0.9914 would have a smaller ripple and fail this mask, and every design below is held to ± ${nf(F.dp, 5)} around 1. 60 dB is a gain under ${nf(F.ds, 3)}.</p>
        <p>Every tap costs a multiplication for every output sample, so the question is how few taps meet the mask. Part of the answer is free. A filter whose taps are mirror images, h[k] = h[N − 1 − k], has <strong>linear phase</strong>: every frequency is delayed by the same (N − 1) / 2 samples, and a pulse comes out the shape it went in, only later. A ${F.ch.n}-tap filter delays by ${nf(linearDelay(F.ch.n), 1)} samples. <a href="#/c/zplane/6">The z-plane chapter</a> showed why: each zero comes with its mirror image across the circle.</p>
        <p>The mirror image also halves the unknowns. The gain of a symmetric filter is a polynomial in cos 2πf with only ⌈N / 2⌉ coefficients, so designing ${F.ch.n} taps is choosing ${Math.ceil(F.ch.n / 2)} numbers. Look at the zeros below: the ones on the circle are the stopband, where the gain crosses zero between ripples, and the others come in sets, r and 1 / r on the real axis or four together at r e^±jθ and e^±jθ / r, which shape the passband and the transition. An even length has a delay of a whole number and a half, and a zero at z = −1 always, so it can never pass half the sample rate.</p>
        <div class="try">Slide the taps from 7 to 31 and count the zeros on the circle: each one is a place the stopband touches zero. Then step to an even length and find the zero at −1.</div>`;
      },
      widget: symmetryWidget,
      challenge: {
        kind: 'quiz', question: 'The filter that just meets the mask has 114 taps. What is its delay, at every frequency?',
        options: [`${nf(linearDelay(114), 1)} samples`, '57 samples', '114 samples', '113 samples'],
        answer: 0,
        explain: 'Half the length less half a sample: 113 / 2 = 56.5. An even length puts the centre between two samples, so the delay is not a whole number.',
        why: ['', 'That is half the length, which would be the delay of 115 taps (a whole number, 57).', 'The signal does not wait for the whole filter, only for its middle.', 'That is the number of delays, not the delay: the centre is half of that.'],
      },
    },
    {
      title: 'The window method',
      get body() {
        const F = figures();
        return `
        <p>The ideal low-pass has taps sin(2π fc k) / (π k), forever. Cut them to N taps and you have multiplied by a rectangle, and the response is the ideal one smeared by the rectangle's spectrum: a transition that narrows in proportion to 1 / N, and a stopband peak that falls only slowly with N: ${dbs(F.rect[0])} at 101 taps, ${dbs(F.rect[1])} at 1 001. Taper the ends instead, with one of the windows of <a href="#/c/spectrum/1">chapter ${numOf('spectrum')}</a>, and the ripples fall, at the price of a wider transition: the same trade a window made there between sidelobe height and main-lobe width. That is the <strong>window method</strong> (the windowed sinc of <a href="#/c/signals/3">chapter ${numOf('signals')}</a>, its trade now named): the window decides how far the stopband falls, and N decides how narrow the transition is.</p>
        <p>One consequence matters here. The window's sidelobes set the passband ripple and the stopband ceiling together, so both bands come out at the same size. This mask allows ${nf(F.dp, 4)} in the passband and ${nf(F.ds, 3)} in the stopband, and a window that meets the second delivers about ${nf(F.kaiserRep.passDev, 4)} in the first: ${nf(F.dp / F.kaiserRep.passDev, 1)} times better than anyone asked for.</p>
        <p>Each fixed window has sidelobes of its own height, and the mask's stopband starts only ${nf(F.width / 2, 4)} beyond the middle of the transition, so the nearest sidelobes sit inside it until N is long. A Hamming window gives ${F.ham.map((v) => dbs(v)).join(', ')} at 61, 101, 201 and 301 taps: it plateaus near −58 dB for a long stretch, and first reaches −60 dB at ${F.hamming} taps if the length is odd (${F.hammingAny} with either parity). Hann needs ${F.hann} taps if the length is odd (${F.hannAny} with either parity) and Blackman ${F.blackman} (${F.blackmanAny}). The rectangle is at ${dbs(F.rect[1])} even at 1 001 taps, and falls about 6 dB for each doubling. </p>
        <p>Kaiser's window has a knob, β, that trades sidelobe height against transition width directly. Kaiser's design rule for his window gives β = ${nf(F.kaiser.beta, 3)} and ${F.kaiser.numtaps} taps for this mask, and the first odd length that meets it is ${F.kaiserOdd}, the first of either parity ${F.kaiserAny}.</p>
        <div class="try">Pick Hamming and slide the taps up from 61 to 489: the transition narrows and the stopband peak falls and then sits on a plateau, before it crosses −60 dB. Switch to Kaiser, leave β where it is, and slide the taps down from 201 until the verdict first goes red: it can go green again below that, so press the button for the table to find the first length that meets the mask.</div>`;
      },
      widget: windowWidget,
      more: {
        get derive() {
          const F = figures();
          return `<p>Every window here is checked against scipy: its <code>kaiserord</code> and <code>firwin</code> agree with our code to 10⁻¹¹. Meeting the mask is not quite monotone in length, even for one window: Kaiser's ${F.runs.map((r) => `${r.ok ? 'meets it' : 'misses it'} from ${r.from}${r.to > r.from ? ` to ${r.to}` : ''}`).join(', then ')}, because each extra tap moves the sidelobes as well as narrowing the transition.</p>`;
        },
      },
      challenge: {
        kind: 'quiz', question: 'A window-method filter is made twice as long with the same window. What changes?',
        options: ['The transition band halves; the sidelobes keep their height relative to it', 'The stopband ripple halves and the transition stays', 'The passband ripple doubles', 'Only the delay changes'],
        answer: 0,
        explain: 'The window decides how high its sidelobes are, and the length decides how wide the transition is: twice the taps, half the width. The delay doubles as well.',
        why: ['', 'The ripple is the window\'s; a longer filter with the same window does not lower it relative to the transition.', 'Passband and stopband ripple stay together.', 'The response sharpens, and that is the reason to pay for the taps.'],
      },
    },
    {
      title: 'Parks–McClellan',
      get body() {
        const F = figures();
        return `
        <p>Instead of a recipe, make it an optimisation: choose the taps that minimise the largest weighted error over the bands, with weights 1 / δp and 1 / δs. A result of 1 or less means both bands fit the mask. The optimum has a striking shape. Its error touches the same size at every one of at least ⌈N / 2⌉ + 1 frequencies, with alternating signs: <strong>equiripple</strong>. The alternation theorem says that is both necessary and sufficient, and the <strong>Remez exchange</strong> finds it: guess that many frequencies, solve for the cosine polynomial that alternates ±δ exactly there, look at where its error really peaks, move the guesses to the peaks, repeat. Here it takes ${F.iters} passes.</p>
        <p>The mask is met by <strong>${F.ch.n} taps</strong>. At ${F.ch.n - 1} it is not: the stopband peaks at ${dbs(F.pm113.stopDb)} and the passband gain is off 1 by up to ${nf(F.pm113.passDev, 5)} against the ${nf(F.dp, 5)} allowed, both a little over, and no weighting makes both fit, because the error is already the best that any taps can do. The fewest odd length is ${F.ch.fewestOddPm}. Kaiser's window needs ${F.kaiserAny} for the same mask with either parity (${F.kaiserOdd} if odd): ${F.kaiserAny - F.ch.n} taps more than ${F.ch.n}, ${nf(100 * (F.kaiserAny / F.ch.n - 1), 0)} % more multiplications on every sample. Kaiser also gave an estimate for equiripple filters like this one (not the window rule of the step before): N ≈ (−20 log₁₀ √(δpδs) − 13) / (14.6 Δf) + 1, which says ${F.est}: a fair estimate, ${F.ch.n - F.est} short.</p>
        <p>This is our own exchange, written to scipy's grid so that the two compare tap for tap: the five test cases agree with <code>scipy.signal.remez</code> to better than 10⁻⁹ of the largest tap, and every design is checked against its mask on the 8 192-point grid that <code>freqz</code> uses. It is the algorithm of Parks and McClellan (1972), and ours is checked against scipy's and, for every result, against its mask.</p>
        <div class="try">Press Find the fewest taps and read ${F.ch.n}, then drop to ${F.ch.n - 1} and see which bands miss. At ${F.ch.n - 1} try the stopband weight: whichever band you favour, the other fails. Play the clip: at ${F.ch.n} taps the second tone, at 0.2 cycles a sample, comes out ${dbs(F.tone2)} down, and the level is on screen beside the button. Listen for its absence.</div>`;
      },
      widget: remezWidget,
      challenge: {
        kind: 'quiz', question: `With the mask's own weights, ${figures().ch.n - 1} taps are tried. What does the result show?`,
        options: ['Both bands miss the mask by a few per cent', 'The passband meets it and the stopband misses', 'The stopband meets it and the passband misses', 'The design meets the mask'],
        answer: 0,
        explain: `The weighted error at ${figures().ch.n - 1} taps is above 1, so neither band fits: the passband gain is off 1 by up to ${nf(figures().pm113.passDev, 5)} against ${nf(figures().dp, 5)}, and the stopband peaks at ${dbs(figures().pm113.stopDb)} against −60.`,
        why: ['', 'The two bands are traded through the weights, and at this length even the best trade misses both.', 'Same: an error above 1 is above 1 in both bands, at the mask\'s weights.', 'It would have to for 114 taps, not one fewer.'],
      },
    },
    {
      title: 'Taps are words',
      get body() {
        const F = figures();
        return `
        <p>A real filter holds its taps as integers, and the multiplier in the gates is 16 × 16. The largest tap of the ${F.ch.n}-tap design is ${nf(F.big, 4)}, under a quarter, so a 16-bit word can carry ${F.spare} bits more fraction than Q1.15: ${F.hw.frac} bits after the point, with the largest tap filling most of the word. Rounding to Q1.15 instead throws that headroom away, and the stopband ceiling rises to ${dbs(F.q15.stopDb)}.</p>
        <p>Rounding is another source of ripple. Each tap is off by up to half a step, the errors add as if random, and the stopband, which started exactly at the mask's edge, is the first to feel it: the ${F.ch.n}-tap design with 17 bits after the point peaks at ${dbs(F.c114q.stopDb)}, ${nf(F.c114q.stopDb + 60, 2)} dB over. Two ways out. Add a bit: ${F.ff.frac} bits after the point meets the mask, in a word of ${F.ff.bits} bits. Or add a tap: <strong>${F.ch.hwN} taps</strong> meet it in 16-bit words, at ${dbs(F.hwq.stopDb)}. A tap costs a multiplication; a bit costs a wider multiplier. The gates below use the ${F.ch.hwN}.</p>
        <p>The accumulator needs headroom too, and here the taps themselves decide. The output is at most Σ|tap| times the largest input: for these taps Σ|tap| = ${nf(F.sumAbs, 3)}, so ${F.guardSum} guard bits above the product guarantee no overflow for <em>any</em> input. The rule of <a href="#/c/fixed/5">the first chapter of this level</a>, log₂ N, would give ${F.guardN}, and it is only right if every tap could be full scale. Guard bits are paid for in every adder and register of the accumulator, so it is worth knowing which number applies. The sum is wide, rounded once, and clamped once at the end.</p>
        <div class="try">Start at 15 bits after the point and read the stopband. Raise it to 17, then 18, and watch the ripple of the rounded taps close on the real ones.</div>`;
      },
      widget: wordsWidget,
      challenge: {
        kind: 'quiz', question: 'The largest tap of the 16-bit design is about 0.22. Why can its words keep 17 bits after the point?',
        options: ['Under 0.25, so two of the sign bits would only repeat', 'The multiplier drops one bit', 'Taps are symmetric, so one bit is free', 'The guard bits add one'],
        answer: 0,
        explain: 'A Q1.15 word reaches ±1. A tap that never exceeds 0.25 uses under a quarter of that range, so the point can slide two places left and every tap keeps two more bits of accuracy; the output comes down by 17 places instead of 15.',
        why: ['', 'The multiplier keeps every bit; rounding is done once, at the end.', 'Symmetry shares multipliers; it does not change a word.', 'Guard bits are above the product, in the accumulator, not in the taps.'],
      },
    },
    {
      title: 'Folding, and the transposed form',
      get body() {
        const F = figures(), n = F.ch.hwN;
        return `
        <p>Mirror-image taps mean the direct form multiplies x[n − k] by h[k] and x[n − (N − 1 − k)] by the same number. <strong>Fold</strong> the filter: add the pair first, then multiply once. ${n} taps need ${foldedMults(n)} multiplications instead of ${n}. The adder in front is one bit wider, so the multiplier is 17 × 17 rather than 16 × 16 (our tree multiplier is square), and counted from the gates the folded filter is ${n0(F.folded.nands)} NANDs against ${n0(F.direct.nands)} for the direct form. It is exact: the output is identical, sample for sample, as the widget checks.</p>
        <p>The <strong>transposed form</strong> reverses every arrow of the direct form. The input reaches all the multipliers at once, and the registers hold partial sums that move toward the output, one adder and one register per tap. Nothing waits behind a long adder chain, so the longest path is one multiplier and one adder, and every product is ready the moment the sample arrives. Its price is in the registers, which hold sums and not samples, so each is as wide as the accumulator. It folds differently: x[n] h[k] is the product that two mirrored taps both need, so computing it once is the saving. Counted that way it is ${n0(F.transposed.nands)} NANDs at ${n} taps, ${F.transposed.nands < F.folded.nands ? 'under' : 'over'} the folded form's ${n0(F.folded.nands)}: ${F.transposed.nands < F.folded.nands ? 'sharing the product is cheaper than adding the pair, even with wide registers' : 'the wide registers cost more than the pre-adders save'}.</p>
        <p>None of these three changes what the filter does. They move cost between multipliers, adders, registers and the longest path, and which one wins depends on the technology. In gates, where a multiplier is the expensive part, folding is the first thing to do to a linear-phase filter.</p>
        <div class="try">Switch to Folded and read the multiplications halve while the output stays identical. Switch to Transposed and read the width of its registers. Slide the taps down to 16 and back up to ${n}, and watch the NANDs; the diagram stays at 6 taps.</div>`;
      },
      widget: structureWidget,
      challenge: {
        kind: 'quiz', question: 'How many multiplications does the folded form of the 115-tap filter need for each output sample?',
        options: [String(foldedMults(115)), '57', '115', '116'],
        answer: 0,
        explain: 'Fifty-seven pairs, and the middle tap has no partner: 57 + 1 = 58. An even length has no middle tap, so 114 taps need 57.',
        why: ['', 'That is the count for 114 taps; an odd length has one tap left over.', 'That is the direct form.', 'Folding cannot need more taps than there are.'],
      },
    },
    {
      title: 'A constant is a few shifts',
      get body() {
        const F = figures(), t = csdOf(csdTap());
        return `
        <p>When the taps never change, a general multiplier is wasted on them. A constant is a sum of powers of two, and a shift is wiring. ${csdTap()} = ${t.map((d, i) => `${i ? (d.neg ? ' − ' : ' + ') : d.neg ? '−' : ''}2<sup>${d.pos}</sup>`).join('')} takes ${t.length} digits (binary has ${binaryDigits(csdTap())} ones), so it takes ${csdAdders(csdTap())} adder${csdAdders(csdTap()) === 1 ? '' : 's'} and no multiplier. Writing it with signed digits, 8 − 1 for 7, cuts the number of non-zero digits: the <strong>canonical signed digit</strong> form never puts two non-zero digits side by side, and has the fewest of any signed form.</p>
        <p>Over the ${F.csd.distinct} different taps of the ${F.ch.hwN}-tap design (the rest are mirrors), binary has ${F.csd.bin} ones and signed digits ${F.csd.csd}, and that needs ${F.csd.adders} adders. Counted from the gates, ${F.csd.distinct} constant multipliers are ${n0(F.csd.nandsCsd)} NANDs against ${n0(F.csd.nandsTree)} for ${F.csd.distinct} general ones (a 16 × 16 tree is ${n0(F.csd.tree)}). The whole folded filter drops from ${n0(F.folded.nands)} to ${n0(F.foldedCsd.nands)}, with no multiplier left in it.</p>
        <p>The price is flexibility: change a tap and you have rebuilt the multiplier. That is the right trade for a fixed channel filter in a radio, and the wrong one for anything that adapts. The scene is the multiplier for one tap of the 16-tap filter drawn in the next step.</p>
        <div class="try">Open the multiplier and find the adders. Press Check, and read that 200 inputs, both extremes among them, all came out as ${csdTap()} times the input.</div>`;
      },
      scene: csdScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Check the multiplier: push 200 inputs through the gates and see them all equal the constant times the input.',
        check: (st) => { const a = csdApi.get(st); return !!a && a.agrees(); },
        hints: ['The panel has a button that pushes the inputs through.', 'Press "Check 200 inputs".'],
        answer: 'The gates form each digit\'s shifted copy by wiring and add them with ripple-carry adders; subtracting uses an inverted copy and a carry in. Two\'s complement addition is modular, so even when an intermediate sum is out of range the final one is exact.',
        solve: (st) => { csdApi.get(st)?.run(); },
      },
    },
    {
      title: 'One multiplier, N clocks',
      get body() {
        const F = figures(), c = F.scene.cfg, N = c.taps.length;
        return `
        <p>If the clock is much faster than the sample rate, build one multiplier and use it N times a sample. A ring of ${N} <span data-show="ring">sample registers</span> turns one place a clock, so that its head shows x[n], x[n − 1], … one tap after another. <span data-show="tapsrom">A ROM</span> gives the tap for each count, together with two flags, first and last. <span data-show="mul">One 16 × 16 signed multiplier</span> multiplies the head by the tap, and <span data-show="accum">a ${F.accBits}-bit accumulator</span> adds each product, starting afresh at the first tap. After the last, <span data-show="rnd">one rounder and one clamp</span> turn the sum into the output word, and <span data-show="yreg">a register</span> holds it for the ${N} clocks until the next.</p>
        <p>The ring has one trick. In the last cycle only the head loads, the new sample; the others hold. The oldest sample has just been used and falls out, and the ring is in order again for the next round, with no write pointer and no address arithmetic. The sample is read at the end of the cycle in which <code>take</code> is high. The accumulator holds ${c.guard} guard bit${c.guard === 1 ? '' : 's'} above the 32-bit product, as Σ|tap| asks, and the clamp, which is <code>clampWord</code> of the first chapter extended to any number of bits, acts once, on the finished sum.</p>
        <p>The drawing is a ${N}-tap equiripple low-pass to a looser mask than the chapter's, because ${N} taps cannot reach 60 dB: pass to ${nf(SCENE_MASK.pass, 2)} with ${nf(F.scene.report.passRippleDb, 2)} dB of ripple, stop from ${nf(SCENE_MASK.stop, 2)} at ${dbs(F.scene.report.stopDb)}. It is ${n0(F.sceneNands)} NANDs, of which the multiplier is ${n0(F.csd.tree)}. The same gates at ${F.ch.hwN} taps would be ${n0(F.shared.nands)} against ${n0(F.direct.nands)} in parallel: ${nf(F.direct.nands / F.shared.nands, 0)} times fewer, for a clock ${F.ch.hwN} times the sample rate. The panel runs the model beside the gates and compares y, the tap number and the accumulator after every clock edge.</p>
        <div class="try">Run the passband tone and read ${nf(F.gains[0.04], 3)}, the gain the taps give at 0.04. Run the stopband tone and read how little gets through, ${nf(F.gains[0.35], 3)}. The panel says how many clocks matched.</div>`;
      },
      scene: macScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the stopband tone through the gates and see it fall to a few per cent, with every clock matching the model.',
        check: (st) => { const a = macApi.get(st); return !!a && a.agrees() && a.lastTone() === 0.35 && a.lastGain() < 0.05; },
        hints: ['The panel has three tones. The stopband one is 0.35 cycles a sample.', 'Press "Stopband: 0.35" and wait for the clocks to run.'],
        answer: `At 0.35 cycles a sample the taps give a gain of ${nf(figures().gains[0.35], 3)}, about ${dbs(dB(figures().gains[0.35]))}. It takes the first frames to fill the ring, then the output settles.`,
        solve: (st) => { macApi.get(st)?.runTone(0.35); },
      },
    },
    {
      title: 'One mask, four ways to build it',
      get body() {
        const F = figures(), n = F.ch.hwN, k = F.kaiser.numtaps;
        return `
        <p>The table counts every design and structure from the gates, with 16-bit words. The Parks–McClellan filter is the ${n}-tap one that meets the mask once rounded; the Kaiser one has ${k} taps. Read it two ways. Across a column, the structures: parallel direct is ${n0(F.direct.nands)} NANDs, folding takes it to ${n0(F.folded.nands)}, signed digits to ${n0(F.foldedCsd.nands)}, and one multiplier to ${n0(F.shared.nands)}. Down a column, the designs: Parks–McClellan is smaller than Kaiser in every row, ${nf(100 * F.pmKaiserDirect, 0) === nf(100 * F.pmKaiserShared, 0) ? `by ${nf(100 * F.pmKaiserDirect, 0)} % whether parallel or shared` : `by ${nf(100 * F.pmKaiserDirect, 0)} % in a parallel build and ${nf(100 * F.pmKaiserShared, 0)} % in a shared one`}.</p>
        <p>What decides is how fast each build can be clocked, and how many clocks a sample takes. The fastest clocks are in the table, at an illustrative 25 ps a NAND delay. The one-multiplier filter is timed by the static timing of its gates: ${n0(F.tShared.period)} NAND delays, ${nf(F.tShared.maxMhz, 0)} MHz. The parallel builds are not drawn, so theirs is a sum of parts counted from the gates, ${nf(F.tDirect.maxMhz, 0)} MHz for the direct form with its adder tree and ${nf(F.tCsd.maxMhz, 0)} for the folded one with constants. It is a conservative sum, since ripple carries overlap between the tree's levels, and it shows why a parallel build is not simply "one sample a clock at any clock": its longest path is a multiplier and then a tree of ${Math.ceil(Math.log2(F.ch.hwN))} wide adders.</p>
        <p>So a parallel build delivers up to ${nf(F.tDirect.maxMhz, 0)} million samples a second, and one multiplier, which takes ${F.ch.hwN} clocks a sample, up to ${nf(F.tShared.maxMhz / F.ch.hwN, 1)} million. At 48 kHz one multiplier needs a ${nf((F.ch.hwN * 48000) / 1e6, 2)} MHz clock, far under the ${nf(F.tShared.maxMhz, 0)} it can run at. A radio's channel filter at several million samples a second is past what one multiplier can do, and needs parallel hardware: folding and constants in signed digits matter most there. The cost column counts NANDs and leaves out the wires between them.</p>
        <p>One caution about the numbers. The Parks–McClellan row is the ${F.ch.hwN}-tap odd design and the Kaiser row the ${F.kaiser.numtaps}-tap odd one, so that both use the same word and the same check; the fair comparison with ${F.ch.n} taps is Kaiser's ${F.kaiserAny}. Every filter on this page was found by designing for the mask, rounding, and checking, in that order, and the rounding step moved the answer by a tap. A design that is checked only in floating point can be a fraction of a decibel from meeting its mask in the hardware that has to run it.</p>
        <p>Every one of these builds spends a multiplication on every tap. <a href="#/c/iir/0">The next chapter</a> spends them on poles instead, and meets the same mask with a fraction of them.</p>
        <div class="try">Move the clock from 10 to 500 MHz and read the sample rate each build sustains: the parallel builds stop gaining where their fastest clock is, and the daggers mark it. Find the cheapest build that reaches 10 million samples a second.</div>`;
      },
      widget: designsWidget,
      challenge: {
        kind: 'quiz', question: `The ${figures().ch.hwN}-tap filter must deliver 10 million samples a second, with any clock the gates can take. Which builds can?`,
        options: ['The parallel builds, but not one multiplier', 'Any build, with a fast enough clock', 'Only one multiplier', 'None of them'],
        answer: 0,
        explain: `One multiplier takes ${figures().ch.hwN} clocks a sample and its gates can run at ${nf(figures().tShared.maxMhz, 0)} MHz, so it delivers up to ${nf(figures().tShared.maxMhz / figures().ch.hwN, 1)} million a second. A parallel build makes a sample every clock and can run at up to ${nf(figures().tDirect.maxMhz, 0)} MHz in the direct form or ${nf(figures().tCsd.maxMhz, 0)} folded with constants, by the sum of parts.`,
        why: ['', 'A clock cannot go past what the longest path allows, so some builds have a ceiling below this.', `One multiplier tops out at ${nf(figures().tShared.maxMhz / figures().ch.hwN, 1)} million.`, 'The parallel builds reach it, in the sum of parts counted here.'],
      },
    },
  ],
};

