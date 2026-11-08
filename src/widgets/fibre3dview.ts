// The optical fibre cut away, in 3D (loaded on demand, modelhost.ts). What it shows is the chapter's model (phys/fibre.ts):
// the critical angle and the guided / leaking decision are rayOf's, the acceptance cone is naOf's, the mode count is V's, and
// the pulse spread is stepDelayPsKm's (n1 * delta / c per km). The motion between the stops is a drawing.

import '../styles/fibre3d.css';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { endTau, facts, fibreAnchors, fibreParts, FIBRES, LENGTH_KM, pulseView, rayDelayNs, SIGMA_NS, type FibrePalette, type FibreState, type Kind } from './fibre3dparts';
import { bandwidthMHzKm, stepDelayPsKm } from '../phys/fibre';
import type { OrbitView } from '../gl/camera';

const VIEW: OrbitView = { target: [0, 0, 0], yaw: 0.18, pitch: 0.4, dist: 118 };
/** Seconds for a pulse to cross the drawn stretch. */
const CROSS_S = 3.5;
const nf = (x: number, d = 1) => x.toFixed(d);

export function fibreView(initial: Kind = 'multi'): Widget {
  const st: FibreState = { kind: initial, deg: 6, tau: -1 };
  let running = false;
  const end = () => endTau(st.kind);
  const stops = () => [0, 0.3, 0.6, 0.9, end()];

  const panel = h('div', { class: 'panel' });
  const palette = (): FibrePalette => ({
    glass: stage.rgba('--fb-glass', 0.28), coat: stage.rgba('--fb-coat', 0.3), core: stage.rgb('--fb-core'), coreEnd: stage.rgb('--fb-core'), ray: stage.rgb('--fb-ray'), fan: stage.rgb('--fb-fan'),
    leak: stage.rgb('--fb-leak'), pulse: stage.rgb('--fb-pulse'), glow: stage.rgba('--fb-glow', 0.55), air: stage.rgb('--fb-air'), cut: stage.rgb('--fb-cut'),
  });
  const stage = modelStage(panel, {
    aria: 'An optical fibre cut away in 3D: the core, the cladding and the coating, with a ray launched at a chosen angle that is guided by total internal reflection or leaks into the cladding, and a pulse travelling down it',
    camera: { ...VIEW },
    limits: { minDist: 60, maxDist: 400 },
    note: 'The diameters are true to scale (50 or 8 µm core, 125 µm cladding, 250 µm coating) and the ray angles are true; the length is compressed, 80 units standing for 1 km, and the packets’ lag is drawn 20 times too long. The ray is a meridional ray; the single-mode field is drawn at the 10.4 µm mode-field diameter. Fresnel partial reflection, loss and bends are left out.',
    draw: () => paint(),
  });
  const paint = () => stage.paint(fibreParts(st, palette()), fibreAnchors(st));

  const chip = h('span', { class: 'r3-chip' });
  stage.chips.append(chip);
  const kv = h('div', { class: 'r3-kv' });
  const plot = s('svg', { class: 'fb-plot', viewBox: '0 0 360 150', role: 'img', 'aria-label': 'The input pulse and the pulse after the fibre' }) as SVGSVGElement;
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });

  function drawPlot(): void {
    const p = pulseView(st.kind), W = 360, H = 150, L = 8, R = 8, T = 18, B = 28;
    const x = (t: number) => L + ((t - p.t[0]) / (p.t[p.t.length - 1] - p.t[0])) * (W - L - R);
    const peak = Math.max(...p.input), y = (v: number) => T + (1 - v / peak) * (H - T - B);
    const poly = (v: number[], cls: string) => s('polyline', { class: cls, points: v.map((q, i) => `${x(p.t[i]).toFixed(1)},${y(q).toFixed(1)}`).join(' ') });
    const f = facts(st.kind, st.deg), kids: SVGElement[] = [s('line', { class: 'ax', x1: L, x2: W - R, y1: H - B, y2: H - B })];
    const ticks = st.kind === 'multi' ? [0, Math.round(p.spreadNs / 2), Math.round(p.spreadNs)] : [0];
    for (const t of ticks) { const e = s('text', { x: x(t), y: H - B + 13, 'text-anchor': 'middle' }); e.textContent = `${t}`; kids.push(s('line', { class: 'grid', x1: x(t), x2: x(t), y1: T, y2: H - B }), e); }
    const ax = s('text', { class: 'axl', x: W - R, y: H - 4, 'text-anchor': 'end' }); ax.textContent = `time after the input pulse, ns (${LENGTH_KM} km)`;
    kids.push(ax, poly(p.input, 'in'), poly(p.output, 'out'));
    if (st.kind === 'multi' && f.coupled) {
      const d = rayDelayNs(st.deg, FIBRES.multi);
      kids.push(s('line', { class: 'mark', x1: x(d), x2: x(d), y1: T, y2: H - B }));
    }
    const lg = s('text', { class: 'lead', x: L + 4, y: 12 }); lg.textContent = st.kind === 'multi' ? 'dashed: in · green: out · red: this ray' : 'dashed: in · green: out (identical)';
    kids.push(lg);
    plot.replaceChildren(...kids);
  }

  function status(): string {
    const f = facts(st.kind, st.deg), p = pulseView(st.kind);
    const ray = f.coupled ? `guided: incidence ${nf(f.ray.incidenceDeg, 1)}° is beyond the critical angle ${nf(f.criticalDeg, 1)}°` : `leaks: incidence ${nf(f.ray.incidenceDeg, 1)}° is under the critical angle ${nf(f.criticalDeg, 1)}°, so it refracts into the cladding`;
    return `${st.kind === 'multi' ? 'Multimode' : 'Single-mode'}, launched at ${st.deg}°: ${ray}. ${st.kind === 'multi' ? `Output pulse spread ${nf(p.spreadNs, 1)} ns over ${LENGTH_KM} km.` : 'One mode, no modal spread.'}`;
  }

  function readout(announce = false): void {
    const f = facts(st.kind, st.deg), p = pulseView(st.kind);
    chip.textContent = f.coupled ? 'Guided: total internal reflection' : 'Leaks into the cladding';
    chip.className = `r3-chip ${f.coupled ? 'good' : 'bad'}`;
    const rows: [string, string][] = [
      ['Core / cladding', `${FIBRES[st.kind].aUm * 2} / 125 µm`],
      ['n core · n cladding', `${nf(f.n1, 4)} · ${nf(f.n2, 4)}`],
      ['Critical angle sin⁻¹(n₂/n₁)', `${nf(f.criticalDeg, 2)}°`],
      ['NA · accepted from air', `${nf(f.na, 3)} · ±${nf(f.acceptDeg, 1)}°`],
      ['This ray: in the core', `${nf(f.ray.coreDeg, 2)}° to the axis`],
      ['This ray: at the wall', `${nf(f.ray.incidenceDeg, 2)}° to the normal`],
      [`V at ${Math.round(f.waveUm * 1000)} nm`, `${nf(f.v, 2)}`],
      ['Modes', f.singleMode ? '1 (two polarizations)' : `≈ ${nf(f.modes, 0)} (V²/2)`],
    ];
    if (st.kind === 'multi') {
      rows.push(['Spread n₁Δ/c · L', `${nf(p.spreadNs, 1)} ns (${nf(stepDelayPsKm(FIBRES.multi) / 1000, 1)} ns/km)`], ['Output rms width', `${nf(p.rmsOutNs, 1)} ns from ${SIGMA_NS} ns in`], ['Bandwidth · length', `${nf(bandwidthMHzKm(stepDelayPsKm(FIBRES.multi)), 0)} MHz·km`]);
    } else rows.push(['Modal spread', '0: one mode, one speed']);
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

  const kinds: [Kind, string][] = [['multi', 'Multimode'], ['single', 'Single-mode']];
  const segBtns = kinds.map(([k, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(k === st.kind) }, label) as HTMLButtonElement;
    if (k === st.kind) b.classList.add('on');
    b.addEventListener('click', () => {
      if (st.kind === k) return;
      st.kind = k;
      segBtns.forEach((x, i) => { const on = kinds[i][0] === k; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      resetPulse();
    });
    return b;
  });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The fibre cut open'),
    h('p', { class: 'm3-sub' }, 'A glass core inside a glass cladding of slightly lower index, in a 250 µm acrylate coating that carries no light. A ray meeting the core wall at more than the critical angle reflects totally, so only rays within the acceptance cone stay in; steeper ones refract into the cladding and are lost. In the multimode core the guided rays take paths of different length, so one input pulse arrives as a train of copies spread over n₁Δ/c per km. The single-mode core is so small that it carries one mode: no ray picture, one speed, no modal spread.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'seg fb-seg', role: 'group', 'aria-label': 'Fibre type' }, ...segBtns), slider),
        h('div', { class: 'r3-btns r3-ctl' }, sendBtn, stepBtn, stage.resetBtn),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This fibre ', h('span', { class: 'r3-badge' }, 'the chapter’s model')), kv, plot)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  drawPlot(); readout(true); paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
