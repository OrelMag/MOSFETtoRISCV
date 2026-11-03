// Binary number explorer: flip bits, read the value as unsigned, signed (two's complement) and hex, see the carry (C)
// and signed-overflow (V) flags of each operation, wrap-around on the number wheel, and decimal → binary by halving.

import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/numsys.css';

export type NumWidth = 4 | 8 | 16 | 32;

export interface NumberOptions {
  /** The decimal → binary panel (repeated halving), beside the wheel or in its place. */
  halve?: boolean;
}

export function numberWidget(initialWidth: NumWidth = 8, showWheel = true, opts: NumberOptions = {}): Widget {
  let width: number = initialWidth;
  let v = initialWidth === 4 ? 0b0101 : 0b00101010;
  let message = '';
  let C = 0, V = 0;
  const bitsRow = h('div', { class: 'bits rows ns-bits' });
  const readout = h('div', { class: 'readout' });
  const flags = h('div', { class: 'ns-flags' });
  const wheelHost = h('div');
  const halveHost = h('div', { class: 'ns-scroll' });
  const msg = h('p', { class: 'sub', style: 'min-height:1.5em;margin-top:10px', 'aria-live': 'polite' });
  const widthSel = h('div', { class: 'seg' });

  // Plain arithmetic, never JS bit operators: those are signed 32-bit and go wrong at width 32.
  const max = () => 2 ** width;
  const half = () => max() / 2;
  const signed = (x: number) => (x >= half() ? x - max() : x);
  const neg = (x: number) => x >= half();

  const op = (label: string, fn: () => void) => h('button', { class: 'btn sm', onclick: () => { fn(); render(); } }, label);
  const ops = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:12px' },
    op('+1', () => {
      const before = signed(v);
      C = v === max() - 1 ? 1 : 0;
      V = v === half() - 1 ? 1 : 0;
      v = (v + 1) % max();
      message = C ? `C: ${max() - 1} + 1 wrapped around to 0 (the carry out of the top bit is lost).`
        : V ? `V: ${before} + 1 became ${signed(v)}: the signed reading passed the top and wrapped.` : '';
    }),
    op('−1', () => {
      const before = signed(v);
      // a − 1 is a + (all ones): it carries out unless a is 0
      C = v === 0 ? 0 : 1;
      V = v === half() ? 1 : 0;
      v = (v - 1 + max()) % max();
      message = v === max() - 1 ? `0 − 1 wrapped around to ${max() - 1} unsigned, which is −1 signed.`
        : V ? `V: ${before} − 1 became ${signed(v)}.` : '';
    }),
    op('NOT (invert bits)', () => { v = max() - 1 - v; C = V = 0; message = 'Inverting every bit gives −x − 1 in two\'s complement.'; }),
    op('negate (NOT, +1)', () => {
      const before = signed(v);
      C = v === 0 ? 1 : 0;
      V = v === half() ? 1 : 0;
      v = (max() - v) % max();
      message = V ? `V: ${before} has no positive partner in ${width} bits: negating it gives itself.` : `−(${before}) = ${signed(v)}. Invert all bits, then add 1.`;
    }),
    op('shift left (×2)', () => {
      const out = (v * 2) % max();
      C = neg(v) ? 1 : 0;
      V = neg(v) !== neg(out) ? 1 : 0;
      v = out;
      message = `Every bit moves one place up: ×2. The top bit falls into C${V ? '; the sign changed, so V' : ''}.`;
    }),
    op('clear', () => { v = 0; C = V = 0; message = ''; }),
  );

  for (const w of [4, 8, 16, 32]) widthSel.append(h('button', {
    'aria-label': `${w} bits`,
    onclick: () => { width = w; v = v % max(); C = V = 0; message = ''; render(); },
  }, `${w}`));

  function render(): void {
    for (const b of widthSel.querySelectorAll('button')) b.classList.toggle('on', b.textContent === `${width}`);
    // rows of eight, top bits first, a gap between nibbles
    bitsRow.replaceChildren();
    for (let r = Math.max(1, width / 8) - 1; r >= 0; r--) {
      const row = h('div', { class: 'bits-row' });
      const lo = 8 * r, hi = Math.min(width, lo + 8) - 1;
      for (let i = hi; i >= lo; i--) {
        const on = Math.floor(v / 2 ** i) % 2 === 1;
        const top = i === width - 1;
        row.append(h('button', {
          class: on ? 'one' : '',
          title: `bit ${i}: worth ${top ? `−2^${i} (signed) or 2^${i} (unsigned)` : `2^${i} = ${2 ** i}`}`,
          'aria-label': `bit ${i}, ${on ? 1 : 0}`,
          onclick: () => { v = on ? v - 2 ** i : v + 2 ** i; C = V = 0; message = ''; render(); },
        }, on ? '1' : '0', h('span', { class: 'idx' }, `${i < 10 ? 2 ** i : `2^${i}`}${top ? '*' : ''}`)));
        if (i % 4 === 0 && i > lo) row.append(h('span', { class: 'ns-gap' }));
      }
      bitsRow.append(row);
    }
    readout.replaceChildren(
      h('div', null, h('b', null, v.toString(2).padStart(width, '0').replace(/(.{4})(?=.)/g, '$1_')), h('span', null, 'binary')),
      h('div', null, h('b', null, '0x' + v.toString(16).toUpperCase().padStart(width / 4, '0')), h('span', null, 'hex: one digit per 4 bits')),
      h('div', null, h('b', null, String(v)), h('span', null, 'unsigned')),
      h('div', null, h('b', null, String(signed(v))), h('span', null, 'signed (two\'s complement)')),
    );
    flags.replaceChildren(
      h('span', { class: `ns-flag${C ? ' lit' : ''}`, title: 'Carry out of the top bit: the unsigned result wrapped' }, h('i'), 'C carry out'),
      h('span', { class: `ns-flag${V ? ' lit' : ''}`, title: 'Signed overflow: the signed result wrapped' }, h('i'), 'V signed overflow'),
    );
    msg.textContent = message;
    if (showWheel) wheelHost.replaceChildren(wheel());
    if (opts.halve) halveHost.replaceChildren(halving());
  }

  /** Decimal → binary: divide by 2, the remainders are the bits from the bottom up. */
  function halving(): HTMLElement {
    const t = h('table', { class: 'ns-t' }, h('tr', null, h('th', null, 'n'), h('th', null, 'n ÷ 2'), h('th', null, 'remainder')));
    let n = v, k = 0;
    if (n === 0) t.append(h('tr', null, h('td', null, '0'), h('td', null, '0'), h('td', null, '0 (bit 0)')));
    while (n > 0 && k < 10) {
      t.append(h('tr', null, h('td', null, String(n)), h('td', null, String(Math.floor(n / 2))), h('td', null, `${n % 2} (bit ${k})`)));
      n = Math.floor(n / 2);
      k++;
    }
    if (n > 0) t.append(h('tr', null, h('td', { colspan: '3' }, `… ${Math.floor(Math.log2(n)) + 1} more rows`)));
    return t;
  }

  /** 4 bits: 16 slots. Wider: 256 ticks for the top 8 bits (exact at 8 bits). Outer ring unsigned, inner signed. */
  function wheel(): SVGSVGElement {
    const R = 118, cx = 160, cy = 152;
    const svg = s('svg', { viewBox: '0 0 320 312', class: 'ns-wheel', role: 'img', 'aria-label': `Number wheel at ${v}, signed ${signed(v)}` });
    const n = width === 4 ? 16 : 256;
    const scale = width === 4 ? 1 : 2 ** (width - 8);
    const at = Math.floor(v / scale);
    const ang = (i: number) => (i / n) * Math.PI * 2 - Math.PI / 2;
    const xy = (i: number, r: number): [number, number] => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
    const fmt = (z: number) => (Math.abs(z) >= 1e5 ? `${z < 0 ? '−' : ''}2^${Math.log2(Math.abs(z))}` : String(z).replace('-', '−'));
    const label = (i: number) => {
      const [x, y] = xy(i, R + 15), [x2, y2] = xy(i, R - (n === 16 ? 26 : 28));
      const u = i * scale, sg = i >= n / 2 ? (i - n) * scale : u;
      svg.append(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'ns-wu' }, fmt(u)));
      svg.append(s('text', { x: x2, y: y2 + 4, 'text-anchor': 'middle', class: 'ns-ws' }, fmt(sg)));
    };
    if (n === 16) {
      for (let i = 0; i < 16; i++) {
        const [x, y] = xy(i, R);
        svg.append(s('circle', { cx: x, cy: y, r: 6, class: 'ns-dot' }));
        label(i);
      }
    } else {
      for (let i = 0; i < 256; i++) {
        const long = i % 32 === 0;
        const [x1, y1] = xy(i, R), [x2, y2] = xy(i, R - (long ? 10 : 5));
        svg.append(s('line', { x1, y1, x2, y2, class: long ? 'ns-tick long' : 'ns-tick' }));
        if (long) label(i);
      }
    }
    // the two seams: unsigned wraps between the last value and 0, signed between the largest positive and the most negative
    const seam = (i: number, cls: string) => {
      const [x1, y1] = xy(i, R - 44), [x2, y2] = xy(i, R + 6);
      svg.append(s('line', { x1, y1, x2, y2, class: cls }));
    };
    seam(-0.5, 'ns-seam-u');
    seam(n / 2 - 0.5, 'ns-seam-s');
    const [px, py] = xy(at, R - 8), [dx, dy] = xy(at, R);
    svg.append(s('line', { x1: cx, y1: cy, x2: px, y2: py, class: 'ns-hand' }));
    svg.append(s('circle', { cx: dx, cy: dy, r: 6, class: 'ns-cur' }));
    svg.append(s('text', { x: 6, y: 16, class: 'ns-wu' }, 'outer: unsigned'));
    svg.append(s('text', { x: 314, y: 16, 'text-anchor': 'end', class: 'ns-ws' }, 'inner: signed'));
    if (scale > 1) svg.append(s('text', { x: cx, y: 308, 'text-anchor': 'middle', class: 'ns-wu' }, `each tick = 2^${width - 8} values (the top 8 bits)`));
    return svg;
  }

  const side: HTMLElement[] = [];
  if (showWheel) side.push(h('div', { class: 'panel' }, h('h3', null, 'The number wheel'),
    h('p', { class: 'sub' }, 'Fixed-width numbers wrap around. The red seam is where the unsigned reading wraps (largest → 0), the amber one where the signed reading wraps (largest positive → most negative).'), wheelHost));
  if (opts.halve) side.push(h('div', { class: 'panel' }, h('h3', null, 'Decimal → binary, by halving'),
    h('p', { class: 'sub' }, 'Divide by 2 and keep the remainder: it is the next bit, lowest first. Follows the unsigned value on the left.'), halveHost));
  const el = h('div', { class: 'widget' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, h('h3', null, 'Bits → numbers'), widthSel),
        h('p', { class: 'sub' }, 'Click bits to flip them. Each bit is worth twice the one to its right. In two\'s complement the top bit is worth a negative amount (marked *).'),
        bitsRow, readout, ops, flags, msg),
      ...side));
  render();
  return { el };
}
