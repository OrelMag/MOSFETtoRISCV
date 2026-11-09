// The manufacturing-test half of the chapter "How do you know it works?": a stuck-at fault planted on the full adder,
// fault coverage of test vectors, test generation step by step, the self-testing adder, and what testing a CPU costs.
// Every number is computed here from sim/faultsim.ts, sim/atpg.ts, lib/bist.ts and lib/dft.ts.

import { BIST_PATTERNS, bistAdder, bistPatterns, bistSignature, signatureOf } from '../lib/bist';
import { FULL_ADDER, rca } from '../lib/combinational';
import { scanCost } from '../lib/dft';
import { pipelinedCpu } from '../lib/pipeline';
import { assemble } from '../riscv/asm';
import { atpg, type AtpgResult } from '../sim/atpg';
import {
  allVectors, coverageCurve, detect, detects, exactCover, faultModel, faultName, greedyCover, randomVectors, responses, type FaultModel,
} from '../sim/faultsim';
import { groupDigits } from '../sim/numfmt';
import { stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { bench } from '../chapters/types';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { withFault } from '../verify/planted';
import '../styles/verify.css';

const n0 = (n: number) => groupDigits(n);
const model = (def: ComponentDef): FaultModel => { const m = faultModel(def); if (typeof m === 'string') throw new Error(m); return m; };
const btn = (label: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls }, label); b.addEventListener('click', f); return b; };
const sidePanel = (cls: string, title: string, ...kids: (Node | string)[]) =>
  h('div', { class: `mem-panel cpu-panel mc-panel vf-side ${cls}`, 'data-dock': 'right', 'data-fold': 'narrow' }, h('h4', null, title, h('span', { class: 'fold-hint' })), ...kids);

/** A fault of a model as a planted one: an input bit by its port, a NAND by its instance path (under `prefix`). */
export function siteFault(m: FaultModel, i: number, prefix: string[] = []) {
  const f = m.faults[i], s = m.sites[f.site];
  const pin = /^([a-z_]+)(?:\[(\d+)\])?$/i.exec(s.name);
  const isInput = m.inNets.includes(s.net);
  return isInput && pin ? { path: prefix, port: pin[1], bit: Number(pin[2] ?? 0), v: f.v } : { path: [...prefix, ...s.name.split('.')], port: 'y', bit: 0, v: f.v };
}

const vecText = (v: number, bits: number) => Array.from({ length: bits }, (_, b) => (v >> b) & 1).join(' ');

// ---- step 8: a defect on the full adder -------------------------------------------------------------------------------

let faPick = -1;
/** The full adder in a bench with the fault picked on the panel planted (none at first). */
export function faultyAdderScene(): Scene {
  const m = model(FULL_ADDER), f = faPick >= 0 ? siteFault(m, faPick) : null;
  const site = faPick >= 0 ? m.sites[m.faults[faPick].site].name : null;
  return {
    root: bench(f ? withFault(FULL_ADDER, f) : FULL_ADDER), inputs: { a: 1, b: 0, cin: 1 }, path: ['u'],
    highlight: site && !m.inNets.includes(m.sites[m.faults[faPick].site].net) ? [site] : [],
    panels: [faultPanel],
  };
}

const faultPanel: ScenePanel = (stage: Stage) => {
  const m = model(FULL_ADDER), vecs = allVectors(m), good = responses(m, vecs);
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Fault' }, h('option', { value: '-1' }, 'No fault: a good die'),
    ...m.faults.map((_, i) => h('option', { value: String(i) }, faultName(m, i)))) as HTMLSelectElement;
  sel.value = String(faPick);
  sel.addEventListener('change', () => { faPick = Number(sel.value); stage.load(faultyAdderScene(), ['u']); });
  const bad = faPick >= 0 ? responses(m, vecs, m.faults[faPick]) : good;
  const wrong = vecs.filter((v) => bad[v] !== good[v]).length;
  const rows = vecs.map((v) => h('tr', { class: bad[v] !== good[v] ? 'bad' : '' },
    h('td', { class: 'mono' }, vecText(v, 3)), h('td', { class: 'mono' }, `${good[v] & 1} ${good[v] >> 1}`), h('td', { class: 'mono' }, `${bad[v] & 1} ${bad[v] >> 1}`)));
  const note = h('p', { class: 'sub' }, faPick < 0 ? 'Pick a defect: the stage simulates it, the drawing stays the good circuit.'
    : wrong ? `${wrong} of 8 input rows show it at an output: any one of them, applied by a tester, rejects this die.` : 'No row shows it: this fault cannot be found from the outside.');
  return {
    el: sidePanel('vf-fault', 'Plant a defect', sel, note,
      h('table', { class: 'vf-tt' }, h('thead', null, h('tr', null, h('th', null, 'a b cin'), h('th', null, 'good s c'), h('th', null, 'this die s c'))), h('tbody', null, ...rows))),
  };
};

// ---- step 9: fault coverage --------------------------------------------------------------------------------------------

/** The full adder's faults against its 8 vectors (click columns into a test set), and the 4-bit adder's coverage curve. */
export function faultMatrixWidget(): Widget {
  const m = model(FULL_ADDER), vecs = allVectors(m), d = detect(m, vecs), F = m.faults.length;
  const sel = new Set<number>();
  const table = h('table', { class: 'vf-fm' });
  const count = h('span', { class: 'big' }), bar = h('div'), info = h('div', { class: 'sub' });
  const draw = () => {
    const covered = m.faults.map((_, f) => [...sel].some((v) => detects(d, f, v)));
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', null, 'a b cin'), ...vecs.map((v) => {
        const th = h('th', { class: sel.has(v) ? 'sel' : '', tabindex: '0', role: 'button', 'aria-pressed': String(sel.has(v)), title: `Vector a b cin = ${vecText(v, 3)}: catches ${m.faults.filter((_, f) => detects(d, f, v)).length} faults` }, vecText(v, 3).replace(/ /g, ''));
        const tog = () => { sel.has(v) ? sel.delete(v) : sel.add(v); draw(); };
        th.addEventListener('click', tog);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tog(); } });
        return th;
      }))),
      h('tbody', null, ...m.faults.map((_, f) => h('tr', { class: sel.size ? (covered[f] ? 'cov' : 'unc') : '' }, h('th', null, faultName(m, f)),
        ...vecs.map((v) => h('td', null, h('i', { class: detects(d, f, v) ? `d${sel.has(v) ? ' c' : ''}` : '' })))))));
    const n = covered.filter(Boolean).length;
    count.textContent = `${n} / ${F}`;
    bar.style.width = `${(100 * n) / F}%`;
    info.textContent = `${sel.size} vector${sel.size === 1 ? '' : 's'} chosen: ${Math.round((100 * n) / F)} % fault coverage`;
  };
  const greedy = greedyCover(d, F), best = exactCover(d, F)!;
  const r4 = model(rca(4)), rv = randomVectors(r4, 32, 7), at = [1, 2, 4, 8, 16, 32], curve = coverageCurve(r4, rv, at);
  const d4 = detect(r4, allVectors(r4)), g4 = greedyCover(d4, r4.faults.length).length;
  // the exact minimum takes most of a second: found after the panel is drawn
  const best4 = h('b', null, '…');
  setTimeout(() => { best4.textContent = String(exactCover(d4, r4.faults.length)?.length ?? '?'); }, 50);
  const W = 300, H = 110, x = (i: number) => 34 + (i * (W - 44)) / (at.length - 1), y = (k: number) => 90 - (80 * k) / r4.faults.length;
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Faults caught against random vectors"><line x1="34" y1="90" x2="${W - 10}" y2="90" class="ax"/><line x1="34" y1="10" x2="34" y2="90" class="ax"/>`
    + `<text x="30" y="14" text-anchor="end">${r4.faults.length}</text><text x="30" y="94" text-anchor="end">0</text>`
    + `<polyline class="ln" points="${curve.map((k, i) => `${x(i)},${y(k)}`).join(' ')}"/>${curve.map((k, i) => `<circle class="pt" cx="${x(i)}" cy="${y(k)}" r="3.5"><title>${at[i]} vectors: ${k} faults</title></circle><text x="${x(i)}" y="106" text-anchor="middle">${at[i]}</text>`).join('')}</svg>`;
  const chart = h('div', { class: 'vf-curve' });
  chart.innerHTML = svg;
  draw();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel vf' }, h('h3', null, 'Fault coverage'),
      h('p', { class: 'sub' }, `The full adder's ${F} stuck-at faults (${m.sites.length} nets, each stuck at 0 or 1) against its 8 input vectors. A dot: that vector shows the fault at s or cout. Click vectors into a test set.`),
      h('div', { class: 'vf-row' },
        h('div', { class: 'vf-card' }, h('h4', null, 'Coverage'), count, h('div', { class: 'vf-bar' }, bar), info,
          h('div', { class: 'cx-controls' }, btn(`Greedy (${greedy.length})`, () => { sel.clear(); greedy.forEach((v) => sel.add(v)); draw(); }), btn(`Smallest (${best.length})`, () => { sel.clear(); best.forEach((v) => sel.add(v)); draw(); }), btn('Clear', () => { sel.clear(); draw(); }))),
        h('div', { class: 'vf-card' }, h('h4', null, `4-bit ripple adder: ${r4.faults.length} faults, random vectors`), chart,
          h('p', { class: 'sub' }, `All ${n0(2 ** r4.inBits)} vectors catch all ${r4.faults.length}; greedy picks ${g4}, the smallest set is `, best4, '.'))),
      h('div', { class: 'vf-wrap' }, table))),
  };
}

// ---- step 10: generating a test ---------------------------------------------------------------------------------------

let atPick = -1;
/** The full adder, open, with the test generator's panel: it sets the inputs and lights the gates as it goes. */
export function atpgScene(): Scene {
  return { root: bench(FULL_ADDER), inputs: { a: 0, b: 0, cin: 0 }, path: ['u'], panels: [atpgPanel] };
}

const atpgPanel: ScenePanel = (stage: Stage) => {
  const m = model(FULL_ADDER);
  if (atPick < 0) atPick = m.faults.findIndex((_, i) => faultName(m, i) === 'g5 stuck at 0');
  let res: AtpgResult = atpg(m, atPick), k = 0;
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Fault' }, ...m.faults.map((_, i) => h('option', { value: String(i) }, faultName(m, i)))) as HTMLSelectElement;
  sel.value = String(atPick);
  const list = h('ol', { class: 'vf-steps' }), status = h('div', { class: 'vf-status' });
  const leaves = m.design.leaves;
  const show = () => {
    const shown = res.steps.slice(0, k);
    list.replaceChildren(...shown.map((s, i) => h('li', { class: `${s.kind}${i === k - 1 ? ' cur' : ''}` }, s.text)));
    // inputs: what the search has set by now (the last assign / backtrack per input wins), the rest 0 on the stage
    const set: (0 | 1 | null)[] = new Array(m.inBits).fill(null);
    for (const s of shown) if (s.kind === 'assign' && s.input !== undefined) set[s.input] = s.value!;
    const names = ['a', 'b', 'cin'];
    stage.setInputs(Object.fromEntries(names.map((n, i) => [n, set[i] ?? 0])));
    const cur = shown.at(-1);
    const net = cur?.kind === 'propagate' ? undefined : cur?.net;
    const lit = cur?.gate !== undefined ? [leaves[cur.gate].node.path.at(-1)!] : net !== undefined && m.siteOf[net] >= 0 && !m.inNets.includes(net) ? [m.sites[m.siteOf[net]].name] : [];
    stage.highlight(lit);
    status.textContent = `${set.map((v, i) => `${names[i]} = ${v ?? 'X'}`).join(', ')}${res.status === 'test' && k === res.steps.length ? `: the test is a b cin = ${vecText(res.vector!, 3)}` : ''}`;
    stepB.disabled = k >= res.steps.length; backB.disabled = k === 0;
  };
  const stepB = btn('Step', () => { k++; show(); }, 'btn sm primary'), backB = btn('Back', () => { k--; show(); });
  sel.addEventListener('change', () => { atPick = Number(sel.value); res = atpg(m, atPick); k = 0; show(); });
  queueMicrotask(show);
  return {
    el: sidePanel('vf-atpg', 'Find a test', sel, h('div', { class: 'cx-controls' }, backB, stepB, btn('All', () => { k = res.steps.length; show(); })), status, list),
  };
};

// ---- step 12: the chip tests itself -----------------------------------------------------------------------------------

let bistPick = -1;
export function bistScene(): Scene {
  const m = model(rca(4)), base = bistAdder(4);
  return { root: bistPick >= 0 ? withFault(base, siteFault(m, bistPick, ['dut'])) : base, inputs: { rst: 1, clk: 0 }, panels: [bistPanel], autoClock: false };
}

const bistPanel: ScenePanel = (stage: Stage) => {
  const m = model(rca(4)), pats = bistPatterns(4, BIST_PATTERNS), good = bistSignature(4, BIST_PATTERNS), gr = responses(m, pats);
  const escapes = new Set(m.faults.map((f, i) => (responses(m, pats, f).some((r, k) => r !== gr[k]) && signatureOf(responses(m, pats, f), 5) === good ? i : -1)).filter((i) => i >= 0));
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Fault' }, h('option', { value: '-1' }, 'No fault: a good die'),
    ...m.faults.map((_, i) => h('option', { value: String(i) }, `${faultName(m, i)}${escapes.has(i) ? ' (escapes)' : ''}`))) as HTMLSelectElement;
  sel.value = String(bistPick);
  sel.addEventListener('change', () => { bistPick = Number(sel.value); stage.load(bistScene()); });
  const out = h('div', { class: 'vf-status', role: 'status' }, `Press Self-test: reset loads the pattern generator with 1, then ${BIST_PATTERNS} clocks; the good signature is ${good}.`);
  const run = () => {
    stage.checkpoint();
    stage.setInput('rst', 1); stage.pulse(); stage.setInput('rst', 0);
    stage.runCycles(BIST_PATTERNS);
    const sig = stage.value('sig');
    out.replaceChildren(h('b', { class: sig === good ? 'vf-pass' : 'vf-fail' }, sig === good ? 'PASS' : 'FAIL'), ` signature ${sig}, good ${good}.${sig === good && bistPick >= 0 ? ' The fault changed some sums, but the signature came out the same: it escaped.' : ''}`);
    stage.refresh();
  };
  return { el: sidePanel('vf-bist', 'Self-test', sel, btn('Self-test', run, 'btn sm primary'), out) };
};

// ---- step 13: what testing a CPU costs -------------------------------------------------------------------------------

export function testCostWidget(): Widget {
  const cpu = pipelinedCpu(assemble('j .').words), sc = scanCost(cpu), nands = stats(cpu).nands;
  let patterns = 2000, chains = 8, mhz = 50;
  const out = h('div', { class: 'vf-cost' });
  const draw = () => {
    const len = Math.ceil(sc.flipFlops / chains), clocks = patterns * (len + 1) + len, t = clocks / (mhz * 1e6);
    out.replaceChildren(
      h('p', null, `Full scan: ${n0(sc.flipFlops)} flip-flops, each a scan flip-flop: ${n0(sc.nands)} NANDs more on the CPU's ${n0(nands)} (${((100 * sc.nands) / nands).toFixed(1)} %).`),
      h('p', null, `${chains} chain${chains > 1 ? 's' : ''} of ${n0(len)}: each pattern shifts ${n0(len)} clocks in (the last answer shifting out at the same time) and captures in 1. ${n0(patterns)} patterns: ${n0(clocks)} clocks, `, h('b', null, t < 1e-3 ? `${(t * 1e6).toFixed(0)} µs` : `${(t * 1e3).toFixed(2)} ms`), ` per die at ${mhz} MHz.`),
      h('p', { class: 'sub' }, 'More chains cost pins (two each: scan in, scan out) and save time in proportion; a tester\'s time is paid per second, for every die, good or bad.'));
  };
  const slider = (label: string, min: number, max: number, step: number, val: number, on: (v: number) => void, unit: string) => {
    const i = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val), 'aria-label': label }) as HTMLInputElement;
    const v = h('span', { class: 'num' }, `${n0(val)} ${unit}`);
    i.addEventListener('input', () => { on(Number(i.value)); v.textContent = `${n0(Number(i.value))} ${unit}`; draw(); });
    return h('label', { class: 'cx-field' }, h('span', null, label), i, v);
  };
  draw();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel vf' }, h('h3', null, 'Testing the pipelined CPU'),
      h('p', { class: 'sub' }, 'Every flip-flop on one scan chain or several; the patterns a test generator would need; the scan clock.'),
      h('div', { class: 'cx-controls' }, slider('patterns', 100, 20000, 100, patterns, (v) => (patterns = v), ''), slider('scan chains', 1, 32, 1, chains, (v) => (chains = v), ''), slider('scan clock', 10, 200, 10, mhz, (v) => (mhz = v), 'MHz')),
      out)),
  };
}
