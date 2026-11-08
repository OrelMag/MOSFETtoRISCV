// Labels over a 3D view kept apart and inside the frame (every model's `.r3-lbl`: a dot at the anchor, its text `b`
// beside it on side l / r / t / b). Projected anchors can land close together, above all on a phone, where two texts
// then read as one ("NO common"), or near an edge, where a text is cut ("pper" for hopper). After each frame's
// placement: a side text that would leave the frame goes to the other side of its dot, a text above or below its dot
// slides back in; then the texts are laid down in order, main labels before minor ones, and one that would come
// within `gap` px of a text already down, or cover another label's dot, moves a few px (the dot stays on its part).
// One that finds no clear spot within MAX px is hidden (class `crowd`).
// With hysteresis, so a running model (the relay playing, the reader feeding) does not make labels jump or blink: a
// label keeps its spot while that spot is clear and goes back nearer its dot only after HOLD frames; it hides only after
// HOLD frames without a spot and shows again only after HOLD frames with one; a flipped side holds until the text
// would sit UNFLIP px inside the frame on its own side.

const MAX = 16;
/** Offsets tried, nearest first: vertical moves read best (a text moved sideways drifts off its dot). */
const MOVES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [[0, 0]];
  for (let d = 4; d <= MAX; d += 4) out.push([0, -d], [0, d]);
  for (const dx of [-8, 8]) for (let d = 0; d <= MAX; d += 4) out.push([dx, -d], ...(d ? [[dx, d] as [number, number]] : []));
  return out;
})();
/** Frames a change must hold before a label hides, shows again, or goes back nearer its dot. */
const HOLD = 8;
/** How far inside the frame an unflipped text must be before a flipped label goes back to its own side. */
const UNFLIP = 12;

interface Box { l: number; t: number; r: number; b: number }
/** What a label chose in the frames before. */
interface Memo { flip: boolean; move: readonly [number, number]; miss: number; fit: number; closer: number; crowd: boolean }

const near = (a: Box, b: Box, gx: number, gy: number) => a.l < b.r + gx && b.l < a.r + gx && a.t < b.b + gy && b.t < a.b + gy;
const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
const shift = (t: Box, [dx, dy]: readonly [number, number]): Box => ({ l: t.l + dx, t: t.t + dy, r: t.r + dx, b: t.b + dy });
const dist = ([dx, dy]: readonly [number, number]) => Math.abs(dx) + Math.abs(dy);
const SIDES = ['l', 'r', 't', 'b'] as const;
const memos = new WeakMap<HTMLElement, Memo>();

export function declutterLabels(els: readonly HTMLElement[], gap = 5): void {
  const live: HTMLElement[] = [];
  for (const e of els) {
    // the side the author chose, restored before this frame's checks (the flip is decided again below)
    const side = (e.dataset.side ??= SIDES.find((s) => e.classList.contains(s)) ?? '');
    for (const s of SIDES) e.classList.toggle(s, s === side);
    const t = e.querySelector<HTMLElement>('b');
    if (t) t.style.translate = '';
    if (e.style.display !== 'none' && t && t.offsetParent !== null) live.push(e);
    else e.classList.remove('crowd');
  }
  if (!live.length) return;
  const frame = box(live[0].offsetParent ?? live[0].parentElement!);
  const memo = (e: HTMLElement): Memo => {
    let m = memos.get(e);
    if (!m) memos.set(e, (m = { flip: false, move: [0, 0], miss: 0, fit: 0, closer: 0, crowd: false }));
    return m;
  };
  const base = live.map(() => 0);
  const texts = live.map((e, k) => {
    const b = e.querySelector('b')!, m = memo(e), side = e.dataset.side;
    let t = box(b);
    if (side === 'l' || side === 'r') {
      const out = t.l < frame.l + 2 || t.r > frame.r - 2, deepIn = t.l > frame.l + UNFLIP && t.r < frame.r - UNFLIP;
      m.flip = m.flip ? !deepIn : out;
      if (m.flip) { e.classList.replace(side, side === 'l' ? 'r' : 'l'); t = box(b); }
    }
    // still out (a centred text, or a flip that did not help): slide it in
    base[k] = t.l < frame.l + 2 ? frame.l + 2 - t.l : t.r > frame.r - 2 ? frame.r - 2 - t.r : 0;
    return shift(t, [base[k], 0]);
  });
  const dots = live.map((e) => box(e.querySelector('i') ?? e));
  const order = live.map((_, k) => k).sort((a, b) => Number(live[a].classList.contains('minor')) - Number(live[b].classList.contains('minor')) || a - b);
  const down: Box[] = [];
  for (const k of order) {
    const t = texts[k], e = live[k], m = memo(e);
    const clear = (mv: readonly [number, number]) => {
      const b = shift(t, mv);
      return !down.some((d) => near(b, d, gap, 1)) && !dots.some((d, j) => j !== k && near(b, d, 1, 1));
    };
    let move = MOVES.find(clear) ?? null;
    // the spot it had keeps it while that spot is clear; a nearer one takes over only after HOLD frames
    if (move && clear(m.move) && dist(move) < dist(m.move)) {
      if (++m.closer < HOLD) move = m.move;
    } else m.closer = 0;
    if (move && move !== m.move && clear(m.move) && dist(move) >= dist(m.move)) move = m.move;
    if (move) { m.fit++; m.miss = 0; } else { m.miss++; m.fit = 0; }
    if (m.crowd ? m.fit >= HOLD : m.miss >= HOLD) m.crowd = !m.crowd;
    e.classList.toggle('crowd', m.crowd);
    if (m.crowd) continue;
    // no clear spot yet, but not hidden either: it stays where it was until HOLD frames say otherwise
    m.move = move ?? m.move;
    const x = base[k] + m.move[0], y = m.move[1];
    if (x || y) e.querySelector<HTMLElement>('b')!.style.translate = `${x.toFixed(1)}px ${y}px`;
    down.push(shift(t, m.move));
  }
}
