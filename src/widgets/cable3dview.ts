// Why a pair is twisted, in 3D (loaded on demand, modelhost.ts). A twisted pair does two jobs: the legs swap places each half
// twist, so an electric field from the side reaches both alike (common mode: the receiver of the step's 2D widget rejects it), and
// each half twist flips the loop's sign, so the magnetic pickup cancels (phys/cable.ts). Uneven twist leaves a residue. A neighbour
// pair of a different lay couples less. A toggle swaps in a stock coax, whose impedance comes from phys/line.ts's z0Of on the L and
// C that its measured D and d give.

import '../styles/cable3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import {
  COAX_PRESETS, coaxLC, coaxZ0, DIELECTRICS, fieldRate, halfTwistsPerMetre, LAY_A_MM, LAY_B_MM, loopCount, loopEdges, loopEmf, neighbourCoupling, neighbourHalfTwists, unevenLoops, type Dielectric,
} from '../phys/cable';
import { z0Of } from '../phys/line';
import { cableAnchors, cableParts, presetOf, type CablePalette, type CableState, type Neighbour } from './cable3dparts';
import { modelStage } from './modelstage';

/** Run length (m), conductor spacing (mm): the numbers behind the readouts. */
const RUN = 1, SPACING_MM = 1;
const NEIGHBOUR_LABEL: Record<Neighbour, string> = { off: 'Neighbour pair: off', same: 'Neighbour: same lay', other: 'Neighbour: other lay' };
const NEXT_NEIGHBOUR: Record<Neighbour, Neighbour> = { off: 'same', same: 'other', other: 'off' };

export function cableView(): Widget {
  const st: CableState = { twists: 5, coax: false, preset: 'rg58', diel: 'pe', uneven: 0, neighbour: 'off' };
  let dbdt = 10; // T / s
  const panel = h('div', { class: 'panel cb3' });
  const palette = (): CablePalette => ({
    a: stage.rgb('--m3-wire-a'), b: stage.rgb('--m3-wire-b'), pos: stage.rgba('--m3-loop-pos', 0.55), neg: stage.rgba('--m3-loop-neg', 0.55),
    shield: stage.rgba('--m3-shield', 0.9), core: stage.rgb('--m3-core'), field: stage.rgb('--m3-field'), efield: stage.rgb('--m3-efield'),
    diel: stage.rgba('--m3-diel', 0.55), jacket: stage.rgba('--m3-jacket', 0.4),
  });
  const stage = modelStage(panel, {
    aria: 'A twisted pair in 3D with each loop tinted by the sign of its induced voltage, or a stock coax with its ends stripped back',
    camera: { target: [0, 0, 0], yaw: -0.5, pitch: 0.75, dist: 98 },
    limits: { minDist: 30, maxDist: 220 },
    note: 'The spacing and the twist are drawn far larger than life, and the loops are lenses; the model counts loops. dB/dt = 10 T/s is a teaching scale, far above ambient. Coax dimensions are drawn to scale; the braid is eight strands.',
    draw: () => stage.paint(cableParts(st, palette()), cableAnchors(st)),
  });
  const chipA = h('span', { class: 'r3-chip' }), chipB = h('span', { class: 'r3-chip' });
  stage.chips.setAttribute('aria-live', 'polite'); stage.chips.setAttribute('aria-atomic', 'true');
  stage.chips.append(chipA, chipB);
  const kv = h('div', { class: 'r3-kv' }), sum = h('div', { class: 'cb-sum', role: 'group', 'aria-label': 'Running sum of the loops, in mV' });
  const mv = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 1000).toFixed(2)} mV`;
  const fill = (rows: [string, string][]) => kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));

  const readout = () => {
    if (st.coax) {
      const p = presetOf(st.preset), er = DIELECTRICS[st.diel].er, { l, c } = coaxLC(p.D, p.d, er), z = z0Of(l, c), stock = st.diel === p.dielectric;
      chipA.textContent = `Z0 = ${z.z0.toFixed(1)} Ω`; chipA.className = `r3-chip ${stock ? 'good' : 'warn'}`;
      chipB.textContent = stock ? `${p.sheet}: ${p.z0} Ω` : 'not the stock dielectric'; chipB.className = 'r3-chip';
      fill([['Cable', `${p.name}, ${p.sheet}`], ['D / d', `${p.D} / ${p.d} mm = ${(p.D / p.d).toFixed(2)}`], ['Jacket', `${p.jacket} mm`], ['Centre', p.core],
        ['L per metre', `${l.toFixed(0)} nH`], ['C per metre', `${c.toFixed(1)} pF`], ['Z0 = √(L / C)', `${z.z0.toFixed(1)} Ω`],
        ['60 / √εr · ln(D / d)', `${coaxZ0(p.D, p.d, er).toFixed(1)} Ω`], ['Datasheet nominal', `${p.z0} Ω`], ['Dielectric', `${DIELECTRICS[st.diel].name}, εr = ${er}`], ['Delay', `${z.psPerMm.toFixed(2)} ps / mm`]]);
      sum.replaceChildren();
      return;
    }
    const n = Math.round(st.twists), sp = SPACING_MM / 1000, loops = unevenLoops(n, sp, RUN, dbdt, st.uneven), run = loops.reduce<number[]>((a, e) => (a.push((a.at(-1) ?? 0) + e), a), []);
    const total = run[run.length - 1], full = loopEmf(sp, RUN, dbdt), zero = Math.abs(total) < 1e-12;
    const edges = loopEdges(n, st.uneven), near = edges.slice(1).reduce((a, e, k) => a + (k % 2 === 0 ? e - edges[k] : 0), 0);
    chipA.textContent = `${loopCount(n)} loops`; chipA.className = 'r3-chip';
    chipB.textContent = zero ? 'cancels exactly' : `${mv(total)} left over`; chipB.className = `r3-chip ${zero ? 'good' : 'warn'}`;
    const rows: [string, string][] = [['Half twists', `${n} drawn, ~${Math.round(halfTwistsPerMetre(LAY_A_MM))} per metre in a real cable`], ['Untwisted', mv(full)], ['One loop', mv(loops[0])], ['Delivered', mv(zero ? 0 : total)],
      ['Share of untwisted', `${Math.abs(zero ? 0 : total / full * 100).toFixed(0)} %`], ['E noise, leg A / B', `${(near * 100).toFixed(1)} % / ${((1 - near) * 100).toFixed(1)} % of the run nearer`]];
    if (st.neighbour !== 'off') {
      const n2 = st.neighbour === 'same' ? n : neighbourHalfTwists(n), lay2 = st.neighbour === 'same' ? LAY_A_MM : LAY_B_MM, cpl = neighbourCoupling(edges, loopEdges(n2));
      rows.push(['Neighbour lay', `${lay2.toFixed(1)} mm (~${Math.round(halfTwistsPerMetre(lay2))} per metre), ${n2} drawn`], ['Pair-to-pair coupling', `${(cpl * 100).toFixed(0)} % of the equal-lay case`]);
    }
    fill(rows);
    sum.replaceChildren(...loops.map((e, k) => h('span', { class: e > 0 ? 'p' : 'n', title: `loop ${k + 1}: ${mv(e)}, sum ${mv(run[k])}` }, `${e > 0 ? '+' : '−'}${Math.abs(e * 1000).toFixed(1)} → Σ ${(Math.abs(run[k]) < 1e-12 ? 0 : run[k] * 1000).toFixed(1)}`)), h('span', { class: 'tot' }, `Σ ${(zero ? 0 : total * 1000).toFixed(2)} mV`));
  };
  const repaint = () => { readout(); stage.paint(cableParts(st, palette()), cableAnchors(st)); };

  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label, 'aria-valuetext': fmt(val) }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); input.setAttribute('aria-valuetext', fmt(v)); on(v); repaint(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), input, out);
  };
  const toggle = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Swap in a coax') as HTMLButtonElement;
  const nbr = h('button', { type: 'button', class: 'btn sm' }, NEIGHBOUR_LABEL.off) as HTMLButtonElement;
  nbr.addEventListener('click', () => { st.neighbour = NEXT_NEIGHBOUR[st.neighbour]; nbr.textContent = NEIGHBOUR_LABEL[st.neighbour]; repaint(); });
  const pairCtl = h('div', { class: 'r3-ctl' }, slider('Half twists', 0, 12, 1, st.twists, String, (v) => { st.twists = v; }),
    slider('Unevenness', 0, 20, 1, 0, (v) => `${v} %`, (v) => { st.uneven = v / 100; }), slider('dB/dt', 1, 50, 1, dbdt, (v) => `${v} T/s`, (v) => { dbdt = v; }));
  // Stock cables only: a D / d the datasheets do not list is not offered. The dielectric changes εr of the same geometry.
  const choice = <T extends string>(items: [T, string][], pick: () => T, set: (v: T) => void) => {
    const bs = items.map(([id, name]) => h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(pick() === id), 'data-id': id }, name) as HTMLButtonElement);
    const sync = () => bs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === pick())));
    bs.forEach((b) => b.addEventListener('click', () => { set(b.dataset.id as T); sync(); repaint(); }));
    return { el: h('div', { class: 'cb-seg', role: 'group' }, ...bs), sync };
  };
  const dielSeg = choice((Object.keys(DIELECTRICS) as Dielectric[]).map((k): [Dielectric, string] => [k, `${DIELECTRICS[k].name} ${DIELECTRICS[k].er}`]), () => st.diel, (v) => { st.diel = v; });
  dielSeg.el.setAttribute('aria-label', 'Dielectric');
  const presets = choice(COAX_PRESETS.map((p): [string, string] => [p.id, p.name]), () => st.preset, (v) => { st.preset = v; st.diel = presetOf(v).dielectric; dielSeg.sync(); });
  presets.el.setAttribute('aria-label', 'Stock coax cable');
  const coaxCtl = h('div', { class: 'r3-ctl cb-coax' }, presets.el, dielSeg.el);
  coaxCtl.hidden = true;
  toggle.addEventListener('click', () => {
    st.coax = !st.coax; toggle.setAttribute('aria-pressed', String(st.coax)); toggle.textContent = st.coax ? 'Back to the pair' : 'Swap in a coax';
    pairCtl.hidden = st.coax; nbr.hidden = st.coax; coaxCtl.hidden = !st.coax; repaint();
  });
  const rate = fieldRate(100e-6, 50);

  panel.append(
    h('h3', { class: 'm3-title' }, 'Why a pair is twisted'),
    h('p', { class: 'm3-sub' }, `Twisting does two jobs. The legs swap places every half twist, so an electric field from the side (amber) reaches both alike: common mode, which the receiver beside this panel rejects. A magnetic field through the loops (grey) induces dΦ/dt = A · dB/dt; each half twist flips a loop’s sign, so odd n sum to zero and even n leave one loop, but only while the loops are equal: the unevenness slider leaves a residue, the widget’s leg mismatch. A real lay is about 8 to 25 mm per turn (example: 11.2 mm, patent EP1058275), ~${Math.round(halfTwistsPerMetre(LAY_A_MM))} half twists per metre where this draws up to 12; pairs in one sheath get different lays (${LAY_B_MM.toFixed(1)} mm here) so their twists do not mesh. 10 T/s is a teaching scale: 100 µT at 50 Hz is ${rate.toFixed(2)} T/s. A coax closes the loop in its shield only above the shield’s R/L corner, of order a kilohertz (Ott: 1 to 2 kHz); below it the return current takes the lowest-resistance path. The coaxes are stock Belden cables.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, pairCtl, coaxCtl, stage.el, stage.hint, h('div', { class: 'r3-btns' }, toggle, nbr, stage.resetBtn)),
      h('div', { class: 'r3-side' }, h('h4', null, 'The cable ', h('span', { class: 'r3-badge' }, 'model')), kv, sum)));
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
