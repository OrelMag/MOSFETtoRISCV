// The diaphragm valve behind the faucet, in 3D (loaded on demand, modelhost.ts). One valve, then the complementary pair.
// The openings are the site's own models: one valve is mosphys.ts / water.ts fetWater (the "Three regions" faucet), the pair
// is water.ts columnStep / columnSettle (the inverter chapter's column). valve3dparts.ts derives each opening from a force
// balance on a spring-opposed diaphragm and tests hold it equal. The diaphragm's lag and the pellet in the gate line are drawn.

import '../styles/valve3d.css';
import '../styles/watertoggle.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { refresh } from '../gl/kit/geo';
import { drawnSpring, newChannelTex, paintChannel, springGeo, valveModel, valvePose, VALVE_HOME } from './valve3dkit';
import { VDD, VT } from './mosphys';
import type { BiasLink } from './mosshare';
import { COLUMN_VOLTS, columnSettle, columnStep, fetWater, wasted } from './water';
import {
  ONE, PAIR, TRAVEL, cracking, preload, rate, springForce, springLen, swept,
  type OneValve, type ValvePose, type ValveSpec,
} from './valve3dparts';

type Mode = 'one' | 'pair';
const LAG = 0.12; // s: the diaphragm's drawn travel time
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** `link`: the gate and drain of the output-characteristics widget above (mosshare.ts), shared in the one-valve view. */
export function valveView(link?: BiasLink): Widget {
  let mode: Mode = 'one', vin = link ? link.vg / VDD : 0.6, vds = link ? link.vd / VDD : 0.25, out = 0, open = { n: 0, p: 0 }, gateQ = 0, phase = 0, firstDraw = true;
  const spec = (): ValveSpec => (mode === 'one' ? ONE : PAIR);
  const volts = () => (mode === 'one' ? VDD : COLUMN_VOLTS);
  const col = () => ({ vin, short: false, weak: false });

  const panel = h('div', { class: 'panel' }), channel = newChannelTex();
  const stage = studioStage({
    aria: 'A pressure-operated diaphragm valve in cutaway: a gate line feeding a diaphragm that pushes a plunger off its seat against a spring, between a tank and a basin',
    home: VALVE_HOME.one,
    limits: { minDist: 30, maxDist: 600 },
    note: 'The lift (the gap) is linear in the gate pressure, as in a real diaphragm valve; the glow of the water is the MOSFET model’s flow (square law in saturation, rising with the tank’s level in the linear region), which a real valve’s linear area would not give. The colour along the gap is the channel’s charge from the same model’s gradual-channel picture (Vov − V(x)): it thins towards the drain and, in saturation, reaches zero at the drain end; a gap of water has no such thing, so this is the transistor drawn on the valve. Stem packing is drawn; travel stops, the yoke and the spring seats are left out. A valve needs steady pressure to stay open and a gate needs none once charged; a shut valve seals where a transistor leaks; the PMOS is not a reversed valve (it is referenced to the supply); the diaphragm’s lag and the pellet in the gate line are drawn, with no inertia or water hammer.',
    build: (detail) => valveModel({ pose: pose(), channel }, detail),
  });

  /** What the site's models say the valves do at the gate's value, held (not the lagged drawing). */
  function target(): { n: number; p: number } {
    if (mode === 'one') return { n: fetWater(vin * VDD, vds * VDD).opening, p: 0 };
    const s = columnStep(out, col(), 0);
    return { n: s.n, p: s.p };
  }
  function pose(): ValvePose {
    const t = target();
    const v: OneValve[] = mode === 'one'
      ? [{ kind: 'n', cx: 0, open: open.n, g: vin, left: vds, right: 0, flow: fetWater(vin * VDD, vds * VDD).flow }]
      : [{ kind: 'p', cx: -30, open: open.p, g: vin, left: 1, right: out, flow: t.p }, { kind: 'n', cx: 30, open: open.n, g: vin, left: out, right: 0, flow: t.n }];
    return { valves: v, gateQ, phase, g: vin, x0: mode === 'one' ? -50 : -80, x1: mode === 'one' ? 50 : 80 };
  }
  /** The pose moved, the channel's charge painted (one valve: the faucet's MOSFET at this gate and tank; the pair: even), a rebuild. */
  function paint(): void {
    const p = pose();
    if (mode === 'one') { const f = fetWater(vin * VDD, vds * VDD); paintChannel(channel, vin * VDD - VT, vds * VDD, f.flow); }
    else paintChannel(channel, 1, 0, Math.max(...p.valves.map((v) => v.flow)));
    p.valves.forEach((vv, i) => { for (const det of ['full', 'flat'] as const) { const g = drawnSpring(i, det); if (g) refresh(g, springGeo(springLen(vv.open * TRAVEL), det)); } });
    stage.move(valvePose(p));
    stage.refresh();
  }

  const chip = h('span', { class: 'r3-chip', 'aria-live': 'polite' }), regionChip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv vl-kv' }), hintP = h('p', { class: 'r3-hint' });
  stage.chips.append(chip, regionChip);

  function readout(): void {
    const sp = spec(), t = target(), vo = volts(), moving = !settled();
    // Units sit in the row names so each value stays one short line beside them (a wrapped value read as two rows).
    const rows: [string, string][] = [['Gate line pressure (of the supply)', `${(vin * vo).toFixed(2)} V · ${pct(vin)}`], ['Cracking pressure (preload ÷ area)', `${(cracking(sp) * vo).toFixed(2)} V`]];
    const held = swept(sp, open.n * TRAVEL) / swept(sp, TRAVEL);
    if (mode === 'one') {
      const f = fetWater(vin * VDD, vds * VDD);
      const ov = vin * VDD - VT;
      rows.push(['Overdrive Vgs − Vt (spring past preload)', ov > 0 ? `${ov.toFixed(2)} V` : 'none, below Vt'], ['Tank level, Vds (drain)', `${(vds * VDD).toFixed(2)} V · ${pct(vds)}`],
        ['Spring force (of full)', pct(springForce(sp, t.n * TRAVEL) / (preload(sp) + rate(sp) * TRAVEL))], ['Plunger lift (of travel)', pct(t.n)],
        ['Drain current (the flow)', f.kind === 'cut' ? '0, shut' : `${f.id.toFixed(0)} µA`]);
      const region = f.kind === 'cut' ? 'Cut-off' : f.kind === 'lin' ? 'Linear' : 'Saturation';
      if (regionChip.textContent !== region) regionChip.textContent = region;
      regionChip.className = `r3-chip ${f.kind === 'cut' ? '' : f.kind === 'lin' ? 'good' : 'warn'}`;
      const msg = moving ? 'Moving: diaphragm travelling' : t.n <= 0 ? 'Seated: below cracking pressure' : t.n >= 1 ? 'Fully open' : 'Cracked open';
      if (chip.textContent !== msg) chip.textContent = msg;
      chip.className = `r3-chip ${moving ? 'warn' : t.n <= 0 ? '' : t.n >= 1 ? 'good' : 'warn'}`;
    } else {
      const st = columnStep(out, col(), 0);
      rows.push(['PMOS valve lift (of travel)', pct(t.p)], ['NMOS valve lift (of travel)', pct(t.n)], ['Output (column) level', `${(out * vo).toFixed(2)} V`],
        ['Straight through, tank to drain', pct(wasted(st))]);
      regionChip.textContent = '';
      const msg = moving ? 'Switching: diaphragms moving' : out > 0.95 ? 'Output 1: pulled up' : out < 0.05 ? 'Output 0: pulled down' : 'Between: valves part-open';
      if (chip.textContent !== msg) chip.textContent = msg;
      chip.className = `r3-chip ${!moving && (out > 0.95 || out < 0.05) ? 'good' : 'warn'}`;
    }
    rows.push(['Gate-line flow (strokes/s)', Math.abs(gateQ) < 0.005 ? '0, at rest' : `${gateQ > 0 ? '+' : '−'}${Math.abs(gateQ).toFixed(2)}`], ['Gate charge held (of a stroke)', pct(held)]);
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    hintP.textContent = mode === 'one'
      ? (vin * VDD < VT ? `Below ${VT} V the gate pressure is less than the spring’s preload: the plunger stays on its seat.` : 'Past the cracking pressure the lift grows in step with the gate pressure. Lower the tank below Vgs − Vt and the flow falls with it (linear); above it the flow stops growing (saturation).')
      : 'The PMOS valve’s lower chamber is on the supply and the gate line is above its diaphragm: gate pressure closes it. The NMOS valve’s gate line is below its diaphragm: it opens it.';
    tankSl.style.display = mode === 'one' ? '' : 'none';
    tank.value = String(Math.round(vds * 1000)); tankOut.textContent = `${(vds * VDD).toFixed(2)} V`;
    tank.setAttribute('aria-valuetext', `${(vds * VDD).toFixed(2)} volts`);
    slider.value = String(Math.round(vin * 1000)); sout.textContent = `${(vin * vo).toFixed(2)} V`;
    slider.setAttribute('aria-valuetext', `${(vin * vo).toFixed(2)} volts`);
  }

  const settled = () => { const t = target(); return Math.abs(open.n - t.n) < 5e-4 && Math.abs(open.p - t.p) < 5e-4 && (mode === 'one' || Math.abs(out - columnSettle(out, col())) < 1e-4); };
  const loop = frameLoop((_now, dt) => {
    const snap = reducedMotion() || firstDraw;
    firstDraw = false;
    if (mode === 'pair') out = snap ? columnSettle(out, col()) : columnStep(out, col(), dt).out;
    const t = target(), k = snap ? 1 : Math.min(1, dt / LAG), pn = open.n, pp = open.p;
    open.n = Math.abs(t.n - open.n) < 5e-4 ? t.n : open.n + (t.n - open.n) * k;
    open.p = Math.abs(t.p - open.p) < 5e-4 ? t.p : open.p + (t.p - open.p) * k;
    // The gate line carries only what the diaphragms displace: A·dx/dt, nothing at rest. The PMOS diaphragm's gate side is
    // above it, so its stroke up pushes fluid out of the line, not in.
    const dq = dt > 0 && !snap ? (open.n - pn - (mode === 'pair' ? open.p - pp : 0)) / dt : 0;
    gateQ = Math.abs(dq) < 0.02 ? 0 : dq;
    phase += Math.abs(gateQ) * dt * 1.2;
    readout(); paint();
  }, () => !settled() || gateQ !== 0);
  const repaint = () => { readout(); paint(); loop.kick(); };

  const slider = h('input', { type: 'range', min: 0, max: 1000, step: 5, value: Math.round(vin * 1000), 'aria-label': 'Gate line pressure' }) as HTMLInputElement;
  const sout = h('output', null, '');
  const share = () => { if (mode === 'one') link?.set(vin * VDD, vds * VDD, panel); };
  slider.addEventListener('input', () => { vin = Number(slider.value) / 1000; share(); repaint(); });
  const tank = h('input', { type: 'range', min: 0, max: 1000, step: 5, value: Math.round(vds * 1000), 'aria-label': 'Tank level, the drain voltage Vds' }) as HTMLInputElement;
  const tankOut = h('output', null, '');
  const tankSl = h('label', { class: 'r3-sl vl-gate' }, h('span', null, 'Tank (Vds)'), tank, tankOut);
  tank.addEventListener('input', () => { vds = Number(tank.value) / 1000; share(); repaint(); });
  const unlink = link?.follow(panel, (g, d) => { if (mode !== 'one') return; vin = g / VDD; vds = d / VDD; repaint(); });
  const toggle = h('button', { type: 'button', class: 'btn sm' }, 'Switch gate 0 / 1') as HTMLButtonElement;
  toggle.addEventListener('click', () => { vin = vin >= 0.5 ? 0 : 1; share(); repaint(); });
  const oneBtn = h('button', { type: 'button', 'aria-pressed': 'true' }, 'One valve (NMOS)'), pairBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Complementary pair');
  const seg = h('div', { class: 'wt-seg', role: 'group', 'aria-label': 'What to show' }, oneBtn, pairBtn);
  function setMode(m: Mode): void {
    mode = m; out = 0;
    if (m === 'one' && link) { vin = link.vg / VDD; vds = link.vd / VDD; } open = { n: 0, p: 0 }; gateQ = 0; firstDraw = true;
    oneBtn.setAttribute('aria-pressed', String(m === 'one')); pairBtn.setAttribute('aria-pressed', String(m === 'pair'));
    repaint();
    stage.goTo(VALVE_HOME[m]);
  }
  oneBtn.addEventListener('click', () => setMode('one'));
  pairBtn.addEventListener('click', () => setMode('pair'));

  panel.append(
    h('h3', { class: 'm3-title' }, 'Inside the valve'),
    h('p', { class: 'm3-sub' }, 'The faucet above has a handle; this kind of valve has a diaphragm. The gate line is a separate, dead-ended pipe: its pressure pushes a diaphragm against a preloaded spring. The preload is the threshold, since below that pressure nothing moves; past it the plunger lifts off its seat and opens a channel from tank to basin, wider with more pressure. Water moves in the gate line only while the diaphragm does. In the transistor’s terms: the tank is the drain (its level is Vds), the basin the source at 0 V, the diaphragm the gate, the spring’s preload the threshold Vt and the gap under the plunger the channel. The pair is the inverter chapter’s “Two faucets on one column”: an NMOS valve that pressure opens and a PMOS valve that pressure closes, on one gate line.'),
    stage.el, hintP,
    h('div', { class: 'vl-below' },
      h('div', null,
        h('details', { class: 'r3-hint' }, h('summary', null, 'Predict, then see: the opening'),
          h('p', null, 'Vt is ' + VT + ' V. At Vgs = 0.90 V, how far open is the valve? The lift is the pressure past the preload over the span: (0.90 − ' + VT + ') ÷ (' + VDD + ' − ' + VT + ') = ' + Math.round(((0.9 - VT) / (VDD - VT)) * 100) + ' % of the travel. Then lower the tank below Vgs − Vt = 0.45 V: the flow falls with it. Raise it past: the flow stops growing.')),
        h('p', { class: 'r3-hint' }, 'Mechanics: a spring-opposed diaphragm actuator, as in Emerson’s Fisher 657 / 667 bulletins: the spring’s preload sets the pressure at which the stem starts to move, its rate sets the pressure span for the full travel. Thresholds and swings are the site’s (the faucet and column figures).')),
      h('div', null, h('h4', null, 'This valve ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  stage.slot.append(seg, h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl vl-gate' }, h('span', null, 'Gate'), slider, sout), tankSl, h('div', { class: 'r3-btns' }, toggle)));
  readout();
  paint();
  loop.kick();
  return { el: panel, destroy() { loop.stop(); unlink?.(); stage.destroy(); } };
}
