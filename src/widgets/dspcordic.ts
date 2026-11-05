// "Turning by shifting"'s explorers: a rotation stage by stage, the same stages run backwards, what the word lengths buy, and the pipeline in gates. Every number is dsp/cordic.ts's.

import { signedOf, wordOf } from '../comm/signals';
import { CordicPipe, cordicBound, cordicError, cordicPath, cordicStart, cordicStretch, type CordicSpec } from '../dsp/cordic';
import { cordicPipeline } from '../lib/cordic';
import { lookupRom } from '../lib/modem';
import { stats } from '../sim/stats';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const ONE = 2 ** 14;
const VIEW: CordicSpec = { w: 18, z: 16, n: 14 };

/** Plots run from 0 on x, so a plane centred on the origin is drawn shifted by this much, and its ticks labelled back. */
const RX = 2;
/** A circle has to look like one, so this plot keeps its own width rather than the panel's. */
const squarePlot = (aria: string) => { const p = plotOf({ W: 340, H: 340, x: [0, 2 * RX], y: [-RX, RX], yTicks: [-2, -1, 0, 1, 2], xLabel: 'x', yLabel: 'y', aria, xFmt: (v) => num(v - RX, 0) }); p.el.style.maxWidth = '380px'; return p; };

/** The unit circle, the axes, and a path of vectors from the origin, the last one bold. */
function drawPath(p: ReturnType<typeof plotOf>, pts: { x: number; y: number }[]) {
  p.clear();
  const c = range(129).map((i) => (2 * Math.PI * i) / 128);
  line(p, c.map((t) => Math.cos(t) + RX), c.map(Math.sin), 'ln-s lump');
  pts.forEach((q, i) => {
    const last = i === pts.length - 1;
    p.layer.append(s('line', { x1: p.X(RX), y1: p.Y(0), x2: p.X(q.x + RX), y2: p.Y(q.y), class: `sg-stem${last ? ' out' : ''}`, 'stroke-opacity': last ? 1 : 0.35 }));
  });
}

// ---- a rotation, stage by stage -----------------------------------------------------------------------------------------------------

export function rotateWidget(): Widget {
  let deg = 37, k = 4, fromK = true;
  const plot = squarePlot('A vector being turned toward an angle, one stage at a time, on the unit circle');
  const chips = mkChips(4);
  const paint = () => {
    const z = Math.round((deg / 360) * 2 ** VIEW.z);
    const start = fromK ? cordicStart(VIEW, ONE) : ONE;
    const whole = cordicPath({ x: start, y: 0, z }, VIEW, 'rotate'), path = whole.slice(0, k + 1 + whole.length - (VIEW.n + 1)); // a half-turn is one point more, and no stage
    drawPath(plot, path.map((v) => ({ x: v.x / ONE, y: v.y / ONE })));
    const end = path[path.length - 1], left = (end.z / 2 ** VIEW.z) * 360;
    chips.set(0, `${num(left, 3)}°`, 'of the angle left');
    chips.set(1, num(Math.hypot(end.x, end.y) / ONE, 4), 'length now');
    chips.set(2, num(end.x / ONE, 4), `x, against cos ${deg}° = ${num(Math.cos((deg * Math.PI) / 180), 4)}`);
    chips.set(3, num(end.y / ONE, 4), `y, against sin ${deg}° = ${num(Math.sin((deg * Math.PI) / 180), 4)}`);
  };
  const sa = slider('Angle', -180, 180, 1, deg, (v) => `${v}°`, (v) => { deg = v; paint(); });
  const sk = slider('Stages run', 0, VIEW.n, 1, k, (v) => String(v), (v) => { k = v; paint(); });
  const start = h('label', { class: 'cd-check' }, h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => { fromK = (e.target as HTMLInputElement).checked; paint(); } }), ' Start from 0.6073, not 1');
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Turning toward an angle'), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, sa.el, sk.el, start)) };
}

// ---- backwards: arctangent and magnitude ---------------------------------------------------------------------------------------------

export function vectorWidget(): Widget {
  let px = -0.5, py = 0.45;
  const plot = squarePlot('A vector being turned onto the x axis, with its angle added up on the way');
  const chips = mkChips(4);
  const paint = () => {
    const x = Math.round(px * ONE), y = Math.round(py * ONE), path = cordicPath({ x, y, z: 0 }, VIEW, 'vector'), end = path[path.length - 1];
    drawPath(plot, path.map((v) => ({ x: v.x / ONE, y: v.y / ONE })));
    const stretch = cordicStretch(VIEW.n), angle = ((end.z / 2 ** VIEW.z) * 360 + 540) % 360 - 180;
    chips.set(0, `${num(angle, 2)}°`, 'the angle z added up');
    chips.set(1, `${num((Math.atan2(y, x) * 180) / Math.PI, 2)}°`, 'atan2, for comparison');
    chips.set(2, num(end.x / stretch / ONE, 4), 'x at the end ÷ the stretch');
    chips.set(3, num(Math.hypot(px, py), 4), 'its length, by Math.hypot');
  };
  const sx = slider('x', -1, 1, 0.01, px, (v) => num(v, 2), (v) => { px = v; paint(); });
  const sy = slider('y', -1, 1, 0.01, py, (v) => num(v, 2), (v) => { py = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Turning onto the axis'), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, sx.el, sy.el)) };
}

// ---- what the word lengths buy --------------------------------------------------------------------------------------------------------

export function wordsWidget(): Widget {
  let w = 14, z = 14, n = 12;
  const chips = mkChips(4), note = h('p', { class: 'sub' });
  const paint = () => {
    const spec = { w, z, n }, scale = 2 ** (w - 2), e = cordicError(spec, scale);
    chips.set(0, `${num(e.worst, 2)} LSB`, 'worst error, over every angle the word holds');
    chips.set(1, num(Math.log2(scale / e.worst), 1), 'bits of accuracy that leaves');
    chips.set(2, `${num(cordicBound(spec, scale), 1)} LSB`, 'what the sum of the worst cases allows');
    chips.set(3, stats(cordicPipeline(spec)).nands.toLocaleString('en').replace(/,/g, ' '), 'NANDs, pipelined');
    note.textContent = `Worst at turn ${num(e.at / 2 ** z, 4)}. The result's own word is ${w - 1} bits with its sign, so the last ${num(Math.max(0, w - 1 - Math.log2(scale / e.worst)), 1)} bits are not worth keeping.`;
  };
  const sw = slider('x and y bits', 8, 18, 1, w, (v) => String(v), (v) => { w = v; paint(); });
  const sz = slider('Angle bits', 8, 14, 1, z, (v) => String(v), (v) => { z = v; paint(); });
  const sn = slider('Stages', 4, 16, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Measured at every angle'), chips.el, note), h('div', { class: 'panel mos-ctl' }, sw.el, sz.el, sn.el)) };
}

// ---- against a ROM -----------------------------------------------------------------------------------------------------------------------

/** A full-period sine table of 2^k words, the modem's way, measured in the same gates. */
export const sineRom = (k: number) => {
  const v = k + 2, N = 2 ** k;
  return lookupRom(`rom_sine_${k}_${v}`, `ROM: one sine period, ${N} words`, k, v, Array.from({ length: N }, (_, i) => Math.round(((Math.sin((2 * Math.PI * i) / N) + 1) / 2) * (2 ** v - 1))), 'A table of sine samples: its size doubles with every address bit.');
};
/** Worst error of a table with no interpolation: the angle truncated to 2^k steps, the word's rounding on top. In bits of accuracy. */
const romMemo = new Map<number, number>();
export const romBits = (k: number): number => {
  const hit = romMemo.get(k);
  if (hit !== undefined) return hit;
  const v = k + 2, N = 2 ** k;
  let worst = 0;
  for (let u = 0; u < N * 16; u++) {
    const i = Math.floor(u / 16), want = Math.sin((2 * Math.PI * u) / (N * 16));
    const got = (Math.round(((Math.sin((2 * Math.PI * i) / N) + 1) / 2) * (2 ** v - 1)) / (2 ** v - 1)) * 2 - 1;
    worst = Math.max(worst, Math.abs(got - want));
  }
  const bits = Math.log2(1 / worst);
  romMemo.set(k, bits);
  return bits;
};
const bitsMemo = new Map<string, number>();
export const cordicBits = (spec: CordicSpec): number => {
  const key = `${spec.w}_${spec.z}_${spec.n}`;
  let v = bitsMemo.get(key);
  if (v === undefined) { const scale = 2 ** (spec.w - 2); v = Math.log2(scale / cordicError(spec, scale).worst); bitsMemo.set(key, v); }
  return v;
};

export function costWidget(): Widget {
  // every angle of an 18-bit word takes about a second, so the page comes first
  const host = h('div', null, h('p', { class: 'sub' }, 'Measuring every angle…'));
  const fill = () => {
  const groups: { name: string; rows: [string, number, number, string][] }[] = [
    { name: 'A table', rows: [6, 8, 10, 12].map((k) => [`${2 ** k} words`, romBits(k), stats(sineRom(k)).nands, 'every clock']) },
    { name: 'CORDIC, pipelined', rows: [{ w: 10, z: 10, n: 8 }, { w: 14, z: 14, n: 12 }, { w: 18, z: 18, n: 16 }].map((sp) => [`${sp.w} bits, ${sp.n} stages`, cordicBits(sp), stats(cordicPipeline(sp)).nands, 'every clock']) },
  ];
  const table = h('table', { class: 'mini' }, h('tr', null, h('th', null, 'Design'), h('th', null, 'Size'), h('th', null, 'Bits of accuracy'), h('th', null, 'NANDs'), h('th', null, 'A sine')),
    ...groups.flatMap((g) => g.rows.map((r) => h('tr', null, h('td', null, g.name), h('td', null, r[0]), h('td', null, num(r[1], 1)), h('td', null, r[2].toLocaleString('en').replace(/,/g, ' ')), h('td', null, r[3])))));
  host.replaceChildren(table);
  };
  setTimeout(fill, 60);
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The same sine, two ways'), host)) };
}

// ---- the pipeline in gates -----------------------------------------------------------------------------------------------------------------

export const SCENE_SPEC: CordicSpec = { w: 12, z: 12, n: 10 };
export const cordicApi = new WeakMap<Stage, { agrees: () => boolean; clocks: () => number; run: () => void }>();
const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };

const pipePanel: ScenePanel = (stage: Stage): Widget => {
  const SP = SCENE_SPEC, STEP = 2 ** SP.z / 64, N = 64 + SP.n + 1, SCALE = 2 ** (SP.w - 2);
  let cs: number[] = [], sn: number[] = [], ok = true, ran = 0;
  const plot = plotOf({ W: 380, H: 170, x: [0, N], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'clock', yLabel: '', aria: 'Cosine and sine at the pipeline\'s outputs over a full turn' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    plot.clear();
    if (cs.length) { line(plot, range(cs.length), cs, 'ln-s lump'); line(plot, range(sn.length), sn, 'ln-s real'); }
    read.replaceChildren(h('span', null, 'clocks ', h('b', null, String(ran))), h('span', null, 'latency ', h('b', null, `${SP.n + 1} clocks`)));
    note.textContent = ran ? (ok ? 'At every clock the gates\' x, y and z matched the model.' : 'The gates and the model disagreed.') : 'Run a full turn in 64 angles. One result leaves every clock, after the pipeline has filled.';
  };
  const run = () => {
    stage.checkpoint();
    const sim = stage.sim!, m = new CordicPipe(SP), x0 = cordicStart(SP, SCALE);
    cs = []; sn = []; ok = true; ran = 0;
    sim.setInput('rotate', 1); sim.setInput('x', wordOf(x0, SP.w)); sim.setInput('y', 0);
    // fill it from a known state: the first angle over and over
    sim.setInput('z', 0); sim.settle();
    for (let i = 0; i < SP.n + 2; i++) { pulse(stage); m.edge({ x: x0, y: 0, z: 0 }, true); }
    for (let i = 0; i < N; i++) {
      const u = (i * STEP) % 2 ** SP.z;
      sim.setInput('z', u); sim.settle();
      pulse(stage);
      m.edge({ x: x0, y: 0, z: signedOf(u, SP.z) }, true);
      const o = m.out, x = signedOf(stage.value('xo'), SP.w), y = signedOf(stage.value('yo'), SP.w), z = signedOf(stage.value('zo'), SP.z);
      if (x !== o.x || y !== o.y || z !== o.z) ok = false;
      cs.push(x / SCALE); sn.push(y / SCALE); ran++;
    }
    stage.refresh();
    paint();
  };
  cordicApi.set(stage, { agrees: () => ok && ran > 0, clocks: () => ran, run });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'A full turn'),
    h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm', onclick: run }, 'Run a full turn')), plot.el,
    h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'x: cosine'), h('span', { class: 'k-far' }, 'y: sine')), read, note);
  stage.resetHooks.add(() => { cs = []; sn = []; ran = 0; paint(); });
  paint();
  return { el, update: () => {} };
};

export function cordicScene(): Scene {
  return { root: cordicPipeline(SCENE_SPEC), inputs: { x: 0, y: 0, z: 0, rotate: 1, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [pipePanel] };
}
