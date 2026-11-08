// Readable schematics at any zoom: a view rule over the drawn circuit, never part of it (the simulation, netlists,
// routing, Verilog and exported images know nothing of it).
//
//  1. Text drawn in grid units is a few pixels at a CPU's fitted view. Every kind of text is hidden once it would render
//     under MIN_TEXT_PX on screen (classes on the svg, toggled when the scale crosses a size: one CSS rule per kind).
//  2. A block's name (box label) that would render under NAME_PX is drawn at a fixed NAME_PX on screen, centred on its
//     block (a second text inside the instance group, so focus fading, dragging, heat and hit testing apply to it as to
//     the block). Names that would collide are dropped, the larger block keeping its name. The plan is computed when
//     the scale settles, from the blocks' sizes alone: no layout reads.

/** Smallest text (px on screen) any schematic text is drawn at. */
export const MIN_TEXT_PX = 7;
/** Size (px) of a block name drawn at a fixed size; a label whose own size reaches it is drawn as usual. */
export const NAME_PX = 12;
/** A block label's font size in grid units (styles/app.css .sym-label). */
export const LABEL_UNITS = 1.05;

/** Text kinds hidden by size: class suffix → font size in grid units (styles/app.css). `tapN` is a tap label of N/10. */
export const TEXT_UNITS: Record<string, number> = {
  tiny: 0.75, rail: 0.85, port: 0.8, label: LABEL_UNITS, iname: 0.78, pin: 0.95, tag: 0.8, bus: 0.82, level: 0.8, flow: 0.78, probe: 0.78, note: 0.95,
  tap3: 0.3, tap4: 0.4, tap5: 0.5, tap6: 0.6, tap7: 0.7, tap8: 0.8,
};

/** Which text kinds are too small at `scale` px per grid unit to be drawn (under MIN_TEXT_PX). */
export function hiddenKinds(scale: number): string[] {
  return Object.entries(TEXT_UNITS).filter(([, u]) => u * scale < MIN_TEXT_PX).map(([k]) => k);
}

/** Does a block's label render under NAME_PX at this scale (so its name is drawn at a fixed size)? */
export const needsFixedNames = (scale: number): boolean => scale > 0 && LABEL_UNITS * scale < NAME_PX;

/** Smallest size (px) a name is shrunk to so that it sits inside its block; below it the name is wrapped, then (a block too small
 *  for any size) drawn at MIN_TEXT_PX over the block's edge rather than dropped. */
export const NAME_MIN_PX = 6;
/** Advance per character of a block name (bold capitals), in em, and the line height. */
const NAME_EM = 0.68, NAME_LINE = 1.25;
/** Room kept inside a block's edge (px): the name's outline. */
const NAME_PAD = 4;

/** A block that may carry a fixed-size name: grid units. `text` (else `chars` letters) is what is drawn. */
export interface NameBox { cx: number; cy: number; w: number; h: number; chars: number; rot: boolean; text?: string }

/** Is this block's label worth a fixed name? Not: no label, one character (a constant, a bit), a small box. */
export function nameEligible(label: string | null | undefined, w: number, h: number): boolean {
  const t = label?.trim() ?? '';
  // not an assignment or a constant drawn as a box ("bit0 := 0", "x0 = 0", "0x0"): those sit on their own stubs;
  // a comparison of two names ("wa = ra1") is a name like any other
  return t.length >= 2 && !/^[01]$/.test(t) && !/:=|=\s*(0x[\da-f]+|[\d.]+)$|^0x|^[\d.]+$/i.test(t) && /[A-Za-z].*[A-Za-z]/.test(t) && (w >= 6 || h >= 20);
}

/** A tall narrow block (a pipeline register) gets its name turned. */
export const nameRotated = (w: number, h: number): boolean => h > w * 3;

/** How a name is drawn: font size (px on screen) and its lines (one, or two broken at a space, a slash or an ampersand). */
export interface NameLayout { px: number; lines: string[] }

/** The ways to put a name on one or two lines: whole, or broken after a space or a slash, the most even split first. */
export function nameBreaks(text: string): string[][] {
  const out: string[][] = [[text]];
  const cuts: number[] = [];
  for (let i = 1; i < text.length; i++) {
    if ((text[i - 1] === ' ' || text[i - 1] === '/') && text[i] !== '&') cuts.push(i);
  }
  const lines = cuts.map((i) => [text.slice(0, i).trim(), text.slice(i).trim()]).filter((l) => l[0] && l[1]);
  lines.sort((a, b) => Math.max(a[0].length, a[1].length) - Math.max(b[0].length, b[1].length));
  return out.concat(lines.slice(0, 3));
}

/**
 * The layout of a block's name at `scale`: the largest font up to NAME_PX at which one line, or two, fits inside the block
 * (a turned name along its length only: it is meant to span a narrow register); a name no size fits is cut short with an ellipsis at
 * MIN_TEXT_PX; a block too small even for three letters keeps its name at MIN_TEXT_PX over the edge, never lost. The block's size alone decides it.
 */
export function nameLayout(b: NameBox, scale: number): NameLayout {
  const text = b.text ?? 'x'.repeat(b.chars);
  const along = (b.rot ? b.h : b.w) * scale - NAME_PAD, across = (b.rot ? b.w : b.h) * scale - 2;
  let best: NameLayout | null = null;
  for (const lines of b.rot ? [[text]] : nameBreaks(text)) {
    const chars = Math.max(...lines.map((l) => l.length));
    let px = Math.min(NAME_PX, along / (chars * NAME_EM));
    if (!b.rot) px = Math.min(px, across / (lines.length * NAME_LINE));
    if (!best || px > best.px + 0.01) best = { px, lines };
  }
  if (best!.px >= NAME_MIN_PX) return best!;
  // no layout reaches the floor: cut the name short, at MIN_TEXT_PX, where one line of that size fits the block
  const n = Math.floor(along / (MIN_TEXT_PX * NAME_EM));
  if (!b.rot && n >= 3 && n < text.length && across >= MIN_TEXT_PX * NAME_LINE) return { px: MIN_TEXT_PX, lines: [text.slice(0, n - 1).trimEnd() + '…'] };
  return { px: MIN_TEXT_PX, lines: nameBreaks(text).reduce((a, l) => (Math.max(...l.map((x) => x.length)) < Math.max(...a.map((x) => x.length)) ? l : a), [text]) };
}

/** The screen rectangle (px, from the block's centre) a fixed name takes. */
function nameSize(b: NameBox, l: NameLayout): { w: number; h: number } {
  const w = Math.max(...l.lines.map((x) => x.length)) * l.px * NAME_EM + 6, h = l.px * NAME_LINE * l.lines.length;
  return b.rot ? { w: h, h: w } : { w, h };
}

/**
 * Which names are drawn at `scale` px per grid unit: none once labels render at NAME_PX themselves; else those whose block
 * is at least `minBlockPx` long and whose text does not overlap a name kept before it, blocks taken from the largest.
 * Pure: `boxes` in any order, the answer by index.
 */
export function planNames(boxes: NameBox[], scale: number, minBlockPx = 10): boolean[] {
  return planLayouts(boxes, scale, minBlockPx).map((l) => l !== null);
}

/** planNames with how each kept name is drawn (null: no name). */
export function planLayouts(boxes: NameBox[], scale: number, minBlockPx = 10): (NameLayout | null)[] {
  const out: (NameLayout | null)[] = boxes.map(() => null);
  if (!needsFixedNames(scale)) return out;
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].w * boxes[b].h - boxes[a].w * boxes[a].h || a - b);
  const kept: { l: number; r: number; t: number; b: number }[] = [];
  for (const i of order) {
    const b = boxes[i];
    if (Math.max(b.w, b.h) * scale < minBlockPx) continue;
    const lay = nameLayout(b, scale);
    const { w, h } = nameSize(b, lay);
    const hw = w / 2 / scale, hh = h / 2 / scale;
    const r = { l: b.cx - hw, r: b.cx + hw, t: b.cy - hh, b: b.cy + hh };
    if (kept.some((k) => r.l < k.r && r.r > k.l && r.t < k.b && r.b > k.t)) continue;
    kept.push(r);
    out[i] = lay;
  }
  return out;
}

/** Largest factor a net tag is enlarged by to reach MIN_TEXT_PX; a tag needing more stays a dot (a CPU's fit). */
export const TAG_MAX_K = 2.5;
const SM = { x: 0, y: 0, w: 0, h: 0 };
type R = typeof SM;
const clash = (a: R, b: R, m = 0.1) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/**
 * Which net tags are drawn enlarged about their tip at `scale` px per grid unit, and by what factor (null: left as is, a dot
 * once its text is under MIN_TEXT_PX). A tag is enlarged to put its text at MIN_TEXT_PX, kept only while the enlarged pill
 * overlaps neither a block (`obstacles`) nor a tag kept before it, so an enlarged tag never covers more than a plain one.
 */
export function planTags(tags: { tip: [number, number]; rect: R }[], obstacles: R[], scale: number): (number | null)[] {
  const k = MIN_TEXT_PX / (TEXT_UNITS.tag * scale);
  const out: (number | null)[] = tags.map(() => null);
  if (!(scale > 0) || k <= 1 || k > TAG_MAX_K) return out;
  const kept: R[] = [];
  tags.forEach((t, i) => {
    const r = t.rect;
    const e = { x: t.tip[0] + (r.x - t.tip[0]) * k, y: t.tip[1] + (r.y - t.tip[1]) * k, w: r.w * k, h: r.h * k };
    if (obstacles.some((o) => clash(e, o, 0)) || kept.some((o) => clash(e, o))) return;
    kept.push(e);
    out[i] = k;
  });
  return out;
}

export interface TagEl { g: SVGGElement; tip: [number, number]; rect: R }

export interface NameEl { t: SVGTextElement; box: NameBox }

/** The rule applied to one schematic svg: classes for the text kinds, the fixed names. */
export class Legibility {
  private hidden = new Set<string>();
  private names: NameEl[] = [];
  private on: boolean[] = [];
  private shown: { t: SVGTextElement; l: NameLayout }[] = [];
  private scale = 0;
  private planScale = 0;
  private timer = 0;
  private fontScale = 0;
  private wasFixed = false;
  private lastPlan = -1e9;
  private tags: TagEl[] = [];
  private tagBlocks: R[] = [];
  private tagK: (number | null)[] = [];
  private tagScale = 0;
  /** Planning runs this long after the scale stopped changing (ms). */
  settleMs = 60;

  constructor(private svg: SVGSVGElement) { svg.classList.add('lg'); }

  /** The blocks that may carry a fixed name (a new drawing replaces them all). */
  setNames(names: NameEl[]): void {
    clearTimeout(this.timer);
    this.names = names;
    this.on = names.map(() => false);
    this.shown = [];
    this.planScale = 0;
    this.fontScale = 0;
    this.wasFixed = false;
  }

  /** The net tags that may be enlarged (legible.ts planTags), and the blocks they must not cover. */
  setTags(tags: TagEl[], blocks: R[]): void {
    this.tags = tags;
    this.tagBlocks = blocks;
    this.tagK = tags.map(() => null);
    this.tagScale = 0;
  }

  private planTagSizes(): void {
    this.tagScale = this.scale;
    const next = planTags(this.tags, this.tagBlocks, this.scale);
    next.forEach((k, i) => {
      if (k === this.tagK[i] && k === null) return;
      const g = this.tags[i].g, [x, y] = this.tags[i].tip;
      g.classList.toggle('lg-tg', k !== null);
      for (const el of g.querySelectorAll('rect, text')) {
        if (k === null) el.removeAttribute('transform');
        else el.setAttribute('transform', `translate(${x} ${y}) scale(${k.toFixed(3)}) translate(${-x} ${-y})`);
      }
    });
    this.tagK = next;
  }

  /** Told after every camera apply, with the scale in px per grid unit (0: not laid out yet). */
  view(scale: number): void {
    if (!(scale > 0)) return;
    this.scale = scale;
    const hide = new Set(hiddenKinds(scale));
    for (const k of this.hidden) if (!hide.has(k)) this.svg.classList.remove('lg-h-' + k);
    for (const k of hide) if (!this.hidden.has(k)) this.svg.classList.add('lg-h-' + k);
    this.hidden = hide;
    if (this.tags.length && Math.abs(scale / this.tagScale - 1) > 0.01) this.planTagSizes();
    const fixed = needsFixedNames(scale);
    this.svg.classList.toggle('lg-nm', fixed && this.names.length > 0);
    if (!this.names.length) return;
    if (this.planScale === 0 || fixed !== this.wasFixed) { this.wasFixed = fixed; this.plan(); }
    else if (fixed && Math.abs(scale / this.planScale - 1) > 0.02) {
      // at once when the last plan is not recent (a resize, a click on zoom), else after the burst (a wheel turning): a
      // plan for a scale the view has left would let names overlap
      if (performance.now() - this.lastPlan >= this.settleMs) this.plan();
      else {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.plan(), this.settleMs);
      }
    }
    this.size();
  }

  /** The names' font follows the scale every frame (a handful of attributes: only the drawn ones). */
  private size(): void {
    if (!this.shown.length || Math.abs(this.scale / this.fontScale - 1) < 0.002) return;
    this.fontScale = this.scale;
    for (const { t, l } of this.shown) {
      t.setAttribute('font-size', String(l.px / this.scale));
      t.setAttribute('stroke-width', String(Math.min(2.6, l.px * 0.22) / this.scale));
    }
  }

  /** A name on two lines is two tspans (centred on the block, em offsets so the font size alone scales it); one line is plain text. */
  private lines(t: SVGTextElement, l: NameLayout): void {
    const key = l.lines.join('|');
    if (t.dataset.ln === key) return;
    t.dataset.ln = key;
    if (l.lines.length === 1) { t.textContent = l.lines[0]; return; }
    t.textContent = '';
    const x = t.getAttribute('x') ?? '0';
    l.lines.forEach((line, i) => {
      const ts = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      ts.setAttribute('x', x);
      ts.setAttribute('dy', String(i === 0 ? -(l.lines.length - 1) * NAME_LINE / 2 : NAME_LINE) + 'em');
      ts.textContent = line;
      t.append(ts);
    });
  }

  private plan(): void {
    clearTimeout(this.timer);
    this.lastPlan = performance.now();
    this.planScale = this.scale;
    const next = planLayouts(this.names.map((n) => n.box), this.scale);
    this.shown = [];
    next.forEach((l, i) => {
      const v = l !== null, t = this.names[i].t;
      if (v !== this.on[i]) t.style.display = v ? 'inline' : '';
      if (l) { this.lines(t, l); this.shown.push({ t, l }); }
    });
    this.on = next.map((l) => l !== null);
    this.fontScale = 0;
    this.size();
  }
}
