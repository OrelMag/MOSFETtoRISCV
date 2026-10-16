// The workbench's Benchmarks tab (#/workbench/bench, its own chunk): the benchmark set
// (riscv/benchprograms.ts) measured on every gate-level CPU by scripts/benchmarks.ts, every run
// checked against the golden model. Time = cycles × static-timing period: the chart sets it
// against cost (or energy), the table gives each program, a row opens on its misses, stalls and energy.

import { COMMON, FAMILIES, RESULTS, chapterOf, familyOf, front, meanOf, metricOf, runNj, runOf, runUs, type BenchCpu, type Family, type Metric } from '../../bench/summary';
import { assemble } from '../../riscv/asm';
import { BENCHMARKS } from '../../riscv/benchprograms';
import { fmtPower, POWER_NOTE, VDD } from '../../sim/power';
import { PS_NOTE } from '../../sim/timing';
import { benchTabs } from '../benchtabs';
import { h, s } from '../dom';
import type { Page } from './chapter';

const METRICS: { k: Metric; label: string; unit: string; digits: number }[] = [
  { k: 'time', label: 'Time', unit: 'µs', digits: 1 },
  { k: 'cycles', label: 'Cycles', unit: 'cycles', digits: 0 },
  { k: 'cpi', label: 'CPI', unit: 'cycles per instruction', digits: 2 },
  { k: 'energy', label: 'Energy', unit: 'nJ', digits: 0 },
  { k: 'epi', label: 'Energy / instr.', unit: 'pJ per instruction', digits: 1 },
];
type SortKey = 'name' | 'nands' | 'period' | 'mean' | string;
type ChartX = 'nands' | 'energy';

const fmt = (x: number, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const mhz = (period: number) => Math.round(1e6 / (period * RESULTS.psPerNand));
const extOf = (id: string) => { const n = BENCHMARKS.find((b) => b.id === id)!.needs; return n?.m ? 'RV32IM' : n?.f ? 'RV32IF' : ''; };
/** Instructions of a program as a single-hart CPU runs it (the dual-core adds its park prelude). */
const instructionsOf = (id: string) => RESULTS.cpus.find((c) => c.id !== 'dual' && runOf(c, id))?.runs.find((r) => r.bench === id)?.instructions ?? 0;

/** A round grid step (1, 2 or 5 × 10^k) near x. */
function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export class BenchmarksPage implements Page {
  readonly kind = 'benchmarks';
  readonly el: HTMLElement;
  private metric: Metric = 'time';
  private chartX: ChartX = 'nands';
  private fams = new Set<Family>(FAMILIES.map((f) => f.key));
  private sort: SortKey = 'mean';
  private dir = 1;
  private open = new Set<string>();
  private metricChips = h('div', { class: 'hw-chips' });
  private famChips = h('div', { class: 'hw-chips' });
  private head = h('tr');
  private body = h('tbody');
  private tip = h('div', { class: 'bm-tip', hidden: true });
  private chartHead = h('div', { class: 'bm-card-head' });
  private chartBox = h('div', { class: 'bm-chart' });

  constructor() {
    this.el = h('div', { class: 'hw-page' }, h('div', { class: 'hw-inner' },
      benchTabs('bench'),
      h('h1', null, 'Benchmarks'),
      h('p', { class: 'hw-sub' }, 'One fixed set of programs on every CPU the chapters build, each simulated gate by gate to its last ',
        'instruction, its final registers and memory checked against the golden model. Time is cycles × the clock period static timing ',
        'gives, so a CPU is fast only if it is short in both. Energy counts every net’s toggles, glitches included. Open a row for its cache misses, stalls and energy.'),
      this.tiles(),
      h('section', { class: 'bm-card' }, this.chartHead, this.chartBox),
      h('div', { class: 'hw-controls' }, h('span', { class: 'bm-lbl' }, 'Show'), this.metricChips, h('span', { class: 'bm-sep' }), h('span', { class: 'bm-lbl' }, 'CPUs'), this.famChips),
      h('div', { class: 'hw-table-wrap bm-wrap' }, h('table', { class: 'hw-table bm-table' }, h('thead', null, this.head), this.body)),
      this.programs(),
      h('p', { class: 'hw-note' }, `${PS_NOTE} NAND counts include the ${RESULTS.dmemWords}-word data memory (and the caches), not the `,
        `${RESULTS.imemWords}-word instruction ROM, whose size follows the program. The dual-core runs each program on hart 0, hart 1 parked. `,
        'Measured by scripts/benchmarks.ts.'),
      h('p', { class: 'hw-note' }, `Energy at ${VDD} V: each run simulated again on the event-driven gate simulator, every net’s toggles counted. ${POWER_NOTE}`)));
    this.renderChart();
    this.render();
  }

  destroy(): void { /* nothing running */ }

  private tiles(): HTMLElement {
    const cpus = RESULTS.cpus;
    const best = (f: (c: BenchCpu) => number) => cpus.reduce((a, c) => (f(c) < f(a) ? c : a));
    const link = (c: BenchCpu) => { const ch = chapterOf(c.id); return ch ? h('a', { href: `#/c/${ch}` }, c.name) : c.name; };
    const tile = (big: string, ...small: (Node | string)[]) => h('div', { class: 'hw-tile' }, h('b', null, big), h('span', null, ...small));
    const fast = best((c) => meanOf(c, 'time')), cpi = best((c) => meanOf(c, 'cpi')), tc = best((c) => (c.offChip ? Infinity : meanOf(c, 'time') * c.nands));
    const en = best((c) => meanOf(c, 'energy'));
    return h('div', { class: 'hw-tiles bm-tiles' },
      tile(`${fmt(meanOf(fast, 'time'), 1)} µs`, 'fastest: ', link(fast)),
      tile(fmt(meanOf(cpi, 'cpi'), 2), 'lowest CPI: ', link(cpi)),
      tile(`${fmt(meanOf(tc, 'time') * tc.nands / 1e3)} µs·kNAND`, 'best time × cost: ', link(tc)),
      tile(`${fmt(meanOf(en, 'energy'))} nJ`, 'least energy per program: ', link(en)),
      tile(`${cpus.reduce((a, c) => a + c.runs.length, 0)} runs`, `${cpus.length} CPUs, each run equal to the golden model`));
  }

  private renderChart(): void {
    const e = this.chartX === 'energy';
    const xChip = (x: ChartX, label: string) => this.chip(label, this.chartX === x, () => { this.chartX = x; this.renderChart(); });
    this.chartHead.replaceChildren(h('h2', null, e ? 'Speed against energy' : 'Speed against cost'),
      h('p', null, `Mean time of the four RV32I programs (geometric mean) against ${e ? `their mean energy at ${VDD} V` : 'NAND gates'}. Down and left is better; the dashed line joins the CPUs no other beats on both.`),
      h('div', { class: 'bm-legend' }, h('span', { class: 'hw-chips' }, xChip('nands', 'Cost'), xChip('energy', 'Energy')),
        ...FAMILIES.map((f) => h('span', null, h('i', { class: `bm-fam ${f.key}` }), f.label)), h('span', null, h('i', { class: 'bm-dash' }), 'best trade-off')));
    this.tip.hidden = true;
    this.chartBox.replaceChildren(this.chart(), this.tip);
  }

  /** Mean time against NANDs (or mean energy), one dot per CPU, the front dashed. */
  private chart(): SVGSVGElement {
    const cpus = RESULTS.cpus, W = 1200, H = 340, L = 56, R = 24, T = 14, B = 40;
    const e = this.chartX === 'energy';
    const xOf = (c: BenchCpu) => (e ? meanOf(c, 'energy') : c.nands / 1e3);
    const xs = cpus.map(xOf), ys = cpus.map((c) => meanOf(c, 'time'));
    const step = e ? niceStep((Math.max(...xs) - Math.min(...xs)) / 6) : 20;
    const x0 = Math.floor(Math.min(...xs) / step) * step, x1 = Math.ceil(Math.max(...xs) / step) * step, y1 = Math.ceil(Math.max(...ys) / 5) * 5;
    const X = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v: number) => T + (1 - v / y1) * (H - T - B);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Mean time per program against ${e ? 'mean energy' : 'NAND gates'}, one dot per CPU` });
    for (let v = x0; v <= x1 + step / 2; v += step) svg.append(s('line', { class: 'bm-grid', x1: X(v), x2: X(v), y1: T, y2: H - B }), s('text', { x: X(v), y: H - B + 16, 'text-anchor': 'middle' }, e ? fmt(v) : `${v}k`));
    for (let v = 0; v <= y1; v += 5) svg.append(s('line', { class: 'bm-grid', x1: L, x2: W - R, y1: Y(v), y2: Y(v) }), s('text', { x: L - 8, y: Y(v) + 4, 'text-anchor': 'end' }, String(v)));
    svg.append(s('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle' }, e ? `nJ per program at ${VDD} V (estimate)` : 'NAND gates (instruction ROM excluded)'),
      s('text', { x: 14, y: (T + H - B) / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${(T + H - B) / 2})` }, 'µs per program'));
    const fr = front(cpus, xOf);
    svg.append(s('polyline', { class: 'bm-front', points: fr.map((c) => `${X(xOf(c))},${Y(meanOf(c, 'time'))}`).join(' ') }));
    for (const c of cpus) {
      const cx = X(xOf(c)), cy = Y(meanOf(c, 'time'));
      const hit = s('circle', { class: 'bm-hit', cx, cy, r: 14 });
      hit.addEventListener('pointerenter', () => this.showTip(c, cx / W, cy / H));
      hit.addEventListener('pointerleave', () => { this.tip.hidden = true; });
      svg.append(s('circle', { class: `bm-dot ${familyOf(c.id)}${c.offChip ? ' off' : ''}`, cx, cy, r: 6 }), hit);
    }
    for (const c of fr) svg.append(s('text', { class: 'bm-lab', x: X(xOf(c)) + 10, y: Y(meanOf(c, 'time')) - 9 }, c.id));
    return svg;
  }

  private showTip(c: BenchCpu, fx: number, fy: number): void {
    this.tip.replaceChildren(h('b', null, c.name),
      h('span', null, `${fmt(meanOf(c, 'time'), 1)} µs · ${fmt(c.nands)} NAND${c.offChip ? ' + a DRAM chip' : ''} · CPI ${fmt(meanOf(c, 'cpi'), 2)} · ${mhz(c.period)} MHz · ${fmt(meanOf(c, 'energy'))} nJ`));
    this.tip.hidden = false;
    this.tip.style.left = `${(fx * 100).toFixed(1)}%`;
    this.tip.style.top = `${(fy * 100).toFixed(1)}%`;
  }

  private value(c: BenchCpu, k: SortKey): number | string | null {
    if (k === 'name') return c.name;
    if (k === 'nands') return c.nands;
    if (k === 'period') return c.period;
    if (k === 'mean') return meanOf(c, this.metric);
    const r = runOf(c, k);
    return r ? metricOf(c, r, this.metric) : null;
  }

  private render(): void {
    const m = METRICS.find((x) => x.k === this.metric)!;
    this.metricChips.replaceChildren(...METRICS.map((x) => this.chip(x.label, x.k === this.metric, () => { this.metric = x.k; })));
    this.famChips.replaceChildren(...FAMILIES.map((f) => this.chip(f.label, this.fams.has(f.key), () => {
      if (!this.fams.has(f.key)) this.fams.add(f.key);
      else if (this.fams.size > 1) this.fams.delete(f.key);
    }, h('i', { class: `bm-fam ${f.key}` }))));
    const cols: { k: SortKey; label: string; sub: string }[] = [
      { k: 'name', label: 'CPU', sub: '' },
      { k: 'nands', label: 'NAND gates', sub: 'without the ROM' },
      { k: 'period', label: 'Clock period', sub: 'NAND delays · MHz' },
      ...BENCHMARKS.map((b) => ({ k: b.id, label: b.name, sub: extOf(b.id) ? `${extOf(b.id)} only` : `${fmt(instructionsOf(b.id))} instr.` })),
      { k: 'mean', label: 'Mean', sub: `${COMMON.length} RV32I programs` },
    ];
    this.head.replaceChildren(...cols.map((c) => {
      const th = h('th', { scope: 'col', 'aria-sort': this.sort === c.k ? (this.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', null, c.label, this.sort === c.k ? h('span', { class: 'hw-arrow' }, this.dir > 0 ? ' ▲' : ' ▼') : null, h('small', null, c.sub || ' ')));
      th.addEventListener('click', () => {
        this.dir = this.sort === c.k ? -this.dir : 1;
        this.sort = c.k;
        this.render();
      });
      return th;
    }));
    const rows = RESULTS.cpus.filter((c) => this.fams.has(familyOf(c.id)));
    rows.sort((a, b) => {
      const x = this.value(a, this.sort), y = this.value(b, this.sort);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      const d = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return d * this.dir || a.name.localeCompare(b.name);
    });
    // per column: the largest value (bar scale) and the best (lowest)
    const range = new Map<string, [number, number]>();
    for (const k of [...BENCHMARKS.map((b) => b.id), 'mean']) {
      const vs = rows.map((c) => this.value(c, k)).filter((v): v is number => typeof v === 'number');
      if (vs.length) range.set(k, [Math.min(...vs), Math.max(...vs)]);
    }
    const cell = (k: string, v: number | string | null) => {
      if (typeof v !== 'number') return h('td', null, h('span', { class: 'hw-na' }, '—'));
      const [lo, hi] = range.get(k)!;
      return h('td', null, h('span', { class: 'bm-cell' }, h('span', { class: v === lo ? 'bm-best' : null }, fmt(v, m.digits)),
        h('span', { class: 'bm-bar' }, h('i', { style: `width:${((100 * v) / hi).toFixed(1)}%` }))));
    };
    const out: HTMLElement[] = [];
    for (const c of rows) {
      const open = this.open.has(c.id), ch = chapterOf(c.id);
      const chev = h('button', { class: 'hw-chev', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} misses, stalls and energy` }, open ? '▾' : '▸');
      chev.addEventListener('click', () => {
        if (open) this.open.delete(c.id);
        else this.open.add(c.id);
        this.render();
      });
      out.push(h('tr', null,
        h('td', { class: 'hw-name' }, chev, h('i', { class: `bm-fam ${familyOf(c.id)}` }), ch ? h('a', { href: `#/c/${ch}`, title: c.id }, c.name) : h('span', { title: c.id }, c.name)),
        h('td', c.offChip ? { title: 'main memory is a DRAM chip outside the CPU: not counted' } : null, fmt(c.nands), c.offChip ? h('span', { class: 'hw-mhz' }, ' + DRAM') : ''),
        h('td', null, String(c.period), h('span', { class: 'hw-mhz' }, ` ${fmt(mhz(c.period))}`)),
        ...BENCHMARKS.map((b) => cell(b.id, this.value(c, b.id))),
        cell('mean', this.value(c, 'mean'))));
      if (open) out.push(this.detail(c, cols.length));
    }
    this.body.replaceChildren(...out);
  }

  private detail(c: BenchCpu, span: number): HTMLElement {
    const d = c.runs.some((r) => r.dmiss !== undefined), i = c.runs.some((r) => r.imiss !== undefined);
    const name = (id: string) => BENCHMARKS.find((b) => b.id === id)!.name;
    const extra = c.runs.reduce((a, r) => a + r.cycles - r.instructions, 0);
    const glitch = (r: (typeof c.runs)[number]) => (r.switched ? `${Math.round(100 * (1 - (r.functional ?? 0) / r.switched))} %` : '—');
    return h('tr', { class: 'bm-detail' }, h('td', { colspan: span },
      h('table', null,
        h('thead', null, h('tr', null, ...['Program', 'Instructions', 'Cycles', 'CPI', 'Time', 'Energy', 'per instr.', 'glitches', 'power',
          ...(d ? ['D-cache misses', 'D stall cycles'] : []), ...(i ? ['I-cache misses', 'I stall cycles'] : [])].map((t) => h('th', null, t)))),
        h('tbody', null, ...c.runs.map((r) => h('tr', null, h('td', null, name(r.bench)), h('td', null, fmt(r.instructions)), h('td', null, fmt(r.cycles)),
          h('td', null, fmt(r.cycles / r.instructions, 2)), h('td', null, `${fmt(runUs(c, r), 1)} µs`),
          h('td', null, `${fmt(runNj(r))} nJ`), h('td', null, `${fmt((runNj(r) * 1e3) / r.instructions, 1)} pJ`), h('td', null, glitch(r)),
          h('td', { title: 'Energy over time at the clock static timing allows' }, fmtPower((runNj(r) * 1e-9) / (runUs(c, r) * 1e-6))),
          ...(d ? [h('td', null, fmt(r.dmiss ?? 0)), h('td', null, fmt(r.dstall ?? 0))] : []),
          ...(i ? [h('td', null, fmt(r.imiss ?? 0)), h('td', null, fmt(r.istall ?? 0))] : []))))),
      h('p', null, extra ? `${fmt(extra)} cycles beyond one per instruction over the ${c.runs.length} programs${d || i ? ', misses included' : ''}.`
        : 'One cycle per instruction: every instruction completes in the cycle it is fetched.')));
  }

  private chip(label: string, on: boolean, act: () => void, lead?: Node): HTMLElement {
    const b = h('button', { class: `hw-chip${on ? ' on' : ''}`, 'aria-pressed': String(on) }, lead ?? null, label);
    b.addEventListener('click', () => { act(); this.render(); });
    return b;
  }

  private programs(): HTMLElement {
    return h('section', { class: 'bm-card' },
      h('div', { class: 'bm-card-head' }, h('h2', null, 'The programs'),
        h('p', null, `Each fits the smallest machine: a ${RESULTS.imemWords}-word ROM, ${RESULTS.dmemWords} words of data, word loads and stores, a final jump to itself. Each result is also computed in TypeScript.`)),
      h('div', { class: 'bm-progs' }, ...BENCHMARKS.map((b) => h('div', { class: 'bm-prog' },
        h('b', null, b.name), extOf(b.id) ? h('small', null, ` · ${extOf(b.id)} only`) : null,
        h('p', null, b.blurb),
        h('small', null, `${fmt(instructionsOf(b.id))} instructions · ${assemble(b.source).words.length} words of code`),
        h('details', null, h('summary', null, 'Source'), h('pre', null, b.source))))));
  }
}
