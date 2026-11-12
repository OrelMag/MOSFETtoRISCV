// The triode close-up on the studio renderer: the tube in true geometry (widgets/triode3dkit.ts) on a studio stage
// (quarter section, exploded view, hover cards, a tour), with the same controls and physics as before (grid voltage,
// heater time, space charge, switch on from cold) and the same side panel: the transfer curve, the warm-up, the
// section's numbers and the dissipation bar.

import '../styles/relay3d.css';
import '../styles/tube3d.css';
import { packInstances, type Instance } from '../gl/instances';
import { sphere } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import { B_PLUS, HEATER_W, R_PLATE, warmup } from '../phys/triode';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { studioStage } from './studiostage';
import { HOME, tubeModel } from './triode3dkit';
import {
  GRID_MAX, H1, H2, PLATE_RATING_W, PW, amps, drawWarm, drawXfer, electronAt, newElectron, returned, rhoOf, staticElectrons, stateAt, stream, type Electron,
} from './triode3dview';

const HEAT_END = 20, PLAY_RATE = 2;
/** Electrons drawn: smaller and more of them than the first close-up (still symbolic: real ones are points). */
const E_R = 0.09, CLOUD_RATE = 380, FLOW_RATE = 150, MAX_ELECTRONS = 900;
const ELECTRON = sphere(E_R, 6, 4);

export function triodeNextView(): Widget {
  let st = stateAt(0, HEAT_END), curve = warmup(st.vg, HEAT_END, 0.05);
  let electrons: Electron[] = [], anim = 0, last = 0, spawnA = 0, spawnP = 0, playing = 0, visible = true, dead = false;

  const gIn = h('input', { type: 'range', min: -20, max: GRID_MAX, step: 0.25, value: st.vg, 'aria-label': 'Grid voltage' }) as HTMLInputElement;
  const gOut = h('output', null, '');
  const tIn = h('input', { type: 'range', min: 0, max: HEAT_END, step: 0.1, value: st.th, 'aria-label': 'Time since the heater was switched on' }) as HTMLInputElement;
  const tOut = h('output', null, '');
  const chargeIn = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const coldBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Switch on from cold');
  const ctl = h('div', { class: 'r3-ctl' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Grid'), gIn, gOut),
    h('label', { class: 'r3-sl' }, h('span', null, 'Heater on for'), tIn, tOut),
    h('label', { class: 'r3-chk' }, chargeIn, 'Space charge'),
    h('div', { class: 'r3-btns' }, coldBtn));
  const stage = studioStage({
    aria: 'A 6SN7 twin triode in 3D',
    home: HOME,
    limits: { minDist: 12, maxDist: 520, minPitch: -1.3, maxPan: 120 },
    note: 'Overall size to scale; the electrodes inside are illustrative, their grid wire and electrons drawn larger than life, electron counts proportional to the current. The grid stops at 0 V: above it a real grid draws current, which the model leaves out.',
    build: (detail) => tubeModel(st, { charge: chargeIn.checked, detail, electron: eMat }),
  });
  stage.slot.append(ctl);
  const stateChip = h('span', { class: 'r3-chip' }), tempChip = h('span', { class: 'r3-chip' }), plateChip = h('span', { class: 'r3-chip' });
  stage.chips.append(stateChip, plateChip, tempChip);

  // The side panel, as the first close-up had it.
  const xfer = s('svg', { class: 'r3-plot t3-plot t3-static', viewBox: `0 0 ${PW} ${H1}`, role: 'img', 'aria-label': 'Plate voltage against grid voltage with the cathode hot, the operating point and the cutoff marked' }) as SVGSVGElement;
  const warm = s('svg', { class: 'r3-plot t3-plot', viewBox: `0 0 ${PW} ${H2}`, role: 'img', 'aria-label': 'Plate current against time since switch-on at this grid voltage; point or drag to set the heater time' }) as SVGSVGElement;
  const kv = h('div', { class: 'r3-kv' });
  const bar = h('i'), barBox = h('div', { class: 't3-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': PLATE_RATING_W, 'aria-label': 'Plate dissipation against the 2.5 watt rating' }, bar);
  const barNote = h('div', { class: 'r3-hint' });
  const el = h('div', { class: 'r3 tube3d' },
    h('div', { class: 'r3-main' }, stage.el),
    h('div', { class: 'r3-side' }, xfer, warm, h('h4', null, 'This section ', h('span', { class: 'r3-badge' }, 'model')), kv, barBox, barNote));

  const summary = () => {
    const { vp, ip } = st, bit = vp > 200 ? '1 (cut off)' : vp < 120 ? '0 (conducting)' : 'between';
    const rows: [string, string, string?][] = [
      ['Circuit', `${B_PLUS} V through ${R_PLATE / 1e3} kΩ`],
      ['Cathode', `${Math.round(st.Tc)} K`, st.Tc > 800 ? 'hot' : ''],
      ['Emission limit', amps(st.sat)],
      ['Falls back to the cathode', `${(100 * returned(st)).toFixed(1)} %`],
      ['Plate current', `${(ip * 1e3).toFixed(2)} mA`],
      ['Plate voltage', `${vp.toFixed(1)} V`],
      ['As a bit', bit, vp > 200 || vp < 120 ? '' : 'bad'],
      ['Plate dissipation', `${(vp * ip).toFixed(2)} W of ${PLATE_RATING_W} W`],
      ['Plate resistor', `${((B_PLUS - vp) * ip).toFixed(2)} W`],
      ['Heater', `${HEATER_W.toFixed(2)} W, always`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, c]) => [h('span', null, k), h('span', { class: `v ${c ?? ''}` }, v)]));
    const pw = vp * ip;
    bar.style.width = `${Math.min(100, (100 * pw) / PLATE_RATING_W)}%`;
    barBox.setAttribute('aria-valuenow', pw.toFixed(2));
    barBox.classList.toggle('over', pw > PLATE_RATING_W);
    barNote.textContent = `Plate ${pw.toFixed(2)} W against the 6SN7GTB rating of ${PLATE_RATING_W} W (max 450 V, 20 mA of cathode current per section).`;
  };

  const eMat = M.make({ base: '--tb-electron', metal: 0, rough: 0.4, emit: '--tb-electron', glow: 0.7, label: 'electrons (drawn larger than life)' });
  const putElectrons = () => {
    const list: Instance[] = electrons.map((q) => ({ pos: electronAt(q.th, q.y, rhoOf(q)), color: [1, 1, 1] }));
    stage.instances('electrons', ELECTRON, eMat, packInstances(list));
  };
  const tick = (now: number) => {
    anim = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const { e, flow } = stream(st);
    spawnA += e * CLOUD_RATE * (chargeIn.checked ? 1 : 0) * dt;
    spawnP += flow * FLOW_RATE * dt;
    for (; spawnA >= 1; spawnA--) if (electrons.length < MAX_ELECTRONS) electrons.push(newElectron(false, Math.random));
    for (; spawnP >= 1; spawnP--) if (electrons.length < MAX_ELECTRONS) electrons.push(newElectron(true, Math.random));
    electrons = electrons.filter((q) => (q.ph += dt / q.dur) < 1);
    putElectrons();
    ensureAnim();
  };
  const ensureAnim = () => {
    if (reducedMotion()) {
      cancelAnimationFrame(anim); anim = 0;
      const { e, flow } = stream(st);
      electrons = [...staticElectrons(e, flow, chargeIn.checked), ...staticElectrons(e, flow, chargeIn.checked).map((q) => ({ ...q, th: q.th + 1.3, y: q.y * 0.97 + 1 }))];
      putElectrons();
      return;
    }
    const want = visible && !dead && !stage.isFlat() && (stream(st).e > 0 || electrons.length > 0);
    if (want && !anim) { last = performance.now(); anim = requestAnimationFrame(tick); }
    if (!want && anim) { cancelAnimationFrame(anim); anim = 0; }
  };

  const draw = () => {
    gOut.textContent = `${st.vg.toFixed(2).replace('-', '−')} V`;
    tOut.textContent = `${st.th.toFixed(1)} s`;
    const { e } = stream(st);
    const [label, cls] = e === 0 ? ['cold', ''] : e < 1 ? ['warming', 'warn'] : st.vp > 200 ? ['cut off', ''] : st.vp < 120 ? ['conducting', 'good'] : ['between', 'warn'];
    stateChip.textContent = label; stateChip.className = `r3-chip ${cls}`;
    plateChip.textContent = `plate ${st.vp.toFixed(0)} V`;
    tempChip.textContent = `cathode ${Math.round(st.Tc)} K`; tempChip.className = `r3-chip ${st.Tc > 800 ? 'hot' : ''}`;
    drawXfer(xfer, st);
    drawWarm(warm, curve, st);
    summary();
    stage.refresh();
    ensureAnim();
  };
  const set = (vg: number, th: number) => {
    const newCurve = vg !== st.vg;
    st = stateAt(vg, Math.max(0, Math.min(HEAT_END, th)));
    if (newCurve) curve = warmup(vg, HEAT_END, 0.05);
    gIn.value = String(st.vg); tIn.value = String(st.th);
    draw();
  };
  const stop = () => { cancelAnimationFrame(playing); playing = 0; coldBtn.textContent = 'Switch on from cold'; };
  gIn.addEventListener('input', () => set(Number(gIn.value), st.th));
  tIn.addEventListener('input', () => { stop(); set(st.vg, Number(tIn.value)); });
  chargeIn.addEventListener('change', () => { electrons = []; draw(); });
  coldBtn.addEventListener('click', () => {
    if (playing) { stop(); return; }
    if (reducedMotion()) { set(st.vg, HEAT_END); return; }
    electrons = [];
    const t0 = performance.now();
    coldBtn.textContent = 'Stop';
    const step = (now: number) => {
      set(st.vg, ((now - t0) / 1000) * PLAY_RATE);
      playing = st.th < HEAT_END ? requestAnimationFrame(step) : 0;
      if (!playing) coldBtn.textContent = 'Switch on from cold';
    };
    playing = requestAnimationFrame(step);
  });
  const scrub = (e: PointerEvent) => {
    const r = warm.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * PW;
    stop();
    set(st.vg, Math.round(((x - 40) / 296) * HEAT_END * 10) / 10);
  };
  warm.addEventListener('pointerdown', (e) => { warm.setPointerCapture(e.pointerId); scrub(e); });
  warm.addEventListener('pointermove', (e) => { if (warm.hasPointerCapture(e.pointerId)) scrub(e); });
  const io = new IntersectionObserver((es) => { visible = es.some((x) => x.isIntersecting); ensureAnim(); });
  io.observe(stage.el);
  set(st.vg, st.th);

  return {
    el,
    destroy() { dead = true; stop(); cancelAnimationFrame(anim); io.disconnect(); stage.destroy(); },
  };
}
