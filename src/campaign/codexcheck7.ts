// Check yourself questions for the entries of codexmore5.ts (see codexcheck.ts), group 7: Communication, chapters 45-47. Answers
// first: the quiz shuffles the options (ui/quiz.ts shuffleOrder). Numbers pinned by tests/content-codexcomm.test.ts. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK7: Record<string, Quiz[]> = {
  qam: [
    {
      question: 'Going from 16-QAM to 64-QAM at the same symbol error rate (10⁻⁶), how much more E_s/N₀ does the line need?',
      options: ['About 6 dB: 20.9 dB becomes 27.2 dB', 'About 3 dB', 'About 12 dB', 'None: it is the same bandwidth'],
      answer: 0,
      explain: 'The decision distance shrinks as √(3 / (M − 1)): four times the points need about four times the power, 6 dB, for the same error rate. The bandwidth is unchanged; the SNR is what is spent.',
      why: ['', 'Doubling the points would cost about 3 dB; 64 is four times 16.', 'That would be sixteen times the points.', 'Same bandwidth does not mean same noise tolerance: the points are closer together.'],
    },
    {
      question: 'On a 35 dB line, which is the largest uncoded square QAM that holds a symbol error rate of 10⁻⁶ (the requirements are 256-QAM 33.3 dB, 1024-QAM 39.3 dB)?',
      options: ['256-QAM, 8 bits a symbol', '1024-QAM, 10 bits a symbol', '64-QAM, 6 bits a symbol', 'Any: the SNR does not limit it'],
      answer: 0,
      explain: '35 dB clears 256-QAM\'s 33.3 dB but not 1024-QAM\'s 39.3 dB. At V.34\'s 3429 baud that is 27.4 kb/s; its other 6 kb/s came from coding and shaping.',
      why: ['', '1024-QAM needs 39.3 dB; at 35 dB its symbol errors are far above 10⁻⁶.', '64-QAM works, but 256-QAM also clears the bar and carries more.', 'The SNR is exactly what limits it: more points, closer together.'],
    },
  ],
  ofdm: [
    {
      question: 'Why does an OFDM block begin with a cyclic prefix at least as long as the channel\'s echo?',
      options: ['It makes the channel\'s linear convolution act as a circular one, so each tone needs one multiplication', 'It carries the sync pattern', 'It protects against crosstalk from other pairs', 'It lowers the number of tones needed'],
      answer: 0,
      explain: 'The transform turns circular convolution into Y[k] = H[k] X[k]. A real channel convolves linearly; copying the block\'s last samples in front makes what remains after the prefix is cut off exactly circular, and equalizing is one division per tone.',
      why: ['', 'Sync blocks are separate (one in 69 for ADSL); the prefix is a copy of data.', 'Crosstalk comes from other wires and a prefix cannot filter it.', 'The tone count is set by the bandwidth and spacing, not by the prefix.'],
    },
    {
      question: 'How many complex multiplications does a 512-point FFT need, against the 512² of the transform\'s definition?',
      options: ['2304: N/2 · log₂ N, 114 times fewer', '4608: N · log₂ N', '512', '262 144'],
      answer: 0,
      explain: 'Splitting into even and odd halves, joined by one multiplication per pair, recurses to N/2 · log₂ N = 256 · 9 = 2304 against N² = 262 144.',
      why: ['', 'N · log₂ N counts two multiplications per butterfly; there is one per pair.', 'That is one multiplication per sample, fewer than the recursion needs.', 'That is the definition\'s count: 512².'],
    },
  ],
  linecode: [
    {
      question: 'What does 8b/10b\'s running disparity guarantee?',
      options: ['The count of ones minus zeros stays within ±1 at every code boundary', 'No code has more than two equal bits in a row', 'Every ten-bit code has exactly five ones', 'The first bit of every code is a transition'],
      answer: 0,
      explain: 'Unbalanced codes (four or six ones) alternate: one with an excess of ones is sent only at RD− and flips it. The stream is DC-balanced and runs never exceed five equal bits; 141 of the 268 symbols are balanced and need no state.',
      why: ['', 'Manchester has runs of at most 2; 8b/10b allows up to 5.', 'Many codes have four or six ones; only the disparity bookkeeping keeps the average balanced.', 'No such rule: the comma and the 5-run limit are what supply edges.'],
    },
    {
      question: 'What is the line rate of 10 Gb/s Ethernet\'s 64b/66b, and how does the overhead compare with 8b/10b?',
      options: ['10.3125 Gbaud: 3.1 % overhead against 25 %', '12.5 Gbaud: 25 % overhead', '10.3125 Gbaud: 25 % overhead', '11 Gbaud: 10 % overhead'],
      answer: 0,
      explain: '66 bits carry 64: 10 · 66/64 = 10.3125 Gbaud, 2 bits in 64 or 3.1 %. 8b/10b spends 2 in 8, 25 %, but guarantees runs and balance, where the scrambler of 64b/66b only makes them likely.',
      why: ['', '12.5 Gbaud would be 8b/10b at 10 Gb/s.', 'The rate matches 64b/66b; the 25 % belongs to 8b/10b.', 'The ratio is 66/64, not 11/10.'],
    },
  ],
  cdr: [
    {
      question: 'An Alexander phase detector sees data samples d ≠ p (a transition between them) and the edge sample e equal to p. What does it vote?',
      options: ['The strobe fired early: the transition came after the edge sample', 'The strobe fired late', 'No vote: only d = p gives a vote', 'The sender is too fast'],
      answer: 0,
      explain: 'The edge sample sits halfway between the two data samples. e still equal to p means the line had not yet changed at e, so the transition is later and the strobe is early. e equal to d would mean late. With d = p there is no vote.',
      why: ['', 'Late would be e already equal to d.', 'It is the opposite: with d = p there is no transition to vote on.', 'Early or late says where the strobe is, not which way the sender\'s clock is off; the loop integrates votes to follow that.'],
    },
    {
      question: 'A loop with ±4 votes per slip keeps up while δ ≤ ρ/16, ρ the fraction of bit periods that carry an edge. What tolerance does a stream with an edge in every fifth bit guarantee?',
      options: ['1.25 %: ρ = 0.2', '0.2 %', '20 %', '5 %'],
      answer: 0,
      explain: '0.2 / 16 = 1.25 %. 8b/10b guarantees an edge in every five bits, so the loop\'s range has a floor; real streams carry more edges and measure ±2 % to ±3 % on the chapter\'s detector.',
      why: ['', 'That divides by 100 instead of 16.', 'ρ itself is 20 %; the tolerance divides it by 16.', '5 % would need ρ = 0.8, an edge in almost every bit.'],
    },
  ],
  eye: [
    {
      question: 'A channel with a single pole at 1 GHz: at what bit rate does the eye close?',
      options: ['9.06 Gb/s: a = e^(−2π·B/R) reaches ½', '2 Gb/s: twice the bandwidth', '4.53 Gb/s: the Nyquist frequency', '1 Gb/s: the pole itself'],
      answer: 0,
      explain: 'The opening is 2(1 − 2a) of the ±1 swing and closes at a = ½, that is R = 2π · B / ln 2 = 9.06 B. The BER collapses well before that: at 8 Gb/s the eye is 9 % open.',
      why: ['', 'Nyquist\'s 2B bounds a noiseless ideal channel; a single pole closes the eye at a different rate.', 'The Nyquist frequency of 9.06 Gb/s is 4.53 GHz; the bit rate itself is twice that.', 'A pole is where the gain has fallen by 3 dB, not where the eye closes.'],
    },
    {
      question: 'To reach a bit error rate of 10⁻¹² with Gaussian noise of rms σ at the slicer, how big must the half-opening of the eye be?',
      options: ['About 7.03 σ', 'About 3 σ', 'About 1 σ', 'About 12 σ'],
      answer: 0,
      explain: 'A bit is wrong when the noise exceeds half the opening: BER = Q(opening / 2σ), and Q(7.03) = 10⁻¹².',
      why: ['', 'Q(3) is 1.3 × 10⁻³, a bit in a thousand.', 'Q(1) is 16 %.', 'That is beyond what the target needs: Q(12) is below 10⁻³².'],
    },
  ],
  equalization: [
    {
      question: 'At 8 Gb/s a CTLE gives a wider eye (58 %) than a DFE (34 %), yet the DFE has the better BER. Why?',
      options: ['The CTLE amplifies the noise with the signal (gain 1.84 at Nyquist); the DFE leaves it alone', 'The DFE\'s eye is wider where it matters', 'The CTLE adds jitter', 'The DFE uses a faster clock'],
      answer: 0,
      explain: 'BER depends on opening over noise at the slicer. The CTLE\'s σ rises from 40 mV to 74 mV, so its larger opening does not buy a lower BER; the DFE subtracts known ISI from decided bits and takes nothing from the noise.',
      why: ['', 'The opening figures are the whole story for the signal; noise is the difference.', 'The CTLE\'s cost is noise gain, not timing jitter.', 'Both run on the same bit clock; the DFE\'s constraint is that its decision must be back within one bit.'],
    },
    {
      question: 'What limits a decision-feedback equalizer?',
      options: ['The decision must return through the subtract and slicer within one bit, and one wrong decision propagates', 'It cannot cancel the first post-cursor', 'It needs a copy of the channel at the transmitter', 'It amplifies high-frequency noise'],
      answer: 0,
      explain: 'The DFE subtracts h₁ times the last decision from the next sample, so the loop must close in one bit period (125 ps at 8 Gb/s here), and a wrong decision subtracts the wrong tail, making the next one more likely wrong.',
      why: ['', 'Cancelling the first post-cursor is exactly what it does, for free.', 'Transmit de-emphasis (FFE) is the one that acts blind on the sending side; a DFE adapts at the receiver.', 'It subtracts a tail and filters nothing, so it adds no noise.'],
    },
  ],
  crc: [
    {
      question: 'Thirty-two consecutive bits of a frame are flipped. Does CRC-32 notice?',
      options: ['Always: any burst of 32 bits or fewer is caught by construction', 'Only with probability 1 − 2⁻³²', 'Only if the burst has odd weight', 'Only if the burst is aligned to a byte'],
      answer: 0,
      explain: 'A burst is xⁱ times a polynomial of degree 31 or less with constant term 1. The generator has degree 32 and constant term 1, so it cannot divide anything of lower degree, and the check always fails.',
      why: ['', '2⁻³² is the miss probability for longer or scattered patterns; a short burst has none.', 'The generator has 15 terms, so odd-weight errors are not all guaranteed; the burst guarantee does not depend on weight.', 'Alignment makes no difference to polynomial divisibility.'],
    },
    {
      question: 'A stuck driver sends garbage frames. What chance does each have of passing CRC-32?',
      options: ['2⁻³² ≈ 2.3 × 10⁻¹⁰', '2⁻¹⁶', '1 in 1500', 'Zero'],
      answer: 0,
      explain: 'Any other error pattern is a multiple of the generator with probability 2⁻³², so a random frame passes one time in 4.3 billion; at 5260 frames a second that is one every 9.5 days if every frame were garbage.',
      why: ['', 'That is a 16-bit check\'s figure.', 'The frame length does not set the chance of a pattern being a multiple of G.', 'A check with r bits cannot give zero: some garbage is always a code word.'],
    },
  ],
  arq: [
    {
      question: 'Stop-and-wait over a path whose one-way delay is a = 52.7 frame times, at 1 % loss. What fraction of the link does it use?',
      options: ['About 0.93 %: (1 − p) / (1 + 2a)', 'About 99 %: 1 − p', 'About 48 %', 'About 50 %'],
      answer: 0,
      explain: 'One frame per round trip of 1 + 2a = 106 slots, and each loss repeats it: 0.99 / 106.4 = 0.93 %. The line is idle 99 % of the time.',
      why: ['', 'That is selective repeat\'s ideal with a window big enough to fill the pipe.', 'That is go-back-N with a full window at 1 % loss (48.2 %), not stop-and-wait.', 'Stop-and-wait has no window; the round trip, not the loss, dominates.'],
    },
    {
      question: 'Why does go-back-N carry only 48.2 % at 1 % loss on that path with a full window, where selective repeat ideally carries 99 %?',
      options: ['Each loss makes it resend a whole round trip of frames', 'Its window is smaller', 'It waits for each frame\'s acknowledgement', 'It cannot use cumulative acknowledgements'],
      answer: 0,
      explain: 'Go-back-N resends the lost frame and everything after it, so a loss costs about 1 + 2a slots: (1 − p) / (1 + 2ap). Selective repeat resends only the lost frame, at the price of a buffer per window slot.',
      why: ['', 'Both use windows of the same size here (at least a round trip).', 'That is stop-and-wait; go-back-N keeps a window in flight.', 'Cumulative acknowledgements are what it uses.'],
    },
  ],
  viterbi: [
    {
      question: 'Why can a Viterbi decoder keep just one path per state?',
      options: ['Two paths in the same state at the same moment have the same future, so only the cheaper can win', 'The other paths are always wrong', 'The encoder has only one path per state', 'Memory limits it to one'],
      answer: 0,
      explain: 'The future of a path depends only on its state, not on how it got there, so the one with the lower metric dominates. The work per bit is constant (2^(K−1) states) instead of growing as 2^L streams.',
      why: ['', 'Both may be plausible; it is the cost so far that decides, not correctness.', 'The encoder is a state machine: many paths reach a state, they differ in metric.', 'It is a property of the code\'s structure, not a memory trick.'],
    },
    {
      question: 'What does keeping three bits of the slicer\'s confidence (soft decisions) buy on the K = 7 code?',
      options: ['About 2.4 dB less signal for roughly 9 % more gates', 'About 20 dB, free', 'Nothing: the metric is the same', 'It doubles the code rate'],
      answer: 0,
      explain: 'The branch metric becomes a distance in voltage rather than a count of differing bits. The decoder grows from 101 094 to 110 578 NANDs; at 10⁻⁵ the gain is 5.4 dB soft against 3.1 dB hard.',
      why: ['', 'No decoder gives that; the whole code gains 5.4 dB over uncoded at best.', 'The metric changes from a Hamming count to a voltage distance.', 'The rate is set by the encoder (½); soft decisions leave it alone.'],
    },
  ],
  reedsolomon: [
    {
      question: 'RS(255, 223) has 32 check bytes. How many wrong bytes can it correct?',
      options: ['16: 32 check bytes / 2', '32', '8', '223'],
      answer: 0,
      explain: '2t check bytes correct t wrong bytes, the maximum distance any code of that size can have. A wrong byte costs one error however many of its eight bits are wrong.',
      why: ['', 'That would be one check byte per error; the locations also need to be found.', 'A byte is not corrected bit by bit; t counts bytes.', 'That is the number of data bytes, not the correction power.'],
    },
    {
      question: 'Why does a burst of 121 bits fall within RS(255, 223)\'s power?',
      options: ['It touches at most 16 bytes, and t = 16 counts bytes', 'It has fewer than 121 errors', 'Reed–Solomon corrects any burst', 'Because bursts are always aligned to bytes'],
      answer: 0,
      explain: 'A burst of 121 bits starts anywhere in a byte and covers 1 + 15 · 8 bits, so it spans at most 16 bytes. One byte wrong in eight bits costs what one wrong bit does.',
      why: ['', 'A burst may have all 121 bits wrong; the code does not count bits.', 'There is a limit: 17 bytes would defeat it.', 'It need not be aligned; the worst case is 16 bytes either way.'],
    },
  ],
  interleave: [
    {
      question: 'Thirty-two SEC-DED words (one bit corrected each) are interleaved to depth 32. What is the longest channel burst they survive?',
      options: ['32 bits: D · t', '1 bit', '64 bits', '32 words'],
      answer: 0,
      explain: 'A burst of b bits puts at most ⌈b / D⌉ errors in any word, so words correcting t = 1 survive b ≤ D · t = 32.',
      why: ['', 'Without interleaving a burst of two already defeats a SEC-DED word.', '64 bits would put two errors in some word.', 'The burst is measured in channel bits, not words.'],
    },
    {
      question: 'What does interleaving cost?',
      options: ['A buffer of D words at each end and D words of delay; no extra redundancy', 'D times as many check bits', 'A lower code rate', 'A faster clock'],
      answer: 0,
      explain: 'The code is untouched, so the rate is unchanged. Nothing can be read until the block is full, so the delay is D words, which is why a voice call interleaves less than a broadcast.',
      why: ['', 'No check bits are added; the same bits are only reordered.', 'The rate (data over total bits) does not change.', 'The reorder is memory and addressing, not speed.'],
    },
  ],
};
