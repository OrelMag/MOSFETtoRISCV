// Colour per net (settings.netColors, data-netcolors on <html>): every net gets a hue of its own so
// a data path can be followed across a schematic. The hue comes from a stable key (the net's name,
// else its sorted ends), so a net keeps its colour across rebuilds, edits and reloads, and a circuit
// opened in the sandbox keeps the colours it had in its chapter; spreadHues then moves a net whose
// hue is close to a neighbour's (drawn next to it). Drawn elements carry it as `--nh`
// (inline style: value classes are rewritten on every repaint); palettes.css turns it into tokens.

import type { NetDef } from '../sim/types';

/** The identity a net's hue is derived from. */
export function netKey(net: NetDef): string {
  return net.name ?? [...net.ends].sort().join(' ');
}

/** A hue in OKLCH degrees, 40°–320°: clear of the red that marks X (which also keeps its dashes). */
export function netHue(key: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 40 + ((h >>> 0) % 281);
}

/** A net as drawn: its identity and its wires (polylines in grid units). */
export interface HueNet { key: string; polys: readonly (readonly (readonly [number, number])[])[] }

const SPREAD = 60; // degrees under which two neighbouring hues start to compete
const STEP = 2; // candidate hues, 40°–320° in 2° steps
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/**
 * Hues for nets drawn side by side: a hash alone gives two neighbours close hues one time in five,
 * and then the colour no longer tells them apart. Nets are rasterized in cells of two units; two nets
 * are neighbours by how much of one runs in or next to the other's cells, about two to four units
 * apart (a long parallel run counts more than a crossing). Most crowded first, each net keeps its own hue (netHue) unless that sits
 * within SPREAD of a neighbour already placed, and else takes the hue that costs least (nearest its
 * own on a tie), so a net far from others keeps its colour and an edit only recolours nets near it.
 */
export function spreadHues(nets: readonly HueNet[]): number[] {
  const own = nets.map((n) => netHue(n.key));
  // Cells each net passes through (one sample per unit), and the nets in each cell.
  const W = 1 << 16;
  const cellOf = (x: number, y: number) => (Math.floor(x / 2) + W / 2) * W + (Math.floor(y / 2) + W / 2);
  const cells = nets.map((n) => {
    const set = new Set<number>();
    for (const p of n.polys) for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i];
      set.add(cellOf(ax, ay));
      if (i === 0) continue;
      const [bx, by] = p[i - 1];
      const k = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let s = 1; s < k; s++) set.add(cellOf(ax + ((bx - ax) * s) / k, ay + ((by - ay) * s) / k));
    }
    return set;
  });
  const at = new Map<number, number[]>();
  cells.forEach((set, i) => { for (const c of set) { const l = at.get(c); if (l) l.push(i); else at.set(c, [i]); } });
  const near = nets.map(() => new Map<number, number>());
  cells.forEach((set, i) => {
    for (const c of set) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const w = dx || dy ? 0.5 : 1;
      for (const j of at.get(c + dx * W + dy) ?? []) if (j !== i) near[i].set(j, (near[i].get(j) ?? 0) + w);
    }
  });
  const crowd = near.map((m) => { let t = 0; for (const w of m.values()) t += w; return t; });
  const order = nets.map((_, i) => i).sort((a, b) => crowd[b] - crowd[a] || (nets[a].key < nets[b].key ? -1 : nets[a].key > nets[b].key ? 1 : a - b));
  const hues = [...own];
  const nbrs = near.map((m) => [...m]);
  const N = Math.floor((320 - 40) / STEP) + 1;
  const cost = new Float64Array(N);
  // The hue for net i against its neighbours in `placed` (all of them on the refining passes).
  const choose = (i: number, placed: (j: number) => boolean) => {
    cost.fill(0);
    let clash = false;
    for (const [j, w] of nbrs[i]) {
      if (!placed(j)) continue;
      const hj = hues[j];
      if (hueDist(own[i], hj) < SPREAD) clash = true;
      // Only candidates within SPREAD of hj pay for it.
      for (let k = Math.max(0, Math.ceil((hj - SPREAD - 40) / STEP)); k < N && 40 + k * STEP <= hj + SPREAD; k++) {
        const d = Math.abs(40 + k * STEP - hj);
        if (d < SPREAD) cost[k] += w * (1 - d / SPREAD) ** 2;
      }
    }
    if (!clash) return own[i];
    // A tiny pull towards the net's own hue makes the choice stable (nearest on a tie).
    let best = hues[i], bestCost = Infinity;
    for (let k = 0; k < N; k++) {
      const h = 40 + k * STEP, c = cost[k] + (1e-3 * hueDist(h, own[i])) / 180;
      if (c < bestCost - 1e-12) { best = h; bestCost = c; }
    }
    return best;
  };
  const done = new Uint8Array(nets.length);
  for (const i of order) { hues[i] = choose(i, (j) => !!done[j]); done[i] = 1; }
  // Greedy placement leaves early nets blind to later ones: a pass or two against every neighbour.
  for (let pass = 0; pass < 2; pass++) for (const i of order) hues[i] = choose(i, () => true);
  return hues;
}

export function setNetHue(el: SVGElement, hue: number | undefined): void {
  if (hue === undefined) el.style.removeProperty('--nh');
  else el.style.setProperty('--nh', String(hue));
}
