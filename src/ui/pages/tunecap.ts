// "Tune it" (cap_tune), the signal-processing capstone that is a chain of the software radio chapter's blocks, not a circuit (dsp/tune.ts). No sandbox: the brief,
// a practice band the learner sees and hears through their own chain, the chain as cards, its cost from the gates, and a check on five bands drawn
// from attempts the learner has not seen. A failed band shows what the learner's own chain measured, and hints that name blocks, never settings. A pass is
// recorded under the capstone's id in the campaign progress, as the other capstones are.

import { progress } from '../../campaign/progress';
import { prepareClip } from '../../dsp/clip';
import { bandSpectrum, DEV, FS } from '../../dsp/sdr';
import {
  attemptSeeds, ATTEMPTS, BLOCK_NAME, BLOCK_NOUN, blockCosts, chainCost, chanGainDb, checkChain, DEFAULT_CHAIN, explain, findSpectrum, FIND_BINS, binHz, fmtKhz, gradeSteps, hintsFor, LIMITS, makeBand,
  PRACTICE_SEED, REFERENCE_CHAIN, runChain, sampleBand, slipText, STAGE, TONE_MAX, TONE_MIN, UNIT_S, type BandResult, type Block, type Chain, type Cost, type GatePrices, type Kind, type Run,
} from '../../dsp/tune';
import { DSP_CAPSTONES } from '../../learn/capstones';
import { cicDecimator } from '../../lib/multirate';
import { complexMixer } from '../../lib/sdr';
import { stats } from '../../sim/stats';
import { clipButton } from '../../widgets/clip';
import { h, s } from '../dom';
import '../../styles/signals.css';
import '../../styles/tune.css';
import { groupNum } from '../../sim/numfmt';
import { needsLine } from '../capneeds';
import { numOf } from '../../chapters/order';

const KEY = 'mosfet2riscv:captune:';
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(KEY + k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* storage blocked: nothing kept */ } };

const PRICES: GatePrices = { mixer: (k) => stats(complexMixer(k)).nands, cic: (N, R, w) => stats(cicDecimator(N, R, w)).nands };
const n0 = (v: number) => groupNum(Math.round(v));
const mps = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : `${n0(v / 1e3)} k`);
const khz = (hz: number) => `${(hz / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} kHz`;

/** New blocks as added from the chips: settings that run, not good ones. */
const FRESH: Record<Exclude<Kind, 'mixer' | 'disc' | 'morse'>, Block> = {
  cic: { kind: 'cic', N: 3, R: 2 }, halfband: { kind: 'halfband', taps: 23 }, poly: { kind: 'poly', taps: 31, R: 2 }, channel: { kind: 'channel', taps: 61, cutoff: 60_000 },
  audio: { kind: 'audio', taps: 63, cutoff: 3_000, M: 2 }, deemph: { kind: 'deemph' },
};

/** A chain read back from storage, if every block still has the fields its kind needs and the chain runs; else the starting chain. */
function sane(c: unknown): Chain {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const ok = (b: Block): boolean => {
    switch (b?.kind) {
      case 'mixer': return num(b.bits) && !!b.tune && (b.tune.mode === 'find' ? num(b.tune.marginDb) : b.tune.mode === 'fixed' && num(b.tune.hz));
      case 'cic': return num(b.N) && num(b.R) && (LIMITS.cicR as readonly number[]).includes(b.R) && b.N >= 1 && b.N <= 5;
      case 'halfband': return num(b.taps);
      case 'poly': return num(b.taps) && num(b.R);
      case 'channel': return num(b.taps) && num(b.cutoff);
      case 'disc': return (b.method === 'phase' || b.method === 'cordic') && num(b.stages);
      case 'audio': return num(b.taps) && num(b.cutoff) && num(b.M);
      case 'deemph': return true;
      case 'morse': return b.threshold === 'auto' || num(b.threshold);
      default: return false;
    }
  };
  try { if (Array.isArray(c) && c.every(ok) && checkChain(c as Chain).problem === null) return c as Chain; } catch { /* fall through */ }
  return structuredClone(DEFAULT_CHAIN);
}

/**
 * A spectrum in dB as a polyline over [lo, hi] hertz, with a shaded band and markers. Gridlines every 10 dB below the peak, labelled; marker labels sit
 * beside their line on a halo, in rows so two never collide. `zero` names the 0 tick ("0" for a band, "tuned" for a plot relative to the tuning).
 */
function spectrumSvg(o: { db: Float64Array; hzOf: (i: number) => number; lo: number; hi: number; shade?: [number, number]; marks: { hz: number; label: string; cls: string }[]; label: string; zero?: string; W?: number; H?: number }): SVGSVGElement {
  const W = o.W ?? 560, H = o.H ?? 160, L = 40, R = 6, T = 22, B = 22, X = (f: number) => L + ((W - L - R) * (f - o.lo)) / (o.hi - o.lo);
  const vals: number[] = [];
  for (let i = 0; i < o.db.length; i++) { const f = o.hzOf(i); if (f >= o.lo && f <= o.hi) vals.push(o.db[i]); }
  const sorted = [...vals].sort((a, b) => a - b), top = sorted[sorted.length - 1] ?? 0, bot = sorted[Math.floor(sorted.length * 0.05)] ?? top - 60, lo = Math.min(bot - 3, top - 20);
  const Y = (v: number) => T + ((H - T - B) * (top - Math.max(lo, Math.min(top, v)))) / (top - lo);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tc-spec', role: 'img', 'aria-label': o.label });
  svg.append(s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'tc-spec-bg' }));
  if (o.shade) { const a = X(Math.max(o.lo, o.shade[0])), b = X(Math.min(o.hi, o.shade[1])); if (b > a) svg.append(s('rect', { x: a, y: T, width: b - a, height: H - T - B, class: 'tc-spec-shade' })); }
  for (let d = 0; top - d >= lo; d += 10) svg.append(s('line', { x1: L, x2: W - R, y1: Y(top - d), y2: Y(top - d), class: 'tc-grid' }), s('text', { x: L - 4, y: Y(top - d) + 4, 'text-anchor': 'end', class: 'tc-tick' }, d === 0 ? '0 dB' : `−${d}`));
  let d = '';
  for (let i = 0; i < o.db.length; i++) { const f = o.hzOf(i); if (f < o.lo || f > o.hi) continue; d += `${d ? 'L' : 'M'}${X(f).toFixed(1)},${Y(o.db[i]).toFixed(1)}`; }
  svg.append(s('path', { d, class: 'tc-spec-line' }));
  const rows: number[][] = [];
  for (const m of o.marks) {
    if (m.hz < o.lo || m.hz > o.hi) continue;
    const x = X(m.hz), w = 7.5 * m.label.length, right = x + 4 + w <= W - R, lx = right ? x + 4 : x - 4 - w;
    let row = rows.findIndex((r) => r.every((rx) => Math.abs(rx - lx) > w + 8));
    if (row < 0) { rows.push([]); row = rows.length - 1; }
    rows[row].push(lx);
    svg.append(s('line', { x1: x, x2: x, y1: T, y2: H - B, class: `tc-mark ${m.cls}` }), s('text', { x: right ? x + 4 : x - 4, y: T - 6 + 13 * row, 'text-anchor': right ? 'start' : 'end', class: `tc-mark-t ${m.cls}` }, m.label));
  }
  for (const f of [o.lo, 0, o.hi]) svg.append(s('text', { x: X(f), y: H - 6, 'text-anchor': f === o.lo ? 'start' : f === o.hi ? 'end' : 'middle', class: 'tc-tick' }, f === 0 ? (o.zero ?? '0') : fmtKhz(f)));
  return svg;
}

/** Where the chain's filters before the discriminator are 6 dB down, from the tuned frequency: its channel as the learner built it. */
function channelEdge(c: Chain): number {
  for (let f = 0; f < FS / 2; f += 250) if (chanGainDb(c, f) < -6) return f;
  return FS / 2;
}

export class TuneCapstonePage {
  readonly kind = 'capstone';
  readonly el = h('div', { class: 'scroll' });
  private body = h('div', { class: 'cc-page tc-page' });
  private chain: Chain = sane(load('chain', null));
  private cards = h('div', { class: 'tc-chain' });
  private problem = h('p', { class: 'tc-problem', 'aria-live': 'polite' });
  private tiles = h('div', { class: 'tc-tiles' });
  private practice = h('div', { class: 'tc-practice', 'aria-live': 'polite' });
  private out = h('div', { class: 'tc-out' });
  private checkBtn = h('button', { type: 'button', class: 'btn primary' }, 'Check on 5 unseen bands') as HTMLButtonElement;
  private timer = 0;
  private stop = false;
  private run: Run | null = null;
  private band = makeBand(PRACTICE_SEED);
  private input = sampleBand(this.band);
  private spec = findSpectrum(this.input.xr, this.input.xi);

  constructor(readonly nodeId: string) {
    const meta = DSP_CAPSTONES.find((c) => c.id === nodeId);
    this.el.append(this.body);
    const play = clipButton('Play your chain on the practice band', () => {
      if (!this.run) return null;
      let a = this.run.audio, rate = this.run.audioRate;
      // the browser plays up to 48 kHz: keep every k-th sample of a sound already filtered below the tone's neighbourhood would alias; average k instead
      const k = Math.ceil(rate / 48_000);
      if (k > 1) { const o = new Float64Array(Math.floor(a.length / k)); for (let i = 0; i < o.length; i++) { let v = 0; for (let j = 0; j < k; j++) v += a[i * k + j]; o[i] = v / k; } a = o; rate /= k; }
      return { samples: prepareClip(a), rate, source: 'model', note: 'your chain, block by block, on the practice band' };
    }, 'Your chain does not run yet');
    this.checkBtn.addEventListener('click', () => this.check());
    this.body.append(
      h('p', { class: 'cc-crumb' }, h('a', { href: '#/path' }, 'My path'), ' › Signal processing capstone'),
      h('h1', null, meta?.title ?? 'Tune it'),
      h('div', { class: 'tc-cols' },
        h('aside', { class: 'tc-side' },
          h('section', { class: 'tc-card' }, h('h2', null, 'The brief'),
            h('p', null, `A band sampled at ${n0(FS / 1000)} kHz holds four FM stations, each swinging ±${DEV / 1000} kHz. One of them is weak, and keys a tone between ${TONE_MIN} and ${TONE_MAX} Hz on and off in Morse at 30 words a minute (a unit of ${UNIT_S * 1000} ms). Build a chain from the blocks of chapter ${numOf('sdr')}'s software radio that finds it and decodes the message. There is no dial: the mixer's "find it" takes the weakest line in the band that stands a margin you set above its surroundings (the median of ±25 kHz), because a keyed station rests on its bare carrier between marks while a loud one spreads its power over its channel.`),
            needsLine(meta?.needs, 'cc-hint') ?? '',
            h('p', null, `You see one practice band. A check runs your chain on five more, each with the station somewhere else, a different message and a different neighbourhood. Every one of the five must decode, exactly. Each check takes the next of ${ATTEMPTS.length} sets of five, from a starting point of your own, so a chain that only fits the last five will not do.`),
            h('p', { class: 'cc-hint' }, 'The mixer and the CICs are gates and are priced in NANDs, counted from their circuits at your sizes. Everything after them runs on a DSP core and is priced in multiplies a second. The Morse decoder is given and free: it listens for the tone against everything else in the sound.')),
          h('section', { class: 'tc-card' }, h('h2', null, 'Practice band'), this.practice, play.el)),
        h('div', { class: 'tc-main' },
          h('h2', null, 'Your chain ', h('span', { class: 'cc-hint' }, 'set each block, move it among its neighbours with the arrows, × to remove')),
          this.cards,
          h('div', { class: 'tc-add' }, h('span', { class: 'cc-hint' }, 'Add a block:'),
            ...(Object.keys(FRESH) as (keyof typeof FRESH)[]).map((k) => h('button', { type: 'button', class: 'tc-chip', onclick: () => this.add(k) }, `+ ${BLOCK_NAME[k]}`)),
            h('button', { type: 'button', class: 'tc-chip', onclick: () => { this.chain = structuredClone(DEFAULT_CHAIN); this.changed(true); } }, 'Start again')),
          this.problem, this.tiles,
          h('div', { class: 'cc-row' }, this.checkBtn, h('span', { class: 'cc-hint' }, 'Each band is decoded by your chain, then compared with the message it carries.')),
          this.out)));
    this.changed(true);
  }

  destroy(): void { clearTimeout(this.timer); this.stop = true; }

  // ---- the chain --------------------------------------------------------------------------------------------------------------------------

  private add(k: keyof typeof FRESH): void {
    const b = structuredClone(FRESH[k]), st = STAGE[k];
    let at = this.chain.length - 1;
    while (at > 0 && STAGE[this.chain[at - 1].kind] > st) at--;
    this.chain.splice(at, 0, b);
    this.changed(true);
  }

  /** The chain changed: keep it, redraw the cards when its shape changed, price it, and rerun the practice band shortly. */
  private changed(shape: boolean): void {
    save('chain', this.chain);
    if (shape) this.drawCards();
    const { problem, rates } = checkChain(this.chain);
    this.problem.textContent = problem ?? '';
    this.checkBtn.disabled = problem !== null;
    this.cards.querySelectorAll<HTMLElement>('[data-rate]').forEach((el) => { const r = rates[Number(el.dataset.rate)]; el.textContent = r ? (r.outRate < r.inRate ? `${khz(r.inRate)} → ${khz(r.outRate)}` : `at ${khz(r.inRate)}`) : ''; });
    if (problem) { this.tiles.replaceChildren(); this.practice.replaceChildren(h('p', { class: 'cc-hint' }, 'Your chain does not run yet.')); this.run = null; return; }
    const cost = chainCost(this.chain, PRICES);
    this.paintCosts(cost);
    clearTimeout(this.timer);
    this.practice.classList.add('tc-busy');
    this.timer = window.setTimeout(() => this.paintPractice(), 350);
  }

  private paintCosts(cost: Cost): void {
    const each = blockCosts(this.chain, PRICES);
    this.chain.forEach((b, i) => {
      const el = this.cards.querySelector<HTMLElement>(`[data-cost="${i}"]`);
      if (!el) return;
      el.textContent = b.kind === 'morse' ? 'free (given)' : b.kind === 'cic' ? `2 × ${n0(each[i].nands / 2)} NANDs` : each[i].nands ? `${n0(each[i].nands)} NANDs` : b.kind === 'disc' ? `${mps(each[i].mults)} mult/s + ${mps(each[i].angles)} ${b.method === 'cordic' ? 'CORDIC stages' : 'angles'}/s` : `${mps(each[i].mults)} mult/s`;
    });
    const out = checkChain(this.chain).rates.at(-1)!.outRate;
    this.tiles.replaceChildren(
      h('div', { class: 'tc-tile' }, h('b', null, n0(cost.nands)), h('span', null, 'NANDs in gates (mixer + CICs)')),
      h('div', { class: 'tc-tile' }, h('b', null, mps(cost.mults + cost.angles)), h('span', null, 'operations a second after the gates (multiplies and angle steps)')),
      h('div', { class: 'tc-tile' }, h('b', null, khz(out)), h('span', null, 'into the decoder')));
  }

  private paintPractice(): void {
    this.practice.classList.remove('tc-busy');
    const r = (this.run = runChain(this.chain, this.band, { input: this.input })), edge = channelEdge(this.chain), tuned = r.tunedHz;
    const svg = spectrumSvg({
      db: this.spec, hzOf: binHz, lo: -FS / 2, hi: FS / 2 - FS / FIND_BINS, label: `Spectrum of the practice band in dB below its peak, −480 to +480 kHz${tuned === null ? '' : `; your chain tuned to ${fmtKhz(tuned)}, its CIC and channel filters shaded to their 6 dB edge, ±${(edge / 1000).toFixed(0)} kHz`}`,
      shade: tuned === null ? undefined : [tuned - edge, tuned + edge], marks: tuned === null ? [] : [{ hz: tuned, label: 'tuned', cls: 'tuned' }], W: 300, H: 140,
    });
    const ok = r.decoded.text === this.band.message;
    this.practice.replaceChildren(svg,
      h('p', { class: 'tc-mono' }, tuned === null ? '"find it" found no station' : `tuned ${fmtKhz(tuned, 1)}${r.found ? ` · its line stood ${r.found.standsDb.toFixed(1)} dB above its surroundings` : ''}`),
      h('p', { class: 'tc-mono' }, 'sent: ', h('b', null, this.band.message), ' · decoded: ', h('b', { class: ok ? 'tc-good' : 'tc-bad' }, r.decoded.text || '(nothing)')));
  }

  private drawCards(): void {
    const last = this.chain.length - 1;
    this.cards.replaceChildren(...this.chain.map((b, i) => {
      const set = (patch: Partial<Block>, shape = false) => { this.chain[i] = { ...this.chain[i], ...patch } as Block; this.changed(shape); };
      const fields = this.fields(b, set);
      const fixed = b.kind === 'mixer' || b.kind === 'morse', swaps = (j: number) => j > 0 && j < last && STAGE[this.chain[j].kind] === STAGE[b.kind];
      const move = (d: number) => { const j = i + d; [this.chain[i], this.chain[j]] = [this.chain[j], this.chain[i]]; this.changed(true); };
      return h('div', { class: `tc-block tc-${b.kind}`, role: 'group', 'aria-label': BLOCK_NAME[b.kind] },
        h('div', { class: 'tc-block-head' }, h('b', null, BLOCK_NAME[b.kind]),
          fixed ? null : h('span', { class: 'tc-block-ops' },
            h('button', { type: 'button', class: 'tc-op', 'aria-label': `Move ${BLOCK_NAME[b.kind]} earlier`, disabled: !swaps(i - 1), onclick: () => move(-1) }, '←'),
            h('button', { type: 'button', class: 'tc-op', 'aria-label': `Move ${BLOCK_NAME[b.kind]} later`, disabled: !swaps(i + 1), onclick: () => move(1) }, '→'),
            b.kind === 'disc' ? null : h('button', { type: 'button', class: 'tc-op', 'aria-label': `Remove ${BLOCK_NAME[b.kind]}`, onclick: () => { this.chain.splice(i, 1); this.changed(true); } }, '×'))),
        ...fields, h('div', { class: 'tc-rate', 'data-rate': String(i) }), h('div', { class: 'tc-cost', 'data-cost': String(i) }));
    }));
  }

  private fields(b: Block, set: (p: Partial<Block>, shape?: boolean) => void): HTMLElement[] {
    const id = () => `tc-f${Math.random().toString(36).slice(2, 8)}`;
    const num = (label: string, v: number, min: number, max: number, step: number, on: (x: number) => void) => {
      const i = id(), inp = h('input', { id: i, type: 'number', value: String(v), min: String(min), max: String(max), step: String(step), inputmode: 'decimal' }) as HTMLInputElement;
      inp.addEventListener('change', () => { const x = Number(inp.value); if (Number.isFinite(x)) on(Math.max(min, Math.min(max, x))); });
      return h('label', { class: 'tc-field', for: i }, h('span', null, label), inp);
    };
    const pick = <T extends string | number,>(label: string, v: T, opts: readonly T[], name: (x: T) => string, on: (x: T) => void) => {
      const i = id(), sel = h('select', { id: i }, ...opts.map((o) => h('option', { value: String(o), selected: o === v }, name(o)))) as HTMLSelectElement;
      sel.addEventListener('change', () => on(opts[sel.selectedIndex]));
      return h('label', { class: 'tc-field', for: i }, h('span', null, label), sel);
    };
    const odd = (x: number) => (Math.round(x) % 2 ? Math.round(x) : Math.round(x) + 1);
    switch (b.kind) {
      case 'mixer': return [
        pick('Tune', b.tune.mode, ['find', 'fixed'] as const, (m) => (m === 'find' ? 'find it' : 'a fixed frequency'), (m) => set({ tune: m === 'find' ? { mode: 'find', marginDb: 12 } : { mode: 'fixed', hz: 0 } }, true)),
        b.tune.mode === 'find' ? num('Stands above its surroundings by (dB)', b.tune.marginDb, LIMITS.marginDb[0], LIMITS.marginDb[1], 0.5, (x) => set({ tune: { mode: 'find', marginDb: x } })) : num('Frequency (kHz)', b.tune.hz / 1000, -480, 480, 0.5, (x) => set({ tune: { mode: 'fixed', hz: x * 1000 } })),
        pick('Table bits', b.bits, Array.from({ length: LIMITS.bits[1] - LIMITS.bits[0] + 1 }, (_, k) => LIMITS.bits[0] + k), String, (x) => set({ bits: x })),
      ];
      case 'cic': return [pick('Order N', b.N, [1, 2, 3, 4, 5], String, (x) => set({ N: x })), pick('Ratio', b.R, LIMITS.cicR, (x) => `÷ ${x}`, (x) => set({ R: x }))];
      case 'halfband': return [num('Taps', b.taps, 3, LIMITS.taps[1], 2, (x) => set({ taps: odd(x) }))];
      case 'poly': return [num('Taps', b.taps, 3, LIMITS.taps[1], 2, (x) => set({ taps: odd(x) })), pick('Ratio', b.R, LIMITS.polyR, (x) => `÷ ${x}`, (x) => set({ R: x }))];
      case 'channel': return [num('Taps', b.taps, 3, LIMITS.taps[1], 2, (x) => set({ taps: odd(x) })), num('Cutoff (kHz)', b.cutoff / 1000, 0.5, 480, 0.5, (x) => set({ cutoff: x * 1000 }))];
      case 'disc': return [
        pick('Method', b.method, ['phase', 'cordic'] as const, (m) => (m === 'phase' ? 'phase step' : 'CORDIC'), (m) => set({ method: m }, true)),
        ...(b.method === 'cordic' ? [num('Stages', b.stages, LIMITS.stages[0], LIMITS.stages[1], 1, (x) => set({ stages: Math.round(x) }))] : []),
      ];
      case 'audio': return [num('Taps', b.taps, 3, LIMITS.taps[1], 2, (x) => set({ taps: odd(x) })), num('Cutoff (Hz)', b.cutoff, 50, 100_000, 50, (x) => set({ cutoff: x })), pick('Ratio', b.M, LIMITS.M, (x) => `÷ ${x}`, (x) => set({ M: x }))];
      case 'deemph': return [h('span', { class: 'cc-hint' }, 'τ = 75 µs, the transmitter\'s')];
      case 'morse': return [
        pick('Threshold', b.threshold === 'auto' ? 'auto' : 'set', ['auto', 'set'] as const, (m) => (m === 'auto' ? 'auto' : 'dB above the quiet'), (m) => set({ threshold: m === 'auto' ? 'auto' : 10 }, true)),
        ...(b.threshold === 'auto' ? [] : [num('dB', b.threshold, 0, 60, 0.5, (x) => set({ threshold: x }))]),
      ];
    }
  }

  // ---- the check --------------------------------------------------------------------------------------------------------------------------

  private check(): void {
    // the learner's own starting point in the list, drawn once; where storage is refused, a fresh draw each time
    const start = load<number | null>('start', null) ?? Math.floor(Math.random() * ATTEMPTS.length);
    save('start', start);
    const chain = structuredClone(this.chain), turn = load('attempt', 0), attempt = ATTEMPTS[(start + turn) % ATTEMPTS.length], seeds = attemptSeeds(attempt);
    save('attempt', turn + 1);
    const results: BandResult[] = [], status = h('p', { class: 'cc-hint', 'aria-live': 'polite' });
    this.checkBtn.disabled = true;
    this.out.replaceChildren(status);
    let i = 0, g = gradeSteps(chain, makeBand(seeds[0]));
    const step = () => {
      if (this.stop) return;
      const r = g.next();
      if (!r.done) { status.textContent = `Band ${i + 1} of 5: ${r.value}…`; this.timer = window.setTimeout(step, 0); return; }
      results.push(r.value);
      if (++i < seeds.length) { g = gradeSteps(chain, makeBand(seeds[i])); this.timer = window.setTimeout(step, 0); return; }
      this.checkBtn.disabled = checkChain(this.chain).problem !== null;
      this.verdict(chain, results);
    };
    this.timer = window.setTimeout(step, 30);
  }

  private verdict(chain: Chain, results: BandResult[]): void {
    const right = results.filter((r) => r.ok).length, passed = right === results.length, cost = chainCost(chain, PRICES), detail = h('div', { class: 'tc-why' });
    const rows = results.map((r, i) => {
      const why = r.ok ? null : h('button', { type: 'button', class: 'btn sm', 'aria-expanded': 'false', onclick: (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement, open = b.getAttribute('aria-expanded') === 'true';
        this.out.querySelectorAll('.tc-table button[aria-expanded]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
        if (open) { detail.replaceChildren(); return; }
        b.setAttribute('aria-expanded', 'true');
        detail.replaceChildren(this.failBoard(r, i + 1, chain));
        detail.scrollIntoView?.({ block: 'nearest' });
      } }, 'Why?');
      return h('tr', { class: r.ok ? 'ok' : 'no' }, h('td', null, String(i + 1)), h('td', null, fmtKhz(r.band.stations[r.band.weak].f)), h('td', null, r.band.message), h('td', null, r.run.decoded.text || '(nothing)'), h('td', null, r.ok ? '✓ right' : '✗ ', why));
    });
    let note: HTMLElement | null = null;
    if (passed) {
      // the best is kept as NANDs, then the DSP core's operations a second (multiplies and angle steps) under the metric for counted operations
      const g = progress().solveCapstone('cap_tune', { nand: cost.nands, laneops: Math.round(cost.mults + cost.angles) }, (m) => [m.nand ?? Infinity, m.laneops ?? Infinity]);
      const ref = chainCost(REFERENCE_CHAIN, PRICES);
      note = h('div', { class: 'tc-pass' }, h('h3', null, g.first ? 'Capstone passed' : g.best ? 'Passed, and a new best' : 'Passed'),
        h('p', null, `Your chain: ${n0(cost.nands)} NANDs in gates and ${mps(cost.mults + cost.angles)} operations a second after them. The book's: ${n0(ref.nands)} NANDs and ${mps(ref.mults + ref.angles)} (a fifth-order CIC ÷ 4 behind an eight-bit table, a 161-tap channel filter at 55 kHz, de-emphasis, a 121-tap audio filter ÷ 10). A cheaper chain that still passes is the better radio.`));
    }
    this.out.replaceChildren(
      h('h2', null, 'Verdict ', h('span', { class: 'cc-hint' }, `${right} of ${results.length} bands right · a pass needs all ${results.length}`)),
      h('div', { class: 'ec-tw' }, h('table', { class: 'ec-t tc-table' }, h('thead', null, h('tr', null, ...['Band', 'Station', 'Sent', 'You decoded', 'Result'].map((t) => h('th', null, t)))), h('tbody', null, ...rows))),
      note ?? h('p', { class: 'cc-hint' }, 'The next check takes the next set of five.'), detail);
  }

  /** Why a band failed: what the learner's chain saw (never the band itself), what was measured, and hints by block. */
  private failBoard(r: BandResult, n: number, chain: Chain): HTMLElement {
    const run = r.run, span = Math.min(run.gatesRate / 2, 150_000), narrow = (this.el.clientWidth || window.innerWidth) < 640, edge = channelEdge(chain), spec = bandSpectrum(run.gatesRe, run.gatesIm, 2048, 16), M = spec.length;
    const marks = [{ hz: 0, label: 'tuned', cls: 'tuned' }];
    let off = '', aria = '';
    if (r.cause?.kind === 'interference') {
      // where the plot shows the neighbour: its carrier in what leaves the gates (a fold after them comes later)
      const w = r.cause.worst, at = w.atGates, label = w.block === null || w.atGates === w.offKhz * 1000 ? 'neighbour' : 'folded neighbour';
      if (Math.abs(at) <= span) { marks.push({ hz: at, label, cls: 'culprit' }); aria = `; the ${label} at ${fmtKhz(at)}`; }
      else off = ` The neighbour's carrier, at ${fmtKhz(at)} here, is off this plot.`;
    }
    const lastBlock = [...chain].reverse().find((b) => STAGE[b.kind] <= 1)!;
    return h('section', { class: 'tc-board' },
      h('h3', null, `Band ${n}: decoded "${run.decoded.text || '(nothing)'}", sent "${r.band.message}"`),
      run.tunedHz === null ? null : h('figure', { class: 'tc-fig' }, h('figcaption', null, `What leaves your ${BLOCK_NOUN[lastBlock.kind]}, in dB below its peak, around the tuning (your CIC and channel filters shaded to their 6 dB edge).${off}`),
        spectrumSvg({ db: spec, hzOf: (i) => ((i - M / 2) * run.gatesRate) / M, lo: -span, hi: span, shade: [-edge, edge], marks, zero: '0 = tuned', W: narrow ? 340 : 560,
          label: `Spectrum leaving your ${BLOCK_NOUN[lastBlock.kind]}, ±${(span / 1000).toFixed(0)} kHz around the tuning; channel shaded to ±${(edge / 1000).toFixed(0)} kHz${aria}` })),
      h('div', { class: 'tc-wrong' }, h('h4', null, 'What went wrong'), ...explain(r, chain).map((t) => h('p', null, t))),
      h('div', { class: 'tc-help' }, h('h4', null, 'Things that would help'), h('ul', null, ...hintsFor(r.cause!, chain).map((t) => h('li', null, t))), h('p', { class: 'cc-hint' }, 'Each hint gives a direction, never a number: the numbers are yours to find.')),
      slipText(r).length ? h('div', { class: 'tc-slips' }, h('h4', null, 'Where your decoder slipped'), h('ul', { class: 'tc-mono' }, ...slipText(r).map((t) => h('li', null, t)))) : null);
  }
}
