// The Strowger selector in 3D (loaded on demand, modelhost.ts): the machine behind the chapter's relay selector. The
// state machine is phys/strowger.ts; this plays its frames slowed, chases the drawing after them, and lets the learner
// dial a level, mark lines busy and hang up. It opens part-way through a call, paused on a busy line.

import '../styles/strowger3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { BREAK_MS, call, HOME, LEVELS, LINES, PULSE_MS, pulsesOf, release, stateAt, verticalPulling, type Frame, type State } from '../phys/strowger';
import { frameLoop } from './mosfet';
import { LOOKS } from '../gl/kit/looks';
import { modelStage } from './modelstage';
import { swAnchors, swParts, type SwPalette, type SwPose } from './strowger3dparts';

/** The call plays this many times slower than real, so a pulse (100 ms) takes half a second. */
export const SLOW = 5;

export function strowgerView(): Widget {
  const busy: boolean[][] = Array.from({ length: LEVELS }, () => Array<boolean>(LINES).fill(false));
  for (const j of [1, 2, 3, 4]) busy[3][j - 1] = true; // level 4: the first four lines are taken
  for (const j of [2, 5, 6, 9]) busy[6][j - 1] = true;
  let digit: number | null = 4, frames: Frame[] = call(4, busy);
  // Open on the wiper passing the third line, which is busy: the hunt is under way.
  let tm = frames.find((f) => f.s.mode === 'hunt' && f.s.line === 3)!.t, playing = false;
  let target: State = stateAt(frames, tm);
  const disp = { level: target.level, line: target.line };
  const end = () => frames[frames.length - 1].t;

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    look: LOOKS.machine,
    aria: 'A Strowger selector in 3D: a vertical shaft with a wiper that turns over a bank of ten levels of ten contacts',
    camera: { target: [0, 25, -2], yaw: 0.5, pitch: 0.3, dist: 158 },
    limits: { minDist: 50, maxDist: 320 },
    note: 'A group selector: it hunts. One of the three wipers is drawn, the shaft’s ratchets and pawls are left out (the release magnet is drawn, not the pawls it frees), the contacts are far larger than life, and the pause before the hunt, the hunting and the release times are assumptions; the 66 % break is the GPO standard.',
    draw,
  });
  const palette = (): SwPalette => ({
    frame: stage.rgb('--m3-si'), shaft: stage.rgb('--m3-metal'), brass: stage.rgb('--sw-brass'), free: stage.rgb('--sw-free'), busy: stage.rgb('--sw-busy'),
    live: stage.rgb('--m3-charge'), coil: stage.rgb('--sw-coil'), lit: stage.rgb('--sw-lit'), probe: stage.rgb('--sw-brass'),
  });
  const pose = (): SwPose => ({
    level: disp.level, line: disp.line,
    // The vertical magnet pulls while the loop is open (the break, BREAK_MS of each pulse); the rotary one steps while hunting;
    // the release magnet holds the pawls off until the shaft is home.
    vmag: playing && verticalPulling(frames, tm), rmag: playing && target.mode === 'hunt' && target.line > 0, rel: playing && target.mode === 'release',
  });
  function draw(): void { const p = pose(); stage.paint(swParts(p, target, busy, palette()), swAnchors(p)); }

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
      ['Shown at', `1/${SLOW} speed`],
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

  const moving = () => playing || Math.abs(disp.level - target.level) > 0.004 || Math.abs(disp.line - target.line) > 0.004;
  const loop = frameLoop((_now, dt) => {
    if (playing) { tm = Math.min(end(), tm + (dt * 1000) / SLOW); if (tm >= end()) playing = false; }
    const next = stateAt(frames, tm), changed = next.mode !== target.mode || next.level !== target.level || next.line !== target.line;
    target = next;
    const k = 1 - Math.exp(-dt * 16);
    disp.line += (target.line - disp.line) * k;
    // The shaft never drops while turned: going down waits for the wipers to be back at the home angle.
    if (target.level >= disp.level || Math.abs(disp.line) < 0.02) disp.level += (target.level - disp.level) * k;
    if (changed || !playing) readout();
    draw();
  }, moving);

  // Without animation the call jumps to its end state.
  const settle = () => { target = stateAt(frames, tm); disp.level = target.level; disp.line = target.line; };
  function repaint(): void { if (reducedMotion()) { playing = false; settle(); } readout(); draw(); loop.kick(); }
  // Dialled again without hanging up, the selector releases first: it is wherever the last call left it.
  function dial(d: number): void { digit = d; frames = call(d, busy, target); tm = reducedMotion() ? end() : 0; playing = !reducedMotion(); target = stateAt(frames, tm); repaint(); }
  function hangUp(): void { digit = null; frames = release(target); tm = reducedMotion() ? end() : 0; playing = !reducedMotion() && frames.length > 1; target = stateAt(frames, tm); repaint(); }
  // An edit while the call is over replays it, so the hunt over the new lines is seen; mid-call it keeps its place.
  function mark(l: number, set: (j: number) => boolean): void {
    const wasEnd = tm >= end();
    for (let j = 1; j <= LINES; j++) busy[l - 1][j - 1] = set(j);
    if (digit !== null) {
      frames = call(digit, busy, frames[0].s.mode === 'release' ? { ...frames[0].s } : HOME);
      if (wasEnd) { tm = reducedMotion() ? end() : 0; playing = !reducedMotion(); } else tm = Math.min(tm, end());
    }
    target = stateAt(frames, tm);
    repaint();
  }
  const toggle = (l: number, j: number) => mark(l, (x) => (x === j ? !busy[l - 1][x - 1] : busy[l - 1][x - 1]));

  const dialBtns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => {
    const b = h('button', { type: 'button', class: 'btn sm sw-key', 'aria-label': `Dial ${d}` }, String(d));
    b.addEventListener('click', () => dial(d));
    return b;
  });
  const resume = h('button', { type: 'button', class: 'btn sm' }, 'Continue the call') as HTMLButtonElement;
  resume.addEventListener('click', () => { if (reducedMotion()) tm = end(); else playing = true; repaint(); });
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
    h('div', { class: 'r3-btns' }, resume, hang, stage.resetBtn));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The machine itself'),
    h('p', { class: 'm3-sub' }, `This is a group selector, the kind that hunts. Each digit sends that many pulses at 10 a second (0 sends ten), the loop open for two thirds of each, and each pulse lifts the shaft one level. Then the rotary magnet turns the wipers along that level by itself, line by line, until it finds a free one; with all ten busy it steps on to an 11th position past the last contact, and that gives the busy tone. (A final selector, the last in the train, would step along the level on the next digit’s pulses instead, and give the tone on a busy line without hunting.) Mark lines busy below and dial again. Hang up and the release magnet frees the pawls: a spring turns the shaft back to its home angle, and only then does it drop. The relay selector of the previous step stops at output 7 and never hunts; here the digit picks a level of ten lines. Shown ${SLOW} times slower than real.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, ctl, stage.el, stage.hint, note),
      h('div', { class: 'r3-side' }, h('h4', null, 'This selector ', h('span', { class: 'r3-badge' }, 'model')), kv, h('h4', null, 'Busy lines'), grid)));

  readout();
  draw();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
