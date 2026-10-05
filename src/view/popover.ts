// Editor for multi-bit inputs: click individual bits or type a number (hex 0x.., binary 0b.., decimal).

import { mask } from '../sim/values';
import { h } from '../ui/dom';

let open: HTMLElement | null = null;

export function closePopover(): void {
  open?.remove();
  open = null;
}

export function editNumber(anchor: DOMRect, name: string, width: number, value: number, onChange: (v: number) => void): void {
  closePopover();
  let v = value;
  const bits = h('div', { class: 'bits' });
  const input = h('input', { type: 'text', class: 'num-in', spellcheck: 'false' }) as HTMLInputElement;
  input.style.cssText = 'width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:600 13px var(--font-mono)';
  const render = () => {
    bits.replaceChildren();
    for (let i = width - 1; i >= 0; i--) {
      const on = Math.floor(v / 2 ** i) % 2 === 1;
      bits.append(h('button', {
        class: on ? 'one' : '', title: `bit ${i}`,
        onclick: () => { v = on ? v - 2 ** i : v + 2 ** i; set(); },
      }, on ? '1' : '0', h('span', { class: 'idx' }, i)));
    }
    input.value = `0x${v.toString(16).toUpperCase()}  (${v})`;
  };
  const set = () => {
    render();
    onChange(v);
  };
  input.addEventListener('change', () => {
    const t = input.value.trim().split(/\s/)[0].toLowerCase();
    const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : parseInt(t, 10);
    if (!Number.isNaN(n)) {
      v = ((n % (mask(width) + 1)) + (mask(width) + 1)) % (mask(width) + 1);
      set();
    }
  });
  const pop = h('div', { class: 'popover' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' },
      h('b', { style: 'font-family:var(--font-mono)' }, `${name}[${width - 1}:0]`),
      h('button', { class: 'btn ghost sm', onclick: closePopover }, 'Done')),
    bits, input,
    h('div', { style: 'display:flex;gap:6px;margin-top:8px' },
      h('button', { class: 'btn sm', onclick: () => { v = 0; set(); } }, '0'),
      h('button', { class: 'btn sm', onclick: () => { v = (v + mask(width)) % (mask(width) + 1); set(); } }, '−1'),
      h('button', { class: 'btn sm', onclick: () => { v = (v + 1) % (mask(width) + 1); set(); } }, '+1'),
      h('button', { class: 'btn sm', onclick: () => { v = Math.floor(Math.random() * (mask(width) + 1)); set(); } }, 'random')));
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
