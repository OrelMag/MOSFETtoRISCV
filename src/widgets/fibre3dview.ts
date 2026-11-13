// The optical fibre cut away, in 3D (loaded on demand, modelhost.ts). What it shows is the chapter's model (phys/fibre.ts):
// the critical angle and the guided / leaking decision are rayOf's, the acceptance cone is naOf's, the mode count is V's, and
// the pulse spread is stepDelayPsKm's (n1 * delta / c per km) for a step core, gradedDelayPsKm's (n1 * delta^2 / 8c) for the graded
// core every 50/125 fibre has. The motion between the stops is a drawing.

import '../styles/fibre3d.css';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { LOOKS } from '../gl/kit/looks';
import { modelStage } from './modelstage';
import { endTau, facts, fibreAnchors, fibreParts, FIBRES, LENGTH_KM, profileOf, pulseView, rayDelayOf, SIGMA_NS, X0, type FibrePalette, type FibreState, type Kind, type Profile } from './fibre3dparts';
import { bandwidthMHzKm, gradedDelayPsKm, stepDelayPsKm } from '../phys/fibre';
import type { OrbitView } from '../gl/camera';

const VIEW: OrbitView = { target: [0, 0, 0], yaw: 0.18, pitch: 0.4, dist: 118 };
/** Close on the input end face, where the core is: a 50 µm core fills a little of the 250 µm coating, an 8 µm one needs the closer view. */
const LOOK = (kind: Kind): OrbitView => ({ target: [X0 + 4, 0, 0], yaw: -0.9, pitch: 0.3, dist: kind === 'single' ? 11 : 30 });
/** Seconds for a pulse to cross the drawn stretch. */
const CROSS_S = 3.5;
const nf = (x: number, d = 1) => x.toFixed(d);

export function fibreView(initial: Kind = 'multi'): Widget {
  const st: FibreState = { kind: initial, deg: 6, tau: -1, profile: 'graded', look: false, cone: true };
  let running = false;
  const end = () => endTau(st.kind, profileOf(st));
  const stops = () => [0, 0.3, 0.6, 0.9, end()];

  const panel = h('div', { class: 'panel' });
  const palette = (): FibrePalette => ({
    glass: stage.rgba('--fb-glass', 0.28), coat: stage.rgba('--fb-coat', 0.2), core: stage.rgb('--fb-core'), coreEnd: stage.rgb('--fb-core'), ray: stage.rgb('--fb-ray'), fan: stage.rgb('--fb-fan'),
    leak: stage.rgb('--fb-leak'), pulse: stage.rgb('--fb-pulse'), glow: stage.rgba('--fb-glow', 0.55), air: stage.rgb('--fb-air'), cut: stage.rgb('--fb-cut'),
  });
  const stage = modelStage(panel, {
    look: LOOKS.lab,
    aria: 'An optical fibre cut away in 3D: the core, the cladding and the coating, with a ray launched at a chosen angle that is guided by total internal reflection or leaks into the cladding, and a pulse travelling down it',
    camera: { ...VIEW },
    limits: { minDist: 7, maxDist: 400 },
    views: [
      { label: 'Whole stretch', view: VIEW, pick: () => { st.look = false; paint(); } },
      { label: 'Look in', view: () => LOOK(st.kind), title: 'Close on the input end face: the core, the cladding and the coating to scale', pick: () => { st.look = true; paint(); } },
    ],
    note: `Scale: 12.5 µm to the unit across and along, so the drawn stretch is 1 mm of fibre, with true diameters (50 or 8 µm core, 125 µm cladding, 250 µm coating) and true ray angles (the bounce spacing and the graded ray’s 1.1 mm period are real). The delays and the pulse plot are for 1 km, and the packets’ lag is drawn 20 times too long (in a graded core it is too small to see). The rays are meridional (they cross the axis); skew rays are left out. The single-mode field is drawn as a Gaussian at the 10.4 µm mode-field diameter. Between the rays and the extreme one, a graded ray’s delay follows turning radius to the fourth power. Fresnel partial reflection, loss and bends are left out. The multimode core’s index (${FIBRES.multi.n1}) is illustrative: data sheets give the group index, not the core’s own.`,
    draw: () => paint(),
  });
  const paint = () => stage.paint(fibreParts(st, palette()), fibreAnchors(st));

  const chip = h('span', { class: 'r3-chip' });
  stage.chips.append(chip);
  const kv = h('div', { class: 'r3-kv' });
  const plot = s('svg', { class: 'fb-plot', viewBox: '0 0 360 150', role: 'img', 'aria-label': 'The input pulse and the pulse after the fibre' }) as SVGSVGElement;
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });

  function drawPlot(): void {
    const prof = profileOf(st), p = pulseView(st.kind, LENGTH_KM, 41, 240, prof), W = 360, H = 150, L = 8, R = 8, T = 18, B = 28;
    const x = (t: number) => L + ((t - p.t[0]) / (p.t[p.t.length - 1] - p.t[0])) * (W - L - R);
    const peak = Math.max(...p.input), y = (v: number) => T + (1 - v / peak) * (H - T - B);
    const poly = (v: number[], cls: string) => s('polyline', { class: cls, points: v.map((q, i) => `${x(p.t[i]).toFixed(1)},${y(q).toFixed(1)}`).join(' ') });
    const f = facts(st.kind, st.deg, prof), kids: SVGElement[] = [s('line', { class: 'ax', x1: L, x2: W - R, y1: H - B, y2: H - B })];
    const ticks = st.kind === 'multi' && p.spreadNs >= 2 ? [0, Math.round(p.spreadNs / 2), Math.round(p.spreadNs)] : st.kind === 'multi' ? [0, 5, 10] : [0];
    for (const t of ticks) { const e = s('text', { x: x(t), y: H - B + 13, 'text-anchor': 'middle' }); e.textContent = `${t}`; kids.push(s('line', { class: 'grid', x1: x(t), x2: x(t), y1: T, y2: H - B }), e); }
    const ax = s('text', { class: 'axl', x: W - R, y: H - 4, 'text-anchor': 'end' }); ax.textContent = `time after the input pulse, ns (${LENGTH_KM} km)`;
    kids.push(ax, poly(p.input, 'in'), poly(p.output, 'out'));
    if (st.kind === 'multi' && f.coupled) {
      const d = rayDelayOf(prof, st.deg, FIBRES.multi);
      kids.push(s('line', { class: 'mark', x1: x(d), x2: x(d), y1: T, y2: H - B }));
    }
    const lg = s('text', { class: 'lead', x: L + 4, y: 12 }); lg.textContent = st.kind === 'multi' ? (prof === 'graded' ? 'dashed: in · green: out (barely wider) · red: this ray' : 'dashed: in · green: out · red: this ray') : 'dashed: in · green: out (identical)';
    kids.push(lg);
    plot.replaceChildren(...kids);
  }

  function status(): string {
    const prof = profileOf(st), f = facts(st.kind, st.deg, prof), p = pulseView(st.kind, LENGTH_KM, 41, 240, prof);
    const graded = st.kind === 'multi' && prof === 'graded';
    if (graded) {
      const turn = f.coupled ? `guided: it turns back smoothly at ${nf(f.turn * 100, 0)} % of the core radius` : `leaks: it would turn back beyond the core edge (${nf(f.turn * 100, 0)} % of the radius), so it reaches the cladding`;
      return `Graded-index multimode, launched at ${st.deg}°: ${turn}. Output pulse spread ${nf(p.spreadNs * 1000, 0)} ps over ${LENGTH_KM} km.`;
    }
    const ray = f.coupled ? `guided: incidence ${nf(f.ray.incidenceDeg, 1)}° is beyond the critical angle ${nf(f.criticalDeg, 1)}°` : `leaks: incidence ${nf(f.ray.incidenceDeg, 1)}° is under the critical angle ${nf(f.criticalDeg, 1)}°, so it refracts into the cladding`;
    return `${st.kind === 'multi' ? 'Multimode' : 'Single-mode'}, launched at ${st.deg}°: ${ray}. ${st.kind === 'multi' ? `Output pulse spread ${nf(p.spreadNs, 1)} ns over ${LENGTH_KM} km.` : 'One mode, no modal spread.'}`;
  }

  function readout(announce = false): void {
    const prof = profileOf(st), f = facts(st.kind, st.deg, prof), p = pulseView(st.kind, LENGTH_KM, 41, 240, prof), graded = st.kind === 'multi' && prof === 'graded';
    chip.textContent = f.coupled ? (graded ? 'Guided: bent back by the index gradient' : 'Guided: total internal reflection') : 'Leaks into the cladding';
    chip.className = `r3-chip ${f.coupled ? 'good' : 'bad'}`;
    const rows: [string, string][] = [
      ['Core / cladding', `${FIBRES[st.kind].aUm * 2} / 125 µm`],
      ['n core · n cladding', `${nf(f.n1, 4)} · ${nf(f.n2, 4)}`],
      ['Critical angle sin⁻¹(n₂/n₁)', `${nf(f.criticalDeg, 2)}°`],
      [st.kind === 'multi' ? 'NA · accepted from air' : 'NA (from Δ) · accepted', `${nf(f.na, 3)} · ±${nf(f.acceptDeg, 1)}°`],
      ['This ray: in the core', `${nf(f.ray.coreDeg, 2)}° to the axis`],
      graded ? ['This ray: turns back at', `${nf(f.turn * 100, 0)} % of the core radius`] : ['This ray: at the wall', `${nf(f.ray.incidenceDeg, 2)}° to the normal`],
      [`V at ${Math.round(f.waveUm * 1000)} nm`, `${nf(f.v, 2)}`],
      ['Modes', f.singleMode ? '1 (two polarizations)' : graded ? `≈ ${nf(f.modes, 0)} (V²/4)` : `≈ ${nf(f.modes, 0)} (V²/2)`],
    ];
    if (st.kind === 'multi' && graded) {
      rows.push(['Spread n₁Δ²/8c · L', `${nf(gradedDelayPsKm(FIBRES.multi) * LENGTH_KM, 0)} ps (${nf(gradedDelayPsKm(FIBRES.multi), 0)} ps/km)`], ['Output rms width', `${nf(p.rmsOutNs, 2)} ns from ${SIGMA_NS} ns in`],
        ['Bandwidth · length, ideal', `${nf(bandwidthMHzKm(gradedDelayPsKm(FIBRES.multi)), 0)} MHz·km`], ['Real fibre (850 nm)', 'OM2 500 · OM3 2 000 · OM4 4 700']);
    } else if (st.kind === 'multi') {
      rows.push(['Spread n₁Δ/c · L', `${nf(p.spreadNs, 1)} ns (${nf(stepDelayPsKm(FIBRES.multi) / 1000, 1)} ns/km)`], ['Output rms width', `${nf(p.rmsOutNs, 1)} ns from ${SIGMA_NS} ns in`], ['Bandwidth · length', `${nf(bandwidthMHzKm(stepDelayPsKm(FIBRES.multi)), 0)} MHz·km`]);
    } else rows.push(['Modal spread', '0: one mode, one speed'], ['NA on data sheets', '0.14 (far-field definition; Δ gives 0.12)'], ['Mode field Ø · outside the core', `10.4 µm · ${nf(f.outsideCore * 100, 0)} % of the power`]);
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    sendBtn.textContent = running ? 'Pause' : 'Send pulse';
    sendBtn.setAttribute('aria-pressed', String(running));
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const t = status();
    if (live.textContent !== t) live.textContent = t;
  }

  const loop = frameLoop((_now, dt) => {
    if (running) {
      st.tau += dt * (end() / CROSS_S);
      if (st.tau >= end()) { st.tau = end(); running = false; readout(true); }
    }
    paint();
  }, () => running);
  const kick = () => { drawPlot(); readout(); paint(); loop.kick(); };

  const sendBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Send pulse') as HTMLButtonElement;
  sendBtn.addEventListener('click', () => {
    if (running) { running = false; readout(true); kick(); return; }
    if (reducedMotion()) { st.tau = end(); readout(true); kick(); return; }
    if (st.tau < 0 || st.tau >= end()) st.tau = 0;
    running = true; kick();
  });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => {
    running = false;
    st.tau = stops().find((v) => v > st.tau + 1e-9) ?? 0;
    readout(true); kick();
  });
  const resetPulse = () => { running = false; st.tau = -1; readout(true); kick(); };

  const input = h('input', { type: 'range', min: 0, max: 25, step: 0.5, value: st.deg, 'aria-label': 'Launch angle in air' }) as HTMLInputElement;
  const out = h('output', null, `${st.deg}°`);
  input.addEventListener('input', () => { st.deg = Number(input.value); out.textContent = `${st.deg}°`; kick(); });
  input.addEventListener('change', () => readout(true));
  const slider = h('label', { class: 'r3-sl' }, h('span', null, 'Launch angle'), input, out);

  const profiles: [Profile, string][] = [['graded', 'Graded index'], ['step', 'Step index']];
  const profBtns = profiles.map(([k, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(k === st.profile) }, label) as HTMLButtonElement;
    if (k === st.profile) b.classList.add('on');
    b.addEventListener('click', () => {
      if (st.profile === k) return;
      st.profile = k;
      profBtns.forEach((x, i) => { const on = profiles[i][0] === k; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      resetPulse();
    });
    return b;
  });
  const profSeg = h('div', { class: 'seg fb-seg', role: 'group', 'aria-label': 'Index profile of the multimode core' }, ...profBtns);
  const coneBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'true', title: 'The cone of launch angles in air that the fibre accepts' }, 'Acceptance cone') as HTMLButtonElement;
  coneBtn.addEventListener('click', () => { st.cone = !st.cone; coneBtn.classList.toggle('on', st.cone); coneBtn.setAttribute('aria-pressed', String(st.cone)); paint(); });
  const kinds: [Kind, string][] = [['multi', 'Multimode'], ['single', 'Single-mode']];
  const segBtns = kinds.map(([k, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(k === st.kind) }, label) as HTMLButtonElement;
    if (k === st.kind) b.classList.add('on');
    b.addEventListener('click', () => {
      if (st.kind === k) return;
      st.kind = k;
      segBtns.forEach((x, i) => { const on = kinds[i][0] === k; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      profSeg.hidden = k === 'single';
      if (st.look) stage.setView(LOOK(k));
      resetPulse();
    });
    return b;
  });
  profSeg.hidden = st.kind === 'single';

  panel.append(
    h('h3', { class: 'm3-title' }, 'The fibre cut open'),
    h('p', { class: 'm3-sub' }, 'A glass core inside a glass cladding of slightly lower index, in a 250 µm acrylate coating whose higher index strips any light that leaks into it. A ray meeting the core wall at more than the critical angle reflects totally, so only rays within the acceptance cone stay in; steeper ones refract into the cladding and are lost. Every 50/125 multimode fibre in use is graded-index (ITU-T G.651.1): the index falls smoothly from the axis, rays bend back along sinusoids and the modal spread shrinks from n₁Δ/c (step index, the contrast case) to n₁Δ²/8c per km. The single-mode core is so small that it carries one mode: no ray picture, one speed, no modal spread. The drawn stretch is 1 mm of fibre; the delays are for 1 km. Use Look in to see the 8 µm core to scale.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'seg fb-seg', role: 'group', 'aria-label': 'Fibre type' }, ...segBtns), profSeg, slider),
        h('div', { class: 'r3-btns r3-ctl' }, sendBtn, stepBtn, coneBtn),
        stage.viewBar(),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This fibre ', h('span', { class: 'r3-badge' }, 'the chapter’s model')), kv, plot)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  drawPlot(); readout(true); paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
