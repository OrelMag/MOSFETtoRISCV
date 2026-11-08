// When bits go wrong (level Communication): how a receiver knows a bit was damaged and what it does then. Parity and
// Hamming from the library (lib/coding.ts), CRC-32 in gates one bit and one byte a clock (lib/crc.ts, comm/crc.ts, checked against
// zlib), framing (comm/framing.ts), stop-and-wait and sliding-window repeat request (comm/arq.ts), and forward error correction as a
// trade against retransmission (comm/fec.ts), then stronger codes (ch-comm-codes.ts). Every number below is computed or pinned in tests/comm-errors.test.ts.

import { aOf, fullWindow, rttOf, utilization } from '../comm/arq';
import { CRC32_POLY, CRC32_REFLECTED, CRC32_RESIDUE, CRC8, crc32, parityUndetected, undetected, weightDistribution } from '../comm/crc';
import { codeOf, crcOnly, crossover, crossoverTime, secdedCrc } from '../comm/fec';
import { cobsWorst, stuffRate } from '../comm/framing';
import { CLOCK_NS } from '../dram/timing';
import { crcNext, crcUnit, eccChannel, hammingDec, hammingEnc, hammingLayout, parity } from '../lib';
import { berOf } from '../phys/line';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../sim/timing';
import { arqWidget, crcApi, crcExplorerWidget, crcScene, fecWidget, framingWidget, parityWidget, undetectedWidget } from '../widgets/errors';
import type { Scene } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';
import { FEC_BER } from '../phys/fibre';

const nf = (x: number, d = 1) => x.toFixed(d);
const sci = (x: number, d = 1) => x.toExponential(d).replace('e-', ' × 10<sup>−').replace('e+', ' × 10<sup>') + '</sup>';
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const depth = (d: Parameters<typeof logicDepth>[0]) => logicDepth(d) ?? 0;
const withCommas = (n: number) => Math.round(n).toLocaleString('en-US');

// the link: 4 cycles a bit at the single-cycle CPU's clock (roadmap decision 7)
const CYCLES_PER_BIT = 4, RATE = 1e9 / (CYCLES_PER_BIT * CLOCK_NS), FRAME_BYTES = 1500;
const FRAME_S = (FRAME_BYTES * 8) / RATE;
const BER = 1e-12, HOURS_PER_ERROR = 1 / (RATE * BER) / 3600;
const WIRE = 8 * FRAME_BYTES + 32;

// the CRC hardware
const NEXT1 = crcNext(32, CRC32_REFLECTED, 1), NEXT8 = crcNext(32, CRC32_REFLECTED, 8), NEXT8_PLAIN = crcNext(32, CRC32_REFLECTED, 8, false);
const U1 = crcUnit(32, CRC32_REFLECTED, 1), U8 = crcUnit(32, CRC32_REFLECTED, 8);
const periodOf = (u: typeof U1): number => analyzeTiming(flatten(u, { mode: 'gate' }))?.period ?? 0;
const GHZ = (period: number) => 1000 / (period * PS_PER_NAND);
const taps = (CRC32_REFLECTED >>> 0).toString(2).split('1').length - 1;

const a = aOf(10e-3, FRAME_BYTES * 8, RATE);

// 16 data bits, CRC-8: the share of corrupted words accepted at 1e-4 against the parity bit's
const A8 = weightDistribution(16, CRC8), SHARE8 = undetected(A8, 1e-4) / (1 - (1 - 1e-4) ** 24), SHARE_PAR = parityUndetected(17, 1e-4) / (1 - (1 - 1e-4) ** 17);

export const chErrors: Chapter = {
  id: 'errors', num: numOf('errors'), title: 'When bits go wrong', level: 'Communication',
  blurb: 'Parity and Hamming, CRC-32 in gates a bit and a byte a clock, framing, stop-and-wait and sliding windows, and forward error correction as a trade against retransmission.',
  goals: [
    'say what a code of Hamming distance d detects and corrects, and what one parity bit and SEC-DED cost in NANDs and levels',
    'compute a CRC as the remainder of a polynomial division over GF(2), name the error patterns it is guaranteed to catch, and read its miss rate off the code\'s weight distribution',
    'build the CRC-32 register one bit and one byte a clock from XOR gates, and say what each costs in NANDs, delay and bits per second',
    'frame a bit stream with flags and stuffing, and state the overhead exactly',
    'size a sliding window from the bandwidth-delay product, and weigh forward error correction against retransmission by goodput and by delivery time',
  ],
  builds: ['cache', 'registers', 'noise', 'serial'],
  recap: {
    keep: [
      `A code of Hamming distance d detects d − 1 flipped bits and corrects ⌊(d − 1)/2⌋. One parity bit (distance 2, ${nands(parity(8))} NANDs for 8 bits) detects every odd number of flips and misses every even one; the share of corrupted words it accepts is about (n − 1)p/2 at bit error rate p over n bits. SEC-DED (distance 4) corrects one error and flags two: ${nands(hammingEnc(8))} + ${nands(hammingDec(8))} NANDs for 8 data bits, ${withCommas(nands(hammingEnc(64)))} + ${withCommas(nands(hammingDec(64)))} for 64.`,
      `A CRC is the remainder of the message, read as a polynomial over GF(2), divided by a generator. CRC-32 (generator 0x${CRC32_POLY.toString(16).toUpperCase().padStart(8, '0')}) catches every single-bit error and every burst of 32 bits or fewer, and a random garbage frame passes with probability 2<sup>−32</sup>. It does not catch every odd number of flips: its generator has an odd number of terms, so it has no factor x + 1.`,
      `The CRC register is a shift register with an XOR at each 1 of the generator: ${nands(NEXT1)} NANDs of next-state logic for one bit a clock (${taps} XORs), ${withCommas(nands(U1))} NANDs with the 32 flip-flops. A byte a clock is the same function applied eight times and collapsed into XORs of the 32 state bits and 8 data bits: ${nands(NEXT8_PLAIN)} NANDs written out, ${nands(NEXT8)} with common pairs shared, at ${depth(NEXT8)} levels against ${depth(NEXT1)}.`,
      `Initial value all ones and the final complement make a frame of leading zeros differ from a frame of fewer zeros. Sending the CRC (low byte first) after the message leaves the register at the constant 0x${CRC32_RESIDUE.toString(16).toUpperCase()}, which is how a receiver checks a frame without comparing.`,
      `HDLC stuffs a 0 after five 1s so the flag 01111110 cannot occur in the data: 1 bit in ${nf(1 / stuffRate(), 0)} on random data, 1 in 5 in the worst case. COBS removes zero bytes instead: at most one byte in 254.`,
      `Stop-and-wait uses (1 − p)/(1 + 2a) of the link, where a is the one-way delay in frame times. A window of 1 + 2a frames fills the pipe: ${fullWindow(a)} frames for ${FRAME_BYTES}-byte frames at ${nf(RATE / 1e6, 0)} Mb/s over 10 ms. Go-back-N then costs 1 + 2a slots per loss; selective repeat costs one, but needs about three round trips of window to deliver 1 − p.`,
      `Forward error correction buys down the retransmission rate with redundancy that is paid on every frame. SEC-DED(72, 64) is 12.5 % redundancy and wins on goodput only above a bit error rate near ${sci(crossover(FRAME_BYTES)!)} for ${FRAME_BYTES}-byte frames; at a long delay it wins on delivery time at a far lower one.`,
    ],
    check: [
      {
        question: 'A link flips each bit independently with probability 10<sup>−4</sup>. A 16-bit field is protected either by one parity bit or by a CRC-8. Which accepts more of the corrupted words?',
        options: ['The parity bit: every pair of flips passes it', 'The CRC-8: eight check bits are more places to go wrong', 'They accept the same share: 2<sup>−r</sup> of the corrupted words', 'Neither accepts any: both detect every error'],
        answer: 0,
        explain: `Parity accepts every even-weight error, and two flips are the commonest: about (n − 1)p/2 = ${SHARE_PAR.toExponential(1)} of the corrupted words. The CRC-8 has no code word of weight 1, 2 or 3 on 16 data bits, so only four or more flips get through (${A8[4]} of its 65 536 code words have weight 4): ${SHARE8.toExponential(1)} of the corrupted words, ${withCommas(SHARE_PAR / SHARE8)} times fewer.`,
        why: ['', 'More check bits do not add failure modes; what matters is which error patterns are themselves code words, and the CRC-8 has none of low weight.', 'The 2<sup>−r</sup> share is the limit for pure noise. At 10<sup>−4</sup> the few-flip errors dominate, and the two checks differ enormously on them.', 'Parity misses every even-weight error, and a CRC misses the patterns that are multiples of its generator.'],
      },
      {
        question: `A link with a round trip of ${rttOf(a).toFixed(0)} frame times runs go-back-N with a window of 8 frames and no loss. What utilization does it reach?`,
        options: [`8 / ${rttOf(a).toFixed(0)}, about ${(800 / rttOf(a)).toFixed(0)} %`, '100 %: no loss, no waiting', `1 / ${rttOf(a).toFixed(0)}, as for stop-and-wait`, '50 %'],
        answer: 0,
        explain: `The sender can have 8 frames out and must then wait for the first acknowledgement, which comes a round trip (${rttOf(a).toFixed(0)} slots) after it was sent. It sends 8 frames in ${rttOf(a).toFixed(0)} slots.`,
        why: ['', `Only when the window reaches ${fullWindow(a)} frames, the bandwidth-delay product plus one.`, 'Stop-and-wait is a window of 1. A window of 8 sends eight frames per round trip.', 'There is no 50 % in this: the fraction is the window over the round trip.'],
      },
      {
        question: 'Forward error correction is added to a link that sees one error in 10<sup>9</sup> bits, with a short round trip. What happens to goodput?',
        options: ['It falls by the code\'s redundancy: there are almost no retransmissions to save', 'It rises, because every error is corrected', 'It is unchanged: the CRC still catches everything', 'It doubles, since frames are shorter'],
        answer: 0,
        explain: `At a bit error rate of 10<sup>−9</sup> a ${FRAME_BYTES}-byte frame is corrupted ${(100 * crcOnly(FRAME_BYTES, 1e-9).pFail).toFixed(4)} % of the time, so retransmission costs almost nothing, while SEC-DED(72, 64) sends ${nf(100 * (codeOf(64).n / 64 - 1), 1)} % more bits on every frame: goodput ${(100 * secdedCrc(FRAME_BYTES, 1e-9).goodput).toFixed(1)} % against ${(100 * crcOnly(FRAME_BYTES, 1e-9).goodput).toFixed(1)} %.`,
        why: ['', 'It does correct every single error, but there are so few that the saving is smaller than the redundancy paid on every frame.', 'The CRC is still needed, but the frame is 12.5 % longer on the wire, so goodput changes.', 'The check bits make frames longer, not shorter.'],
      },
    ],
  },
  steps: [
    {
      title: 'One extra bit',
      get body() {
        const P8 = parity(8), q = 7;
        return `
        <p>The coherent receiver of the last chapter hands its decisions to a decoder, because the optics alone may leave one bit in ${Math.round(1 / FEC_BER)} wrong. This chapter builds the parts of such a code, from the simplest check up.</p>
        <p>A receiver decides each bit from a voltage (<a href="#/c/noise/2">chapter ${numOf('noise')}</a>, and the eye of chapter ${numOf('serial')}), and the decision is wrong with a probability that falls with the eye's opening over the noise: a half-opening of ${q} σ gives a bit error rate of Q(${q}) = ${sci(berOf(q, 1))}.
        A link engineered to 10<sup>−12</sup> at ${nf(RATE / 1e6, 0)} Mb/s (the book's convention: ${CYCLES_PER_BIT} cycles a bit at ${CLOCK_NS} ns) still delivers a wrong bit about every ${nf(HOURS_PER_ERROR, 1)} hours, and a marginal one every few frames. The receiver cannot see which bits are wrong, so the sender adds redundancy the receiver can test.</p>
        <p>Redundancy works by making most bit patterns <em>not</em> code words. Two code words that differ in <strong>d</strong> positions are the code's Hamming distance; an error pattern is noticed unless it turns one code word into another, so a code of distance d detects any d − 1 flips, and corrects ⌊(d − 1)/2⌋ because the nearest code word is then unique.
        The cheapest code is one <strong>parity bit</strong>: the XOR of the data bits, so every code word has an even number of 1s (distance 2). The sender's side is a tree of XOR gates, ${nands(P8)} NANDs and ${depth(P8)} levels for 8 bits (${nands(parity(64))} NANDs for 64, ${depth(parity(64))} levels); the receiver's is the same tree over all nine bits, and its output is the alarm.</p>
        <p>One flipped bit makes the count odd and rings the alarm; so does any odd number. Two flips restore even parity and pass unseen. At a bit error rate p over n bits the share of corrupted words accepted is about (n − 1)p/2: 4p for n = 9, so parity is a good check exactly when errors are rare and independent, and says nothing about which bit.</p>
        <div class="try">Flip one bit, then two. Then move the bit error rate from 10<sup>−6</sup> to 10<sup>−1</sup> and watch the share that slips through.</div>`;
      },
      widget: parityWidget,
      challenge: {
        kind: 'quiz',
        question: 'A 9-bit word with even parity arrives with exactly two bits flipped. What does the receiver do?',
        options: ['Accepts it: the number of 1s is even again', 'Rejects it: two errors are detected', 'Corrects both bits', 'Rejects it, and reports the two positions'],
        answer: 0,
        explain: 'Each flip changes the count of 1s by one, so two flips change it by an even number and the parity test passes. Distance 2 detects one flip and nothing more.',
        why: ['', 'It would need distance 3 to detect two flips. A parity bit has distance 2.', 'Correcting needs distance 3 for one error and distance 5 for two.', 'Parity carries no position information at all: one bit cannot say where.'],
      },
    },
    {
      title: 'Locating the error',
      get body() {
        const L8 = hammingLayout(8), L64 = hammingLayout(64);
        return `
        <p><a href="#/c/cache/0">The chapter on caches and memories</a> (chapter ${numOf('cache')}) already used the next step up: <strong>Hamming's code</strong> puts check bit 2<sup>j</sup> at position 2<sup>j</sup> and makes the XOR of every position with bit j set even. On receipt the checks recomputed are the <em>syndrome</em>, and for one flipped bit it is that bit's position: the code locates the error, so the decoder flips it back. A last overall parity bit gives distance 4, <strong>SEC-DED</strong>: a single error has an odd overall parity and a non-zero syndrome (correct it); a double error has even overall parity and a non-zero syndrome (flag it, cannot fix it).</p>
        <p>The circuit is the one from the memory chapters, here between a sender and a receiver. The <span data-show="enc">encoder</span> for 8 data bits is ${nands(hammingEnc(8))} NANDs and ${depth(hammingEnc(8))} levels, the <span data-show="dec">decoder</span> ${nands(hammingDec(8))} NANDs and ${depth(hammingDec(8))} levels, and <span data-show="upset">upset</span> is where the channel flips bits. 8 data bits need ${L8.r} Hamming bits and the overall parity: ${L8.n} bits sent for 8, a rate of ${nf(100 * 8 / L8.n, 0)} %.
        Redundancy grows with log<sub>2</sub> of the block, so it is spent better on long blocks: 64 data bits need ${L64.r + 1} check bits (${L64.n} sent, rate ${nf(100 * 64 / L64.n, 1)} %) at ${withCommas(nands(hammingEnc(64)))} + ${withCommas(nands(hammingDec(64)))} NANDs, the (72, 64) code of server memory. The price on a link is the block's worth of delay: the decoder is ${depth(hammingDec(64))} levels deep, ${nf(depth(hammingDec(64)) * PS_PER_NAND / 1000, 2)} ns at ${PS_PER_NAND} ps a level.</p>
        <div class="try">Set <code>flip</code> to a single bit and watch <code>single</code> go up and <code>dout</code> stay right. Then flip two bits.</div>`;
      },
      scene: (): Scene => ({ root: eccChannel(8), inputs: { d: 0xa5, flip: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Corrupt two bits of the stored word so that the decoder flags a double error (double = 1).',
        check: (st) => st.value('double') === 1,
        hints: ['flip is a 13-bit mask over the stored word: a 1 inverts that bit.', 'Set two bits of flip, for example 0b101.'],
        answer: 'Two flipped bits give an even overall parity and a non-zero syndrome: the decoder cannot tell which two, so it raises double and passes the data on uncorrected.',
        solve: (st) => st.setInput('flip', 0b101),
      },
    },
    {
      title: 'A remainder as a check',
      get body() {
        return `
        <p>Parity is one check bit for the whole word; a <strong>cyclic redundancy check</strong> is thirty-two chosen so that bursts cannot hide. Read the message as a polynomial over GF(2), bit i the coefficient of x<sup>i</sup>, and divide it by a fixed <em>generator</em> of degree 32; subtraction is XOR and there are no borrows, so the division is a handful of XORs of the divisor under the dividend (the lower panel does one by hand for a CRC-8).
        The remainder is the CRC. Append it to the message and the whole word is a multiple of the generator, so the receiver divides again and accepts only a zero remainder (or, as the register does it, a fixed one).</p>
        <p>The generator of Ethernet, zlib, PNG and gzip is x<sup>32</sup> + x<sup>26</sup> + x<sup>23</sup> + x<sup>22</sup> + x<sup>16</sup> + x<sup>12</sup> + x<sup>11</sup> + x<sup>10</sup> + x<sup>8</sup> + x<sup>7</sup> + x<sup>5</sup> + x<sup>4</sup> + x<sup>2</sup> + x + 1, 0x${CRC32_POLY.toString(16).toUpperCase().padStart(8, '0')} without its leading term, and 0x${CRC32_REFLECTED.toString(16).toUpperCase()} written the other way round, which is the form the shift register below uses (each byte goes in least significant bit first). The convention adds two details: the register <em>starts at all ones</em> and the result is <em>complemented</em>. Without them a message with extra leading zeros has the same CRC, and an all-zero frame has CRC zero. The CRC-32 of the nine characters 123456789 is 0x${crc32(Array.from(new TextEncoder().encode('123456789'))).toString(16).toUpperCase()}.</p>
        <p>What the arithmetic guarantees follows from divisibility. An error pattern E goes unnoticed only if the generator G divides E. A single flipped bit is x<sup>i</sup>, which G does not divide. A burst from bit i to bit j is x<sup>i</sup> times a polynomial of degree j − i with a constant term 1, and G (degree 32, constant term 1) cannot divide anything of lower degree: <strong>every burst of 32 bits or fewer is caught</strong>. Any other pattern is a multiple of G with probability 2<sup>−32</sup> = ${sci(2 ** -32)}. What it does <em>not</em> promise is odd-weight detection: G has ${15} terms, an odd number, so x + 1 does not divide it (a CRC with an even number of terms, like the CRC-16 of HDLC, does catch every odd error).</p>
        <div class="try">Flip one bit: about half of the 32 CRC bits change. Flip a burst of 32, then of 40: both are caught, the first by guarantee.</div>`;
      },
      widget: crcExplorerWidget,
      more: {
        derive: `<p>Linearity is why the hardware is small. CRC(a ⊕ b) = CRC(a) ⊕ CRC(b) ⊕ CRC(0) for equal lengths, so the register's next state is an XOR of the old state bits and the new data bits, nothing else. Each output bit of the next-state function is the XOR of a fixed subset of its inputs, which can be read off by feeding it the unit vectors. The two gate-level steps build exactly those subsets, and tests/comm-crc-gates.test.ts compares them with the golden model every cycle.</p>`,
        pitfall: `<p>Calling the register's contents the CRC. The reflected register that started at all ones holds the <em>complement</em> of the CRC after the message; the CRC proper is its complement, sent low byte first. Mixing the two, or the bit order, is the usual reason two implementations disagree.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'A frame carries a CRC-32. A burst of 20 consecutive bits is corrupted, with the first and last of them flipped. What is the chance the receiver accepts the frame?',
        options: ['Zero: every burst of 32 bits or fewer is caught', '2<sup>−32</sup>, like any random error', '2<sup>−20</sup>', 'One half, since each flipped bit is a coin toss'],
        answer: 0,
        explain: 'The error polynomial is x<sup>i</sup> times a polynomial of degree 19 with a constant term. A generator of degree 32 cannot divide a polynomial of degree below 32 (other than zero), so the remainder is never zero.',
        why: ['', 'That is the figure for errors longer than the burst guarantee. Short bursts are better than random: they are never missed.', 'The burst length does not set the miss probability; the generator\'s degree does, and below it the answer is zero.', 'The bits inside the burst are not random events; the argument is about the pattern as a whole.'],
      },
    },
    {
      title: 'How good is a check?',
      get body() {
        const fps = RATE / (WIRE);
        return `
        <p>An error pattern is missed exactly when it is itself a code word, because then it moves one code word onto another. So a code's miss rate is read from its <em>weight distribution</em> A<sub>w</sub>, the number of code words with w ones: at bit error rate p the probability that a word is corrupted into a different valid word is the sum over w of A<sub>w</sub> p<sup>w</sup> (1 − p)<sup>n − w</sup>. The widget enumerates all 65 536 words of a 16-bit data field and computes this exactly for a parity bit, a CRC-8 (x<sup>8</sup> + x<sup>2</sup> + x + 1) and a CRC-16 (x<sup>16</sup> + x<sup>12</sup> + x<sup>5</sup> + 1).</p>
        <p>The right edge of the plot is pure noise, every pattern equally likely, where a check with r bits accepts 2<sup>−r</sup> of corrupted words. The left edge is the real link, where only few-bit errors occur, and a CRC does <em>much</em> better than 2<sup>−r</sup> there because it catches every low-weight pattern: the CRC-8 above has no code word of weight 1, 2 or 3 on a 16-bit field. A parity bit is the other way round: it misses the commonest error, two flips, at about (n − 1)p / 2: 8p on this 17-bit word.</p>
        <p>For CRC-32 the 2<sup>−32</sup> figure is the one to design with for <em>garbage</em>: a stuck driver, a truncated or mis-addressed frame, a bug in a buffer. A ${FRAME_BYTES}-byte frame has ${withCommas(WIRE)} bits on the wire, so at ${nf(RATE / 1e6, 0)} Mb/s there are ${withCommas(fps)} frames a second; if every one were garbage, one would pass the check every ${nf(2 ** 32 / fps / 86400, 1)} days. Real garbage is rarer than that. For random single-bit errors at 10<sup>−6</sup>, ${nf(100 * crcOnly(FRAME_BYTES, 1e-6).pFail, 1)} % of those frames arrive damaged, and the check misses essentially none of them.</p>
        <div class="try">Slide the bit error rate from 10<sup>−6</sup> up. Where do the parity and CRC curves cross 1 in 100?</div>`;
      },
      widget: undetectedWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does a CRC-16 on a clean link miss far fewer corrupted words than 2<sup>−16</sup>, yet approach 2<sup>−16</sup> on a link full of noise?',
        options: ['It catches every low-weight error pattern, and a noisy link produces patterns of every weight', 'The check bits are recomputed more carefully on a noisy link', 'The CRC adapts its generator to the error rate', 'On a clean link it also corrects errors'],
        answer: 0,
        explain: 'A pattern is missed only when it is a code word, and the lightest code words of a good CRC are heavy (four or more flips). A clean link makes mostly light patterns, which are all caught. At 50 % bit errors every pattern is equally likely and a fraction 2<sup>−r</sup> of them are code words.',
        why: ['', 'The check is the same division in both cases; the difference is which error patterns occur.', 'The generator is fixed at design time.', 'A CRC detects; correcting needs a code built for it (the Hamming step).'],
      },
    },
    {
      title: 'CRC in gates, a bit a clock',
      get body() {
        const p1 = periodOf(U1), f1 = GHZ(p1);
        return `
        <p>The division is a <strong>shift register with feedback</strong>. The reflected register shifts right; the bit that leaves, XOR the data bit arriving, is the feedback f; wherever the generator has a 1, f is XORed into the bit shifted in at that position. That is ${taps} XOR gates for the ${taps} ones of the generator, and the first XOR forms f, which the others share. The next-state block (<span data-show="step">step</span>) is ${nands(NEXT1)} NANDs, ${depth(NEXT1)} levels deep, and is built by lib/crc.ts from the golden model's linear map, so it cannot disagree with it.</p>
        <p>Around it sit the register (<span data-show="reg">32 flip-flops with an enable</span>, the bulk of the ${withCommas(nands(U1))} NANDs and ${withCommas(stats(U1).transistors)} transistors in all), a multiplexer that loads all ones (<span data-show="init k">init</span>), an OR so init works without en (<span data-show="ld">load</span>) and an XOR with ones that complements the register on its way out (<span data-show="fc">FCS</span>). The register can be clocked at ${p1} NAND delays (${CLK_TO_Q} to q, ${SETUP} setup, the rest in logic), ${nf(p1 * PS_PER_NAND / 1000, 2)} ns, ${nf(f1, 1)} GHz: one bit a clock is ${nf(f1, 1)} Gb/s.</p>
        <p>At the book's clock (${CLOCK_NS} ns) it takes in ${nf(1000 / CLOCK_NS, 0)} Mb/s, four times the ${nf(RATE / 1e6, 0)} Mb/s link, which sends a bit every ${CYCLES_PER_BIT} cycles: the register has three idle clocks in four and <code>en</code> is the link's bit-valid. The same circuit, with another tap pattern, is a CRC-8 or CRC-16.</p>
        <div class="try">Press <strong>Init</strong>, then <strong>Send 1 bit</strong> a few times and watch the register: each clock a different tap flips. Then <strong>Send message + FCS</strong>: the register ends at the residue.</div>`;
      },
      scene: () => crcScene(1),
      lit: 'The next-state XORs, the init multiplexer and the register.',
      challenge: {
        kind: 'reach', goal: 'Clock the nine characters 123456789 in, one bit a clock, so that fcs reads 0xCBF43926.',
        check: (st) => st.value('fcs') === 0xcbf43926,
        hints: ['The panel\'s message starts as 123456789. Press Init first: the register starts from all ones.', 'Then Send message clocks all 72 bits in.'],
        answer: 'Init loads all ones; each of the 72 clock edges with en = 1 takes one bit, least significant bit of each byte first; fcs is the complement of the register, and for this message it is 0xCBF43926.',
        solve: (st) => crcApi.get(st)?.send('123456789'),
      },
    },
    {
      title: 'A byte at a time',
      get body() {
        const p8 = periodOf(U8), f8 = GHZ(p8), p1 = periodOf(U1), f1 = GHZ(p1);
        const clockBitsPerCycle = 1e9 / CLOCK_NS / RATE;
        return `
        <p>A link faster than the clock cannot use one bit a clock. Eight serial steps are one function: because the next state is linear in the state and the data, eight steps in a row are again an XOR of some state bits and some data bits, and the matrix is read off the golden model. Written out as one XOR tree per output it costs <strong>${nands(NEXT8_PLAIN)} NANDs</strong>, and most of that is the same pairs computed over and over. Factoring out the most common pair of terms, repeatedly, gives <strong>${nands(NEXT8)} NANDs</strong> (${nf(nands(NEXT8_PLAIN) / nands(NEXT8), 1)}× smaller) at the same ${depth(NEXT8)} levels. That is ${nf(nands(NEXT8) / nands(NEXT1), 1)}× the serial block's ${nands(NEXT1)} NANDs for eight times the bits.</p>
        <p>With the register, the whole unit is ${withCommas(nands(U8))} NANDs against ${withCommas(nands(U1))}, only ${nf(100 * (nands(U8) / nands(U1) - 1), 0)} % more, because the 32 flip-flops dominate both. The deeper XOR network costs frequency: ${p8} delays against ${p1}, ${nf(f8, 2)} GHz against ${nf(f1, 2)} GHz, so at their own limits the byte-wide unit takes in ${nf(8 * f8, 1)} Gb/s against ${nf(f1, 1)} Gb/s, ${nf(8 * f8 / f1, 1)}× the throughput for ${nf(nands(U8) / nands(U1), 2)}× the gates. A ${FRAME_BYTES}-byte frame takes ${withCommas(FRAME_BYTES * 8)} clocks serially and ${withCommas(FRAME_BYTES)} a byte at a time.</p>
        <p>Whether that is needed is arithmetic about the link: it delivers a bit every ${CYCLES_PER_BIT} cycles, so one bit a clock has a factor ${nf(clockBitsPerCycle, 0)} to spare. At ${nf(RATE * 16 / 1e9, 1)} Gb/s (sixteen times the book's link) it would deliver ${nf(16 * RATE / (1e9 / CLOCK_NS), 0)} bits every cycle, and the byte-wide form, or a wider one, is the only choice. A word-wide CRC in software is the same idea as a table: the 256-entry table is eight serial steps for each byte value, precomputed.</p>
        <div class="try">Send the same message here: one clock edge takes a byte, nine for the whole string, and the register ends where the serial one did.</div>`;
      },
      scene: () => crcScene(8),
      challenge: {
        kind: 'quiz',
        question: 'Going from one bit a clock to one byte a clock multiplies the CRC unit\'s NAND count by about 1.3, not 8. Why?',
        options: ['The 32 flip-flops are shared; only the XOR network grows, and sharing common pairs keeps that to about five times its serial size', 'Byte-wide units use fewer flip-flops', 'The XOR network gets simpler with more inputs', 'Four of the eight steps are skipped'],
        answer: 0,
        explain: 'The register and its multiplexers are the same 32-bit state either way. Only the next-state logic grows (56 to 288 NANDs), and it is the smaller part of the unit.',
        why: ['', 'It is the same 32-bit state; the register is identical.', 'The network grows with the width, roughly with the number of terms in each row of the matrix.', 'All eight steps are folded into one network, none are skipped.'],
      },
    },
    {
      title: 'Where a frame starts',
      get body() {
        const w = 8 * FRAME_BYTES;
        return `
        <p>A check needs a word to check. On a serial line the receiver sees a stream and must find where each frame begins and ends. The classic bit-level answer is the HDLC <strong>flag</strong>, 01111110, between frames. To keep it from occurring in the data, the sender <strong>stuffs</strong> a 0 after every five consecutive 1s and the receiver deletes a 0 that follows five 1s. A run of six 1s then can only be a flag (seven, an abort). The cost is exact: on random data a stuffed bit follows a chain that restarts after each, and the rate works out to one in ${nf(1 / stuffRate(), 0)} (checked by an exact Markov chain and a four-hundred-thousand-bit run); on a payload of all 1s it is one in five, so a ${FRAME_BYTES}-byte frame of 0xFF grows by ${withCommas(w / 5)} bits (20 %). The length on the wire is not known before the data, a nuisance for a fixed-size buffer.</p>
        <p>The byte-level answer is <strong>COBS</strong>: rewrite the data without a zero byte (each block is led by the distance to the next zero) and a 0 ends the frame. The overhead is one byte, plus one more for every 254 bytes of non-zero data: at most ${cobsWorst(FRAME_BYTES)} bytes on a ${FRAME_BYTES}-byte frame, ${nf(100 * cobsWorst(FRAME_BYTES) / FRAME_BYTES, 2)} %, and bounded by the length, whatever the content. The other common answers are a length field up front (the receiver must trust it, and a corrupted one desynchronizes it; a CRC over the header repairs that) and a preamble, a pattern the receiver locks its clock to, followed by a start delimiter and a known frame length.</p>
        <p>The check goes at the end, over everything between the flags. The receiver feeds the frame, <em>including</em> the four FCS bytes, into the same register: a good frame always leaves it at the constant 0x${CRC32_RESIDUE.toString(16).toUpperCase()}, so there is no comparator and no need to know where the data ends. The widget builds the frame, flips the bit you press, and runs the receiver: most flips are caught by the CRC; a flip that makes or destroys a flag shows the other failure, a frame cut in two or two frames fused, each with its own CRC verdict.</p>
        <div class="try">Press <strong>Six 0xFF bytes</strong> and count the stuffed zeros. Then flip a bit inside the closing flag.</div>`;
      },
      widget: framingWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does the HDLC receiver always see a frame ended by a flag, never by the data?',
        options: ['The sender stuffs a 0 after every five 1s, so six in a row cannot occur inside a frame', 'Data bytes are never 0x7E', 'The flag is longer than any run in the data', 'The CRC would fail on a flag'],
        answer: 0,
        explain: 'The flag is a 0, six 1s, a 0. Inside the frame no run of 1s is longer than five, because a 0 is inserted after the fifth. A run of six therefore means a flag (or an abort).',
        why: ['', 'Any byte value may occur; 0x7E is stuffed like any other pattern with five 1s in a row.', 'The flag is only eight bits and a run of six is shorter than many payloads.', 'The CRC is checked after the frame ends; it does not find the end.'],
      },
    },
    {
      title: 'Asking again',
      get body() {
        const gbn = utilization('gbn', a, fullWindow(a), 0.01), saw = utilization('saw', a, 1, 0.01);
        return `
        <p>A check that fails is only useful if something follows. The oldest scheme is <strong>automatic repeat request</strong>: the receiver acknowledges frames it accepts; the sender keeps a timer, and a frame not acknowledged in time is sent again. A corrupted frame is simply dropped by the receiver, so the check turns a bit error into a lost frame, which the timeout repairs. Three schemes differ in how many frames may be out at once.</p>
        <p><strong>Stop-and-wait</strong> sends one frame and waits for its acknowledgement. Let a be the one-way delay in frame times; the round trip is 1 + 2a slots, and a loss rate p repeats each frame 1/(1 − p) times on average, so the link carries <strong>(1 − p)/(1 + 2a)</strong> frames per slot. Take ${FRAME_BYTES}-byte frames at ${nf(RATE / 1e6, 0)} Mb/s: a frame takes ${nf(FRAME_S * 1e6, 0)} µs, and across a 10 ms path a = ${nf(a, 1)}. Stop-and-wait then uses ${nf(100 * saw, 2)} % of the link at 1 % loss, though the line is idle 99 % of the time.</p>
        <p>The cure is a <strong>window</strong>: keep W frames in flight. It fills the pipe when W reaches the round trip, 1 + 2a = ${nf(rttOf(a), 0)} slots, the bandwidth-delay product in frames plus the one being sent: ${fullWindow(a)} frames here, below that the utilization is W/(1 + 2a). <strong>Go-back-N</strong> acknowledges cumulatively and has one timer: when the oldest frame times out the sender goes back and resends it and everything after it, and the receiver discards what arrives out of order (it keeps one counter). With W ≥ 1 + 2a it carries (1 − p)/(1 + 2ap), exact in this model: each loss costs a whole round trip of slots, ${nf(100 * gbn, 1)} % at 1 % loss. <strong>Selective repeat</strong> resends only the frame that timed out and buffers the rest, which costs a buffer per window slot and a sequence space of at least twice the window. Its ideal is 1 − p, but a lost frame is resent a timeout late and acknowledged a round trip after that, and the window cannot slide past it meanwhile, so it takes about three round trips of window to reach 1 − p; at one round trip it falls short, which the timeline shows as stalls.</p>
        <div class="try">Set loss to 10 % and a = 4. Compare go-back-N and selective repeat at W = 9, then at W = 27.</div>`;
      },
      widget: arqWidget,
      more: {
        derive: `<p>Go-back-N with W ≥ 1 + 2a: a frame needs on average 1/(1 − p) attempts, and every failed attempt wastes the round trip of 1 + 2a slots before the sender goes back (the frames sent meanwhile are discarded), so the time per delivered frame is 1 + (1 + 2a)·p/(1 − p) = (1 + 2ap)/(1 − p) slots. The inverse is the utilization. tests/comm-arq.test.ts holds a seeded simulation of the exchange, slot by slot, to this to 3 %.</p>`,
        pitfall: `<p>Taking the closed forms for window-limited operation as exact. For go-back-N below the round trip, Stallings' expression is an approximation (the simulation is higher by up to 12 %), and selective repeat needs a window of several round trips for 1 − p. The tests say which regimes are exact.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: `A 10 ms path carries ${FRAME_BYTES}-byte frames at ${nf(RATE / 1e6, 0)} Mb/s. About how large must a sliding window be to keep the link busy?`,
        options: [`About ${fullWindow(a)} frames: the bandwidth-delay product, ${nf(2 * 10e-3 * RATE / 8 / 1000, 0)} kB, in frames, plus one`, '2 frames: one in flight and one being acknowledged', '10 frames: one per millisecond', 'It depends on the loss rate only'],
        answer: 0,
        explain: `The round trip is 20 ms, and a frame takes ${nf(FRAME_S * 1e6, 0)} µs to send, so ${nf(20e-3 / FRAME_S, 1)} frames fit in it, and one more is being sent.`,
        why: ['', 'A window of 2 gives 2 / ' + nf(rttOf(a), 0) + ' of the link, about ' + nf(200 / rttOf(a), 1) + ' %.', 'The unit is the frame time, not a millisecond: it is the round trip over the frame time.', 'Loss changes how much is wasted, not how many frames fit in a round trip.'],
      },
    },
    {
      title: 'Correcting instead of asking',
      get body() {
        const p = 1e-5, A = crcOnly(FRAME_BYTES, p), B = secdedCrc(FRAME_BYTES, p), c1 = crossover(FRAME_BYTES)!;
        const near = crossoverTime(FRAME_BYTES, RATE, 1e-6)!, far = crossoverTime(FRAME_BYTES, RATE, 0.25)!;
        return `
        <p><strong>Forward error correction</strong> pays for reliability in advance. The Hamming step's code can be run on the link: cut the frame and its CRC into 64-bit blocks, send each as a SEC-DED(${codeOf(64).n}, 64) word, correct the single errors in each block, and let the CRC and a retransmission handle what is left. The redundancy is fixed, ${codeOf(64).r} bits in ${codeOf(64).n} (rate ${nf(100 * codeOf(64).rate, 1)} %), whether or not errors occur. What it buys is that a frame fails only when some block has <em>two</em> errors.</p>
        <p>At a bit error rate of ${sci(p, 0)} a ${FRAME_BYTES}-byte frame (${withCommas(A.wire)} bits with its CRC) fails with probability ${nf(100 * A.pFail, 1)} %. With SEC-DED on ${withCommas(B.wire)} bits it fails with probability ${(100 * B.pFail).toExponential(1)} % (the formula is checked against the real encoder, errors and decoder, tests/comm-fec.test.ts). Whether that is a gain depends on what you count. <strong>Goodput</strong>, payload per wire bit, is ${nf(100 * A.goodput, 1)} % for CRC with retransmission and ${nf(100 * B.goodput, 1)} % for the code at this error rate; the code overtakes above ${sci(c1)}. <strong>Delivery time</strong> adds the round trip each repeat costs: with a one-way delay of 1 µs the code is faster only above ${sci(near)}, with 250 ms (a geostationary hop) above ${sci(far)}. A deep-space link, where the round trip is hours, cannot ask again at all and carries heavy redundancy.</p>
        <p>The trade has three axes: rate (what fraction of the wire carries payload), correction (how many errors per block), and latency (the cost of a repeat). A stronger code corrects more per block and costs more rate and decoder logic; the decoder here is ${withCommas(nands(hammingDec(64)))} NANDs. Real links burst, which this model does not capture: a burst breaks a Hamming block with many errors at once. <a href="#/c/codes/0">Codes near the limit</a> builds the stronger codes, and <span data-ahead="interleave">an interleaver (which spreads a burst over many words, so that each sees a few errors)</span>: the same trade with better numbers.</p>
        <div class="try">At 1500-byte frames set the one-way delay to 1 µs and move the bit error rate through 10<sup>−7</sup> to 10<sup>−4</sup>. Then slide the delay to 250 ms.</div>`;
      },
      widget: fecWidget,
      challenge: {
        kind: 'quiz',
        question: 'A link has a bit error rate of 10<sup>−6</sup> and a 1 µs one-way delay. A designer adds SEC-DED(72, 64) to every frame. What is the effect on goodput?',
        options: ['It falls: the 12.5 % redundancy is paid on every frame to avoid a few retransmissions', 'It rises: every bit error is now corrected', 'It does not change: the CRC still protects the frame', 'It falls to zero: the decoder cannot keep up'],
        answer: 0,
        explain: `At 10<sup>−6</sup> only ${nf(100 * crcOnly(FRAME_BYTES, 1e-6).pFail, 1)} % of 1500-byte frames are damaged; repeating them adds ${nf(100 * crcOnly(FRAME_BYTES, 1e-6).pFail / (1 - crcOnly(FRAME_BYTES, 1e-6).pFail), 1)} % to the wire, less than the code's ${nf(100 * (codeOf(64).n / 64 - 1), 1)} %.`,
        why: ['', 'It does correct them, but there are too few to repay the redundancy at this error rate and delay.', 'The CRC is unchanged, but the frame is longer on the wire and the wire carries the same payload rate it did, minus the check bits.', 'The decoder is ' + depth(hammingDec(64)) + ' levels deep and keeps up easily at this speed.'],
      },
    },
  ],
};
