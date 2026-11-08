// Speech (level Signal processing): how does a voice fit in 2.4 kb/s? G.711 μ-law in gates (lib/ulaw.ts, every sample and code against dsp/speech.ts and against audioop), IMA ADPCM as
// an RV32I program on the golden model, linear prediction, and a vocoder of ours on a model. The voice is a public-domain LibriVox reading; sources in docs/DSP-SOURCES.md.

import { ulawDecision, VOC_BITS, vocBitRate, vocBitsPerFrame } from '../dsp/speech';
import { SPEECH_FIGS as F } from '../dsp/soundfigs';
import { adpcmProgramLength } from '../dsp/adpcmrv';
import { ulawDecoder, ulawEncoder } from '../lib/ulaw';
import { logicDepth, stats } from '../sim/stats';
import { adpcmRvWidget, adpcmWidget, companderWidget, lpcWidget, ulawApi, ulawScene, ulawWidget, vocoderWidget, voiceWidget } from '../widgets/dspspeech';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(Math.round(x));
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const kb = (b: number) => `${(b / 1000).toFixed(b % 1000 ? 1 : 0)} kb/s`;

export const chSpeech: Chapter = {
  id: 'speech', num: numOf('speech'), title: 'Speech', level: 'Signal processing',
  blurb: 'How does a voice fit in 2.4 kb/s? G.711 μ-law in gates, IMA ADPCM as an RV32 program, linear prediction and a vocoder, all heard side by side on a real reading.',
  goals: [
    'say why the telephone network codes samples on a logarithmic scale, and build that coder in gates',
    'code a voice by its differences, and count what the program costs a sample',
    'describe a voice by a filter and a source, and say what that buys',
    'compare the recording and three coders by rate and by what they keep',
  ],
  builds: ['signals', 'multirate', 'adaptive', 'fixed'],
  recap: {
    keep: [
      'μ-law gives each sample 8 bits whose steps grow with the level: segments double in width, so the noise is a roughly constant share of the signal over some 40 dB of level.',
      'G.711 defines μ-law by a table of decision and output values on 14-bit samples. The code is the sign, a 3-bit segment and a 4-bit step, sent inverted.',
      'ADPCM sends 4 bits of difference from a prediction, and adapts its step: the four smallest magnitudes (eight of the sixteen codes, with the sign) shrink it, the rest grow it. Encoder and decoder run the same arithmetic, so they agree without sending the step.',
      'Linear prediction fits a short all-pole filter to each frame: the coefficients carry the spectrum\'s envelope, which is the shape of the vocal tract.',
      'A vocoder sends that filter and a description of the source (pitch or noise, and a level) instead of the waveform: 54 bits every 22.5 ms here. It keeps the words and loses the voice\'s character.',
    ],
    check: [
      {
        question: 'Why does μ-law beat 8 uniform bits by so much on a quiet voice, and so little on a loud one?',
        options: ['Its steps grow with the level', 'It uses more bits for quiet samples', 'It filters out the noise', 'It only works on speech'],
        answer: 0,
        explain: 'A quiet voice lives in the small steps near zero, where μ-law\'s are finer than uniform 8-bit steps. A loud one uses the large steps, which are coarser.',
        why: ['', 'Every sample takes 8 bits either way.', 'It is a quantizer, and filters nothing.', 'It would treat any signal of the same level the same way.'],
      },
      {
        question: 'An ADPCM decoder never receives the step size. How does it know it?',
        options: ['It updates it from each code', 'It reads it from a header every frame', 'It measures the decoded signal\'s level', 'It uses one fixed step throughout'],
        answer: 0,
        explain: 'The step index moves by the same table from the same codes on both sides, so the two stay in step for as long as no code is lost.',
        why: ['', 'IMA ADPCM has no such header in its stream of codes.', 'That would lag, and the encoder would not know what it had measured.', 'The step adapts: that is the A in ADPCM.'],
      },
      {
        question: 'What does a vocoder send for a voiced frame, beyond the filter?',
        options: ['A pitch period and a level', 'The residual, sample by sample', 'The waveform at a lower rate', 'Only the filter, nothing more'],
        answer: 0,
        explain: 'The source is modelled as a pulse train at the pitch, scaled to the level. That is a few bits a frame instead of every sample.',
        why: ['', 'Sending the residual is what a waveform coder does, and it costs far more.', 'That is resampling, and it would keep the waveform\'s bits.', 'With no source, the filter would have nothing to shape.'],
      },
    ],
  },
  steps: [
    {
      title: 'A voice on a wire',
      body: `
        <p>The telephone network samples a voice 8 000 times a second, enough for the band from 300 Hz to 3.4 kHz that carries what is said: 8 kHz could hold up to 4 kHz, and the filter in front needs the margin. At 8 bits a sample that is 64 kb/s, a channel's worth, and this chapter is about how far below that a voice can go and what each step down costs.</p>
        <p>The voice here is a real one: six seconds of a LibriVox reading of the Gettysburg Address, whose recordings LibriVox releases into the public domain. It was decoded from LibriVox's 64 kb/s MP3, itself a lossy copy, cleared of a DC offset the recording carries, and resampled to 8 kHz by this site's own windowed-sinc filter. It is stored at 16 bits, so it starts at twice the telephone's rate.</p>
        <p>Its spectrum shows where the energy is: most of it below 1 kHz, where the voice's pitch and its first <strong>formants</strong> sit, the resonances of the throat and mouth (step 7 finds them), falling away towards 4 kHz.</p>
        <div class="try">Play it, and look at how much of the spectrum is below 1 kHz.</div>`,
      widget: voiceWidget,
      challenge: {
        kind: 'quiz', question: 'Sampling at 8 kHz keeps which band of the voice?',
        options: ['Up to 4 kHz', 'Up to 8 kHz', 'Up to 16 kHz', 'All of it'],
        answer: 0,
        explain: 'Half the sample rate is the most a sampled signal can hold. Above that it would fold, so a filter removes it first.',
        why: ['', 'That is the sample rate itself, twice what it can hold.', 'That would need 32 kHz.', 'A voice reaches past 8 kHz, and those parts are cut.'],
      },
    },
    {
      title: 'Why logarithms',
      body: `
        <p>A uniform quantizer has the same step everywhere, so its noise is the same whether someone shouts or whispers. A whisper then has a poor signal to noise ratio, and the bits spent on steps a whisper never reaches are wasted.</p>
        <p>The fix is steps that grow with the level, so the noise grows with the signal. Logarithmic steps keep the ratio about constant. The telephone's version is <strong>μ-law</strong>, named for the constant in its curve, sign(x) · ln(1 + μ|x|) / ln(1 + μ) with μ = 255 (Europe uses A-law, a cousin); G.711 codes a piecewise-linear version of it. The plot shows it for a sine at every level: 8 bits of μ-law stay near the same SNR over some 40 dB, where 8 uniform bits fall off a cliff. On quiet speech μ-law matches what 12 uniform bits would give.</p>
        <p>On this recording, normalized to 1 dB below full scale, μ-law gets ${F.muSnr} dB and 8 uniform bits ${F.uniform8Snr}: a loud voice keeps uniform close. Turned down by 30 dB, μ-law still gets ${F.quietMuSnr} dB and 8 uniform bits only ${F.quietUniform8Snr}.</p>`,
      widget: companderWidget,
      challenge: {
        kind: 'quiz', question: 'A uniform 8-bit coder loses about how much SNR when the signal drops by 20 dB?',
        options: ['About 20 dB', 'About 6 dB', 'Nothing at all', 'About 3 dB'],
        answer: 0,
        explain: 'Its noise stays where it was, so the ratio falls by exactly as much as the signal does.',
        why: ['', 'That is one bit, and the signal fell by more than three.', 'That is what logarithmic steps try for, and uniform ones do not.', 'That would be half the power, and 20 dB is a hundredth.'],
      },
    },
    {
      title: 'μ-law, from G.711\'s table',
      body: `
        <p>G.711 gives tables, not a formula: (2a and 2b) of 128 decision values and 128 output values for each sign, on 14-bit samples. They are built from 8 segments, each 16 steps, each segment's steps twice as wide as the last: 1 and 2 in the first, then 4, 8 and up to 256. Segment ends fall at ${[1, 2, 3, 4, 5, 6, 7, 8].map((s) => ulawDecision(16 * s)).join(', ')}.</p>
        <p>A code is the sign, the segment and the step. G.711 sends it inverted, so a positive sample's code is 255 − n and silence is 1111 1111. Encoding is a short sum: the magnitude plus 33 has its top bit at the segment and the step in the four bits below. Decoding is ((33 + 2m) ≪ e) − 33. The tests hold both against every row of the tables they were checked on, and against Python's audioop on all 16 384 samples and all 256 codes.</p>
        <div class="try">Move the sample up from 0 and watch the step grow each time the segment changes. Then hear the voice at 8 bits uniform and at 8 bits μ-law.</div>`,
      widget: ulawWidget,
      challenge: {
        kind: 'quiz', question: 'How wide is a step in μ-law\'s top segment, on 14-bit samples?',
        options: ['256', '1', '16', '2 048'],
        answer: 0,
        explain: 'Each segment doubles the step: 2, 4, 8 … and the eighth is 256 wide. Its 16 steps cover 4 096 values.',
        why: ['', 'That is the first step of the first segment.', 'That is how many steps a segment has.', 'That is half of the top segment\'s 4 096, which would make each of its 16 steps 128 wide.'],
      },
    },
    {
      title: 'μ-law in gates',
      get body() {
        return `
        <p>The encoder takes the magnitude, adds 33, finds the top set bit with a priority encoder, picks the four bits below it with a multiplexer, and inverts. A sample at the clip or beyond takes the top code. The decoder is the sum backwards: the step and two 1s make 33 + 2m, a shift by the segment, 33 taken off, and the sign put back.</p>
        <p>The encoder is ${n0(nands(ulawEncoder()))} NANDs and the decoder ${n0(nands(ulawDecoder()))}, with no clock. Their longest paths are ${logicDepth(ulawEncoder())} and ${logicDepth(ulawDecoder())} NAND delays, mostly the ripple adders: slow beside a fast adder, and still a fraction of the 125 µs between samples. The tests compare the encoder with the model on all 16 384 samples and the decoder on all 256 codes.</p>
        <div class="try">Send 50 ms of the voice. The panel feeds each sample to the gates, reads the code and the sample back, and checks both.</div>`;
      },
      scene: ulawScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Send the voice through the gates, every code and every sample back agreeing with G.711\'s model.',
        check: (st) => !!ulawApi.get(st)?.agrees(),
        hints: ['The panel beside the circuit has one button.'],
        answer: 'Four hundred samples, each encoded to 8 bits and decoded back by the gates, every one equal to the model.',
        solve: (st) => { ulawApi.get(st)?.run(); },
      },
    },
    {
      title: 'Send the difference',
      body: `
        <p>Neighbouring samples of a voice are close, so the difference from a prediction is smaller than the sample. <strong>ADPCM</strong>, adaptive differential pulse-code modulation (PCM is a sample sent as a code, as G.711 does), sends that difference in 4 bits and adapts its step: a small code shrinks the step for next time, a large one grows it, by the table of 89 steps about 10 % apart that the Interactive Multimedia Association (IMA) set out.</p>
        <p>The encoder runs the decoder's own arithmetic, so it predicts exactly what the far end will have, and the step never needs to be sent. That is 32 kb/s, half of μ-law. On this voice it reaches ${F.adpcmSnr} dB against μ-law's ${F.muSnr}. Its error is largest just after a loud onset, while the step is still growing: the plot shows the error separately, scaled up.</p>
        <p>The tests hold this model equal to Python's audioop on the voice and on a full-scale square wave, codes, state and the order audioop packs two codes into a byte, with the first in the high half. Microsoft's IMA ADPCM in WAV files puts it in the low half, and adds block headers, so these codes are not a WAV file's.</p>
        <div class="try">The plot opens at the first loud onset. Watch the step index climb and the error shrink as it does, then move along to quieter speech.</div>`,
      widget: adpcmWidget,
      challenge: {
        kind: 'quiz', question: 'Why does ADPCM send no step size?',
        options: ['Both sides compute it from the codes', 'It is fixed by the standard for every sample', 'It is sent once at the start of the call', 'The decoder does not need one'],
        answer: 0,
        explain: 'The step moves by the same table from the same codes at both ends, so it never has to travel.',
        why: ['', 'It changes at every sample, by the table.', 'One value would not adapt.', 'It needs one at every sample to scale the code.'],
      },
    },
    {
      title: 'ADPCM on the RV32',
      body: `
        <p>A coder like this is usually software. Here is the encoder as an RV32I program: ${adpcmProgramLength()} instructions, reading IMA's tables from memory, three comparisons for the three bits, two clamps, one table lookup for the step index. It needs no multiply.</p>
        <p>On the golden model it takes ${F.rvPerSample} instructions a sample, so keeping up with a voice at 8 kHz needs about ${(F.rvPerSample * 8000 / 1e6).toFixed(2)} million instructions a second, at one instruction a cycle as on this site's single-cycle core. Its codes equal the model's on the voice, block by block with the state carried over, and on the clipping square wave.</p>`,
      widget: adpcmRvWidget,
      challenge: {
        kind: 'quiz', question: 'Which operation does the program never use?',
        options: ['A multiply', 'A branch on a comparison', 'A shift right', 'A halfword load from memory'],
        answer: 0,
        explain: 'Each bit of the code is a compare, a subtract and an add of a halved step. Shifts halve the step, and the tables are loaded: nothing needs a multiply.',
        why: ['', 'Every code bit is decided by one.', 'Halving the step is a shift.', 'The step table is read a halfword at a time.'],
      },
    },
    {
      title: 'Predict the next sample',
      body: `
        <p>A better prediction leaves less to send. <strong>Linear prediction</strong> fits each 30 ms stretch with the best weighted sum of its last ten samples, the same Wiener problem <a href="#/c/adaptive/1">Filters that learn</a> solved with Levinson's recursion, here on the frame's autocorrelation. Pre-emphasis, 1 − 0.9375 z⁻¹, is applied first so the low end does not take all of the predictor's effort.</p>
        <p>What the prediction misses is the <strong>residual</strong>, and the filter that makes it from the frame is A(z) = 1 − Σ aₖ z⁻ᵏ. Running the residual back through 1 / A(z) makes the frame again, so 1 / A(z) is the voice's own filter: its response is the envelope of the frame's spectrum, the formants. A <em>voiced</em> sound, a vowel or an m, is driven by the vocal cords' pulses at the pitch, and an <em>unvoiced</em> one, an s or an f, by turbulent noise. On the loud frames of this voice, order 10 makes the error ${F.predGain} dB smaller than the pre-emphasized frame. The Levinson recursion also gives reflection coefficients, each inside ±1 for any real signal, which is what makes them safe to quantize.</p>
        <div class="try">On a voiced frame, raise the order from 2 to 20: the envelope finds the formants by about 10, and more coefficients add only small bumps, never the harmonics. Then try an unvoiced frame.</div>`,
      widget: lpcWidget,
      challenge: {
        kind: 'quiz', question: 'What does the LPC filter\'s response trace in a voiced frame?',
        options: ['The envelope over the harmonics', 'Each of the harmonics, exactly', 'The pitch of the speaker\'s voice', 'The noise floor alone, nothing more'],
        answer: 0,
        explain: 'A short all-pole filter can draw a smooth shape, the formants. The harmonics are the source, and ten coefficients cannot follow them all.',
        why: ['', 'It would need far more coefficients than ten.', 'Pitch is in the residual, not the envelope.', 'The envelope rises above the floor at each formant.'],
      },
    },
    {
      title: 'A vocoder at 2.4 kb/s',
      body: `
        <p>Now send the filter instead of the waveform. Every 22.5 ms (each frame analysed over a 30 ms window around it, so the windows overlap) the <strong>vocoder</strong> sends ten reflection coefficients, each k as a log-area ratio, ln((1 + k) / (1 − k)), which spreads out the values near ±1 where the sound is most sensitive, on ${VOC_BITS.k.reduce((a, b) => a + b, 0)} bits, more for the first ones, which shape the spectrum most. Then a voiced or unvoiced decision with a pitch period, on ${VOC_BITS.pitch} bits, a level on ${VOC_BITS.gain}, and a sync bit: ${vocBitsPerFrame()} bits a frame, ${kb(vocBitRate())}. The far end makes a pulse train at the pitch, or noise, and runs it through the filter.</p>
        <p>This vocoder is ours, a model, laid out like the US government's LPC-10 (Federal Standard 1015, 1984), which also sends 54 bits every 22.5 ms. On this reading it finds ${F.voicedPct} % of frames voiced and a median pitch of ${F.pitchHz} Hz. Its pitch tracking is simple, with centre clipping and a check for octave errors, and it makes mistakes a real one would avoid.</p>
        <p>The comparison is the point. μ-law at 64 kb/s and ADPCM at 32 keep the waveform. The vocoder at ${kb(vocBitRate())} keeps the words and loses the person: what comes out is intelligible and sounds like a machine. An SNR means nothing for it, because it never tries to match the samples.</p>
        <div class="try">Play all four, in order of rate.</div>`,
      widget: vocoderWidget,
      challenge: {
        kind: 'quiz', question: 'Why is SNR no measure of a vocoder?',
        options: ['It does not try to match the waveform', 'Its noise is always exactly zero', 'Its rate is too low for SNR to be measured', 'SNR only applies to music'],
        answer: 0,
        explain: 'It makes a new waveform with the same envelope and pitch. Sample by sample it differs completely, however good it sounds.',
        why: ['', 'Its output differs from the input almost everywhere.', 'SNR does not depend on the rate.', 'It applies to any waveform coder.'],
      },
    },
  ],
};
