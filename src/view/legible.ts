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
  tiny: 0.75, rail: 0.85, port: 0.8, label: LABEL_UNITS, iname: 0.78, pin: 0.95, tag: 0.8, bus: 0.82, level: 0.8, flow: 0.78,
  tap3: 0.3, tap4: 0.4, tap5: 0.5, tap6: 0.6, tap7: 0.7, tap8: 0.8,
};

/** Which text kinds are too small at `scale` px per grid unit to be drawn (under MIN_TEXT_PX). */
export function hiddenKinds(scale: number): string[] {
  return Object.entries(TEXT_UNITS).filter(([, u]) => u * scale < MIN_TEXT_PX).map(([k]) => k);
}

/** Does a block's label render under NAME_PX at this scale (so its name is drawn at a fixed size)? */
export const needsFixedNames = (scale: number): boolean => scale > 0 && LABEL_UNITS * scale < NAME_PX;

/** A block that may carry a fixed-size name: grid units. */
export interface NameBox { cx: number; cy: number; w: number; h: number; chars: number; rot: boolean }

/** Is this block's label worth a fixed name? Not: no label, one character (a constant, a bit), a small box. */
export function nameEligible(label: string | null | undefined, w: number, h: number): boolean {
  return !!label && label.trim().length >= 2 && !/^[01]$/.test(label.trim()) && (w >= 6 || h >= 20);
}

/** A tall narrow block (a pipeline register) gets its name turned. */
export const nameRotated = (w: number, h: number): boolean => h > w * 3;

/** The screen rectangle (px, from the block's centre) a fixed name takes. */
function nameSize(b: NameBox): { w: number; h: number } {
  const w = b.chars * NAME_PX * 0.6 + 4, h = NAME_PX * 1.25;
  return b.rot ? { w: h, h: w } : { w, h };
}

/**
 * Which names are drawn at `scale` px per grid unit: none once labels render at NAME_PX themselves; else those whose block
 * is at least `minBlockPx` long and whose text does not overlap a name kept before it, blocks taken from the largest.
 * Pure: `boxes` in any order, the answer by index.
 */
export function planNames(boxes: NameBox[], scale: number, minBlockPx = 10): boolean[] {
  const out = boxes.map(() => false);
  if (!needsFixedNames(scale)) return out;
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].w * boxes[b].h - boxes[a].w * boxes[a].h || a - b);
  const kept: { l: number; r: number; t: number; b: number }[] = [];
  for (const i of order) {
    const b = boxes[i];
    if (Math.max(b.w, b.h) * scale < minBlockPx) continue;
    const { w, h } = nameSize(b);
    const hw = w / 2 / scale, hh = h / 2 / scale;
    const r = { l: b.cx - hw, r: b.cx + hw, t: b.cy - hh, b: b.cy + hh };
    if (kept.some((k) => r.l < k.r && r.r > k.l && r.t < k.b && r.b > k.t)) continue;
    kept.push(r);
    out[i] = true;
  }
  return out;
}

export interface NameEl { t: SVGTextElement; box: NameBox }

/** The rule applied to one schematic svg: classes for the text kinds, the fixed names. */
export class Legibility {
  private hidden = new Set<string>();
  private names: NameEl[] = [];
  private on: boolean[] = [];
  private shown: SVGTextElement[] = [];
  private scale = 0;
  private planScale = 0;
  private timer = 0;
  private fontScale = 0;
  /** Planning runs this long after the scale stopped changing (ms). */
  settleMs = 90;

  constructor(private svg: SVGSVGElement) { svg.classList.add('lg'); }

  /** The blocks that may carry a fixed name (a new drawing replaces them all). */
  setNames(names: NameEl[]): void {
    clearTimeout(this.timer);
    this.names = names;
    this.on = names.map(() => false);
    this.shown = [];
    this.planScale = 0;
    this.fontScale = 0;
  }

  /** Told after every camera apply, with the scale in px per grid unit (0: not laid out yet). */
  view(scale: number): void {
    if (!(scale > 0)) return;
    this.scale = scale;
    const hide = new Set(hiddenKinds(scale));
    for (const k of this.hidden) if (!hide.has(k)) this.svg.classList.remove('lg-h-' + k);
    for (const k of hide) if (!this.hidden.has(k)) this.svg.classList.add('lg-h-' + k);
    this.hidden = hide;
    const fixed = needsFixedNames(scale);
    this.svg.classList.toggle('lg-nm', fixed && this.names.length > 0);
    if (!this.names.length) return;
    if (this.planScale === 0 || !fixed) this.plan();
    else if (Math.abs(scale / this.planScale - 1) > 0.02) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.plan(), this.settleMs);
    }
    this.size();
  }

  /** The names' font follows the scale every frame (a handful of attributes: only the drawn ones). */
  private size(): void {
    if (!this.shown.length || Math.abs(this.scale / this.fontScale - 1) < 0.002) return;
    this.fontScale = this.scale;
    const fs = String(NAME_PX / this.scale), sw = String(3 / this.scale);
    for (const t of this.shown) { t.setAttribute('font-size', fs); t.setAttribute('stroke-width', sw); }
  }

  private plan(): void {
    this.planScale = this.scale;
    const next = planNames(this.names.map((n) => n.box), this.scale);
    this.shown = [];
    next.forEach((v, i) => {
      if (v !== this.on[i]) this.names[i].t.style.display = v ? 'inline' : '';
      if (v) this.shown.push(this.names[i].t);
    });
    this.on = next;
    this.fontScale = 0;
    this.size();
  }
}
