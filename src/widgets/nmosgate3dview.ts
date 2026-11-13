// A 6502-style NMOS NOR in 3D on the studio renderer (loaded on demand, modelhost.ts; drawn by nmosgate3dkit.ts). Under
// Appendix A's transistor ledger: what one of the ledger's gates is on silicon.

import '../styles/nmosgate3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { studioStage } from './studiostage';
import { LAMBDA, NG_HOME, RATIO, V, nmosGateModel, stateOf, wl, zOf } from './nmosgate3dkit';
import { NNOR2 } from '../lib/nmos';

/** Each tour beat's inputs a, b. */
const BEAT_INPUTS: [boolean, boolean][] = [[false, false], [true, false], [false, false], [true, false], [true, true]];

export function nmosGateView(): Widget {
  let a = false, b = false, ready = false;
  const panel = h('div', { class: 'panel ng3' });
  const stage = studioStage({
    home: NG_HOME,
    fit: false,
    aspect: 1.45,
    scaleBar: (len) => `${len} µm`,
    limits: { minDist: 60, maxDist: 700, maxPan: 120 },
    onBeat: (i) => { if (i < 0) return; [a, b] = BEAT_INPUTS[i]; if (ready) sync(); },
    build: () => nmosGateModel(a, b),
    aria: 'A two-input NMOS NOR gate in 3D: two pull-down transistors in parallel from the output to ground, a depletion load above them to VDD, in diffusion, polysilicon and aluminium',
    note: `In micrometres, heights × ${V}. Original geometry, not traced from any chip: a textbook layout to Mead and Conway’s λ rules (Introduction to VLSI Systems, 1980) at λ = ${LAMBDA} µm, an 8 µm gate like the 6502’s 1975 process, so “6502-style”. The circuit is the appendix’s NMOS NOR (ld, n0, n1) and the output is its own rule. Layer thicknesses are typical of the time and illustrative; the glass between the poly and the aluminium is left out so the layers show.`,
  });
  ready = true;

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip);
  const inBtn = (name: string, get: () => boolean, set: (v: boolean) => void) => {
    const btn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }) as HTMLButtonElement;
    btn.addEventListener('click', () => { set(!get()); sync(); });
    return { btn, show: () => { btn.textContent = `${name} = ${get() ? 1 : 0}`; btn.setAttribute('aria-pressed', String(get())); } };
  };
  const ia = inBtn('a', () => a, (v) => { a = v; }), ib = inBtn('b', () => b, (v) => { b = v; });
  const um = (n: 'n0' | 'ld') => `${wl(n).W * LAMBDA} × ${wl(n).L * LAMBDA} µm (W × L), Z = ${zOf(n)}`;
  function sync(): void {
    const s = stateOf(a, b), y = NNOR2.spec!([a ? 1 : 0, b ? 1 : 0])[0];
    ia.show(); ib.show();
    chip.textContent = `y = ${y} · ${s.current ? 'current VDD → GND' : 'no current'}`;
    chip.className = `r3-chip ${s.current ? 'warn' : 'good'}`;
    kv.replaceChildren(...([
      ['Transistors', '3 (a CMOS NOR: 4)'],
      ['Pull-downs', um('n0')],
      ['Load', um('ld')],
      ['Load / pull-down', `${RATIO} times weaker (the rule: at least 4)`],
      ['Output y', `${y}${s.current ? ', while current flows through the load and the pull-down that is on' : ', the load holds it up; nothing flows'}`],
    ] as [string, string][]).flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    stage.refresh();
  }

  panel.append(
    h('h3', { class: 'm3-title' }, 'One of those gates, on silicon'),
    h('p', { class: 'm3-sub' }, 'A 6502-style NOR: two pull-downs and a depletion load in diffusion, polysilicon and aluminium. Set the inputs and watch which channels carry current.'),
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, ia.btn, ib.btn)),
    stage.el,
    h('div', { class: 'r3' }, h('div', { class: 'r3-side' }, h('h4', null, 'This gate ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  sync();
  return { el: panel, destroy() { stage.destroy(); } };
}
