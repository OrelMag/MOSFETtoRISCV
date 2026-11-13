// The CMOS 4T pixel in 3D (loaded on demand, pixel4t3d.ts): one back-illuminated 2.4 µm pixel, cut through its
// photodiode. Light of the chosen colour falls through the microlens and filter and is absorbed at the depth silicon
// gives that wavelength; its electrons gather in the pinned photodiode. Read steps the correlated double sampling
// sequence (imagesensor.ts cdsSequence): reset, sample the reset level, transfer, sample the signal; the floating
// diffusion's voltage and the column's two samples are plotted beside.

import '../styles/pixel4t3d.css';
import { h, s } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { absorptionDepth, C_FD_FF, CG_4T, ktcNoise, qe, SF_GAIN, VDD_PIX } from '../phys/imagesensor';
import { frameLoop } from './mosfet';
import { LOOKS } from '../gl/kit/looks';
import { modelStage } from './modelstage';
import {
  DRAWN, electronsOf, FILTER_NM, FULL_WELL, IDLE, nextPhase, PHOTONS_PER_FLASH, photonsAt, phaseOf, pixAnchors, pixParts, PITCH, SI_T, sequenceOf,
  type Filter, type Photon, type PixPalette, type PixState,
} from './pixel4t3dparts';

/** A photon falls for FALL_MS, its electron drifts for DRIFT_MS; a CDS phase is held READ_MS while Read runs. */
const FALL_MS = 700, DRIFT_MS = 500, READ_MS = 900;
const e = (n: number): string => `${groupNum(Math.round(n))} e⁻`;
const HOME = { target: [12, 10, 12] as [number, number, number], yaw: 2.65, pitch: 0.3, dist: 128 };
const ZOOM = { target: [16, 0, 17] as [number, number, number], yaw: 2.65, pitch: 0.3, dist: 42 };
const NAMES: Record<Filter, string> = { b: 'Blue', g: 'Green', r: 'Red' };

export function pixel4tView(): Widget {
  let last: Photon[] = [];
  let st: PixState = { ...IDLE }, filter: Filter = 'g', photons: Photon[] = [], seed = 1, cut = true, reading = false, held = 0;
  const panel = h('div', { class: 'panel px4t' });
  const stage = modelStage(panel, {
    look: LOOKS.silicon,
    aria: 'One back-illuminated CMOS pixel in 3D, cut through its photodiode: microlens, colour filter, thinned silicon with the pinned photodiode, and on the front side the transfer gate, floating diffusion, reset, source follower and row select transistors with their metal to the column line',
    camera: HOME,
    views: [{ label: 'Whole pixel', view: HOME }, { label: 'Zoom to the transistors', view: ZOOM, title: 'Close on the transfer gate, floating diffusion and the reset, follower and select transistors' }],
    limits: { minDist: 25, maxDist: 220 },
    note: `Drawn to scale (${PITCH} µm pixel, ${SI_T} µm of thinned silicon, absorption depths from Green's 2008 table) except the gate oxide, a few nanometres and not drawn. Representative, not IMX183's own (Sony does not publish them): the deep trench walls (0.08 µm inside each edge, full depth), the 0.28 µm shallow trench (the 0.25–0.3 µm class of Fossum & Hondongwa, IEEE J. EDS 2014), the HfO₂ / Ta₂O₅ / SiO₂ films (0.03, 0.065 and 0.095 µm, the last two a quarter wave at 550 nm), the 0.25 µm metal grid, and the 1.2 µm drawn of the bonded carrier wafer, which is hundreds of µm thick; the p+ back layer is drawn 0.05 µm, five times the 0.01 µm dead layer the model fits. The potential funnel is a sketch: the real field comes from graded doping and deep implants, so electrons born at the back are steered into the diode, not carried in a straight line as drawn. Poly (0.18 µm) and the metals are 0.18 µm-generation values; a 2.4 µm pixel's transistors are a newer, finer node (Sony does not say which). The layout is ours: a real ${PITCH} µm pixel shares its reset, follower and select transistors among two or four photodiodes. A dot is ${groupNum(Math.round(FULL_WELL / 60))} electrons, and each drawn photon stands for ${PHOTONS_PER_FLASH / DRAWN}. Sony does not publish the IMX183's conversion gain: ${CG_4T} µV/e⁻ is an illustrative value for a ${PITCH} µm pixel, and the floating diffusion's ${C_FD_FF.toFixed(2)} fF follows from it as q / CG; the full well (${groupNum(FULL_WELL)} e⁻) is an EMVA 1288 measurement.`,
    draw: () => draw(),
  });
  const palette = (): PixPalette => ({
    si: stage.rgba('--m3-si', 0.28), p: stage.rgb('--m3-p'), n: stage.rgb('--m3-n'), nplus: stage.rgb('--px-nplus'), poly: stage.rgb('--m3-poly'),
    metal: stage.rgb('--px-metal'), oxide: stage.rgba('--m3-oxide', 0.3), lens: stage.rgba('--px-lens', 0.35),
    filter: { b: stage.rgba('--px-b', 0.55), g: stage.rgba('--px-g', 0.55), r: stage.rgba('--px-r', 0.55) },
    charge: stage.rgb('--m3-charge'), hot: stage.rgb('--px-hot'), light: { b: stage.rgb('--px-b'), g: stage.rgb('--px-g'), r: stage.rgb('--px-r') },
    sti: stage.rgba('--px-sti', 0.85), dti: stage.rgba('--px-dti', 0.4), pback: stage.rgba('--m3-p', 0.85), grid: stage.rgb('--px-metal'),
    ar: [stage.rgba('--px-ar0', 0.9), stage.rgba('--px-ar1', 0.9), stage.rgba('--px-ar2', 0.75)], ild: stage.rgba('--m3-oxide', 0.16), wafer: stage.rgb('--px-wafer'),
  });
  const pose = () => ({ s: st, filter, photons, cut });
  const draw = () => stage.paint(pixParts(pose(), palette()), pixAnchors(pose()));

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), plotBox = h('div'), live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  stage.chips.append(chip);

  function plot(): SVGSVGElement {
    // Both traces on one axis: FD near the supply, the column a follower's drop below it (SF_GAIN × (FD − Vt)).
    const seq = sequenceOf(st), W = 300, H = 150, x0 = 34, cw = (W - x0 - 6) / 4, vMin = 1, vMax = VDD_PIX + 0.1;
    const y = (v: number) => 8 + ((vMax - v) / (vMax - vMin)) * (H - 30);
    const svg = s('svg', { class: 'px-plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The floating diffusion's voltage and the column's through the four phases of a read, with the column's reset and signal samples` }) as SVGSVGElement;
    for (const v of [VDD_PIX, 2, 1.2]) svg.append(s('line', { class: 'grid', x1: x0, x2: W - 6, y1: y(v), y2: y(v) }), s('text', { x: 0, y: y(v) + 3 }, `${v.toFixed(1)} V`));
    let pts = '', cpts = '';
    const dotsAt: SVGElement[] = [];
    seq.phases.forEach((p, i) => {
      const xa = x0 + i * cw, done = st.phase >= i;
      svg.append(s('text', { class: `ph${st.phase === i ? ' now' : ''}`, x: xa + cw / 2, y: H - 6, 'text-anchor': 'middle' }, p.name));
      if (!done) return;
      pts += ` ${xa},${y(p.fd)} ${xa + cw},${y(p.fd)}`;
      cpts += ` ${xa},${y(p.col)} ${xa + cw},${y(p.col)}`;
      if (p.sample) dotsAt.push(s('circle', { class: `smp ${p.sample}`, cx: xa + cw / 2, cy: y(p.col), r: 4 }));
    });
    if (st.phase >= 0) {
      const last = seq.phases[Math.min(st.phase, 3)];
      svg.append(s('polyline', { class: 'fd', points: pts.trim() }), s('polyline', { class: 'col', points: cpts.trim() }), ...dotsAt,
        s('text', { class: 'lbl', x: W - 8, y: y(last.fd) - 4, 'text-anchor': 'end' }, 'FD'), s('text', { class: 'lbl', x: W - 8, y: y(last.col) - 4, 'text-anchor': 'end' }, 'column'));
    }
    return svg;
  }

  /** Where the last flash's drawn photons stopped, by depth below the lit surface (µm), and how many passed through. */
  function stops(): string {
    if (!last.length) return '—';
    const bins = [0, 0, 0, 0];
    for (const p of last) bins[p.depth < 0.5 ? 0 : p.depth < 1.5 ? 1 : p.depth <= SI_T ? 2 : 3]++;
    return `${bins[0]} < 0.5 µm, ${bins[1]} to 1.5, ${bins[2]} to ${SI_T}, ${bins[3]} through`;
  }

  function readout(): void {
    const nm = FILTER_NM[filter], ph = phaseOf(st), seq = sequenceOf(st);
    chip.textContent = ph ? `${ph.name}: ${ph.note}` : reading ? 'reading' : `integrating under ${NAMES[filter].toLowerCase()} light`;
    chip.className = `r3-chip ${ph ? 'warn' : ''}`;
    const shr = seq.phases[1], shs = seq.phases[3];
    const rows: [string, string][] = [
      ['Light', `${NAMES[filter]}, ${nm} nm`],
      ['1/e absorption depth', `${absorptionDepth(nm) < 1 ? absorptionDepth(nm).toFixed(2) : absorptionDepth(nm).toFixed(1)} µm of ${SI_T} µm`],
      ['QE here', `${Math.round(qe(nm) * 100)} %`],
      ['Drawn photons stopped at', stops()],
      ['In the photodiode', e(st.pd)],
      ['On FD', st.phase < 0 ? '—' : st.phase < 2 ? 'reset, empty' : e(st.fd)],
      ['Column samples', st.phase >= 3 ? `${shr.col.toFixed(3)} V reset, ${shs.col.toFixed(3)} V signal` : st.phase >= 1 ? `${shr.col.toFixed(3)} V reset` : '—'],
      ['CDS: their difference', st.phase >= 3 ? `${(seq.cds * 1000).toFixed(1)} mV = ${e(seq.cdsE)}` : '—'],
      ['Conversion gain', `${CG_4T} µV/e⁻ (C_FD ${C_FD_FF.toFixed(2)} fF), follower ×${SF_GAIN}`],
      ['kTC reset noise', `${ktcNoise(C_FD_FF).toFixed(1)} e⁻ rms, cancelled by CDS`],
      ['Full well', e(FULL_WELL)],
    ];
    kv.replaceChildren(...rows.flatMap(([a, b]) => [h('span', null, a), h('span', { class: 'v' }, b)]));
    plotBox.replaceChildren(h('h4', null, 'Floating diffusion and the column'), plot());
    readBtn.textContent = reading ? 'Pause' : 'Read the row';
    readBtn.setAttribute('aria-pressed', String(reading));
  }

  const moving = () => photons.length > 0 || reading;
  const loop = frameLoop((_now, dt) => {
    const ms = dt * 1000;
    if (photons.length) {
      for (const p of photons) {
        const was = p.t;
        p.t += p.t < 1 ? ms / FALL_MS : ms / DRIFT_MS;
        if (was < 2 && p.t >= 2) st = { ...st, pd: Math.min(FULL_WELL, st.pd + electronsOf(p)) };
      }
      photons = photons.filter((p) => p.t < 2);
    }
    if (reading && !photons.length) {
      held += ms;
      if (held >= READ_MS) { held = 0; step(); if (st.phase < 0) reading = false; }
    }
    readout();
    draw();
  }, moving);
  function repaint(): void { readout(); draw(); loop.kick(); }

  function flash(): void {
    if (st.phase >= 0) st = { ...IDLE, pd: 0 };
    const fresh = photonsAt(FILTER_NM[filter], DRAWN, seed++);
    last = fresh;
    if (reducedMotion()) { for (const p of fresh) st = { ...st, pd: Math.min(FULL_WELL, st.pd + electronsOf(p)) }; }
    else photons.push(...fresh);
    const lost = fresh.filter((p) => electronsOf(p) === 0).length;
    live.textContent = `${PHOTONS_PER_FLASH} ${NAMES[filter].toLowerCase()} photons: ${DRAWN - lost} of ${DRAWN} drawn are absorbed in the silicon${lost ? `, ${lost} pass through it` : ''}`;
    repaint();
  }
  function step(): void {
    st = nextPhase(st);
    const ph = phaseOf(st);
    live.textContent = ph ? `${ph.name}: ${ph.note}` : 'Read done: the pixel integrates again';
  }

  const filterBtns = (['b', 'g', 'r'] as Filter[]).map((f) => {
    const b = h('button', { type: 'button', class: `btn sm on px-f ${f}`, 'aria-pressed': String(f === filter) }, NAMES[f]) as HTMLButtonElement;
    b.addEventListener('click', () => { filter = f; filterBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(['b', 'g', 'r'][i] === f))); repaint(); });
    return b;
  });
  const flashBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Expose');
  flashBtn.addEventListener('click', flash);
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step the read');
  stepBtn.addEventListener('click', () => { reading = false; photons = []; step(); repaint(); });
  const readBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'false' }, 'Read the row') as HTMLButtonElement;
  readBtn.addEventListener('click', () => { reading = !reading; held = READ_MS; repaint(); });
  const cutBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'true' }, 'Cut through');
  cutBtn.addEventListener('click', () => { cut = !cut; cutBtn.setAttribute('aria-pressed', String(cut)); repaint(); });
  const reset = h('button', { type: 'button', class: 'btn sm' }, 'Empty');
  reset.addEventListener('click', () => { reading = false; photons = []; st = { ...IDLE }; repaint(); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'One pixel, cut open'),
    h('p', { class: 'm3-sub' }, `A back-illuminated pixel, drawn with the light coming from above: microlens, colour filter, then ${SI_T} µm of silicon with the pinned photodiode at its foot, and the transistors and metal on the front side below it. Which colour has the lowest QE here? Guess, then expose each in turn. Each photon stops at the depth silicon gives its wavelength (blue near the top, red deep, some red straight through), and its electron is steered into the photodiode by the potential gradient. xfer is the transfer gate, sf the follower, rs the row select; DTI / STI are the deep and shallow trench isolation. Then step the read and watch the gates light and the floating diffusion's voltage fall in the plot.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Colour filter and light' }, ...filterBtns),
          h('div', { class: 'r3-btns' }, flashBtn, stepBtn, readBtn, reset, cutBtn), stage.viewBar()),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'This pixel ', h('span', { class: 'r3-badge' }, 'model')), kv), plotBox)));
  readout();
  draw();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
