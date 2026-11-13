// Why a pair is twisted, in 3D (loaded on demand, modelhost.ts), on the studio renderer (cable3dkit.ts). A twisted pair does
// two jobs: the legs swap places each half twist, so an electric field from the side reaches both alike (common mode: the
// receiver of the step's 2D widget rejects it), and each half twist turns the loop over, so the magnetic pickup cancels
// (phys/cable.ts). The field rises and falls in time; each loop's lens takes its voltage's colour, beads show the charge it
// pushes, the receiver glows with the sum. Uneven twist leaves a residue. A neighbour pair of a different lay couples less.
// A toggle swaps in a stock coax, to scale, whose impedance comes from phys/line.ts's z0Of on the L and C its D and d give.

import '../styles/cable3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { packInstances } from '../gl/instances';
import { boundsOfNamed, fitView } from '../gl/kit/scene';
import { M } from '../gl/kit/materials';
import { reducedMotion } from '../ui/motion';
import {
  COAX_PRESETS, coaxLC, coaxZ0, DIELECTRICS, fieldRate, halfTwistsPerMetre, LAY_A_MM, LAY_B_MM, loopCount, loopEdges, loopEmf, neighbourCoupling, neighbourHalfTwists, unevenLoops, type Dielectric,
} from '../phys/cable';
import { z0Of } from '../phys/line';
import { presetOf, type CableState, type Neighbour } from './cable3dparts';
import {
  BEAD, CAT5E, COAX_HOME, COAX_LAYERS, FRAME_GROUPS, HEAD, LENS, LOAD, PAIR_HOME, PAIR_LAYERS, PERIOD_MS, SHAFT, STILL, cableModel, pairCutAt, fieldArrows, lenses, pushBeads, receiver, tighterThanLife,
  type CableLayer, type CableLook, type CableRgb,
} from './cable3dkit';
import { frameLoop } from './mosfet';
import { studioStage, type StudioStage } from './studiostage';

/** Run length (m), conductor spacing (mm): the numbers behind the readouts. */
const RUN = 1, SPACING_MM = 1;
const NEIGHBOUR_LABEL: Record<Neighbour, string> = { off: 'Neighbour pair: off', same: 'Neighbour: same lay', other: 'Neighbour: other lay' };
const NEXT_NEIGHBOUR: Record<Neighbour, Neighbour> = { off: 'same', same: 'other', other: 'off' };
const FALLBACK: CableRgb = { pos: [1, 0.48, 0.45], neg: [0.42, 0.64, 1], field: [0.71, 0.74, 0.8], push: [0.3, 0.85, 0.55], load: [0.45, 0.48, 0.55], hot: [1, 0.6, 0.25] };

export function cableView(): Widget {
  const st: CableState = { twists: 5, coax: false, preset: 'rg58', diel: 'pe', uneven: 0, neighbour: 'off' };
  let dbdt = 10; // T / s
  let phase = STILL, paused = false, stageRef: StudioStage | null = null;
  const mine = new Set<CableLayer>(['field']);
  let shown: ReadonlySet<CableLayer> = mine;
  const home = { ...PAIR_HOME };
  const rgb = (): CableRgb => {
    const s = stageRef;
    return s ? { pos: s.rgb('--m3-loop-pos'), neg: s.rgb('--m3-loop-neg'), field: s.rgb('--m3-field'), push: s.rgb('--cb-push'), load: s.rgb('--cb-load'), hot: s.rgb('--cb-hot') } : FALLBACK;
  };
  const look = (detail: CableLook['detail']): CableLook => ({ detail, st, layers: shown, phase: STILL, rgb: rgb() });
  const panel = h('div', { class: 'panel cb3' });
  const stage = studioStage({
    aria: 'A twisted pair in 3D: two insulated copper wires twisted between a sender and a receiver, each loop between them tinted by the voltage a changing magnetic field drives round it, alternating in sign; or a stock coax to scale, stripped back to its centre conductor, dielectric, braid and jacket',
    home,
    homeFrame: ['homebox'],
    hidden: [...FRAME_GROUPS],
    knobs: { cut: 0, explode: 0 },
    onKnobs: () => put(),
    limits: { minDist: 12, maxDist: 400 },
    onBeat: (i) => { shown = i >= 0 ? new Set((st.coax ? COAX_LAYERS : PAIR_LAYERS)[i] ?? []) : mine; syncChips(); stage.refresh(); put(); },
    note: `The pair is drawn far wider and its twist far tighter than life, so its loops can be counted: the True proportion layer puts the same pair beside it at its real shape (two ${CAT5E.insulated} mm Cat5e wires touching, a turn every ${LAY_A_MM.toFixed(1)} mm), with a ruler. The field rises and falls as a sine; a lens's colour is its loop's voltage (dB/dt), the beads the charge each loop pushes round itself (the field, B), the receiver's glow what they add up to. dB/dt = 10 T/s in the readouts is a teaching scale, far above ambient. The coaxes are drawn to scale from the Belden sheets; their braid as 8 carriers of 3 wires each way at 45° (the sheets give the coverage, not the weave), the strip-back steps ours, and the field a snapshot.`,
    build: (detail) => cableModel(look(detail)),
  });
  stageRef = stage;
  const NONE = new Float32Array(0);
  const mats = {
    lens: M.make({ base: [1, 1, 1], metal: 0, rough: 0.6, transmit: 0.5, label: 'a loop, coloured by its voltage now' }),
    field: M.make({ base: [1, 1, 1], metal: 0, rough: 0.5, label: 'the magnetic field B, now' }),
    push: M.make({ base: [1, 1, 1], metal: 0, rough: 0.35, label: 'the charge each loop pushes (it glows with its own colour)' }),
    load: M.make({ base: [1, 1, 1], metal: 0, rough: 0.45, label: 'the receiver (a resistor between the legs)' }),
  };
  /** The parts that move with the field, instanced each frame (none in the flat view, which draws a still). */
  function put(): void {
    if (stage.isFlat()) return;
    const pair = !st.coax, c = rgb(), f = fieldArrows(st, phase, c), cut = pairCutAt(st, stage.knobs().cut);
    // what lies beyond the cut goes with it (the stage cuts only the model's own parts)
    const keep = <T extends { pos: number[] }>(list: T[]): T[] => list.filter((x) => x.pos[0] <= cut);
    stage.instances('lens', LENS, mats.lens, pair ? packInstances(lenses(st, phase, c).filter((l) => l.pos[0] + l.scale![0] <= cut + 1e-6)) : NONE);
    stage.instances('shaft', SHAFT, mats.field, pair && shown.has('field') ? packInstances(keep(f.shafts)) : NONE);
    stage.instances('head', HEAD, mats.field, pair && shown.has('field') ? packInstances(keep(f.heads)) : NONE);
    // cut open, the beads would crowd the cut face: the cut is for looking at the copper
    stage.instances('push', BEAD, mats.push, pair && shown.has('push') && stage.knobs().cut === 0 ? packInstances(pushBeads(st, phase, c)) : NONE);
    stage.instances('load', LOAD, mats.load, pair ? packInstances(keep(receiver(st, phase, c))) : NONE);
  }
  const moving = () => !st.coax && !paused && !reducedMotion();
  const loop = frameLoop((_now, dt) => { phase = (phase + (dt * 1000 * 2 * Math.PI) / PERIOD_MS) % (2 * Math.PI); put(); }, moving);

  /** Fit a mode's or a layer's frame from home's direction, and make it home. */
  function frameOn(groups: string[]): void {
    const s = stage.studio(), cv = stage.el.querySelector('canvas');
    if (!s || !cv) return;
    const f = fitView(boundsOfNamed(cableModel(look('full')), groups), home.yaw, home.pitch, s.camera.fov, cv.clientWidth / Math.max(1, cv.clientHeight), 0.08);
    stage.goTo({ yaw: home.yaw, pitch: home.pitch, target: f.target, dist: f.dist });
  }

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
      ['Share of untwisted', `${Math.abs(zero ? 0 : total / full * 100).toFixed(0)} %`], ['E noise, leg A / B', `${(near * 100).toFixed(1)} % / ${((1 - near) * 100).toFixed(1)} % of the run nearer`],
      ['Drawn twist', `${tighterThanLife(n).toFixed(1)} × tighter than an ${LAY_A_MM.toFixed(1)} mm lay`]];
    if (st.neighbour !== 'off') {
      const n2 = st.neighbour === 'same' ? n : neighbourHalfTwists(n), lay2 = st.neighbour === 'same' ? LAY_A_MM : LAY_B_MM, cpl = neighbourCoupling(edges, loopEdges(n2));
      rows.push(['Neighbour lay', `${lay2.toFixed(1)} mm (~${Math.round(halfTwistsPerMetre(lay2))} per metre), ${n2} drawn`], ['Pair-to-pair coupling', `${(cpl * 100).toFixed(0)} % of the equal-lay case`]);
    }
    fill(rows);
    sum.replaceChildren(...loops.map((e, k) => h('span', { class: e > 0 ? 'p' : 'n', title: `loop ${k + 1}: ${mv(e)}, sum ${mv(run[k])}` }, `${e > 0 ? '+' : '−'}${Math.abs(e * 1000).toFixed(1)} → Σ ${(Math.abs(run[k]) < 1e-12 ? 0 : run[k] * 1000).toFixed(1)}`)), h('span', { class: 'tot' }, `Σ ${(zero ? 0 : total * 1000).toFixed(2)} mV`));
  };
  const repaint = () => { readout(); stage.refresh(); put(); loop.kick(); };

  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label, 'aria-valuetext': fmt(val) }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); input.setAttribute('aria-valuetext', fmt(v)); on(v); repaint(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), input, out);
  };
  const toggle = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Swap in a coax') as HTMLButtonElement;
  const nbr = h('button', { type: 'button', class: 'btn sm' }, NEIGHBOUR_LABEL.off) as HTMLButtonElement;
  nbr.addEventListener('click', () => { st.neighbour = NEXT_NEIGHBOUR[st.neighbour]; nbr.textContent = NEIGHBOUR_LABEL[st.neighbour]; repaint(); frameOn(st.neighbour === 'off' ? ['homebox'] : ['nbox']); });
  const pause = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: 'Stop the field where it is' }, 'Pause the field') as HTMLButtonElement;
  pause.addEventListener('click', () => { paused = !paused; pause.setAttribute('aria-pressed', String(paused)); pause.classList.toggle('on', paused); pause.textContent = paused ? 'Run the field' : 'Pause the field'; loop.kick(); });
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

  // layers: each mode its own; a beat lends its own and gives them back
  const CHIPS: [CableLayer, string, string, boolean][] = [
    ['field', 'Magnetic field', 'The field through the loops, rising and falling', false], ['push', 'Charge pushed', 'The charge each loop pushes round itself, as beads on the wires', false],
    ['electric', 'Electric field', 'An electric field from the side, at the crossings', false],
    ['true', 'True proportion', 'The same pair at its real shape, with a millimetre ruler', false], ['fields', 'Fields', 'The field between the core and the braid', true],
  ];
  const chipBtns = CHIPS.map(([key, label, title]) => {
    const b = h('button', { type: 'button', class: 'btn sm', title, 'aria-pressed': 'false' }, label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      if (shown !== mine) { mine.clear(); for (const l of shown) mine.add(l); }
      if (mine.has(key)) mine.delete(key); else mine.add(key);
      shown = mine; syncChips(); repaint();
      if (key === 'true') frameOn(shown.has('true') ? ['truebox'] : ['homebox']);
    });
    return b;
  });
  function syncChips(): void { chipBtns.forEach((b, i) => { const on = shown.has(CHIPS[i][0]); b.hidden = CHIPS[i][3] !== st.coax; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); }

  toggle.addEventListener('click', () => {
    st.coax = !st.coax; toggle.setAttribute('aria-pressed', String(st.coax)); toggle.textContent = st.coax ? 'Back to the pair' : 'Swap in a coax';
    pairCtl.hidden = st.coax; nbr.hidden = pause.hidden = st.coax; coaxCtl.hidden = !st.coax;
    Object.assign(home, st.coax ? COAX_HOME : PAIR_HOME);
    mine.clear(); if (!st.coax) mine.add('field'); shown = mine; syncChips();
    // the other mode opens whole: its cut and explode back to none
    for (const k of stage.el.querySelectorAll<HTMLInputElement>('input[aria-label="Cutaway"], input[aria-label="Exploded view"]')) { k.value = '0'; k.dispatchEvent(new Event('input')); }
    repaint(); frameOn(['homebox']);
  });
  const rate = fieldRate(100e-6, 50);

  stage.slot.append(pairCtl, coaxCtl,
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, toggle, nbr, pause), h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Layers' }, ...chipBtns)));
  panel.append(
    h('h3', { class: 'm3-title' }, 'Why a pair is twisted'),
    h('p', { class: 'm3-sub' }, `Twisting does two jobs. The legs swap places every half twist, so an electric field from the side reaches both alike: common mode, which the receiver beside this panel rejects. A magnetic field through the loops induces dΦ/dt = A · dB/dt; each half twist turns a loop over and flips its sign, so as the field rises and falls the lenses go red and blue in turn and the beads, the charge each loop pushes, go opposite ways. Odd n sum to zero and the receiver stays dark; even n leave one loop, but only while the loops are equal: the unevenness slider leaves a residue, the widget’s leg mismatch. A real lay is about 8 to 25 mm per turn (example: 11.2 mm, patent EP1058275), ~${Math.round(halfTwistsPerMetre(LAY_A_MM))} half twists per metre where this draws up to 12; pairs in one sheath get different lays (${LAY_B_MM.toFixed(1)} mm here) so their twists do not mesh. 10 T/s is a teaching scale: 100 µT at 50 Hz is ${rate.toFixed(2)} T/s. A coax closes the loop in its shield only above the shield’s R/L corner, of order a kilohertz (Ott: 1 to 2 kHz); below it the return current takes the lowest-resistance path. The coaxes are stock Belden cables.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('h4', null, 'The cable ', h('span', { class: 'r3-badge' }, 'model')), kv, sum)));
  syncChips();
  readout();
  const ready = setInterval(() => { if (stage.studio() || stage.isFlat()) { clearInterval(ready); put(); loop.kick(); } }, 100);
  return { el: panel, destroy() { clearInterval(ready); loop.stop(); stage.destroy(); } };
}
