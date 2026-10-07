// The sandbox canvas: a chip document drawn as SVG. Unlike SchematicView (which routes a
// netlist once and never changes it), every object here keeps one element that is updated in
// place, so dragging repaints only what moved. Wires are exactly what the user drew (model
// polylines), with the site's hops, junction dots and value colours, so a circuit looks the
// same here as in the inside view of the chip it becomes.

import { symbolGeom, type Vec } from '../sim/geometry';
import { B1, BX, BZ, type Bit, type ComponentDef } from '../sim/types';
import { formatBits, pack, type Radix } from '../sim/values';
import { s } from '../ui/dom';
import { Camera, type ViewBox } from '../view/camera';
import { junctions, type PinGeom, textWidth } from '../view/route';
import { bitClass, busClass } from '../view/schematic';
import { drawPinGlyph, drawSymbol, instNameAt, type PinGlyph, placePinValue } from '../view/symbols';
import type { Compiled, Diag } from './compile';
import { partBox, pinBody, pinKnob, pointerGeom, wireGroups } from './geom';
import { HopCache } from './hops';
import {
  type ChipDoc, COMMENT_LINE, type CommentDoc, commentBox, type DefOf, defaultFace, type DisplayKind, type LabelDoc, type PartDoc, type PinDoc, pinBig, polyline, type WireDoc,
} from './model';
import type { Sel } from './ops';
import { buzzerHz, LED_PITCH, ledGrid } from './parts';

/** Live values, read through the compile the simulator was built from (runtime.ts). */
export interface ViewValues {
  wireBits(id: string): Bit[] | null;
  endBits(key: string): Bit[] | null;
  labelBits(id: string): Bit[] | null;
  pinBits(name: string): Bit[] | null;
  conducting(part: string): number | undefined;
}

interface PartEls { doc: PartDoc; def: ComponentDef | undefined; g: SVGGElement; disp?: DisplayEls; cls: string }
interface DisplayEls {
  kind: DisplayKind; width: number; segs: SVGElement[]; shown: string;
  led?: SVGCircleElement; text?: SVGTextElement; halt?: SVGGElement; buzz?: SVGGElement;
  /** An LED bank: one LED per bit (index = bit). */
  leds?: SVGCircleElement[];
  /** A buzzer's tone now (Hz, 0 silent). */
  hz?: number;
}
interface WireEls { doc: WireDoc; poly: Vec[] | null; key: string; ver: number; path: SVGPathElement; hit: SVGPathElement; width: number; cls: string }
interface DotEls { el: SVGCircleElement; wire: string; cls: string }
interface PinEls { doc: PinDoc; g: SVGGElement; glyph: PinGlyph; geom: PinGeom; cls: string; txt: string }
interface LabelEls { doc: LabelDoc; g: SVGGElement; stub: SVGPathElement; cls: string }
interface CommentEls { doc: CommentDoc; g: SVGGElement }
interface BusLabel { net: number; wire: string; at: Vec; room: number; g: SVGGElement; bg: SVGRectElement; text: SVGTextElement; txt: string }

const pathD = (p: Vec[]) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
const valueClass = (bits: Bit[]) => (bits.length > 1 ? busClass(bits) : bitClass(bits[0]));

export class EditorView {
  readonly svg: SVGSVGElement;
  readonly cam: Camera;
  /** Drawn polyline of every wire (null: an end does not resolve). */
  readonly polys = new Map<string, Vec[]>();
  radix: Radix = 'hex';
  /** Where buzzer tones go (part id → Hz), after every repaint that changes them. */
  sound: ((tones: Map<string, number>) => void) | null = null;
  private toneKey = '';

  private gComments: SVGGElement;
  private gWires: SVGGElement;
  private gDots: SVGGElement;
  private gHits: SVGGElement;
  private gParts: SVGGElement;
  private gPins: SVGGElement;
  private gLabels: SVGGElement;
  private gValues: SVGGElement;
  private gOver: SVGGElement;
  private parts = new Map<string, PartEls>();
  private wires = new Map<string, WireEls>();
  private pins = new Map<string, PinEls>();
  private labels = new Map<string, LabelEls>();
  private comments = new Map<string, CommentEls>();
  private busLabels: BusLabel[] = [];
  /** Junction dots of each net group (keyed by its wires and their versions), coloured like the wire they sit on. */
  private dots = new Map<string, DotEls[]>();
  private hops = new HopCache();
  private groups: { wires: WireDoc[] | null; ids: string[][] } = { wires: null, ids: [] };
  private busLayout: { built: Compiled | null; version: number } = { built: null, version: -1 };
  private version = 0;
  private doc: ChipDoc | null = null;
  private sel: Sel = {};
  private diagCls = new Map<string, string>();
  private preview: SVGPathElement;
  private band: SVGRectElement;
  private hot: SVGCircleElement;
  private ghost: SVGGElement;

  constructor(host: HTMLElement) {
    this.svg = s('svg', { class: 'schematic ed-svg', role: 'application', 'aria-label': 'Circuit editor canvas' });
    const defs = s('defs');
    defs.innerHTML = `<pattern id="ed-grid" width="1" height="1" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="0.07" class="grid-dot"/></pattern>
      <pattern id="ed-grid5" width="5" height="5" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="0.12" class="grid-dot ed-grid-major"/></pattern>`;
    const L = (cls: string) => s('g', { class: cls });
    this.gComments = L('ed-notes');
    this.gWires = L('wires');
    this.gDots = L('ed-dots');
    this.gHits = L('wire-hits');
    this.gParts = L('insts');
    this.gPins = L('pins');
    this.gLabels = L('ed-ptrs');
    this.gValues = L('labels');
    this.gOver = L('ed-over');
    this.preview = s('path', { class: 'ed-preview', d: '' });
    this.band = s('rect', { class: 'ed-band', width: 0, height: 0, display: 'none' });
    this.hot = s('circle', { class: 'ed-hot', r: 0.42, display: 'none' });
    this.ghost = s('g', { class: 'ed-ghost' });
    this.gOver.append(this.ghost, this.preview, this.band, this.hot);
    this.svg.append(defs,
      s('rect', { class: 'grid-bg', x: -5000, y: -5000, width: 10000, height: 10000, fill: 'url(#ed-grid)' }),
      s('rect', { class: 'grid-bg', x: -5000, y: -5000, width: 10000, height: 10000, fill: 'url(#ed-grid5)' }),
      this.gComments, this.gWires, this.gDots, this.gHits, this.gParts, this.gPins, this.gLabels, this.gValues, this.gOver);
    host.append(this.svg);
    this.cam = new Camera(this.svg, host);
    this.cam.vb = { x: -4, y: -4, w: 60, h: 36 };
    this.cam.apply();
  }

  /** Grid units per screen pixel (hit tolerances are given in pixels). */
  px(n: number): number {
    return n * this.cam.scale();
  }

  // ---- document → elements ----------------------------------------------------------------

  /** Bring the drawing up to date with `doc`; unchanged objects (same identity) are skipped. */
  render(doc: ChipDoc, defOf: DefOf): void {
    const prev = this.doc;
    this.doc = doc;
    const geomChanged = !prev || prev.parts !== doc.parts || prev.pins !== doc.pins || prev.labels !== doc.labels;
    // Objects that moved or changed: only the wires ending on them need a new polyline.
    const dirty = new Set<string>();

    // Parts
    const seenParts = new Set<string>();
    for (const p of doc.parts) {
      seenParts.add(p.id);
      const def = defOf(p);
      const e = this.parts.get(p.id);
      if (e && e.doc === p && e.def === def) continue;
      dirty.add(`p:${p.id}`);
      if (e && e.def === def && e.doc.ref === p.ref && !!e.doc.flip === !!p.flip && e.doc.label === p.label) {
        e.g.setAttribute('transform', `translate(${p.at[0]},${p.at[1]})`);
        e.doc = p;
        continue;
      }
      const { g, disp } = this.drawPart(p, def);
      if (e) e.g.replaceWith(g);
      else this.gParts.append(g);
      this.parts.set(p.id, { doc: p, def, g, cls: '', disp });
    }
    for (const [id, e] of this.parts) if (!seenParts.has(id)) { e.g.remove(); this.parts.delete(id); dirty.add(`p:${id}`); }

    // Chip pins
    const seenPins = new Set<string>();
    for (const p of doc.pins) {
      seenPins.add(p.id);
      const e = this.pins.get(p.id);
      if (e && e.doc === p) continue;
      dirty.add(`pin:${p.id}`);
      const geom: PinGeom = { name: p.name, dir: p.dir, width: p.width, pos: p.at, exit: defaultFace(p) };
      const glyph = drawPinGlyph(geom, p.dir !== 'out');
      const g = glyph.g;
      g.setAttribute('data-pin-id', p.id);
      g.classList.add('ed-pin');
      if (p.dir === 'in' && p.kind && p.kind !== 'toggle') {
        g.classList.add(`ed-pin-${p.kind}`);
        const [kx, ky] = [p.at[0] + (geom.exit === 'right' ? -0.9 : geom.exit === 'left' ? 0.9 : 0), p.at[1] + (geom.exit === 'down' ? -0.9 : geom.exit === 'up' ? 0.9 : 0)];
        if (p.width === 1) {
          g.append(s('path', {
            class: 'ed-pin-mark',
            d: p.kind === 'clock' ? `M${kx - 0.45},${ky + 0.25} h0.3 v-0.5 h0.3 v0.5 h0.3` : `M${kx - 0.35},${ky - 0.35} h0.7 v0.7 h-0.7 z`,
          }));
        }
      }
      if (p.dir === 'inout') {
        // What the user drives onto a bidirectional pin (Z: nothing); the knob shows the net.
        const [kx, ky] = pinKnob(p);
        const v = p.value === undefined ? 'Z' : p.width === 1 ? String(p.value) : `0x${pinBig(p.value).toString(16).toUpperCase()}`;
        g.append(s('text', { class: 'ed-pin-drv', x: kx, y: p.width === 1 ? ky + 0.34 : ky - 1.25, 'text-anchor': 'middle' }, v));
      }
      // A wide transparent target over the knob (the glyph's own shapes are small).
      const b = pinBody(p);
      g.prepend(s('rect', { class: 'ed-pin-hit', x: b.x, y: b.y, width: b.w, height: b.h, rx: 0.5 }));
      if (e) e.g.replaceWith(g);
      else this.gPins.append(g);
      this.pins.set(p.id, { doc: p, g, glyph, geom, cls: '', txt: '' });
    }
    for (const [id, e] of this.pins) if (!seenPins.has(id)) { e.g.remove(); this.pins.delete(id); dirty.add(`pin:${id}`); }

    // Pointers
    const seenLabels = new Set<string>();
    for (const l of doc.labels) {
      seenLabels.add(l.id);
      const e = this.labels.get(l.id);
      if (e && e.doc === l) continue;
      dirty.add(`l:${l.id}`);
      const pg = pointerGeom(l);
      const g = s('g', { class: 'ed-ptr', 'data-label': l.id });
      const stub = s('path', { class: 'wire', d: pathD([l.at, pg.tip]) });
      g.append(stub, s('path', { class: 'ed-flag', d: `${pathD(pg.outline)} Z` }),
        s('text', { class: 'ed-ptr-name', x: pg.text[0], y: pg.text[1], 'text-anchor': 'middle' }, l.name),
        s('circle', { class: 'ed-ptr-dot', cx: l.at[0], cy: l.at[1], r: 0.18 }));
      if (e) e.g.replaceWith(g);
      else this.gLabels.append(g);
      this.labels.set(l.id, { doc: l, g, stub, cls: '' });
    }
    for (const [id, e] of this.labels) if (!seenLabels.has(id)) { e.g.remove(); this.labels.delete(id); dirty.add(`l:${id}`); }

    // Comments: under everything, touching nothing.
    const seenComments = new Set<string>();
    for (const c of doc.comments ?? []) {
      seenComments.add(c.id);
      const e = this.comments.get(c.id);
      if (e && e.doc === c) continue;
      if (e && e.doc.text === c.text) {
        e.g.setAttribute('transform', `translate(${c.at[0]},${c.at[1]})`);
        e.doc = c;
        continue;
      }
      const g = drawComment(c);
      if (this.sel.comments?.includes(c.id)) g.classList.add('ed-sel');
      if (e) e.g.replaceWith(g);
      else this.gComments.append(g);
      this.comments.set(c.id, { doc: c, g });
    }
    for (const [id, e] of this.comments) if (!seenComments.has(id)) { e.g.remove(); this.comments.delete(id); }

    // Wires: polylines follow their ends; a geometry change rechecks the wires on what changed.
    let wiresChanged = prev?.wires !== doc.wires || geomChanged;
    if (wiresChanged) {
      // A new wire list may regroup nets (hops and dots follow): HopCache sees it and is cheap.
      wiresChanged = prev?.wires !== doc.wires;
      const seen = new Set<string>();
      // A branch end is a fixed point; a wire with no part or pin end takes its width from its
      // host wire, so it is always rechecked.
      const touches = (w: WireDoc) => [w.a, w.b].some((x) => ('part' in x ? dirty.has(`p:${x.part}`) : 'pin' in x ? dirty.has(`pin:${x.pin}`) : 'label' in x && dirty.has(`l:${x.label}`)))
        || ![w.a, w.b].some((x) => 'part' in x || 'pin' in x);
      for (const w of doc.wires) {
        seen.add(w.id);
        let e = this.wires.get(w.id);
        // An unchanged wire between unchanged ends keeps its polyline and width (no lookups).
        if (e && e.doc === w && !touches(w)) continue;
        const poly = polyline(doc, w, defOf);
        const key = poly ? pathD(poly) : '';
        if (!e) {
          const path = s('path', { class: 'wire', 'data-wire': w.id });
          const hit = s('path', { class: 'wire-hit', 'data-wire': w.id });
          this.gWires.append(path);
          this.gHits.append(hit);
          e = { doc: w, poly, key: '\0', ver: 0, path, hit, width: 1, cls: '' };
          this.wires.set(w.id, e);
        }
        e.doc = w;
        e.width = this.wireWidth(doc, w, defOf);
        if (key !== e.key) {
          e.key = key;
          e.ver++;
          e.poly = poly;
          e.hit.setAttribute('d', key);
          wiresChanged = true;
        }
        if (poly) this.polys.set(w.id, poly);
        else this.polys.delete(w.id);
      }
      for (const [id, e] of this.wires) {
        if (seen.has(id)) continue;
        e.path.remove();
        e.hit.remove();
        this.wires.delete(id);
        this.polys.delete(id);
        wiresChanged = true;
      }
    }
    if (wiresChanged) this.drawWireShapes(doc);
    this.applyClasses();
  }

  /**
   * Hops and junction dots. Hops of a wire depend on the wires it crosses: HopCache recomputes
   * only the moved wires and those crossing them. Dots depend on their own group only: a group
   * whose wires did not move keeps its elements.
   */
  private drawWireShapes(doc: ChipDoc): void {
    this.version++;
    // A drag rewrites wires' corners, not their ends: the groups stay.
    const prev = this.groups.wires;
    if (prev !== doc.wires) {
      const end = (x: WireDoc['a'], y: WireDoc['a']) => x === y || ('wire' in x && 'wire' in y && x.wire === y.wire);
      const same = prev?.length === doc.wires.length && doc.wires.every((w, i) => w.id === prev[i].id && end(w.a, prev[i].a) && end(w.b, prev[i].b));
      this.groups = { wires: doc.wires, ids: same ? this.groups.ids : wireGroups(doc.wires) };
    }
    const groups = this.groups.ids;
    const shapes = groups.flatMap((ids, gi) => ids.map((id) => ({ id, group: gi, poly: this.wires.get(id)?.poly ?? null })));
    for (const id of this.hops.update(shapes)) this.wires.get(id)?.path.setAttribute('d', this.hops.d.get(id) ?? '');
    const seen = new Set<string>();
    for (const ids of groups) {
      const els = ids.map((id) => this.wires.get(id)).filter((e): e is WireEls => !!e?.poly);
      if (els.length < 2) continue;
      const bus = els.some((e) => e.width > 1);
      const key = `${bus ? 'b' : ''}${els.map((e) => `${e.doc.id}:${e.ver}`).join(' ')}`;
      seen.add(key);
      if (this.dots.has(key)) continue;
      const list: DotEls[] = [];
      for (const [x, y] of junctions(els.map((e) => e.poly!))) {
        const c = s('circle', { cx: x, cy: y, r: bus ? 0.32 : 0.24, class: 'dot' });
        list.push({ el: c, wire: ids[0], cls: '' });
        this.gDots.append(c);
      }
      this.dots.set(key, list);
    }
    for (const [k, list] of this.dots) if (!seen.has(k)) { list.forEach((d) => d.el.remove()); this.dots.delete(k); }
  }

  /** Width of a wire from what it touches (before any simulation says so). */
  private wireWidth(doc: ChipDoc, w: WireDoc, defOf: DefOf, depth = 0): number {
    for (const e of [w.a, w.b]) {
      if ('part' in e) {
        const p = doc.parts.find((q) => q.id === e.part);
        const port = p && defOf(p)?.ports.find((q) => q.name === e.port);
        if (port) return port.width;
      } else if ('pin' in e) {
        const p = doc.pins.find((q) => q.id === e.pin);
        if (p) return p.width;
      }
    }
    for (const e of [w.a, w.b]) {
      if ('wire' in e && depth < 8) {
        const host = doc.wires.find((q) => q.id === e.wire);
        if (host) return this.wireWidth(doc, host, defOf, depth + 1);
      }
    }
    return 1;
  }

  private drawPart(p: PartDoc, def: ComponentDef | undefined): { g: SVGGElement; disp?: DisplayEls } {
    const g = s('g', { class: 'inst ed-part', transform: `translate(${p.at[0]},${p.at[1]})`, 'data-part': p.id });
    if (!def) {
      const name = 'lib' in p.ref ? p.ref.lib : 'chip' in p.ref ? p.ref.chip : Object.keys(p.ref)[0];
      g.classList.add('ed-unresolved');
      g.append(s('rect', { class: 'hit', x: -0.4, y: -0.4, width: 6.8, height: 4.8, rx: 0.6 }),
        s('rect', { class: 'ed-missing', x: 0, y: 0, width: 6, height: 4, rx: 0.6 }),
        s('text', { class: 'sym-port', x: 3, y: 2.3, 'text-anchor': 'middle' }, name),
        s('text', { class: 'inst-name', x: 0.1, y: -0.45 }, p.label ?? p.id));
      return { g };
    }
    const geo = symbolGeom(def);
    g.append(s('rect', { class: 'hit', x: -0.4, y: -0.4, width: geo.w + 0.8, height: geo.h + 0.8, rx: 0.6 }));
    let disp: DisplayEls | undefined;
    if ('display' in p.ref) disp = this.drawDisplay(g, p.ref.display, p.ref.width ?? 1, geo.w, geo.h, !!p.flip);
    else g.append(drawSymbol(def, p.flip));
    const nameAt = instNameAt(def);
    if (nameAt) g.append(s('text', { class: 'inst-name', x: nameAt.x, y: nameAt.y, 'text-anchor': nameAt.anchor }, p.label ?? p.id));
    return { g, disp };
  }

  /** A display: LED, 7-segment digit (bit i = segment a…g, bit 7 = dp), hex digit, value box or halt plate. */
  private drawDisplay(g: SVGGElement, kind: DisplayKind, width: number, w: number, h: number, flip: boolean): DisplayEls {
    g.append(s('rect', { class: 'sym-body sym-box ed-disp-box', x: 0, y: 0, width: w, height: h, rx: 0.6 }));
    const port = flip ? w : 0;
    g.append(s('circle', { class: 'ed-disp-port', cx: port, cy: h / 2, r: 0.16 }));
    const d: DisplayEls = { kind, width, segs: [], shown: '' };
    if (kind === 'led' && width > 1) {
      // Most significant bit first, rows of 8, as a binary number reads.
      const gr = ledGrid(width), x0 = (w - gr.cols * LED_PITCH) / 2, y0 = (h - gr.rows * LED_PITCH) / 2;
      d.leds = Array.from({ length: width }, (_, b) => {
        const i = width - 1 - b, r = Math.floor(i / gr.cols), c = i % gr.cols;
        return s('circle', { class: 'ed-led', cx: x0 + LED_PITCH * (c + 0.5), cy: y0 + LED_PITCH * (r + 0.5), r: LED_PITCH / 2 - 0.15 });
      });
      g.append(...d.leds);
    } else if (kind === 'led') {
      d.led = s('circle', { class: 'ed-led', cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 - 0.25 });
      g.append(d.led);
    } else if (kind === 'buzzer') {
      // A speaker cone and two sound waves (lit while it sounds).
      const cx = w / 2 - 0.5, cy = h / 2;
      d.buzz = s('g', { class: 'ed-buzz' },
        s('path', { class: 'ed-buzz-cone', d: `M${cx - 0.9},${cy - 0.35} h0.5 l0.7,-0.5 v1.7 l-0.7,-0.5 h-0.5 Z` }),
        s('path', { class: 'ed-buzz-wave', d: `M${cx + 0.65},${cy - 0.4} q0.35,0.4 0,0.8` }),
        s('path', { class: 'ed-buzz-wave', d: `M${cx + 1.05},${cy - 0.7} q0.6,0.7 0,1.4` }));
      g.append(d.buzz);
    } else if (kind === 'halt') {
      d.halt = s('g', { class: 'ed-halt' },
        s('rect', { class: 'ed-halt-plate', x: 0.45, y: 0.35, width: w - 0.9, height: h - 0.7, rx: 0.3 }),
        s('text', { class: 'ed-halt-text', x: w / 2, y: h / 2 + 0.32, 'text-anchor': 'middle' }, 'HALT'));
      g.append(d.halt);
    } else if (kind === 'value') {
      d.text = s('text', { class: 'ed-disp-value', x: w / 2, y: h / 2 + 0.4, 'text-anchor': 'middle' });
      g.append(d.text);
    } else {
      // A slanted-free digit, height h - 1, centred.
      const dh = h - 1.1, dw = dh * 0.55, x0 = w / 2 - dw / 2, y0 = 0.55, m = dh / 2;
      const seg = (x1: number, y1: number, x2: number, y2: number) => s('path', { class: 'ed-seg', d: `M${x1},${y1} L${x2},${y2}` });
      const i = 0.32; // gaps between segments, as on a real display
      d.segs = [
        seg(x0 + i, y0, x0 + dw - i, y0), // a
        seg(x0 + dw, y0 + i, x0 + dw, y0 + m - i), // b
        seg(x0 + dw, y0 + m + i, x0 + dw, y0 + dh - i), // c
        seg(x0 + i, y0 + dh, x0 + dw - i, y0 + dh), // d
        seg(x0, y0 + m + i, x0, y0 + dh - i), // e
        seg(x0, y0 + i, x0, y0 + m - i), // f
        seg(x0 + i, y0 + m, x0 + dw - i, y0 + m), // g
      ];
      g.append(...d.segs);
      if (kind === 'seg7' && width >= 8) {
        const dp = s('circle', { class: 'ed-seg ed-dp', cx: x0 + dw + 0.45, cy: y0 + dh, r: 0.16 });
        d.segs.push(dp);
        g.append(dp);
      }
    }
    return d;
  }

  // ---- classes: selection, diagnostics, values ---------------------------------------------

  setSelection(sel: Sel): void {
    this.sel = sel;
    this.applyClasses();
  }

  setDiags(diags: Diag[]): void {
    this.diagCls.clear();
    const mark = (k: string, lvl: string) => {
      if (this.diagCls.get(k) !== 'ed-err') this.diagCls.set(k, lvl);
    };
    for (const d of diags) {
      const lvl = d.level === 'error' ? 'ed-err' : 'ed-warn';
      d.parts?.forEach((id) => mark(`p:${id}`, lvl));
      d.pins?.forEach((id) => mark(`pin:${id}`, lvl));
      d.wires?.forEach((id) => mark(`w:${id}`, lvl));
      d.labels?.forEach((id) => mark(`l:${id}`, lvl));
    }
    this.applyClasses();
  }

  private extra(kind: 'p' | 'pin' | 'w' | 'l', id: string, sel: string[] | undefined): string {
    const d = this.diagCls.get(`${kind}:${id}`);
    return `${sel?.includes(id) ? ' ed-sel' : ''}${d ? ` ${d}` : ''}`;
  }

  private applyClasses(): void {
    for (const [id, e] of this.parts) {
      const x = this.extra('p', id, this.sel.parts);
      if (x !== e.cls) {
        e.g.classList.remove('ed-sel', 'ed-err', 'ed-warn');
        if (x) e.g.classList.add(...x.trim().split(' '));
        e.cls = x;
      }
    }
    for (const [id, e] of this.pins) {
      const x = this.extra('pin', id, this.sel.pins);
      if (x !== e.cls) {
        e.g.classList.remove('ed-sel', 'ed-err', 'ed-warn');
        if (x) e.g.classList.add(...x.trim().split(' '));
        e.cls = x;
      }
    }
    for (const [id, e] of this.labels) {
      e.g.classList.toggle('ed-sel', !!this.sel.labels?.includes(id));
      const d = this.diagCls.get(`l:${id}`);
      e.g.classList.toggle('ed-err', d === 'ed-err');
      e.g.classList.toggle('ed-warn', d === 'ed-warn');
    }
    for (const [id, e] of this.comments) e.g.classList.toggle('ed-sel', !!this.sel.comments?.includes(id));
    for (const e of this.wires.values()) this.paintWire(e, e.cls ? e.cls.split('|')[0] : 'wire');
  }

  private paintWire(e: WireEls, vcls: string): void {
    const full = `${vcls}${this.extra('w', e.doc.id, this.sel.wires)}`;
    const key = `${vcls}|${full}`;
    if (key === e.cls) return;
    e.cls = key;
    e.path.setAttribute('class', full);
  }

  /** Repaint every value from the simulation (null: no simulation, everything neutral). */
  paint(v: ViewValues | null, built: Compiled | null): void {
    for (const e of this.wires.values()) {
      const bits = v?.wireBits(e.doc.id);
      const vcls = bits ? `wire ${valueClass(bits)}` : `wire${e.width > 1 ? ' bus' : ''} ed-dead`;
      this.paintWire(e, vcls);
    }
    for (const list of this.dots.values()) for (const d of list) {
      const vc = this.wires.get(d.wire)?.cls.split('|')[0].replace(/^wire/, 'dot') ?? 'dot';
      if (vc !== d.cls) {
        d.cls = vc;
        d.el.setAttribute('class', vc);
      }
    }
    for (const e of this.pins.values()) {
      const p = e.doc;
      const bits = v?.pinBits(p.name) ?? null;
      const base = `pin ${p.dir === 'in' ? 'pin-in clickable' : p.dir === 'inout' ? 'pin-in clickable ed-pin-io' : 'pin-out'} ed-pin${p.kind && p.dir === 'in' && p.kind !== 'toggle' ? ` ed-pin-${p.kind}` : ''}`;
      const vc = bits ? (p.width === 1 ? bitClass(bits[0]) : busClass(bits)) : p.width === 1 ? '' : 'bus';
      const cls = `${base} ${vc}${e.cls}`;
      if (e.g.getAttribute('class') !== cls) {
        e.g.setAttribute('class', cls);
        if (p.width > 1) e.g.querySelector('.pin-stub')?.setAttribute('class', `wire ${vc || 'bus'} pin-stub`);
      }
      if (p.width > 1) {
        const txt = bits && bits.length === p.width ? formatBits(bits, this.radix) : '?';
        if (txt !== e.txt) {
          e.txt = txt;
          placePinValue(e.geom, e.glyph, txt);
        }
      }
    }
    for (const e of this.labels.values()) {
      const bits = v?.labelBits(e.doc.id);
      const vc = bits ? valueClass(bits) : '';
      if (vc !== e.cls) {
        e.cls = vc;
        e.stub.setAttribute('class', `wire ${vc}`);
        e.g.classList.remove('v0', 'v1', 'vx', 'vz', 'bus', 'bus0', 'bus1');
        if (vc) e.g.classList.add(...vc.split(' '));
      }
    }
    for (const [id, e] of this.parts) {
      if (e.disp) this.paintDisplay(e.disp, v?.endBits(`p:${id}.a`) ?? null);
      const c = v?.conducting(id);
      e.g.classList.toggle('conducting', c === 1);
      e.g.classList.toggle('maybe', c === 2);
    }
    this.paintBusLabels(v, built);
    this.paintTones(v !== null);
  }

  /** Hand the buzzers' tones to `sound` when they change (all silent without a simulation). */
  private paintTones(live: boolean): void {
    if (!this.sound) return;
    const tones = new Map<string, number>();
    if (live) for (const [id, e] of this.parts) if (e.disp?.hz) tones.set(id, e.disp.hz);
    const key = [...tones].join(';');
    if (key === this.toneKey) return;
    this.toneKey = key;
    this.sound(tones);
  }

  private paintDisplay(d: DisplayEls, bits: Bit[] | null): void {
    const x = !bits || bits.some((b) => b === BX || b === BZ);
    // segments read the low byte only (pack is exact there at any width)
    const v = bits && !x ? pack(bits.slice(0, 8)) : -1;
    const key = bits ? bits.join('') + this.radix : '';
    if (key === d.shown) return;
    d.shown = key;
    if (d.leds) {
      d.leds.forEach((el, i) => {
        const b = bits?.[i];
        el.setAttribute('class', `ed-led${b === B1 ? ' on' : b === BX || b === BZ ? ' vx' : ''}`);
      });
    } else if (d.buzz) {
      // A bus wider than 7 bits with a high bit set is past note 127: the top note.
      d.hz = !bits || x ? 0 : buzzerHz(d.width, bits.slice(7).includes(B1) ? 127 : pack(bits.slice(0, 7)));
      d.buzz.setAttribute('class', `ed-buzz${d.hz ? ' on' : x && bits ? ' vx' : ''}`);
    } else if (d.halt) {
      const on = !!bits && bits.includes(B1);
      d.halt.setAttribute('class', `ed-halt${on ? ' ed-halt-on' : x && bits ? ' ed-halt-vx' : ''}`);
    } else if (d.led) {
      d.led.setAttribute('class', `ed-led${bits && bits.some((b) => b === B1) && !x ? ' on' : x && bits ? ' vx' : ''}`);
    } else if (d.text) {
      d.text.textContent = bits ? formatBits(bits, this.radix) : '–';
    } else {
      let on: number;
      if (d.kind === 'hex') on = v < 0 ? 0 : HEX_SEGS[v % 16];
      else on = v < 0 ? 0 : v;
      d.segs.forEach((el, i) => el.setAttribute('class', `ed-seg${i === 7 ? ' ed-dp' : ''}${(Math.floor(on / 2 ** i) % 2) ? ' on' : ''}${x && bits ? ' vx' : ''}`));
    }
  }

  /** One value label per bus net, on its longest horizontal segment (not where a pin or display shows it). */
  private paintBusLabels(v: ViewValues | null, built: Compiled | null): void {
    if (this.busLayout.built !== built || this.busLayout.version !== this.version) {
      this.busLayout = { built, version: this.version };
      this.gValues.replaceChildren();
      this.busLabels = [];
      if (built && this.doc) {
        const shown = new Set<number>();
        for (const [k, n] of built.netOfEnd) if (k.startsWith('pin:')) shown.add(n);
        for (const p of this.doc.parts) if ('display' in p.ref && p.ref.display !== 'halt') shown.add(built.netOfEnd.get(`p:${p.id}.a`) ?? -1);
        const best = new Map<number, { at: Vec; len: number; wire: string }>();
        for (const e of this.wires.values()) {
          const n = built.netOfWire.get(e.doc.id);
          if (n === undefined || n < 0 || e.width < 2 || shown.has(n) || !e.poly) continue;
          for (let i = 1; i < e.poly.length; i++) {
            const [a, b] = [e.poly[i - 1], e.poly[i]];
            if (a[1] !== b[1]) continue;
            const len = Math.abs(a[0] - b[0]);
            if (len > (best.get(n)?.len ?? 3)) best.set(n, { at: [(a[0] + b[0]) / 2, a[1]], len, wire: e.doc.id });
          }
        }
        for (const [net, { at, len, wire }] of best) {
          const g = s('g', { class: 'bus-label' });
          const bg = s('rect', { rx: 0.45, height: 1.3, y: at[1] - 0.65 - 0.9 });
          const text = s('text', { x: at[0], y: at[1] - 0.9 + 0.38, 'text-anchor': 'middle' });
          g.append(bg, text);
          this.gValues.append(g);
          this.busLabels.push({ net, wire, at, room: len, g, bg, text, txt: '' });
        }
      }
    }
    for (const l of this.busLabels) {
      const nets = v?.wireBits(l.wire) ?? null;
      const txt = nets ? formatBits(nets, this.radix) : '';
      if (txt === l.txt) continue;
      l.txt = txt;
      l.text.textContent = txt;
      const tw = textWidth(txt, 0.95);
      l.bg.setAttribute('x', String(l.at[0] - tw / 2));
      l.bg.setAttribute('width', String(tw));
      l.g.setAttribute('display', txt && tw <= l.room - 0.4 ? 'inline' : 'none');
      if (nets) l.g.setAttribute('class', `bus-label ${busClass(nets)}`);
    }
  }


  // ---- overlays ----------------------------------------------------------------------------

  /** The wire being drawn (null hides it); `bad` when it cannot end where the cursor is. */
  showPreview(path: Vec[] | null, bad = false): void {
    this.preview.setAttribute('d', path && path.length > 1 ? pathD(path) : '');
    this.preview.setAttribute('class', `ed-preview${bad ? ' bad' : ''}`);
  }

  showBand(a: Vec | null, b?: Vec): void {
    if (!a || !b) return void this.band.setAttribute('display', 'none');
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
    this.band.setAttribute('x', String(x));
    this.band.setAttribute('y', String(y));
    this.band.setAttribute('width', String(Math.abs(a[0] - b[0])));
    this.band.setAttribute('height', String(Math.abs(a[1] - b[1])));
    this.band.setAttribute('display', 'inline');
  }

  /** Highlight an attach point under the cursor (null hides it). */
  showHot(p: Vec | null, bad = false): void {
    if (!p) return void this.hot.setAttribute('display', 'none');
    this.hot.setAttribute('cx', String(p[0]));
    this.hot.setAttribute('cy', String(p[1]));
    this.hot.setAttribute('class', `ed-hot${bad ? ' bad' : ''}`);
    this.hot.setAttribute('display', 'inline');
  }

  /**
   * A translucent preview of something being placed, its origin at `at`. `key` names what it
   * shows: `make` draws it only when the key changes. A null key hides it.
   */
  showGhost(key: string | null, make?: () => SVGElement, at?: Vec): void {
    if (key === null) {
      this.ghost.replaceChildren();
      this.ghostKey = '';
      return;
    }
    if (key !== this.ghostKey && make) {
      this.ghost.replaceChildren(make());
      this.ghostKey = key;
    }
    if (at) this.ghost.setAttribute('transform', `translate(${at[0]},${at[1]})`);
  }
  private ghostKey = '';

  /** Draw a part symbol for a ghost (displays drawn like placed ones). */
  ghostOf(def: ComponentDef, ref?: PartDoc['ref']): SVGGElement {
    return this.drawPart({ id: '', ref: ref ?? { lib: def.id }, at: [0, 0], label: ' ' }, def).g;
  }

  /** Flash an object (a jump to a pointer). */
  ping(kind: 'label' | 'part' | 'pin', id: string): void {
    const el = kind === 'label' ? this.labels.get(id)?.g : kind === 'part' ? this.parts.get(id)?.g : this.pins.get(id)?.g;
    if (!el) return;
    el.classList.remove('ed-ping');
    void (el as unknown as HTMLElement).getBoundingClientRect();
    el.classList.add('ed-ping');
    setTimeout(() => el.classList.remove('ed-ping'), 1000);
  }

  centerOn(p: Vec, force = false): void {
    if (force) {
      const v = this.cam.vb;
      this.cam.vb = { ...v, x: p[0] - v.w / 2, y: p[1] - v.h / 2 };
      this.cam.apply();
    } else this.cam.centerOn(p);
  }

  /** Bounding box of everything drawn (null when the chip is empty). */
  contentBox(defOf: DefOf): ViewBox | null {
    const doc = this.doc;
    if (!doc) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const p of doc.parts) {
      const b = partBox(defOf(p), p.at);
      grow(b.x, b.y - 1);
      grow(b.x + b.w, b.y + b.h);
    }
    for (const p of doc.pins) {
      const b = pinBody(p);
      grow(b.x - 3, b.y);
      grow(b.x + b.w + 3, b.y + b.h);
    }
    for (const l of doc.labels) {
      const r = pointerGeom(l).rect;
      grow(r.x, r.y);
      grow(r.x + r.w, r.y + r.h);
    }
    for (const c of doc.comments ?? []) {
      const b = commentBox(c);
      grow(b.x, b.y);
      grow(b.x + b.w, b.y + b.h);
    }
    for (const poly of this.polys.values()) for (const [x, y] of poly) grow(x, y);
    if (x0 === Infinity) return null;
    return { x: x0 - 3, y: y0 - 3, w: x1 - x0 + 6, h: y1 - y0 + 6 };
  }

  fit(defOf: DefOf): void {
    const b = this.contentBox(defOf);
    if (b) this.cam.fit(b, 0, 40);
    else {
      this.cam.fit({ x: -4, y: -4, w: 60, h: 36 });
    }
  }
}

/** A comment: its lines on a faint note (the box from commentBox, so hits match the drawing). */
export function drawComment(c: CommentDoc): SVGGElement {
  const b = commentBox(c);
  const g = s('g', { class: 'ed-note', transform: `translate(${c.at[0]},${c.at[1]})`, 'data-comment': c.id });
  const text = s('text', { class: 'ed-note-text', x: 0.6, y: 0 });
  b.lines.forEach((l, i) => text.append(s('tspan', { x: 0.6, y: (i + 1) * COMMENT_LINE - 0.2 }, l || ' ')));
  g.append(s('rect', { class: 'ed-note-bg', x: 0, y: 0, width: b.w, height: b.h, rx: 0.4 }), text);
  return g;
}

/** Segments a…g lit for each hex digit (bit 0 = a). */
const HEX_SEGS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];
