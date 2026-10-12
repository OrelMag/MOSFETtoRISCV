// Quick navigation: every chapter and step as a searchable entry (DOM-free, tested in Node).

/** The part of a Chapter navigation reads (so tests need not load the chapters). */
export interface NavChapter {
  id: string;
  num: number;
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
    ({ chapter: c.id, step, num: c.num, level: c.level, chTitle: c.title, title, text, href: `#/c/${c.id}/${Math.max(0, step)}`, lt: title.toLowerCase(), lx: text.toLowerCase() });
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
  if (/^\d+$/.test(w) && e.num === Number(w)) return e.step < 0 ? 100 : 30;
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
