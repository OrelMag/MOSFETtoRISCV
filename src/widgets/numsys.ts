// Chapter 5's number-system widgets: four signed encodings side by side against one plain adder, overflow worked in
// columns (C and V), and fixed-point fractions.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/numsys.css';

const bin = (x: number, w: number) => x.toString(2).padStart(w, '0');

/** A row of w toggles for a value; `set` gets the new value. */
function bitToggles(w: number, get: () => number, set: (x: number) => void, name: string): HTMLElement {
  const row = h('div', { class: 'bits-row' });
  for (let i = w - 1; i >= 0; i--) {
    const on = Math.floor(get() / 2 ** i) % 2 === 1;
    row.append(h('button', {
      class: on ? 'one' : '', 'aria-label': `${name} bit ${i}, ${on ? 1 : 0}`,
      onclick: () => set(on ? get() - 2 ** i : get() + 2 ** i),
    }, on ? '1' : '0'));
    if (i % 4 === 0 && i > 0) row.append(h('span', { class: 'ns-gap' }));
  }
  return h('div', { class: 'bits ns-bits' }, row);
}

// ---- four encodings ------------------------------------------------------------------------------------

interface Encoding { name: string; short: string; read: (p: number) => number; zero2?: number; note: string }

/** 4-bit readings. zero2: the pattern that is a second zero. */
export const ENCODINGS: Encoding[] = [
  { name: 'sign-magnitude', short: 'sign-mag', read: (p) => (p & 8 ? -(p & 7) : p), zero2: 8, note: 'top bit = sign, the rest = size' },
  { name: 'one\'s complement', short: '1s comp', read: (p) => (p & 8 ? -(15 - p) : p), zero2: 15, note: 'negative = every bit inverted' },
  { name: 'bias 8', short: 'bias 8', read: (p) => p - 8, note: 'unsigned value minus 8' },
  { name: 'two\'s complement', short: '2s comp', read: (p) => (p & 8 ? p - 16 : p), note: 'top bit weighs −8' },
];

export function encodingsWidget(): Widget {
  let a = 0b1110, b = 0b0011;
  const table = h('div', { class: 'ns-scroll' });
  const ins = h('div', { class: 'ns-ins' });
  const verdict = h('div', { class: 'ns-verdict' });

  function render(): void {
    const sum = (a + b) % 16;
    const t = h('table', { class: 'ns-t ns-enc' },
      h('tr', null, h('th', null, 'bits'), h('th', null, 'unsigned'), ...ENCODINGS.map((e) => h('th', { title: `${e.name}: ${e.note}` }, e.short))));
    for (let p = 0; p < 16; p++) {
      const mark = [p === a ? 'a' : '', p === b ? 'b' : '', p === sum ? 'sum' : ''].filter(Boolean).join(' ');
      t.append(h('tr', { class: mark ? 'sel' : '' },
        h('td', null, bin(p, 4), mark ? h('span', { class: 'ns-tag' }, mark) : ''),
        h('td', null, String(p)),
        ...ENCODINGS.map((e) => h('td', { class: e.zero2 === p ? 'dup' : '' }, e.zero2 === p ? '−0' : String(e.read(p)).replace('-', '−')))));
    }
    table.replaceChildren(t);
    ins.replaceChildren(
      h('div', null, h('span', { class: 'ns-lab' }, 'a'), bitToggles(4, () => a, (x) => { a = x; render(); }, 'a')),
      h('div', null, h('span', { class: 'ns-lab' }, 'b'), bitToggles(4, () => b, (x) => { b = x; render(); }, 'b')),
      h('p', { class: 'ns-sum' }, `A plain 4-bit adder: ${bin(a, 4)} + ${bin(b, 4)} = ${bin(sum, 4)}${a + b > 15 ? ' (carry out dropped)' : ''}`),
    );
    verdict.replaceChildren(...ENCODINGS.map((e) => {
      const want = e.read(a) + e.read(b), got = e.read(sum);
      const fits = want >= -8 + (e.zero2 !== undefined ? 1 : 0) && want <= 7;
      const ok = got === want || (want === 0 && e.zero2 === sum);
      const cls = !fits ? 'na' : ok ? 'ok' : 'no';
      const text = !fits ? `${want} does not fit in 4 bits` : ok ? `${e.read(a)} + ${e.read(b)} = ${want}: right` : `${e.read(a)} + ${e.read(b)} should be ${want}, the adder gives ${got}`;
      return h('div', { class: cls }, h('b', null, `${e.name} ${cls === 'ok' ? '✓' : cls === 'no' ? '✗' : '–'}`), text.replace(/-/g, '−'));
    }));
  }
  render();
  const el = h('div', { class: 'widget ns' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' }, h('h3', null, 'One adder, four readings'),
        h('p', { class: 'sub' }, 'Pick two 4-bit patterns. The adder only sees bits; each encoding then reads its sum. Only one reading is right every time.'),
        ins, verdict),
      h('div', { class: 'panel' }, h('h3', null, 'All 16 patterns'),
        h('p', { class: 'sub' }, 'Red: a second zero, a pattern wasted. Hover a heading for the rule.'), table)));
  return { el };
}

// ---- overflow in columns ------------------------------------------------------------------------------

export function overflowWidget(): Widget {
  const W = 8;
  let a = 0x70, b = 0x30;
  const ins = h('div', { class: 'ns-ins' });
  const cols = h('div', { class: 'ns-scroll' });
  const flags = h('div', { class: 'ns-flags' });
  const read = h('div', { class: 'readout ns-wide' });
  const note = h('p', { class: 'sub', 'aria-live': 'polite', style: 'margin-top:10px' });
  const sg = (x: number) => (x >= 128 ? x - 256 : x);

  function render(): void {
    const carry: number[] = []; // carry[i]: into column i
    let c = 0;
    for (let i = 0; i < W; i++) {
      carry[i] = c;
      c = Math.floor((Math.floor(a / 2 ** i) % 2 + Math.floor(b / 2 ** i) % 2 + c) / 2);
    }
    const cout = c, cin = carry[W - 1], v = cin !== cout ? 1 : 0, sum = (a + b) % 256;
    const bitsOf = (x: number) => Array.from({ length: W }, (_, k) => h('td', null, String(Math.floor(x / 2 ** (W - 1 - k)) % 2)));
    const t = h('table', { class: 'ns-cols' },
      h('tr', { class: 'carry' }, h('td', { class: 'hot', title: 'carry out' }, String(cout)),
        ...Array.from({ length: W }, (_, k) => { const i = W - 1 - k; return h('td', { class: i === W - 1 ? 'hot' : '', title: `carry into bit ${i}` }, i === 0 ? '' : String(carry[i])); }),
        h('td', { class: 'lab' }, 'carries')),
      h('tr', null, h('td'), ...bitsOf(a), h('td', { class: 'lab' }, 'a')),
      h('tr', null, h('td', null, '+'), ...bitsOf(b), h('td', { class: 'lab' }, 'b')),
      h('tr', { class: 'sum' }, h('td'), ...bitsOf(sum), h('td', { class: 'lab' }, 'sum')));
    cols.replaceChildren(t);
    ins.replaceChildren(
      h('div', null, h('span', { class: 'ns-lab' }, 'a'), bitToggles(W, () => a, (x) => { a = x; render(); }, 'a')),
      h('div', null, h('span', { class: 'ns-lab' }, 'b'), bitToggles(W, () => b, (x) => { b = x; render(); }, 'b')));
    flags.replaceChildren(
      h('span', { class: `ns-flag${cout ? ' lit' : ''}` }, h('i'), `C = ${cout}: the carry out`),
      h('span', { class: `ns-flag${v ? ' lit' : ''}` }, h('i'), `V = ${cin} ⊕ ${cout} = ${v}: carry into the top column ⊕ out of it`));
    const m = (x: number) => String(x).replace('-', '−');
    read.replaceChildren(
      h('div', null, h('b', null, `${a} + ${b} = ${sum}`), h('span', null, cout ? `unsigned: wrong (true sum ${a + b}), C = 1` : 'unsigned: right, C = 0')),
      h('div', null, h('b', null, `${m(sg(a))} + ${m(sg(b))} = ${m(sg(sum))}`), h('span', null, v ? `signed: wrong (true sum ${m(sg(a) + sg(b))}), V = 1` : 'signed: right, V = 0')));
    note.textContent = v
      ? 'Both operands have the same sign and the sum has the other one. That happens exactly when the carry into the top column differs from the carry out of it.'
      : cout ? 'A carry out but no V: the unsigned sum wrapped, the signed one is fine.' : '';
  }
  const presets = h('div', { class: 'ns-presets' }, ...([[0x70, 0x30], [0xFF, 0x02], [0x80, 0x80], [0x05, 0x0A]] as const).map(([x, y]) =>
    h('button', { class: 'btn sm', onclick: () => { a = x; b = y; render(); } }, `0x${x.toString(16).toUpperCase().padStart(2, '0')} + 0x${y.toString(16).toUpperCase().padStart(2, '0')}`)));
  render();
  const el = h('div', { class: 'widget ns' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' }, h('h3', null, 'a + b, column by column'),
        h('p', { class: 'sub' }, 'Add as on paper: each column\'s carry goes to the column on its left. Flip bits or pick a case.'),
        ins, presets, cols, flags),
      h('div', { class: 'panel' }, h('h3', null, 'Both readings of one sum'), read, note)));
  return { el };
}

// ---- fixed point --------------------------------------------------------------------------------------

export function fixedWidget(): Widget {
  const W = 8;
  let x = 0b0001_1010, P = 4;
  const ins = h('div');
  const read = h('div', { class: 'readout' });
  const qLab = h('b', { class: 'ns-q' });
  const slider = h('input', { type: 'range', min: '0', max: String(W), value: String(P), 'aria-label': 'Fraction bits (where the binary point sits)' }) as HTMLInputElement;
  slider.addEventListener('input', () => { P = Number(slider.value); render(); });
  const tenth = h('div', { class: 'ns-scroll' });

  function render(): void {
    qLab.textContent = `Q${W - P}.${P}`;
    const row = h('div', { class: 'bits-row' });
    for (let i = W - 1; i >= 0; i--) {
      const on = Math.floor(x / 2 ** i) % 2 === 1, e = i - P;
      row.append(h('button', {
        class: on ? 'one' : '', 'aria-label': `bit ${i}, worth ${e >= 0 ? 2 ** e : `1/${2 ** -e}`}`,
        onclick: () => { x = on ? x - 2 ** i : x + 2 ** i; render(); },
      }, on ? '1' : '0', h('span', { class: 'idx' }, e >= 0 ? String(2 ** e) : `1/${2 ** -e}`)));
      if (i === P && P > 0) row.append(h('span', { class: 'ns-point', 'aria-hidden': 'true' }, '.'));
    }
    ins.replaceChildren(h('div', { class: 'bits ns-bits' }, row));
    const val = x / 2 ** P;
    read.replaceChildren(
      h('div', null, h('b', null, String(val)), h('span', null, `value = ${x} / 2^${P}`)),
      h('div', null, h('b', null, P ? `1/${2 ** P}` : '1'), h('span', null, 'step: the smallest change')),
      h('div', null, h('b', null, String((2 ** W - 1) / 2 ** P)), h('span', null, 'largest value')));
  }
  const t = h('table', { class: 'ns-t' }, h('tr', null, h('th', null, 'fraction bits'), h('th', null, 'nearest to 0.1'), h('th', null, 'error')));
  for (const k of [4, 8, 12, 16, 24]) {
    const n = Math.round(0.1 * 2 ** k);
    t.append(h('tr', null, h('td', null, String(k)), h('td', null, `${n}/${2 ** k} = ${(n / 2 ** k).toPrecision(7)}`), h('td', null, (n / 2 ** k - 0.1).toExponential(2).replace('-', '−'))));
  }
  tenth.append(t);
  render();
  const el = h('div', { class: 'widget ns' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' },
        h('div', { class: 'ns-point-row' }, h('h3', null, 'Binary point'), slider, qLab),
        h('p', { class: 'sub' }, 'The same 8 bits, read with a binary point: the bits right of it weigh ½, ¼, ⅛ … Slide the point; click the bits.'),
        ins, read),
      h('div', { class: 'panel' }, h('h3', null, '0.1 has no exact binary form'),
        h('p', { class: 'sub' }, '0.1 = 0.000110011… in binary, repeating for ever. Each fraction bit halves the worst-case error; none makes it 0.'),
        tenth)));
  return { el };
}
