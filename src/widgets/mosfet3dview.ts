// The MOSFET in 3D (loaded on demand, modelhost.ts) on the studio renderer: the device in true geometry (mosfet3dkit.ts),
// with what the cross-section cannot show. W widens the current and L shortens it because of where they lie; the sheet
// is the model's inversion charge, the carriers keep the current constant through it (faster where it is thin), the
// depletion layer fills with bare ions up to Vt, and electrons stream down the source's plugs and up the drain's at a
// rate set by Id. The cut at the gate's middle is the cross-section above.

import '../styles/mosfet3d.css';
import { packInstances, type Instance } from '../gl/instances';
import { along, sphere } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import type { Vec3 } from '../gl/math';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { DEPL_MAX, L0, MOS_HOME, PLUG_PITCH, W0, depletionAt, extents, ionsAt, mosModel, plugSites, plugsFor, sheetAt, type MosLayout, type MosState } from './mosfet3dkit';
import type { BiasLink } from './mosshare';
import { carrierVelocity, channelCharge, current, depletionDepth, gateCap, sizedCurrent, VDD, VT } from './mosphys';
import { studioStage } from './studiostage';

const REGION = { cut: 'cut-off', lin: 'linear', sat: 'saturation' } as const;
const PER_W = 5, PER_L = 7, PER_PLUG = 6;
const CARRIER = sphere(7, 8, 5), ION = sphere(4.5, 6, 4), PLUG_E = sphere(9, 8, 5);

interface Carrier { x: number; z: number }

/** `link`: the gate and drain of the cross-section above (mosshare.ts); without it the view keeps its own. */
export function mosfetView(link?: BiasLink): Widget {
  const st: MosState = { vg: link?.vg ?? 1.2, vd: link?.vd ?? 0.9, w: 1, l: 1, layout: 'real' };
  let carriers: Carrier[] = [], plugPhase = 0;
  const stage = studioStage({
    aria: 'An NMOS transistor in 3D: source and drain islands, the channel between them, oxide and gate above, contacts and metal',
    home: MOS_HOME,
    limits: { minDist: 300, maxDist: 9000, minPitch: -0.6, maxPan: 2000 },
    note: 'A 180 nm-class device, the 1.8 V, 0.45 V model\'s, to scale in nanometres: oxide 4 nm, polysilicon 200 nm, spacers 60 nm, trenches 350 nm, plugs 220 nm, at the node\'s published or typical figures (point at a part for its source). Drawn larger than life: the channel sheet (a few nm in silicon), the electrons and ions. Left out: the dielectric around the plugs (it would hide everything), wells and the body contact.',
    build: (detail) => mosModel(st, detail),
  });

  const eMat = M.make({ base: '--m3-carrier', metal: 0, rough: 0.4, emit: '--m3-carrier', glow: 0.6, label: 'electrons (drawn larger than life)' });
  const ionMat = M.make({ base: '--mf-ion', metal: 0, rough: 0.6, label: 'bare acceptor ions (boron), drawn larger' });

  function seed(): void {
    const rows = Math.round(PER_W * st.w), cols = Math.round(PER_L * st.l);
    carriers = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) carriers.push({ x: (j + (i % 2) / 2) / cols, z: rows > 1 ? -1 + (2 * i) / (rows - 1) : 0 });
  }
  const flowing = () => current(st.vg - VT, st.vd).id > 0;

  /** The particles: carriers in the sheet, ions in the depletion layer, electrons in the plugs. */
  function particles(): void {
    const { hl, hw } = extents(st), on = flowing();
    const list: Instance[] = on ? carriers.map((c) => {
      const t = sheetAt(st, c.x);
      return { pos: [-hl + 2 * hl * c.x, -Math.max(5, t / 2), c.z * hw * 0.9] as Vec3, color: [1, 1, 1] };
    }) : [];
    stage.instances('carriers', CARRIER, eMat, packInstances(list));
    stage.instances('ions', ION, ionMat, packInstances(ionsAt(st).map((p) => ({ pos: p, color: [1, 1, 1] }))));
    const pe: Instance[] = [];
    if (on) for (const p of plugSites(st)) {
      if (p.kind === 'g') continue; // no current through the gate
      const path: Vec3[] = p.kind === 's' ? [[p.x, p.y1, p.z], [p.x, p.y0, p.z]] : [[p.x, p.y0, p.z], [p.x, p.y1, p.z]];
      for (let k = 0; k < PER_PLUG; k++) pe.push({ pos: along(path, (plugPhase + k / PER_PLUG) % 1), color: [1, 1, 1] });
    }
    stage.instances('plug electrons', PLUG_E, eMat, packInstances(pe));
  }

  const region = h('span', { class: 'r3-chip' }), idChip = h('span', { class: 'r3-chip' });
  stage.chips.append(region, idChip);
  const kv = h('div', { class: 'r3-kv' });

  const readout = () => {
    const vov = st.vg - VT, { kind } = current(vov, st.vd), id = sizedCurrent(vov, st.vd, st.w, st.l);
    region.textContent = REGION[kind];
    region.className = `r3-chip ${kind === 'cut' ? '' : kind === 'sat' ? 'warn' : 'good'}`;
    idChip.textContent = `Id = ${id.toFixed(0)} µA`;
    const n = plugsFor(st.w);
    const rows: [string, string][] = [
      ['Size', `W ${Math.round(W0 * st.w)} nm / L ${Math.round(L0 * st.l)} nm`],
      ['Depletion depth', `${Math.round(depletionDepth(st.vg) * 100)} % of max (${Math.round(depletionAt(st.vg))} of ${DEPL_MAX} nm)`],
      ['Overdrive', vov > 0 ? `${vov.toFixed(2)} V` : 'none'],
      ['Charge at the source', `${channelCharge(vov, st.vd, 0).toFixed(2)} V`],
      ['Charge at the drain', `${channelCharge(vov, st.vd, 1).toFixed(2)} V`],
      ['Drain current', `${id.toFixed(0)} µA`],
      ['Gate capacitance', `${gateCap(st.w, st.l).toFixed(1)} fF`],
      ['Contacts per island', `${n} (one per ${PLUG_PITCH} nm of width)`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
  };

  const repaint = () => { readout(); stage.refresh(); particles(); loop.kick(); };
  const loop = frameLoop((_now, dt) => {
    const vov = st.vg - VT, id = current(vov, st.vd).id;
    // Per unit width the current is k·(W/L)·…/W: the same through every x, so speed is that over the local charge; a
    // longer channel also has further to go.
    for (const c of carriers) {
      c.x += (carrierVelocity(id / st.l, channelCharge(vov, st.vd, c.x)) * dt * 0.28) / st.l;
      if (c.x >= 1) c.x -= 1;
    }
    // the plugs carry the same current: their electrons move at a rate set by Id per plug
    plugPhase = (plugPhase + (dt * 0.9 * sizedCurrent(vov, st.vd, st.w, st.l)) / (300 * plugsFor(st.w))) % 1;
    particles();
  }, () => flowing() && !reducedMotion());

  const fmtV = (v: number) => `${v.toFixed(2)} V`, fmtX = (v: number) => `${v}×`;
  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return { el: h('label', { class: 'r3-sl' }, h('span', null, label), input, out), set(v: number) { input.value = String(v); out.textContent = fmt(v); } };
  };
  const gSl = slider('Gate', 0, VDD, 0.01, st.vg, fmtV, (v) => { st.vg = v; link?.set(st.vg, st.vd, st); }),
    dSl = slider('Drain', 0, VDD, 0.01, st.vd, fmtV, (v) => { st.vd = v; link?.set(st.vg, st.vd, st); });
  const unlink = link?.follow(st, (g, d) => { st.vg = g; st.vd = d; gSl.set(g); dSl.set(d); repaint(); });
  // the two states: the chapter's simplified device, or what a process makes
  const layoutBtns: HTMLButtonElement[] = (['textbook', 'real'] as MosLayout[]).map((k) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(st.layout === k) }, k === 'real' ? 'Real layout' : 'Textbook') as HTMLButtonElement;
    b.addEventListener('click', () => { st.layout = k; for (const x of layoutBtns) x.setAttribute('aria-pressed', String(x === b)); repaint(); });
    return b;
  });
  const ctl = h('div', { class: 'r3-ctl' },
    gSl.el, dSl.el,
    slider('W', 1, 4, 0.5, st.w, fmtX, (v) => { st.w = v; seed(); }).el,
    slider('L', 1, 3, 0.5, st.l, fmtX, (v) => { st.l = v; seed(); }).el,
    h('div', { class: 'r3-btns mf-layout', role: 'group', 'aria-label': 'Layout' }, ...layoutBtns));
  stage.slot.append(ctl);

  const panel = h('div', { class: 'panel mf3' },
    h('h3', { class: 'm3-title' }, 'The same device, in three dimensions'),
    h('p', { class: 'm3-sub' }, (link ? 'Gate and drain here are the cross-section’s: move either and both follow, the same square-law model. ' : 'The same equations as the cross-section. ') + 'The cross-section is one slice (Cutaway shows it): it cannot show W, the width of the sheet, which runs into the page. Double W and there are two channels side by side, so the current doubles. Double L and each carrier goes twice as far at half the field, so it halves. Either way the gate gets bigger, and the capacitance is what you pay. The amber layer under the channel is the depletion layer, from the same depth law as the cross-section: it grows as √Vgs up to Vt and then stops.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el,
        h('details', { class: 'r3-hint mf-try' }, h('summary', null, 'Predict, then see: the depletion layer'),
          h('p', null, 'At Vgs = 0.30 V, is the depletion layer deeper or shallower than at Vt = 0.45 V? Set the gate and read “Depletion depth”: it is ' + Math.round(depletionDepth(0.3) * 100) + ' % of the maximum at 0.30 V and 100 % from 0.45 V up, since past Vt the extra gate charge goes into the channel, not deeper.'))),
      h('div', { class: 'r3-side' }, h('h4', null, 'This transistor ', h('span', { class: 'r3-badge' }, 'model')), kv)));

  seed();
  readout();
  particles();
  loop.kick();
  return { el: panel, destroy() { loop.stop(); unlink?.(); stage.destroy(); } };
}
