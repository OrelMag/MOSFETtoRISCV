// A 3.5" 7200 rpm hard disk in 3D on the studio renderer, in true geometry (disk3dkit.ts; loaded on demand, modelhost.ts). The timing is disk3dparts.ts's model: the platter turns
// exactly once in 8.33 ms of drive time, the seek follows the fitted a + b·√d curve, and the wait for the sector is wherever
// the sector is when the arm arrives. The time is slowed by SLOW so the eye can follow; the rest is a drawing (see the note). The heads start parked on the ramp at the platters' edge.

import '../styles/disk3d.css';
import { FLASH_REAL_US } from '../flash/model';
import { groupNum } from '../sim/numfmt';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { DISK_HIDDEN, DISK_HOME, DISK_HOME_FRAME, diskModel, diskMoves } from './disk3dkit';
import {
  CYLINDERS, DATASHEET_MEDIA_MBIT, PITCH_EXAGGERATION, PITCH_NM, SECTORS, TRACKS, TURN_MS, trackBytes, driveRows, fmtMs, guessLine, phaseAt, planRead, queueLine, radiusAt, readoutRows, rewriteLine, trackRadius,
  type Kind, type Plan,
} from './disk3dparts';

/** Playback: one second of screen time is 1000 / SLOW ms of drive time, so a turn takes 8.33 ms × SLOW = 2.5 s. */
export const SLOW = 300;
const MS_PER_S = 1000 / SLOW;

/** What the drawing exaggerates, simplifies and leaves out (the stage adds the controls' help). */
const NOTE = `Drawn to scale in millimetres for a 3.5″ 7200 rpm drive of the Hitachi Deskstar 7K1000.B 500 GB class: its data sheet (HGST DSDS721008EN-01) gives the 101.6 × 147 × 26.1 mm case, 7200 rpm, ramp load / unload and a maximum media rate of ${DATASHEET_MEDIA_MBIT} Mbit/s but no seek table: the 8.5 ms average seek is its enterprise sibling’s (Deskstar E7K1000) and the 0.8 ms track-to-track a retro-hardware listing’s; the sectors per track and the ${PITCH_NM} nm track pitch are fitted so that the outer track passes that rate and the capacity is 500 GB (the data sheet gives no tracks per inch, nor the platter count: two is our assumption). 95 mm platters on a 25 mm hole, four heads, the recording band from r = 20 to 46 mm, the arm pivoting 56 mm from the spindle with the head 46 mm from the pivot. Where the clamp, spacer, E-block, suspensions, voice coil, magnets, yokes, flex cable and board sit follows a teardown’s labelled photos; their sizes are this model’s own, as are the platters’ 1.27 mm thickness and the 1 mm cover the case’s height allows for. Exaggerated: the 12 track rings stand for ${groupNum(Math.round(CYLINDERS / 100) * 100)} tracks ${PITCH_NM} nm apart (drawn about ${groupNum(Math.round(PITCH_EXAGGERATION / 100) * 100)} times too wide) and are drawn on the platter, where nothing is printed; the heads fly 0.25 mm up instead of a few nanometres; the slider is twice a pico slider’s 1.25 × 1.0 mm; the platters sit 5 mm apart (about 2 mm real) so the arms fit. Simplified: the 16 wedges are only places round the track (at r = 27 mm the arc of a wedge holds about ${Math.round(trackBytes(27) / SECTORS / 1024)} KiB of real 512-byte sectors), and a read transfers one 4 KiB block there, so the transfer is a few hundredths of a millisecond; no zones or servo wedges; the seek is the fitted curve eased out and in, not the actuator’s current profile; a load from the ramp is timed as a seek from the outer track. Left out: the cover, the spindle motor under the hub, the breather and recirculation filters, the actuator latch, the screws. Drive time is slowed 300× for the eye.`;

export function diskView(): Widget {
  // The drive's own clock (ms), the track the head is parked on, the request and its plan.
  let t = 1.7, parked: number | null = null, plan: Plan | null = null, anim: number | null = null, spinning = !reducedMotion();
  let sel = { track: 8, sector: 11 };
  // The learner's guess (ms) taken when the read starts, for the comparison afterwards.
  let guess: number | null = null;

  const panel = h('div', { class: 'panel dk3' });
  let shownKey = '', tracks = true;
  const look = () => ({ sel, phase: phaseAt(plan, t), r: radiusAt(plan, parked, t), tracks });
  const pose = () => ({ phi: t / TURN_MS, r: radiusAt(plan, parked, t) });
  const stage = studioStage({
    aria: 'A 3.5 inch hard disk in 3D: two mirror platters on a spindle, a stack of arms with four heads turning on a pivot, the voice coil between two magnets, the parking ramp and the flex cable; a board underneath',
    home: DISK_HOME, homeFrame: DISK_HOME_FRAME, hidden: DISK_HIDDEN,
    scaleBar: (len) => `${len} mm`,
    // a beat about the head stack looks where the arm is now: rebuild before it frames
    onBeat: () => { shownKey = ''; paint(); },
    limits: { minDist: 6, maxDist: 600 },
    note: NOTE,
    build: (detail) => diskModel(look(), detail),
  });
  /** Rebuild only when what the model shows changed (the wedge, the head lit); the platters and the arm move every frame. */
  function paint(): void {
    const l = look(), key = JSON.stringify([l.tracks, l.sel, l.phase === 'transfer', l.phase !== 'idle' && l.phase !== 'done']), p = pose();
    if (stage.isFlat()) diskMoves(p, 'flat');
    stage.move(diskMoves(p));
    if (key !== shownKey) { shownKey = key; stage.refresh(); }
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), drive = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  const line = h('div', { class: 'dk-line', role: 'img' }), cur = h('i', { class: 'cur' });
  const keyT = [h('span', null, 'seek'), h('span', null, 'rotational latency'), h('span', null, 'transfer')];
  const key = h('div', { class: 'dk-key' }, h('span', { class: 'seek' }, h('b'), keyT[0]), h('span', { class: 'wait' }, h('b'), keyT[1]), h('span', { class: 'xfer' }, h('b'), keyT[2]));
  const verdict = h('p', { class: 'dk-verdict', 'aria-live': 'polite' }), queue = h('p', { class: 'dk-verdict' });
  // the drawn tracks and wedges are an overlay on the mirror, not its material: the reader can take them off
  const tracksBtn = h('button', { type: 'button', class: 'r3-chip dk-tracks on', 'aria-pressed': 'true', title: 'The drawn tracks and wedges over the top platter (nothing is printed on a real one)' }, 'Tracks and sectors') as HTMLButtonElement;
  tracksBtn.addEventListener('click', () => { tracks = !tracks; tracksBtn.setAttribute('aria-pressed', String(tracks)); tracksBtn.classList.toggle('on', tracks); paint(); });
  stage.chips.append(chip, tracksBtn);

  const busy = () => anim !== null;
  const done = () => !plan || t >= plan.t3 - 1e-9;
  const settledTrack = (): number | null => (plan ? (t >= plan.t1 ? plan.to : plan.fromRamp ? null : plan.from) : parked);

  function status(): string {
    const ph = phaseAt(plan, t);
    if (!plan) return parked === null ? 'Idle: the heads are parked on the ramp at the platters’ edge. Guess the time, pick a track and a sector, then Read sector or Step.' : 'Idle: pick a track and a sector, then Read sector or Step.';
    const where = `track ${plan.to}, sector ${plan.sector}`;
    if (ph === 'seek') return `${plan.kind === 'write' ? 'Rewrite: seeking' : 'Seeking'} to ${where}: ${fmtMs(Math.max(0, plan.t1 - t))} of ${fmtMs(plan.seek)} left.`;
    if (ph === 'wait') return `Seek done in ${fmtMs(plan.seek)}. Waiting for sector ${plan.sector} to come round: ${fmtMs(Math.max(0, plan.t2 - t))} of ${fmtMs(plan.wait)} left.`;
    if (ph === 'transfer') return `Sector ${plan.sector} is under the head: transferring, ${fmtMs(Math.max(0, plan.t3 - t))} left.`;
    if (plan.kind === 'write') return rewriteLine(plan);
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
      keyT[0].textContent = `seek ${fmtMs(shown.seek)}`; keyT[1].textContent = `rotational latency ${fmtMs(shown.wait)}`; keyT[2].textContent = `transfer ${fmtMs(shown.transfer)}`;
      cur.style.left = `${Math.min(100, Math.max(0, ((t - shown.t0) / sum) * 100))}%`;
      line.setAttribute('aria-label', `Timeline of ${fmtMs(sum)}: seek ${fmtMs(shown.seek)}, latency ${fmtMs(shown.wait)}, transfer ${fmtMs(shown.transfer)}`);
    } else {
      line.replaceChildren(); line.hidden = true;
      keyT[0].textContent = 'seek'; keyT[1].textContent = 'rotational latency'; keyT[2].textContent = 'transfer';
      line.setAttribute('aria-label', 'No read yet');
    }
    readBtn.disabled = stepBtn.disabled = rewriteBtn.disabled = guessIn.disabled = busy();
    selects.forEach((s) => (s.disabled = busy()));
    const fin = shown && done() && !busy();
    verdict.textContent = fin && shown.kind === 'read' && guess !== null ? guessLine(guess, shown) : '';
    verdict.hidden = !verdict.textContent;
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
  function begin(kind: Kind = 'read'): Plan {
    if (plan) parked = plan.to;
    const g = Number(guessIn.value);
    guess = kind === 'read' && guessIn.value.trim() !== '' && g > 0 ? g : null;
    plan = planRead(t, parked ?? 0, sel.track, sel.sector, { kind, fromRamp: parked === null });
    return plan;
  }

  const readBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Read sector') as HTMLButtonElement;
  readBtn.addEventListener('click', () => { if (busy()) return; advance(begin().t3); });
  const rewriteBtn = h('button', { type: 'button', class: 'btn sm', title: 'Overwrite this sector where it is: no seek if the head is already on the track, then up to a turn for the sector to come round' }, 'Rewrite this sector') as HTMLButtonElement;
  rewriteBtn.addEventListener('click', () => { if (busy()) return; advance(begin('write').t3); });
  const guessIn = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: 'ms', 'aria-label': 'Your guess for the time of this read, in milliseconds' }) as HTMLInputElement;
  const queueBtn = h('button', { type: 'button', class: 'btn sm', title: '8 random reads, served in arrival order and sorted by track' }, '8 reads: in order vs sorted');
  queueBtn.addEventListener('click', () => { queue.textContent = queueLine(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => {
    if (busy()) return;
    if (!plan || done()) { advance(begin().t1); return; }
    advance(t < plan.t1 - 1e-9 ? plan.t1 : t < plan.t2 - 1e-9 ? plan.t2 : plan.t3);
  });
  const spinBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(spinning), title: 'The platters keep turning when idle' }, 'Spin') as HTMLButtonElement;
  spinBtn.addEventListener('click', () => { spinning = !spinning; kick(); });
  const restart = h('button', { type: 'button', class: 'btn sm' }, 'Reset');
  restart.addEventListener('click', () => { plan = null; anim = null; parked = null; guess = null; t = 1.7; kick(); });

  const trackSel = h('select', { 'aria-label': 'Track to read (0 is the outermost drawn track)' }, ...Array.from({ length: TRACKS }, (_, k) => h('option', { value: String(k) }, `${k}  (r ${trackRadius(k).toFixed(1)} mm)`))) as HTMLSelectElement;
  const sectorSel = h('select', { 'aria-label': 'Sector to read' }, ...Array.from({ length: SECTORS }, (_, k) => h('option', { value: String(k) }, String(k)))) as HTMLSelectElement;
  trackSel.value = String(sel.track); sectorSel.value = String(sel.sector);
  const selects = [trackSel, sectorSel];
  const picked = () => { if (plan) abandon(); sel = { track: Number(trackSel.value), sector: Number(sectorSel.value) }; kick(); };
  trackSel.addEventListener('change', picked); sectorSel.addEventListener('change', picked);

  drive.replaceChildren(...driveRows().flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The disk itself'),
    h('p', { class: 'm3-sub' }, `A 3.5″ 7200 rpm drive: two platters, four heads on one comb that swings on a pivot, driven by a coil between two magnets. Pick a track and a sector: the requested wedge is orange, and turns green while the head reads it. A read is three waits in a row. The arm seeks to the track, a time that grows with the square root of the distance. The platter keeps turning the whole while, so when the arm arrives the sector is wherever it happens to be, and the head waits for it to come round: rotational latency, 0 to 8.33 ms, 4.17 ms on average. Then the sector passes under the head and its bits are read. Drive time runs ${SLOW}× slower than real here, so a turn takes ${(TURN_MS * SLOW / 1000).toFixed(1)} s. Guess the time before you press Read sector, then see what it was made of. Rewrite this sector puts the data back where it was: no table, no fresh page, which flash cannot do. A flash page read, in the NOR and NAND steps earlier in this chapter, is ${FLASH_REAL_US.read} µs.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el, line, key, verdict, live, h('div', { class: 'r3-btns' }, queueBtn), queue),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'This read ', h('span', { class: 'r3-badge' }, 'model')), kv), h('div', null, h('h4', null, 'This drive'), drive))));
  stage.slot.append(h('div', { class: 'r3-ctl' },
    h('div', { class: 'dk-sel' }, h('label', null, 'Track', trackSel), h('label', null, 'Sector', sectorSel), h('label', null, 'Guess (ms)', guessIn)),
    h('div', { class: 'r3-btns' }, readBtn, rewriteBtn, stepBtn, spinBtn, restart)));
  readout(true);
  paint();
  loop.kick();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
