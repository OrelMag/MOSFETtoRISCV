// The loudspeaker / microphone in 3D (loaded on demand, modelhost.ts). The samples are the chapter's voice (loadClip, the
// recording the Speech chapter plays at 8 kHz): a loud window of it is the DAC's codes, each held for one period. The pose
// comes from speaker3dparts.ts (poseAt: the cone's second-order response to the held current) and speaker3dkit.ts draws it on
// the studio renderer; the plot of the held codes and the cone's trace is SVG under the canvas. The motion is slowed down.

import '../styles/speaker3d.css';
import { numOf } from '../chapters/order';
import { h } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { refresh } from '../gl/kit/geo';
import { studioStage } from './studiostage';
import { loadClip } from './dspaudio';
import { bentAt, bentOf, dyOf, speakerModel, speakerPose, SPEAKER_HOME, type SpeakerState } from './speaker3dkit';
import {
  BL, CMS_MM_N, DRAW_K, I_FULL, I_RATED, P_RMS_W, RE_OHM, peakStrokeMm, QMS, SPL_DB, FS_HZ, VOICE_RATE, WINDOW, XMAX_MM, coneMm, currentA, currentForStroke, strokeForAmp, drawnRatio, emfVolts, loudestWindow, makeDrive, pitchHz, poseAt, realPeakUm, realUm, velocityMmS,
  coneEdges, staircase, type Drive, type Mode,
} from './speaker3dparts';

/** Sample periods a second on Run (the voice runs at 8 000 a second, so it is slowed 500 times), and a step's motion. */
const RATE = 16, STEP_MS = 420;
// Never "−0.0": a value that rounds to zero at `d` places is zero.
const fmt = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d).replace('-', '−');
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(k: K, a: Record<string, string> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, k);
  for (const [n, v] of Object.entries(a)) e.setAttribute(n, v);
  return e;
};

export function speakerView(): Widget {
  const panel = h('div', { class: 'panel m3d' }, h('h3', { class: 'm3-title' }, 'The loudspeaker and the microphone'), h('p', { class: 'm3-sub' }, 'Loading the recording…'));
  let alive = true, stage: ReturnType<typeof studioStage> | null = null, loop: ReturnType<typeof frameLoop> | null = null;
  loadClip('voice').then((v) => { if (alive) build(v.x, v.rate); }).catch((e: Error) => { panel.lastElementChild!.textContent = `The recording would not load: ${e.message}`; });

  function build(x: readonly number[], rate: number): void {
    const start = loudestWindow(x), codes = x.slice(start, start + WINDOW), f0 = pitchHz(x, start, rate);
    let tone = 'f0';
    let mode: Mode = 'speaker', massless = false, running = false, t = 0, stepFrom = -1, stepT0 = 0;
    let d: Drive = makeDrive(codes, mode, massless, rate, f0);
    const ratio = Math.round(drawnRatio(d));
    const state = (): SpeakerState => ({ d, t });
    const st = studioStage({
      aria: 'A moving-coil loudspeaker in 3D, cut in half: cone, rubber surround, spider, voice coil in the magnet gap, pole piece with its phase plug, ferrite ring, top plate and the cast six-spoke frame',
      home: SPEAKER_HOME,
      // a round driver fitted as a sphere, close: the cut driver fills the width, the frame's far rim may touch the edge
      homeRadius: 64,
      knobs: { cut: 1 },
      scaleBar: (len) => `${len} mm`,
      limits: { minDist: 60, maxDist: 1600 },
      note: `Drawn to a Dayton RS180-8’s datasheet, with the coil, magnet and spider proportions chosen to fit it. As a speaker the cone moves ${fmt(peakStrokeMm(d), 2)} mm at most, drawn ×${d.mag}. As a microphone its real stroke is about ${realPeakUm(d).toFixed(1)} µm, drawn ${groupNum(ratio)} times larger, and it is the woofer run backwards, a simplification. 16 of about 64 coil turns are drawn; time is slowed 500 times.`,
      noteMore: `Drawn to a Dayton RS180-8: the cone, coil diameter, Xmax, force factor, the phase plug (no dust cap), the rubber surround and the cast six-hole frame are the datasheet's; the winding and gap heights, the magnet's size, the phase plug's and the spider are proportions chosen to fit Xmax, and the six holes sit on a 168 mm bolt circle from a seller's listing. Speaker: the loudest sample is the rated power's peak current, √(2 · ${P_RMS_W} W / ${RE_OHM} Ω) = ${fmt(I_RATED, 1)} A (Dayton: 60 W RMS, Re ${RE_OHM} Ω, Qms ${QMS}); the cone follows the held current through Mms · x'' + Rms · x' + x / Cms = Bl · i and moves ${fmt(peakStrokeMm(d), 2)} mm at most, so its motion is drawn ×${d.mag} (the numbers shown are real). Microphone: the sound is ${SPL_DB} dB SPL (1 Pa rms, 1.41 Pa peak) at the cone, whose real stroke is about ${realPeakUm(d).toFixed(1)} µm at the voice's ${Math.round(f0)} Hz; it is drawn at Xmax × ${DRAW_K}, ${groupNum(ratio)} times larger than real. This is the woofer run backwards in a sealed box with the baffle ignored, a simplification: a real dynamic microphone has a light diaphragm and a small coil and is flat to several kHz, where this one falls 6 dB per octave. The coil is drawn with 16 of its roughly 64 turns (an estimate from Bl), glowing with the current; the blue arrows are the field across the gap and the amber one the force on the coil. Dayton names two short-circuit paths in the motor; their shape is not given, so they are not drawn. Time is slowed 500 times.`,
      build: (detail) => speakerModel(state(), detail),
    });
    stage = st;

    // The plot: the held codes (speaker: the DAC's; mic: the ADC's) as a staircase, the part already played solid, the cone's
    // own position over it, and a cursor at now.
    const PW = 360, PH = 110, PY = PH / 2, PA = 44;
    const done = svgEl('path', { class: 'sp-st' }), todo = svgEl('path', { class: 'sp-st dim' }), coneP = svgEl('polyline', { class: 'sp-tr' });
    const cur = svgEl('line', { class: 'sp-cur', y1: '4', y2: String(PH - 4) });
    const plot = svgEl('svg', { class: 'sp-plot', viewBox: `0 0 ${PW} ${PH}`, role: 'img', 'aria-label': 'The held samples as a staircase and the cone position over them' });
    plot.append(svgEl('line', { class: 'sp-zero', x1: '0', x2: String(PW), y1: String(PY), y2: String(PY) }), todo, done, coneP, cur);
    const plotTitle = h('h4', null, '');
    function drawPlot(): void {
      const n = d.n, w = PW / n, s0 = staircase(d), k = poseAt(d, t).k, Y = (v: number) => (PY - v * PA).toFixed(1);
      const stair = (a: number, b: number) => { let p = ''; for (let i = a; i < b; i++) p += `${i === a ? 'M' : 'L'}${(i * w).toFixed(1)},${Y(s0[i])}H${((i + 1) * w).toFixed(1)}`; return p; };
      done.setAttribute('d', stair(0, k + 1));
      todo.setAttribute('d', k + 1 < n ? stair(k + 1, n) : '');
      const e = coneEdges(d), pts: string[] = [];
      for (let i = 0; i <= k; i++) pts.push(`${(i * w).toFixed(1)},${Y(e[i])}`);
      const x = (((t % n) + n) % n) * w;
      pts.push(`${x.toFixed(1)},${Y(poseAt(d, t).cone)}`);
      coneP.setAttribute('points', pts.join(' '));
      cur.setAttribute('x1', x.toFixed(1)); cur.setAttribute('x2', x.toFixed(1));
      plotTitle.textContent = mode === 'speaker' ? 'Held DAC codes (blue), the cone (orange)' : 'The cone (orange), the ADC’s held samples (blue)';
    }
    /** The pose: the cone and coil moved, the spider, surround and lead bent in place, the plot redrawn; then a rebuild (cheap). */
    function paint(): void {
      const s = state(), dy = dyOf(s);
      for (const det of ['full', 'flat'] as const) {
        const g = bentOf(det);
        if (g) { const nb = bentAt(dy, det); refresh(g.spider, nb.spider); refresh(g.surround, nb.surround); refresh(g.lead, nb.lead); }
      }
      st.move(speakerPose(s));
      st.refresh();
      drawPlot();
    }

    const kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
    const chip = h('span', { class: 'r3-chip good' });
    st.chips.append(chip);
    const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
    function readout(announce = false): void {
      const p = poseAt(d, t);
      const rows: [string, string][] = [['Sample', `${p.k + 1} of ${d.n}, held 125 µs`]];
      if (mode === 'speaker') {
        rows.push(['DAC code', fmt(p.code, 0)], ['Coil current (held, rated power)', `${fmt(currentA(d, p.drive))} A`], ['Cone position (real)', `${fmt(coneMm(p.cone), 2)} mm · drawn ×${d.mag}`]);
      } else {
        rows.push(['Cone (real stroke)', `${fmt(realUm(d, p.cone), 2)} µm`], ['Cone velocity', `${fmt(velocityMmS(d, p.k), 2)} mm/s`], ['EMF (real stroke)', `${fmt(emfVolts(d, p.k) * 1000, 2)} mV · drawn ×${groupNum(ratio)}`], ['ADC code (held)', fmt(p.code, 0)]);
      }
      if (mode === 'speaker') {
        const f = tone === 'f0' ? f0 : Number(tone);
        rows.push(['Xmax', `±${XMAX_MM} mm`], [`Current for Xmax at ${fmt(f, f < 100 ? 1 : 0)} Hz`, `${fmt(currentForStroke(f), 2)} A`], [`Stroke from 1 A at ${fmt(f, f < 100 ? 1 : 0)} Hz`, `${fmt(strokeForAmp(f), 2)} mm`]);
      } else rows.push(['Sound at the cone', `${SPL_DB} dB SPL, ${Math.round(f0)} Hz`]);
      kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
      chip.textContent = mode === 'speaker' ? `sample ${p.k + 1} · ${fmt(currentA(d, p.drive), 1)} A · cone ${fmt(coneMm(p.cone), 2)} mm` : `sample ${p.k + 1} · ${fmt(emfVolts(d, p.k) * 1000, 2)} mV`;
      runBtn.textContent = running ? 'Pause' : 'Run';
      runBtn.setAttribute('aria-pressed', String(running));
      live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
      const text = mode === 'speaker'
        ? `Sample ${p.k + 1}: code ${p.code} held, cone at ${fmt(coneMm(p.cone), 2)} millimetres of ±${XMAX_MM}.`
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
    const rebuild = () => { d = makeDrive(codes, mode, massless, rate, f0); };

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
      speaker: `The DAC holds each sample for one period (the zero-order hold of chapter ${numOf('converters')}) and the coil current follows it. The cone is a mass on a spring: above its resonance (Fs = ${FS_HZ} Hz) it is mass-controlled, a second-order low-pass, so it answers the average of the staircase and the steps' edges (8 kHz) are lost to it (about −94 dB). The loudest sample is the rated power's peak, ${fmt(I_RATED, 1)} A (60 W RMS into 6.4 Ω), and it moves the cone only ${fmt(peakStrokeMm(d), 2)} mm at the voice's ${Math.round(f0)} Hz, drawn ×${d.mag}; a pure tone at ${Math.round(f0)} Hz would need ${fmt(currentForStroke(f0), 1)} A for Xmax. The stiffness law x = Bl · i · Cms (Cms = ${CMS_MM_N} mm/N) would give Xmax for ${fmt(I_FULL)} A but holds only below Fs: Massless cone shows it. Choose a tone to see the current for Xmax: it grows as f².`,
      mic: `The same machine run backwards: sound moves the cone, the coil moving in the gap makes e = Bl · v with Bl = ${BL} T·m, and the ADC takes one sample of that voltage a period, held for the next. The sound is ${SPL_DB} dB SPL (1 Pa rms, 1.41 Pa peak) at the cone: F = p · Sd, and above Fs (35.7 Hz) the cone is mass-controlled, v = F / (ω · Mms), so the voice's peak moves it only ${realPeakUm(d).toFixed(1)} µm at ${Math.round(f0)} Hz. The picture draws that stroke at Xmax × ${DRAW_K}, ${groupNum(ratio)} times larger; the volts shown are for the real stroke.`,
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
        smoothBtn.disabled = m === 'mic'; toneRow.hidden = m === 'mic';
        explain.textContent = EXPLAIN[m];
        readout(true); kick();
      });
      return b;
    });
    const smoothBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: 'The stiffness law x = Bl · i · Cms, true only below the 35.7 Hz resonance: the cone sits on the held step. For contrast; a real cone cannot do this at voice frequencies.' }, 'Massless cone') as HTMLButtonElement;
    smoothBtn.addEventListener('click', () => {
      massless = !massless; rebuild();
      smoothBtn.classList.toggle('on', massless); smoothBtn.setAttribute('aria-pressed', String(massless));
      readout(true); kick();
    });
    const toneSel = h('select', { class: 'sp-tone', 'aria-label': 'Frequency for the current readout' },
      ...([['f0', `the voice's pitch (${Math.round(f0)} Hz)`], [String(FS_HZ), `the resonance (${FS_HZ} Hz)`], ['500', '500 Hz'], ['4000', '4 kHz']] as const).map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    toneSel.addEventListener('change', () => { tone = toneSel.value; readout(true); });
    const toneRow = h('label', { class: 'sp-toner' }, 'Tone for the current readout ', toneSel);
    const mats = h('ul', { class: 'sp-mat' },
      h('li', null, 'Cone: black anodised aluminium; surround: rubber; spider: treated fabric'),
      h('li', null, 'Voice coil: copper wire on an aluminium former, 38 mm'),
      h('li', null, 'Ferrite ring magnet; steel back plate, top plate and pole piece'),
      h('li', null, 'Phase plug: solid aluminium, fixed on the pole piece (no dust cap)'),
      h('li', null, 'Frame: cast aluminium, six spokes'));
    const restartBtn = h('button', { type: 'button', class: 'btn sm' }, 'Back to sample 1');
    restartBtn.addEventListener('click', () => { running = false; t = 0; stepFrom = -1; readout(true); kick(); });
    st.slot.append(h('div', { class: 'r3-ctl' },
      h('div', { class: 'seg sp-seg', role: 'group', 'aria-label': 'Speaker or microphone' }, ...modeBtns),
      h('div', { class: 'r3-btns' }, runBtn, stepBtn, smoothBtn, restartBtn)));
    panel.replaceChildren(
      h('h3', { class: 'm3-title' }, 'The loudspeaker and the microphone'),
      h('p', { class: 'm3-sub' }, `A Dayton RS180-8 woofer cut open, driven by this chapter's voice: ${WINDOW} samples of the recording above at ${VOICE_RATE} a second, one period (125 µs) each. Time is slowed so each hold can be seen.`),
      st.el, live,
      h('div', { class: 'sp-below' },
        h('div', null, plotTitle, plot, h('h4', null, 'This driver ', h('span', { class: 'r3-badge' }, 'RS180-8')), kv, toneRow),
        h('div', null, explain, mats)));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
    readout(true); paint();
  }

  return { el: panel, destroy() { alive = false; loop?.stop(); stage?.destroy(); } };
}
