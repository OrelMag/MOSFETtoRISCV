// Chapter float: error in practice. errorLab(): an expression evaluated in float32 (operation by operation, src/sim/fpref.ts) and
// exactly (src/sim/errorlab.ts), with the error of every step in ulps and relative terms. sumLab(): naive, pairwise and Kahan
// sums against the exact sum and their worst-case bounds (src/sim/sumerror.ts). Nothing on screen is typed in: all computed.

import '../styles/fperror.css';
import { EPSILON, evalText, qOfBits, qText, relErr, UNIT_ROUNDOFF, ulpsOff, type Step } from '../sim/errorlab';
import { f32ToBits } from '../sim/fpref';
import { groupDigits } from '../sim/numfmt';
import { bounds, DATA_NAMES, dataset, errorCurve, exactSum, kahanSum, naiveSum, pairwiseSum, relErrOf, type DataKind, type SumPoint } from '../sim/sumerror';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const sci = (x: number) => (x === 0 ? '0' : x >= 0.01 && x < 1000 ? String(+x.toPrecision(3)) : x.toExponential(2).replace('e-', 'e−').replace('e+', 'e'));
const hex32 = (bits: number) => `0x${(bits >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const ulpText = (x: number | null) => (x === null ? 'n/a' : x === 0 ? '0' : x >= 1e5 ? groupDigits(Math.round(x)) : sci(x));
const relText = (x: number | null) => (x === null ? 'n/a' : x === 0 ? '0' : sci(x));

/** Cases: [name, A (as written), B (rewritten, or '')]. Binary-friendly literals where the point is the arithmetic, decimals where it is the input. */
const PRESETS: [string, string, string][] = [
  ['(1 + x) − 1', '(1 + 1e-8) - 1', ''],
  ['absorption', '(1e8 + 1) - 1e8', '1e8 - 1e8 + 1'],
  ['quadratic root', '(10000 - sqrt(10000*10000 - 4*1*0.1)) / (2*1)', '(2*0.1) / (10000 + sqrt(10000*10000 - 4*1*0.1))'],
  ['x² − y²', '1.000244140625*1.000244140625 - 1.0001220703125*1.0001220703125', '(1.000244140625 - 1.0001220703125) * (1.000244140625 + 1.0001220703125)'],
  ['Sterbenz', '1.0001 - 1.00005', ''],
  ['0.3 × 3 − 0.9', '0.3*3 - 0.9', ''],
];

function note(s: Step): string {
  if (s.op === 'num') return 'the decimal rounded to the nearest float32';
  const parts: string[] = [];
  if (s.sterbenz) parts.push(s.cancelled > 0 ? `exact (Sterbenz: y/2 ≤ x ≤ 2y); ${s.cancelled.toFixed(1)} bits cancel` : 'exact (Sterbenz)');
  else if (s.delta === 0 || s.delta === null) parts.push('exact');
  else parts.push(`own rounding ${s.delta.toFixed(2)} u`);
  if (s.cancelled >= 1 && !s.sterbenz) parts.push(`${s.cancelled.toFixed(1)} bits cancel`);
  if (s.amplify !== null && s.amplify >= 4) parts.push(`inherited error × ${s.amplify >= 1e4 ? sci(s.amplify) : Math.round(s.amplify)}`);
  return parts.join('; ');
}

function resultBlock(label: string, src: string): HTMLElement {
  const r = evalText(src);
  if ('error' in r) return h('div', { class: 'fe-res bad', role: 'status' }, h('strong', null, label), ` cannot be evaluated: ${r.error}`);
  const f = qOfBits(r.bits), rel = relErr(f, r.real), ulps = ulpsOff(f, r.real);
  const head = h('div', { class: 'fe-sum' },
    h('strong', null, label),
    h('span', null, 'float32 ', h('code', null, qText(f, 9)), ` (${hex32(r.bits)})`),
    h('span', null, '· real ', h('code', null, qText(r.real, 9))),
    h('span', null, '· error ', h('strong', { class: rel !== null && rel > 1e-3 ? 'fe-bad' : '' }, rel === null ? `absolute ${qText(f, 3)}, relative n/a (real value 0)` : `${relText(rel)} relative`),
      rel !== null ? `, ${ulpText(ulps)} ulp${ulps === 1 ? '' : 's'}${rel <= UNIT_ROUNDOFF ? ' (within u)' : ''}` : ''));
  const rows = r.steps.map((s) => {
    const sf = qOfBits(s.bits), re = relErr(sf, s.real);
    return h('tr', null, h('td', { class: 'fe-x' }, s.text), h('td', null, qText(sf, 9)), h('td', null, qText(s.real, 9)),
      h('td', null, ulpText(ulpsOff(sf, s.real))), h('td', null, relText(re)), h('td', { class: 'fe-n' }, note(s)));
  });
  const table = rows.length
    ? h('div', { class: 'fe-scroll' }, h('table', { class: 'fe-t' },
      h('thead', null, h('tr', null, ['step', 'float32', 'real', 'error in ulps', 'relative', 'this step'].map((t) => h('th', null, t)))), h('tbody', null, rows)))
    : h('p', { class: 'sub' }, 'Every value in this expression is exactly representable and no operation rounds: the float32 result is the real one.');
  return h('div', { class: 'fe-res' }, head, table);
}

/** (1 + x) − 1 for x = 10⁻¹ … 10⁻¹⁰: measured relative error against the bound u / x. */
function cancelChart(): SVGSVGElement {
  const W = 640, H = 230, L = 52, R = 14, T = 14, B = 34, js = Array.from({ length: 10 }, (_, i) => i + 1);
  const pts = js.map((j) => {
    const r = evalText(`(1 + 1e-${j}) - 1`);
    if ('error' in r) return { j, e: 0 };
    return { j, e: relErr(qOfBits(r.bits), r.real) ?? 0 };
  });
  const lo = -10, hi = 1, X = (j: number) => L + ((j - 1) / 9) * (W - L - R), Y = (v: number) => T + ((hi - Math.log10(Math.max(v, 1e-30))) / (hi - lo)) * (H - T - B);
  const clampY = (v: number) => Y(v <= 0 ? 10 ** lo : Math.min(Math.max(v, 10 ** lo), 10 ** hi));
  let g = '';
  for (let e = lo; e <= hi; e += 3) g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}"/><text class="lb" x="${L - 6}" y="${Y(10 ** e) + 3}" text-anchor="end">1e${String(e).replace('-', '−')}</text>`;
  for (const j of js) g += `<text class="lb" x="${X(j)}" y="${H - 16}" text-anchor="middle">${j}</text>`;
  g += `<text class="lb" x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle">x = 10⁻ʲ   (j)</text>`;
  const bound = js.map((j) => `${X(j)},${clampY(UNIT_ROUNDOFF / 10 ** -j)}`).join(' ');
  const meas = pts.map((p) => `${X(p.j)},${clampY(p.e)}`).join(' ');
  g += `<polyline class="bd" points="${bound}"/><polyline class="ms" points="${meas}"/>`;
  for (const p of pts) g += `<circle class="${p.e === 0 ? 'pt zero' : 'pt'}" cx="${X(p.j)}" cy="${clampY(p.e)}" r="4"><title>x = 1e−${p.j}: relative error ${p.e === 0 ? '0 (exact: plotted on the floor)' : sci(p.e)}</title></circle>`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'fe-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Relative error of (1 + x) − 1 in float32 for x from 0.1 to 1e-10: ${pts.map((p) => `${p.j}: ${relText(p.e)}`).join(', ')}. The bound is u over x.`);
  svg.innerHTML = g;
  return svg;
}

export function errorLab(): Widget {
  const inA = h('input', { type: 'text', class: 'fe-in', 'aria-label': 'expression A', spellcheck: 'false', value: PRESETS[2][1] }) as HTMLInputElement;
  const inB = h('input', { type: 'text', class: 'fe-in', 'aria-label': 'expression B, the rewritten form', spellcheck: 'false', value: PRESETS[2][2] }) as HTMLInputElement;
  const out = h('div', { class: 'fe-out', 'aria-live': 'polite' });
  const render = () => {
    out.replaceChildren(resultBlock('A', inA.value), ...(inB.value.trim() ? [resultBlock('B', inB.value)] : []));
  };
  inA.addEventListener('input', render);
  inB.addEventListener('input', render);
  const buttons = PRESETS.map(([name, a, b]) => h('button', { class: 'btn sm', onclick: () => { inA.value = a; inB.value = b; render(); } }, name));
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel fe' },
      h('h3', null, 'Error of an expression, step by step'),
      h('p', { class: 'sub' }, 'Each step is computed twice: in float32 (round to nearest even, after every operation) and exactly, from the decimal numbers as written (BigInt rationals; sqrt to 2⁻¹⁶⁰). A literal is first rounded to float32, as a compiler does. Operators: + − * / ( ) sqrt( ) and 2^-3 style powers.'),
      h('p', { class: 'fe-const' },
        'machine epsilon ε = 2⁻²³ = ', h('strong', null, sci(EPSILON)), ' (the gap from 1.0 to the next float) · unit roundoff u = ε/2 = 2⁻²⁴ = ', h('strong', null, sci(UNIT_ROUNDOFF)),
        ' (the worst relative error of one rounded operation under round to nearest; the directed modes lose a whole ε)'),
      h('div', { class: 'fe-presets', role: 'group', 'aria-label': 'cases' }, buttons),
      h('label', { class: 'fe-row' }, h('span', null, 'A'), inA),
      h('label', { class: 'fe-row' }, h('span', null, 'B'), inB),
      out,
      h('h4', { class: 'fe-h' }, 'Cancellation as x shrinks: (1 + x) − 1'),
      h('p', { class: 'sub' }, 'The subtraction itself is exact. The loss happened earlier: 1 + x was rounded to a multiple of ε, an absolute error of up to u that the subtraction leaves in place while the result shrinks to x. Relative error: up to u / x (dashed).'),
      cancelChart(),
      h('div', { class: 'fe-legend' }, h('span', { class: 'k ms' }, 'measured'), h('span', { class: 'k bd' }, 'bound u / x')))),
  };
}

// ---------------------------------------------------------------- summation

const KINDS = Object.keys(DATA_NAMES) as DataKind[];
const MAXK = 15;
const curves = new Map<DataKind, SumPoint[]>();
const curveOf = (k: DataKind) => { let c = curves.get(k); if (!c) curves.set(k, (c = errorCurve(k, MAXK))); return c; };

function sumChart(kind: DataKind, k: number): SVGSVGElement {
  const W = 640, H = 270, L = 52, R = 14, T = 14, B = 36, pts = curveOf(kind);
  const lo = -9, hi = 0, X = (n: number) => L + ((Math.log2(n) - 1) / (MAXK - 1)) * (W - L - R);
  const Y = (v: number) => T + ((hi - Math.log10(Math.min(Math.max(v, 10 ** lo), 10 ** hi))) / (hi - lo)) * (H - T - B);
  let g = '';
  for (let e = lo; e <= hi; e += 3) g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}"/><text class="lb" x="${L - 6}" y="${Y(10 ** e) + 3}" text-anchor="end">1e${String(e).replace('-', '−')}</text>`;
  for (let i = 1; i <= MAXK; i += 2) g += `<text class="lb" x="${X(2 ** i)}" y="${H - 18}" text-anchor="middle">2<tspan dy="-4" font-size="8">${i}</tspan></text>`;
  g += `<text class="lb" x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">number of terms n</text>`;
  const series = (key: 'naive' | 'pairwise' | 'kahan') => pts.map((p) => `${X(p.n)},${Y(p[key])}`).join(' ');
  const bound = (key: 'naive' | 'pairwise' | 'kahan') => pts.map((p) => `${X(p.n)},${Y(bounds(p.n)[key])}`).join(' ');
  for (const key of ['naive', 'pairwise', 'kahan'] as const) g += `<polyline class="bd ${key}" points="${bound(key)}"/>`;
  g += `<line class="cur" x1="${X(2 ** k)}" x2="${X(2 ** k)}" y1="${T}" y2="${H - B}"/>`;
  for (const key of ['naive', 'pairwise', 'kahan'] as const) {
    g += `<polyline class="ms ${key}" points="${series(key)}"/>`;
    for (const p of pts) {
      const c = `${X(p.n)},${Y(p[key])}`, [x, y] = c.split(',').map(Number), t = `<title>${key}, n = ${p.n}: relative error ${p[key] === 0 ? '0 (on the floor)' : sci(p[key])}</title>`;
      g += key === 'naive' ? `<circle class="pt ${key}" cx="${x}" cy="${y}" r="3.2">${t}</circle>`
        : key === 'pairwise' ? `<rect class="pt ${key}" x="${x - 3}" y="${y - 3}" width="6" height="6">${t}</rect>`
          : `<path class="pt ${key}" d="M${x} ${y - 4}L${x + 4} ${y + 3}L${x - 4} ${y + 3}Z">${t}</path>`;
    }
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'fe-chart');
  svg.setAttribute('role', 'img');
  const last = pts[pts.length - 1];
  svg.setAttribute('aria-label', `Relative error of three float32 sums against the number of terms, on ${DATA_NAMES[kind]}. At n = ${last.n}: naive ${sci(last.naive)}, pairwise ${sci(last.pairwise)}, Kahan ${sci(last.kahan)}.`);
  svg.innerHTML = g;
  return svg;
}

export function sumLab(): Widget {
  let kind: DataKind = 'absorb', k = 12;
  const sel = h('select', { 'aria-label': 'data set' }) as HTMLSelectElement;
  KINDS.forEach((d) => sel.append(h('option', { value: d, selected: d === kind }, DATA_NAMES[d])));
  const slider = h('input', { type: 'range', min: 1, max: MAXK, value: k, 'aria-label': 'number of terms, as a power of two' }) as HTMLInputElement;
  const kLabel = h('span', { class: 'fe-n2' });
  const chartHost = h('div'), table = h('div', { class: 'fe-scroll' });
  const render = () => {
    chartHost.replaceChildren(sumChart(kind, k));
    const n = 2 ** k, xs = dataset(kind, n), ex = exactSum(xs), b = bounds(n);
    kLabel.textContent = `n = ${groupDigits(n)}`;
    const ka = kahanSum(xs);
    const rows: [string, number, number][] = [['naive: s += x', naiveSum(xs), b.naive], ['pairwise: halves, recursively', pairwiseSum(xs), b.pairwise], ['Kahan: carries c', ka.sum, b.kahan]];
    table.replaceChildren(h('table', { class: 'fe-t' },
      h('thead', null, h('tr', null, ['sum', 'float32', 'error in ulps', 'relative error', 'worst case'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map(([name, s, bd]) => {
        const sf = qOfBits(f32ToBits(s));
        const rel = relErrOf(s, ex);
        return h('tr', null, h('td', { class: 'fe-x' }, name), h('td', null, qText(sf, 9)), h('td', null, ulpText(ulpsOff(sf, ex))), h('td', null, relText(rel)), h('td', null, `≤ ${sci(bd)}`));
      })),
      h('tfoot', null, h('tr', null, h('td', { colspan: 5, class: 'fe-n' }, `exact sum ${qText(ex, 9)} (BigInt over the float32 terms); u = ${sci(UNIT_ROUNDOFF)}`)))));
  };
  sel.addEventListener('change', () => { kind = sel.value as DataKind; render(); });
  slider.addEventListener('input', () => { k = Number(slider.value); render(); });
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel fe' },
      h('h3', null, 'Summing n numbers in float32'),
      h('p', { class: 'sub' }, 'Relative error of the three sums against the exact sum of the same float32 terms (all terms positive, so no cancellation inside the data). Dashed: the worst-case bounds, (n − 1)u for naive, ⌈log₂ n⌉u for pairwise, 2u + O(nu²) for Kahan. The curves are measured, and typically sit well below the bounds, except on data built to hit them.'),
      h('div', { class: 'param-row' }, sel, slider, kLabel),
      chartHost,
      h('div', { class: 'fe-legend' }, h('span', { class: 'k naive' }, '● naive'), h('span', { class: 'k pairwise' }, '■ pairwise'), h('span', { class: 'k kahan' }, '▲ Kahan'), h('span', { class: 'sub' }, 'floor of the plot: 1e−9 (exact results sit on it)')),
      table)),
  };
}
