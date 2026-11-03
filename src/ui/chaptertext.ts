// The text of every chapter step, for the search (the outline has titles only). One JSON file written at build
// (scripts/chapter-manifest.ts: public/chapterindex.json, plain text per step); where it is missing or stale (the dev server, an old
// cache) the chapters are loaded and stripped here, which gives the same text, only later.

import { loadChapters } from '../chapters/load';
import { outline } from '../chapters/outline';
import { plainText, type NavChapter } from './chapternav';

export const INDEX_FILE = 'chapterindex.json';

/** The index file's text laid over the outline, or null when it does not match it (every chapter, every step). */
export function withText(index: unknown): NavChapter[] | null {
  const text = (index as { v?: number; text?: Record<string, unknown> } | null)?.text;
  if (!text || (index as { v?: number }).v !== 1) return null;
  const out: NavChapter[] = [];
  for (const c of outline) {
    const t = text[c.id];
    if (!Array.isArray(t) || t.length !== c.steps.length || t.some((x) => typeof x !== 'string')) return null;
    out.push({ ...c, steps: c.steps.map((s, i) => ({ title: s.title, text: t[i] as string })) });
  }
  return out;
}

export async function loadChapterText(): Promise<NavChapter[]> {
  if (typeof document !== 'undefined') {
    try {
      const res = await fetch(new URL(INDEX_FILE, document.baseURI));
      if (res.ok) {
        const got = withText(await res.json());
        if (got) return got;
      }
    } catch { /* offline, or no file: the chapters themselves */ }
  }
  const full = await loadChapters();
  return full.map((c) => ({ id: c.id, num: c.num, appendix: c.appendix, prologue: c.prologue, title: c.title, blurb: c.blurb, level: c.level, steps: c.steps.map((s) => ({ title: s.title, text: plainText(s.body) })) }));
}
