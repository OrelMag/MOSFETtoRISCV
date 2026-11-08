// Codes near the limit: codes that correct far more than SEC-DED. Five steps moved here from When bits go wrong (chapters/stepmoves.ts). A convolutional encoder and a
// Viterbi decoder (lib/viterbi.ts, comm/conv.ts), Reed-Solomon's encoder, check and decoder (lib/rs.ts, lib/rsdec.ts, comm/rs.ts, comm/rsrtl.ts), interleaving
// (comm/interleave.ts), all of them on one Eb/N0 axis (comm/ber.ts), and LDPC on a model (comm/ldpc.ts). Computed here, or pinned in tests/comm-errors.test.ts, tests/comm-rsdec.test.ts, tests/comm-ldpc.test.ts.

import { codingGain, convHardBound, convSoftBound, ebn0For, rsCurve, secdedBer, shannonBinaryDb, shannonDb, uncodedBer } from '../comm/ber';
import { AWGN_SIGMA, becThreshold, concatRate, ebn0OfSigma, ldpcTrial, regularCode } from '../comm/ldpc';
import { rsLatency } from '../comm/rsrtl';
import { CONV_K3, CONV_K7, defaultDepth, metricWidth, spectrum } from '../comm/conv';
import { burstTolerance } from '../comm/interleave';
import { convEncoder, gfInvGates, gfMulGates, rsBuffer, rsDecoder, rsEncoder, rsSyndrome, vitAcs, vitSlice, viterbi } from '../lib';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import { CONCAT_FAILED_22, CONCAT_MEASURED, CONCAT_POINTS, CONCAT_WORDS, concatWidget, costWidget, GOSSIP_PAIR, gossipWidget, rsDecApi, rsDecScene, tunnelWidget, waterfallWidget } from '../widgets/codes2';
import { stats } from '../sim/stats';
import { berWidget, convEncApi, convEncScene, interleaveWidget, RS_CHECK, rsApi, rsScene, VIT_FLIPS, vitApi, viterbiScene } from '../widgets/codes';
import type { Chapter, Step } from './types';
import { numOf } from './order';
import { groupNum } from '../sim/numfmt';

const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const n0 = (x: number) => groupNum(Math.round(x));
const db = (x: number, d = 1) => `${x.toFixed(d)} dB`;
const nf = (x: number, d = 1) => x.toFixed(d);
const periodOf = (d: Parameters<typeof flatten>[0]) => analyzeTiming(flatten(d))?.period ?? 0;

/** Moved from When bits go wrong. */
const codeSteps: Step[] = [
  {
    title: 'A code with memory',
    get body() {
      const k3 = spectrum(CONV_K3, 8), k7 = spectrum(CONV_K7, 12);
      return `
      <p>Block codes cut the stream into words and treat each alone. A <strong>convolutional code</strong> does not cut it: every data bit makes two channel bits, each the parity of that bit and the last K − 1 bits; K, the <strong>constraint length</strong>, counts the bits one output depends on. The redundancy is spread along the stream, so there are no word boundaries for an error to fall across. The circuit is a shift register and two XOR trees: <span data-show="ff1 ff0">K − 1 flip-flops</span>, one tree per <em>generator</em>, <span data-show="xa1 xa2">one output</span> using all three taps and <span data-show="xb1">the other</span> the first and last (octal 7 and 5). It is ${nands(convEncoder(CONV_K3))} NANDs for K = 3, of which the flip-flops are most.</p>
      <p>The encoder is a state machine with 2<sup>K−1</sup> states, and the code's strength is a property of its paths: the <em>free distance</em> is the fewest channel bits in which two paths that split and rejoin can differ, and a search over the <em>trellis</em> (the states drawn over time, the next step's picture) finds it (the tests run one, comm/conv.ts). For K = 3 it is ${k3.dfree}, and a single 1 followed by zeros writes it out: 11 10 11. The code used by NASA's deep-space probes and by 802.11, K = 7 with generators 133 and 171 octal, reaches ${k7.dfree} with ${k7.A[k7.dfree]} such paths, at ${nands(convEncoder(CONV_K7))} NANDs: <em>encoding</em> a strong code costs next to nothing, and all the price is in the decoder. Our K = 7 encoder reproduces the worked example in the IEEE 802.11 task group's 1999 proposed text for the OFDM annex (document 99/077a): its 24-bit SIGNAL field to the 48 bits it tabulates. That draft lists the length before the rate; the final standard puts the rate first, so its example bits differ and are not claimed here.</p>
      <p>The rate is ½, double the bits, against SEC-DED's ${(100 * 64 / 72).toFixed(1)} %. That is a far higher price up front, and whether it pays is a later step's question.</p>
      <div class="try">Send 1, then 0, then 0: count the 1s in the three pairs. Then send 1, 1 and watch the state.</div>`;
    },
    scene: convEncScene,
    challenge: {
      kind: 'reach', goal: 'Put the encoder in the state where u = 0 gives a = 0 and b = 1.',
      check: (st) => st.value('u') === 0 && st.value('a') === 0 && st.value('b') === 1,
      hints: ['a = u ⊕ s1 ⊕ s0 and b = u ⊕ s0. With u = 0, b = 1 needs s0 = 1 and a = 0 needs s1 = 1.', 'A 1 enters at s1 and moves to s0 on the next edge: send two 1s.'],
      answer: 'Two 1s fill both flip-flops: state 11. With u = 0, a = 0 ⊕ 1 ⊕ 1 = 0 and b = 0 ⊕ 1 = 1.',
      solve: (st) => { convEncApi.get(st)?.send([1, 1]); st.setInput('u', 0); },
    },
    more: {
      real: `<p>Puncturing makes other rates from the same encoder and decoder: send only some of the bits on a fixed pattern (802.11's rates ⅔ and ¾, and 5⁄6 from 802.11n on). The decoder treats a missing bit as a level halfway between 0 and 1, so one piece of hardware serves every rate.</p>`,
    },
  },
  {
    title: 'The Viterbi decoder',
    get body() {
      const w3 = metricWidth(CONV_K3.K, 1), w7 = metricWidth(CONV_K7.K, 1), d7 = defaultDepth(CONV_K7.K), V3 = viterbi(CONV_K3), V7 = viterbi(CONV_K7), V7s = viterbi(CONV_K7, { q: 3 });
      const slice7 = nands(vitSlice(w7, d7, 0)), acs7 = nands(vitAcs(w7));
      return `
      <p>The best decoder picks the sent stream closest to what arrived, and there are 2<sup>L</sup> streams of L bits. <strong>Viterbi's</strong> observation is that two streams in the same state at the same moment have the same future, so only the cheaper can ever win. So keep one path per state and extend every state once per symbol. The work per bit is constant, and the stream can be any length.</p>
      <p>That is one small circuit per state. <span data-show="bm">Branch metrics</span> say how far the received pair is from each of the four pairs the encoder can send; with a hard decision that is the number of differing bits. Each <span data-show="u0 u1 u2 u3">state</span> holds an <em>add-compare-select</em> (two adders, a subtractor, a multiplexer), a <em>path metric</em> and a <em>survivor</em>. Open one. Three details make it hardware: metrics are never normalized, they wrap at ${w3} bits here (${w7} for K = 7), and the comparison is the top bit of a subtraction, correct because no two metrics compared ever differ by half the range; ties go to the lower predecessor; and the survivor is <em>register exchange</em>, the winner's whole register copied each clock with this state's input bit shifted in, so there is no traceback to control.</p>
      <p>The price is ${n0(nands(V3))} NANDs here, and <strong>${n0(nands(V7))} for K = 7</strong> (64 states, ${d7}-bit survivors), about the size of the complete RV32IM system CPU. One state is ${n0(slice7)} NANDs and its add-compare-select only ${n0(acs7)}: survivors are nearly everything. Real decoders store the selects in RAM and trace back, trading those flip-flops for control and latency. Reading from a fixed state, as here, wants depth: the survivors must have merged by the time they are read. This decoder uses ten constraint lengths, a safe margin; measured with three-bit levels at 4 dB, seven is already within a factor of two of it, while five (the textbook figure for reading from the best state, at the cost of comparing all 64 metrics) is over five times worse (tests/comm-codes.test.ts).</p>
      <p><strong>Soft decisions</strong> are the cheapest gain in communications. The slicer throws away how sure it was; keep three bits of that and the metric becomes a distance in voltage, not a count of bits. The same decoder with three-bit levels is ${n0(nands(V7s))} NANDs, ${(100 * (nands(V7s) / nands(V7) - 1)).toFixed(0)} % more, and needs about ${db(ebn0For((d) => convHardBound(CONV_K7, d), 1e-5) - ebn0For((d) => convSoftBound(CONV_K7, d), 1e-5), 1)} less signal by the bounds, of which three-bit levels give up about a quarter of a dB. tests/comm-codes-gates.test.ts compares every metric, select and survivor bit with the model every clock, K = 3 and K = 7, hard and soft.</p>
      <div class="try">Press <strong>Run</strong> on a clean channel, then flip one or two bits apart from each other. Then find three that beat it.</div>`;
    },
    scene: viterbiScene,
    lit: 'The branch metrics and the four states.',
    challenge: {
      kind: 'reach', goal: 'Flip three channel bits close together so that the decoder delivers a wrong bit.',
      check: (st) => { const a = vitApi.get(st); return !!a && a.done() && a.flips() === 3 && a.wrong() > 0; },
      hints: ['The free distance is 5, so three flips can land a wrong path closer than the sent one if they fall on the bits where those paths differ.', `Try the middle of the stream, within two or three pairs: bits ${VIT_FLIPS.join(', ')} work.`],
      answer: `Three errors among the five positions where another path differs make that path two bits from the received stream and the sent path three, and the decoder rightly picks the nearer one. Flipping bits ${VIT_FLIPS.join(', ')} does it. Distance 5 guarantees only two errors in any span where paths differ.`,
      solve: (st) => { const a = vitApi.get(st); if (!a) return; a.clear(); VIT_FLIPS.forEach((i) => a.flip(i)); a.run(); },
    },
    more: {
      pitfall: `<p>Starting the metrics at zero says nothing about the state, which is why this decoder is weakest on the first few pairs: there, two flips can already beat it. A real link starts from a known state or transmits a preamble, and ends a block with K − 1 zeros (the panel's flush) so the last bits are as safe as the rest.</p>`,
    },
  },
  {
    title: 'Reed-Solomon: errors in bytes',
    get body() {
      const t32 = 16;
      return `
      <p><strong>Reed-Solomon</strong> codes treat bytes as the symbols. A byte is an element of GF(256): adding is XOR, and multiplying is polynomial multiplication reduced by x<sup>8</sup> + x<sup>4</sup> + x<sup>3</sup> + x<sup>2</sup> + 1. The code words are the multiples of a generator with roots α<sup>0</sup> … α<sup>2t−1</sup>, and 2t check bytes correct any t wrong bytes. Nothing can do better, since t errors must not reach halfway between two code words: this is the maximum distance a code of that size can have. A byte wrong in all eight bits costs what a byte wrong in one bit does, so a burst of up to ${8 * (t32 - 1) + 1} bits is at most ${t32} bytes, within RS(255, 223)'s t = ${t32}.</p>
      <p>The encoder is the CRC's circuit with bytes for bits: polynomial division by a shift register, here ${10} byte <span data-show="s0 s1 s2 s3 s4 s5 s6 s7 s8 s9">stages</span>, each with a constant multiplier. A constant multiplier has no multiplier in it: multiplying by a fixed element is linear over GF(2), so each output bit is an XOR of input bits, found the way the CRC's network was. <span data-show="fgate">The feedback</span> is the data byte plus the top register while the message goes in; then it is zero and <span data-show="pass">the output</span> shifts the check bytes out. ${n0(nands(rsEncoder(10)))} NANDs for 10 check bytes, ${n0(nands(rsEncoder(32)))} for RS(255, 223)'s 32. The panel's message is the one in the published QR example, and the gates end on its check bytes. The receiver's first step is as cheap: evaluate the word at each root, one byte a clock (${n0(nands(rsSyndrome(10)))} NANDs for 10); a code word leaves all of them at zero.</p>
      <p>Correcting is where the cost is: general multiplications, ${n0(nands(gfMulGates()))} NANDs apiece against a few dozen for a constant. The panel here decodes with the software model (comm/rs.ts); the next two steps build the decoder. This is the family in CDs, QR codes, DVB and, as RS(544, 514) over a ten-bit field, 400 Gb/s Ethernet. The field polynomial above is the one QR and DVB use; the deep-space standard's Reed-Solomon code is the same family over a different polynomial (and a dual basis), so its bytes are not interchangeable with these.</p>
      <div class="try">Encode the message and compare with the published bytes. Then corrupt five bytes, then six.</div>`;
    },
    scene: rsScene,
    challenge: {
      kind: 'reach', goal: `Clock the 16 data bytes in, so the registers hold the published check bytes, starting ${RS_CHECK[0]} (0x${RS_CHECK[0].toString(16).toUpperCase()}).`,
      check: (st) => { const r = rsApi.get(st)?.regs(); return !!r && r.every((v, i) => v === RS_CHECK[i]); },
      hints: ['Press Encode the message: it clears the registers and clocks the bytes in with msg = 1.'],
      answer: 'The registers hold the remainder of the message, multiplied by x¹⁰, divided by the generator. For this message the remainder is the ten check bytes of the published example.',
      solve: (st) => rsApi.get(st)?.send(),
    },
  },
  {
    title: 'Bursts: interleaving',
    get body() {
      return `
      <p>Real channels do not flip bits one at a time. A scratch, a fade, or a lightning strike takes out a run, and the codes above, Viterbi's most of all, fail badly when errors arrive together, whatever their average rate. <strong>Interleaving</strong> changes the errors instead of the code: write D words as rows, send the columns. A burst of b channel bits now puts at most ⌈b / D⌉ errors in any word, so a code correcting t per word survives any burst up to D · t: ${burstTolerance(32, 1)} bits for 32 SEC-DED words, ${8 * (burstTolerance(8, 16) - 1) + 1} bits for eight RS(255, 223) words, whose t counts bytes (a burst that long can touch at most ${burstTolerance(8, 16)} bytes, however it falls).</p>
      <p>It adds no redundancy, so the rate does not change, and costs two things: a buffer of D words at each end, and D words of delay, since nothing can be read until the block is full. That delay is why a voice call interleaves less than a broadcast. The two kinds of code combine well. The deep-space standard (CCSDS) runs K = 7 inside and RS(255, 223) outside: Viterbi turns a noisy channel into a nearly clean one whose rare errors come in bursts, an interleaver spreads those bursts, and Reed-Solomon cleans up what remains.</p>
      <div class="try">At depth 1, a burst of 6 costs a word. Raise the depth until it costs none, then raise the burst past the depth.</div>`;
    },
    widget: interleaveWidget,
    challenge: {
      kind: 'quiz',
      question: 'A link sends SEC-DED words and suffers bursts of at most 20 bits. What is the smallest block interleaver depth that makes every burst harmless?',
      options: ['20 words: ⌈20 / D⌉ must be at most the one error each word corrects', '2 words: SEC-DED detects two errors', '72 words: one for each bit of a word', 'None: interleaving adds no redundancy, so it cannot help'],
      answer: 0,
      explain: 'A burst of b gives ⌈b / D⌉ errors in the worst word, and SEC-DED corrects one, so D ≥ b. The cost is 20 words of buffer at each end and 20 words of delay.',
      why: ['', 'Detecting is not correcting, and two words would each take 10 errors.', 'The word length does not enter: the burst only has to be spread across enough words.', 'It adds none, but it moves errors from one word to many, each of which has redundancy to spare.'],
    },
  },
  {
    title: 'How far from Shannon',
    get body() {
      const T = 1e-5, un = ebn0For(uncodedBer, T), lim = shannonDb(0.5), limB = shannonBinaryDb(0.5);
      const gain = (f: (d: number) => number) => codingGain(f, T), se = (d: number) => secdedBer(d), rs = (d: number) => rsCurve(d, 255, 223), hard = (d: number) => convHardBound(CONV_K7, d), soft = (d: number) => convSoftBound(CONV_K7, d);
      return `
      <p>A fair comparison needs one axis, and <a href="#/c/noise/4">E<sub>b</sub>/N<sub>0</sub></a> is it, energy per <em>data</em> bit over the noise density. What a code adds is its rate: a code of rate R spends that energy on 1/R channel bits, each of which sees R · E<sub>b</sub>/N<sub>0</sub>: its raw error rate is Q(√(2R · E<sub>b</sub>/N<sub>0</sub>)), so a rate ½ code starts 3 dB behind. Forgetting this makes every code look better than it is. <em>Coding gain</em> is what is left: how much less signal the coded link needs for the same decoded error rate.</p>
      <p>At 10<sup>−5</sup> uncoded BPSK (the ±1 signalling of the noise chapter) needs ${db(un, 2)}. SEC-DED(72, 64) gains ${db(gain(se))} and RS(255, 223) ${db(gain(rs))}, at high rates and with hard decisions. K = 7 gains ${db(gain(hard))} with hard decisions and ${db(gain(soft))} with soft ones, for half the rate. Each dB is bandwidth or range you did not have to buy: at ${db(gain(soft))}, a link needs about a third of the transmit power, or reaches ${Math.sqrt(10 ** (gain(soft) / 10)).toFixed(1)} times as far in free space.</p>
      <p><strong>The limit.</strong> At rate ½, Shannon's bound says errors can be made as rare as you like above ${Math.abs(lim) < 0.005 ? '0 dB' : db(lim, 2)}, or ${db(limB, 2)} if the only inputs are ±1, and at any rate no lower than ${db(shannonDb(1e-6), 2)}. K = 7 soft at 10<sup>−5</sup> sits ${db(ebn0For(soft, T) - limB)} above it. Modern codes close that gap with long blocks and iterative decoding, as the next steps show. <strong>Whether to code at all</strong> is still the trade of <a href="#/c/errors/8">Correcting instead of asking</a>: redundancy against repeating, and a good link with a short round trip often should simply ask again.</p>
      <div class="try">Slide to 4 dB and press <strong>Run the decoder</strong>. Each decoder runs until it has counted 100 errors or 400 000 bits. The hard dot lands well below its bound, which is loose this high up. Soft errors are rare here (the curve says about 2 in 100 000 bits), so its run ends on the bit limit with only a handful of errors, and its dot lands within a small factor of the curve, above it by the quarter of a dB that three-bit levels lose and by the noise of so small a count. At 5 dB or more it sees none: the dot turns hollow and marks 1 in the number of bits, a ceiling, not a measurement.</div>`;
    },
    widget: () => berWidget(),
    more: {
      derive: `<p>For a soft decoder, a wrong path at distance d wins when the noise projected on the difference exceeds half of it: Q(√(2 d R E<sub>b</sub>/N<sub>0</sub>)). Summing over all error events weighted by the data bits they get wrong is the union bound, Σ B<sub>d</sub> Q(·), and comm/conv.ts computes B<sub>d</sub> from the generators. It overcounts when many paths are likely at once, so it is loose at high error rates and tight at low ones. tests/comm-codes.test.ts holds the real decoder at 4 dB to the bound at 3.75 dB within 35 %.</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: `Rate ½ K = 7 with soft decisions gains about 5 dB at 10⁻⁵, although each of its channel bits has 3 dB less energy than an uncoded bit. Which statement is right?`,
      options: ['The 3 dB is already counted: the gain is measured per data bit, so the channel bits are noisier and the decoder more than repays it', 'The gain is really 8 dB, since 3 dB must be added back', 'The gain is really 2 dB, since 3 dB must be subtracted', 'Rate does not matter on this axis: the channel error rate is the same for every code'],
      answer: 0,
      explain: 'On an Eb/N0 axis the energy per data bit is the same for every code, and each code\'s channel error rate is computed at R · Eb/N0. The curves already include the rate; reading a gain off the plot needs no correction.',
      why: ['', 'Adding it back would compare energy per channel bit for one code and per data bit for another.', 'Subtracting counts the rate twice: it is already in the coded curve.', 'A lower rate means less energy per channel bit, hence more raw errors: compare the table\'s third column.'],
    },
  },
];

const decodeLocator: Step = {
  title: 'The decoder: where the errors are',
  get body() {
    const D = rsDecoder(10, 26), n32 = nands(rsDecoder(32, 255)), mul = nands(gfMulGates());
    return `
      <p>The syndromes are the only clue. Write the errors as positions X<sub>i</sub> and values e<sub>i</sub>, and each syndrome is S<sub>k</sub> = Σ e<sub>i</sub> X<sub>i</sub><sup>k</sup>: 2t equations, nonlinear, in up to t positions and t values. <strong>Berlekamp-Massey</strong> reads the list differently. A sum of powers is exactly what a linear feedback shift register generates, so it asks for the shortest register that produces S<sub>0</sub>, S<sub>1</sub> … Its feedback polynomial, the <strong>locator</strong> Λ, has the inverses of the X<sub>i</sub> as roots, and its length is the number of errors. It takes one iteration per syndrome: compare the next syndrome with what the register predicts (the discrepancy δ), and if they differ, patch the register with an old version of itself.</p>
      <p>In gates that loop is one clock. <span data-show="s0 s1 s2 s3 s4 s5 s6 s7 s8 s9">The ten syndrome registers</span> are Horner evaluators while the word arrives, and then a ring that rotates, so its tail is the window δ needs and no second register is spent. <span data-show="dl">The discrepancy</span> is six general multipliers and an XOR tree. <span data-show="l0 l1 l2 l3 l4 l5">Each λ<sub>j</sub></span> has two more (λ<sub>0</sub> one), since λ<sub>j</sub> ← γ λ<sub>j</sub> + δ b<sub>j−1</sub>. The textbook form divides by the old discrepancy; this <em>inversionless</em> form multiplies by it (<span data-show="gam">γ</span>) and carries the scale along, which trades one divider for twice the multipliers, and takes the division out of the clock period.</p>
      <p>Ω, the polynomial the error values will need, is Σ λ<sub>j</sub> S<sub>i−j</sub>: the same sum δ computes. So after 2t iterations the ring goes around again for t clocks, and <span data-show="dl">the same unit</span> fills <span data-show="o0 o1 o2 o3 o4">Ω</span>, for no new multipliers.</p>
      <p>The whole decoder is <strong>${n0(nands(D))} NANDs</strong>: 22 general multipliers at ${mul} each are ${n0(22 * mul)} of them, and <span data-show="buf">the buffer</span> holding the word while all this happens ${n0(nands(rsBuffer(26)))}. That is RS(26, 16). RS(255, 223), whose t is 16, is ${n0(n32)} NANDs, the same order as the system CPU. comm/rsrtl.ts states every rule, and tests/comm-rsdec.test.ts holds every register to it every clock, and its answers to the software decoder.</p>
      <div class="try">Set <strong>Bytes hit</strong> to 3 and press <strong>Next phase</strong> twice. Then read the length of λ: three non-zero terms past the first. Then Decode with 1 hit, and with 5.</div>`;
  },
  scene: rsDecScene,
  lit: 'The syndromes, the discrepancy and the locator.',
  challenge: {
    kind: 'reach', goal: 'Hit five bytes, the most this code can take, and decode the word back to what was sent.',
    check: (st) => { const a = rsDecApi.get(st); return !!a && a.hits() === 5 && a.finished() && !a.failed() && a.right(); },
    hints: ['Set Bytes hit to 5, then press Decode.'],
    answer: 'Ten check bytes correct any five wrong bytes. The gates find a locator of degree 5, five roots, and five values.',
    solve: (st) => rsDecApi.get(st)?.decode(5),
  },
};

const decodeFix: Step = {
  title: 'The decoder: fixing them',
  get body() {
    return `
      <p>Finding the positions is a search, and hardware searches by evaluating. <strong>Chien's search</strong> asks at each position whether Λ is zero there. Registers hold λ<sub>j</sub> X<sup>−j</sup> for the current position, so moving on one byte is a constant multiplication per register, α<sup>j</sup>, and a constant multiplier is only XORs. The sum of the registers is Λ's value, and it happens to arrive exactly as that byte leaves the buffer. Since the first byte sent is the highest power, one more constant multiplier per register, once, starts it at position n − 1. <span data-show="fr">Forney's formula</span> gives the error there: Ω's value over Λ's derivative. In characteristic 2 the derivative keeps only the odd terms, which the search has already summed, and the factor of X cancels, so e = Ω / odd. Only the inverse remains. a<sup>−1</sup> = a<sup>254</sup>, by an addition chain of four general multiplications and some squarings, which are wires and XORs: ${n0(nands(gfInvGates()))} NANDs and no table.</p>
      <p>That gives RS(26, 16) a latency of ${rsLatency(10, 26)} clocks: 26 in, 10 for the locator, 5 for Ω, 1 to set up, 26 out. Its period is ${nf(periodOf(rsDecoder(10, 26)), 0)} gate delays: the discrepancy's multipliers and XOR tree, then δ · b and the λ update, two general multipliers in series. So this design is small and slow. Fast decoders pipeline that loop into an array of simple cells, and the folded ones in low-rate parts share one multiplier over many clocks, which is the trade the streaming FFT made.</p>
      <p><strong>Past t,</strong> the hardware's knowledge is one comparison: a locator of degree L must have exactly L roots among the positions, and if not, the word is not correctable. <span data-show="kk">One counter</span> serves both: it holds r − 2L during the iterations, and adds 2 for each root found, so <em>fail</em> is that it did not end at 2t. A decoder that streams its bytes has sent them by then, so fail is a flag beside the data, for a layer above. And in rare cases a word past t lies within t of a different code word, the decoder finds that, and no flag rises: tests/comm-rsdec.test.ts finds this model and the software decoder agreeing on every such case, and this is why a CRC stays above the code.</p>
      <div class="try">Decode at 5 and at 6. Press <strong>Next phase</strong> through CH with 6 hit, and watch what comes out while the flag has yet to rise.</div>`;
  },
  scene: rsDecScene,
  lit: 'Chien, Forney, and the counter that gives the verdict.',
  challenge: {
    kind: 'reach', goal: 'Hit six bytes and watch the decoder refuse the word.',
    check: (st) => { const a = rsDecApi.get(st); return !!a && a.hits() === 6 && a.finished() && a.failed(); },
    hints: ['Set Bytes hit to 6, then press Decode.'],
    answer: 'Six errors take more than t = 5. Berlekamp-Massey still produces a locator, but it does not have as many roots as its degree, the counter does not end at 2t, and fail rises at the end.',
    solve: (st) => rsDecApi.get(st)?.decode(6),
  },
};

const concatStep: Step = {
  title: 'Two codes, one link',
  get body() {
    const [d1, d2, d8] = CONCAT_MEASURED, tot = CONCAT_WORDS, pc = (x: number) => `${(100 * x / tot).toFixed(1)} %`;
    return `
      <p>Neither code gets near the limit alone, and they fail in opposite ways. Viterbi is good while the channel is bad, and its errors, when they come, come as bursts, a wrong path followed for a few constraint lengths. Reed-Solomon needs a nearly clean channel, and does not care how wrong a byte is. So give Reed-Solomon the output of Viterbi: K = 7 inside, RS(255, 223) outside, and the interleaver between them. That is the shape of the deep-space standard, and of many that followed. Its rate is ½ · 223 / 255 = ${nf(concatRate(), 3)}.</p>
      <p>The whole link is here as a model, on the same comm/conv.ts and comm/rs.ts as the gates. At 2.3 dB, with 384 words sent at each depth, ${d1} words fail at depth 1 (${pc(d1)}), ${d2} at depth 2 (${pc(d2)}), and ${d8} at depth 8 (${pc(d8)}): the same channel, the same two codes, and a factor of ${(d1 / d8).toFixed(0)} from the arrangement of the bytes. At depth 8 the words behave nearly as if their bytes failed independently, and the binomial tail of 255 bytes predicts the measurement to within a factor of two (tests/comm-codes-chapter.test.ts). A word's failure is a cliff: at 2.2 dB, ${pc(CONCAT_FAILED_22)} of the depth-8 words fail, at 2.3 dB ${pc(d8)}.</p>
      <p>Compare K = 7 alone at 2.3 dB: its bound is ${convSoftBound(CONV_K7, 2.3).toExponential(0)}, where the link's data bits come through at ${CONCAT_POINTS[1][1].toExponential(0)}, at a slightly lower rate. The price is a block of ${8 * 255} bytes of delay at each end, and a decoder of each kind.</p>
      <div class="try">Send a frame at 2.2 dB at depth 1, then at depth 8. Find a word over the line at depth 1. At depth 8 the same kind of burst is shared among eight words.</div>`;
  },
  widget: concatWidget,
  challenge: {
    kind: 'quiz',
    question: 'In the concatenated link, why does Reed-Solomon go outside and Viterbi inside, and not the other way round?',
    options: ['Viterbi profits from the channel\'s soft levels and turns noise into rare bursts; Reed-Solomon then corrects bytes however wrong they are. In the other order, RS would face raw noise it cannot correct, and its bursts of wrong bytes would defeat Viterbi', 'Viterbi is cheaper, so it must be the last to run', 'Reed-Solomon has to see the data first, to compute its check bytes on it', 'Either order gives the same result, since they are both linear'],
    answer: 0,
    explain: 'The inner code must cope with the channel as it is, and only Viterbi uses soft levels. Its failures look like bursts, and that is what the outer code is best at. The transmitter is simply the mirror: outer code first, inner code last.',
    why: ['', 'Cost does not set the order: both are decoded on every word regardless.', 'Both orders would see the data at some point; the question is which sees the channel.', 'Linearity says nothing about how they fail on noise. Measure it: bursts are what matter.'],
  },
};

const gossip: Step = {
  title: 'Decoding by gossip',
  get body() {
    return `
      <p>Viterbi looks at all paths and Reed-Solomon solves equations. Neither scales to a word of thousands of bits at a rate close to capacity: Shannon's proof needs long random codes, and a decoder for a long random code looks hopeless. Gallager's answer, in the early 1960s, largely forgotten for thirty years: a code defined by checks that each touch only a few bits, <strong>low-density parity checks</strong>, and a decoder that does nothing but pass messages along the checks.</p>
      <p>Draw it as a graph, bits below and checks above. Every bit starts with what the channel said, as a log-likelihood ratio L = ln P(0) / P(1), positive for "probably 0", large for "sure". In each round every bit tells each of its checks what it believes, leaving out what that check last told it; and every check tells each of its bits what the others imply: their parity for the sign, and for the size 2 atanh Π tanh(L / 2), which is about the least sure of them. A bit adds up what it hears. That is <strong>belief propagation</strong>, and the leaving-out is the essential part: a message must carry only new information, or a bit would hear its own opinion back as confirmation.</p>
      <p>On a graph with no cycles this is exactly right, not an approximation: tests/comm-ldpc.test.ts holds it to the true a-posteriori probabilities, summed by brute force over every code word. A real code has cycles, and then messages eventually contain their own past. It works as long as the cycles are long compared with the number of rounds, which is why long sparse codes do so well, and why a code's construction avoids short cycles. The graph here is small and full of short cycles, so nothing is safe: its checks share more than two bits on average. Replace tanh by the minimum and you have <strong>min-sum</strong>, which needs only comparators, loses a fraction of a dB, and is what hardware usually builds, with a scale factor to win most of that back.</p>
      <div class="try">Make bits ${GOSSIP_PAIR[0]} and ${GOSSIP_PAIR[1]} wrong and iterate: the unhappy checks light up, then go out. Then make every bit unsure and only one wrong: with nothing solid to lean on, it never settles. Then try other pairs: many come back, and some cannot, even though each one flipped alone does.</div>`;
  },
  widget: gossipWidget,
  challenge: {
    kind: 'quiz',
    question: 'A bit\'s message to a check leaves out what that check told it last round. What goes wrong if it does not?',
    options: ['The check hears its own opinion back as if it were independent evidence, and the beliefs grow without information', 'Nothing: the sum only gets larger, and that is safe', 'The decoder would need more memory, but gives the same answer', 'The check\'s parity no longer holds'],
    answer: 0,
    explain: 'Each message is meant to be independent evidence for the receiver. Echoing its own message counts it twice, and the error then reinforces itself, which is why every check-to-bit and bit-to-check message excludes its receiver.',
    why: ['', 'Large beliefs that are wrong are the failure: they stop the decoder from changing its mind.', 'It changes the answer, not only the storage.', 'The parity is computed over hard decisions at the end, not over messages.'],
  },
};

const threshold: Step = {
  title: 'A threshold you can compute',
  get body() {
    const th = becThreshold(), lo = ebn0OfSigma(AWGN_SIGMA[1]), hi = ebn0OfSigma(AWGN_SIGMA[0]), lim = shannonBinaryDb(0.5);
    return `
      <p>A strange thing about long sparse codes: a typical one's behaviour can be worked out exactly, with no code in sight. Pick the simplest channel, which erases a bit with chance ε and never lies. On a graph that looks like a tree for many rounds, a bit-to-check message is erased if the channel erased the bit and all its other checks' messages are erased; a check-to-bit message is erased if any of its other bits' is. For bits of degree 3 and checks of degree 6 the erased share x follows <strong>x′ = ε (1 − (1 − x)<sup>5</sup>)<sup>2</sup></strong>. This is <strong>density evolution</strong>.</p>
      <p>Decoding succeeds exactly when that map has no fixed point above 0, and that is a sharp edge in ε, the code's <strong>threshold</strong>. Bisection on the recursion gives ε* = ${th.toFixed(4)}, the value in the literature for this pair (for one, arXiv 1102.5087). Shannon's limit at rate ½ is ε = 0.5, so a code with only two degrees has come ${(0.5 - th).toFixed(3)} short of it. A real code with 4000 bits, seeded, in the same widget, finishes or stalls on the same side of ε* nearly everywhere; the closer to it, the longer the code must be.</p>
      <p>The Gaussian channel needs whole distributions in place of one number. Discretized, the same computation gives this code's threshold between σ = ${AWGN_SIGMA[0]} and ${AWGN_SIGMA[1]}, E<sub>b</sub>/N<sub>0</sub> between ${nf(lo, 2)} and ${nf(hi, 2)} dB, against a limit of ${nf(lim, 2)} dB for ±1 inputs. So already about ${nf((lo + hi) / 2 - lim, 1)} dB from Shannon, with no search. <strong>Irregular</strong> degree profiles, with a few bits of very high degree, shift the threshold further: their design is a matter of shaping the curve to hug the diagonal, and one family designed this way has a threshold within 0.0045 dB of the limit (Chung, Forney, Richardson and Urbanke, 2001); their simulated blocks of ten million bits came within a few hundredths of a dB.</p>
      <div class="try">Move ε past ${th.toFixed(3)}, watching the tunnel close. Then go to just below it, and count the rounds. Then see where the 4000-bit code begins to fail.</div>`;
  },
  widget: tunnelWidget,
  challenge: {
    kind: 'quiz',
    question: `At ε just below ${becThreshold().toFixed(3)}, density evolution says a (3, 6) code recovers everything, yet a real 4000-bit code can stall there. Which statement is right?`,
    options: ['The threshold is for a code in the limit of long blocks, where the graph looks like a tree for many rounds; a finite code has cycles and random fluctuation, so its edge is blurred and lower', 'The recursion must be wrong, since it fails on a real code', 'Real codes do better than the threshold, since their cycles add information', 'Shannon\'s limit prevents decoding that close to 0.5'],
    answer: 0,
    explain: 'Density evolution is exact as blocks grow, for almost any code in the ensemble. For a finite block it is a limit that the real code approaches from below as its length grows. The tests hold long codes on the correct side well away from it.',
    why: ['', 'It predicts the limit exactly: tests/comm-ldpc.test.ts follows a long code round by round down the recursion.', 'Cycles make messages less independent, and that hurts.', 'The threshold here is below capacity: Shannon allows up to 0.5.'],
  },
};

const fallStep: Step = {
  title: 'The waterfall',
  get body() {
    const T = 1e-5, soft = (d: number) => convSoftBound(CONV_K7, d);
    return `
      <p>Now the same axis as before, with real runs. A long code stays poor up to its threshold and then its error rate falls off a cliff, far steeper than a convolutional code's curve: that is the <strong>waterfall</strong> this family is named for. K = 7 soft reaches 10<sup>−5</sup> at ${db(ebn0For(soft, T))}; the limit is ${db(shannonBinaryDb(0.5), 2)}. The dots are this page running belief propagation at each E<sub>b</sub>/N<sub>0</sub>, until 400 errors or 600 words, on a seeded (3, 6) code of the chosen length.</p>
      <p>Word length is delay, and it buys steepness. Even 504 bits beat K = 7 soft: at 2.4 dB, about 6 in 10 000 against the bound's 6 in 1000. At 1.6 dB, 504 bits still lose more than 1 % and 8064 bits make no error in the first 200 000. Sum-product and scaled min-sum differ by a small part of a dB at short lengths, a little more at long ones, which is why hardware takes the comparators. The concatenated link's squares sit to the right of the longer words' dots, at the lower rate of ${nf(concatRate(), 3)}.</p>
      <p>What the plot cannot reach is an <strong>error floor</strong>. Far below these rates, small structures in the graph (trapping sets) cause failures that more signal hardly helps, and that decides many designs: a link that must reach 10<sup>−15</sup>, as a fibre does, adds an outer code again to clean up.</p>
      <div class="try">Run at 2016 bits. Then 504, then 8064. Then change the decoder to min-sum at 2016 and read how far the dots move.</div>`;
  },
  widget: waterfallWidget,
  challenge: {
    kind: 'quiz',
    question: 'Why not simply use an LDPC word of a million bits for every link?',
    options: ['A word can only be decoded once all of it has arrived, so its length is delay, plus the memory for every message on every edge', 'Longer words have higher error rates at every Eb/N0', 'Belief propagation does not converge past a certain length', 'Shannon\'s limit only applies to short words'],
    answer: 0,
    explain: 'Every bit must arrive before the last checks can be used, so a million bits at 100 Mb/s is 10 ms before any iteration starts. Memory grows with the edges, too. Latency-sensitive links choose short words and accept a worse waterfall.',
    why: ['', 'Longer words are better past the threshold: that is the plot.', 'The tree-like neighbourhood gets better with length, not worse.', 'Shannon\'s limit is about long words: short words sit further from it.'],
  },
};

const costStep: Step = {
  title: 'What near the limit costs',
  get body() {
    const code = regularCode(2016, 3, 6, 5), run = ldpcTrial(code, 2, 40, { seed: 2, maxIter: 60 }), msgs = (2 * 3) / 0.5, k7 = 2 * 64, v = nands(viterbi(CONV_K7));
    return `
      <p>The operation count is the first surprise. A (3, 6) code at rate ½ has 3 edges a bit, 2 messages an edge a round, so ${msgs} messages a round per data bit. At 2 dB on a 2016-bit word it averages ${nf(run.meanIter, 1)} rounds, so about ${n0(msgs * run.meanIter)} message updates a data bit. K = 7 Viterbi does ${k7} branch additions a data bit, two for each of its 64 states. They are about equal in arithmetic, at a point on the plot Viterbi cannot reach.</p>
      <p>The cost that decides is elsewhere. Viterbi's memory is its survivors, ${n0(v)} NANDs in register-exchange form. An LDPC decoder must hold a message per edge and a word of soft bits, and every check must reach bits spread across the whole block: a parallel decoder is mostly wires, and a serial one mostly memory and control. So no standard uses a purely random graph. They use <strong>quasi-cyclic</strong> codes, a small base graph lifted by replacing each edge with a cyclically shifted bundle of edges. The shifts are small barrel shifters, a block of memory serves each bundle, and the structure does not noticeably hurt the threshold. A base-graph construction is also how such a code gets many rates and lengths from one table.</p>
      <p>Who uses what, and why: <strong>DVB-S2</strong> broadcasts long LDPC frames of 64 800 bits with an outer BCH code to clean up the floor, since a broadcast can afford the delay and nobody can ask for a repeat. <strong>10GBASE-T</strong> runs LDPC over twisted pair. <strong>802.11n and later</strong> offer LDPC beside the old K = 7. <strong>5G NR</strong> chose LDPC for data and polar codes for control messages, which are short. <strong>Turbo codes</strong> (Berrou, Glavieux and Thitimajshima, 1993), two convolutional codes passing beliefs between them, started all of this, and ran 3G and LTE. Each generation's choice is a position on the same axes: gain, delay, power and silicon, and how close Shannon's limit is worth being.</p>
      <p>Inside a computer the same toolbox is used at the other end of the scale. <span data-ahead="pcie">PCI Express, the next chapter's serial link between chips,</span> checks each packet with a 32-bit CRC and, when the far end reports one damaged, <span data-ahead="replay">sends it again from a copy it keeps until the far end confirms it</span> (<a href="#/c/errors/7">When bits go wrong</a>), sends 8b/10b or 128b/130b on its lanes (<a href="#/c/serial/1">Fast serial links</a>), and at the rates of PCIe 5 and below uses no forward correction at all: a short link with a round trip under a microsecond simply asks again.</p>`;
  },
  widget: () => costWidget(),
  challenge: {
    kind: 'quiz',
    question: 'What does a quasi-cyclic structure give an LDPC decoder that a random graph of the same size does not?',
    options: ['Bundles of edges that are cyclic shifts of each other, so messages move between blocks of memory through barrel shifters, not through a block-wide tangle of wires', 'A higher threshold, closer to the limit', 'No need for iterations', 'A smaller minimum distance'],
    answer: 0,
    explain: 'The decoding operations are the same, but the addresses are now regular, and that is what makes the block-wide connectivity implementable.',
    why: ['', 'If anything it gives up a little threshold. It is done for the wiring.', 'It iterates just as any belief propagation does.', 'A smaller minimum distance would be a cost, not a gain.'],
  },
};

export const chCodes: Chapter = {
  id: 'codes', num: numOf('codes'), title: 'Codes near the limit', level: 'Communication',
  blurb: 'How close to Shannon can we get: Viterbi and a whole Reed-Solomon decoder in gates, interleaving, two codes together, and LDPC decoded in the page against its computed threshold.',
  goals: [
    'read a convolutional encoder and a Viterbi decoder in gates, and say where their cost lies',
    'follow Reed-Solomon\'s decoder clock by clock: syndromes, Berlekamp-Massey, Ω, Chien and Forney, and what it does past t',
    'combine an inner and an outer code through an interleaver, and measure why the order and the depth matter',
    'run belief propagation by hand, compute a threshold by density evolution, and read a waterfall against the limit',
    'compare codes on one Eb/N0 axis by their coding gain, and say what a quasi-cyclic structure buys an LDPC decoder',
  ],
  builds: ['noise', 'errors', 'modem', 'carriers'],
  recap: {
    keep: [
      `A convolutional encoder is a shift register and XOR trees, ${nands(convEncoder(CONV_K3))} NANDs at K = 3 and ${nands(convEncoder(CONV_K7))} at K = 7. Its Viterbi decoder keeps one path per state: an add-compare-select and a survivor per state, ${n0(nands(viterbi(CONV_K7)))} NANDs for K = 7, most of it survivors. Three-bit levels give most of soft decision's gain.`,
      `Reed-Solomon corrects t wrong bytes with 2t check bytes. Its encoder is the CRC's circuit over GF(256), with constant multipliers. Its decoder is syndromes, Berlekamp-Massey to the locator Λ, the same discrepancy unit for Ω, Chien's search, Forney's value: ${n0(nands(rsDecoder(10, 26)))} NANDs at RS(26, 16), ${n0(nands(rsDecoder(32, 255)))} at RS(255, 223).`,
      'Past t, a locator has fewer roots than its degree, and the decoder says so; rarely it lands on another code word and cannot know. A CRC stays above the code.',
      `An interleaver of depth D makes a burst of b into ⌈b / D⌉ errors a word, for D words of delay. K = 7 inside and RS(255, 223) outside gives a rate of ${nf(concatRate(), 3)} and a cliff near 2.3 dB.`,
      `On an Eb/N0 axis, a code of rate R gives each channel bit R of the energy, so the rate is already counted. Coding gain is what is left. At rate ½ the limit is ${db(shannonDb(0.5), 2)}, or ${db(shannonBinaryDb(0.5), 2)} with ±1 inputs.`,
      `LDPC: sparse checks, belief propagation on the graph, exact on a tree. Density evolution computes a typical long code's threshold without a code: ε* = ${becThreshold().toFixed(4)} for (3, 6) on the erasure channel. Word length is delay and buys steepness; memory and wiring are the price, which quasi-cyclic graphs pay down.`,
    ],
    check: [
      {
        question: 'What does the Reed-Solomon decoder\'s discrepancy unit compute in its two passes?',
        options: ['Both times Σ λ_j S_(r − j): in the first pass the next syndrome against the register\'s prediction, in the second the coefficients of Ω', 'The syndromes, then the error values', 'The inverse of δ, then of γ', 'The locator\'s roots, then their count'],
        answer: 0,
        explain: 'One sum, two uses: that is why Ω costs no new multipliers. Only the window differs: the mask stops the sum wrapping round to the far end of the ring in the second pass.',
        why: ['', 'The syndromes are built by Horner as the word arrives, and Forney finds the values.', 'The inversionless form never divides by δ or γ; the only inverse is in Forney.', 'Chien\'s search finds the roots and a counter counts them.'],
      },
      {
        question: 'A link\'s concatenated decoder fails often. Doubling the interleaver depth cuts failures a lot, at no change in rate. What does this say?',
        options: ['The inner decoder\'s errors arrive in bursts, and the words were limited by bursts, not by the average rate of errors', 'The outer code was too weak at any depth', 'The inner code\'s rate had changed', 'The channel\'s noise had fallen'],
        answer: 0,
        explain: 'Interleaving changes nothing but where wrong bytes land. If that helps, wrong bytes were clumped.',
        why: ['', 'A code too weak at any depth would not have improved so much.', 'The interleaver has no effect on the rate.', 'It has no effect on the noise.'],
      },
      {
        question: `Density evolution says a (3, 6) code's threshold on the erasure channel is about ${becThreshold().toFixed(3)}. What does a threshold promise?`,
        options: ['Below it, a typical long enough code decodes nearly everything; above it, no length helps this code with this decoder', 'Every code with these degrees corrects exactly this share of erasures', 'A word of any length corrects up to it', 'It is the capacity of the channel'],
        answer: 0,
        explain: 'It is a property of the ensemble and the decoder, in the limit of long blocks. Capacity at rate ½ is 0.5, higher than this.',
        why: ['', 'A particular unlucky code may do worse: the claim is about typical ones.', 'Short words stall below it.', 'Capacity at rate ½ on this channel is 0.5.'],
      },
    ],
  },
  steps: [codeSteps[0], codeSteps[1], codeSteps[2], decodeLocator, decodeFix, codeSteps[3], codeSteps[4], concatStep, gossip, threshold, fallStep, costStep],
};
