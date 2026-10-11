// The live faces of the sandbox's displays (LED, LED bank, 7-segment, hex, value, buzzer, halt) as
// SVG, and the displays a user chip shows on its box (face.ts): drawn by the canvas (view.ts) and the
// Package dialog's face editor, painted from the simulation's bits.

import type { HierNode } from '../sim/flatten';
import { symbolGeom } from '../sim/geometry';
import type { Sim } from '../sim/sim';
import { B1, BX, BZ, type Bit, type ComponentDef } from '../sim/types';
import { formatBits, pack, type Radix } from '../sim/values';
import { s } from '../ui/dom';
import { faceOf, type FaceShown, nodeAt, shownBox, shownNets } from './face';
import { drawIoFace, type IoFace } from './ioface';
import type { DisplayKind } from './model';
import { buzzerHz, LED_PITCH, ledGrid } from './parts';

/** A display shown on a placed chip's face (face.ts), painted from inside that chip. */
export interface FaceEls { d: FaceShown; disp: DisplayEls }
/** The live face of a display, a key part ('key') or a keyboard part ('keyboard'). */
export interface DisplayEls {
  kind: DisplayKind | 'key' | 'keyboard' | 'io'; width: number; segs: SVGElement[]; shown: string;
  /** A console, switch bank or screen (ioface.ts). */
  face?: IoFace;
  led?: SVGCircleElement; text?: SVGTextElement; halt?: SVGGElement; buzz?: SVGGElement;
  /** An LED bank: one LED per bit (index = bit). */
  leds?: SVGCircleElement[];
  /** A buzzer's tone now (Hz, 0 silent). */
  hz?: number;
  /** A key part's keycap; a keyboard's code cell (lit while a key waits), its glyph and the "more waiting" count. */
  key?: SVGGElement; kbdCell?: SVGRectElement; kbdChar?: SVGTextElement; kbdMore?: SVGTextElement;
}

/** A display: LED, 7-segment digit (bit i = segment a…g, bit 7 = dp), hex digit, value box or halt plate. */
export function drawDisplay(g: SVGGElement, kind: DisplayKind, width: number, w: number, h: number, flip: boolean, onFace = false): DisplayEls {
  g.append(s('rect', { class: 'sym-body sym-box ed-disp-box', x: 0, y: 0, width: w, height: h, rx: 0.6 }));
  if (!onFace) g.append(s('circle', { class: 'ed-disp-port', cx: flip ? w : 0, cy: h / 2, r: 0.16 }));
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

/** Repaint a display from its input bits (null: no simulation); values in `radix`. */
export function paintDisplay(d: DisplayEls, bits: Bit[] | null, radix: Radix): void {
  const x = !bits || bits.some((b) => b === BX || b === BZ);
  // segments read the low byte only (pack is exact there at any width)
  const v = bits && !x ? pack(bits.slice(0, 8)) : -1;
  const key = bits ? bits.join('') + radix : '';
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
    d.text.textContent = bits ? formatBits(bits, radix) : '–';
  } else {
    let on: number;
    if (d.kind === 'hex') on = v < 0 ? 0 : HEX_SEGS[v % 16];
    else on = v < 0 ? 0 : v;
    d.segs.forEach((el, i) => el.setAttribute('class', `ed-seg${i === 7 ? ' ed-dp' : ''}${(Math.floor(on / 2 ** i) % 2) ? ' on' : ''}${x && bits ? ' vx' : ''}`));
  }
}

/** The displays a user chip shows on its box, each a display part's own face scaled into place. */
export function drawFace(g: SVGGElement, def: ComponentDef, flip: boolean): FaceEls[] | undefined {
  const f = faceOf(def);
  if (!f) return undefined;
  const w = symbolGeom(def).w;
  return f.displays.map((d) => {
    const b = shownBox(d, w, flip);
    const sub = s('g', { class: 'ed-face-disp', transform: `translate(${b.x - d.crop.x * d.scale},${b.y - d.crop.y * d.scale}) scale(${d.scale})` });
    g.append(sub);
    if (d.kind === 'console' || d.kind === 'screen' || d.kind === 'switches') {
      const io = drawIoFace(d.def, false)!;
      if (d.kind === 'switches') sub.append(s('rect', { class: 'sym-body sym-box ed-disp-box', x: 0, y: 0, width: d.crop.w, height: d.crop.h, rx: 0.6, style: `stroke-width:${0.08 / d.scale}` }));
      sub.append(io.g);
      return { d, disp: { kind: 'io', width: 0, segs: [], shown: '', face: io } };
    }
    const geo = symbolGeom(d.def);
    const disp = drawDisplay(sub, d.kind, d.width, geo.w, geo.h, false, true);
    // A thin bezel at any scale: the chip's own outline stays the boldest line.
    sub.querySelector<SVGElement>('.ed-disp-box')?.style.setProperty('stroke-width', String(0.08 / d.scale));
    return { d, disp };
  });
}

/** Repaint a placed chip's face displays: `chip` is its node in `sim` (null: no simulation). */
export function paintFace(faces: readonly FaceEls[], sim: Sim | null, chip: HierNode | null, radix: Radix): void {
  for (const f of faces) {
    if (f.disp.face) f.disp.face.paint(sim, nodeAt(chip, f.d.path));
    else {
      const nets = sim && shownNets(chip, f.d);
      paintDisplay(f.disp, nets ? sim.getBits(nets) : null, radix);
    }
  }
}

/** Segments a…g lit for each hex digit (bit 0 = a). */
const HEX_SEGS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];
