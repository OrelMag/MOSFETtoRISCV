// Fast serial links (level Communication): what a receiver does when no clock travels with the data. Line codes
// (comm/linecode.ts), a SerDes and a bang-bang clock recovery in gates (lib/serdes.ts, comm/serdes.ts), then the analog side as the
// channel model (phys/line.ts): the eye, equalization, PAM4, and one step on fibre. Every number below is computed or pinned
// by tests/comm-linecode, comm-serdes and phys-line-eq. The gate-level link runs at 4 cycles a bit (63 Mb/s at 3.95 ns a cycle);
// the multi-gigabit figures are the channel model's, and the prose says which is which.

import { decode8b10b, disparityOf, encode8b10b, K_CODES, MAX_RUN_8B10B, overhead, POLY_7, type Rd } from '../comm/linecode';
import { CYCLES_PER_BIT, FILTER_LIMIT, GATE_BIT_NS, GATE_MBPS, LINK_PATTERNS, lockRange, NCO_BITS, NOMINAL_INC, patternDensity, theoryRange } from '../comm/serdes';
import { DEC8B10B, DESER10, ENC8B10B, MANCH_ENC, CDR, SER_RX, SER_TX, SERDES_LINK, scrambler } from '../lib/serdes';
import { ctleNoiseGain, eye, berOf, PAM4_PENALTY_DB, prbs } from '../phys/line';
import { stats } from '../sim/stats';
import { eyeWidget, disparityWidget, manchesterWidget, mediaWidget, mediaReach, pam4Widget, scramblerWidget } from '../widgets/serial';
import { serdesApi, serdesScene } from '../widgets/serdes';
import type { Chapter } from './types';
import { numOf } from './order';

const nf = (x: number, d = 1) => x.toFixed(d);
const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const pc = (x: number, d = 1) => `${nf(x * 100, d)} %`;

// ---- numbers ---------------------------------------------------------------------------------------------------------------
const N = {
  man: nands(MANCH_ENC), enc: nands(ENC8B10B), dec: nands(DEC8B10B), scr: nands(scrambler(POLY_7)), tx: nands(SER_TX), rx: nands(SER_RX),
  cdr: nands(CDR), des: nands(DESER10), link: nands(SERDES_LINK),
};
let lockMemo: { name: string; rho: number; theory: number; measured: number }[] | null = null;
const locks = () => (lockMemo ??= LINK_PATTERNS.map((p) => {
  const rho = patternDensity(p.bytes);
  return { name: p.name, rho, theory: theoryRange(rho), measured: lockRange(p.bytes) / NOMINAL_INC };
}));

// 8b/10b facts from the model
const SYMS: { v: number; k: boolean }[] = [];
for (let v = 0; v < 256; v++) SYMS.push({ v, k: false });
for (const v of K_CODES) SYMS.push({ v, k: true });
const neutral = SYMS.filter((s) => disparityOf(encode8b10b(s.v, s.k, 0).code, 10) === 0).length;
const oneForm = SYMS.filter((s) => encode8b10b(s.v, s.k, 0).code === encode8b10b(s.v, s.k, 1).code).length;
const codesUsed = new Set(([0, 1] as Rd[]).flatMap((rd) => SYMS.map((s) => encode8b10b(s.v, s.k, rd).code))).size;
let illegal = 0;
for (let c = 0; c < 1024; c++) if (decode8b10b(c, 0).err === 'code' && decode8b10b(c, 1).err === 'code') illegal++;

// the channel at the chapter's working point: a 1 GHz single pole
const BITS = prbs(9, 1022);
const B1 = 1, CLOSE = (2 * Math.PI * B1) / Math.LN2;           // a = 1/2: the NRZ eye shuts at 2π B / ln 2
const open = (ch: Parameters<typeof eye>[1]) => Math.max(0, eye(BITS, ch).opening);
const SIG = 0.04, R8 = 8;
const eq = (ch: Parameters<typeof eye>[1]) => {
  const o = open(ch), g = ctleNoiseGain(ch);
  return { o, g, ber: o > 0 ? berOf(o / 2, SIG * g) : 0.5 };
};
const E_NONE = eq({ rate: R8, bandwidth: B1 }), E_DE = eq({ rate: R8, bandwidth: B1, de: 0.3 }), E_CTLE = eq({ rate: R8, bandwidth: B1, ctle: 2 }), E_DFE = eq({ rate: R8, bandwidth: B1, dfe: 1 });
const sup = (e: string) => [...e].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]).join('');
const sci = (b: number) => (b < 1e-30 ? '< 10⁻³⁰' : b.toExponential(0).replace(/e-(\d+)/, (_, e: string) => ` × 10⁻${sup(e)}`).replace('e+', ' × 10'));
const A8 = Math.exp((-2 * Math.PI * B1) / R8);
const reach = mediaReach(10), reach56 = mediaReach(56);

export const chSerial: Chapter = {
  id: 'serial', num: numOf('serial'), title: 'Fast serial links', level: 'Communication',
  blurb: 'No clock travels with the data: Manchester, 8b/10b and running disparity, a scrambler, a SerDes and bang-bang clock recovery in gates, then the eye, equalization, PAM4 and fibre.',
  goals: [
    'say what a line code buys (transitions for the receiver, balance for the wire) and what it costs in bandwidth and gates, for Manchester, 8b/10b and a scrambler',
    'follow a byte through an 8b/10b encoder with its running disparity, and say why a flipped bit is caught as a code or a disparity error',
    'build the sender, serializer, receiver and clock recovery of a SerDes in gates, and compute the frequency offset the recovery loop tolerates',
    'read an eye diagram and its BER from the channel model, and compare feed-forward, CTLE and decision-feedback equalization and PAM4 by what each costs',
    'compare copper, multimode and single-mode fibre by reach at a given rate',
  ],
  builds: ['clocks', 'uart', 'wire', 'signals', 'noise', 'carriers'],
  recap: {
    keep: [
      `A receiver with no clock of its own recovers one from the transitions in the data. A line code exists to guarantee them (a bounded run of equal bits) and to keep the average level at the middle (DC balance) so a transformer or an AC-coupled receiver passes it.`,
      `Manchester: a transition in every bit, so runs of at most 2 and a clock the receiver can lock to at once, for ${N.man} NANDs a bit and twice the symbol rate. 8b/10b: ${nf(overhead['8b/10b'] * 100, 0)} % overhead, runs of at most ${MAX_RUN_8B10B}, a running disparity within one, ${SYMS.length} symbols (256 bytes and 12 control codes) in ${codesUsed} of 1024 ten-bit patterns, and a comma (0011111) that exists nowhere else, to find the word boundary.`,
      `A self-synchronizing scrambler (1 + x³⁹ + x⁵⁸ for 64b/66b) costs ${nf(overhead['64b/66b'] * 100, 1)} % and ${N.scr} NANDs for the short one here, bounds nothing (a payload equal to its own sequence stays a run), and turns every wrong bit on the line into three.`,
      `The gate-level link runs at ${CYCLES_PER_BIT} cycles a bit, ${nf(GATE_MBPS, 0)} Mb/s at ${nf(GATE_BIT_NS / CYCLES_PER_BIT, 2)} ns a cycle. Sender ${N.tx} NANDs (a ${NCO_BITS}-bit bit-clock accumulator and a serializer), receiver ${N.rx} (clock recovery ${N.cdr}, deserializer ${N.des}), encoder ${N.enc}, decoder ${N.dec}; the whole link ${N.link}.`,
      `An Alexander detector votes early or late from three samples; ${FILTER_LIMIT} votes the same way move the bit strobe by one of four samples. The loop follows a sender whose rate is off by at most (transitions per bit) ÷ (4 × ${FILTER_LIMIT}): the code's guarantee of one edge in five bits puts the formula's floor at ${pc(theoryRange(0.2), 2)}.`,
      `From <a href="#/c/signals/0">Signals and spectrum</a>: a pattern is a sum of sines, and a linear channel scales and turns each one: 1010's fundamental sits at Nyquist, R / 2, a long run at DC. ISI is that unequal gain seen in time: 1010 swings (1 − a) / (1 + a), a lone bit after a long run reaches 1 − 2a, with a = e^(−2πB/R).`,
      `The eye is the channel model's: a single pole of bandwidth B shuts the NRZ eye at 2π · B / ln 2 = ${nf(CLOSE, 2)} × B bits a second. CTLE moves the pole and amplifies noise, a DFE removes post-cursors without noise gain and needs a decision inside one bit, PAM4 trades ${nf(PAM4_PENALTY_DB, 2)} dB of eye for half the symbol rate. Past a few tens of centimetres of copper at multi-gigabit rates, fibre.`,
    ],
    check: [
      {
        question: 'A stream of 8b/10b codes is received with a run of seven equal bits in it. What happened?',
        options: ['A bit was corrupted on the line, since no legal stream has a run longer than five', 'Two codes of the same disparity followed each other', 'The scrambler seed was wrong', 'The comma moved'],
        answer: 0,
        explain: `The code book has runs of at most ${MAX_RUN_8B10B}, across code boundaries too (checked over all ${SYMS.length}² pairs at both disparities). Seven means the line is not carrying a legal stream.`,
        why: ['', 'Disparity bounds the count of ones, not runs, and the encoder alternates the forms to keep it within one.', 'There is no scrambler in 8b/10b; its bound is in the table.', 'A comma only marks a boundary; the stream stays legal wherever it is.'],
      },
      {
        question: `A sender's bit clock is 2 % fast. The receiver's loop tolerates ${pc(theoryRange(0.5), 1)} on a stream with an edge every other bit. What happens?`,
        options: ['It follows, slipping its strobe by one sample every few words', 'It loses lock within a word', 'It follows only while the data are random', 'It needs a new comma every word'],
        answer: 0,
        explain: `At 2 % the sender drifts 0.08 sample a bit, a sample every 12 bits, and the loop makes a slip every F = ${FILTER_LIMIT} votes, about every ${FILTER_LIMIT * 2} bits on a stream with edges at half the bits.`,
        why: ['', 'Only past the limit: the votes cannot move the strobe as fast as the data drift.', 'Any pattern with edges works; fewer edges means a smaller range, not none.', 'The comma sets the word boundary once; the strobe is tracked separately.'],
      },
      {
        question: 'Why does PAM4 sometimes carry a lossy channel at a higher bit rate than NRZ?',
        options: ['Half the symbol rate saves more channel loss than the three-times smaller eye costs', 'Its levels are further apart', 'It needs no clock recovery', 'The line code is shorter'],
        answer: 0,
        explain: `Four levels shrink each eye to a third (${nf(PAM4_PENALTY_DB, 1)} dB). Halving the symbol rate halves the Nyquist frequency, and a trace whose loss in dB grows with frequency saves more than that once the loss at Nyquist is past about ${nf(2 * PAM4_PENALTY_DB, 0)} dB.`,
        why: ['', 'They are closer: spacing is a third of NRZ\'s swing at the same peak amplitude.', 'It needs the same recovery, at the symbol rate.', 'PAM4 changes the levels, not the code that guarantees transitions.'],
      },
    ],
  },
  steps: [
    {
      title: 'No clock on the wire',
      body: `
        <p>The last chapter split a poor channel into many slow carriers. This one goes the other way: one signal at the highest rate a short, clean wire allows, with no clock beside it. The UART found its timing again at every start bit; here nothing marks the bits, so the data must carry the clock.</p>
        <p>Two chips that share a clock wire need no recovery, and a clock wire costs a pin pair and, at speed, a skew budget. A serial link sends the clock <em>in</em> the data: the receiver watches the transitions and builds its own. Its sampler must fire near the middle of every bit, and the only evidence of where a bit starts is an edge, so the stream has to keep supplying edges. A long run of equal bits starves the receiver, and a stream that is mostly ones or mostly zeros drifts the average level off the middle, which a transformer or an AC-coupled receiver (a capacitor in series) cannot pass. A <strong>line code</strong> fixes both.</p>
        <p><strong>Manchester</strong> is the simplest. Every bit is two half-bits with a transition between them: a 1 goes low then high, a 0 high then low (the other convention swaps them). The encoder is one XNOR of the bit and the half-bit clock, ${N.man} NANDs. Runs are at most 2 and the average level is exactly the middle, whatever is sent. The decoder reads the second half and flags a bit whose halves are equal. The price is bandwidth: the line changes twice as often as the data, so 1 Mb/s occupies the spectrum of 2 Mb/s of NRZ (non-return-to-zero: the plain two-level signal, one level a bit), and every gain you buy at the receiver is spent at twice the frequency.</p>
        <p>Because every bit carries a transition, a Manchester receiver can also tell whether anything is being sent at all (Ethernet's 10 Mb/s twisted-pair link still uses it). Type a bit pattern below, flip a half-bit on the line, and compare the longest run on NRZ with the longest on the wire.</p>`,
      widget: () => manchesterWidget(),
      more: {
        pitfall: `<p>Calling Manchester "self-clocking, so free". The transition per bit is the cost: the symbol rate doubles. For a link that is bandwidth-limited rather than gate-limited, which is every link in the rest of this chapter, that is the wrong trade, and the codes of the next two steps spend 25 % and 3 % instead of 100 %.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A Manchester link carries 10 Mb/s. What is the highest fundamental frequency on the wire?',
        options: ['10 MHz, from a run of equal bits, which has a transition in the middle of every bit', '5 MHz, as for NRZ', '20 MHz, the symbol rate', '2.5 MHz'],
        answer: 0,
        why: ['', 'That is NRZ 1010… at 10 Mb/s. In Manchester a run of equal bits (all 1s) is already a 10 MHz square wave: one period a bit.', 'The symbol rate is 20 million half-bits a second, but the fastest square wave takes two half-bits a period: 10 MHz.', 'That is NRZ at 5 Mb/s, not this link.'],
        explain: 'Equal bits give one period a bit, 10 MHz; alternating bits give one period in two bits, 5 MHz. The spectrum spans 5 to 10 MHz, twice what NRZ at the same rate needs (up to 5 MHz).',
      },
    },
    {
      title: '8b/10b and running disparity',
      body: `
        <p>Manchester spends 100 % of the bandwidth. <strong>8b/10b</strong> (Widmer and Franaszek, IBM, 1983) spends ${nf(overhead['8b/10b'] * 100, 0)} %: every byte becomes ten bits, and the ten-bit code book is chosen so that (1) no code, and no pair of adjacent codes, has more than ${MAX_RUN_8B10B} equal bits in a row, (2) each code has five ones (a balanced code), or four or six, and (3) the encoder keeps a one-bit state, the <strong>running disparity</strong>, so that the unbalanced codes alternate: a code with an excess of ones is sent only when RD is − and flips it, one with an excess of zeros only when RD is +. The count of ones minus zeros therefore stays within ±1 at every code boundary, forever. It is how Gigabit Ethernet's optical ports, Fibre Channel, early <span data-ahead="pcie">PCI Express (the serial bus inside a computer, taken apart in a later chapter)</span> and SATA run: 1 Gb/s is 1.25 Gbaud.</p>
        <p>A byte is HGF EDCBA, named D<em>x</em>.<em>y</em> with x = EDCBA and y = HGF. The low five bits take a 6-bit block, the high three a 4-bit block, each chosen at the current disparity. Twelve <strong>control codes</strong> (K28.0 … K28.7, K23.7, K27.7, K29.7, K30.7) mark the stream itself: K28.5, 0011111010 after RD−, contains the <strong>comma</strong>, seven bits (0011111 or 1100000) that appear nowhere else in a legal stream, so a receiver that sees it knows where a word starts.</p>
        <p>Of the 1024 ten-bit patterns, ${codesUsed} are codes and ${illegal} are neither, in either disparity. A decoder tells the cases apart: a pattern in neither book is a <em>code error</em>, a code legal only at the other disparity is a <em>disparity error</em>. A single flipped bit usually becomes one of these, sometimes a word later when a flipped bit changes the disparity the next word is read at. In the table below, click bits on the line: some flips are caught at once, some one word later, and a few turn one legal code into another and are not caught at all.</p>
        <p>The gates: a 5b/6b table and a 3b/4b table, with an XOR per disparity change, ${N.enc} NANDs for the encoder and ${N.dec} for the decoder, both lookups.</p>`,
      widget: () => disparityWidget(),
      more: {
        derive: `<p>Why the alternate 7. D17.7 at RD− is 100011, neutral and ending in 11, and the primary 4b block for y = 7 at RD− is 1110: 11 + 111 is five ones in a row, a length the code keeps for commas. The alternate 0111 breaks it. K28.7 uses the alternate always; that is also what lets the decoder tell K23.7 (alternate) from D23.7 (primary): both have the same 6b block.</p>`,
        numbers: `<p>${SYMS.length} symbols, ${codesUsed} distinct ten-bit codes across both disparities, ${illegal} that decode in neither. Overhead 25 % beside Manchester's 100 %; 64b/66b of the next step is ${nf(overhead['64b/66b'] * 100, 1)} %.</p>
          <p>${neutral} of the ${SYMS.length} symbols are balanced, and ${oneForm} are sent as the same ten bits at both disparities (a balanced code can still have two forms, like D7's 111000 and 000111); the other ${SYMS.length - oneForm} have two. D<em>x</em>.7 has two 4b blocks and takes the alternate for x = 17, 18, 20 after RD− and 11, 13, 14 after RD+ so that no data code contains the comma's run of five. K28.7 can make a false comma with the code after it, and the standard says not to send it before certain codes; the test over all pairs finds exactly those.</p>
          <p>The tables are lookups (minimized sums of products from <code>lib/sop.ts</code>); published Widmer–Franaszek logic factors the same function much smaller by hand, and the table form is kept here because every row can be checked against the standard (all ${SYMS.length} symbols at both disparities, every one of the 2 048 decoder inputs).</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The encoder sends D0.0 at RD−, 100111 0100. What disparity does the next byte see?',
        options: ['RD−, because the code is balanced', 'RD+, because the 6b block has an excess of ones', 'RD+, because every data code flips it', 'It depends on the next byte'],
        answer: 0,
        why: ['', 'The 6b block 100111 has four ones in six (+2), but the 4b block 0100 has one in four (−2). They cancel.', 'Only unbalanced codes flip RD; a balanced code leaves it alone.', 'The next RD is a function of this byte and this RD only; the next byte is read at it.'],
        explain: `Four ones in six (+2) and one in four (−2) cancel: five ones in ten, disparity ${disparityOf(encode8b10b(0, false, 0).code, 10)}, so RD stays −. At RD+ the encoder sends the complement, 011000 1011, also balanced.`,
      },
    },
    {
      title: 'Scrambling instead',
      body: `
        <p>8b/10b guarantees; a <strong>scrambler</strong> only makes the stream look random. Each bit is XORed with earlier bits of the stream itself, so the output is not predictable from the input: runs are the length a coin would make, the average level is the middle on average, and nothing is added to the stream. 10 Gb/s Ethernet's 64b/66b adds a 2-bit header to every 64 bits (${nf(overhead['64b/66b'] * 100, 1)} %, 10.3125 Gbaud for 10 Gb/s) and scrambles the 64 with a <em>multiplicative</em> scrambler, <code>1 + x³⁹ + x⁵⁸</code>: out = in ⊕ out<sub>−39</sub> ⊕ out<sub>−58</sub>. The header is not scrambled and is always 01 or 10, a transition every 66 bits, which is what the receiver's clock recovery and its block alignment lean on.</p>
        <p>The descrambler is the same two XORs on the bits <em>received</em>, which makes it <strong>self-synchronizing</strong>: whatever its register held, after 58 bits it is right. There is no seed to agree and no frame to align to. The price is <strong>error multiplication</strong>: one wrong bit on the line is a wrong input to the descrambler at three moments, so three wrong output bits (now, 39 and 58 bits later). The gate-level short version, <code>1 + x⁶ + x⁷</code>, is seven flip-flops and two XORs: ${N.scr} NANDs for either end.</p>
        <p>What it does not do is bound anything. A payload equal to the scrambler's own output comes out as zeros, and an all-zero payload into an <em>empty</em> register stays all zeros forever; the header exists partly for that reason. Choose the payload below, then corrupt one line bit and count the wrong outputs.</p>`,
      widget: () => scramblerWidget(),
      more: {
        real: `<p>The other family is the additive (frame-synchronous) scrambler: XOR with the output of a free-running LFSR that both ends start together (SONET uses 1 + x⁶ + x⁷ over each frame; PCI Express 3.0 and later use LFSRs with 128b/130b). No error multiplication, but it needs a reset at a known point of the stream, and the receiver must find it.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'One bit is wrong on a 64b/66b line. How many bits of the descrambled payload are wrong?',
        options: ['Three, at distances 0, 39 and 58', 'One', 'Fifty-eight, until the register recovers', 'None: the header repairs it'],
        answer: 0,
        why: ['', 'One would need the descrambler to forget the bit after using it. It sits in its register and is used twice more.', 'The register is flushed after 58 bits, but a received bit enters the output only through its three terms.', 'The header gives block alignment, not correction; nothing here repairs a bit.'],
        explain: 'The wrong bit is XORed into the output when it arrives and again when it reaches the x³⁹ and x⁵⁸ taps. The tests pin this on both polynomials: wrong outputs at exactly 0, a and b.',
      },
    },
    {
      title: 'A SerDes in gates',
      body: `
        <p>Now the whole path, in gates, on one clock: a <strong>SerDes</strong> (serializer and deserializer). A byte source sends a K28.5 comma every eighth word and random bytes between (or a byte you choose); the encoder gives ten bits and the running disparity; the <strong>sender</strong> turns them into a bit stream; a <strong>line</strong> carries them; a <strong>receiver</strong> with only the line recovers the bit boundary, shifts ten bits in, aligns on the comma, and a decoder turns the word back into a byte. <span data-show="enc">The encoder</span>, <span data-show="dec">the decoder</span>, <span data-show="tx">the sender</span> and <span data-show="rx">the receiver</span> open down to NAND gates like any box.</p>
        <p><strong>Speed.</strong> A bit is ${CYCLES_PER_BIT} cycles, so at the book's ${nf(GATE_BIT_NS / CYCLES_PER_BIT, 2)} ns a cycle the gate-level link runs at ${nf(GATE_BIT_NS, 1)} ns a bit, ${nf(GATE_MBPS, 0)} Mb/s. The multi-gigabit rates of the following steps belong to the channel model, not to this circuit.</p>
        <p><strong>Two clocks from one.</strong> The simulator has one clock, and the receiver samples the line on every edge of it. The sender's bit rate is not that clock: it is a ${NCO_BITS}-bit accumulator (<span data-show="tx">sender</span>) adding a step each cycle, a bit every time it overflows. A step of ${NOMINAL_INC} is exactly 4 cycles a bit; ${NOMINAL_INC + 1} is one part in ${NOMINAL_INC} fast. The receiver is never told the step, so the two ends are as unrelated as two oscillators and no more. It runs on the gate simulator because that is the default and Step then shows each gate delay; every flip-flop shares the one clock, so the cycle engine could run it too.</p>
        <p><strong>The line</strong> is one part: a delay of three cycles and an input that flips the bit passing. It stands for the channel of <a href="#/c/wire/0">A wire is not a wire</a>; opened, it is the one box here that does not end in transistors, and the eye of the next step is what it hides.</p>
        <p>The sender is ${N.tx} NANDs, the receiver ${N.rx}, the whole link ${N.link} with its encoder and decoder. <span class="try">Run the link until the panel says Locked.</span> <span class="try">Flip a line bit and watch the decoder flag a word.</span></p>`,
      scene: () => serdesScene('link'),
      lit: 'The encoder <span data-show="enc">enc</span>, sender <span data-show="tx">tx</span>, line <span data-show="line">line</span>, receiver <span data-show="rx">rx</span> and decoder <span data-show="dec">dec</span>',
      tries: [(st) => !!serdesApi.get(st)?.status().locked, (st) => !!serdesApi.get(st)?.status().sawErr],
      challenge: {
        kind: 'reach',
        goal: 'Run the link until the receiver has decoded a K28.5 comma and reports Locked.',
        check: (st) => { const s = serdesApi.get(st)?.status(); return !!s && s.locked && s.sawK; },
        hints: ['Press Run, or Word a few times: the receiver first waits for a comma to find the word boundary.', 'A comma is sent every eighth word, so lock takes under twenty words.'],
        answer: 'Run about 900 cycles (20 words): the receiver sees the comma 0011111 in its shift register, sets its bit count to 7 and from then on its words are aligned. The decoder shows K28.5 and the last words match the sent list.',
        solve: (st) => serdesApi.get(st)?.run(1200),
      },
      more: {
        numbers: `<p>Encoder ${N.enc} NANDs, decoder ${N.dec}, sender ${N.tx}, receiver ${N.rx} (clock recovery ${N.cdr}, deserializer ${N.des}), link ${N.link}. The tests compare the sender, line and receiver with their golden models every output every cycle, and the 8b/10b blocks over every input.</p>`,
      },
    },
    {
      title: 'Finding the clock in the data',
      body: `
        <p>The receiver samples the line every cycle, four times a bit, and keeps the last five samples x<sub>0</sub> (newest) … x<sub>4</sub>. Every <em>strobe</em> it takes three of them: the data sample d = x<sub>0</sub>, the sample before that, p = x<sub>4</sub>, one bit earlier, and the <strong>edge sample</strong> e = x<sub>2</sub> halfway between. If d and p differ there was a transition between them, and e says where. If e still equals p the transition came after it: the strobe fired <em>early</em>. If e already equals d the transition came before it: <em>late</em>. This is an <strong>Alexander</strong> (bang-bang) phase detector (J. D. H. Alexander, 1975): it says which way, not how far, and says nothing when d = p.</p>
        <p>Each vote moves a counter f by ±1. At ±${FILTER_LIMIT} the strobe counter is reloaded with a 5- or 3-cycle period once (it falls back one sample or gains one) and f clears; otherwise the period is 4. That is the whole loop: <span data-show="rx.cdr.ctl">a table</span> with c (the strobe counter) and f in, c and f out, and the detector's three gates. It is ${N.cdr} NANDs with its five samples.</p>
        <p><strong>How far it follows.</strong> A sender off by a fraction δ drifts 4δ samples every bit. The loop slips a sample for every ${FILTER_LIMIT} votes in the same direction, and a vote needs an edge, so with a fraction ρ of bit periods carrying one it can slip ρ ⁄ ${FILTER_LIMIT} samples a bit. It keeps up while 4δ ≤ ρ ⁄ ${FILTER_LIMIT}: <strong>δ<sub>max</sub> = ρ ⁄ (4 × ${FILTER_LIMIT})</strong>. The code guarantees an edge in every five bits, so ρ ≥ 0.2 and the worst case is ${pc(theoryRange(0.2), 2)}; real streams have more edges and reach further.</p>
        <p>Set the sender's rate off with the slider and press <em>Run</em>. Ethernet is specified to ±100 ppm (0.01 %), so this loop, which steps a quarter bit at a time, tolerates orders of magnitude more.</p>
        <p class="try"><b>Try:</b> sender rate +2 %, Run, and watch the strobe move late or early. The loop follows with no wrong word.</p>
        <p class="try"><b>Try:</b> push it past the limit (the slider reaches ±8 %) and watch words go wrong.</p>`,
      scene: () => serdesScene('cdr'),
      lit: 'The detector and filter in <span data-show="rx">rx</span>, the sender\'s accumulator in <span data-show="tx">tx</span>',
      tries: [(st) => { const s = serdesApi.get(st)?.status(); return !!s && s.locked && s.offset !== 0 && Math.abs(s.offset) <= 3; }, (st) => !!serdesApi.get(st)?.status().lost],
      challenge: {
        kind: 'reach',
        goal: 'Lock the link, then set the sender\'s rate far enough off that the receiver loses lock.',
        check: (st) => !!serdesApi.get(st)?.status().lost,
        hints: ['Run at 0 % until it says Locked, so there is something to lose.', 'The pattern with the fewest edges has the smallest range; at 8 % even random data fails.'],
        answer: 'Lock at 0 %, then slide the sender to +8 % (or −8 %) and Run: the strobe cannot be moved fast enough, words come out wrong and the panel reports the loss.',
        solve: (st) => { const a = serdesApi.get(st); a?.run(2400); a?.setOffset(8); a?.run(6000); },
      },
      more: {
        numbers: `<p>The golden model, run to the first wrong word, against the formula's ceiling for each pattern in the panel. No useful stream sits on the guaranteed floor: K28.7's 0011111000 alone has that density, but repeated it contains false commas (1100000 across two codes), so the word alignment breaks before the loop does, and data between commas has more edges.</p>
          <table class="mini"><tr><th>pattern</th><th>edges</th><th>ceiling</th><th>measured ±</th></tr>${locks().map((l) => `<tr><td>${l.name}</td><td>${pc(l.rho, 0)}</td><td>${pc(l.theory, 1)}</td><td>${pc(l.measured, 1)}</td></tr>`).join('')}</table>
          <p>Sparse and regular patterns reach the ceiling; a dense, quantized one gets noisy votes (the sender's own edges move by a sample) and falls short.</p>`,
        real: `<p>PCIe allows ±300 ppm and SATA about ±350, and a real recovery loop has a phase step of 1⁄32 bit or finer; this one steps a quarter bit and hunts by a quarter bit in steady state. Production receivers use a phase interpolator, a mixer that steps the sampling clock in 1/32 or 1/64 of a bit, and a loop filter with an integral term that tracks frequency without a long-term error, instead of this proportional-only counter. A bang-bang loop's jitter is the step size, so the step is the lever on how much of the eye the sampler gives up.</p>`,
      },
    },
    {
      title: 'The eye diagram',
      body: `
        <p><a href="#/c/signals/0">Signals and spectrum</a> showed that unequal gain makes each bit depend on the ones before it. Here is how that looks on a live link. The channel between the sender's driver and the receiver's slicer is the model of <a href="#/c/wire/0">A wire is not a wire</a>: here a single pole, <code>B</code> = ${B1} GHz. A bit is not a square pulse at the far end; it is a rounded one whose tail runs into the next bits. Fold a long random pattern on itself one bit period at a time and the traces form an <strong>eye</strong>. The slicer samples in the gap that is left. The opening is the margin against noise, the width is the margin against the sampling instant, and when the tails of earlier bits fill the gap there is <strong>intersymbol interference</strong> (ISI).</p>
        <p>For one pole the numbers are closed forms. Each bit period the pole retains a = e<sup>−2π·B/R</sup> of the last level. At the end of the bit the sampled value is (1 − a) times the new bit plus a geometric tail of the earlier ones, and the worst-case ISI is the sum of the tail, a; the opening is <code>2 (1 − 2a)</code> of the ±1 swing. It closes at a = ½, that is at <strong>R = 2π · B / ln 2 = ${nf(CLOSE, 2)} × B</strong>: ${nf(CLOSE, 1)} Gb/s for ${B1} GHz, with Nyquist at 4.5 GHz. The model checks these forms (tests/phys-line-eq).</p>
        <p>The BER follows the opening. With Gaussian noise of rms σ at the slicer, a bit is wrong when the noise exceeds half the opening: <code>BER = Q(opening ⁄ 2σ)</code>, with Q the Gaussian tail of the noise chapter's <a href="#/c/noise/2">A decision</a>; 10⁻¹² needs half the opening to be 7.03 σ. At 6 Gb/s here a = ${nf(Math.exp((-2 * Math.PI * B1) / 6), 3)}, the eye is ${pc(open({ rate: 6, bandwidth: B1 }) / 2, 0)} open, and with σ = 40 mV the BER is ${sci(berOf(open({ rate: 6, bandwidth: B1 }) / 2, 0.04))}. Raise the rate and watch the BER climb well before the eye shuts; raise the noise and the same eye is a coin toss.</p>
        <p>Past the slicer it is gates again: the recovered bits drive the SerDes of the last two steps, which is where the two models meet. Everything on this plot is the channel model, labelled as such; nothing in it runs at the link's 4 cycles a bit.</p>`,
      widget: () => eyeWidget(),
      more: {
        derive: `<p>The pole is y' = (x − y)/τ with τ = 1 ⁄ (2π B). For a bit of length T the response to one isolated bit, sampled at the end of its own period and k periods later, is (1 − a) a<sup>k</sup>, a = e<sup>−T/τ</sup>. Superposing the bits (the channel is linear) gives sampled value Σ x<sub>n−k</sub> (1 − a) a<sup>k</sup>; the worst case sets every x<sub>n−k</sub> (k ≥ 1) against x<sub>n</sub>, and Σ<sub>k≥1</sub> (1 − a) a<sup>k</sup> = a. Opening = 2 ((1 − a) − a).</p>`,
        pitfall: `<p>Reading the eye on the quietest pattern. A short repeating pattern fills only a few of the possible histories, so its eye looks better than the real one. The widget uses PRBS-9, which has every nine-bit history, and the closed forms count a longer tail than that.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `A channel has a single pole at 2 GHz. At about what bit rate does the NRZ eye close, ignoring noise?`,
        options: [`${nf((2 * Math.PI * 2) / Math.LN2, 0)} Gb/s, where a = ½ and the ISI equals the signal`, '4 Gb/s, twice the pole', '2 Gb/s, equal to the pole', '8 Gb/s, four times the pole'],
        answer: 0,
        why: ['', 'At 4 Gb/s the pole retains a = e^−π ≈ 0.04 of the last level: 1 − 2a is 0.91, an eye almost fully open.', 'At 2 Gb/s a = e^−2π ≈ 0.002: the eye is almost ideal.', 'At 8 Gb/s a = e^−π/2 ≈ 0.21: 1 − 2a is 0.58, still more than half open.'],
        explain: `The eye opening is 2 (1 − 2a), a = exp(−2π B / R). It is zero at a = ½: R = 2π B / ln 2 = ${nf(CLOSE, 2)} B, so ${nf(CLOSE * 2, 1)} Gb/s for B = 2 GHz.`,
      },
    },
    {
      title: 'Equalization',
      body: `
        <p>The eye is closed by ISI, and ISI is a known, linear thing: the tail of bits already sent. You can cancel it in three places. At ${R8} Gb/s on the ${B1} GHz channel, a = ${nf(A8, 3)} and the eye is ${pc(E_NONE.o / 2, 0)} open: with σ = 40 mV the BER is ${sci(E_NONE.ber)}.</p>
        <p><strong>Transmit de-emphasis</strong> (a feed-forward equalizer, FFE) sends the first bit after a transition at full swing and the bits that repeat it at (1 − d) of it: a two-tap filter (1 − d/2, −d/2) on the data, one flip-flop for the previous bit and a driver with two strengths. It cuts the low-frequency content the channel passes best. At d = 30 % the opening is ${pc(E_DE.o / 2, 0)}, BER ${sci(E_DE.ber)}. It adds no noise, and it costs swing (power) and, like every transmit-side trick, cannot see the channel it is meant to match.</p>
        <p>A <strong>CTLE</strong> (continuous-time linear equalizer) at the receiver puts a zero on the channel's pole and its own pole higher: the pair is one pole at the higher bandwidth. At 2× the pole the opening is ${pc(E_CTLE.o / 2, 0)}. But it amplifies whatever came with the signal: at Nyquist its gain is ${nf(ctleNoiseGain({ rate: R8, bandwidth: B1, ctle: 2 }), 2)} (a modelling choice, stated in the widget), so σ at the slicer is ${nf(SIG * 1000 * E_CTLE.g, 0)} mV. BER ${sci(E_CTLE.ber)}.</p>
        <p>A <strong>DFE</strong> (decision-feedback equalizer) does not filter the signal. It subtracts the tail of the bits it has already <em>decided</em>: h₁ times the last decision from the sample before slicing. It takes nothing from the noise, so the first post-cursor (the tail left by the bit just before) is gone for free: opening 2 (1 − a − a²), a half-opening of ${pc(E_DFE.o / 2, 0)}, BER ${sci(E_DFE.ber)}. The price is timing, since the decision must travel through the subtract and slicer and be back in one bit, ${nf(1000 / R8, 0)} ps here; and error propagation, since one wrong decision subtracts the wrong tail and makes the next bit more likely wrong (the widget assumes decisions are right).</p>
        <p>Move the sliders below and watch the bars: the DFE removes tall post-cursors, and what is left is what the other two have to fight.</p>`,
      widget: () => eyeWidget({ eq: true, rate: R8 }),
      more: {
        real: `<p>Real receivers stack all three: an FFE in the transmitter (3 to 5 taps, adapted from the link partner's report), a CTLE with a few dB of peaking and a 1 to 5 tap DFE whose first tap is the hard one. The training sequence a link runs at start-up exists to set them. Adaptation is a loop like the clock recovery's: a bang-bang sign-sign LMS adjusts each tap from the slicer's errors.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Which equalizer improves the eye without amplifying the noise at the slicer?',
        options: ['The DFE, because it subtracts decided bits and never filters the noisy input', 'The CTLE, because it only boosts the signal', 'Neither: every equalizer boosts the noise', 'Both: the noise is added after them'],
        answer: 0,
        why: ['', 'The CTLE boosts what is near Nyquist, signal and noise alike; its gain is the cost in the widget.', 'The DFE uses decisions, which are noiseless once made; that is why it is attractive and why it propagates errors.', 'The noise enters before the receiver\'s front end in this model, so a filter there passes it.'],
        explain: 'The DFE adds a number derived from earlier decisions to the sample. The sample\'s noise is unchanged, the ISI is smaller. A wrong decision is the price: it is subtracted wrongly from the next sample.',
      },
    },
    {
      title: 'PAM4',
      body: `
        <p>When a channel is the limit, send fewer symbols a second. <strong>PAM4</strong> carries two bits in each symbol on four levels, −1, −⅓, +⅓, +1 (Gray coded, so a neighbouring level differs in one bit): half the symbol rate for the same bit rate, so Nyquist falls by half. It is how 400 Gb/s Ethernet lanes reach 53 Gbaud for 106 Gb/s, how <span data-ahead="pcie">PCI Express (the serial bus inside a computer, taken apart in a later chapter)</span> 6.0 reaches 64 GT/s, and how GDDR6X moves data. 1000BASE-T went to five levels on four pairs for the same reason.</p>
        <p>The price is in the eye. The same peak swing is split into three eyes, each a third of the NRZ one: ${nf(PAM4_PENALTY_DB, 2)} dB less margin against noise. The symbol error rate for Gray PAM4 is 3⁄2 · Q(half the eye ⁄ σ), a symbol error flips one of its two bits, so BER ≈ ¾ · Q(…) (checked on seeded noise in tests/phys-line-eq). Whether PAM4 wins depends on the channel: it saves the difference in loss between the NRZ Nyquist and half of it, and pays ${nf(PAM4_PENALTY_DB, 2)} dB.</p>
        <p>A single pole loses at most 6 dB an octave, less than the penalty: with one pole the two eyes shut at the same bandwidth and PAM4 never wins (move <em>Channel</em> to one pole). A lossy trace is steeper: several poles stand in for the skin and dielectric loss of a real trace, which grows with frequency. At two poles the NRZ eye is shut where PAM4 is open. The rule the widget prints: <strong>PAM4 wins where the loss it saves exceeds ${nf(PAM4_PENALTY_DB, 1)} dB</strong>, which on a trace whose loss in dB is proportional to frequency means a Nyquist loss past about ${nf(2 * PAM4_PENALTY_DB, 0)} dB. It also needs three slicers where NRZ needs one, and linearity in the driver, so it is used where the channel forces it.</p>`,
      widget: () => pam4Widget(),
      challenge: {
        kind: 'quiz', question: 'On a single-pole channel at the same peak swing, how does a PAM4 link compare with NRZ at the same bit rate?',
        options: ['Its eye is no better, and shuts at the same bandwidth', 'It is always better, by half the symbol rate', 'It is always worse by 9.5 dB and nothing else', 'It is better below a bandwidth and worse above it'],
        answer: 0,
        why: ['', 'Half the rate helps only if the channel loses more than 9.5 dB between the two Nyquist frequencies, and a single pole loses at most 6 dB an octave.', 'It also changes the ISI: the symbol is twice as long, a is squared. The two effects cancel at closure.', 'The comparison is monotonic with one pole.'],
        explain: 'NRZ closes at a = ½. PAM4 uses symbols twice as long, so its a is the square, and the eye 2/3 − 8a/3 closes at a² = ¼, the same a. At the same bandwidth both are shut; open, PAM4 is smaller.',
      },
    },
    {
      title: 'Fibre',
      body: `
        <p>Copper's trouble is that its loss grows with frequency. Loss in a circuit-board (FR4) trace goes as √f from the skin effect plus f from the dielectric; this model uses ${nf(10, 0)}·√f + ${nf(2.4, 1)}·f dB a metre, f in GHz (illustrative constants) and a ${25} dB budget at Nyquist, which is ${nf(reach.pcbCm, 0)} cm at 10 Gb/s and ${nf(reach56.pcbCm, 0)} cm at 56 Gb/s. Equalization and PAM4 stretch that; they do not change its slope.</p>
        <p>Fibre has a flat 0.2 to 0.35 dB a km for single-mode (the loss is flat across any band a modulator could use, so the rate does not enter) and about 3 dB a km for multimode at 850 nm, where the light travels in many modes with different delays and bandwidth × length is a constant (4 700 MHz·km for OM4 fibre). The same line codes, 8b/10b or 64b/66b, run over it; what changes is the transducers, a laser driver and a photodiode amplifier, which are transistors again and outside this book's model. Drag the rate and read the three reaches.</p>
        <p>That is the trade: copper to a few tens of centimetres at the fastest rates, multimode fibre to hundreds of metres and falling with the rate, single-mode to kilometres. <a href="#/c/glass/0">Light in glass</a>, next, takes the optics in depth.</p>`,
      widget: () => mediaWidget(),
      challenge: {
        kind: 'quiz', question: 'The bit rate of a copper trace doubles. What happens to its reach under a fixed loss budget?',
        options: ['It falls to between half and about 71 % of what it was, because loss per metre rises with frequency', 'It halves exactly, whatever the trace', 'It stays the same: loss is set by the material', 'It doubles'],
        answer: 0,
        why: ['', 'Halving is the limit, reached only where the f term dominates: with a √f term as well, the loss per metre rises by between 1.4 and 2.', 'Loss in dB per metre is a function of frequency, so reach follows the rate.', 'Higher rates do not make copper better.'],
        explain: 'The budget divided by the loss per metre at the new Nyquist: the trace loss 10√f + 2.4 f grows by between √2 and 2 when f doubles, so the reach divides by that same factor: 72.8 cm at 10 Gb/s becomes 44.9 cm at 20 Gb/s.',
      },
    },
  ],
};
