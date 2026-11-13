// Planar, fin and nanosheet transistors in 3D on the studio renderer (loaded on demand, modelhost.ts; drawn by finfet3dkit.ts,
// the numbers from phys/gatecontrol.ts). Under chapter silicon's "The real thing": the transistors the layouts there are
// really made of, cut across the gate.

import '../styles/finfet3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { studioStage } from './studiostage';
import { COMPARE_VIEW, FF_HOME, finfetModel } from './finfet3dkit';
import { DEVICES, EOT_NM, IDEAL_SWING, SIDES, offRatio, swing, weff, weffDensity, type GateKind } from '../phys/gatecontrol';

type Kind = GateKind | 'all';
const KINDS: [Kind, string][] = [['planar', 'Planar'], ['fin', 'Fin'], ['sheets', 'Nanosheets'], ['all', 'All three']];
/** Each tour beat's device and gate state. */
const BEAT_STATE: [Kind, boolean][] = [['planar', true], ['fin', true], ['fin', false], ['sheets', true], ['sheets', false], ['all', false]];

export function finfetView(): Widget {
  let kind: Kind = 'fin', on = false, ready = false;
  const panel = h('div', { class: 'panel ff3' });
  const stage = studioStage({
    home: FF_HOME,
    fit: false,
    aspect: 1.5,
    knobs: { cut: 1 },
    scaleBar: (len) => `${len} nm`,
    limits: { minDist: 40, maxDist: 600, maxPan: 120 },
    onBeat: (i) => { if (i < 0) return; [kind, on] = BEAT_STATE[i]; if (ready) sync(); },
    build: () => finfetModel(kind, on),
    aria: 'Three transistors in 3D, cut across the gate: a planar one with its gate on top, a fin wrapped on three sides, and three stacked nanosheets wrapped on all four',
    note: `In nanometres. The fin is Intel’s 22 nm tri-gate fin (8 nm wide, 34 nm tall, 60 nm pitch; Auth et al., VLSI 2012); the sheets are IBM’s 2 nm test chip (three sheets 5 nm thick and 40 nm wide, 5 nm apart, a 12 nm gate; IBM Research 2021, as reported). The planar device is drawn on the sheets’ footprint, and the gate dielectric (about ${EOT_NM} nm equivalent oxide), the metal gate’s height and the source and drain lengths are illustrative. The glow is the model’s: the swing comes from the natural length of a gate on 1, 3 or 4 sides at the same 12 nm gate length (Colinge’s textbook estimate), a deliberately simple model that gets the direction and size of the effect, not a real device; the off glow is the off current against the planar device’s on a log scale.`,
  });
  ready = true;

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chip);
  const kindBtns = KINDS.map(([k, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': 'false' }, label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      // between one device and all three the frame changes size: go to the other one's view
      const view = (k === 'all') !== (kind === 'all') ? (k === 'all' ? COMPARE_VIEW : FF_HOME) : null;
      kind = k; sync();
      if (view) stage.goTo(view);
    });
    return b;
  });
  const onBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Gate on') as HTMLButtonElement;
  onBtn.addEventListener('click', () => { on = !on; sync(); });
  const offText = (k: GateKind) => k === 'planar' ? '1 (the reference)' : `1 / ${Math.round(1 / offRatio(DEVICES[k], DEVICES.planar)).toLocaleString('en-US')} of planar`;
  function sync(): void {
    kindBtns.forEach((b, i) => { const k = KINDS[i][0] === kind; b.classList.toggle('on', k); b.setAttribute('aria-pressed', String(k)); });
    onBtn.textContent = on ? 'Gate on' : 'Gate off'; onBtn.setAttribute('aria-pressed', String(on));
    chip.className = `r3-chip ${on ? 'good' : 'warn'}`;
    if (kind === 'all') {
      chip.textContent = `1, 3 and 4 sides gated · ${on ? 'on' : 'off'}`;
      kv.replaceChildren(...(['planar', 'fin', 'sheets'] as const).flatMap((k) => [h('span', null, `${KINDS.find((x) => x[0] === k)![1]}: off current`), h('span', { class: 'v' }, `${offText(k)}, ${swing(DEVICES[k]).toFixed(0)} mV / decade`)]));
      stage.refresh();
      return;
    }
    const d = DEVICES[kind];
    chip.textContent = `${SIDES[kind]} side${SIDES[kind] > 1 ? 's' : ''} gated · ${on ? 'on' : 'off'}`;
    kv.replaceChildren(...([
      ['Gate holds', `${SIDES[kind]} side${SIDES[kind] > 1 ? 's' : ''} of the channel`],
      ['Width that conducts', `${weff(d)} nm (${weffDensity(d).toFixed(2)} per nm of footprint)`],
      ['Swing at a 12 nm gate', `${swing(d).toFixed(0)} mV / decade (limit ${IDEAL_SWING.toFixed(0)})`],
      ['Off current, 0.3 V threshold', offText(kind)],
    ] as [string, string][]).flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    stage.refresh();
  }

  panel.append(
    h('h3', { class: 'm3-title' }, 'The transistors it is really made of'),
    h('p', { class: 'm3-sub' }, 'The layouts above are sky130’s, a 130 nm process of planar transistors. Since 22 nm the fastest chips are built of fins, and now of stacked sheets. Cut across the gate, the difference is one thing: how many sides of the channel the gate holds. The more it holds, the better it turns the channel off at a short gate, and the more width of silicon conducts in the same footprint.'),
    h('div', { class: 'r3-ctl' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Device' }, ...kindBtns), h('div', { class: 'r3-btns' }, onBtn)),
    stage.el,
    h('div', { class: 'r3' }, h('div', { class: 'r3-side' }, h('h4', null, 'This device ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  sync();
  return { el: panel, destroy() { stage.destroy(); } };
}
