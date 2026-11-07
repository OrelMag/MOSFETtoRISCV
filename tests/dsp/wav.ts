// A 16-bit mono WAV's samples, as the site's clips are stored, read from disk for the tests.
import { readFileSync } from 'node:fs';

export function wavSamples(path: string): { rate: number; x: number[] } {
  const b = readFileSync(path);
  return { rate: b.readUInt32LE(24), x: Array.from({ length: (b.length - 44) / 2 }, (_, i) => b.readInt16LE(44 + 2 * i)) };
}
