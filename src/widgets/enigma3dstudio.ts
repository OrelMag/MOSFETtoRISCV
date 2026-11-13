// The M4 on the studio renderer (DOM-free): enigma3dmachine.ts's parts, each drawn in the material it is made of, and the
// current as light travelling the cipher's own path.
//
// Materials: a part's colour is one of the palette's (the case's stained wood, the black crackle panel, zinc, steel, brass,
// bakelite, the ivory key caps, the lamps), so the colour says what it is made of; each gets its finish here (varnish on
// the wood, a metal's sheen, the bakelite's gloss, a lit lamp's glow). A colour the palette does not name (grain, shades)
// keeps the plain finish by its old shininess. Each finish is one instance set of a unit box or cylinder, colour per part.
//
// The current: crypto/enigma.ts's trace, along enigma3dextras.ts's runs (key, plug, entry wheel, the four wheels, the
// reflector, back, plug, lamp), drawn as additive light that travels from the key to the lamp after each press. Where its
// head has got to is measured against the trace's contacts (pathPoints), so the readout can light each stage's letter as
// the light reaches it.

import { packInstances, type RGB, type RGBA } from '../gl/instances';
import type { Part } from '../gl/parts';
import { merge as mergeGeos, sphere, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import { UNIT_BOX, UNIT_CYL } from '../gl/kit/fromparts';
import { itemMatrix, type Item } from '../gl/kit/scene';
import type { Mat4, Quat, Vec3 } from '../gl/math';
import type { Trace } from '../crypto/enigma';
import type { EnigmaPalette } from './enigma3dparts';
import { pathPoints } from './enigma3dparts';

type Key = keyof EnigmaPalette;
const W: RGB = [1, 1, 1];
const fin = (o: Partial<Material> & { label: string }): Material => ({ base: W, metal: 0, rough: 0.5, ...o });
/** The finish of each palette colour: what the part is made of. */
export const FINISH: Partial<Record<Key, Material>> = {
  wood: fin({ rough: 0.42, coat: 0.4, label: 'oak, stained and varnished' }),
  woodDark: fin({ rough: 0.48, coat: 0.3, label: 'oak, darker stain' }),
  black: fin({ metal: 0.25, rough: 0.5, coat: 0.15, label: 'black-painted steel' }),
  panel: fin({ metal: 0.1, rough: 0.82, label: 'black crackle-finish panel' }),
  zinc: fin({ metal: 0.9, rough: 0.42, label: 'zinc die-casting' }),
  steel: fin({ metal: 1, rough: 0.3, label: 'steel' }),
  brass: fin({ metal: 1, rough: 0.28, label: 'brass' }),
  bakelite: fin({ rough: 0.28, coat: 0.6, label: 'bakelite' }),
  ivory: fin({ rough: 0.32, coat: 0.4, label: 'celluloid key caps' }),
  red: fin({ rough: 0.4, coat: 0.3, label: 'red paint' }),
  paper: fin({ rough: 0.9, label: 'paper' }),
  glass: fin({ rough: 0.15, coat: 0.6, label: 'lamp glass' }),
  lampOn: fin({ rough: 0.3, emit: W, glow: 1.6, bloom: 1.8, label: 'a lit lamp' }),
  lampLetter: fin({ rough: 0.5, label: 'lamp window letter' }),
  forward: fin({ rough: 0.4, emit: W, glow: 0.6, label: 'the current, going in' }),
  back: fin({ rough: 0.4, emit: W, glow: 0.6, label: 'the current, coming back' }),
  cable: fin({ rough: 0.65, label: 'plug cable, rubber' }),
  cotton: fin({ rough: 0.85, label: 'cotton-covered wire' }),
  loom: fin({ rough: 0.85, label: 'cloth loom' }),
  wireKey: fin({ rough: 0.8, label: 'key wiring' }),
  wireLamp: fin({ rough: 0.8, label: 'lamp wiring' }),
};
const PLAIN: Material[] = [
  fin({ rough: 0.7, label: 'matte' }),
  fin({ rough: 0.38, coat: 0.25, label: 'satin' }),
  fin({ metal: 0.85, rough: 0.32, label: 'metal' }),
];
const plainOf = (spec: number) => (spec < 0.12 ? 0 : spec < 0.3 ? 1 : 2);
const KEYS = Object.keys(FINISH) as Key[];
/** Every set this module ever fills, so a set emptied by a change is cleared. */
export const SET_KEYS: string[] = (['box', 'cyl'] as const).flatMap((k) => [...KEYS.map((f) => `en:${k}:${f}`), ...PLAIN.map((_, i) => `en:${k}:plain${i}`)]);

const same = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;
/** The palette key a part's colour is, if any. */
export function finishOf(c: readonly number[], P: EnigmaPalette): Key | null {
  for (const k of KEYS) if (same(c, P[k])) return k;
  return null;
}

export interface EnigmaSet { key: string; geo: Geo; mat: Material; data: Float32Array }
/** The parts as instance sets by finish (opaque ones), and the see-through ones as glass items. */
export function partSets(parts: readonly Part[], P: EnigmaPalette): { sets: EnigmaSet[]; glass: Item[] } {
  const lists = new Map<string, Part[]>(), glass: Item[] = [];
  for (const p of parts) {
    const a = (p.color as RGBA)[3] ?? 1;
    if (a < 1) {
      glass.push({ geo: p.kind === 'box' ? UNIT_BOX : UNIT_CYL, mat: { base: [p.color[0], p.color[1], p.color[2]], metal: 0, rough: 0.1, transmit: Math.min(0.9, 1 - a), label: 'glass' }, at: p.pos, rot: p.rot, scale: p.scale, cut: 'none', shadow: false });
      continue;
    }
    const f = finishOf(p.color, P), key = `en:${p.kind}:${f ?? `plain${plainOf(p.spec ?? 0)}`}`;
    let l = lists.get(key);
    if (!l) lists.set(key, (l = []));
    l.push(p);
  }
  const sets = SET_KEYS.map((key) => {
    const [, kind, f] = key.split(':'), mat = f.startsWith('plain') ? PLAIN[Number(f.slice(5))] : FINISH[f as Key]!;
    const list = lists.get(key) ?? [];
    return { key, geo: kind === 'box' ? UNIT_BOX : UNIT_CYL, mat, data: packInstances(list) };
  });
  return { sets, glass };
}

/** Every part as an item of its own colour: the flat drawing (no WebGL2) takes items only. */
export function flatItems(parts: readonly Part[]): Item[] {
  return parts.map((p) => {
    const a = (p.color as RGBA)[3] ?? 1;
    return { geo: p.kind === 'box' ? UNIT_BOX : UNIT_CYL, mat: { base: [p.color[0], p.color[1], p.color[2]] as RGB, metal: 0, rough: 0.5, transmit: a < 1 ? 1 - a : undefined, label: '' }, at: p.pos, rot: p.rot as Quat | undefined, scale: p.scale };
  });
}

// ---------------------------------------------------------------- the current as light

/** The whole way, key to lamp, as one polyline (the runs joined in order), and its length so far at each point. */
export function beamPath(runs: { forward: Vec3[][]; back: Vec3[][] }): { pts: Vec3[]; at: number[]; split: number } {
  const pts: Vec3[] = [];
  const add = (r: Vec3[]) => { for (const q of r) if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1], q[2] - pts[pts.length - 1][2]) > 1e-6) pts.push(q); };
  for (const r of runs.forward) add(r);
  const split = pts.length;
  for (const r of runs.back) add(r);
  const at = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  return { pts, at, split };
}
/** The path up to a length: the points passed and the head where it has got to. */
export function upTo(b: { pts: Vec3[]; at: number[] }, len: number): Vec3[] {
  const out: Vec3[] = [b.pts[0]];
  for (let i = 1; i < b.pts.length; i++) {
    if (b.at[i] <= len) { out.push(b.pts[i]); continue; }
    const f = (len - b.at[i - 1]) / (b.at[i] - b.at[i - 1]);
    if (f > 1e-6) out.push([0, 1, 2].map((j) => b.pts[i - 1][j] + (b.pts[i][j] - b.pts[i - 1][j]) * f) as Vec3);
    break;
  }
  return out;
}
/** How far along the path each stage of the trace is (its contact on a wheel's face): entry, the four wheels going in,
 *  the reflector, the four wheels coming back, the exit; the readout lights each as the light reaches it. */
export function stageLengths(t: Trace, b: { pts: Vec3[]; at: number[] }): number[] {
  const pp = pathPoints(t), marks: Vec3[] = [pp.forward[0], ...t.out.map((_, i) => pp.forward[2 + 2 * i]), pp.back[3], ...t.ret.map((_, i) => pp.back[5 + 2 * i]), pp.back[pp.back.length - 1]];
  return marks.map((m) => {
    let best = Infinity, len = 0;
    for (let i = 1; i < b.pts.length; i++) { // the nearest point of the path to the contact, by its length along
      const a = b.pts[i - 1], c = b.pts[i], d: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], L2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
      const s = L2 > 0 ? Math.max(0, Math.min(1, ((m[0] - a[0]) * d[0] + (m[1] - a[1]) * d[1] + (m[2] - a[2]) * d[2]) / L2)) : 0;
      const q = [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s], e = Math.hypot(q[0] - m[0], q[1] - m[1], q[2] - m[2]);
      if (e < best) { best = e; len = b.at[i - 1] + s * (b.at[i] - b.at[i - 1]); }
    }
    return len;
  });
}

const HEAD = sphere(2.6, 12, 8);
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** The light so far: the way in (forward colour) and back (back colour) as glowing tubes, and a bright head. */
export function beamItems(b: { pts: Vec3[]; at: number[]; split: number }, len: number, forward: Material['base'], back: Material['base']): Item[] {
  const shown = upTo(b, len), items: Item[] = [], k = b.split;
  const a = shown.slice(0, Math.min(k, shown.length)), c = shown.length > k ? shown.slice(k - 1) : [];
  const glow = (base: Material['base'], label: string): Material => ({ ...M.beam(base as `--${string}`, 1.4, label), bloom: 1.6 });
  if (a.length > 1) items.push({ geo: tube(a, 1.3, { sides: 8 }), mat: glow(forward, 'the current, going in'), name: 'the current', group: 'current', shadow: false, cut: 'none' });
  if (c.length > 1) items.push({ geo: tube(c, 1.3, { sides: 8 }), mat: glow(back, 'the current, coming back'), name: 'the current', group: 'current', shadow: false, cut: 'none' });
  if (len < b.at[b.at.length - 1]) items.push({ geo: transform(HEAD, tr(shown[shown.length - 1])), mat: { ...M.beam(W, 3, 'the current'), bloom: 2 }, name: 'the current', group: 'current', shadow: false, cut: 'none' });
  return items;
}

// ---------------------------------------------------------------- the see-through parts as one item per opacity

let glassMemo: { sig: string; items: Item[] } = { sig: '', items: [] };
/** The translucent parts (the ghosted case of the current's view, the lamp glass) merged into one glass item per opacity,
 *  each part's colour on its vertices; rebuilt only when one of them moved or changed (a hash of every number). */
export function glassItems(parts: readonly Part[]): Item[] {
  const byA = new Map<number, Part[]>();
  let h = 0;
  const mix = (v: number) => { h = (Math.imul(h ^ Math.round(v * 1000), 2654435761) >>> 0); };
  for (const p of parts) {
    const a = (p.color as RGBA)[3] ?? 1;
    if (a >= 1) continue;
    const k = Math.round(a * 100) / 100;
    let l = byA.get(k);
    if (!l) byA.set(k, (l = []));
    l.push(p);
    for (const v of [...p.pos, ...(p.scale ?? [1, 1, 1]), ...(p.rot ?? [0, 0, 0, 1]), ...p.color, p.kind === 'box' ? 1 : 2]) mix(v);
  }
  const sig = `${byA.size}:${h}`;
  if (sig === glassMemo.sig) return glassMemo.items;
  const items: Item[] = [...byA].map(([a, list]) => {
    const geos = list.map((p) => transform(p.kind === 'box' ? UNIT_BOX : UNIT_CYL, itemMatrix({ geo: UNIT_BOX, mat: PLAIN[0], at: p.pos, rot: p.rot, scale: p.scale }, 0)));
    const g = mergeGeos(geos), colors = new Float32Array(g.positions.length);
    let o = 0;
    list.forEach((p, i) => { const n = geos[i].positions.length; for (let k = 0; k < n; k += 3) colors.set([p.color[0], p.color[1], p.color[2]], o + k); o += n; });
    g.colors = colors;
    return { geo: g, mat: { base: W, metal: 0, rough: 0.1, transmit: Math.min(0.9, 1 - a), label: 'glass' }, cut: 'none' as const, shadow: false };
  });
  glassMemo = { sig, items };
  return items;
}
