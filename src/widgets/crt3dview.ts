// The CRT raster scan in 3D (loaded on demand, modelhost.ts). The beam is driven by the scan-out: crt3dparts.ts clocks a
// reference of lib/raster.ts SCAN_OUT (held to the gates by tests/crt3d.test.ts) on the cycles the beam is active, the
// beam's deflection comes from the same timeline, and each cell lights with the byte the scan-out read. Retrace and the
// blanking are drawn, in VGA's proportions: our scan-out has none (the cycle after word 1023 is word 0).

import '../styles/crt3d.css';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { barsPicture, ringsPicture } from '../gfx/scenepics';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  beamAt, crtAnchors, CrtRun, decayTicks, frameTicks, GEOM, hTotal, levelsOf, poseParts, ROW_WORDS, staticParts, timingOf, vTotal, yokeCurrent,
  type CrtDetail, type CrtPalette, type Timing,
} from './crt3dparts';
import type { OrbitView } from '../gl/camera';

const PICS: [Uint8Array, Uint8Array] = [barsPicture(), ringsPicture()];
const PICTURE = ['colour bars', 'rings'];
const VIEWS: Record<string, OrbitView> = {
  three: { target: [30, 0, 0], yaw: 0.62, pitch: 0.3, dist: 540 },
  front: { target: [GEOM.D, 0, 0], yaw: 1.2, pitch: 0.14, dist: 500 },
  side: { target: [10, 0, 0], yaw: 0.05, pitch: 0.12, dist: 620 },
  gun: { target: [-105, 0, 0], yaw: 0.45, pitch: 0.25, dist: 200 },
  yoke: { target: [-5, 0, 0], yaw: 0.6, pitch: 0.3, dist: 300 },
};
/** A phone's stage is narrow: stand further back so the whole tube is in it. */
const viewOf = (name: string): OrbitView => {
  const o = VIEWS[name], narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  return { ...o, dist: o.dist * (narrow ? 1.25 : 1) };
};
const hex = (n: number, d = 3) => `0x${n.toString(16).toUpperCase().padStart(d, '0')}`;
const SVGW = 300, SVGH = 64;

export function crtView(): Widget {
  let blanking = false, tm: Timing = timingOf(false), run = new CrtRun(tm, PICS);
  let detail: CrtDetail = 'overview', tf = 0.5, running = false, rate = 256, persist = 16, acc = 0, sync = true;

  const panel = h('div', { class: 'panel crt3d' });
  const stage = modelStage(panel, {
    aria: 'A colour picture tube in 3D: an electron gun with three beams, the deflection yoke at the neck, the funnel and the phosphor screen, with the beam painting the picture the scan-out sends',
    camera: viewOf('three'),
    limits: { minDist: 120, maxDist: 1500 },
    note: 'Drawn, not modelled: one smooth bend per beam through a single deflection centre, electrodes as plates, a shadow mask with no holes, a flat faceplate, one phosphor cell per pixel (a real pixel is many red, green and blue dots), and an exponential fade. The beams are drawn about 2 mm thick (the real ones are a fraction of a millimetre) so they show. Sizes, angle, neck, stem pins and the order of the electrodes are real.',
    draw: () => paint(),
  });
  const palette = (): CrtPalette => ({
    glass: stage.rgb('--crt-glass'), aquadag: stage.rgb('--crt-aquadag'), copper: stage.rgb('--crt-copper'), ferrite: stage.rgb('--crt-ferrite'),
    metal: stage.rgb('--crt-metal'), pin: stage.rgb('--crt-pin'), cellOff: stage.rgb('--crt-off'), mask: stage.rgb('--crt-mask'),
    heater: stage.rgb('--crt-heater'), ghost: stage.rgb('--crt-ghost'), bezel: stage.rgb('--crt-bezel'),
  });
  const tau = () => decayTicks(tm, 1, persist);
  const beam = () => beamAt(tm, tf);

  function paint(): void {
    const P = palette(), b = beam(), cur = yokeCurrent(b), t = tau(), flat = stage.isFlat();
    const lv = b.blanked ? ([0, 0, 0] as [number, number, number]) : levelsOf(PICS[run.scan.front][b.pixel]);
    const cell = (i: number): [number, number, number] => {
      const g = run.glow(i, tf, t);
      if (g < 0.004) return [0, 0, 0];
      const c = levelsOf(run.litCol[i]);
      return [c[0] * g, c[1] * g, c[2] * g];
    };
    stage.paint([...staticParts(P, cur), ...poseParts(P, { beam: b, levels: lv, cell, current: cur, bin: flat ? 2 : 1 })], crtAnchors(detail));
  }

  // ---- readout
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const retraceNote = h('p', { class: 'r3-hint crt-retrace' });

  function status(b = beam()): string {
    if (b.phase === 'vretrace') return 'Vertical retrace: the beam is blanked and flying back to the top while the line sweep goes on.';
    if (b.phase === 'hretrace') return 'Horizontal retrace: the beam is blanked and returning to the left edge.';
    return `Row ${b.line}, pixel ${b.px}: scan-out word ${hex(b.addr)} (row ${b.line}, word ${b.px >> 2} of ${ROW_WORDS}), front frame ${PICTURE[run.scan.front]}.`;
  }
  function readout(announce = false): void {
    const b = beam(), cur = yokeCurrent(b), o = run.scan.out(), px = run.pics[o.front];
    chip.textContent = b.phase === 'active' ? 'Beam on' : b.phase === 'hretrace' ? 'Blanked: horizontal retrace' : 'Blanked: vertical retrace';
    chip.className = `r3-chip ${b.phase === 'active' ? 'good' : 'warn'}`;
    const lv = b.blanked ? null : px[b.pixel];
    const rows: [string, string][] = [
      ['Pixel clock ticks', String(Math.floor(tf))],
      ['Scan-out edges', `${run.edges}${run.held ? ` (clock held ${run.held} blanked cycles)` : ''}`],
      ['Counter ra', `${hex(o.ra)} = row ${o.ra >> 4}, word ${o.ra & 15}`],
      ['Beam on', b.blanked ? 'blanked' : `x ${b.px}, y ${b.line} (word ${hex(b.addr)})`],
      ['Gun drive R · G · B', lv === null ? 'cut off' : `${(lv >> 5) & 7} · ${(lv >> 2) & 7} · ${lv & 3} of 7 · 7 · 3`],
      ['Front frame', `${PICTURE[o.front]}${run.scan.pend ? ' (flip pending)' : ''}`],
      ['vsync (our last word)', String(o.vsync)],
      ...(blanking ? ([['VGA sync h · v', `${b.hsync ? 1 : 0} · ${b.vsync ? 1 : 0}`]] as [string, string][]) : []),
      ['Yoke current H · V', `${(cur.h * 100).toFixed(0)} % · ${(cur.v * 100).toFixed(0)} %`],
      ['Frames scanned', String(run.frames)],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    swapBtn.setAttribute('aria-pressed', String(run.swapReq || run.scan.pend === 1));
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = status(b);
    if (live.textContent !== text) live.textContent = text;
    curH.setAttribute('x1', String(((tf % hTotal(tm)) / hTotal(tm)) * SVGW)); curH.setAttribute('x2', curH.getAttribute('x1')!);
    curV.setAttribute('x1', String(((tf % frameTicks(tm)) / frameTicks(tm)) * SVGW)); curV.setAttribute('x2', curV.getAttribute('x1')!);
  }

  // ---- the two yoke currents, from beamAt over one line and one frame
  const plot = (label: string, samples: number, at: (k: number) => number, blank: (k: number) => boolean, line: SVGLineElement) => {
    const g = s('svg', { class: 'crt-plot', viewBox: `0 0 ${SVGW} ${SVGH}`, role: 'img', 'aria-label': label });
    const pts: string[] = [];
    let runStart = -1;
    for (let k = 0; k <= samples; k++) {
      const x = (k / samples) * SVGW, y = SVGH / 2 - at(k) * (SVGH / 2 - 8);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const bl = k < samples && blank(k);
      if (bl && runStart < 0) runStart = x;
      if (!bl && runStart >= 0) { g.append(s('rect', { class: 'blank', x: runStart, y: 0, width: Math.max(1, x - runStart), height: SVGH })); runStart = -1; }
    }
    g.append(s('line', { class: 'ax', x1: 0, x2: SVGW, y1: SVGH / 2, y2: SVGH / 2 }), s('polyline', { class: 'line', points: pts.join(' ') }), line);
    return g;
  };
  const curH = s('line', { class: 'cur', x1: 0, x2: 0, y1: 0, y2: SVGH }), curV = s('line', { class: 'cur', x1: 0, x2: 0, y1: 0, y2: SVGH });
  const plotsBox = h('div');
  function buildPlots(): void {
    const HT = hTotal(tm), FT = frameTicks(tm);
    const hp = plot('Horizontal deflection current over one line: a sawtooth, the sweep and the flyback', HT, (k) => yokeCurrent(beamAt(tm, k + 0.001)).h, (k) => k >= tm.hAct, curH);
    const N = 280;
    const vp = plot('Vertical deflection current over one frame: a slow ramp and the return', N, (k) => yokeCurrent(beamAt(tm, (k / N) * FT + 0.001)).v, (k) => (k / N) * vTotal(tm) >= tm.vAct, curV);
    plotsBox.replaceChildren(h('h4', null, 'Horizontal yoke current, one line'), hp, h('h4', null, 'Vertical yoke current, one frame'), vp);
  }

  // ---- time
  function setTf(v: number): void { tf = v; run.advance(Math.floor(tf) + 1); }
  const loop = frameLoop((_now, dt) => {
    if (running) {
      if (reducedMotion()) { // a row every half second, no sweeping
        acc += dt;
        if (acc >= 0.5) { acc = 0; stepRow(); }
      } else setTf(tf + dt * rate * 4);
    }
    readout(); paint();
  }, () => running);
  const kick = (announce = false) => { readout(announce); paint(); loop.kick(); };

  function stepWord(): void { const t = run.tick; setTf(Math.max(tf, (t >> 2) * 4 + 3 + 0.5)); }
  function stepRow(): void { const HT = hTotal(tm), t = run.tick; setTf(Math.max(tf, (Math.floor(t / HT) + 1) * HT - 1 + 0.5)); }

  // ---- controls
  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; acc = 0; kick(true); });
  const wordBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step one word');
  wordBtn.addEventListener('click', () => { running = false; stepWord(); kick(true); });
  const rowBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step one row');
  rowBtn.addEventListener('click', () => { running = false; stepRow(); kick(true); });
  const swapBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'false', title: 'ask the scan-out for the other frame' }, 'Swap frame') as HTMLButtonElement;
  swapBtn.addEventListener('click', () => { run.swapReq = true; kick(true); });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Start over');
  resetBtn.addEventListener('click', () => { running = false; run.reset(); tf = 0.5; kick(true); });

  const syncBox = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  syncBox.addEventListener('change', () => { sync = syncBox.checked; run.sync = sync ? 1 : 0; kick(true); });
  const mode = h('select', { class: 'crt-sel', 'aria-label': 'retrace' }, h('option', { value: 'a' }, 'Our scan-out: no blanking'), h('option', { value: 'b' }, 'With VGA-proportioned retrace')) as HTMLSelectElement;
  mode.addEventListener('change', () => {
    const was = run;
    blanking = mode.value === 'b'; tm = timingOf(blanking);
    run = new CrtRun(tm, PICS); run.sync = sync ? 1 : 0; tf = 0.5; running = false; void was;
    retraceNote.textContent = retraceText();
    buildPlots(); kick(true);
  });
  const pers = h('select', { class: 'crt-sel', 'aria-label': 'phosphor persistence' },
    h('option', { value: '1' }, 'Fade ≈ 1 ms (P22 order)'), h('option', { value: '4' }, 'Fade ×4 (exaggerated)'), h('option', { value: '16' }, 'Fade ×16 (exaggerated)')) as HTMLSelectElement;
  pers.value = String(persist);
  pers.addEventListener('change', () => { persist = Number(pers.value); kick(); });
  const speed = h('input', { type: 'range', min: 4, max: 12, step: 0.1, value: Math.log2(rate), 'aria-label': 'Speed in scan-out cycles a second' }) as HTMLInputElement;
  const speedOut = h('output', null, '');
  const showSpeed = () => { speedOut.textContent = `${Math.round(rate)}/s`; };
  speed.addEventListener('input', () => { rate = 2 ** Number(speed.value); showSpeed(); });
  showSpeed();
  const view = (name: string) => {
    const b = h('button', { type: 'button', class: 'btn sm' }, name[0].toUpperCase() + name.slice(1));
    b.addEventListener('click', () => { detail = name === 'gun' ? 'gun' : name === 'yoke' ? 'yoke' : 'overview'; stage.setView(viewOf(name)); paint(); });
    return b;
  };

  function retraceText(): string {
    return blanking
      ? 'Retrace is drawn in VGA 640 × 480 @ 59.94 Hz proportions (25.175 MHz, 800 × 525 clocks for 640 × 480 visible: 160 clocks of blanking a line, 45 lines a frame), scaled to our 64 × 64 as 16 pixels a line and 6 lines a frame. Our scan-out has none, so here its clock is held while the beam is blanked, as a real display controller holds its address while a line buffer waits: the words are the same, in the same order. VGA’s vsync pulse comes one line after the last visible line; our vsync output is the last word, bottom right.'
      : 'Our scan-out has no blanking: the cycle after the last word of a row is the first of the next, and word 1023 (vsync) is followed by word 0. The beam therefore flies back in zero time here: it jumps. Switch to the VGA-proportioned retrace to see the blanked flyback a real tube needs.';
  }
  retraceNote.textContent = retraceText();
  buildPlots();

  panel.append(
    h('h3', { class: 'm3-title' }, 'The scan-out on a tube'),
    h('p', { class: 'm3-sub' }, 'The counter of the scan-out above, drawn on a colour picture tube. A word a cycle, four pixels, sixteen words a row, 64 rows: the beam sits on the pixel the counter is sending, and the three guns are driven with that pixel’s three colour fields. The yoke’s horizontal coils (above and below the neck) sweep it sideways with a sawtooth current, the vertical ones (at its sides) step it down; each lit phosphor cell then fades. A frame is 1024 cycles, with the beam blanked on its way back.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'r3-sl' }, h('span', null, 'Speed'), speed, speedOut),
          h('div', { class: 'r3-btns' }, runBtn, wordBtn, rowBtn, swapBtn, resetBtn)),
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'crt-chk' }, syncBox, 'flip at vsync'),
          mode, pers,
          h('div', { class: 'crt-seg', role: 'group', 'aria-label': 'Views' }, view('three'), view('front'), view('side'), view('gun'), view('yoke'), stage.resetBtn)),
        stage.el, stage.hint, retraceNote, live),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'The beam ', h('span', { class: 'r3-badge' }, 'model')), kv), plotsBox)));
  // Replace the leading "three" button label
  panel.querySelectorAll('.crt-seg button').forEach((b) => { if (b.textContent === 'Three') b.textContent = '3/4 view'; });
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
