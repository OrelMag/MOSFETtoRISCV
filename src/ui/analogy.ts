// The folded "Analogy" aside (chapters/analogies.ts): under a step's body, closed by default so the prose stays dense,
// and in a codex entry with a link back to the step that tells it.

import type { Analogy } from '../chapters/analogies';
import { h, icon } from './dom';

export interface AnalogyOptions {
  /** Open on first show (the codex: the entry is already the reader's choice). */
  open?: boolean;
  /** A link under the text: where the analogy is told in the journey. */
  from?: { href: string; label: string };
}

export function analogyEl(a: Analogy, opts: AnalogyOptions = {}): HTMLElement {
  const body = h('div', { class: 'analogy-body' });
  body.innerHTML = a.body;
  const map = a.map?.length
    ? h('dl', { class: 'analogy-map' }, a.map.flatMap(([k, v]) => [h('dt', { html: k }), h('dd', { html: v })]))
    : null;
  const breaks = h('p', { class: 'analogy-breaks' }, h('b', null, 'Where it breaks: '), h('span', { html: a.breaks }));
  const from = opts.from ? h('a', { class: 'analogy-from', href: opts.from.href }, opts.from.label, icon('chevR', 12)) : null;
  const d = h('details', { class: 'analogy' },
    h('summary', null, icon('like', 14), h('span', { class: 'analogy-k' }, 'Analogy'), h('span', { class: 'analogy-t' }, a.title)),
    h('div', { class: 'analogy-in' }, body, map, breaks, from));
  if (opts.open) d.open = true;
  return d;
}
