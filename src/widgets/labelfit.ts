// Labels over a 3D view kept apart and inside the frame (every model's `.r3-lbl`: a dot at the anchor, its text `b`
// beside it on side l / r / t / b). Projected anchors can land close together, above all on a phone, where two texts
// then read as one ("NO common"), or near an edge, where a text is cut ("pper" for hopper) or lost off the top or bottom.
// After each frame's placement: a text that would leave the frame goes to the other side of its dot (l ↔ r, t ↔ b), and
// one still out slides back in, on either axis; then the texts are laid down in priority order (main labels before
// minor ones, then each label's priority, by default the order the model declares them), and one that would come within
// `gap` px of a text already down, cover another label's dot, or leave the frame moves a few px (the dot stays on its
// part). One that finds no clear spot within MAX px is hidden (class `crowd`), as is one whose dot is outside the frame
// or whose text would have to slide more than SLIDE px from it: the lower priority gives way, never an overlap.
// With hysteresis, so a running model (the relay playing, the reader feeding) does not make labels jump or blink: a
// label keeps its spot while that spot is clear and goes back nearer its dot only after HOLD frames; it hides only after
// HOLD frames without a spot and shows again only after HOLD frames with one; a flipped side holds until the text
// would sit UNFLIP px inside the frame on its own side. A model draws frames only on demand, so while any of those
// counts is under way this runs again on the next animation frames by itself; and a label seen for the first time is
// placed or hidden at once (nothing to keep steady yet).

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
/** The furthest a text slides back into the frame along its dot's line before it is hidden instead (it would lose its dot). */
const SLIDE = 28;
/** Inset of the frame a text must stay within. */
const EDGE = 2;

export interface Box { l: number; t: number; r: number; b: number }
/** What a label chose in the frames before. */
interface Memo { flip: boolean; move: readonly [number, number]; miss: number; fit: number; closer: number; crowd: boolean; seen: boolean }

export interface LabelOptions {
  /** Least space between two texts, px. */
  gap?: number;
  /** Each label's priority (lower is placed first); absent: its index. */
  prio?: readonly (number | undefined)[];
  /** Rectangles (client px) no text may cover and no dot may sit under; the stage's corner buttons (modelframe.ts
   *  .r3-tools) are added by themselves. */
  avoid?: readonly Box[];
}

const near = (a: Box, b: Box, gx: number, gy: number) => a.l < b.r + gx && b.l < a.r + gx && a.t < b.b + gy && b.t < a.b + gy;
const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
const shift = (t: Box, [dx, dy]: readonly [number, number]): Box => ({ l: t.l + dx, t: t.t + dy, r: t.r + dx, b: t.b + dy });
const dist = ([dx, dy]: readonly [number, number]) => Math.abs(dx) + Math.abs(dy);
const inside = (t: Box, f: Box) => t.l >= f.l + EDGE - 0.5 && t.r <= f.r - EDGE + 0.5 && t.t >= f.t + EDGE - 0.5 && t.b <= f.b - EDGE + 0.5;
const SIDES = ['l', 'r', 't', 'b'] as const;
const OPPOSITE: Record<string, string> = { l: 'r', r: 'l', t: 'b', b: 't' };
const memos = new WeakMap<HTMLElement, Memo>();
/** A re-run waiting for the next animation frame, per frame element. */
const reruns = new WeakMap<Element, number>();

/** How far a text must slide along one axis to sit inside [lo, hi] (0: it does). */
const slideIn = (a: number, b: number, lo: number, hi: number) => (a < lo ? lo - a : b > hi ? hi - b : 0);

export function declutterLabels(els: readonly HTMLElement[], opts: LabelOptions | number = {}): void {
  const o: LabelOptions = typeof opts === 'number' ? { gap: opts } : opts, gap = o.gap ?? 5;
  const live: HTMLElement[] = [], prioOf = new Map<HTMLElement, number>();
  els.forEach((e, i) => {
    // the side the author chose, restored before this frame's checks (the flip is decided again below)
    const side = (e.dataset.side ??= SIDES.find((s) => e.classList.contains(s)) ?? '');
    for (const s of SIDES) e.classList.toggle(s, s === side);
    const t = e.querySelector<HTMLElement>('b');
    if (t) t.style.translate = '';
    prioOf.set(e, o.prio?.[i] ?? i);
    if (e.style.display !== 'none' && t && t.offsetParent !== null) live.push(e);
    else e.classList.remove('crowd');
  });
  if (!live.length) return;
  const host = live[0].offsetParent ?? live[0].parentElement!, frame = box(host);
  const memo = (e: HTMLElement): Memo => {
    let m = memos.get(e);
    if (!m) memos.set(e, (m = { flip: false, move: [0, 0], miss: 0, fit: 0, closer: 0, crowd: false, seen: false }));
    return m;
  };
  // The stage's corner buttons (turn, save image, full screen) are off-limits like the frame's edge.
  const tools = host.closest('.r3-stage, .wt-stage')?.querySelector('.r3-tools'), avoid: Box[] = [...(o.avoid ?? [])];
  if (tools && tools.getBoundingClientRect().width) avoid.push(box(tools));
  const dots = live.map((e) => box(e.querySelector('i') ?? e));
  // A dot outside the frame (its part is off screen) or under the buttons: the label cannot point at it.
  const lost = dots.map((d) => {
    const x = (d.l + d.r) / 2, y = (d.t + d.b) / 2;
    return x < frame.l || x > frame.r || y < frame.t || y > frame.b || avoid.some((a) => x > a.l - 2 && x < a.r + 2 && y > a.t - 2 && y < a.b + 2);
  });
  const base: [number, number][] = live.map(() => [0, 0]);
  const texts = live.map((e, k) => {
    const b = e.querySelector('b')!, m = memo(e), side = e.dataset.side ?? '';
    let t = box(b);
    if (side) {
      const across = side === 'l' || side === 'r';
      const out = across ? t.l < frame.l + EDGE || t.r > frame.r - EDGE : t.t < frame.t + EDGE || t.b > frame.b - EDGE;
      // across, a flipped text waits until its own side is well inside (a running model's label would swap at every
      // frame); above or below, a text near the edge is common (a label over the top of a model), so it goes back as
      // soon as its own side fits
      const deepIn = across ? t.l > frame.l + UNFLIP && t.r < frame.r - UNFLIP : t.t > frame.t + EDGE + 2 && t.b < frame.b - EDGE - 2;
      const was = m.flip;
      m.flip = m.flip ? !deepIn : out;
      if (m.flip) {
        e.classList.replace(side, OPPOSITE[side]);
        const f = box(b);
        // a flip that leaves it just as far out is no flip
        const outF = across ? f.l < frame.l + EDGE || f.r > frame.r - EDGE : f.t < frame.t + EDGE || f.b > frame.b - EDGE;
        if (outF && out && !was) { e.classList.replace(OPPOSITE[side], side); m.flip = false; } else t = f;
      }
    }
    // still out (a centred text, or a flip that did not help): slide it in, on both axes
    base[k] = [slideIn(t.l, t.r, frame.l + EDGE, frame.r - EDGE), slideIn(t.t, t.b, frame.t + EDGE, frame.b - EDGE)];
    return shift(t, base[k]);
  });
  const prio = (k: number) => prioOf.get(live[k])!;
  const order = live.map((_, k) => k).sort((a, b) => Number(live[a].classList.contains('minor')) - Number(live[b].classList.contains('minor')) || prio(a) - prio(b) || a - b);
  const down: Box[] = [];
  let pending = false;
  for (const k of order) {
    const t = texts[k], e = live[k], m = memo(e);
    const hopeless = lost[k] || dist(base[k]) > SLIDE;
    const clear = (mv: readonly [number, number]) => {
      if (hopeless) return false;
      const b = shift(t, mv);
      return inside(b, frame) && !down.some((d) => near(b, d, gap, 1)) && !dots.some((d, j) => j !== k && near(b, d, 1, 1)) && !avoid.some((a) => near(b, a, 3, 3));
    };
    let move = MOVES.find(clear) ?? null;
    if (!m.seen) {
      // first sight: nothing on screen to keep steady, so decide now
      m.seen = true; m.crowd = !move; m.move = move ?? [0, 0]; m.fit = m.miss = m.closer = 0;
    } else {
      // the spot it had keeps it while that spot is clear; a nearer one takes over only after HOLD frames
      if (move && clear(m.move) && dist(move) < dist(m.move)) {
        if (++m.closer < HOLD) move = m.move;
      } else m.closer = 0;
      if (move && move !== m.move && clear(m.move) && dist(move) >= dist(m.move)) move = m.move;
      if (move) { m.fit++; m.miss = 0; } else { m.miss++; m.fit = 0; }
      if (m.crowd ? m.fit >= HOLD : m.miss >= HOLD) { m.crowd = !m.crowd; m.fit = m.miss = 0; }
      if (m.crowd ? m.fit > 0 : m.miss > 0) pending = true;
      if (m.closer > 0 && m.closer < HOLD) pending = true;
    }
    e.classList.toggle('crowd', m.crowd);
    if (m.crowd) continue;
    // no clear spot yet, but not hidden either: it stays where it was until HOLD frames say otherwise
    m.move = move ?? m.move;
    const x = base[k][0] + m.move[0], y = base[k][1] + m.move[1];
    if (x || y) e.querySelector<HTMLElement>('b')!.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
    down.push(shift(t, m.move));
  }
  // A model draws only when something changes: finish the counts on animation frames of our own.
  const old = reruns.get(host);
  if (old !== undefined) cancelAnimationFrame(old);
  reruns.delete(host);
  if (pending && typeof requestAnimationFrame === 'function') {
    reruns.set(host, requestAnimationFrame(() => {
      reruns.delete(host);
      if (live[0].isConnected) declutterLabels(els, o);
    }));
  }
}
