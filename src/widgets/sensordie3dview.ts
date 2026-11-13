// A whole image sensor die in 3D (loaded on demand, modelhost.ts): the chapter's IMX183 capturing a moving bar or a
// turning propeller with a rolling or a global shutter, in slow motion, on the studio renderer (sensordie3dkit.ts).
// Timing from phys/imagesensor.ts and sensordie3dgeom.ts.

import '../styles/sensordie3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { groupNum } from '../sim/numfmt';
import { IMX183, rollingSkew } from '../phys/imagesensor';
import { frameLoop } from './mosfet';
import { M } from '../gl/kit/materials';
import { roundedBox } from '../gl/kit/geo';
import { packInstances } from '../gl/instances';
import { studioStage, type StudioStage } from './studiostage';
import { DIE_HOME, dieInstances, dieModel } from './sensordie3dkit';
import { CELL, FRAME, RAMP_SHARE, T_ROW, captureEnd, cellRow, defaultScene, dieState, fmtTime, type DiePose, type SceneKind, type Shutter } from './sensordie3dgeom';

const UNIT = roundedBox(1, 1, 1, 0.08, 1);
const counterMat = M.glow(M.make({ base: '--m3-charge', metal: 0, rough: 0.4, label: 'a column counter: its height is its count' }), '--m3-charge', 0.5);
const imageMat = M.make({ base: '--sd-img', metal: 0, rough: 0.6, transmit: 0.45, label: 'the image the lens forms, drawn above the array' });

/** Screen seconds a capture takes (a frame of 45.5 ms, slowed down), and the pause on the finished frame. */
const SHOW_S = 8, HOLD_S = 2.5;
const EXPOSURES = [0.05e-3, 0.1e-3, 0.25e-3, 0.5e-3, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3];

export function sensorDieView(): Widget {
  let shutter: Shutter = 'rolling', kind: SceneKind = 'prop', scene = defaultScene(kind), texp = 5e-3;
  let now = 0, running = !reducedMotion(), hold = 0;
  const panel = h('div', { class: 'panel sd3' });
  let ref: StudioStage | null = null;
  const rgb = (t: `--${string}`): [number, number, number] => (ref ? ref.rgb(t) : [0.5, 0.5, 0.5]);
  const pose = (): DiePose => ({ scene, shutter, texp, now });
  const stage = studioStage({
    aria: 'An image sensor die in 3D: the pixel array, row drivers on its left, a column ADC per column below it and the readout, with a moving object’s image above the array',
    home: DIE_HOME,
    homeFrame: ['array', 'rows', 'adc', 'out'],
    aspect: 1.45,
    limits: { minDist: 40, maxDist: 600, maxPan: 120 },
    scaleBar: (len) => `${len / 10} mm`,
    note: `The array is the IMX183’s to scale (13.3 × 8.9 mm), in cells of ${CELL} × ${CELL} pixels; the periphery is drawn, with one ADC for every ${CELL} columns, and the optical-black strips far wider than they are. Slow motion: a ${fmtTime(FRAME)} frame takes ${SHOW_S} s. The IMX183 has a rolling shutter only: Global is a what-if.`,
    noteMore: `The array is the IMX183’s to scale (13.3 × 8.9 mm) in cells of ${CELL} × ${CELL} pixels, each showing its middle pixel; the periphery is drawn, not measured, with one ADC drawn for every ${CELL} columns. Slow motion: a ${fmtTime(FRAME)} frame takes ${SHOW_S} s. The IMX183 has a rolling shutter only; Global shows the same array with a storage node in every pixel. Its row time, ${fmtTime(T_ROW)}, is derived from its frame rate, blanking ignored. The reset and read pointers run down the array one exposure apart; between them is the band of rows gathering light. The optical-black strips along the top and left edges, pixels under metal whose reading is the dark level each row has subtracted, are drawn far wider than their few dozen rows and columns. Each drawn row’s time is split between the ramp (${Math.round(RAMP_SHARE * 100)} %) and shifting its counters out; on the chip the next row’s conversion overlaps the last one’s shift.`,
    build: (detail) => dieModel(pose(), rgb, detail),
  });
  ref = stage;
  function paint(): void {
    stage.refresh();
    const ins = dieInstances(pose());
    stage.instances('counters', UNIT, counterMat, packInstances(ins.counters));
    stage.instances('image', UNIT, imageMat, packInstances(ins.image));
    readout();
  }

  let kvKeys = '';
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const end = () => captureEnd(shutter, texp) + CELL * T_ROW;
  function readout(): void {
    const st = dieState(pose()), done = now >= end();
    const row = st.reading === null ? null : cellRow(st.reading);
    chip.textContent = done ? 'Frame captured' : row !== null ? `Reading row ${groupNum(row)}` : now < texp && shutter === 'global' ? 'Every row exposing' : 'Exposing';
    chip.className = `r3-chip ${done ? 'good' : 'warn'}`;
    const v = scene.kind === 'bar' ? `bar crossing in ${fmtTime(IMX183.cols / scene.v)}` : `propeller, ${groupNum(scene.rps * 60)} rpm`;
    const rows: [string, string][] = [
      ['Sensor', `${IMX183.part}, ${groupNum(IMX183.cols)} × ${groupNum(IMX183.rows)}, ${IMX183.pitch} µm`],
      ['Time since the first reset', fmtTime(now)],
      ['Row time · frame', `${fmtTime(T_ROW)} · ${fmtTime(FRAME)}`],
      ['Exposure (every row)', `${fmtTime(texp)}: ${groupNum(Math.round(texp / T_ROW))} rows between the pointers`],
      ['Object', v],
      ...(scene.kind === 'prop' ? [['Turns while the frame is read', `${(scene.rps * FRAME).toFixed(2)}`] as [string, string]] : []),
      ['Rolling skew, top to bottom', scene.kind === 'bar' ? `${groupNum(Math.round(rollingSkew(scene.v, IMX183.rows)))} pixels` : `${Math.round(scene.rps * IMX183.rows * T_ROW * 360)}° of turn`],
      ['Counter clock for a 12-bit ramp a row', `${groupNum(Math.round(2 ** IMX183.adcBits / T_ROW / 1e6))} MHz`],
    ];
    // rebuilt only when the rows change, else their values set in place: this runs every frame of a run
    const keys = rows.map(([k]) => k).join('\n');
    if (keys !== kvKeys) { kvKeys = keys; kv.replaceChildren(...rows.flatMap(([k, val]) => [h('span', null, k), h('span', { class: 'v' }, val)])); }
    else rows.forEach(([, val], i) => { const v = kv.children[2 * i + 1]; if (v.textContent !== val) v.textContent = val; });
    const text = done ? `Captured with a ${shutter} shutter: ${shutter === 'rolling' ? 'each row saw the object a row time later than the one above.' : 'every row saw the same instant.'}` : '';
    if (text && live.textContent !== text) live.textContent = text;
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    expOut.textContent = fmtTime(texp);
    spdOut.textContent = scene.kind === 'bar' ? fmtTime(IMX183.cols / scene.v) : `${groupNum(scene.rps * 60)} rpm`;
  }

  const loop = frameLoop((_t, dt) => {
    if (!running) return;
    if (now >= end()) { hold += dt; if (hold >= HOLD_S) { now = 0; hold = 0; } }
    else now = Math.min(end(), now + (dt * FRAME) / SHOW_S);
    paint();
  }, () => running);

  const restart = () => { now = 0; hold = 0; paint(); loop.kick(); };
  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; if (running && now >= end()) { now = 0; hold = 0; } paint(); loop.kick(); });
  const shotBtn = h('button', { type: 'button', class: 'btn sm' }, 'Whole frame at once') as HTMLButtonElement;
  shotBtn.addEventListener('click', () => { running = false; now = end(); paint(); });
  const seg = (label: string, opts: readonly [string, string][], get: () => string, set: (v: string) => void) => {
    const btns = opts.map(([v, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(get() === v) }, t) as HTMLButtonElement;
      b.addEventListener('click', () => { set(v); btns.forEach((x, i) => { const on = opts[i][0] === get(); x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); restart(); });
      if (get() === v) b.classList.add('on');
      return b;
    });
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...btns);
  };
  const shutSeg = seg('Shutter', [['rolling', 'Rolling shutter'], ['global', 'Global shutter']], () => shutter, (v) => { shutter = v as Shutter; });
  const objSeg = seg('Object', [['prop', 'Propeller'], ['bar', 'Moving bar']], () => kind, (v) => { kind = v as SceneKind; scene = defaultScene(kind); spd.value = '2'; });
  const expSl = h('input', { type: 'range', min: 0, max: EXPOSURES.length - 1, step: 1, value: EXPOSURES.indexOf(texp), 'aria-label': 'Exposure time' }) as HTMLInputElement;
  expSl.addEventListener('input', () => { texp = EXPOSURES[Number(expSl.value)]; restart(); });
  // Speed: five steps; for the bar its crossing time, for the propeller its rpm.
  const BAR_S = [0.4, 0.2, 0.1, 0.05, 0.025], PROP_RPS = [1, 2, 3, 6, 12];
  const spd = h('input', { type: 'range', min: 0, max: 4, step: 1, value: 2, 'aria-label': 'How fast the object moves' }) as HTMLInputElement;
  spd.addEventListener('input', () => { const i = Number(spd.value); scene = kind === 'bar' ? { ...scene, v: IMX183.cols / BAR_S[i] } : { ...scene, rps: PROP_RPS[i] }; restart(); });
  const expOut = h('output', null, ''), spdOut = h('output', null, '');

  stage.slot.append(
    h('div', { class: 'r3-ctl' }, shutSeg, objSeg, h('div', { class: 'r3-btns' }, runBtn, shotBtn)),
    h('div', { class: 'r3-ctl' },
      h('label', { class: 'r3-sl sd-sl' }, h('span', null, 'Exposure'), expSl, expOut),
      h('label', { class: 'r3-sl sd-sl' }, h('span', null, 'Speed'), spd, spdOut)),
    live);
  panel.append(
    h('h3', { class: 'm3-title' }, 'The whole sensor'),
    h('p', { class: 'm3-sub' }, `The ${IMX183.part}’s pixel array with what surrounds it. The row decoder on the left picks a row; its drivers reset it, transfer its charge and connect it to the column lines. Below, every column has its own single-slope ADC: one ramp shared by all, a comparator and a counter per column, so a whole row is converted at once and shifted out to the output. A rolling shutter resets and reads the rows one after another, a row time apart, so each row sees the scene at its own moment; a global shutter exposes them all together, then reads them out the same way. Watch the propeller.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('h4', null, 'This sensor ', h('span', { class: 'r3-badge' }, 'the chapter’s IMX183')), kv)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; paint(); } });
  if (!running) now = end(); // reduced motion: the finished frame, Run to watch it built
  paint();
  loop.kick();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
