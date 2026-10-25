// Codex search (DOM-free), shared by the codex page's list and the Ctrl K box's Codex group: every entry indexed by
// its title (a parenthetical as a second name), the glossary's aliases and a few search-only names, and its summary.
// Text is compared with case, accents, apostrophes, hyphens, dashes and spaces removed, so "flip flop", "flip-flop"
// and "flipflop" are one query, and "twos complement" finds Two's complement. Ranked: an exact name, then a name it
// begins, then a word of a name it begins, then inside a name, then the summary; ties go to the shorter name.

import { CODEX, type CodexEntry } from './codex';
import { ALIASES } from './glossary';

/** Names to search by that the glossary must not mark in prose (too common, or not how the chapters say it). */
const SEARCH_ONLY: Record<string, string[]> = {
  fsm: ['state machine', 'FSM'], dff: ['flip-flop', 'DFF', 'register bit'], kmap: ['K-map', 'Karnaugh'], not: ['inverter gate'],
  twos: ['twos complement', 'negative numbers'], signext: ['sign extend'], ieee754: ['floating point', 'float'],
  stack: ['stack pointer'], clock: ['clock', 'period', 'frequency'], reset: ['reset', 'power-on', 'rst'],
  tristate: ['three-state', 'high impedance'], bin2dec: ['print a number', 'decimal digits', 'BCD'], preg: ['stage register'],
};

/** Dropped inside a word (two's → twos); separators below are dropped and start a word. */
const STRIP = /[’'‘]/;
const SEP = /[\s\-–—/(),.:;&]/;

/** A string squashed for comparison, with the positions (in the squashed text) where a word starts. */
interface Squashed { s: string; starts: Set<number> }

function squash(text: string): Squashed {
  const t = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let s = '';
  const starts = new Set<number>();
  let boundary = true;
  for (const c of t) {
    if (SEP.test(c)) { boundary = true; continue; }
    if (STRIP.test(c)) continue; // an apostrophe: inside the word
    if (boundary) starts.add(s.length);
    boundary = false;
    s += c;
  }
  return { s, starts };
}

/** The query as the index sees it. */
export const normalizeQuery = (q: string): string => squash(q).s;

interface Indexed { e: CodexEntry; order: number; names: { n: Squashed; title: boolean }[]; sum: Squashed }

let index: Indexed[] | null = null;

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

/** The entry's names: title (and its parenthetical), then aliases. */
export function namesOf(e: CodexEntry): { text: string; title: boolean }[] {
  const out: { text: string; title: boolean }[] = [];
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(e.title);
  if (m) out.push({ text: m[1], title: true }, { text: m[2], title: true });
  else out.push({ text: e.title, title: true });
  for (const a of [...(ALIASES[e.id] ?? []), ...(SEARCH_ONLY[e.id] ?? [])]) out.push({ text: a, title: false });
  return out;
}

function build(entries: readonly CodexEntry[]): Indexed[] {
  return entries.map((e, order) => ({ e, order, names: namesOf(e).map((x) => ({ n: squash(x.text), title: x.title })), sum: squash(plain(e.body)) }));
}

/** Where q occurs in x: 4 the whole of it, 3 its start, 2 a word's start, 1 anywhere, 0 nowhere. */
function hit(x: Squashed, q: string): number {
  if (x.s === q) return 4;
  if (x.s.startsWith(q)) return 3;
  let best = 0;
  for (let i = x.s.indexOf(q); i >= 0; i = x.s.indexOf(q, i + 1)) {
    if (x.starts.has(i)) return 2;
    best = 1;
  }
  return best;
}

const NAME_SCORE = [0, 40, 60, 80, 100];

/** The score of one entry for a squashed query (0: no match) and the length of the name that matched best. */
function score(x: Indexed, q: string, words: string[]): { score: number; len: number } {
  let best = 0, len = Infinity;
  for (const { n, title } of x.names) {
    const k = hit(n, q);
    if (!k) continue;
    const s = NAME_SCORE[k] - (title ? 0 : 4);
    if (s > best || (s === best && n.s.length < len)) { best = s; len = n.s.length; }
  }
  if (best) return { score: best, len };
  const ks = hit(x.sum, q);
  if (ks >= 2) return { score: 20, len: Infinity };
  // Several words not side by side: each must start a word of a name or the summary.
  if (words.length > 1 && words.every((w) => x.names.some(({ n }) => hit(n, w) >= 2) || hit(x.sum, w) >= 2)) return { score: 15, len: Infinity };
  if (ks === 1 && q.length >= 4) return { score: 10, len: Infinity };
  return { score: 0, len };
}

/** Entries matching the query, best first; an empty query gives none. `entries` defaults to the whole codex. */
export function searchCodex(query: string, entries: readonly CodexEntry[] = CODEX): CodexEntry[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const words = query.split(/\s+/).map(normalizeQuery).filter(Boolean);
  const idx = entries === CODEX ? (index ??= build(CODEX)) : build(entries);
  return idx.map((x) => ({ x, ...score(x, q, words) })).filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.len - b.len || a.x.order - b.x.order).map((r) => r.x.e);
}
