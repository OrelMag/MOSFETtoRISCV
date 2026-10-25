// Chapter 32 widgets: which lanes each memory access serves (the gate-level access unit, evaluated
// for any stride and offset, global lines or shared banks), and when tiling a matrix multiply pays
// (the timing model, which the tests check against the gate-level core, swept over memory bandwidth).

import { accessUnit } from '../lib';
import { assemble } from '../riscv/asm';
import { WARP_DMEM_K, WARP_PROGRAMS, WARP_SMEM_K } from '../riscv/warpprograms';
import { warpTiming, type WarpTiming } from '../riscv/warptiming';
import { evalOnce, simulate } from '../sim/harness';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const LANES = 4;
const lanesOf = (m: number) => Array.from({ length: LANES }, (_, i) => i).filter((i) => (m >> i) & 1);

interface Preset { name: string; stride: number; offset: number }
const PRESETS: Record<'global' | 'shared', Preset[]> = {
  global: [
    { name: 'Contiguous: x[tid]', stride: 1, offset: 0 },
    { name: 'Stride 2: x[2·tid]', stride: 2, offset: 0 },
    { name: 'Stride 4: a column', stride: 4, offset: 0 },
    { name: 'Misaligned: x[tid + 1]', stride: 1, offset: 1 },
  ],
  shared: [
    { name: 'Stride 1', stride: 1, offset: 0 },
    { name: 'Stride 2: two-way conflict', stride: 2, offset: 0 },
    { name: 'Stride 4: four-way conflict', stride: 4, offset: 0 },
    { name: 'One word for all: broadcast', stride: 0, offset: 5 },
    { name: 'Stride 5: padded rows', stride: 5, offset: 0 },
  ],
};

/** The access unit's answer, access by access: the lanes each one serves. */
export function accessSteps(sim: ReturnType<typeof simulate>, addrs: number[], amo = false): number[] {
  const out: number[] = [];
  for (let left = 2 ** LANES - 1; left && out.length < LANES; ) {
    const [serve] = evalOnce(sim, [left, amo ? 1 : 0, ...addrs]);
    out.push(serve);
    left &= ~serve;
  }
  return out;
}

/** Lanes 0 … 3 reading word offset + stride · lane: the accesses global memory (lines) or shared memory (banks) needs. */
export function accessWidget(start: 'global' | 'shared' = 'global'): Widget {
  const sim = simulate(accessUnit(LANES));
  let mem = start, stride = PRESETS[start][0].stride, offset = PRESETS[start][0].offset;
  const el = h('div', { class: 'widget feed-acc' });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'memory' });
  const presets = h('div', { class: 'feed-presets' });
  const strideSel = h('select', { 'aria-label': 'stride' }) as HTMLSelectElement;
  const offSel = h('select', { 'aria-label': 'offset' }) as HTMLSelectElement;
  for (let s = 0; s <= 8; s++) strideSel.append(h('option', { value: String(s) }, `stride ${s}`));
  for (let o = 0; o <= 7; o++) offSel.append(h('option', { value: String(o) }, `offset ${o}`));
  const grid = h('div', { class: 'feed-words' });
  const steps = h('div', { class: 'feed-steps' });
  const segBtns = (['global', 'shared'] as const).map((k) => {
    const b = h('button', { role: 'radio' }, k === 'global' ? 'Global memory: lines' : 'Shared memory: banks');
    b.addEventListener('click', () => { mem = k; ({ stride, offset } = PRESETS[k][0]); draw(); });
    seg.append(b);
    return [k, b] as const;
  });
  strideSel.addEventListener('change', () => { stride = Number(strideSel.value); draw(); });
  offSel.addEventListener('change', () => { offset = Number(offSel.value); draw(); });
  const chip = (lane: number, text = `L${lane}`) => h('span', { class: `feed-lane l${lane}` }, text);
  const draw = () => {
    for (const [k, b] of segBtns) { b.classList.toggle('on', k === mem); b.setAttribute('aria-checked', String(k === mem)); }
    strideSel.value = String(stride);
    offSel.value = String(offset);
    presets.replaceChildren(...PRESETS[mem].map((p) => {
      const b = h('button', { class: `btn sm${p.stride === stride && p.offset === offset ? ' on' : ''}` }, p.name);
      b.addEventListener('click', () => { ({ stride, offset } = p); draw(); });
      return b;
    }));
    const words = Array.from({ length: LANES }, (_, i) => offset + stride * i);
    const base = mem === 'shared' ? 0x1000 : 0;
    const acc = accessSteps(sim, words.map((w) => base + 4 * w));
    const accOf = (lane: number) => acc.findIndex((s) => (s >> lane) & 1) + 1;
    // 32 words: 8 lines of four (global) or 8 rows of the 4 banks (shared); either way word w at row w / 4, column w mod 4
    const rows = Array.from({ length: 8 }, (_, r) => r);
    grid.replaceChildren(h('table', null,
      h('tr', null, h('th'), ...[0, 1, 2, 3].map((c) => h('th', null, mem === 'shared' ? `bank ${c}` : `word ${c}`))),
      ...rows.map((r) => h('tr', null, h('td', { class: 'lbl' }, mem === 'shared' ? `row ${r}` : `line ${r}`),
        ...[0, 1, 2, 3].map((c) => {
          const w = 4 * r + c, ls = words.map((x, i) => (x === w ? i : -1)).filter((i) => i >= 0);
          return h('td', { class: ls.length ? 'used' : '', title: `word ${w}${ls.length ? `: lane${ls.length > 1 ? 's' : ''} ${ls.join(', ')}, access ${accOf(ls[0])}` : ''}` },
            String(w), ...ls.map((i) => chip(i, `L${i}·${accOf(i)}`)));
        })))));
    const what = (s: number) => {
      const ls = lanesOf(s);
      if (mem === 'global') return `line ${words[ls[0]] >> 2} (words ${4 * (words[ls[0]] >> 2)}–${4 * (words[ls[0]] >> 2) + 3})`;
      const byBank = new Map<number, number>();
      for (const i of ls) byBank.set(words[i] & 3, words[i]);
      return [...byBank].sort((a, b) => a[0] - b[0]).map(([b, w]) => `bank ${b} row ${w >> 2}`).join(', ');
    };
    steps.replaceChildren(
      h('div', { class: 'feed-total' }, h('b', null, `${acc.length} access${acc.length > 1 ? 'es' : ''}`),
        `: the instruction holds the issue port ${acc.length} cycle${acc.length > 1 ? 's' : ''}${acc.length === 1 ? ', every lane at once' : ''}.`),
      ...acc.map((s, k) => h('div', { class: 'feed-step' }, h('span', { class: 'n' }, `access ${k + 1}`), ...lanesOf(s).map((i) => chip(i)), h('span', { class: 'w' }, what(s)))));
  };
  draw();
  el.append(h('div', { class: 'param-row' }, seg, strideSel, offSel), presets, h('div', { class: 'feed-cols' }, grid, steps),
    h('p', { class: 'sub' }, 'Lane i reads word offset + stride · i. Each access is the gate-level access unit evaluated on those four addresses: '
      + 'the lanes it serves leave, and it runs again on the rest. The label L1·2 means lane 1, served by access 2.'));
  return { el };
}

// ---- tiling ------------------------------------------------------------------------------------

const B_RANGE = [1, 2, 3, 4, 5, 6, 7, 8];

/** Both matrix multiplies on the 4-warp core (8-cycle global, 2-cycle shared loads), a global line at most every B cycles. */
export function tilingRuns(): { plain: WarpTiming[]; tiled: WarpTiming[] } {
  const run = (id: string) => {
    const p = WARP_PROGRAMS.find((x) => x.id === id)!;
    const words = assemble(p.source(LANES)).words;
    return B_RANGE.map((B) => warpTiming(words, { warps: 4, lanes: LANES, latency: 8, sharedLatency: 2, globalEvery: B, lsu: true, mul: true,
      dmemWords: 2 ** WARP_DMEM_K, smemWords: 2 ** WARP_SMEM_K, data: p.data() }));
  };
  return { plain: run('matmul'), tiled: run('matmulTiled') };
}

/** Cycles of the plain and the tiled matrix multiply against the memory's bandwidth. */
export function tilingWidget(): Widget {
  const { plain, tiled } = tilingRuns();
  const series = [{ name: 'every operand from global memory', runs: plain }, { name: 'tiles in shared memory', runs: tiled }];
  const S = 'http://www.w3.org/2000/svg', Wd = 620, Ht = 250, x0 = 56, x1 = Wd - 150, y0 = 220, yTop = 30;
  const max = Math.ceil(Math.max(...plain.map((r) => r.cycles), ...tiled.map((r) => r.cycles)) / 200) * 200;
  const X = (B: number) => x0 + ((x1 - x0) * (B - 1)) / (B_RANGE.length - 1), Y = (c: number) => y0 - ((y0 - yTop) * c) / max;
  const svg = document.createElementNS(S, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht + 24}`);
  svg.setAttribute('class', 'lvc-bars feed-tile');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Cycles of the two matrix multiplies against cycles between global accesses');
  const add = (tag: string, a: Record<string, string | number>, text?: string, parent: Element = svg) => {
    const e = document.createElementNS(S, tag);
    for (const k in a) e.setAttribute(k, String(a[k]));
    if (text !== undefined) e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  for (let g = 0; g <= max; g += 200) {
    add('line', { x1: x0, y1: Y(g), x2: x1, y2: Y(g), class: 'grid' });
    add('text', { x: x0 - 6, y: Y(g) + 4, 'text-anchor': 'end', class: 'ax' }, String(g));
  }
  for (const B of B_RANGE) add('text', { x: X(B), y: y0 + 16, 'text-anchor': 'middle', class: 'ax' }, String(B));
  add('text', { x: (x0 + x1) / 2, y: y0 + 34, 'text-anchor': 'middle', class: 'ax' }, 'cycles between global line accesses (1 = a line every cycle, as in the scenes)');
  add('text', { x: x0 - 6, y: yTop - 16, 'text-anchor': 'end', class: 'ax' }, 'cycles');
  // where tiling starts to pay
  const cross = B_RANGE.find((_, i) => tiled[i].cycles < plain[i].cycles);
  if (cross) {
    add('line', { x1: X(cross) - (X(2) - X(1)) / 2, y1: yTop, x2: X(cross) - (X(2) - X(1)) / 2, y2: y0, class: 'feed-cross' });
    add('text', { x: X(cross) - (X(2) - X(1)) / 2 + 6, y: yTop + 10, class: 'ax' }, 'tiling pays from here');
  }
  series.forEach((s, k) => {
    const col = `var(--series-${k + 1})`;
    add('polyline', { points: s.runs.map((r, i) => `${X(B_RANGE[i])},${Y(r.cycles)}`).join(' '), fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    s.runs.forEach((r, i) => {
      const g = add('g', {});
      add('circle', { cx: X(B_RANGE[i]), cy: Y(r.cycles), r: 4, fill: col, stroke: 'var(--surface)', 'stroke-width': 2 }, undefined, g);
      add('circle', { cx: X(B_RANGE[i]), cy: Y(r.cycles), r: 11, fill: 'transparent' }, undefined, g);
      add('title', {}, `${s.name}, a line every ${B_RANGE[i]} cycle${B_RANGE[i] > 1 ? 's' : ''}: ${r.cycles} cycles`, g);
    });
    const lastR = s.runs[s.runs.length - 1];
    add('text', { x: X(8) + 10, y: Y(lastR.cycles) + 4, class: 'nm' }, `${k ? 'tiled' : 'plain'} ${lastR.cycles}`);
  });
  const legend = h('div', { class: 'lvc-legend' }, ...series.map((s, k) => h('span', null, h('i', { style: `background:var(--series-${k + 1})` }), s.name)));
  const p0 = plain[0], t0 = tiled[0];
  const facts = h('table', { class: 'lvc-table' },
    h('tr', null, h('th', null, 'C = A · B, 4 warps'), h('th', null, 'instructions'), h('th', null, 'global accesses'), h('th', null, 'shared accesses'), h('th', null, 'cycles, a line every cycle')),
    ...[['plain', p0], ['tiled', t0]].map(([n, r]) => h('tr', null, h('td', null, n as string), ...[(r as WarpTiming).issued, (r as WarpTiming).globalAccesses, (r as WarpTiming).sharedAccesses, (r as WarpTiming).cycles].map((v) => h('td', null, String(v))))));
  const table = h('table', { class: 'lvc-table' },
    h('tr', null, h('th', null, 'a line every'), ...B_RANGE.map((B) => h('th', null, `${B}`))),
    ...series.map((s, k) => h('tr', null, h('td', null, k ? 'tiled' : 'plain'), ...s.runs.map((r) => h('td', null, String(r.cycles))))));
  const el = h('div', { class: 'widget warp-occ' }, h('div', { class: 'lvc-title' }, 'C = A · B (8 × 4 by 4 × 8): cycles against memory bandwidth'), legend, svg, facts, table,
    h('p', { class: 'sub' }, 'Cycles from the timing model, which the tests check against the gate-level core cycle for cycle (at one, two and three cycles per line). '
      + 'Global loads take 8 cycles, shared ones 2; a slower memory adds no latency here, only a gap between line accesses.'));
  return { el };
}
