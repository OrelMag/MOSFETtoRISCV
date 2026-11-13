// The standard cell of the layout step on the studio renderer (loaded on demand, modelhost.ts): the cell in true
// geometry and true thickness above the silicon (cell3dkit.ts), its inputs switching the transistors and colouring
// the nets, the charge that moves through the conducting channels when the output switches, a cut through a gate
// (the stage's Cutaway), the films pulled apart (Explode), the oxide between them and the neighbours in its row as
// layers, and a tour.

import '../styles/masks3d.css';
import { packInstances, type RGB } from '../gl/instances';
import { sphere } from '../gl/kit/geo';
import { fitView } from '../gl/kit/scene';
import { M } from '../gl/kit/materials';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { LAMBDA_NM, ROW_UM, sectionText, defaultCut, type CellPalette } from './cell3dparts';
import { BEAT_LAYERS, DRAWN, FRAME_GROUPS, HOME, PDK, carriers, cellModel, heights, lanes, type CellLayer, type Lane } from './cell3dkit';
import { CELLS } from './silicon';
import { studioStage, type StudioStage } from './studiostage';

const BEAD = sphere(0.8, 10, 6);
const BURST_MS = 2200;
const FALLBACK: CellPalette = {
  psub: [0.55, 0.5, 0.6], nwell: [0.4, 0.55, 0.7], sti: [0.75, 0.82, 0.9], ndiff: [0.85, 0.35, 0.3], pdiff: [0.35, 0.6, 0.35], poly: [0.85, 0.3, 0.3],
  gox: [0.8, 0.85, 0.95], licon: [0.5, 0.5, 0.5], li1: [0.6, 0.55, 0.7], mcon: [0.5, 0.5, 0.5], metal: [0.6, 0.65, 0.75], chanOn: [0.3, 0.9, 0.5],
};

export function cellView(): Widget {
  // The layout step opens on NAND2 (the cell with series NMOS to point at).
  let cell = CELLS[1];
  let ins: Record<string, number> = Object.fromEntries(cell.inputs.map((n) => [n, 1]));
  const mine = new Set<CellLayer>(['metal']);
  let shown: ReadonlySet<CellLayer> = mine, stageRef: StudioStage | null = null;
  const pal = (): CellPalette => {
    const s = stageRef;
    if (!s) return FALLBACK;
    return {
      psub: s.rgb('--mk-psub'), nwell: s.rgb('--mk-nwell'), sti: s.rgb('--mk-sti'), ndiff: s.rgb('--mk-ndiff'), pdiff: s.rgb('--mk-pdiff'),
      poly: s.rgb('--mk-poly'), gox: s.rgb('--mk-gox'), licon: s.rgb('--mk-contact'), li1: s.rgb('--mk-li1'), mcon: s.rgb('--mk-contact'),
      metal: s.rgb('--mk-metal'), chanOn: s.rgb('--mk-chan-on'),
    };
  };
  const z = heights();
  const stage = studioStage({
    aria: 'A standard cell in 3D, layer by layer: silicon with its well and trenches, diffusion, gate oxide and polysilicon, the contact stack up to metal 1; a cut through a transistor gate',
    home: HOME,
    homeFrame: ['cellbox'],
    hidden: [...FRAME_GROUPS],
    limits: { minDist: 10, maxDist: 400, maxPan: 120 },
    onBeat: (i) => { shown = i >= 0 ? new Set(BEAT_LAYERS[i] ?? []) : mine; syncChips(); stage.refresh(); },
    note: `The footprint is the layout step's cell at 1 λ = ${Math.round(LAMBDA_NM)} nm (the 44 λ row is sky130's ${ROW_UM} µm); the films above the silicon are the SkyWater PDK's thicknesses (poly ${PDK.poly} µm, li1 ${PDK.li1} µm, met1 ${PDK.met1} µm), the gate oxide ${DRAWN.goxScale}× thicker than its ${PDK.gox * 1000} nm so it shows, the trench depth and the gap under metal 1 illustrative. Net colours: bright is 1, dark is 0. The charge that moves when the output switches is drawn as beads, not to scale.`,
    build: (detail) => cellModel(cell, { detail, ins, layers: shown, pal: pal() }),
  });
  stageRef = stage;

  // ---------------------------------------------------------------- the charge that moves when the output switches

  let burst: { lanes: Lane[]; t0: number } | null = null, raf = 0;
  const NONE = new Float32Array(0), beadMat = M.beam([0, 0, 0], 1, 'carriers (drawn)');
  const putCarriers = (k: number | null) => {
    if (stage.isFlat()) return;
    if (k === null || !burst) { stage.instances('carriers', BEAD, beadMat, NONE); return; }
    const c = (t: string): RGB => stage.rgb(t);
    stage.instances('carriers', BEAD, beadMat, packInstances(carriers(cell, burst.lanes, k, { e: c('--mk-ndiff'), h: c('--mk-pdiff') })));
  };
  const tick = (now: number) => {
    raf = 0;
    if (!burst) return;
    const k = (now - burst.t0) / BURST_MS;
    if (k >= 1) { burst = null; putCarriers(null); return; }
    putCarriers(k);
    raf = requestAnimationFrame(tick);
  };

  // ---------------------------------------------------------------- readouts and controls

  const info = h('p', { class: 'mk-read' }), verdict = h('p', { class: 'mk-verdict', 'aria-live': 'polite' }), kv = h('div', { class: 'r3-kv' });
  const readout = () => {
    const v = cell.eval(ins), um = (l: number) => ((l * LAMBDA_NM) / 1000).toFixed(2);
    info.replaceChildren(h('strong', null, cell.name), `: ${cell.transistors} transistors; y = ${v.y}.`);
    verdict.textContent = `With the cut open: ${sectionText(cell, defaultCut(cell))}`;
    const rows: [string, string][] = [
      ['Cell', `${cell.w} λ × 44 λ`], ['Size', `${um(cell.w)} × ${ROW_UM} µm`], ['1 λ', `${Math.round(LAMBDA_NM)} nm`],
      ['Stack to metal 1', `${um(z.met1)} µm`], ['Poly', `${PDK.poly} µm`], ['Gate oxide', `${PDK.gox * 1000} nm (drawn ×${DRAWN.goxScale})`],
      ['li1 / met1', `${PDK.li1} / ${PDK.met1} µm`], ['n-well', `${PDK.nwell} µm deep`], ['nand2_1 (sky130)', '1.38 µm × 2.72 µm'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
  };
  const refresh = () => { readout(); stage.refresh(); };

  const cellBtns = CELLS.map((c) => {
    const b = h('button', { type: 'button', class: `btn sm${c === cell ? ' primary' : ''}`, 'aria-pressed': String(c === cell) }, c.name) as HTMLButtonElement;
    b.addEventListener('click', () => {
      cell = c;
      ins = Object.fromEntries(c.inputs.map((n) => [n, 1]));
      burst = null; putCarriers(null);
      cellBtns.forEach((x, i) => { x.classList.toggle('primary', CELLS[i] === c); x.setAttribute('aria-pressed', String(CELLS[i] === c)); });
      inputBtns(); refresh();
    });
    return b;
  });
  const inputs = h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Inputs' });
  function inputBtns(): void {
    inputs.replaceChildren(...cell.inputs.map((n) => {
      const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(ins[n] === 1) }, `${n} = ${ins[n]}`) as HTMLButtonElement;
      b.addEventListener('click', () => {
        const before = cell.eval(ins).y;
        ins = { ...ins, [n]: ins[n] ^ 1 };
        // the output switched: its charge runs through the channels now on, for a moment (static CMOS draws none at rest)
        if (cell.eval(ins).y !== before && !reducedMotion()) { burst = { lanes: lanes(cell, ins), t0: performance.now() }; if (!raf) raf = requestAnimationFrame(tick); }
        inputBtns(); refresh();
      });
      return b;
    }));
  }
  const toggle = (b: HTMLButtonElement, on: boolean) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  const CHIPS: [CellLayer, string, string][] = [
    ['metal', 'Metal 1', 'Metal 1 and its plugs (off: look down onto li1, poly and the transistors)'],
    ['ild', 'Oxide between', 'The silicon dioxide that fills every gap between the films (translucent)'],
    ['row', 'Neighbours', 'The cell with its neighbours in the row: the rails and the n-well run through'],
  ];
  const chipBtns = CHIPS.map(([k, label, title]) => {
    const b = h('button', { type: 'button', class: 'btn sm', title, 'aria-pressed': 'false' }, label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      if (shown !== mine) { mine.clear(); for (const l of shown) mine.add(l); }
      if (mine.has(k)) mine.delete(k); else mine.add(k);
      shown = mine; syncChips(); stage.refresh();
    });
    return b;
  });
  // the layout as drawn: straight down onto the cell, VDD at the top
  const topBtn = h('button', { type: 'button', class: 'btn sm', title: 'Look straight down: the flat layout' }, 'Top view') as HTMLButtonElement;
  topBtn.addEventListener('click', () => {
    const st = stage.studio(), cv = stage.el.querySelector('canvas');
    if (!st || !cv) return;
    const pitch = 1.5, f = fitView({ min: [-cell.w / 2, 0, -22], max: [cell.w / 2, z.met1, 22] }, 0, pitch, st.camera.fov, cv.clientWidth / Math.max(1, cv.clientHeight), 0.06);
    const c = st.camera;
    c.target = f.target; c.yaw = 0; c.pitch = pitch; c.dist = f.dist;
    st.invalidate();
  });
  function syncChips(): void { chipBtns.forEach((b, i) => toggle(b, shown.has(CHIPS[i][0]))); }

  stage.slot.append(
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Cell' }, ...cellBtns), inputs),
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns mk-layers', role: 'group', 'aria-label': 'Layers' }, ...chipBtns, topBtn)),
    verdict, info);
  const el = h('div', { class: 'r3 cell3d' },
    h('div', { class: 'r3-main' }, stage.el),
    h('div', { class: 'r3-side' }, h('h4', null, 'This cell ', h('span', { class: 'r3-badge' }, 'sky130 scale')), kv));
  syncChips(); inputBtns(); readout();
  const ready = setInterval(() => { if (stage.studio() || stage.isFlat()) { clearInterval(ready); stage.refresh(); } }, 100);
  return { el, destroy() { clearInterval(ready); cancelAnimationFrame(raf); stage.destroy(); } };
}
