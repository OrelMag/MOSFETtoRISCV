// The short clip the gates render (DOM-free; widgets/dspsdr.ts plays it): the first CLIP_CLOCKS samples of the band through lib/sdr.ts's front end in a BitSim, then the same floating-point chain
// as the model's. The gates' words are compared with dsp/sdr.ts's, so the sound is the same either way (tests/dsp-sdr.test.ts).

import { signedOf, wordOf } from '../comm/signals';
import { sdrFront } from '../lib/sdr';
import { BitSim } from '../sim/bitsim';
import { flatten } from '../sim/flatten';
import type { Clip } from './clip';
import { AUD, demodulate, frontBlock, sample, tuningWord, W_CIC, W_IN, type Band } from './sdr';

/** 16 ms of the band: 15 360 clocks of the gates, 384 samples of sound. */
export const CLIP_CLOCKS = 15_360;
/** The first audio samples come from filters still filling (the channel filter is 41 taps, the audio filter 81, at 240 kHz): left out of both clips. */
export const CLIP_SKIP = 24;

const sound = (yr: ArrayLike<number>, yi: ArrayLike<number>) => demodulate(yr, yi).audio.slice(CLIP_SKIP);

/** The clip from the model. */
export function modelClip(b: Band, f: number, noiseDb: number): Clip {
  const { xr, xi } = sample(b, noiseDb, 0, CLIP_CLOCKS), { yr, yi } = frontBlock(xr, xi, tuningWord(f));
  return { samples: sound(yr, yi), rate: AUD, fade: 24, source: 'model', note: `${CLIP_CLOCKS} clocks of the band, the model's words` };
}

export interface GateRun { clip: Clip; yr: number[]; yi: number[]; clocks: number }
/**
 * The clip from the gates: every clock of the band through the mixer and the two CICs, the words that leave collected and then taken through the same filters, discriminator and de-emphasis.
 * `pause` is awaited now and then so a page stays alive (a timeout in the browser, a tick in tests); `progress` gets the share done.
 */
export async function gateClip(b: Band, f: number, noiseDb: number, o: { progress?: (share: number) => void; pause?: () => Promise<void> } = {}): Promise<GateRun> {
  const { xr, xi } = sample(b, noiseDb, 0, CLIP_CLOCKS), sim = new BitSim(flatten(sdrFront())), yr: number[] = [], yi: number[] = [];
  sim.setInput('ftw', [tuningWord(f)]);
  for (let i = 0; i < CLIP_CLOCKS; i++) {
    sim.setInput('xr', [wordOf(xr[i], W_IN)]); sim.setInput('xi', [wordOf(xi[i], W_IN)]);
    sim.cycle();
    if (sim.get('valid', 1)[0]) { yr.push(signedOf(sim.get('yr', 1)[0], W_CIC)); yi.push(signedOf(sim.get('yi', 1)[0], W_CIC)); }
    if (i % 1024 === 1023) { o.progress?.((i + 1) / CLIP_CLOCKS); await o.pause?.(); }
  }
  return { clip: { samples: sound(yr, yi), rate: AUD, fade: 24, source: 'gates', note: `${CLIP_CLOCKS} clocks of the band through the mixer and CIC in gates` }, yr, yi, clocks: CLIP_CLOCKS };
}
