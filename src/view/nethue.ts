// Colour per net (settings.netColors, data-netcolors on <html>): every net gets a hue of its own so
// a data path can be followed across a schematic. The hue comes from a stable key (the net's name,
// else its sorted ends), so a net keeps its colour across rebuilds, edits and reloads, and a circuit
// opened in the sandbox keeps the colours it had in its chapter. Drawn elements carry it as `--nh`
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

export function setNetHue(el: SVGElement, hue: number | undefined): void {
  if (hue === undefined) el.style.removeProperty('--nh');
  else el.style.setProperty('--nh', String(hue));
}
