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
        if (l.step !== undefined) {
          expect(l.step, `${id}: ${l.chapter} step`).toBeLessThan(ch!.steps.length);
          // The label is the step's title, so a step inserted earlier in the chapter fails here instead of
          // silently pointing the link at its neighbour.
          expect(l.label, `${id}: ${l.chapter} step ${l.step}`).toBe(ch!.steps[l.step].title);
        }
      }
    }
  });

  it.skipIf(moreIds().length === 0)('covers every entry', () => {
    expect(CODEX.filter((e) => !moreOf(e.id)).map((e) => e.id)).toEqual([]);
  });
});

// Numbers the text quotes, measured (they drifted when typed by hand).
describe('numbers in the level text', () => {
  it('the single-cycle core: 79 delays alone, 98 on the bench with its 8-delay memories', async () => {
    const { corePeriod } = await import('../src/campaign/corecheck');
    const { analyzeTiming } = await import('../src/sim/timing');
    const { flatten } = await import('../src/sim/flatten');
    const cpu = resolveComponent('rv16_cpu')!;
    const alone = analyzeTiming(flatten(cpu, { mode: 'gate' }))!.period, bench = corePeriod(cpu)!;
    expect(bench).toBe(nodeById('c_core3')!.par!.period);
    const say = `${alone} delays without memories (${bench} with the bench\'s 8-delay memories)`;
    for (const id of ['a_inc16', 's_pc']) expect(caseOf(id)!.cost, id).toContain(say);
    expect(caseOf('o_fastadd')!.cost).toContain(`(with the bench's 8-delay memories) falls from ${bench} to ${nodeById('c_fast')!.par!.period} delays`);
  });

  it('o_mulseq against the 16 × 16 array', async () => {
    const { stats, logicDepth } = await import('../src/sim/stats');
    const n = nodeById('o_mulseq')!, arr = resolveComponent('amul16')!;
    const cycles = 18, depth = logicDepth(arr)!, nand = stats(arr).nands;
    const fmt = (v: number) => v.toLocaleString('en').replace(/,/g, ' ');
    expect(n.why).toContain(`${cycles} cycles of a ${n.par!.period}-delay clock against one ${depth}-deep pass: about ${(cycles * n.par!.period! / depth).toFixed(1)} times the time`);
    expect(n.why).toContain(`(${fmt(n.par!.nand!)} against ${fmt(nand)})`);
    expect(caseOf('o_mulseq')!.problem).toContain(`${cycles} cycles per product`);
  });

  it('m_ctrl says its refresh interval is scaled from the real one', async () => {
    const { TIMING } = await import('../src/dram/timing');
    const { BUILDM } = await import('../src/campaign/buildm');
    expect(BUILDM.m_ctrl().brief).toContain(`a real chip's 7.8 µs is about ${TIMING.tREFI.toLocaleString('en').replace(/,/g, ' ')} cycles`);
  });
});

describe('codex links', () => {
  // RASTER16 has no depth buffer, k_frame one screen, and the barrel's one-cycle-late memory needs no scoreboard: those
  // entries hang where the text says what is missing (p_spin) or where the idea first appears (the load-use interlock).
  it('point at what the level has', () => {
    const c = (id: string) => nodeById(id)!.codex;
    expect(c('k_raster')).not.toContain('zbuffer');
    expect(c('k_frame')).not.toContain('doublebuffer');
    expect(c('k_warps')).not.toContain('scoreboard');
    expect(c('p_spin')).toEqual(expect.arrayContaining(['doublebuffer', 'zbuffer']));
    expect(nodeById('p_spin')!.why).toMatch(/One screen and no depth buffer/);
    expect(c('pi_haz')).toContain('scoreboard');
  });
});
