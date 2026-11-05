// The map: every chapter in book order, under folding sections (chapters/sections.ts), each row saying what the chapter builds with.

import { chapterNo } from '../chapters/meta';
import { outline, outlineOf } from '../chapters/outline';
import { sectionsOf } from '../chapters/sections';
import { h, icon } from '../ui/dom';
import { settings } from '../ui/settings';
import type { Widget } from '../view/stage';

/** What a chapter's level is made of, by chapter id; a chapter not listed shows its `level`. */
const MADE_OF: Record<string, string> = {
  basics: 'voltage, binary, truth tables', map: 'levels, transparent boxes',
  relays: 'magnets, contacts', tubes: 'triodes, diodes', cards: 'holes, readers',
  mosfet: 'doped silicon', inverter: '2 transistors', nand: '4 transistors', gates: 'NAND',
  binary: 'bits', adders: 'gates', routing: 'gates',
  latches: 'gates with feedback', registers: 'flip-flops', memory: 'decoders, registers, mux trees',
  alu: 'adders, muxes', regfile: 'registers, muxes', isa: 'bits with agreed meanings', cpu: 'register file, ALU, control, memories', python: 'RV32I instructions, a stack',
  fastadd: 'prefix networks', pipeline: 'pipeline registers, hazard unit', pipepay: 'balanced stages, a branch predictor',
  io: 'byte lanes, memory-mapped I/O', traps: 'CSRs, exceptions', muldiv: 'Booth, SRT', cache: 'SRAM, tag arrays', multicycle: 'state machines, a microcode ROM', float: 'IEEE 754 units', widths: 'the C extension, RV64',
  ooo: 'renaming, a reorder buffer', multicore: 'arbiter, atomics, coherence', silicon: 'standard cells, routing, masks',
  lanes: 'one decode, four ALUs', simt: 'masks, split / join', warps: 'scoreboards, warps', feed: 'coalescing, banks', pixels: 'a rasterizer, frame buffers', graphics: 'kernels, a command unit',
  dram: 'capacitors, sense amplifiers', memctrl: 'commands, timing rules', flash: 'floating gates', bus: 'valid / ready, masters',
  message: 'bits, delay, packets, decibels', signals: 'sines, FIR filters, sampling', noise: 'Gaussian tails, spheres', telegraph: 'relays, a line', exchange: 'relays, circuits', wire: 'RC, repeaters', clocks: 'synchronizers', uart: 'a baud divider, shifters', spi: 'a shared clock, two wires', modem: 'FSK', serial: '8b/10b', errors: 'parity, CRC',
  'appendix-6502': 'NMOS, a PLA', 'appendix-doom': 'C, RV32IM', 'appendix-sap': '74xx TTL', 'appendix-runner': 'counters, gates',
};

/** Where the journey starts in earnest: until it is opened, the map offers it. */
const FIRST = 'mosfet';

/**
 * The chapter the map opens at: the one being read, else the last one in book order that was opened, else the first real chapter.
 * Start's chapters count for none of these: they lead to the journey, and a reader far along can come back to them.
 */
export function ladderFocus(seen: (chapter: string) => boolean, last?: string): string {
  const start = sectionsOf(outline)[0].chapters;
  const counts = (id: string) => !start.some((c) => c.id === id);
  if (last && outlineOf(last) && counts(last)) return last;
  return [...outline].reverse().find((c) => counts(c.id) && seen(c.id))?.id ?? FIRST;
}

/**
 * The map in a box of its own, in book order: a folding row per section with its progress, and a row per chapter. It opens scrolled to
 * the visitor's section, the only one open, its chapter marked; a new visitor's is the MOSFET, marked "Start here" (`badge`).
 */
export function ladder(opts: { badge?: boolean } = {}): HTMLElement {
  const seen = (id: string) => settings.visited(id).length > 0;
  const fresh = !seen(FIRST);
  const focus = ladderFocus(seen, settings.lastStep()?.chapter);
  const secs = sectionsOf(outline).map((s) => {
    const steps = s.chapters.reduce((n, c) => n + c.steps.length, 0);
    const done = s.chapters.reduce((n, c) => n + settings.visited(c.id).filter((k) => k < c.steps.length).length, 0);
    const pct = steps ? Math.round((100 * done) / steps) : 0;
    const rungs = s.chapters.map((c) => {
      const tag = c.id !== focus ? null : !fresh ? 'You are here' : opts.badge !== false ? 'Start here' : null;
      return h('a', { class: `rung${tag ? ' start' : ''}`, href: `#/c/${c.id}/0`, title: c.blurb, 'aria-current': tag ? 'location' : null },
        h('span', { class: 'n' }, chapterNo(c)),
        h('span', { class: 't' }, c.title),
        tag ? h('span', { class: 'start-tag' }, tag) : null,
        h('span', { class: 'c' }, MADE_OF[c.id] ?? c.level));
    });
    return h('details', { class: `ladder-sec ${s.tone}`, open: s.chapters.some((c) => c.id === focus) },
      h('summary', { class: 'ladder-head' }, icon('chevR', 14),
        h('b', null, s.name),
        s.range ? h('span', { class: 'r' }, s.range) : null,
        h('span', { class: 'ladder-bar', role: 'img', title: `${pct}% seen`, 'aria-label': `${pct}% seen` }, h('i', { style: `width:${pct}%` }))),
      h('div', { class: 'ladder-rows' }, rungs));
  });
  const box = h('nav', { class: 'ladder', 'aria-label': 'Every chapter, by section' }, secs);
  // A chip names what lies above (the fade alone read as a sliced card); it sits outside the box, which the fade masks.
  const up = h('button', { class: 'ladder-up', type: 'button', hidden: true, onclick: () => box.scrollTo({ top: 0, behavior: 'smooth' }) });
  const wrap = h('div', { class: 'ladder-wrap' }, box, up);
  // Fades at the edges that have more sections past them.
  const edges = () => {
    box.classList.toggle('more-up', box.scrollTop > 2);
    box.classList.toggle('more-down', box.scrollTop + box.clientHeight < box.scrollHeight - 2);
    const above = secs.filter((r) => r.offsetTop < box.scrollTop - 2).length;
    up.hidden = !above;
    up.textContent = `↑ ${above} section${above > 1 ? 's' : ''} above`;
  };
  box.addEventListener('scroll', edges, { passive: true });
  secs.forEach((s) => s.addEventListener('toggle', edges));
  // The open section at the box's top once it has a size (it is built before the page is attached), and again
  // while sizes settle (web fonts, a phone's wrapped rungs), until the visitor scrolls it.
  if (typeof ResizeObserver !== 'undefined') {
    const open = secs.find((s) => s.open) ?? secs[0];
    const ro = new ResizeObserver(() => {
      if (!box.clientHeight) return;
      box.scrollTop = open.offsetTop - 1;
      edges();
    });
    ro.observe(box);
    ro.observe(open);
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) box.addEventListener(ev, () => ro.disconnect(), { once: true, passive: true });
  }
  return wrap;
}

export function journeyWidget(): Widget {
  return {
    el: h('div', { class: 'widget' },
      h('div', { class: 'panel' },
        h('h3', null, 'The map'),
        h('p', { class: 'sub' }, 'Every chapter, by section, each using only what came before it. A section opens with a click; a row opens its chapter.'),
        ladder())),
  };
}
