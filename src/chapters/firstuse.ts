// First use before teaching (DOM-free): a codex term in what a step shows by default (goals, body, tour captions,
// challenge, quiz, recap) before the chapter that teaches it (taught.ts) is either reworded away or explained in place
// inside an element marked data-ahead="<codex id>", with a few words of its own. The `more` layers are opened on
// request and left out. tests/first-use.test.ts holds the count at zero; the chapter page's hover cards use later().

import { chapterSkip, Glossary, proseRuns } from '../campaign/glossary';
import { TAUGHT, TAUGHT_OPTIONAL } from './taught';
import { chapterNo, type Chapter } from './types';

/** What a chapter shows a reader without opening anything: [where, html]. */
export function shownTexts(c: Chapter): [string, string][] {
  const t: [string, string][] = [];
  c.goals?.forEach((g, i) => t.push([`goal ${i}`, g]));
  c.steps.forEach((s, i) => {
    t.push([`${i} body`, s.body]);
    s.tour?.beats.forEach((b, k) => t.push([`${i} beat ${k}`, `${b.title ?? ''} ${b.say}`]));
    s.reading?.quizzes.forEach((q, k) => t.push([`${i} reading ${k}`, [q.question, ...q.options, q.explain, ...(q.why ?? [])].join(' ')]));
    if (s.reading) t.push([`${i} reading`, s.reading.note]);
    const ch = s.challenge;
    if (ch?.kind === 'reach') t.push([`${i} challenge`, [ch.goal, ...(ch.hints ?? []), ch.answer].join(' ')]);
    if (ch?.kind === 'quiz') t.push([`${i} quiz`, [ch.question, ...ch.options, ch.explain, ...(ch.why ?? [])].join(' ')]);
  });
  c.recap?.keep.forEach((k, i) => t.push([`recap keep ${i}`, k]));
  c.recap?.check?.forEach((q, i) => t.push([`recap check ${i}`, [q.question, ...q.options, q.explain, ...(q.why ?? [])].join(' ')]));
  return t;
}

const optional = (c: Chapter) => !!(c.prologue || c.appendix);

/**
 * Has a reader of `chs[at]` been taught `id`? A journey chapter knows what the journey taught up to it; a prologue or
 * appendix chapter also what it, or an earlier chapter of its own group, explains (TAUGHT_OPTIONAL). Untaught ids: yes.
 */
export function knows(chs: readonly Chapter[], at: number, id: string): boolean {
  const t = TAUGHT[id];
  const ti = t ? chs.findIndex((c) => c.id === t) : -1;
  if (ti >= 0 && ti <= at) return true;
  const c = chs[at];
  if (optional(c)) {
    for (let k = at; k >= 0 && optional(chs[k]) && !!chs[k].prologue === !!c.prologue; k--)
      if (TAUGHT_OPTIONAL[id]?.includes(chs[k].id)) return true;
  }
  return !t && !TAUGHT_OPTIONAL[id];
}

/** "chapter 3, NAND gate": where a term the reader of `chs[at]` lacks is built; null when known. */
export function later(chs: readonly Chapter[], at: number, id: string): string | null {
  if (knows(chs, at, id)) return null;
  const c = chs.find((x) => x.id === TAUGHT[id]) ?? chs.find((x) => x.id === TAUGHT_OPTIONAL[id]?.[0]);
  return c ? `${c.prologue ? 'prologue' : c.appendix ? 'appendix' : 'chapter'} ${chapterNo(c).replace(/^0(?=\d)/, '')}, ${c.title}` : null;
}

export interface EarlyUse { chapter: string; where: string; id: string; word: string }

let gloss: Glossary | null = null;

/** Terms used before they are taught and not explained in place (first per text), plus data-ahead explanations too thin to count. */
export function earlyUses(chs: readonly Chapter[]): { early: EarlyUse[]; thin: EarlyUse[] } {
  gloss ??= new Glossary();
  const early: EarlyUse[] = [], thin: EarlyUse[] = [];
  chs.forEach((c, at) => {
    for (const [where, html] of shownTexts(c)) {
      // words the chapter uses in another sense (a loom's warp) are not the term
      const seen = chapterSkip(c);
      for (const run of proseRuns(html)) {
        for (const m of gloss!.find(run.text)) {
          if (seen.has(m.id) || knows(chs, at, m.id)) continue;
          seen.add(m.id);
          if (!run.ahead.includes(m.id)) early.push({ chapter: c.id, where, id: m.id, word: run.text.slice(m.start, m.end) });
        }
      }
      // An explanation in place says something beyond the term: three words or more of its own.
      for (const m of html.matchAll(/<(\w+)[^>]*\bdata-ahead="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)) {
        const text = proseRuns(m[3]).map((r) => r.text).join('');
        const rest = gloss!.find(text).reduceRight((s, t) => s.slice(0, t.start) + s.slice(t.end), text);
        if (rest.split(/\s+/).filter((w) => /\w/.test(w)).length < 3) thin.push({ chapter: c.id, where, id: m[2], word: text.trim() });
      }
    }
  });
  return { early, thin };
}
