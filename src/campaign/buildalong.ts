// Build along: a walkthrough step done by the learner. Their parts are matched to the reference's by kind and place
// (the step's outlines show where each goes), then their nets by the ports they join, so names and wire shapes are
// theirs to choose. No DOM.

import type { ChipDoc, PartDoc, Vec } from '../editor/model';

const kindOf = (p: PartDoc): string => JSON.stringify(p.ref);
const near = (a: Vec, b: Vec, d = 0.01) => Math.abs(a[0] - b[0]) <= d && Math.abs(a[1] - b[1]) <= d;

/** Their part id → the reference part on whose outline it sits (same kind, same place, same flip and turn). */
export function matchParts(ref: ChipDoc, mine: ChipDoc): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const rp of ref.parts) {
    const mp = mine.parts.find((p) => !used.has(p.id) && kindOf(p) === kindOf(rp) && near(p.at, rp.at) && !!p.flip === !!rp.flip && (p.rot ?? 0) === (rp.rot ?? 0));
    if (mp) { used.add(mp.id); out.set(mp.id, rp.id); }
  }
  return out;
}

/**
 * A part of theirs to move onto an outline: same kind, within `reach` grid units, the outline still free. The nearest
 * candidate first; null when there is nothing to snap.
 */
export function snapCandidate(guides: PartDoc[], mine: ChipDoc, reach = 3): { id: string; at: Vec; flip: boolean; rot?: 1 | 2 | 3 } | null {
  const taken = matchParts({ ...mine, parts: guides }, mine);
  const freeGuides = guides.filter((g) => ![...taken.values()].includes(g.id));
  let best: { id: string; at: Vec; flip: boolean; rot?: 1 | 2 | 3; d: number } | null = null;
  for (const g of freeGuides) {
    for (const p of mine.parts) {
      if (taken.has(p.id) || kindOf(p) !== kindOf(g)) continue;
      const d = Math.hypot(p.at[0] - g.at[0], p.at[1] - g.at[1]);
      if (d > 0.01 && d <= reach && (!best || d < best.d)) best = { id: p.id, at: g.at, flip: !!g.flip, rot: g.rot, d };
    }
  }
  return best && { id: best.id, at: best.at, flip: best.flip, rot: best.rot };
}

export interface BuildCheck {
  ok: boolean;
  /** Reference parts with no part of theirs on the outline. */
  missing: PartDoc[];
  /** Ports wired differently from the reference: "g2.b". */
  wiring: string[];
  /** Their parts on no outline that are wired into the circuit. */
  extra: string[];
}

/**
 * Compare their chip with the reference's partial chip after the step. `*Nets`: the compiled netOfEnd of each (end key →
 * net index, -1 for an end on no net). Only part ports and pins count.
 */
export function checkBuild(ref: ChipDoc, refNets: Map<string, number>, mine: ChipDoc, mineNets: Map<string, number>): BuildCheck {
  const map = matchParts(ref, mine);
  const matched = new Set(map.values());
  const missing = ref.parts.filter((p) => !matched.has(p.id));
  const counts = (k: string) => k.startsWith('p:') || k.startsWith('pin:');
  // their end keys in the reference's names; ends of unmatched parts kept apart
  const rename = (k: string): string | null => {
    if (k.startsWith('pin:')) return k;
    const m = /^p:([^.]+)\.(.*)$/.exec(k);
    if (!m) return null;
    const r = map.get(m[1]);
    return r ? `p:${r}.${m[2]}` : null;
  };
  const net = (nets: Map<string, number>, k: string) => {
    const n = nets.get(k);
    return n === undefined || n < 0 ? `alone:${k}` : `n${n}`;
  };
  const wiring = new Set<string>();
  const refToMine = new Map<string, string>(), mineToRef = new Map<string, string>();
  const mineByRefKey = new Map<string, string>();
  for (const [k] of mineNets) {
    if (!counts(k)) continue;
    const r = rename(k);
    if (r) mineByRefKey.set(r, k);
  }
  for (const [k] of refNets) {
    if (!counts(k)) continue;
    const pk = /^p:([^.]+)\./.exec(k)?.[1];
    if (pk && !matched.has(pk)) continue; // a missing part: reported as missing
    const mk = mineByRefKey.get(k);
    const rn = net(refNets, k);
    const mn = mk ? net(mineNets, mk) : `alone:mine:${k}`;
    const a = refToMine.get(rn), b = mineToRef.get(mn);
    if ((a !== undefined && a !== mn) || (b !== undefined && b !== rn)) wiring.add(k.replace(/^p:/, '').replace(/^pin:/, 'pin '));
    if (a === undefined) refToMine.set(rn, mn);
    if (b === undefined) mineToRef.set(mn, rn);
  }
  // their parts on no outline but on a net the circuit uses
  const usedNets = new Set(refToMine.values());
  const extra = new Set<string>();
  for (const [k, n] of mineNets) {
    const m = /^p:([^.]+)\./.exec(k);
    if (!m || map.has(m[1]) || n < 0) continue;
    if (usedNets.has(`n${n}`)) extra.add(m[1]);
  }
  return { ok: !missing.length && !wiring.size && !extra.size, missing, wiring: [...wiring], extra: [...extra] };
}
