// The analogy index (#/campaign/codex/analogies: ANALOGY_INDEX_ID, in the codex's detail pane): every analogy of the journey grouped by
// chapter, each a closed aside (its figure loads when opened) with the step that tells it and the codex entries that
// show it. A filter narrows by title, text and chapter.

import { analogyIndex } from '../chapters/analogies';
import { chapters } from '../chapters';
import { chapterNo } from '../chapters/types';
import { codexById } from '../campaign/codex';
import { analogyEl } from './analogy';
import { h, icon } from './dom';

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');

export function analogyIndexEl(): HTMLElement {
  const groups = analogyIndex(chapters);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const drawn = groups.reduce((n, g) => n + g.items.filter((x) => x.a.figure).length, 0);
  const rows: { el: HTMLElement; text: string }[] = [];
  const sections = groups.map((g) => {
    const c = chapters.find((x) => x.id === g.chapter)!;
    const head = `${chapterNo(c)} · ${c.title}`;
    const items = g.items.map(({ a, step }) => {
      const el = analogyEl(a, step >= 0 ? { from: { href: `#/c/${c.id}/${step}`, label: `Told in ${head}: ${a.step}` } } : {});
      const cx = (a.codex ?? []).map((id) => codexById(id)).filter((e) => !!e);
      if (cx.length) el.querySelector('.analogy-in')!.append(h('p', { class: 'ax-codex' }, 'In the codex: ',
        cx.map((e) => h('a', { class: 'cp-chip', href: `#/campaign/codex/${e.id}` }, e.title))));
      rows.push({ el, text: `${head} ${a.step} ${a.title} ${plain(a.body)} ${plain(a.breaks)}`.toLowerCase() });
      return el;
    });
    return { el: h('section', { class: 'ax-grp' }, h('h4', null, h('a', { href: `#/c/${c.id}` }, head)), items), items };
  });
  const empty = h('p', { class: 'sub', hidden: true }, 'No analogy matches.');
  const search = h('input', { class: 'cx-search', type: 'search', placeholder: `Filter ${total} analogies`, 'aria-label': 'Filter the analogies' });
  const toggle = (open: boolean) => { for (const r of rows) if (!r.el.hidden) (r.el as HTMLDetailsElement).open = open; };
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const r of rows) {
      r.el.hidden = !q.every((w) => r.text.includes(w));
      if (!r.el.hidden) shown++;
    }
    for (const s of sections) s.el.hidden = s.items.every((x) => x.hidden);
    empty.hidden = shown > 0;
  });
  return h('div', { class: 'cp-codex-entry ax-index' },
    h('h2', null, icon('like', 18), 'Analogies'),
    h('p', null, `A familiar picture for each abstract idea, told under the step it belongs to: ${total} in all, each with a figure to play with (${drawn} drawn here, the other ${total - drawn} as the Water view on their step). Each one says where it stops being true.`),
    h('div', { class: 'ax-tools' }, search, h('div', { class: 'ax-btns' },
      h('button', { class: 'btn sm ghost', onclick: () => toggle(true) }, 'Open all'),
      h('button', { class: 'btn sm ghost', onclick: () => toggle(false) }, 'Close all'))),
    empty, sections.map((s) => s.el));
}
