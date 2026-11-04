// Chapter 47's explainers (When bits go wrong): flip bits and watch parity respond, CRC-32 of a message you edit and the long
// division behind a CRC-8, how often each check lets a corrupted word through, the CRC register panel on the gate-level scene,
// a frame with its flags and stuffed zeros, a repeat-request timeline against its closed form, and forward error correction
// against retransmission. Every number comes from comm/crc.ts, framing.ts, arq.ts, fec.ts.

import '../styles/errors.css';
import { fullWindow, PROTO_NAMES, rttOf, simulate, utilization, type Proto } from '../comm/arq';
import { bitsLsb, CRC8, CRC16, CRC32_INIT, CRC32_RESIDUE, crc32, divisionSteps, fcsBytes, parityUndetected, parityWeights, stepBits, undetected, weightDistribution, wordBits } from '../comm/crc';
import { codeOf, crcOnly, crossover, crossoverTime, deliveryTime, secdedCrc } from '../comm/fec';
import { cobsEncode, FLAG, frame, receive, stuffedMask } from '../comm/framing';
import { parity } from '../lib';
import { rng } from '../phys/line';
import { logicDepth, stats } from '../sim/stats';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { crcUnit } from '../lib';
import { CRC32_REFLECTED } from '../comm/crc';
import { fitText, slider } from './mosparts';

const hex = (v: number, w = 8) => (v >>> 0).toString(16).padStart(w, '0').toUpperCase();
const sci = (x: number): string => (x === 0 ? '0' : x >= 0.01 && x < 1000 ? x.toPrecision(3).replace(/\.?0+$/, '') : x.toExponential(1).replace('e-', ' x 10^-').replace('e+', ' x 10^'));
const oneIn = (x: number): string => (x > 0 ? `1 in ${Math.round(1 / x).toLocaleString('en-US')}` : 'never');
const pct = (x: number): string => `${(100 * x).toFixed(x < 0.1 ? 2 : 1)} %`;
const si = (v: number, unit: string): string => (v >= 1 ? `${+v.toPrecision(3)} ${unit}` : v >= 1e-3 ? `${+(v * 1e3).toPrecision(3)} m${unit}` : v >= 1e-6 ? `${+(v * 1e6).toPrecision(3)} µ${unit}` : `${+(v * 1e9).toPrecision(3)} n${unit}`);

const btn = (label: string, title: string, f: () => void, cls = 'btn sm'): HTMLButtonElement => {
  const b = h('button', { class: cls, title, type: 'button' }, label);
  b.addEventListener('click', f);
  return b;
};

/** A button that is a bit: pressed = 1, with an accessible name that says which bit. */
function bitButton(label: string, on: boolean, cls: string, f: () => void, text?: string): HTMLButtonElement {
  const b = h('button', { class: `err-bit ${cls}${on ? ' on' : ''}`, type: 'button', 'aria-pressed': on, 'aria-label': label, title: label }, text ?? (on ? '1' : '0'));
  b.addEventListener('click', f);
  return b;
}

// ---- a log-log plot --------------------------------------------------------------------------------------------------------

interface LogPlot { svg: SVGSVGElement; X(v: number): number; Y(v: number): number; layer: SVGGElement }

/** Decade axes: x from 10^x0 to 10^x1, y from 10^y0 to 10^y1 (ylog false: y linear from y0 to y1). */
function logPlot(W: number, H: number, x0: number, x1: number, y0: number, y1: number, xl: string, yl: string, label: string, ylog = true, ystep = 1): LogPlot {
  const m = { l: 52, r: 14, t: 12, b: 36 };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot err-plot', role: 'img', 'aria-label': label }) as SVGSVGElement;
  const X = (v: number) => m.l + ((Math.log10(v) - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - (((ylog ? Math.log10(Math.max(v, 10 ** (y0 - 1))) : v) - y0) / (y1 - y0)) * (H - m.t - m.b);
  for (let e = Math.ceil(x0); e <= x1; e++) svg.append(s('line', { x1: X(10 ** e), x2: X(10 ** e), y1: m.t, y2: H - m.b, class: 'grid' }), s('text', { x: X(10 ** e), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, `1e${e}`));
  if (ylog) for (let e = y0; e <= y1; e += ystep) svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(10 ** e), y2: Y(10 ** e), class: 'grid' }), s('text', { x: m.l - 6, y: Y(10 ** e) + 3.5, 'text-anchor': 'end', class: 'tick' }, `1e${e}`));
  else for (let v = y0; v <= y1 + 1e-9; v += ystep) svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, v.toFixed(1)));
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ax' }), s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'ax' }),
    s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, xl),
    s('text', { x: 6, y: m.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${m.t})`, class: 'axl' }, yl));
  fitText(svg, W);
  const layer = svg.appendChild(s('g'));
  return { svg, X, Y, layer };
}

const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
const logSpace = (a: number, b: number, n: number): number[] => Array.from({ length: n }, (_, i) => 10 ** (a + ((b - a) * i) / (n - 1)));

// ---- 1. parity -----------------------------------------------------------------------------------------------------------

export function parityWidget(): Widget {
  let data = 0b10110010, lp = -3;
  const flips = new Array<boolean>(9).fill(false);
  const bitsOf = () => Array.from({ length: 8 }, (_, i) => (data >> (7 - i)) & 1);
  const rows = h('div', { class: 'err-rows' });
  const verdict = h('p', { class: 'err-verdict', role: 'status' });
  const chips = h('div', { class: 'mos-chips' });
  const P = parity(8);
  const paint = () => {
    const d = bitsOf(), pbit = d.reduce((a, b) => a ^ b, 0), sent = [...d, pbit], got = sent.map((b, i) => b ^ (flips[i] ? 1 : 0));
    const n = flips.filter(Boolean).length, alarm = got.reduce((a, b) => a ^ b, 0) === 1;
    const row = (label: string, cells: HTMLElement[]) => h('div', { class: 'err-row' }, h('span', { class: 'err-lab' }, label), h('div', { class: 'err-cells' }, ...cells));
    rows.replaceChildren(
      row('sent', [...d.map((b, i) => bitButton(`Data bit ${7 - i}, now ${b}: press to change`, !!b, 'data', () => { data ^= 1 << (7 - i); paint(); })), h('span', { class: 'err-bit par', title: 'Parity bit: makes the number of 1s even', 'aria-label': `Parity bit ${pbit}` }, String(pbit))]),
      row('flipped', sent.map((_, i) => bitButton(i < 8 ? `Flip data bit ${7 - i} in transit: ${flips[i] ? 'flipped' : 'intact'}` : `Flip the parity bit in transit: ${flips[i] ? 'flipped' : 'intact'}`, flips[i], 'flip', () => { flips[i] = !flips[i]; paint(); }, flips[i] ? 'x' : '·'))),
      row('received', got.map((b, i) => h('span', { class: `err-bit rx${flips[i] ? ' hit' : ''}${i === 8 ? ' par' : ''}`, 'aria-label': `Received ${b}${flips[i] ? ' (flipped)' : ''}` }, String(b)))));
    verdict.className = `err-verdict ${n === 0 ? 'ok' : alarm ? 'ok' : 'bad'}`;
    verdict.textContent = n === 0 ? 'Nothing flipped: the receiver\'s XOR of all nine bits is 0 and it accepts the word.'
      : alarm ? `${n} bit${n > 1 ? 's' : ''} flipped, an odd number: the XOR of the nine bits is 1, the alarm rings. It cannot say which bit, so the word is rejected.`
        : `${n} bits flipped, an even number: the XOR is back to 0 and the receiver accepts a wrong word. Parity cannot see this.`;
    const p = 10 ** lp, any = 1 - (1 - p) ** 9, miss = parityUndetected(9, p);
    const cell = (b: string, t: string) => h('div', null, h('b', null, b), h('span', null, t));
    chips.replaceChildren(cell(sci(any), 'P(some bit of 9 flips)'), cell(sci(miss), 'P(wrong word accepted)'), cell(`${Math.round((100 * miss) / any)} %`, 'of corrupted words slip through'),
      cell(`${stats(P).nands} NANDs`, `8-bit parity: ${logicDepth(P)} levels`));
  };
  const sl = slider('Bit error rate', -6, -1, 0.1, lp, (v) => `1e${v.toFixed(1)}`, (v) => { lp = v; paint(); });
  const el = h('div', { class: 'widget mos err-w' },
    h('div', { class: 'panel' }, h('h3', null, 'One parity bit on eight data bits'), rows, verdict),
    h('div', { class: 'panel mos-ctl' }, sl.el, chips, h('p', { class: 'sub mos-note' }, 'Even parity over 9 bits. At a bit error rate p each of the nine bits flips independently; the word is accepted wrongly when an even, non-zero number of them flip: (1 + (1 − 2p)^9)/2 − (1 − p)^9 ≈ 36 p². The share that slips through is about 4 p: small when errors are rare, nearly one half when they are not.')));
  paint();
  return { el };
}

// ---- 3. CRC-32 of a message you edit, and the division behind it ------------------------------------------------------------

export function crcExplorerWidget(): Widget {
  let text = 'HELLO', flipped = new Set<number>(), burst = 8, start = 5, divHex = 'BEEF';
  const bytesOf = () => Array.from(new TextEncoder().encode(text)).slice(0, 8);
  const grid = h('div', { class: 'err-grid', role: 'group', 'aria-label': 'Message bits in transmission order, press to flip' });
  const out = h('div', { class: 'err-crc' });
  const verdict = h('p', { class: 'err-verdict', role: 'status' });
  const div = h('pre', { class: 'err-div', tabindex: 0, 'aria-label': 'Long division of the data by the CRC-8 generator' });
  const input = h('input', { type: 'text', class: 'err-in', value: text, maxlength: 8, 'aria-label': 'Message (up to 8 characters)' }) as HTMLInputElement;
  const dIn = h('input', { type: 'text', class: 'err-in', value: divHex, maxlength: 4, 'aria-label': 'Sixteen data bits in hex' }) as HTMLInputElement;
  const paint = () => {
    const b = bytesOf(), bits = bitsLsb(b), got = bits.map((v, i) => v ^ (flipped.has(i) ? 1 : 0));
    const rx = b.map((_, k) => got.slice(8 * k, 8 * k + 8).reduce((a, v, i) => a | (v << i), 0));
    grid.replaceChildren(...b.map((_c, k) => h('div', { class: 'err-byte' }, h('span', { class: 'err-ch' }, text[k] ?? ''),
      h('div', null, ...bits.slice(8 * k, 8 * k + 8).map((_v, i) => { const idx = 8 * k + i, on = flipped.has(idx); return bitButton(`Message bit ${idx}, byte ${k}, bit ${i}, now ${got[idx]}: press to flip`, !!got[idx], on ? 'hit' : '', () => { if (flipped.has(idx)) flipped.delete(idx); else flipped.add(idx); paint(); }); })),
      )));
    const sent = crc32(b), recv = crc32(rx);
    let d = 0;
    for (let i = 0; i < 32; i++) if (((sent ^ recv) >>> i) & 1) d++;
    out.replaceChildren(h('div', null, h('span', null, 'CRC-32 sent'), h('b', null, `0x${hex(sent)}`)), h('div', null, h('span', null, 'CRC-32 of what arrived'), h('b', null, `0x${hex(recv)}`)),
      h('div', null, h('span', null, 'CRC bits that differ'), h('b', null, `${d} of 32`)), h('div', null, h('span', null, 'bits flipped'), h('b', null, String(flipped.size))));
    const f = flipped.size;
    verdict.className = `err-verdict ${f === 0 || sent !== recv ? 'ok' : 'bad'}`;
    const idx = [...flipped].sort((x, y) => x - y), span = f ? idx[idx.length - 1] - idx[0] + 1 : 0;
    verdict.textContent = f === 0 ? 'Nothing flipped. Flip one bit and about half of the 32 CRC bits change.'
      : sent === recv ? 'The CRC did not change: this error pattern is a multiple of the generator. The receiver accepts a wrong message.'
        : span <= 32 ? `Caught. The flipped bits lie within a burst of ${span}, and every burst of 32 bits or fewer is guaranteed to change the CRC.` : `Caught (the flipped bits span ${span}, beyond the burst guarantee: this is the 1 − 2^−32 case).`;
    // the long division
    const v = parseInt(divHex.replace(/[^0-9a-f]/gi, '') || '0', 16) & 0xffff, data = wordBits(v, 16), r = divisionSteps(data, CRC8.poly, CRC8.width);
    const pad = (k: number) => ' '.repeat(k);
    div.textContent = [`dividend  ${r.dividend}   data ${data.join('')} then 8 zeros`, `divisor   ${r.divisor}   x^8 + x^2 + x + 1`, '',
      ...r.steps.flatMap((st) => [`${st.before}`, `${pad(st.at)}${r.divisor}`, `${'-'.repeat(r.dividend.length)}`]), `${r.steps.length ? r.steps[r.steps.length - 1].after : r.dividend}`, '', `remainder ${r.remainder.toString(2).padStart(8, '0')} = 0x${hex(r.remainder, 2)}: the last 8 bits, sent after the data`].join('\n');
  };
  input.addEventListener('input', () => { text = input.value; flipped = new Set(); start = Math.min(start, Math.max(0, 8 * bytesOf().length - 1)); paint(); });
  dIn.addEventListener('input', () => { divHex = dIn.value; paint(); });
  const lenSl = slider('Burst length', 1, 40, 1, burst, (v) => `${v} bits`, (v) => { burst = v; });
  const posSl = slider('Burst at bit', 0, 63, 1, start, (v) => String(v), (v) => { start = v; });
  const el = h('div', { class: 'widget mos err-w' },
    h('div', { class: 'panel' }, h('h3', null, 'CRC-32 of a message'), h('label', { class: 'err-lab-in' }, 'Message ', input), grid, out, verdict,
      h('div', { class: 'mos-row' }, lenSl.el, posSl.el),
      h('div', { class: 'dram-ops' },
        btn('Flip the burst', 'Flip every bit from the chosen position, burst length bits long', () => { const n = 8 * bytesOf().length; for (let i = start; i < Math.min(n, start + burst); i++) { if (flipped.has(i)) flipped.delete(i); else flipped.add(i); } paint(); }),
        btn('Three random bits', 'Flip three bits chosen by a seeded generator', () => { const n = 8 * bytesOf().length, r = rng(flipped.size + 7 + n); for (let k = 0; k < 3; k++) { const i = Math.floor(r() * n); if (flipped.has(i)) flipped.delete(i); else flipped.add(i); } paint(); }),
        btn('Clear', 'Put every bit back', () => { flipped = new Set(); paint(); })),
      h('p', { class: 'sub mos-note' }, 'Bits are shown in transmission order: each byte least significant bit first, as the reflected CRC register takes them. The CRC starts from all ones and is complemented at the end, so it matches zlib.crc32 and Ethernet.')),
    h('div', { class: 'panel' }, h('h3', null, 'The same arithmetic by hand: a CRC-8 as long division'), h('label', { class: 'err-lab-in' }, 'Data (16 bits, hex) ', dIn), div,
      h('p', { class: 'sub mos-note' }, 'Division over GF(2): subtract is XOR, no borrows. Wherever the running dividend has a 1 over a data bit, XOR the divisor under it. What is left in the last eight places is the remainder, and appending it makes the whole word divisible by the generator.')));
  paint();
  return { el };
}

// ---- 4. how often a check lets a corrupted word through -------------------------------------------------------------------

const weights = new Map<string, number[]>();
const weightsOf = (name: string): number[] => {
  let w = weights.get(name);
  if (!w) weights.set(name, (w = name === 'parity' ? parityWeights(16) : weightDistribution(16, name === 'crc8' ? CRC8 : CRC16)));
  return w;
};

export function undetectedWidget(): Widget {
  let lp = -3;
  const codes: { id: string; name: string; n: number; cls: string }[] = [{ id: 'parity', name: 'parity bit', n: 17, cls: 'c1' }, { id: 'crc8', name: 'CRC-8', n: 24, cls: 'c2' }, { id: 'crc16', name: 'CRC-16', n: 32, cls: 'c3' }];
  const pl = logPlot(560, 280, -6, -0.3, -20, 0, 'bit error rate p', 'corrupted words accepted', 'Share of corrupted 16-bit words that a check accepts, against bit error rate', true, 4);
  const marker = pl.svg.appendChild(s('line', { class: 'bound', y1: 12, y2: 244 }));
  const pts = logSpace(-6, -0.3, 60);
  codes.forEach((c) => {
    const A = weightsOf(c.id);
    pl.svg.append(s('path', { class: `err-s ${c.cls}`, d: pathOf(pts.map((p): [number, number] => [pl.X(p), pl.Y(undetected(A, p) / (1 - (1 - p) ** c.n))])) }));
  });
  [8, 16].forEach((r) => pl.svg.append(s('line', { class: 'ln-h', x1: pl.X(1e-6), x2: pl.X(0.5), y1: pl.Y(2 ** -r), y2: pl.Y(2 ** -r) }), s('text', { class: 'ln-hl', x: pl.X(1e-6) + 4, y: pl.Y(2 ** -r) - 3 }, `2^-${r}`)));
  const table = h('div', { class: 'err-tab' });
  const paint = () => {
    const p = 10 ** lp;
    marker.setAttribute('x1', String(pl.X(p))); marker.setAttribute('x2', String(pl.X(p)));
    table.replaceChildren(h('div', { class: 'err-trow head' }, h('span', null, 'check'), h('span', null, 'bits'), h('span', null, 'P(accepted wrong)'), h('span', null, 'of corrupted words')),
      ...codes.map((c) => { const A = weightsOf(c.id), u = undetected(A, p), bad = 1 - (1 - p) ** c.n; return h('div', { class: `err-trow ${c.cls}` }, h('span', null, c.name), h('span', null, `16 + ${c.n - 16}`), h('span', null, sci(u)), h('span', null, oneIn(u / bad))); }));
  };
  const sl = slider('Bit error rate', -6, -0.3, 0.1, lp, (v) => `1e${v.toFixed(1)}`, (v) => { lp = v; paint(); });
  const key = h('div', { class: 'clk-legend err-key' }, h('span', { class: 'c1' }, 'parity bit'), h('span', { class: 'c2' }, 'CRC-8'), h('span', { class: 'c3' }, 'CRC-16'));
  const el = h('div', { class: 'widget mos err-w' }, h('div', { class: 'panel' }, h('h3', null, 'What a check lets through'), key, pl.svg),
    h('div', { class: 'panel mos-ctl' }, sl.el, table, h('p', { class: 'sub mos-note' }, 'Exact: 16 data bits, every one of the 65 536 code words enumerated for its weight distribution, so an error pattern is accepted exactly when it is itself a code word (comm/crc.ts). The vertical axis is the share of corrupted words accepted. A CRC with r check bits approaches 2^−r when the channel is pure noise (right edge), and does far better at low error rates, because the few-bit errors that occur there are all caught.')));
  paint();
  return { el };
}

// ---- 5 + 6. the CRC register panel ----------------------------------------------------------------------------------------

export interface CrcApi { send(text: string): void; init(): void }
export const crcApi = new WeakMap<Stage, CrcApi>();

/** The panel on a CRC generator scene: feed a message one item (a bit, or a byte) per clock edge, against the golden model. */
export function crcPanel(w: 1 | 8): ScenePanel {
  return (stage: Stage): Widget => {
    let text = '123456789', fed = 0, model = 0;
    const unit = w === 1 ? 'bit' : 'byte';
    const items = (withFcs: boolean): number[] => {
      const b = Array.from(new TextEncoder().encode(text));
      const all = withFcs ? [...b, ...fcsBytes(crc32(b))] : b;
      return w === 1 ? bitsLsb(all) : all;
    };
    const total = () => items(false).length;
    const edgeModel = (d: number, en: number, init: number) => { if (init) model = CRC32_INIT; else if (en) model = stepBits(model, d, w); };
    const hook = { before: () => { const sim = stage.sim; if (sim) edgeModel(Number(stage.value('d')), Number(stage.value('en')), Number(stage.value('init'))); } };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({ save: () => ({ fed, model, text }), restore: (v) => { ({ fed, model, text } = v as { fed: number; model: number; text: string }); inp.value = text; update(); } });
    stage.resetHooks.add(() => { fed = 0; model = 0; update(); });
    const edge = (d: number, en: number, init: number) => {
      const sim = stage.sim!;
      sim.setInput('d', d); sim.setInput('en', en); sim.setInput('init', init); sim.settle();
      edgeModel(d, en, init);
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      sim.setInput('en', 0); sim.setInput('init', 0); sim.settle();
    };
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const feed = (n: number, withFcs: boolean) => { const it = items(withFcs); for (let k = 0; k < n && fed < it.length; k++) edge(it[fed++], 1, 0); };
    const doInit = () => { edge(0, 0, 1); fed = 0; };
    const inp = h('input', { type: 'text', class: 'err-in', value: text, maxlength: 24, 'aria-label': 'Message' }) as HTMLInputElement;
    inp.addEventListener('input', () => { text = inp.value; fed = 0; update(); });
    const status = h('div', { class: 'mc-status err-status' });
    const note = h('p', { class: 'sub' });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel err-panel', 'data-dock': 'right' },
      h('h4', null, `CRC-32, ${w === 1 ? 'one bit' : 'one byte'} a clock`, h('span', { class: 'fold-hint' })),
      h('label', { class: 'err-lab-in' }, 'Message ', inp),
      h('div', { class: 'dram-ops' },
        btn('Init', 'Load the register with all ones (init = 1 at an edge)', () => act(doInit)),
        btn(`Send 1 ${unit}`, `One clock edge with en = 1 and the next ${unit} on d`, () => act(() => feed(1, true))),
        btn('Send message', 'Clock in the rest of the message', () => act(() => feed(total() - Math.min(fed, total()), false))),
        btn('Send message + FCS', 'Clock in the message and then its own FCS: the register ends at the constant', () => act(() => feed(items(true).length - fed, true)))),
      status, note);
    const update = () => {
      const q = stage.sim ? Number(stage.value('q')) : 0, fc = stage.sim ? Number(stage.value('fcs')) : 0, b = Array.from(new TextEncoder().encode(text)), it = items(true), msgN = total();
      const ok = q === model;
      status.replaceChildren(h('span', null, `${unit}s clocked `, h('b', null, `${Math.min(fed, it.length)} / ${msgN}${fed > msgN ? ' + FCS' : ''}`)), h('span', null, 'q ', h('b', null, `0x${hex(q)}`)),
        h('span', null, 'model ', h('b', { class: ok ? 'good' : 'bad' }, `0x${hex(model)}${ok ? ' ✓' : ' ✗'}`)), h('span', null, 'fcs = ~q ', h('b', null, `0x${hex(fc)}`)), h('span', null, 'zlib.crc32 ', h('b', null, `0x${hex(crc32(b))}`)));
      note.textContent = fed >= it.length && q === CRC32_RESIDUE ? `The message and its own FCS went in: q = 0x${hex(CRC32_RESIDUE)}, the constant every good frame leaves.`
        : fed >= msgN && fc === crc32(b) ? 'The whole message is in: fcs equals the CRC-32 of the message, the four bytes (low byte first) that follow it on the wire.'
          : `Init loads all ones, then each edge with en = 1 takes ${w === 1 ? 'one bit, least significant bit of each byte first' : 'a byte'}. The CRC-32 of "123456789" is 0xCBF43926.`;
    };
    update();
    crcApi.set(stage, { send: (t) => act(() => { text = t; inp.value = t; doInit(); feed(total(), false); }), init: () => act(doInit) });
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); crcApi.delete(stage); } };
  };
}

/** The CRC generator on a bench: a pulse to the clock, d / en / init by hand or from the panel. */
export function crcScene(w: 1 | 8): Scene {
  return { root: crcUnit(32, CRC32_REFLECTED, w), inputs: { d: 0, en: 0, init: 0, clk: 0 }, clock: 'clk', autoClock: false, panels: [crcPanel(w)] };
}

// ---- 7. framing ---------------------------------------------------------------------------------------------------------------

export function framingWidget(): Widget {
  let text = 'Hi~', flips = new Set<number>(), allOnes = false;
  const strip = h('div', { class: 'err-strip', role: 'group', 'aria-label': 'The frame on the wire, press a bit to flip it' });
  const stats_ = h('div', { class: 'mos-chips' });
  const verdict = h('p', { class: 'err-verdict', role: 'status' });
  const cobs = h('p', { class: 'sub mos-note' });
  const input = h('input', { type: 'text', class: 'err-in', value: text, maxlength: 12, 'aria-label': 'Payload text' }) as HTMLInputElement;
  const payload = () => (allOnes ? Array(6).fill(0xff) : Array.from(new TextEncoder().encode(text)).slice(0, 12));
  const paint = () => {
    const p = payload(), body = [...p, ...fcsBytes(crc32(p))], raw = bitsLsb(body), m = stuffedMask(raw), wire = frame(p);
    const cells: HTMLElement[] = [];
    const bitAt = (i: number, cls: string, v: number) => { const on = flips.has(i); return bitButton(`Wire bit ${i}, now ${v ^ (on ? 1 : 0)}: press to flip`, !!(v ^ (on ? 1 : 0)), `${cls}${on ? ' hit' : ''}`, () => { if (flips.has(i)) flips.delete(i); else flips.add(i); paint(); }); };
    let pos = 0;
    FLAG.forEach((v) => cells.push(bitAt(pos++, 'flag', v)));
    let k = 0;
    m.bits.forEach((v, i) => { if (!m.stuffed[i] && k % 8 === 0 && k > 0) cells.push(h('span', { class: 'err-gap' })); if (!m.stuffed[i]) k++; cells.push(bitAt(pos++, m.stuffed[i] ? 'stuffed' : k > 8 * p.length ? 'fcs' : 'data', v)); });
    FLAG.forEach((v) => cells.push(bitAt(pos++, 'flag', v)));
    strip.replaceChildren(...cells);
    const got = wire.map((v, i) => v ^ (flips.has(i) ? 1 : 0)), res = receive(got);
    const stuffedN = m.stuffed.filter(Boolean).length;
    const cell = (b: string, t: string) => h('div', null, h('b', null, b), h('span', null, t));
    stats_.replaceChildren(cell(String(8 * p.length), 'payload bits'), cell(String(stuffedN), 'stuffed zeros'), cell(String(wire.length), 'bits on the wire'), cell(pct((8 * p.length) / wire.length), 'efficiency'));
    const dec = (b: number[]) => new TextDecoder().decode(Uint8Array.from(b));
    verdict.className = `err-verdict ${!flips.size ? 'ok' : res.length === 1 && res[0].ok && dec(res[0].payload) === dec(p) ? 'ok' : res.length === 1 && !res[0].ok ? 'ok' : 'bad'}`;
    verdict.textContent = res.length === 0 ? 'No complete frame found: a flag was destroyed, the receiver is still looking for one.'
      : res.length === 1 ? (res[0].ok ? (flips.size ? `Accepted: "${dec(res[0].payload)}" (a different message passed: the CRC missed it).` : `Accepted: "${dec(res[0].payload)}", CRC good.`) : 'Frame dropped: stuffing or CRC-32 failed.')
        : `${res.length} frames found where one was sent: ${res.map((x) => (x.ok ? 'good' : 'bad CRC')).join(', ')}. A damaged bit made a false flag; the CRC still rejects the pieces.`;
    cobs.textContent = `Byte-oriented alternative: COBS removes every zero byte from the data, so a 0 ends the frame. These ${p.length + 4} bytes (payload and FCS) become ${cobsEncode(body).length} plus the delimiter; the worst case is one byte in 254, where bit stuffing costs one bit in 5 on a run of 1s (20 %) and 1 in 62 on random data.`;
  };
  input.addEventListener('input', () => { text = input.value; allOnes = false; flips = new Set(); paint(); });
  const el = h('div', { class: 'widget mos err-w' }, h('div', { class: 'panel' }, h('h3', null, 'A frame between two flags'),
    h('label', { class: 'err-lab-in' }, 'Payload ', input),
    h('div', { class: 'dram-ops' }, btn('Six 0xFF bytes', 'The worst case for stuffing: only 1s', () => { allOnes = true; flips = new Set(); paint(); }), btn('Clear flips', 'Undo the flipped bits', () => { flips = new Set(); paint(); })),
    h('div', { class: 'clk-legend err-key' }, h('span', { class: 'f1' }, 'flag 01111110'), h('span', { class: 'f2' }, 'payload'), h('span', { class: 'f3' }, 'CRC-32'), h('span', { class: 'f4' }, 'stuffed 0')),
    strip, stats_, verdict, cobs));
  paint();
  return { el };
}

// ---- 8. repeat request ----------------------------------------------------------------------------------------------------------

export function arqWidget(): Widget {
  let proto: Proto = 'gbn', a = 4, W = 9, p = 0.1;
  const slots = 96;
  const strip = h('div', { class: 'err-tl', role: 'img', 'aria-label': 'Transmission slots, one cell each' });
  const chips = h('div', { class: 'mos-chips' });
  const note = h('p', { class: 'sub mos-note' });
  const tabs = (['saw', 'gbn', 'sr'] as Proto[]).map((k) => { const b = btn(PROTO_NAMES[k], `Simulate ${PROTO_NAMES[k]}`, () => { proto = k; paint(); }); b.setAttribute('aria-pressed', 'false'); return [k, b] as const; });
  const paint = () => {
    for (const [k, b] of tabs) b.setAttribute('aria-pressed', String(k === proto));
    const run = simulate(proto, a, W, p, 60, 3, 400), by = new Map(run.events.map((e) => [e.t, e]));
    strip.replaceChildren(...Array.from({ length: slots }, (_, t) => {
      const e = by.get(t);
      if (!e) return h('span', { class: 'err-sl idle', title: `slot ${t}: idle` }, '');
      const kind = !e.ok ? 'lost' : e.discarded ? 'drop' : e.retx ? 'retx' : 'new';
      return h('span', { class: `err-sl ${kind}`, title: `slot ${t}: frame ${e.seq}${e.retx ? ' (repeat)' : ''}, ${!e.ok ? 'corrupted' : e.discarded ? 'arrived out of order, discarded' : 'delivered'}` }, String(e.seq % 100));
    }));
    const sim = simulate(proto, a, W, p, 20000, 11), R = rttOf(a), f = utilization(proto, a, W, p);
    const cell = (b: string, t: string) => h('div', null, h('b', null, b), h('span', null, t));
    chips.replaceChildren(cell(pct(sim.u), 'simulated utilization'), cell(pct(f), proto === 'sr' && W < 3 * R ? 'closed form (ideal window)' : 'closed form'), cell(String(fullWindow(a)), 'frames in flight to fill the pipe'), cell(`${sim.perFrame.toFixed(2)}`, 'transmissions per frame'));
    const ft = (1500 * 8) / 63e6;
    note.textContent = `One-way delay a = ${a} frame times: with 1500-byte frames at 63 Mb/s (${si(ft, 's')} each) that is ${si(a * ft, 's')}, a round trip of ${R} slots. ${proto === 'saw' ? 'Stop-and-wait sends one frame, then waits a round trip for the acknowledgement.' : proto === 'gbn' ? 'Go-back-N: an unacknowledged frame times out after a round trip and the sender goes back, resending it and everything after it; the receiver discards frames that arrive out of order.' : 'Selective repeat: only the frame that timed out is resent, but the window cannot slide past it, so it takes about three round trips of window to reach 1 − p.'}`;
  };
  const sA = slider('One-way delay a', 0, 30, 1, a, (v) => `${v} frames`, (v) => { a = v; paint(); });
  const sW = slider('Window', 1, 64, 1, W, (v) => `${v} frames`, (v) => { W = v; paint(); });
  const sP = slider('Loss', 0, 0.3, 0.01, p, (v) => pct(v), (v) => { p = v; paint(); });
  const key = h('div', { class: 'clk-legend err-key' }, h('span', { class: 'f1' }, 'new frame'), h('span', { class: 'f4' }, 'repeat'), h('span', { class: 'f5' }, 'corrupted'), h('span', { class: 'f6' }, 'discarded'));
  const el = h('div', { class: 'widget mos err-w' }, h('div', { class: 'panel' }, h('h3', null, 'The first 96 slots'), h('div', { class: 'dram-ops' }, ...tabs.map(([, b]) => b)), key, strip),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sA.el, sW.el, sP.el), chips, note));
  paint();
  return { el };
}

// ---- 9. forward error correction as a trade ---------------------------------------------------------------------------------------

export function fecWidget(): Widget {
  let lp = -5, bytes = 1500, ld = -3;
  const RATE = 63e6;
  const pl = logPlot(560, 260, -8, -2, 0, 1, 'bit error rate p', 'goodput / wire bits', 'Goodput of CRC with retransmission and of SEC-DED with CRC and retransmission, against bit error rate', false, 0.2);
  const marker = pl.svg.appendChild(s('line', { class: 'bound', y1: 12, y2: 224 }));
  const curveA = pl.svg.appendChild(s('path', { class: 'err-s c2' })), curveB = pl.svg.appendChild(s('path', { class: 'err-s c3' }));
  const tab = h('div', { class: 'err-tab' });
  const note = h('p', { class: 'sub mos-note' });
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Payload size' }, ...[64, 256, 1500].map((v) => h('option', { value: String(v) }, `${v} byte frames`))) as HTMLSelectElement;
  sel.value = String(bytes);
  sel.addEventListener('change', () => { bytes = Number(sel.value); paint(); });
  const paint = () => {
    const p = 10 ** lp, oneWay = 10 ** ld;
    const pts = logSpace(-8, -2, 80);
    curveA.setAttribute('d', pathOf(pts.map((q): [number, number] => [pl.X(q), pl.Y(crcOnly(bytes, q).goodput)])));
    curveB.setAttribute('d', pathOf(pts.map((q): [number, number] => [pl.X(q), pl.Y(secdedCrc(bytes, q).goodput)])));
    marker.setAttribute('x1', String(pl.X(p))); marker.setAttribute('x2', String(pl.X(p)));
    const A = crcOnly(bytes, p), B = secdedCrc(bytes, p), tA = deliveryTime(A.wire, A.pFail, RATE, oneWay), tB = deliveryTime(B.wire, B.pFail, RATE, oneWay);
    const row = (c: string, l: string, a: string, b: string) => h('div', { class: `err-trow ${c}` }, h('span', null, l), h('span', null, a), h('span', null, b));
    tab.replaceChildren(row('head', '', 'CRC + retransmit', `SEC-DED + CRC + retransmit`), row('', 'bits on the wire', String(A.wire), String(B.wire)), row('', 'rate', pct(A.payload / A.wire), pct(B.payload / B.wire)),
      row('', 'frames repeated', pct(A.pFail), pct(B.pFail)), row('', 'goodput', pct(A.goodput), pct(B.goodput)), row('', 'mean delivery time', si(tA, 's'), si(tB, 's')));
    const c1 = crossover(bytes), c2 = crossoverTime(bytes, RATE, oneWay);
    note.textContent = `SEC-DED(${codeOf(64).n}, 64) adds ${codeOf(64).r} check bits to every 64 data bits (rate ${pct(codeOf(64).rate)}) and corrects any one error in a block; two in one block, and the frame is repeated. ${c1 ? `Goodput: the code wins above a bit error rate of ${sci(c1)}.` : 'Goodput: no crossover in range.'} ${c2 ? `Delivery time at a one-way delay of ${si(oneWay, 's')}: the code is faster above ${sci(c2)}.` : 'Delivery time: no crossover in range.'} Errors are independent here; real links burst.`;
  };
  const sP = slider('Bit error rate', -8, -2, 0.1, lp, (v) => `1e${v.toFixed(1)}`, (v) => { lp = v; paint(); });
  const sD = slider('One-way delay', -6, -0.5, 0.1, ld, (v) => si(10 ** v, 's'), (v) => { ld = v; paint(); });
  const key = h('div', { class: 'clk-legend err-key' }, h('span', { class: 'c2' }, 'CRC + retransmit'), h('span', { class: 'c3' }, 'SEC-DED + CRC + retransmit'));
  const el = h('div', { class: 'widget mos err-w' }, h('div', { class: 'panel' }, h('h3', null, 'Goodput against bit error rate'), key, pl.svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sel, sP.el, sD.el), tab, note));
  paint();
  return { el };
}
