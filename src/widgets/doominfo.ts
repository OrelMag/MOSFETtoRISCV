// Appendix B's first steps: what Doom asks of a computer, the program GCC made of it (measured from
// public/doom/doom.img and its symbols), and the machine's memory map.

import { decode, disasm } from '../riscv/isa';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import type { DoomSymbol } from '../doom/image';

const fmt = (n: number) => Math.round(n).toLocaleString('en');
const hex = (n: number, d = 8) => (n >>> 0).toString(16).padStart(d, '0');

/** B.1: Doom's needs against the system CPU of chapters 19–21, and what Appendix B adds. */
export function doomNeeds(): Widget {
  const rows: [string, string, string, string][] = [
    ['ISA', '32-bit integers, multiply and divide; fixed point, no floats', 'RV32IM + Zicsr, machine mode', 'nothing'],
    ['Memory', '6 MiB zone heap + 400 KB of data and bss + a stack', '2⁵ … 2¹⁶ words (128 B … 256 KiB)', '8 MiB of RAM (2²¹ words in byte banks)'],
    ['Game data', 'a WAD file: Freedoom is 28.8 MB', 'none', 'a read-only region at 0x1000_0000, the file\'s bytes'],
    ['Screen', '320 × 200, 256 colours from a palette', 'a console, 8 LEDs', 'a frame buffer of palette indices + 256 palette registers'],
    ['Keys', 'press and release events', '8 switches', 'KEY: a load takes the oldest event'],
    ['Time', 'milliseconds since start', 'mtime, a 32-bit cycle counter', 'nothing: time = cycles / 40 000 (40 MHz), extended to 64 bits in software'],
    ['Work', 'measured: 1.0–3.0 M cycles a frame (median 1.9 M)', 'about 2 400 cycles/s on the gates in a page', 'a fast interpreter of the same ISA (≈ 90 M instructions/s)'],
  ];
  const el = h('div', { class: 'doom-info' },
    h('table', { class: 'doom-table' },
      h('thead', null, h('tr', null, ['', 'Doom needs', 'Our system CPU had', 'Appendix B adds'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, h('th', null, r[0]), h('td', null, r[1]), h('td', null, r[2]), h('td', null, r[3]))))));
  return { el };
}

/** B.2: the program image, measured. */
export function doomProgram(): Widget {
  const el = h('div', { class: 'doom-info' }, h('p', { class: 'muted' }, 'Reading the program…'));
  let alive = true;
  Promise.all([
    fetch('doom/doom.img').then((r) => r.arrayBuffer()),
    fetch('doom/doom.syms.json').then((r) => r.json() as Promise<DoomSymbol[]>),
    import('../doom/image'),
  ]).then(([buf, syms, img]) => {
    if (!alive) return;
    const im = img.parseImage(buf);
    // what GCC emitted: every instruction word of the image by class
    const cls = new Map<string, number>();
    const classOf = (name: string, op: number): string => {
      if (/^(lb|lh|lw|lbu|lhu)$/.test(name)) return 'loads';
      if (/^(sb|sh|sw)$/.test(name)) return 'stores';
      if (/^b/.test(name)) return 'branches';
      if (name === 'jal' || name === 'jalr') return 'jumps and calls';
      if (/^(mul|div|rem)/.test(name)) return 'multiply / divide';
      if (op === 0x73) return 'system (CSR, ecall, mret)';
      if (name === 'unknown') return 'not an instruction';
      return 'ALU, lui, auipc';
    };
    for (const w of im.text) { const d = decode(w); const c = classOf(d.name, d.opcode); cls.set(c, (cls.get(c) ?? 0) + 1); }
    const n = im.text.length;
    const top = syms.slice().sort((a, b) => b[1] - a[1]).slice(0, 10);
    const col = syms.find((x) => x[2] === 'R_DrawColumn');
    const loop: [number, string][] = [];
    if (col) for (let a = col[0]; a < col[0] + col[1]; a += 4) loop.push([a, disasm(im.text[a >>> 2], a)]);
    el.replaceChildren(
      h('div', { class: 'doom-facts' },
        h('div', null, h('b', null, fmt(n)), h('span', null, `instruction words (${fmt(4 * n / 1024)} KiB of ROM)`)),
        h('div', null, h('b', null, fmt(im.data.length)), h('span', null, `words of initial data at 0x${hex(im.dataBase)}`)),
        h('div', null, h('b', null, fmt(im.bssEnd - im.dataBase - 4 * im.data.length)), h('span', null, 'bytes of zeroed data (bss)')),
        h('div', null, h('b', null, fmt(syms.length)), h('span', null, 'functions'))),
      h('div', { class: 'doom-cols' },
        h('div', null, h('h4', null, 'Every word GCC emitted'),
          h('div', { class: 'doom-prof' }, [...cls].sort((a, b) => b[1] - a[1]).map(([k, v]) => [
            h('span', { class: 'k' }, k), h('span', { class: 't' }, h('i', { style: `width:${(100 * v) / n}%` })), h('span', { class: 'v' }, `${((100 * v) / n).toFixed(1)} %`)]))),
        h('div', null, h('h4', null, 'The largest functions, in instructions'),
          h('div', { class: 'doom-prof' }, top.map(([, size, name]) => [
            h('span', { class: 'k' }, name), h('span', { class: 't' }, h('i', { style: `width:${(100 * size) / top[0][1]}%` })), h('span', { class: 'v' }, `${fmt(size / 4)}`)])))),
      ...(col ? [h('div', null, h('h4', null, `R_DrawColumn: one wall column, ${loop.length} instructions`),
        h('div', { class: 'doom-listing mono' }, loop.map(([a, t]) => h('div', null, h('span', null, hex(a, 5)), h('span', null, t)))))] : []),
    );
  }).catch((e: unknown) => { el.replaceChildren(h('p', null, `Could not read the program: ${String(e)}`)); });
  return { el, destroy() { alive = false; } };
}

/** B.3: the memory map, drawn. */
export function doomMemoryMap(): Widget {
  const regions: [string, string, string, string][] = [
    ['0x0000_0000', 'RAM · 8 MiB', 'code\'s data, the zone heap, the stack (wraps every 8 MiB)', 'mem'],
    ['0x1000_0000', 'WAD · read only', 'the game data file, byte for byte (WADLEN bytes)', 'rom'],
    ['0x8000_0000', 'Devices', 'register = addr[4:2]', 'io'],
    ['0xC000_0000', 'Frame buffer', '320 × 200 bytes, a palette index each; palette at 0xC001_0000', 'fb'],
  ];
  const regs: [string, string][] = [
    ['+0x00', 'CONSOLE: a store prints its low byte'], ['+0x04', 'LEDS'], ['+0x08', 'SWITCHES (read 0)'], ['+0x0C', 'WADLEN: the WAD\'s length in bytes'],
    ['+0x10', 'MTIME: cycles since power-on (inside the core)'], ['+0x14', 'MTIMECMP (inside the core)'], ['+0x18', 'KEY: a load takes one event: bit 8 pressed, bits 7:0 the key'], ['+0x1C', 'FLIP: a store says the frame is complete'],
  ];
  const W = 560, rowH = 58;
  const svg = s('svg', { viewBox: `0 0 ${W} ${regions.length * rowH + 4}`, class: 'doom-map', role: 'img', 'aria-label': 'The Doom computer\'s memory map' },
    regions.map(([a, name, what, k], i) => s('g', { class: `r-${k}` },
      s('text', { x: 130, y: i * rowH + 20, 'text-anchor': 'end', class: 'addr' }, a),
      s('rect', { x: 142, y: i * rowH + 4, width: 400, height: rowH - 10, rx: 6 }),
      s('text', { x: 158, y: i * rowH + 26, class: 'name' }, name),
      s('text', { x: 158, y: i * rowH + 42, class: 'what' }, what))));
  const el = h('div', { class: 'doom-info' }, svg,
    h('h4', null, 'The devices: 0x8000_0000 + offset'),
    h('table', { class: 'doom-table compact' }, h('tbody', null, regs.map(([o, t]) => h('tr', null, h('td', { class: 'mono' }, o), h('td', null, t))))));
  return { el };
}
