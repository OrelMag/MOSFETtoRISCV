// The side-channels chapter's widgets. Every number they show comes from a run: the golden model for the password
// check, the out-of-order model in spec mode (riscv/ooomodel.ts) for the cache and Spectre steps, read back from what
// the attacker program itself stored in memory.

import { assemble } from '../riscv/asm';
import { BENCHMARKS } from '../riscv/benchprograms';
import type { ISS } from '../riscv/iss';
import { OooModel, type OooConfig, type Uop } from '../riscv/ooomodel';
import {
  callsSource, HIT_BELOW, MAP, NOTHING, probeSource, pwCheckText, pwRun, PW_LETTERS, PASSWORD, sideConfig, SIDE_OPTS, SIDE_SPEC,
  spectreWords, STREAM_SOURCE, timesIn, type Defence,
} from '../riscv/sideprograms';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { legend, timeline } from './ooo';
import '../styles/ooo.css';
import '../styles/sidechan.css';

export type Guard = Defence | 'fill';
export const GUARD_NAME: Record<Guard, string> = { none: 'No defence', fence: 'A fence after the check', mask: 'The index masked', fill: 'Fill at commit' };

// ---- runs (memoized: the widgets re-ask while the learner clicks) ---------------------------------------------------------

const memo = new Map<string, unknown>();
function once<T>(key: string, f: () => T): T {
  if (!memo.has(key)) memo.set(key, f());
  return memo.get(key) as T;
}
const dmemOf = (m: OooModel) => (m as unknown as { iss: ISS }).iss.dmem;
const byteAt = (d: Uint32Array, a: number) => (d[a >> 2] >>> (8 * (a & 3))) & 255;

function runModel(words: number[], cfg: Partial<OooConfig>, max = 2_000_000): OooModel {
  const m = new OooModel(words, cfg, SIDE_OPTS);
  m.historyMax = 1e9;
  m.run(max);
  return m;
}

export interface Attack {
  secret: number[];
  guard: Guard;
  /** What the attacker program stored for each nibble (NOTHING: no line came back fast). */
  recovered: number[];
  /** Its 16 reload times for the last nibble. */
  times: number[];
  /** The last attack's bounds check, and the instructions fetched behind it until the flush. */
  check: Uop;
  window: Uop[];
  cycles: number;
}

/** The Spectre program on the model. */
export function attack(secret: number[], guard: Guard = 'none', train = true): Attack {
  return once(`atk:${secret.join(',')}:${guard}:${train}`, () => {
    const m = runModel(spectreWords(secret, guard === 'fill' ? 'none' : guard, train), sideConfig(guard));
    const d = dmemOf(m), checks = m.history.filter((u) => u.text.startsWith('bgeu') && u.state === 'committed');
    // the last call made with x past the array (x = 16 + k): its check is the last committed bgeu taken
    const check = [...checks].reverse().find((u) => u.next !== ((u.pc + 4) >>> 0)) ?? checks[checks.length - 1];
    const flushAt = check.c;
    const window = m.history.filter((u) => u.seq >= check.seq - 1 && u.f <= flushAt && (u.seq <= check.seq || u.wrong || u.f > check.f)).slice(0, 14);
    return { secret, guard, recovered: secret.map((_, k) => byteAt(d, MAP.out + k)), times: timesIn(d), check, window, cycles: m.stats.cycles };
  });
}

/** Evict + reload with no speculation: the victim touches line s, the attacker times all 16. */
export const probeTimes = (sec: number) => once(`probe:${sec}`, () => timesIn(dmemOf(runModel(assemble(probeSource(sec)).words, { spec: SIDE_SPEC }))));

/** Cycles per in-bounds call of the victim, warm cache (the difference of two loop lengths, so the set-up cancels). */
export const cyclesPerCall = (g: Guard) => once(`call:${g}`, () => {
  const c = (n: number) => runModel(assemble(callsSource(g === 'fill' ? 'none' : g, n)).words, sideConfig(g)).stats.cycles;
  return (c(48) - c(16)) / 32;
});

/** Cycles of a program in spec mode, with fill-at-commit or without. */
export const specCycles = (source: string, fill: boolean) => once(`cyc:${fill}:${source.length}:${source.slice(0, 40)}`, () =>
  new OooModel(assemble(source).words, { spec: { ...SIDE_SPEC, fillAtCommit: fill } }, { dmemWords: 1 << 12, imemWords: 1 << 12 }).run().cycles);

/** The ooo chapter's benchmarks (RV32I and M; not the float one) and the streaming loop: cycles without and with fill-at-commit. */
export const fillCosts = () => once('fillcosts', () => [
  ...BENCHMARKS.filter((b) => !b.needs?.f).map((b) => ({ id: b.id, name: b.name, base: specCycles(b.source, false), fill: specCycles(b.source, true) })),
  { id: 'stream', name: 'Sum a 4 KB array', base: specCycles(STREAM_SOURCE, false), fill: specCycles(STREAM_SOURCE, true) },
]);

// ---- drawing helpers ----------------------------------------------------------------------------------------------------

const hex = (v: number) => v.toString(16).toUpperCase();
const btn = (label: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, type: 'button' }, label); b.addEventListener('click', f); return b; };

function seg<T extends string | number>(opts: [T, string][], get: () => T, set: (v: T) => void, label: string) {
  const g = h('span', { class: 'seg', role: 'group', 'aria-label': label });
  const bs = opts.map(([v, l]) => { const b = btn(l, () => set(v), ''); g.append(b); return [v, b] as const; });
  return { el: g, sync: () => bs.forEach(([v, b]) => { b.classList.toggle('on', v === get()); b.setAttribute('aria-pressed', String(v === get())); }) };
}

/** Bars, one per value, labelled underneath; `mark` picks the ones drawn as the fast (green) kind. */
function bars(values: number[], labels: string[], mark: (v: number, i: number) => boolean, aria: string, top = Math.max(...values, 1)): SVGSVGElement {
  const W = 640, H = 150, n = values.length, w = W / n, base = 118;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sc-bars', role: 'img', 'aria-label': aria });
  values.forEach((v, i) => {
    const hgt = Math.max(2, (v / top) * 96), x = i * w;
    svg.append(
      s('rect', { x: x + w * 0.15, y: base - hgt, width: w * 0.7, height: hgt, rx: 2, class: mark(v, i) ? 'fast' : 'slow' }),
      s('text', { x: x + w / 2, y: base - hgt - 4, 'text-anchor': 'middle', class: 'v' }, String(v)),
      s('text', { x: x + w / 2, y: base + 16, 'text-anchor': 'middle', class: 'l' }, labels[i]),
    );
  });
  return svg;
}

const chip = (big: string, small: string) => h('div', { class: 'sc-chip' }, h('b', null, big), h('span', null, small));

// ---- step 1: time tells ------------------------------------------------------------------------------------------------

export function pwWidget(): Widget {
  let known = '', constant = false;
  const out = h('div', null), status = h('p', { class: 'sub', 'aria-live': 'polite' });
  const code = h('pre', { class: 'sc-code' });
  const paint = () => {
    sync();
    code.textContent = pwCheckText(constant);
    const letters = [...PW_LETTERS], runs = letters.map((c) => pwRun(known + c, constant));
    const keys = h('div', { class: 'sc-keys' }, ...letters.map((c, i) => btn(c, () => {
      const r = runs[i];
      if (r.ok) { status.textContent = `${known + c}: yes, in ${r.cycles} cycles.`; return; }
      const slow = runs[i].cycles > Math.min(...runs.map((q) => q.cycles));
      status.textContent = `${(known + c).padEnd(4, '·')}: no, in ${r.cycles} cycles.${slow && !constant ? ` Longer than the others: the next letter is ${c}.` : ''}`;
      if (slow && !constant && known.length < 3) { known += c; paint(); }
    }, 'btn sm key')));
    out.replaceChildren(
      h('div', { class: 'sc-row' }, chip(known.padEnd(4, '·'), 'known so far'), chip(String(letters.length), 'letters to try for the next one')),
      keys,
      bars(runs.map((r) => r.cycles), letters, (v) => v > Math.min(...runs.map((q) => q.cycles)), `Cycles the check takes for each next letter`),
    );
  };
  const g = seg<number>([[0, 'Stops at the first difference'], [1, 'Constant time']], () => (constant ? 1 : 0), (v) => { constant = !!v; known = ''; status.textContent = ''; paint(); }, 'Which check');
  const sync = () => g.sync();
  const el = h('div', { class: 'widget sc-widget' },
    h('div', { class: 'rb-ctl' }, g.el, btn('Start again', () => { known = ''; status.textContent = ''; paint(); })),
    h('p', { class: 'sub' }, `A 4-letter password from a to p, checked on the golden model: one instruction a cycle, the single-cycle CPU of the cpu chapter. The bars are each guess's cycles in the check.`),
    out, status, h('details', { class: 'deeper' }, h('summary', null, 'The check'), code));
  paint();
  return { el };
}
export const PW_SECRET = PASSWORD;

// ---- step 2: the cache remembers ---------------------------------------------------------------------------------------

export function probeWidget(): Widget {
  let sec = 9;
  const out = h('div', null);
  const paint = () => {
    const t = probeTimes(sec), fast = t.indexOf(Math.min(...t));
    out.replaceChildren(
      h('div', { class: 'sc-row' }, chip(hex(sec), 'the victim\'s secret: the line it touched'), chip(hex(fast), 'the line the attacker found fastest'), chip(`${Math.min(...t)} · ${Math.max(...t)}`, 'cycles: a hit · a miss, as the program measured them')),
      bars(t, t.map((_, i) => hex(i)), (v) => v < HIT_BELOW, 'Reload time of each probe line, in cycles'),
    );
  };
  const el = h('div', { class: 'widget sc-widget' },
    h('div', { class: 'rb-ctl' }, btn('Another secret', () => { sec = (sec * 7 + 5) & 15; paint(); })),
    h('p', { class: 'sub' }, 'Evict the 16 probe lines, let the victim load one, reload each and time it with csrr cycle. The program stores its 16 times; the bars are those.'),
    out);
  paint();
  return { el };
}

// ---- steps 4–10: the attack on the model ----------------------------------------------------------------------------------

export interface SpectreOpts {
  /** Which defences the learner may pick (the first is where it starts). */
  guards?: Guard[];
  /** Show the timeline, the probe chart, or both. */
  show?: 'timeline' | 'chart' | 'both';
  /** The training calls can be switched off (step 7). */
  trainSwitch?: boolean;
  /** Secret nibbles (several: step 6). */
  secret?: number[];
}

export function spectreWidget(opts: SpectreOpts = {}): Widget {
  const guards = opts.guards ?? ['none'];
  let guard: Guard = guards[0], train = true, secret = opts.secret ?? [0xa];
  const show = opts.show ?? 'both';
  const out = h('div', null);
  const paint = () => {
    for (const g of segs) g.sync();
    const a = attack(secret, guard, train);
    const got = a.recovered.map((v) => (v === NOTHING ? '·' : hex(v))).join('');
    const lw = a.window.find((u) => u.wrong && u.cls === 'load' && u.addr !== undefined && u.addr >= MAP.probe && u.addr < MAP.probe + 256);
    const parts: (HTMLElement | SVGSVGElement)[] = [h('div', { class: 'sc-row' },
      chip(secret.map(hex).join(''), secret.length > 1 ? 'the secret, past the array' : 'the secret nibble, past the array'),
      chip(got, 'what the attacker program printed'),
      chip(`${a.check.f} → ${a.check.c}`, 'the bounds check: fetched → committed (then the flush)'),
      ...(lw ? [chip(hex((lw.addr! - MAP.probe) >> 4), guard === 'fill' ? `the probe line the wrong path loaded (cycle ${lw.s}): not filled, it never committed` : `the probe line the wrong path loaded (cycle ${lw.s}), kept after the flush`)] : []))];
    if (show !== 'chart') {
      const c0 = Math.min(...a.window.map((u) => u.f)), c1 = Math.max(a.check.c + 1, ...a.window.map((u) => Math.min(u.c >= 0 ? u.c : u.x, a.check.c + 1)));
      parts.push(h('div', { class: 'cpu-sec' }, `The last attack: cycles ${c0} to ${c1}. Struck-out rows ran on the wrong path and were flushed.`), timeline(a.window, c0, c1), legend());
    }
    if (show !== 'timeline') parts.push(h('div', { class: 'cpu-sec' }, 'The attacker\'s reload times for the last nibble (cycles, measured by the program)'),
      bars(a.times, a.times.map((_, i) => hex(i)), (v) => v < HIT_BELOW, 'Reload time of each probe line after the attack'));
    out.replaceChildren(...parts);
  };
  const segs = [
    ...(guards.length > 1 ? [seg<Guard>(guards.map((g) => [g, GUARD_NAME[g]] as [Guard, string]), () => guard, (v) => { guard = v; paint(); }, 'Defence')] : []),
    ...(opts.trainSwitch ? [seg<number>([[1, 'Train first (two in-bounds calls)'], [0, 'No training']], () => (train ? 1 : 0), (v) => { train = !!v; paint(); }, 'Training')] : []),
  ];
  const el = h('div', { class: 'widget sc-widget ooo-widget' },
    h('div', { class: 'rb-ctl' }, ...segs.map((g) => g.el), btn(secret.length > 1 ? 'Another secret' : 'Another nibble', () => {
      secret = secret.map((v, i) => (v * 7 + 3 + i) & 15);
      paint();
    })),
    out);
  paint();
  return { el };
}

// ---- step 11: the defences side by side ------------------------------------------------------------------------------------

export const GUARDS: Guard[] = ['none', 'fence', 'mask', 'fill'];

export function defenceTable(): Widget {
  const secret = [0xc, 0x0, 0xf, 0xe];
  const costs = fillCosts();
  const rows = GUARDS.map((g) => {
    const a = attack(secret, g), leaks = a.recovered.some((v) => v !== NOTHING);
    return h('tr', null, h('td', null, GUARD_NAME[g]), h('td', { class: leaks ? 'bad' : 'good' }, leaks ? 'yes' : 'no'),
      h('td', null, String(cyclesPerCall(g))),
      h('td', null, g === 'fill' ? fmtRatio(costs.filter((c) => c.id !== 'stream')) : '1.00×'),
      h('td', null, g === 'fill' ? fmtRatio(costs.filter((c) => c.id === 'stream')) : '1.00×'));
  });
  const el = h('div', { class: 'widget sc-widget' },
    h('div', { class: 'scroll' }, h('table', { class: 'data num sc-table' },
      h('tr', null, ...['Defence', 'Leaks', 'Cycles per call', 'The ooo benchmarks', 'Sum a 4 KB array'].map((t) => h('th', null, t))), ...rows)),
    h('p', { class: 'sub' }, `"Leaks": whether the attacker program printed any of the secret `, h('code', null, secret.map(hex).join('')), `. Cycles per call: the victim called in bounds, cache warm. The last two columns: cycles against no defence, the benchmarks as their geometric mean.`));
  return { el };
}

function fmtRatio(cs: { base: number; fill: number }[]): string {
  const g = Math.exp(cs.reduce((a, c) => a + Math.log(c.fill / c.base), 0) / cs.length);
  return `${g.toFixed(g < 1.01 && g > 1 ? 3 : 2)}×`;
}
