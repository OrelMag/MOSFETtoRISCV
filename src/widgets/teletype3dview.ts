// The Teletype Model 33's selector in 3D on the studio renderer (loaded on demand, modelhost.ts; drawn by teletype3dkit.ts,
// moved by comm/teletype33.ts). Under chapter exchange's start-stop widget: the same frame, received by cams instead of a
// counter. A character is sent at 110 baud slowed down; the clock-error slider runs the receiver's motor fast or slow.

import '../styles/teletype3d.css';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { TOUR, TT_HOME, teletypeModel } from './teletype3dkit';
import { REV_UNITS, TTY33, UNIT_MS, startStopWord, ttyCode, ttyPose } from '../comm/teletype33';
import { frameUnits, receive, segments, toleranceClosedForm } from '../comm/startstop';

/** How many times slower than real the character plays (100 ms becomes 4 s). */
const SLOW = 40;
const TEXT = 'HELLO, WORLD! ';
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const bin8 = (v: number) => Array.from({ length: 8 }, (_, i) => (v >> (7 - i)) & 1).join('');
const shown = (c: number) => { const k = c & 0x7f; return k >= 32 && k < 127 ? `‘${String.fromCharCode(k)}’` : `0x${hex2(k)}`; };

export function teletypeView(): Widget {
  let code = ttyCode('A'), err = 0, t = -1.2, playing = false, running = false, next = 0, ready = false;
  const panel = h('div', { class: 'panel tt3' });
  const stage = studioStage({
    home: TT_HOME,
    fit: false,
    aspect: 1.6,
    limits: { minDist: 40, maxDist: 600, maxPan: 160 },
    // a beat poses the selector at its moment (and its clock error)
    onBeat: (i) => { if (i < 0) return; playing = false; running = false; t = TOUR[i].t; setErr(TOUR[i].err); if (i === 4) code = ttyCode('A'); if (ready) { readout(); draw(); } },
    build: () => teletypeModel(ttyPose(code, err, t)),
    aria: 'The selector of a Teletype Model 33 in 3D: a continuously turning shaft, a clutch, a cam sleeve with eight notched cams, eight selector levers and push levers, and the selector magnet on the line whose armature lets the levers read it',
    note: `Every dimension is illustrative: no measurement of the 33’s selector was found (Teletype Bulletin 310B gives them). The mechanism is the serial selector of Teletype’s patents (US 3,406,254: magnet, armature, start lever, clutch trip, a cam sleeve with notched cams offset round it, followers, push levers) with the 33’s frame: 110 baud, a start unit, eight levels (seven-bit ASCII and even parity) and two stop units, ${UNIT_MS.toFixed(2)} ms a unit, ${(UNIT_MS * frameUnits(TTY33)).toFixed(0)} ms a character. The sleeve turns once in ${REV_UNITS} units of its own clock, a little less than the character, so it is at rest before the next start (US 1,821,110). It plays ${SLOW} times slower than real. The levers’ readings are computed by the chapter’s own receiver model (comm/startstop.ts), so the clock-error slider fails where the chapter’s tolerance says.`,
  });
  ready = true;
  function draw(): void { if (ready) stage.refresh(); }

  const chip = h('span', { class: 'r3-chip' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const strip = s('svg', { class: 'tt-strip', viewBox: '0 0 440 64', role: 'img', 'aria-label': 'The character on the line and where the levers sample it' }) as SVGSVGElement;
  function drawStrip(): void {
    const U = 440 / (frameUnits(TTY33) + 1), X = (u: number) => (u + 0.5) * U, rx = receive(TTY33, code, { err });
    const g: SVGElement[] = [];
    for (const seg of segments(TTY33, code)) {
      const y = seg.level ? 10 : 34;
      g.push(s('rect', { x: X(seg.from), y, width: X(seg.to) - X(seg.from), height: 14, class: `tt-u ${seg.level ? 'm' : 's'}` }), s('text', { x: (X(seg.from) + X(seg.to)) / 2, y: 60, class: 'tt-l' }, seg.label === 'start' ? 'start' : seg.label === 'stop' ? 'stop' : seg.label.replace('d', '')));
    }
    rx.samples.slice(0, TTY33.data).forEach((sm, i) => g.push(s('line', { x1: X(sm.at), x2: X(sm.at), y1: 4, y2: 50, class: `tt-s ${sm.sees === `d${i}` ? '' : 'bad'}` })));
    if (t >= 0) g.push(s('line', { x1: X(t), x2: X(t), y1: 0, y2: 52, class: 'tt-now' }));
    strip.replaceChildren(...g);
  }
  function readout(): void {
    const p = ttyPose(code, err, t), word = startStopWord(code, err), done = p.read.every((b) => b !== null);
    chip.textContent = t < 0 ? 'At rest: line marking' : p.clutch ? `Sleeve turning: ${Math.round(p.sleeve)}°` : 'Stopped: levers hold the character';
    chip.className = `r3-chip ${p.clutch ? 'warn' : ''}`;
    const got = p.read.map((b) => (b === null ? '·' : String(b))).reverse().join('');
    const text = t < 0 ? `Sending ${shown(code)} = ${bin8(code)} (parity first, bit 1 last). Press Send.`
      : `Sent ${shown(code)} ${bin8(code)}; the levers read ${got}${done ? (word === code ? ': right.' : `: wrong, ${shown(word)}.`) : '.'}`;
    if (live.textContent !== text) live.textContent = text;
    errOut.textContent = `${err > 0 ? '+' : err < 0 ? '−' : ''}${Math.abs(err * 100).toFixed(1)} %`;
    errOut.className = Math.abs(startStopWord(code, err) - code) ? 'bad' : '';
    drawStrip();
  }

  const loop = frameLoop((_now, dt) => {
    if (playing) {
      t += reducedMotion() ? 0 : (dt * 1000) / (UNIT_MS * SLOW);
      if (reducedMotion()) t = REV_UNITS + 0.5;
      if (t > frameUnits(TTY33) + 0.6) {
        if (running) { code = ttyCode(TEXT[next++ % TEXT.length]); t = -0.6; } else { playing = false; }
      }
    }
    readout(); draw();
  }, () => playing);
  const kick = () => { readout(); draw(); loop.kick(); };

  const charIn = h('input', { type: 'text', value: 'A', maxlength: '1', 'aria-label': 'Character to send', spellcheck: 'false', class: 'tt-char' }) as HTMLInputElement;
  charIn.addEventListener('input', () => { if (charIn.value) { code = ttyCode(charIn.value); t = -1.2; playing = false; kick(); } });
  const sendBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Send') as HTMLButtonElement;
  sendBtn.addEventListener('click', () => { running = false; t = -0.4; playing = true; kick(); });
  const runBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Type a line') as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    running = !running; runBtn.setAttribute('aria-pressed', String(running)); runBtn.textContent = running ? 'Stop' : 'Type a line';
    if (running) { code = ttyCode(TEXT[next++ % TEXT.length]); t = -0.4; playing = true; }
    kick();
  });
  const tol = toleranceClosedForm(TTY33);
  const errIn = h('input', { type: 'range', min: '-0.08', max: '0.08', step: '0.005', value: '0', 'aria-label': 'Receiver clock error, −8 to +8 percent' }) as HTMLInputElement;
  const errOut = h('output', null, '0 %');
  function setErr(v: number): void { err = v; errIn.value = String(v); }
  errIn.addEventListener('input', () => { err = Number(errIn.value); kick(); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The receiver of a Teletype Model 33'),
    h('p', { class: 'm3-sub' }, `The same frame received by a machine: a motor turns all the time, the start edge releases a clutch, and a sleeve of eight cams turns once. Each cam has one notch, and the notches are staggered so that lever i looks at the line in the middle of unit i. No counter, no clock but the motor’s speed: it reads right while that speed is within ${(tol.fast * 100).toFixed(1)} % fast and ${(tol.slow * 100).toFixed(1)} % slow.`),
    h('div', { class: 'r3-ctl' },
      h('label', { class: 'tt-in' }, 'Character ', charIn), h('div', { class: 'r3-btns' }, sendBtn, runBtn),
      h('label', { class: 'r3-sl tt-err' }, h('span', null, 'Receiver clock error'), errIn, errOut)),
    stage.el, strip, live);
  readout();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
