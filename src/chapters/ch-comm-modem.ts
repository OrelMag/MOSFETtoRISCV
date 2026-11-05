// Chapter 45, Modems (level Communication): how bits cross a line built for voices. The gates are lib/modem.ts (an NCO, an FSK
// transmitter and receiver, a stand-in for the line), checked against comm/modem.ts every output every cycle; the constellations,
// error rates and modem milestones are that file's models (closed forms checked against seeded Monte Carlo
// in tests/comm-modem.test.ts); the DFT and a block of tones are comm/fourier.ts. The line is the model, labelled as such (roadmap Phase 21, decisions 2 and 3).

import { dbToRatio, levelsSupported, MARKED, nyquistBitRate, ratioToDb, shannon, snrNeeded } from '../comm/limits';
import {
  ACC_BITS, BELL103, bitsPerSymbol, DS0, FS, FTW_MARK, FTW_SPACE, gapDb, gapToShannonDb, MODEMS, ncoHz, ncoSnrDb, PCM_RATE, RX_LONG,
  SAMPLES_PER_BIT, serClosed, SINE_K, SINE_W, snrForSer, tuningWord, constellation, monteCarlo,
} from '../comm/modem';
import { arrayMul, FSK_LINK, FSK_RX, FSK_TX, MODEM_LINE, NCO, rca, register, SINE_ROM } from '../lib';
import { flatten } from '../sim/flatten';
import { stats } from '../sim/stats';
import { analyzeTiming, PS_PER_NAND } from '../sim/timing';
import { constellationWidget, fskWidget, iqWidget, linkScene, milestonesWidget, ncoScene, passbandWidget } from '../widgets/modem';
import type { Chapter } from './types';
import { numOf } from './order';

const nf = (x: number, d = 2) => x.toFixed(d);
const n0 = (x: number) => x.toLocaleString('en');
const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const period = (d: Parameters<typeof flatten>[0]) => analyzeTiming(flatten(d))?.period ?? 0;
const fmtRate = (x: number) => (x >= 1e6 ? `${+(x / 1e6).toPrecision(3)} Mb/s` : x >= 1e3 ? `${+(x / 1e3).toPrecision(3)} kb/s` : `${+x.toPrecision(3)} b/s`);
const db = (x: number, d = 1) => `${nf(x, d)} dB`;

const B = 3100;
const v34 = MARKED.find((m) => m.short === 'V.34')!;
const mdm = (id: string) => MODEMS.find((m) => m.id === id)!;
const snrLine = 35;
const needDb = (M: number, ser = 1e-6) => snrForSer('qam', M, ser);
/** The largest square QAM (bits a symbol) the line's SNR carries at one symbol error in a million. */
const maxBits = (() => { let b = 2; while (needDb(4 ** (b + 1)) <= snrLine) b++; return b; })();
const hz = (w: number) => nf(ncoHz(w), 1);

export const chModem: Chapter = {
  id: 'modem', num: numOf('modem'), title: 'Modems', level: 'Communication',
  blurb: 'How bits cross a line built for voices: FSK from an oscillator in gates, then phase and amplitude, the constellation, and how 300 b/s became 56 kb/s against Shannon\'s limit.',
  goals: [
    'say what a voice-band channel passes (300 – 3400 Hz) and why bits have to ride on a carrier to cross it',
    'build an FSK modem from a phase accumulator and a sine table, and read its receiver\'s period counter as a demodulator that needs no carrier phase',
    'turn symbols into a carrier with an in-phase and a quadrature part, label the points with a Gray code, and read the error rate off the closed form',
    'place each voice-band modem from 300 b/s to V.34 against Shannon\'s limit, and say why V.90\'s 56 kb/s does not beat it',
  ],
  builds: ['telegraph', 'adders', 'registers', 'wire'],
  recap: {
    keep: [
      `The telephone channel passes 300 – 3400 Hz, about ${n0(B)} Hz of it usable, so bits ride on a carrier inside it. A pass band of width B carries at most B complex symbols a second (I and Q: 2B real values); the rate is that times log₂ of the points a symbol chooses from.`,
      `An NCO is a ${ACC_BITS}-bit register that adds a tuning word to itself at every clock: f = word · f_clk / 2^${ACC_BITS}, here ${n0(FS)} / 8192 = ${nf(FS / 2 ** ACC_BITS, 2)} Hz a step. A ${2 ** SINE_K}-word sine ROM on its top bits makes the samples (${n0(nands(NCO))} NANDs, ${n0(nands(SINE_ROM))} of them the ROM); changing the word changes the tone with the phase carried on.`,
      `Bell 103 is 300 baud FSK: ${BELL103.originate.space} / ${BELL103.originate.mark} Hz originating, ${BELL103.answer.space} / ${BELL103.answer.mark} Hz answering, a mark (1) the higher tone. The receiver here slices the sign and counts clocks between rising edges (${RX_LONG} or more is the low tone): ${n0(nands(FSK_RX))} NANDs, no carrier phase, and the first thing noise breaks.`,
      `A symbol is a point (I, Q); the line carries I cos ωt − Q sin ωt. Gray labels make neighbours differ in one bit, so a symbol error is about one bit error. V.22 sends ${bitsPerSymbol(mdm('v22'))} bits per symbol at ${mdm('v22').baud} baud, V.22bis ${bitsPerSymbol(mdm('v22bis'))}: the rate rose and the bandwidth did not.`,
      `Noise sets the number of points: square M-QAM errs at 1 − (1 − 2(1 − 1/√M) Q(√(3·SNR/(M − 1))))², and two more bits a symbol cost about 6 dB. Uncoded QAM sits ${db(gapToShannonDb(256, 1e-6))} above Shannon's floor at 10⁻⁶; coding and shaping recover part of it.`,
      `V.34's ${fmtRate(v34.rate)} needs ${db(ratioToDb(snrNeeded(v34.rate / B)))} through ${n0(B)} Hz. V.90's 56 kb/s is ${n0(PCM_RATE)} PCM codewords a second of 7 bits, through about 4 kHz, which needs ${db(ratioToDb(snrNeeded(56000 / 4000)))}: a digital server leaves no analog-to-digital conversion in the downstream path, so the line's noise is all there is. Shannon still holds.`,
    ],
    check: [
      {
        question: `The NCO's tuning word is ${FTW_MARK} and the clock ${n0(FS)} Hz. About what frequency comes out?`,
        options: [`${hz(FTW_MARK)} Hz: word · ${n0(FS)} / 2^${ACC_BITS}`, `${n0(FTW_MARK)} Hz: the word is the frequency`, `${hz(FTW_MARK / 2)} Hz: half the word, to stay under Nyquist`, `${nf(FS / FTW_MARK, 1)} Hz: the clock divided by the word`],
        answer: 0,
        explain: `The accumulator wraps every 2^${ACC_BITS} / word = ${nf(2 ** ACC_BITS / FTW_MARK, 2)} clocks, one sine period, so f = word · f_clk / 2^${ACC_BITS}.`,
        why: ['', 'The word is a fraction of a turn per clock, not hertz. It is hertz only after multiplying by f_clk / 2^13.', 'Nyquist limits the highest word to half the table; it does not halve the frequency.', 'A divider would make the period the word; here the word is the step, so a bigger word is a faster tone.'],
      },
      {
        question: 'A 16-QAM modem is moved from a line of 25 dB SNR to one of 18 dB, same symbol rate. What happens at the receiver?',
        options: [`The error rate rises from ${serClosed('qam', 16, dbToRatio(25)).toExponential(0)} to ${serClosed('qam', 16, dbToRatio(18)).toExponential(0)} a symbol: the points are as far apart in absolute terms, with more noise round each`, 'Nothing: the decision boundaries scale with the noise', 'The carrier frequency drifts', 'The symbol rate falls automatically'],
        answer: 0,
        explain: 'The points stay where they are; the noise cloud round each grows. The chance that a cloud crosses a boundary follows the Gaussian tail, so a few dB changes it by orders of magnitude. A real modem answers by dropping to a smaller constellation.',
        why: ['', 'The boundaries are halfway between points and do not know about the noise.', 'The carrier is a separate matter from the noise power.', 'Nothing in the receiver changes the rate by itself; the two modems negotiate it.'],
      },
      {
        question: 'V.90 reaches 56 kb/s downstream. Why is that no counter-example to Shannon?',
        options: ['The downstream path from the server is digital to the line card, so only the local loop adds noise: about 4 kHz at more than 42 dB SNR is enough, and Shannon is satisfied', 'The telephone line has more bandwidth than 3.1 kHz, so the limit does not apply', 'Compression: the data is 56 kb/s after the modem, fewer bits before', 'V.90 uses more bits per symbol than Nyquist allows'],
        answer: 0,
        explain: `${n0(PCM_RATE)} symbols a second of 7 bits each is ${n0(PCM_RATE * 7)} b/s through about 4 kHz: ${db(ratioToDb(snrNeeded(56000 / 4000)))} at the least. V.34, with the caller's analog line converted to PCM at the exchange, could not have that; V.90 removes the conversion from the downstream path.`,
        why: ['', 'The limit applies to whatever band is used. Used with 4 kHz it still needs the SNR above.', 'Compression raises the user\'s rate, not the line\'s bit rate, which is what V.90 quotes.', 'Nyquist bounds symbols a second (2B real values); it does not limit bits a symbol, which the SNR does.'],
      },
    ],
  },
  steps: [
    {
      title: 'A channel built for voices',
      body: `
        <p>The telephone network was engineered to carry speech: a pair of copper wires to the exchange, a transformer, filters that pass about <strong>300 to 3400 Hz</strong> (below 300 Hz is hum and above 3400 Hz is the guard band of the 8 kHz sampling that digital trunks use), then 64 kb/s of PCM. Nothing in it passes direct current or a sharp edge. A square pulse of the telegraph's kind (chapter <a href="#/c/telegraph/0">Two machines, one wire</a>) comes out as nothing at all. So a modem — modulator and demodulator — dresses bits as something that sounds like a voice: <strong>tones</strong> inside the band.</p>
        <p>The band sets the ceiling twice, as chapter 39 set it. Nyquist: a pass band of ${n0(B)} Hz has room for ${n0(B)} <em>complex</em> symbols a second, because a carrier has two independent parts (the next steps), or ${n0(2 * B)} real values; at ${snrLine} dB (this chapter's assumption for a good call) it supports ${nf(levelsSupported(dbToRatio(snrLine)), 0)} levels an axis, and Shannon puts the whole channel at ${fmtRate(shannon(B, dbToRatio(snrLine)))}. Every modem in this chapter is a way of getting nearer that number than the last one. The tones below are where the first generations put their carriers; drag the SNR to see what the same channel holds at 20 or 45 dB.</p>`,
      widget: passbandWidget,
      more: {
        numbers: `<p>${nf(nyquistBitRate(B, 2) / 1000, 1)} kb/s is the Nyquist rate for binary signalling in ${n0(B)} Hz; V.34's ${fmtRate(v34.rate)} is ${nf(v34.rate / nyquistBitRate(B, 2), 1)} times that, which takes ${nf(Math.log2(v34.rate / nyquistBitRate(B, 2)) + 1, 1)} bits a real value, i.e. ${nf(v34.rate / B, 1)} bits per hertz of band at ${db(ratioToDb(snrNeeded(v34.rate / B)))} at the very least.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `A modem occupies the whole ${n0(B)} Hz band with a carrier and sends complex (I, Q) symbols as fast as the band allows. How many symbols a second, at most?`,
        options: [`About ${n0(B)}: one complex symbol per hertz of band`, `${n0(2 * B)}: Nyquist's 2B`, `${n0(B / 2)}: half the band`, `Unlimited: the SNR sets the rate, not the band`],
        answer: 0,
        explain: `Nyquist's 2B counts real values; a carrier with I and Q makes each symbol two of them, so a pass band of B holds B symbols a second. V.34's top rate of ${n0(mdm('v34').baud)} baud needs more than this nominal band: it measures the line when it connects and uses the wider band a good line offers, at least 3.4 kHz.`,
        why: ['', 'That counts the real values per second. One I/Q symbol is two of them.', 'Half of B is what a baseband signal of bandwidth B/2 would hold. A pass band of width B holds B complex symbols.', 'The SNR sets how many bits each symbol holds. The band still limits how many symbols fit.'],
      },
    },
    {
      title: 'Tones: FSK',
      body: `
        <p>The simplest dress for a bit is a pair of tones: one frequency for 0 (a <em>space</em>), another for 1 (a <em>mark</em>), a change of frequency at each bit. That is <strong>frequency-shift keying</strong>. The Bell 103 modem (1962) used it at <strong>${BELL103.baud} baud</strong>, ${BELL103.baud} b/s: ${BELL103.originate.space} Hz and ${BELL103.originate.mark} Hz for the side that called (the originating modem), ${BELL103.answer.space} and ${BELL103.answer.mark} Hz for the side that answered. Two pairs, so both directions share the pair of wires at once: full duplex by frequency division, with filters at each end.</p>
        <p>At ${BELL103.baud} baud a bit lasts ${nf(1000 / BELL103.baud, 2)} ms, which holds ${nf(BELL103.originate.space / BELL103.baud, 2)} cycles of the space tone and ${nf(BELL103.originate.mark / BELL103.baud, 2)} of the mark: the two differ by two thirds of a cycle in a bit, enough for a receiver that counts but not much for one that waits for a clean spectral peak. The change from one tone to the other is made <em>phase-continuous</em> (the oscillator keeps its phase, only the rate of turning changes), so the signal has no jump to spread into the neighbouring band.</p>
        <p>The waveform below is not drawn: it is the integer models that the gates of the next steps are checked against, at ${n0(FS)} samples a second (${SAMPLES_PER_BIT} to a bit) and ${SINE_W} bits to a sample. Toggle bits; add noise and watch the receiver's decision (the lower trace, and a dot where the bit is read) go wrong.</p>`,
      widget: fskWidget,
      challenge: {
        kind: 'quiz', question: 'Why does Bell 103 have two pairs of tones, one for each side?',
        options: ['Both modems can transmit at once on the one pair of wires, each side listening on the other side\'s pair', 'A single pair would not fit in the band', 'To send two bits per symbol', 'Each pair is a backup for the other'],
        answer: 0,
        explain: `The wire is shared by both directions. Frequency division gives each its own part of the band (${BELL103.originate.space}–${BELL103.originate.mark} Hz and ${BELL103.answer.space}–${BELL103.answer.mark} Hz), told apart by filters; later modems (V.32) used an echo canceller to share the same band instead.`,
        why: ['', 'Four tones fit easily; the whole band is 3100 Hz wide.', 'A tone pair sends one bit per symbol, whichever side it is.', 'A pair is used for the direction of one side, not both.'],
      },
    },
    {
      title: 'An oscillator from an adder',
      get body() {
        const nco = stats(NCO), rom = stats(SINE_ROM), accN = nands(register(ACC_BITS)) + nands(rca(ACC_BITS)), snr = ncoSnrDb(), p = period(NCO);
        return `
        <p>To make a tone in gates, count in steps. A <strong>phase accumulator</strong> is a ${ACC_BITS}-bit register fed by an adder: at every clock it adds the <em>tuning word</em> to itself and wraps. The register is a fraction of a turn; its top ${SINE_K} bits address a ${2 ** SINE_K}-word ROM of one sine period, in ${SINE_W}-bit offset binary (31.5 + 31.5 · sin), so the sign of the signal is simply the top bit. The whole circuit is the <span data-show="acc">accumulator</span> with its <span data-show="add">adder</span> and the <span data-show="sine">sine table</span>: a <strong>numerically controlled oscillator</strong>.</p>
        <p>The frequency is f = word · f<sub>clk</sub> / 2<sup>${ACC_BITS}</sup>. At f<sub>clk</sub> = ${n0(FS)} Hz one step of the word is ${nf(FS / 2 ** ACC_BITS, 2)} Hz, so the tones come out near but not at the published ones: ${BELL103.originate.space} Hz needs word ${tuningWord(BELL103.originate.space)} and gives ${hz(FTW_SPACE)} Hz; ${BELL103.originate.mark} Hz needs ${FTW_MARK} and gives ${hz(FTW_MARK)} Hz; ${BELL103.answer.space} Hz and ${BELL103.answer.mark} Hz are words ${tuningWord(BELL103.answer.space)} and ${tuningWord(BELL103.answer.mark)}. The error is under half a step, and a telephone filter will not mind.
        The word is the control: change it between two clocks and the next sample continues from the same phase, which is the phase-continuous switch FSK wants for free.</p>
        <p><strong>Cost.</strong> The ${ACC_BITS}-bit register and ripple adder are ${n0(accN)} NANDs; the sine table is ${n0(rom.nands)}, a decoder and an OR plane like the ROM of chapter 10, so the oscillator is ${n0(nco.nands)} NANDs and ${nf((rom.nands / nco.nands) * 100, 0)} % of that is the table. The critical path is clock-to-q, a ${ACC_BITS}-stage carry and setup: ${p} NAND delays, ${nf(p * PS_PER_NAND / 1000, 2)} ns at ${PS_PER_NAND} ps a delay, so this circuit could be clocked ${n0(Math.round(1e12 / (p * PS_PER_NAND) / FS))} times faster than the ${n0(FS)} Hz it needs. A real modem gains by serving several channels with one accumulator in turn, or by a quarter-wave table (a quarter of the words and a sign flip) at the price of a few more gates.</p>
        <p><strong>What it is worth.</strong> Six bits of phase and six of amplitude put the output at ${db(snr)} signal to its own error, measured over a period of the mark tone (six dB a bit). That is enough for FSK and below the ${snrLine} dB of a good line: a 256-QAM modem would need a larger table than this one.</p>
        <div class="try">Press <strong>1070 Hz</strong>, then <strong>Run 256 clocks</strong>; then 2225 Hz. Open the NCO and watch the register on the clock.</div>`;
      },
      scene: ncoScene,
      challenge: {
        kind: 'quiz', question: `Which tuning word gives a tone nearest ${BELL103.answer.space} Hz at ${n0(FS)} Hz?`,
        options: [`${tuningWord(BELL103.answer.space)}: ${BELL103.answer.space} · 2^${ACC_BITS} / ${n0(FS)} rounded`, `${BELL103.answer.space}: the word is the frequency`, `${Math.round(FS / BELL103.answer.space)}: clocks per cycle`, `${tuningWord(BELL103.answer.space) * 2}: twice the step`],
        answer: 0,
        explain: `word = f · 2^${ACC_BITS} / f_clk = ${nf((BELL103.answer.space * 2 ** ACC_BITS) / FS, 2)}, rounded to ${tuningWord(BELL103.answer.space)}, giving ${hz(tuningWord(BELL103.answer.space))} Hz.`,
        why: ['', 'The accumulator wraps every 2^13 / word clocks. A word of 2025 would turn through a quarter of a turn per clock (4.7 kHz).', 'That is the period in clocks, the reciprocal of what the accumulator wants.', 'Twice the word is twice the frequency.'],
      },
    },
    {
      title: 'FSK in gates',
      get body() {
        const tx = nands(FSK_TX), rx = nands(FSK_RX), ln = nands(MODEM_LINE), all = nands(FSK_LINK), pRx = period(FSK_RX);
        return `
        <p>The modem pair is three boxes on one clock: the <span data-show="tx">transmitter</span> (a multiplexer picks one of two tuning words by the data bit, and the NCO of the last step does the rest: ${n0(tx)} NANDs), <span data-show="line">the line</span>, and the <span data-show="rx">receiver</span> (${n0(rx)} NANDs). The line is one part with a delay of two clocks and a <em>hit</em> input that flips a sample's sign for as long as it is high (${n0(ln)} NANDs of delay registers). It stands for the copper, the hybrid transformer and the exchange; <strong>it is the one box here that does not end in gates</strong>, and opening it shows the noise model it stands for, with those registers a button away.</p>
        <p>The receiver is a <strong>non-coherent demodulator</strong>: it never learns the phase of the carrier. The sign bit of a sample is the slicer (positive half of the sine: 1). A flip-flop remembers the sign one clock ago, an AND finds the rising edge, and a 5-bit counter counts the clocks since the last one (saturating at 31). At each rising edge the counter holds the period: the space tone has ${nf(FS / ncoHz(FTW_SPACE), 1)} clocks between edges, the mark ${nf(FS / ncoHz(FTW_MARK), 1)}, so a period of ${RX_LONG} or more is a 0 and anything less a 1, and the decision register loads it. The counter restarts at 1. The decision is updated once per carrier cycle, so it follows a change of tone within one cycle (about a millisecond); the bit is read in the three-quarter point of each bit time.</p>
        <p>Three honest limits. <strong>Bit timing is shared:</strong> the panel reads each bit at a known clock, while a real receiver recovers the bit clock from the transitions (a UART does it with a sampling clock). <strong>Noise breaks it first:</strong> one extra edge from a noise spike near a zero crossing shortens one period, and the previous step\'s noise slider shows the first errors at a few steps rms; a correlator over a whole bit does better and costs multipliers. <strong>The answering band does not fit at this clock:</strong> ${BELL103.answer.space} and ${BELL103.answer.mark} Hz are ${nf(FS / ncoHz(tuningWord(BELL103.answer.space)), 1)} and ${nf(FS / ncoHz(tuningWord(BELL103.answer.mark)), 1)} clocks a cycle, less than a clock apart, so the same counter would have to average several cycles or run faster.</p>
        <p><strong>Cost.</strong> The pair is ${n0(all)} NANDs for 300 b/s: ${n0(tx)} in the transmitter (its sine table is the bulk), ${n0(ln)} in the line and ${n0(rx)} in the receiver. The receiver's longest path is ${pRx} NAND delays (${nf(pRx * PS_PER_NAND / 1000, 2)} ns). The gates agree with the integer models of <code>comm/modem.ts</code> at every output of every cycle (tests/comm-modem.test.ts).</p>
        <div class="try">Press <strong>Send</strong> with "Hi". Then tick <strong>Hit the line</strong> and send again: the hit flips the samples' sign through half of the fourth data bit.</div>`;
      },
      scene: linkScene,
      challenge: {
        kind: 'quiz', question: `The receiver counts ${RX_LONG} or more clocks between rising edges as a 0. A noise spike adds a spurious rising edge in the middle of a space tone's cycle. What does it decide?`,
        options: ['A 1 for one cycle: the shortened period is under the threshold', 'A 0, as the threshold only looks at the tone', 'It locks up until reset', 'It decides nothing: the decision register loads only on a full period'],
        answer: 0,
        explain: 'The counter restarts at every rising edge, so it measures the gap to the spurious edge, about half a period, and the register loads a mark. The next true edge measures the other half, also short. Two wrong cycles, then it recovers: a burst shorter than a bit may or may not flip the bit read at the three-quarter point.',
        why: ['', 'The threshold looks at the interval between edges whatever caused them.', 'The counter saturates and restarts; nothing latches up.', 'The register loads at every rising edge of the sign, true or spurious.'],
      },
      more: {
        pitfall: `<p>Reading the decision as if it were the bit. The register changes within a carrier cycle of a tone change, but it can show a stray value during the cycle that straddles a transition. The bit clock reads it in the three-quarter point of the bit, when it has settled, and that is the job a UART-like receiver does with a sampling clock.</p>`,
      },
    },
    {
      title: 'Phase and amplitude',
      get body() {
        const mul = nands(arrayMul(SINE_W)), add = nands(rca(SINE_W + 1));
        return `
        <p>FSK sends one bit per change of tone. To send more in the same band, change more of the carrier at once. A sinusoid has three numbers, frequency, amplitude and phase; keeping the frequency, <em>both</em> of the others can carry data. Written another way: <strong>x(t) = I cos 2πft − Q sin 2πft</strong>. Cosine and sine are orthogonal (the integral of their product over a cycle is zero), so I and Q do not disturb each other and a receiver can recover them separately. One symbol is one point (I, Q) of the plane; its distance from the centre is the amplitude and its angle the phase.</p>
        <p>Four points at 90° are <strong>QPSK</strong> (4-QAM), two bits a symbol. <strong>V.22</strong> (Bell 212A) sent ${bitsPerSymbol(mdm('v22'))} bits a symbol at ${mdm('v22').baud} baud, ${n0(mdm('v22').rate)} b/s, by the <em>change</em> of phase (DPSK: a receiver that knows only the difference needs no absolute reference). <strong>V.22bis</strong> kept the ${mdm('v22bis').baud} baud and the band and used sixteen points, 16-QAM, four bits a symbol: ${n0(mdm('v22bis').rate)} b/s, twice the data in the same spectrum. Nothing was gained from the line; the receiver only distinguished more points.</p>
        <p>Label the points with a <strong>Gray code</strong> (as chapter 42 did for pointers): neighbours differ in one bit, so the commonest error, a point mistaken for the nearest, costs one bit and not several. On a square grid, a Gray code on each axis does it. Pick a point below and read the carrier it makes: the light curve is the reference cosine.</p>
        <p><strong>Cost.</strong> Mixing is the new gate cost: I times a cosine and Q times a sine, then an adder. With the library's unsigned ${SINE_W}-bit array multiplier at ${n0(mul)} NANDs and a ${SINE_W + 1}-bit adder at ${n0(add)}, two multipliers and the adder come to about ${n0(2 * mul + add)} NANDs, plus the second table and sign handling. The receiver needs the same mixing, a carrier it has to recover and an equalizer, which is why QAM waited for cheap digital signal processing.</p>`;
      },
      widget: iqWidget,
      challenge: {
        kind: 'quiz', question: 'A 16-QAM point is moved to the next one to its right. In a Gray-labelled constellation, how many bits of the 4-bit label change?',
        options: ['One', 'Two', 'Four', 'It depends on the point; Gray guarantees nothing about 16-QAM'],
        answer: 0,
        explain: 'On a square grid a Gray code on each axis (2 bits for I, 2 for Q) makes every pair of horizontal or vertical neighbours differ in one bit. tests/comm-modem.test.ts checks that for every neighbour pair of 4-, 16-, 64- and 256-QAM.',
        why: ['', 'With a plain binary label 01 → 10 changes two; the Gray label 01 → 11 changes one.', 'Four would be an inversion of every bit, an opposite corner of the grid.', 'The guarantee holds on both axes of every square constellation.'],
      },
    },
    {
      title: 'Noise decides how many points',
      get body() {
        const mc = monteCarlo(constellation('qam', 16), 18, 40000, 3), cf = serClosed('qam', 16, dbToRatio(18));
        return `
        <p>More points, finer distinctions. Normalize the average symbol energy to 1 and put noise of variance N0/2 on each axis: the points of an M-QAM square sit ${nf(constellation('qam', 4).dmin / constellation('qam', 256).dmin, 0)} times closer at 256 than at 4, and a decision boundary lies half-way between neighbours. The symbol is wrong when the noise on either axis crosses it, so for square M-QAM (L = √M)</p>
        <p style="text-align:center"><strong>P<sub>axis</sub> = 2 (1 − 1/L) · Q(√(3 · Es/N0 / (M − 1))),&nbsp;&nbsp;P<sub>symbol</sub> = 1 − (1 − P<sub>axis</sub>)²</strong></p>
        <p>with Q the Gaussian tail of chapter 41. The "M − 1" is the story: four times the points (two bits) needs four times the SNR, 6 dB, to keep the rate of error. At one wrong symbol in a million, QPSK needs ${db(needDb(4))}, 16-QAM ${db(needDb(16))}, 64-QAM ${db(needDb(64))}, 256-QAM ${db(needDb(256))} and 1024-QAM ${db(needDb(1024))}. On a ${snrLine} dB line the largest that clears the bar is ${4 ** maxBits}-QAM, ${2 * maxBits} bits a symbol, ${fmtRate(2 * maxBits * mdm('v34').baud)} at V.34's ${n0(mdm('v34').baud)} baud: the ${fmtRate(v34.rate)} of V.34 came from the other ${nf(v34.rate / mdm('v34').baud - 2 * maxBits, 1)} bits a symbol, which uncoded QAM cannot hold at this SNR.</p>
        <p>The closed form is exact for squares; for PSK beyond four points it is the usual two-neighbour approximation. Both are checked in the tests against a seeded Monte Carlo: at 18 dB the closed form for 16-QAM says ${cf.toExponential(2)} a symbol and 40 000 random symbols through Gaussian noise gave ${mc.ser.toExponential(2)}. The widget makes the same comparison live, 20 000 symbols at a time.</p>
        <p><strong>Where the rest went.</strong> Uncoded 256-QAM sits ${db(gapToShannonDb(256, 1e-6))} above Shannon's floor of ${db(ratioToDb(snrNeeded(8)))} at 10⁻⁶; the large-constellation formula for the gap, (Q⁻¹(P/4))² / 3, gives ${db(gapDb(1e-6))}. Closing it is what trellis coding (V.32 on) and signal shaping do, by spending a bit of redundancy to get the coded points further apart than the raw ones. <a href="#/c/codes/7">Chapter ${numOf('codes')}</a> puts the codes themselves on one axis against this limit.</p>`;
      },
      widget: constellationWidget,
      challenge: {
        kind: 'quiz', question: `A modem running 16-QAM at ${db(needDb(16))} (one symbol error in 10⁶) is upgraded to 256-QAM at the same symbol rate. About how much more SNR does the same error rate need?`,
        options: [`${db(needDb(256) - needDb(16), 0)}: 12 dB, six per two bits`, 'The same: the decision regions rescale', '3 dB: one more bit', '24 dB: the squared number of points'],
        answer: 0,
        explain: `Two doublings of the points on each axis cost 4 times the SNR twice: ${db(needDb(16))} to ${db(needDb(256))}, a difference of ${db(needDb(256) - needDb(16))}.`,
        why: ['', 'The energy is fixed, so the grid of 256 points is finer and the same noise crosses more boundaries.', 'One more bit a symbol is 3 dB; 16 to 256 is four bits.', '24 dB would be a 256-fold increase. The points grow 16-fold and the SNR needed grows about as M, so it is about 12 dB.'],
      },
    },
    {
      title: '300 b/s to 56 kb/s',
      get body() {
        return `
        <p>Each generation of voice-band modem is a point on the figure below. The ladder: <strong>Bell 103</strong> ${fmtRate(300)}, one bit a symbol; <strong>V.22</strong> ${fmtRate(1200)} on ${mdm('v22').baud} baud and two bits; <strong>V.22bis</strong> ${fmtRate(2400)} on the same baud and four; <strong>V.32</strong> ${fmtRate(9600)} on ${mdm('v32').baud} baud, four data bits and one coding bit a symbol, an <em>echo canceller</em> letting both directions use the whole band; <strong>V.32bis</strong> ${fmtRate(14400)}; <strong>V.34</strong> ${fmtRate(v34.rate)} at up to ${mdm('v34').baud} baud, ${nf(bitsPerSymbol(mdm('v34')), 1)} bits a symbol, after a probing phase that measures the line and picks a rate that suits it. Three things made it: the baud rate rose until the band was full, the points per symbol rose until the SNR was spent, and coding spent the rest of the margin (V.32 onwards).</p>
        <p>Every dot sits to the right of Shannon's curve: ${nf(ratioToDb(snrNeeded(mdm('v22bis').rate / B)), 1)} dB at the least for V.22bis, ${nf(ratioToDb(snrNeeded(v34.rate / B)), 1)} dB for V.34, which real lines had. The ladder ended at the curve because the line could not give more.</p>
        <p><strong>V.90 and 56 kb/s.</strong> It does not climb the curve; it changes the channel. The server's side of the call is digital: bits go to the exchange as PCM, ${n0(PCM_RATE)} eight-bit samples a second (${n0(DS0)} b/s, a DS0), and only the last mile is analog. The server picks the PCM codewords whose levels the line card turns into voltages, and the user's modem reads each one off the loop. A symbol is a PCM level, ${n0(PCM_RATE)} a second, taken from a subset of the 256 codewords worth 7 bits: ${n0(PCM_RATE * 7)} b/s. The bandwidth is the 4 kHz that 8 kHz sampling gives. Through 4 kHz, 7 bits per real symbol need ${db(ratioToDb(snrNeeded(56000 / 4000)))}; through ${n0(B)} Hz, as V.34 saw the line, ${db(ratioToDb(snrNeeded(56000 / B)))}. The difference is the analog-to-digital conversion on the user's side of an ordinary call, which adds its own quantization noise (about ${snrLine} dB here, our assumption) and capped V.34. With a digital server, the downstream path has no such step, and a short, clean loop can have the SNR; hence "up to", and about 53 kb/s in practice under power limits. Upstream, where the user's modem is the analog source, stays V.34. Shannon holds in both directions; V.90 found a channel for which the bound was higher.</p>
        <p>That is the end of the voice band. The copper itself passes far more, but no one carrier can use it: <a href="#/c/carriers/0">Many carriers</a> takes it from here.</p>`;
      },
      widget: milestonesWidget,
      challenge: {
        kind: 'quiz', question: 'What did V.22bis change relative to V.22, to double the bit rate on the same line?',
        options: ['Points per symbol: 4 bits a symbol (16-QAM) instead of 2, at the same 600 baud', 'The baud rate, from 600 to 1200', 'The carrier frequency, to a clearer part of the band', 'It added an echo canceller'],
        answer: 0,
        explain: `Both are ${mdm('v22').baud} baud in the same two bands. Rate = baud × bits per symbol: ${mdm('v22').baud} × 2 = ${mdm('v22').rate}, ${mdm('v22').baud} × 4 = ${mdm('v22bis').rate}.`,
        why: ['', 'The symbol rate stayed at 600; that is why the old bands were kept.', 'The carriers stayed at 1200 and 2400 Hz.', 'Echo cancellation arrived with V.32, which shares a band between the directions.'],
      },
    },
  ],
};
