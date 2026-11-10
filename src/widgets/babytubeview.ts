// Appendix E's tube line at switch level (lib/babytube.ts williamsTube): the scene and its Charge panel. Each clock is
// one beat and one beat of leakage (SwitchSim.leak(1)); Wait lets beats pass with the scanner stopped, so the charge
// falls without a rewrite. The bars are each spot's level, a fraction of the full charge; under the reference the
// pick-up reads a dot.

import '../styles/baby.css';
import { SPOT_HALFLIFE, williamsTube } from '../lib/babytube';
import { SwitchSim } from '../sim/switchsim';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

/** The line in the scene: 2^K spots. */
export const TUBE_K = 3;

export function tubeLineScene(o: { highlight?: string[] } = {}): Scene {
  return {
    root: williamsTube(TUBE_K), clock: 'clk', inputs: { rst_n: 1, wr: 0, wa: 0, d: 1 }, autoClock: false,
    highlight: o.highlight, panels: [tubePanel()], memory: false,
  };
}

function tubePanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const sw = () => (stage.sim instanceof SwitchSim ? stage.sim : null);
    let waited = 0;
    stage.edgeHooks.add({ after: () => { const s = sw(); if (s && !stage.inEdge) s.leak(1); } });
    stage.resetHooks.add(() => { waited = 0; paint(); });
    const spots = () => {
      const s = sw();
      return s ? [...(s.design.leaks?.keys() ?? [])].sort((a, b) => a - b) : [];
    };
    const bars = h('div', { class: 'bb-spots' });
    const note = h('div', { class: 'bb-note', 'aria-live': 'polite' });
    const paint = () => {
      const s = sw();
      if (!s) return;
      bars.replaceChildren(...spots().map((n, i) => {
        const v = s.level(n), lvl = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
        return h('div', { class: `bb-spot${lvl >= 0.5 ? ' dash' : ''}`, title: `spot ${i}: ${(100 * lvl).toFixed(0)} % charge` },
          h('span', { style: `height:${(100 * lvl).toFixed(0)}%` }), h('b', null, String(i)));
      }));
      note.textContent = waited ? `${waited} beats waited with the scanner stopped (half-life ${SPOT_HALFLIFE} beats).` : `Half-life ${SPOT_HALFLIFE} beats; the scanner visits every spot each ${4 * 2 ** TUBE_K} beats.`;
    };
    const wait = (n: number) => {
      const b = h('button', { class: 'btn sm', type: 'button' }, `Wait ${n}`);
      b.addEventListener('click', () => { const s = sw(); if (!s) return; stage.checkpoint(); s.leak(n); waited += n; stage.refresh(); paint(); });
      return b;
    };
    const el = h('div', { class: 'mem-panel bb-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'Charge ', h('span', { class: 'fold-hint' })),
      h('div', { class: 'bb-body' }, bars, h('div', { class: 'param-row' }, wait(100), wait(300), wait(700)), note));
    const boot = requestAnimationFrame(paint);
    return { el, update: paint, destroy: () => cancelAnimationFrame(boot) };
  };
}
