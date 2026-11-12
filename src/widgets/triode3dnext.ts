// The triode close-up on the studio renderer (the 3D state-of-the-art prototype): the same controls and physics as
// triode3dview.ts (grid voltage, heater time, space charge, switch on from cold), the tube in true geometry
// (widgets/triode3dkit.ts) on a studio stage with a quarter section, an exploded view, hover cards and a tour.

import '../styles/relay3d.css';
import '../styles/tube3d.css';
import { packInstances, type Instance } from '../gl/instances';
import { M } from '../gl/kit/materials';
import { HEATER_W } from '../phys/triode';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { studioStage } from './studiostage';
import { HOME, tubeModel } from './triode3dkit';
import { CLOUD_RATE, E_D, FLOW_RATE, GRID_MAX, MAX_ELECTRONS, electronAt, newElectron, rhoOf, staticElectrons, stateAt, stream, type Electron } from './triode3dview';
import { sphere } from '../gl/kit/geo';

const HEAT_END = 20, PLAY_RATE = 2;
const ELECTRON = sphere(E_D / 2, 8, 5);

export function triodeNextView(): Widget {
  let st = stateAt(0, HEAT_END);
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
  const host = h('div', { class: 'tube3d' });
  const stage = studioStage({
    aria: 'A 6SN7 twin triode in 3D',
    home: HOME,
    limits: { minDist: 18, maxDist: 420, minPitch: -1.3, maxPan: 90 },
    note: 'Overall size to scale; the electrodes inside are illustrative, their grid wire and electrons drawn larger than life, electron counts proportional to the current.',
    build: (detail) => tubeModel(st, { charge: chargeIn.checked, detail, electron: M.make({ base: '--tb-electron', metal: 0, rough: 0.4, emit: '--tb-electron', glow: 0.8 }) }),
  });
  const stateChip = h('span', { class: 'r3-chip' }), tempChip = h('span', { class: 'r3-chip' }), plateChip = h('span', { class: 'r3-chip' });
  stage.chips.append(stateChip, plateChip, tempChip);
  host.append(ctl, stage.el);

  const eMat = M.make({ base: '--tb-electron', metal: 0, rough: 0.4, emit: '--tb-electron', glow: 0.9, label: 'electrons (drawn larger than life)' });
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
      electrons = staticElectrons(e, flow, chargeIn.checked);
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
    stage.refresh();
    ensureAnim();
  };
  const set = (vg: number, th: number) => { st = stateAt(vg, Math.max(0, Math.min(HEAT_END, th))); gIn.value = String(st.vg); tIn.value = String(st.th); draw(); };
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
  const io = new IntersectionObserver((es) => { visible = es.some((x) => x.isIntersecting); ensureAnim(); });
  io.observe(stage.el);
  set(st.vg, st.th);
  const sum = h('p', { class: 'r3-hint' }, `Heater ${HEATER_W.toFixed(2)} W per section, always.`);
  host.append(sum);

  return {
    el: host,
    destroy() { dead = true; stop(); cancelAnimationFrame(anim); io.disconnect(); stage.destroy(); },
  };
}
