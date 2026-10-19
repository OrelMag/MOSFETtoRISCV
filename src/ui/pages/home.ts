import { chapters, future } from '../../chapters';
import { checksDone } from '../../chapters/checks';
import { chapterNo } from '../../chapters/types';
import { ladder } from '../../widgets/journey';
import { chapterMark, resumeTarget } from '../chapternav';
import { h, icon } from '../dom';
import { reportLink } from '../errors';
import { settings } from '../settings';
import type { Page } from './chapter';

/** '40% seen · 2 / 5 checks' on a started chapter's card. */
function seenNote(c: (typeof chapters)[number], p: number): string {
  const { done, total } = checksDone(c, (k) => settings.isSolved(k));
  return `${Math.round(p * 100)}% seen${total ? ` · ${done} / ${total} checks` : ''}`;
}

/**
 * "Continue campaign: <level>" in place of "Play the campaign" when the campaign has been started: its own next level (graph.ts nextAvailable, as
 * the map's welcome panel offers it). Loaded only then, so the campaign's chunk stays off a plain visit's home page.
 */
function campaignLink(into: HTMLElement): void {
  try {
    if (!localStorage.getItem('mosfet2riscv:campaign:v1')) return;
  } catch { return; }
  Promise.all([import('../../campaign/progress'), import('../../campaign/graph')]).then(([{ progress }, { nextAvailable }]) => {
    const p = progress();
    if (!Object.keys(p.state.nodes).length) return;
    const next = nextAvailable(p.view, p.unlockAll);
    if (!next || !into.isConnected) return;
    into.replaceChildren(h('a', { class: 'btn', href: `#/campaign/n/${next.id}`, title: 'The next level open on the campaign map' }, icon('flag', 16), `Continue campaign: ${next.title}`));
  }, () => {});
}

export function homePage(): Page {
  const progress = (id: string, n: number) => settings.visited(id).filter((k) => k < n).length / n;
  const resume = resumeTarget(chapters, (id) => settings.visited(id), settings.lastStep());
  // "Play the campaign", replaced by "Continue campaign: <level>" once the campaign has been started
  const campaign = h('span', { class: 'cta-campaign' }, h('a', { class: 'btn', href: '#/campaign' }, icon('flag', 16), 'Play the campaign'));
  campaignLink(campaign);

  const cards = chapters.flatMap((c, i) => {
    const p = progress(c.id, c.steps.length);
    // the prologue (before the transistor) and the appendix (after the journey), behind dividers
    const prev = chapters[i - 1];
    const divider = c.appendix && !prev?.appendix ? [h('div', { class: 'cards-divider' }, 'Appendix')]
      : c.prologue && !prev?.prologue ? [h('div', { class: 'cards-divider prologue' }, 'Prologue: before the transistor')]
      : !c.prologue && !c.appendix && prev?.prologue ? [h('div', { class: 'cards-divider journey' }, 'The journey')] : [];
    // The full tick only for a finished chapter (every step seen, every check solved); all seen with checks left: a lighter mark.
    const mark = chapterMark(p, checksDone(c, (k) => settings.isSolved(k)));
    return [...divider, h('a', { class: `card${c.appendix ? ' appendix' : c.prologue ? ' prologue' : ''}`, href: `#/c/${c.id}/0` },
      mark === 'done' ? h('span', { class: 'done-badge', title: 'Finished: every step seen, every check solved', 'aria-label': 'Finished' }, icon('check', 16))
        : mark === 'seen' ? h('span', { class: 'done-badge seen', title: 'Every step seen; some checks are still open', 'aria-label': 'All steps seen' }, icon('check', 13)) : null,
      h('span', { class: 'num' }, `${chapterNo(c)} · ${c.level}`),
      h('h3', null, c.title),
      h('p', null, c.blurb),
      h('div', { class: 'meta' }, h('span', null, `${c.steps.length} steps`), h('span', null, p > 0 ? seenNote(c, p) : '')))];
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
          h('a', { class: 'btn primary', href: resume ? `#/c/${resume.chapter.id}/${resume.step}` : '#/c/map/0' },
            resume ? `${resume.next ? 'Next chapter' : 'Continue'}: ${resume.chapter.title}` : 'Start the journey', icon('chevR', 16)),
          campaign,
          h('a', { class: 'btn', href: '#/workbench/rca4' }, icon('bench', 16), 'Open the workbench'),
          h('a', { class: 'btn', href: '#/sandbox' }, icon('chip', 16), 'Open the sandbox'))),
      ladder()),
    h('h2', { class: 'section-title', id: 'chapters' }, 'Chapters'),
    h('p', { class: 'section-sub' }, 'Each chapter uses only what the previous ones built.'),
    h('div', { class: 'cards' }, cards, soon),
    h('h2', { class: 'section-title' }, 'How it works'),
    h('div', { class: 'features' },
      feature('layers', 'Transparent boxes', 'Double-click any part to open it. Breadcrumbs show the way back. It goes all the way down to transistors.'),
      feature('chip', 'Real simulation', 'Every wire value is computed: a gate-level simulator in which every NAND takes one delay unit, and a switch-level solver for transistors.'),
      feature('code', 'Real hardware description', 'Every component comes with SystemVerilog, including Verilog generated from the very schematic on screen.'),
      feature('info', 'Cost is visible', 'Transistor counts, gate counts and worst-case delays are measured from the circuit, so you can feel every trade-off.')),
    h('div', { class: 'footer' },
      'Inspired by Turing Complete, Sebastian Lague\'s Digital Logic Sim, nand2tetris, and Harris & Harris. ',
      h('a', { href: 'https://github.com/OrelMag/MOSFETtoRISCV' }, 'Source on GitHub'), ' · ',
      reportLink(undefined, 'Report a problem'), ' · ',
      h('a', { href: '#/', onclick: (e: Event) => { e.preventDefault(); if (confirm('Reset your progress?')) settings.resetProgress(); } }, 'Reset progress'),
      h('div', { class: 'footer-meta' },
        h('span', { title: `build ${__APP_COMMIT__}, ${__APP_DATE__}` }, `Version ${__APP_VERSION__}`), ' · ',
        `© ${__APP_DATE__.slice(0, 4)} OrelMag`, ' · ',
        h('a', { href: 'mailto:orelmac@gmail.com' }, 'orelmac@gmail.com')))));
  return { el, destroy() {} };
}
