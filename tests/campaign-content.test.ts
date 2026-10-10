// The campaign's written content refers only to things that exist: level cases to nodes and library
// parts, the fuller codex to codex entries, library parts, anatomy blocks and chapters. Every
// required build or core level has a case, and every codex entry has its fuller text.

import { describe, expect, it } from 'vitest';
import { BLOCKS } from '../src/campaign/anatomy';
import { caseIds, caseOf } from '../src/campaign/cases';
import { CODEX, codexById } from '../src/campaign/codex';
import { moreIds, moreOf } from '../src/campaign/codexmore';
import { NODES, nodeById } from '../src/campaign/nodes';
import { chapterById } from '../src/chapters';
import { resolveComponent } from '../src/lib/resolve';

const hasLib = (id: string) => !!resolveComponent(id);

describe('level cases', () => {
  it('belong to known nodes and name known library parts', () => {
    for (const id of caseIds()) {
      expect(nodeById(id), `case for unknown node ${id}`).toBeDefined();
      const c = caseOf(id)!;
      expect(c.problem.trim().length, `${id}: problem`).toBeGreaterThan(20);
      for (const a of c.alts ?? []) {
        if (a.lib) expect(hasLib(a.lib), `${id}: alt ${a.name} lib ${a.lib}`).toBe(true);
        else expect(a.nand !== undefined || a.depth !== undefined, `${id}: alt ${a.name} has neither lib nor numbers`).toBe(true);
      }
      if (c.counts) expect(hasLib(c.counts), `${id}: counts ${c.counts}`).toBe(true);
    }
  });

  it.skipIf(caseIds().length === 0)('cover every required build and core level', () => {
    const missing = NODES.filter((n) => !n.optional && !n.soon && (n.kind === 'build' || n.kind === 'core') && !caseOf(n.id)).map((n) => n.id);
    expect(missing).toEqual([]);
  });
});

describe('the fuller codex', () => {
  it('belongs to known entries and refers to known parts, blocks and chapters', () => {
    const blocks = new Set(BLOCKS.map((b) => b.id));
    for (const id of moreIds()) {
      expect(codexById(id), `fuller text for unknown entry ${id}`).toBeDefined();
      const m = moreOf(id)!;
      expect(m.idea.trim().length, `${id}: idea`).toBeGreaterThan(40);
      if (m.lib) expect(hasLib(m.lib), `${id}: lib ${m.lib}`).toBe(true);
      for (const c of m.compare ?? []) expect(hasLib(c), `${id}: compare ${c}`).toBe(true);
      for (const b of m.anatomy ?? []) expect(blocks.has(b), `${id}: anatomy ${b}`).toBe(true);
      for (const l of m.chapters ?? []) {
        const ch = chapterById(l.chapter);
        expect(ch, `${id}: chapter ${l.chapter}`).toBeDefined();
        if (l.step !== undefined) expect(l.step, `${id}: ${l.chapter} step`).toBeLessThan(ch!.steps.length);
      }
    }
  });

  it.skipIf(moreIds().length === 0)('covers every entry', () => {
    expect(CODEX.filter((e) => !moreOf(e.id)).map((e) => e.id)).toEqual([]);
  });
});
