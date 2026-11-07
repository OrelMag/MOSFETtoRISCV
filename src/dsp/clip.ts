// A clip of computed sound (DOM-free): what widgets/clip.ts plays. `source` says what made it, which the player shows: full-length sound comes
// from a model, and a clip from the gates is short and checked equal to the model first (nothing large plays live through a simulator).

export type ClipSource = 'model' | 'gates';
export interface Clip { samples: ArrayLike<number>; rate: number; source: ClipSource; note?: string; /** Samples faded in and out (default 200): a very short clip needs fewer. */ fade?: number }

/** Loudest the player goes. A filter's peak or a wrapped word never reaches the ears any harder than this. */
export const CLIP_PEAK = 0.3;

/** Scaled so its peak is CLIP_PEAK, or by `scale` if given (to compare two clips' loudness), and faded at both ends so it starts and stops without a click. */
export function prepareClip(samples: ArrayLike<number>, opts: { scale?: number; fade?: number } = {}): Float32Array {
  const n = samples.length, out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const k = opts.scale ?? (peak > 0 ? CLIP_PEAK / peak : 0);
  for (let i = 0; i < n; i++) out[i] = Math.max(-CLIP_PEAK, Math.min(CLIP_PEAK, samples[i] * k));
  const f = Math.min(opts.fade ?? 200, n >> 1);
  for (let i = 0; i < f; i++) { const g = i / f; out[i] *= g; out[n - 1 - i] *= g; }
  return out;
}
