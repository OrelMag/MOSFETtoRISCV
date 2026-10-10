// The live faces of the I/O parts (ioparts.ts) as SVG, drawn by the editor's canvas (view.ts) and
// over a placed chip's inside (look inside): a console's terminal, a switch bank's toggles, a
// screen's picture. A face reads the part's state from the simulation through its hierarchy node
// (any depth) and redraws only when that state changed. The screen's picture is a canvas bitmap
// in a foreignObject, repainted from the frame buffer when its version moves (never one element
// per pixel); ScreenCanvas is shared with the Screens drawer (ioui.ts) and the PNG download.

import '../styles/ioparts.css';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { type ComponentDef, netlistOf } from '../sim/types';
import { formatBits } from '../sim/values';
import { s } from '../ui/dom';
import {
  CON_CH, CON_LINE, consoleLayout, flipSwitch, consoleRows, type ConsoleState, type FaceLayout, ioInfo, type IoInfo, ioState, pixelsOf, paintScreen,
  type ScreenRef, screenLayout, screenRes, type ScreenState, type ScreenTheme, SW_PITCH, switchCell, type SwitchState,
} from './ioparts';

export interface IoFace {
  readonly g: SVGGElement;
  /** Redraw from the simulation (`node`: the part's node in it; null: not simulated). */
  paint(sim: Sim | null, node: HierNode | null): void;
}

/** The face of an I/O part's definition (null for any other part). `toggle`: a click on a switch (look inside). */
export function drawIoFace(def: ComponentDef, flip: boolean, toggle?: (bit: number) => void): IoFace | null {
  const info = ioInfo(def);
  if (!info) return null;
  if (info.kind === 'console') return consoleFace(def, info, flip);
  if (info.kind === 'switches') return switchFace(def, info.width, flip, toggle);
  return screenFace(def, info.ref, flip);
}

// ---- console ---------------------------------------------------------------------------------

function consoleFace(def: ComponentDef, info: Extract<IoInfo, { kind: 'console' }>, flip: boolean): IoFace {
  const L = consoleLayout(def, flip), f = L.face;
  const g = s('g', { class: 'io-con' });
  const text = s('text', { class: 'io-con-text', x: f.x + 0.5, y: f.y });
  const rows = Array.from({ length: info.rows }, (_, i) => s('tspan', { x: f.x + 0.5, y: f.y + 0.5 + (i + 0.78) * CON_LINE }));
  text.append(...rows);
  const cursor = s('rect', { class: 'io-con-cursor', width: CON_CH, height: CON_LINE * 0.85, x: f.x + 0.5, y: f.y + 0.5 });
  g.append(s('rect', { class: 'io-con-bg', x: f.x, y: f.y, width: f.w, height: f.h, rx: 0.3 }), text, cursor);
  let last: unknown = null, lastN = -1;
  return {
    g,
    paint(sim, node) {
      const st = sim && node ? (ioState(sim, node) as ConsoleState | undefined) : undefined;
      if (st === last && (st?.n ?? -1) === lastN) return;
      last = st;
      lastN = st?.n ?? -1;
      const shown = st ? consoleRows(st, info.cols, info.rows) : [];
      rows.forEach((t, i) => (t.textContent = shown[i] ?? ''));
      const r = Math.max(0, shown.length - 1), c = shown[r]?.length ?? 0;
      const full = c >= info.cols;
      cursor.setAttribute('x', String(f.x + 0.5 + Math.min(c, info.cols - 1) * CON_CH));
      cursor.setAttribute('y', String(f.y + 0.5 + r * CON_LINE + 0.1));
      g.classList.toggle('off', !st);
      g.classList.toggle('full', full);
    },
  };
}

// ---- switch bank -------------------------------------------------------------------------------

function switchFace(def: ComponentDef, w: number, flip: boolean, toggle?: (bit: number) => void): IoFace {
  const bw = def.symbol.w!, bh = def.symbol.h!;
  const g = s('g', { class: 'io-sw' });
  g.append(s('circle', { class: 'ed-disp-port', cx: flip ? 0 : bw, cy: bh / 2, r: 0.16 }));
  const sw = Array.from({ length: w }, (_, b) => {
    const [x, y] = switchCell(w, b);
    const e = s('g', { class: 'io-switch', 'data-bit': b, transform: `translate(${x},${y})` },
      s('title', null, `switch ${b}`),
      s('rect', { class: 'io-sw-track', x: (SW_PITCH - 0.9) / 2, y: 0.15, width: 0.9, height: 1.5, rx: 0.3 }),
      s('rect', { class: 'io-sw-knob', x: (SW_PITCH - 0.9) / 2 + 0.12, y: 0.95, width: 0.66, height: 0.6, rx: 0.2 }));
    g.append(e);
    return e;
  });
  const value = s('text', { class: 'io-sw-value', x: bw / 2, y: bh - 0.45, 'text-anchor': 'middle' });
  g.append(value);
  if (toggle) {
    g.addEventListener('click', (e) => {
      const t = (e.target as Element).closest('[data-bit]');
      if (!t) return;
      e.stopPropagation();
      toggle(Number(t.getAttribute('data-bit')));
    });
    g.classList.add('clickable');
  }
  let shown = '';
  return {
    g,
    paint(sim, node) {
      const bits = sim && node ? sim.getBits(node.ports.q) : null;
      const st = sim && node ? (ioState(sim, node) as SwitchState | undefined) : undefined;
      const key = `${st?.v ?? ''}|${bits?.join('') ?? ''}`;
      if (key === shown) return;
      shown = key;
      sw.forEach((e, b) => {
        const on = st ? Math.floor(st.v / 2 ** b) % 2 === 1 : false;
        e.setAttribute('class', `io-switch${on ? ' on' : ''}`);
      });
      value.textContent = bits ? formatBits(bits, 'hex') : '';
    },
  };
}

// ---- screen ----------------------------------------------------------------------------------------

/** Theme colours a picture needs, resolved through the CSS tokens (light-dark() included). */
function themeOf(host: Element): ScreenTheme {
  const probe = (v: string) => {
    const el = document.createElement('span');
    el.style.color = `var(${v})`;
    el.style.display = 'none';
    (host.ownerDocument.body ?? host).append(el);
    const c = getComputedStyle(el).color;
    el.remove();
    const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    return (Math.round(m[0]) << 16) | (Math.round(m[1]) << 8) | Math.round(m[2]);
  };
  return { off: probe('--scr-off'), gap: probe('--scr-gap'), x: probe('--wx') };
}

/** What decides the theme colours now (a change repaints every picture). */
const themeKey = () => {
  const d = document.documentElement;
  return `${d.dataset.theme ?? ''}|${d.dataset.palette ?? ''}|${typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches}`;
};
let theme: { key: string; th: ScreenTheme } | null = null;
const currentTheme = (host: Element) => {
  const k = themeKey();
  if (!theme || theme.key !== k) theme = { key: k, th: themeOf(host) };
  return theme;
};

/** A screen's picture as a canvas bitmap, repainted only when the picture (or the theme) changed. */
export class ScreenCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private img: ImageData | null = null;
  private u32: Uint32Array | null = null;
  private key: unknown = null;
  private ver = -1;
  private bitsKey = '';
  private themeKey = '';
  private px: Int32Array<ArrayBufferLike>;
  readonly k: number;

  constructor(readonly ref: ScreenRef) {
    const n = ref.size;
    this.k = screenRes(n, ref.look, !!ref.grid);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = n * this.k;
    this.canvas.className = 'io-scr-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.px = new Int32Array(n * n);
  }

  /** Show the part's picture now (its frame buffer, or the bits on its px bus). Returns whether it was repainted. */
  update(sim: Sim | null, node: HierNode | null): boolean {
    const r = this.ref, th = currentTheme(this.canvas.isConnected ? this.canvas : document.body);
    let px: ArrayLike<number> | null = null;
    if (sim && node) {
      if (r.mode === 'pixels') {
        const bits = sim.getBits(node.ports.px);
        const bk = bits.join('');
        if (bk !== this.bitsKey || th.key !== this.themeKey || this.key !== sim) { this.bitsKey = bk; px = pixelsOf(bits, r.size, r.color, this.px); }
        this.key = sim;
      } else {
        const st = ioState(sim, node) as ScreenState | undefined;
        if (st && (st !== this.key || st.ver !== this.ver || th.key !== this.themeKey)) { px = st.px; this.ver = st.ver; }
        this.key = st ?? null;
      }
    } else if (this.key !== null || th.key !== this.themeKey) {
      this.key = null;
      this.bitsKey = '';
      px = this.px.fill(0);
    }
    if (!px || !this.ctx) return false;
    this.themeKey = th.key;
    const W = r.size * this.k;
    if (!this.img) {
      this.img = this.ctx.createImageData(W, W);
      this.u32 = new Uint32Array(this.img.data.buffer);
    }
    paintScreen(this.u32!, px, r.size, r.color, this.k, r.look, !!r.grid, th.th);
    this.ctx.putImageData(this.img, 0, 0);
    return true;
  }

  /** The picture as a PNG (at least 256 pixels a side, pixels kept square). */
  png(): Promise<Blob | null> {
    const n = this.ref.size, up = Math.max(1, Math.ceil(256 / (n * this.k)));
    const c = document.createElement('canvas');
    c.width = c.height = n * this.k * up;
    const g = c.getContext('2d');
    if (!g) return Promise.resolve(null);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.canvas, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, 'image/png'));
  }
}

function screenFace(def: ComponentDef, ref: ScreenRef, flip: boolean): IoFace {
  const L: FaceLayout = screenLayout(def, flip), f = L.face;
  const g = s('g', { class: `io-scr${ref.look === 'dots' ? ' dots' : ''}` });
  const sc = new ScreenCanvas(ref);
  const fo = s('foreignObject', { x: f.x, y: f.y, width: f.w, height: f.h, class: 'io-scr-fo' });
  fo.append(sc.canvas);
  g.append(s('rect', { class: 'io-scr-bezel', x: f.x - 0.35, y: f.y - 0.35, width: f.w + 0.7, height: f.h + 0.7, rx: 0.35 }), fo);
  // a pixels-mode screen is an alias box: drawSymbol prints no port names, so name px here
  if (ref.mode === 'pixels') {
    for (const l of L.labels) g.append(s('text', { class: 'sym-port', x: l.x, y: l.y, 'text-anchor': l.anchor }, l.text));
  }
  return { g, paint: (sim, node) => void sc.update(sim, node) };
}


// ---- look inside ---------------------------------------------------------------------------------

/** What flips a switch from outside: the editor's simulation (EditorSim). */
export interface SwitchHost { readonly sim: Sim | null; pokeLeaf(li: number, state: unknown): void }

/** Flip switch `bit` of the switch bank at `node` (in host's simulation). */
export function toggleSwitch(host: SwitchHost, node: HierNode, bit: number): void {
  const li = node.leafIndex, sim = host.sim;
  if (li === undefined || !sim) return;
  const v = (sim.leafState(li) as SwitchState | undefined)?.v ?? 0;
  host.pokeLeaf(li, { v: flipSwitch(v, bit) } satisfies SwitchState);
}

/**
 * Faces for the I/O parts of a schematic drawn by SchematicView (look inside): each goes over its
 * instance's symbol. Returns the repaint (null when the level has none). `toggle`: flip a switch
 * (null in a sub-simulation, which the editor does not drive).
 */
export function decorateInside(svg: SVGSVGElement, ctx: { sim: Sim; node: HierNode; def: ComponentDef }, toggle: ((node: HierNode, bit: number) => void) | null): (() => void) | null {
  const faces: { face: IoFace; name: string }[] = [];
  for (const inst of netlistOf(ctx.def)?.instances ?? []) {
    if (!ioInfo(inst.def)) continue;
    const g = svg.querySelector(`[data-inst="${CSS.escape(inst.name)}"]`);
    const node = ctx.node.children?.get(inst.name) ?? null;
    const face = drawIoFace(inst.def, !!inst.flip, toggle && node ? (bit) => toggle(node, bit) : undefined);
    if (!g || !face) continue;
    g.append(face.g);
    faces.push({ face, name: inst.name });
  }
  if (!faces.length) return null;
  return () => { for (const f of faces) f.face.paint(ctx.sim, ctx.node.children?.get(f.name) ?? null); };
}
