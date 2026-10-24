// The chapters' guide: names in the text and highlights point at parts that exist, every per-option explanation lines
// up with its options, Try conditions have a box to tick, Builds on links resolve, checks have unique keys.

import { describe, expect, it } from 'vitest';
import { nodeById } from '../src/campaign/nodes';
import { chapterById, chapters } from '../src/chapters';
import { checkKeys } from '../src/chapters/checks';
import type { Quiz } from '../src/chapters/types';
import { showTarget, viewDef } from '../src/ui/pages/looks';

const shows = (html: string) => [...html.matchAll(/data-show="([^"]*)"/g)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean));
const tryBoxes = (html: string) => [...html.matchAll(/class="try[\s"]/g)].length;

function quizOk(where: string, q: Quiz): void {
  expect(q.answer, where).toBeGreaterThanOrEqual(0);
  expect(q.answer, where).toBeLessThan(q.options.length);
  if (q.why) expect(q.why.length, `${where}: one why per option`).toBe(q.options.length);
}

describe('chapter guide', () => {
  it('a link whose text is a chapter number names the chapter it goes to (renumbering left stale ones)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const bad: string[] = [];
    for (const dir of ['src/chapters', 'src/widgets', 'src/campaign', 'src/ui', 'src/editor'])
      for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (!f.endsWith('.ts')) continue;
        for (const m of readFileSync(`${dir}/${f}`, 'utf8').matchAll(/#\/c\/([\w-]+)[^>]*>([^<]{0,60})</g)) {
          const s = m[2].trim(), n = s.match(/^(?:[Cc]hapters? )?(\d+)$/) ?? s.match(/[Cc]hapters? (\d+)/);
          // (a number past 99 is a name: "6502")
          if (n && +n[1] < 100 && chapterById(m[1])?.num !== +n[1]) bad.push(`${dir}/${f}: #/c/${m[1]} is chapter ${chapterById(m[1])?.num}, the text says "${s}"`);
        }
      }
    expect(bad).toEqual([]);
  });
  it('names in the text and highlights resolve in the scene they point at', () => {
    for (const c of chapters) {
      c.steps.forEach((s, i) => {
        const names = shows(s.body);
        if (!names.length && !s.scene) return;
        if (names.length) expect(s.scene, `${c.id}/${i}: data-show needs a scene`).toBeTruthy();
        if (!names.length && s.lit !== undefined) return;
        const scene = s.scene!();
        const def = viewDef(scene);
        expect(def, `${c.id}/${i}: the scene's path`).toBeTruthy();
        for (const n of [...names, ...(s.lit === undefined ? scene.highlight ?? [] : [])]) {
          expect(showTarget(def!, n), `${c.id}/${i}: '${n}'`).toBeTruthy();
        }
      });
    }
  });

  it('questions, hints and tries are well formed', () => {
    for (const c of chapters) {
      c.steps.forEach((s, i) => {
        const where = `${c.id}/${i}`;
        if (s.challenge?.kind === 'quiz') quizOk(where, s.challenge);
        if (s.challenge?.kind === 'reach') for (const h of s.challenge.hints ?? []) expect(h.trim(), where).not.toBe('');
        if (s.tries) expect(s.tries.length, `${where}: a .try box per condition`).toBeLessThanOrEqual(tryBoxes(s.body));
      });
      c.recap?.check?.forEach((q, k) => quizOk(`${c.id}/recap ${k}`, q));
      if (c.recap) expect(c.recap.keep.length, `${c.id}: recap`).toBeGreaterThan(0);
      for (const id of c.recap?.practise ?? []) expect(nodeById(id), `${c.id} practises ${id}`).toBeTruthy();
    }
  });

  it('Builds on names chapters that come earlier', () => {
    for (const c of chapters) {
      for (const id of c.builds ?? []) {
        const b = chapterById(id);
        expect(b, `${c.id} builds on ${id}`).toBeTruthy();
        expect(chapters.indexOf(b!), `${c.id} builds on ${id}`).toBeLessThan(chapters.indexOf(c));
      }
    }
  });

  it('every check has its own key', () => {
    const keys = chapters.flatMap(checkKeys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('links inside the text point at chapters that exist', () => {
    for (const c of chapters) {
      for (const s of c.steps) {
        for (const m of s.body.matchAll(/href="#\/c\/([^/"]+)/g)) expect(chapterById(m[1]), `${c.id}: ${m[0]}`).toBeTruthy();
      }
    }
  });
});
