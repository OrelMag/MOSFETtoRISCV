// A telegraph key, circuit closer and main-line sounder in 3D (loaded on demand, modelhost.ts). American landlines worked closed
// circuit: current flows at idle, the circuit closer shorts the key and holds the sounder's armature down, and sending
// means opening the closer and then working the key. With the closer open the loop is the open-circuit one (current only
// while the key is down). The armature moves as phys/relay.ts moves it (SOUNDER: a 120 Ω main-line coil) at the voltage
// the line leaves across the coil, or not at all below the pull-in current. The click is heard when the armature strikes
// the anvil, and the softer one when it falls back on its stop.

import '../styles/telegraph3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { morseUnitSeconds } from '../comm/codes';
import type { Widget } from '../view/stage';
import { RELAY, relaySummary } from '../phys/relay';
import { CELL_V, margin, ohmsPerKm, PULL_I, reachKm, SOUNDER, SOUNDER_R, SOUNDER_RELEASE, type Metal } from '../phys/telegraph';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { coilVolts, lineCurrent, pressX, pulls, releaseX, runFor, SLOW, type Line, type TgPose } from './telegraph3dparts';
import { drawnRetractor, retractorGeo, retractorLen, tgModel, tgPose, TG_HOME } from './telegraph3dkit';
import { refresh } from '../gl/kit/geo';

/** Two short noise bursts through a high-pass: made on the first key press (a user gesture), nothing without Web Audio. */
class Clicker {
  private ctx: AudioContext | null = null;
  private buf: AudioBuffer | null = null;
  prime(): void {
    if (this.ctx || typeof AudioContext !== 'function') return;
    try {
      const c = new AudioContext(), n = Math.round(c.sampleRate * 0.012), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6 * i) / n);
      this.ctx = c; this.buf = b;
      if (c.state === 'suspended') void c.resume().catch(() => {});
    } catch { this.ctx = null; }
  }
  play(kind: 'down' | 'up'): void {
    const c = this.ctx, b = this.buf;
    if (!c || !b) return;
    try {
      const src = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain();
      src.buffer = b; hp.type = 'highpass'; hp.frequency.value = kind === 'down' ? 1500 : 900;
      g.gain.value = kind === 'down' ? 0.5 : 0.22;
      src.connect(hp); hp.connect(g); g.connect(c.destination);
      src.start();
    } catch { /* a closed context: stay silent */ }
  }
  destroy(): void { void this.ctx?.close().catch(() => {}); this.ctx = null; }
}

const mA = (a: number) => `${(a * 1e3).toFixed(1)} mA`;

/** SOS as key-down intervals in dot units: ... --- ... (dot 1, dash 3, gaps 1 within a letter and 3 between letters). */
export const SOS_UNITS: [number, number][] = (() => {
  const out: [number, number][] = [];
  let t = 0;
  for (const [li, letter] of ['...', '---', '...'].entries()) {
    if (li) t += 3;
    for (const [si, sym] of [...letter].entries()) { if (si) t += 1; const d = sym === '.' ? 1 : 3; out.push([t, t + d]); t += d; }
  }
  return out;
})();

export function telegraphView(): Widget {
  const line: Line = { V: 24, km: 12, metal: 'iron' };
  // American landline practice: the circuit closer is shut at idle (closed circuit). Open it to send, or leave it open: open-circuit working.
  let closer = true, keyDown = false, sound = true, tReal = 1e6, x = RELAY.travel, x0 = 0, kd = 0, cd = 1;
  let seated = true, lifting = false, was = true, wpm = 20, sos: { t: number; closerWas: boolean } | null = null;
  const clicker = new Clicker();
  const panel = h('div', { class: 'panel tg3d' });
  // before the stage: it builds the model at once
  /** The loop is closed while the circuit closer is shut or the key is down. */
  const closed = () => closer || keyDown;
  const pose = (): TgPose => ({ kd, x, flowing: closed(), i: closed() ? lineCurrent(line) : 0, cd });
  const stage = studioStage({
    aria: 'A telegraph key with its circuit closer, a line on poles and a main-line sounder with two coils, a retractor spring, an armature and an anvil, in 3D',
    home: TG_HOME,
    // home: the key, the closer and the sounder; the line between them is drawn short
    homeFrame: ['key', 'keybase', 'closer', 'sounder', 'armature', 'battery', 'earth return'],
    scaleBar: (len) => `${len} mm`,
    limits: { minDist: 120, maxDist: 2000 },
    note: `Drawn after an American closed-circuit line: the loop carries current at idle, the circuit closer (the brass lever in front of the key) shorts the key and keeps the sounder's armature down, and to send you open the closer and work the key. With the closer open the loop is the open-circuit convention (current only while the key is down). The sounder is a ${SOUNDER_R} Ω main-line coil, the Western Union 15B's resistance: the model's relay rewound with the same turns, so the same ${mA(PULL_I)} pull-in current, which is the model's estimate and no datasheet value (long lines used a finer-wound relay and a 4 Ω local sounder: the next step). It has no telephone quench: release runs through a model discharge path of ${SOUNDER_RELEASE} Ω standing for the key's spark and condenser, an estimate. The line is drawn short and its length is not to scale; the armature gap is drawn five times its size; the key lever is 108 mm (Pope: about four to five inches) and the sounder's board 120 × 72 mm (a Western Electric 15B is 140 × 113 × 77 mm), but the coils, springs, screws and posts are drawn, not measured from an instrument, and the two gravity cells are drawn small (a cell was about 150 × 200 mm). Near pull-in the model has not seated the armature by the end of its run, so the last stretch onto the anvil is eased, not computed.`,
    build: (detail) => tgModel(pose(), detail),
  });
  /** The pose: levers and armature moved, the retractor stretched; then a rebuild (cheap: cached geometry, the lit materials by level). */
  const paint = () => {
    for (const det of ['full', 'flat'] as const) { const g = drawnRetractor(det); if (g) refresh(g, retractorGeo(retractorLen(x), det)); }
    stage.move(tgPose(pose())); stage.refresh();
  };

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip);
  const verdict = h('p', { class: 'r3-hint', 'aria-live': 'polite' });

  /** The armature's travel for the model's clock; the clicks come from it crossing the anvil and the stop. */
  function armature(): void {
    if (closed() !== was) { was = closed(); tReal = 0; if (was) { seated = false; lifting = false; } else x0 = x; }
    x = closed() ? pressX(line, tReal / 1000 / SLOW) : releaseX(line, x0, tReal / 1000 / SLOW);
    const t = RELAY.travel;
    if (!seated && x >= 0.99 * t) { seated = true; if (sound) clicker.play('down'); }
    else if (seated && x <= 0.5 * t) { seated = false; lifting = true; }
    if (lifting && x <= 1e-12) { lifting = false; if (sound) clicker.play('up'); }
  }
  const settling = () => (closed() ? tReal / 1000 / SLOW < 0.04 : x > 0 && tReal / 1000 / SLOW < 0.035);
  const loop = frameLoop((_n, dt) => {
    tReal += dt * 1000;
    if (sos) runSos(dt);
    armature();
    kd += ((keyDown ? 1 : 0) - kd) * (1 - Math.exp(-dt * 30));
    if (Math.abs(kd - (keyDown ? 1 : 0)) < 0.005) kd = keyDown ? 1 : 0;
    cd += ((closer ? 1 : 0) - cd) * (1 - Math.exp(-dt * 20));
    if (Math.abs(cd - (closer ? 1 : 0)) < 0.005) cd = closer ? 1 : 0;
    readout();
    paint();
  }, () => settling() || kd !== (keyDown ? 1 : 0) || cd !== (closer ? 1 : 0) || sos !== null);

  function readout(): void {
    const full = lineCurrent(line), ok = pulls(line), reach = reachKm(line.V, line.metal), mg = margin(line.V, line.km, line.metal);
    const i = closed() ? full : 0;
    chip.textContent = `${closed() ? 'Closed' : 'Open'}: ${(i * 1e3).toFixed(1)} / ${(PULL_I * 1e3).toFixed(1)} mA`;
    chip.className = `r3-chip ${closed() ? (ok ? 'good' : 'bad') : ''}`;
    const sum = ok ? relaySummary(runFor(line), SOUNDER) : null;
    const ms = (v: number | null | undefined) => (v == null ? 'eased in' : `${(v * 1e3).toFixed(1)} ms`);
    const rows: [string, string, string?][] = [
      ['Loop current, loop closed', mA(full), ok ? '' : 'bad'], ['Pull-in current', mA(PULL_I)],
      ['Margin', `${mg.toFixed(2)} ×`, ok ? 'good' : 'bad'], ['Reach, this battery and metal', `${reach.toFixed(1)} km`],
      ['Line resistance', `${(ohmsPerKm(line.metal) * line.km).toFixed(0)} Ω (${ohmsPerKm(line.metal).toFixed(2)} Ω/km)`],
      ['Sounder coil', `${SOUNDER_R} Ω`], ['Across the coil', `${coilVolts(line).toFixed(1)} V`],
      ['Battery', `${Math.round(line.V / CELL_V)} cells of ${CELL_V} V (two drawn)`], ['Armature gap', `${((RELAY.gOpen - x) * 1e3).toFixed(2)} mm`],
      ['Strikes the anvil after', sum ? ms(sum.firstTouch) : 'never', sum ? '' : 'bad'], ['Lets go after', sum ? ms(sum.release) : 'never'],
      ['Shown at', `1/${SLOW} speed`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, c]) => [h('span', null, k), h('span', { class: `v ${c ?? ''}` }, v)]));
    verdict.textContent = !ok ? `${(100 * mg).toFixed(0)} % of the pull-in current: the armature does not move, shut or open. Shorten the line, raise the battery or use copper.`
      : closer ? `Closed circuit: current flows at idle and the closer holds the armature down, ${((mg - 1) * 100).toFixed(0)} % above pull-in. The key is shorted: open the closer to send.`
      : `Closer open: current flows only while the key is down (${((mg - 1) * 100).toFixed(0)} % above pull-in). Shut the closer when you are done, or the line stays silent.`;
  }
  function repaint(): void {
    if (reducedMotion()) { tReal = 1e6; kd = keyDown ? 1 : 0; cd = closer ? 1 : 0; }
    armature(); readout();
    paint();
    loop.kick();
  }
  /** The line changed: a loop that now pulls in is struck down again, one that no longer does lets go at once. */
  function lineChanged(): void {
    if (closed()) {
      if (!pulls(line)) { x = 0; seated = false; }
      else if (x < 0.99 * RELAY.travel) { tReal = 0; seated = false; lifting = false; }
    }
    repaint();
  }

  function press(): void { if (keyDown) return; keyDown = true; if (sound) clicker.prime(); repaint(); }
  function release(): void { if (!keyDown) return; keyDown = false; repaint(); }
  const key = h('button', { type: 'button', class: 'btn tg-key', 'aria-label': 'Telegraph key: hold to work it (Space or Enter). With the circuit closer shut it changes nothing: open the closer first' }, 'Key: hold to send') as HTMLButtonElement;
  key.addEventListener('pointerdown', (e) => { e.preventDefault(); key.setPointerCapture?.(e.pointerId); key.focus(); press(); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) key.addEventListener(t, release);
  key.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) press(); } });
  key.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
  key.addEventListener('blur', release);
  key.addEventListener('click', (e) => e.preventDefault());

  const closerBtn = h('button', { type: 'button', class: 'btn sm tg-closer', 'aria-pressed': 'true' }) as HTMLButtonElement;
  const closerText = () => { closerBtn.textContent = closer ? 'Circuit closer: shut' : 'Circuit closer: open'; closerBtn.setAttribute('aria-pressed', String(closer)); };
  closerText();
  closerBtn.addEventListener('click', () => { if (sound) clicker.prime(); closer = !closer; closerText(); repaint(); });

  /** SOS through the key at the chosen speed, in the model's own time (the picture runs 1/SLOW of it): the closer is opened first and shut after. */
  function runSos(dt: number): void {
    if (!sos) return;
    sos.t += (dt * 1000) / SLOW;
    const unit = morseUnitSeconds(wpm) * 1000, end = SOS_UNITS[SOS_UNITS.length - 1][1] * unit + 2 * unit;
    keyDown = SOS_UNITS.some(([a, b]) => sos!.t >= a * unit && sos!.t < b * unit);
    if (sos.t >= end) { closer = sos.closerWas; closerText(); sos = null; keyDown = false; sosText(); }
  }
  const sosBtn = h('button', { type: 'button', class: 'btn sm' }, 'Send SOS') as HTMLButtonElement;
  const sosText = () => { sosBtn.textContent = sos ? 'Stop SOS' : 'Send SOS'; };
  sosBtn.addEventListener('click', () => {
    if (sos) { closer = sos.closerWas; closerText(); sos = null; keyDown = false; sosText(); repaint(); return; }
    if (sound) clicker.prime();
    sos = { t: 0, closerWas: closer }; closer = false; closerText(); sosText(); repaint();
  });

  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void, lineEdit = true) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); if (lineEdit) lineChanged(); else repaint(); });
    return { el: h('label', { class: 'r3-sl' }, h('span', null, label), input, out), set(v: number) { input.value = String(v); out.textContent = fmt(v); } };
  };
  const km = slider('Line', 0, 400, 1, line.km, (v) => `${v} km`, (v) => { line.km = v; });
  const volts = slider('Battery', 6, 120, 1, line.V, (v) => `${v} V`, (v) => { line.V = v; });
  const speed = slider('Speed', 5, 40, 1, wpm, (v) => `${v} wpm (dot ${Math.round(morseUnitSeconds(v) * 1000)} ms)`, (v) => { wpm = v; }, false);
  const metals = (['iron', 'copper'] as Metal[]).map((m) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(m === line.metal) }, m === 'iron' ? 'Iron wire' : 'Copper wire') as HTMLButtonElement;
    b.addEventListener('click', () => { line.metal = m; for (const o of metals) o.setAttribute('aria-pressed', String(o === b)); lineChanged(); });
    return b;
  });
  const snd = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'true' }, 'Sound on') as HTMLButtonElement;
  snd.addEventListener('click', () => { sound = !sound; snd.setAttribute('aria-pressed', String(sound)); snd.textContent = sound ? 'Sound on' : 'Sound off'; if (sound) clicker.prime(); });
  const jump = (extra: number) => () => { const k = Math.min(400, Math.floor(reachKm(line.V, line.metal)) + extra); line.km = k; km.set(k); lineChanged(); };
  const edge = h('button', { type: 'button', class: 'btn sm' }, 'Longest that works') as HTMLButtonElement;
  const over = h('button', { type: 'button', class: 'btn sm' }, 'One km further') as HTMLButtonElement;
  edge.addEventListener('click', jump(0)); over.addEventListener('click', jump(1));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The key, the closer and the sounder'),
    h('p', { class: 'm3-sub' }, `An American landline ran closed circuit: the loop (battery, key, line, sounder coil, earth) carries current at idle, and the circuit closer lever shorts the key to keep it so. The coil is ${SOUNDER_R} Ω and pulls in at ${mA(PULL_I)}, so the armature rests on the anvil while the line is quiet. To send, open the closer and work the key: each press closes the loop and the armature clicks down, each release lets it go with a second click. Open the closer and leave it, and you have the open-circuit convention. Below the pull-in current the armature does not move at all. Space or Enter works on the focused key.`),
    stage.el, verdict,
    h('div', { class: 'tg-below' }, h('h4', null, 'This loop ', h('span', { class: 'r3-badge' }, 'model')), kv));
  stage.slot.append(
    h('div', { class: 'r3-ctl' }, km.el, volts.el),
    h('div', { class: 'r3-btns tg-btns' }, closerBtn, key, sosBtn, ...metals, edge, over, snd),
    h('div', { class: 'r3-ctl' }, speed.el));
  repaint();
  return { el: panel, destroy() { loop.stop(); clicker.destroy(); stage.destroy(); } };
}
