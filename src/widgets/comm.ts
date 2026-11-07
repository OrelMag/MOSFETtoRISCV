// Chapter 39's explainers: the line that fades (phys/telegraph.ts), Morse against ITA2 (comm/codes.ts), and the two limits
// (comm/limits.ts). Every number shown is computed by the DOM-free model; the sliders are the learner's.

import { ITA2_UNITS, codeBits, ita2Encode, morseEncode } from '../comm/codes';
import { MARKED, dbToRatio, levelsSupported, nyquistBitRate, nyquistSymbolRate, ratioToDb, shannon, snrNeeded } from '../comm/limits';
import { RELAY_STEP_MS } from '../phys/relay';
import { CELL_V, PULL_I, PULL_V, loopCurrent, margin, ohmsPerKm, reachKm, repeaterDelayMs, type Metal } from '../phys/telegraph';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';

const fmtRate = (x: number) => (x >= 1e9 ? `${(x / 1e9).toPrecision(3)} Gb/s` : x >= 1e6 ? `${(x / 1e6).toPrecision(3)} Mb/s` : x >= 1e3 ? `${(x / 1e3).toPrecision(3)} kb/s` : `${x.toPrecision(3)} b/s`);
const fmtHz = (x: number) => (x >= 1e6 ? `${+(x / 1e6).toPrecision(3)} MHz` : x >= 1e3 ? `${+(x / 1e3).toPrecision(3)} kHz` : `${+x.toPrecision(3)} Hz`);

/** Four readout chips: a bold value over a small caption. */
export function chipRow(n = 4) {
  const cells = Array.from({ length: n }, () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; });
  return { el: h('div', { class: 'mos-chips' }, ...cells.map((c) => c.el)), set(i: number, value: string, caption: string) { cells[i].b.textContent = value; cells[i].sp.textContent = caption; } };
}

/** Plot frame: gridlines, tick labels, axis names. Returns scale functions. */
function frame(W: number, H: number, M: { l: number; r: number; t: number; b: number }, x: [number, number, number[], (v: number) => string], y: [number, number, number[], (v: number) => string], names: [string, string], logY = false) {
  const X = (v: number) => M.l + ((v - x[0]) / (x[1] - x[0])) * (W - M.l - M.r);
  const Y = (v: number) => (logY ? M.t + ((Math.log10(y[1]) - Math.log10(Math.max(v, y[0]))) / (Math.log10(y[1]) - Math.log10(y[0]))) * (H - M.t - M.b) : M.t + ((y[1] - v) / (y[1] - y[0])) * (H - M.t - M.b));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot' });
  for (const v of y[2]) svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: M.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, y[3](v)));
  for (const v of x[2]) svg.append(s('line', { x1: X(v), x2: X(v), y1: M.t, y2: H - M.b, class: 'grid' }), s('text', { x: X(v), y: H - M.b + 14, 'text-anchor': 'middle', class: 'tick' }, x[3](v)));
  svg.append(
    s('line', { x1: M.l, x2: M.l, y1: M.t, y2: H - M.b, class: 'ax' }), s('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'ax' }),
    s('text', { x: W - M.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, names[0]),
    s('text', { x: 8, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 8 ${M.t})`, class: 'axl' }, names[1]));
  return { svg, X, Y };
}

/** A line of path data through points. */
const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');

// ---------------------------------------------------------------- the telegraph line

export function telegraphLineWidget(): Widget {
  let km = 60, volts = 48, repeaters = 0, metal: Metal = 'iron';
  const W = 640, H = 280, M = { l: 52, r: 18, t: 14, b: 34 }, XMAX = 800, YMAX = 80;
  const { svg, X, Y } = frame(W, H, M, [0, XMAX, [0, 200, 400, 600, 800], (v) => `${v}`], [0, YMAX, [0, 20, 40, 60, 80], (v) => `${v}`], ['route length, km', 'mA'], false);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Line current against route length, with the relay pull-in current');
  const pull = s('line', { class: 'bound' }), pullL = s('text', { class: 'rl sat', 'text-anchor': 'end' }), cur = s('path', { class: 'cur' }), alt = s('path', { class: 'fam' }), dot = s('circle', { r: 6, class: 'op' }), reach = s('line', { class: 'vt' });
  svg.append(alt, pull, pullL, reach, cur, dot);
  const chips = chipRow();
  const verdict = h('p', { class: 'sub mos-note' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Wire metal' });
  const btn = (m: Metal) => { const b = h('button', { type: 'button', 'aria-pressed': String(m === metal) }, m === 'iron' ? 'Iron wire' : 'Copper wire'); b.addEventListener('click', () => { metal = m; paint(); }); return b; };
  const bI = btn('iron'), bC = btn('copper');
  seg.append(bI, bC);

  const curve = (m: Metal) => {
    const pts: [number, number][] = [];
    for (let L = 0; L <= XMAX; L += 8) pts.push([X(L), Y(Math.min(YMAX, 1e3 * loopCurrent(volts, L / (repeaters + 1), m)))]);
    return path(pts);
  };
  function paint() {
    const sec = km / (repeaters + 1), i = loopCurrent(volts, sec, metal), mg = margin(volts, sec, metal), reachSec = reachKm(volts, metal);
    cur.setAttribute('d', curve(metal));
    alt.setAttribute('d', curve(metal === 'iron' ? 'copper' : 'iron'));
    const yp = Y(1e3 * PULL_I);
    pull.setAttribute('x1', String(M.l)); pull.setAttribute('x2', String(W - M.r)); pull.setAttribute('y1', String(yp)); pull.setAttribute('y2', String(yp));
    pullL.setAttribute('x', String(W - M.r - 4)); pullL.setAttribute('y', String(yp - 5)); pullL.textContent = `pull-in ${(1e3 * PULL_I).toFixed(0)} mA`;
    const rx = X((repeaters + 1) * reachSec);
    reach.setAttribute('x1', String(rx)); reach.setAttribute('x2', String(rx)); reach.setAttribute('y1', String(M.t)); reach.setAttribute('y2', String(H - M.b));
    dot.setAttribute('cx', String(X(km))); dot.setAttribute('cy', String(Y(Math.min(YMAX, 1e3 * i))));
    dot.setAttribute('class', `op ${mg >= 1 ? '' : 'bad'}`);
    bI.setAttribute('aria-pressed', String(metal === 'iron')); bC.setAttribute('aria-pressed', String(metal === 'copper'));
    bI.classList.toggle('on', metal === 'iron'); bC.classList.toggle('on', metal === 'copper');
    chips.set(0, `${(ohmsPerKm(metal) * sec).toFixed(0)} Ω`, `wire in each of ${repeaters + 1} section${repeaters ? 's' : ''} (${ohmsPerKm(metal).toFixed(2)} Ω/km)`);
    chips.set(1, `${(1e3 * i).toFixed(1)} mA`, `coil current, ${mg.toFixed(2)} × the pull-in`);
    chips.set(2, `${((repeaters + 1) * reachSec).toFixed(0)} km`, `reach with ${repeaters} repeater${repeaters === 1 ? '' : 's'} (${reachSec.toFixed(0)} km a section)`);
    chips.set(3, `${repeaterDelayMs(repeaters).toFixed(0)} ms`, `added by the repeaters (${repeaters} × ${RELAY_STEP_MS} ms)`);
    verdict.textContent = reachSec === 0 ? `${volts} V cannot pull this relay in even on a zero-length line: it needs ${PULL_V.toFixed(1)} V across its coil.`
      : mg >= 1 ? `The coil pulls in with ${((mg - 1) * 100).toFixed(0)} % to spare.`
      : `The current is ${(100 * mg).toFixed(0)} % of what the coil needs: the sounder never moves. Add a repeater or raise the battery.`;
    verdict.classList.toggle('bad', mg < 1);
  }
  const kmSl = slider('Route', 1, XMAX, 1, km, (v) => `${v} km`, (v) => { km = v; paint(); });
  const vSl = slider('Battery', 24, 240, 4, volts, (v) => `${v} V`, (v) => { volts = v; paint(); });
  const rSl = slider('Repeaters', 0, 8, 1, repeaters, (v) => String(v), (v) => { repeaters = v; paint(); });
  const el = h('div', { class: 'widget mos comm' },
    h('div', { class: 'panel' }, h('h3', null, 'Key, battery, wire and relay coil in series ', seg), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, kmSl.el, vSl.el, rSl.el), verdict,
      h('p', { class: 'sub mos-note' }, `Model: the telephone relay of the previous chapters (pull-in ${PULL_V.toFixed(1)} V on 400 Ω), 4 mm wire, one wire with the earth as the return, ${CELL_V} V a cell. Leakage over damp insulators and the line's inductance are left out; both cost real lines more.`)),
    chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------- Morse against ITA2

export function codesWidget(): Widget {
  let text = 'SOS 73', unitMs = 20;
  const input = h('input', { type: 'text', class: 'comm-input', value: text, maxlength: 18, 'aria-label': 'Text to send', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const W = 640, ML = 84, MR = 10, ROW = 46;
  const holder = h('div', { class: 'comm-tapes' });
  const chips = chipRow();
  const note = h('p', { class: 'sub mos-note' });
  const wave = (svg: SVGSVGElement, y0: number, pts: [number, number][], cls: string) => {
    svg.append(s('path', { d: path(pts.map(([x, lv]) => [x, y0 + (lv ? 8 : ROW - 18)] as [number, number])), class: `wave ${cls}` }));
  };
  function paint() {
    const m = morseEncode(text), t = ita2Encode(text);
    const total = Math.max(m.units, t.units, 1), px = (W - ML - MR) / total;
    const svg = s('svg', { viewBox: `0 0 ${W} ${2 * ROW + 40}`, class: 'mos-plot comm-tape', role: 'img', 'aria-label': 'The text as a Morse waveform and as an ITA2 waveform, on one time axis' });
    // Morse: idle low (key up), key down high
    let x = ML, pts: [number, number][] = [[ML, 0]];
    for (const [on, u] of m.runs) { pts.push([x, on ? 1 : 0], [x + u * px, on ? 1 : 0]); x += u * px; }
    pts.push([x, 0]);
    svg.append(s('text', { x: 6, y: 18, class: 'axl' }, 'Morse'), s('text', { x: 6, y: 32, class: 'tick' }, 'idle low'));
    wave(svg, 0, pts, 'morse');
    // ITA2: idle high (mark); start 0, five data bits (bit 1 first), stop 1.5
    x = ML; pts = [[ML, 1]];
    for (const [code] of t.codes) {
      const lv = [0, ...codeBits(code), 1], w = [1, 1, 1, 1, 1, 1, 1.5];
      lv.forEach((l, k) => { pts.push([x, l], [x + w[k] * px, l]); x += w[k] * px; });
    }
    pts.push([x, 1]);
    svg.append(s('text', { x: 6, y: ROW + 18, class: 'axl' }, 'ITA2'), s('text', { x: 6, y: ROW + 32, class: 'tick' }, 'idle high'));
    wave(svg, ROW, pts, 'ita');
    let cx = ML;
    for (const [, label] of t.codes) { svg.append(s('text', { x: cx + (ITA2_UNITS * px) / 2, y: 2 * ROW + 12, 'text-anchor': 'middle', class: 'tick' }, label)); cx += ITA2_UNITS * px; }
    svg.append(s('text', { x: W - MR, y: 2 * ROW + 32, 'text-anchor': 'end', class: 'axl' }, `${total.toFixed(total % 1 ? 1 : 0)} time units across`));
    holder.replaceChildren(svg);
    const letters = m.words.reduce((n, w) => n + w.length, 0) + (m.words.length - 1 > 0 ? m.words.length - 1 : 0);
    chips.set(0, `${m.units} units`, `Morse, key down for ${m.runs.filter((r) => r[0]).reduce((n, r) => n + r[1], 0)}`);
    chips.set(1, `${t.units} units`, `ITA2: ${t.codes.length} characters (${t.shifts} shift${t.shifts === 1 ? '' : 's'}) × ${ITA2_UNITS}`);
    chips.set(2, `${(m.units * unitMs / 1000).toFixed(2)} s`, `Morse at a ${unitMs} ms unit`);
    chips.set(3, `${(t.units * unitMs / 1000).toFixed(2)} s`, `ITA2 at ${(1000 / unitMs).toFixed(0)} baud`);
    const skipped = [...new Set([...m.skipped, ...t.skipped])];
    note.textContent = (skipped.length ? `No code for ${skipped.join(' ')} in one of the two tables. ` : '') +
      (letters > 0 ? '' : 'Type something to send. ') + 'Morse spends its time on the key being down or up and needs a human ear to find the gaps; ITA2 spends 7.5 units a character on a frame that a motor and a cam can find alone.';
  }
  input.addEventListener('input', () => { text = input.value; paint(); });
  const uSl = slider('Unit', 10, 100, 5, unitMs, (v) => `${v} ms`, (v) => { unitMs = v; paint(); });
  const el = h('div', { class: 'widget mos comm' },
    h('div', { class: 'panel' }, h('h3', null, 'Type text, read both codes'), input, holder),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, uSl.el), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------- Nyquist and Shannon

export function limitsWidget(withNoise: boolean): Widget {
  let bExp = Math.log10(3100), snrDb = 30, levelExp = 1; // the voice band the text works with (3.49 would read 3.09 kHz)
  const B = () => 10 ** bExp, M = () => 2 ** levelExp;
  const W = 640, H = 300, Mg = { l: 52, r: 18, t: 14, b: 34 }, YMAX = 14;
  const { svg, X, Y } = frame(W, H, Mg, [-10, 60, [-10, 0, 10, 20, 30, 40, 50, 60], (v) => `${v}`], [0, YMAX, [0, 2, 4, 6, 8, 10, 12, 14], (v) => `${v}`], ['SNR, dB', 'bit/s per Hz'], false);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Spectral efficiency against signal-to-noise ratio: the Shannon curve and the Nyquist level line');
  const shan = s('path', { class: 'cur' }), nyq = s('line', { class: 'bound' }), nyqL = s('text', { class: 'rl sat', 'text-anchor': 'end' }), at = s('circle', { r: 6, class: 'op' }), vline = s('line', { class: 'vt' });
  const marks = s('g');
  svg.append(marks, shan, nyq, nyqL, vline, at);
  const pts: [number, number][] = [];
  for (let d = -10; d <= 60; d += 1) pts.push([X(d), Y(Math.log2(1 + dbToRatio(d)))]);
  shan.setAttribute('d', path(pts));
  if (withNoise) for (const m of MARKED) {
    const eta = m.rate / m.B, y = Y(eta);
    marks.append(s('line', { x1: Mg.l, x2: W - Mg.r, y1: y, y2: y, class: 'mk' }), s('text', { x: Mg.l + 4, y: y - 4, class: 'tick mk-l' }, m.short));
  }
  const chips = chipRow();
  const verdict = h('p', { class: 'sub mos-note' });
  const table = h('table', { class: 'mini comm-table' });
  const legend = h('p', { class: 'sub mos-note' }, MARKED.map((m) => `${m.short}: ${(m.rate / m.B).toFixed(1)} bit/s per Hz, so at least ${ratioToDb(snrNeeded(m.rate / m.B)).toFixed(0)} dB if it used no more than ${fmtHz(m.B)}. `).join(''));
  function paint() {
    const b = B(), snr = dbToRatio(snrDb), m = M();
    const nyqRate = nyquistBitRate(b, m), cap = shannon(b, snr), eta = Math.log2(m);
    vline.setAttribute('x1', String(X(snrDb))); vline.setAttribute('x2', String(X(snrDb))); vline.setAttribute('y1', String(Mg.t)); vline.setAttribute('y2', String(H - Mg.b));
    at.setAttribute('cx', String(X(snrDb))); at.setAttribute('cy', String(Y(Math.min(YMAX, Math.log2(1 + snr)))));
    const yn = Y(Math.min(YMAX, eta));
    nyq.setAttribute('x1', String(Mg.l)); nyq.setAttribute('x2', String(W - Mg.r)); nyq.setAttribute('y1', String(yn)); nyq.setAttribute('y2', String(yn));
    nyqL.setAttribute('x', String(W - Mg.r - 4)); nyqL.setAttribute('y', String(yn - 5)); nyqL.textContent = `${m} levels: ${eta.toFixed(0)} bit per symbol, 2 symbols per Hz`;
    shan.style.display = vline.style.display = at.style.display = marks.style.display = withNoise ? '' : 'none';
    chips.set(0, `${nyquistSymbolRate(b) >= 1e3 ? fmtRate(nyquistSymbolRate(b)).replace('b/s', 'baud') : `${nyquistSymbolRate(b).toFixed(0)} baud`}`, `symbols a second at most through ${fmtHz(b)} (2B)`);
    chips.set(1, fmtRate(nyqRate), `Nyquist, ${m} levels: 2B log2 M`);
    if (withNoise) {
      chips.set(2, fmtRate(cap), `Shannon at ${snrDb} dB (${snr >= 100 ? snr.toFixed(0) : snr.toFixed(1)} ×): B log2(1 + SNR)`);
      chips.set(3, levelsSupported(snr).toFixed(1), `levels the noise allows: √(1 + SNR)`);
      verdict.textContent = nyqRate <= cap ? `${m} levels fit under the noise: Nyquist's ${fmtRate(nyqRate)} is below Shannon's ${fmtRate(cap)}, which a good code can approach.`
        : `${m} levels need at least ${ratioToDb(m * m - 1).toFixed(1)} dB; this channel has ${snrDb} dB. Past ${fmtRate(cap)} no code, however clever, gets through.`;
      verdict.classList.toggle('bad', nyqRate > cap);
    } else {
      chips.set(2, `${eta.toFixed(0)} bit`, `per symbol, ${m} levels`);
      chips.set(3, fmtHz(b), 'bandwidth, the same in every row below');
      table.replaceChildren(h('tr', null, h('th', null, 'levels'), h('th', null, 'bits a symbol'), h('th', null, 'bit rate'), h('th', null, 'SNR it will need')),
        ...[1, 2, 3, 4, 6, 8].map((k) => h('tr', { class: k === levelExp ? 'now' : '' }, h('td', null, String(2 ** k)), h('td', null, String(k)), h('td', null, fmtRate(nyquistBitRate(b, 2 ** k))), h('td', null, `${ratioToDb(4 ** k - 1).toFixed(1)} dB or more`))));
      verdict.textContent = 'With no noise, every doubling of the levels adds a bit to every symbol. The last column is a preview: the next step shows where it comes from.';
      verdict.classList.remove('bad');
    }
  }
  const bSl = slider('Bandwidth', 1, 8, 0.01, bExp, (v) => fmtHz(10 ** v), (v) => { bExp = v; paint(); });
  const lSl = slider('Levels', 1, 8, 1, levelExp, (v) => String(2 ** v), (v) => { levelExp = v; paint(); });
  const nSl = slider('SNR', -10, 60, 1, snrDb, (v) => `${v} dB`, (v) => { snrDb = v; paint(); });
  const el = h('div', { class: 'widget mos comm' },
    h('div', { class: 'panel' }, h('h3', null, withNoise ? 'Capacity against signal-to-noise ratio, per hertz of bandwidth' : 'Symbols a second, and bits a symbol'), withNoise ? svg : table),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, bSl.el, lSl.el, ...(withNoise ? [nSl.el] : [])), verdict, ...(withNoise ? [legend] : [])), chips.el);
  paint();
  return { el };
}
