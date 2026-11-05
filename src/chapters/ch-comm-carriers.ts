// Many carriers (level Communication): why split a channel into thousands of tones, and what that takes. The FFT in gates is lib/fft.ts, the butterfly, an 8-point network and a streaming pipeline,
// compared with the integer model comm/fftfix.ts on every register every clock (tests/comm-fft.test.ts). Water-filling, loading, the peak and the carrier offset are comm/carriers.ts, closed forms held
// to searches and to runs of the real transform (tests/comm-carriers.test.ts). The tones and the prefix are comm/fourier.ts; ADSL's loop is comm/modem.ts's illustrative model. Tones and ADSL came from Modems.

import { blockTime, dataShare, equalizerTaps, flatBest, flatPower, loadBits, offsetSirDb, SYSTEMS, waterFill } from '../comm/carriers';
import { fftSnrDb, streamLatency, twiddleCount } from '../comm/fftfix';
import { fftMults, ofdmLink, randomQpsk } from '../comm/fourier';
import { ADSL, bitLoad, DOWN_TONES, gapDb, snrForSer, toneSnrDb } from '../comm/modem';
import { arrayMul } from '../lib/muldiv';
import { fftDelay, fftNet, fftStream, fxCmul, fxCore, fxRoot, fxRot45 } from '../lib/fft';
import { flatten } from '../sim/flatten';
import { stats } from '../sim/stats';
import { analyzeTiming, PS_PER_NAND } from '../sim/timing';
import { BF_K, BF_N, bfApi, breakWidget, butterflyScene, nearZero, net8Scene, netApi, paprDbAt, STREAM_N, streamApi, streamScene, waterWidget, wordWidget } from '../widgets/carriers';
import { adslWidget } from '../widgets/modem';
import { ofdmWidget } from '../widgets/fourier';
import { numOf } from './order';
import type { Chapter, Step } from './types';

const nf = (x: number, d = 1) => x.toFixed(d);
const n0 = (x: number) => Math.round(x).toLocaleString('en');
const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const us = (x: number) => `${nf(x * 1e6, x < 1e-5 ? 2 : 1)} µs`;
const W = 10;
const db = (x: number, d = 1) => `${nf(x, d)} dB`;
const fmtRate = (x: number) => (x >= 1e6 ? `${+(x / 1e6).toPrecision(3)} Mb/s` : x >= 1e3 ? `${+(x / 1e3).toPrecision(3)} kb/s` : `${+x.toPrecision(3)} b/s`);
const adsl3 = bitLoad(3, -120, gapDb(1e-7)), adsl5 = bitLoad(5, -120, gapDb(1e-7));
const adslMults = fftMults(ADSL.tones * 2);
// G.992.1's cyclic prefix in samples, and data blocks to one sync block: 4312.5 × 512 / 544 × 68 / 69 = 4000 exactly
const ADSL_CP = 32, ADSL_DATA = 68;

/** The illustrative loop of comm/modem.ts as gains, with the flat power of the modem chapter as the budget. */
const loopGains = (km: number) => DOWN_TONES.map((k) => 10 ** (toneSnrDb(k, km, -120) / 10));
const GAP = 10 ** (gapDb(1e-7) / 10);

const unpack = (v: number) => ({ re: ((v % 1024) + 512) % 1024 - 512, im: ((Math.floor(v / 1024) % 1024) + 512) % 1024 - 512 });
const mag = (v: number) => { const c = unpack(v); return Math.hypot(c.re, c.im) / 512; };

/** Moved from Modems (chapters/stepmoves.ts). */
const tonesStep: Step =   {
    title: 'Many tones, one FFT',
    get body() {
      const N = ADSL.tones * 2, sy = randomQpsk(31, 1), pv = randomQpsk(31, 1001), taps = [1, 0, 0, 0, 0, 0.6], none = ofdmLink(sy, pv, 64, 0, taps);
      return `
      <p>Over the megahertz it can pass, a copper pair is far from flat, and one fast carrier meets all of it. The alternative is many slow carriers, each too narrow to see the slope. Run them at once and the receiver must pull them apart, which looks like a bank of filters. It is not. Choose the tones to fit a whole number of cycles in a block of N samples, and any two have zero overlap over that block: Σ e<sup>j2π(k−m)n/N</sup> = 0 unless k = m. They are <strong>orthogonal</strong>, though their spectra overlap heavily, so a tone can be read by correlating with it, and no guard band is spent.</p>
      <p>Correlating with every tone is the <strong>discrete Fourier transform</strong>, X[k] = Σ x[n] e<sup>−j2πkn/N</sup>, and summing every tone with its QAM point as the amplitude is its inverse. The modem is therefore two transforms and no oscillators: bits to a point per tone, an inverse transform to a block of samples, and at the far end a transform back. By its definition that takes N² complex multiplications. The <strong>FFT</strong> splits a transform of N into two of N / 2 on the even and odd samples, joined by one multiplication per pair (a butterfly), and recursion leaves N / 2 · log₂ N. For ADSL's ${n0(N)} points that is ${n0(adslMults)} a symbol against ${n0(N * N)}, ${nf(N * N / adslMults, 0)} times fewer. Giving tone N − k the conjugate of tone k makes the block real, which is how ${n0(N)} points carry ${ADSL.tones - 1} tones on one wire (G.992.1 numbers the tones 0 … ${ADSL.tones - 1}; tone 0 is DC and stays empty, and the tone at N / 2 does not exist). At ${n0(ADSL.symbolRate)} symbols a second that is ${nf(adslMults * ADSL.symbolRate / 1e6, 1)} million complex multiplications a second each way, and a complex multiplication is four real ones (${n0(nands(arrayMul(16)))} NANDs each as a 16-bit array), if you build it, and the next steps do.</p>
      <p>What it buys is the channel's whole equalizer. A channel is a convolution, and the transform turns <em>circular</em> convolution into one multiplication per tone: Y[k] = H[k] X[k]. A real channel convolves linearly, so the sender copies the block's last samples in front of it, the <strong>cyclic prefix</strong>. If the prefix is at least as long as the echo, the receiver cuts it off and what remains is exactly circular, so each tone needs one complex division. In the widget an echo of 5 samples leaves an error vector of ${nf(100 * none.evm, 1)} % with no prefix and none with 5. ADSL's numbers show the price: ${n0(N)} × ${ADSL.spacingHz.toLocaleString('en')} Hz is ${nf(N * ADSL.spacingHz / 1e6, 3)} MHz of samples, a prefix of ${ADSL_CP} takes that from ${ADSL.spacingHz.toLocaleString('en')} to ${nf(N * ADSL.spacingHz / (N + ADSL_CP), 1)} blocks a second, and one sync block in ${ADSL_DATA + 1} takes it to the ${n0(ADSL.symbolRate)} the standard quotes. Later steps load those tones.</p>
      <div class="try">With an echo at 5 samples, raise <strong>Prefix</strong> from 0: the cloud tightens and collapses on the points at exactly 5. Then set <strong>Echo</strong> to 0.95 and read the weakest tone's gain. Nothing is wrong yet, but with noise on the line a tone at that gain would carry almost nothing.</div>`;
    },
    widget: ofdmWidget,
    more: {
      derive: `<p>With the prefix, the received samples of the block are y[n] = Σ h[m] x[(n − m) mod N], since every x[n − m] that reaches back before the block is a copy of the block's own tail. Substitute x[n] = (1 / N) Σ X[k] e<sup>j2πkn/N</sup> and each tone comes out multiplied by Σ h[m] e<sup>−j2πkm/N</sup> = H[k]. tests/comm-fourier.test.ts checks the FFT's output against H[k] X[k] on an FIR channel, with the block before it in the stream.</p>`,
      real: `<p>Wi-Fi from 802.11a on (802.11b is not OFDM), DVB, LTE and 5G all run this scheme and call it OFDM (LTE's uplink, and 5G's when coverage is short, a DFT-spread form of it, which lowers the peak-to-average ratio). Its known weaknesses are in the arithmetic: the sum of many tones has a high peak-to-average ratio, which strains the line driver, and a frequency offset at the receiver breaks the orthogonality.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'An echo arrives 40 samples after the direct path, and a block of tones has a cyclic prefix of 32. What does the receiver see after its FFT?',
      options: ['Every tone carries interference from the others, which a division per tone cannot remove', 'Only the highest tones are affected', 'Nothing changes: the FFT has already separated the tones', 'The echo is discarded with the prefix, so the signal is cleaner'],
      answer: 0,
      explain: 'Eight samples of the previous block leak in and eight wrap around lost, so the channel is no longer a circular convolution over the block. Orthogonality fails, and each output is a mix of tones. A prefix covers an echo only up to its own length.',
      why: ['', 'The disturbance in time spreads over the whole block, and so over all tones, not only a band.', 'The FFT separates tones only when the block is an exact circular convolution of them.', 'Only what falls inside the prefix is discarded, and this echo reaches past it.'],
    },
  };

const adslStep: Step =   {
    title: 'ADSL: many carriers',
    get body() {
      return `
      <p>The voice band is a property of the exchange's filters, not of the copper. The twisted pair itself passes more than a megahertz, with an attenuation that grows as the square root of frequency and in proportion to length, and with crosstalk from neighbours that grows with frequency too. So the SNR of the pair is large at low frequencies and falls steeply: a single carrier either wastes the good part or runs into the bad part. <strong>ADSL</strong> (ITU-T G.992.1) gives each frequency what it can take. It cuts the band into <strong>${ADSL.tones} tone slots, ${ADSL.spacingHz.toLocaleString('en')} Hz apart</strong>, numbered 0 … ${ADSL.tones - 1} (up to ${nf((ADSL.tones * ADSL.spacingHz) / 1e6, 3)} MHz) and loads each with its own QAM: at ${n0(ADSL.symbolRate)} symbols a second per tone, that is a symbol every 250 µs on every tone at once.</p>
      <p>Training measures the SNR on every tone and assigns <strong>b<sub>k</sub> = ⌊log₂(1 + SNR<sub>k</sub> / Γ)⌋</strong> bits, from 0 to at most ${ADSL.maxBits}. Γ, the gap between uncoded QAM and Shannon\'s limit, is ${db(gapDb(1e-7))} uncoded at an error rate of 10⁻⁷ (it falls with coding). The widget uses an illustrative loop, 20 dB/km at 1 MHz and growing with √f, and a noise floor that you move: at 3 km and −120 dBm/Hz it loads ${adsl3.total} bits a symbol for ${fmtRate(adsl3.rate)}, at 5 km ${adsl5.total} bits and ${fmtRate(adsl5.rate)}. The rate follows the line, tone by tone; this is a negotiated rate, not a standard one.</p>
      <p>The tones are this chapter's inverse FFT, ${n0(adslMults)} complex multiplications a symbol for ${ADSL.tones * 2} points. The idea and the trade are what matter here: a single wide carrier needs one equalizer for a distorted channel, while many narrow ones each see a nearly flat one and take as many bits as that stretch of spectrum holds.</p>`;
    },
    widget: adslWidget,
    challenge: {
      kind: 'quiz', question: 'The same ADSL line gets 10 dB noisier at every frequency. Which statement is closest to what the bit loading does?',
      options: ['Every tone loses about 10/3 ≈ 3 bits, until the weak ones reach 0 and drop out; the highest tones go first', 'All tones lose one bit', 'The modem lowers the symbol rate', 'Only the lowest tones change'],
      answer: 0,
      explain: 'The bits on a tone are log₂(1 + SNR/Γ); 10 dB is a factor of 10, which is about 3.3 bits. Tones already near 1 or 2 bits cannot give 3: they carry nothing, and the highest tones, which start lowest, reach zero first.',
      why: ['', 'One bit is 3 dB; 10 dB is about three.', 'The symbol rate stays at 4000 a second; the bits per tone adapt.', 'Every tone sees the added noise. The ones with least SNR to start with lose their last bits first.'],
    },
  };

const carrierNewSteps: Step[] = [
  {
    title: 'The butterfly',
    get body() {
      return `
      <p>An FFT does one thing: <strong>y0 = a + W b, y1 = a − W b</strong>, where W is a root of unity, the twiddle. Everything else is which samples meet. In hardware both results are <strong>halved</strong>, one bit a stage, so the transform of N points gives X[k] / N and cannot grow out of its word. The halving is also where the rounding goes: both adders have their carry-in tied to 1 and drop the lowest bit. In the sum that carry rounds an odd total up; in the difference it is the two's complement's own +1, so an odd total rounds down. The two errors cancel exactly, y0 + y1 = a, with no rounding unit spent.</p>
      <p>Open <span data-show="core">the adders</span>: four, ${nands(fxCore(W, false))} NANDs at ${W} bits a part. What the twiddle costs depends on which it is. W = 1 is nothing. W = −j swaps the parts and exchanges one sum and one difference, so it is wires. This one, W₈¹ = (1 − j) / √2, is <span data-show="turn">a 45° turn</span>: re + im and im − re, each times 1/√2. A constant multiplier has no multiplier in it, only an adder for each signed digit of the constant after the first, ${nands(fxRoot(W))} NANDs each and ${nands(fxRot45(W))} for the turn. Any other twiddle needs the general complex multiplier: four ${W} × ${W} Booth multipliers and two adders, <strong>${n0(nands(fxCmul(W)))} NANDs</strong>. Counting butterflies, as the transform's usual N / 2 · log₂ N does, hides all of that, since ${(() => { const c = twiddleCount(8); return c.one + c.minusj; })()} of the ${fftMults(8)} in an 8-point FFT are wires and none of them needs that multiplier.</p>
      <div class="try">Set both to 0.6. Turn b until W·b lands on a: y0 becomes a, and y1 disappears. Then turn it another 180°.</div>`;
    },
    scene: butterflyScene,
    challenge: {
      kind: 'reach', goal: 'Make y1 vanish with |a| at least 0.4: W·b has to land exactly on a.',
      check: (st) => mag(Number(st.value('a'))) >= 0.4 && nearZero(Number(st.value('y1'))),
      hints: [`W₈¹ turns b by 45° clockwise (the twiddle is k = ${BF_K} of ${BF_N}). So b must start 45° ahead of a.`, 'With a at 0°, set b to +45°, at the same size.'],
      answer: 'y1 = (a − W b) / 2 is zero when W b = a. With |a| = |b| = 0.6, a at 0° and b at +45°, the turn brings b onto a. y1 is left with at most a few units of rounding, since 1/√2 is rounded in the table.',
      solve: (st) => bfApi.get(st)?.solve(),
    },
  },
  {
    title: 'Eight points, in gates',
    get body() {
      const c = twiddleCount(8);
      return `
      <p>A transform of N splits into two of N / 2, on the even and on the odd samples, and one column of butterflies joins them. Unroll the recursion and it is a network: log₂ N columns of N / 2 butterflies, no clock and no memory. The even and odd split, repeated, is why the inputs arrive in <strong>bit-reversed order</strong> (x4 next to x0, since 100 reversed is 001), and that is only wiring.</p>
      <p>Here it is at 8 points and ${W} bits a part, ${n0(nands(fftNet(8, W)))} NANDs. <span data-show="s0_0 s0_2 s0_4 s0_6">The first column</span> has only W⁰ twiddles, <span data-show="s1_0 s1_1 s1_4 s1_5">the second</span> W⁰ and −j, and <span data-show="s2_1 s2_3">only the last</span> has anything to multiply, the two 45° turns: ${c.root1 + c.root3} of the ${fftMults(8)} butterflies. That luck ends here. At 16 points the first general twiddles appear, and the same drawing costs ${n0(nands(fftNet(16, W)))} NANDs, ${nf(nands(fftNet(16, W)) / nands(fftNet(8, W)), 1)} times as much for twice the points. Unrolled, this design delivers a whole transform per settling time, which nothing on a phone line needs. The next step trades that for a clock.</p>
      <p>The inverse takes no new gates. Swap each sample's real and imaginary parts going in and coming out, and the same network computes Σ X e<sup>+j2πkn/N</sup> / N, the inverse as defined. So a modem's transmitter and receiver can share one design, and in half-duplex one instance.</p>
      <div class="try">Look at one impulse, then a tone, then two tones. Pick <strong>Random samples</strong> and read how small the tones are compared with the inputs.</div>`;
    },
    scene: net8Scene,
    challenge: {
      kind: 'reach', goal: 'Feed the network tone 3, so that all of it lands on X3.',
      check: (st) => { const v = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => mag(Number(st.value(`X${i}`)))); return v[3] > 0.8 && v.every((x, i) => i === 3 || x < 0.03); },
      hints: ['Choose One tone in the panel, then move the Tone slider.'],
      answer: 'A tone at index 3 adds in phase along one path through the three columns and cancels on every other: each output other than X3 is left with rounding, at most a few units in 512.',
      solve: (st) => netApi.get(st)?.tone(3),
    },
    more: {
      derive: `<p>Twiddle by twiddle: X[k] = E[k] + W<sup>k</sup> O[k] for k &lt; N / 2, and X[k + N / 2] = E[k] − W<sup>k</sup> O[k], since W<sup>k + N / 2</sup> = −W<sup>k</sup>. That sign is the butterfly. Each of the log₂ N levels has N / 2 of them.</p>`,
    },
  },
  {
    title: 'A sample every clock',
    get body() {
      const net16 = nands(fftNet(16, W)), s16 = nands(fftStream(16, W)), s64 = nands(fftStream(64, W)), s512 = nands(fftStream(512, 12)), lat = streamLatency(STREAM_N);
      const t = analyzeTiming(flatten(fftStream(STREAM_N, W))), ps = t ? t.period * PS_PER_NAND : 0, lines512 = Array.from({ length: 9 }, (_, i) => nands(fftDelay(512 / 2 ** (i + 1), 12))).reduce((a, b) => a + b, 0);
      return `
      <p>A real line delivers one sample at a time, so there is no reason to compute every butterfly at once. Each stage of a <strong>single-path delay-feedback</strong> pipeline has one butterfly, and a delay line as long as half the rest of its block. For the first half of a block the samples <span data-show="s0">go into the line</span>. For the second half each new sample meets its partner coming out: the sum goes on, the difference goes back into the line, and during the next half it leaves through the twiddle. ${Math.log2(STREAM_N)} stages with lines of ${STREAM_N / 2}, ${STREAM_N / 4}, ${STREAM_N / 8} and 1 samples take one sample in and give one tone out per clock, in bit-reversed order.</p>
      <p>Each butterfly gets its own clock cycle, so a few multipliers do the work of ${fftMults(STREAM_N)} butterflies, at the price of ${STREAM_N - 1} samples of memory and ${lat} edges of latency. <strong>${n0(s16)} NANDs against ${n0(net16)}</strong> unrolled at 16 points, and the gap widens fast: ${n0(s64)} at 64. The critical path at 16 points is ${nf(t?.period ?? 0, 0)} gate delays, one butterfly and one multiplier, since a register ends each stage: ${nf(ps / 1000, 1)} ns at the site's ${PS_PER_NAND} ps a gate, ${nf(1e6 / ps, 0)} million samples a second. ADSL's 512 points at 12 bits are ${n0(s512)} NANDs with the lines as flip-flops, ${nf(100 * lines512 / s512, 0)} % of it lines. A real design keeps them in a RAM. ADSL needs only ${nf((512 * ADSL.spacingHz) / 1e6, 2)} million samples a second, so a slower design could share one multiplier among the stages.</p>
      <p>The rules are in comm/fftfix.ts, and tests/comm-fft.test.ts compares every counter, every delay word and every output register with it, every clock, with random enables and resets.</p>
      <div class="try">Press <strong>Step</strong> a few times and watch stage 0 fill, then flip to its butterfly. Then <strong>Run a block</strong> at tone 3 and tone 11: count where each bar fills as they arrive.</div>`;
    },
    scene: streamScene,
    challenge: {
      kind: 'reach', goal: `Run a whole block of tone 5 through the pipeline, until all ${STREAM_N} tones are out with the largest on tone 5.`,
      check: (st) => { const a = streamApi.get(st); return !!a && a.tonesOut() === STREAM_N && a.peak() === 5; },
      hints: ['Set the Tone slider to 5, then Run a block.'],
      answer: `Reset sets each stage's counter to minus the samples ahead of it, then ${STREAM_N} samples go in and ${streamLatency(STREAM_N)} more clocks flush them. Tone 5 is the eleventh to arrive, counting from 1, since 0101 reversed is 1010, ten.`,
      solve: (st) => streamApi.get(st)?.run(5),
    },
  },
  {
    title: 'How many bits a sample',
    get body() {
      const a = fftSnrDb(512, 12, 8, 1), b = fftSnrDb(512, 16, 8, 1), c = fftSnrDb(64, 12, 16, 1), g = gapDb(1e-7), peak = paprDbAt(1e-3, 512);
      const bitsFor = (snr: number) => Math.floor(Math.log2(1 + 10 ** ((snr - g) / 10)));
      return `
      <p>Word length sets the noise the transform itself adds, and that noise is one more limit on a tone's bits. The rounding is about one unit per butterfly, every stage, wherever the signal sits. For one strong tone all that halving is free, since its energy all comes together. A real block is the opposite, since after the inverse transform it looks like noise: its tones are each about 1/√N of the samples, while the rounding stays one unit. Each doubling of N costs about 3 dB, each bit of the word gains 6.</p>
      <p>Measured on random blocks: 12 bits at 512 points leave ${nf(a)} dB, 16 bits ${nf(b)} dB, and 12 bits at 64 points ${nf(c)} dB. ADSL's largest constellation of ${ADSL.maxBits} bits needs ${nf(g + 10 * Math.log10(2 ** ADSL.maxBits - 1), 0)} dB at the gap Γ = ${nf(g)} dB. So 12 bits would hold a tone to ${bitsFor(a)} bits whatever the line was like, and 16 bits clear the top constellation by only ${nf(b - (g + 10 * Math.log10(2 ** ADSL.maxBits - 1)), 0)} dB. A block's peak takes more: once in 1000 blocks it is ${nf(peak, 1)} dB over its mean at 512 points, and a word has to leave room for that or clip.</p>
      <p>Hardware often scales conditionally, shifting a stage only when a result would overflow, which keeps small blocks from losing bits they did not need to. The fixed halving here is the simplest choice that cannot wrap.</p>
      <div class="try">At 64 points, find how many bits leave room for a 9-bit tone. Then move to 4096 points with the same word.</div>`;
    },
    widget: wordWidget,
    challenge: {
      kind: 'quiz',
      question: 'A 512-point FFT at 12 bits a part leaves too little SNR on its tones. Which single change adds about 6 dB, and what does it cost?',
      options: ['One more bit a part: all the adders, multipliers and delay words grow by a bit', 'Doubling N: more samples average the rounding away', 'Dropping the per-stage halving: it wastes a bit a stage, and the tones would simply be larger', 'Rounding in the adders instead of truncating: the adders here already round, so nothing is left to gain there'],
      answer: 0,
      explain: 'Rounding noise is fixed at about one unit, so each extra bit halves it relative to the signal, 6 dB. The multipliers grow fastest, roughly with the square of the width.',
      why: ['', 'A tone of a noise-like block gets relatively smaller as N grows, so doubling N costs about 3 dB.', 'Without halving, a pure tone at full scale overflows the word in the first stages.', 'That is true of the rounding here, but it is not a way to add 6 dB.'],
    },
  },
  {
    title: 'Water-filling',
    get body() {
      const g = loopGains(3), B = g.length, wf = waterFill(g, B, GAP), fl = flatPower(g, B, GAP), lo = loadBits(g, B, GAP, ADSL.maxBits);
      const g5 = loopGains(5), wf5 = waterFill(g5, g5.length, GAP), fl5 = flatPower(g5, g5.length, GAP), fb5 = flatBest(g5, g5.length, GAP), low = [1, 0.1], lw = waterFill(low, 2);
      return `
      <p>Each tone is a small channel of its own, with its own gain over noise g<sub>k</sub>, and the transmitter has one power budget. How should it spend? The bits a tone carries are log₂(1 + g p / Γ), a curve that flattens: the first watt on a good tone buys far more than the hundredth. Maximizing the sum with Σ p fixed gives an answer with a picture: <strong>p<sub>k</sub> = μ − Γ / g<sub>k</sub></strong> where that is positive, zero elsewhere. Draw a floor of height Γ / g over each tone and pour the budget in: the water finds one level μ, deep over the good tones, and the bad ones stay dry. With floors of 1 and 10 and a budget of 2, the level reaches ${nf(lw.level, 0)}, all of it on the first tone: giving the second any power is a loss, however little.</p>
      <p>At Γ = 0 dB this is Shannon's capacity for parallel channels; with a gap it is the best a QAM of that gap can do. Either way it tells how much a real scheme gives up. Hardware needs whole bits, and <strong>greedy loading</strong> (Hughes-Hartogs) gets them: add one bit at a time to the tone where it costs least, Γ 2<sup>b</sup> / g. The costs on each tone rise, so greedy is optimal, and tests/comm-carriers.test.ts checks it against every allocation on small cases. Whole bits never lose more than a bit a tone.</p>
      <p>Then a surprise. On the last step's illustrative 3 km loop, at a gap of ${nf(gapDb(1e-7))} dB, water-filling carries ${n0(wf.total)} bits a block on all ${wf.used} tones, and flat power on the same tones ${n0(fl.total)}: moving power gains ${nf(wf.total - fl.total, 1)} bits, and greedy whole bits give ${n0(lo.total)}. At 5 km the tones are not all worth using. Flat power over all of them carries ${n0(fl5.total)} bits, flat power over the best ${fb5.used} ${n0(fb5.total)}, and water-filling's ${wf5.used} tones ${n0(wf5.total)}. Choosing the tones is what matters, and shaping the power on them adds little. That is lucky, since <strong>ADSL cannot water-fill much</strong>: a spectral mask caps the power on each tone so as not to disturb neighbouring pairs in the same cable. Its bits follow the SNR, as the last step showed, with its power nearly flat.</p>
      <div class="try">Drop <strong>Signal</strong> to 10 dB with the tap on, and read the gain over flat. Then raise it to 60 dB. Then turn up <strong>Gap Γ</strong>.</div>`;
    },
    widget: waterWidget,
    challenge: {
      kind: 'quiz',
      question: 'Two tones have gains over noise 1 and 2, and the budget is 3 (Γ = 1). What does water-filling give each?',
      options: ['1.25 and 1.75: a level of 2.25 over floors of 1 and ½', '1 and 2: power in proportion to gain', '1.5 and 1.5: the same to each', '0 and 3: all to the better tone'],
      answer: 0,
      explain: 'μ − 1 + μ − ½ = 3 gives μ = 2.25, so the powers are 1.25 and 1.75. The better tone gets more power, but not in proportion. Both floors are below the level, so neither stays dry.',
      why: ['', 'That rule overfeeds the better tone: the curve flattens, so its last watts buy less than the other tone\'s.', `That is the flat plan: ${nf(flatPower([1, 2], 3).total, 2)} bits against water-filling\'s ${nf(waterFill([1, 2], 3).total, 2)}. Close, as flat usually is when power is plentiful, but below.`, 'The other tone\'s floor of 1 is below the level, so its first watt beats the good tone\'s last.'],
    },
    more: {
      derive: `<p>Lagrange on Σ log₂(1 + g<sub>k</sub> p<sub>k</sub> / Γ) with Σ p<sub>k</sub> = P: every tone in use has the same marginal rate, g / (Γ + g p) = 1 / μ, so p = μ − Γ / g. A tone whose floor is above μ would get negative power, so it gets none. A gap Γ only multiplies the floors, which is why it needs no second algorithm. In the tests, no small move of power between tones ever beats the result, and flat plans never do.</p>`,
    },
  },
  {
    title: 'What breaks a block of tones',
    get body() {
      const p512 = paprDbAt(1e-3, 512), p64 = paprDbAt(1e-3, 64);
      return `
      <p><strong>The peak.</strong> A block is a sum of many independent tones, so by the central limit theorem each sample is nearly Gaussian, and each sample's power nearly exponential. So the chance of a block peaking above x times its mean is 1 − (1 − e<sup>−x</sup>)<sup>N</sup>. Once in 1000 blocks that is ${nf(p64, 1)} dB at 64 points and ${nf(p512, 1)} dB at 512: the line driver and converters must stay linear about ${nf(p512 / 6.02, 1)} bits above where the signal mostly sits, or clip and splash noise over every tone. Single-carrier QAM has far less. This is why LTE's uplink, and 5G's when coverage is short, spread the tones with a second DFT to get a single carrier's lower peak back: a phone's power amplifier pays for the peak.</p>
      <p><strong>A carrier that is off.</strong> Tones are orthogonal only if the block holds a whole number of cycles of each. If the receiver's oscillator is off by a fraction ε of the tone spacing, tone k's energy leaks into tone k + d in proportion to |sin π(d + ε) / (N sin(π(d + ε) / N))|. Every tone leaks into every other, so a stronger signal changes nothing: the interference is a ceiling. At ε = 0.1 what stays over what leaks in is ${nf(offsetSirDb(0.1, 64), 1)} dB, and at 0.02 it is ${nf(offsetSirDb(0.02, 64), 1)} dB. Narrow tones are the catch: crystal oscillators are good to tens of parts per million, 20 of them at 5.2 GHz is ${n0(5.2e9 * 20e-6 / 1000)} kHz, and Wi-Fi's tones are 312.5 kHz apart. So a receiver measures the offset from a preamble, and then tracks it with pilot tones.</p>
      <p><strong>A long echo.</strong> That one is already known: past the prefix, the block stops being a circular convolution. And its alternative is why any of this is worth it. One wide carrier must undo the same echo with a filter: an echo of 0.9 at 40 samples needs a filter ${n0(equalizerTaps(0.9, 40, 0.01))} samples long to get within 1 %, and a real channel has echoes throughout that span. The block needs one complex division per tone.</p>
      <div class="try">Raise the offset until what stays over what leaks in falls under ${nf(snrForSer('qam', 64, 1e-3), 0)} dB, the SNR uncoded 64-QAM needs for one symbol error in 1000. Then compare the peak at 64 and at 4096 points.</div>`;
    },
    widget: breakWidget,
    challenge: {
      kind: 'quiz',
      question: 'A Wi-Fi receiver leaves a carrier offset of 0.1 of a tone uncorrected. The signal then gets 20 dB stronger. What happens to the tones?',
      options: ['Almost nothing: what leaks scales with the signal, so the ceiling on the SNR stays where it is', 'They clear up by 20 dB, like any other noise', 'The offset falls, since a stronger signal locks the oscillator', 'Only the tones next to the channel\'s edge are affected'],
      answer: 0,
      explain: 'Inter-carrier interference is a fraction of the signal, so it scales with it. Only the part of the SNR limited by thermal noise improves. Correcting the offset is the only way through this ceiling.',
      why: ['', 'Thermal noise stays put as the signal grows, but this interference grows with it.', 'Nothing in the signal\'s strength steers the local oscillator.', 'Every tone leaks and every tone receives. The edge tones have a few fewer neighbours, and little else changes.'],
    },
  },
  {
    title: 'The same idea, everywhere',
    get body() {
      const row = (s: (typeof SYSTEMS)[number]) => {
        const T = blockTime(s), cp = T * (1 - dataShare(s));
        return `<tr><td>${s.name}</td><td class="num">${s.fft}</td><td class="num">${s.used}</td><td class="num">${nf(s.spacingHz / 1000, s.spacingHz < 1e5 ? 2 : 1)}</td><td class="num">${us(T)}</td><td class="num">${us(cp)}</td><td class="num">${nf(100 * dataShare(s), 1)} %</td></tr>`;
      };
      const wifi = SYSTEMS[1], rate = (48 * 6 * 0.75) / blockTime(wifi);
      return `
      <p>Each system below chooses the same three numbers. <strong>The prefix</strong> is set by the longest echo it must absorb, and light goes 300 m in a microsecond, so a building needs far less than a city. <strong>The tone spacing</strong> is set by the speed of what disturbs the block: a block must be short against a fading channel, but long against its own prefix, to keep the loss low. <strong>N</strong> is then the bandwidth over the spacing.</p>
      <table class="tbl"><thead><tr><th>System</th><th class="num">FFT</th><th class="num">Used tones</th><th class="num">Spacing, kHz</th><th class="num">Block</th><th class="num">Prefix</th><th class="num">Data</th></tr></thead><tbody>${SYSTEMS.map(row).join('')}</tbody></table>
      <p class="sub">${SYSTEMS.map((s) => `${s.name}: ${s.note}`).join(' ')}</p>
      <p>Wi-Fi's top 802.11a rate falls straight out of the table: 48 data tones, 6 bits on each with 64-QAM, a rate ¾ <span data-ahead="viterbi">convolutional code (a shift register whose parity bits spread each data bit over several sent bits; a later chapter builds its decoder)</span> of constraint length 7, every ${us(blockTime(wifi))}, is ${nf(rate / 1e6, 0)} Mb/s. Unlike ADSL, a fast radio channel cannot be measured and loaded tone by tone, so these systems put one rate on many tones and spread the bits across them with a code. A fade on some tones then costs a few coded bits, not a word. The code does the work ADSL's loading does, and <a href="#/c/codes/0">Codes near the limit</a> is about that.</p>
      <p>And the channel is no longer one wire, so tones are shared: LTE and 5G hand out blocks of 12 tones a slot at a time, a question for a later chapter. The arithmetic stays the one butterfly above, at ${nf((4096 * 30000) / 1e6, 2)} million samples a second.</p>`;
    },
    challenge: {
      kind: 'quiz',
      question: 'A design has tones 15 kHz apart and a 4.7 µs prefix. A designer doubles the spacing to 30 kHz and keeps the same bandwidth and the same prefix share. Which is true?',
      options: ['The prefix halves to about 2.3 µs, so it absorbs shorter echoes, but the block\'s shorter time tolerates a faster channel', 'The prefix stays at 4.7 µs, since the share is fixed', 'N doubles, since more tones are needed', 'The prefix loss doubles, since blocks are shorter'],
      answer: 0,
      explain: 'Block length is 1 / spacing, so it halves, and a fixed share halves the prefix with it. N halves too. That is the trade 5G\'s numerologies offer: wider spacing for small cells and fast channels, narrower for wide areas.',
      why: ['', 'A fixed share of a block half as long is half as long.', 'Same bandwidth over twice the spacing is half the tones.', 'The share was kept the same, so the loss is the same.'],
    },
  },
];

export const chCarriers: Chapter = {
  id: 'carriers', num: numOf('carriers'), title: 'Many carriers', level: 'Communication',
  blurb: 'Why split a channel into thousands of tones: FFT butterflies and a streaming pipeline in gates, the cyclic prefix, water-filling, and what ADSL, Wi-Fi and 5G each chose.',
  goals: [
    'build an FFT from one butterfly, and say which twiddles are wires, which are shift-and-add, and which need a multiplier',
    'compare an unrolled network with a streaming pipeline by NANDs, memory and clock, and size a word for the SNR a tone needs',
    'pour a power budget over the tones by water-filling, load whole bits by the greedy rule, and say why ADSL gets close with almost flat power',
    'say what breaks a block of tones, and what ADSL, Wi-Fi, LTE and 5G each chose for N, spacing and prefix',
  ],
  builds: ['modem', 'adders', 'registers', 'fastadd'],
  recap: {
    keep: [
      `Tones with a whole number of cycles in a block are orthogonal, so an inverse FFT sends them and an FFT reads them: N / 2 · log₂ N butterflies against N² multiplications. A cyclic prefix at least as long as the echo makes the channel circular, so each tone needs one complex division.`,
      `A butterfly is y0 = (a + W b) / 2, y1 = (a − W b) / 2: four adders, ${nands(fxCore(W, false))} NANDs at ${W} bits. W = 1 and −j are wires, the 45° twiddle two constant multipliers (${nands(fxRot45(W))}), any other a complex multiplier (${n0(nands(fxCmul(W)))}). Both adders' carry-ins are tied high: the sum rounds up and the difference down, and together they lose nothing.`,
      `Unrolled, N points are log₂ N columns of N / 2 butterflies with the inputs bit-reversed. Streaming, each stage has one butterfly and a delay line of half the rest, a sample a clock, tones in bit-reversed order: ${n0(nands(fftStream(16, W)))} against ${n0(nands(fftNet(16, W)))} NANDs at 16 points. Swapping re and im in and out inverts it with no new gates.`,
      'Rounding is about one unit per butterfly; a noise-like block\'s tones are about 1 / √N of its samples. So each bit gains 6 dB and each doubling of N costs about 3 dB, and the block\'s peak needs room too.',
      `ADSL splits the pair into ${ADSL.tones} tones ${ADSL.spacingHz.toLocaleString('en')} Hz apart, each its own QAM of ⌊log₂(1 + SNR/Γ)⌋ bits (at most ${ADSL.maxBits}), ${n0(ADSL.symbolRate)} symbols a second. Γ is ${db(gapDb(1e-7))} uncoded at 10⁻⁷. The loop's SNR falls with frequency and length, so the bits go where the channel is good.`,
      'Water-filling: p = μ − Γ / g where positive. It is the capacity of parallel channels. Greedy whole-bit loading is optimal for whole bits. Choosing the tones matters far more than moving power among those chosen, which is why ADSL\'s masked, nearly flat power loses little.',
      'A block peaks with chance 1 − (1 − e^(−x))^N. A carrier offset ε leaks every tone into every other, so it sets a ceiling no signal strength can lift. An echo past the prefix breaks the block, and a single carrier would pay for the same echo with a long filter.',
    ],
    check: [
      {
        question: 'An 8-point FFT has 12 butterflies. How many of them need the general complex multiplier?',
        options: ['None: seven have W = 1, three −j, and two are 45° turns made of constant multipliers', 'All twelve', 'Eight: one per output', 'Four: one per column, plus one'],
        answer: 0,
        explain: 'The general multiplier only appears from 16 points on. That is why the butterfly count overstates the arithmetic of small transforms.',
        why: ['', 'That is what N / 2 · log₂ N suggests, but it counts wires as multiplications.', 'The count is by twiddle, and an output has nothing to do with it.', 'Only the last column has any non-trivial twiddle.'],
      },
      {
        question: 'Why does a streaming FFT cost so much less than the unrolled network of the same size?',
        options: ['Each butterfly gets a different clock, so one butterfly and one multiplier a stage serve them all, in exchange for N − 1 samples of memory', 'It computes fewer butterflies', 'It works in lower precision', 'It drops the bit reversal'],
        answer: 0,
        explain: 'Every butterfly of the network still happens, one at a time. The price is memory and latency, and a throughput of one sample a clock instead of N.',
        why: ['', 'The arithmetic done per block is the same.', 'Both are built at the same word length here.', 'The tones still come out bit-reversed: the order is a property of the factorization.'],
      },
      {
        question: 'Water-filling leaves a tone dry. What does that mean about it?',
        options: ['Its floor Γ / g is above the water level: any power there would buy less than the same power spent on the better tones', 'It has failed and must be repaired', 'It is carrying 15 bits already', 'Its gain is exactly 1'],
        answer: 0,
        explain: 'At the optimum all tones in use have the same marginal rate, 1 / μ. A tone whose very first watt earns less than that gets none, and a stronger budget can raise the level over it later.',
        why: ['', 'It may be a perfectly good tone that the budget does not stretch to.', 'A full tone has a low floor, not a high one.', 'The value of the gain only matters against the level.'],
      },
    ],
  },
  steps: [tonesStep, ...carrierNewSteps.slice(0, 4), adslStep, ...carrierNewSteps.slice(4)],
};
