// The level's recorded clips (public/dsp/*.wav, 16-bit mono), fetched only by the steps that use them and kept once loaded. Sources and licences: docs/DSP-SOURCES.md.

export interface Recording { rate: number; x: number[] }
export const CLIPS = {
  voice: { file: 'dsp/voice-8k.wav', credit: 'The Gettysburg Address, read by Shurtagal for LibriVox (public domain), 6 s from 0:25' },
  nocturne: { file: 'dsp/nocturne-16k.wav', credit: 'Chopin, Nocturne in E minor, Op. 72 No. 1, from Musopen\'s Chopin collection (CC0; the pianist is not named), 10 s from 0:05' },
} as const;

const cache = new Map<string, Promise<Recording>>();
/** A clip's samples, as −32768 … 32767. */
export function loadClip(name: keyof typeof CLIPS): Promise<Recording> {
  let p = cache.get(name);
  if (!p) {
    p = fetch(CLIPS[name].file).then((r) => { if (!r.ok) throw new Error(`${CLIPS[name].file}: ${r.status}`); return r.arrayBuffer(); }).then((b) => {
      const v = new DataView(b), n = (b.byteLength - 44) / 2;
      return { rate: v.getUint32(24, true), x: Array.from({ length: n }, (_, i) => v.getInt16(44 + 2 * i, true)) };
    });
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}
