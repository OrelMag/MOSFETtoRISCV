// The Strowger selector in 3D on the studio renderer (loaded on demand, modelhost.ts): the machine behind the chapter's
// relay selector, in true geometry (strowger3dkit.ts). The state machine is phys/strowger.ts; this plays its frames
// slowed and draws the mechanism where phys/strowger.ts's motionAt puts it between them: each pulse the vertical armature
// lifts the shaft one tooth, each hunt step the rotary armature turns the wipers one contact, on hang-up the release
// magnet lifts the holding pawls and the shaft turns home, then drops. The learner dials a level, marks lines busy and
// hangs up. It opens part-way through a call, paused on a busy line.

import '../styles/strowger3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { BREAK_MS, call, HOME, LEVELS, LINES, motionAt, PULSE_MS, pulsesOf, release, stateAt, type Frame, type State } from '../phys/strowger';
import { frameLoop } from './mosfet';
import type { Item, Model3 } from '../gl/kit/scene';
import { studioStage } from './studiostage';
import { CONTACT_GEO, contactData, contactInstances, ENVELOPE, MATS, SW_HOME, swModel, type SwPalette } from './strowger3dkit';

/** The call plays this many times slower than real, so a pulse (100 ms) takes half a second; the tour's pulse beat
 *  slows it further, so a tooth lifting under the pawl can be watched. */
export const SLOW = 5;
const BEAT_SLOW = [SLOW, 24, 10, SLOW, 10];

export function strowgerView(): Widget {
  const busy: boolean[][] = Array.from({ length: LEVELS }, () => Array<boolean>(LINES).fill(false));
  for (const j of [1, 2, 3, 4]) busy[3][j - 1] = true; // level 4: the first four lines are taken
  for (const j of [2, 5, 6, 9]) busy[6][j - 1] = true;
  let digit: number | null = 4, frames: Frame[] = call(4, busy), slow = SLOW;
  // Open on the wiper passing the third line, which is busy: the hunt is under way.
  let tm = frames.find((f) => f.s.mode === 'hunt' && f.s.line === 3)!.t, playing = false;
  let target: State = stateAt(frames, tm), ready = false, shownKey = '';
  const end = () => frames[frames.length - 1].t;

  const panel = h('div', { class: 'panel sw3' });
  const stage = studioStage({
    aria: 'A Strowger selector in 3D: a vertical shaft with three wipers that climb to a level of a bank and turn along it, worked by a vertical, a rotary and a release magnet',
    home: SW_HOME,
    fit: false,
    // taller than wide, as the selector is (the model is empty until the page holds it, so its bounds cannot set this)
    aspect: 0.95,
    scaleBar: (len) => (len >= 10 ? `${len / 10} cm` : `${len} mm`),
    limits: { minDist: 60, maxDist: 2400, maxPan: 600 },
    onBeat: (i) => beat(i),
    build: (detail) => model(detail),
    note: `An Automatic Electric-style two-motion group selector, the kind with a release magnet, to scale in millimetres inside the Science Museum’s pre-2000 group selector’s envelope (${ENVELOPE.h} × ${ENVELOPE.w} × ${ENVELOPE.d} mm). The parts are the descriptions’: vertical and rotary ratchets on the shaft, a pawl on each magnet’s armature, a holding pawl for each motion, the release magnet, the return spring, three wipers over a bank three contacts deep. Their sizes are the model’s, and the bank’s arc and level pitch are illustrative: no dimensioned drawing was found. Left out: the off-normal springs, the interrupter springs’ contacts, the bank’s multiple wiring. The pause before the hunt, the hunting and the release times are assumptions; the 66 % break is the GPO standard.`,
  });
  const palette = (): SwPalette => ({ busy: stage.rgb('--sw-busy'), live: stage.rgb('--sw-live') });

  /** The model now: the mechanism where motionAt puts it, the bank's contacts as one instance set (items when flat). */
  function model(detail: 'full' | 'flat'): Model3 {
    if (!ready || !panel.isConnected) return { items: [] };
    const m = swModel(motionAt(frames, tm), detail);
    if (detail === 'full') stage.instances('sw:contacts', CONTACT_GEO, MATS.contact, contactData(target, busy, palette()), true);
    else m.items.push(...contactInstances(target, busy, palette()).map((c): Item => ({ geo: CONTACT_GEO, mat: { ...MATS.contact, base: [c.color[0], c.color[1], c.color[2]] }, at: c.pos, rot: c.rot, scale: c.scale, name: 'bank', group: 'bank' })));
    return m;
  }
  /** Rebuild only when something drawn moved. */
  function paint(): void {
    const m = motionAt(frames, tm), key = [m.level, m.line, m.vArm, m.rArm, m.relArm].map((v) => v.toFixed(3)).join() + `${m.vOn}${m.rOn}${m.relOn}${m.held}${target.mode}${target.level}${target.line}${busy.flat().join('')}`;
    if (key !== shownKey) { shownKey = key; stage.refresh(); }
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip);
  const cells = new Map<string, HTMLButtonElement>();
  const note = h('p', { class: 'r3-hint' });

  function readout(): void {
    const s = target, n = digit === null ? 0 : pulsesOf(digit), inCall = digit !== null;
    const text: Record<State['mode'], string> = {
      home: 'At rest', climb: `Vertical: level ${s.level} of ${n}`, hunt: s.line ? `Rotary: line ${s.line} busy, stepping on` : 'Rotary: starting',
      connected: `Connected: level ${s.level}, line ${s.line}`, busy: `Busy tone: level ${s.level} full, wiper on the 11th step`,
      release: s.line ? 'Release: the spring turns the shaft home' : 'Release: the shaft drops',
    };
    chip.textContent = text[s.mode];
    chip.className = `r3-chip ${s.mode === 'connected' ? 'good' : s.mode === 'busy' ? 'bad' : s.mode === 'home' || s.mode === 'release' ? '' : 'warn'}`;
    const rows: [string, string][] = [
      ['Digit dialled', inCall ? `${digit} (${n} pulses)` : 'none'],
      ['Shaft level', `${s.level} of ${LEVELS}`],
      ['Wiper line', s.line > LINES ? '11th step, past the bank' : s.line ? `${s.line} of ${LINES}` : 'rest'],
      ['Dial pulse', `${PULSE_MS} ms, ${BREAK_MS} % break (GPO)`],
      ['The call takes (model timing)', inCall ? `${end()} ms` : '0 ms'],
      ['Shown at', `1/${slow} speed`],
      ['Relay selector (previous step)', inCall ? (n < 8 ? `output ${n}` : `output ${n & 7} (it counts to 7)`) : 'output 0'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    note.textContent = !inCall ? (s.mode === 'release' ? '' : 'Dial a digit to lift the shaft.') : playing ? '' : tm < end() ? 'Paused part-way through the call. Continue it, or dial again.' : '';
    resume.hidden = !(!playing && tm < end());
    for (const [k, b] of cells) {
      const [l, j] = k.split(',').map(Number);
      b.classList.toggle('busy', busy[l - 1][j - 1]);
      b.classList.toggle('at', s.level === l && s.line === j && s.mode !== 'home');
      b.setAttribute('aria-pressed', String(busy[l - 1][j - 1]));
    }
  }

  const loop = frameLoop((_now, dt) => {
    if (playing) { tm = Math.min(end(), tm + (dt * 1000) / slow); if (tm >= end()) playing = false; }
    const next = stateAt(frames, tm), changed = next.mode !== target.mode || next.level !== target.level || next.line !== target.line;
    target = next;
    if (changed || !playing) readout();
    paint();
  }, () => playing);

  function repaint(): void { if (reducedMotion()) { playing = false; tm = end(); target = stateAt(frames, tm); } readout(); paint(); loop.kick(); }
  // Dialled again without hanging up, the selector releases first: it is wherever the last call left it.
  function dial(d: number): void { digit = d; frames = call(d, busy, target); tm = 0; playing = true; target = stateAt(frames, tm); repaint(); }
  function hangUp(): void { digit = null; frames = release(target); tm = 0; playing = frames.length > 1; target = stateAt(frames, tm); repaint(); }
  // An edit while the call is over replays it, so the hunt over the new lines is seen; mid-call it keeps its place.
  function mark(l: number, set: (j: number) => boolean): void {
    const wasEnd = tm >= end();
    for (let j = 1; j <= LINES; j++) busy[l - 1][j - 1] = set(j);
    if (digit !== null) {
      frames = call(digit, busy, frames[0].s.mode === 'release' ? { ...frames[0].s } : HOME);
      if (wasEnd) { tm = 0; playing = true; } else tm = Math.min(tm, end());
    }
    target = stateAt(frames, tm);
    repaint();
  }
  const toggle = (l: number, j: number) => mark(l, (x) => (x === j ? !busy[l - 1][x - 1] : busy[l - 1][x - 1]));
  /** The tour: each beat plays what it describes. */
  function beat(i: number): void {
    slow = BEAT_SLOW[i] ?? SLOW;
    // from rest, so the beat shows pulses and not a release first
    if (i === 1) { digit = 3; frames = call(3, busy); tm = 0; playing = true; target = stateAt(frames, tm); repaint(); }
    else if (i === 2) { for (let j = 1; j <= LINES; j++) busy[3][j - 1] = j <= 4; dial(4); }
    else if (i === 3) { if (target.mode !== 'connected') { digit = 4; frames = call(4, busy); tm = end(); playing = false; target = stateAt(frames, tm); repaint(); } }
    else if (i === 4) { if (target.mode === 'home') { frames = call(4, busy); tm = end(); target = stateAt(frames, tm); } hangUp(); }
    else readout();
  }

  const dialBtns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => {
    const b = h('button', { type: 'button', class: 'btn sm sw-key', 'aria-label': `Dial ${d}` }, String(d));
    b.addEventListener('click', () => dial(d));
    return b;
  });
  const resume = h('button', { type: 'button', class: 'btn sm' }, 'Continue the call') as HTMLButtonElement;
  resume.addEventListener('click', () => { playing = true; repaint(); });
  const hang = h('button', { type: 'button', class: 'btn sm' }, 'Hang up');
  hang.addEventListener('click', hangUp);

  const grid = h('div', { class: 'sw-grid', role: 'group', 'aria-label': 'Busy lines: a button for each line of each level' });
  grid.append(h('span'), ...Array.from({ length: LINES }, (_, j) => h('span', { class: 'sw-col' }, String(j + 1))));
  for (let l = LEVELS; l >= 1; l--) {
    const row = h('button', { type: 'button', class: 'sw-row', 'aria-label': `Level ${l}: toggle all lines busy` }, `L${l}`);
    row.addEventListener('click', () => { const all = busy[l - 1].every(Boolean); mark(l, () => !all); });
    grid.append(row);
    for (let j = 1; j <= LINES; j++) {
      const b = h('button', { type: 'button', class: 'sw-cell', 'aria-label': `Level ${l}, line ${j}` }) as HTMLButtonElement;
      b.addEventListener('click', () => toggle(l, j));
      cells.set(`${l},${j}`, b);
      grid.append(b);
    }
  }

  const ctl = h('div', { class: 'r3-ctl' }, h('div', { class: 'sw-dial', role: 'group', 'aria-label': 'Dial a digit' }, ...dialBtns),
    h('div', { class: 'r3-btns' }, resume, hang));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The machine itself'),
    h('p', { class: 'm3-sub' }, `This is a group selector, the kind that hunts. Each digit sends that many pulses at 10 a second (0 sends ten), the loop open for two thirds of each, and each pulse lifts the shaft one level: the vertical magnet pulls its armature, whose pawl lifts the shaft one tooth of its ratchet, and a holding pawl falls in under it. Then the rotary magnet turns the wipers along that level by itself, line by line, until the sleeve wiper finds a free line; with all ten busy it steps on to an 11th position past the last contact, and that gives the busy tone. (A final selector, the last in the train, would step along the level on the next digit’s pulses instead, and give the tone on a busy line without hunting.) Mark lines busy below and dial again. Hang up and the release magnet lifts the holding pawls: a spring turns the shaft back to its home angle, and only then does it drop. The relay selector of the previous step stops at output 7 and never hunts; here the digit picks a level of ten lines. Shown ${SLOW} times slower than real.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, ctl, stage.el, note),
      h('div', { class: 'r3-side' }, h('h4', null, 'This selector ', h('span', { class: 'r3-badge' }, 'model')), kv, h('h4', null, 'Busy lines'), grid)));

  ready = true;
  readout();
  // the theme's colours resolve only once the panel is on the page
  requestAnimationFrame(function onPage() { if (panel.isConnected) { shownKey = ''; paint(); } else if (ready) requestAnimationFrame(onPage); });
  return { el: panel, destroy() { ready = false; loop.stop(); stage.destroy(); } };
}
