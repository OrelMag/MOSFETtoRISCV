// Quick navigation: every chapter and step as a searchable entry (DOM-free, tested in Node).

/** The part of a Chapter navigation reads (so tests need not load the chapters). */
export interface NavChapter {
  id: string;
  num: number;
  /** An appendix chapter's letter. */
  appendix?: string;
  /** A prologue chapter's label (P1 …). */
  prologue?: string;
  title: string;
  blurb: string;
  level: string;
  steps: { title: string; body: string }[];
}

export interface NavEntry {
  chapter: string;
  /** -1 for the chapter itself. */
  step: number;
  num: number;
  /** As shown: 07, or A for an appendix. */
  no: string;
  level: string;
  chTitle: string;
  title: string;
  /** Plain text (tags and entities stripped), for snippets. */
  text: string;
  href: string;
  /** Lower-cased title and text, searched. */
  lt: string;
  lx: string;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', rarr: '→', larr: '←', times: '×', middot: '·', le: '≤', ge: '≥', minus: '−' };

/** HTML → plain text, good enough for search and snippets. */
export function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m)
    .replace(/\s+/g, ' ').trim();
}

const memo = new WeakMap<readonly NavChapter[], NavEntry[]>();

/** One entry per chapter, then one per step, in book order. */
export function navEntries(chs: readonly NavChapter[]): NavEntry[] {
  let out = memo.get(chs);
  if (out) return out;
  out = [];
  const entry = (c: NavChapter, step: number, title: string, text: string): NavEntry =>
    ({ chapter: c.id, step, num: c.num, no: c.prologue ?? c.appendix ?? String(c.num).padStart(2, '0'), level: c.level, chTitle: c.title, title, text, href: `#/c/${c.id}/${Math.max(0, step)}`, lt: title.toLowerCase(), lx: text.toLowerCase() });
  for (const c of chs) {
    out.push(entry(c, -1, c.title, c.blurb));
    c.steps.forEach((s, i) => out!.push(entry(c, i, s.title, plainText(s.body))));
  }
  memo.set(chs, out);
  return out;
}

const wordStart = (s: string, w: string) => {
  for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + 1)) if (i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1])) return true;
  return false;
};

/** How well one query word matches an entry (0: not at all). */
function wordScore(e: NavEntry, w: string): number {
  if (/^\d+$/.test(w) && e.num === Number(w) && !/^[a-z]\d*$/i.test(e.no)) return e.step < 0 ? 100 : 30;
  if (/^[a-z]$/.test(w) && e.no.toLowerCase() === w) return e.step < 0 ? 100 : 30;
  const ct = e.chTitle.toLowerCase();
  if (e.lt.startsWith(w)) return 60;
  if (wordStart(e.lt, w)) return 50;
  if (e.lt.includes(w)) return 35;
  // A step also matches its chapter's title ("cache miss" finds a step about misses in Caches).
  if (e.step >= 0 && wordStart(ct, w)) return 15;
  if (wordStart(e.lx, w)) return 10;
  if (e.lx.includes(w)) return 5;
  return 0;
}

/**
 * Entries matching every word of the query, best first (ties in book order). A chapter wins over
 * its own steps on equal score. An empty query lists the chapters.
 */
export function searchNav(entries: readonly NavEntry[], query: string, limit = 40): NavEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.filter((e) => e.step < 0);
  const hits: { e: NavEntry; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    let s = 0;
    for (const w of words) {
      const ws = wordScore(e, w);
      if (!ws) return;
      s += ws;
    }
    hits.push({ e, s: s + (e.step < 0 ? 1 : 0), i });
  });
  hits.sort((a, b) => b.s - a.s || a.i - b.i);
  return hits.slice(0, limit).map((x) => x.e);
}

/** About `n` characters of the text around the first query word found in it. */
export function snippet(e: NavEntry, query: string, n = 90): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let at = -1;
  for (const w of words) if ((at = e.lx.indexOf(w)) >= 0) break;
  if (at < 0) return e.text.length > n ? `${e.text.slice(0, n).trimEnd()}…` : e.text;
  const from = Math.max(0, at - Math.floor(n / 3));
  const to = Math.min(e.text.length, from + n);
  return `${from > 0 ? '…' : ''}${e.text.slice(from, to).trim()}${to < e.text.length ? '…' : ''}`;
}

// ---- the home page's Continue and chapter cards ----------------------------------------------------

/** The part of a chapter Continue reads. */
export interface ResumeChapter { id: string; steps: readonly unknown[] }

/**
 * Where Continue goes: the step last viewed (`last`), or, once every step of that chapter has been seen, the next
 * chapter in book order at its first unseen step (`next`). Without a record of the last view (progress saved before
 * it was kept): the last chapter started, at its furthest step. Null for a new visitor.
 */
export function resumeTarget<C extends ResumeChapter>(chs: readonly C[], visited: (id: string) => readonly number[], last?: { chapter: string; step: number }): { chapter: C; step: number; next: boolean } | null {
  let i = last ? chs.findIndex((c) => c.id === last.chapter) : -1;
  let step = i >= 0 ? last!.step : 0;
  if (i < 0) {
    for (let k = chs.length - 1; k >= 0 && i < 0; k--) if (visited(chs[k].id).length) i = k;
    if (i < 0) return null;
    step = Math.max(0, ...visited(chs[i].id));
  }
  const cur = chs[i];
  // the recap is one past the last step
  if (step < 0 || step > cur.steps.length) step = 0;
  const allSeen = (c: C) => { const v = visited(c.id); return c.steps.every((_, k) => v.includes(k)); };
  const nxt = chs[i + 1];
  if (allSeen(cur) && nxt) {
    const v = visited(nxt.id);
    const first = nxt.steps.findIndex((_, k) => !v.includes(k));
    return { chapter: nxt, step: Math.max(0, first), next: true };
  }
  return { chapter: cur, step, next: false };
}

/**
 * A chapter card's mark: 'done' (the full tick) once every step was seen and every check solved, 'seen' when the
 * steps were all seen but checks remain, else none. `seen` is the fraction of steps visited.
 */
export function chapterMark(seen: number, checks: { done: number; total: number }): 'done' | 'seen' | null {
  if (seen < 1) return null;
  return checks.done >= checks.total ? 'done' : 'seen';
}

// ---- search items of every kind (the search box's sources: ui/searchsources.ts) ----------------

export type NavKind = 'chapter' | 'step' | 'component' | 'level' | 'codex' | 'action';

/** One row the search can show: a place (href) or something to do (run). */
export interface NavItem {
  kind: NavKind;
  /** Unique within its kind (recent items are kept by kind and id). */
  id: string;
  title: string;
  /** The small line under the title. */
  sub: string;
  /** Also matched like the title, a little lower: ids, aliases, the act or category. */
  alt?: string;
  /** Matched last, and shown as a snippet. */
  text?: string;
  href?: string;
  run?: () => void;
  /** Its own shortcut, shown on the right (key caps). */
  keys?: string[];
  /** Left column: a chapter's number. */
  no?: string;
  /** A campaign level not open yet, a codex entry not discovered: listed, marked, its brief only. */
  locked?: boolean;
  /** Shown on the right: solved, read … */
  badge?: string;
  /** A chapter or step: ranked exactly like the chapter list (wordScore). */
  entry?: NavEntry;
}

interface Low { t: string; a: string; x: string }
const lows = new WeakMap<NavItem, Low>();
const low = (it: NavItem): Low => {
  let l = lows.get(it);
  if (!l) lows.set(it, l = { t: it.title.toLowerCase(), a: (it.alt ?? '').toLowerCase(), x: (it.text ?? '').toLowerCase() });
  return l;
};

/** How well one query word matches an item (0: not at all). Chapters and steps keep their own score. */
export function itemWordScore(it: NavItem, w: string): number {
  if (it.entry) return wordScore(it.entry, w);
  const l = low(it);
  if (l.t === w) return 70;
  if (l.t.startsWith(w)) return 60;
  if (wordStart(l.t, w)) return 50;
  if (l.a && (l.a === w || l.a.split(/[\s·,/]+/).includes(w))) return 45;
  if (l.t.includes(w)) return 35;
  if (l.a && wordStart(l.a, w)) return 25;
  if (l.a.includes(w)) return 12;
  if (wordStart(l.x, w)) return 10;
  if (l.x.includes(w)) return 5;
  return 0;
}

/** Items matching every word of the query, best first (ties in the given order); an empty query keeps them all. */
export function rankItems<T extends NavItem>(items: readonly T[], query: string): { item: T; score: number }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.map((item) => ({ item, score: 0 }));
  const hits: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    let s = 0;
    for (const w of words) {
      const ws = itemWordScore(item, w);
      if (!ws) return;
      s += ws;
    }
    hits.push({ item, score: s + (item.kind === 'chapter' ? 1 : 0) - (item.locked ? 2 : 0), i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.map(({ item, score }) => ({ item, score }));
}

/** The title cut into runs, `true` where a query word matches (at a word start where it can). */
export function markRuns(title: string, query: string): [string, boolean][] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0 && !/^\d+$/.test(w));
  const lt = title.toLowerCase();
  const on = new Array<boolean>(title.length).fill(false);
  for (const w of words) {
    let at = -1;
    for (let i = lt.indexOf(w); i >= 0; i = lt.indexOf(w, i + 1)) if (i === 0 || !/[\p{L}\p{N}]/u.test(lt[i - 1])) { at = i; break; }
    if (at < 0) at = lt.indexOf(w);
    if (at >= 0) on.fill(true, at, at + w.length);
  }
  const out: [string, boolean][] = [];
  for (let i = 0; i < title.length; i++) {
    const last = out[out.length - 1];
    if (last && last[1] === on[i]) last[0] += title[i];
    else out.push([title[i], on[i]]);
  }
  return out;
}

/** A snippet of the item's text around the first query word found in it. */
export function itemSnippet(it: NavItem, query: string, n = 90): string {
  if (it.entry) return snippet(it.entry, query, n);
  const text = it.text ?? '';
  return snippet({ text, lx: low(it).x } as NavEntry, query, n);
}
