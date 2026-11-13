// ENIAC's decade ring counter in 3D (loaded on demand, eniac3d.ts), on the studio renderer: two decade units counting
// pulses, the lit neon moving one stage a pulse, the carry to the tens as the units pass nine (eniac3dgeom.ts's rule,
// tested against the library's ringCounter(10)).

import '../styles/eniac3d.css';
import { h } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { keepWidth } from './studiowidth';
import { ENIAC_HOME, eniacModel } from './eniac3dkit';
import { ACCUMULATORS, DIGITS, RING_TRIODES, STAGES, TUBES_PER_DIGIT, pulse, zero, type Decades } from './eniac3dgeom';
import { ENIAC } from '../phys/triode';

const LIT_MS = 260, RUN_HZ = 2.5;

export function eniacView(): Widget {
  let d: Decades = { digits: [7, 0], carried: [false, false] }, count = 7, lit = 0, running = false, acc = 0;
  const panel = h('div', { class: 'panel en3' });
  const stage = studioStage({
    aria: 'Two decade units of an ENIAC accumulator in 3D: ten 6SN7 twin-triode flip-flops in a row on each, a neon under each tube, the lit neon showing the digit; a pulse moves it one stage, and passing nine carries into the tens',
    home: ENIAC_HOME,
    fit: false,
    aspect: 1.35,
    limits: { minDist: 150, maxDist: 4000, maxPan: 900 },
    scaleBar: (len) => `${groupNum(len)} mm`,
    note: `ENIAC's decade ring counter after the U.S. Army Ordnance history (1961): ten flip-flops a decade, two triodes each with one conducting, a neon on the front panel for each, a pulse advancing the ring one stage, a pulse to the next ring when it passes nine. The 6SN7 is to its datasheet's outline (Rock's tube, at its low detail); the unit's length, about 114.5 cm, is the Smithsonian's ENIAC Decade Ring Counter; its depth, the sockets' spacing, the neons and their place on the front edge, the grey paint and the plug are drawn (the lit neon's glow far wider than the lamp, so it reads at this scale). The heaters glow as Rock's tube model computes them at full warmth; the glow between the plates of each tube's conducting half is a cue (a 6SN7's current makes no light): the left half conducts in nine stages, the right half in the one holding the digit. The dim back row stands for the digit's other ${TUBES_PER_DIGIT - STAGES} tubes (pulse standardizer, carry, output transmitters), drawn plain and unlit so the ring leads. The tens decade stands behind and above the units (drawn: in ENIAC the decades sat side by side in an accumulator's panels). Two decades are drawn; an accumulator had ten and a sign. The counting rate is slowed: ENIAC counted at 100 000 pulses a second.`,
    build: (detail) => eniacModel({ d, pulsing: lit > 0 }, detail),
  });
  const width = keepWidth(stage, 2.0, () => ENIAC_HOME); // its home's canvas at 1440 px
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  function readout(): void {
    const n = d.digits[1] * 10 + d.digits[0];
    chip.textContent = `holds ${n}`;
    chip.className = `r3-chip ${d.carried[1] && lit > 0 ? 'warn' : 'good'}`;
    const rows: [string, string][] = [
      ['Pulses counted', groupNum(count)],
      ['Units decade', `stage ${d.digits[0]} lit`],
      ['Tens decade', `stage ${d.digits[1]} lit`],
      ['A digit', `${STAGES} 6SN7s in the ring = ${RING_TRIODES} triodes; ${TUBES_PER_DIGIT} tubes with its support`],
      ['An accumulator', `${DIGITS} digits and a sign`],
      ['ENIAC', `${ACCUMULATORS} accumulators: ${groupNum(ACCUMULATORS * DIGITS * TUBES_PER_DIGIT)} of its ${groupNum(ENIAC.tubes)} tubes counting`],
      ['Counting rate', `${groupNum(ENIAC.pulseHz)} pulses a second (drawn at ${RUN_HZ})`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    runBtn.textContent = running ? 'Pause' : 'Run';
  }
  const paint = () => { stage.refresh(); readout(); };
  function step(): void {
    d = pulse(d); count++; lit = LIT_MS;
    if (d.carried[1]) live.textContent = `The units passed nine: a carry pulse stepped the tens to ${d.digits[1]}.`;
    paint(); loop.kick();
  }
  const loop = frameLoop((_t, dt) => {
    if (lit > 0) { lit = Math.max(0, lit - dt * 1000); if (lit === 0) paint(); }
    if (running) { acc += dt * RUN_HZ; if (acc >= 1) { acc -= 1; step(); } }
  }, () => running || lit > 0);
  const btn = (label: string, fn: () => void, primary = false) => { const b = h('button', { type: 'button', class: `btn sm${primary ? ' primary' : ''}` }, label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };
  const pulseBtn = btn('Pulse', () => { running = false; step(); }, true);
  const runBtn = btn('Run', () => { running = !running && !reducedMotion(); if (reducedMotion()) step(); paint(); loop.kick(); });
  const toNine = btn('Set 9', () => { running = false; d = { digits: [9, d.digits[1]], carried: [false, false] }; paint(); });
  const reset = btn('Clear', () => { running = false; d = zero(); count = 0; lit = 0; live.textContent = ''; paint(); });
  stage.slot.append(h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, pulseBtn, runBtn, toNine, reset)), live);
  panel.append(
    h('h3', { class: 'm3-title' }, 'A decimal digit in ten bulbs'),
    h('p', { class: 'm3-sub' }, `ENIAC did not count in binary: each digit of an accumulator was a ring of ten flip-flops, each one a 6SN7 twin triode wired as the Eccles–Jordan pair of the step before, and exactly one of the ten in its "1" state. A neon under each tube shows which. A counting pulse moves the "1" on one stage; when the ring passes nine it sends a pulse to the next decade. Press Pulse, or Set 9 and pulse once to see the carry.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('h4', null, 'This accumulator ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  return { el: panel, destroy() { width.stop(); loop.stop(); stage.destroy(); } };
}
