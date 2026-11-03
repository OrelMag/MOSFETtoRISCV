// The chapters' guide: names in the text and highlights point at parts that exist, every per-option explanation lines
// up with its options, Try conditions have a box to tick, Builds on links resolve, checks have unique keys.

import { describe, expect, it } from 'vitest';
import { nodeById } from '../src/campaign/nodes';
import { chapterById, chapters } from '../src/chapters';
import { Glossary, proseRuns } from '../src/campaign/glossary';
import { NODES } from '../src/campaign/nodes';
import { checkKeys } from '../src/chapters/checks';
import { shownTexts } from '../src/chapters/firstuse';
import { TAUGHT } from '../src/chapters/taught';
import { PARTS_MIN, partsOf } from '../src/chapters/parts';
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
        if (s.reading) {
          expect(s.reading.quizzes.length, `${where}: a reading has three questions`).toBe(3);
          s.reading.quizzes.forEach((q, k) => quizOk(`${where} reading ${k}`, q));
          expect(s.reading.quote.join(' ').length, `${where}: quote the manual briefly`).toBeLessThan(700);
        }
        if (s.challenge?.kind === 'reach') for (const h of s.challenge.hints ?? []) expect(h.trim(), where).not.toBe('');
        if (s.tries) expect(s.tries.length, `${where}: a .try box per condition`).toBeLessThanOrEqual(tryBoxes(s.body));
      });
      c.recap?.check?.forEach((q, k) => quizOk(`${c.id}/recap ${k}`, q));
      if (c.recap) expect(c.recap.keep.length, `${c.id}: recap`).toBeGreaterThan(0);
      for (const id of c.recap?.practise ?? []) expect(nodeById(id), `${c.id} practises ${id}`).toBeTruthy();
    }
  });

  it('the spec readings: six, each on a step of its own chapter', () => {
    const n = chapters.flatMap((c) => c.steps.filter((s) => s.reading)).length;
    expect(n).toBeGreaterThanOrEqual(5);
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

  describe('parts', () => {
    it('a chapter of PARTS_MIN steps or more has parts, a shorter one has none', () => {
      for (const c of chapters) {
        if (c.steps.length >= PARTS_MIN) expect(c.parts, c.id + ' has ' + c.steps.length + ' steps').toBeTruthy();
        else expect(c.parts, c.id).toBeUndefined();
      }
    });
    it('parts cover every step exactly once, in order, with short unique names', () => {
      for (const c of chapters.filter((x) => x.parts)) {
        const ps = partsOf(c);
        expect(ps, c.id + ': the counts add up to the steps').toBeTruthy();
        expect(ps!.reduce((n, p) => n + p.count, 0)).toBe(c.steps.length);
        for (const p of ps!) {
          expect(p.count, c.id + ' ' + p.name).toBeGreaterThan(0);
          expect(p.name.length, c.id + ': ' + p.name).toBeLessThanOrEqual(28);
        }
        expect(new Set(ps!.map((p) => p.name)).size, c.id + ': unique names').toBe(ps!.length);
        expect(ps!.length, c.id).toBeGreaterThanOrEqual(4);
        expect(ps!.length, c.id).toBeLessThanOrEqual(7);
      }
    });
    it('deep dives are only in chapters with parts, and nothing depends on them', () => {
      const deep = new Set(chapters.flatMap((c) => c.steps.flatMap((s, i) => (s.deep ? [c.id + ':' + i] : []))));
      for (const c of chapters) if (c.steps.some((s) => s.deep)) expect(c.parts, c.id).toBeTruthy();
      // a campaign level that sends the learner to a step needs it
      const nodeLinks = NODES.flatMap((n) => (n.chapters ?? []).map((l) => n.id + ' -> ' + l.chapter + ':' + l.step));
      expect(nodeLinks.filter((l) => deep.has(l.split(' -> ')[1]))).toEqual([]);
      // another chapter's text sends the learner there
      const bad: string[] = [];
      for (const c of chapters)
        for (const s of c.steps)
          for (const m of s.body.matchAll(/href="#\/c\/([^/"]+)\/(\d+)/g)) if (m[1] !== c.id && deep.has(`${m[1]}:${m[2]}`)) bad.push(`${c.id} -> ${m[1]}:${m[2]}`);
      expect(bad).toEqual([]);
      // a term a later chapter takes as taught (taught.ts) is met in a step on the core path, not only in a deep dive
      const gloss = new Glossary();
      for (const c of chapters.filter((x) => x.steps.some((st) => st.deep))) {
        const seen = new Map<string, Set<number>>();
        for (const [where, html] of shownTexts(c)) {
          const m = where.match(/^(\d+) /);
          if (m) for (const run of proseRuns(html)) for (const f of gloss.find(run.text)) (seen.get(f.id) ?? seen.set(f.id, new Set()).get(f.id)!).add(+m[1]);
        }
        for (const [id, ch] of Object.entries(TAUGHT)) {
          const at = [...(seen.get(id) ?? [])];
          if (ch === c.id && at.length) expect(at.some((i) => !c.steps[i].deep), c.id + ': ' + id + ' is taught only in deep dives').toBe(true);
        }
      }
      // the recap's questions are about core material: no deep step is the only place a question's subject is taught
      // (checked by hand when parts were written; a chapter keeps at least half of its steps on the core path)
      for (const c of chapters.filter((x) => x.parts)) expect(c.steps.filter((s) => !s.deep).length / c.steps.length, c.id).toBeGreaterThan(0.5);
    });
  });
});
