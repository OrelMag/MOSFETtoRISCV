// The memory hierarchy as distances, in 3D (loaded on demand, modelhost.ts). Latencies are widgets/hierarchy3ddata.ts's,
// the table above's. The flight is a drawing's time: the courier takes a second or a few however long the access really
// takes; the elapsed time it shows is the level's latency read off the log scale at the courier's distance.

import '../styles/hierarchy3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import type { OrbitView } from '../gl/camera';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { CORE_GHZ, LEVELS } from './hierarchy3ddata';
import {
  asSeconds, placeOf, cyclesOf, flightSeconds, fmtNs, followView, hierarchyAnchors, hierarchyParts, levelX, overview, timeAt, SCALE,
  type HPalette, type HPose, type Phase,
} from './hierarchy3dparts';

const mix = (a: OrbitView, b: OrbitView, t: number): OrbitView => ({
  target: [0, 1, 2].map((i) => a.target[i] + (b.target[i] - a.target[i]) * t) as OrbitView['target'],
  yaw: a.yaw + (b.yaw - a.yaw) * t, pitch: a.pitch + (b.pitch - a.pitch) * t, dist: a.dist * (b.dist / a.dist) ** t,
});
const ease = (t: number) => t * t * (3 - 2 * t);

export function hierarchyView(): Widget {
  let x = 0, phase: Phase = 'idle', target: number | null = null, cam = 0, camGoal = 0, arrived = false;
  const narrow = () => panel.clientWidth > 0 && panel.clientWidth < 560;

  const panel = h('div', { class: 'panel hy3d' });
  const stage = modelStage(panel, {
    aria: 'The memory hierarchy as distances in 3D: a core, then along a road a desk, a shelf, a library, a warehouse across town and another city, each at a distance that is its latency on a log scale, and a courier that fetches data from the level you pick',
    camera: overview(false),
    limits: { minDist: 25, maxDist: 500 },
    note: 'Distance is the latency on a log scale (20 units per factor of ten), not a straight one: on a straight scale the SSD would be 80 000 times as far as L1. The flight is a drawing: it takes a second or a few, not the access’s real time. Block sizes are not capacities. L1 and L2 follow the Golden Cove / Willow Cove measurements and the SSD a NAND page read, so they are orders of magnitude that vary by product.',
    draw: () => paint(),
  });
  const palette = (): HPalette => ({
    ground: stage.rgb('--hy-ground'), road: stage.rgb('--hy-road'), tick: stage.rgb('--hy-tick'), wood: stage.rgb('--hy-wood'), shelf: stage.rgb('--hy-shelf'),
    wall: stage.rgb('--hy-wall'), roof: stage.rgb('--hy-roof'), door: stage.rgb('--hy-door'), core: stage.rgb('--hy-core'), metal: stage.rgb('--m3-metal'),
    mark: stage.rgb('--hy-mark'), live: stage.rgb('--m3-charge'), courier: stage.rgb('--hy-courier'),
  });
  const pose = (): HPose => ({ x, phase, target });
  const home = () => overview(narrow());
  function applyCamera(): void {
    if (stage.isFlat()) return; // one fixed view
    stage.setView(cam <= 0 ? home() : mix(home(), followView(x), ease(cam)));
  }
  /** A label whose box would cross the canvas edge is hidden, not cut. */
  function keepLabelsIn(): void {
    const box = stage.el.getBoundingClientRect();
    for (const l of stage.el.querySelectorAll<HTMLElement>('.r3-lbl')) {
      const r = (l.querySelector('b') ?? l).getBoundingClientRect();
      l.style.visibility = r.width > 0 && (r.left < box.left + 2 || r.right > box.right - 2 || r.top < box.top + 2 || r.bottom > box.bottom - 2) ? 'hidden' : '';
    }
  }
  function paint(): void {
    stage.paint(hierarchyParts(pose(), palette()), hierarchyAnchors());
    requestAnimationFrame(keepLabelsIn); // after the renderer has placed them
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);

  function readout(): void {
    const lv = target === null ? null : LEVELS[target];
    const done = !!lv && phase === 'idle', elapsed = !lv ? 0 : done || arrived || phase === 'back' ? lv.ns : x > 0 ? timeAt(x) : 0;
    chip.textContent = !lv ? 'At the core: pick a level' : arrived ? `${lv.name}: ${fmtNs(lv.ns)}` : done ? `Back at the core: ${fmtNs(lv.ns)}` : phase === 'back' ? `Back with the data: ${fmtNs(lv.ns)}` : `On the way to ${lv.name}: ${fmtNs(elapsed)}`;
    chip.className = `r3-chip ${arrived || done || phase === 'back' ? 'good' : lv ? 'warn' : ''}`;
    const rows: [string, string][] = lv ? [
      ['Hit in', lv.name],
      ['Place', lv.place === 'core' ? 'In the core' : placeOf(lv).label],
      ['Latency', `${fmtNs(lv.ns)} = ${cyclesOf(lv.ns).toLocaleString('en-US')} cycles at ${CORE_GHZ} GHz`],
      ['Distance', `${levelX(lv).toFixed(1)} units`],
      ['Elapsed', fmtNs(elapsed)],
      ['If a cycle were a second', asSeconds(cyclesOf(lv.ns))],
      ['A real one', lv.real],
    ] : [
      ['Scale', `log: ${SCALE} units per ×10 in time, from 0.1 ns`],
      ['Nearest', `Registers: ${fmtNs(LEVELS[0].ns)}, ${levelX(LEVELS[0]).toFixed(0)} units out`],
      ['Farthest', `${LEVELS[5].name}: ${fmtNs(LEVELS[5].ns)}, ${levelX(LEVELS[5]).toFixed(0)} units out`],
      ['Ratio', `${Math.round(LEVELS[5].ns / LEVELS[1].ns).toLocaleString('en-US')} × from L1 to the SSD`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    LEVELS.forEach((_, k) => btns[k].setAttribute('aria-pressed', String(target === k)));
  }
  function announce(): void {
    const lv = target === null ? null : LEVELS[target];
    live.textContent = !lv ? '' : arrived ? `Data from ${lv.name}, ${lv.place === 'core' ? 'in the core' : placeOf(lv).label.toLowerCase()}: ${fmtNs(lv.ns)}.` : phase === 'idle' ? `Back at the core with data from ${lv.name} after ${fmtNs(lv.ns)}.` : '';
  }

  // The courier: out to the level's distance and back, the camera following.
  let t = 0, dur = 1;
  const loop = frameLoop((_now, dt) => {
    if (phase !== 'idle') {
      t += dt;
      const X = levelX(LEVELS[target!]);
      if (phase === 'out') { x = Math.min(X, X * (t / dur)); if (t >= dur) { phase = 'back'; t = 0; x = X; } }
      else { x = Math.max(0, X * (1 - t / dur)); if (t >= dur) { phase = 'idle'; x = 0; camGoal = 0; announce(); } }
    }
    const step = dt / 0.7;
    cam = cam < camGoal ? Math.min(camGoal, cam + step) : Math.max(camGoal, cam - step);
    applyCamera(); readout(); paint();
  }, () => phase !== 'idle' || cam !== camGoal);

  function go(k: number): void {
    target = k; const X = levelX(LEVELS[k]);
    if (reducedMotion()) { // jump cuts: the courier is at the level, the camera beside it
      phase = 'idle'; arrived = true; x = X; cam = camGoal = 1; applyCamera(); readout(); paint(); announce(); return;
    }
    arrived = false; phase = 'out'; t = 0; dur = flightSeconds(X); x = 0; camGoal = 1;
    live.textContent = '';
    readout(); loop.kick();
  }
  function toOverview(): void {
    phase = 'idle'; arrived = false; target = null; x = 0; camGoal = 0;
    if (reducedMotion()) cam = 0;
    live.textContent = '';
    applyCamera(); readout(); paint(); loop.kick();
  }

  const btns = LEVELS.map((lv, k) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: `Fetch from ${lv.name}: ${fmtNs(lv.ns)}` }, lv.name) as HTMLButtonElement;
    b.addEventListener('click', () => go(k));
    return b;
  });
  stage.resetBtn.addEventListener('click', toOverview);

  panel.append(
    h('h3', { class: 'm3-title' }, 'The same ladder as distances'),
    h('p', { class: 'm3-sub' }, 'The registers are in the core itself. What you use now is on the desk (L1), this week’s work on a shelf (L2), the department’s in the library (L3), and everything else in a warehouse across town (DRAM); the SSD is another city. Each place sits as far from the core as its latency, on a log scale with the table’s own figures. Pick the level where the data is and a courier goes out to it and comes back with the time on the clock; the camera follows.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'hy-btns', role: 'group', 'aria-label': 'Where the data is' }, h('span', { class: 'hy-lbl' }, 'Hit in'), ...btns, stage.resetBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This access ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
