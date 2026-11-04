// A telegraph key and sounder in 3D (loaded on demand, modelhost.ts). The key closes a series loop (phys/telegraph.ts);
// the sounder's armature moves as phys/relay.ts moves it at the voltage the line leaves across the coil, or not at all
// below the pull-in current. Hold the key (pointer, Space or Enter) to send; the click is heard when the armature
// strikes the anvil, and the softer one when it falls back on its stop.

import '../styles/telegraph3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { RELAY, RELAY_STEP_MS } from '../phys/relay';
import { margin, ohmsPerKm, PULL_I, reachKm, type Metal } from '../phys/telegraph';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { coilVolts, lineCurrent, pressX, pulls, releaseX, SLOW, tgAnchors, tgParts, type Line, type TgPalette, type TgPose } from './telegraph3dparts';

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

export function telegraphView(): Widget {
  const line: Line = { V: 24, km: 12, metal: 'iron' };
  let down = false, sound = true, tReal = 0, x = 0, x0 = 0, kd = 0;
  let seated = false, lifting = false;
  const clicker = new Clicker();
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A telegraph key, a line on poles and a sounder with two coils, an armature and an anvil, in 3D',
    camera: { target: [2, 6, 2], yaw: 0.45, pitch: 0.7, dist: 215 },
    limits: { minDist: 90, maxDist: 440 },
    note: 'The line is drawn short and its length is not to scale; the armature gap is drawn five times its size and the coils are far larger than life. Near pull-in the model has not seated the armature by the end of its run, so the last stretch onto the anvil is eased, not computed.',
    draw: () => stage.paint(tgParts(pose(), palette()), tgAnchors(pose())),
  });
  const palette = (): TgPalette => ({
    board: stage.rgb('--tg-board'), metal: stage.rgb('--m3-metal'), brass: stage.rgb('--tg-brass'), wood: stage.rgb('--tg-wood'),
    live: stage.rgb('--m3-charge'), coil: stage.rgb('--tg-coil'), glow: stage.rgb('--tg-glow'), wire: stage.rgb('--tg-wire'),
  });
  const pose = (): TgPose => ({ kd, x, flowing: down, i: down ? lineCurrent(line) : 0 });

  const chip = h('span', { class: 'r3-chip' }), chip2 = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip, chip2);
  const verdict = h('p', { class: 'r3-hint', 'aria-live': 'polite' });

  /** The armature's travel for the model's clock; the clicks come from it crossing the anvil and the stop. */
  function armature(): void {
    x = down ? pressX(line, tReal / 1000 / SLOW) : releaseX(line, x0, tReal / 1000 / SLOW);
    const t = RELAY.travel;
    if (!seated && x >= 0.99 * t) { seated = true; if (sound) clicker.play('down'); }
    else if (seated && x <= 0.5 * t) { seated = false; lifting = true; }
    if (lifting && x <= 1e-12) { lifting = false; if (sound) clicker.play('up'); }
  }
  const settling = () => (down ? tReal / 1000 / SLOW < 0.04 : x > 0 && tReal / 1000 / SLOW < 0.012);
  const loop = frameLoop((_n, dt) => {
    tReal += dt * 1000;
    armature();
    kd += ((down ? 1 : 0) - kd) * (1 - Math.exp(-dt * 30));
    if (Math.abs(kd - (down ? 1 : 0)) < 0.005) kd = down ? 1 : 0;
    readout();
    stage.paint(tgParts(pose(), palette()), tgAnchors(pose()));
  }, () => settling() || kd !== (down ? 1 : 0));

  function readout(): void {
    const full = lineCurrent(line), ok = pulls(line), reach = reachKm(line.V, line.metal), mg = margin(line.V, line.km, line.metal);
    const i = down ? full : 0;
    chip.textContent = `${down ? 'Key closed' : 'Key open'}: ${mA(i)} · pull-in ${mA(PULL_I)}`;
    chip.className = `r3-chip ${down ? (ok ? 'good' : 'bad') : ''}`;
    chip2.textContent = `closed it would carry ${mA(full)}`;
    chip2.className = `r3-chip ${ok ? '' : 'warn'}`;
    const rows: [string, string, string?][] = [
      ['Loop current, key closed', mA(full), ok ? '' : 'bad'], ['Pull-in current', mA(PULL_I)],
      ['Margin', `${mg.toFixed(2)} ×`, ok ? 'good' : 'bad'], ['Reach, this battery and metal', `${reach.toFixed(1)} km`],
      ['Line resistance', `${(ohmsPerKm(line.metal) * line.km).toFixed(0)} Ω (${ohmsPerKm(line.metal).toFixed(2)} Ω/km)`],
      ['Across the coil', `${coilVolts(line).toFixed(1)} V`], ['Armature gap', `${((RELAY.gOpen - x) * 1e3).toFixed(2)} mm`],
      ['Shown at', `1/${SLOW} speed (pull-in ${RELAY_STEP_MS} ms at 24 V)`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, c]) => [h('span', null, k), h('span', { class: `v ${c ?? ''}` }, v)]));
    verdict.textContent = ok ? `The coil pulls in with ${((mg - 1) * 100).toFixed(0)} % to spare.` : `${(100 * mg).toFixed(0)} % of the pull-in current: the armature does not move. Shorten the line, raise the battery or use copper.`;
  }
  function repaint(): void {
    if (reducedMotion()) { tReal = 1e6; kd = down ? 1 : 0; }
    armature(); readout();
    stage.paint(tgParts(pose(), palette()), tgAnchors(pose()));
    loop.kick();
  }

  function press(): void {
    if (down) return;
    down = true; tReal = 0; seated = false; lifting = false;
    if (sound) clicker.prime();
    repaint();
  }
  function release(): void {
    if (!down) return;
    // The model's release starts from wherever the armature got to.
    x0 = x; down = false; tReal = 0;
    repaint();
  }
  const key = h('button', { type: 'button', class: 'btn tg-key', 'aria-label': 'Telegraph key: hold to close the circuit (Space or Enter)' }, 'Key: hold to send') as HTMLButtonElement;
  key.addEventListener('pointerdown', (e) => { e.preventDefault(); key.setPointerCapture?.(e.pointerId); key.focus(); press(); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) key.addEventListener(t, release);
  key.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) press(); } });
  key.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
  key.addEventListener('blur', release);
  key.addEventListener('click', (e) => e.preventDefault());

  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return { el: h('label', { class: 'r3-sl' }, h('span', null, label), input, out), set(v: number) { input.value = String(v); out.textContent = fmt(v); } };
  };
  const km = slider('Line', 0, 400, 1, line.km, (v) => `${v} km`, (v) => { line.km = v; });
  const volts = slider('Battery', 6, 120, 1, line.V, (v) => `${v} V`, (v) => { line.V = v; });
  const metals = (['iron', 'copper'] as Metal[]).map((m) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(m === line.metal) }, m === 'iron' ? 'Iron wire' : 'Copper wire') as HTMLButtonElement;
    b.addEventListener('click', () => { line.metal = m; for (const o of metals) o.setAttribute('aria-pressed', String(o === b)); repaint(); });
    return b;
  });
  const snd = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'true' }, 'Sound on') as HTMLButtonElement;
  snd.addEventListener('click', () => { sound = !sound; snd.setAttribute('aria-pressed', String(sound)); snd.textContent = sound ? 'Sound on' : 'Sound off'; if (sound) clicker.prime(); });
  const jump = (extra: number) => () => { const k = Math.min(400, Math.floor(reachKm(line.V, line.metal)) + extra); line.km = k; km.set(k); repaint(); };
  const edge = h('button', { type: 'button', class: 'btn sm' }, 'Longest that works') as HTMLButtonElement;
  const over = h('button', { type: 'button', class: 'btn sm' }, 'One km further') as HTMLButtonElement;
  edge.addEventListener('click', jump(0)); over.addEventListener('click', jump(1));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The key and the sounder'),
    h('p', { class: 'm3-sub' }, `Hold the key and the loop closes: battery, key, line, coil, earth. The coil sees I × ${RELAY.Rc} Ω, and the armature is the relay of the model run at exactly that voltage. At or above ${mA(PULL_I)} it pulls down onto the anvil with a click and lets go with a softer one; below it the armature does not move at all, however long you hold the key. Space or Enter works on the focused key.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, km.el, volts.el),
        stage.el, stage.hint, verdict,
        h('div', { class: 'r3-btns tg-btns' }, key, ...metals, edge, over, snd, stage.resetBtn)),
      h('div', { class: 'r3-side' }, h('h4', null, 'This loop ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  repaint();
  return { el: panel, destroy() { loop.stop(); clicker.destroy(); stage.destroy(); } };
}
