// The Wi-Fi chapter's panels: a cell of DCF stations in gates on a model of the air (a timeline of what each sends, the model stations beside the gates), and the explorers over comm/wifi.ts: contention, rates, airtime, MIMO.
// The air, the rates and the channels are models, labelled as such: nothing here is a capture of a real radio.

import { Air, bianchi, aggregateMbps, airtimeUs, capacity2x2, goodputMbps, KIND_ACK, KIND_CTS, KIND_DATA, KIND_NAMES, KIND_RTS, measureThroughput, RATES, rateRun, type AirOpts, W_NAMES } from '../comm/wifi';
import { dbToRatio } from '../comm/limits';
import { wifiCell } from '../lib/wifi';
import { gaussian, rng } from '../phys/line';
import { Clarke } from '../phys/radio';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';
import { frameRun } from './slowctl';
import '../styles/wifi.css';

const nf = (x: number, d = 1) => x.toFixed(d);
const stat = (label: string, value: string, cls = '') => h('span', null, `${label} `, h('b', { class: cls }, value));
const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };
const poly = (pts: [number, number][], cls: string) => s('polyline', { class: cls, points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') });
const txt = (x: number, y: number, t: string, cls = 'wf-t', anchor = 'start') => { const e = s('text', { x, y, class: cls, 'text-anchor': anchor }); e.textContent = t; return e; };
const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => s('line', { x1, y1, x2, y2, class: cls });
const row = (el: Node) => h('div', { class: 'mos-row' }, el);
function axes(xr: [number, number], yr: [number, number], xt: number[], yt: number[], fmtX: (v: number) => string, fmtY: (v: number) => string, xl: string, yl: string, W = 560, H = 220) {
  const L = 44, R = 10, T = 24, B = 34;
  const x = (v: number) => L + ((v - xr[0]) / (xr[1] - xr[0])) * (W - L - R), y = (v: number) => T + (1 - (v - yr[0]) / (yr[1] - yr[0])) * (H - T - B);
  const g: SVGElement[] = [];
  for (const v of yt) { g.push(line(L, y(v), W - R, y(v), 'wf-grid')); g.push(txt(L - 5, y(v) + 4, fmtY(v), 'wf-t', 'end')); }
  for (const v of xt) { g.push(line(x(v), T, x(v), H - B, 'wf-grid')); g.push(txt(x(v), H - B + 14, fmtX(v), 'wf-t', 'middle')); }
  g.push(txt(W - R, H - 4, xl, 'wf-t', 'end'), txt(4, 12, yl, 'wf-t'));
  return { w: W, h: H, x, y, g };
}
const svgOf = (a: { w: number; h: number }, label: string, ...kids: SVGElement[]) => s('svg', { class: 'wf-svg', viewBox: `0 0 ${a.w} ${a.h}`, role: 'img', 'aria-label': label }, ...kids);

// ---- the cell in gates --------------------------------------------------------------------------------------------------------
export const CELL_N = 3, AP = 1, A = 0, B = 2;
export const CELL_LEN_US = 300, HIDDEN_LEN_US = 1000, CELL_SEEDS = [101, 3, 300];
const lenOf = (view: 'open' | 'hidden'): number => (view === 'hidden' ? HIDDEN_LEN_US : CELL_LEN_US);
/** The hidden pair on the model stations, with and without RTS / CTS, over `clocks`: frames delivered. */
export function hiddenCompare(clocks = 400000): { plain: number; rts: number; plainDropped: number; a: number; b: number } {
  const go = (useRts: boolean) => {
    const air = new Air({ n: CELL_N, lenUs: HIDDEN_LEN_US, useRts, dest: () => AP, saturated: [true, false, true], seeds: CELL_SEEDS, hears: (i, j) => !((i === A && j === B) || (i === B && j === A)) });
    for (let c = 0; c < clocks; c++) air.step();
    return air.stats;
  };
  const p = go(false), r = go(true);
  return { plain: p.delivered[A] + p.delivered[B], plainDropped: p.dropped[A] + p.dropped[B], rts: r.delivered[A] + r.delivered[B], a: r.delivered[A], b: r.delivered[B] };
}
export interface WifiStatus { clocks: number; delivered: number[]; dropped: number[]; sent: number[]; collisions: number; hidden: boolean; rts: boolean; agreed: boolean; wrong: string; retries: number }
export interface WifiApi { status(): WifiStatus; setHidden(on: boolean): void; setRts(on: boolean): void; run(n: number): void }
export const wifiApi = new WeakMap<Stage, WifiApi>();
const OUTS = ['tx', 'kind', 'st', 'cw', 'bo', 'retry', 'nav', 'cnt', 'done', 'drop'];

export function wifiScene(view: 'open' | 'hidden'): Scene {
  const hide: string[] = ['rst', 'len', 'use_rts'], outs: string[] = [];
  const inp: Record<string, number> = { rst: 1, len: lenOf(view), use_rts: 0 };
  for (let i = 0; i < CELL_N; i++) {
    for (const p of ['seed', 'pending', 'busy', 'rx_data', 'rx_ack', 'rx_rts', 'rx_cts', 'nav_load', 'nav_val']) { hide.push(`${p}${i}`); inp[`${p}${i}`] = p === 'seed' ? CELL_SEEDS[i] : 0; }
    for (const p of OUTS) outs.push(`${p}${i}`);
  }
  return { root: wifiCell(CELL_N), inputs: inp, clock: 'clk', autoClock: false, engine: 'cycle', hiddenInputs: hide, hiddenOutputs: outs, memory: false, panels: [wifiPanel(view)] };
}

interface Span { from: number; to: number; kind: number; bad?: boolean }
function wifiPanel(view: 'open' | 'hidden'): ScenePanel {
  return (stage: Stage): Widget => {
    let hidden = view === 'hidden', rts = false, started = false, agreed = true, wrong = '', stopRun: (() => void) | null = null, raf = 0;
    const LEN = lenOf(view);
    const optsOf = (): AirOpts => ({ n: CELL_N, lenUs: LEN, useRts: rts, dest: () => AP, saturated: [true, false, true], seeds: CELL_SEEDS, hears: (i, j) => !hidden || !((i === A && j === B) || (i === B && j === A)) });
    let air = new Air(optsOf()), ref = new Air(optsOf()), spans: Span[][] = [[], [], []];
    const v = (n: string) => stage.value(n);
    const outsNow = () => [0, 1, 2].map((i) => ({ tx: v(`tx${i}`), kind: v(`kind${i}`) }));
    /** Inputs for the coming edge, from what the gates show; the reference stations take the same edge. */
    const prepare = () => {
      const outs = outsNow(), ins = air.compute(outs), sim = stage.sim!;
      ins.forEach((x, i) => {
        sim.setInput(`pending${i}`, x.pending); sim.setInput(`busy${i}`, x.busy); sim.setInput(`rx_data${i}`, x.rx_data); sim.setInput(`rx_ack${i}`, x.rx_ack);
        sim.setInput(`rx_rts${i}`, x.rx_rts); sim.setInput(`rx_cts${i}`, x.rx_cts); sim.setInput(`nav_load${i}`, x.nav_load); sim.setInput(`nav_val${i}`, x.nav_val);
      });
      sim.settle();
      air.account(outs, [0, 1, 2].map((i) => ({ done: v(`done${i}`), drop: v(`drop${i}`) })));
      ref.step();
      const t = air.stats.clock;
      outs.forEach((o, i) => {
        if (!o.tx) return;
        const a = spans[i], l = a[a.length - 1];
        if (l && l.to === t - 1 && l.kind === o.kind) l.to = t; else a.push({ from: t - 1, to: t, kind: o.kind });
        if (a.length > 200) a.shift();
      });
    };
    const hook = {
      before: () => undefined,
      after: () => {
        if (!started) return;
        ref.sta.forEach((m, i) => {
          if (!agreed) return;
          const o = m.out() as unknown as Record<string, number>;
          for (const n of ['tx', 'kind', 'st', 'cw', 'bo', 'retry', 'nav', 'cnt']) if (v(`${n}${i}`) !== o[n]) { agreed = false; wrong = `station ${i}: ${n} gates ${v(`${n}${i}`)} model ${o[n]}`; break; }
        });
        prepare();
        schedule();
      },
    };
    stage.edgeHooks.add(hook);
    const init = () => {
      air = new Air(optsOf()); ref = new Air(optsOf()); spans = [[], [], []]; agreed = true; wrong = '';
      stage.setInputs({ rst: 1, use_rts: rts ? 1 : 0, len: LEN });
      started = false;
      stage.runCycles(1, undefined, 0, true);
      stage.setInputs({ rst: 0 });
      started = true;
      prepare();
      stage.refresh(); schedule();
    };
    stage.resetHooks.add(() => { stopRun?.(); started = false; requestAnimationFrame(init); });
    stage.historyHooks.add({
      save: () => ({ a: air.save(), r: ref.save(), spans: spans.map((x) => x.map((y) => ({ ...y }))), agreed, wrong }),
      restore: (x) => { const k = x as { a: ReturnType<Air['save']>; r: ReturnType<Air['save']>; spans: Span[][]; agreed: boolean; wrong: string }; air.load(k.a); ref.load(k.r); spans = k.spans.map((y) => y.map((z) => ({ ...z }))); agreed = k.agreed; wrong = k.wrong; schedule(); },
    });
    const act = (f: () => void) => { stopRun?.(); stage.checkpoint(); f(); stage.refresh(); schedule(); };
    const runBtn = btn('Run', 'Run the clock as fast as the page can draw', () => {
      if (stopRun) { stopRun(); return; }
      stage.checkpoint();
      runBtn.textContent = 'Pause';
      stopRun = frameRun(stage, () => false, () => { stopRun = null; runBtn.textContent = 'Run'; schedule(); });
    }, 'btn sm primary');
    const box = (label: string, on: boolean, f: (x: boolean) => void) => { const i = h('input', { type: 'checkbox' }) as HTMLInputElement; i.checked = on; i.addEventListener('change', () => f(i.checked)); return { el: h('label', { class: 'wf-box' }, i, ` ${label}`), i }; };
    const setMode = () => { stopRun?.(); init(); };
    const hb = box('A and B cannot hear each other', hidden, (x) => { hidden = x; setMode(); });
    const rb = box('RTS / CTS', rts, (x) => { rts = x; setMode(); });
    const tl = h('div', { class: 'wf-tl' }), status = h('div', { class: 'mc-status' }), states = h('div', { class: 'wf-states' }), verdict = h('div', { class: 'sr-lock' });
    const WIN = 3000;
    const update = () => {
      if (!stage.sim) return;
      const t = air.stats.clock, t0 = Math.max(0, t - WIN), W = 560, rowH = 26, x = (u: number) => 58 + ((u - t0) / WIN) * (W - 66);
      const kids: SVGElement[] = [];
      ['A', 'AP', 'B'].forEach((n, i) => {
        const y = 8 + i * rowH;
        kids.push(line(58, y + 14, W - 8, y + 14, 'wf-grid'), txt(4, y + 14, n, 'wf-t wf-strong'));
        for (const sp of spans[i]) if (sp.to > t0) kids.push(s('rect', { x: x(Math.max(sp.from, t0)), y, width: Math.max(1, x(sp.to) - x(Math.max(sp.from, t0))), height: 14, class: `wf-frame k${sp.kind}` }));
      });
      tl.replaceChildren(s('svg', { class: 'wf-svg', viewBox: `0 0 ${W} ${8 + 3 * rowH}`, role: 'img', 'aria-label': `The last ${WIN} µs on the air` }, ...kids),
        h('div', { class: 'wf-key' }, ...[KIND_DATA, KIND_ACK, KIND_RTS, KIND_CTS].map((k) => h('span', null, h('i', { class: `wf-sw k${k}` }), KIND_NAMES[k]))));
      const st = air.stats;
      status.replaceChildren(stat('Time', `${(t / 1000).toFixed(1)} ms`), stat('A delivered', String(st.delivered[A])), stat('B delivered', String(st.delivered[B])), stat('Tries', String(st.sent[A] + st.sent[B])), stat('Dropped after 7', String(st.dropped[A] + st.dropped[B]), st.dropped[A] + st.dropped[B] ? 'bad' : ''), stat('Payload share of the air', t ? `${nf((100 * st.successUs) / t, 0)} %` : '–'));
      states.replaceChildren(...[A, B].map((i) => h('div', null, h('b', null, i === A ? 'A ' : 'B '), `${W_NAMES[v(`st${i}`)] ?? '?'}, backoff ${v(`bo${i}`)}, CW ${v(`cw${i}`)}, retry ${v(`retry${i}`)}${v(`nav${i}`) ? `, NAV ${v(`nav${i}`)} µs` : ''}`)));
      verdict.className = `sr-lock ${agreed ? 'ok' : 'bad'}`;
      verdict.textContent = agreed ? 'Gates and model stations agree on every clock so far.' : `Disagreement: ${wrong}`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel wf-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'A cell', h('span', { class: 'fold-hint' })),
      h('div', { class: 'dram-ops' }, btn('1 µs', 'One clock', () => act(() => stage.runCycles(1))), btn('100 µs', '100 clocks', () => act(() => stage.runCycles(100))), runBtn),
      h('div', { class: 'wf-boxes' }, hb.el, rb.el), tl, status, states, verdict,
      h('p', { class: 'sub' }, `A clock is a microsecond, so these are the standard's own timings. Frames of ${LEN} µs, A and B always sending to the access point. Stations are gates; the air, who hears whom, is a model, and this trace is modelled, not captured.`));
    update();
    requestAnimationFrame(() => { if (stage.sim && !started) init(); });
    wifiApi.set(stage, {
      status: () => ({ clocks: air.stats.clock, delivered: [...air.stats.delivered], dropped: [...air.stats.dropped], sent: [...air.stats.sent], collisions: air.stats.collisions, hidden, rts, agreed, wrong, retries: air.stats.sent[A] + air.stats.sent[B] - air.stats.delivered[A] - air.stats.delivered[B] }),
      setHidden: (on) => { hidden = on; hb.i.checked = on; setMode(); },
      setRts: (on) => { rts = on; rb.i.checked = on; setMode(); },
      run: (n) => act(() => { stage.runCycles(n, undefined, 0, true); }),
    });
    return { el, update, destroy: () => { stopRun?.(); stage.edgeHooks.delete(hook); wifiApi.delete(stage); if (raf) cancelAnimationFrame(raf); } };
  };
}

// ---- contention ----------------------------------------------------------------------------------------------------------------------
export function contentionWidget(): Widget {
  let bytes = 1500, rate = 7, rts = false;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const len = airtimeUs(bytes + 28, RATES[rate].ndbps), ns = [1, 2, 3, 5, 8, 12, 20, 30, 50];
    const a = axes([0, 50], [0, 1], [1, 10, 20, 30, 40, 50], [0, 0.25, 0.5, 0.75, 1], (v) => String(v), (v) => `${v * 100} %`, 'stations always sending', 'air carrying payload');
    const pts: [number, number][] = [], meas: SVGElement[] = [];
    for (let n = 1; n <= 50; n++) pts.push([a.x(n), a.y(bianchi(Math.max(n, 2), len, rts).throughput)]);
    for (const n of ns) if (n >= 2) { const m = measureThroughput(n, len, 150000, rts); meas.push(s('circle', { cx: a.x(n), cy: a.y(Math.min(1, m.share)), r: 3.5, class: 'wf-dot' })); }
    plot.replaceChildren(svgOf(a, 'Share of air carrying payload against stations', ...a.g, poly(pts, 'wf-l1'), ...meas));
    const b5 = bianchi(5, len, rts), b30 = bianchi(30, len, rts);
    out.replaceChildren(stat('Frame', `${len} µs`), stat('5 stations', `${nf(b5.throughput * 100, 0)} %, a try collides ${nf(b5.p * 100, 0)} %`), stat('30 stations', `${nf(b30.throughput * 100, 0)} %, a try collides ${nf(b30.p * 100, 0)} %`), stat('Rate × share at 5', `${nf(RATES[rate].mbps * b5.throughput, 1)} Mb/s`));
  };
  const a = slider('Frame', 100, 2300, 100, bytes, (v) => `${v} B`, (v) => { bytes = v; paint(); });
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Rate' }, ...RATES.map((r, i) => h('option', { value: String(i) }, `${r.mbps} Mb/s`))) as HTMLSelectElement;
  sel.value = String(rate);
  sel.addEventListener('change', () => { rate = Number(sel.value); paint(); });
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
  box.addEventListener('change', () => { rts = box.checked; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos wf-w' }, h('div', { class: 'dram-ops' }, sel, h('label', { class: 'wf-box' }, box, ' RTS / CTS')), row(a.el), plot, out, h('p', { class: 'sub' }, 'The line is Bianchi\'s 2000 closed form. The dots are the station model in this page, run for 150 ms of air each. Both are models.')) };
}

// ---- rate adaptation ---------------------------------------------------------------------------------------------------------------
export function rateWidget(): Widget {
  let mean = 22, kmh = 3;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const fd = Math.max(0.5, (kmh / 3.6 * 5.5e9) / 299792458), g = new Clarke(fd, 7), snr = (us: number) => { const c = g.at(us * 1e-6); return mean + 20 * Math.log10(Math.max(1e-3, Math.hypot(c.re, c.im))); };
    const T = 400000, d = () => rng(5);
    const arf = rateRun('arf', snr, d(), 1500, T), oracle = rateRun('oracle', snr, d(), 1500, T), stats = RATES.map((_, i) => rateRun(i, snr, d(), 1500, T));
    const a = axes([0, T / 1000], [0, 60], [0, 100, 200, 300, 400], [0, 20, 40, 60], (v) => String(v), (v) => String(v), 'ms', 'rate, Mb/s');
    const pts = arf.history.map((f) => [a.x(f.us / 1000), a.y(f.mbps)] as [number, number]);
    const snrp: [number, number][] = [];
    for (let u = 0; u <= T; u += 1000) { const v = Math.max(0, Math.min(60, snr(u))); snrp.push([a.x(u / 1000), a.y(v)]); }
    plot.replaceChildren(svgOf(a, 'The rate ARF chose over time, and the SNR', ...a.g, poly(snrp, 'wf-l2'), poly(pts, 'wf-l1'), txt(52, 34, 'thin: SNR, dB', 'wf-t wf-c2')));
    const best = stats.reduce((x, y) => (y.mbps > x.mbps ? y : x)), bi = stats.indexOf(best);
    out.replaceChildren(stat('ARF', `${nf(arf.mbps, 1)} Mb/s, ${nf((100 * arf.lost) / Math.max(1, arf.frames), 0)} % lost`), stat('Told the SNR', `${nf(oracle.mbps, 1)} Mb/s`), stat(`Best fixed (${RATES[bi].mbps})`, `${nf(best.mbps, 1)} Mb/s`), stat('Fixed at 54', `${nf(stats[7].mbps, 1)} Mb/s`, stats[7].mbps < arf.mbps ? 'bad' : ''));
  };
  const a = slider('Mean SNR', 3, 35, 1, mean, (v) => `${v} dB`, (v) => { mean = v; paint(); });
  const b = slider('Walking speed', 0, 30, 1, kmh, (v) => `${v} km/h`, (v) => { kmh = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos wf-w' }, row(a.el), row(b.el), plot, out, h('p', { class: 'sub' }, 'A modelled trace on Clarke\'s fading at 5.5 GHz: each frame\'s fate drawn from a steep function of its SNR, not a captured radio. ARF: up after 10 good frames, down after 2 lost.')) };
}

// ---- airtime -----------------------------------------------------------------------------------------------------------------------------
export function airtimeWidget(): Widget {
  let bytes = 1500, n = 1;
  const body = h('tbody'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    body.replaceChildren(...RATES.map((r) => h('tr', null, h('td', null, r.modulation), h('td', { class: 'num' }, `${r.mbps}`), h('td', { class: 'num' }, `${airtimeUs(bytes + 28, r.ndbps)} µs`), h('td', { class: 'num' }, nf(goodputMbps(bytes, r), 1)), h('td', { class: 'num' }, nf(aggregateMbps(bytes, n, r), 1)))));
    const r = RATES[7];
    out.replaceChildren(stat('Efficiency at 54, one frame', `${nf(goodputMbps(bytes, r) / 0.54, 0)} %`), stat(`${n} aggregated`, `${nf(aggregateMbps(bytes, n, r) / 0.54, 0)} %`));
  };
  const a = slider('Payload', 40, 2300, 20, bytes, (v) => `${v} B`, (v) => { bytes = v; paint(); });
  const b = slider('Frames aggregated', 1, 64, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos wf-w' }, row(a.el), row(b.el), h('div', { class: 'wf-scroll' }, h('table', { class: 'wf-table' }, h('thead', null, h('tr', null, ...['Code', 'Rate, Mb/s', 'Frame on air', 'Goodput, Mb/s', 'Aggregated, Mb/s'].map((t) => h('th', null, t)))), body)), out, h('p', { class: 'sub' }, 'One sender and an idle channel. No collisions, no fading: the ceiling, by the standard\'s formula for OFDM frame length.')) };
}

// ---- MIMO --------------------------------------------------------------------------------------------------------------------------------
export function mimoCurves(corr: number, draws = 400, seed = 3) {
  const u = rng(seed), hs: [number, number][][] = [];
  const cn = (): [number, number] => [gaussian(u) * Math.SQRT1_2, gaussian(u) * Math.SQRT1_2];
  for (let k = 0; k < draws; k++) {
    // two receive antennas correlated: the second row leans towards the first
    const a = cn(), b = cn(), c = cn(), d = cn(), m = Math.sqrt(1 - corr * corr);
    hs.push([a, b, [corr * a[0] + m * c[0], corr * a[1] + m * c[1]], [corr * b[0] + m * d[0], corr * b[1] + m * d[1]]]);
  }
  const mean = (snrDb: number) => { const x = dbToRatio(snrDb); return hs.reduce((sum, h1) => sum + capacity2x2(h1, x), 0) / draws; };
  const siso = (snrDb: number) => { const x = dbToRatio(snrDb); return hs.reduce((sum, h1) => sum + Math.log2(1 + x * (h1[0][0] ** 2 + h1[0][1] ** 2)), 0) / draws; };
  return { mean, siso };
}
export function mimoWidget(): Widget {
  let corr = 0;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const { mean, siso } = mimoCurves(corr);
    const a = axes([0, 40], [0, 24], [0, 10, 20, 30, 40], [0, 6, 12, 18, 24], (v) => String(v), (v) => String(v), 'SNR, dB', 'b/s/Hz');
    const m: [number, number][] = [], one: [number, number][] = [];
    for (let d = 0; d <= 40; d += 1) { m.push([a.x(d), a.y(Math.min(24, mean(d)))]); one.push([a.x(d), a.y(Math.min(24, siso(d)))]); }
    plot.replaceChildren(svgOf(a, 'Capacity of one antenna against two by two', ...a.g, poly(one, 'wf-l2'), poly(m, 'wf-l1'), txt(a.x(30), a.y(Math.min(24, siso(30))) + 16, '1 × 1', 'wf-t wf-c2'), txt(a.x(28), a.y(Math.min(24, mean(28))) - 8, '2 × 2', 'wf-t')));
    out.replaceChildren(stat('At 30 dB', `${nf(mean(30), 1)} against ${nf(siso(30), 1)} b/s/Hz`), stat('Each 3 dB at high SNR', `+${nf(mean(40) - mean(37), 1)} b/s/Hz, against +${nf(siso(40) - siso(37), 1)}`));
  };
  const a = slider('Antenna correlation', 0, 1, 0.05, corr, (v) => nf(v, 2), (v) => { corr = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos wf-w' }, row(a.el), plot, out, h('p', { class: 'sub' }, 'Mean capacity over 400 random Rayleigh channels, power split between the two antennas, the receiver knowing the channel.')) };
}

