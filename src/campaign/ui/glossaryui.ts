// Hover definitions: marks the first mention of each codex term in a block of prose (outside links,
// code and headings) and shows the entry's summary in a card on hover or focus, with a link to the
// codex. Loaded on demand by the chapter page and the level screen.

import '../../styles/glossary.css';
import { analogiesForCodex } from '../../chapters/analogies';
import { h, icon } from '../../ui/dom';
import { CODEX_KINDS, codexById } from '../codex';
import { Glossary, GLOSS_SKIP } from '../glossary';

/** A chapter's skip set for markTerms (the GPU act's terms before chapter 29). */
export { chapterSkip } from '../glossary';

let gloss: Glossary | null = null;
let card: HTMLElement | null = null;
/** The term whose card is open (it is described by the card while open). */
let current: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Opens an entry where the reader is instead of the codex page (the level screen: its pane keeps the circuit). */
let opener: ((id: string) => void) | null = null;

/** Set (or clear, null) where a card's "Open in the codex" goes. */
export function setCodexOpener(f: ((id: string) => void) | null): void {
  opener = f;
}

const SKIP = GLOSS_SKIP;

/**
 * Mark the first mention of each term in `root` (at most `max` marks); `skip` ids are not marked. `later(id)`: where a
 * term the reader has not been taught yet is built ("chapter 3, NAND gate"), said on its card; null when it is known.
 */
export function markTerms(root: HTMLElement, max = 10, skip: ReadonlySet<string> = new Set(), later?: (id: string) => string | null): void {
  gloss ??= new Glossary();
  const seen = new Set(skip);
  let n = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) texts.push(t as Text);
  for (const t of texts) {
    if (n >= max) break;
    const s = t.data;
    const ms = gloss.find(s).filter((m) => {
      if (seen.has(m.id) || n >= max) return false;
      seen.add(m.id);
      n++;
      return true;
    });
    if (!ms.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const m of ms) {
      frag.append(s.slice(at, m.start));
      const ahead = later?.(m.id);
      const el = h('span', { class: ahead ? 'gl later' : 'gl', tabindex: '0', 'data-cx': m.id, 'data-later': ahead ?? null }, s.slice(m.start, m.end));
      wire(el, m.id);
      frag.append(el);
      at = m.end;
    }
    frag.append(s.slice(at));
    t.replaceWith(frag);
  }
}

/** Hover, focus and keyboard behaviour of one marked term. */
function wire(el: HTMLElement, id: string): void {
  el.addEventListener('mouseenter', () => show(el));
  el.addEventListener('focus', () => show(el));
  el.addEventListener('mouseleave', hideSoon);
  el.addEventListener('blur', hideSoon);
  // keyboard: Enter takes the term to its codex entry (the card's link is out of the tab order, below the page), Esc closes the card
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && card && !card.hidden) { hideGlossary(); ev.stopPropagation(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); openEntry(id); }
  });
}

/** Terms a caller marked itself (`.gl[data-wire]`, ui/quiz.ts: an explanation in place folded into a hover card). */
export function wireTerms(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.gl[data-wire]')) {
    el.removeAttribute('data-wire');
    wire(el, el.dataset.cx ?? '');
  }
}

/** The codex terms mentioned in an HTML fragment (outside the parts markTerms skips): what a reader already met there. */
export function termsIn(html: string): Set<string> {
  gloss ??= new Glossary();
  const root = h('div', { html });
  const out = new Set<string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let t = walker.nextNode(); t; t = walker.nextNode()) for (const m of gloss.find((t as Text).data)) out.add(m.id);
  return out;
}

function show(el: HTMLElement): void {
  const e = codexById(el.dataset.cx ?? '');
  if (!e) return;
  if (hideTimer) clearTimeout(hideTimer);
  if (!card) {
    card = h('div', { class: 'gl-card', role: 'tooltip', id: 'gl-card' });
    card.addEventListener('mouseenter', () => { if (hideTimer) clearTimeout(hideTimer); });
    card.addEventListener('mouseleave', hideSoon);
    document.body.append(card);
    // A touch screen has no mouseleave: the card closes on its ×, and when the page scrolls under it.
    addEventListener('scroll', () => { if (card && !card.hidden && coarse()) hideGlossary(); }, { capture: true, passive: true });
  }
  current?.removeAttribute('aria-describedby');
  current = el;
  const go = (ev: Event) => {
    if (!opener) return;
    ev.preventDefault();
    hideGlossary();
    opener(e.id);
  };
  // A one-line pointer to the picture the entry has in the codex (chapters/analogies.ts), under the summary.
  const pic = analogiesForCodex(e.id)[0];
  const sum = h('div', { class: 'gl-sum' });
  sum.innerHTML = e.body;
  card.replaceChildren(h('div', { class: 'gl-title' }, h('b', null, e.title), h('span', { class: 'gl-kind' }, CODEX_KINDS.find((k) => k.id === e.kind)?.title.replace(/s$/, '') ?? e.kind),
    coarse() ? h('button', { class: 'gl-close', 'aria-label': 'Close', onclick: hideGlossary }, icon('close', 14)) : null), sum,
    ...(pic ? [h('a', { class: 'gl-analogy', href: `#/campaign/codex/${e.id}`, onclick: go }, h('span', null, 'Analogy: '), pic.title)] : []),
    ...(el.dataset.later ? [h('div', { class: 'gl-later' }, `Built in ${el.dataset.later}. Read on: this step does not need it yet.`)] : []),
    h('a', { class: 'gl-more', href: `#/campaign/codex/${e.id}`, onclick: go }, opener ? 'Read the entry' : 'Open in the codex', icon('chevR', 12)));
  card.hidden = false;
  el.setAttribute('aria-describedby', 'gl-card');
  const r = el.getBoundingClientRect();
  const w = Math.min(380, window.innerWidth - 24);
  card.style.width = `${w}px`;
  card.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
  const below = r.bottom + 8;
  card.style.top = '0px';
  const ch = card.offsetHeight;
  card.style.top = `${below + ch < window.innerHeight - 8 ? below : Math.max(8, r.top - ch - 8)}px`;
}

const coarse = () => matchMedia('(pointer: coarse)').matches;

function hideSoon(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hideGlossary, 180);
}

/** Enter on a term: the codex entry, where the reader is (the level screen) or on the codex page. */
function openEntry(id: string): void {
  hideGlossary();
  if (opener) opener(id);
  else location.hash = `#/campaign/codex/${id}`;
}

/** Hide the card (a page change). */
export function hideGlossary(): void {
  if (card) card.hidden = true;
  current?.removeAttribute('aria-describedby');
}
