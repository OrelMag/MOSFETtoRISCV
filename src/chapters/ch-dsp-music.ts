// Music (level Signal processing): what can a codec safely throw away? The MDCT with perfect reconstruction (against scipy's DCT-IV), a masking model labelled simplified, and a teaching
// codec of ours that gives its bits by the mask or by the signal. No format is followed or claimed. The recording is a CC0 Musopen one; sources in docs/DSP-SOURCES.md.

import { bands, MASK, MDCT_M } from '../dsp/music';
import { MUSIC_FIGS as F } from '../dsp/soundfigs';
import { codecWidget, maskWidget, musicWidget, tdacWidget } from '../widgets/dspmusic';
import { numOf } from './order';
import type { Chapter } from './types';

export const chMusic: Chapter = {
  id: 'music', num: numOf('music'), title: 'Music', level: 'Signal processing',
  blurb: 'What can a codec safely throw away? The MDCT and its perfect reconstruction, a simplified model of what the ear misses, and a codec of ours that spends its bits only where noise would be heard.',
  goals: [
    'transform overlapping frames and get the signal back exactly',
    'say what masking is, and what a simple model of it leaves out',
    'give bits by a mask, and show why SNR is the wrong measure of the result',
  ],
  builds: ['signals', 'spectrum', 'multirate', 'speech'],
  recap: {
    keep: [
      'The MDCT turns 2M samples into M coefficients, and each frame alone comes back aliased. With a window whose halves meet w[n]² + w[n + M]² = 1, overlapped frames cancel each other\'s aliasing exactly.',
      'A loud sound hides quieter ones near it in frequency, more above it than below. A perceptual codec computes that mask every frame and lets the noise sit under it.',
      'Bits given by the mask can leave less SNR and less audible noise than bits given by the signal. SNR counts all noise alike; the ear does not.',
      'Starved of bits, nothing saves a codec: at 16 kb/s half the band-frames are audible either way, though the mask still does better.',
    ],
    check: [
      {
        question: 'An MDCT frame alone, transformed and back, has aliasing. What removes it?',
        options: ['Adding the next frame\'s overlapping half', 'A longer transform with more coefficients', 'A low-pass filter after it', 'Quantizing more finely'],
        answer: 0,
        explain: 'The aliasing in the second half of one frame is the opposite of the aliasing in the first half of the next. Overlap-added, it cancels: time-domain aliasing cancellation.',
        why: ['', 'A longer frame has the same problem at its own edges.', 'The aliasing is in time, and in the same band as the music.', 'It is there with no quantization at all.'],
      },
      {
        question: 'Why does a masking model let a codec spend fewer bits?',
        options: ['Noise under the mask is not heard', 'Masked bands are louder', 'The mask removes the noise', 'It lowers the sample rate of each band'],
        answer: 0,
        explain: 'The codec only has to keep each band\'s quantization noise below what nearby sounds hide. Bands far below the mask need no bits at all.',
        why: ['', 'A masked band is the quiet one, near a louder one.', 'The noise is still there; the ear just cannot pick it out.', 'The rate is unchanged: only the bits per coefficient change.'],
      },
      {
        question: 'From the same 64 kb/s budget, bits by signal give 28 dB more SNR than bits by mask. Which sounds better, by the model?',
        options: ['Bits by mask', 'Bits by signal', 'Both the same', 'Neither: SNR says nothing'],
        answer: 0,
        explain: 'Bits by signal pile into the loudest bands, where noise is masked anyway, and leave quiet bands with audible noise. SNR does not see the difference.',
        why: ['', 'More SNR, and more bands with noise above their mask.', 'They put their noise in different places, and only one hides it.', 'It says something, just not what the ear hears.'],
      },
    ],
  },
  steps: [
    {
      title: 'What a codec may throw away',
      body: `
        <p><a href="#/c/speech/7">Speech</a> had a model of its source: a throat and a pitch. Music has no such model, so a music codec keeps the waveform and asks a different question: which parts of it would nobody hear if they were wrong?</p>
        <p>The recording is ten seconds of Chopin's Nocturne in E minor, Op. 72 No. 1, from Musopen's Chopin collection, which is marked CC0, public domain. The pianist is not named. It was decoded from Apple Lossless and resampled to 16 kHz mono by this site's own filter, and this site added no perceptual coding of its own: the source is lossless. At 16 bits that is 256 kb/s. (Chapter ${numOf('speech')}'s voice came from an MP3, which a telephone coder hardly notices; a codec that decides what the ear misses needs a source that has not already been through one.)</p>
        <p>A piano is a hard case for this: clear tones, long decays and quiet passages, where any added noise has little to hide behind.</p>
        <div class="try">Play it, and look at where the energy is.</div>`,
      widget: musicWidget,
      challenge: {
        kind: 'quiz', question: 'Why start from a lossless recording here?',
        options: ['An MP3 already dropped what the ear misses', 'Lossless files are always the smaller of the two', 'MP3 cannot be resampled', 'It makes no difference'],
        answer: 0,
        explain: 'A perceptual codec has already removed what its own model said was masked. Measuring masking on its output would mostly find its own decisions.',
        why: ['', 'They are larger.', 'Any decoded audio can be resampled.', 'It changes what is left to find.'],
      },
    },
    {
      title: 'Overlap without loss',
      body: `
        <p>A codec works on frames, and frames with hard edges click. The <strong>MDCT</strong>, <span data-ahead="dct">the modified discrete cosine transform, which writes a frame as a sum of cosines,</span> uses windows that overlap by half: each frame of 2M samples gives M coefficients, so there are no more numbers than samples. Like <a href="#/c/spectrum/0">chapter ${numOf('spectrum')}</a>'s DFT it turns a frame into frequencies, but with cosines alone, so real samples give real coefficients. Here M is ${MDCT_M}, a frame every ${(1000 * MDCT_M / 16000).toFixed(0)} ms.</p>
        <p>Any one frame, transformed and back, is wrong: half of it is folded over onto itself. But with a window whose two halves satisfy w[n]² + w[n + M]² = 1, such as the sine window w[n] = sin(π (n + ½) / 2M), the next frame's error is the exact opposite, and the overlapped sum is the signal. This is time-domain aliasing cancellation. The tests hold this MDCT equal to scipy's DCT-IV (the cosine transform with half-sample shifts in both time and frequency) of the folded frame to 9 places, and the reconstruction to the signal within 10⁻¹².</p>
        <div class="try">Look at the two frames separately, each wrong in its own way, and at their sum, on top of the music.</div>`,
      widget: tdacWidget,
      challenge: {
        kind: 'quiz', question: 'How many coefficients does one MDCT frame give for 2M samples?',
        options: ['M', '2M', '4M', 'M / 2'],
        answer: 0,
        explain: 'Half as many as its samples, and since frames overlap by half, one coefficient per sample overall.',
        why: ['', 'That would double the data.', 'That is four times more numbers than are needed.', 'That would lose information.'],
      },
    },
    {
      title: 'What the ear misses',
      get body() {
        return `
        <p>A loud tone hides quieter sounds near it in frequency: this is <strong>masking</strong>. It reaches further upward than downward, and it is measured on the ear's own scale, the Bark, about one critical band per Bark. At 16 kHz this codec's ${MDCT_M} coefficients fall into ${bands(16000).length} bands about a Bark wide.</p>
        <p>The model here is simplified, and says so. Each band's level spreads to its neighbours, falling ${MASK.down} dB a Bark below and ${MASK.up} above, and masks at ${MASK.offset} dB under itself. The threshold in quiet sets a floor. Bark is Zwicker's formula and the floor is Terhardt's, both from memory, with full scale taken as ${MASK.fullScaleSpl} dB SPL (sound pressure level: decibels above 20 µPa, about the quietest 1 kHz tone a young ear hears). Real codecs tell tones from noise, follow masking in time and are tuned on listening tests. This one does none of that.</p>
        <div class="try">Step through frames: a held chord makes a high mask over its neighbours, and a quiet passage leaves the mask near the floor.</div>`;
      },
      widget: maskWidget,
      challenge: {
        kind: 'quiz', question: 'A loud tone at 1 kHz. Which is better hidden: a faint tone at 1.2 kHz or at 0.8 kHz?',
        options: ['1.2 kHz, above it', '0.8 kHz, the one below it', 'Both the same', 'Neither'],
        answer: 0,
        explain: 'Masking spreads further upward in frequency than downward, so the tone above is the better hidden.',
        why: ['', 'Below, the mask falls off faster.', 'The spread is not symmetric.', 'Both are near enough to be masked to some extent.'],
      },
    },
    {
      title: 'Bits where they are heard',
      body: `
        <p>Now give out bits. Each bit a coefficient takes lowers its band's noise by 6 dB, and bits go one at a time to the band where the next one buys most for what it costs. By the <em>signal</em>, a bit buys noise power wherever it is: the loudest bands get the most, which is what plain SNR rewards. By the <em>mask</em>, a bit buys the dB it takes off noise that is above the mask, and a band well under it gets nothing. It is the same loop with two measures of what a bit is worth. A 4-bit count per band and a 6-bit scale factor for each band that has bits are side information, counted in every rate here.</p>
        <p>Given 64 kb/s, bits by mask stop at ${F.mask64Rate} kb/s, because the model says nothing more would be heard: ${F.mask64Audible} % of band-frames have noise above their mask. Bits by signal spend ${F.signal64Rate} kb/s for an SNR of ${F.signal64Snr} dB against ${F.mask64Snr}, and leave ${F.signal64Audible} % of band-frames audible by the same model. More SNR, worse sound.</p>
        <p>Starved, it holds, but neither is good. At 32 kb/s the mask leaves ${F.mask32Audible} % audible against ${F.signal32Audible} %, and at 16 kb/s ${F.mask16Audible} % against ${F.signal16Audible} %: once every band is short, about half of them are heard either way. That is what a codec's lowest rates sound like.</p>
        <p>This codec is ours, to show the idea. It follows no format, is not compatible with anything, and has none of a real codec's refinements: <span data-ahead="huffman">entropy coding (short codes for common values, as the Huffman codes of <a href="#/c/pictures/6">the next chapter</a> give)</span>, window switching for sharp attacks, or joint stereo. Its numbers are for this recording and this model.</p>
        <div class="try">Hear both at 64 kb/s, then lower the budget to 16 and hear both fail. Compare the bars for a quiet frame and a loud one.</div>`,
      widget: codecWidget,
      challenge: {
        kind: 'quiz', question: 'Why does giving bits by the mask leave less SNR but sound better?',
        options: ['Its noise is where it is masked', 'It uses more bits than the other', 'It removes the noise', 'SNR measures it wrongly'],
        answer: 0,
        explain: 'It leaves more noise overall, but puts it under the mask in every band. Bits by signal leave less noise in total, some of it in bands where it is heard.',
        why: ['', 'It uses fewer at 64 kb/s.', 'Quantization always adds noise.', 'SNR measures the noise correctly: it just weighs every band alike.'],
      },
    },
  ],
};
