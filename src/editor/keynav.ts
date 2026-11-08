// The canvas without a mouse (WCAG 2.1.1): what the keyboard cursor can land on and how it is said aloud.
// DOM-free (tested in Node). tools.ts holds the state (the cursor, the wire begun) and calls these; the
// announcements go to the editor's polite live region (Editor.announce).

import type { Vec } from '../sim/geometry';
import { attachPoints, type Hit } from './geom';
import { type ChipDoc, type DefOf, type EndRef, endKey } from './model';
import type { Sel } from './ops';

/** An attach point: where a wire can end. */
export interface Attach { end: EndRef; pos: Vec }

/** Keyboard cursor steps: one grid unit, or five with Shift. */
export const KEY_STEP = 1, KEY_STEP_BIG = 5;

/** The cursor after an arrow key (grid points only: parts and ports sit on the grid). */
export function stepCursor(p: Vec, key: string, big: boolean): Vec {
  const n = big ? KEY_STEP_BIG : KEY_STEP;
  return key === 'ArrowLeft' ? [p[0] - n, p[1]] : key === 'ArrowRight' ? [p[0] + n, p[1]] : key === 'ArrowUp' ? [p[0], p[1] - n] : [p[0], p[1] + n];
}

/** Every place a wire can end, in reading order along the signal flow (left to right, then top to bottom). */
export function targetsOf(doc: ChipDoc, defOf: DefOf): Attach[] {
  return attachPoints(doc, defOf).map((a) => ({ end: a.end, pos: a.pos }))
    .sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1] || (endKey(a.end) < endKey(b.end) ? -1 : 1));
}

/** The attach points of the one part, pin or pointer selected (in the part's port order); empty for any other selection. */
export function ownPorts(doc: ChipDoc, defOf: DefOf, sel: Sel): Attach[] {
  const count = (sel.parts?.length ?? 0) + (sel.pins?.length ?? 0) + (sel.labels?.length ?? 0) + (sel.wires?.length ?? 0) + (sel.comments?.length ?? 0);
  if (count !== 1) return [];
  const all = attachPoints(doc, defOf).map((a) => ({ end: a.end, pos: a.pos }));
  if (sel.parts?.length) return all.filter((a) => 'part' in a.end && a.end.part === sel.parts![0]);
  if (sel.pins?.length) return all.filter((a) => 'pin' in a.end && a.end.pin === sel.pins![0]);
  if (sel.labels?.length) return all.filter((a) => 'label' in a.end && a.end.label === sel.labels![0]);
  return [];
}

/**
 * The next (dir 1) or previous (-1) of `list` after the one at `from`, wrapping round; the first / last when
 * `from` is on none of them. `skip`: an end that never counts (the pin a wire started from).
 */
export function cycle(list: readonly Attach[], from: Vec | null, dir: 1 | -1, skip?: EndRef): Attach | null {
  const l = skip ? list.filter((a) => endKey(a.end) !== endKey(skip)) : list;
  if (!l.length) return null;
  const i = from ? l.findIndex((a) => a.pos[0] === from[0] && a.pos[1] === from[1]) : -1;
  if (i >= 0) return l[(i + dir + l.length) % l.length];
  if (!from) return dir > 0 ? l[0] : l[l.length - 1];
  // not on a pin: the first one after (before) the point in reading order
  const ahead = (a: Attach) => a.pos[0] > from[0] || (a.pos[0] === from[0] && a.pos[1] > from[1]);
  if (dir > 0) return l.find(ahead) ?? l[0];
  for (let k = l.length - 1; k >= 0; k--) if (!ahead(l[k]) && !(l[k].pos[0] === from[0] && l[k].pos[1] === from[1])) return l[k];
  return l[l.length - 1];
}

/** "nand1 pin a (input)", "pin clk (input)", "pointer bus": a wire end in words. */
export function endName(doc: ChipDoc, defOf: DefOf, e: EndRef): string {
  if ('part' in e) {
    const p = doc.parts.find((q) => q.id === e.part);
    const d = p && defOf(p);
    const port = d?.ports.find((q) => q.name === e.port);
    return `${p?.label ?? e.part} pin ${e.port}${port ? ` (${port.dir === 'in' ? 'input' : port.dir === 'out' ? 'output' : 'bidirectional'})` : ''}`;
  }
  if ('pin' in e) {
    const p = doc.pins.find((q) => q.id === e.pin);
    return p ? `${p.dir === 'in' ? 'input' : p.dir === 'out' ? 'output' : 'bidirectional'} pin ${p.name}` : 'pin';
  }
  if ('label' in e) return `pointer ${doc.labels.find((l) => l.id === e.label)?.name ?? ''}`.trim();
  return 'a wire';
}

/** What is under the cursor, in words (null: nothing). */
export function hitName(doc: ChipDoc, defOf: DefOf, h: Hit): string | null {
  switch (h.k) {
    case 'port': return endName(doc, defOf, h.end);
    case 'pin': return endName(doc, defOf, { pin: h.id });
    case 'label': return endName(doc, defOf, { label: h.id });
    case 'part': {
      const p = doc.parts.find((q) => q.id === h.id);
      const d = p && defOf(p);
      return p ? `${p.label ?? p.id}${d ? ` (${d.name})` : ''}` : null;
    }
    case 'wire': return 'a wire';
    case 'comment': return 'a comment';
    default: return null;
  }
}
