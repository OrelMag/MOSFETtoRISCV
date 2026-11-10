// "The real thing"'s Numbers layer (chapter silicon): our static timing beside OpenSTA's after routing on the two sky130 layouts, path by
// path. skytiming.json is written by scripts/sky-paths.ts --write from a layout run's sky-paths-<design> artifact; tests/skypaths-spread.test.ts
// recomputes it from the paths kept in tests/sky/ and our netlists, so every number here is measured, and a change to the delay model shows.

import { PS_PER_UNIT } from '../../sim/delay';
import SKY from './skytiming.json';

interface Spread { n: number; median: number; p10: number; p90: number; cv: number; rho: number }
interface Summary {
  design: string; run: number; endpoints: number; worst: number; paths: number; sameStart: number;
  worstUnit: Spread; worstLoad: Spread; startUnit: Spread; startLoad: Spread;
  byPin: { kind: string; n: number; unit: number; unitCv: number; load: number; loadCv: number }[];
  byBlock: { block: string; n: number; sky: number; unit: number; load: number }[];
  slowest: { end: string; start: string; ours: string; sky: number; unit: number; load: number }[];
  caps: [number, number, number, number][];
}
export const SKY_TIMING = SKY as unknown as Record<'dual' | 'sys', Summary>;

const NAME: Record<'dual' | 'sys', string> = { dual: 'dual-core', sys: 'system core (RV32IM)' };
const pc = (x: number) => `${Math.round(x * 100)} %`;
const f2 = (x: number) => x.toFixed(2);
/** The layout runs' pages (the sky-paths artifacts the numbers come from). */
const RUNS = 'https://github.com/OrelMag/MOSFETtoRISCV/actions/runs/';
/** The value that occurs most often. */
const top = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
const code = (s: string) => `<code>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`;
// OpenSTA names a register bit after Yosys (rf.w25.ff12.q$_DFFE_PP_/D): the instance path is what our drawing shows
const pin = (s: string) => s.replace(/\.q\$_[A-Z_]+_\//, '/').replace(/\//g, '.').replace(/\.(D|DE)$/, ' ($1)');

/** The spreads the chapter quotes: ps per one of our delays, our worst path to each endpoint, unit and load model. */
export function skySpreads(d: 'dual' | 'sys') {
  const s = SKY_TIMING[d];
  return { unit: s.worstUnit.cv, load: s.worstLoad.cv, units: s.worstUnit.median, loads: s.worstLoad.median };
}

export function skyTimingHtml(): string {
  const ds = ['dual', 'sys'] as const;
  // the layer is a narrow pane: four or five short columns, a design's rows under a heading row
  const head = (d: 'dual' | 'sys', cols: number, extra = '') => `<tr><th colspan="${cols}">${NAME[d]}${extra}</th></tr>`;
  const row = (label: string, s: Spread) => `<tr><td>${label}</td><td>${s.median}</td><td>${s.p10}–${s.p90}</td><td>${pc(s.cv)}</td><td>${f2(s.rho)}</td></tr>`;
  const spreads = ds.map((d) => {
    const s = SKY_TIMING[d];
    return head(d, 5, `: ${s.paths} paths`) + row('unit, our worst', s.worstUnit) + row('load, our worst', s.worstLoad) + row('unit, from sky’s start', s.startUnit) + row('load, from sky’s start', s.startLoad);
  }).join('');
  const blocks = ds.map((d) => head(d, 4) + SKY_TIMING[d].byBlock.map((b) => `<tr><td>${code(b.block)}</td><td>${b.n}</td><td>${f2(b.sky)}</td><td>${b.unit} · ${b.load}</td></tr>`).join('')).join('');
  const paths = ds.map((d) => head(d, 4) + SKY_TIMING[d].slowest.map((p) =>
    `<tr><td>${code(pin(p.end))}</td><td>${code(p.start)}<br>${code(p.ours)}</td><td>${f2(p.sky)}</td><td>${Math.round((p.sky * 1000) / p.unit)} · ${Math.round((p.sky * 1000) / p.load)}</td></tr>`).join('')).join('');
  const caps = SKY_TIMING.sys.caps.map(([lo, hi, n, f], i) => {
    const dual = SKY_TIMING.dual.caps[i];
    return `<tr><td>${lo === hi ? lo : `${lo}–${hi}`}</td><td>${f} (${n})</td><td>${dual ? `${dual[3]} (${dual[2]})` : '–'}</td></tr>`;
  }).join('');
  const dual = SKY_TIMING.dual, sys = SKY_TIMING.sys;
  return `<p>Every endpoint of both layouts timed twice: by OpenSTA on the routed sky130 database (its worst path to each flip-flop pin and output: ${dual.endpoints} on the
    dual-core, ${sys.endpoints} on the system core, <a href="${RUNS}${dual.run}" target="_blank" rel="noopener">layout run ${dual.run}</a>${sys.run !== dual.run ? ` and <a href="${RUNS}${sys.run}" target="_blank" rel="noopener">${sys.run}</a>` : ''}), and by our static timing to the same pin, with the unit model (every NAND one delay) and the
    load model (logical effort). If our model timed paths the way the cells do, one of our delays would be worth the same picoseconds on every path: the spread
    (standard deviation over the mean) is the test, and the rank correlation ρ (1: the same order, 0: unrelated) says whether the two at least order the paths alike. Paths of at least a quarter of
    the worst (${f2(dual.worst)} and ${f2(sys.worst)} ns), each distinct timing once.</p>
  <table class="mini"><thead><tr><th>ps per our delay</th><th>median</th><th>middle 80 %</th><th>spread</th><th>ρ</th></tr></thead><tbody>${spreads}</tbody></table>
  <p><strong>The load model does not narrow the spread here</strong>: ${pc(dual.worstUnit.cv)} → ${pc(dual.worstLoad.cv)} on the dual-core, ${pc(sys.worstUnit.cv)} → ${pc(sys.worstLoad.cv)} on the system core.
    Nor does it order the paths much better: ρ ${f2(dual.worstUnit.rho)} → ${f2(dual.worstLoad.rho)} on the dual-core, ${f2(sys.worstUnit.rho)} → ${f2(sys.worstLoad.rho)} on the system core. Scale is not the error: about ${dual.worstLoad.median}–${sys.worstLoad.median} ps per
    load unit against the illustrative ${PS_PER_UNIT.toFixed(1)} is sky130 at 1.8 V against a 28 nm-class constant.</p>
  <table class="mini"><thead><tr><th>endpoint block</th><th>paths</th><th>sky ns</th><th>ps per delay: unit · load</th></tr></thead><tbody>${blocks}</tbody></table>
  <p>Each block's slowest path: where it ends, where it starts on silicon (above) and where our worst path to the same pin starts (below):</p>
  <table class="mini"><thead><tr><th>ends at</th><th>starts</th><th>sky ns</th><th>ps per delay: unit · load</th></tr></thead><tbody>${paths}</tbody></table>
  <p>Two reasons they differ. On the dual-core ours starts at a constant inside the multiprocessor decoder (${code('mpd.kA')}): our timing gives a tie cell an arrival of
    one delay, while synthesis folds constants into the logic, so on silicon that path does not exist (${dual.sameStart} of ${dual.paths} start alike). On the system core both mostly start at the instruction input, at different bits: ours at
    ${code(top(sys.slowest.map((p) => p.ours)))}, silicon's at ${code(top(sys.slowest.map((p) => p.start)))}, and in the register file ours starts at a register, launched at clock-to-q
    (${sys.sameStart} of ${sys.paths} start alike): the two netlists are different circuits for the same logic, so their longest paths need not begin at the same pin. Timed from silicon's own start the spread is no narrower, so the routes are not the
    whole story: wires are.</p>
  <table class="mini"><thead><tr><th>net fan-out</th><th>sys: fF per input (nets)</th><th>dual</th></tr></thead><tbody>${caps}</tbody></table>
  <p>Silicon's capacitance per input driven grows about threefold from a single sink to 5–16, pins and wire both, and the resizer (the flow's step that sizes cells and inserts buffers) splits wider nets into buffer trees. Our wire term is a constant per branch,
    so the load model charges a net's fan-out where silicon charges its length. The next step for the model is a wire term from placement, where a design has one.</p>`;
}
