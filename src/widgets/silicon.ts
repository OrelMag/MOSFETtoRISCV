// Chapter 25 widgets: cell layout, fabrication, technology mapping, place & route, clock tree,
// floorplan and wafer economics. The numbers are computed from this site's own netlists.

import { FULL_ADDER, alu, counter, dataMemory, dualCore, rca, singleCycleCpu } from '../lib';
import { assemble } from '../riscv/asm';
import { MC_PROGRAMS } from '../riscv/mcprograms';
import { PROGRAMS } from '../riscv/programs';
import { Layout, problemOf, routeAll, SITE, type RouteResult } from '../sim/pnr';
import { stats } from '../sim/stats';
import { techMap } from '../sim/techmap';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const svgNS = 'http://www.w3.org/2000/svg';
const svgEl = (w: number, hgt: number, cls: string) => {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  s.setAttribute('class', cls);
  return s;
};
const panel = (title: string, sub: string, ...kids: (Node | string)[]) => h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, title), h('p', { class: 'sub' }, sub), ...kids));

// ---- standard-cell layout -------------------------------------------------------------------------

type Layer = 'nwell' | 'pdiff' | 'ndiff' | 'poly' | 'metal' | 'contact';
interface Shape { layer: Layer; r: [number, number, number, number]; node?: string; gate?: [string, 'p' | 'n'] }
interface Cell { name: string; w: number; inputs: string[]; shapes: Shape[]; eval: (v: Record<string, number>) => Record<string, number | 'z'>; transistors: number }

const rail = (w: number): Shape[] => [
  { layer: 'nwell', r: [0, 0, w, 22] },
  { layer: 'metal', r: [0, 0, w, 4], node: 'vdd' }, { layer: 'metal', r: [0, 40, w, 4], node: 'gnd' },
];
const C = (x: number, y: number): Shape => ({ layer: 'contact', r: [x, y, 2, 2] });

const CELLS: Cell[] = [
  {
    name: 'INV', w: 16, inputs: ['A'], transistors: 2,
    eval: ({ A }) => ({ vdd: 1, gnd: 0, y: A ? 0 : 1 }),
    shapes: [...rail(16),
      { layer: 'pdiff', r: [2, 8, 5, 8], node: 'vdd' }, { layer: 'pdiff', r: [9, 8, 5, 8], node: 'y' },
      { layer: 'ndiff', r: [2, 28, 5, 6], node: 'gnd' }, { layer: 'ndiff', r: [9, 28, 5, 6], node: 'y' },
      { layer: 'poly', r: [7, 6, 2, 30], node: 'A' }, { layer: 'poly', r: [2, 19, 7, 3], node: 'A' },
      { layer: 'pdiff', r: [7, 8, 2, 8], gate: ['A', 'p'] }, { layer: 'ndiff', r: [7, 28, 2, 6], gate: ['A', 'n'] },
      { layer: 'metal', r: [3, 0, 3, 14], node: 'vdd' }, { layer: 'metal', r: [3, 29, 3, 15], node: 'gnd' }, { layer: 'metal', r: [9.5, 10, 3, 24], node: 'y' },
      C(3.5, 11), C(10, 11), C(3.5, 30), C(10, 30)],
  },
  {
    name: 'NAND2', w: 24, inputs: ['A', 'B'], transistors: 4,
    eval: ({ A, B }) => ({ vdd: 1, gnd: 0, y: A && B ? 0 : 1, mid: A ? 0 : B ? (A && B ? 0 : 1) : 'z' }),
    shapes: [...rail(24),
      { layer: 'pdiff', r: [2, 8, 5, 8], node: 'vdd' }, { layer: 'pdiff', r: [9, 8, 6, 8], node: 'y' }, { layer: 'pdiff', r: [17, 8, 5, 8], node: 'vdd' },
      { layer: 'ndiff', r: [2, 28, 5, 6], node: 'gnd' }, { layer: 'ndiff', r: [9, 28, 6, 6], node: 'mid' }, { layer: 'ndiff', r: [17, 28, 5, 6], node: 'y' },
      { layer: 'poly', r: [7, 6, 2, 30], node: 'A' }, { layer: 'poly', r: [15, 6, 2, 30], node: 'B' },
      { layer: 'pdiff', r: [7, 8, 2, 8], gate: ['A', 'p'] }, { layer: 'pdiff', r: [15, 8, 2, 8], gate: ['B', 'p'] },
      { layer: 'ndiff', r: [7, 28, 2, 6], gate: ['A', 'n'] }, { layer: 'ndiff', r: [15, 28, 2, 6], gate: ['B', 'n'] },
      { layer: 'metal', r: [3, 0, 3, 14], node: 'vdd' }, { layer: 'metal', r: [18, 0, 3, 14], node: 'vdd' }, { layer: 'metal', r: [3, 29, 3, 15], node: 'gnd' },
      { layer: 'metal', r: [10.5, 10, 3, 15], node: 'y' }, { layer: 'metal', r: [10.5, 22, 10, 3], node: 'y' }, { layer: 'metal', r: [17.5, 22, 3, 12], node: 'y' },
      C(3.5, 11), C(11, 11), C(18.5, 11), C(3.5, 30), C(18.5, 30)],
  },
  {
    name: 'NOR2', w: 24, inputs: ['A', 'B'], transistors: 4,
    eval: ({ A, B }) => ({ vdd: 1, gnd: 0, y: A || B ? 0 : 1, mid: !A ? 1 : !B ? 0 : 'z' }),
    shapes: [...rail(24),
      { layer: 'pdiff', r: [2, 8, 5, 8], node: 'vdd' }, { layer: 'pdiff', r: [9, 8, 6, 8], node: 'mid' }, { layer: 'pdiff', r: [17, 8, 5, 8], node: 'y' },
      { layer: 'ndiff', r: [2, 28, 5, 6], node: 'gnd' }, { layer: 'ndiff', r: [9, 28, 6, 6], node: 'y' }, { layer: 'ndiff', r: [17, 28, 5, 6], node: 'gnd' },
      { layer: 'poly', r: [7, 6, 2, 30], node: 'A' }, { layer: 'poly', r: [15, 6, 2, 30], node: 'B' },
      { layer: 'pdiff', r: [7, 8, 2, 8], gate: ['A', 'p'] }, { layer: 'pdiff', r: [15, 8, 2, 8], gate: ['B', 'p'] },
      { layer: 'ndiff', r: [7, 28, 2, 6], gate: ['A', 'n'] }, { layer: 'ndiff', r: [15, 28, 2, 6], gate: ['B', 'n'] },
      { layer: 'metal', r: [3, 0, 3, 14], node: 'vdd' }, { layer: 'metal', r: [3, 29, 3, 15], node: 'gnd' }, { layer: 'metal', r: [18, 29, 3, 15], node: 'gnd' },
      { layer: 'metal', r: [17.5, 10, 3, 15], node: 'y' }, { layer: 'metal', r: [10.5, 22, 10, 3], node: 'y' }, { layer: 'metal', r: [10.5, 22, 3, 12], node: 'y' },
      C(3.5, 11), C(18.5, 11), C(3.5, 30), C(11, 30), C(18.5, 30)],
  },
];

/** A CMOS cell drawn layer by layer; inputs switch the transistors and colour the nodes. */
export function layoutWidget(): Widget {
  let cell = CELLS[1];
  const ins: Record<string, number> = { A: 1, B: 1 };
  const show: Record<Layer, boolean> = { nwell: true, pdiff: true, ndiff: true, poly: true, metal: true, contact: true };
  const box = h('div', { class: 'lay-box' });
  const info = h('div', { class: 'sub' });
  const ctl = h('div', { class: 'param-row' });
  const render = () => {
    const v = cell.eval(ins);
    const val = (n?: string) => (n === undefined ? undefined : n in ins ? ins[n] : v[n]);
    const svg = svgEl(cell.w + 8, 52, 'lay-svg');
    let s = '';
    const order: Layer[] = ['nwell', 'pdiff', 'ndiff', 'poly', 'metal', 'contact'];
    for (const L of order) {
      if (!show[L]) continue;
      for (const sh of cell.shapes.filter((x) => x.layer === L)) {
        const [x, y, w, hh] = sh.r;
        let cls = `L-${L}`;
        if (sh.gate) {
          if (!show.poly) continue;
          const on = sh.gate[1] === 'n' ? ins[sh.gate[0]] === 1 : ins[sh.gate[0]] === 0;
          s += `<rect x="${x + 4}" y="${y + 2}" width="${w}" height="${hh}" class="chan${on ? ' on' : ''}"><title>${sh.gate[1] === 'n' ? 'NMOS' : 'PMOS'} gate ${sh.gate[0]}: ${on ? 'conducting' : 'off'}</title></rect>`;
          continue;
        }
        const nv = val(sh.node);
        if (L !== 'nwell' && L !== 'contact') cls += nv === 1 ? ' v1' : nv === 0 ? ' v0' : nv === 'z' ? ' vz' : '';
        s += `<rect x="${x + 4}" y="${y + 2}" width="${w}" height="${hh}" class="${cls}"><title>${L}${sh.node ? ` · ${sh.node} = ${nv}` : ''}</title></rect>`;
      }
    }
    s += `<text x="${4 + 1}" y="${2 + 2.8}" class="lbl">VDD</text><text x="${4 + 1}" y="${2 + 42.8}" class="lbl">GND</text>`;
    cell.inputs.forEach((n, i) => (s += `<text x="${4 + 7 + 8 * i}" y="51" class="lbl">${n} = ${ins[n]}</text>`));
    s += `<text x="${4 + cell.w - 6}" y="${2 + 26.5}" class="lbl">y = ${v.y}</text>`;
    svg.innerHTML = s;
    box.replaceChildren(svg);
    info.textContent = `${cell.name}: ${cell.transistors} transistors, ${cell.w}λ × 44λ = ${cell.w * 44} λ². In SkyWater's 130 nm open process a NAND2 cell (sky130_fd_sc_hd__nand2_1) is 1.38 µm × 2.72 µm = 3.75 µm².`;
    ctl.replaceChildren(
      ...CELLS.map((c) => h('button', { class: `btn sm${c === cell ? ' primary' : ''}`, onclick: () => { cell = c; render(); } }, c.name)),
      ...cell.inputs.map((n) => h('button', { class: 'btn sm', onclick: () => { ins[n] ^= 1; render(); } }, `toggle ${n}`)),
      ...(['nwell', 'pdiff', 'ndiff', 'poly', 'metal', 'contact'] as Layer[]).map((L) => h('label', { class: 'lay-chk' },
        h('input', { type: 'checkbox', checked: show[L] ? '' : undefined, onchange: (e: Event) => { show[L] = (e.target as HTMLInputElement).checked; render(); } }), L)));
  };
  render();
  return { el: panel('A standard cell, drawn in silicon', 'Layers, bottom to top: n-well (where the PMOS live), p and n diffusion, polysilicon (where poly crosses diffusion there is a transistor), metal 1, and contacts joining metal to what is below. Bright = 1, dark = 0, hatched = floating. Green outline on a gate: the transistor conducts.', ctl, box, info) };
}

// ---- fabrication -------------------------------------------------------------------------------------

const FAB: [string, string][] = [
  ['Substrate', 'A polished wafer of lightly p-doped silicon, 300 mm across and under 1 mm thick, cut from a single crystal.'],
  ['N-well', 'Photoresist masks the wafer; phosphorus ions implanted into the exposed area make an n-type well where the PMOS transistors will live.'],
  ['Isolation', 'Shallow trenches are etched between transistors and filled with oxide (STI) so neighbouring devices cannot leak into each other.'],
  ['Gate stack', 'A gate dielectric a few atoms thick is grown, then polysilicon (or, today, metal) is deposited over the whole wafer.'],
  ['Lithography', 'Photoresist is spun on and exposed to deep-UV light through a mask (reticle), 4× reduced by the lens. The exposed resist dissolves in the developer.'],
  ['Etch', 'Plasma etching removes the gate material wherever the resist does not protect it; the resist is stripped. What remains are the gates.'],
  ['N+ implant', 'Arsenic or phosphorus implanted beside the NMOS gate forms its source and drain. The gate itself masks the channel, so the transistor is self-aligned.'],
  ['P+ implant', 'Boron implanted beside the PMOS gate, inside the n-well, forms the PMOS source and drain.'],
  ['Contacts', 'An insulating oxide covers everything; holes are etched down to the sources, drains and gates and filled with tungsten plugs.'],
  ['Metal', 'Copper wires (metal 1) connect the contacts. Ten or more metal layers follow, each insulated from the last and joined by vias: the routing.'],
];

export function fabWidget(): Widget {
  let step = 0;
  const box = h('div', { class: 'fab-box' });
  const text = h('div', { class: 'fab-text' });
  const prev = h('button', { class: 'btn sm' }, '◀ previous');
  const next = h('button', { class: 'btn sm primary' }, 'next ▶');
  const render = () => {
    const W = 600, H = 220, top = 120;
    const svg = svgEl(W, H, 'fab-svg');
    let s = `<rect x="0" y="${top}" width="${W}" height="${H - top}" class="si"/>`;
    if (step >= 1) s += `<rect x="320" y="${top}" width="260" height="70" class="nwell"/>`;
    if (step >= 2) for (const x of [10, 290, 570]) s += `<rect x="${x}" y="${top}" width="24" height="34" class="sti"/>`;
    const gates = [[140, 'n'], [440, 'p']] as const;
    if (step === 3 || step === 4) s += `<rect x="0" y="${top - 4}" width="${W}" height="4" class="gox"/><rect x="0" y="${top - 24}" width="${W}" height="20" class="poly"/>`;
    if (step === 4) {
      s += `<rect x="0" y="${top - 38}" width="${W}" height="14" class="resist"/>`;
      for (const [gx] of gates) s += `<rect x="${gx - 30}" y="${top - 38}" width="60" height="14" class="resist-hard"/>`;
      s += `<rect x="0" y="10" width="${W}" height="10" class="mask"/>${gates.map(([gx]) => `<rect x="${gx - 30}" y="10" width="60" height="10" class="mask-dark"/>`).join('')}`;
      for (let x = 30; x < W; x += 40) s += `<line x1="${x}" y1="24" x2="${x}" y2="${top - 44}" class="uv"/>`;
    }
    if (step >= 5) for (const [gx] of gates) s += `<rect x="${gx - 30}" y="${top - 4}" width="60" height="4" class="gox"/><rect x="${gx - 30}" y="${top - 24}" width="60" height="20" class="poly"/>`;
    if (step >= 6) for (const x of [60, 175]) s += `<rect x="${x}" y="${top}" width="60" height="18" class="nplus"/>`;
    if (step >= 7) for (const x of [360, 475]) s += `<rect x="${x}" y="${top}" width="60" height="18" class="pplus"/>`;
    if (step >= 8) {
      s += `<rect x="0" y="${top - 70}" width="${W}" height="46" class="ild"/>`;
      for (const x of [85, 140, 200, 385, 440, 500]) s += `<rect x="${x - 6}" y="${top - 70}" width="12" height="${x === 140 || x === 440 ? 46 : 70}" class="plug"/>`;
    }
    if (step >= 9) {
      s += `<rect x="70" y="${top - 86}" width="40" height="16" class="cu"/><rect x="185" y="${top - 86}" width="215" height="16" class="cu"/><rect x="480" y="${top - 86}" width="40" height="16" class="cu"/><rect x="125" y="${top - 86}" width="30" height="16" class="cu"/><rect x="425" y="${top - 86}" width="30" height="16" class="cu"/>`;
      s += `<rect x="0" y="${top - 112}" width="${W}" height="24" class="upper"/><text x="10" y="${top - 96}" class="lbl">metal 2 … 12 and vias</text>`;
    }
    s += `<text x="140" y="${H - 8}" text-anchor="middle" class="lbl">NMOS</text><text x="440" y="${H - 8}" text-anchor="middle" class="lbl">PMOS (in the n-well)</text>`;
    svg.innerHTML = s;
    box.replaceChildren(svg);
    text.replaceChildren(h('strong', null, `${step + 1}. ${FAB[step][0]}`), ' ', FAB[step][1]);
    (prev as HTMLButtonElement).disabled = step === 0;
    (next as HTMLButtonElement).disabled = step === FAB.length - 1;
  };
  prev.addEventListener('click', () => { step = Math.max(0, step - 1); render(); });
  next.addEventListener('click', () => { step = Math.min(FAB.length - 1, step + 1); render(); });
  render();
  return { el: panel('Making an inverter', 'A cross-section through one NMOS and one PMOS transistor, step by step (not to scale). A real process has hundreds of steps and 60 to 100 masks.', h('div', { class: 'param-row' }, prev, next), box, text) };
}

// ---- technology mapping --------------------------------------------------------------------------------

export function mappingWidget(): Widget {
  const body = h('tbody');
  const designs: [string, () => ComponentDef][] = [
    ['full adder', () => FULL_ADDER],
    ['32-bit ALU (fast)', () => alu(32, 'ks')],
    ['single-cycle RV32I', () => singleCycleCpu(assemble(PROGRAMS[0].source).words, { adder: 'ks' })],
    ['dual-core', () => dualCore(assemble(MC_PROGRAMS[0].source).words)],
  ];
  const btn = h('button', { class: 'btn sm primary' }, 'Map the designs');
  btn.addEventListener('click', () => {
    (btn as HTMLButtonElement).disabled = true;
    body.replaceChildren();
    let i = 0;
    const nextOne = () => {
      if (i >= designs.length) { btn.textContent = 'Done'; return; }
      const [name, mk] = designs[i++];
      const r = techMap(mk());
      body.append(h('tr', null, h('td', null, name), h('td', { class: 'num' }, r.nands.toLocaleString()), h('td', { class: 'num' }, r.inverters.toLocaleString()),
        h('td', { class: 'num' }, r.pairsRemoved.toLocaleString()), h('td', { class: 'num' }, r.nandTransistors.toLocaleString()), h('td', { class: 'num' }, r.mappedTransistors.toLocaleString()),
        h('td', { class: 'num' }, `${(100 * (1 - r.mappedTransistors / r.nandTransistors)).toFixed(1)} %`)));
      setTimeout(nextOne, 30);
    };
    setTimeout(nextOne, 30);
  });
  return {
    el: panel('Technology mapping, measured', 'Every NAND with both inputs tied is really an inverter: 2 transistors in a real library, not 4. Two inverters in a row cancel. A synthesis tool does much more (AND-OR-INVERT cells, sizing, restructuring); this is the first and simplest win.',
      btn, h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, 'design'), h('th', null, 'NANDs'), h('th', null, 'inverters'), h('th', null, 'pairs removed'), h('th', null, 'transistors (NAND only)'), h('th', null, 'mapped'), h('th', null, 'saved'))),
        body)),
  };
}

// ---- place & route --------------------------------------------------------------------------------------

export function pnrWidget(): Widget {
  const circuits: [string, () => ComponentDef][] = [['full adder (9 cells)', () => FULL_ADDER], ['4-bit adder (36 cells)', () => rca(4)], ['4-bit counter (80 cells)', () => counter(4)]];
  let lay = new Layout(problemOf(circuits[1][1]()));
  lay.randomize();
  let routed: RouteResult | null = null, shown = 0, anim: number | null = null;
  const box = h('div', { class: 'pnr-box' });
  const stat = h('div', { class: 'sub' });
  const stop = () => { if (anim) cancelAnimationFrame(anim); anim = null; };
  const draw = () => {
    const S = 8, W = lay.W * S, H = lay.H * S;
    const svg = svgEl(W, H, 'pnr-svg');
    let s = '';
    for (let i = 0; i < lay.cols * lay.rows; i++) { const [x, y] = lay.siteXY(i); s += `<rect x="${x * S}" y="${y * S}" width="${(SITE - 1) * S}" height="${(SITE - 1) * S}" class="site"/>`; }
    lay.site.forEach((st) => { const [x, y] = lay.siteXY(st); s += `<rect x="${(x + 0.5) * S}" y="${(y + 0.5) * S}" width="${3.5 * S}" height="${3 * S}" class="cell"/><text x="${(x + 2.2) * S}" y="${(y + 2.6) * S}" class="clbl">&amp;</text>`; });
    if (!routed) {
      for (const n of lay.prob.nets) { const ts = lay.terminals(n); for (let k = 1; k < ts.length; k++) s += `<line x1="${ts[0][0] * S + 4}" y1="${ts[0][1] * S + 4}" x2="${ts[k][0] * S + 4}" y2="${ts[k][1] * S + 4}" class="rat"/>`; }
    } else {
      let k = 0;
      for (const [, paths] of routed.paths) {
        if (k++ >= shown) break;
        for (const p of paths) for (let i = 1; i < p.length; i++) {
          const [x0, y0, l0] = p[i - 1], [x1, y1, l1] = p[i];
          if (l0 !== l1) s += `<rect x="${x0 * S + 2}" y="${y0 * S + 2}" width="4" height="4" class="via"/>`;
          else s += `<line x1="${x0 * S + 4}" y1="${y0 * S + 4}" x2="${x1 * S + 4}" y2="${y1 * S + 4}" class="m${l0}"/>`;
        }
      }
      for (const n of routed.failed) { const ts = lay.terminals(n); for (let j = 1; j < ts.length; j++) s += `<line x1="${ts[0][0] * S + 4}" y1="${ts[0][1] * S + 4}" x2="${ts[j][0] * S + 4}" y2="${ts[j][1] * S + 4}" class="fail"/>`; }
    }
    for (const n of lay.prob.nets) for (const [x, y] of lay.terminals(n)) s += `<circle cx="${x * S + 4}" cy="${y * S + 4}" r="2" class="pin"/>`;
    lay.prob.io.forEach((p, i) => { const [x, y] = lay.pinXY({ io: i }); s += `<text x="${p.side === 'L' ? x * S + 10 : x * S - 2}" y="${y * S + 7}" text-anchor="${p.side === 'L' ? 'start' : 'end'}" class="iol">${p.name}</text>`; });
    svg.innerHTML = s;
    box.replaceChildren(svg);
    stat.textContent = routed
      ? `Routed ${routed.paths.size} of ${lay.prob.nets.length} nets: ${routed.wirelength} track segments, ${routed.vias} vias${routed.failed.length ? `, ${routed.failed.length} failed (red)` : ''}. Blue: metal 1 (horizontal). Red: metal 2 (vertical). Squares: vias.`
      : `${lay.prob.cells.length} cells, ${lay.prob.nets.length} nets, half-perimeter wirelength ${lay.totalHpwl()}. The thin lines (the "ratsnest") show what must be connected.`;
  };
  const anneal = () => {
    stop(); routed = null;
    let T = 10;
    const tick = () => {
      lay.anneal(250, T);
      T *= 0.95;
      draw();
      if (T > 0.05) anim = requestAnimationFrame(tick);
    };
    anim = requestAnimationFrame(tick);
  };
  const doRoute = () => {
    stop();
    routed = routeAll(lay);
    shown = 0;
    const tick = () => { shown += Math.max(1, Math.ceil(routed!.paths.size / 60)); draw(); if (shown < routed!.paths.size) anim = requestAnimationFrame(tick); };
    anim = requestAnimationFrame(tick);
  };
  const sel = h('select', { 'aria-label': 'circuit' }) as HTMLSelectElement;
  circuits.forEach(([n], i) => sel.append(h('option', { value: String(i) }, n)));
  sel.value = '1';
  sel.addEventListener('change', () => { stop(); lay = new Layout(problemOf(circuits[Number(sel.value)][1]())); lay.randomize(); routed = null; draw(); });
  draw();
  return {
    el: panel('Place and route', 'Each NAND of the flattened netlist becomes a cell on a grid of sites. Placement: simulated annealing swaps cells, always accepting improvements and sometimes accepting worse moves (less often as the "temperature" falls), to shorten the wires. Routing: a maze router finds each connection on two metal layers, shortest nets first.',
      h('div', { class: 'param-row' }, sel,
        h('button', { class: 'btn sm', onclick: () => { stop(); lay.randomize(); routed = null; draw(); } }, 'Random placement'),
        h('button', { class: 'btn sm primary', onclick: anneal }, 'Anneal'),
        h('button', { class: 'btn sm primary', onclick: doRoute }, 'Route')),
      box, stat),
    destroy: stop,
  };
}

// ---- clock tree -----------------------------------------------------------------------------------------

export function clockTreeWidget(): Widget {
  let levels = 3;
  const box = h('div', { class: 'ct-box' });
  const info = h('div', { class: 'sub' });
  const render = () => {
    const W = 520;
    const svg = svgEl(W * 2 + 40, W, 'ct-svg');
    let s = '', sinks = 0, wire = 0;
    // H-tree on the left
    const H = (x: number, y: number, len: number, lvl: number) => {
      if (lvl === 0) { s += `<circle cx="${x}" cy="${y}" r="4" class="ff"/>`; sinks++; return; }
      s += `<line x1="${x - len}" y1="${y}" x2="${x + len}" y2="${y}" class="ht"/><line x1="${x - len}" y1="${y - len}" x2="${x - len}" y2="${y + len}" class="ht"/><line x1="${x + len}" y1="${y - len}" x2="${x + len}" y2="${y + len}" class="ht"/>`;
      wire += 6 * len;
      for (const dx of [-len, len]) for (const dy of [-len, len]) H(x + dx, y + dy, len / 2, lvl - 1);
    };
    H(W / 2, W / 2, W / 4, levels);
    // a single spine on the right: the same sinks, very different distances
    const n = 2 ** levels, pitch = W / n;
    let near = Infinity, far = 0;
    s += `<line x1="${W + 40 + W / 2}" y1="0" x2="${W + 40 + W / 2}" y2="${W}" class="sp"/>`;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = W + 40 + pitch * (i + 0.5), y = pitch * (j + 0.5);
      s += `<line x1="${W + 40 + W / 2}" y1="${y}" x2="${x}" y2="${y}" class="sp2"/><circle cx="${x}" cy="${y}" r="4" class="ff"/>`;
      const d = y + Math.abs(x - (W + 40 + W / 2));
      near = Math.min(near, d); far = Math.max(far, d);
    }
    s += `<text x="${W / 2}" y="${W - 4}" text-anchor="middle" class="lbl">H-tree</text><text x="${W + 40 + W / 2}" y="${W - 4}" text-anchor="middle" class="lbl">one spine from the top</text>`;
    svg.innerHTML = s;
    box.replaceChildren(svg);
    info.textContent = `${sinks} flip-flops. H-tree: every path from the root to a flip-flop has the same length, so the clock edge arrives everywhere at once (zero skew, ideally). Spine: the nearest flip-flop is ${Math.round(near)} units away, the farthest ${Math.round(far)}. That difference is skew, and it eats directly into the clock period.`;
  };
  const sl = h('input', { type: 'range', min: '1', max: '5', value: String(levels) }) as HTMLInputElement;
  sl.addEventListener('input', () => { levels = Number(sl.value); render(); });
  render();
  return { el: panel('Distributing the clock', 'One clock net reaches every flip-flop on the chip. Real clock trees add buffers at each branch and are balanced by tools; the H-tree shows the idea.', h('div', { class: 'param-row' }, h('span', null, 'levels'), sl), box, info) };
}

// ---- floorplan ---------------------------------------------------------------------------------------------

export function floorplanWidget(): Widget {
  const prog = assemble(MC_PROGRAMS[0].source).words;
  const core = stats(singleCycleCpu(prog, { shared: true, adder: 'ks' })).nands;
  const mem = stats(dataMemory(5)).nands;
  const total = stats(dualCore(prog)).nands;
  const nodes: [string, number][] = [['SkyWater 130 nm (open source)', 3.75], ['28 nm (approximate)', 0.3], ['5 nm (approximate)', 0.03]];
  let node = 0, sram = false;
  const box = h('div', { class: 'fp-box' });
  const info = h('div', { class: 'sub' });
  const render = () => {
    const a = nodes[node][1];               // µm² per NAND2
    const util = 0.7;
    const bitArea = a * 0.6;                // a 6T SRAM bit is a little smaller than a NAND2 cell
    const memArea = sram ? 32 * 32 * bitArea * 1.3 : mem * a / util;
    const coreArea = core * a / util;
    const logic = 2 * coreArea + memArea + (total - 2 * core - mem) * a / util;
    const side = Math.sqrt(logic);           // µm
    const pad = 60, pads = 40, perSide = pads / 4;
    const padSide = perSide * pad;           // the pad ring sets a minimum die edge
    const die = Math.max(side + 2 * pad, padSide + 2 * pad);
    const S = 420 / die;
    const svg = svgEl(440, 440, 'fp-svg');
    let s = `<rect x="10" y="10" width="${die * S}" height="${die * S}" class="die"/>`;
    for (let k = 0; k < perSide; k++) for (let side4 = 0; side4 < 4; side4++) {
      const t = 10 + pad * S + (k + 0.5) * ((die - 2 * pad) / perSide) * S;
      const [x, y] = side4 === 0 ? [t, 10] : side4 === 1 ? [10 + (die - pad) * S, t] : side4 === 2 ? [t, 10 + (die - pad) * S] : [10, t];
      s += `<rect x="${side4 % 2 ? x : x - pad * S * 0.35}" y="${side4 % 2 ? y - pad * S * 0.35 : y}" width="${side4 % 2 ? pad * S : pad * S * 0.7}" height="${side4 % 2 ? pad * S * 0.7 : pad * S}" class="pad"/>`;
    }
    const cx = 10 + (die / 2 - side / 2) * S, cy = 10 + (die / 2 - side / 2) * S, cs = side * S;
    const f0 = coreArea / logic, f1 = memArea / logic;
    s += `<rect x="${cx}" y="${cy}" width="${cs * f0}" height="${cs}" class="blk c0"/><text x="${cx + cs * f0 / 2}" y="${cy + cs / 2}" text-anchor="middle" class="blbl">core 0</text>`;
    s += `<rect x="${cx + cs * f0}" y="${cy}" width="${cs * f0}" height="${cs}" class="blk c1"/><text x="${cx + cs * f0 * 1.5}" y="${cy + cs / 2}" text-anchor="middle" class="blbl">core 1</text>`;
    s += `<rect x="${cx + 2 * cs * f0}" y="${cy}" width="${cs * f1}" height="${cs}" class="blk mem"/><text x="${cx + cs * (2 * f0 + f1 / 2)}" y="${cy + cs / 2 + 14}" text-anchor="middle" class="blbl">mem</text>`;
    svg.innerHTML = s;
    box.replaceChildren(svg);
    const mm = (u: number) => (u / 1000).toFixed(u > 3000 ? 1 : 2);
    info.textContent = `${total.toLocaleString()} NAND equivalents (each core ${core.toLocaleString()} including its program ROM as a multiplexer tree, memory ${mem.toLocaleString()} as flip-flops). Logic area at ${(util * 100).toFixed(0)} % utilization: ${mm(side)} mm × ${mm(side)} mm. With ${pads} bond pads of ${pad} µm the die is ${mm(die)} mm on a side${padSide > side ? ': pad-limited, the I/O ring is bigger than the logic it serves' : ''}. For scale: Caravel's user area on the open-source SkyWater shuttles is 2.92 × 3.52 mm; a modern laptop SoC is over 100 mm² with ~10¹⁰ transistors.`;
  };
  const nsel = h('select', { 'aria-label': 'process' }) as HTMLSelectElement;
  nodes.forEach(([n], i) => nsel.append(h('option', { value: String(i) }, n)));
  nsel.addEventListener('change', () => { node = Number(nsel.value); render(); });
  const chk = h('label', { class: 'lay-chk' }, h('input', { type: 'checkbox', onchange: (e: Event) => { sram = (e.target as HTMLInputElement).checked; render(); } }), 'memory as an SRAM macro');
  render();
  return { el: panel('Floorplan of our dual-core', 'Areas come from the NAND counts of this site\'s own netlists, times the area of a NAND2 cell in the chosen process.', h('div', { class: 'param-row' }, nsel, chk), box, info) };
}

// ---- wafer, dies and yield ------------------------------------------------------------------------------------

export function waferWidget(): Widget {
  let dieW = 10, dieH = 10, d0 = 0.1, cost = 17000;
  const D = 300;
  const box = h('div', { class: 'wf-box' });
  const info = h('div', { class: 'sub' });
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const render = () => {
    seed = 3;
    const A = dieW * dieH; // mm²
    const S = 400 / D;
    const svg = svgEl(410, 410, 'wf-svg');
    let s = `<circle cx="205" cy="205" r="${(D / 2) * S}" class="wafer"/>`;
    let gross = 0, good = 0;
    const yieldP = Math.exp(-(A / 100) * d0); // Poisson, D0 per cm²
    for (let y = -D / 2; y < D / 2; y += dieH) for (let x = -D / 2; x < D / 2; x += dieW) {
      const corners = [[x, y], [x + dieW, y], [x, y + dieH], [x + dieW, y + dieH]];
      if (corners.some(([cx, cy]) => cx * cx + cy * cy > (D / 2 - 3) ** 2)) continue;
      gross++;
      const ok = rnd() < yieldP;
      if (ok) good++;
      s += `<rect x="${205 + x * S}" y="${205 + y * S}" width="${dieW * S - 0.6}" height="${dieH * S - 0.6}" class="${ok ? 'good' : 'bad'}"/>`;
    }
    svg.innerHTML = s;
    box.replaceChildren(svg);
    info.textContent = `${gross} whole dies of ${A} mm² on a 300 mm wafer. Expected yield e^(−A·D₀) = ${(yieldP * 100).toFixed(1)} % (Poisson model, ${d0} defects/cm²), so about ${Math.round(gross * yieldP)} good dies (this wafer: ${good}). At $${cost.toLocaleString()} per processed wafer: $${(cost / Math.max(1, gross * yieldP)).toFixed(2)} per good die, before testing and packaging. Yield falls exponentially with area: big dies are disproportionately expensive, which is why large designs are split into chiplets.`;
  };
  const slider = (label: string, min: number, max: number, step: number, val: number, on: (v: number) => void, unit: string) => {
    const i = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val) }) as HTMLInputElement;
    const v = h('span', { class: 'num' }, `${val} ${unit}`);
    i.addEventListener('input', () => { on(Number(i.value)); v.textContent = `${i.value} ${unit}`; render(); });
    return h('label', { class: 'cx-field' }, h('span', null, label), i, v);
  };
  render();
  return {
    el: panel('Wafers, dies and yield', 'Every chip is cut from a wafer; random defects kill some of them.',
      h('div', { class: 'cx-controls' },
        slider('die width', 1, 30, 0.5, dieW, (v) => (dieW = v), 'mm'), slider('die height', 1, 30, 0.5, dieH, (v) => (dieH = v), 'mm'),
        slider('defect density', 0.01, 1, 0.01, d0, (v) => (d0 = v), '/cm²'), slider('wafer cost', 2000, 25000, 500, cost, (v) => (cost = v), '$')),
      box, info),
  };
}
