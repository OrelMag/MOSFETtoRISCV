// The Examples gallery: the toolbar's Examples button opens it (memui.ts, loaded on the first click, so neither this nor its styles
// are in the first load). Cards in four sections with a thumbnail drawn at build time from the example's own circuit
// (editor/examplethumb.ts → examples/<id>.svg; a missing file leaves the placeholder), a search box over name and blurb, arrow keys
// between the cards. A card loads the example as a new chip, as the menu did.
import '../styles/examplegallery.css';
import { coarsePointer, h, icon, rememberFocus, undoKey } from '../ui/dom';
import type { Editor } from './editor';
import { filterExamples } from './examplefilter';
import { addExample, EXAMPLES, type Example } from './examples';

let closeGallery: (() => void) | null = null;

/** The card nearest below / above `from` (arrows up and down), or the neighbour in reading order (left and right). */
export function nextCard(cards: HTMLElement[], from: number, key: string): number {
  if (from < 0) return cards.length ? 0 : -1;
  if (key === 'ArrowRight') return Math.min(cards.length - 1, from + 1);
  if (key === 'ArrowLeft') return Math.max(0, from - 1);
  const r = cards[from].getBoundingClientRect();
  const cx = r.left + r.width / 2, down = key === 'ArrowDown';
  let best = -1, bestD = Infinity;
  cards.forEach((c, i) => {
    const q = c.getBoundingClientRect();
    if (down ? q.top < r.bottom - 4 : q.bottom > r.top + 4) return; // another row only
    const d = Math.abs(down ? q.top - r.bottom : r.top - q.bottom) * 4 + Math.abs(q.left + q.width / 2 - cx);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best < 0 ? from : best;
}

export function openExamplesGallery(ed: Editor): void {
  if (closeGallery) return closeGallery();
  // Esc puts the focus back on the Examples button (or what opened it: More, the empty chip's card)
  const back = rememberFocus(() => ed.actionAnchor('examples') ?? ed.view.svg);
  const search = h('input', { class: 'ex-search', type: 'search', placeholder: 'Search examples', 'aria-label': 'Search examples', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const body = h('div', { class: 'ex-body' });
  const empty = h('p', { class: 'ex-empty', role: 'status' });
  const close = () => {
    ov.remove();
    closeGallery = null;
    back();
  };
  const pick = (ex: Example) => {
    let id = '';
    ed.editWs((ws) => { const a = addExample(ws, ex); id = a.id; return a.ws; });
    ov.remove();
    closeGallery = null;
    ed.view.svg.focus({ preventScroll: true });
    ed.toast(`Loaded “${ed.ws.chips[id]?.name ?? ex.name}” (${undoKey()} removes it)`);
  };
  const card = (ex: Example) => {
    const thumb = h('div', { class: 'ex-thumb' });
    const img = h('img', { src: `examples/${ex.id}.svg`, alt: '', loading: 'lazy', decoding: 'async', width: 160, height: 100 });
    img.onerror = () => img.remove(); // no thumbnail (the dev server): the placeholder stays
    thumb.append(img);
    return h('button', { class: 'ex-card', type: 'button', 'data-example': ex.id, title: ex.blurb, onclick: () => pick(ex) },
      thumb, h('span', { class: 'ex-name' }, ex.name), h('span', { class: 'ex-blurb' }, ex.short),
      ex.drawer ? h('span', { class: 'ex-tag' }, 'CPU drawer') : null);
  };
  const cards = () => [...body.querySelectorAll<HTMLElement>('.ex-card')];
  // cards are built once; the filter hides the ones that miss and the sections with none
  const built = new Map(EXAMPLES.map((ex) => [ex.id, card(ex)]));
  const sections = filterExamples(EXAMPLES, '').map((g) => ({ g, el: h('section', { class: 'ex-group' }, h('h4', null, g.title), h('div', { class: 'ex-grid' }, g.items.map((e) => built.get(e.id)!))) }));
  body.append(...sections.map((s) => s.el));
  const refresh = () => {
    const hits = filterExamples(EXAMPLES, search.value);
    const shown = new Set(hits.flatMap((g) => g.items.map((e) => e.id)));
    for (const [id, el] of built) el.hidden = !shown.has(id);
    for (const s of sections) s.el.hidden = !hits.some((g) => g.id === s.g.id);
    empty.hidden = shown.size > 0;
    empty.textContent = shown.size ? '' : `No example matches “${search.value.trim()}”.`;
  };
  search.addEventListener('input', refresh);
  refresh();
  const ov = h('div', { class: 'sb-help ex-gallery', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Examples', onclick: (e: Event) => { if (e.target === ov) close(); } },
    h('div', { class: 'panel ex-panel' },
      h('div', { class: 'ex-head' }, h('h3', null, 'Examples'), search,
        h('span', { class: 'ex-hint' }, 'Opens as a new chip · Esc closes'),
        h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
      body, empty));
  function onKey(e: KeyboardEvent): void {
    e.stopPropagation(); // the editor's shortcuts stay out of the dialog
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
    if (e.key === 'Enter' && document.activeElement === search) { // one match left: Enter opens it
      const one = cards().filter((c) => !c.hidden && !c.closest('[hidden]'));
      if (one.length === 1) { e.preventDefault(); one[0].click(); }
      return;
    }
    if (!/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
    const list = cards().filter((c) => !c.hidden && !c.closest('[hidden]'));
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (document.activeElement === search) {
      if (e.key === 'ArrowDown') { e.preventDefault(); list[0].focus(); }
      return; // left and right move the caret
    }
    if (at < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && nextCard(list, at, e.key) === at) return search.focus();
    list[nextCard(list, at, e.key)].focus();
  }
  ov.addEventListener('keydown', onKey);
  closeGallery = close;
  ed.claimMenu(close);
  ed.el.append(ov);
  if (!coarsePointer()) search.focus(); // a phone's keyboard would cover the list at once
}
