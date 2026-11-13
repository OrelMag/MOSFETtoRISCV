// Hollerith's pin press in 3D (loaded on demand, modelhost.ts). The card, its holes and the tally are the chapter's
// census (cards/census.ts, the same stack and counting as censusWidget). The motion is a drawing, not a physics model: a
// stroke counts the card once, on crossing the bottom (pins reaching mercury), however the slider got there.

import '../styles/press3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { FIELDS, STACK, censusPeople, newCounts, relayDial, tallyCard, type Wiring } from '../cards/census';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { PRESS_HOME, pressModel } from './press3dkit';
import { N, POSITIONS, closedOf, holesOf, type PressPose } from './press3dgeom';

const DOWN_MS = 450, HOLD_MS = 150;
const PRE = 8; // cards already counted when the page opens

export function pressView(): Widget {
  const people = censusPeople();
  let counts = newCounts(), idx = 0, armed = true, s = 0.85, wiring: Wiring = 'and', relayCount = 0;
  // A stroke: down to the bottom, a short hold, back up; the slider and Feed end it.
  let anim: { phase: 'down' | 'hold' | 'up'; t: number } | null = null;
  // Opens part-way through a stroke: eight cards counted, the ninth half down with its pins visibly past the blocked ones.
  for (idx = 0; idx < PRE; idx++) count(people[idx]);
  function count(p: readonly number[]): void { tallyCard(counts, p); if (relayDial(p, wiring)) relayCount++; }

  const panel = h('div', { class: 'panel pr3' });
  const pose = (): PressPose => ({ s, holes: holesOf(people[idx]), counts: POSITIONS.map((q) => counts[q.field][q.opt]), wiring, relayCount });
  const stage = studioStage({
    aria: 'Hollerith’s pin press in 3D: a box of spring pins above a census card, mercury cups below it and a row of counting dials',
    home: PRESS_HOME,
    homeFrame: ['card', 'cups', 'dials', 'pin box'],
    limits: { minDist: 25, maxDist: 360, maxPan: 60 },
    note: 'A drawing of the mechanism, not a measured press: only the census card’s ten positions (a real card had 288), drawn thicker than card; the pin box slides on posts where the real press swung on a hinge worked by a hand lever; the stroke is a drawing, not a model of the forces; the wiring under the table is drawn only where it meets the relays. The real press had 40 dials of 100 divisions with two hands each (U.S. Census Bureau; The Henry Ford). The card’s size is not stated: the sources disagree (3¼ × 6⅝ in, 3¼ × 7⅜ in, 3 × 5½ in).',
    build: (detail) => pressModel(pose(), detail),
  });
  function paint(): void { stage.refresh(); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), note = h('p', { class: 'r3-hint' });
  stage.chips.append(chip);

  /** Count the card the moment the head reaches the bottom, once per card. */
  function cross(prev: number): void {
    if (armed && prev < 1 && s >= 1) { count(people[idx]); armed = false; }
  }
  function readout(): void {
    const p = people[idx], holes = holesOf(p), nHoles = holes.filter(Boolean).length, nClosed = closedOf(s, holes).filter(Boolean).length;
    chip.textContent = nClosed ? `${nClosed} circuits closed` : s <= 0 ? 'Raised' : `Pressing: no circuit yet`;
    chip.className = `r3-chip ${nClosed ? 'good' : ''}`;
    const rows: [string, string][] = [
      ['Card', `${idx + 1} of ${STACK}`],
      ['Punched', FIELDS.map((f, i) => f.opts[p[i]]).join(', ')],
      ['Pins over a hole', `${nHoles} of ${N}`],
      ['Circuits closed now', String(nClosed)],
      ['Cards counted', String(armed ? idx : idx + 1)],
      [wiring === 'and' ? 'Married and born abroad (series)' : 'Married or born abroad (parallel)', String(relayCount)],
      ['Married + abroad dials, added', String(counts[2][0] + counts[3][1])],
      ['This card', `${p[2] === 0 ? 'married' : 'not married'}, ${p[3] === 1 ? 'born abroad' : 'born in the US'}: ${relayDial(p, wiring) ? 'steps' : 'leaves'} the relay dial`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    note.textContent = armed ? 'Lower the press all the way: only a pin above a hole reaches the mercury.' : idx + 1 < STACK ? 'Counted. Raise the press and feed the next card.' : 'The stack is counted.';
    feed.disabled = idx + 1 >= STACK;
    slider.value = String(Math.round(s * 100)); out.textContent = `${Math.round(s * 100)} %`;
    press.textContent = reducedMotion() && s >= 1 ? 'Raise' : 'Press';
    wire.textContent = wiring === 'and' ? 'Contacts in parallel (OR)' : 'Contacts in series (AND)';
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
  // Rewiring the contacts and feeding the cards again, as in 1890: the dial counts what is counted so far under the new wiring.
  const wire = h('button', { type: 'button', class: 'btn sm' }, '') as HTMLButtonElement;
  wire.addEventListener('click', () => {
    wiring = wiring === 'and' ? 'or' : 'and';
    relayCount = people.slice(0, armed ? idx : idx + 1).filter((p) => relayDial(p, wiring)).length;
    repaint();
  });
  restart.addEventListener('click', () => { counts = newCounts(); relayCount = 0; idx = 0; armed = true; s = 0; anim = null; repaint(); });

  stage.slot.append(h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl pr-stroke' }, h('span', null, 'Press'), slider, out),
    h('div', { class: 'r3-btns' }, press, feed, wire, restart)), note);
  panel.append(
    h('h3', { class: 'm3-title' }, 'The press itself'),
    h('p', { class: 'm3-sub' }, 'The same sixty census cards and the same tally as the widget above, one position for every option of every field. The pin box lowers an identical spring pin over each position. Where the card has no hole the pin stops on it and rides up into the box against its spring; where it has one the pin goes through to the mercury cup below, and the circuit it closes energizes that dial’s magnet, which steps the long hand one of a hundred divisions (the short hand turns once per 10 000). Two of the cups also feed relays, married and born abroad: their contacts in series step the eleventh dial for married AND born abroad, in parallel for married OR born abroad. Adding the two single dials instead counts a married immigrant twice; compare them in the table. The card is counted once, as the head reaches the bottom of the stroke: lowered only part way, nothing closes.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('h4', null, 'This press ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
