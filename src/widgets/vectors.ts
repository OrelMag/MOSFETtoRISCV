// The Vectors chapter's widgets. Every number is computed: by the RVV rules (riscv/rvv.ts), by the golden model run
// at several VLENs (ISS({ v })), by the timing model (riscv/vecmodel.ts), or from the measured machines in
// bench/vectorcosts.json (recomputed by tests/vectors-chapter.test.ts). The Vector panel reads the gate-level unit.

import type { VectorCosts } from '../bench/vectorcosts';
import costs from '../bench/vectorcosts.json';
import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { CHAIN_KERNEL, chainTimes, type ChainMode } from '../riscv/vecmodel';
import { SCALAR_ROLES, STRIP_MINE } from '../riscv/vecprograms';
import { groupDigits } from '../sim/numfmt';
import { PS_PER_NAND } from '../sim/timing';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import { vecView } from './vecview';
import '../styles/vectors.css';

export const VEC = costs as VectorCosts;
export const machine = (id: VectorCosts['machines'][number]['id']) => VEC.machines.find((m) => m.id === id)!;

const num = (n: number) => groupDigits(Math.round(n));
const panel = (title: string, sub: string, ...kids: (Node | string)[]): Widget => ({ el: h('div', { class: 'widget' }, h('div', { class: 'panel vec-widget' }, h('h3', null, title), h('p', { class: 'sub' }, sub), ...kids)) });
/** A row of toggle buttons; `on` is called with the picked value. */
function seg<T extends string | number>(label: string, values: readonly T[], cur: T, on: (v: T) => void, text: (v: T) => string = String): HTMLElement {
  const btns = values.map((v) => {
    const b = h('button', { class: `btn sm${v === cur ? ' on' : ''}`, 'aria-pressed': String(v === cur) }, text(v));
    b.addEventListener('click', () => { for (const x of btns) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); } on(v); });
    return b;
  });
  return h('div', { class: 'vec-seg', role: 'group', 'aria-label': label }, h('span', { class: 'vec-lbl' }, label), ...btns);
}
function slider(label: string, min: number, max: number, value: number, on: (v: number) => void): HTMLElement {
  const out = h('b', null, String(value));
  const inp = h('input', { type: 'range', min: String(min), max: String(max), value: String(value), 'aria-label': label }) as HTMLInputElement;
  inp.addEventListener('input', () => { out.textContent = inp.value; on(Number(inp.value)); });
  return h('label', { class: 'vec-slider' }, h('span', { class: 'vec-lbl' }, label), inp, out);
}

/** Step 0: what the scalar loop spends its instructions on, and the kernel on the four machines in cycles. */
export function kernelWidget(): Widget {
  const per = SCALAR_ROLES.reduce((a, r) => a + r.n, 0);
  const ROLE: Record<string, string> = { work: 'work: 2·x, + x, + y', memory: 'loads and the store', address: 'the address', loop: 'counter and branch' };
  const bar = h('div', { class: 'vec-roles', role: 'img', 'aria-label': `${per} instructions per element: ${SCALAR_ROLES.map((r) => `${r.n} ${r.role}`).join(', ')}` },
    ...SCALAR_ROLES.map((r, i) => h('div', { class: `vec-role r${i}`, style: `flex:${r.n}` }, h('b', null, String(r.n)), h('span', null, ROLE[r.role]))));
  const sc = machine('scalar'), v = machine('vector');
  return panel('One element at a time', `The scalar loop does ${per} instructions for every element, of which ${SCALAR_ROLES[0].n} compute.`,
    bar,
    h('p', { class: 'vec-note' }, `16 elements on the single-cycle CPU: ${sc.instrs} instructions, ${sc.cycles} cycles (the initialisation included). The same kernel on the vector unit later in this chapter: ${v.instrs} instructions, ${v.cycles} cycles.`));
}

/** Step 1: a packed-SIMD loop of fixed width, its scalar tail, and the rebuild a wider machine needs. */
export function simdTailWidget(): Widget {
  let n = 37, w = 4;
  const strip = h('div', { class: 'vec-strip', role: 'img' });
  const note = h('p', { class: 'vec-note' });
  const draw = () => {
    const trips = Math.floor(n / w), tail = n % w;
    strip.setAttribute('aria-label', `${n} elements: ${trips} trips of the ${w}-wide loop, ${tail} of the scalar tail loop`);
    strip.replaceChildren(...Array.from({ length: n }, (_, e) => h('i', { class: e < trips * w ? `m${Math.floor(e / w) % 2}` : 'tail', title: e < trips * w ? `element ${e}: trip ${Math.floor(e / w) + 1} of the ${w}-wide loop` : `element ${e}: the scalar tail loop` })));
    note.replaceChildren(`${trips} trip${trips === 1 ? '' : 's'} of the ${w}-wide loop, then ${tail} trip${tail === 1 ? '' : 's'} of a scalar tail loop: ${Math.round((100 * tail) / n)} % of the elements at a quarter${w === 8 ? ' of an eighth' : ''} of the speed. `,
      h('b', null, w === 4 ? 'This binary uses 128-bit registers only; ' : 'This needs another build, with 256-bit instructions; '),
      w === 4 ? 'a machine with 256-bit registers runs it at half its width.' : 'the 128-bit build still runs, at half the width.');
  };
  draw();
  return panel('Fixed width, and its tail', 'Packed SIMD (SSE, Neon): the width is in the opcode.',
    h('div', { class: 'vec-ctl' }, slider('n', 1, 64, n, (v) => { n = v; draw(); }), seg('register', [4, 8], w, (v) => { w = v; draw(); }, (v) => `${32 * v}-bit`)),
    strip, note);
}

/** Run the strip-mining loop on the golden model at a VLEN: passes (vsetvli executed) and instructions retired. */
export function stripRun(n: number, vlen: number, lmul: number): { passes: number[]; instrs: number } {
  const src = `li a0, ${n}\nli a1, 0\nli a2, 512\n${STRIP_MINE.replace('e32, m1', `e32, m${lmul}`)}\nhalt: j halt`;
  const iss = new ISS(assemble(src).words, { v: { vlen }, dmemWords: 256, imemWords: 64 });
  const passes: number[] = [];
  while (!iss.halted && iss.steps < 10_000) {
    const info = iss.step();
    if (/^vsetvli/.test(info.text)) passes.push(iss.vl);
  }
  return { passes, instrs: iss.steps };
}

/** Step 2: vsetvli's answer pass by pass, for any n, VLEN and LMUL; and one binary run at three VLENs. */
export function stripMineWidget(): Widget {
  let n = 37, vlen = 128, lmul = 1;
  const list = h('div', { class: 'vec-passes' });
  const sum = h('p', { class: 'vec-note' });
  const three = h('div', { class: 'vec-three' });
  const draw = () => {
    const vlmax = (lmul * vlen) / 32;
    const r = stripRun(n, vlen, lmul);
    list.setAttribute('aria-label', `${r.passes.length} passes: ${r.passes.join(', ')}`);
    list.replaceChildren(...r.passes.map((vl, p) => h('div', { class: 'vec-pass' }, h('span', { class: 'vec-lbl' }, `pass ${p + 1}`),
      h('span', { class: 'vec-cells' }, ...Array.from({ length: vlmax }, (_, j) => h('i', { class: j < vl ? `l${j % 4}` : 'off', title: j < vl ? `element ${p * vlmax + j}` : 'not used: vl ends here' }))),
      h('span', { class: 'vec-vl' }, `vl = ${vl}`))));
    sum.textContent = `VLMAX = LMUL · VLEN / SEW = ${lmul} · ${vlen} / 32 = ${vlmax}: ${r.passes.length} passes, ${r.instrs} instructions for ${n} elements. Colours: the lane each element goes to on a four-lane unit.`;
    three.replaceChildren(h('span', { class: 'vec-lbl' }, 'The same words on three machines:'), ...[128, 256, 512].map((L) => {
      const q = stripRun(n, L, lmul);
      return h('span', { class: `vec-chip${L === vlen ? ' on' : ''}` }, `VLEN ${L}: ${q.passes.length} passes, ${q.instrs} instructions`);
    }));
  };
  draw();
  return panel('The length in a register', 'vsetvli t0, a0, e32, m1: “I have a0 elements; how many this pass?” The answer, vl, goes to t0.',
    h('div', { class: 'vec-ctl' }, slider('n', 1, 100, n, (v) => { n = v; draw(); }), seg('VLEN', [128, 256, 512], vlen, (v) => { vlen = v; draw(); }), seg('LMUL', [1, 2, 4, 8], lmul, (v) => { lmul = v; draw(); })),
    list, sum, three);
}

/** Step 3: the register file as 32 rows of 128 bits in four lane slices; SEW cuts a row, LMUL groups rows. */
export function vrfWidget(): Widget {
  let sew = 32, lmul = 4, reg = 8, lane = 0;
  const grid = h('div', { class: 'vrf-grid' });
  const cap = h('p', { class: 'vec-note', 'aria-live': 'polite' });
  const regSel = h('select', { 'aria-label': 'register' }, ...Array.from({ length: 32 }, (_, r) => h('option', { value: String(r) }, `v${r}`))) as HTMLSelectElement;
  regSel.value = String(reg);
  regSel.addEventListener('change', () => { reg = Number(regSel.value); draw(); });
  const lanePick = seg('lane', [0, 1, 2, 3], lane, (v) => { lane = v; draw(); });
  lanePick.classList.add('vrf-lanepick');
  const draw = () => {
    const legal = reg % lmul === 0, per = 32 / sew, perRow = 128 / sew, vlmax = lmul * perRow;
    grid.replaceChildren(h('span', { class: 'vrf-h' }), ...[0, 1, 2, 3].map((s) => h('span', { class: `vrf-h lane${s === lane ? ' on' : ''}` }, `lane ${s}`)));
    for (let r = 0; r < 32; r++) {
      const inGroup = legal && r >= reg && r < reg + lmul;
      grid.append(h('span', { class: `vrf-r${inGroup ? ' in' : ''}` }, `v${r}`));
      for (let s = 0; s < 4; s++) {
        const cell = h('span', { class: `vrf-c lane${s === lane ? ' on' : ''}${inGroup ? ` g l${s}` : ''}` });
        if (inGroup) for (let k = 0; k < per; k++) cell.append(h('i', null, String((r - reg) * perRow + s * per + k)));
        else if (r === 0 && reg !== 0) cell.append(h('i', { class: 'mask' }, 32 * s < vlmax ? `mask bits ${32 * s}–${Math.min(vlmax, 32 * s + 32) - 1}` : '·'));
        grid.append(cell);
      }
    }
    cap.replaceChildren(...(legal
      ? [h('b', null, `v${reg}`), ` at e${sew}, m${lmul} is ${lmul > 1 ? `v${reg}–v${reg + lmul - 1}` : `v${reg} alone`}: ${vlmax} elements of ${sew} bits, ${perRow} a row, ${per} in each lane's slice of a row. A four-lane unit takes ${lmul} beat${lmul > 1 ? 's' : ''} over it. Row v0, the mask: bit e enables element e${vlmax <= 32 ? `, so at most ${vlmax} bits, all in lane 0's slice` : ''}.`]
      : [h('b', { class: 'bad' }, `v${reg} is refused at m${lmul}`), `: a group of ${lmul} registers must start on a multiple of ${lmul} (v${reg - (reg % lmul)} or v${reg - (reg % lmul) + lmul}). The instruction is illegal.`]));
  };
  draw();
  return panel('Thirty-two registers, regrouped', 'VLEN 128, four lanes: each lane holds a 32-bit slice of every register.',
    h('div', { class: 'vec-ctl' }, seg('SEW', [8, 16, 32], sew, (v) => { sew = v; draw(); }), seg('LMUL', [1, 2, 4, 8], lmul, (v) => { lmul = v; draw(); }), h('label', { class: 'vec-seg' }, h('span', { class: 'vec-lbl' }, 'register'), regSel), lanePick),
    h('div', { class: 'vrf-wrap' }, grid), cap);
}

const UNIT_LABEL: Record<string, string> = { load: 'load', shift: 'shift', add: 'add', store: 'store' };
/** Step 8: the kernel's loop body on three machines: one instruction at a time, separate units, and chaining. */
export function chainWidget(): Widget {
  let groups = 8;
  const rows = h('div', { class: 'vec-chain' });
  const MODES: [ChainMode, string][] = [['serial', 'One at a time (our unit)'], ['units', 'Separate units, no chaining'], ['chained', 'Chained (Cray-1, 1976)']];
  const draw = () => {
    rows.replaceChildren(...MODES.map(([mode, title]) => {
      const t = chainTimes(CHAIN_KERNEL, groups, mode);
      const cells = h('div', { class: 'vec-tl', style: `--cols:${t.total}` });
      CHAIN_KERNEL.forEach((ins, i) => {
        cells.append(h('span', { class: 'vec-tl-n', title: ins.text }, ins.text.split(' ')[0]));
        const row = h('span', { class: 'vec-tl-row' });
        t.start[i].forEach((c, g) => row.append(h('i', { class: `u-${ins.unit}`, style: `grid-column:${c + 1}`, title: `${ins.text}: element group ${g} in cycle ${c} (${UNIT_LABEL[ins.unit]} unit)` })));
        cells.append(row);
      });
      return h('div', { class: 'vec-chain-m' }, h('h4', null, `${title}: `, h('b', null, `${t.total} cycles`)), cells);
    }));
  };
  draw();
  return panel('Chaining', 'Load, shift, add and store, one element group a cycle each; a cell is one group of four elements.',
    h('div', { class: 'vec-ctl' }, seg('groups (LMUL)', [2, 4, 8], groups, (v) => { groups = v; draw(); })), rows,
    h('p', { class: 'vec-legend' }, ...Object.entries(UNIT_LABEL).map(([u, l]) => h('span', null, h('i', { class: `u-${u}` }), l))));
}

/** Step 9: the kernel on four machines, measured: NANDs, cycles, time, and NANDs × time. */
export function machinesWidget(): Widget {
  const ms = VEC.machines;
  const ns = (m: (typeof ms)[number]) => (m.cycles * m.period * PS_PER_NAND) / 1000;
  const maxN = Math.max(...ms.map((m) => m.nands)), maxT = Math.max(...ms.map(ns));
  const best = Math.min(...ms.map((m) => m.nands * ns(m)));
  const tbl = h('div', { class: 'vec-mach', role: 'table', 'aria-label': 'y = 3·x + y on 16 elements, four machines' },
    h('div', { class: 'vm-h', role: 'row' }, ...['machine', 'NANDs (no ROM)', 'time', 'NANDs × time'].map((t) => h('span', { role: 'columnheader' }, t))),
    ...ms.map((m) => h('div', { class: `vm-r ${m.id}`, role: 'row' },
      h('span', { role: 'cell', class: 'vm-name' }, m.name),
      h('span', { role: 'cell' }, h('i', { class: 'vm-track' }, h('i', { class: 'vm-bar n', style: `width:${(100 * m.nands) / maxN}%` })), h('b', null, num(m.nands))),
      h('span', { role: 'cell' }, h('i', { class: 'vm-track' }, h('i', { class: 'vm-bar t', style: `width:${(100 * ns(m)) / maxT}%` })), h('b', null, `${ns(m).toFixed(0)} ns`), h('small', null, ` ${m.cycles} cycles × ${m.period}`)),
      h('span', { role: 'cell' }, h('small', { class: 'vm-ph' }, 'NANDs × time '), h('b', null, `${((m.nands * ns(m)) / best).toFixed(2)}×`)))));
  return panel('One kernel, four machines', 'y = 3·x + y on 16 elements, every machine in gates and timed by its golden model; the period is static timing, 25 ps a NAND delay.', tbl);
}

/** The scenes' Vector panel: the unit's view (widgets/vecview.ts), docked right. */
export function vecPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const body = h('div', { class: 'vec-pbody' });
    const el = h('div', { class: 'mem-panel vec-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, h('h4', null, 'Vector unit', h('span', { class: 'fold-hint' })), body);
    let shown = '';
    const paint = () => {
      const sim = stage.sim;
      const vu = sim?.design.root.children?.get('vu');
      if (!sim || !vu) { if (shown !== 'none') body.replaceChildren(h('p', { class: 'sub' }, 'No vector unit in this scene.')); shown = 'none'; return; }
      const v = vecView(sim, vu);
      if (v.key === shown) return;
      shown = v.key;
      body.replaceChildren(...v.nodes);
    };
    paint();
    return { el, update: paint };
  };
}

export { num as vecNum };
