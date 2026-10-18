// A chapter's way into the campaign (DOM-free): the levels that practise it and the codex entries that cite it, read
// from the links the campaign already keeps (CampaignNode.chapters, CodexMore.chapters) unless the recap names its
// levels itself. Loaded on demand by a chapter's recap.

import { CODEX } from './codex';
import { moreOf } from './codexmore';
import { NODES } from './nodes';

export interface Link { id: string; title: string; href: string }

const link = (n: { id: string; title: string }): Link => ({ id: n.id, title: n.title, href: `#/campaign/n/${n.id}` });

/**
 * Levels that practise a chapter, in campaign order: `ids` when the recap names them, else the levels (not lessons)
 * that list the chapter, then those built around a codex entry the chapter teaches first.
 */
export function practiceFor(chapter: string, ids?: readonly string[]): Link[] {
  if (ids) return NODES.filter((n) => ids.includes(n.id)).map(link);
  const taught = new Set(CODEX.filter((e) => moreOf(e.id)?.chapters?.[0]?.chapter === chapter).map((e) => e.id));
  return NODES.filter((n) => n.kind !== 'lesson' && !n.soon
    && (n.chapters?.some((c) => c.chapter === chapter) || n.codex?.some((id) => taught.has(id)))).map(link);
}

/** Codex entries whose fuller text links the chapter, in codex order. */
export function codexFor(chapter: string): Link[] {
  return CODEX.filter((e) => moreOf(e.id)?.chapters?.some((c) => c.chapter === chapter))
    .map((e) => ({ id: e.id, title: e.title, href: `#/campaign/codex/${e.id}` }));
}
