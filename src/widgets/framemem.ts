// Chapters 32–33: every memory the graphics hardware keeps, shown live in the screen panels. The two frames (which one
// is front, which back), the depth buffer, and what the back frame holds while it is rebuilt. Its pixels are dimmed until
// something writes them after the flip that made it the back frame. Then who writes it this cycle, and a filmstrip of
// the frame being rebuilt (before, after the clear, after each triangle, on screen).
//
// Writes are watched where they happen: the framebuffer's write port (fb.we / fb.wa) at every rising edge, the
// rasterizer's pixel output before the depth test (rast.fwe) and its clear flag (rast.fclr, held for the whole job).
// The pictures are read from the memory leaves (fb.fb<k>.bank<j>, rop.zbuf). Every scene with a screen uses these
// instance names: displayTop, GPU30, GPU30Z, gpu31. gpu31's faster clear (step 5) clears with its clear unit (clear.busy,
// clear.ca), a word a write (fb.wall: four pixels), into a depth buffer in four banks (rop.zbuf0 … zbuf3).

import { FB_W, rgb332 } from '../gfx/raster';
import { FB_WORDS } from '../lib/raster';
import { ramLeafState } from '../lib/bigmem';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import type { Bit } from '../sim/types';
import { h } from '../ui/dom';
import type { Stage } from '../view/stage';
import type { ScanCapture } from './screen';

const W = FB_W, N = W * W;
const kid = (n: HierNode, ...p: string[]) => p.reduce<HierNode | undefined>((x, k) => x?.children?.get(k), n);
const val = (sim: Sim, nets: number[]) => sim.getBits(nets).reduce((v: number, b: Bit, i) => v + (b === 1 ? 2 ** i : 0), 0);
/** A pixel written this long ago (cycles) has stopped glowing. */
const GLOW = 800;
/** Pictures kept in a frame's filmstrip. */
const FILM_MAX = 16;

/** Frame k's pixels from its memory leaves (null when it is not simulated as a lookup). */
export function frameOf(sim: Sim, k: number): Uint8Array | null {
  const fb = kid(sim.design.root, 'fb', `fb${k}`);
  const out = new Uint8Array(N);
  for (let j = 0; j < 4; j++) {
    const st = ramLeafState(sim, kid(fb!, `bank${j}`));
    if (!st) return null;
    for (let a = 0; a < FB_WORDS; a++) out[4 * a + j] = st.x[a] ? 0 : st.mem[a];
  }
  return out;
}

/** The depth buffer (16 bits a pixel), or null without one: one memory, or four banks (pixel x mod 4). */
export function depthOf(sim: Sim): Uint16Array | null {
  const out = new Uint16Array(N);
  const st = ramLeafState(sim, kid(sim.design.root, 'rop', 'zbuf'));
  if (st) {
    for (let i = 0; i < N; i++) out[i] = st.x[i] ? 0xffff : st.mem[i];
    return out;
  }
  for (let j = 0; j < 4; j++) {
    const b = ramLeafState(sim, kid(sim.design.root, 'rop', `zbuf${j}`));
    if (!b) return null;
    for (let a = 0; a < FB_WORDS; a++) out[4 * a + j] = b.x[a] ? 0xffff : b.mem[a];
  }
  return out;
}

/** gpu31's clear unit at work: the word it clears (null: no clear unit, or idle). */
function clearWord(sim: Sim): number | null {
  const c = kid(sim.design.root, 'clear');
  return c && sim.getBits(c.ports.busy)[0] === 1 ? val(sim, c.ports.ca) : null;
}

export type MemId = 'screen' | 'f0' | 'f1' | 'z';
type Hue = 'draw' | 'wait' | 'kernel' | 'scan';
export interface WriterRow { unit: string; hue: Hue; text: string }

export interface FrameMemOptions {
  /** A rasterizer writes the back frame (else the frames are fixed pictures: chapter 32, step 1). */
  gpu: boolean;
  /** A depth buffer behind the rasterizer. */
  depth: boolean;
  /** More units to list (chapter 33: the command unit, the warp core), between the ROP and the scan-out. */
  rows?: (sim: Sim) => WriterRow[];
}

interface Still { label: string; px: Uint8Array; fresh: Uint8Array | null }

/** One frame's worth of tracking, saved and restored with the simulation (Back). */
interface Track {
  /** The front frame (−1: not seen yet). */
  front: number;
  /** Per frame: pixel written since that frame became the back frame. */
  fresh: [Uint8Array, Uint8Array];
  /** Cycle of each pixel's last drawn (not cleared) write, −∞ when none. */
  glowAt: Float64Array;
  written: number;
  failed: number;
  /** Triangles started since the flip. */
  tris: number;
  busy: boolean;
  jobStart: number;
  jobClear: boolean;
  /** The frame being rebuilt, and the last one finished. */
  film: Still[];
  last: Still[];
  elided: number;
}

const freshTrack = (): Track => ({
  front: -1, fresh: [new Uint8Array(N), new Uint8Array(N)], glowAt: new Float64Array(N).fill(-Infinity),
  written: 0, failed: 0, tris: 0, busy: false, jobStart: 0, jobClear: false, film: [], last: [], elided: 0,
});

/** RGB332 (or depth) pixels into an image, the back frame's unwritten pixels dimmed and striped, fresh draws glowing. */
function toImage(im: ImageData, px: ArrayLike<number>, o: { depth?: boolean; fresh?: Uint8Array | null; glowAt?: Float64Array; now?: number }): void {
  const d = im.data;
  for (let i = 0; i < N; i++) {
    let r: number, g: number, b: number;
    if (o.depth) { const k = px[i] >= 0xffff ? 0 : 255 - (px[i] >> 8); r = g = b = k; }
    else [r, g, b] = rgb332(px[i]);
    if (o.fresh && !o.fresh[i]) {
      // still what the frame held before: not written since it became the back frame
      const s = (((i % W) + ((i / W) | 0)) & 3) === 0 ? 46 : 0;
      r = r * 0.32 + s; g = g * 0.32 + s; b = b * 0.32 + s * 1.2;
    }
    if (o.glowAt && o.now !== undefined) {
      const age = o.now - o.glowAt[i];
      if (age < GLOW) { const k = 0.75 * (1 - age / GLOW); r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    }
    d[4 * i] = r; d[4 * i + 1] = g; d[4 * i + 2] = b; d[4 * i + 3] = 255;
  }
}

export class FrameMemory {
  sel: MemId = 'screen';
  readonly el: HTMLElement;
  private t = freshTrack();
  private strip: HTMLElement;
  private thumbs = new Map<MemId, { btn: HTMLButtonElement; cv: HTMLCanvasElement; badge: HTMLElement; who: HTMLElement }>();
  private writer: HTMLElement;
  private filmEl: HTMLElement;
  private filmHead: HTMLElement;
  private filmShown: Still[] | null = null;
  private off = document.createElement('canvas');
  private im: ImageData;

  constructor(private stage: Stage, private cap: ScanCapture, private opts: FrameMemOptions, private onSelect: () => void) {
    this.off.width = this.off.height = W;
    this.im = this.off.getContext('2d')!.createImageData(W, W);
    const ids: [MemId, string, string][] = [
      ['screen', 'Screen', 'what the scan-out has sent to the screen'],
      ['f0', 'Frame 0', 'frame 0 in memory: front (sent to the screen) or back (drawn into)'],
      ['f1', 'Frame 1', 'frame 1 in memory'],
      ...(opts.depth ? [['z', 'Depth', 'the depth buffer: 16 bits a pixel, near bright, far (cleared) black'] as [MemId, string, string]] : []),
    ];
    this.strip = h('div', { class: 'gfx-mem-strip', style: `grid-template-columns: repeat(${ids.length}, minmax(0, 1fr))`, role: 'group', 'aria-label': 'memories: click one to show it large' });
    for (const [id, name, title] of ids) {
      const cv = h('canvas', { width: W, height: W }) as HTMLCanvasElement;
      const badge = h('span', { class: 'gfx-mem-badge' }), who = h('span', { class: 'gfx-mem-who' });
      const btn = h('button', { class: 'gfx-mem-thumb', type: 'button', title }, cv, h('span', { class: 'gfx-mem-name' }, h('span', null, name), badge), who) as HTMLButtonElement;
      btn.addEventListener('click', () => { this.sel = id; this.onSelect(); });
      this.strip.append(btn);
      this.thumbs.set(id, { btn, cv, badge, who });
    }
    this.writer = h('div', { class: 'gfx-mem-writer', 'aria-live': 'off' });
    this.filmEl = h('div', { class: 'gfx-film' });
    this.filmHead = h('span');
    const film = h('details', { class: 'gfx-mem-fold', open: true }, h('summary', null, this.filmHead), h('div', { class: 'gfx-film-wrap' }, this.filmEl));
    this.el = h('div', { class: 'gfx-mem' },
      h('div', { class: 'cpu-sec' }, 'Memory · click one to show it large'), this.strip,
      ...(opts.gpu ? [this.writer, film] : [this.writer]));

    stage.edgeHooks.add({ before: () => this.watch() });
    stage.historyHooks.add({
      save: () => ({ ...this.t, fresh: [this.t.fresh[0].slice(), this.t.fresh[1].slice()], glowAt: this.t.glowAt.slice(), film: this.t.film.slice() }),
      restore: (s) => {
        const v = s as Track;
        this.t = { ...v, fresh: [v.fresh[0].slice(), v.fresh[1].slice()], glowAt: v.glowAt.slice(), film: v.film.slice() };
      },
    });
    stage.resetHooks.add(() => { this.t = freshTrack(); });
  }

  /** Before every rising edge: what this edge writes, and the epoch boundaries (a flip, a job starting or ending). */
  private watch(): void {
    const sim = this.stage.sim;
    if (!sim) return;
    const root = sim.design.root, t = this.t, now = this.stage.cycles;
    const front = val(sim, kid(root, 'scan')!.ports.front);
    if (front !== t.front) this.flip(sim, front);
    if (!this.opts.gpu) return;
    const fb = kid(root, 'fb')!, rast = kid(root, 'rast')!;
    const wordClear = clearWord(sim) !== null;
    const busy = sim.getBits(rast.ports.busy)[0] === 1 || wordClear;
    const clr = wordClear || (this.opts.depth && sim.getBits(rast.ports.fclr)[0] === 1);
    if (busy && !t.busy) { t.jobStart = now; t.jobClear = clr; if (!clr) t.tris++; }
    if (sim.getBits(fb.ports.we)[0] === 1) {
      const a = val(sim, fb.ports.wa);
      // the clear unit's write is a whole word: four pixels
      const n = fb.ports.wall && sim.getBits(fb.ports.wall)[0] === 1 ? 4 : 1;
      for (let i = 0; i < n; i++) t.fresh[1 - front][a + i] = 1;
      if (!t.jobClear) { t.glowAt[a] = now; t.written++; }
    } else if (sim.getBits(rast.ports.fwe)[0] === 1) t.failed++;
    if (!busy && t.busy) {
      // a back face stops after three set-up cycles, before writing anything
      const culled = !t.jobClear && now - t.jobStart <= 4;
      this.still(sim, t.jobClear ? 'cleared' : culled ? `tri ${t.tris} culled` : `tri ${t.tris}`);
    }
    t.busy = busy;
  }

  /** The front frame changed (or is seen for the first time): the frame being rebuilt starts again. */
  private flip(sim: Sim, front: number): void {
    const t = this.t;
    // the frame just finished is the new front
    if (this.opts.gpu && t.front >= 0 && t.film.length > 1) {
      const px = frameOf(sim, front);
      t.last = px ? [...t.film, { label: 'on screen', px, fresh: null }] : t.film;
    }
    t.front = front;
    if (this.opts.gpu) {
      t.fresh[1 - front].fill(0);
      t.written = 0; t.failed = 0; t.tris = 0; t.elided = 0;
      t.film = [];
      this.still(sim, 'before');
    }
  }

  private still(sim: Sim, label: string): void {
    const t = this.t, back = 1 - t.front;
    const px = frameOf(sim, back);
    if (!px) return;
    // keep the first two (before, the clear) and the latest ones
    if (t.film.length >= FILM_MAX - 1) { t.film.splice(2, 1); t.elided++; }
    t.film.push({ label, px, fresh: t.fresh[back].slice() });
  }

  private paint(cv: HTMLCanvasElement, id: Exclude<MemId, 'screen'>, sim: Sim): boolean {
    const t = this.t, back = 1 - Math.max(0, t.front);
    const isBack = this.opts.gpu && id === `f${back}`;
    const px = id === 'z' ? depthOf(sim) : frameOf(sim, id === 'f0' ? 0 : 1);
    if (!px) return false;
    toImage(this.im, px, { depth: id === 'z', fresh: isBack ? t.fresh[back] : null, glowAt: isBack ? t.glowAt : undefined, now: this.stage.cycles });
    this.off.getContext('2d')!.putImageData(this.im, 0, 0);
    const c = cv.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.off, 0, 0, cv.width, cv.height);
    const S = cv.width / W;
    if (id === `f${t.front}`) {
      // the scan-out's row
      const y = Math.floor((4 * this.cap.addr()) / W);
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(0, y * S, cv.width, S);
    }
    if (isBack || id === 'z') {
      const wk = kid(sim.design.root, 'rast', 'walk');
      if (wk && val(sim, wk.ports.busy)) {
        const x = val(sim, wk.ports.x), y = val(sim, wk.ports.y);
        c.strokeStyle = 'rgba(255,255,255,0.95)';
        c.lineWidth = Math.max(1, S / 4);
        c.strokeRect((x & ~3) * S + 0.5, (y & ~3) * S + 0.5, 4 * S - 1, 4 * S - 1);
        c.lineWidth = 1;
      }
    }
    return true;
  }

  /** The selected memory into the panel's large canvas (not the screen: the panel paints that); its caption. */
  paintLarge(cv: HTMLCanvasElement): string {
    const sim = this.stage.sim;
    if (!sim || this.sel === 'screen') return '';
    this.paint(cv, this.sel, sim);
    const t = this.t;
    if (this.sel === 'z') return 'Depth buffer: near bright, far black';
    const k = this.sel === 'f0' ? 0 : 1;
    return k === t.front ? `Frame ${k} · FRONT: the scan-out sends it` : this.opts.gpu ? `Frame ${k} · BACK: being rebuilt` : `Frame ${k} · waiting for a swap`;
  }

  /** The back frame's pixels are all still from before the flip, and nothing is drawing. */
  backUntouched(): boolean { return this.t.front >= 0 && !this.t.busy && !this.t.fresh[1 - this.t.front].some((v) => v); }

  update(): void {
    const sim = this.stage.sim;
    if (!sim) return;
    const t = this.t, root = sim.design.root, front = Math.max(0, t.front);
    const row = Math.floor((4 * this.cap.addr()) / W);
    const wk = this.opts.gpu ? kid(root, 'rast', 'walk') : undefined;
    const cw = this.opts.gpu ? clearWord(sim) : null;
    const busy = !!wk && val(sim, wk.ports.busy) === 1;
    const clr = cw !== null || (busy && this.opts.depth && sim.getBits(kid(root, 'rast')!.ports.fclr)[0] === 1);
    for (const [id, th] of this.thumbs) {
      th.btn.classList.toggle('on', id === this.sel);
      if (id === 'screen') {
        this.cap.paint(th.cv);
        th.badge.className = 'gfx-mem-badge';
        th.badge.textContent = 'sent';
        th.who.textContent = `${this.cap.frames} frame${this.cap.frames === 1 ? '' : 's'} sent`;
        continue;
      }
      this.paint(th.cv, id, sim);
      if (id === 'z') {
        th.badge.className = 'gfx-mem-badge';
        th.badge.textContent = '16 bit';
        th.who.textContent = clr ? 'clearing: far' : busy ? 'ROP: depth test' : 'kept';
      } else if (id === `f${front}`) {
        th.badge.className = 'gfx-mem-badge front';
        th.badge.textContent = 'FRONT';
        th.who.textContent = `scan-out, row ${row}`;
      } else {
        th.badge.className = 'gfx-mem-badge back';
        th.badge.textContent = 'BACK';
        th.who.textContent = !this.opts.gpu ? 'waits for a swap' : cw !== null ? `clear unit: word ${cw}` : clr ? 'rasterizer: clear' : busy ? 'rasterizer: drawing' : 'idle';
      }
    }

    const rows: WriterRow[] = [];
    if (this.opts.gpu && wk) {
      const s = val(sim, wk.ports.s), x = val(sim, wk.ports.x), y = val(sim, wk.ports.y);
      const what = clr ? 'clear' : `triangle ${t.tris}`;
      if (kid(root, 'clear')) {
        rows.push({ unit: 'Clear unit', hue: 'draw', text: cw === null ? 'idle' : `word ${cw} of ${FB_WORDS}: pixels ${4 * cw} – ${4 * cw + 3} and their depths, at once` });
      }
      rows.push({
        unit: 'Rasterizer', hue: 'draw',
        text: !busy ? 'idle'
          : s >= 1 && s <= 8 ? `${what}: set-up${this.opts.depth && s === 8 ? ' (depth plane: the division)' : `, cycle ${s}`}`
          : s === 9 ? `${what}: tile (${x >> 2}, ${y >> 2}), test`
          : `${what}: tile (${x >> 2}, ${y >> 2}), pixel (${x}, ${y})`,
      });
      rows.push({
        unit: this.opts.depth ? 'Depth · blend' : 'Framebuffer',
        hue: 'draw',
        text: `${t.written.toLocaleString('en')} pixel${t.written === 1 ? '' : 's'} drawn since the flip`
          + (t.failed ? `, ${t.failed.toLocaleString('en')} failed the depth test` : ''),
      });
    }
    rows.push(...(this.opts.rows?.(sim) ?? []));
    rows.push({ unit: 'Scan-out', hue: 'scan', text: `sending frame ${front}, row ${row}` });
    this.writer.replaceChildren(...rows.flatMap((r) => [
      h('span', { class: 'k' }, h('i', { class: `gfx-dot ${r.hue}` }), r.unit), h('span', { class: 'v' }, r.text)]));

    if (this.opts.gpu) {
      const film = t.film.length > 1 || !t.last.length ? t.film : t.last;
      const live = film === t.film;
      this.filmHead.textContent = live ? `This frame, rebuilt${t.elided ? ` · ${t.elided} earlier triangles not shown` : ''}` : 'The last frame, rebuilt';
      if (film !== this.filmShown || film.length !== this.filmEl.childElementCount) {
        this.filmShown = film;
        this.filmEl.replaceChildren(...film.map((f) => {
          const cv = h('canvas', { width: W, height: W }) as HTMLCanvasElement;
          toImage(this.im, f.px, { fresh: f.fresh });
          cv.getContext('2d')!.putImageData(this.im, 0, 0);
          return h('figure', null, cv, h('figcaption', null, f.label));
        }));
        if (!film.length) this.filmEl.append(h('span', { class: 'gfx-film-empty' }, 'The back frame at each step appears here as it is drawn.'));
      }
    }
  }
}
