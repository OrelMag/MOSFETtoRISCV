// Binary number explorer: flip bits, read the value as unsigned, signed (two's complement)
// and hex, and see wrap-around on the number wheel.

import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';

export function numberWidget(initialWidth: 4 | 8 = 8, showWheel = true): Widget {
  let width: number = initialWidth;
  let v = initialWidth === 8 ? 0b00101010 : 0b0101;
  let message = '';
  const bitsRow = h('div', { class: 'bits', style: 'justify-content:center;gap:6px' });
  const readout = h('div', { class: 'readout' });
  const wheelHost = h('div');
  const msg = h('p', { class: 'sub', style: 'min-height:1.5em;margin-top:10px' });
  const widthSel = h('div', { class: 'seg' });

  const max = () => 2 ** width;
  const signed = (x: number) => (x >= max() / 2 ? x - max() : x);

  const op = (label: string, fn: () => void) => h('button', { class: 'btn sm', onclick: () => { fn(); render(); } }, label);
  const ops = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:12px' },
    op('+1', () => {
      const before = signed(v);
      v = (v + 1) % max();
      message = v === 0 ? `Unsigned overflow: ${max() - 1} + 1 wrapped around to 0 (the carry out is lost).`
        : signed(v) < before ? `Signed overflow: ${before} + 1 became ${signed(v)}: the sign bit flipped.` : '';
    }),
    op('−1', () => {
      const before = signed(v);
      v = (v - 1 + max()) % max();
      message = v === max() - 1 ? `0 − 1 wrapped around to ${max() - 1} unsigned, which is −1 signed.`
        : signed(v) > before ? `Signed overflow: ${before} − 1 became ${signed(v)}.` : '';
    }),
    op('NOT (invert bits)', () => { v = max() - 1 - v; message = 'Inverting every bit gives −x − 1 in two\'s complement.'; }),
    op('negate (NOT, +1)', () => {
      const before = signed(v);
      v = (max() - v) % max();
      message = before === -max() / 2 ? `${before} has no positive partner in ${width} bits: negating it gives itself.` : `−(${before}) = ${signed(v)}. Invert all bits, then add 1.`;
    }),
    op('shift left (×2)', () => { v = (v * 2) % max(); message = 'Every bit moves one place up: multiply by 2 (bits falling off the top are lost).'; }),
    op('clear', () => { v = 0; message = ''; }),
  );

  for (const w of [4, 8]) widthSel.append(h('button', {
    onclick: () => { width = w; v = v % max(); message = ''; render(); },
  }, `${w} bits`));

  function render(): void {
    for (const b of widthSel.querySelectorAll('button')) b.classList.toggle('on', b.textContent === `${width} bits`);
    bitsRow.replaceChildren();
    for (let i = width - 1; i >= 0; i--) {
      const on = Math.floor(v / 2 ** i) % 2 === 1;
      bitsRow.append(h('button', {
        class: on ? 'one' : '', style: 'width:40px;height:52px;font-size:18px',
        title: `bit ${i}: worth ${i === width - 1 ? `−${2 ** i} (signed) or ${2 ** i} (unsigned)` : 2 ** i}`,
        onclick: () => { v = on ? v - 2 ** i : v + 2 ** i; message = ''; render(); },
      }, on ? '1' : '0', h('span', { class: 'idx', style: 'font-size:10px' }, i === width - 1 ? `${2 ** i}*` : 2 ** i)));
    }
    readout.replaceChildren(
      h('div', null, h('b', null, v.toString(2).padStart(width, '0').replace(/(.{4})(?=.)/g, '$1_')), h('span', null, 'binary')),
      h('div', null, h('b', null, '0x' + v.toString(16).toUpperCase().padStart(width / 4, '0')), h('span', null, 'hex: one digit per 4 bits')),
      h('div', null, h('b', null, String(v)), h('span', null, 'unsigned')),
      h('div', null, h('b', null, String(signed(v))), h('span', null, 'signed (two\'s complement)')),
    );
    msg.textContent = message;
    wheelHost.replaceChildren(showWheel ? wheel() : '');
  }

  function wheel(): SVGSVGElement {
    const n = width === 4 ? 16 : 16; // 8-bit: show the 16 values around the current one region-wise
    const R = 120, cx = 160, cy = 150;
    const svg = s('svg', { viewBox: '0 0 320 300', style: 'width:100%;max-width:340px;display:block;margin:0 auto' });
    const style = s('style');
    style.textContent = `.wv{font:600 11px var(--font-mono);fill:var(--text-2)} .ws{font:600 11px var(--font-mono);fill:var(--accent)}
      .wcur{fill:var(--w1)} .wtick{fill:var(--surface-3)} .wover{stroke:var(--wx);stroke-width:3;fill:none;stroke-dasharray:4 3}`;
    svg.append(style);
    // For 8 bits, the wheel shows the top 4 bits (each slot spans 16 values).
    const slot = width === 4 ? v : Math.floor(v / 16);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      svg.append(s('circle', { cx: x, cy: y, r: 15, class: i === slot ? 'wcur' : 'wtick' }));
      const uns = width === 4 ? i : i * 16;
      const sg = width === 4 ? (i >= 8 ? i - 16 : i) : (i >= 8 ? (i - 16) * 16 : i * 16);
      svg.append(s('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'wv', style: i === slot ? 'fill:#fff' : '' }, String(uns)));
      const x2 = cx + Math.cos(a) * (R - 36), y2 = cy + Math.sin(a) * (R - 36);
      svg.append(s('text', { x: x2, y: y2 + 4, 'text-anchor': 'middle', class: 'ws' }, String(sg)));
    }
    // The signed overflow boundary sits between 7 and 8 (bottom of the wheel).
    const a1 = (7.5 / n) * Math.PI * 2 - Math.PI / 2;
    svg.append(s('line', { x1: cx + Math.cos(a1) * (R - 60), y1: cy + Math.sin(a1) * (R - 60), x2: cx + Math.cos(a1) * (R + 22), y2: cy + Math.sin(a1) * (R + 22), class: 'wover' }));
    svg.append(s('text', { x: cx, y: cy - 6, 'text-anchor': 'middle', class: 'wv' }, 'outer: unsigned'));
    svg.append(s('text', { x: cx, y: cy + 10, 'text-anchor': 'middle', class: 'ws' }, 'inner: signed'));
    svg.append(s('text', { x: cx, y: 296, 'text-anchor': 'middle', class: 'wv', style: 'fill:var(--wx)' }, 'signed overflow boundary'));
    if (width === 8) svg.append(s('text', { x: cx, y: 14, 'text-anchor': 'middle', class: 'wv' }, 'each slot = 16 values (top 4 bits)'));
    return svg;
  }

  const el = h('div', { class: 'widget' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, h('h3', null, 'Bits → numbers'), widthSel),
        h('p', { class: 'sub' }, 'Click bits to flip them. Each bit is worth twice the one to its right. In two\'s complement the top bit is worth a negative amount (marked *).'),
        bitsRow, readout, ops, msg),
      h('div', { class: 'panel' }, h('h3', null, 'The number wheel'), h('p', { class: 'sub' }, 'Fixed-width numbers wrap around. The same bits mean different numbers depending on how we read them.'), wheelHost)));
  render();
  return { el };
}
