// Where a box symbol's text goes: the port names just inside its edges and the label in the
// middle. DOM-free, so the layout tests check every registered box (tests/layout.test.ts:
// boxTextOverlaps) with the very positions drawSymbol uses. A short box with a port name at the
// bottom (a clock) or the top moves its label up or down, clear of it; a one-port box with a label
// (a constant) prints no port name.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import type { Rect } from './route';

/** Font sizes (grid units) of .sym-port and .sym-label (styles/app.css). */
const PORT_FONT = 0.8, LABEL_FONT = 1.05;
/** Advance per character: the port font is monospace (0.6 em); the label's UI font is narrower on average. */
const PORT_EM = 0.6, LABEL_EM = 0.58;

export interface BoxPortText { name: string; x: number; y: number; anchor: 'start' | 'middle' | 'end'; side: string; clock: boolean }
export interface BoxText {
  ports: BoxPortText[];
  /** The label's baseline (centred on x), or null for none. */
  label: { text: string; x: number; y: number } | null;
}

const textRect = (x: number, y: number, chars: number, font: number, em: number, anchor: 'start' | 'middle' | 'end'): Rect => {
  const w = chars * font * em;
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  return { x: x0, y: y - 0.75 * font, w, h: 0.95 * font };
};

/** A port name's box (an overline is no wider: active-low names drop their _n). */
export const portTextRect = (p: BoxPortText): Rect => textRect(p.x, p.y, p.name.endsWith('_n') ? p.name.length - 2 : p.name.length, PORT_FONT, PORT_EM, p.anchor);
export const labelRect = (l: NonNullable<BoxText['label']>): Rect => textRect(l.x, l.y, l.text.length, LABEL_FONT, LABEL_EM, 'middle');

const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The text of a box symbol (not for vertical labels, which keep the middle). */
export function boxText(def: ComponentDef, flip = false): BoxText {
  const g = symbolGeom(def), { w, h } = g;
  const text = def.symbol.label ?? def.name;
  const ports: BoxPortText[] = [];
  // Pure-wiring boxes are too small for port names, and a one-port box with a label (a constant) needs none.
  const named = def.prim !== 'alias' && !def.symbol.noPortLabels && !(def.ports.length === 1 && text);
  for (const p of named ? def.ports : []) {
    const pg = g.ports[p.name];
    const side = p.side ?? (p.dir === 'out' ? 'right' : 'left');
    let x = pg.pos[0], y = pg.pos[1] + 0.38;
    let anchor: BoxPortText['anchor'] = 'start';
    if (side === 'left') x = 0.45;
    else if (side === 'right') { x = w - 0.45; anchor = 'end'; }
    else if (side === 'top') { y = 1.15; anchor = 'middle'; }
    else { y = h - 0.5; anchor = 'middle'; }
    if (flip && (side === 'left' || side === 'right')) {
      x = w - x;
      anchor = anchor === 'start' ? 'end' : 'start';
    }
    const clock = !!p.clock && (side === 'left' || side === 'bottom' || side === 'top');
    if (clock) {
      if (side === 'left') x += flip ? -0.7 : 0.7;
      else if (side === 'bottom') y -= 0.6;
    }
    ports.push({ name: p.name, x, y, anchor, side, clock });
  }
  if (!text) return { ports, label: null };
  const mid = h / 2 + 0.45;
  // The middle, unless a port name is in the way: then a little up or down, whichever is clear.
  const rects = ports.map(portTextRect);
  const clear = (y: number) => !rects.some((r) => hit(r, labelRect({ text, x: w / 2, y })));
  const y = [mid, mid - 0.7, mid + 0.7, mid - 1.1, mid + 1.1].find((c) => c - 0.8 >= 0 && c + 0.2 <= h && clear(c)) ?? mid;
  return { ports, label: { text, x: w / 2, y } };
}

/** Port names and the label of a box that hide one another (for the layout tests). */
export function boxTextOverlaps(def: ComponentDef): string[] {
  if (def.symbol.kind !== 'box' || def.symbol.verticalLabel) return [];
  const t = boxText(def);
  const out: string[] = [];
  const rs = t.ports.map((p) => ({ what: `port '${p.name}'`, r: portTextRect(p) }));
  if (t.label) rs.push({ what: `label '${t.label.text}'`, r: labelRect(t.label) });
  rs.forEach((a, i) => rs.slice(i + 1).forEach((b) => { if (hit(a.r, b.r)) out.push(`${a.what} × ${b.what}`); }));
  return out;
}
