// Today's models on the studio renderer, unchanged (phase 0 of the 3D pass): the box / cyl parts of gl/parts.ts become
// instance sets of a unit box and a unit cylinder, grouped by a material guessed from each part's `spec` (its colour
// rides in the instance record), and the see-through parts become glass items. DOM-free.

import { packInstances, type RGBA } from '../instances';
import type { Part } from '../parts';
import { lathe, roundedBox, type Geo } from './geo';
import type { Material } from './materials';
import type { PartLook } from './looks';
import type { Item } from './scene';

export const UNIT_BOX: Geo = roundedBox(1, 1, 1, 0);
export const UNIT_CYL: Geo = lathe([[0, -0.5], [0.5, -0.5], [0.5, 0.5], [0, 0.5]], { seg: 28, crease: 60 });

interface Tier { below: number; key: string; mat: Material }
/** spec 0..1 (today's "polished metal ≈ 0.4") → a material: metal, satin, or matte, as the model's look says. The colour
 *  comes per instance. */
const tiersOf = (l: PartLook = {}): Tier[] => [
  { below: l.satinFrom ?? 0.12, key: 'matte', mat: { base: [1, 1, 1], metal: 0, rough: l.matte?.rough ?? 0.7, label: 'matte' } },
  { below: l.metalFrom ?? 0.3, key: 'satin', mat: { base: [1, 1, 1], metal: 0, rough: l.satin?.rough ?? 0.38, coat: l.satin?.coat ?? 0.25, label: 'satin' } },
  { below: Infinity, key: 'metal', mat: { base: [1, 1, 1], metal: l.metal?.metal ?? 0.85, rough: l.metal?.rough ?? 0.32, label: 'metal' } },
];
const tierMemo = new WeakMap<PartLook, Tier[]>(), DEFAULT_TIERS = tiersOf();
const tiersFor = (l?: PartLook) => { if (!l) return DEFAULT_TIERS; let t = tierMemo.get(l); if (!t) tierMemo.set(l, (t = tiersOf(l))); return t; };

export interface PartScene { items: Item[]; sets: { key: string; geo: Geo; mat: Material; data: Float32Array }[] }

export function fromParts(parts: readonly Part[], look?: PartLook): PartScene {
  const TIERS = tiersFor(look), items: Item[] = [], groups = new Map<string, { geo: Geo; mat: Material; list: Part[] }>();
  for (const p of parts) {
    const a = (p.color as RGBA)[3] ?? 1, geo = p.kind === 'box' ? UNIT_BOX : UNIT_CYL;
    if (a < 1) {
      items.push({ geo, mat: { base: [p.color[0], p.color[1], p.color[2]], metal: 0, rough: 0.12, transmit: Math.min(0.89, 1 - a), label: 'glass' }, at: p.pos, rot: p.rot, scale: p.scale, cut: 'none', shadow: false });
      continue;
    }
    const t = TIERS.find((x) => (p.spec ?? 0) < x.below)!, key = `parts:${p.kind}:${t.key}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { geo, mat: t.mat, list: [] }));
    g.list.push(p);
  }
  // every tier always present (an empty one clears what an earlier paint drew)
  const sets = (['box', 'cyl'] as const).flatMap((k) => TIERS.map((t) => {
    const key = `parts:${k}:${t.key}`, g = groups.get(key);
    return { key, geo: k === 'box' ? UNIT_BOX : UNIT_CYL, mat: t.mat, data: packInstances(g?.list ?? []) };
  }));
  return { items, sets };
}
