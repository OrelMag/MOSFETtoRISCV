// "Three regions": the output characteristics large, with the linear and saturation regions shaded and
// the pinch-off boundary, a drain sweep, and a close-up of the channel under the same two voltages.

import { h } from '../ui/dom';
import '../styles/watertoggle.css';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop, volts } from './mosfet';
import { VDD } from './mosphys';
import { chips, idVdsChart, slider } from './mosparts';
import { crossSection } from './mosxsec';
import { fetWater, fetWords } from './water';
import type { WaterMount } from './waterkit';

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

  // Cross-section | Water: the channel as silicon, or as a faucet (3D, loaded on first use) on the same two voltages.
  let view: 'xs' | 'water' = 'xs', water: WaterMount | null = null, dead = false;
  const xsBtn = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => setView('xs') }, 'Cross-section');
  const waterBtn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setView('water') }, 'Water');
  const seg = h('div', { class: 'wt-seg', role: 'group', 'aria-label': 'How to draw the channel' }, xsBtn, waterBtn);
  const host = h('div', { class: 'wt-host' });
  const words = h('p', { class: 'wt-cap', 'aria-live': 'polite' });
  const waterBox = h('div', null, host, words);
  waterBox.style.display = 'none';
  function setView(v: 'xs' | 'water'): void {
    view = v;
    xsBtn.setAttribute('aria-pressed', String(v === 'xs'));
    waterBtn.setAttribute('aria-pressed', String(v === 'water'));
    xs.el.style.display = v === 'xs' ? '' : 'none';
    waterBox.style.display = v === 'water' ? '' : 'none';
    if (v === 'water' && !water && !host.firstChild) {
      host.style.minHeight = '260px';
      host.textContent = 'Loading the water view…';
      import('./waterscenes')
        .then((m) => {
          if (dead) return;
          host.textContent = ''; host.style.minHeight = '';
          water = m.mountFet(host, () => ({ vg, vd }));
        })
        .catch((e: unknown) => { if (!dead) host.textContent = `The water view did not load (${String(e)}).`; });
    }
    repaint();
  }

  function paint(dt: number): void {
    chart.paint(vg, vd, false);
    readout.paint(vg, vd, false);
    if (view === 'xs') flowing = xs.paint('n', vg, vd, dt);
    else { flowing = false; words.textContent = fetWords(fetWater(vg, vd)); water?.kick(); }
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
    h('div', { class: 'panel mos-xpanel' }, h('h3', null, 'The channel, close up'), seg, xs.el, waterBox));

  syncSweep();
  repaint();
  return { el, destroy() { dead = true; loop.stop(); water?.destroy(); water = null; } };
}
