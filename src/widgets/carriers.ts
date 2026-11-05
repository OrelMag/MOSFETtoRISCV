// Many carriers' explainers: the butterfly and the 8-point network and the stream on their gate-level scenes (values always the gates', checked against comm/fftfix.ts on the panel), how many
// bits a word needs, water-filling against a flat plan, and what breaks a block of tones (comm/carriers.ts).

import { flatBest, flatPower, leak, loadBits, offsetSirDb, paprCcdf, paprMeasured, waterFill } from '../comm/carriers';
import { butterflyFx, bitRev, FftStream, fftFx, fftSnrDb, packFx, safeMagnitude, streamLatency, unpackFx, type Fx } from '../comm/fftfix';
import { gapDb } from '../comm/modem';
import { fftNet, fftStream, fxButterfly } from '../lib/fft';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/carriers.css';

const btn = (label: string, title: string, f: () => void, cls = 'btn sm'): HTMLButtonElement => {
  const b = h('button', { class: cls, type: 'button', title }, label) as HTMLButtonElement;
  b.addEventListener('click', f);
  return b;
};
const W_SCENE = 10;
const FS = 2 ** (W_SCENE - 1);
export const polar = (r: number, deg: number): Fx => ({ re: Math.trunc(r * Math.cos((deg * Math.PI) / 180) * FS), im: Math.trunc(r * Math.sin((deg * Math.PI) / 180) * FS) });
const hexW = (c: Fx) => `${num(c.re / FS, 3)} ${c.im < 0 ? '−' : '+'} ${num(Math.abs(c.im) / FS, 3)}j`;

// ---- one butterfly ------------------------------------------------------------------------------------------------------------

/** Its twiddle: W₈¹, a 45° clockwise turn. */
export const BF_K = 1, BF_N = 8;

export interface BfApi { solve(): void }
export const bfApi = new WeakMap<Stage, BfApi>();

function butterflyPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    let ra = 0.6, aa = 0, rb = 0.6, ab = 90;
    const svg = s('svg', { viewBox: '0 0 220 220', class: 'mos-plot fc-phasor', role: 'img', 'aria-label': 'The butterfly on the complex plane: a, the turned b, and the two outputs' }) as SVGSVGElement;
    const out = h('div', { class: 'cd-bytes fc-read' });
    const push = () => {
      const sim = stage.sim;
      if (!sim) return;
      sim.setInput('a', packFx(polar(ra, aa), W_SCENE)); sim.setInput('b', packFx(polar(rb, ab), W_SCENE)); sim.settle();
      stage.refresh(); update();
    };
    const arrow = (c: Fx, cls: string, label: string): SVGElement[] => {
      const x = 110 + (c.re / FS) * 95, y = 110 - (c.im / FS) * 95;
      return [s('line', { x1: 110, y1: 110, x2: x, y2: y, class: `fc-arrow ${cls}` }), s('circle', { cx: x, cy: y, r: 3, class: `fc-dot ${cls}` }), s('text', { x: x + (x >= 110 ? 5 : -5), y: y - 4, 'text-anchor': x >= 110 ? 'start' : 'end', class: `fc-lab ${cls}` }, label)];
    };
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      const a = unpackFx(Number(stage.value('a')), W_SCENE), b = unpackFx(Number(stage.value('b')), W_SCENE), y0 = unpackFx(Number(stage.value('y0')), W_SCENE), y1 = unpackFx(Number(stage.value('y1')), W_SCENE);
      const [m0, m1] = butterflyFx(a, b, BF_K, BF_N, W_SCENE), ok = m0.re === y0.re && m0.im === y0.im && m1.re === y1.re && m1.im === y1.im;
      const t = { re: y0.re - y1.re, im: y0.im - y1.im };
      svg.replaceChildren(
        s('circle', { cx: 110, cy: 110, r: 95, class: 'fc-unit' }), s('line', { x1: 15, x2: 205, y1: 110, y2: 110, class: 'fc-axis' }), s('line', { x1: 110, x2: 110, y1: 15, y2: 205, class: 'fc-axis' }),
        ...arrow(a, 'a', 'a'), ...arrow(b, 'b', 'b'), ...arrow(t, 't', 'W·b'), ...arrow(y0, 'y0', 'y0'), ...arrow(y1, 'y1', 'y1'));
      out.replaceChildren(h('span', null, `y0 = ${hexW(y0)}`), h('span', null, `y1 = ${hexW(y1)}`), h('span', { class: `cd-tag ${ok ? 'good' : 'bad'}` }, ok ? 'gates = model ✓' : 'gates ≠ model'));
    };
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel fc-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'One butterfly, W₈¹', h('span', { class: 'fold-hint' })), svg, out,
      slider('|a|', 0, 0.95, 0.05, ra, (v) => v.toFixed(2), (v) => { ra = v; push(); }).el,
      slider('angle of a', -180, 180, 15, aa, (v) => `${v}°`, (v) => { aa = v; push(); }).el,
      slider('|b|', 0, 0.95, 0.05, rb, (v) => v.toFixed(2), (v) => { rb = v; push(); }).el,
      slider('angle of b', -180, 180, 15, ab, (v) => `${v}°`, (v) => { ab = v; push(); }).el);
    push();
    bfApi.set(stage, { solve: () => { const sim = stage.sim!; stage.checkpoint(); sim.setInput('a', packFx(polar(0.6, 0), W_SCENE)); sim.setInput('b', packFx(polar(0.6, 45), W_SCENE)); sim.settle(); stage.refresh(); update(); } });
    return { el, update, destroy: () => { bfApi.delete(stage); } };
  };
}

export function butterflyScene(): Scene {
  return { root: fxButterfly(W_SCENE, BF_K, BF_N), inputs: { a: 0, b: 0 }, hiddenInputs: ['a', 'b'], hiddenOutputs: ['y0', 'y1'], panels: [butterflyPanel()] };
}

/** Is this complex word close to 0: within a few units of the last place, since W·b is rounded? */
export const nearZero = (v: number, units = 4): boolean => { const c = unpackFx(v, W_SCENE); return Math.abs(c.re) <= units && Math.abs(c.im) <= units; };

// ---- the 8-point network ------------------------------------------------------------------------------------------------------

export type Block8 = 'tone' | 'two' | 'impulse' | 'dc' | 'noise';
export const block8 = (kind: Block8, k: number, seed = 1): Fx[] => {
  const m = safeMagnitude(W_SCENE, 8) * 0.95, tone = (b: number, g: number) => Array.from({ length: 8 }, (_, n) => polar(g, (360 * b * n) / 8));
  if (kind === 'tone') return tone(k, m);
  if (kind === 'two') return tone(k, m / 2).map((c, n) => { const o = tone((k + 3) % 8, m / 2)[n]; return { re: c.re + o.re, im: c.im + o.im }; });
  if (kind === 'impulse') return Array.from({ length: 8 }, (_, n) => (n === 0 ? polar(m, 0) : { re: 0, im: 0 }));
  if (kind === 'dc') return tone(0, m);
  let v = seed * 2654435761 >>> 0;
  const u = () => (v = (Math.imul(v, 1103515245) + 12345) >>> 0) / 2 ** 32;
  return Array.from({ length: 8 }, () => polar(m * Math.sqrt(u()), 360 * u()));
};

export interface NetApi { tone(k: number): void }
export const netApi = new WeakMap<Stage, NetApi>();

function net8Panel(): ScenePanel {
  return (stage: Stage): Widget => {
    let kind: Block8 = 'impulse', k = 1, seed = 1;
    const bars = s('svg', { viewBox: '0 0 240 112', class: 'mos-plot fc-bars', role: 'img', 'aria-label': 'The size of each of the eight tones out of the gates' }) as SVGSVGElement;
    const verdict = h('div', { class: 'cd-bytes fc-read' }), note = h('p', { class: 'sub' });
    const push = () => {
      const sim = stage.sim;
      if (!sim) return;
      block8(kind, k, seed).forEach((c, i) => sim.setInput(`x${i}`, packFx(c, W_SCENE)));
      sim.settle(); stage.refresh(); update();
    };
    const update = () => {
      if (!stage.sim) return;
      const x = Array.from({ length: 8 }, (_, i) => unpackFx(Number(stage.value(`x${i}`)), W_SCENE)), X = Array.from({ length: 8 }, (_, i) => unpackFx(Number(stage.value(`X${i}`)), W_SCENE)), m = fftFx(x, W_SCENE);
      const ok = X.every((c, i) => c.re === m[i].re && c.im === m[i].im);
      bars.replaceChildren(...X.flatMap((c, i) => {
        const v = Math.hypot(c.re, c.im) / FS, H = 84 * Math.min(1, v), x0 = 8 + i * 29;
        return [s('rect', { x: x0, y: 92 - H, width: 22, height: Math.max(H, 0.5), class: 'fc-bar' }), s('text', { x: x0 + 11, y: 106, 'text-anchor': 'middle', class: 'fc-lab' }, `X${i}`), s('text', { x: x0 + 11, y: 88 - H, 'text-anchor': 'middle', class: 'fc-lab' }, v >= 0.005 ? v.toFixed(2) : '')];
      }));
      verdict.replaceChildren(h('span', { class: `cd-tag ${ok ? 'good' : 'bad'}` }, ok ? 'gates = model ✓' : 'gates ≠ model'));
      note.textContent = kind === 'tone' ? `A pure tone ${k}: every stage adds in phase on one path and cancels on the others, so all of it lands on X${k}. The last unit of error elsewhere is rounding.`
        : kind === 'two' ? `Two tones of half the size land on their own outputs. The transform is linear, so this is what lets every tone carry its own bits.`
          : kind === 'impulse' ? 'One sample holds every frequency equally: each output gets an eighth of it, once the three halvings are done.'
            : kind === 'dc' ? 'A constant is tone 0.'
              : 'Random samples spread over every tone, each small: the halving that keeps a pure tone in range costs a block like this its resolution. The word-length step measures that.';
    };
    const sel = h('select', { 'aria-label': 'Input block' }, ...([['impulse', 'One impulse'], ['tone', 'One tone'], ['two', 'Two tones'], ['dc', 'A constant'], ['noise', 'Random samples']] as const).map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
    sel.addEventListener('change', () => { kind = sel.value as Block8; push(); });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel fc-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'Eight samples in, eight tones out', h('span', { class: 'fold-hint' })), h('div', { class: 'dram-ops' }, sel, btn('New samples', 'Another random block', () => { seed++; kind = 'noise'; sel.value = 'noise'; push(); })),
      slider('Tone', 0, 7, 1, k, (v) => String(v), (v) => { k = v; if (kind !== 'two') { kind = 'tone'; sel.value = 'tone'; } push(); }).el, bars, verdict, note);
    push();
    netApi.set(stage, { tone: (t) => { stage.checkpoint(); k = t; kind = 'tone'; sel.value = 'tone'; push(); } });
    return { el, update, destroy: () => { netApi.delete(stage); } };
  };
}

export function net8Scene(): Scene {
  const inputs: Record<string, number> = {}, hide: string[] = [], outs: string[] = [];
  for (let i = 0; i < 8; i++) { inputs[`x${i}`] = 0; hide.push(`x${i}`); outs.push(`X${i}`); }
  return { root: fftNet(8, W_SCENE), inputs, hiddenInputs: hide, hiddenOutputs: outs, panels: [net8Panel()] };
}

// ---- the stream ---------------------------------------------------------------------------------------------------------------

export const STREAM_N = 16;
export interface StreamApi { run(k?: number): void; tonesOut(): number; peak(): number }
export const streamApi = new WeakMap<Stage, StreamApi>();

function streamPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const N = STREAM_N, bits = Math.log2(N), lat = streamLatency(N);
    let tone = 3, model = new FftStream(N, W_SCENE), t = 0, tones = new Array<Fx | null>(N).fill(null), ready = false;
    const block = (): Fx[] => Array.from({ length: N }, (_, n) => polar(safeMagnitude(W_SCENE, N) * 0.95, (360 * tone * n) / N));
    const hook = { before: () => {
      if (!stage.sim) return;
      const d = unpackFx(Number(stage.value('d')), W_SCENE), en = !!stage.value('en'), rst = !!stage.value('rst');
      model.step(d, en, rst);
      if (rst) { t = 0; tones = tones.map(() => null); return; }
      if (en) { const i = t - lat + 1; if (i >= 0 && i < N) tones[bitRev(i, bits)] = model.q; t++; }
    } };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({ save: () => ({ stages: structuredClone(model.stages), t, tones: tones.slice() }), restore: (v) => { const o = v as { stages: FftStream['stages']; t: number; tones: (Fx | null)[] }; model.stages = structuredClone(o.stages); t = o.t; tones = o.tones.slice(); update(); } });
    stage.resetHooks.add(() => { model = new FftStream(N, W_SCENE); t = 0; tones = tones.map(() => null); ready = false; update(); });
    const edge = () => {
      const sim = stage.sim!;
      hook.before();
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    };
    const restart = () => { const sim = stage.sim!; sim.setInput('d', 0); sim.setInput('en', 0); sim.setInput('rst', 1); sim.settle(); edge(); sim.setInput('rst', 0); sim.setInput('en', 1); sim.settle(); ready = true; };
    const feed = () => { const sim = stage.sim!; sim.setInput('d', t < N ? packFx(block()[t], W_SCENE) : 0); sim.settle(); edge(); };
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const stepOne = () => { if (!ready) restart(); feed(); };
    const run = () => { restart(); for (let i = 0; i < lat + N; i++) feed(); };
    const rows = h('div', { class: 'fc-stages' }), out = s('svg', { viewBox: '0 0 300 96', class: 'mos-plot fc-bars', role: 'img', 'aria-label': 'The tones that have left the pipeline, in natural order' }) as SVGSVGElement;
    const status = h('div', { class: 'cd-bytes fc-read' }), note = h('p', { class: 'sub' });
    const regOf = (s0: number, port: string) => { const nd = stage.sim!.design.root.children!.get(`s${s0}`)!.children!.get(port)!; return Array.from(stage.sim!.getBits(nd.ports.q)).reduce<number>((a, b, k) => a + Number(b) * 2 ** k, 0); };
    const update = () => {
      if (!stage.sim) return;
      const ok = model.stages.every((st, i) => regOf(i, 'ctr') === st.count && regOf(i, 'out') === packFx(st.out, W_SCENE));
      rows.replaceChildren(...model.stages.map((st, i) => {
        const M = N / 2 ** i, L = M / 2, sel = st.count >= L;
        return h('div', { class: `fc-stage${sel ? ' run' : ''}` }, h('b', null, `stage ${i}`), h('span', null, `${L} in the line`), h('span', null, `count ${st.count} of ${M}`), h('em', null, sel ? 'butterfly' : 'filling, twiddle'));
      }));
      const parts = tones.flatMap((c, i) => {
        const v = c ? Math.hypot(c.re, c.im) / FS : 0, H = 70 * Math.min(1, v), x0 = 6 + i * 18;
        return [s('rect', { x: x0, y: 78 - H, width: 13, height: Math.max(H, c ? 0.5 : 0), class: 'fc-bar' }), s('text', { x: x0 + 6.5, y: 91, 'text-anchor': 'middle', class: `fc-lab${c ? '' : ' off'}` }, String(i))];
      });
      out.replaceChildren(...parts);
      const got = tones.filter(Boolean).length;
      status.replaceChildren(h('span', null, `edge ${t}`), h('span', null, `${got} of ${N} tones out`), h('span', { class: `cd-tag ${ok ? 'good' : 'bad'}` }, ok ? 'gates = model ✓' : 'gates ≠ model'));
      note.textContent = t === 0 ? `Nothing moves on its own here. Step clocks in one sample; Run a block clocks all ${N}, then ${lat} more to flush them.`
        : got === 0 ? `Samples go in one a clock. The first tone needs ${lat} edges: the delay lines hold ${N - 1} samples and each of the ${bits} stages has an output register.`
          : got < N ? 'Tones arrive one a clock in bit-reversed order: watch which bar each new one fills.' : `The whole block in ${t} edges, and a next block could already be following it: ${N} samples in, ${N} tones out, every ${N} clocks.`;
    };
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel fc-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, `A sample a clock, ${N} points`, h('span', { class: 'fold-hint' })),
      h('div', { class: 'dram-ops' }, btn('Step', 'One sample, one clock edge', () => act(stepOne)), btn('Run a block', 'Reset, the whole block, and the flush', () => act(run))),
      slider('Tone', 0, N - 1, 1, tone, (v) => String(v), (v) => { tone = v; }).el, status, rows, out, note);
    update();
    streamApi.set(stage, { run: (k) => { if (k !== undefined) tone = k; act(run); }, tonesOut: () => tones.filter(Boolean).length, peak: () => { let b = -1, m = -1; tones.forEach((c, i) => { const v = c ? Math.hypot(c.re, c.im) : -1; if (v > m) { m = v; b = i; } }); return b; } });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); streamApi.delete(stage); } };
  };
}

export function streamScene(): Scene {
  return { root: fftStream(STREAM_N, W_SCENE), inputs: { d: 0, en: 0, rst: 0, clk: 0 }, clock: 'clk', autoClock: false, hiddenInputs: ['d', 'en', 'rst'], panels: [streamPanel()] };
}

// ---- how many bits ------------------------------------------------------------------------------------------------------------

export function wordWidget(): Widget {
  let N = 64, W = 12, backoff = 6;
  const WS = [8, 10, 12, 14, 16, 18, 20], plot = plotOf({ W: 640, H: 250, x: [0, 22], y: [0, 100], yTicks: [0, 20, 40, 60, 80, 100], xLabel: 'bits a part', yLabel: 'SNR, dB', aria: 'Signal over rounding noise out of the integer FFT against the word length', xFmt: (v) => String(v) });
  plot.setX(22);
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' }), gap = gapDb(1e-7);
  const bitsAt = (snr: number) => Math.max(0, Math.floor(Math.log2(1 + 10 ** ((snr - gap) / 10))));
  const paint = () => {
    const pts = WS.map((w) => fftSnrDb(N, w, 12, 1, 0.9 * 10 ** (-backoff / 20))), now = fftSnrDb(N, W, 12, 1, 0.9 * 10 ** (-backoff / 20));
    plot.clear();
    line(plot, WS, pts, 'ln-s real');
    WS.forEach((w, i) => plot.layer.append(s('circle', { cx: plot.X(w), cy: plot.Y(pts[i]), r: w === W ? 6 : 3.5, class: w === W ? 'fc-dot now' : 'fc-dot a' })));
    chips.set(0, `${now.toFixed(1)} dB`, 'tone power over the FFT\'s own rounding');
    chips.set(1, `${bitsAt(now)} bits`, `the largest constellation that leaves, at Γ = ${gap.toFixed(1)} dB`);
    chips.set(2, `${(2 * W * (N - 1)).toLocaleString('en')}`, 'flip-flops in the stream\'s delay lines');
    note.textContent = `Every bit gives 6 dB, and N = ${N} costs about ${(3 * Math.log2(N)).toFixed(0)} dB against no transform at all, since the tones of a noise-like block shrink under the stage-by-stage halving while the rounding stays one unit. The back-off is the room left for the block's peak: each 6 dB of it is one bit of the word held idle.`;
  };
  const sel = h('select', { 'aria-label': 'Points' }, ...[64, 512, 4096].map((v) => h('option', { value: String(v) }, `${v} points`))) as HTMLSelectElement;
  sel.addEventListener('change', () => { N = Number(sel.value); paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Rounding noise out of the integer FFT, measured on random blocks'), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, sel,
      slider('Bits a part', 8, 20, 2, W, (v) => String(v), (v) => { W = v; paint(); }).el,
      slider('Back-off', 0, 12, 1, backoff, (v) => `${v} dB`, (v) => { backoff = v; paint(); }).el), chips.el, note)) };
}

// ---- water-filling ------------------------------------------------------------------------------------------------------------

/** The illustrative channel: `TONES` tones, SNR per unit power falling `slope` dB across the band, with an optional notch from a bridged tap. */
export const WF_TONES = 32;
export function wfGains(top: number, slope: number, notch: boolean): number[] {
  return Array.from({ length: WF_TONES }, (_, k) => {
    const d = (k - 20) / 2.2, dip = notch ? 28 * Math.exp(-d * d) : 0;
    return 10 ** ((top - (slope * k) / (WF_TONES - 1) - dip) / 10);
  });
}

export function waterWidget(): Widget {
  let top = 35, slope = 40, notch = true, gamma = 0;
  const plot = plotOf({ W: 640, H: 260, x: [0, WF_TONES], y: [0, 2], yTicks: [0, 1, 2], xLabel: 'tone', yLabel: 'noise / gain, and power', aria: 'Each tone\'s floor, Gamma over its gain, with the power water-filling pours over it up to one level', xFmt: (v) => String(v) });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const g = wfGains(top, slope, notch), G = 10 ** (gamma / 10), B = WF_TONES, wf = waterFill(g, B, G), fl = flatPower(g, B, G), fb = flatBest(g, B, G), lo = loadBits(g, B, G, 15);
    const yMax = Math.max(2, wf.level * 1.25);
    plot.setY(0, yMax); plot.setX(WF_TONES); plot.clear();
    g.forEach((v, k) => {
      const f = G / v, x0 = plot.X(k), x1 = plot.X(k + 1), yF = plot.Y(Math.min(f, yMax)), yL = plot.Y(wf.level);
      plot.layer.append(s('rect', { x: x0, y: yF, width: x1 - x0, height: plot.Y(0) - yF, class: 'fc-floor' }));
      if (wf.power[k] > 0) plot.layer.append(s('rect', { x: x0, y: yL, width: x1 - x0, height: yF - yL, class: 'fc-water' }));
      if (lo.bits[k] > 0) plot.layer.append(s('text', { x: (x0 + x1) / 2, y: plot.Y(0) - 3, 'text-anchor': 'middle', class: 'fc-lab on' }, String(lo.bits[k])));
    });
    plot.layer.append(s('line', { x1: plot.X(0), x2: plot.X(WF_TONES), y1: plot.Y(1), y2: plot.Y(1), class: 'fc-flat' }));
    chips.set(0, wf.total.toFixed(1), 'bits a block, water-filling', 'ok');
    chips.set(1, fl.total.toFixed(1), 'the same power spread flat');
    chips.set(2, fb.total.toFixed(1), `flat over the best ${fb.used} tones`);
    chips.set(3, String(lo.total), 'whole bits, greedy loading (printed on each tone)');
    note.textContent = `${wf.used} of ${WF_TONES} tones get water. The dashed line is the flat plan's power. Water-filling wins most where the budget is short: lower the signal and the gain over flat grows; raise it and the water covers everything almost level. Flat over the right tones gives up ${(wf.total - fb.total).toFixed(2)} bits of ${wf.total.toFixed(1)}.`;
  };
  const nt = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  nt.addEventListener('change', () => { notch = nt.checked; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'A budget poured over the tones'), h('div', { class: 'ln-key' }, h('span', { class: 'fc-kf' }, 'floor: Γ / gain'), h('span', { class: 'fc-kw' }, 'power')), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      slider('Signal', 0, 60, 1, top, (v) => `${v} dB`, (v) => { top = v; paint(); }).el,
      slider('Slope', 0, 80, 5, slope, (v) => `${v} dB`, (v) => { slope = v; paint(); }).el,
      slider('Gap Γ', 0, 10, 1, gamma, (v) => `${v} dB`, (v) => { gamma = v; paint(); }).el,
      h('label', { class: 'fc-check' }, nt, ' bridged tap')), chips.el, note)) };
}

// ---- what breaks it -----------------------------------------------------------------------------------------------------------

export function breakWidget(): Widget {
  let N = 512, eps = 0.05;
  const pk = plotOf({ W: 640, H: 220, x: [0, 14], y: [-4, 0], yTicks: [-4, -3, -2, -1, 0], xLabel: 'peak over mean, dB', yLabel: 'chance above', aria: 'The chance that a block peaks above each level: the closed form and measured blocks', xFmt: (v) => String(v), yFmt: (v) => ['10⁻⁴', '10⁻³', '0.01', '0.1', '1'][v + 4] });
  pk.setX(14);
  const lk = s('svg', { viewBox: '0 0 640 150', class: 'mos-plot fc-bars', role: 'img', 'aria-label': 'What one tone leaks onto its neighbours when the carrier is off' }) as SVGSVGElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const measured = new Map<number, [number, number][]>();
  const dots = (n: number) => {
    let d = measured.get(n);
    if (!d) { const blocks = n > 1000 ? 300 : 1500; d = [6, 7, 8, 9, 10, 11].map((v) => [v, paprMeasured(v, n, blocks, v + n)]); measured.set(n, d); }
    return d;
  };
  const paint = () => {
    pk.clear();
    const xs = Array.from({ length: 80 }, (_, i) => 4 + (i * 10) / 79);
    line(pk, xs, xs.map((x) => Math.max(-5, Math.log10(paprCcdf(x, N)))), 'ln-s real');
    for (const [x, p] of dots(N)) if (p > 0) pk.layer.append(s('circle', { cx: pk.X(x), cy: pk.Y(Math.log10(p)), r: 3.5, class: 'fc-dot a' }));
    const rows = Array.from({ length: 9 }, (_, i) => i - 4);
    lk.replaceChildren(...rows.flatMap((d, i) => {
      const v = leak(d, eps, 64), H = 110 * v, x0 = 30 + i * 66;
      return [s('rect', { x: x0, y: 128 - H, width: 52, height: Math.max(0.5, H), class: d ? 'fc-bar leak' : 'fc-bar' }), s('text', { x: x0 + 26, y: 144, 'text-anchor': 'middle', class: 'fc-lab big' }, d > 0 ? `+${d}` : String(d).replace('-', '−')), s('text', { x: x0 + 26, y: 123 - H, 'text-anchor': 'middle', class: 'fc-lab big' }, v.toFixed(2))];
    }));
    const sir = offsetSirDb(eps, 64);
    chips.set(0, `${paprDbAt(1e-3, N).toFixed(1)} dB`, `peak passed once in 1000 blocks of ${N}`);
    chips.set(1, `${(paprDbAt(1e-3, N) / 6.02).toFixed(1)} bits`, 'of the converter that the peak holds idle');
    chips.set(2, `${sir.toFixed(1)} dB`, 'what stays over what leaks in', sir < 20 ? 'bad' : 'ok');
    chips.set(3, `${Math.round((eps * 312500) / 5.2e3)} ppm`, 'that error, at 5.2 GHz with 312.5 kHz tones');
    note.textContent = `The closed form treats each sample's power as exponential and independent; the dots are real blocks through the FFT. N hardly matters, since the chance grows with N and the exponential falls fast. An offset of ${eps} of a tone spreads into the neighbours, and because every tone leaks into every other, a stronger signal does not help: that interference is a ceiling on the SNR.`;
  };
  const sel = h('select', { 'aria-label': 'Points' }, ...[64, 512, 4096].map((v) => h('option', { value: String(v), selected: v === N ? true : undefined }, `${v} points`))) as HTMLSelectElement;
  sel.addEventListener('change', () => { N = Number(sel.value); paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'The peak of many tones'), pk.el),
    h('div', { class: 'panel' }, h('h3', null, 'A carrier that is off: one tone\'s leak onto its neighbours'), lk),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, sel, slider('Offset, of a tone', 0, 0.5, 0.01, eps, (v) => v.toFixed(2), (v) => { eps = v; paint(); }).el), chips.el, note)) };
}

/** The level a block passes with probability p. */
export function paprDbAt(p: number, N: number): number {
  let a = 0, b = 30;
  for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (paprCcdf(m, N) > p) a = m; else b = m; }
  return (a + b) / 2;
}
