// The two pictures chapter 33's first scene keeps in its frame buffers (DOM-free, so the CRT model and the tests can
// hold them without the screen panel): colour bars over a grey ramp, and rings around the centre. RGB332, 64 × 64.

import { FB_W as W } from './raster';

const grey332 = (k: number) => (k << 5) | (k << 2) | (k >> 1);

/** Frame 0 of the first scene: colour bars over a grey ramp. */
export function barsPicture(): Uint8Array {
  const bars = [0xff, 0xfc, 0x1f, 0x1c, 0xe3, 0xe0, 0x03, 0x00];
  const p = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) p[y * W + x] = y < 48 ? bars[x >> 3] : grey332(x >> 3);
  return p;
}

/** Frame 1: rings around the centre. */
export function ringsPicture(): Uint8Array {
  const cols = [0xe0, 0xfc, 0x1c, 0x1f, 0x03, 0xe3];
  const p = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) p[y * W + x] = cols[Math.floor(Math.hypot(x - 31.5, y - 31.5) / 4) % cols.length];
  return p;
}
