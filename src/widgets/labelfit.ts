// Labels over a 3D view kept apart and inside the frame (every model's `.r3-lbl`: a dot at the anchor, its text `b`
// beside it on side l / r / t / b). Projected anchors can land close together, above all on a phone, where two texts
// then read as one ("NO common"), or near an edge, where a text is cut ("pper" for hopper). After each frame's
// placement: a side text that would leave the frame goes to the other side of its dot, a text above or below its dot
// slides back in; then the texts are laid down in order, main labels before minor ones, and one that would come
// within `gap` px of a text already down, or cover another label's dot, moves a few px (the dot stays on its part).
// One that finds no clear spot within MAX px is hidden for that frame (class `crowd`).

const MAX = 16;
/** Offsets tried, nearest first: vertical moves read best (a text moved sideways drifts off its dot). */
const MOVES: readonly [number, number][] = (() => {
  const out: [number, number][] = [[0, 0]];
  for (let d = 4; d <= MAX; d += 4) out.push([0, -d], [0, d]);
  for (const dx of [-8, 8]) for (let d = 0; d <= MAX; d += 4) out.push([dx, -d], ...(d ? [[dx, d] as [number, number]] : []));
  return out;
})();

interface Box { l: number; t: number; r: number; b: number }

const near = (a: Box, b: Box, gx: number, gy: number) => a.l < b.r + gx && b.l < a.r + gx && a.t < b.b + gy && b.t < a.b + gy;
const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
const SIDES = ['l', 'r', 't', 'b'] as const;

export function declutterLabels(els: readonly HTMLElement[], gap = 5): void {
  const live: HTMLElement[] = [];
  for (const e of els) {
    e.classList.remove('crowd');
    // the side the author chose, restored before this frame's checks (a flip below is per frame)
    const side = (e.dataset.side ??= SIDES.find((s) => e.classList.contains(s)) ?? '');
    for (const s of SIDES) e.classList.toggle(s, s === side);
    const t = e.querySelector<HTMLElement>('b');
    if (t) t.style.translate = '';
    if (e.style.display !== 'none' && t && t.offsetParent !== null) live.push(e);
  }
  if (!live.length) return;
  const frame = box(live[0].offsetParent ?? live[0].parentElement!);
  const base: [number, number][] = live.map(() => [0, 0]);
  const texts = live.map((e, k) => {
    const b = e.querySelector('b')!;
    let t = box(b);
    const side = e.dataset.side;
    if ((t.l < frame.l + 2 || t.r > frame.r - 2) && (side === 'l' || side === 'r')) {
      e.classList.replace(side, side === 'l' ? 'r' : 'l');
      t = box(b);
    }
    // still out (a centred text, or a flip that did not help): slide it in
    const dx = t.l < frame.l + 2 ? frame.l + 2 - t.l : t.r > frame.r - 2 ? frame.r - 2 - t.r : 0;
    base[k] = [dx, 0];
    return { l: t.l + dx, t: t.t, r: t.r + dx, b: t.b };
  });
  const dots = live.map((e) => box(e.querySelector('i') ?? e));
  const order = live.map((_, k) => k).sort((a, b) => Number(live[a].classList.contains('minor')) - Number(live[b].classList.contains('minor')) || a - b);
  const down: Box[] = [];
  for (const k of order) {
    const t = texts[k];
    const fits = ([dx, dy]: readonly [number, number]) => {
      const m = { l: t.l + dx, t: t.t + dy, r: t.r + dx, b: t.b + dy };
      return !down.some((d) => near(m, d, gap, 1)) && !dots.some((d, j) => j !== k && near(m, d, 1, 1)) ? m : null;
    };
    let placed: Box | null = null, move: readonly [number, number] = [0, 0];
    for (const mv of MOVES) if ((placed = fits(mv))) { move = mv; break; }
    if (!placed) { live[k].classList.add('crowd'); continue; }
    const x = base[k][0] + move[0], y = move[1];
    if (x || y) live[k].querySelector<HTMLElement>('b')!.style.translate = `${x.toFixed(1)}px ${y}px`;
    down.push(placed);
  }
}
