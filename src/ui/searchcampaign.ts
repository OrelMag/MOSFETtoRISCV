// The search's campaign sources: every level and every codex entry, locked ones too (marked, and opening
// one shows its brief: the level's why, the codex summary, never a solution). A chunk of its own, loaded
// by the search on the first keystroke (the campaign's data is far too big for the main bundle).

import { CODEX, CODEX_KINDS } from '../campaign/codex';
import { plainSummary } from '../campaign/codexlinks';
import { searchCodex } from '../campaign/codexsearch';
import { ALIASES } from '../campaign/glossary';
import { statusOf } from '../campaign/graph';
import { actName, actTitle, NODES } from '../campaign/nodes';
import { progress } from '../campaign/progress';
import type { CampaignNode, NodeKind } from '../campaign/types';
import { plainText, type NavItem } from './chapternav';

const KIND: Record<NodeKind, string> = { lesson: 'lesson', drill: 'drill', build: 'build', program: 'program', core: 'core' };
const BADGE: Record<string, string> = { solved: 'solved', skipped: 'skipped', started: 'in progress' };

const playable = (n: CampaignNode) => !!n.base && !n.soon;

/** Every campaign level in map order, with the learner's status. */
export function levelItems(): NavItem[] {
  const p = progress();
  p.reload();
  return NODES.map((n): NavItem => {
    const st = statusOf(n, p.view, p.unlockAll);
    const locked = st === 'locked';
    return {
      kind: 'level', id: n.id, title: n.title,
      sub: `${actName(n.act)} · ${KIND[n.kind]}${n.optional ? ' · optional' : ''}${n.soon ? ' · coming soon' : ''}`,
      alt: `${actName(n.act)} ${actTitle(n.act)} ${KIND[n.kind]}`,
      text: plainText(n.why),
      href: playable(n) && !locked ? `#/campaign/play/${n.id}` : `#/campaign/n/${n.id}`,
      locked, badge: BADGE[st],
    };
  });
}

/** Every codex entry; those not discovered yet marked locked (their page shows the summary only). */
export function codexItems(): NavItem[] {
  const p = progress();
  const open = p.codexUnlocked();
  const kinds = new Map(CODEX_KINDS.map((k) => [k.id, k.title.replace(/s$/, '')]));
  return CODEX.map((e): NavItem => {
    const sum = plainSummary(e).trim();
    const first = /^.{20,}?[.:;](\s|$)/.exec(sum)?.[0].trim() ?? sum;
    return {
      kind: 'codex', id: e.id, title: e.title,
      sub: `${kinds.get(e.kind) ?? e.kind} · ${first}`,
      alt: [kinds.get(e.kind), ...(ALIASES[e.id] ?? [])].join(' · '), text: sum, href: `#/campaign/codex/${e.id}`, locked: !open.has(e.id),
    };
  });
}

/** The codex group's order for a query: the codex page's own search (aliases, spellings), over the items given. */
export function rankCodexItems(items: readonly NavItem[], text: string): NavItem[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  return searchCodex(text).map((e) => byId.get(e.id)).filter((x): x is NavItem => !!x);
}
