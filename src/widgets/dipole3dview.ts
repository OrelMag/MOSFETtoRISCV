// The dipole in 3D (loaded on demand, modelhost.ts) on the studio renderer: the antenna in true geometry
// (dipole3dkit.ts) on a studio stage (a cut through the pattern and the coax, the coax's layers pulled apart, hover
// cards, a tour), driven by the closed forms of dipole3dparts.ts. Frequency, length and pattern are the radio chapter's
// own; the motion is a drawing of a standing wave and of the near field's loops, slowed down.

import '../styles/dipole3d.css';
import { packInstances, type RGB } from '../gl/instances';
import { sphere } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import { apertureM2 } from '../phys/radio';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { ANTENNA_GHZ } from './radio';
import { studioStage, type StudioStage } from './studiostage';
import { BEAT_LAYERS, COAX, FRAME_GROUPS, GHZ_HI, HI_VIEW, HOME, apertureMm2, dipoleModel, loopBeads, type DipoleLook, type Layer } from './dipole3dkit';
import {
  DEFICIT, DRAW_RATE, DipoleRun, END_EFFECT, FEED_W, FREQ_HZ, LAMBDA, L_HALF, L_MAX, L_MIN, REAL_DIAMETER, DRAWN_SCALE, SLOWDOWN, STEP_PHASE, Z0_COAX,
  cutLength, feedDrive, feedResistance, gainDbi, halfPower, loopBirth, mismatch, type Feed, type PatternMode,
} from './dipole3dparts';

const STEP_MS = 380;
/** One decimal, with no '-0.0': anything under 0.05 reads 0.0. */
const f1 = (x: number) => (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);
const sci = (x: number) => { const e = Math.floor(Math.log10(x)); return `${(x / 10 ** e).toFixed(1)} × 10${String(e).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)])}`; };
const fmtR = (r: number) => (!Number.isFinite(r) || r > 2000 ? 'very high (a current null at the feed)' : `${r < 100 ? r.toFixed(0) : Math.round(r / 5) * 5} Ω`);
const FEEDS: [Feed, string][] = [['balanced', 'Feed: leads'], ['coax', 'Feed: coax, no balun'], ['balun', 'Feed: coax + sleeve']];
const BEAD = sphere(1.3, 10, 6);
/** Until the stage resolves the theme's colours (the first build runs inside studioStage). */
const FALLBACK: DipoleLook['rgb'] = { cu: [0.84, 0.54, 0.29], pos: [1, 0.35, 0.29], neg: [0.31, 0.55, 1] };

export function dipoleView(): Widget {
  const run = new DipoleRun();
  /** The reader's layers (the chips); the tour's beats lend their own while they play and give these back at its end. */
  const mine = new Set<Layer>();
  let shown: ReadonlySet<Layer> = mine;
  const look: Omit<DipoleLook, 'detail' | 'rgb' | 'layers'> = { mode: 'power', feed: 'balanced' };
  let running = false, target: number | null = null, lastRead = 0, stageRef: StudioStage | null = null;
  const rgb = (): DipoleLook['rgb'] => (stageRef ? { cu: stageRef.rgb('--dp-cu'), pos: stageRef.rgb('--dp-pos'), neg: stageRef.rgb('--dp-neg') } : FALLBACK);

  const stage = studioStage({
    aria: 'A half-wave dipole antenna in 3D: two copper arms with a feed gap, coloured by the current running along them; layers add the current and voltage curves, the field leaving it, its doughnut-shaped radiation pattern against an isotropic sphere of the same power, its effective aperture and the same dipole at 28 GHz',
    home: HOME,
    // home is the antenna and its feed, large (a box round them, never drawn), whatever is layered on
    homeFrame: ['homebox'],
    hidden: [...FRAME_GROUPS],
    limits: { minDist: 20, maxDist: 1600, maxPan: 400 },
    onBeat: (i) => {
      shown = i >= 0 ? new Set(BEAT_LAYERS[i] ?? []) : mine;
      syncChips();
      draw();
    },
    note: `Scaled or drawn, not solved: the ${f1(LAMBDA)} cm wavelength and the ${f1(cutLength(L_HALF))} cm cut length are to scale (the half wave is ${f1(LAMBDA / 2)} cm electrical; the end effect shortens a thin wire by about ${Math.round((1 - END_EFFECT) * 100)} %, taken as a constant ${(DEFICIT / 2).toFixed(2)} cm a tip at every length); the ${REAL_DIAMETER * 10} mm copper rod is drawn ${DRAWN_SCALE}× thicker, and the height of the current and voltage curves is arbitrary. Current and voltage are the sinusoidal standing waves of a thin centre-fed dipole (Balanis, ch. 4); the field loops and magnetic rings are a cartoon of the near field, not a solution of Maxwell's equations; the pattern is the exact far-field shape of that current, drawn close in (the far field starts about a wavelength out). The coax is to scale (UT-085C, ${COAX.jacket.toFixed(2)} mm), the sleeve a quarter wave in air. Time runs ${sci(SLOWDOWN)} times slower than real (${DRAW_RATE} periods a second at ${f1(ANTENNA_GHZ)} GHz). The impedances are the resistive part only; the reactance (+42.5 Ω at λ/2) is not computed.`,
    build: (detail) => dipoleModel(run, { ...look, detail, layers: shown, rgb: rgb() }),
  });
  stageRef = stage;
  const beadMat = M.beam([0, 0, 0], 1, 'electric field loop (a cartoon of the near field)');
  const NONE = new Float32Array(0);
  /** The electric loops are instanced beads: drawn only with the Fields layer. */
  const putLoops = () => {
    if (stage.isFlat()) return;
    if (!shown.has('fields')) { stage.instances('loops', BEAD, beadMat, NONE); return; }
    const c = (t: string): RGB => stage.rgb(t);
    stage.instances('loops', BEAD, beadMat, packInstances(loopBeads(run, { e1: c('--dp-e1'), e2: c('--dp-e2') })));
  };
  /** The 28 GHz layer comes with its own view: the small dipole large, the 2.4 GHz arm a copper bar beside it, the phone behind. */
  const goView = (v: { target: [number, number, number]; yaw: number; pitch: number; dist: number } | null) => {
    const st = stage.studio();
    if (!st) return;
    if (!v) { st.camera.reset(); st.invalidate(); return; }
    const c = st.camera;
    c.limits.minDist = Math.min(c.limits.minDist, v.dist * 0.5);
    c.target = [...v.target]; c.yaw = v.yaw; c.pitch = v.pitch; c.dist = v.dist;
    st.invalidate();
  };

  // ---------------------------------------------------------------- the feed current against time, with the loops' births

  const SW = 320, SH = 84, WIN = 2;
  const strip = s('svg', { class: 'dp-strip', viewBox: `0 0 ${SW} ${SH}`, role: 'img', 'aria-label': 'The feed current against time over the last two periods; a tick where a field loop was born (the current passing through zero)' }) as SVGSVGElement;
  const drawStrip = () => {
    const t1 = run.t, t0 = t1 - WIN, X = (t: number) => 8 + ((t - t0) / WIN) * (SW - 16), Y = (v: number) => SH / 2 - v * (SH / 2 - 20);
    const amp = Math.sin(Math.PI * run.lwl);
    const pts = Array.from({ length: 121 }, (_, i) => { const t = t0 + (WIN * i) / 120; return `${X(t).toFixed(1)},${Y(Math.cos(2 * Math.PI * t) * amp).toFixed(1)}`; });
    const births: SVGElement[] = [];
    for (let n = Math.ceil(2 * (t0 - 0.25)); loopBirth(n) <= t1; n++) if (loopBirth(n) >= t0) births.push(s('line', { x1: X(loopBirth(n)), x2: X(loopBirth(n)), y1: 18, y2: SH - 18, class: `dp-birth ${n % 2 === 0 ? 'a' : 'b'}` }));
    strip.replaceChildren(
      s('line', { x1: 8, x2: SW - 8, y1: SH / 2, y2: SH / 2, class: 'dp-axis' }), ...births,
      s('polyline', { points: pts.join(' '), class: 'dp-i' }),
      s('circle', { cx: X(t1), cy: Y(run.feed), r: 3.5, class: 'dp-now' }),
      s('text', { x: 10, y: 11, class: 'dp-lbl' }, 'feed current I(t), now at the right'),
      s('text', { x: SW - 10, y: SH - 2, class: 'dp-lbl', 'text-anchor': 'end' }, 'ticks: a loop is born (I = 0)'));
  };

  // ---------------------------------------------------------------- readouts

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const sense = (v: number) => (Math.abs(v) < 0.05 ? 'zero' : v > 0 ? 'up the upper arm' : 'down the upper arm');
  const status = () => {
    const v = run.feed;
    return `Phase ${run.degrees}°, length ${run.lwl.toFixed(2)} λ: feed current ${f1(v)} of the wave's peak, ${sense(v)}; tip current ${f1(run.tip)}.${Math.abs(Math.cos(run.phase)) < 0.05 ? ' The charge at the tips is at its peak: a new field loop forms.' : ''}`;
  };
  const readout = (announce = false) => {
    const v = run.feed, L = run.lwl, half = Math.abs(L - L_HALF) < 1e-9, hp = halfPower(L), rin = feedResistance(L);
    chip.textContent = `Phase ${run.degrees}°`;
    chip.className = `r3-chip ${Math.abs(v) < 0.05 ? 'warn' : 'good'}`;
    const rows: [string, string][] = [
      ['Frequency', `${f1(ANTENNA_GHZ)} GHz`], ['Wavelength λ', `${f1(LAMBDA)} cm`],
      ['Electrical length', `${L.toFixed(2)} λ = ${f1(L * LAMBDA)} cm`], ['Cut length', `${f1(cutLength(L))} cm${half ? ' (end effect, 0.95)' : ''}`],
      ['Period (real)', `${(1e9 / FREQ_HZ).toFixed(3)} ns`], ['Feed current', `${f1(v)} of peak`], ['Tip current', f1(run.tip)],
      ['Feed resistance', fmtR(rin)], ['Gain (power)', `${gainDbi(L).toFixed(2)} dBi`],
      ['Half-power width', `${Math.round((hp.width * 180) / Math.PI)}° (−3 dB)`],
      ['Aperture', `${(apertureMm2(L, ANTENNA_GHZ) / 100).toFixed(1)} cm² (0 dBi: ${(apertureM2(0, ANTENNA_GHZ) * 1e4).toFixed(1)})`],
      [`At ${GHZ_HI} GHz`, `${(apertureMm2(L, GHZ_HI) / 100).toFixed(2)} cm² (0 dBi: ${(apertureM2(0, GHZ_HI) * 1e4).toFixed(2)})`],
    ];
    if (Number.isFinite(rin) && rin < 2000) {
      const d = feedDrive(rin), m = mismatch(rin);
      rows.push([`${FEED_W} W drive`, `${d.amps.toFixed(3)} A, ${d.volts.toFixed(0)} V peak`], [`On ${Z0_COAX} Ω coax (tuned)`, `SWR ${m.swr.toFixed(2)}, ${m.returnLoss.toFixed(1)} dB return loss`]);
    }
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    lenOut.textContent = `${L.toFixed(2)} λ`;
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = status();
    if (live.textContent !== text) live.textContent = text;
  };
  // The flat view (no WebGL2) redraws every face as SVG: while the wave runs, at most every 150 ms there.
  let flatAt = 0;
  const draw = (frame = false) => {
    const now = performance.now();
    if (!(frame && stage.isFlat() && now - flatAt < 150)) { flatAt = now; stage.refresh(); }
    putLoops(); drawStrip();
  };

  const loop = frameLoop((now, dt) => {
    if (running) run.advance(dt * DRAW_RATE);
    else if (target !== null) {
      run.t += (dt * 1000 * STEP_PHASE) / STEP_MS;
      if (run.t >= target - 1e-9) { run.t = target; target = null; readout(true); }
    }
    // the numbers ten times a second at most while running; the picture every frame
    if (!running || now - lastRead > 100) { lastRead = now; readout(); }
    draw(true);
  }, () => running || target !== null);
  const kick = () => { readout(); draw(); loop.kick(); };

  // ---------------------------------------------------------------- controls

  const btn = (label: string, title = '', pressed?: boolean) => h('button', { type: 'button', class: `btn sm${pressed ? ' on' : ''}`, title, ...(pressed === undefined ? {} : { 'aria-pressed': String(pressed) }) }, label) as HTMLButtonElement;
  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  const syncMotion = () => {
    const still = reducedMotion();
    runBtn.disabled = still;
    runBtn.title = still ? 'Reduced motion is on: use Step a phase' : '';
    if (still && running) { running = false; readout(true); }
  };
  runBtn.addEventListener('click', () => { if (reducedMotion()) return; running = !running; target = null; if (!running) readout(true); kick(); });
  const stepBtn = btn('Step a phase (45°)');
  stepBtn.addEventListener('click', () => {
    running = false;
    const next = (target ?? Math.round(run.t / STEP_PHASE) * STEP_PHASE) + STEP_PHASE;
    if (reducedMotion()) { run.t = next; target = null; } else target = next;
    readout(true); kick();
  });
  const toggle = (b: HTMLButtonElement, on: boolean) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  const modeBtn = btn('Doughnut: power', 'The pattern as the power (the field squared: what the gain describes) or as the field amplitude');
  modeBtn.addEventListener('click', () => {
    look.mode = (look.mode === 'power' ? 'field' : 'power') as PatternMode;
    modeBtn.textContent = look.mode === 'power' ? 'Doughnut: power' : 'Doughnut: field';
    kick();
  });
  const feedBtn = btn(FEEDS[0][1], 'Cycle: balanced leads, a bare coax (current on the braid), a coax with a quarter-wave sleeve balun');
  feedBtn.addEventListener('click', () => {
    const i = (FEEDS.findIndex(([k]) => k === look.feed) + 1) % FEEDS.length;
    look.feed = FEEDS[i][0]; feedBtn.textContent = FEEDS[i][1]; kick();
  });
  // The layers, one chip each: the antenna alone to begin with, each chip adds one thing over it.
  const CHIPS: [Layer, string, string][] = [
    ['curves', 'Current & voltage', 'The current I(z) and the voltage V(z) along the arms, as curves beside them'],
    ['fields', 'Fields', 'The electric loops leaving at c and the magnetic rings round the arms (a cartoon of the near field)'],
    ['pattern', 'Pattern', 'The far-field pattern: how much is radiated each way'],
    ['iso', 'vs isotropic', 'The isotropic sphere of the same total power, and the half-power rings: the gain as aiming'],
    ['aperture', 'Aperture', 'The area of a passing wave this dipole collects, A = Gλ²/4π'],
    ['hi', `${GHZ_HI} GHz beside it`, `The same dipole at ${GHZ_HI} GHz with its aperture, a phone behind for scale; the camera goes to it`],
  ];
  const chipBtns = CHIPS.map(([k, label, title]) => {
    const b = btn(label, title, false);
    b.addEventListener('click', () => {
      // a chip is the reader's: it takes back from the tour what it shows
      for (const l of shown) if (shown !== mine) mine.add(l);
      if (mine.has(k)) mine.delete(k); else mine.add(k);
      shown = mine;
      syncChips(); kick();
      if (k === 'hi') goView(mine.has('hi') ? HI_VIEW : null);
    });
    return b;
  });
  function syncChips(): void { chipBtns.forEach((b, i) => toggle(b, shown.has(CHIPS[i][0]))); }
  const lenIn = h('input', { type: 'range', min: Math.round(L_MIN * 100), max: Math.round(L_MAX * 100), step: 5, value: Math.round(L_HALF * 100), 'aria-label': 'Electrical length of the dipole in wavelengths' }) as HTMLInputElement;
  const lenOut = h('output', null, '');
  lenIn.addEventListener('input', () => { run.lwl = Number(lenIn.value) / 100; kick(); });
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)'), onMq = () => { syncMotion(); kick(); };
  mq?.addEventListener?.('change', onMq);
  syncMotion();

  stage.slot.append(
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns dp-btns' }, runBtn, stepBtn, modeBtn, feedBtn)),
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns dp-btns dp-layers', role: 'group', 'aria-label': 'Layers over the antenna' }, ...chipBtns)),
    h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl' }, h('span', null, 'Length'), lenIn, lenOut)),
    strip, live);
  const el = h('div', { class: 'r3 dipole3d' },
    h('div', { class: 'r3-main' }, stage.el),
    h('div', { class: 'r3-side' }, h('h4', null, 'This dipole ', h('span', { class: 'r3-badge' }, 'the chapter’s numbers')), kv));
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  draw();
  // the loops are instances, and the arms' colours come from the theme: both again once the renderer is up
  const ready = setInterval(() => { if (stage.studio() || stage.isFlat()) { clearInterval(ready); draw(); } }, 100);
  return { el, destroy() { clearInterval(ready); mq?.removeEventListener?.('change', onMq); loop.stop(); stage.destroy(); } };
}
