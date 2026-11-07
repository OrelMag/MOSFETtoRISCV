// "Filters that learn"'s echo canceller on a real voice (public/dsp/voice-8k.wav, a public-domain LibriVox reading): the far end, the near-end talker and the room noise, and the
// figures the chapter quotes, so the prose need not fetch the clip. tests/dsp-echofigs.test.ts recomputes every one from the recording.

/** Samples the run lasts (4 s at 8 kHz); the far end is the reading's first 4 s. */
export const ECHO_RUN = 32000;
/** When someone talks at the near end, in samples: 0.875 s of the same reader's next sentence (from 4 s into the clip), placed there. */
export const TALK = { from: 18000, to: 25000, source: 32000 };
/** Room noise at the microphone, as a share of full scale: about 50 dB down, which is what limits the cancelling. */
export const ROOM_NOISE = 0.003;

/** The far end and the near-end talker from the recording (−1 … 1). */
export function voiceEcho(v: readonly number[]): { x: number[]; near: number[] } {
  const s = v.map((t) => t / 32768), x = s.slice(0, ECHO_RUN), near = new Array<number>(ECHO_RUN).fill(0);
  for (let i = TALK.from; i < TALK.to; i++) near[i] = s[TALK.source + (i - TALK.from)] ?? 0;
  return { x, near };
}

export const ECHO_FIGS = {
  /** NLMS, μ 0.5, 128 taps: ERLE over the last quarter, and with only 32 taps. */
  erle: 35.4, erle32: 14.6,
  /** Near-end talk with learning left on, and held while they talk. */
  talkOn: 25.1, talkHeld: 33.9,
  /** Plain LMS's step limits on this far end: 2 / (N σ²) from its average power, and 2 / (the loudest 128 samples' energy). */
  avgAllows: 1.87, loudestAllows: 0.176,
  /** Plain LMS still converges at 1.3 times the loudest-stretch limit and has diverged at 1.4 times it: the limit is sufficient, not where it breaks. */
  stillConverges: 1.3, diverges: 1.4,
  /** The widget's default plain step (0.15 × 10^−0.3) diverges once the far end is this loud. */
  loudDiverges: 2,
};
