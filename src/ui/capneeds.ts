// A capstone's "Builds on" line: the chapters it needs, each a link, by number and title from the manifest (no chapter is loaded).

import { MANIFEST } from '../chapters/manifest';
import { h } from './dom';

export function needsLine(ids: readonly string[] | undefined, cls = 'lp-sub'): HTMLElement | null {
  const metas = (ids ?? []).map((id) => MANIFEST.find((m) => m.id === id)).filter((m) => !!m);
  if (!metas.length) return null;
  const links = metas.flatMap((m, i) => [i ? ', ' : '', h('a', { href: `#/c/${m.id}/0` }, `${m.num} ${m.title}`)]);
  return h('p', { class: cls }, h('b', null, 'Builds on: '), ...links);
}
