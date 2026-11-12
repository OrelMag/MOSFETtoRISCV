// An image sensor's optical stack in 3D (loaded on demand, modelhost.ts): a 2 × 2 Bayer quad cut through its front row,
// front- or back-side illuminated, with rays traced at the learner's angle and wavelength (sensorstack3dparts.ts). The
// optics are the chapter's: silicon's absorption depth and the filters from phys/imagesensor.ts.

import '../styles/sensorstack3d.css';
import { h, s as svg } from '../ui/dom';
import type { Widget } from '../view/stage';
import type { OrbitView } from '../gl/camera';
import { LOOKS } from '../gl/kit/looks';
import { modelStage } from './modelstage';
import { angleCurve, BAYER, FATES, K, fmtUm, lensHeight, PITCHES, pctOf, siReflectance, spotSize, tenths, stackAnchors, stackHeight, stackParts, stackSpec, traceStack, type Illum, type StackOptics, type StackPalette, type StackPose, type StackSpec } from './sensorstack3dparts';
import { STACK_OPTICS } from './sensorstackoptics';

const NAMES = { R: 'red', G: 'green', B: 'blue' } as const;
/** The angles the angular response is drawn at, degrees. */
const CURVE_ANGLES = Array.from({ length: 16 }, (_, i) => i * 2);

/** A drawing framed whole: from the lens' top to the bottom of what hangs below the silicon (BSI: its metal and the
 *  logic wafer), wider for the wider pixel. */
function viewOf(s: StackSpec, rc: number): OrbitView {
  const top = stackHeight(s) + lensHeight(s, rc), bot = -s.si - (s.beolBelow > 0 ? s.beolBelow + 1.2 : 0.8);
  const span = Math.max(top - bot, 2.2 * s.pitch) * K;
  return { target: [0, ((top + bot) / 2) * K, -s.pitch * K * 0.3], yaw: 0.55, pitch: 0.3, dist: 2.0 * span };
}

export function sensorStackView(optics: StackOptics = STACK_OPTICS): Widget {
  let illum: Illum = 'fsi', nm = 540, angle = 0, row: 0 | 1 = 0, pitch: number = PITCHES[0], ar = true;
  const spec = (il = illum) => stackSpec(il, { pitch, ar });
  const frame = () => { const sp = spec(); return viewOf(sp, traceStack(sp, optics, 550, 0, 0, 1).rc); };
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    look: LOOKS.silicon,
    aria: 'Four pixels of an image sensor in 3D, cut through the front row: microlenses, red, green and blue filters, metal, and the silicon photodiodes, with light rays traced through them',
    camera: frame(),
    limits: { minDist: 35, maxDist: 600 },
    note: 'To scale, with representative layer thicknesses, not one product’s. 2.4 µm is the chapter’s IMX183 over its 3 µm of collecting silicon; 1.0 µm is a phone pixel, its BSI silicon 2.7 µm as TechInsights measured on early 1.0 µm pixels with deep trench isolation (R. Fontaine, “The State-of-the-Art of Smartphone Imagers”, IISW 2019). FSI at 1.0 µm is drawn for comparison only: no one made it. Its stack, 3.7 µm from lens to silicon, is far taller than the pixel is wide, so tilted 15° the focal spot lands on the metal at the pixel’s edge; Lee et al. (“SNR Performance Comparison of 1.4 µm Pixel: FSI, Light-guide, and BSI”, IISW 2011) measured FSI losing over 20 % to its metal already at 1.4 µm, and BSI’s response at oblique light far better for its low stack. FSI products of that size added light guides over the diode, not drawn. Geometric rays in the cut’s plane: the orange bar is the diffraction-limited spot (2.44 λ N) the lens cannot beat, so at 1 µm the sharp edges seen here are blurred over the pixel. Reflection at the silicon is Fresnel’s at normal incidence, through a quarter-wave film when the anti-reflection coating is on; the reflection off the metal behind BSI’s silicon, which gives near-infrared a second pass, is not traced. The diode’s n region is drawn on the metal side, under its p+ pinning layer, about two thirds of the silicon deep; charge made below it still diffuses to it, so the whole silicon counts. A ray counts in the pixel where it reaches its mean absorption depth; the filters’ curves are illustrative; no microlens shift towards the sensor’s corners.',
    draw: () => paint(),
  });
  const palette = (): StackPalette => ({
    lens: stage.rgba('--ss-lens', 0.6), R: stage.rgba('--ss-r', 0.85), G: stage.rgba('--ss-g', 0.85), B: stage.rgba('--ss-b', 0.85),
    oxide: stage.rgba('--m3-oxide', 0.3), metal: stage.rgb('--m3-metal'), si: stage.rgb('--m3-si'), diode: stage.rgb('--m3-n'),
    dti: stage.rgb('--ss-dti'), beol: stage.rgba('--m3-oxide', 0.22), warn: stage.rgb('--ss-warn'), dim: stage.rgb('--ss-dim'),
    pplus: stage.rgb('--ss-pplus'), arc: stage.rgba('--ss-arc', 0.8),
  });
  const pose = (): StackPose => { const sp = spec(); return { spec: sp, nm, angle, row, trace: traceStack(sp, optics, nm, angle, row, 9) }; };
  function paint(): void { const q = pose(); stage.paint(stackParts(q, palette()), stackAnchors(q)); readout(q); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);

  // The angular response: own-pixel share of the light past the filter against angle, FSI and BSI at this pitch.
  const CW = 240, CH = 120, L = 30, B = 22, T = 8, R = 8, xOf = (a: number) => L + (a / 30) * (CW - L - R), yOf = (v: number) => T + (1 - v) * (CH - T - B);
  const lineF = svg('polyline', { class: 'ss-cv-fsi' }), lineB = svg('polyline', { class: 'ss-cv-bsi' }), mark = svg('line', { class: 'ss-cv-at', y1: T, y2: CH - B });
  const axes = svg('g', { class: 'ss-cv-ax' },
    svg('line', { x1: L, x2: CW - R, y1: CH - B, y2: CH - B }), svg('line', { x1: L, x2: L, y1: T, y2: CH - B }),
    ...[0, 10, 20, 30].map((a) => svg('text', { x: xOf(a), y: CH - B + 13, 'text-anchor': 'middle' }, `${a}°`)),
    ...[0, 0.5, 1].map((v) => svg('text', { x: L - 4, y: yOf(v) + 3, 'text-anchor': 'end' }, `${v * 100}%`)));
  const legend = h('div', { class: 'ss-cv-leg' }, h('span', { class: 'f' }, 'FSI'), h('span', { class: 'b' }, 'BSI'));
  const curve = h('figure', { class: 'ss-cv' },
    h('figcaption', null, 'Own pixel against angle'),
    svg('svg', { viewBox: `0 0 ${CW} ${CH}`, role: 'img', 'aria-label': 'The share of the light past the filter that its own pixel absorbs, against the angle of the light, for front-side and back-side illumination' }, axes, lineF, lineB, mark),
    legend);
  let curveKey = '';
  function drawCurve(): void {
    const key = `${pitch}|${nm}|${ar}`;
    if (key !== curveKey) {
      curveKey = key;
      for (const [il, el] of [['fsi', lineF], ['bsi', lineB]] as const) {
        const ys = angleCurve(spec(il), optics, nm, CURVE_ANGLES);
        el.setAttribute('points', CURVE_ANGLES.map((a, i) => `${xOf(a).toFixed(1)},${yOf(ys[i]).toFixed(1)}`).join(' '));
      }
    }
    const x = xOf(Math.min(30, Math.abs(angle))).toFixed(1);
    mark.setAttribute('x1', x); mark.setAttribute('x2', x);
  }

  function readout(q: StackPose): void {
    const t = q.trace.total, s = q.spec, px = BAYER[q.row], p = tenths(t);
    chip.textContent = `${s.illum.toUpperCase()} · ${s.pitch.toFixed(1)} µm · ${q.nm} nm · ${q.angle}°`;
    chip.className = `r3-chip ${t.cross + t.metal > 0.1 ? 'warn' : 'good'}`;
    const spot = spotSize(s, q.trace.rc, q.nm);
    const rows: [string, string, string?][] = [
      ['Pixels cut', `${NAMES[px[0]]} · ${NAMES[px[1]]}`],
      ['Absorption depth 1/α', fmtUm(q.trace.depth)],
      ['Silicon that collects', fmtUm(s.si)],
      ['Stack, lens base to silicon', fmtUm(stackHeight(s))],
      ['Diffraction spot, 2.44 λ N', `${fmtUm(spot)}${spot > s.pitch ? ': wider than the pixel' : ''}`, spot > s.pitch ? 'bad' : ''],
      ['Silicon’s reflectance, 0°', pctOf(Math.round(1000 * siReflectance(s.layers[s.layers.length - 1].n, optics.nSi(q.nm), q.nm, s.arc)))],
      ...FATES.map(({ k, name }): [string, string] => [name[0].toUpperCase() + name.slice(1), pctOf(p[k])]),
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, cls]) => [h('span', null, k), h('span', { class: `v ${cls ?? ''}` }, v)]));
    const text = `${s.illum === 'fsi' ? 'FSI' : 'BSI'}, ${s.pitch.toFixed(1)} µm, at ${q.angle}°, ${q.nm} nm: ${FATES.map(({ k, name }) => `${pctOf(p[k])} ${name}`).join(', ')}.`;
    if (live.textContent !== text) live.textContent = text;
    angOut.textContent = `${angle}°`; nmOut.textContent = `${nm} nm`;
    drawCurve();
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
  const illumSeg = seg('Illumination', [['fsi', 'Front-side (FSI)'], ['bsi', 'Back-side (BSI)']], () => illum, (v) => { illum = v as Illum; stage.setView(frame()); });
  const pitchSeg = seg('Pixel pitch', PITCHES.map((p): [string, string] => [String(p), `${p.toFixed(1)} µm${p === PITCHES[0] ? ' (IMX183)' : ''}`]), () => String(pitch), (v) => { pitch = Number(v); stage.setView(frame()); });
  const arSeg = seg('Anti-reflection coating', [['1', 'AR coating'], ['0', 'Bare silicon']], () => (ar ? '1' : '0'), (v) => { ar = v === '1'; });
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
    h('p', { class: 'm3-sub' }, `A Bayer quad (${K} drawing units a µm), cut through the middle of its front row, at the chapter’s 2.4 µm or a phone’s 1.0 µm. Each pixel has a microlens over a colour filter; below, the light must reach the photodiode in the silicon. Front-side illuminated, it passes between three levels of metal first; back-side illuminated, the wafer is thinned and turned over, so the light enters through the back and the metal is below, out of the way. Tilt the light as a lens does towards the corners of a sensor, and change its wavelength: blue is absorbed in the first few hundred nanometres of silicon, red only microns down, near-infrared mostly not at all. Take the coating off and silicon, with an index near 4, reflects a fifth of the light back.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, illumSeg, pitchSeg, arSeg, rowSeg,
          h('label', { class: 'r3-sl ss-sl' }, h('span', null, 'Angle'), angSl, angOut),
          h('label', { class: 'r3-sl ss-sl' }, h('span', null, 'Wavelength'), nmSl, nmOut),
          h('div', { class: 'r3-btns' }, stage.resetBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'Where the light goes ', h('span', { class: 'r3-badge' }, 'traced')), kv, curve)));
  paint();
  return { el: panel, destroy() { stage.destroy(); } };
}
