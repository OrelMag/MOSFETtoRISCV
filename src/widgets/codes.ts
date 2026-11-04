// Chapter 47's stronger codes: bit error rate against Eb/N0 (closed forms from comm/ber.ts, a live run of the real decoders on top), the convolutional
// encoder and the Viterbi decoder on their gate-level scenes with the golden model in lock step and the trellis drawn from it, the Reed-Solomon encoder
// with the model's decoder on the word it made, and interleaving against a burst.

import '../styles/errors.css';
import { BER_CHUNK, BER_MAX_BITS, BER_MIN_ERRORS, channelP, codingGain, convHardBound, convSoftBound, convTrial, rsCurve, secdedBer, shannonBinaryDb, shannonDb, trialSeed, uncodedBer } from '../comm/ber';
import { CONV_K3, CONV_K7, Viterbi, convEncode, convStep, statesOf } from '../comm/conv';
import { codeOf, secdedDecode, secdedEncode } from '../comm/fec';
import { deinterleave, interleave, placeOf, secdedOverBursts, worstPerWord } from '../comm/interleave';
import { rsDecode, rsGenerator, rsStep } from '../comm/rs';
import { convEncoder, rsEncoder, viterbi } from '../lib';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { fitText, slider } from './mosparts';

const btn = (label: string, title: string, f: () => void, cls = 'btn sm'): HTMLButtonElement => {
  const b = h('button', { type: 'button', class: cls, title }, label) as HTMLButtonElement;
  b.addEventListener('click', f);
  return b;
};
const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const sci = (x: number): string => {
  if (x === 0) return '0';
  const [m, e] = x.toExponential(1).split('e');
  return `${m.replace(/\.0$/, '')} × 10${[...String(Number(e))].map((c) => SUP[c] ?? c).join('')}`;
};

// ---- bit error rate against Eb/N0 ---------------------------------------------------------------------------------------

interface Curve { key: string; name: string; cls: string; rate: number; f: (db: number) => number }

const CURVES: Curve[] = [
  { key: 'none', name: 'Uncoded', cls: 'c1', rate: 1, f: uncodedBer },
  { key: 'secded', name: 'SEC-DED (72, 64)', cls: 'c2', rate: 64 / 72, f: (d) => secdedBer(d) },
  { key: 'rs', name: 'RS (255, 223)', cls: 'c3', rate: 223 / 255, f: (d) => rsCurve(d, 255, 223) },
  { key: 'hard', name: 'K = 7, hard', cls: 'c4', rate: 0.5, f: (d) => convHardBound(CONV_K7, d) },
  { key: 'soft', name: 'K = 7, soft', cls: 'c5', rate: 0.5, f: (d) => convSoftBound(CONV_K7, d) },
];

/** `keys`: which curves it starts with. */
export function berWidget(keys: string[] = CURVES.map((c) => c.key)): Widget {
  let db = 4, alive = true, timer = 0;
  const W = 620, H = 300, M = { l: 78, r: 14, t: 12, b: 36 }, X0 = -2, X1 = 12, Y0 = -8, Y1 = 0;
  const X = (d: number) => M.l + ((d - X0) / (X1 - X0)) * (W - M.l - M.r);
  const Y = (b: number) => M.t + ((Y1 - Math.log10(Math.max(b, 10 ** (Y0 - 1)))) / (Y1 - Y0)) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot err-plot', role: 'img', 'aria-label': 'Bit error rate against Eb/N0 for each code, with Shannon\'s limit for rate one half' }) as SVGSVGElement;
  for (let e = Y0; e <= Y1; e++) svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(10 ** e), y2: Y(10 ** e), class: 'grid' }), s('text', { x: M.l - 6, y: Y(10 ** e) + 3.5, 'text-anchor': 'end', class: 'tick' }, `1e${e}`));
  for (let d = X0; d <= X1; d += 2) svg.append(s('line', { x1: X(d), x2: X(d), y1: M.t, y2: H - M.b, class: 'grid' }), s('text', { x: X(d), y: H - M.b + 14, 'text-anchor': 'middle', class: 'tick' }, `${d}`));
  svg.append(s('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'ax' }), s('line', { x1: M.l, x2: M.l, y1: M.t, y2: H - M.b, class: 'ax' }),
    s('text', { x: W - M.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'Eb/N0, dB'), s('text', { x: 6, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${M.t})`, class: 'axl' }, 'bit error rate'));
  const lim = shannonDb(0.5), limB = shannonBinaryDb(0.5);
  svg.append(s('line', { x1: X(lim), x2: X(lim), y1: M.t, y2: H - M.b, class: 'bound' }), s('text', { x: X(lim) + 4, y: H - M.b - 6, class: 'tick' }, 'Shannon, rate ½'));
  fitText(svg, W);
  const marker = svg.appendChild(s('line', { class: 'cd-mark', y1: M.t, y2: H - M.b }));
  const dots = svg.appendChild(s('g'));
  const on = new Set(keys), paths = new Map<string, SVGElement>();
  const pts = Array.from({ length: 141 }, (_, i) => X0 + (i * (X1 - X0)) / 140);
  for (const c of CURVES) {
    const d = pts.map((x) => [x, c.f(x)] as const).filter(([, b]) => b >= 10 ** Y0 && b < 0.2).map(([x, b], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(b).toFixed(1)}`).join('');
    paths.set(c.key, svg.appendChild(s('path', { class: `err-s ${c.cls}`, d })) as SVGElement);
  }
  const key = h('div', { class: 'seg cd-seg', role: 'group', 'aria-label': 'Curves shown' });
  const tab = h('div', { class: 'err-tab' }), note = h('p', { class: 'sub mos-note' }), runNote = h('p', { class: 'sub' });
  const row = (c: string, ...v: string[]) => h('div', { class: `err-trow cd-trow ${c}` }, ...v.map((x) => h('span', null, x)));
  CURVES.forEach((c) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(on.has(c.key)), class: `cd-key ${c.cls}` }, c.name) as HTMLButtonElement;
    b.addEventListener('click', () => { if (on.has(c.key)) on.delete(c.key); else on.add(c.key); b.setAttribute('aria-pressed', String(on.has(c.key))); paint(); });
    key.append(b);
  });
  const paint = () => {
    marker.setAttribute('x1', String(X(db))); marker.setAttribute('x2', String(X(db)));
    for (const c of CURVES) paths.get(c.key)!.style.display = on.has(c.key) ? '' : 'none';
    tab.replaceChildren(row('head', 'code', 'rate', 'channel bit wrong', 'decoded bit wrong', 'gain at 10⁻⁵'),
      ...CURVES.filter((c) => on.has(c.key)).map((c) => row('', c.name, c.rate === 1 ? '1' : c.rate.toFixed(3), sci(channelP(db, c.rate)), sci(c.f(db)), c.key === 'none' ? '' : `${codingGain(c.f, 1e-5).toFixed(1)} dB`)));
    note.textContent = `Eb is the energy per data bit, so a code of rate R gives each channel bit only R of it: Q(√(2R·Eb/N0)) is that channel bit's error rate. No code of rate ½ can work below ${Math.abs(lim) < 0.005 ? '0' : lim.toFixed(2)} dB (${limB.toFixed(2)} dB with ±1 as the only inputs). The K = 7 curves are union bounds, which climb away from the truth above about 10⁻³; press Run for the decoder itself.`;
  };
  const run = () => {
    window.clearTimeout(timer);
    dots.replaceChildren();
    const at = db, jobs = [{ q: 1, cls: 'c4', name: 'hard' }, { q: 3, cls: 'c5', name: 'soft' }];
    const tally = jobs.map(() => ({ bits: 0, errors: 0, chunks: 0 })), finished = (i: number) => tally[i].errors >= BER_MIN_ERRORS || tally[i].bits >= BER_MAX_BITS;
    const circles = jobs.map((j) => dots.appendChild(s('circle', { r: 5, class: `cd-dot ${j.cls}`, cx: X(at), cy: -20 })));
    const tick = () => {
      if (!alive) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 12 && !jobs.every((_, i) => finished(i))) {
        jobs.forEach((j, i) => { if (finished(i)) return; const r = convTrial(CONV_K7, at, BER_CHUNK, { q: j.q, seed: trialSeed(tally[i].chunks++, j.q) }); tally[i].bits += r.bits; tally[i].errors += r.errors; });
      }
      // a dot with no errors is hollow and sits at 1 / bits: the rate is below it, not on it
      tally.forEach((t, i) => { if (t.bits) { circles[i].setAttribute('cy', String(Y(Math.max(t.errors, 1) / t.bits))); circles[i].classList.toggle('zero', t.errors === 0); } });
      const done = jobs.every((_, i) => finished(i));
      runNote.textContent = `The real decoder, at ${at.toFixed(1)} dB, three-bit levels for soft, each run to ${BER_MIN_ERRORS} errors or ${BER_MAX_BITS.toLocaleString('en-US')} bits: ` + jobs.map((j, i) => `${j.name} ${tally[i].errors} error${tally[i].errors === 1 ? '' : 's'} in ${tally[i].bits.toLocaleString('en-US')} bits${tally[i].errors ? ` (${sci(tally[i].errors / tally[i].bits)})` : ' (hollow dot: below 1 in that many)'}`).join(', ') + (done ? '.' : ' …');
      if (!done) timer = window.setTimeout(tick, 0);
    };
    tick();
  };
  const sD = slider('Eb/N0', X0, X1, 0.1, db, (v) => `${v.toFixed(1)} dB`, (v) => { db = v; paint(); });
  const el = h('div', { class: 'widget mos err-w' }, h('div', { class: 'panel' }, h('h3', null, 'Bit error rate against Eb/N0'), key, svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sD.el, btn('Run the decoder', 'Run random bits through the K = 7 encoder, Gaussian noise and the decoder at this Eb/N0; the dots land on the plot', run)), tab, note, runNote));
  paint();
  return { el, destroy: () => { alive = false; window.clearTimeout(timer); } };
}

// ---- the encoder on its scene -------------------------------------------------------------------------------------------

export interface ConvEncApi { send(bits: number[]): void }
export const convEncApi = new WeakMap<Stage, ConvEncApi>();

export function convEncPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    let state = 0, sent: [number, number, number][] = [];
    const hook = { before: () => {
      if (!stage.sim || !stage.value('en')) return;
      const u = Number(stage.value('u')), r = convStep(CONV_K3, state, u);
      sent = [...sent, [u, r.a, r.b]]; state = r.next;
    } };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({ save: () => ({ state, sent }), restore: (v) => { ({ state, sent } = v as { state: number; sent: [number, number, number][] }); update(); } });
    stage.resetHooks.add(() => { state = 0; sent = []; update(); });
    const edge = (u: number) => {
      const sim = stage.sim!;
      sim.setInput('u', u); sim.setInput('en', 1); sim.settle();
      hook.before();
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      sim.setInput('en', 0); sim.settle();
    };
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const status = h('div', { class: 'mc-status err-status' }), stream = h('div', { class: 'cd-stream' }), note = h('p', { class: 'sub' });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel', 'data-dock': 'right' },
      h('h4', null, 'Encoder, K = 3', h('span', { class: 'fold-hint' })),
      h('div', { class: 'dram-ops' }, btn('Send 0', 'One clock edge with u = 0', () => act(() => edge(0))), btn('Send 1', 'One clock edge with u = 1', () => act(() => edge(1)))),
      status, stream, note);
    const update = () => {
      const a = stage.sim ? Number(stage.value('a')) : 0, b = stage.sim ? Number(stage.value('b')) : 0, u = stage.sim ? Number(stage.value('u')) : 0, m = convStep(CONV_K3, state, u), ok = a === m.a && b === m.b;
      status.replaceChildren(h('span', null, 'state ', h('b', null, state.toString(2).padStart(2, '0'))), h('span', null, 'a b now ', h('b', null, `${a} ${b}`)), h('span', null, 'model ', h('b', { class: ok ? 'good' : 'bad' }, `${m.a} ${m.b}${ok ? ' ✓' : ' ✗'}`)));
      stream.replaceChildren(...sent.slice(-16).map(([x, p, q]) => h('span', { class: 'cd-sym' }, h('i', null, String(x)), h('b', null, `${p}${q}`))));
      note.textContent = sent.length ? `${sent.length} bits in, ${2 * sent.length} out. A single 1 followed by zeros sends 11 10 11: five 1s, the code's free distance.` : 'Each bit in makes two out, and those two depend on the last two bits as well. Send 1, then 0, then 0.';
    };
    update();
    convEncApi.set(stage, { send: (bits) => act(() => bits.forEach(edge)) });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); convEncApi.delete(stage); } };
  };
}

export function convEncScene(): Scene {
  return { root: convEncoder(CONV_K3), inputs: { u: 0, en: 0, clk: 0 }, clock: 'clk', autoClock: false, panels: [convEncPanel()] };
}

// ---- Viterbi on its scene -----------------------------------------------------------------------------------------------

/** The scene's survivor depth: five constraint lengths, enough here because the flush ends the stream in state 0, which is the state read. */
export const VIT_SCENE_DEPTH = 15;
export const VIT_MESSAGE = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1];
/** Three channel bits in the middle of the stream that beat the decoder (tests/comm-errors.test.ts). */
export const VIT_FLIPS = [12, 13, 14];

export interface VitApi { flip(i: number): void; run(): void; clear(): void; wrong(): number; done(): boolean; flips(): number }
export const vitApi = new WeakMap<Stage, VitApi>();

interface VitStep { sel: number[]; metric: number[] }

/** Decode the panel's stream with the model: what the gates will say, used to check a set of flips without clocking. */
export function vitStreamErrors(flips: readonly number[], depth = VIT_SCENE_DEPTH): number {
  const msg = [...VIT_MESSAGE, ...new Array<number>(depth).fill(0)], tx = convEncode(CONV_K3, msg), v = new Viterbi(CONV_K3, { depth });
  for (const f of flips) tx[f] ^= 1;
  let wrong = 0;
  for (let t = 0; t < msg.length; t++) { v.step(tx[2 * t], tx[2 * t + 1]); const j = t - (depth - 1); if (j >= 0 && j < VIT_MESSAGE.length && v.out !== VIT_MESSAGE[j]) wrong++; }
  return wrong;
}

export function viterbiPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const depth = VIT_SCENE_DEPTH, n = statesOf(CONV_K3), msg = [...VIT_MESSAGE, ...new Array<number>(depth).fill(0)], clean = convEncode(CONV_K3, msg);
    let flips = new Set<number>(), model = new Viterbi(CONV_K3, { depth }), t = 0, hist: VitStep[] = [], decoded: number[] = [];
    const nodeMetric = (i: number) => { const nd = stage.sim!.design.root.children!.get(`u${i}`)!; return Array.from(stage.sim!.getBits(nd.ports.m)).reduce<number>((a, b, k) => a + Number(b) * 2 ** k, 0); };
    const rx = (i: number) => clean[i] ^ (flips.has(i) ? 1 : 0);
    const hook = { before: () => {
      const sim = stage.sim;
      if (!sim) return;
      if (stage.value('rst')) model.resetMetrics();
      else if (stage.value('en')) {
        model.step(Number(stage.value('r0')), Number(stage.value('r1')));
        hist = [...hist, { sel: Array.from(model.sel), metric: Array.from(model.metric) }];
        const j = t - (depth - 1);
        if (j >= 0) decoded = [...decoded, model.out];
        t++;
      }
    } };
    stage.edgeHooks.add(hook);
    const fresh = () => { model = new Viterbi(CONV_K3, { depth }); t = 0; hist = []; decoded = []; };
    stage.historyHooks.add({ save: () => ({ flips: new Set(flips), metric: model.metric.slice(), surv: model.surv.map((x) => x.slice()), t, hist, decoded }), restore: (v) => { const o = v as { flips: Set<number>; metric: Uint32Array; surv: Uint8Array[]; t: number; hist: VitStep[]; decoded: number[] }; flips = new Set(o.flips); model.metric = o.metric.slice(); model.surv = o.surv.map((x) => x.slice()); t = o.t; hist = o.hist; decoded = o.decoded; update(); } });
    stage.resetHooks.add(() => { fresh(); update(); });
    const edge = (r0: number, r1: number, en: number, rst: number) => {
      const sim = stage.sim!;
      sim.setInput('r0', r0); sim.setInput('r1', r1); sim.setInput('en', en); sim.setInput('rst', rst); sim.settle();
      hook.before();
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      sim.setInput('en', 0); sim.setInput('rst', 0); sim.settle();
    };
    const stepOne = () => { if (t < msg.length) edge(rx(2 * t), rx(2 * t + 1), 1, 0); };
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const restart = () => { for (let d = 0; d < depth; d++) edge(0, 0, 0, 0); edge(0, 0, 0, 1); fresh(); };
    const chan = h('div', { class: 'cd-chan' }), tre = s('svg', { class: 'mos-plot cd-trellis', role: 'img', 'aria-label': 'The trellis: each state at each step, its surviving incoming branch, and the survivor of the best state in bold' }) as SVGSVGElement;
    const status = h('div', { class: 'mc-status err-status' }), out = h('div', { class: 'cd-out' }), note = h('p', { class: 'sub' });
    const wrongNow = () => decoded.reduce((a, b, i) => a + (i < VIT_MESSAGE.length && b !== VIT_MESSAGE[i] ? 1 : 0), 0);
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel cd-vit', 'data-dock': 'right' },
      h('h4', null, 'Viterbi, K = 3', h('span', { class: 'fold-hint' })),
      h('p', { class: 'sub' }, 'The channel: click a bit to flip it, before it is sent.'), chan,
      h('div', { class: 'dram-ops' }, btn('Step', 'One received pair, one clock edge', () => act(stepOne)), btn('Run', 'Send every remaining pair', () => act(() => { while (t < msg.length) stepOne(); })), btn('Start over', 'Metrics to zero, and the same flips sent again', () => act(restart)), btn('No flips', 'A clean channel, started over', () => act(() => { flips = new Set(); restart(); }))),
      status, tre, out, note);
    const paintTrellis = () => {
      const cols = hist.slice(-14), W = 300, H = 106, PX = (W - 24) / Math.max(13, 1), PY = 26, x = (i: number) => 12 + i * PX, y = (st: number) => 14 + st * PY, parts: SVGElement[] = [];
      tre.setAttribute('viewBox', `0 0 ${W} ${H}`);
      // the survivor of the cheapest state, traced back through the selects
      const last = cols[cols.length - 1];
      let best = -1;
      if (last) { best = 0; for (let i = 1; i < n; i++) { const d = (last.metric[i] - last.metric[best] + 16) % 16; if (d >= 8) best = i; } }
      const onPath = new Set<string>();
      let st = best;
      for (let c = cols.length - 1; c >= 0 && st >= 0; c--) { onPath.add(`${c}:${st}`); st = ((st << 1) & (n - 1)) | cols[c].sel[st]; }
      cols.forEach((c, i) => {
        for (let ns = 0; ns < n; ns++) {
          const p = ((ns << 1) & (n - 1)) | c.sel[ns];
          parts.push(s('line', { x1: i ? x(i - 1) : x(0) - 8, y1: y(p), x2: x(i), y2: y(ns), class: onPath.has(`${i}:${ns}`) ? 'cd-edge on' : 'cd-edge' }));
        }
      });
      if (last) for (let ns = 0; ns < n; ns++) {
        parts.push(s('circle', { cx: x(cols.length - 1), cy: y(ns), r: 8, class: ns === best ? 'cd-node on' : 'cd-node' }));
        parts.push(s('text', { x: x(cols.length - 1), y: y(ns) + 3.5, 'text-anchor': 'middle', class: 'cd-node-t' }, String(last.metric[ns])));
      }
      tre.replaceChildren(...parts);
    };
    const update = () => {
      chan.replaceChildren(...msg.flatMap((_, i) => [0, 1].map((k) => {
        const idx = 2 * i + k, past = i < t, b = h('button', { type: 'button', class: `err-bit cd-bit${flips.has(idx) ? ' hit' : ''}${past ? ' past' : ''}${i === t ? ' now' : ''}`, 'aria-label': `Channel bit ${idx}${flips.has(idx) ? ', flipped' : ''}`, 'aria-pressed': String(flips.has(idx)) }, String(rx(idx))) as HTMLButtonElement;
        b.disabled = past;
        b.addEventListener('click', () => { if (flips.has(idx)) flips.delete(idx); else flips.add(idx); update(); });
        return b;
      })));
      const ok = stage.sim ? Array.from({ length: n }, (_, i) => nodeMetric(i) === model.metric[i]).every(Boolean) && Number(stage.value('out')) === model.out : true;
      status.replaceChildren(h('span', null, 'pairs sent ', h('b', null, `${t} / ${msg.length}`)), h('span', null, 'bits flipped ', h('b', null, String(flips.size))), h('span', null, 'gates vs model ', h('b', { class: ok ? 'good' : 'bad' }, ok ? 'equal ✓' : 'differ ✗')), h('span', null, 'wrong so far ', h('b', { class: wrongNow() ? 'bad' : 'good' }, String(wrongNow()))));
      out.replaceChildren(h('span', { class: 'sub' }, 'sent '), ...VIT_MESSAGE.map((b) => h('span', { class: 'cd-o' }, String(b))), h('br'), h('span', { class: 'sub' }, 'out '), ...VIT_MESSAGE.map((b, i) => h('span', { class: `cd-o${i < decoded.length ? (decoded[i] === b ? ' ok' : ' bad') : ''}` }, i < decoded.length ? String(decoded[i]) : '·')));
      note.textContent = t < depth ? `The output lags by ${depth} pairs: the decoder commits to a bit only when every survivor agrees on it, in practice. Bold on the trellis is the cheapest state's survivor.`
        : t >= msg.length ? (wrongNow() ? `${wrongNow()} wrong bit${wrongNow() > 1 ? 's' : ''}: these flips moved the received stream closer to another path than to the one sent.` : `All ${VIT_MESSAGE.length} bits right, with ${flips.size} flipped on the channel.`)
          : 'Every state keeps one incoming path, the cheaper of two. Numbers on the right are path metrics, wrapping at 16.';
      paintTrellis();
    };
    update();
    vitApi.set(stage, { flip: (i) => { flips.add(i); update(); }, run: () => act(() => { while (t < msg.length) stepOne(); }), clear: () => act(() => { flips = new Set(); restart(); }), wrong: wrongNow, done: () => t >= msg.length, flips: () => flips.size });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); vitApi.delete(stage); } };
  };
}

export function viterbiScene(): Scene {
  return { root: viterbi(CONV_K3, { depth: VIT_SCENE_DEPTH }), inputs: { r0: 0, r1: 0, en: 0, rst: 0, clk: 0 }, clock: 'clk', autoClock: false, panels: [viterbiPanel()] };
}

// ---- Reed-Solomon on its scene ------------------------------------------------------------------------------------------

/** A QR symbol's 16 data bytes (HELLO WORLD at 1-M) and the check bytes the published example gives; the panel starts on them. */
export const RS_MESSAGE = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
export const RS_CHECK = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];

export interface RsApi { send(): void; regs(): number[] }
export const rsApi = new WeakMap<Stage, RsApi>();

export function rsPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const nsym = 10, g = rsGenerator(nsym);
    let st = new Array<number>(nsym).fill(0), hits = new Map<number, number>();
    const cw = [...RS_MESSAGE, ...RS_CHECK];
    const hook = { before: () => { if (!stage.sim) return; if (stage.value('clr')) st = new Array<number>(nsym).fill(0); else if (stage.value('en')) st = stage.value('msg') ? rsStep(g, st, Number(stage.value('d'))) : [...st.slice(1), 0]; } };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({ save: () => ({ st, hits: new Map(hits) }), restore: (v) => { const o = v as { st: number[]; hits: Map<number, number> }; st = o.st; hits = new Map(o.hits); update(); } });
    stage.resetHooks.add(() => { st = new Array<number>(nsym).fill(0); update(); });
    const regs = () => st.map((_, i) => { const nd = stage.sim!.design.root.children!.get(`s${i}`)!; return Array.from(stage.sim!.getBits(nd.ports.q)).reduce<number>((a, b, k) => a + Number(b) * 2 ** k, 0); });
    const edge = (vals: Record<string, number>) => {
      const sim = stage.sim!;
      for (const [k, v] of Object.entries(vals)) sim.setInput(k, v);
      sim.settle();
      hook.before();
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      sim.setInput('en', 0); sim.setInput('clr', 0); sim.settle();
    };
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const send = () => { edge({ clr: 1, en: 0 }); for (const b of RS_MESSAGE) edge({ d: b, msg: 1, en: 1 }); };
    const status = h('div', { class: 'cd-bytes' }), wordEl = h('div', { class: 'cd-bytes cd-word' }), verdict = h('p', { class: 'err-verdict' });
    const sHits = slider('Bytes hit', 0, 8, 1, 0, (v) => String(v), (v) => { hits = new Map(); let seed = 12345 + v * 77; const r = (m: number) => { seed = (seed * 1103515245 + 12345) >>> 0; return Math.floor((seed / 2 ** 32) * m); }; while (hits.size < v) hits.set(r(cw.length), 1 + r(255)); update(); });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel cd-rs', 'data-dock': 'right' },
      h('h4', null, 'RS (26, 16)', h('span', { class: 'fold-hint' })),
      h('div', { class: 'dram-ops' }, btn('Encode the message', 'Clear, then clock the 16 data bytes in', () => act(send)), btn('Clear', 'One clock edge with clr = 1', () => act(() => edge({ clr: 1, en: 0 })))),
      h('p', { class: 'sub' }, 'Registers, highest first:'), status,
      h('p', { class: 'sub' }, 'The code word on the channel: click a byte to corrupt it.'), wordEl, sHits.el, verdict);
    const update = () => {
      const got = stage.sim ? regs() : st, ok = got.every((v, i) => v === st[i]), match = got.every((v, i) => v === RS_CHECK[i]);
      status.replaceChildren(...got.map((v) => h('span', { class: `err-bit cd-b${match ? ' par' : ''}` }, hex2(v))), h('span', { class: `cd-tag ${ok ? 'good' : 'bad'}` }, ok ? 'gates = model ✓' : 'gates ≠ model ✗'), h('span', { class: 'cd-tag sub' }, match ? 'the published check bytes' : ''));
      wordEl.replaceChildren(...cw.map((b, i) => { const x = h('button', { type: 'button', class: `err-bit cd-b${i >= 16 ? ' par' : ''}${hits.has(i) ? ' hit' : ''}`, 'aria-label': `Byte ${i}${hits.has(i) ? ', corrupted' : ''}`, 'aria-pressed': String(hits.has(i)) }, hex2(b ^ (hits.get(i) ?? 0))) as HTMLButtonElement; x.addEventListener('click', () => { if (hits.has(i)) hits.delete(i); else hits.set(i, 0x5a); update(); }); return x; }));
      const rx = cw.map((b, i) => b ^ (hits.get(i) ?? 0)), d = rsDecode(rx, nsym), right = d.word && d.word.every((v, i) => v === cw[i]);
      verdict.className = `err-verdict ${d.word === null ? 'bad' : right ? 'ok' : 'bad'}`;
      verdict.textContent = hits.size === 0 ? 'A clean word: every syndrome is 0, and the decoder has nothing to do.'
        : d.word === null ? `${hits.size} bytes hit, more than t = 5. The decoder (the model, not gates) knows it failed: ${2 * d.errors > nsym ? `the error locator it finds has degree ${d.errors}, above t = ${nsym / 2}, so there is no solution` : `the error locator it finds (degree ${d.errors}) has roots that do not all lie in the word, so there is no solution`}. A retransmission or an outer code takes over.`
          : right ? `${hits.size} byte${hits.size > 1 ? 's' : ''} hit, whatever the bits in them: found and corrected at position${d.fixed.length > 1 ? 's' : ''} ${d.fixed.join(', ')}. Corrected by the model's Berlekamp-Massey, Chien and Forney, not gates.`
            : `${hits.size} bytes hit, and the word was moved onto a different code word: a miscorrection, the case only a CRC above it can catch.`;
    };
    update();
    rsApi.set(stage, { send: () => act(send), regs });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); rsApi.delete(stage); } };
  };
}

export function rsScene(): Scene {
  return { root: rsEncoder(10), inputs: { d: 0, msg: 0, en: 0, clr: 0, clk: 0 }, clock: 'clk', autoClock: false, panels: [rsPanel()] };
}

// ---- interleaving -------------------------------------------------------------------------------------------------------

/** 16 data bits, SEC-DED: 22 bits a word, short enough to see. */
const IL_K = 16;

/** Words of a fixed pattern through a block interleaver and one deterministic burst of `b` flipped bits at `at`: per word the errors and whether SEC-DED saved it. */
export function burstOutcome(D: number, b: number, at: number): { n: number; errs: number[]; failed: number; total: number } {
  const ds = Array.from({ length: D }, (_, w) => Array.from({ length: IL_K }, (_, i) => ((w * 5 + i * 3) % 7 < 3 ? 1 : 0)));
  const tx = interleave(ds.map((d) => secdedEncode(d))), n = codeOf(IL_K).n, rx = tx.slice(), start = Math.min(at, Math.max(0, tx.length - b));
  for (let c = start; c < Math.min(tx.length, start + b); c++) rx[c] ^= 1;
  const errs = new Array<number>(D).fill(0);
  for (let c = start; c < Math.min(tx.length, start + b); c++) errs[placeOf(c, D)[0]]++;
  let failed = 0;
  deinterleave(rx, D).forEach((w, i) => { if (secdedDecode(w, IL_K).data.some((v, j) => v !== ds[i][j])) failed++; });
  return { n, errs, failed, total: D };
}

/** The verdict under the grid, decided on what the words saw: a word with two errors that still decoded (both hits on check bits) is luck, not the guarantee. */
export function burstVerdict(D: number, b: number, r: { errs: number[]; failed: number }): { cls: 'ok' | 'bad'; text: string } {
  const worst = Math.max(...r.errs);
  if (r.failed) return { cls: 'bad', text: `A burst of ${b} puts ${worst} errors into one word, beyond SEC-DED's one. ${r.failed} word${r.failed > 1 ? 's' : ''} wrong.` };
  if (worst > 1) return { cls: 'ok', text: `A burst of ${b} puts ${worst} errors into one word, beyond SEC-DED's one, yet its data came out right: the extra hits fell on check bits. That is luck, not the code's guarantee, which is one error a word.` };
  return { cls: 'ok', text: `Written across ${D} word${D > 1 ? 's' : ''}, the burst of ${b} leaves at most one error in any word, and every word corrects it. The redundancy did not change.` };
}

export function interleaveWidget(): Widget {
  let D = 1, b = 6, at = 4;
  const runs = new Map<number, number>();
  const lost = (d: number) => { let v = runs.get(d); if (v === undefined) runs.set(d, (v = secdedOverBursts(d, Math.ceil(3000 / d), 2e-4, 0.2, 7).rate)); return v; };
  const grid = h('div', { class: 'cd-il' }), verdict = h('p', { class: 'err-verdict' }), chips = h('div', { class: 'err-crc' }), note = h('p', { class: 'sub mos-note' });
  const stat = (k: string, v: string) => h('div', null, h('span', null, k), h('b', null, v));
  const paint = () => {
    const n = codeOf(IL_K).n, total = D * n;
    // the block is all there is to hit: a burst is clipped to it and a start is held inside it, and the sliders say so
    if (b > total) { b = total; sB.set(b); }
    if (at > total - b) { at = total - b; sA.set(at); }
    setMax(sB, Math.min(30, total)); setMax(sA, Math.min(60, total - b));
    const r = burstOutcome(D, b, at), start = at, worst = Math.max(...r.errs);
    grid.style.setProperty('--n', String(n));
    grid.replaceChildren(...Array.from({ length: Math.min(D, 12) }, (_, w) => h('div', { class: `cd-il-row${r.errs[w] > 1 ? ' bad' : r.errs[w] === 1 ? ' fixed' : ''}` }, h('span', { class: 'cd-il-lab' }, `word ${w}`),
      ...Array.from({ length: n }, (_, i) => { const c = i * D + w, hit = c >= start && c < start + b; return h('span', { class: `cd-il-b${hit ? ' hit' : ''}` }); }),
      h('span', { class: 'cd-il-n' }, r.errs[w] ? String(r.errs[w]) : ''))));
    chips.replaceChildren(stat('worst word sees', `${worst} (⌈${b}/${D}⌉ = ${worstPerWord(b, D)})`), stat('words lost', `${r.failed} of ${r.total}`), stat('buffer each end', `${(D * n).toLocaleString('en-US')} bits`), stat('added delay', `${(D * n).toLocaleString('en-US')} bit times`));
    const v = burstVerdict(D, b, r);
    verdict.className = `err-verdict ${v.cls}`;
    verdict.textContent = v.text;
    note.textContent = `On a seeded burst channel (a bad state entered 2 in 10 000 bits, five bits long on average, half the bits wrong) SEC-DED(72, 64) loses ${(100 * lost(1)).toFixed(2)} % of words without interleaving${D > 1 ? ` and ${(100 * lost(D)).toFixed(2)} % at depth ${D}, the same errors spread out` : ''}.`;
  };
  const setMax = (sl: { el: HTMLElement }, max: number) => { (sl.el.querySelector('input') as HTMLInputElement).max = String(max); };
  const sD = slider('Depth D (words)', 1, 12, 1, D, (v) => String(v), (v) => { D = v; paint(); });
  const sB = slider('Burst length', 1, 30, 1, b, (v) => `${v} bits`, (v) => { b = v; paint(); });
  const sA = slider('Burst starts at', 0, 60, 1, at, (v) => `bit ${v}`, (v) => { at = v; paint(); });
  const el = h('div', { class: 'widget mos err-w' }, h('div', { class: 'panel' }, h('h3', null, 'A burst against SEC-DED words'), h('p', { class: 'sub' }, 'Each row is one code word; the channel sends one bit of each row in turn, column by column. Red bits are the burst.'), grid, verdict),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sD.el, sB.el, sA.el), chips, note));
  paint();
  return { el };
}

