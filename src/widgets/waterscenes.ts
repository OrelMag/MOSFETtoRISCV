// The three water scenes on the water kit (waterkit.ts), each a thin drawing of a model in water.ts: the loop of chapter 0
// (shares loopWidget's own state), the faucet of "Three regions" (shares its gate / drain sliders and mosphys.ts current()),
// and the CMOS column of chapter 2's aside figures. Loaded as one lazy chunk with the kit and the renderer.

import type { FigureMount } from '../ui/analogyfigs';
import { h } from '../ui/dom';
import {
  columnSettle, columnStep, columnWords, COLUMN_VOLTS, COLUMN_VT, FET_PIPE_R, fetWater, loopWater, pinchRadius, wasted,
  type ColumnIn, type ColumnStep, type FetWater, type LoopState, type P3,
} from './water';
import { htmlSub, mountWater, type Parts, type WaterMount, type WaterScene } from './waterkit';

const approach = (cur: number, tgt: number, dt: number, settle: boolean): number =>
  settle ? tgt : Math.abs(tgt - cur) < 0.004 ? tgt : cur + (tgt - cur) * Math.min(1, dt * 12);

// ---------------------------------------------------------------- 1 · the loop

const TOP: P3[] = [[-2.0, 0.5, 0], [2.6, 0.5, 0], [2.6, -1.6, 0], [-3.8, -1.6, 0], [-3.8, 2.95, 0], [-2.6, 2.95, 0], [-2.6, 2.5, 0]];
const LOOP_PATH: P3[] = [[-2.6, 0.5, 0], ...TOP, [-2.6, 0.5, 0]];
const LOOP_DROPS = 46;

export function loopScene(get: () => LoopState): WaterScene {
  let vA = 0, vB = 1, phase = 0, ang = 0, moving = false, firstDraw = true;
  const lenLoop = LOOP_PATH.reduce((l, p, i) => (i ? l + Math.hypot(p[0] - LOOP_PATH[i - 1][0], p[1] - LOOP_PATH[i - 1][1]) : 0), 0);
  return {
    alt: 'A loop of water: a tank, two valves, a water wheel with a lamp, a narrow pipe and a pump.',
    view: { target: [-0.6, 0.5, 0], yaw: -0.35, pitch: 0.3, dist: 9.4 },
    aspect: 4 / 3,
    flat: { x0: -4.6, y0: -2.6, w: 8.6, h: 6.4 },
    labels: () => [
      { text: 'tank height = voltage', p: [-2.6, 2.95, 0.6], side: 't' },
      { text: 'valve = switch', p: [-1.0, 1.05, 0.4], side: 't' },
      { text: 'wheel = lamp', p: [1.0, 1.55, 0.3], side: 't' },
      { text: 'narrow pipe = resistance', p: [2.45, 0.5, 0.3], side: 'r' }, // right of the corner: below it sat on the second lamp's wheel
      { text: 'pump = battery', p: [-1.4, -2.25, 0.3], side: 'b' },
      { text: 'return pipe = ground, 0 V', p: [0.6, -1.95, 0.5], side: 'b', minor: true },
    ],
    advance(dt, settle) {
      const st = get(), m = loopWater(st);
      vA = approach(vA, st.closed ? 1 : 0, dt, settle || firstDraw);
      vB = approach(vB, st.cut ? 0 : 1, dt, settle || firstDraw);
      firstDraw = false;
      if (!settle) { phase += ((m.dropSpeed * dt) / lenLoop) * LOOP_DROPS; ang -= m.wheelRate * dt; }
      moving = m.dropSpeed > 0 || vA !== (st.closed ? 1 : 0) || vB !== (st.cut ? 0 : 1);
    },
    active: () => moving,
    build(p: Parts) {
      const st = get(), m = loopWater(st), P = p.P;
      p.tank(-2.6, 0.2, 0, 1.2, 2.4, 1.0, m.tank);
      // The pipe, with a restriction (flanged, bore shrinking as lamps are added) before the first wheel's far side.
      p.tube([-2.0, 0.5, 0], [1.6, 0.5, 0], 0.11);
      p.tube([1.6, 0.5, 0], [2.25, 0.5, 0], 0.075 * m.bore);
      p.flange([1.6, 0.5, 0], 0.16, [1, 0, 0]); p.flange([2.25, 0.5, 0], 0.16, [1, 0, 0]);
      p.pipe([[2.25, 0.5, 0], [2.6, 0.5, 0], [2.6, -1.6, 0], [-3.8, -1.6, 0], [-3.8, 2.95, 0], [-2.6, 2.95, 0], [-2.6, 2.5, 0]]);
      p.valve([-1.0, 0.5, 0], vA, P.pmos);
      p.valve([1.3, -1.6, 0], vB, P.pmos);
      // Lamp = wheel + bulb, glowing with the power it takes (m.power is per lamp: two in a row carry one current and drop
      // equal voltages, so they glow alike); a second one in the vertical run when there are two lamps.
      const glow = Math.min(1, m.power / 0.15), lit = P.lamp.map((c) => c * glow) as [number, number, number];
      p.wheel([1.0, 0.5, 0], ang);
      p.sphere([1.0, 1.1, 0], 0.13, P.lamp, lit);
      if (st.lamps === 2) {
        p.wheel([2.6, -0.55, 0], ang);
        p.sphere([3.1, -0.55, 0], 0.13, P.lamp, lit);
      }
      // The pump: a wheel on a blue plate, turning with the current.
      p.box([-1.4, -1.6, -0.22], [0.9, 0.9, 0.1], P.nmos);
      p.wheel([-1.4, -1.6, 0], ang * -1, 0.3);
      p.drops(LOOP_PATH, LOOP_DROPS, phase);
    },
  };
}

export function mountLoop(host: HTMLElement, get: () => LoopState): WaterMount {
  return mountWater(host, loopScene(get));
}

// ---------------------------------------------------------------- 2 · the faucet

const FET_PATH: P3[] = [[-2.4, -0.2, 0], [2.4, -0.2, 0]];
const FET_DROPS = 26;
const FET_SPEED = 6.5; // scene units a second at the device's largest current

export function fetScene(get: () => { vg: number; vd: number }): WaterScene {
  let open = 0, level = 0, phase = 0, moving = false;
  const now = (): FetWater => fetWater(get().vg, get().vd);
  const choked = (): boolean => now().choked;
  return {
    alt: 'A faucet between a drain tank and a source basin: the handle is the gate, the tank level the drain voltage.',
    view: { target: [0, 0.6, 0], yaw: -0.25, pitch: 0.28, dist: 9.2 },
    aspect: 16 / 10,
    flat: { x0: -3.4, y0: -0.9, w: 6.8, h: 3.6 },
    labels: () => [
      { text: 'drain tank: V_DS above the source', p: [-2.4, 2.35, 0.5], side: 't' },
      { text: 'source basin: 0 V', p: [2.4, 2.35, 0.5], side: 't' },
      { text: 'handle = gate (V_GS)', p: [0.0, 0.55, 0.4], side: 't' },
      { text: choked() ? 'outlet regulates: sets the flow' : 'outlet: opens with V_GS − V_T', p: [1.45, -0.55, 0.4], side: 'b', minor: true },
    ],
    advance(dt, settle) {
      const f = now();
      open = approach(open, f.opening, dt, settle);
      level = approach(level, f.level, dt, settle);
      if (!settle) phase += ((f.flow * FET_SPEED * dt) / 4.8) * FET_DROPS;
      moving = f.flow > 0 || open !== f.opening || level !== f.level;
    },
    active: () => moving,
    build(p: Parts) {
      const f = now();
      p.tank(-2.4, -0.4, 0, 1.3, 2.4, 1.0, 0.05 + level * 0.9);
      p.tank(2.4, -0.4, 0, 1.3, 2.4, 1.0, 0.02);
      // The outlet: a nozzle whose bore is the overdrive (water.ts pinchRadius), flanged.
      p.tube([-1.75, -0.2, 0], [1.0, -0.2, 0], FET_PIPE_R);
      p.tube([1.0, -0.2, 0], [1.75, -0.2, 0], pinchRadius(f.bore));
      p.flange([1.0, -0.2, 0], 0.23, [1, 0, 0]); p.flange([1.75, -0.2, 0], 0.23, [1, 0, 0]);
      p.flange([1.375, -0.2, 0], pinchRadius(f.bore) + 0.04, [1, 0, 0]); // a collar hugging the neck, so the narrowing reads
      p.valve([0, -0.2, 0], open, p.P.nmos);
      if (f.flow > 0) p.drops(FET_PATH, FET_DROPS, phase);
    },
  };
}

export function mountFet(host: HTMLElement, get: () => { vg: number; vd: number }): WaterMount {
  return mountWater(host, fetScene(get));
}

// ---------------------------------------------------------------- 3 · two faucets on one column

const COL = { x: 1.2, y0: -0.6, h: 2.3, r: 0.32 };
const TOP_PATH: P3[] = [[0, 2.9, 0], [0, 2.2, 0], [1.2, 2.2, 0], [1.2, 1.7, 0]];
const BOT_PATH: P3[] = [[1.2, -0.6, 0], [1.2, -1.1, 0], [0, -1.1, 0], [0, -1.8, 0]];

export interface ColumnScene extends WaterScene { readonly state: { out: number; step: ColumnStep } }

export function columnScene(inp: ColumnIn, out0: number): ColumnScene {
  const state = { out: out0, step: columnStep(out0, inp, 0) };
  let phaseT = 0, phaseB = 0, ang = 0;
  return {
    state,
    alt: 'Two faucets on one glass column: a full tank above, a drain below. The output is the water level in the column.',
    view: { target: [0.1, 0.85, 0], yaw: -0.55, pitch: 0.22, dist: 11.4 },
    aspect: 0.8,
    flat: { x0: -2.6, y0: -2.5, w: 5.4, h: 6.6 },
    labels: () => [
      { text: 'V_DD tank, full', p: [1.9, 3.5, 0.4], side: 'r' },
      { text: inp.weak ? 'top: NMOS, shuts itself' : 'top: PMOS, open at 0', p: [0.6, 2.75, 0.5], side: 't' },
      { text: 'output = column level', p: [1.6, 0.55, 0.3], side: 'r' },
      { text: 'bottom: NMOS, open at 1', p: [0.6, -0.55, 0.5], side: 'b' },
      { text: 'drain = ground', p: [0, -2.3, 0.6], side: 'b', minor: true },
      { text: 'wasted flow', p: [-1.6, -0.6, 0.3], side: 't', minor: true },
      { text: `V_DD − V_t = ${(COLUMN_VOLTS * (1 - COLUMN_VT)).toFixed(2)} V`, p: [1.5, COL.y0 + COL.h * (1 - COLUMN_VT), 0.2], side: 'r', hidden: !inp.weak },
    ],
    advance(dt, settle) {
      if (settle) { state.out = columnSettle(state.out, inp); state.step = columnStep(state.out, inp, 0); }
      else { state.step = columnStep(state.out, inp, dt); state.out = state.step.out; }
      if (!settle) {
        phaseT += ((state.step.iTop * 6 * dt) / 2.4) * 14;
        phaseB += ((state.step.iBot * 6 * dt) / 2.6) * 14;
        ang += wasted(state.step) * 30 * dt;
      }
    },
    active: () => state.step.iTop > 0.003 || state.step.iBot > 0.003,
    build(p: Parts) {
      const P = p.P, s = state.step;
      p.tank(0, 2.9, 0, 2.2, 0.9, 1.0, 0.92);
      p.pipe(TOP_PATH);
      p.valve([0.6, 2.2, 0], s.p, inp.weak ? P.nmos : P.pmos);
      p.column(COL.x, COL.y0, 0, COL.r, COL.h, state.out);
      p.pipe(BOT_PATH);
      p.valve([0.6, -1.1, 0], s.n, P.nmos);
      p.box([0, -1.9, 0], [2.6, 0.35, 1.2], P.dark);
      p.tube([0, -1.1, 0], [-1.2, -1.1, 0], 0.05);
      p.wheel([-1.6, -1.1, 0], ang, 0.28);
      if (inp.weak) p.disc([COL.x, COL.y0 + COL.h * (1 - COLUMN_VT), 0], COL.r * 1.25, 0.03, P.lamp);
      if (s.iTop > 0.003) p.drops(TOP_PATH, 14, phaseT);
      if (s.iBot > 0.003) p.drops(BOT_PATH, 14, phaseB);
    },
  };
}

/** The CMOS column as an aside figure (analogyfigs.ts: 'water-cmos' / 'water-cmos-weak'): the input handle, the two faucets,
 *  a short and the NMOS-on-top switch, and readouts of what the column does. `weak`: opens with the NMOS on top. */
export function cmosFigure(weak: boolean): FigureMount {
  return (host) => {
    const inp: ColumnIn = { vin: 0, short: false, weak };
    // Normal: the column starts full (input 0). Weak: it starts empty, so the climb that stops at 0.80 V is seen.
    const scene = columnScene(inp, weak ? 0 : 1);
    const stageHost = h('div');
    const range = h('input', { type: 'range', min: 0, max: 1, step: 0.02, value: 0, 'aria-label': 'Input voltage: one handle for both faucets' }) as HTMLInputElement;
    const rangeOut = h('output', null, '0.00 V');
    const shortBtn = h('button', { type: 'button', class: 'btn sm wt-btn', 'aria-pressed': 'false' }, 'Both open (short)');
    const weakBtn = h('button', { type: 'button', class: 'btn sm wt-btn', 'aria-pressed': String(weak) }, 'NMOS on top (weak 1)');
    const cell = () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; };
    const cells = [cell(), cell(), cell(), cell()];
    ['output level', 'top faucet open', 'bottom faucet open', 'wasted flow'].forEach((t, i) => { cells[i].sp.textContent = t; });
    const pill = h('span', { class: 'wt-pill', role: 'status' });
    const el = h('div', { class: 'wt-fig' },
      stageHost,
      h('div', { class: 'wt-ctl' }, h('label', { class: 'wt-sl' }, h('span', null, 'Input'), range, rangeOut), shortBtn, weakBtn),
      h('div', { class: 'wt-chips' }, ...cells.map((c) => c.el)),
      h('div', null, pill));
    host.append(el);

    const readout = () => {
      const s = scene.state.step, w = columnWords(s, inp);
      cells[0].b.textContent = `${(scene.state.out * COLUMN_VOLTS).toFixed(2)} V`;
      cells[1].b.textContent = `${Math.round(s.p * 100)} %`;
      cells[2].b.textContent = `${Math.round(s.n * 100)} %`;
      cells[3].b.textContent = `${Math.round(wasted(s) * 100)} %`;
      pill.replaceChildren(...htmlSub(w.text));
      pill.className = `wt-pill ${w.tone === 'mid' ? '' : w.tone}`;
      rangeOut.textContent = `${(inp.vin * COLUMN_VOLTS).toFixed(2)} V`;
      shortBtn.setAttribute('aria-pressed', String(inp.short));
      weakBtn.setAttribute('aria-pressed', String(inp.weak));
    };
    const mount = mountWater(stageHost, scene, readout);
    const change = () => { scene.state.step = columnStep(scene.state.out, inp, 0); readout(); mount.kick(); };
    range.addEventListener('input', () => { inp.vin = Number(range.value); change(); });
    shortBtn.addEventListener('click', () => { inp.short = !inp.short; if (inp.short) inp.weak = false; change(); });
    weakBtn.addEventListener('click', () => {
      inp.weak = !inp.weak;
      if (inp.weak) { inp.vin = 0; range.value = '0'; inp.short = false; } // the two states exclude each other
      change();
    });
    readout();
  };
}
