// Per-instance data as the renderer uploads it: one interleaved float record per instance, read by the vertex
// shader with a divisor of 1. A hall of 60 000 relays is one Float32Array of 60 000 records per mesh.

import { QUAT_ID, type Quat, type Vec3 } from './math';

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export interface Instance {
  /** Centre of the unit mesh after scaling and rotation. */
  pos: Vec3;
  /** Size along the mesh's own axes (default 1). */
  scale?: Vec3;
  rot?: Quat;
  /** sRGB 0..1; alpha < 1 only in a transparent batch. */
  color: RGB | RGBA;
  /** Light the part gives off (sRGB 0..1, added after lighting): a glowing cathode, a warm coil. */
  emissive?: RGB;
  /** Specular strength 0..1 (polished metal ≈ 0.4). */
  spec?: number;
}

/** Record layout in floats: position 3, scale 3, rotation 4, colour 4, emissive 3 + specular 1. */
export const INSTANCE_FLOATS = 18;
export const INSTANCE_ATTRS = [
  { name: 'iPos', size: 3, offset: 0 },
  { name: 'iScale', size: 3, offset: 3 },
  { name: 'iRot', size: 4, offset: 6 },
  { name: 'iCol', size: 4, offset: 10 },
  { name: 'iMat', size: 4, offset: 14 },
] as const;

/** Write instance `k` of `out` (so a scene can rewrite a few records in place). */
export function writeInstance(out: Float32Array, k: number, inst: Instance): void {
  const o = k * INSTANCE_FLOATS, s = inst.scale ?? [1, 1, 1], r = inst.rot ?? QUAT_ID, c = inst.color, e = inst.emissive ?? [0, 0, 0];
  out[o] = inst.pos[0]; out[o + 1] = inst.pos[1]; out[o + 2] = inst.pos[2];
  out[o + 3] = s[0]; out[o + 4] = s[1]; out[o + 5] = s[2];
  out[o + 6] = r[0]; out[o + 7] = r[1]; out[o + 8] = r[2]; out[o + 9] = r[3];
  out[o + 10] = c[0]; out[o + 11] = c[1]; out[o + 12] = c[2]; out[o + 13] = (c as RGBA)[3] ?? 1;
  out[o + 14] = e[0]; out[o + 15] = e[1]; out[o + 16] = e[2]; out[o + 17] = inst.spec ?? 0;
}

export function packInstances(list: readonly Instance[], out = new Float32Array(list.length * INSTANCE_FLOATS)): Float32Array {
  list.forEach((inst, k) => writeInstance(out, k, inst));
  return out;
}
