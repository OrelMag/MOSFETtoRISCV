import { chapters, future } from '../../chapters';
import { ladder } from '../../widgets/journey';
import { h, icon } from '../dom';
import { settings } from '../settings';
import type { Page } from './chapter';

export function homePage(): Page {
  const progress = (id: string, n: number) => settings.visited(id).length / n;
  const started = chapters.filter((c) => settings.visited(c.id).length > 0);
  const resume = started.length ? started[started.length - 1] : null;

  const cards = chapters.map((c) => {
    const p = progress(c.id, c.steps.length);
    return h('a', { class: 'card', href: `#/c/${c.id}/0` },
      p >= 1 ? h('span', { class: 'done-badge', title: 'All steps visited' }, icon('check', 16)) : null,
      h('span', { class: 'num' }, `${String(c.num).padStart(2, '0')} · ${c.level}`),
      h('h3', null, c.title),
      h('p', null, c.blurb),
      h('div', { class: 'meta' }, h('span', null, `${c.steps.length} steps`), h('span', null, p > 0 ? `${Math.round(p * 100)}% seen` : '')));
  });
  const soon = future.map((c) =>
    h('div', { class: 'card soon' },
      h('span', { class: 'num' }, `${String(c.num).padStart(2, '0')} · ${c.level}`),
      h('h3', null, c.title), h('p', null, c.blurb), h('div', { class: 'meta' }, h('span', null, 'coming soon'))));

  const feature = (ic: string, title: string, text: string) =>
    h('div', { class: 'feature' }, icon(ic, 22), h('h4', null, title), h('p', null, text));

  const el = h('div', { class: 'scroll' }, h('div', { class: 'home' },
    h('section', { class: 'hero' },
      h('div', null,
        h('div', { class: 'eyebrow' }, 'An interactive journey'),
        h('h1', null, 'From a single ', h('span', { class: 'grad' }, 'MOSFET'), ' to a ', h('span', { class: 'grad' }, 'RISC-V'), ' processor.'),
        h('p', { class: 'lead' }, 'Build a computer one level at a time. Start with a transistor, make a gate, then adders, memory, and a processor. Every box on screen is transparent: open it and keep going down until you reach silicon.'),
        h('div', { class: 'cta' },
          h('a', { class: 'btn primary', href: resume ? `#/c/${resume.id}/0` : '#/c/map/0' }, resume ? `Continue: ${resume.title}` : 'Start the journey', icon('chevR', 16)),
          h('a', { class: 'btn', href: '#/workbench/rca4' }, icon('bench', 16), 'Open the workbench'))),
      ladder()),
    h('h2', { class: 'section-title', id: 'chapters' }, 'Chapters'),
    h('p', { class: 'section-sub' }, 'Each chapter uses only what the previous ones built.'),
    h('div', { class: 'cards' }, cards, soon),
    h('h2', { class: 'section-title' }, 'How it works'),
    h('div', { class: 'features' },
      feature('layers', 'Transparent boxes', 'Double-click any part to open it. Breadcrumbs show the way back. It goes all the way down to transistors.'),
      feature('chip', 'Real simulation', 'Every wire value is computed: a gate-level simulator with real delays, and a switch-level solver for transistors.'),
      feature('code', 'Real hardware description', 'Every component comes with SystemVerilog, including Verilog generated from the very schematic on screen.'),
      feature('info', 'Cost is visible', 'Transistor counts, gate counts and worst-case delays are measured from the circuit, so you can feel every trade-off.')),
    h('div', { class: 'footer' },
      'Inspired by Turing Complete, Sebastian Lague\'s Digital Logic Sim, nand2tetris, and Harris & Harris. ',
      h('a', { href: 'https://github.com/OrelMag/MOSFETtoRISCV' }, 'Source on GitHub'), ' · ',
      h('a', { href: '#/', onclick: (e: Event) => { e.preventDefault(); if (confirm('Reset your progress?')) settings.resetProgress(); } }, 'Reset progress'))));
  return { el, destroy() {} };
}
