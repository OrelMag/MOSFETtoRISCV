// The Jacquard head in 3D (loaded on demand, modelhost.ts). The card read at a pick, the hooks its holes leave on the knife,
// the threads they lift and the cloth rows are loomWidget's own rule (cards.ts loomPick) on its presets; the motion between
// them is a drawing of the classical single-lift head (loom3dparts.ts).

import '../styles/loom3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import type { OrbitView } from '../gl/camera';
import { HOOKS, LOOM_PRESETS, PICKS, WARP, loomPick } from './cards';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { loomAnchors, loomParts, poseOf, steppedPose, type Cards, type LoomPalette } from './loom3dparts';

/** Seconds a pick takes, and a stepped run's seconds a pick when motion is reduced. */
const PICK_S = 6, STEP_S = 1.2;
const PHASES: [number, string][] = [
  [0, 'the cylinder presses the card on the needles'], [0.12, 'the griffe rises with the hooks still over its knife'],
  [0.35, 'the shuttle carries the weft through the shed'], [0.6, 'the reed beats the weft up to the fell'],
  [0.72, 'the griffe sinks and the shed closes'], [0.85, 'the cylinder withdraws'], [0.92, 'the cylinder turns to the next card'],
];
const VIEWS: Record<'head' | 'whole', OrbitView> = {
  head: { target: [0, 38, -8], yaw: 0.85, pitch: 0.25, dist: 165 },
  whole: { target: [0, 24, 8], yaw: 0.55, pitch: 0.38, dist: 205 },
};
const phaseOf = (T: number) => PHASES.filter(([a]) => T >= a).pop()![1];
const cardsOf = (k: string): Cards => LOOM_PRESETS[k].cards.map((r) => r.split('').map((c) => c === '1'));

export function loomView(): Widget {
  let whole = false;
  let cards = cardsOf('diamond');
  // done: picks completed; T: how far through pick done + 1; running: back to back; finishing: the current pick, then stop.
  let done = 0, T = 0, running = false, finishing = false, stepAcc = 0;

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A Jacquard head in 3D: a square cylinder carrying a chain of punched cards against sprung needles, vertical hooks over the griffe knife, harness cords with lingoes lifting warp threads, a shuttle, a reed and the cloth',
    camera: { ...VIEWS.head },
    limits: { minDist: 90, maxDist: 600 },
    note: `The widget’s ${HOOKS} hooks and ${WARP} threads are drawn; a real head had hundreds of hooks (Posselt, 1888, gives 100, 200, 400, 600, 900 and 1200 as the sizes most often used), a griffe of many knives and a harness of thousands of cords. Cards are drawn some ten times thicker than pasteboard, the prism, needles and hooks are scaled up for visibility, and the shed is much taller against the thread pitch than on a loom. The chain hangs in a curtain, and a chain shorter than four cards is drawn repeated on the cylinder’s faces.`,
    draw: () => paint(),
  });
  const palette = (): LoomPalette => ({
    wood: stage.rgb('--lm-wood'), iron: stage.rgb('--lm-iron'), steel: stage.rgb('--lm-steel'), spring: stage.rgb('--lm-spring'), card: stage.rgb('--lm-card'),
    hole: stage.rgb('--lm-hole'), warp: stage.rgb('--lm-warp'), weft: stage.rgb('--lm-weft'), cord: stage.rgb('--lm-cord'), lead: stage.rgb('--lm-lead'),
    brass: stage.rgb('--lm-brass'), live: stage.rgb('--m3-charge'),
  });
  const pose = () => (reducedMotion() ? steppedPose(cards, done) : poseOf(cards, done + 1, T));
  function paint(): void { const o = pose(); stage.paint(loomParts(cards, o, palette()), loomAnchors(cards, o, whole)); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Weave one pick') as HTMLButtonElement;
  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;

  function readout(announce = false): void {
    const inPick = !reducedMotion() && T > 0, shown = inPick ? done + 1 : done; // the pick the readout describes
    const r = shown > 0 ? loomPick(cards, shown) : null;
    const hooks = r ? r.hooks.map((j) => j + 1).join(', ') || 'none' : '–';
    chip.textContent = !r ? 'Nothing woven' : inPick ? phaseOf(T) : `Pick ${shown} woven`;
    chip.className = `r3-chip ${inPick ? 'warn' : r ? 'good' : ''}`;
    kv.replaceChildren(...([
      ['Picks woven', String(done)],
      ['Card on the needles', r ? `${r.card + 1} of ${cards.length}${shown > cards.length ? ' (the chain has looped)' : ''}` : '–'],
      ['Hooks over the knife', r ? `${hooks} of ${HOOKS}` : '–'],
      ['Threads lifted', r ? `${r.threads.filter(Boolean).length} of ${WARP}` : '–'],
    ] as [string, string][]).flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = !r ? 'Nothing woven yet.'
      : `${inPick ? `Pick ${shown}: ${phaseOf(T)}.` : `Pick ${shown} woven.`} Card ${r.card + 1} of ${cards.length}; hooks ${hooks} stay over the knife and lift ${r.threads.filter(Boolean).length} of ${WARP} threads.${shown > PICKS ? ` Beyond ${PICKS} rows the oldest wind onto the cloth beam.` : ''}`;
    if (live.textContent !== text) live.textContent = text;
  }

  const loop = frameLoop((_now, dt) => {
    if (reducedMotion()) {
      // No motion: a run steps a pick every STEP_S seconds.
      if (running) { stepAcc += dt; if (stepAcc >= STEP_S) { stepAcc = 0; done++; } }
    } else if (running || finishing) {
      T += dt / PICK_S;
      if (T >= 1) {
        T = 0; done++;
        if (!running) { finishing = false; readout(true); }
      }
    }
    readout(); paint();
  }, () => running || finishing);
  const kick = () => { readout(); paint(); loop.kick(); };

  stepBtn.addEventListener('click', () => {
    if (reducedMotion()) { running = false; done++; readout(true); kick(); return; }
    running = false; finishing = true; kick();
  });
  runBtn.addEventListener('click', () => {
    running = !running; finishing = false; stepAcc = 0;
    if (!running) readout(true);
    kick();
  });
  const viewBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Whole loom') as HTMLButtonElement;
  viewBtn.addEventListener('click', () => {
    whole = !whole;
    viewBtn.setAttribute('aria-pressed', String(whole));
    viewBtn.textContent = whole ? 'Head close-up' : 'Whole loom';
    stage.setView({ ...VIEWS[whole ? 'whole' : 'head'] }); paint();
  });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset');
  const restart = () => { running = false; finishing = false; done = 0; T = 0; stepAcc = 0; readout(true); kick(); };
  resetBtn.addEventListener('click', restart);
  const presets = h('select', { 'aria-label': 'Pattern' }, ...Object.entries(LOOM_PRESETS).map(([k, p]) => h('option', { value: k }, p.name))) as HTMLSelectElement;
  presets.addEventListener('change', () => { cards = cardsOf(presets.value); restart(); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The head of a Jacquard loom'),
    h('p', { class: 'm3-sub' }, `The same chain, hooks and harness as the loom above (${HOOKS} hooks, ${WARP} threads; hook j lifts every ${HOOKS}th thread from j). The cylinder, a square prism, presses a card on the sprung needles. A solid place pushes its needle and hook back off the knife of the griffe; a hole lets the needle in, and its hook stays over the knife. The griffe rises with the hooks still on it, their cords lift the threads through the comber board (lingoes pull the others down), the shuttle crosses the shed, the reed beats the weft up and the cloth takes up a row. Then the cylinder turns a quarter to the next card; the chain loops.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, presets, stepBtn, runBtn, resetBtn, viewBtn, stage.resetBtn)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This head ', h('span', { class: 'r3-badge' }, 'the loom’s chain')), kv)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (running || finishing)) { running = false; finishing = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
