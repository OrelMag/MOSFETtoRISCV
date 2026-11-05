// Chapter numbers follow from the book's order (chapters/order.ts). Chapters from the modem on move as chapters are inserted, so text
// must not type those numbers: it says `chapter ${numOf('modem')}`. A typed number below them is stable; comments are not read.

import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import { MANIFEST } from '../src/chapters/manifest';
import { BOOK_ORDER, numOf, type ChapterId } from '../src/chapters/order';

/** The first number that may move: everything before it stays put when a chapter is inserted further on. */
const FLOOR = numOf('spi') + 1;
const REF = /\b(?:chapters?|ch\.?)\s+(\d+(?:\s*(?:,\s*and|,|–|-|to|and|or|&)\s*\d+)*)/gi;

/** The typed numbers in a piece of text that a later insertion could make wrong. */
function typedRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF)) if (m[1].match(/\d+/g)!.some((d) => +d >= FLOOR && +d < 100)) out.push(m[0]);
  return out;
}

/** Those in a source file's strings and templates. */
function typedInSource(name: string, src: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddleOrTemplateTail(n)) out.push(...typedRefs(n.text));
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true));
  return out;
}

describe('chapter numbers', () => {
  it('the order is the list of chapters, in the same order', () => {
    expect(chapters.map((c) => c.id)).toEqual([...BOOK_ORDER]);
  });

  it('every chapter takes its number from the order, the outline too', () => {
    for (const c of chapters) expect(c.num, c.id).toBe(numOf(c.id as ChapterId));
    for (const c of MANIFEST) expect(c.num, c.id).toBe(numOf(c.id as ChapterId));
  });

  it('numbers run from 1 with no gap and no repeat, and only a chapter with no number to show has 0', () => {
    const nums = chapters.filter((c) => c.num).map((c) => c.num);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    for (const c of chapters.filter((x) => !x.num)) expect(c.label || c.prologue || c.id === 'map', c.id).toBeTruthy();
    // a label or a prologue's name replaces the number, so a chapter with one must not use up a number
    for (const c of chapters.filter((x) => x.label || x.prologue)) expect(c.num, c.id).toBe(0);
  });

  it('the detector sees what it is for', () => {
    const typed = [`chapter ${FLOOR}`, `Chapter ${FLOOR + 3}'s MAC`, `chapters 39–${FLOOR + 2}`, `chapters 39, 40 and ${FLOOR}`, `ch ${FLOOR}`, `Chapters ${FLOOR} to ${FLOOR + 1}`];
    for (const t of typed) expect(typedRefs(t), t).not.toEqual([]);
    for (const t of [`chapter ${FLOOR - 1}`, 'chapters 1 to 3', 'chapter 6502', `${FLOOR} chapters`, `channel ${FLOOR}`]) expect(typedRefs(t), t).toEqual([]);
    const src = `// chapter ${FLOOR}, a comment\nconst a = 'chapter ${FLOOR}', b = \`\${x} Chapter ${FLOOR}'s \${y} ch ${FLOOR}\`, c = \`chapter \${numOf('modem')}\`;`;
    expect(typedInSource('t.ts', src)).toEqual([`chapter ${FLOOR}`, `Chapter ${FLOOR}`, `ch ${FLOOR}`]);
  });

  it('a table of chapters shows each with its own number (the telegraph chapter\'s ladder has them bare, where the detector cannot see)', () => {
    const rows = [...chapters.find((c) => c.id === 'telegraph')!.steps.map((s) => s.body).join('').matchAll(/<tr><td>(\d+)<\/td><td>([^<]+)<\/td><\/tr>/g)];
    expect(rows.length).toBeGreaterThan(10);
    for (const [, n, title] of rows) expect(chapters.find((c) => c.num === +n)?.title, n).toBe(title);
  });

  it('no text types a number that can move', () => {
    const bad: string[] = [];
    for (const f of readdirSync('src', { recursive: true }) as string[]) {
      if (!f.endsWith('.ts')) continue;
      const path = `src/${f.replace(/\\/g, '/')}`, src = readFileSync(path, 'utf8');
      if (!/\b(?:chapters?|ch\.?)\s+\d/i.test(src)) continue;
      for (const r of typedInSource(path, src)) bad.push(`${path}: "${r}"`);
    }
    expect(bad, `say \`chapter \${numOf('id')}\` instead (chapters/order.ts)`).toEqual([]);
  });
});
