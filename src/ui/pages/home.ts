import { outline as chapters, future } from '../../chapters/outline';
import { checksDone } from '../../chapters/checks';
import { chapterNo, type ChapterMeta } from '../../chapters/meta';
import { sectionsOf } from '../../chapters/sections';
import { ladder } from '../../widgets/journey';
import { chapterMark, resumeTarget } from '../chapternav';
import { h, icon, tx } from '../dom';
import { reportLink } from '../errors';
import { learn } from '../../learn/store';
import { notes } from '../notes';
import { settings } from '../settings';
import type { Page } from './chapter';

/** '40% seen · 2 / 5 checks' on a started chapter's card. */
function seenNote(c: ChapterMeta, p: number): string {
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
    into.replaceChildren(h('a', { class: 'btn ghost', href: `#/campaign/n/${next.id}`, title: 'The next level open on the campaign map' }, icon('flag', 16), `Continue campaign: ${next.title}`));
  }, () => {});
}

export function homePage(): Page {
  const progress = (id: string, n: number) => settings.visited(id).filter((k) => k < n).length / n;
  const resume = resumeTarget(chapters, (id) => settings.visited(id), settings.lastStep());
  const path = !!learn().state.start;
  // "Play the campaign", replaced by "Continue campaign: <level>" once the campaign has been started
  const campaign = h('span', { class: 'cta-campaign' }, h('a', { class: 'btn ghost', href: '#/campaign' }, icon('flag', 16), 'Play the campaign'));
  campaignLink(campaign);

  const card = (c: ChapterMeta) => {
    const p = progress(c.id, c.steps.length);
    // The full tick only for a finished chapter (every step seen, every check solved); all seen with checks left: a lighter mark.
    const mark = chapterMark(p, checksDone(c, (k) => settings.isSolved(k)));
    return h('a', { class: `card${c.appendix ? ' appendix' : c.prologue ? ' prologue' : ''}`, href: `#/c/${c.id}/0` },
      mark === 'done' ? h('span', { class: 'done-badge', title: 'Finished: every step seen, every check solved', 'aria-label': 'Finished' }, icon('check', 16))
        : mark === 'seen' ? h('span', { class: 'done-badge seen', title: 'Every step seen; some checks are still open', 'aria-label': 'All steps seen' }, icon('check', 13)) : null,
      h('span', { class: 'num' }, `${chapterNo(c)} · ${c.level}`),
      h('h3', null, c.title),
      h('p', null, c.blurb),
      h('div', { class: 'meta' }, h('span', null, `${c.steps.length} steps`), h('span', null, p > 0 ? seenNote(c, p) : '')));
  };
  // Under the book's sections (chapters/sections.ts), as on the map and in the chapter menu
  const cards = sectionsOf(chapters).flatMap((s) => [
    h('div', { class: `cards-divider ${s.tone}`, role: 'heading', 'aria-level': 3 }, s.range ? `${s.name} · ${s.range}` : s.name),
    ...s.chapters.map(card)]);
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
        h('h1', null, 'From a ', h('span', { class: 'grad' }, 'switch'), ' to a ', h('span', { class: 'grad' }, 'CPU'), ': RISC-V and beyond.'),
        h('p', { class: 'lead' }, 'Build a computer one level at a time. Start with a MOSFET, make a gate, then adders, memory and a processor, and go on to GPUs, memory systems and networks. Every box on screen is transparent: open it and keep going down until you reach silicon.'),
        // One way forward, then the rest as quiet links: five equal buttons wrapped unevenly and moved when the campaign link grew.
        h('div', { class: 'cta' },
          // A path chosen: continue it. A first visit: where to start. Otherwise the resume button, with My path beside it.
          path ? h('a', { class: 'btn primary', href: '#/path' }, 'Continue your path', icon('chevR', 16))
            : !resume ? h('a', { class: 'btn primary', href: '#/start' }, 'Where are you starting?', icon('chevR', 16)) : null,
          resume ? h('a', { class: `btn${path ? '' : ' primary'}`, href: `#/c/${resume.chapter.id}/${resume.step}` },
            `${resume.next ? 'Next chapter' : 'Continue'}: ${resume.chapter.title}`, path ? null : icon('chevR', 16)) : null),
        h('div', { class: 'cta-more' },
          !path && resume ? h('a', { class: 'btn ghost', href: '#/path' }, icon('layers', 16), 'My path') : null,
          campaign,
          h('a', { class: 'btn ghost', href: '#/workbench/rca4' }, icon('bench', 16), 'Workbench'),
          h('a', { class: 'btn ghost', href: '#/sandbox' }, icon('chip', 16), 'Sandbox'),
          notes().count ? h('a', { class: 'btn ghost', href: '#/notes', title: 'Your notes and bookmarks, and the review queue' }, icon('note', 16), `My notes · ${notes().count}`) : null)),
      h('div', { class: 'hero-ladder' }, h('p', { class: 'ladder-cap' }, 'Every chapter, by section, each using only what came before it. Your section starts open.'), ladder({ badge: false }))),
    h('h2', { class: 'section-title', id: 'chapters' }, 'Chapters'),
    h('p', { class: 'section-sub' }, 'Each chapter uses only what the previous ones built.'),
    h('div', { class: 'cards' }, cards, soon),
    h('h2', { class: 'section-title' }, 'How it works'),
    h('div', { class: 'features' },
      feature('layers', 'Transparent boxes', tx('Double-click any part to open it. Breadcrumbs show the way back. It goes all the way down to transistors.', 'Double-tap any part to open it. Breadcrumbs show the way back. It goes all the way down to transistors.')),
      feature('chip', 'Real simulation', 'Every wire value is computed: a gate-level simulator in which every NAND takes one delay unit, and a switch-level solver for transistors.'),
      feature('code', 'Real hardware description', 'Every component comes with SystemVerilog, including Verilog generated from the very schematic on screen.'),
      feature('info', 'Cost is visible', 'Transistor counts, gate counts and worst-case delays are measured from the circuit, so you can feel every trade-off.')),
    h('div', { class: 'footer' },
      'Inspired by Turing Complete, Sebastian Lague\'s Digital Logic Sim, nand2tetris, and Harris & Harris. ',
      h('a', { href: 'https://github.com/OrelMag/MOSFETtoRISCV' }, 'Source on GitHub'), ' · ',
      reportLink(undefined, 'Report a problem'), ' · ',
      h('a', { href: '#/', title: 'One backup file: chapters, campaign, puzzles and every sandbox project', onclick: (e: Event) => { e.preventDefault(); void import('../backupui').then((m) => m.exportBackup()); } }, 'Export all progress'), ' · ',
      h('a', { href: '#/', title: 'Merge a backup file into what you have; nothing is lost', onclick: (e: Event) => { e.preventDefault(); void import('../backupui').then((m) => m.importBackup()); } }, 'Import progress…'), ' · ',
      h('a', { href: '#/', onclick: (e: Event) => { e.preventDefault(); void import('../backupui').then((m) => m.resetProgressDialog(() => settings.resetProgress())); } }, 'Reset progress'),
      h('div', { class: 'footer-meta' },
        h('span', { title: `build ${__APP_COMMIT__}, ${__APP_DATE__}` }, `Version ${__APP_VERSION__}`), ' · ',
        `© ${__APP_DATE__.slice(0, 4)} `,
        h('a', { href: 'mailto:orelmac@gmail.com', title: 'Write to Orel Magidish' }, 'Orel Magidish')))));
  return { el, destroy() {} };
}
