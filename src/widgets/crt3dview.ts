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
import { LOOKS } from '../gl/kit/looks';
import { modelStage } from './modelstage';
import {
  beamAt, crtAnchors, CrtRun, decayTicks, fieldTicks, frameTicks, GEOM, hTotal, levelsOf, maskParts, NTSC, NTSC_SCALED, poseParts, ROW_WORDS, staticParts, timingFor,
  TRIADS_PER_CELL, yokeCurrent, type CrtDetail, type CrtPalette, type Timing,
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
  // the mask close-up: a patch 2 mm across, drawn to scale, the camera a few millimetres from it
  mask: { target: [GEOM.D - GEOM.Q / 2, 0, 0], yaw: -0.8, pitch: 0.45, dist: 5.5 },
};
const TUBE_LIMITS = { minDist: 120, maxDist: 1500 }, MASK_LIMITS = { minDist: 2, maxDist: 30 };
const isNarrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
/** A phone's stage is narrow: stand further back so the whole tube is in it. */
const viewOf = (name: string): OrbitView => {
  const o = VIEWS[name];
  return { ...o, dist: o.dist * (isNarrow() ? (name === 'mask' ? 1.7 : 1.25) : 1) };
};
const hex = (n: number, d = 3) => `0x${n.toString(16).toUpperCase().padStart(d, '0')}`;
const SVGW = 300, SVGH = 64;

export function crtView(): Widget {
  let mode: 'a' | 'b' | 'c' = 'a', tm: Timing = timingFor('a'), run = new CrtRun(tm, PICS);
  const blanking = () => mode !== 'a';
  let detail: CrtDetail = 'overview', tf = 0.5, running = false, rate = 256, persist = 16, acc = 0, sync = true;

  const panel = h('div', { class: 'panel crt3d' });
  const stage = modelStage(panel, {
    look: LOOKS.lab,
    aria: 'A colour picture tube in 3D: an electron gun with three beams, the deflection yoke at the neck, the funnel and the phosphor screen, with the beam painting the picture the scan-out sends',
    camera: viewOf(isNarrow() ? 'side' : 'three'),
    limits: TUBE_LIMITS,
    note: "Drawn, not modelled: one smooth bend per beam about its own deflection centre (the three keep their 5.5 mm spacing through the yoke, cross in a hole of the mask and land on three dots), electrodes as plates, a mask with no holes in the tube views (the Mask view has them), one phosphor cell per pixel (4.25 mm, about 16 triads), and an exponential fade. The beams are drawn about 2 mm thick (the real ones are a fraction of a millimetre) so they show. Estimated: the faceplate radius (2 m), the mask-to-screen gap (derived from the pitch and the gun spacing), the stem's pin count (about ten) and the order of the three guns (R, G, B is this model's choice). A simplification: the round-hole dot mask was made for a delta gun (three guns in a triangle, the dots in triangular triads), and setting the guns side by side is what let the holes become slots (the Porta-Color); here an in-line gun is drawn with round holes. Sizes, angle, neck and the order of the electrodes are real; the 0.27 mm triad pitch is the example of US6107729; the interlaced timing is 525-line NTSC (ITU-R BT.470, SMPTE 170M) scaled to 64 rows.",
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
    const narrow = isNarrow();
    if (detail === 'mask') { stage.paint(maskParts(P, lv, b.blanked), crtAnchors('mask', narrow)); return; }
    // a phone draws 32 x 32 cells (1 024 boxes, not 4 096), as the flat fallback does
    stage.paint([...staticParts(P, cur), ...poseParts(P, { beam: b, levels: lv, cell, current: cur, bin: flat || narrow ? 2 : 1 })], crtAnchors(detail, narrow));
  }

  // ---- readout
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const retraceNote = h('p', { class: 'r3-hint crt-retrace' });

  function status(b = beam()): string {
    if (b.phase === 'vretrace') return 'Vertical retrace: the beam is blanked and flying back to the top while the line sweep goes on.';
    if (b.phase === 'hretrace') return 'Horizontal retrace: the beam is blanked and returning to the left edge.';
    return `Row ${b.row}${tm.fields === 2 ? ` (line ${b.row + 1}, ${b.field ? 'even' : 'odd'} field)` : ''}, pixel ${b.px}: scan-out word ${hex(b.addr)} (word ${b.px >> 2} of ${ROW_WORDS}), front frame ${PICTURE[run.scan.front]}.`;
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
      ['Beam on', b.blanked ? 'blanked' : `x ${b.px}, y ${b.row} (word ${hex(b.addr)})`],
      ...(tm.fields === 2 ? ([['Field', `${b.field + 1} of 2: ${b.field ? 'even lines 2, 4 … (rows 1, 3 …)' : 'odd lines 1, 3 … (rows 0, 2 …)'}`]] as [string, string][]) : []),
      ['Gun drive R · G · B', lv === null ? 'cut off' : `${(lv >> 5) & 7} · ${(lv >> 2) & 7} · ${lv & 3} of 7 · 7 · 3`],
      ['Front frame', `${PICTURE[o.front]}${run.scan.pend ? ' (flip pending)' : ''}`],
      ['vsync (our last word)', String(o.vsync)],
      ...(blanking() ? ([[tm.id === 'ntsc' ? 'Sync h · v' : 'VGA sync h · v', `${b.hsync ? 1 : 0} · ${b.vsync ? 1 : 0}`]] as [string, string][]) : []),
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
    const vp = plot('Vertical deflection current over one frame: a slow ramp and the return', N, (k) => yokeCurrent(beamAt(tm, (k / N) * FT + 0.001)).v, (k) => beamAt(tm, (k / N) * FT + 0.001).phase === 'vretrace', curV);
    plotsBox.replaceChildren(h('h4', null, 'Horizontal yoke current, one line'), hp, h('h4', null, tm.fields === 2 ? 'Vertical yoke current, one frame (two fields)' : 'Vertical yoke current, one frame'), vp);
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
  const modeSel = h('select', { class: 'crt-sel', 'aria-label': 'scan timing' }, h('option', { value: 'a' }, 'Our scan-out: no blanking'), h('option', { value: 'b' }, 'With VGA-proportioned retrace'), h('option', { value: 'c' }, 'Broadcast NTSC, interlaced (scaled)')) as HTMLSelectElement;
  modeSel.addEventListener('change', () => {
    const was = run;
    mode = modeSel.value as 'a' | 'b' | 'c'; tm = timingFor(mode);
    run = new CrtRun(tm, PICS); run.sync = sync ? 1 : 0; tf = 0.5; running = false; void was;
    if (mode === 'c') { persist = 16; pers.value = '16'; } // the fade must last about a field for the comb to show
    predict.style.display = mode === 'c' ? '' : 'none';
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
  // the preset views on the stage's shared view bar; the gun, yoke and mask views also draw those parts in detail (the mask up close: its own zoom limits)
  const views = ['three', 'front', 'side', 'gun', 'yoke', 'mask'].map((name) => ({
    label: name === 'three' ? '3/4 view' : name[0].toUpperCase() + name.slice(1),
    view: () => viewOf(name),
    limits: name === 'mask' ? MASK_LIMITS : TUBE_LIMITS,
    on: name === (isNarrow() ? 'side' : 'three'), // a phone opens on the side view (the camera above)
    pick: () => {
      detail = name === 'gun' || name === 'yoke' || name === 'mask' ? name : 'overview';
      maskNote.style.display = name === 'mask' ? '' : 'none';
      paint();
    },
  }));

  function retraceText(): string {
    if (mode === 'c') {
      return "Broadcast video is 525 lines a frame at 4.5 MHz / 286 = 15 734.264 Hz (ITU-R BT.470-6; SMPTE ST 170M): 63.56 µs a line, drawn as two interlaced fields of 262.5 lines at 59.94 Hz. The first field draws the odd lines 1, 3, 5 … (rows 0, 2, 4 … counted from 0), the second the even lines 2, 4, 6 … (rows 1, 3, 5 …); a scan-out run this way only needs its counter's field bit moved to the bottom of the row address. Scaled to 64 × 64: 76 clocks a line (BT.601 samples a line 858 times, 720 of them picture: 64 / (720 / 858) = 76.3), 35 lines a field of which 32 draw (240 of 262.5), so a frame is 70 line times and the half line becomes whole. Porches and the sync pulse are rounded estimates. With the fade set to ×16 (about a field), the field just drawn is bright and the other fading: the comb of the interlace. The clock is held while the beam is blanked, as in the VGA mode.";
    }
    return blanking()
      ? 'Retrace is drawn in VGA 640 × 480 @ 59.94 Hz proportions (25.175 MHz, 800 × 525 clocks for 640 × 480 visible: 160 clocks of blanking a line, 45 lines a frame), scaled to our 64 × 64 as 16 pixels a line and 6 lines a frame. Our scan-out has none, so here its clock is held while the beam is blanked, as a real display controller holds its address while a line buffer waits: the words are the same, in the same order. VGA’s vsync pulse comes one line after the last visible line; our vsync output is the last word, bottom right.'
      : 'Our scan-out has no blanking: the cycle after the last word of a row is the first of the next, and word 1023 (vsync) is followed by word 0. The beam therefore flies back in zero time here: it jumps. Switch to the VGA-proportioned retrace to see the blanked flyback a real tube needs.';
  }
  retraceNote.textContent = retraceText();
  buildPlots();
  const predict = h('details', { class: 'deeper crt-predict' }, h('summary', null, 'Predict first: a line lasts 63.5 µs and a picture has 525 lines. How long is a frame?'),
    h('p', null, `525 × ${NTSC.lineUs().toFixed(2)} µs = ${NTSC.frameMs().toFixed(1)} ms: ${(1000 / NTSC.frameMs()).toFixed(2)} frames a second, each of two fields of 262.5 lines, ${NTSC.fieldHz().toFixed(2)} fields a second. Here that is ${frameTicks(NTSC_SCALED)} pixel ticks (${fieldTicks(NTSC_SCALED)} a field).`));
  predict.style.display = 'none';
  const maskNote = h('p', { class: 'r3-hint crt-mask' },
    `The Mask view, to scale: a patch of seven by five holes in the steel shadow mask. The triad pitch is ${GEOM.TRIAD} mm (the circular-hole example of US6107729); the holes are drawn square and 0.12 mm wide, the steel 0.15 mm thick (estimates). The three beams leave the gun ${GEOM.GUN_PITCH} mm apart, cross in one hole and land on three dots ${(GEOM.TRIAD / 3).toFixed(2)} mm apart, each beam on the far side from its gun: that is why a mask makes colour, each gun can only see its own dots through the hole. Behind the dots is the black matrix. The gap from mask to screen, ${GEOM.Q.toFixed(1)} mm, is derived from the pitch and the gun spacing (estimated: no source found for the real figure). One of our 4.25 mm cells spans about ${Math.round(TRIADS_PER_CELL)} triads: a real pixel here would be ${Math.round(TRIADS_PER_CELL)} dots of each colour.`);
  maskNote.style.display = 'none';

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
          modeSel, pers,
          stage.viewBar(views)),
        stage.el, stage.hint, maskNote, retraceNote, predict, live),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'The beam ', h('span', { class: 'r3-badge' }, 'model')), kv), plotsBox)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
