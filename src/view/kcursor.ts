// The stage's keyboard part cursor (DOM-free): which part or pin the arrow keys move to next. Items are boxes in grid
// units; a move goes to the nearest item whose centre lies in the pressed direction (within 60° either side of it),
// a sideways step counting twice a straight one, so ↓ from an adder picks the part below it, not a far one beside it.

export interface CursorItem {
  kind: 'inst' | 'pin';
  name: string;
  /** A pin's direction (an input can be toggled). */
  dir?: 'in' | 'out' | 'inout';
  x: number; y: number; w: number; h: number;
}

export type Dir = 'left' | 'right' | 'up' | 'down';
const VEC: Record<Dir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

const centre = (i: CursorItem): [number, number] => [i.x + i.w / 2, i.y + i.h / 2];

/** The item an arrow moves to from `from`, or null when nothing lies that way. */
export function nextInDir(items: readonly CursorItem[], from: CursorItem, dir: Dir): CursorItem | null {
  const [fx, fy] = centre(from), [dx, dy] = VEC[dir];
  let best: CursorItem | null = null, bs = Infinity;
  for (const it of items) {
    if (it === from || (it.kind === from.kind && it.name === from.name)) continue;
    const [cx, cy] = centre(it);
    const along = (cx - fx) * dx + (cy - fy) * dy, side = Math.abs((cx - fx) * dy - (cy - fy) * dx);
    if (along <= 0 || side > along * Math.tan(Math.PI / 3)) continue;
    const score = along + 2 * side;
    if (score < bs) [bs, best] = [score, it];
  }
  return best;
}

/** Reading order: top to bottom, then left to right (rows of 2 units), for Home / End and the first press. */
export function readingOrder(items: readonly CursorItem[]): CursorItem[] {
  return [...items].sort((a, b) => Math.round(centre(a)[1] / 2) - Math.round(centre(b)[1] / 2) || centre(a)[0] - centre(b)[0]);
}

/** Where the cursor starts: the first input pin, else the first item in reading order. */
export function firstItem(items: readonly CursorItem[], kind: 'in' | 'out' = 'in'): CursorItem | null {
  const order = readingOrder(items);
  return order.find((i) => i.kind === 'pin' && (kind === 'in' ? i.dir !== 'out' : i.dir === 'out')) ?? order[0] ?? null;
}
