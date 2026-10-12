// Editor for multi-bit inputs: click individual bits or type a number (hex 0x.., binary 0b.., decimal),
// exact at any width (BigInt).

import { parseBig } from '../sim/values';
import { h } from '../ui/dom';

let open: HTMLElement | null = null;

export function closePopover(): void {
  open?.remove();
  open = null;
}

/** Bit buttons per row for a wide input (rows from the top bits down, LSB at the right). */
const ROW = 16;
/** Wider inputs get the text field only (a button per bit would fill the screen). */
const MAX_BUTTONS = 128;

/**
 * Edit a `width`-bit value (exact at any width: BigInt). `onChange` gets the new value, always
 * in 0 … 2^width − 1.
 */
export function editNumber(anchor: DOMRect, name: string, width: number, value: number | bigint, onChange: (v: bigint) => void): void {
  closePopover();
  const W = BigInt(width), M = 1n << W;
  const wrap = (x: bigint) => ((x % M) + M) % M;
  let v = wrap(typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(value))));
  const bits = h('div', { class: `bits${width > ROW ? ' rows' : ''}` });
  const input = h('input', { type: 'text', class: 'num-in', spellcheck: 'false' }) as HTMLInputElement;
  input.style.cssText = 'width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:600 13px var(--font-mono)';
  const button = (i: number) => {
    const on = ((v >> BigInt(i)) & 1n) === 1n;
    return h('button', {
      class: on ? 'one' : '', title: `bit ${i}`,
      onclick: () => { v ^= 1n << BigInt(i); set(); },
    }, on ? '1' : '0', h('span', { class: 'idx' }, i));
  };
  const render = () => {
    bits.replaceChildren();
    if (width <= ROW) for (let i = width - 1; i >= 0; i--) bits.append(button(i));
    else if (width <= MAX_BUTTONS) {
      for (let r = Math.ceil(width / ROW) - 1; r >= 0; r--) {
        const row = h('div', { class: 'bits-row' });
        for (let i = Math.min(width, (r + 1) * ROW) - 1; i >= r * ROW; i--) row.append(button(i));
        bits.append(row);
      }
    }
    const hex = v.toString(16).toUpperCase();
    // Wide values: hex in groups of eight digits, no decimal (hundreds of digits say nothing).
    input.value = width > 64 ? `0x${hex.replace(/\B(?=(.{8})+$)/g, '_')}` : `0x${hex}  (${v})`;
  };
  const set = () => {
    render();
    onChange(v);
  };
  input.addEventListener('change', () => {
    const n = parseBig(input.value.trim().split(/\s/)[0]);
    if (n !== null) {
      v = wrap(n);
      set();
    }
  });
  const random = () => {
    let r = 0n;
    for (let i = 0; i < width; i += 32) r = (r << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32));
    return wrap(r);
  };
  const pop = h('div', { class: 'popover' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' },
      h('b', { style: 'font-family:var(--font-mono)' }, `${name}[${width - 1}:0]`),
      h('button', { class: 'btn ghost sm', onclick: closePopover }, 'Done')),
    width > MAX_BUTTONS ? h('small', { style: 'display:block;margin:8px 0;color:var(--muted)' }, 'Type the value: hex 0x…, binary 0b… or decimal (_ separators allowed).') : bits, input,
    h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
      h('button', { class: 'btn sm', onclick: () => { v = 0n; set(); } }, '0'),
      h('button', { class: 'btn sm', onclick: () => { v = wrap(v - 1n); set(); } }, '−1'),
      h('button', { class: 'btn sm', onclick: () => { v = wrap(v + 1n); set(); } }, '+1'),
      h('button', { class: 'btn sm', onclick: () => { v = random(); set(); } }, 'random')));
  render();
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, anchor.left))}px`;
  pop.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, anchor.bottom + 6))}px`;
  open = pop;
  setTimeout(() => {
    const away = (e: PointerEvent) => {
      if (open && !open.contains(e.target as Node)) {
        closePopover();
        document.removeEventListener('pointerdown', away);
      }
    };
    document.addEventListener('pointerdown', away);
  });
}
