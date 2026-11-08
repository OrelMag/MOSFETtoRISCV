// A 3.5" 7200 rpm hard disk in 3D (loaded on demand, modelhost.ts). The timing is disk3dparts.ts's model: the platter turns
// exactly once in 8.33 ms of drive time, the seek follows the fitted a + b·√d curve, and the wait for the sector is wherever
// the sector is when the arm arrives. The time is slowed by SLOW so the eye can follow; the rest is a drawing (see the note).

import '../styles/disk3d.css';
import { FLASH_REAL_US } from '../flash/model';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  SECTORS, TRACKS, TURN_MS, diskAnchors, diskParts, driveRows, fmtMs, phaseAt, planRead, radiusAt, readoutRows, trackRadius,
  type DiskPalette, type Plan,
} from './disk3dparts';

/** Playback: one second of screen time is 1000 / SLOW ms of drive time, so a turn takes 8.33 ms × SLOW = 2.5 s. */
export const SLOW = 300;
const MS_PER_S = 1000 / SLOW;

export function diskView(): Widget {
  // The drive's own clock (ms), the track the head is parked on, the request and its plan.
  let t = 1.7, parked = 3, plan: Plan | null = null, anim: number | null = null, spinning = !reducedMotion();
  let sel = { track: 8, sector: 11 };

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A 3.5 inch hard disk in 3D: two spinning platters on a spindle, an actuator arm with heads on a pivot, and the voice-coil motor between two magnets',
    camera: { target: [24, 8, -4], yaw: 0.45, pitch: 1.0, dist: 190 },
    limits: { minDist: 70, maxDist: 520 },
    note: 'The platters, spindle, arm and magnet are to scale, from a typical 3.5″ drive; the 12 track rings stand for 260 000 tracks 100 nm apart, so they are drawn about 24 000 times too wide, and the heads fly 0.25 mm up instead of about 10 nm. The platters are further apart than real ones so the arms fit, the top magnet plate is see-through, and the cover is off. Zone bits, servo wedges and the sectors’ size are not drawn: 16 equal wedges, 1/16 of a turn each.',
    draw: () => paint(),
  });
  const palette = (): DiskPalette => ({
    base: stage.rgb('--dk-base'), platter: stage.rgb('--dk-platter'), ring: stage.rgb('--dk-ring'), mark: stage.rgb('--dk-mark'), hub: stage.rgb('--dk-hub'),
    steel: stage.rgb('--dk-steel'), slider: stage.rgb('--dk-slider'), copper: stage.rgb('--dk-copper'), magnet: stage.rgb('--dk-magnet'),
    yoke: stage.rgba('--dk-yoke', 0.35), magnetTop: stage.rgba('--dk-magnet', 0.4), target: stage.rgb('--dk-target'), live: stage.rgb('--m3-charge'),
  });
  const pose = () => ({ phi: t / TURN_MS, r: radiusAt(plan, parked, t), sel, phase: phaseAt(plan, t) });
  function paint(): void { const p = pose(); stage.paint(diskParts(p, palette()), diskAnchors(p)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), drive = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  const line = h('div', { class: 'dk-line', role: 'img' }), cur = h('i', { class: 'cur' });
  const key = h('div', { class: 'dk-key' }, h('span', { class: 'seek' }, h('b'), 'seek'), h('span', { class: 'wait' }, h('b'), 'rotational latency'), h('span', { class: 'xfer' }, h('b'), 'transfer'));
  stage.chips.append(chip);

  const busy = () => anim !== null;
  const done = () => !plan || t >= plan.t3 - 1e-9;
  const settledTrack = () => (plan ? (t >= plan.t1 ? plan.to : plan.from) : parked);

  function status(): string {
    const ph = phaseAt(plan, t);
    if (!plan) return 'Idle: pick a track and a sector, then Read sector or Step.';
    const where = `track ${plan.to}, sector ${plan.sector}`;
    if (ph === 'seek') return `Seeking to ${where}: ${fmtMs(Math.max(0, plan.t1 - t))} of ${fmtMs(plan.seek)} left.`;
    if (ph === 'wait') return `Seek done in ${fmtMs(plan.seek)}. Waiting for sector ${plan.sector} to come round: ${fmtMs(Math.max(0, plan.t2 - t))} of ${fmtMs(plan.wait)} left.`;
    if (ph === 'transfer') return `Sector ${plan.sector} is under the head: transferring, ${fmtMs(Math.max(0, plan.t3 - t))} left.`;
    return `Read of ${where} done: seek ${fmtMs(plan.seek)} + latency ${fmtMs(plan.wait)} + transfer ${fmtMs(plan.transfer)} = ${fmtMs(plan.total)}.`;
  }

  function readout(announce = false): void {
    const ph = phaseAt(plan, t);
    chip.textContent = { idle: 'Idle', seek: 'Seeking', wait: 'Waiting for the sector', transfer: 'Transferring', done: 'Done' }[ph];
    chip.className = `r3-chip ${ph === 'transfer' || ph === 'done' ? 'good' : ph === 'idle' ? '' : 'warn'}`;
    const shown = plan && !busy() && done() ? plan : plan && busy() ? plan : null;
    const rows = readoutRows(shown, plan ? settledTrack() : parked, sel);
    rows.push(['Drive time', `${t.toFixed(2)} ms · platter at ${((t / TURN_MS) % 1 * 360).toFixed(0)}°`]);
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    line.hidden = !shown;
    if (shown) {
      const sum = shown.total;
      line.replaceChildren(
        h('i', { class: 'seek', style: `width:${(shown.seek / sum) * 100}%` }), h('i', { class: 'wait', style: `width:${(shown.wait / sum) * 100}%` }),
        h('i', { class: 'xfer', style: `width:${(shown.transfer / sum) * 100}%` }), cur);
      cur.style.left = `${Math.min(100, Math.max(0, ((t - shown.t0) / sum) * 100))}%`;
      line.setAttribute('aria-label', `Timeline of ${fmtMs(sum)}: seek ${fmtMs(shown.seek)}, latency ${fmtMs(shown.wait)}, transfer ${fmtMs(shown.transfer)}`);
    } else {
      line.replaceChildren(); line.hidden = true;
      line.setAttribute('aria-label', 'No read yet');
    }
    readBtn.disabled = stepBtn.disabled = busy();
    selects.forEach((s) => (s.disabled = busy()));
    spinBtn.hidden = reducedMotion();
    spinBtn.setAttribute('aria-pressed', String(spinning));
    spinBtn.classList.toggle('on', spinning);
    stepBtn.textContent = !plan || done() ? 'Step: start (seek)' : t < plan.t1 ? 'Step: finish the seek' : t < plan.t2 ? 'Step: wait for the sector' : 'Step: transfer';
    live.setAttribute('aria-live', busy() && !announce ? 'off' : 'polite');
    const text = status();
    if (live.textContent !== text) live.textContent = text;
  }

  const loop = frameLoop((_now, dt) => {
    if (anim !== null) {
      t = Math.min(anim, t + dt * MS_PER_S);
      if (t >= anim) { anim = null; readout(true); paint(); return; }
    } else if (spinning && !reducedMotion()) t += dt * MS_PER_S;
    readout(); paint();
  }, () => anim !== null || (spinning && !reducedMotion()));
  const kick = () => { readout(); paint(); loop.kick(); };

  /** Run the drive clock to `to`: animated, or at once under reduced motion. */
  function advance(to: number): void {
    if (reducedMotion()) { t = to; anim = null; readout(true); paint(); return; }
    anim = to; kick();
  }
  function abandon(): void { parked = settledTrack(); plan = null; }
  function begin(): Plan {
    if (plan) parked = plan.to;
    plan = planRead(t, parked, sel.track, sel.sector);
    return plan;
  }

  const readBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Read sector') as HTMLButtonElement;
  readBtn.addEventListener('click', () => { if (busy()) return; advance(begin().t3); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => {
    if (busy()) return;
    if (!plan || done()) { advance(begin().t1); return; }
    advance(t < plan.t1 - 1e-9 ? plan.t1 : t < plan.t2 - 1e-9 ? plan.t2 : plan.t3);
  });
  const spinBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(spinning), title: 'The platters keep turning when idle' }, 'Spin') as HTMLButtonElement;
  spinBtn.addEventListener('click', () => { spinning = !spinning; kick(); });
  const restart = h('button', { type: 'button', class: 'btn sm' }, 'Reset');
  restart.addEventListener('click', () => { plan = null; anim = null; parked = 3; t = 1.7; kick(); });

  const trackSel = h('select', { 'aria-label': 'Track to read (0 is the outermost drawn track)' }, ...Array.from({ length: TRACKS }, (_, k) => h('option', { value: String(k) }, `${k}  (r ${trackRadius(k).toFixed(1)} mm)`))) as HTMLSelectElement;
  const sectorSel = h('select', { 'aria-label': 'Sector to read' }, ...Array.from({ length: SECTORS }, (_, k) => h('option', { value: String(k) }, String(k)))) as HTMLSelectElement;
  trackSel.value = String(sel.track); sectorSel.value = String(sel.sector);
  const selects = [trackSel, sectorSel];
  const picked = () => { if (plan) abandon(); sel = { track: Number(trackSel.value), sector: Number(sectorSel.value) }; kick(); };
  trackSel.addEventListener('change', picked); sectorSel.addEventListener('change', picked);

  drive.replaceChildren(...driveRows().flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The disk itself'),
    h('p', { class: 'm3-sub' }, `A 3.5″ 7200 rpm drive: two platters, four heads on one comb that swings on a pivot, driven by a coil between two magnets. Pick a track and a sector: the requested wedge is orange, and turns green while the head reads it. A read is three waits in a row. The arm seeks to the track, a time that grows with the square root of the distance. The platter keeps turning the whole while, so when the arm arrives the sector is wherever it happens to be, and the head waits for it to come round: rotational latency, 0 to 8.33 ms, 4.17 ms on average. Then the sector passes under the head and its bits are read. Drive time runs ${SLOW}× slower than real here, so a turn takes ${(TURN_MS * SLOW / 1000).toFixed(1)} s. A flash page read, step one in this chapter, is ${FLASH_REAL_US.read} µs.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' },
          h('div', { class: 'dk-sel' }, h('label', null, 'Track', trackSel), h('label', null, 'Sector', sectorSel)),
          h('div', { class: 'r3-btns' }, readBtn, stepBtn, spinBtn, restart, stage.resetBtn)),
        stage.el, stage.hint, line, key, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This read ', h('span', { class: 'r3-badge' }, 'model')), kv, h('h4', null, 'This drive'), drive)));
  readout(true);
  paint();
  loop.kick();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
