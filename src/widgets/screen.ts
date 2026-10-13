// Chapter 30 widgets: the screen panel (what the scan-out sends, or the back frame being drawn, with the
// rasterizer's position), the scenes it sits in (the display alone, the rasterizer drawing into it) and the
// edge-function explorer.

import { type DrawOp, FB_W, rasterize, type Vtx } from '../gfx/raster';
import { displayTop, FB_WORDS, GPU30, GPU30Z, VERTEX_PINS } from '../lib/raster';
import { ramLeafState } from '../lib/bigmem';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import type { Bit } from '../sim/types';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

const W = FB_W;
const kid = (n: HierNode, ...p: string[]) => p.reduce<HierNode | undefined>((x, k) => x?.children?.get(k), n);
/** A port's value, X bits read as 0. */
const val = (sim: Sim, nets: number[]) => sim.getBits(nets).reduce((v: number, b: Bit, i) => v + (b === 1 ? 2 ** i : 0), 0);

/** RGB332 → CSS rgb components. */
export function rgb332(v: number): [number, number, number] {
  return [Math.round(((v >> 5) & 7) * 255 / 7), Math.round(((v >> 2) & 7) * 255 / 7), Math.round((v & 3) * 255 / 3)];
}
const grey332 = (k: number) => (k << 5) | (k << 2) | (k >> 1);

/** Frame 0 of the first scene: colour bars over a grey ramp. */
function barsPicture(): Uint8Array {
  const bars = [0xff, 0xfc, 0x1f, 0x1c, 0xe3, 0xe0, 0x03, 0x00];
  const p = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) p[y * W + x] = y < 48 ? bars[x >> 3] : grey332(x >> 3);
  return p;
}

/** Frame 1: rings around the centre. */
function ringsPicture(): Uint8Array {
  const cols = [0xe0, 0xfc, 0x1c, 0x1f, 0x03, 0xe3];
  const p = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) p[y * W + x] = cols[Math.floor(Math.hypot(x - 31.5, y - 31.5) / 4) % cols.length];
  return p;
}

export interface TrianglePreset { id: string; title: string; v: Vtx[]; col: number }

export const TRIANGLES: TrianglePreset[] = [
  { id: 'large', title: 'A large triangle', v: [[20, 12], [230, 70], [90, 240]], col: 0xe3 },
  { id: 'sliver', title: 'A thin sliver', v: [[8, 16], [248, 224], [232, 248]], col: 0x1f },
  { id: 'small', title: 'A small one', v: [[100, 100], [140, 110], [115, 150]], col: 0xfc },
  { id: 'back', title: 'The large one, wound the other way', v: [[20, 12], [90, 240], [230, 70]], col: 0xe0 },
];

const presetInputs = (t: TrianglePreset): Record<string, number> =>
  Object.fromEntries([...VERTEX_PINS.map((p, k) => [p, t.v[k >> 1][k & 1]]), ['col', t.col]]);

/** Step 1: two pictures in memory, the scan-out, flips on request. */
export function displayScene(): Scene {
  return {
    root: displayTop(barsPicture(), ringsPicture()),
    inputs: { swap: 0, sync: 1, clk: 0 }, highlight: ['scan'], autoClock: false,
    panels: [screenPanel({ gpu: false })],
  };
}

/** Steps 2–3: the rasterizer drawing into the back frame while the scan-out shows the front one. */
export function gpuScene(preset = 'large', highlight: string[] = ['rast']): Scene {
  const t = TRIANGLES.find((x) => x.id === preset) ?? TRIANGLES[0];
  return {
    root: GPU30,
    inputs: { ...presetInputs(t), go: 0, swap: 0, sync: 1, clk: 0 }, highlight, autoClock: false,
    panels: [screenPanel({ gpu: true })],
  };
}

/** A sequence of draws the panel plays (each waits for the rasterizer), then a swap. */
export interface DrawScript { id: string; title: string; ops: DrawOp[] }

const CLEAR: DrawOp = { clr: true, v: [[0, 0], [0, 0], [0, 0]], col: 0x25 };
/** Two triangles that cross in depth: red is near at the top, far at the bottom; green the other way round. */
const RED: DrawOp = { v: [[20, 20], [240, 60], [40, 230]], z: [20, 20, 220], col: 0xe0, zt: true };
const GREEN: DrawOp = { v: [[230, 20], [200, 240], [10, 120]], z: [220, 60, 30], col: 0x1c, zt: true };
/** Opaque red, and a blue at three eighths over it. */
const BLUE: DrawOp = { v: [[100, 4], [250, 250], [4, 180]], z: [0, 0, 0], col: 0x03, a: 2, zt: false };
const OPAQUE_RED: DrawOp = { ...RED, zt: false };

export const DEPTH_SCRIPTS: DrawScript[] = [
  { id: 'rg', title: 'Clear, red, then green', ops: [CLEAR, RED, GREEN] },
  { id: 'gr', title: 'Clear, green, then red', ops: [CLEAR, GREEN, RED] },
  { id: 'off', title: 'Depth test off: green, then red', ops: [CLEAR, { ...GREEN, zt: false }, { ...RED, zt: false }] },
];
export const BLEND_SCRIPTS: DrawScript[] = [
  { id: 'rb', title: 'Clear, red, then blue at 3/8', ops: [CLEAR, OPAQUE_RED, BLUE] },
  { id: 'br', title: 'Clear, blue at 3/8, then red', ops: [CLEAR, BLUE, OPAQUE_RED] },
];

const opInputs = (op: DrawOp): Record<string, number> => Object.fromEntries([
  ...VERTEX_PINS.map((p, k) => [p, op.v[k >> 1][k & 1]]), ['col', op.col],
  ['z0', op.z?.[0] ?? 0], ['z1', op.z?.[1] ?? 0], ['z2', op.z?.[2] ?? 0], ['a', op.a ?? 7], ['zt', op.zt ? 1 : 0], ['clr', op.clr ? 1 : 0]]);

/** Steps 4–5: the rasterizer with depth and the ROP; the panel plays the scripts. */
export function depthScene(kind: 'depth' | 'blend'): Scene {
  const scripts = kind === 'depth' ? DEPTH_SCRIPTS : BLEND_SCRIPTS;
  return {
    root: GPU30Z,
    inputs: { ...opInputs(scripts[0].ops[1]), go: 0, swap: 0, sync: 1, clk: 0 },
    highlight: kind === 'depth' ? ['rop', 'rast'] : ['rop'], autoClock: false,
    panels: [screenPanel({ gpu: true, scripts })],
  };
}

interface PanelOpts { gpu: boolean; scripts?: DrawScript[] }

/**
 * What the screen shows: the last frame the scan-out sent (RGB332) and which pixels it has sent at all, sampled at
 * every rising edge from the root's `pixels` at the scan-out's word address; vsync pulses counted. Back restores it.
 */
export class ScanCapture {
  shown = new Uint8Array(W * W);
  seen = new Uint8Array(W * W);
  frames = 0;
  constructor(private stage: Stage, onRestore?: () => void) {
    stage.edgeHooks.add({
      before: () => {
        const sim = stage.sim;
        if (!sim) return;
        const root = sim.design.root, a = this.addr();
        const bits = sim.getBits(root.ports.pixels);
        for (let j = 0; j < 4; j++) {
          let v = 0, known = true;
          for (let i = 0; i < 8; i++) { const b = bits[8 * j + i]; if (b === 1) v |= 1 << i; else if (b !== 0) known = false; }
          this.shown[4 * a + j] = v;
          this.seen[4 * a + j] = known ? 1 : 0;
        }
        if (val(sim, root.ports.vsync)) this.frames++;
      },
    });
    stage.historyHooks.add({
      save: () => ({ shown: this.shown.slice(), seen: this.seen.slice(), frames: this.frames }),
      restore: (st) => {
        const v = st as { shown: Uint8Array; seen: Uint8Array; frames: number };
        onRestore?.();
        this.shown = v.shown.slice(); this.seen = v.seen.slice(); this.frames = v.frames;
      },
    });
    stage.resetHooks.add(() => { onRestore?.(); this.forget(); this.frames = 0; });
  }

  /** Forget what was sent (the screen goes grey until the scan-out sends it again). */
  forget(): void { this.shown.fill(0); this.seen.fill(0); }

  /** Nothing but black (or nothing at all) has reached the screen. */
  blank(): boolean { return this.shown.every((v) => v === 0); }

  /** A note over the picture, centred (the screen is blank: say why and what to do). */
  note(cv: HTMLCanvasElement, lines: string[]): void {
    const c = cv.getContext('2d')!, lh = 17, y0 = cv.height / 2 - ((lines.length - 1) * lh) / 2;
    c.font = '13px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(255,255,255,0.75)';
    lines.forEach((t, i) => c.fillText(t, cv.width / 2, y0 + i * lh));
  }

  /** The word the scan-out reads now. */
  addr(): number {
    const sim = this.stage.sim, sc = sim && kid(sim.design.root, 'scan');
    return sim && sc ? val(sim, sc.ports.ra) : 0;
  }

  /** Draw a 64 × 64 picture (src, else what was sent) into cv, scaled up without smoothing; pixels never sent are grey. */
  paint(cv: HTMLCanvasElement, src?: Uint8Array | null): void {
    const off = document.createElement('canvas');
    off.width = off.height = W;
    const ctx = off.getContext('2d')!, im = ctx.createImageData(W, W);
    const p = src ?? this.shown;
    for (let i = 0; i < W * W; i++) {
      const [r, g, b] = src || this.seen[i] ? rgb332(p[i]) : [40, 44, 56];
      im.data.set([r, g, b, 255], 4 * i);
    }
    ctx.putImageData(im, 0, 0);
    const c = cv.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.drawImage(off, 0, 0, cv.width, cv.height);
  }

  /** The beam: the row the scan-out reads now, and its word. */
  beam(cv: HTMLCanvasElement): void {
    const c = cv.getContext('2d')!, S = cv.width / W, a = this.addr(), y = Math.floor((4 * a) / W), x = (4 * a) % W;
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(0, y * S, cv.width, S);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.strokeRect(x * S + 0.5, y * S + 0.5, 4 * S - 1, S - 1);
  }
}

/** The back frame's pixels, from the memory leaves (null when the frame is not simulated as a lookup). */
export function backFrame(sim: Sim): Uint8Array | null {
  const front = val(sim, kid(sim.design.root, 'scan')!.ports.front), fb = kid(sim.design.root, 'fb', `fb${front ? 0 : 1}`);
  const out = new Uint8Array(W * W);
  for (let j = 0; j < 4; j++) {
    const st = ramLeafState(sim, kid(fb!, `bank${j}`));
    if (!st) return null;
    for (let a = 0; a < FB_WORDS; a++) out[4 * a + j] = st.x[a] ? 0 : st.mem[a];
  }
  return out;
}

function screenPanel(opts: PanelOpts): ScenePanel {
  return (stage: Stage): Widget => {
    let view: 'screen' | 'back' = 'screen';
    let running: number | null = null, rate = 0;
    /** Cycles a second (0: as fast as the simulation goes). */
    let cap = opts.gpu ? 0 : 1024;
    const speed = h('select', { 'aria-label': 'speed' }, ...[[0, 'As fast as it goes'], [4096, '4 frames a second'], [1024, '1 frame a second'], [128, '1 frame in 8 s']]
      .map(([v, t]) => h('option', { value: String(v) }, String(t)))) as HTMLSelectElement;
    speed.value = String(cap);
    speed.addEventListener('change', () => { cap = Number(speed.value); });
    const cv = h('canvas', { class: 'gfx-screen', width: 256, height: 256, 'aria-label': 'the screen' }) as HTMLCanvasElement;
    const status = h('div', { class: 'cpu-status' });
    const runBtn = h('button', { class: 'btn sm primary' }, 'Run');
    const frameBtn = h('button', { class: 'btn sm', title: 'run until the scan-out has sent one whole frame' }, 'One frame');
    const viewSel = h('select', { 'aria-label': 'view' }, h('option', { value: 'screen' }, 'Screen: what the scan-out sent'),
      h('option', { value: 'back' }, 'Back frame: being drawn')) as HTMLSelectElement;
    const sync = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const node = (sim: Sim, ...p: string[]) => kid(sim.design.root, ...p);

    const stop = () => { if (running) cancelAnimationFrame(running); running = null; runBtn.textContent = 'Run'; };
    const cap0 = new ScanCapture(stage, stop);
    /** Draws still to start, and a swap after them. */
    let queue: DrawOp[] = [], swapAfter = false;
    const busyNow = () => { const sim = stage.sim; return !!sim && sim.design.root.ports.busy !== undefined && val(sim, sim.design.root.ports.busy) === 1; };
    const pump = () => {
      if (busyNow()) return;
      const op = queue.shift();
      if (op) {
        stage.setInputs({ ...opInputs(op), go: 1 });
        stage.runCycles(1);
        stage.setInput('go', 0);
      } else if (swapAfter) {
        swapAfter = false;
        pulse('swap');
      }
    };
    const pending = () => (queue.length > 0 || swapAfter) && !busyNow();
    stage.resetHooks.add(() => { queue = []; swapAfter = false; });
    const runFor = (until: () => boolean) => {
      if (running) return stop();
      stage.checkpoint();
      runBtn.textContent = 'Pause';
      let last = performance.now(), owed = 0;
      // as fast as it goes: cycles for ~12 ms of each frame, then one redraw (a redraw costs as much as many cycles)
      const tick = () => {
        const t0 = performance.now(), deadline = t0 + 12;
        let want = 1e7;
        if (cap) {
          owed += (cap * (t0 - last)) / 1000;
          want = Math.min(Math.floor(owed), 8192);
          owed -= want;
        }
        last = t0;
        if (queue.length || swapAfter) pump();
        const n = want > 0 ? stage.runCycles(want, () => until() || pending() || performance.now() > deadline) : 0;
        const dt = performance.now() - t0;
        if (cap) rate = cap;
        else if (n > 0 && dt > 0) rate = Math.round((n * 1000) / Math.max(dt, 16.7));
        if (until()) return stop();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    };
    runBtn.addEventListener('click', () => runFor(() => false));
    frameBtn.addEventListener('click', () => {
      stop();
      const f = cap0.frames;
      runFor(() => cap0.frames > f);
    });
    viewSel.addEventListener('change', () => { view = viewSel.value as typeof view; paint(); });
    sync.addEventListener('change', () => stage.setInput('sync', sync.checked ? 1 : 0));
    const pulse = (port: string) => {
      stage.setInput(port, 1);
      stage.runCycles(1);
      stage.setInput(port, 0);
    };
    const front = () => { const sim = stage.sim; return sim ? val(sim, node(sim, 'scan')!.ports.front) : 0; };
    const swapBtn = h('button', { class: 'btn sm', title: 'ask the scan-out to show the other frame (paused: run until it has sent it)' }, 'Swap');
    swapBtn.addEventListener('click', () => {
      const f0 = front();
      pulse('swap');
      if (running) return;
      // paused: run until the flip (at vsync when waiting for it) and one whole frame of the other picture sent
      let sent = front() !== f0 ? cap0.frames : -1;
      runFor(() => {
        if (sent < 0 && front() !== f0) sent = cap0.frames;
        return sent >= 0 && cap0.frames > sent;
      });
    });
    const resetSel = h('select', { class: 'gfx-reset', 'aria-label': 'reset', title: 'reset options' }, h('option', { value: '' }, 'Reset…'),
      h('option', { value: 'power' }, opts.gpu ? 'Power-cycle: both frames blank' : 'Power-cycle: back to the first frame'),
      h('option', { value: 'forget' }, 'Forget what the screen showed'),
      ...(opts.scripts ? [h('option', { value: 'clear' }, 'Clear the back frame')] : [])) as HTMLSelectElement;
    resetSel.addEventListener('change', () => {
      const k = resetSel.value;
      resetSel.value = '';
      if (k === 'power') stage.powerCycle();
      else if (k === 'forget') { cap0.forget(); paint(); }
      else if (k === 'clear') { queue = [CLEAR]; swapAfter = false; if (!running) runFor(() => !queue.length && !busyNow()); }
    });

    const controls: HTMLElement[] = [runBtn, frameBtn, swapBtn, resetSel, h('label', { class: 'gfx-check', title: 'flip only at vsync, between two frames' }, sync, 'wait for vsync')];
    let triSel: HTMLSelectElement | null = null;
    if (opts.scripts) {
      const scripts = opts.scripts;
      triSel = h('select', { 'aria-label': 'draws' }, ...scripts.map((t) => h('option', { value: t.id }, t.title))) as HTMLSelectElement;
      const playBtn = h('button', { class: 'btn sm', title: 'draw these triangles one after the other into the back frame, then swap' }, 'Draw these');
      playBtn.addEventListener('click', () => {
        queue = [...scripts.find((t) => t.id === triSel!.value)!.ops];
        swapAfter = true;
        if (!running) runFor(() => false);
      });
      controls.splice(2, 1, playBtn);
    } else if (opts.gpu) {
      const drawBtn = h('button', { class: 'btn sm', title: 'start the rasterizer on the triangle at its inputs' }, 'Draw');
      drawBtn.addEventListener('click', () => {
        pulse('go');
        // paused: run until the rasterizer is done (a back face stops after its set-up)
        if (!running) runFor(() => !busyNow());
      });
      triSel = h('select', { 'aria-label': 'triangle' }, ...TRIANGLES.map((t) => h('option', { value: t.id }, t.title))) as HTMLSelectElement;
      triSel.addEventListener('change', () => stage.setInputs(presetInputs(TRIANGLES.find((t) => t.id === triSel!.value)!)));
      controls.splice(2, 0, drawBtn);
    }

    const paint = () => {
      const sim = stage.sim;
      if (!sim) return;
      cap0.paint(cv, view === 'back' && opts.gpu ? backFrame(sim) : null);
      const c = cv.getContext('2d')!, S = cv.width / W;
      if (view === 'screen' || !opts.gpu) cap0.beam(cv);
      else {
        // where the rasterizer is: its tile and pixel
        const wk = node(sim, 'rast', 'walk');
        if (wk && val(sim, wk.ports.busy)) {
          const x = val(sim, wk.ports.x), y = val(sim, wk.ports.y), s = val(sim, wk.ports.s);
          c.strokeStyle = 'rgba(255,255,255,0.9)';
          c.strokeRect((x & ~3) * S + 0.5, (y & ~3) * S + 0.5, 4 * S - 1, 4 * S - 1);
          if (s === 10) { c.fillStyle = 'rgba(255,255,255,0.7)'; c.fillRect(x * S, y * S, S, S); }
        }
      }
      const fr = val(sim, node(sim, 'scan')!.ports.front);
      const rb = node(sim, 'rast', 'walk');
      const busy = rb ? val(sim, rb.ports.busy) === 1 : false;
      // a black screen looks broken: say what it is and what to do
      if (opts.gpu) {
        const back = backFrame(sim), backBlank = !back || back.every((v) => v === 0);
        if (view === 'screen' && cap0.blank()) {
          cap0.note(cv, busy || queue.length ? ['The front frame is blank.', 'The rasterizer is drawing', 'into the back frame.']
            : !backBlank ? ['The front frame is blank.', 'The back frame holds a picture:', 'Swap to show it.']
            : opts.scripts ? ['The front frame is blank.', 'Draw these: the triangles, then a swap.'] : ['The front frame is blank.', 'Draw, then Swap.']);
        } else if (view === 'back' && backBlank && !busy) cap0.note(cv, ['The back frame is blank.', opts.scripts ? 'Draw these to fill it.' : 'Draw to fill it.']);
      }
      status.replaceChildren(
        h('span', null, `cycle ${stage.cycles}`),
        h('span', { title: 'vsync pulses so far: the scan-out sends a frame every ' + FB_WORDS + ' cycles' }, `${cap0.frames} frame${cap0.frames === 1 ? '' : 's'} sent`),
        h('span', null, `front: frame ${fr}`),
        ...(opts.gpu ? [h('span', { class: busy ? 'warn' : '' }, busy ? 'rasterizer busy' : 'rasterizer idle')] : []),
        ...(queue.length ? [h('span', null, `${queue.length} draw${queue.length > 1 ? 's' : ''} to go`)] : []),
        ...(running && rate ? [h('span', { title: 'gate-level simulation in this page' }, `${rate.toLocaleString('en')} cycles/s`)] : []));
    };

    const title = h('h4', null, 'Screen 64 × 64, RGB332', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
    const el = h('div', { class: 'mem-panel cpu-panel gfx-panel', 'data-dock': 'right' }, title,
      h('div', { class: 'cpu-body' },
        h('div', { class: 'param-row', style: 'margin-bottom:6px' }, ...(triSel ? [triSel] : []), ...(opts.gpu ? [viewSel] : []), speed),
        h('div', { class: 'gfx-screen-wrap' }, cv),
        h('div', { class: 'param-row', style: 'margin-top:6px' }, ...controls), status,
        h('p', { class: 'cpu-sec-hint' }, opts.scripts
          ? 'Draw these clears the back frame and draws the triangles in turn, each waiting for the rasterizer, then swaps. Choose "Back frame" to watch them land.'
          : opts.gpu
          ? 'Draw starts the rasterizer on the triangle at its inputs; it writes into the back frame (choose "Back frame" to watch). Swap shows it.'
          : 'The scan-out reads four pixels a cycle; the bright row is where it reads now. Swap asks for the other frame.')));
    title.addEventListener('click', () => { el.classList.toggle('collapsed'); stage.setInset(el.classList.contains('collapsed') ? 0 : el.getBoundingClientRect().width + 24); });
    paint();
    return { el, update: paint, destroy: stop };
  };
}

// ---- edge functions ---------------------------------------------------------------------------------

/** Step 2: drag a triangle's vertices, read the three edge values at any pixel, see the walk's tiles. */
export function edgeWidget(): Widget {
  const el = h('div', { class: 'widget gfx-edges' });
  const cv = h('canvas', { class: 'gfx-edge-canvas', width: 512, height: 512, 'aria-label': 'a 64 by 64 pixel grid with a triangle' }) as HTMLCanvasElement;
  const info = h('div', { class: 'gfx-edge-info' });
  const probe = h('div', { class: 'gfx-edge-info' });
  const mode = h('select', { 'aria-label': 'walk' }, h('option', { value: 'tiles' }, 'Show the tile walk'), h('option', { value: 'none' }, 'Pixels only')) as HTMLSelectElement;
  let V: Vtx[] = [[34, 30], [222, 96], [78, 228]];
  let drag = -1, hover: [number, number] | null = null;
  // theme tokens live on :root; read them at every draw, so a theme switch shows at the next one
  const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
  const S = cv.width / W;
  const draw = () => {
    const run = rasterize(V), s = run.setup, c = cv.getContext('2d')!;
    c.fillStyle = css('--surface-2'); c.fillRect(0, 0, cv.width, cv.height);
    if (s.front && mode.value === 'tiles') {
      for (let ty = s.ty0; ty <= s.ty1; ty++) for (let tx = s.tx0; tx <= s.tx1; tx++) {
        const ok = [0, 1, 2].every((i) => s.A[i] * (16 * tx + 2 - V[i][0]) + s.B[i] * (16 * ty + 2 - V[i][1]) - s.bias[i] + s.off[i] >= 0);
        c.fillStyle = ok ? css('--accent-soft') : css('--surface');
        c.fillRect(4 * tx * S, 4 * ty * S, 4 * S, 4 * S);
        if (!ok) { c.strokeStyle = css('--muted'); c.setLineDash([3, 3]); c.strokeRect(4 * tx * S + 0.5, 4 * ty * S + 0.5, 4 * S - 1, 4 * S - 1); c.setLineDash([]); }
      }
    }
    c.fillStyle = css('--accent');
    for (const w of run.writes) c.fillRect(w.x * S, w.y * S, S, S);
    c.strokeStyle = css('--grid'); c.globalAlpha = 0.6; c.beginPath();
    for (let i = 1; i < W; i++) { c.moveTo(i * S + 0.5, 0); c.lineTo(i * S + 0.5, cv.height); c.moveTo(0, i * S + 0.5); c.lineTo(cv.width, i * S + 0.5); }
    c.stroke(); c.globalAlpha = 1;
    const P = V.map(([x, y]) => [(x / 4) * S, (y / 4) * S] as [number, number]);
    c.strokeStyle = css('--text'); c.lineWidth = 1.5; c.beginPath(); c.moveTo(...P[0]); c.lineTo(...P[1]); c.lineTo(...P[2]); c.closePath(); c.stroke(); c.lineWidth = 1;
    P.forEach(([x, y], i) => {
      c.fillStyle = css('--surface'); c.strokeStyle = css('--text'); c.beginPath(); c.arc(x, y, 8, 0, 7); c.fill(); c.stroke();
      c.fillStyle = css('--text'); c.font = '600 10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(`v${i}`, x, y + 0.5);
    });
    const kv = (k: string, v: string, cls = '') => [h('span', null, k), h('span', { class: `v ${cls}` }, v)];
    info.replaceChildren(
      ...kv('Vertices (¼ px)', V.map((p) => `(${p[0]}, ${p[1]})`).join(' ')),
      ...kv('A, B per edge', s.A.map((a, i) => `${a}, ${s.B[i]}`).join(' · ')),
      ...kv('Twice the area', `${s.area2}${s.front ? '' : ': a back face, culled'}`, s.front ? '' : 'bad'),
      ...kv('Top-left bias', s.bias.map((b, i) => `E${i} ${b ? '−1' : '0'}`).join(' · ')),
      ...kv('Pixels written', String(run.writes.length)),
      ...kv('Cycles', `${run.cycles}: 8 set-up, ${run.tiles} tile tests, ${run.walked} × 16 pixels`));
    if (!hover) probe.replaceChildren(...kv('Pixel', 'point at the grid'));
    else {
      const [x, y] = hover, px = 4 * x + 2, py = 4 * y + 2;
      const e = [0, 1, 2].map((i) => s.A[i] * (px - V[i][0]) + s.B[i] * (py - V[i][1]));
      const sum = e[0] + e[1] + e[2];
      const inside = e.every((k, i) => k - s.bias[i] >= 0);
      probe.replaceChildren(...kv('Pixel', `(${x}, ${y}), centre (${px}, ${py})`),
        ...e.flatMap((k, i) => kv(`E${i}`, String(k), k - s.bias[i] >= 0 ? 'good' : 'bad')),
        ...kv('E0 + E1 + E2', `${sum} (twice the area, everywhere)`),
        ...kv('Weights of v2, v0, v1', sum ? e.map((k) => (k / sum).toFixed(2)).join(' · ') : '—'),
        ...kv('Verdict', inside ? 'inside: written' : 'outside', inside ? 'good' : ''));
    }
  };
  const at = (ev: PointerEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * 4 * W, ((ev.clientY - r.top) / r.height) * 4 * W];
  };
  cv.addEventListener('pointerdown', (ev) => {
    const [x, y] = at(ev);
    let best = -1, bd = 1e9;
    V.forEach(([vx, vy], i) => { const d = Math.hypot(vx - x, vy - y); if (d < bd) { bd = d; best = i; } });
    if (bd < 16) { drag = best; cv.setPointerCapture(ev.pointerId); }
  });
  cv.addEventListener('pointermove', (ev) => {
    const [x, y] = at(ev);
    if (drag >= 0) V = V.map((p, i) => (i === drag ? [Math.max(0, Math.min(255, Math.round(x))), Math.max(0, Math.min(255, Math.round(y)))] : p));
    const hx = Math.floor(x / 4), hy = Math.floor(y / 4);
    hover = hx >= 0 && hx < W && hy >= 0 && hy < W ? [hx, hy] : null;
    draw();
  });
  cv.addEventListener('pointerup', () => { drag = -1; });
  cv.addEventListener('pointerleave', () => { if (drag < 0) { hover = null; draw(); } });
  mode.addEventListener('change', draw);
  el.append(h('div', { class: 'gfx-edge-grid' }, h('div', null, h('div', { class: 'param-row' }, mode), cv),
    h('div', null, h('div', { class: 'lvc-title' }, 'This triangle'), info, h('div', { class: 'lvc-title' }, 'At the pixel under the pointer'), probe)));
  draw();
  // the theme can change under the widget: redraw when <html>'s attributes do
  const mo = new MutationObserver(draw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', draw);
  return { el, update: draw, destroy: () => { mo.disconnect(); mq.removeEventListener('change', draw); } };
}
