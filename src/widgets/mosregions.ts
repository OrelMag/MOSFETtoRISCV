// "Three regions": the output characteristics large, with the linear and saturation regions shaded and
// the pinch-off boundary, a drain sweep, and a close-up of the channel under the same two voltages.

import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop, volts } from './mosfet';
import { VDD } from './mosphys';
import { chips, idVdsChart, slider } from './mosparts';
import { crossSection } from './mosxsec';

const SWEEP_MS = 4000;

export function mosRegionsWidget(): Widget {
  let vg = 1.2, vd = 0.3, flowing = false;
  let sweepT0: number | null = null;
  const chart = idVdsChart(640, 300, true);
  const xs = crossSection('channel', 'The channel of an NMOS transistor, close up');
  const readout = chips();
  const gSl = slider('Gate', 0, VDD, 0.01, vg, volts, (v) => { vg = v; repaint(); });
  const dSl = slider('Drain', 0, VDD, 0.01, vd, volts, (v) => { stopSweep(); vd = v; repaint(); });
  const sweepBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => (sweepT0 === null ? startSweep() : stopSweep()) });
  const syncSweep = () => { sweepBtn.textContent = sweepT0 === null ? '▶ Sweep drain' : '■ Stop'; };
  const startSweep = () => { vd = 0; sweepT0 = performance.now(); syncSweep(); loop.kick(); };
  const stopSweep = () => { sweepT0 = null; syncSweep(); };

  function paint(dt: number): void {
    chart.paint(vg, vd, false);
    readout.paint(vg, vd, false);
    flowing = xs.paint('n', vg, vd, dt);
    dSl.set(vd);
  }
  const loop = frameLoop((now, dt) => {
    if (sweepT0 !== null) {
      const t = (now - sweepT0) / SWEEP_MS;
      vd = Math.min(VDD, VDD * t);
      if (t >= 1.15) stopSweep(); // hold at the end for a moment
    }
    paint(dt);
  }, () => sweepT0 !== null || (flowing && !reducedMotion()));
  function repaint(): void { paint(0); loop.kick(); }

  const el = h('div', { class: 'widget mos' },
    h('div', { class: 'panel' }, h('h3', null, 'Output characteristics: Id against Vds for five gate voltages'), chart.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, gSl.el, dSl.el, reducedMotion() ? null : sweepBtn)),
    readout.el,
    h('div', { class: 'panel mos-xpanel' }, h('h3', null, 'The channel, close up'), xs.el));

  syncSweep();
  repaint();
  return { el, destroy() { loop.stop(); } };
}
