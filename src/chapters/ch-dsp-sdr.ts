// A software radio (level Signal processing): can you receive a station with what you have built? A synthesized band of four FM stations at 960 kHz; a complex mixer and a CIC in gates (lib/sdr.ts, equal to
// dsp/sdr.ts every clock), the channel filter, discriminator, audio filter and de-emphasis in floating point (the DSP core's part, not built yet), and sound out: a full second from the model, a short clip
// from the gates, checked equal to the model. Every number on this page is measured or computed (tests/dsp-sdr.test.ts).

import { cicAliasDb, cicResponse } from '../dsp/multirate';
import {
  ADC_SCALE, AUD, AUDIO_R, AUDIO_TAPS, carrierToNoise, carson, stationBand, CHAN_EDGE, CHAN_TAPS, CIC_GAIN, CIC_N, CIC_R, DEV, FS, FS_CIC, keyingRatio, KEYING_LOST_DB, NCO_BITS, NCO_K, occupied, receive, STATIONS, TAU, TEST_TONE_HZ, toneFm, toneSnr, W_CIC, W_IN, W_MIX,
  workPerSecond, synthBand, NCO_AMP, NCO_SHIFT, interferenceDb, ringSpread, trailingZeros, tuningWord, firstClipNoiseDb, chanWorstDb, audioHalfPointHz, audioGainDb, preLiftDb, analogueLiftDb, ALPHA, stationOccupied,
  releaseReceptions,
} from '../dsp/sdr';
import { CLIP_CLOCKS } from '../dsp/sdrclip';
import { cicDecimator } from '../lib/multirate';
import { stats } from '../sim/stats';
import { audioWidget, band, bandWidget, carsonWidget, channelWidget, dialWidget, DIAL_DEFAULT, frontScene, FRONT_CLOCKS, mixerScene, MIXER_CLOCKS, nandsOf, sdrApi, tableRow, tableUnits, TABLE_KS, tableWidget, tuneWidget } from '../widgets/dspsdr';
import { deferredAt, lazyProps, lz } from '../ui/lazy';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(Math.round(x));
const d1 = (x: number) => (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);
const khzf = (hz: number) => `${n0(hz / 1000)} kHz`;
const memo = <T>(f: () => T): (() => T) => { let v: T | undefined; return () => (v ??= f()); };
const nands = memo(nandsOf);
const firstClip = memo(firstClipNoiseDb);
const memoBy = <A, T>(f: (a: A) => T): ((a: A) => T) => { const m = new Map<A, T>(); return (a) => { if (!m.has(a)) m.set(a, f(a)); return m.get(a)!; }; };
const TONE_NDS = [-40, -25, -10, 0];
const toneAt = memoBy((i: number) => { const nd = TONE_NDS[i], rx = () => receive(band(), STATIONS[0].f, nd); return lazyProps({ nd: () => nd, clip: () => rx().clipped, snr: () => toneSnr(rx().chain.audio), cn: () => carrierToNoise(STATIONS[0].a, nd, stationBand(STATIONS[0])) }); });
const WEAK_NDS = [-40, -25, -15];
const weakAt = memoBy((i: number) => { const nd = WEAK_NDS[i]; return lazyProps({ nd: () => nd, key: () => keyingRatio(receive(band(), STATIONS[3].f, nd).chain.audio), cn: () => carrierToNoise(STATIONS[3].a, nd, stationBand(STATIONS[3])) }); });
const measuredBw = () => measuredBwOf;
const measuredBwOf = lazyProps({ tone: () => occupied(toneFm(DEV, TEST_TONE_HZ), 0.98), wide: () => occupied(toneFm(DEV, 15_000), 0.98) });
/** The closest two stations are this far apart. */
const closest = () => Math.min(...STATIONS.map((s) => s.f).sort((a, b) => a - b).map((f, i, a) => (i ? f - a[i - 1] : Infinity)));
const toneFloor = memo(() => toneSnr(receive(band(), STATIONS[0].f, -60).chain.audio));
const floors = (() => { const k = (b: ReturnType<typeof synthBand>, nd: number) => keyingRatio(receive(b, STATIONS[3].f, nd, FS, 12).chain.audio); return lazyProps({ noisy: () => k(band(), -40), noisyAlone: () => k(synthBand(FS, [3]), -40), clean: () => k(band(), -200), cleanAlone: () => k(synthBand(FS, [3]), -200) }); })();
const interf = lazyProps({ six: () => interferenceDb(3), twelve: () => interferenceDb(3, 12), sweepAlone: () => interferenceDb(3, 12, [2]) });
const spreads = lazyProps({ tone: () => ringSpread(STATIONS[0].f, FRONT_CLOCKS), weak: () => ringSpread(STATIONS[3].f, FRONT_CLOCKS) });
const discPeak = (f: number) => { const d = receive(band(), f, -40, 1 << 17).chain.disc; let p = 0; for (let i = 3000; i < 3000 + 1200; i++) p = Math.max(p, Math.abs(d[i])); return p; };
const peaks = lazyProps({ tone: () => discPeak(STATIONS[0].f), weak: () => discPeak(STATIONS[3].f) });
const betas = memo(() => [[5_000, 15_000], [15_000, 15_000], [30_000, 15_000], [50_000, 15_000]].map(([dev, fm]) => ({ beta: dev / fm, c: carson(dev, fm), m98: occupied(toneFm(dev, fm), 0.98), m999: occupied(toneFm(dev, fm), 0.999) })));
const widest = () => Math.max(...STATIONS.map(stationBand));
const occAt = (k: number) => stationOccupied(k);
const d2 = (x: number) => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(2);
const ratioDb = (a: number, b: number) => 20 * Math.log10(a / b);

export const chSdr: Chapter = {
  leave: releaseReceptions,
  id: 'sdr', num: numOf('sdr'), title: 'A software radio', level: 'Signal processing',
  blurb: 'Can you receive a station with what you have built? A band of four FM stations, a mixer and a CIC in gates, the filters and the discriminator after them, and sound out.',
  goals: [
    'say what an FM station occupies and how Carson\'s rule finds it, and check the rule on a spectrum',
    'tune a station to zero with a complex mixer, and say what each bit of its oscillator table buys',
    'follow one band down 960 kHz → 240 kHz → 24 kHz and say what each stage costs and where it runs',
    'hear a station received by your own gates, and say what noise does to FM',
  ],
  builds: ['signals', 'radio', 'modem', 'fixed', 'spectrum', 'firdesign', 'multirate', 'cordic', 'dspcore', 'converters'],
  recap: {
    keep: [
      'An FM station is a carrier whose frequency follows the sound. Its width is not the audio\'s: Carson\'s rule, 2 (deviation + highest audio frequency), holds nearly all the power, and the stations are spaced wider than that.',
      'Multiplying a complex band by e^(−jθ), with θ turning at the tuning word, slides every frequency down by that amount. The station you want is then at zero, and the rest of the receiver never moves.',
      'The oscillator\'s table costs gates by the bit and buys 6 dB of spur-free range by the bit. How much that matters depends on where a station sits: a tuning word whose phase lands on table points hides the error, a station off the grid does not, and a weak station beside a loud one needs it most.',
      'A CIC is the right first filter after the mixer: adders only, at the full rate, dropping it by 4. Everything with multipliers then runs at a quarter, or a fortieth, of the rate.',
      'The discriminator is the phase step between neighbouring samples. FM turns carrier-to-noise ratio into audio signal-to-noise ratio generously until a threshold, below which it breaks up.',
      'That closes the Signal processing level. Its three capstones, on My path, put it to work: a filter to a mask, an echo canceller, and Tune it, which hands you a band with no dial and asks for this receiver.',
    ],
    practise: ['sp_cic', 'sp_cordic'],
    check: [
      {
        question: 'The mixer multiplies each complex sample by e^(−jθ), and θ advances by the tuning word every clock. What does that do to a station at +100 kHz when the word stands for +100 kHz?',
        options: ['Moves it to 0 Hz', 'Moves it to 200 kHz', 'Filters out everything else', 'Doubles its deviation'],
        answer: 0,
        explain: 'The multiplication subtracts the oscillator\'s frequency from every frequency in the band: 100 − 100 = 0. A station at −300 kHz moves to −400 kHz, and the filters that follow take it out.',
        why: ['', 'Mixing with e^(−jθ) subtracts. A real mixer would also make the sum, which is why this one is complex.', 'A mixer is a multiplier and changes no amplitudes. The filters after it remove the others.', 'It shifts the whole spectrum; the deviation, which is a width, does not change.'],
      },
      {
        question: 'The test tone tuned on its own frequency sounded the same from a 4-bit table to a 9-bit one, while the weak station\'s keying did not. What does that show about the table?',
        options: ['The tone\'s tuning word puts its phase on table points, which hides the error; the weak station is off the grid and beside a loud one', 'The weak station uses a different table', 'FM audio is immune to every oscillator error', 'Spurs only exist in the weak station\'s band'],
        answer: 0,
        explain: 'A coarse table puts a spur some tens of dB below every strong signal. A tuning word with many trailing zero bits, as the test tone\'s has, steps the phase through a few table points exactly, so there is no staircase error to see. Tuned a little off, the same tone gets worse as the table shrinks.',
        why: ['', 'There is one table, for all of them.', 'FM does not make a spur harmless: tuned 100 Hz off its frequency the tone\'s SNR depends strongly on the table.', 'They are in every station\'s band, in proportion to its neighbours.'],
      },
      {
        question: 'Why does the CIC come before the 41-tap channel filter?',
        options: ['It takes the rate down 4× with no multipliers, so the filter runs at a quarter', 'It filters more sharply than any ordinary filter', 'It flattens the channel before it is cut', 'A channel filter cannot take 11-bit words'],
        answer: 0,
        explain: 'The channel filter\'s price is taps × rate. Put after a ÷ 4 stage it is 41 × 240 000 a second for each of I and Q instead of four times that. The CIC droops across the channel and rejects only near its nulls; the 41 taps finish the job.',
        why: ['', 'It rejects well near its nulls and droops across the band. That is why a short ordinary filter follows.', 'It does the opposite: it droops across the band.', 'A filter works on words of any width the designer gives it.'],
      },
    ],
  },
  steps: [
    {
      title: 'Four stations in one band',
      get body() {
        const b = nands();
        return `
        <p>Most chapters of this level had a part in a receiver; this one assembles them. <a href="#/c/radio/4">Chapter ${numOf('radio')}</a> already ran four BPSK stations through a mixer and decimation in arithmetic; here the stations are FM, the front end is in gates, and every stage is priced. A radio front end hands you a stream of <em>complex</em> samples, I and Q, from two converters, at a rate that covers a whole slice of the spectrum at once. Here that is ${n0(FS)} of them a second, ${W_IN} bits each of I and Q, and the slice holds four FM stations: a test tone at 1 kHz, an arpeggio, a sweep, and a weak one that sends Morse. The stations are synthesized by the code on this page, so everything here is the same for every reader. (<a href="#/c/radio/0">Chapter ${numOf('radio')}</a> had the antenna and the path.)</p>
        <p>Their levels differ by ${d1(ratioDb(STATIONS[0].a, STATIONS[3].a))} dB, which is what makes a receiver hard: the weak station sits ${khzf(Math.abs(STATIONS[3].f - STATIONS[2].f))} from a loud one, and whatever the receiver does wrong to the loud one lands on the weak one at that offset. The peak deviation is ±${n0(DEV / 1000)} kHz, narrower than broadcast's ±75, to keep the band small.</p>
        <p>The receiver has six stages and the first two are in gates: <strong>mix</strong> the chosen station to zero (${n0(b.mixer)} NANDs), <strong>decimate</strong> by ${CIC_R} with a CIC (two of them, ${n0(2 * stats(cicDecimator(CIC_N, CIC_R, W_MIX)).nands)} NANDs), <strong>filter</strong> the channel, <strong>discriminate</strong>, <strong>filter</strong> the audio down to ${n0(AUD / 1000)} kHz, and undo the transmitter's treble boost (<strong>de-emphasis</strong>, step 8).</p>
        <div class="try">Raise the noise to the right. The floor lifts under the weak station first, and at the far end the ADC clips: the readout counts the samples at full scale.</div>`;
      },
      widget: deferredAt([673, 792], bandWidget, band, ...STATIONS.map((_, k) => () => stationOccupied(k))),
      challenge: {
        kind: 'quiz', question: 'Which of these does the ADC\'s word size decide?',
        options: ['How far a weak station sits above rounding noise next to a loud one', 'How many stations fit in the band', 'The width of each station', 'The rate the audio comes out at'],
        answer: 0,
        explain: `Rounding to ${W_IN} bits adds noise spread over the whole band, at a level fixed by the word. A station at ${STATIONS[3].a} of the loudest has only ${d1(STATIONS[3].a * ADC_SCALE)} steps of amplitude to stand on.`,
        why: ['', 'That is the sample rate, and the stations\' spacing.', 'That is the deviation and the audio.', 'That is the decimation, chosen by the filters.'],
      },
    },
    {
      title: 'How wide is a station?',
      get body() {
        return `
        <p>Frequency modulation moves the carrier by an amount proportional to the sound: ±${n0(DEV / 1000)} kHz at the loudest. That is <em>deviation</em>, and it is not the width. A tone of frequency f<sub>m</sub> puts sidebands every f<sub>m</sub> either side of the carrier, with amplitudes set by Bessel functions (J<sub>n</sub>(β) for the n-th pair, a standard family of oscillating functions), and the larger the swing against f<sub>m</sub> (the <em>modulation index</em> β = Δf / f<sub>m</sub>) the farther out they reach. <strong>Carson's rule</strong> is the engineer's shortcut: the band that holds nearly all the power is 2 (Δf + f<sub>m</sub>).</p>
        <p>The widget measures it. It synthesizes one station, takes an FFT, and finds the narrowest band centred on the carrier that holds 98 % of the power. For the 1 kHz test tone at ±${n0(DEV / 1000)} kHz the rule says ${d1(carson(DEV, TEST_TONE_HZ) / 1000)} kHz and the spectrum says ${lz(() => d1(measuredBw().tone / 1000))} kHz. Over a range of modulation indices with a 15 kHz tone: ${lz(() => betas().map((b) => `β = ${d1(b.beta)}: the 98 % band is ${d1(b.m98 / 1000)} kHz against Carson's ${d1(b.c / 1000)}`).join('; '))}. The rule is a convenient figure, not a bound either way: at 99.9 % of the power the last case needs ${lz(() => d1(betas()[3].m999 / 1000))} kHz.</p>
        <p>This sets the channel the receiver must keep. The closest two stations here are ${khzf(closest())} apart. The widest station in the band is the sweep, with Carson's ${khzf(widest())} (the 130 kHz above is the 15 kHz-audio case, not a station here), so a ±${khzf(CHAN_EDGE)} filter, ${khzf(2 * CHAN_EDGE)} wide, has room. On the first step the shaded bands are Carson's estimate; the table beside them lists what each station measures at 98 % of its own power, averaged over about a second of its programme: ${[0, 1, 2, 3].map((k) => lz(() => khzf(occAt(k)))).join(', ')}.</p>
        <div class="try">Slide the audio tone up to 15 kHz and watch the sidebands run out to the shaded edges. Then shrink the deviation to 5 kHz: the band collapses to a few audio tones' width.</div>`;
      },
      widget: deferredAt([551, 620], carsonWidget),
      challenge: {
        kind: 'quiz', question: `A station deviates ±${n0(DEV / 1000)} kHz and carries audio up to 15 kHz. Stations are ${khzf(closest())} apart at the closest. Do they overlap?`,
        options: [`No: Carson's band is ${khzf(carson(DEV, 15000))}`, 'Yes: the deviation alone is wider', 'Yes: 15 kHz audio needs 15 kHz either side', 'It depends on the noise'],
        answer: 0,
        explain: `2 (${n0(DEV / 1000)} + 15) = ${n0(carson(DEV, 15000) / 1000)} kHz, under the ${khzf(closest())} spacing, with ${khzf(closest() - carson(DEV, 15000))} to spare for the filter's skirt.`,
        why: ['', `The deviation is ±${n0(DEV / 1000)}, a ${n0((2 * DEV) / 1000)} kHz swing; Carson's rule adds the audio's reach to it.`, 'The audio is carried by the sidebands, but they reach out Δf + f<sub>m</sub> in all, not f<sub>m</sub>.', 'Noise changes the quality, not the width of a station.'],
      },
    },
    {
      title: 'Moving a station to zero',
      get body() {
        return `
        <p>A filter that picks one station out of a band at ${n0(FS / 1000)} kHz would need a very long impulse response. It is much cheaper to move the station and keep the filter fixed. Multiply every sample by e^(−jθ<sub>n</sub>), where θ turns by a fixed step each clock, and every frequency in the band drops by the rate that step stands for. The station you tuned to ends up at zero, and the others land at their distance from it. <a href="#/c/radio/3">Chapter ${numOf('radio')}</a> mixed one BPSK signal down this way (<a href="#/c/radio/4">A radio in arithmetic</a>); here the mixer picks one FM station out of four, and the next step puts it in gates.</p>
        <p>Because the samples are complex, this is one rotation and nothing is lost: (x<sub>r</sub> + j x<sub>i</sub>)(cos θ − j sin θ) = (x<sub>r</sub> cos θ + x<sub>i</sub> sin θ) + j (x<sub>i</sub> cos θ − x<sub>r</sub> sin θ). A real mixer, one multiplication, would make the sum and the difference of every pair of frequencies at once and fold the mirror image onto the station. The step is a ${NCO_BITS}-bit <em>tuning word</em>, so the oscillator tunes in ${d1(FS / 2 ** NCO_BITS)} Hz steps. The band wraps at ±${n0(FS / 2000)} kHz, so the station at +${n0(STATIONS[3].f / 1000)} kHz, tuned to ${n0(STATIONS[0].f / 1000)}, would sit at +${n0((STATIONS[3].f - STATIONS[0].f) / 1000)} kHz and shows at ${n0((STATIONS[3].f - STATIONS[0].f - FS) / 1000)} kHz.</p>
        <div class="try">Drag the tuning across a station. The channel it lands in is the shaded one, the only part the later stages keep.</div>`;
      },
      widget: deferredAt([810, 737], tuneWidget, band),
      challenge: {
        kind: 'quiz', question: `The oscillator is tuned to ${n0(STATIONS[0].f / 1000)} kHz. Where does the station at +${n0(STATIONS[2].f / 1000)} kHz end up?`,
        options: [`+${n0((STATIONS[2].f - STATIONS[0].f) / 1000)} kHz`, `${n0((STATIONS[0].f + STATIONS[2].f) / 1000)} kHz`, '0 Hz', `+${n0(STATIONS[2].f / 1000)} kHz`],
        answer: 0,
        explain: `The mixer subtracts the tuned frequency: ${n0(STATIONS[2].f / 1000)} − (${n0(STATIONS[0].f / 1000)}) = +${n0((STATIONS[2].f - STATIONS[0].f) / 1000)} kHz, inside the band's ±${n0(FS / 2000)} kHz but far outside any channel the next filter keeps.`,
        why: ['', 'That would be adding the two; the mixer takes the oscillator away.', 'Only the station at the tuned frequency lands there.', 'Everything moves.'],
      },
    },
    {
      title: 'The mixer in gates',
      get body() {
        const b = nands();
        return `
        <p>Here it is, drawn from parts you have: a ${NCO_BITS}-bit register that adds the tuning word at every clock, two tables addressed by its top ${NCO_K} bits, four ${W_IN}-bit multipliers and two adders. The register is the <em>numerically controlled oscillator</em> of <a href="#/c/modem/2">chapter ${numOf('modem')}</a>, with a cosine table beside the sine one. The whole mixer is ${n0(b.mixer)} NANDs, of which the oscillator is ${n0(b.nco)} and the multipliers and adders the rest.</p>
        <p>The tables hold ±${NCO_AMP}, and ${NCO_AMP} stands for 1.0, so the mixer's gain is ${NCO_AMP} / ${2 ** NCO_SHIFT} = ${(NCO_AMP / 2 ** NCO_SHIFT).toFixed(3)}, not 1. It keeps ${W_MIX} bits of the sum from bit ${NCO_SHIFT} up: a floor, which biases every output by half a step downward, and a rotated sample can be √2 as large as it was. The only stored coefficients are the two tables. The integer model in the tests equals these gates on every clock, at several tunings and several table sizes.</p>
        <p>One sample goes in at every clock, so a second of the band is ${n0(FS)} clocks, too many to run a gate simulator through live. The page keeps that in mind: sound for a full second comes from the model, which does these gates' arithmetic on typed arrays, and a short clip comes from the gates themselves.</p>
        <div class="try">Pick a station and run ${MIXER_CLOCKS} clocks. The trace is the sum of all four stations after mixing, so it shows who is there, not one station: the tuned one is at zero frequency now and the others turn at their distance from it. The spectrum on the step before, Moving a station to zero, shows them one by one.</div>`;
      },
      scene: mixerScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Tune to the test tone, run the gates, and see every output equal the model\'s.',
        check: (st) => { const a = sdrApi.get(st); return !!a && a.agrees() && a.tuned() === STATIONS[0].f; },
        hints: ['The first button of the panel is the test tone.'],
        answer: `Run the first station. The panel compares both outputs of the mixer with the integer model at every one of the ${MIXER_CLOCKS} clocks.`,
        solve: (st) => { sdrApi.get(st)?.run(STATIONS[0].f); },
      },
    },
    {
      title: 'How fine does the table have to be?',
      get body() {
        const r = tableRow, z = trailingZeros(tuningWord(STATIONS[0].f));
        return `
        <p>A table of 2<sup>k</sup> steps turns the phase into a staircase, and the staircase has an error: a spur in the mixer's output for every strong signal that passes through. Measured on a steady carrier, a ${r(4).k}-bit table leaves its largest spur ${lz(() => d1(r(4).sfdr))} dB below it, ${r(6).k} bits ${lz(() => d1(r(6).sfdr))} dB, ${r(8).k} bits ${lz(() => d1(r(8).sfdr))} dB: that column of the table rises 6 dB for every bit, until by ${r(9).k} bits the 8-bit words of the table take over (${lz(() => d1(r(9).sfdr))} dB). The price is ${n0(r(4).nands)} NANDs for the oscillator at ${r(4).k} bits and ${n0(r(8).nands)} at ${r(8).k}: a table doubles for every bit.</p>
        <p>What the spurs do to a station depends on where it sits, and the test tone is a trap. Tuned on its own frequency its audio is ${lz(() => d1(r(4).toneOn))} dB above everything else from ${r(4).k} bits to ${r(9).k}, and it is tempting to say FM does not care. It does not care <em>there</em> only because its tuning word, ${tuningWord(STATIONS[0].f)}, ends in ${z} zero bits, so the phase steps through ${2 ** (NCO_BITS - z)} points that are all on the table. Tuned 100 Hz off, the same tone is ${TABLE_KS.filter((k) => k <= 6 || k === 8).map((k) => `${lz(() => d1(r(k).toneOff))} dB at ${k} bits`).join(', ')}. The arpeggio's tuning word has the same property. The sweep and the weak station do not, and they show what the table does.</p>
        <p>The weak station, ${d1(ratioDb(STATIONS[2].a, STATIONS[3].a))} dB under its neighbour, shows it as keying: key down over key up is ${lz(() => d1(r(5).keying))} dB at ${r(5).k} bits, ${lz(() => d1(r(6).keying))} at ${r(6).k}, ${lz(() => d1(r(7).keying))} at ${r(7).k}, ${lz(() => d1(r(8).keying))} at ${r(8).k} and ${lz(() => d1(r(9).keying))} at ${r(9).k}. That is not 6 dB a bit. It is a cliff, then a floor. At ${r(4).k} bits and below the table shows <em>lost</em>, not a figure: the spurs are louder than the weak station, the discriminator follows them, and the audio is as loud with the key up as with it down. The ratio of two stretches of the same garbage is near 0 dB, a little either side (${lz(() => d2(r(3).keying))} at ${r(3).k} bits, ${lz(() => d2(r(4).keying))} at ${r(4).k}), and means nothing; ${d1(KEYING_LOST_DB)} dB is where the table stops quoting it. Past the cliff each bit buys less (${lz(() => d1(r(7).keying - r(6).keying))} dB from ${r(6).k} to ${r(7).k} bits, ${lz(() => d1(r(9).keying - r(8).keying))} from ${r(8).k} to ${r(9).k}), and the table is not what stops it. At −40 dB of noise the weak carrier is only ${d1(carrierToNoise(STATIONS[3].a, -40, stationBand(STATIONS[3])))} dB over the noise, and with a 12-bit table it keys ${lz(() => d1(floors.noisy))} dB with all four stations present and ${lz(() => d1(floors.noisyAlone))} dB with the weak station alone: the noise sets that floor, whatever else is on the air. Switch the noise off and the 12-bit table reaches ${lz(() => d1(floors.clean))} dB with all four, against ${lz(() => d1(floors.cleanAlone))} dB alone; that gap is the neighbours (next steps).</p>
        <p>The chapter's mixer uses ${NCO_K} bits: ${lz(() => d1(r(NCO_K).sfdr))} dB of spur-free range for ${n0(r(NCO_K).nands)} NANDs in the oscillator, against ${n0(r(9).nands)} at ${r(9).k}. The test tone's audio SNR on its own frequency is ${lz(() => d1(toneAt(0).snr))} dB, which only says its tuning word is a friendly one.</p>
        <div class="try">Play the weak station at 4 bits, then at 6 and 8, and read the key-down / key-up figure beside it. Then read the tone column: the left figure is on its frequency, the right one 100 Hz off.</div>`;
      },
      widget: deferredAt([496, 586], tableWidget, band, ...tableUnits()),
      challenge: {
        kind: 'quiz', question: 'What sets the table size a receiver needs?',
        options: ['How much louder its strongest neighbour is than the weakest wanted station', 'The audio\'s highest frequency', 'The deviation of the stations', 'The number of stations'],
        answer: 0,
        explain: 'A spur is a copy of a strong signal at a fixed distance below it. It does no harm unless something weaker sits there, or the tuning leaves the phase off the table\'s points. The test tone looked unharmed by a table of 16 steps only because its tuning word lands on them; 100 Hz off it is not, and the weak station is not either.',
        why: ['', 'That sets the audio filter.', 'That sets the channel width.', 'Spurs scale with levels, not with how many signals there are.'],
      },
    },
    {
      title: 'Dropping to a quarter of the rate',
      get body() {
        const b = nands(), cic = stats(cicDecimator(CIC_N, CIC_R, W_MIX)).nands;
        const alias = cicAliasDb(CIC_N, CIC_R, CHAN_EDGE / FS_CIC), droop = 20 * Math.log10(cicResponse(CIC_N, CIC_R, CHAN_EDGE / FS));
        return `
        <p>The channel is ±${khzf(CHAN_EDGE)} wide in a band of ±${n0(FS / 2000)}, so most of the samples are not needed, and <a href="#/c/multirate/5">the rate chapter</a> said what to do about that: a CIC, which is adders and registers with no multiplier. Behind each of I and Q goes an order-${CIC_N} CIC, ÷ ${CIC_R}, from ${W_MIX}-bit words. Its registers grow by N log₂ R = ${CIC_N * Math.log2(CIC_R)} bits to ${W_CIC}, and the gain at zero is ${n0(CIC_GAIN)}. One CIC is ${n0(cic)} NANDs; the whole front end, mixer and two CICs, is ${n0(b.front)}.</p>
        <p>At ${n0(FS_CIC / 1000)} kHz the CIC's alias rejection at the channel's edge is ${d1(-alias)} dB, and the droop at the channel's edge is ${d1(-droop)} dB. The droop is not corrected anywhere in this receiver: the station is ${d1(-droop)} dB lower at the channel's edge than at its centre.</p>
        <p>Aliasing is the bigger matter, because what folds in at ${n0(FS_CIC / 1000)} kHz cannot be filtered out afterwards: it is in the channel. The sweep is ${khzf(STATIONS[3].f - STATIONS[2].f)} from the weak station; after ÷ ${CIC_R} that lands ${khzf(FS_CIC - (STATIONS[3].f - STATIONS[2].f))} from zero, well inside it, and the CIC's nulls, at multiples of ${khzf(FS_CIC)}, are narrow beside a station ${khzf(stationBand(STATIONS[2]))} wide, so most of it is not in one. Measured with the noise off, everything the other three stations put into the weak station's channel is ${lz(() => d1(interf.six))} dB against the station itself with this chapter's table, ${lz(() => d1(interf.twelve))} dB with a 12-bit table, and the sweep's alias alone is ${lz(() => d1(interf.sweepAlone))} dB. So the alias holds the weak station's signal-to-interference ratio in its own channel to about ${lz(() => d1(-interf.twelve))} dB however fine the table is. It is not what sets the keying figure at −40 dB of noise (the previous step: that is the noise), but with the noise off it is what holds the keying to ${lz(() => d1(floors.clean))} dB where the station alone would give ${lz(() => d1(floors.cleanAlone))}.</p>
        <div class="try">Pick a station and run the front end. ${FRONT_CLOCKS} clocks go in and ${FRONT_CLOCKS / CIC_R} points of I and Q come out. The test tone's points stay on a circle: the spread of their radius is ${lz(() => n0(100 * spreads.tone))} % of the mean, and how fast, and which way, they go round it is the sound. The weak station's do not: ${lz(() => n0(100 * spreads.weak))} %, because the neighbours' alias is in its channel. (The first ${CIC_N} outputs, while the CIC fills, are left off the plot, not out of the check.)</div>`;
      },
      scene: frontScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Tune to the weak station, run the front end, and see every word equal the model\'s.',
        check: (st) => { const a = sdrApi.get(st); return !!a && a.agrees() && a.tuned() === STATIONS[3].f; },
        hints: ['The weak station is the last button.'],
        answer: `Run the fourth station. The panel compares both CIC outputs and the strobe with the model at each of the ${FRONT_CLOCKS} clocks.`,
        solve: (st) => { sdrApi.get(st)?.run(STATIONS[3].f); },
      },
    },
    {
      title: 'The channel filter and the discriminator',
      get body() {
        const w = workPerSecond;
        return `
        <p>From here on the arithmetic is the kind a processor does well. This page does it in floating point on the model, and says so. A ${CHAN_TAPS}-tap low-pass at ${n0(FS_CIC / 1000)} kHz cuts the channel to ±${khzf(CHAN_EDGE)}: ${n0(w.channel)} real multiplications a second for I and Q together, against ${n0(w.mixer)} for the mixer's four multipliers at the full rate. Stations far enough away are in its stopband, at least ${d1(-chanWorstDb(90_000, 120_000))} dB down from 90 to 120 kHz out; what the CIC folded into the channel is already in it, and the filter cannot tell it from the station.</p>
        <p>Then the part that makes it FM. A sample is z<sub>n</sub> = I + jQ, and the angle of z<sub>n</sub> · conj(z<sub>n−1</sub>) is how far the phase turned in one sample. That is the instantaneous frequency, in radians a sample, and with the deviation's scale it <em>is</em> the audio: a full-scale tone swings it ±1 deviation. No local oscillator tracks the carrier, and the answer ignores amplitude. It costs one arctangent a sample, which <a href="#/c/cordic/4">the CORDIC chapter</a> built.</p>
        <p>These are the stages <a href="#/c/dspcore/0">chapter ${numOf('dspcore')}</a>'s DSP core is built for. This page does not run them there: it runs them in floating point on the model, and the steps after this one depend on nothing but its numbers.</p>
        <div class="try">Pick the weak station. The largest discriminator output is ${lz(() => d2(peaks.weak))} deviations for it against ${lz(() => d2(peaks.tone))} for the test tone, which is the one that keeps to its limit: the angle ignores amplitude, not noise or the neighbours' alias, and whatever exceeds one deviation is theirs.</div>`;
      },
      widget: deferredAt([797, 832], channelWidget, band, () => receive(band(), STATIONS[0].f, -40, 1 << 17)),
      challenge: {
        kind: 'quiz', question: 'Why does the discriminator work on the product z[n] · conj(z[n−1]) instead of subtracting the two angles?',
        options: ['The angle of the product is the difference, with no wrap to undo', 'It is cheaper than subtracting angles', 'It removes the noise', 'Angles cannot be computed for complex samples'],
        answer: 0,
        explain: 'Subtracting two angles that each wrap at ±π gives an answer off by 2π whenever one has just wrapped. The product\'s angle is already the small difference.',
        why: ['', 'It costs a complex multiplication; a subtraction is cheaper. That is not the point.', 'It does not touch the noise.', 'atan2 does exactly that.'],
      },
    },
    {
      title: 'Audio, and the treble that was boosted',
      get body() {
        return `
        <p>The discriminator's output is at ${n0(FS_CIC / 1000)} kHz, and audio is under 10. An ${AUDIO_TAPS}-tap filter whose −6 dB point is at ${d1(audioHalfPointHz() / 1000)} kHz computes only every ${AUDIO_R}th output, so it costs ${n0(workPerSecond.audio)} multiplications a second, not ${AUDIO_R} times that: <a href="#/c/multirate/2">polyphase</a>, again. It is not a sharp cut: it is ${d1(-audioGainDb(12_000))} dB down at 12 kHz and ${d1(-audioGainDb(14_000))} dB at 14, which fold onto 12 and 10 kHz of the ${n0(AUD)} samples a second that remain.</p>
        <p>Last is a trick of the broadcaster's. FM's noise is worst at high audio frequencies, so the transmitter boosts the treble before modulating and the receiver cuts it back, and the same cut takes the noise down with it. Here the pair is a first-order discrete filter and its exact inverse (α = ${ALPHA.toFixed(3)}), so the two cancel on the sound and not on the hiss. It is not the analogue 75 µs network, whose corner is ${d1(1 / (2 * Math.PI * TAU) / 1000)} kHz: this filter lifts 10 kHz by ${d1(preLiftDb(10_000))} dB over the bass, where an analogue network with ${n0(TAU * 1e6)} µs lifts ${d1(analogueLiftDb(10_000))} dB.</p>
        <div class="try">Play the arpeggio without the de-emphasis, then with it. The first is the transmitter's boost with nothing to undo it.</div>`;
      },
      widget: deferredAt([822, 931], audioWidget, band, () => receive(band(), STATIONS[1].f, -40)),
      challenge: {
        kind: 'quiz', question: 'If the receiver skipped de-emphasis, what would the listener get?',
        options: ['Too much treble, and the hiss with it', 'Nothing: de-emphasis is only for noise', 'The audio at half speed', 'Only the bass'],
        answer: 0,
        explain: 'Pre-emphasis boosted the treble by the same curve de-emphasis cuts. Without the cut the treble is too strong, and the high-frequency noise comes through at full strength.',
        why: ['', 'It changes the sound as well as the noise: the two curves are inverses.', 'Rate and pitch are unaffected.', 'The boost is on the treble.'],
      },
    },
    {
      title: 'Turn the dial',
      get body() {
        return `
        <p>Everything at once, on a second of the band: sample, mix, CIC, channel filter, discriminator, audio filter, de-emphasis. Tune across the four stations. Between them the readout names nothing and the output is noise.</p>
        <p>Then raise the noise. FM trades bandwidth for noise: the test tone's audio is ${lz(() => d1(toneAt(0).snr))} dB above everything else at ${toneAt(0).nd} dB of noise (carrier to noise ${d1(toneAt(0).cn)} dB), ${lz(() => d1(toneAt(1).snr))} dB at ${toneAt(1).nd} (${d1(toneAt(1).cn)}) and ${lz(() => d1(toneAt(2).snr))} dB at ${toneAt(2).nd} (${d1(toneAt(2).cn)}). At ${toneAt(3).nd} dB the ADC is clipping ${lz(() => n0(toneAt(3).clip))} samples of the second, so its ${lz(() => d1(toneAt(3).snr))} dB is a clipped figure, not an FM one. Carrier to noise here is the carrier's power over the noise inside the station's Carson band; the receiver keeps ±${khzf(CHAN_EDGE)}, and the ADC's rounding noise is left out. The tone's SNR does not rise for ever: at −60 dB of noise it is ${lz(() => d1(toneFloor()))} dB, the floor of this model's own arithmetic. And the page never takes the tone down to FM's threshold: the ADC starts clipping first, at ${lz(() => String(firstClip()))} dB of noise, where the tone's carrier to noise is still ${lz(() => d1(carrierToNoise(STATIONS[0].a, firstClip() ?? 0, stationBand(STATIONS[0]))))} dB.</p>
        <p>The weak station gets there first. Its key-down to key-up ratio is ${[0, 1, 2].map((i) => `${lz(() => d1(weakAt(i).key))} dB at ${weakAt(i).nd} dB of noise (${d1(weakAt(i).cn)} dB carrier to noise)`).join(', ')}. Textbooks put FM's threshold near 10 dB carrier to noise, below which the discriminator picks up whole turns of phase that were never there. This receiver still keys the weak station at ${d1(weakAt(1).cn)} dB, under that figure, and has lost it by ${d1(weakAt(2).cn)} dB: its own threshold lies between the two, a little under the textbook figure, and that is a measurement of this model, not a standard.</p>
        <p>Sound is never the only proof here. The full second plays from the model. The second button renders the first ${n0((CLIP_CLOCKS / FS) * 1000)} ms of the band through the gates of this chapter, ${n0(CLIP_CLOCKS)} clocks of a ${n0(nands().front)}-NAND circuit, which takes seconds. Say exactly what that compares: the gates are the mixer and the two CICs, and every word leaving the CIC is checked against the model's. The channel filter, the discriminator, the audio filter and the de-emphasis are then the same floating-point code on both sides, so the audio samples agree because the words do; that is a consequence, not a second check. The page says which source you hear.</p>
        <p>That is the receiver whole, and the end of this level. Its last capstone, <a href="#/campaign/play/cap_tune">Tune it</a>, hands you a band you have not seen, with no dial, and asks you to build this chain yourself.</p>
        <p>After it the book ends with five appendices, each a machine whole rather than a chapter's idea: <a href="#/c/appendix-6502/0">Appendix A</a>, the 6502 in its own NMOS transistors; <a href="#/c/appendix-doom/0">B</a>, Doom compiled for our RISC-V, played on its golden model and handed to its gates for a window; <a href="#/c/appendix-sap/0">C</a>, an 8-bit computer on breadboards of 74xx chips; <a href="#/c/appendix-runner/0">D</a>, a game built from gates with no program at all; and <a href="#/c/appendix-baby/0">E</a>, the Manchester Baby of 1948, the first computer to run a program from its own memory.</p>
        <details class="deeper"><summary>What this chapter does not do</summary><p>Only the CIC is in gates: a polyphase decimator is the rate chapter's, and the channel filter that follows the CIC runs on the model in floating point, not on chapter ${numOf('dspcore')}'s core. The noise slider goes to 0 dB, not −5, so that the weak station can be taken past its threshold; the ADC clips well before. Carrier to noise is defined over Carson's band, as above.</p></details>
        <div class="try">Tune to ${n0(STATIONS[0].f / 1000)} kHz and play both. Then tune to +${n0(STATIONS[3].f / 1000)} kHz, raise the noise, and watch the carrier-to-noise readout against how the Morse looks in the waveform.</div>`;
      },
      widget: deferredAt([767, 659], dialWidget, band, () => receive(band(), DIAL_DEFAULT.f, DIAL_DEFAULT.noise)),
      challenge: {
        kind: 'quiz', question: 'The receiver is tuned to the weak station and the noise is raised. Which station breaks up first?',
        options: ['The weak one: its carrier-to-noise ratio is lowest', 'The test tone: it is loudest', 'All at once: the noise is the same for all', 'None: FM rejects noise completely'],
        answer: 0,
        explain: 'Noise is the same everywhere in the band, so the quietest carrier has the least above it. FM improves the audio\'s signal-to-noise ratio generously at good carrier-to-noise ratios and loses it below a threshold.',
        why: ['', 'The loud one has the most carrier above the same noise.', 'The audio quality depends on each station\'s own carrier-to-noise ratio.', 'Below the threshold it breaks up badly.'],
      },
    },
  ],
};
