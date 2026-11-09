// Chapter noise's explainers: Manchester against NRZ, running disparity on a typed byte stream, the scrambler, the eye diagram with
// equalization, PAM4 against NRZ, and the media table. Every number comes from comm/linecode.ts or phys/line.ts; the gate-level
// link is widgets/serdes.ts.

import {
  byteOf, decode8b10bTracking, Descrambler, disparityOf, encodeStream, isKCode, manchester, maxRun, nameOf, POLY_64B66B, POLY_7, Scrambler,
  transitionDensity, unManchester, type Rd,
} from '../comm/linecode';
import {
  berOf, ctleNoiseGain, eye, eyePam, gaussian, pam4Ber, pam4Symbols, PAM4_LEVELS, PAM4_PENALTY_DB, prbs, pulseResponse, rng, type ChannelSpec,
} from '../phys/line';
import { h, keepFocus, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { hline, mkChips, num, plotOf, sci, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/serial.css';

const sl = (label: string, a: number, b: number, st: number, v: number, fmt: (x: number) => string, f: (x: number) => void) => slider(label, a, b, st, v, fmt, (x) => f(x)).el;
const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };

// ---- waveform helpers -------------------------------------------------------------------------------------------------------

/** A digital trace as a step path: `vals` one per cell of width `cw`, high at y0, low at y1. */
function steps(vals: number[], cw: number, x0: number, y0: number, y1: number): string {
  let d = '';
  vals.forEach((v, i) => {
    const y = v ? y0 : y1, x = x0 + i * cw;
    d += i === 0 ? `M${x},${y}` : `L${x},${y}`;
    d += `L${x + cw},${y}`;
  });
  return d;
}

export function wavePanel(W: number, rows: { label: string; vals: number[]; cw: number; cls?: string }[], marks: { x: number; label?: string }[] = [], aria = 'Waveforms'): SVGSVGElement {
  const rh = 34, H = rows.length * rh + 22, x0 = 58;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot sr-wave', role: 'img', 'aria-label': aria }) as SVGSVGElement;
  rows.forEach((r, k) => {
    const yb = 6 + k * rh;
    svg.append(s('text', { x: 4, y: yb + 19, class: 'axl' }, r.label), s('path', { d: steps(r.vals, r.cw, x0, yb + 6, yb + 26), class: `sr-tr ${r.cls ?? ''}` }));
  });
  for (const m of marks) svg.append(s('line', { x1: x0 + m.x, x2: x0 + m.x, y1: 2, y2: H - 18, class: 'sr-grid' }));
  return svg;
}

// ---- 1. Manchester ----------------------------------------------------------------------------------------------------------

export function manchesterWidget(): Widget {
  let text = '10110010 11100001', broken = -1;
  const bitsOf = () => Array.from(text.replace(/[^01]/g, '').slice(0, 32), Number);
  const out = h('div'), chips = mkChips(4);
  const input = h('input', { type: 'text', value: text, class: 'sr-in', 'aria-label': 'Bits to send', spellcheck: 'false' }) as HTMLInputElement;
  const paint = () => {
    const bits = bitsOf();
    if (!bits.length) { out.replaceChildren(h('p', { class: 'sub' }, 'Type some 0s and 1s.')); return; }
    const half = manchester(bits);
    if (broken >= 0 && broken < half.length) half[broken] ^= 1;
    const cw = Math.min(30, 640 / (bits.length * 2)), dec = unManchester(half);
    const clock = bits.flatMap(() => [0, 1]);
    const svg = wavePanel(700, [
      { label: 'bits', vals: bits.flatMap((b) => [b, b]), cw, cls: 'nrz' }, { label: 'half clk', vals: clock, cw },
      { label: 'Manchester', vals: half, cw, cls: 'man' },
    ], bits.map((_, i) => ({ x: i * 2 * cw })), 'The bits as NRZ, the half-bit clock and the Manchester line');
    const nrzRun = maxRun(bits);
    chips.set(0, `${nrzRun}`, 'longest run, NRZ (nothing bounds it)');
    chips.set(1, `${maxRun(half)}`, 'longest run, Manchester (at most 2)');
    chips.set(2, `${(transitionDensity(bits) * 100).toFixed(0)} % → ${(transitionDensity(half) * 100).toFixed(0)} %`, 'level changes per half-bit boundary: NRZ → Manchester');
    chips.set(3, dec.errors ? `${dec.errors} bit${dec.errors > 1 ? 's' : ''} flagged` : 'none', dec.errors ? 'halves equal: no mid-bit transition, so the receiver knows the bit is bad' : 'every bit has a transition in the middle', dec.errors ? 'bad' : 'ok');
    out.replaceChildren(svg, h('p', { class: 'sub' }, 'Click a half-bit below to flip it on the line.'),
      h('div', { class: 'sr-halves', role: 'group', 'aria-label': 'Half-bits on the line' }, ...half.map((v, i) => {
        const b = h('button', { class: `sr-half ${v ? 'v1' : 'v0'}${i === broken ? ' flipped' : ''}`, type: 'button', 'aria-label': `half-bit ${i}, level ${v}; click to flip` }, String(v));
        b.addEventListener('click', () => { broken = broken === i ? -1 : i; paint(); });
        return b;
      })));
  };
  input.addEventListener('input', () => { text = input.value; broken = -1; paint(); });
  const preset = (label: string, v: string) => btn(label, `Send ${v}`, () => { text = v; input.value = v; broken = -1; paint(); });
  const el = h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'mos-row' }, h('label', { class: 'mos-sl sr-field' }, h('span', null, 'Bits'), input)),
    h('div', { class: 'ln-presets' }, preset('Mixed', '10110010 11100001'), preset('Eight zeros', '00000000'), preset('Alternating', '10101010'), preset('All ones', '11111111')),
    out, chips.el);
  paint();
  return { el };
}

// ---- 2. 8b/10b and running disparity ----------------------------------------------------------------------------------------

const PRESETS: [string, string][] = [
  ['Comma, then text', 'K28.5 48 45 4C 4C 4F K28.5 57 4F 52 4C 44'],
  ['Zeros', '00 00 00 00 00 00 00 00'],
  ['Ones', 'FF FF FF FF FF FF FF FF'],
  ['Counting', '00 01 02 03 04 05 06 07 08 09'],
  ['D21.5 and D10.2', 'B5 4A B5 4A B5 4A'],
];

function parseSymbols(text: string): { v: number; k: boolean }[] {
  const out: { v: number; k: boolean }[] = [];
  for (const t of text.trim().split(/[\s,]+/).filter(Boolean).slice(0, 24)) {
    try {
      if (/^[DK]\d+\.\d$/i.test(t)) { const b = byteOf(t.toUpperCase()); if (!b.k || isKCode(b.v)) out.push(b); } else if (/^[0-9a-f]{1,2}$/i.test(t)) out.push({ v: parseInt(t, 16), k: false });
    } catch { /* not a code */ }
  }
  return out;
}

export function disparityWidget(): Widget {
  let text = PRESETS[0][1];
  const flips = new Set<string>();
  const out = h('div'), chips = mkChips(4);
  const input = h('input', { type: 'text', value: text, class: 'sr-in', 'aria-label': 'Bytes to send: hex, or D21.5 / K28.5', spellcheck: 'false' }) as HTMLInputElement;
  const paint = () => {
    const syms = parseSymbols(text);
    if (!syms.length) { out.replaceChildren(h('p', { class: 'sub' }, 'Type bytes in hex (48 45 4C) or code names (D21.5, K28.5).')); return; }
    const enc = encodeStream(syms, 0);
    // the line, with the learner's flipped bits
    const codes = enc.codes.map((c, i) => { let x = c; for (let j = 0; j < 10; j++) if (flips.has(`${i}:${j}`)) x ^= 1 << (9 - j); return x; });
    const line = codes.flatMap((c) => Array.from({ length: 10 }, (_, j) => (c >> (9 - j)) & 1));
    let rdBefore: Rd = 0, rdRx: Rd = 0, firstErr = -1;
    const rows = codes.map((c, i) => {
      const d = decode8b10bTracking(c, rdRx), tx = i ? enc.rds[i - 1] : 0;
      rdBefore = tx as Rd;
      const e = d.err;
      if (e && firstErr < 0) firstErr = i;
      rdRx = d.rd;
      const bad = flips.size ? (e ? (e === 'code' ? 'not a code' : 'wrong disparity') : (d.v !== syms[i].v || d.k !== syms[i].k ? 'wrong byte, no flag' : '')) : '';
      return h('tr', { class: bad ? 'bad' : '' },
        h('td', { class: 'sr-sym' }, nameOf(syms[i].v, syms[i].k), h('small', null, syms[i].k ? '' : ` ${syms[i].v.toString(16).toUpperCase().padStart(2, '0')}`)),
        h('td', null, rdBefore ? 'RD+' : 'RD−'),
        h('td', { class: 'sr-bits' }, ...Array.from({ length: 10 }, (_, j) => {
          const b = h('button', { class: `sr-bit v${(c >> (9 - j)) & 1}${flips.has(`${i}:${j}`) ? ' flipped' : ''}${j === 6 ? ' gap' : ''}`, type: 'button', 'aria-label': `${nameOf(syms[i].v, syms[i].k)} bit ${j}: ${(c >> (9 - j)) & 1}; click to flip` }, String((c >> (9 - j)) & 1));
          b.addEventListener('click', () => { const k = `${i}:${j}`; if (flips.has(k)) flips.delete(k); else flips.add(k); paint(); });
          return b;
        })),
        h('td', null, `${disparityOf(c, 10) > 0 ? '+' : ''}${disparityOf(c, 10)}`),
        h('td', null, enc.rds[i] ? 'RD+' : 'RD−'),
        h('td', { class: 'sr-dec' }, e ? (e === 'code' ? 'code error' : 'disparity error') : nameOf(d.v, d.k), bad && !e ? h('small', null, ' (undetected)') : null));
    });
    // cumulative sum of ones − zeros bit by bit, coded and raw
    const raw = syms.flatMap((b) => Array.from({ length: 8 }, (_, j) => (b.v >> (7 - j)) & 1));
    const cum = (bits: number[]) => { let c = 0; return [0, ...bits.map((b) => (c += b ? 1 : -1))]; };
    const cc = cum(line), cr = cum(raw), lo = Math.min(...cc, ...cr, -3), hi = Math.max(...cc, ...cr, 3);
    const plot = plotOf({ W: 700, H: 150, x: [0, Math.max(line.length, raw.length)], y: [lo - 1, hi + 1], yTicks: [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i), xLabel: 'bits sent', yLabel: 'ones − zeros', aria: 'Running count of ones minus zeros, coded and uncoded' });
    plot.clear();
    plot.layer.append(s('path', { d: cr.map((v, i) => `${i ? 'L' : 'M'}${plot.X(i).toFixed(1)},${plot.Y(v).toFixed(1)}`).join(''), class: 'ln-s lump' }),
      s('path', { d: cc.map((v, i) => `${i ? 'L' : 'M'}${plot.X(i).toFixed(1)},${plot.Y(v).toFixed(1)}`).join(''), class: 'ln-s real' }));
    chips.set(0, `${maxRun(line)}`, 'longest run on the line (never more than 5)');
    chips.set(1, `${Math.min(...cc)} … ${Math.max(...cc)}`, 'running disparity range, bit by bit');
    chips.set(2, `${cr[cr.length - 1]}`, 'the same bytes uncoded: where the count ends up');
    chips.set(3, `${(transitionDensity(line) * 100).toFixed(0)} %`, 'transition density of the coded stream');
    out.replaceChildren(
      h('div', { class: 'ln-scroll' }, h('table', { class: 'tbl sr-table' }, h('thead', null, h('tr', null, ...['symbol', 'RD in', 'abcdei fghj (click to flip a bit)', 'disp.', 'RD out', 'decoder'].map((t) => h('th', null, t)))), h('tbody', null, ...rows))),
      h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'coded'), h('span', { class: 'k-lump' }, 'uncoded')), plot.el, chips.el,
      ...(flips.size ? [h('p', { class: 'sub' }, firstErr >= 0 ? `First flag at ${nameOf(syms[firstErr].v, syms[firstErr].k)}, word ${firstErr}.` : 'The flipped bits made another legal code: nothing is flagged.'), btn('Un-flip all', 'Clear the flipped bits', () => { flips.clear(); paint(); })] : []));
  };
  input.addEventListener('input', () => { text = input.value; flips.clear(); paint(); });
  const el = h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'mos-row' }, h('label', { class: 'mos-sl sr-field' }, h('span', null, 'Bytes'), input)),
    h('div', { class: 'ln-presets' }, ...PRESETS.map(([l, v]) => btn(l, v, () => { text = v; input.value = v; flips.clear(); paint(); }))), out);
  paint();
  return { el };
}

// ---- 3. The scrambler -------------------------------------------------------------------------------------------------------

export function scramblerWidget(): Widget {
  let payload = 'zeros', poly: 'short' | 'long' = 'long', flipAt = -1;
  const N = 400;
  const payloads: Record<string, [string, () => number[]]> = {
    zeros: ['All zeros', () => Array(N).fill(0)],
    text: ['ASCII text', () => Array.from('HELLO, WORLD! THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. '.repeat(4)).flatMap((c) => Array.from({ length: 8 }, (_, j) => (c.charCodeAt(0) >> (7 - j)) & 1)).slice(0, N)],
    counter: ['Counter 00 … FF', () => Array.from({ length: 50 }, (_, i) => i).flatMap((v) => Array.from({ length: 8 }, (_, j) => (v >> (7 - j)) & 1))],
    ones: ['All ones', () => Array(N).fill(1)],
  };
  const taps = () => (poly === 'long' ? POLY_64B66B : POLY_7);
  const out = h('div'), chips = mkChips(4);
  const hist = (bits: number[]) => {
    const runs: number[] = Array(12).fill(0);
    let r = 0;
    for (let i = 0; i < bits.length; i++) { r = i && bits[i] === bits[i - 1] ? r + 1 : 1; if (i === bits.length - 1 || bits[i + 1] !== bits[i]) runs[Math.min(11, r)]++; }
    return runs;
  };
  const bars = (title: string, runs: number[], cls: string) => {
    const mx = Math.max(1, ...runs);
    return h('div', { class: 'sr-hist' }, h('b', null, title), h('div', { class: 'sr-bars', role: 'img', 'aria-label': `${title}: runs of 1 to 11 or more` },
      ...runs.slice(1).map((n, i) => h('span', { class: 'sr-bar', title: `${n} runs of ${i + 1}${i === 10 ? ' or more' : ''}` }, h('i', { class: cls, style: `height:${Math.max(n ? 3 : 0, (n / mx) * 56)}px` }), h('em', null, String(i + 1))))));
  };
  const paint = () => {
    const data = payloads[payload][1]();
    // a nonzero register: the empty register would pass zeros as zeros
    const seed = poly === 'long' ? 0x15555555555555 : 0x55;
    const line = new Scrambler(taps(), seed).run(data);
    const wire = line.slice();
    if (flipAt >= 0) wire[flipAt] ^= 1;
    // counted against the same descrambler on the clean line, so its start-up transient is not an error and the flip's copies all are
    const back = new Descrambler(taps(), seed ^ 0x2a).run(wire), clean = new Descrambler(taps(), seed ^ 0x2a).run(line);
    const wrong = back.map((b, i) => (b !== clean[i] ? i : -1)).filter((i) => i >= 0);
    const same = payload === 'zeros' || payload === 'ones';
    chips.set(0, `${maxRun(data)} → ${maxRun(line)}`, 'longest run: payload → scrambled');
    chips.set(1, `${(transitionDensity(data) * 100).toFixed(0)} % → ${(transitionDensity(line) * 100).toFixed(0)} %`, 'transition density: payload → scrambled');
    chips.set(2, flipAt >= 0 ? `${wrong.length} wrong` : 'none', flipAt >= 0 ? `one flipped line bit: wrong at ${wrong.slice(0, 3).map((i) => i - flipAt).map((d) => (d ? `+${d}` : '0')).join(', ')} bits` : 'flip a bit on the line below', wrong.length === 3 ? 'bad' : '');
    chips.set(3, same ? 'no guarantee' : 'statistical', 'a long run is unlikely, never impossible: the line code has no bound');
    const cells = line.slice(0, 160).map((_, i) => {
      const e = h('button', { class: `sr-bit sm v${wire[i]}${i === flipAt ? ' flipped' : ''}`, type: 'button', 'aria-label': `line bit ${i}: ${wire[i]}; click to flip it` }, String(wire[i]));
      e.addEventListener('click', () => keepFocus(e, () => { flipAt = flipAt === i ? -1 : i; paint(); }));
      return e;
    });
    out.replaceChildren(
      h('div', { class: 'sr-hists' }, bars('payload', hist(data), 'bar-a'), bars('scrambled', hist(line), 'bar-b')),
      h('p', { class: 'sub' }, `The line, first 160 of ${line.length} bits. Click one to corrupt it.`), h('div', { class: 'sr-bitrow' }, ...cells), chips.el);
  };
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Payload' }, ...Object.entries(payloads).map(([k, [l]]) => h('option', { value: k }, l))) as HTMLSelectElement;
  sel.addEventListener('change', () => { payload = sel.value; flipAt = -1; paint(); });
  const sp = h('select', { class: 'mc-sel', 'aria-label': 'Polynomial' }, h('option', { value: 'long' }, '1 + x³⁹ + x⁵⁸ (64b/66b)'), h('option', { value: 'short' }, '1 + x⁶ + x⁷ (this chapter\'s gates)')) as HTMLSelectElement;
  sp.addEventListener('change', () => { poly = sp.value as typeof poly; flipAt = -1; paint(); });
  const el = h('div', { class: 'widget mos sr-w' }, h('div', { class: 'mos-row sr-sels' }, h('label', null, 'Payload ', sel), h('label', null, 'Polynomial ', sp)), out);
  paint();
  return { el };
}

// ---- 6 and 7. The eye diagram and equalization --------------------------------------------------------------------------------

/** The eye of a PRBS-9 pattern with noise, with rate / bandwidth / noise (and, with `eq`, equalization) sliders and the BER. */
export function eyeWidget(opt: { eq?: boolean; rate?: number } = {}): Widget {
  let rate = opt.rate ?? 6, bw = 1, sig = 40, de = 0, ctle = 1, dfe = 0;
  const bits = prbs(9, 1022);
  const plot = plotOf({ W: 640, H: 250, x: [0, 2], y: [-1.3, 1.3], yTicks: [-1, 0, 1], xLabel: 'unit intervals', yLabel: 'swing (V)', aria: 'Eye diagram of a pseudo-random bit stream through a low-pass channel', xFmt: (v) => num(v, 1), yFmt: (v) => num(v, 1) });
  const chips = mkChips(4), taps = h('div', { class: 'sr-taps' }), note = h('p', { class: 'sub mos-note' }), best = h('p', { class: 'sub' });
  const spec = (): ChannelSpec => ({ rate, bandwidth: bw, de, ctle, dfe });
  const paint = () => {
    const ch = spec(), e = eye(bits, ch), p = plot, S = e.spu;
    p.clear();
    const gain = ctleNoiseGain(ch), sg = (sig / 1000) * gain;
    const u = rng(12345), g = p.layer.appendChild(s('g', { class: 'ln-eye' }));
    const start = e.phase - S;
    for (let i = 24; i < 190; i++) {
      let d = '';
      const off = sg * gaussian(u);
      for (let j = 0; j <= 2 * S; j += 2) {
        const idx = i * S + start + j;
        d += `${j ? 'L' : 'M'}${p.X(j / S).toFixed(1)},${p.Y(e.wave[idx] + off * 0.6 + sg * 0.8 * gaussian(u)).toFixed(1)}`;
      }
      g.append(s('path', { d, class: 'ln-s eyeline' }));
    }
    const open = Math.max(e.opening, 0), ber = e.opening <= 0 ? 0.5 : berOf(open / 2, sg);
    if (open > 0) p.layer.append(s('line', { x1: p.X(1), x2: p.X(1), y1: p.Y(e.lowOne), y2: p.Y(e.highZero), class: 'ln-open' }));
    hline(p, e.threshold, 'slicer');
    chips.set(0, e.opening > 0 ? `${(e.opening * 1000).toFixed(0)} mV` : 'closed', `eye height at the best phase, of a ±1 V swing (${(e.opening * 50).toFixed(0)} % of ideal)`, e.opening > 0 ? '' : 'bad');
    chips.set(1, `${e.ui.toFixed(0)} ps`, `bit period · ${(e.width * 100).toFixed(0)} % of it open sideways`);
    chips.set(2, `${(sg * 1000).toFixed(0)} mV`, gain > 1.001 ? `noise at the slicer: ${sig} mV × CTLE gain ${gain.toFixed(2)}` : 'noise σ at the slicer');
    chips.set(3, sci(ber), 'BER = Q(half the opening / σ)', ber > 1e-12 ? 'bad' : 'ok');
    note.textContent = `Channel: ${num(bw, 2)} GHz single pole${ctle > 1 ? ` with a CTLE zero on it and a pole at ${num(ctle * bw, 2)} GHz` : ''}. Nyquist for ${rate} Gb/s is ${num(rate / 2, 1)} GHz, ${num(rate / 2 / bw, 1)}× the pole.`;
    if (opt.eq) {
      const base = { ...ch, dfe: 0 }, pr = pulseResponse(base, 7), ph = e.phase;
      const hk = Array.from({ length: 6 }, (_, k) => pr[k * S + ph]);
      const mx = Math.max(Math.abs(hk[0]), 1e-9);
      taps.replaceChildren(h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'cursor'), h('span', { class: 'k-good' }, 'post-cursor left'), h('span', { class: 'k-lump' }, 'removed by the DFE')),
        h('div', { class: 'sr-bars sr-stems', role: 'img', 'aria-label': 'Pulse response sampled at the best phase: the cursor and five post-cursors' },
          ...hk.map((v, k) => h('span', { class: 'sr-bar' }, h('i', { class: k === 0 ? 'bar-a' : k <= dfe ? 'bar-x' : 'bar-b', style: `height:${Math.max(3, (Math.abs(v) / mx) * 64)}px` }), h('em', null, k === 0 ? 'h0' : `h${k}`), h('small', null, v.toFixed(2))))));
    }
  };
  const findBest = () => {
    // the fastest rate at which this channel and noise still give BER < 1e-12 (Q ≥ 7.03)
    let lo = 0.5, hi = 40;
    const good = (r: number) => { const c = { ...spec(), rate: r }, e = eye(bits, c, 20); return e.opening > 0 && berOf(e.opening / 2, (sig / 1000) * ctleNoiseGain(c)) < 1e-12; };
    if (!good(lo)) { best.textContent = 'No rate works with this noise and bandwidth.'; return; }
    for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (good(m)) lo = m; else hi = m; }
    best.textContent = `Fastest rate with BER below 10⁻¹² for this channel, noise and equalizer: ${num(lo, 2)} Gb/s (${num(lo / bw, 1)} bits per hertz of bandwidth).`;
  };
  const rows = [
    sl('Rate', 1, 16, 0.5, rate, (v) => `${v.toFixed(1)} Gb/s`, (v) => { rate = v; paint(); }),
    sl('Bandwidth', 0.5, 4, 0.25, bw, (v) => `${v.toFixed(2)} GHz`, (v) => { bw = v; paint(); }),
    sl('Noise σ', 0, 150, 5, sig, (v) => `${v} mV`, (v) => { sig = v; paint(); }),
  ];
  const eqRows = opt.eq ? [
    sl('De-emphasis', 0, 60, 5, de * 100, (v) => `${v} %`, (v) => { de = v / 100; paint(); }),
    sl('CTLE pole', 1, 4, 0.25, ctle, (v) => (v === 1 ? 'none' : `${v}× bw`), (v) => { ctle = v; paint(); }),
    sl('DFE taps', 0, 3, 1, dfe, (v) => String(v), (v) => { dfe = v; paint(); }),
  ] : [];
  const el = h('div', { class: 'widget mos sr-w' }, plot.el, h('div', { class: 'mos-row' }, ...rows), eqRows.length ? h('div', { class: 'mos-row' }, ...eqRows) : null, chips.el, opt.eq ? taps : null,
    h('div', { class: 'ln-presets' }, btn('Find the fastest rate', 'Bisect the rate for BER below 10⁻¹²', findBest)), best, note);
  paint();
  return { el };
}

// ---- 8. PAM4 against NRZ ------------------------------------------------------------------------------------------------------

export function pam4Widget(): Widget {
  let rate = 8, bw = 2, poles = 1, sig = 30;
  const bits = prbs(9, 1022), sym = pam4Symbols(bits);
  const mk = (aria: string, ys: number[]) => plotOf({ W: 320, H: 220, x: [0, 2], y: [-1.3, 1.3], yTicks: ys, xLabel: 'unit intervals', yLabel: 'swing (V)', aria, xFmt: (v) => num(v, 1), yFmt: (v) => num(v, 2) });
  const pn = mk('NRZ eye', [-1, 0, 1]), pp = mk('PAM4 eye', [-1, -1 / 3, 1 / 3, 1]);
  const chips = mkChips(4), verdict = h('p', { class: 'clk-verdict' });
  const draw = (p: Plot, wave: Float64Array, S: number, phase: number, from: number, count: number, offs: (u: () => number) => number) => {
    p.clear();
    const u = rng(777), g = p.layer.appendChild(s('g', { class: 'ln-eye' })), start = phase - S;
    for (let i = from; i < from + count; i++) {
      let d = '';
      const o = offs(u);
      for (let j = 0; j <= 2 * S; j += 2) d += `${j ? 'L' : 'M'}${p.X(j / S).toFixed(1)},${p.Y(wave[i * S + start + j] + o).toFixed(1)}`;
      g.append(s('path', { d, class: 'ln-s eyeline' }));
    }
  };
  const paint = () => {
    const e = eye(bits, { rate, bandwidth: bw, poles }), ep = eyePam(sym, PAM4_LEVELS, { rate: rate / 2, bandwidth: bw, poles });
    const sg = sig / 1000, noise = (u: () => number) => sg * gaussian(u);
    draw(pn, e.wave, e.spu, e.phase, 24, 150, noise); draw(pp, ep.wave, ep.spu, ep.phase, 24, 150, noise);
    const bn = e.opening <= 0 ? 0.5 : berOf(e.opening / 2, sg), bp = pam4Ber(ep.opening, sg);
    const loss = (f: number) => poles * 10 * Math.log10(1 + (f / bw) ** 2);
    chips.set(0, e.opening > 0 ? `${(e.opening * 1000).toFixed(0)} mV` : 'closed', 'NRZ eye height', e.opening > 0 ? '' : 'bad');
    chips.set(1, ep.opening > 0 ? `${(ep.opening * 1000).toFixed(0)} mV` : 'closed', 'PAM4 eye height, the smallest of three', ep.opening > 0 ? '' : 'bad');
    chips.set(2, `${sci(bn)} | ${sci(bp)}`, 'BER: NRZ | PAM4', Math.min(bn, bp) > 1e-12 ? 'bad' : 'ok');
    chips.set(3, `${loss(rate / 2).toFixed(1)} | ${loss(rate / 4).toFixed(1)} dB`, `channel loss at Nyquist: NRZ ${num(rate / 2, 1)} GHz | PAM4 ${num(rate / 4, 1)} GHz`);
    const d = loss(rate / 2) - loss(rate / 4);
    verdict.className = `clk-verdict ${d > PAM4_PENALTY_DB ? 'ok' : 'bad'}`;
    verdict.textContent = `PAM4 buys ${d.toFixed(1)} dB of channel loss by halving Nyquist and pays ${PAM4_PENALTY_DB.toFixed(1)} dB of eye height. ${d > PAM4_PENALTY_DB ? 'The loss saved is larger: PAM4 wins here.' : 'The loss saved is smaller: NRZ wins here.'}`;
  };
  const el = h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'sr-two' }, h('div', null, h('h4', null, 'NRZ'), pn.el), h('div', null, h('h4', null, 'PAM4, half the symbol rate'), pp.el)),
    h('div', { class: 'mos-row' }, sl('Bit rate', 2, 32, 1, rate, (v) => `${v} Gb/s`, (v) => { rate = v; paint(); }), sl('Bandwidth', 0.5, 6, 0.25, bw, (v) => `${v.toFixed(2)} GHz`, (v) => { bw = v; paint(); }),
      sl('Channel', 1, 3, 1, poles, (v) => (v === 1 ? 'one pole' : `${v} poles (lossy trace)`), (v) => { poles = v; paint(); }), sl('Noise σ', 0, 100, 5, sig, (v) => `${v} mV`, (v) => { sig = v; paint(); })),
    chips.el, verdict);
  paint();
  return { el };
}

// ---- 9. Media -----------------------------------------------------------------------------------------------------------------

/** Loss of an FR4 trace at frequency f (GHz), dB per metre: a skin-effect term in √f and a dielectric term in f. Illustrative constants. */
export const PCB_LOSS = (f: number): number => 10 * Math.sqrt(f) + 2.4 * f;
export const LOSS_BUDGET_DB = 25;
export const MMF = { dbPerKm: 3, modalMHzKm: 4700, budgetDb: 6 };
export const SMF = { dbPerKm: 0.35, budgetDb: 10 };

export const mediaReach = (rate: number) => ({
  pcbCm: (LOSS_BUDGET_DB / PCB_LOSS(rate / 2)) * 100,
  mmfM: Math.min(MMF.budgetDb / MMF.dbPerKm, MMF.modalMHzKm / (0.7 * rate * 1000)) * 1000,
  smfKm: SMF.budgetDb / SMF.dbPerKm,
});

export function mediaWidget(): Widget {
  let rate = 10;
  const body = h('tbody');
  const paint = () => {
    const r = mediaReach(rate), f = rate / 2;
    const cm = (x: number) => (x >= 100 ? `${(x / 100).toFixed(1)} m` : `${x.toFixed(0)} cm`);
    const m = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} km` : `${x.toFixed(0)} m`);
    body.replaceChildren(
      h('tr', null, h('td', null, 'FR4 trace'), h('td', null, `${PCB_LOSS(f).toFixed(0)} dB/m at ${num(f, 1)} GHz`), h('td', null, `${LOSS_BUDGET_DB} dB budget`), h('td', { class: 'sr-reach' }, cm(r.pcbCm)), h('td', null, 'loss grows with frequency: reach falls faster than the rate rises')),
      h('tr', null, h('td', null, 'Multimode fibre, 850 nm'), h('td', null, `${MMF.dbPerKm} dB/km, ${MMF.modalMHzKm} MHz·km`), h('td', null, `${MMF.budgetDb} dB; bandwidth ≈ 0.7 × rate`), h('td', { class: 'sr-reach' }, m(r.mmfM)), h('td', null, 'modes arrive at different times: bandwidth × length is constant')),
      h('tr', null, h('td', null, 'Single-mode fibre, 1310 nm'), h('td', null, `${SMF.dbPerKm} dB/km`), h('td', null, `${SMF.budgetDb} dB`), h('td', { class: 'sr-reach' }, `${r.smfKm.toFixed(0)} km`), h('td', null, 'one mode: loss, not bandwidth, sets the reach (dispersion limits the fastest links)')));
  };
  const el = h('div', { class: 'widget mos sr-w' }, h('div', { class: 'mos-row' }, sl('Bit rate', 1, 112, 1, rate, (v) => `${v} Gb/s`, (v) => { rate = v; paint(); })),
    h('div', { class: 'ln-scroll' }, h('table', { class: 'tbl ln-table sr-table' }, h('thead', null, h('tr', null, ...['medium', 'loss', 'budget', 'reach', 'what limits it'].map((t) => h('th', null, t)))), body)),
    h('p', { class: 'sub' }, 'Illustrative constants for each medium, labelled in the text: the shape of the trade is the point, not the third digit.'));
  paint();
  return { el };
}
