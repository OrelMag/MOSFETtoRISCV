// The floating gate in 3D (loaded on demand, modelhost.ts): a NAND string of four cells whose charge follows
// phys/fgate.ts, i.e. chapter 37's rule (lib/flash.ts, sim/switchsim.ts). The learner pulses program on a chosen cell,
// erases the block and reads the string with the other cells at the pass voltage.

import '../styles/fgate3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { V_READ, vtOf } from '../lib/flash';
import { FG_STEP } from '../sim/switchsim';
import { CELLS, E_FULL, PASS_V, PULSES_TO_PROGRAM, conducts, electrons, erase, program, readConduction, stringConducts, type Bank } from '../phys/fgate';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { fgAnchors, fgParts, type FgPalette, type FgPose } from './fgate3dparts';

/** A pulse's electrons take this long to cross the oxide. */
export const FLY_MS = 700;

export function fgateView(): Widget {
  // Opens on a cell that has taken two pulses, read: the string is blocked by it.
  let bank: Bank = { q: [0, 2 * FG_STEP, 0, 0], sel: 1 };
  let reading = true, fly: FgPose['fly'];
  const panel = h('div', { class: 'panel' });
  const palette = (): FgPalette => ({
    si: stage.rgb('--m3-si'), n: stage.rgb('--m3-n'), poly: stage.rgb('--m3-poly'), oxide: stage.rgb('--m3-oxide'), metal: stage.rgb('--m3-metal'),
    charge: stage.rgb('--m3-charge'), carrier: stage.rgb('--m3-carrier'), hot: stage.rgb('--m3-hot'),
  });
  const pose = (): FgPose => ({ bank, reading, programming: !!fly, fly });
  const stage = modelStage(panel, {
    aria: 'A NAND string of four floating-gate flash cells in 3D: each has a control gate with a wire and a floating gate sealed in oxide, holding electrons',
    camera: { target: [0, 5, 0], yaw: 0.2, pitch: 0.3, dist: 114 },
    limits: { minDist: 40, maxDist: 300 },
    note: `The layers are drawn about 10 times thicker than a real tunnel oxide, and a cell holds ${E_FULL} electrons at full charge here, where a real one holds thousands: the count is only proportional to the charge.`,
    draw: () => stage.paint(fgParts(pose(), palette()), fgAnchors(pose())),
  });
  const draw = () => stage.paint(fgParts(pose(), palette()), fgAnchors(pose()));

  const chip = h('span', { class: 'r3-chip' }), chip2 = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip, chip2);
  const note = h('p', { class: 'r3-hint' });

  function readout(): void {
    const s = bank.sel, q = bank.q[s], on = conducts(q, V_READ), str = stringConducts(bank);
    chip.textContent = fly ? `Program pulse on cell ${s + 1}` : reading ? `Reading cell ${s + 1}: ${V_READ} V, the others ${PASS_V} V` : 'No voltage on the string';
    chip.className = `r3-chip ${fly ? 'warn' : ''}`;
    chip2.textContent = reading ? (str ? 'String conducts: reads 1' : 'String blocked: reads 0') : '';
    chip2.className = `r3-chip ${reading ? (str ? 'good' : 'bad') : ''}`;
    chip2.hidden = !reading;
    const rows: [string, string][] = [
      ['Chosen cell', String(s + 1)],
      ['Charge q', `${q.toFixed(1)} (${electrons(q)} of ${E_FULL} electrons drawn)`],
      ['Vt = 1 + 5q', `${vtOf(q).toFixed(1)} V`],
      ['At the read voltage', `${V_READ} V: ${on ? 'conducts' : 'stays off'}`],
      ['Others at the pass voltage', `${PASS_V} V: ${readConduction(bank).filter((_, i) => i !== s).every(Boolean) ? 'all conduct' : 'one is off'}`],
      ['Bit read', on ? '1 (erased side)' : '0 (programmed)'],
      ['Pulses to reach 0', `${PULSES_TO_PROGRAM} of ${FG_STEP} charge`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    note.textContent = fly ? '' : reading ? 'Only the chosen control gate is at the read voltage; the string decides by that one cell.' : 'Pulse program to push electrons through the oxide, or read the string.';
  }

  const loop = frameLoop((_now, dt) => {
    if (fly) { fly.t += (dt * 1000) / FLY_MS; if (fly.t >= 1) fly = undefined; readout(); }
    draw();
  }, () => !!fly);
  function repaint(): void { readout(); draw(); loop.kick(); }

  function doPulse(): void {
    const before = electrons(bank.q[bank.sel]);
    bank = program(bank);
    reading = false;
    const after = electrons(bank.q[bank.sel]);
    // Under reduced motion the electrons just appear.
    fly = reducedMotion() || after === before ? undefined : { cell: bank.sel, n0: before, n1: after, t: 0 };
    repaint();
  }

  const sel = Array.from({ length: CELLS }, (_, i) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-label': `Choose cell ${i + 1}`, 'aria-pressed': String(i === bank.sel) }, `Cell ${i + 1}`) as HTMLButtonElement;
    b.addEventListener('click', () => { fly = undefined; bank = { ...bank, sel: i }; sel.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i))); repaint(); });
    return b;
  });
  const pulseBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Program pulse');
  pulseBtn.addEventListener('click', doPulse);
  const eraseBtn = h('button', { type: 'button', class: 'btn sm' }, 'Erase block');
  eraseBtn.addEventListener('click', () => { fly = undefined; bank = erase(bank); reading = false; repaint(); });
  const readBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'true' }, 'Read string');
  readBtn.addEventListener('click', () => { fly = undefined; reading = !reading; readBtn.setAttribute('aria-pressed', String(reading)); repaint(); });
  // A pulse or an erase ends a read, so the toggle follows.
  const sync = () => readBtn.setAttribute('aria-pressed', String(reading));
  for (const b of [pulseBtn, eraseBtn, ...sel]) b.addEventListener('click', sync);

  const ctl = h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Chosen cell' }, ...sel), h('div', { class: 'r3-btns' }, pulseBtn, eraseBtn, readBtn, stage.resetBtn));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The cell itself'),
    h('p', { class: 'm3-sub' }, `Four cells in series on one strip. The control gate on top has a wire to its word line; the floating gate under it has none, only oxide on every side. A program pulse adds ${FG_STEP} of charge (electrons tunnel up from the channel) and raises Vt by ${(5 * FG_STEP).toFixed(1)} V. A read puts ${V_READ} V on the chosen control gate and ${PASS_V} V, above every threshold a pulse train can reach, on the others, so the string conducts only if the chosen cell does.`),
    h('div', { class: 'r3' }, h('div', { class: 'r3-main' }, ctl, stage.el, stage.hint, note), h('div', { class: 'r3-side' }, h('h4', null, 'This string ', h('span', { class: 'r3-badge' }, 'model')), kv)));

  readout();
  draw();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
