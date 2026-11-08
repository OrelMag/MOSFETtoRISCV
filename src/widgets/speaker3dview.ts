// The loudspeaker / microphone in 3D (loaded on demand, modelhost.ts). The samples are the chapter's voice (loadClip, the
// recording the Speech chapter plays at 8 kHz): a loud window of it is the DAC's codes, each held for one period. The pose
// comes from speaker3dparts.ts (poseAt); the motion between samples is slowed down, and the mechanics are drawn, not simulated.

import '../styles/speaker3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage, type ModelStage } from './modelstage';
import { loadClip } from './dspaudio';
import type { OrbitView } from '../gl/camera';
import {
  BL, CMS_MM_N, DRAW_K, I_FULL, SPL_DB, TAU, VOICE_RATE, WINDOW, XMAX_MM, coneMm, currentA, drawnRatio, emfVolts, loudestWindow, makeDrive, pitchHz, poseAt, realPeakUm, realUm, velocityMmS,
  speakerAnchors, speakerParts, type Drive, type Mode, type SpeakerPalette,
} from './speaker3dparts';

/** Sample periods a second on Run (the voice runs at 8 000 a second, so it is slowed 500 times), and a step's motion. */
const RATE = 16, STEP_MS = 420;
const VIEW: OrbitView = { target: [10, 74, -20], yaw: 0.3, pitch: 0.16, dist: 340 };
const CLOSE: OrbitView = { target: [-19, 28, 0], yaw: 0.12, pitch: 0.08, dist: 95 };
// Never "−0.0": a value that rounds to zero at `d` places is zero.
const fmt = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d).replace('-', '−');

export function speakerView(): Widget {
  const panel = h('div', { class: 'panel' }, h('h3', { class: 'm3-title' }, 'The loudspeaker and the microphone'), h('p', { class: 'm3-sub' }, 'Loading the recording…'));
  let alive = true, stage: ModelStage | null = null, loop: ReturnType<typeof frameLoop> | null = null;
  loadClip('voice').then((v) => { if (alive) build(v.x, v.rate); }).catch((e: Error) => { panel.lastElementChild!.textContent = `The recording would not load: ${e.message}`; });

  function build(x: readonly number[], rate: number): void {
    const start = loudestWindow(x), codes = x.slice(start, start + WINDOW), f0 = pitchHz(x, start, rate);
    let mode: Mode = 'speaker', smooth = false, running = false, t = 0, stepFrom = -1, stepT0 = 0, close = false;
    let d: Drive = makeDrive(codes, mode, smooth, rate, f0);
    const ratio = Math.round(drawnRatio(d));
    const draw = () => paint();
    const probeHost = h('span', { class: 'sp-host', 'aria-hidden': 'true' }); // the colour probe lives here: it must outlast replaceChildren below
    const st = modelStage(probeHost, {
      aria: 'A cut-away moving-coil loudspeaker in 3D with a plot of the held samples behind it: cone, surround, spider, voice coil in the magnet gap, pole piece, ferrite ring, top plate and frame',
      camera: { ...VIEW },
      limits: { minDist: 120, maxDist: 1200 },
      note: `Drawn to a Dayton RS180-8: the cone, coil diameter, Xmax and force factor are the datasheet's; the winding and gap heights, the magnet's size and the spider are proportions chosen to fit Xmax. Speaker: the window's peak sample is scaled to Xmax (${XMAX_MM} mm) and the stroke is drawn ${DRAW_K} times larger. Microphone: the sound is ${SPL_DB} dB SPL (1 Pa rms, 1.41 Pa peak) at the cone, whose real stroke is about ${realPeakUm(d).toFixed(1)} µm at the voice's ${Math.round(f0)} Hz; it is drawn at Xmax × ${DRAW_K}, ${ratio.toLocaleString('en')} times larger than real. Time is slowed 500 times. The mechanics are drawn, not simulated: the smoothing is a one-pole lag, not the cone's resonance.`,
      draw,
    });
    stage = st;
    const palette = (): SpeakerPalette => ({
      steel: st.rgb('--sp-steel'), magnet: st.rgb('--sp-magnet'), basket: st.rgb('--sp-frame'), cone: st.rgba('--sp-cone', 0.85), dust: st.rgb('--sp-dust'),
      former: st.rgb('--sp-former'), wire: st.rgb('--sp-wire'), rubber: st.rgb('--sp-rubber'), spider: st.rgb('--sp-spider'),
      stair: st.rgb('--sp-stair'), stairDim: st.rgba('--sp-stair', 0.3), trace: st.rgb('--sp-trace'), cursor: st.rgb('--sp-cursor'),
      live: st.rgb('--m3-charge'), zero: st.rgb('--sp-cursor'),
    });
    function paint(): void { st.paint(speakerParts(d, t, palette()), speakerAnchors(d, t, close)); }

    const kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
    const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
    function readout(announce = false): void {
      const p = poseAt(d, t);
      const rows: [string, string][] = [['Sample', `${p.k + 1} of ${d.n}, held 125 µs`]];
      if (mode === 'speaker') {
        rows.push(['DAC code', fmt(p.code, 0)], ['Coil current (held)', `${fmt(currentA(p.drive))} A`], ['Cone position', `${fmt(coneMm(p.cone), 1)} mm`]);
      } else {
        rows.push(['Cone (real stroke)', `${fmt(realUm(d, p.cone), 2)} µm`], ['Cone velocity', `${fmt(velocityMmS(d, p.k), 2)} mm/s`], ['EMF (real stroke)', `${fmt(emfVolts(d, p.k) * 1000, 2)} mV · drawn ×${ratio.toLocaleString('en')}`], ['ADC code (held)', fmt(p.code, 0)]);
      }
      rows.push(mode === 'speaker' ? ['Xmax', `±${XMAX_MM} mm`] : ['Sound at the cone', `${SPL_DB} dB SPL, ${Math.round(f0)} Hz`]);
      kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
      runBtn.textContent = running ? 'Pause' : 'Run';
      runBtn.setAttribute('aria-pressed', String(running));
      live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
      const text = mode === 'speaker'
        ? `Sample ${p.k + 1}: code ${p.code} held, cone at ${fmt(coneMm(p.cone), 1)} millimetres of ±${XMAX_MM}.`
        : `Sample ${p.k + 1}: the cone moves ${fmt(realUm(d, p.cone), 2)} micrometres at ${fmt(velocityMmS(d, p.k), 2)} millimetres a second, the coil makes ${fmt(emfVolts(d, p.k) * 1000, 2)} millivolts, the ADC holds code ${p.code}.`;
      if (live.textContent !== text) live.textContent = text;
    }

    const lp = frameLoop((now, dt) => {
      if (running) {
        // Reduced motion: whole sample periods, a couple a second, no tween.
        t += dt * (reducedMotion() ? 2 : RATE);
        if (reducedMotion()) t = Math.floor(t);
      } else if (stepFrom >= 0) {
        const u = Math.min(1, (now - stepT0) / STEP_MS);
        t = stepFrom + u;
        if (u >= 1) stepFrom = -1;
      }
      if (t >= d.n) t -= d.n;
      readout(); paint();
    }, () => running || stepFrom >= 0);
    loop = lp;
    const kick = () => { readout(); paint(); lp.kick(); };
    const rebuild = () => { d = makeDrive(codes, mode, smooth, rate, f0); };

    runBtn.addEventListener('click', () => { running = !running; stepFrom = -1; t = Math.floor(t); if (!running) readout(true); kick(); });
    const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step one sample') as HTMLButtonElement;
    stepBtn.addEventListener('click', () => {
      running = false;
      const n0 = Math.floor(t);
      if (reducedMotion()) { stepFrom = -1; t = n0 + 1; } else { stepFrom = n0; stepT0 = performance.now(); t = n0; }
      if (t >= d.n) t -= d.n;
      readout(true); kick();
    });
    const EXPLAIN: Record<Mode, string> = {
      speaker: `The DAC holds each sample for one period, the coil current follows it, and the suspension turns that current into a position: full scale is ${fmt(I_FULL)} A for Xmax (x = Bl · i · Cms, with Cms = ${CMS_MM_N} mm/N). With Smoothing off the cone position is exactly the staircase, the zero-order hold. Smoothing lags the cone by about ${TAU} periods, a stand-in for the reconstruction filter and the cone's mass.`,
      mic: `The same machine run backwards: sound moves the cone, the coil moving in the gap makes e = Bl · v with Bl = ${BL} T·m, and the ADC takes one sample of that voltage a period, held for the next. The sound is ${SPL_DB} dB SPL (1 Pa rms, 1.41 Pa peak) at the cone: F = p · Sd, and above Fs (35.7 Hz) the cone is mass-controlled, v = F / (ω · Mms), so the voice's peak moves it only ${realPeakUm(d).toFixed(1)} µm at ${Math.round(f0)} Hz. The picture draws that stroke at Xmax × ${DRAW_K}, ${ratio.toLocaleString('en')} times larger; the volts shown are for the real stroke.`,
    };
    const explain = h('p', { class: 'm3-sub' }, EXPLAIN.speaker);
    const modes = ['speaker', 'mic'] as const;
    const modeBtns = modes.map((m) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(m === mode) }, m === 'speaker' ? 'Speaker' : 'Microphone') as HTMLButtonElement;
      if (m === mode) b.classList.add('on');
      b.addEventListener('click', () => {
        if (mode === m) return;
        mode = m; rebuild();
        modeBtns.forEach((x, i) => { const on = modes[i] === m; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        smoothBtn.disabled = m === 'mic';
        explain.textContent = EXPLAIN[m];
        readout(true); kick();
      });
      return b;
    });
    const smoothBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: 'Show what the reconstruction filter and the cone’s mass do: the cone chases each held step' }, 'Smoothing') as HTMLButtonElement;
    smoothBtn.addEventListener('click', () => {
      smooth = !smooth; rebuild();
      smoothBtn.classList.toggle('on', smooth); smoothBtn.setAttribute('aria-pressed', String(smooth));
      readout(true); kick();
    });
    const mats = h('ul', { class: 'sp-mat' },
      h('li', null, 'Cone: black anodised aluminium; surround: rubber; spider: treated fabric'),
      h('li', null, 'Voice coil: copper wire on an aluminium former, 38 mm'),
      h('li', null, 'Ferrite ring magnet; steel back plate, top plate and pole piece'),
      h('li', null, 'Frame: cast aluminium, six spokes'));
    const closeBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Close-up of the gap') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => {
      close = !close; closeBtn.setAttribute('aria-pressed', String(close)); closeBtn.classList.toggle('on', close);
      closeBtn.textContent = close ? 'Whole driver' : 'Close-up of the gap';
      st.setView({ ...(close ? CLOSE : VIEW) });
      kick();
    });
    const restartBtn = h('button', { type: 'button', class: 'btn sm' }, 'Back to sample 1');
    restartBtn.addEventListener('click', () => { running = false; t = 0; stepFrom = -1; readout(true); kick(); });
    panel.replaceChildren(
      probeHost,
      h('h3', { class: 'm3-title' }, 'The loudspeaker and the microphone'),
      h('p', { class: 'm3-sub' }, `A Dayton RS180-8 woofer cut open, driven by this chapter's voice: ${WINDOW} samples of the recording above at ${VOICE_RATE} a second, one period (125 µs) each. Time is slowed so each hold can be seen.`),
      h('div', { class: 'r3' },
        h('div', { class: 'r3-main' },
          h('div', { class: 'r3-ctl' },
            h('div', { class: 'seg sp-seg', role: 'group', 'aria-label': 'Speaker or microphone' }, ...modeBtns),
            h('div', { class: 'r3-btns' }, runBtn, stepBtn, smoothBtn, restartBtn, closeBtn, st.resetBtn)),
          st.el, st.hint, live),
        h('div', { class: 'r3-side' }, h('h4', null, 'This driver ', h('span', { class: 'r3-badge' }, 'RS180-8')), kv, explain, mats)));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
    readout(true); paint();
  }

  return { el: panel, destroy() { alive = false; loop?.stop(); stage?.destroy(); } };
}
