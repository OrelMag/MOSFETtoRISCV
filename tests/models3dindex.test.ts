// The 3D model index (widgets/models3dindex.ts) against the code: a model nobody indexed, or an entry pointing at a step
// that does not mount it, fails here.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexById } from '../src/campaign/codex';
import { chapterById } from '../src/chapters';
import { MODEL_CATEGORIES, MODELS_3D, modelsOfCodex, searchModels } from '../src/widgets/models3dindex';

const WIDGETS = join(__dirname, '../src/widgets');

describe('3D model index', () => {
  it('claims every 3D model file in src/widgets', () => {
    const claimed = new Set(MODELS_3D.flatMap((m) => m.files));
    // A model's body is a *3dview.ts; a *3d.ts is its lazy entry (cell3d.ts: the standard cell's 3D projection).
    const models = readdirSync(WIDGETS).filter((f) => /3d(view)?\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, ''));
    const missing = models.filter((f) => !claimed.has(f));
    expect(missing, `Add an entry to MODELS_3D in src/widgets/models3dindex.ts for: ${missing.join(', ')} (id, title, summary, category, chapter, step, files, factory, open)`).toEqual([]);
    const files = new Set(readdirSync(WIDGETS).map((f) => f.replace(/\.ts$/, '')));
    const stale = [...claimed].filter((f) => !files.has(f));
    expect(stale, 'files named in MODELS_3D that are not in src/widgets').toEqual([]);
  });

  it('has unique ids and known categories', () => {
    expect(new Set(MODELS_3D.map((m) => m.id)).size).toBe(MODELS_3D.length);
    for (const m of MODELS_3D) {
      expect(MODEL_CATEGORIES.some((c) => c.id === m.category), m.id).toBe(true);
      expect(m.id, 'an id is one path segment').toMatch(/^[a-z0-9]+$/);
      expect(m.summary.length, `${m.id}: one line`).toBeLessThan(160);
    }
  });

  for (const m of MODELS_3D) {
    it(`${m.id}: ${m.chapter}/${m.step} mounts ${m.factory}`, () => {
      const c = chapterById(m.chapter);
      expect(c, `no chapter '${m.chapter}'`).toBeTruthy();
      const step = c!.steps[m.step];
      expect(step, `chapter '${m.chapter}' has no step ${m.step}`).toBeTruthy();
      expect(step.widget, `${m.chapter}/${m.step} has no widget`).toBeTypeOf('function');
      expect(String(step.widget), `${m.chapter}/${m.step} ("${step.title}") does not call ${m.factory}`).toMatch(new RegExp(`\\b${m.factory}\\b`));
      expect(String(m.open), `${m.id}.open does not call ${m.factory}`).toMatch(new RegExp(`\\b${m.factory}\\b`));
      for (const id of m.codex ?? []) expect(codexById(id), `${m.id}: no codex entry '${id}'`).toBeTruthy();
    });
  }

  it('finds models by title and links codex entries', () => {
    expect(searchModels('enigma').map((m) => m.id)).toContain('enigma');
    expect(searchModels('relay')[0].id).toBe('relay');
    expect(searchModels('')).toEqual([]);
    expect(modelsOfCodex('mosfet').map((m) => m.id)).toEqual(['mosfet']);
  });
});
