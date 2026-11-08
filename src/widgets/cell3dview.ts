// The standard cell of the layout step in 3D on the shared model stage (loaded on demand, modelhost.ts): the cell's
// layers from the well to metal 1, inputs that switch the transistors and colour the nets, and a section plane through
// a gate whose cut face shows the stack the next step builds: n+ | gate oxide | polysilicon | n+.

import '../styles/masks3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { CELL_LAYER_NAME, CELL_LAYERS, cellAnchors, cellParts, defaultCut, LAMBDA_NM, ROW_UM, sectionText, type CellLayer, type CellPalette, type CellState } from './cell3dparts';
import { modelStage } from './modelstage';
import { CELLS } from './silicon';

export function cellView(): Widget {
  // The layout step opens on NAND2 (the cell with series NMOS to point at).
  let cell = CELLS[1];
  const st: CellState = {
    ins: Object.fromEntries(cell.inputs.map((n) => [n, 1])), spread: 0.3, cut: null,
    show: Object.fromEntries(CELL_LAYERS.map((l) => [l, true])) as Record<CellLayer, boolean>,
  };
  const panel = h('div', { class: 'panel' });
  const iso = { target: [0, 3, 0] as [number, number, number], yaw: -0.7, pitch: 0.7, dist: 62 };
  const stage = modelStage(panel, {
    aria: 'A standard cell in 3D, layer by layer, with a section plane through a transistor gate',
    camera: iso,
    limits: { minDist: 18, maxDist: 160 },
    note: 'The footprint is to scale (1 λ = 62 nm); heights are exaggerated and the layers can be pulled apart. The oxide between licon1, li1 and met1 is not drawn.',
    draw,
  });
  const palette = (): CellPalette => ({
    psub: stage.rgb('--mk-psub'), nwell: stage.rgb('--mk-nwell'), sti: stage.rgb('--mk-sti'), ndiff: stage.rgb('--mk-ndiff'), pdiff: stage.rgb('--mk-pdiff'),
    poly: stage.rgb('--mk-poly'), gox: stage.rgb('--mk-gox'), licon: stage.rgb('--mk-contact'), li1: stage.rgb('--mk-li1'), mcon: stage.rgb('--mk-contact'),
    metal: stage.rgb('--mk-metal'), chanOn: stage.rgb('--mk-chan-on'),
  });
  function draw(): void { stage.paint(cellParts(cell, st, palette()), cellAnchors(cell, st)); }

  const info = h('p', { class: 'mk-read' });
  const verdict = h('p', { class: 'mk-verdict', 'aria-live': 'polite' });
  const readout = () => {
    const v = cell.eval(st.ins);
    info.replaceChildren(h('strong', null, cell.name), `: ${cell.transistors} transistors, ${cell.w} λ × 44 λ = ${cell.w * 44} λ²; here 1 λ = ${Math.round(LAMBDA_NM)} nm, which makes the 44 λ row sky130_fd_sc_hd’s ${ROW_UM} µm and this cell ${(cell.w * LAMBDA_NM / 1000).toFixed(2)} µm wide (nand2_1: 1.38 µm × 2.72 µm = 3.75 µm²). y = ${v.y}.`);
    verdict.textContent = st.cut === null ? 'Section plane off.' : sectionText(cell, st.cut);
  };

  const input = (label: string, min: number, max: number, step: number, val: number, text: (v: number) => string, on: (v: number) => void) => {
    const el = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, text(val));
    el.addEventListener('input', () => { out.textContent = text(Number(el.value)); on(Number(el.value)); });
    return { el, out, row: h('label', { class: 'r3-sl mk-wide' }, h('span', null, label), el, out) };
  };
  const spread = input('Pull apart', 0, 1, 0.05, st.spread, (v) => `${Math.round(v * 100)} %`, (v) => { st.spread = v; draw(); });
  const plane = input('Section plane', 0, 44, 0.5, defaultCut(cell), (v) => `y = ${v} λ`, (v) => { if (planeOn.checked) { st.cut = v; refresh(); } });
  const planeOn = h('input', { type: 'checkbox' }) as HTMLInputElement;
  plane.el.disabled = true;
  const setPlane = (on: boolean) => { planeOn.checked = on; st.cut = on ? Number(plane.el.value) : null; plane.el.disabled = !on; refresh(); };
  planeOn.addEventListener('change', () => setPlane(planeOn.checked));
  const refresh = () => { readout(); draw(); };

  const cellBtns = CELLS.map((c) => {
    const b = h('button', { type: 'button', class: `btn sm${c === cell ? ' primary' : ''}`, 'aria-pressed': String(c === cell) }, c.name) as HTMLButtonElement;
    b.addEventListener('click', () => {
      cell = c;
      st.ins = Object.fromEntries(c.inputs.map((n) => [n, 1]));
      st.cut = planeOn.checked ? defaultCut(c) : null;
      plane.el.value = String(defaultCut(c)); plane.out.textContent = `y = ${defaultCut(c)} λ`;
      cellBtns.forEach((x, i) => { x.classList.toggle('primary', CELLS[i] === c); x.setAttribute('aria-pressed', String(CELLS[i] === c)); });
      inputBtns();
      refresh();
    });
    return b;
  });
  const inputs = h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Inputs' });
  function inputBtns(): void {
    inputs.replaceChildren(...cell.inputs.map((n) => {
      const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(st.ins[n] === 1) }, `${n} = ${st.ins[n]}`) as HTMLButtonElement;
      b.addEventListener('click', () => { st.ins[n] ^= 1; inputBtns(); refresh(); });
      return b;
    }));
  }
  const toggles = h('div', { class: 'r3-btns mk-layers', role: 'group', 'aria-label': 'Layers shown' }, ...CELL_LAYERS.map((l) => {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = true;
    box.addEventListener('change', () => { st.show[l] = box.checked; refresh(); });
    return h('label', { class: 'lay-chk' }, box, CELL_LAYER_NAME[l]);
  }));
  const views = [
    { label: 'Iso', view: () => ({ ...iso, target: [...iso.target] as [number, number, number] }) },
    { label: 'Section', title: 'Cut the cell through a gate and look at the cut face', pick: () => setPlane(true), view: () => ({ target: [0, 0, 0] as [number, number, number], yaw: 0.15, pitch: 0.28, dist: 40 }) },
    { label: 'Top', title: 'Straight down: the layout step’s flat view', view: () => ({ target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: Math.PI / 2 - 0.02, dist: 66 }) },
  ];

  panel.append(
    h('h3', { class: 'm3-title' }, 'A standard cell, drawn in silicon'),
    h('p', { class: 'm3-sub' }, 'From the bottom: the substrate and the n-well (where the PMOS live) with oxide-filled trenches between devices, n+ and p+ diffusion sunk into the surface, polysilicon (a transistor is where poly crosses diffusion) over a thin gate oxide, then licon1 plugs up to the local interconnect li1, mcon plugs to metal 1. Bright is 1, dark is 0, faded is floating; a green channel conducts. Inputs enter on poly contacts; the n+ and p+ taps tie the substrate to GND and the well to VDD. Move the section plane through a gate and read the stack off the cut face.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Cell' }, ...cellBtns), inputs, stage.viewBar(views)),
        h('div', { class: 'r3-ctl' }, spread.row, h('label', { class: 'r3-sl mk-chk' }, planeOn, h('span', null, 'Cut the cell')), plane.row),
        toggles, stage.el, stage.hint, verdict, info)));
  inputBtns();
  readout();
  draw();
  return { el: panel, destroy: () => stage.destroy() };
}
