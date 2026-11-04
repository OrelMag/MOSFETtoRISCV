// Every wire palette's value colours (0, 1, X, Z, bus) reach 3:1 (WCAG non-text contrast) on the board they sit on:
// the light theme's --bg, and the dark board a schematic takes in either theme (vivid.css --canvas). Parsed from
// palettes.css, so a new palette is checked without touching this file.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/palettes.css', import.meta.url), 'utf8');
const LIGHT_BOARD = '#f5f6fa'; // theme.css --bg
const DARK_BOARD = '#1b1f2a'; // vivid.css --canvas
const TOKENS = ['--w0', '--w1', '--wx', '--wz', '--bus'];

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function lum(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** palette id → token → [light, dark]; the default is the first block (selector `:root, [data-palette='default']`). */
const palettes = new Map<string, Map<string, [string, string]>>();
for (const m of css.matchAll(/^(:root[^{]*\[data-palette='(\w+)'\][^{]*)\{([^}]*)\}/gm)) {
  const toks = new Map<string, [string, string]>();
  for (const t of m[3].matchAll(/(--[\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)) toks.set(t[1], [t[2], t[3]]);
  palettes.set(m[2], toks);
}

describe('wire palettes', () => {
  it('finds the five palettes', () => {
    expect([...palettes.keys()].sort()).toEqual(['cb', 'contrast', 'default', 'lsim', 'print']);
  });
  for (const [id, toks] of palettes) {
    it(`${id}: value colours reach 3:1 on the light and the dark board`, () => {
      for (const k of TOKENS) {
        const [l, d] = toks.get(k)!;
        expect(contrast(l, LIGHT_BOARD), `${id} ${k} on light ${l}`).toBeGreaterThanOrEqual(3);
        expect(contrast(d, DARK_BOARD), `${id} ${k} on dark ${d}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
