// An image sensor's optical stack in 3D (loaded on demand, modelhost.ts): a 2 × 2 Bayer quad cut through its front row,
// front- or back-side illuminated, with rays traced at the learner's angle and wavelength (sensorstack3dparts.ts). The
// optics are the chapter's: silicon's absorption depth and the filters from phys/imagesensor.ts.

import '../styles/sensorstack3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import type { OrbitView } from '../gl/camera';
import { modelStage } from './modelstage';
import { BAYER, FATES, K, fmtUm, pctOf, tenths, stackAnchors, stackHeight, stackParts, stackSpec, traceStack, type Illum, type StackOptics, type StackPalette, type StackPose } from './sensorstack3dparts';
import { STACK_OPTICS } from './sensorstackoptics';

const NAMES = { R: 'red', G: 'green', B: 'blue' } as const;
/** Each illumination framed on its own drawing (BSI's metal and logic wafer hang below the thinned silicon). */
const VIEWS: Record<Illum, OrbitView> = {
  fsi: { target: [0, 9, -3], yaw: 0.55, pitch: 0.3, dist: 150 },
  bsi: { target: [0, -15, -3], yaw: 0.55, pitch: 0.3, dist: 150 },
};

export function sensorStackView(optics: StackOptics = STACK_OPTICS): Widget {
  let illum: Illum = 'fsi', nm = 540, angle = 0, row: 0 | 1 = 0;
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'Four pixels of an image sensor in 3D, cut through the front row: microlenses, red, green and blue filters, metal, and the silicon photodiodes, with light rays traced through them',
    camera: { ...VIEWS.fsi },
    limits: { minDist: 35, maxDist: 320 },
    note: 'To scale: a 1.0 µm pixel with representative layer thicknesses (BSI silicon 2.7 µm as measured on early 1.0 µm pixels; FSI drawn at this size only for comparison). At this pitch FSI’s stack, 3.7 µm from lens to silicon, is far taller than the pixel is wide: tilted 15° or more, the lens’ focal spot walks past the aperture in the top metal and lands on the line at the pixel’s edge, so nothing reaches its own diode. That is why FSI stopped near 1.4 µm, where Lee et al. and Agranov et al. (IISW 2011) measured its sensitivity falling far faster with angle than BSI’s. Geometric rays in the cut’s plane: no diffraction (at a 1 µm pitch it blurs the sharp edges seen here), no reflection losses, no microlens shift towards the sensor’s centre. A ray counts in the pixel where it reaches its mean absorption depth; the filters’ curves are illustrative.',
    draw: () => paint(),
  });
  const palette = (): StackPalette => ({
    lens: stage.rgba('--ss-lens', 0.6), R: stage.rgba('--ss-r', 0.85), G: stage.rgba('--ss-g', 0.85), B: stage.rgba('--ss-b', 0.85),
    oxide: stage.rgba('--m3-oxide', 0.3), metal: stage.rgb('--m3-metal'), si: stage.rgb('--m3-si'), diode: stage.rgb('--m3-n'),
    dti: stage.rgb('--ss-dti'), beol: stage.rgba('--m3-oxide', 0.22), warn: stage.rgb('--ss-warn'), dim: stage.rgb('--ss-dim'),
  });
  const pose = (): StackPose => { const spec = stackSpec(illum); return { spec, nm, angle, row, trace: traceStack(spec, optics, nm, angle, row, 9) }; };
  function paint(): void { const q = pose(); stage.paint(stackParts(q, palette()), stackAnchors(q)); readout(q); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  function readout(q: StackPose): void {
    const t = q.trace.total, s = q.spec, px = BAYER[q.row], p = tenths(t);
    chip.textContent = `${s.illum.toUpperCase()} · ${q.nm} nm · ${q.angle}°`;
    chip.className = `r3-chip ${t.cross + t.metal > 0.1 ? 'warn' : 'good'}`;
    const rows: [string, string][] = [
      ['Pixels cut', `${NAMES[px[0]]} · ${NAMES[px[1]]}`],
      ['Absorption depth 1/α', fmtUm(q.trace.depth)],
      ['Silicon that collects', fmtUm(s.si)],
      ['Stack, lens base to silicon', fmtUm(stackHeight(s))],
      ...FATES.map(({ k, name }): [string, string] => [name[0].toUpperCase() + name.slice(1), pctOf(p[k])]),
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    const text = `${s.illum === 'fsi' ? 'FSI' : 'BSI'} at ${q.angle}°, ${q.nm} nm: ${FATES.map(({ k, name }) => `${pctOf(p[k])} ${name}`).join(', ')}.`;
    if (live.textContent !== text) live.textContent = text;
    angOut.textContent = `${angle}°`; nmOut.textContent = `${nm} nm`;
  }

  const seg = (label: string, opts: readonly [string, string][], get: () => string, set: (v: string) => void) => {
    const btns = opts.map(([v, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(get() === v) }, t) as HTMLButtonElement;
      b.addEventListener('click', () => { set(v); btns.forEach((x, i) => { const on = opts[i][0] === get(); x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); paint(); });
      if (get() === v) b.classList.add('on');
      return b;
    });
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...btns);
  };
  const illumSeg = seg('Illumination', [['fsi', 'Front-side (FSI)'], ['bsi', 'Back-side (BSI)']], () => illum, (v) => { illum = v as Illum; stage.setView({ ...VIEWS[illum] }); });
  const rowSeg = seg('Row cut', [['0', 'Cut red · green'], ['1', 'Cut green · blue']], () => String(row), (v) => { row = Number(v) as 0 | 1; });
  const slider = (label: string, min: number, max: number, step: number, v: number, on: (x: number) => void) => {
    const el = h('input', { type: 'range', min, max, step, value: v, 'aria-label': label }) as HTMLInputElement;
    el.addEventListener('input', () => { on(Number(el.value)); paint(); });
    return el;
  };
  const angOut = h('output', null, ''), nmOut = h('output', null, '');
  const angSl = slider('Angle of the light from the normal, degrees', -30, 30, 1, angle, (x) => { angle = x; });
  const nmSl = slider('Wavelength, nanometres', 400, 1000, 10, nm, (x) => { nm = x; });

  panel.append(
    h('h3', { class: 'm3-title' }, 'Four pixels, cut open'),
    h('p', { class: 'm3-sub' }, `A Bayer quad at a 1.0 µm pitch (${K} drawing units a µm), cut through the middle of its front row. Each pixel has a microlens over a colour filter; below, the light must reach the photodiode in the silicon. Front-side illuminated, it passes between three levels of metal first; back-side illuminated, the wafer is thinned and turned over, so the light enters through the back and the metal is below, out of the way. Tilt the light as a lens does towards the corners of a sensor, and change its wavelength: blue is absorbed in the first few hundred nanometres of silicon, red only microns down, near-infrared mostly not at all.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, illumSeg, rowSeg,
          h('label', { class: 'r3-sl ss-sl' }, h('span', null, 'Angle'), angSl, angOut),
          h('label', { class: 'r3-sl ss-sl' }, h('span', null, 'Wavelength'), nmSl, nmOut),
          h('div', { class: 'r3-btns' }, stage.resetBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'Where the light goes ', h('span', { class: 'r3-badge' }, 'traced')), kv)));
  paint();
  return { el: panel, destroy() { stage.destroy(); } };
}
