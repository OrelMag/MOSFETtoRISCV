// What "Speech" and "Music" measure on their two recordings, written down so the prose can quote them without fetching a clip. tests/dsp-soundfigs.test.ts recomputes every one
// from public/dsp/*.wav, so they cannot drift from what the widgets show.

export const SPEECH_FIGS = {
  /** SNR of the voice as 14-bit samples, μ-law and 8 uniform bits, at its own level (peaks at −1 dB of full scale) and 30 dB down. */
  muSnr: 37.3, uniform8Snr: 31.9, quietMuSnr: 28.9, quietUniform8Snr: 4.5,
  /** IMA ADPCM's SNR on the 16-bit voice. */
  adpcmSnr: 18,
  /** RV32I instructions a sample, on the golden model, over the first second. */
  rvPerSample: 39.2,
  /** Mean prediction gain of order 10 over the loud pre-emphasized frames. */
  predGain: 6.6,
  /** The vocoder's share of voiced frames, and the median pitch it found. */
  voicedPct: 59, pitchHz: 127,
};

/** The teaching codec on the nocturne, at budgets of 64, 32 and 16 kb/s, bits by mask or by signal: kb/s actually spent, % of band-frames whose noise is above the mask, SNR and mean NMR in dB. */
export const MUSIC_FIGS = {
  mask64Rate: 49.4, mask64Audible: 1, mask64Snr: 21.4, mask64Nmr: -7.9,
  signal64Rate: 63.9, signal64Audible: 11.3, signal64Snr: 49.4, signal64Nmr: -29.1,
  mask32Rate: 31.7, mask32Audible: 17.3, mask32Snr: 21.3, mask32Nmr: -4.9,
  signal32Rate: 31.9, signal32Audible: 28.4, signal32Snr: 35, signal32Nmr: -11,
  mask16Rate: 15.9, mask16Audible: 49.3, mask16Snr: 13, mask16Nmr: 0.8,
  signal16Rate: 15.9, signal16Audible: 58.4, signal16Snr: 17.5, signal16Nmr: 1.7,
};
