// The floating gate in 3D on the studio renderer (fgate3dkit.ts; loaded on demand, modelhost.ts): a planar NAND string of
// four cells whose charge follows phys/fgate.ts, i.e. chapter flash's rule (lib/flash.ts, sim/switchsim.ts). The learner
// pulses program on a chosen cell, erases the block (the electrons leave down through the tunnel oxide into the well) and
// reads the string with the other cells at the pass voltage. The coupling-ratio slider shows what sets the voltage across
// the tunnel oxide and the size of the Vt window; the pass/fail rule itself is the chapter's. The model is rebuilt per
// frame only while electrons move (its layers are memoized, so a frame uploads the electrons alone).

import '../styles/fgate3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { V_READ, vtOf } from '../lib/flash';
import { FG_STEP } from '../sim/switchsim';
import { CELLS, E_FULL, PASS_V, PULSES_TO_PROGRAM, conducts, electrons, erase, program, readConduction, stringConducts, type Bank } from '../phys/fgate';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { FG_ASPECT, FG_HOME, FG_HOME_FRAME, fgModel } from './fgate3dkit';
import { FN_MV_CM, GCR_MODEL, T_TUNNEL_NM, V_PGM, toxField, toxVolts, windowOf, type FgPose } from './fgate3dparts';

/** A pulse's electrons take this long to cross the oxide; an erase's the same, going the other way. */
export const FLY_MS = 700;

export function fgateView(): Widget {
  // Opens on a cell that has taken two pulses, read: the string is blocked by it.
  let bank: Bank = { q: [0, 2 * FG_STEP, 0, 0], sel: 1 };
  let reading = true, fly: FgPose['fly'], leave: FgPose['erase'], gcr = GCR_MODEL;
  const panel = h('div', { class: 'panel fg3' });
  // How hard the tunnel oxide is driven while a pulse or an erase is on: 1 at 1.5 x the field FN tunnelling needs.
  const field = () => (fly || leave ? Math.min(1, toxField(gcr) / (1.5 * FN_MV_CM)) : 0);
  const pose = (): FgPose => ({ bank, reading, programming: !!fly, fly, erase: leave, field: field() });
  const stage = studioStage({
    aria: 'A planar NAND string of four floating-gate flash cells in 3D, cut open: each floating gate sits on a thin tunnel oxide, sealed in oxide, under a control gate that is the word line itself and wraps down its sides; select transistors, a bit line and a source line at the ends',
    home: FG_HOME, homeFrame: FG_HOME_FRAME, aspect: FG_ASPECT,
    knobs: { cut: 1 },
    limits: { minDist: 30, maxDist: 400 },
    note: `Scaled: the layers are drawn far thicker against the cell than real ones (tunnel oxide 8 nm, ONO about 15 nm equivalent oxide), the floating gate thinner than a real 50 to 100 nm one, and a cell holds ${E_FULL} electrons at full charge here where a real one holds thousands. The cross-section is planar NAND's wrapped cell (the control gate down both sides of the floating gate onto the trench oxide), drawn after Pavan et al., Proc. IEEE 85 (1997); real strings hold 32 to 64 cells, not four, and stacked 3D NAND replaces the floating gate with a charge-trap nitride round a vertical channel. The voltages are illustrative: a real NAND string has its erased cells below 0 V, reads at about 0 V and passes at 4.5 to 6 V; the model keeps the chapter's NOR-style 1 V erased threshold and 5 V window.`,
    build: (detail) => fgModel(pose(), detail),
  });
  const draw = () => stage.refresh();

  const chip = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' }), chip2 = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip, chip2);
  const note = h('p', { class: 'r3-hint' });

  function readout(): void {
    const s = bank.sel, q = bank.q[s], on = conducts(q, V_READ), str = stringConducts(bank);
    chip.textContent = leave ? `Erase: p-well at ${V_PGM} V, electrons tunnel out` : fly ? `Program pulse on cell ${s + 1}` : reading ? `Reading cell ${s + 1}: ${V_READ} V, the others ${PASS_V} V` : 'No voltage on the string';
    chip.className = `r3-chip ${fly || leave ? 'warn' : ''}`;
    chip2.textContent = reading ? (str ? 'String conducts: reads 1' : 'String blocked: reads 0') : '';
    chip2.className = `r3-chip ${reading ? (str ? 'good' : 'bad') : ''}`;
    chip2.hidden = !reading;
    const tv = toxVolts(gcr), tf = toxField(gcr);
    const rows: [string, string][] = [
      ['Chosen cell', String(s + 1)],
      ['Charge q', `${q.toFixed(1)} (${electrons(q)} of ${E_FULL} electrons drawn)`],
      ['Vt = 1 + 5q', `${vtOf(q).toFixed(1)} V (illustrative)`],
      ['At the read voltage', `${V_READ} V: ${on ? 'conducts' : 'stays off'}`],
      ['Others at the pass voltage', `${PASS_V} V: ${readConduction(bank).filter((_, i) => i !== s).every(Boolean) ? 'all conduct' : 'one is off'}`],
      ['Bit read', on ? '1 (erased side)' : '0 (programmed)'],
      ['Pulses to reach 0', `${PULSES_TO_PROGRAM} of ${FG_STEP} charge`],
      ['Coupling ratio GCR', `C_ONO / (C_ONO + C_tox) = ${gcr.toFixed(2)}`],
      [`Tunnel oxide at ${V_PGM} V`, `${tv.toFixed(1)} V over ${T_TUNNEL_NM} nm = ${tf.toFixed(0)} MV/cm: ${tf >= FN_MV_CM ? 'tunnels (Fowler-Nordheim)' : `under the ~${FN_MV_CM} needed`}`],
      ['Vt per full charge', `Q / C_ONO = ${windowOf(gcr).toFixed(1)} V (the model’s 5.0 V is GCR ${GCR_MODEL.toFixed(2)})`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    note.textContent = fly || leave ? '' : reading ? 'Only the chosen control gate is at the read voltage; the string decides by that one cell.' : 'Pulse program to push electrons through the oxide, or read the string.';
  }

  const loop = frameLoop((_now, dt) => {
    if (fly) { fly.t += (dt * 1000) / FLY_MS; if (fly.t >= 1) fly = undefined; readout(); }
    if (leave) { leave.t += (dt * 1000) / FLY_MS; if (leave.t >= 1) leave = undefined; readout(); }
    draw();
  }, () => !!fly || !!leave);
  function repaint(): void { readout(); draw(); loop.kick(); }

  function doPulse(): void {
    leave = undefined;
    const before = electrons(bank.q[bank.sel]);
    bank = program(bank);
    reading = false;
    const after = electrons(bank.q[bank.sel]);
    // Under reduced motion the electrons just appear.
    fly = reducedMotion() || after === before ? undefined : { cell: bank.sel, n0: before, n1: after, t: 0 };
    repaint();
  }
  function doErase(): void {
    fly = undefined;
    const from = bank.q.map(electrons);
    bank = erase(bank);
    reading = false;
    leave = reducedMotion() || from.every((n) => n === 0) ? undefined : { from, t: 0 };
    repaint();
  }

  const sel = Array.from({ length: CELLS }, (_, i) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-label': `Choose cell ${i + 1}`, 'aria-pressed': String(i === bank.sel) }, `Cell ${i + 1}`) as HTMLButtonElement;
    b.addEventListener('click', () => { fly = undefined; leave = undefined; bank = { ...bank, sel: i }; sel.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i))); repaint(); });
    return b;
  });
  const pulseBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Program pulse');
  pulseBtn.addEventListener('click', doPulse);
  const eraseBtn = h('button', { type: 'button', class: 'btn sm' }, 'Erase block');
  eraseBtn.addEventListener('click', doErase);
  const readBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'true' }, 'Read string');
  readBtn.addEventListener('click', () => { fly = undefined; leave = undefined; reading = !reading; readBtn.setAttribute('aria-pressed', String(reading)); repaint(); });
  // A pulse or an erase ends a read, so the toggle follows.
  const sync = () => readBtn.setAttribute('aria-pressed', String(reading));
  for (const b of [pulseBtn, eraseBtn, ...sel]) b.addEventListener('click', sync);

  const gcrIn = h('input', { type: 'range', min: 0.4, max: 0.8, step: 0.05, value: gcr, 'aria-label': 'Coupling ratio' }) as HTMLInputElement;
  const gcrOut = h('output', null, gcr.toFixed(2));
  gcrIn.addEventListener('input', () => { gcr = Number(gcrIn.value); gcrOut.textContent = gcr.toFixed(2); repaint(); });
  const gcrSl = h('label', { class: 'r3-sl' }, h('span', null, 'GCR'), gcrIn, gcrOut);

  stage.slot.append(h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Chosen cell' }, ...sel), h('div', { class: 'r3-btns' }, pulseBtn, eraseBtn, readBtn), gcrSl));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The cell itself'),
    h('p', { class: 'm3-sub' }, `Four cells in series on one strip between two select transistors, a bit line at one end and the source line at the other. Across the strip, the control gate is the word line itself: it runs over the floating gate and dips down both its sides onto the trench oxide, with the thicker ONO layer (oxide, nitride, oxide) between them. The floating gate has no wire, only oxide on every side. A program pulse puts ${V_PGM} V on the control gate; the floating gate takes the fraction GCR of it, and that voltage across the thin tunnel oxide pulls electrons up from the channel: ${FG_STEP} of charge a pulse, raising Vt by ${(5 * FG_STEP).toFixed(1)} V. An erase puts ${V_PGM} V on the well and they leave the same way. A read puts ${V_READ} V on the chosen control gate and ${PASS_V} V, above every threshold a pulse train can reach, on the others, so the string conducts only if the chosen cell does.`),
    h('div', { class: 'r3' }, h('div', { class: 'r3-main' }, stage.el, note), h('div', { class: 'r3-side' }, h('h4', null, 'This string ', h('span', { class: 'r3-badge' }, 'model')), kv)));

  readout();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
