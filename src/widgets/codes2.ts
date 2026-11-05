// Codes near the limit's explainers: the Reed-Solomon decoder on its gate-level scene (comm/rsrtl.ts in lock step), a burst from the inner code spread over the outer words (comm/ldpc.ts concatTrial), belief
// propagation on a graph small enough to read, density evolution's tunnel beside a real long code, and the waterfall on the Eb/N0 axis of comm/ber.ts.

import { codingGain, convSoftBound, shannonBinaryDb, shannonDb, uncodedBer, rsCurve } from '../comm/ber';
import { CONV_K7 } from '../comm/conv';
import { becThreshold, Bp, concatRate, concatTrial, deBecStep, ebn0OfSigma, erasures, ldpcTrial, peel, regularCode, type BpKind, type Tanner } from '../comm/ldpc';
import { RS_PHASE, RS_PHASE_NAMES, RsRtl, rsLatency } from '../comm/rsrtl';
import { rsDecode } from '../comm/rs';
import { rsDecoder } from '../lib/rsdec';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { RS_CHECK, RS_MESSAGE } from './codes';
import { line, mkChips, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/codes2.css';

const btn = (label: string, title: string, f: () => void, cls = 'btn sm'): HTMLButtonElement => {
  const b = h('button', { class: cls, type: 'button', title }, label) as HTMLButtonElement;
  b.addEventListener('click', f);
  return b;
};
const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();

// ---- the decoder on its scene -------------------------------------------------------------------------------------------------

const NSYM = 10, CW = [...RS_MESSAGE, ...RS_CHECK], LAT = rsLatency(NSYM, CW.length);
/** The bytes the slider corrupts, and their masks: a fixed scatter, so a level of damage always means the same word. */
export const RS_HITS = [3, 9, 14, 20, 24, 1, 6, 17, 22];
export const RS_MASKS = [0x5a, 0x81, 0x3c, 0xff, 0x07, 0x99, 0x40, 0xe2, 0x1b];
export const rsWordHit = (n: number): number[] => { const w = CW.slice(); for (let i = 0; i < n; i++) w[RS_HITS[i]] ^= RS_MASKS[i]; return w; };

export interface RsDecApi { decode(hits: number): void; hits(): number; finished(): boolean; failed(): boolean; right(): boolean }
export const rsDecApi = new WeakMap<Stage, RsDecApi>();

function rsDecPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    let hits = 0, model = new RsRtl(NSYM, CW.length), t = 0, out: number[] = [], run = 0, roots = 0;
    const hook = { before: () => {
      if (!stage.sim) return;
      const en = Number(stage.value('en')), rst = Number(stage.value('rst')), d = Number(stage.value('d'));
      const c = model.comb(en);
      if (!rst && c.valid) { out = [...out, c.out]; if (c.root) roots++; }
      model.step(d, en, rst);
      if (rst) { t = 0; out = []; roots = 0; } else t++;
    } };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({ save: () => ({ m: structuredClone({ ...model }), t, out, hits, run, roots }), restore: (v) => { const o = v as { m: RsRtl; t: number; out: number[]; hits: number; run: number; roots: number }; Object.assign(model, structuredClone(o.m)); t = o.t; out = o.out; hits = o.hits; run = o.run; roots = o.roots; update(); } });
    stage.resetHooks.add(() => { model = new RsRtl(NSYM, CW.length); t = 0; out = []; run = 0; roots = 0; update(); });
    const edge = (d: number, en: number, rst: number) => {
      const sim = stage.sim!;
      sim.setInput('d', d); sim.setInput('en', en); sim.setInput('rst', rst); sim.settle();
      hook.before();
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      sim.setInput('en', 0); sim.setInput('rst', 0); sim.settle();
    };
    const word = () => rsWordHit(hits);
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const start = () => { edge(0, 0, 1); run = hits + 1; };
    const clockOne = () => {
      if (!run || model.phase === RS_PHASE.DONE) start();
      const w = word();
      if (model.phase === RS_PHASE.RX) edge(w[model.cnt], 1, 0); else edge(0, 0, 0);
    };
    const toNext = () => { const p = model.phase === RS_PHASE.DONE ? -1 : model.phase; if (p < 0 || !run) start(); const q = model.phase; while (model.phase === q && model.phase !== RS_PHASE.DONE) clockOne(); };
    const toEnd = () => { start(); while (model.phase !== RS_PHASE.DONE) clockOne(); };
    const reg = (name: string, port: string) => { const nd = stage.sim!.design.root.children!.get(name)!; return Array.from(stage.sim!.getBits(nd.ports[port])).reduce<number>((a, b, k) => a + Number(b) * 2 ** k, 0); };
    const phases = h('div', { class: 'cn-phases' }), lamEl = h('div', { class: 'cd-bytes' }), omEl = h('div', { class: 'cd-bytes' }), outEl = h('div', { class: 'cd-bytes cd-word' }), status = h('div', { class: 'cd-bytes cn-read' }), verdict = h('p', { class: 'err-verdict' });
    const damage = slider('Bytes hit', 0, 9, 1, hits, (v) => String(v), (v) => { hits = v; update(); });
    const update = () => {
      if (!stage.sim) return;
      const ok = model.lam.every((v, j) => reg(`l${j}`, 'l') === v) && model.om.every((v, j) => reg(`o${j}`, 'q') === v) && model.ring.every((v, k) => reg(`s${k}`, 'q') === v) && Number(stage.value('done')) === (model.phase === RS_PHASE.DONE ? 1 : 0);
      phases.replaceChildren(...RS_PHASE_NAMES.map((n, i) => h('span', { class: `cn-phase${model.phase === i ? ' on' : model.phase > i ? ' past' : ''}` }, n)));
      lamEl.replaceChildren(h('span', { class: 'cn-name' }, 'λ'), ...model.lam.map((v) => h('span', { class: `err-bit cd-b${v ? ' par' : ''}` }, hex2(v))));
      omEl.replaceChildren(h('span', { class: 'cn-name' }, 'Ω'), ...model.om.map((v) => h('span', { class: `err-bit cd-b${v ? ' par' : ''}` }, hex2(v))));
      const w = word();
      outEl.replaceChildren(...CW.map((b, i) => {
        const sent = i < out.length, v = sent ? out[i] : w[i], cls = sent ? (v === b ? (w[i] !== b ? ' fix' : ' sent') : ' hit') : w[i] !== b ? ' hit' : '';
        return h('span', { class: `err-bit cd-b${cls}`, title: `byte ${i}` }, hex2(v));
      }));
      const c = model.comb(0);
      status.replaceChildren(h('span', null, `clock ${t} of ${LAT}`), h('span', null, `δ ${hex2(c.delta)}`), h('span', null, `roots found ${roots}`), h('span', { class: `cd-tag ${ok ? 'good' : 'bad'}` }, ok ? 'gates = model ✓' : 'gates ≠ model'));
      if (model.phase !== RS_PHASE.DONE || !run) { verdict.className = 'err-verdict'; verdict.textContent = model.phase === RS_PHASE.RX ? `Press Decode to clock the word through, or a phase at a time. ${hits} byte${hits === 1 ? '' : 's'} hit.` : `In ${RS_PHASE_NAMES[model.phase]}.`; return; }
      const fail = Number(stage.value('fail')) === 1, right = out.every((v, i) => v === CW[i]), soft = rsDecode(rsWordHit(run - 1), NSYM);
      verdict.className = `err-verdict ${!fail && right ? 'ok' : 'bad'}`;
      verdict.textContent = fail
        ? `${run - 1} bytes hit, more than t = 5. The locator's roots do not number its degree, so the decoder raises fail. The bytes have already gone out, as they were: a stream cannot be recalled, which is why fail matters. The software decoder agrees${soft.word === null ? '' : ' not'}: it also refuses.`
        : right ? `${run - 1} byte${run === 2 ? '' : 's'} hit, whatever the bits in them. All corrected in ${LAT} clocks, with no flag raised.`
          : `${run - 1} bytes hit, and the decoder landed on a different code word without raising fail: a miscorrection, the case only a CRC above it can catch.`;
    };
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel cd-rs', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'RS (26, 16), the decoder', h('span', { class: 'fold-hint' })), damage.el,
      h('div', { class: 'dram-ops' }, btn('Decode', 'Reset, the word in, and every phase', () => act(toEnd)), btn('Next phase', 'Run to the end of this phase', () => act(toNext)), btn('Clock', 'One clock edge', () => act(clockOne))),
      phases, status, lamEl, omEl, h('p', { class: 'sub' }, 'The word: hit bytes in red, corrected in green once sent.'), outEl, verdict);
    update();
    rsDecApi.set(stage, {
      decode: (n) => { hits = n; act(toEnd); }, hits: () => (run ? run - 1 : -1), finished: () => !!run && model.phase === RS_PHASE.DONE,
      failed: () => Number(stage.value('fail')) === 1, right: () => out.length === CW.length && out.every((v, i) => v === CW[i]),
    });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); rsDecApi.delete(stage); } };
  };
}

export function rsDecScene(): Scene {
  return { root: rsDecoder(NSYM, CW.length), inputs: { d: 0, en: 0, rst: 0, clk: 0 }, clock: 'clk', autoClock: false, hiddenInputs: ['d', 'en', 'rst'], panels: [rsDecPanel()] };
}

// ---- a burst, inner code to outer words ----------------------------------------------------------------------------------------

/** Total bytes in a frame, for every depth: 8 words of 255. */
export const CONCAT_BYTES = 8 * 255;

export function concatWidget(): Widget {
  let db = 2.2, depth = 8, seed = 1, running = false;
  const map = s('svg', { viewBox: '0 0 640 54', class: 'mos-plot cn-map', role: 'img', 'aria-label': 'Which bytes of the stream the Viterbi decoder left wrong: errors come in bursts' }) as SVGSVGElement;
  const words = s('svg', { viewBox: '0 0 640 130', class: 'mos-plot cn-map', role: 'img', 'aria-label': 'Wrong bytes per Reed-Solomon word, against the sixteen it can correct' }) as SVGSVGElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const send = () => {
    if (running) return;
    running = true;
    const errs: number[] = [], D = depth, frames = 8 / D, perWord = new Array<number>(8).fill(0);
    const r = concatTrial(db, { depth: D, frames, seed, errs });
    // errs: positions over the whole stream of `frames` frames, each frame by columns of D words
    errs.forEach((p) => { const f = Math.floor(p / (D * 255)), i = p - f * D * 255; perWord[f * D + i % D]++; });
    map.replaceChildren(s('rect', { x: 0, y: 8, width: 640, height: 30, class: 'cn-track' }), ...errs.map((p) => s('rect', { x: (p / CONCAT_BYTES) * 640, y: 8, width: Math.max(1, 640 / CONCAT_BYTES), height: 30, class: 'cn-err' })), s('text', { x: 0, y: 50, class: 'cn-lab' }, `${r.bytes.toLocaleString('en')} bytes as sent, left to right; each stripe a byte the Viterbi decoder left wrong`));
    const Y = (v: number) => 112 - Math.min(v, 32) * 3;
    words.replaceChildren(s('line', { x1: 0, x2: 640, y1: Y(16), y2: Y(16), class: 'cn-limit' }), s('text', { x: 636, y: Y(16) - 3, 'text-anchor': 'end', class: 'cn-lab' }, 't = 16'),
      ...perWord.flatMap((v, i) => [s('rect', { x: 12 + i * 78, y: Y(v), width: 60, height: 112 - Y(v), class: v > 16 ? 'cn-bar bad' : 'cn-bar' }), s('text', { x: 42 + i * 78, y: Y(v) - 3, 'text-anchor': 'middle', class: 'cn-lab' }, String(v)), s('text', { x: 42 + i * 78, y: 126, 'text-anchor': 'middle', class: 'cn-lab' }, `word ${i}`)]));
    chips.set(0, `${(r.innerBitErrors / r.innerBits).toExponential(1).replace('e-', ' × 10⁻').replace(/⁻(\d)$/, (_, d) => `⁻${'⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]}`)}`, 'bit error rate after Viterbi');
    chips.set(1, `${r.byteErrors}`, 'wrong bytes in the frame');
    chips.set(2, `${r.failed} of ${r.words}`, 'Reed-Solomon words lost', r.failed ? 'bad' : 'ok');
    chips.set(3, (100 * concatRate()).toFixed(1) + ' %', 'of the channel carries data');
    note.textContent = `Viterbi's errors come in bursts, a wrong path followed for a while before the survivors merge again. With depth 1 a burst lands on one word. With depth ${D === 1 ? 8 : D} it is shared among ${D === 1 ? 8 : D}. Same wrong bytes, same rate, and only the arrangement differs.`;
    running = false;
    seed++;
  };
  const sel = h('select', { 'aria-label': 'Interleaver depth' }, ...[1, 2, 8].map((v) => h('option', { value: String(v), selected: v === depth ? true : undefined }, `Depth ${v}`))) as HTMLSelectElement;
  sel.addEventListener('change', () => { depth = Number(sel.value); });
  note.textContent = 'Press Send a frame: about 16 000 data bits through the real encoder, noise and decoder, so it takes a moment.';
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'What Viterbi leaves'), map),
    h('div', { class: 'panel' }, h('h3', null, 'What each Reed-Solomon word sees'), words),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, sel,
      slider('Eb/N0', 1.6, 3.2, 0.1, db, (v) => `${v.toFixed(1)} dB`, (v) => { db = v; }).el, btn('Send a frame', 'Run a frame through both codes', send)), chips.el, note)) };
}

// ---- belief propagation, small enough to read ---------------------------------------------------------------------------------

/** A (3, 6) code of 12 bits, six checks (comm/ldpc.ts regularCode, this seed). So few bits cannot avoid short cycles: pairs of checks share 2.4 bits on average. */
export const GOSSIP_SEED = 7;
const GOSSIP_CONF = 2.5, GOSSIP_WRONG = -1, GOSSIP_UNSURE = 0.3;
/** Two wrong bits the code can correct, from the steady start (tests/comm-ldpc-chapter.test.ts). */
export const GOSSIP_PAIR = [0, 7];

export function gossipWidget(): Widget {
  const t: Tanner = regularCode(12, 3, 6, GOSSIP_SEED);
  const VX = (v: number) => 24 + v * 52, CX = (c: number) => 50 + c * 108, VY = 196, CY = 34;
  let ch = new Float64Array(12).fill(GOSSIP_CONF);
  let bp = new Bp(t, ch);
  const svg = s('svg', { viewBox: '0 0 620 236', class: 'mos-plot cn-graph', role: 'group', 'aria-label': 'The code as a graph: six checks above, twelve bits below' }) as SVGSVGElement;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const reset = () => { bp = new Bp(t, ch); paint(); };
  const cycle = (v: number) => { ch[v] = ch[v] === GOSSIP_CONF ? GOSSIP_UNSURE : ch[v] === GOSSIP_UNSURE ? GOSSIP_WRONG : GOSSIP_CONF; reset(); };
  const wrongNow = () => bp.hard.reduce((a, b) => a + b, 0);
  function paint() {
    const parts: SVGElement[] = [];
    for (let e = 0; e < t.edgeVar.length; e++) {
      const v = t.edgeVar[e], c = t.edgeChk[e], m = bp.c2v[e], w = Math.min(5, 0.6 + Math.abs(m));
      parts.push(s('line', { x1: VX(v), y1: VY - 13, x2: CX(c), y2: CY + 12, class: bp.iterations ? (m >= 0 ? 'cn-msg good' : 'cn-msg bad') : 'cn-msg', 'stroke-width': bp.iterations ? w : 1 }));
    }
    for (let c = 0; c < t.m; c++) {
      let par = 0;
      for (let i = t.chkOff[c]; i < t.chkOff[c + 1]; i++) par ^= bp.hard[t.edgeVar[t.chkEdges[i]]];
      parts.push(s('rect', { x: CX(c) - 13, y: CY - 13, width: 26, height: 26, rx: 3, class: par ? 'cn-chk bad' : 'cn-chk' }), s('text', { x: CX(c), y: CY + 4, 'text-anchor': 'middle', class: 'cn-t' }, par ? '✕' : '＋'));
    }
    for (let v = 0; v < t.n; v++) {
      const g = s('g', { role: 'button', tabindex: 0, 'aria-label': `Bit ${v}: channel ${ch[v].toFixed(1)}, now ${bp.post[v].toFixed(1)}`, class: 'cn-var-g' });
      g.addEventListener('click', () => cycle(v));
      g.addEventListener('keydown', (ev) => { const k = (ev as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { ev.preventDefault(); cycle(v); } });
      g.append(s('circle', { cx: VX(v), cy: VY, r: 14, class: `cn-var ${bp.hard[v] ? 'bad' : ch[v] === GOSSIP_CONF ? '' : 'weak'}` }), s('text', { x: VX(v), y: VY + 4, 'text-anchor': 'middle', class: 'cn-t' }, bp.post[v].toFixed(1).replace('-', '−')), s('text', { x: VX(v), y: VY + 28, 'text-anchor': 'middle', class: 'cn-lab' }, ch[v].toFixed(1).replace('-', '−')));
      parts.push(g);
    }
    svg.replaceChildren(...parts);
    const unsat = bp.ok ? 0 : (() => { let n = 0; for (let c = 0; c < t.m; c++) { let p = 0; for (let i = t.chkOff[c]; i < t.chkOff[c + 1]; i++) p ^= bp.hard[t.edgeVar[t.chkEdges[i]]]; n += p; } return n; })();
    chips.set(0, String(bp.iterations), 'iterations');
    chips.set(1, String(wrongNow()), 'bits wrong now', wrongNow() ? 'bad' : 'ok');
    chips.set(2, String(unsat), 'checks not satisfied', unsat ? 'bad' : 'ok');
    note.textContent = bp.iterations === 0
      ? 'The number in a circle is the bit\'s total belief so far, under it what the channel said (positive: probably 0). Click a bit to make the channel unsure of it, then wrong.'
      : bp.ok && wrongNow() === 0 ? `All checks hold and every bit is right, after ${bp.iterations} round${bp.iterations === 1 ? '' : 's'}. Green lines say "you are a 0", red "you are a 1", width how sure.`
        : bp.ok ? 'All checks hold, on a different code word: this decoder has no way to know.' : 'A check tells each bit what the others imply, and how sure the least sure of them is. Keep stepping.';
  }
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Twelve bits, six checks of six, three checks a bit'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'dram-ops' },
      btn('Iterate', 'Every bit speaks, then every check answers', () => { bp.iterate(); paint(); }), btn('Start over', 'Back to what the channel said', reset),
      btn('Clean channel', 'Every bit sure and right', () => { ch = new Float64Array(12).fill(GOSSIP_CONF); reset(); })), chips.el, note)),
 };
}

// ---- density evolution's tunnel -----------------------------------------------------------------------------------------------

export function tunnelWidget(): Widget {
  let eps = 0.4;
  const th = becThreshold(), code = regularCode(4000, 3, 6, 3);
  const plot = plotOf({ W: 640, H: 300, x: [0, 0.55], y: [0, 0.55], yTicks: [0, 0.1, 0.2, 0.3, 0.4, 0.5], xLabel: 'erased, this round', yLabel: 'erased, next round', aria: 'The recursion x next = eps (1 - (1 - x)^5)^2 against the diagonal, with the decoder\'s steps between them' });
  plot.setX(0.55);
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    plot.clear();
    const xs = Array.from({ length: 111 }, (_, i) => i * 0.005);
    line(plot, xs, xs, 'ln-s near');
    line(plot, xs, xs.map((x) => deBecStep(eps, x)), 'ln-s real');
    // the decoder's steps: from ε, up to the curve and over to the diagonal
    let x = eps, n = 0, d = `M${plot.X(x)} ${plot.Y(x)}`;
    for (; n < 400; n++) { const y = deBecStep(eps, x); d += ` L${plot.X(x)} ${plot.Y(y)} L${plot.X(y)} ${plot.Y(y)}`; if (y < 1e-9 || x - y < 1e-7) { x = y; break; } x = y; }
    plot.layer.append(s('path', { d, class: 'cn-web' }));
    const falls = x < 1e-6, ch = erasures(code.n, eps, 11), r = peel(code, ch, 400);
    chips.set(0, th.toFixed(4), 'threshold ε*, from the recursion', eps <= th ? 'ok' : 'bad');
    chips.set(1, falls ? String(n + 1) : 'stuck', falls ? 'rounds in the limit of long codes' : `at ${(100 * x).toFixed(1)} % erased`, falls ? 'ok' : 'bad');
    chips.set(2, `${r.left} of ${code.n}`, 'bits left erased: a real code of 4000', r.left ? 'bad' : 'ok');
    chips.set(3, '0.5', 'what Shannon allows at rate ½');
    note.textContent = eps <= th
      ? `Below the threshold the curve stays under the diagonal, and the decoder walks down the tunnel to zero. Near ε* the tunnel is narrow, so the steps pile up there: that is where the iterations go.`
      : `The curve has touched the diagonal, and the walk stops where they meet, however long the code. ε* = ${th.toFixed(4)} belongs to this degree pair: (3, 6) falls ${(0.5 - th).toFixed(3)} short of capacity, and irregular degree pairs can close that gap.`;
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'The share of erased messages, round by round'), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, slider('Erased ε', 0.2, 0.55, 0.005, eps, (v) => v.toFixed(3), (v) => { eps = v; paint(); }).el), chips.el, note)) };
}

// ---- the waterfall ------------------------------------------------------------------------------------------------------------

/** Points already measured with comm/ldpc.ts's concatTrial and pinned in tests/comm-codes-chapter.test.ts: Eb/N0, words failed of 384 at depth 8. */
export const CONCAT_POINTS: [number, number][] = [[2.2, 29 / 384], [2.3, 5 / 384]];
/** Words failed of CONCAT_WORDS at 2.3 dB at depths 1, 2 and 8: tests/comm-codes-chapter.test.ts runs exactly these. */
export const CONCAT_MEASURED = [52, 25, 5], CONCAT_WORDS = 384;

export interface FallPoint { db: number; ber: number; errors: number; bits: number; meanIter: number; n: number }

/** Message updates a data bit against Viterbi's add-compares, as the rate and the mean iterations move. */
export function costWidget(): Widget {
  let dv = 3, it = 18;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const dc = 2 * dv, msgs = (2 * dv) / 0.5;
    chips.set(0, String(msgs * it), `message updates a data bit, (${dv}, ${dc}) at rate ½`);
    chips.set(1, '128', 'add-compares a data bit, K = 7 Viterbi');
    chips.set(2, `${(msgs * it / 128).toFixed(1)} ×`, 'LDPC against Viterbi, in operations');
    note.textContent = 'Operations are not the bottleneck. Every edge needs its message in memory, and a bit may reach any check in the block: that is what the silicon pays for.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
    slider('Bit degree', 2, 6, 1, dv, (v) => String(v), (v) => { dv = v; paint(); }).el,
    slider('Iterations', 2, 60, 1, it, (v) => String(v), (v) => { it = v; paint(); }).el), chips.el, note)) };
}

export function waterfallWidget(): Widget {
  let n = 2016, kind: BpKind = 'sum-product', running = 0, raf = 0;
  const plot = plotOf({ W: 640, H: 320, x: [0, 8], y: [-7, 0], yTicks: [-7, -6, -5, -4, -3, -2, -1, 0], xLabel: 'Eb/N0, dB', yLabel: 'bit error rate', aria: 'Bit error rate against Eb/N0 for several codes, with Shannon\'s limit', xFmt: (v) => String(v), yFmt: (v) => (v === 0 ? '1' : `10⁻${'⁰¹²³⁴⁵⁶⁷'[-v]}`) });
  plot.setX(8);
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' }), pts: FallPoint[] = [];
  const log = (v: number) => Math.max(-8, Math.log10(Math.max(v, 1e-9)));
  const curve = (f: (d: number) => number, cls: string, a = 0, b = 8) => { const xs = Array.from({ length: 81 }, (_, i) => a + ((b - a) * i) / 80); line(plot, xs, xs.map((x) => log(f(x))), cls); };
  const vmark = (x: number, cls: string, label: string, y: number) => { plot.layer.append(s('line', { x1: plot.X(x), x2: plot.X(x), y1: plot.Y(0), y2: plot.Y(-7), class: `cn-v ${cls}` }), s('text', { x: plot.X(x) + 3, y: plot.Y(y), class: 'cn-lab' }, label)); };
  const paint = () => {
    plot.clear();
    curve(uncodedBer, 'ln-s near');
    curve((d) => convSoftBound(CONV_K7, d), 'ln-s real', 2.5);
    curve((d) => rsCurve(d, 255, 223), 'ln-s cn-rs', 3.5);
    vmark(shannonBinaryDb(0.5), 'lim', 'limit at rate ½', -6.7);
    vmark(ebn0OfSigma(0.8825), 'th', '(3, 6) threshold', -5.9);
    for (const [d, p] of CONCAT_POINTS) plot.layer.append(s('rect', { x: plot.X(d) - 3.5, y: plot.Y(Math.log10(p)) - 3.5, width: 7, height: 7, class: 'cn-sq' }));
    for (const p of pts) plot.layer.append(s('circle', { cx: plot.X(p.db), cy: plot.Y(log(p.errors ? p.ber : 1 / p.bits)), r: 4, class: `${p.errors ? 'cn-pt' : 'cn-pt hollow'} n${p.n}` }));
    const last = pts[pts.length - 1];
    chips.set(0, last ? `${last.errors ? last.ber.toExponential(1) : `< ${(1 / last.bits).toExponential(0)}`}` : '–', last ? `at ${last.db.toFixed(1)} dB, ${last.errors} errors in ${last.bits.toLocaleString('en')} bits` : 'bit error rate');
    chips.set(1, last ? last.meanIter.toFixed(1) : '–', 'iterations a word, on average');
    chips.set(2, `${codingGain((d) => convSoftBound(CONV_K7, d), 1e-5).toFixed(1)} dB`, 'K = 7 soft\'s gain at 10⁻⁵, the code to beat');
  };
  const sweep = () => {
    cancelAnimationFrame(raf);
    const code = regularCode(n, 3, 6, 5), id = ++running, doses = [0.8, 1.2, 1.6, 2, 2.4, 2.8];
    let i = 0, seed = 1, cur: FallPoint | null = null;
    pts.length = 0;
    const tick = () => {
      if (id !== running) return;
      const t0 = performance.now();
      while (i < doses.length && performance.now() - t0 < 12) {
        if (!cur) { cur = { db: doses[i], ber: 0, errors: 0, bits: 0, meanIter: 0, n }; pts.push(cur); }
        const r = ldpcTrial(code, doses[i], 1, { kind, seed: seed++, maxIter: 60 });
        cur.meanIter = (cur.meanIter * cur.bits + r.meanIter * r.bits) / (cur.bits + r.bits);
        cur.errors += r.errors; cur.bits += r.bits; cur.ber = cur.errors / cur.bits;
        if (cur.errors >= 400 || cur.bits >= 600 * n) { i++; cur = null; }
      }
      paint();
      if (i < doses.length) raf = requestAnimationFrame(tick);
      else note.textContent = `${n}-bit words with ${kind === 'sum-product' ? 'sum-product' : 'min-sum, scaled by 0.8'}. Dots: real runs of the decoder (hollow: none wrong, so 1 in the number of bits is only a ceiling). Squares: K = 7 with RS(255, 223), measured at depth 8. A longer word falls more steeply and closer to the threshold, at more delay.`;
    };
    note.textContent = 'Running: a real decoder on real noise.';
    raf = requestAnimationFrame(tick);
  };
  const sel = h('select', { 'aria-label': 'Word length' }, ...[504, 2016, 8064].map((v) => h('option', { value: String(v), selected: v === n ? true : undefined }, `${v} bits`))) as HTMLSelectElement;
  sel.addEventListener('change', () => { n = Number(sel.value); sweep(); });
  const kindSel = h('select', { 'aria-label': 'Decoder' }, h('option', { value: 'sum-product' }, 'Sum-product'), h('option', { value: 'min-sum' }, 'Min-sum')) as HTMLSelectElement;
  kindSel.addEventListener('change', () => { kind = kindSel.value as BpKind; sweep(); });
  paint();
  note.textContent = `Solid: uncoded, RS(255, 223) and K = 7 soft, as on the earlier plot. Shannon's limit is ${shannonDb(0.5).toFixed(1)} dB with any input, ${shannonBinaryDb(0.5).toFixed(2)} dB with ±1. Press Run.`;
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'One axis for all of them'), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, sel, kindSel, btn('Run the decoder', 'A sweep of real runs, in the page', sweep)), chips.el, note)),
    destroy: () => { running++; cancelAnimationFrame(raf); } };
}
