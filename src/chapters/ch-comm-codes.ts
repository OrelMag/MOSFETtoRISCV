// Chapter 47's last five steps: codes that correct far more than SEC-DED, in gates where the gates are a reasonable size. A convolutional encoder and a
// Viterbi decoder (lib/viterbi.ts, comm/conv.ts), Reed-Solomon's encoder and check (lib/rs.ts, comm/rs.ts; its decoder is a model), interleaving
// (comm/interleave.ts), and all of them on one Eb/N0 axis (comm/ber.ts). Computed here, or pinned in tests/comm-errors.test.ts.

import { codingGain, convHardBound, convSoftBound, ebn0For, rsCurve, secdedBer, shannonBinaryDb, shannonDb, uncodedBer } from '../comm/ber';
import { CONV_K3, CONV_K7, defaultDepth, metricWidth, spectrum } from '../comm/conv';
import { burstTolerance } from '../comm/interleave';
import { convEncoder, gfMulGates, rsEncoder, rsSyndrome, vitAcs, vitSlice, viterbi } from '../lib';
import { stats } from '../sim/stats';
import { berWidget, convEncApi, convEncScene, interleaveWidget, RS_CHECK, rsApi, rsScene, VIT_FLIPS, vitApi, viterbiScene } from '../widgets/codes';
import type { Step } from './types';

const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const db = (x: number, d = 1) => `${x.toFixed(d)} dB`;

export const codeSteps: Step[] = [
  {
    title: 'A code with memory',
    get body() {
      const k3 = spectrum(CONV_K3, 8), k7 = spectrum(CONV_K7, 12);
      return `
      <p>Block codes cut the stream into words and treat each alone. A <strong>convolutional code</strong> does not cut it: every data bit makes two channel bits, each the parity of that bit and the last K − 1 bits. The redundancy is spread along the stream, so there are no word boundaries for an error to fall across. The circuit is a shift register and two XOR trees: <span data-show="ff1 ff0">K − 1 flip-flops</span>, one tree per <em>generator</em>, <span data-show="xa1 xa2">one output</span> using all three taps and <span data-show="xb1">the other</span> the first and last (octal 7 and 5). It is ${nands(convEncoder(CONV_K3))} NANDs for K = 3, of which the flip-flops are most.</p>
      <p>The encoder is a state machine with 2<sup>K−1</sup> states, and the code's strength is a property of its paths: the <em>free distance</em> is the fewest channel bits in which two paths that split and rejoin can differ, and a search over the trellis finds it (the tests run one, comm/conv.ts). For K = 3 it is ${k3.dfree}, and a single 1 followed by zeros writes it out: 11 10 11. The code used by NASA's deep-space probes and by 802.11, K = 7 with generators 133 and 171 octal, reaches ${k7.dfree} with ${k7.A[k7.dfree]} such paths, at ${nands(convEncoder(CONV_K7))} NANDs: <em>encoding</em> a strong code costs next to nothing, and all the price is in the decoder. Our K = 7 encoder reproduces the worked example in the 802.11 annex: its 24-bit SIGNAL field to the 48 published bits.</p>
      <p>The rate is ½, double the bits, against SEC-DED's ${(100 * 64 / 72).toFixed(1)} %. That is a far higher price up front, and whether it pays is the last step's question.</p>
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
      real: `<p>Puncturing makes other rates from the same encoder and decoder: send only some of the bits on a fixed pattern (802.11's rates ⅔ and ¾). The decoder treats a missing bit as a level halfway between 0 and 1, so one piece of hardware serves every rate.</p>`,
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
      <p>The price is ${n0(nands(V3))} NANDs here, and <strong>${n0(nands(V7))} for K = 7</strong> (64 states, ${d7}-bit survivors), about the size of the complete RV32IM system CPU. One state is ${n0(slice7)} NANDs and its add-compare-select only ${n0(acs7)}: survivors are nearly everything. Real decoders store the selects in RAM and trace back, trading those flip-flops for control and latency. Reading from a fixed state, as here, needs about ten constraint lengths before more depth stops helping (at five, K = 7 is over five times worse at 4 dB, in the tests); reading from the best state needs about five (the textbook figure), at the cost of comparing all 64 metrics.</p>
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
      <p>Correcting is where the cost is, and <strong>the decoder here is a model, not gates</strong> (comm/rs.ts): Berlekamp-Massey finds the polynomial whose roots mark the wrong positions from the syndromes, Chien's search tries every position, Forney's formula gives each error's value. Each uses general multiplications, ${n0(nands(gfMulGates()))} NANDs apiece in gates against a few dozen for a constant, and a fast decoder has dozens working at once plus the registers to feed them: fifty multipliers alone would be ${n0(50 * nands(gfMulGates()))} NANDs, for a block that would teach little the Viterbi decoder has not. Past t the decoder either says so, which the tests measure as nearly every time for RS(26, 16), or lands on a different code word, which is why a CRC stays above it. This is the family in CDs, QR codes, DVB and, as RS(544, 514) over a ten-bit field, 400 Gb/s Ethernet.</p>
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
      <p>Real channels do not flip bits one at a time. A scratch, a fade, or a lightning strike takes out a run, and the codes above, Viterbi's most of all, fail badly when errors arrive together, whatever their average rate. <strong>Interleaving</strong> changes the errors instead of the code: write D words as rows, send the columns. A burst of b channel bits now puts at most ⌈b / D⌉ errors in any word, so a code correcting t per word survives any burst up to D · t: ${burstTolerance(32, 1)} bits for 32 SEC-DED words, ${burstTolerance(8, 16) * 8} bits for eight RS(255, 223) words, whose t counts bytes.</p>
      <p>It adds no redundancy, so the rate does not change, and costs two things: a buffer of D words at each end, and D words of delay, since nothing can be read until the block is full. That delay is why a voice call interleaves less than a broadcast. The two kinds of code combine well. The deep-space standard runs K = 7 inside and RS(255, 223) outside: Viterbi turns a noisy channel into a nearly clean one whose rare errors come in bursts, an interleaver spreads those bursts, and Reed-Solomon cleans up what remains.</p>
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
      <p>A fair comparison needs one axis. Noise is the Gaussian of <a href="#/c/wire/0">chapter 41</a> and <a href="#/c/modem/5">chapter 45</a>, and the signal is <strong>E<sub>b</sub>/N<sub>0</sub></strong>, the energy per <em>data</em> bit over the noise density. A code of rate R spends that energy on 1/R channel bits, each of which sees R · E<sub>b</sub>/N<sub>0</sub>: its raw error rate is Q(√(2R · E<sub>b</sub>/N<sub>0</sub>)), so a rate ½ code starts 3 dB behind. Forgetting this makes every code look better than it is. <em>Coding gain</em> is what is left: how much less signal the coded link needs for the same decoded error rate.</p>
      <p>At 10<sup>−5</sup> uncoded BPSK needs ${db(un, 2)}. SEC-DED(72, 64) gains ${db(gain(se))} and RS(255, 223) ${db(gain(rs))}, at high rates and with hard decisions. K = 7 gains ${db(gain(hard))} with hard decisions and ${db(gain(soft))} with soft ones, for half the rate. Each dB is bandwidth or range you did not have to buy: at ${db(gain(soft))}, a link needs about a third of the transmit power, or reaches ${Math.sqrt(10 ** (gain(soft) / 10)).toFixed(1)} times as far in free space.</p>
      <p><strong>The limit.</strong> At rate ½, Shannon's bound says errors can be made as rare as you like above ${Math.abs(lim) < 0.005 ? '0 dB' : db(lim, 2)}, or ${db(limB, 2)} if the only inputs are ±1, and at any rate no lower than ${db(shannonDb(1e-6), 2)}. K = 7 soft at 10<sup>−5</sup> sits ${db(ebn0For(soft, T) - limB)} above it. Modern codes close that gap with long blocks and iterative decoding: turbo codes and LDPC come within a fraction of a dB, at far higher decoder cost, and they are why the last generations of Wi-Fi, 5G and fast Ethernet use them or concatenate them. They are not built here. <strong>Whether to code at all</strong> is still the earlier step's trade: redundancy against repeating, and a good link with a short round trip often should simply ask again.</p>
      <div class="try">Slide to 4 dB and press <strong>Run the decoder</strong>. The soft dot should land just above its curve (three-bit levels lose about a quarter of a dB); the hard one well below its bound, which is loose this high up.</div>`;
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
