// Hollerith's pin press in 3D (loaded on demand, modelhost.ts). The card, its holes and the tally are the chapter's
// census (cards/census.ts, the same stack and counting as censusWidget). The motion is a drawing, not a physics model: a
// stroke counts the card once, on crossing the bottom (pins reaching mercury), however the slider got there.

import '../styles/press3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { FIELDS, STACK, censusPeople, marriedWoman, newCounts, tallyCard } from '../cards/census';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { N, POSITIONS, closedOf, holesOf, pressAnchors, pressParts, type PressPalette, type PressPose } from './press3dparts';

const DOWN_MS = 450, HOLD_MS = 150;
const PRE = 8; // cards already counted when the page opens

export function pressView(): Widget {
  const people = censusPeople();
  let counts = newCounts(), combo = 0, idx = 0, armed = true, s = 0.85;
  // A stroke: down to the bottom, a short hold, back up; the slider and Feed end it.
  let anim: { phase: 'down' | 'hold' | 'up'; t: number } | null = null;
  // Opens part-way through a stroke: eight cards counted, the ninth half down with its pins visibly past the blocked ones.
  for (idx = 0; idx < PRE; idx++) combo += tallyCard(counts, people[idx]);

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'Hollerith’s pin press in 3D: a head of spring pins above a census card, mercury cups below it and a row of counting dials',
    camera: { target: [0, 23, 8], yaw: 0.5, pitch: 0.3, dist: 142 },
    limits: { minDist: 60, maxDist: 360 },
    note: 'Only the census card’s ten positions are drawn, far fewer than a real card had, and the stroke is a drawing: the pins are not modelled.',
    draw: () => paint(),
  });
  const palette = (): PressPalette => ({
    frame: stage.rgb('--m3-si'), metal: stage.rgb('--m3-metal'), card: stage.rgb('--pr-card'), hg: stage.rgb('--pr-hg'), live: stage.rgb('--m3-charge'),
    cup: stage.rgb('--pr-cup'), face: stage.rgb('--pr-face'), hand: stage.rgb('--pr-hand'), brass: stage.rgb('--pr-brass'), pad: stage.rgb('--pr-pad'),
  });
  const pose = (): PressPose => ({ s, holes: holesOf(people[idx]), counts: POSITIONS.map((q) => counts[q.field][q.opt]) });
  function paint(): void { const p = pose(); stage.paint(pressParts(p, palette()), pressAnchors(p)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), note = h('p', { class: 'r3-hint' });
  stage.chips.append(chip);

  /** Count the card the moment the head reaches the bottom, once per card. */
  function cross(prev: number): void {
    if (armed && prev < 1 && s >= 1) { combo += tallyCard(counts, people[idx]); armed = false; }
  }
  function readout(): void {
    const p = people[idx], holes = holesOf(p), nHoles = holes.filter(Boolean).length, nClosed = closedOf(s, holes).filter(Boolean).length;
    chip.textContent = nClosed ? `${nClosed} circuits closed` : s <= 0 ? 'Raised' : `Pressing: no circuit yet`;
    chip.className = `r3-chip ${nClosed ? 'good' : s > 0 ? 'warn' : ''}`;
    const rows: [string, string][] = [
      ['Card', `${idx + 1} of ${STACK}`],
      ['Punched', FIELDS.map((f, i) => f.opts[p[i]]).join(', ')],
      ['Pins over a hole', `${nHoles} of ${N}`],
      ['Circuits closed now', String(nClosed)],
      ['Cards counted', String(armed ? idx : idx + 1)],
      ['Women', String(counts[0][1])],
      ['Married women (two relays)', String(combo)],
      ['This card', marriedWoman(p) ? 'a married woman' : 'not a married woman'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    note.textContent = armed ? 'Lower the press all the way: only a pin above a hole reaches the mercury.' : idx + 1 < STACK ? 'Counted. Raise the press and feed the next card.' : 'The stack is counted.';
    feed.disabled = idx + 1 >= STACK;
    slider.value = String(Math.round(s * 100)); out.textContent = `${Math.round(s * 100)} %`;
    press.textContent = reducedMotion() && s >= 1 ? 'Raise' : 'Press';
  }
  const repaint = () => { readout(); paint(); loop.kick(); };

  const loop = frameLoop((_now, dt) => {
    if (anim) {
      const prev = s;
      anim.t += dt * 1000;
      if (anim.phase === 'down') { s = Math.min(1, s + (dt * 1000) / DOWN_MS); cross(prev); if (s >= 1) { anim.phase = 'hold'; anim.t = 0; } }
      else if (anim.phase === 'hold') { if (anim.t >= HOLD_MS) anim.phase = 'up'; }
      else { s = Math.max(0, s - (dt * 1000) / DOWN_MS); if (s <= 0) anim = null; }
    }
    readout(); paint();
  }, () => anim !== null);

  function setS(v: number): void { const prev = s; anim = null; s = Math.min(1, Math.max(0, v)); cross(prev); repaint(); }
  const slider = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(s * 100), 'aria-label': 'Press: how far the head is lowered' }) as HTMLInputElement;
  const out = h('output', null, '');
  slider.addEventListener('input', () => setS(Number(slider.value) / 100));
  const press = h('button', { type: 'button', class: 'btn sm' }, 'Press') as HTMLButtonElement;
  press.addEventListener('click', () => {
    if (reducedMotion()) { setS(s >= 1 ? 0 : 1); return; }
    if (anim) return;
    anim = { phase: s >= 1 ? 'hold' : 'down', t: 0 };
    repaint();
  });
  const feed = h('button', { type: 'button', class: 'btn sm' }, 'Feed next card') as HTMLButtonElement;
  feed.addEventListener('click', () => { if (idx + 1 >= STACK) return; anim = null; s = 0; idx++; armed = true; repaint(); });
  const restart = h('button', { type: 'button', class: 'btn sm' }, 'Start over');
  restart.addEventListener('click', () => { counts = newCounts(); combo = 0; idx = 0; armed = true; s = 0; anim = null; repaint(); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The press itself'),
    h('p', { class: 'm3-sub' }, 'The same sixty census cards and the same tally as the widget above, one position for every option of every field. The head lowers a spring pin over each position. Where the card has no hole the pin stops on it and its spring gives; where it has one the pin goes through to the mercury cup below, and the circuit it closes steps that position’s dial by one. The card is counted once, as the head reaches the bottom of the stroke: lowered only part way, nothing closes. Feed the next card and press again.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl pr-stroke' }, h('span', null, 'Press'), slider, out),
          h('div', { class: 'r3-btns' }, press, feed, restart, stage.resetBtn)),
        stage.el, stage.hint, note),
      h('div', { class: 'r3-side' }, h('h4', null, 'This press ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
