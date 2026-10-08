// The DOM-free side of the sandbox's files and links: share-route parsing, download names,
// import summaries, and the chip-management steps (duplicate, delete) of the "Manage chips"
// dialog. fileui.ts puts them on screen.

import { usedBy } from './library';
import { slug, uniqueName, type ChipDoc, type Workspace } from './model';
import { openChip } from './session';
import type { Imported } from './store';

/** The route segment of a share link: #/sandbox/s/<payload>. */
export const SHARE_SEG = 's';

/** Links longer than this may be cut by mail clients, chat apps and URL shorteners. */
export const SHARE_WARN = 32 * 1024;

export const shareHash = (payload: string) => `#/sandbox/${SHARE_SEG}/${payload}`;

/** The public site: where a link made outside the web (the desktop program's app:// page) points. */
export const SITE_URL = 'https://orelmag.github.io/MOSFETtoRISCV/';

/** The full link: the page's URL without its hash (the public site if the page is not on the web), plus the share route. */
export const shareUrl = (href: string, payload: string) =>
  (/^https?:/i.test(href) ? href.replace(/#.*$/s, '') : SITE_URL) + shareHash(payload);

/** The payload of a share route (#/sandbox/s/<payload>), or null for any other hash. */
export function shareRoute(hash: string): string | null {
  const m = hash.match(/^#\/?sandbox\/s\/([^/?#]*)\/?$/);
  return m && m[1] ? m[1] : null;
}

/** A file name from a chip name: readable (Unicode kept), without characters file systems refuse. */
export function fileBase(name: string, fallback = 'chip'): string {
  // eslint-disable-next-line no-control-regex
  const s = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  return s || fallback;
}

export const chipFileName = (doc: Pick<ChipDoc, 'name'>) => `${fileBase(doc.name)}.chip.json`;

/** sandbox-chips-2026-10-06.json (local date: what the user sees on their calendar). */
export function workspaceFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `sandbox-chips-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

export interface ImportSummary {
  added: { id: string; name: string }[];
  /** Came in under a new id because a different chip already had theirs. */
  renamed: { from: string; to: string; name: string }[];
  /** Identical to a chip already there. */
  skipped: { id: string; name: string }[];
  /** The chip to open afterwards: the top of what came in (it places the others). */
  open: string | null;
}

/**
 * What an import did, by name. The last chip in dependency order is the top one (it places the
 * others, as in an export of one chip or a share link), so that is the one to open.
 */
export function summarize(r: Imported): ImportSummary {
  const name = (id: string) => r.ws.chips[id]?.name ?? id;
  const renamed = Object.entries(r.renamed).map(([from, to]) => ({ from, to, name: name(to) }));
  const open = r.order[r.order.length - 1] ?? null;
  return {
    added: r.added.map((id) => ({ id, name: name(id) })),
    renamed,
    skipped: r.skipped.map((id) => ({ id, name: name(id) })),
    open: open && r.ws.chips[open] ? open : null,
  };
}

/** One line for a toast: "2 chips added (1 renamed), 1 already here". */
export function summaryLine(s: ImportSummary): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const bits: string[] = [];
  if (s.added.length) bits.push(`${n(s.added.length, 'chip')} added${s.renamed.length ? ` (${s.renamed.length} renamed)` : ''}`);
  if (s.skipped.length) bits.push(`${s.skipped.length} already here`);
  return bits.join(', ') || 'nothing to import';
}

/** Size of a chip for the manager: parts, wires, pins, and which chips contain it. */
export function chipInfo(ws: Workspace, id: string): { parts: number; wires: number; pins: number; usedBy: string[] } {
  const c = ws.chips[id];
  return { parts: c?.parts.length ?? 0, wires: c?.wires.length ?? 0, pins: c?.pins.length ?? 0, usedBy: usedBy(ws, id) };
}

/**
 * A copy of a chip under a new id and name ("Adder copy", u_adder_copy), right after the
 * original in the chip list. The copy places the same chips; nothing places the copy.
 */
export function duplicateChip(ws: Workspace, id: string): { ws: Workspace; id: string } | null {
  const c = ws.chips[id];
  if (!c) return null;
  const names = new Set(Object.values(ws.chips).map((d) => d.name));
  let name = `${c.name} copy`;
  for (let i = 2; names.has(name); i++) name = `${c.name} copy ${i}`;
  const nid = uniqueName(`u_${slug(name)}`, Object.keys(ws.chips));
  const copy: ChipDoc = structuredClone({ ...c, id: nid, name });
  const chips: Record<string, ChipDoc> = {};
  for (const [k, v] of Object.entries(ws.chips)) {
    chips[k] = v;
    if (k === id) chips[nid] = copy;
  }
  return { ws: { ...ws, chips }, id: nid };
}

/**
 * Delete a chip unless another chip contains it. The workspace never ends up empty (a blank
 * Main takes the last chip's place) and always has an open tab.
 */
export function deleteChip(ws: Workspace, id: string): { ws: Workspace } | { error: string; usedBy: string[] } {
  const users = usedBy(ws, id);
  if (users.length) return { error: `used by ${users.map((u) => ws.chips[u]?.name ?? u).join(', ')}`, usedBy: users };
  const chips = { ...ws.chips };
  delete chips[id];
  if (!Object.keys(chips).length) {
    return { ws: { ...ws, chips: { u_main: { id: 'u_main', name: 'Main', pins: [], parts: [], wires: [], labels: [] } }, open: ['u_main'] } };
  }
  const open = ws.open.filter((o) => o !== id && chips[o]);
  const next: Workspace = { ...ws, chips, open };
  return { ws: open.length ? next : openChip(next, Object.keys(chips)[0]) };
}
