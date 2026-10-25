// The codex guide: links between entries resolve and never point at the entry itself, every figure and question
// belongs to an entry, every entry has two well-formed Check yourself questions.

import { describe, expect, it } from 'vitest';
import { CODEX, codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CODEX_ACTS, CODEX_ORDER, FURTHER, buildsOn, firstTaught, firstTeacher, leadsTo, neighbours, seeAlso } from '../src/campaign/codexlinks';
import { caseOf } from '../src/campaign/cases';
import { Glossary } from '../src/campaign/glossary';
import { LESSONS } from '../src/campaign/lessons';
import { levelChallenge } from '../src/campaign/levels';
import { ACTS } from '../src/campaign/nodes';
import { tipsOf } from '../src/campaign/nudges';
import { hasCodexFigure } from '../src/campaign/ui/codexfigs';

describe('codex guide', () => {
  it('reading order holds every entry once', () => {
    expect(CODEX_ORDER.length).toBe(CODEX.length);
    expect(new Set(CODEX_ORDER.map((e) => e.id)).size).toBe(CODEX.length);
    expect(neighbours(CODEX_ORDER[0].id).prev).toBeUndefined();
    expect(neighbours(CODEX_ORDER[CODEX.length - 1].id).next).toBeUndefined();
  });

  it('links resolve, skip the entry itself, and leave no entry unconnected', () => {
    for (const e of CODEX) {
      const all = [...buildsOn(e.id), ...leadsTo(e.id), ...seeAlso(e.id)];
      for (const x of all) {
        expect(codexById(x.id), `${e.id} → ${x.id}`).toBeTruthy();
        expect(x.id, e.id).not.toBe(e.id);
      }
      expect(all.length, `${e.id} links nowhere`).toBeGreaterThan(0);
    }
  });

  it('reads by act: acts in map order, each entry at its first teaching level, Further entries unnamed by it', () => {
    const acts = CODEX_ACTS.map((g) => g.act);
    expect(acts.filter((a) => a !== undefined)).toEqual(ACTS.map((a) => a.num).filter((n) => acts.includes(n)));
    for (const g of CODEX_ACTS) {
      const ks = g.main.map((e) => firstTaught(e.id));
      expect([...ks].sort((a, b) => a - b), `act ${g.act}`).toEqual(ks);
      for (const e of [...g.main, ...g.further]) expect(firstTeacher(e.id)?.act, e.id).toBe(g.act);
    }
    const gl = new Glossary();
    for (const id of FURTHER) {
      const n = firstTeacher(id)!;
      expect(n, id).toBeTruthy();
      const c = caseOf(n.id);
      const text = [n.title, n.why, n.body ? LESSONS[n.body] ?? '' : '', levelChallenge(n)?.brief ?? '', ...tipsOf(n), c?.problem ?? '', c?.without ?? '', c?.cost ?? '']
        .join(' ').replace(/<[^>]+>/g, ' ');
      expect(gl.find(text).map((m) => m.id), `${n.id} names ${id}: no longer Further`).not.toContain(id);
      expect(CODEX_ACTS.find((g) => g.act === n.act)!.further.map((e) => e.id)).toContain(id);
    }
  });

  it('builds on only what is taught before, leads only to what is taught after', () => {
    const back: string[] = [];
    for (const e of CODEX) {
      const at = firstTaught(e.id);
      for (const x of buildsOn(e.id)) if (!(firstTaught(x.id) < at)) back.push(`${e.id} builds on ${x.id}`);
      for (const x of leadsTo(e.id)) if (!(firstTaught(x.id) > at)) back.push(`${e.id} leads to ${x.id}`);
    }
    expect(back).toEqual([]);
    expect(buildsOn('pipeline').map((x) => x.id)).not.toContain('stall');
    expect(buildsOn('twos').map((x) => x.id)).not.toContain('ripple');
  });

  it('figures and questions belong to entries', () => {
    for (const id of ['positional', 'hex', 'twos', 'formats', 'pipeline', 'hazards', 'flush']) expect(hasCodexFigure(id), id).toBe(true);
    for (const id of Object.keys(CHECKS)) expect(codexById(id), `questions for '${id}'`).toBeTruthy();
  });

  it('every question is well formed', () => {
    for (const [id, qs] of Object.entries(CHECKS)) {
      qs.forEach((q, k) => {
        const where = `${id} ${k}`;
        expect(q.options.length, where).toBeGreaterThanOrEqual(2);
        expect(q.answer, where).toBeGreaterThanOrEqual(0);
        expect(q.answer, where).toBeLessThan(q.options.length);
        expect(q.why?.length, `${where}: one why per option`).toBe(q.options.length);
        expect(new Set(q.options).size, `${where}: options differ`).toBe(q.options.length);
        q.why!.forEach((w, i) => { if (i !== q.answer) expect(w.trim(), `${where}: why for option ${i}`).not.toBe(''); });
      });
    }
  });

  it.skipIf(Object.keys(CHECKS).length === 0)('every entry has two questions', () => {
    for (const e of CODEX) expect(CHECKS[e.id]?.length, e.id).toBe(2);
  });
});
