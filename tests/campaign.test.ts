// The campaign: the graph is well formed (acyclic, required never depends on optional, every
// reference resolves), every playable level's reference answer passes its own test set under the
// campaign's rule and meets par, the map and the anatomy diagram have no overlaps, and progress
// survives storage, export and import.

import { describe, expect, it } from 'vitest';
import { BLOCKS, blockNodes, LINKS } from '../src/campaign/anatomy';
import { CODEX, codexById } from '../src/campaign/codex';
import { measured, stars } from '../src/campaign/grade';
import { ancestors, nextAvailable, ruleFor, statusOf, topo } from '../src/campaign/graph';
import { mapLayout, NODE_H, NODE_W } from '../src/campaign/layout';
import { LESSONS } from '../src/campaign/lessons';
import { levelChallenge, levelChipId, nodeOfChip } from '../src/campaign/levels';
import { ACTS, NODES, nodeById } from '../src/campaign/nodes';
import { CAMPAIGN_KEY, exportCampaign, importCampaign, mergeCampaign, Progress, sanitizeCampaign } from '../src/campaign/progress';
import { chapterById } from '../src/chapters';
import { checkChallenge, libAllowed, startChallenge } from '../src/editor/challenges';
import { checkSimulatable } from '../src/editor/compile';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { resolveComponent } from '../src/lib/resolve';
import { chip, part, pin, wire, workspace } from './editorkit';
import type { ComponentDef } from '../src/sim/types';

class MapKV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe('the campaign graph', () => {
  it('has unique ids, known requirements, and no cycle', () => {
    expect(new Set(NODES.map((n) => n.id)).size).toBe(NODES.length);
    for (const n of NODES) for (const r of n.requires) expect(nodeById(r), `${n.id} requires ${r}`).toBeDefined();
    expect(topo().length).toBe(NODES.length);
  });

  it('starts from the intro, and a required level never builds on an optional one', () => {
    const roots = NODES.filter((n) => !n.requires.length);
    expect(roots.map((n) => n.id)).toEqual(['intro']);
    for (const n of NODES.filter((x) => !x.optional)) {
      for (const a of ancestors(n.id)) expect(nodeById(a)!.optional, `${n.id} ← ${a}`).toBeFalsy();
    }
  });

  it('every act has levels, and requirements never point to a later act', () => {
    for (const a of ACTS) expect(NODES.some((n) => n.act === a.num), `act ${a.num}`).toBe(true);
    for (const n of NODES) for (const r of n.requires) expect(nodeById(r)!.act, `${n.id} ← ${r}`).toBeLessThanOrEqual(n.act);
  });

  it('codex entries, lessons, chapter links and unlocks all resolve', () => {
    expect(new Set(CODEX.map((e) => e.id)).size).toBe(CODEX.length);
    for (const e of CODEX) for (const r of e.related ?? []) expect(codexById(r), `${e.id} → ${r}`).toBeDefined();
    for (const n of NODES) {
      for (const c of n.codex) expect(codexById(c), `${n.id}: codex ${c}`).toBeDefined();
      if (n.body && !n.soon) expect(LESSONS[n.body], `${n.id}: lesson ${n.body}`).toBeDefined();
      for (const l of n.chapters ?? []) {
        const ch = chapterById(l.chapter);
        expect(ch, `${n.id}: chapter ${l.chapter}`).toBeDefined();
        expect(l.step ?? 0).toBeLessThan(ch!.steps.length);
      }
      for (const u of n.unlocks ?? []) if (!u.endsWith('*')) expect(resolveComponent(u), `${n.id} unlocks ${u}`).toBeDefined();
    }
    // Every codex entry is taught somewhere.
    const taught = new Set(NODES.flatMap((n) => n.codex));
    for (const e of CODEX) expect(taught.has(e.id), `codex ${e.id} is in no level`).toBe(true);
  });

  it('a level\'s rule is NAND plus what its requirements unlock, never its own parts', () => {
    const r = ruleFor('g_xor');
    expect(libAllowed(r, 'nand')).toBe(true);
    expect(libAllowed(r, 'and')).toBe(true);
    expect(libAllowed(r, 'or')).toBe(true);
    expect(libAllowed(r, 'xor')).toBe(false);
    expect(libAllowed(ruleFor('m_ram'), 'dec2e')).toBe(true);
    expect(libAllowed(ruleFor('m_ram'), 'mux4x4')).toBe(true);
  });

  it('status follows requirements; Unlock all opens everything', () => {
    const st: Record<string, { status?: 'solved' | 'skipped' | 'started' }> = {};
    const view = (id: string) => st[id];
    expect(statusOf(nodeById('intro')!, view)).toBe('available');
    expect(statusOf(nodeById('t_inv')!, view)).toBe('locked');
    expect(statusOf(nodeById('t_inv')!, view, true)).toBe('available');
    st.intro = { status: 'solved' };
    expect(statusOf(nodeById('t_inv')!, view)).toBe('available');
    st.t_inv = { status: 'skipped' };
    expect(statusOf(nodeById('t_nand')!, view)).toBe('available');
    expect(nextAvailable(view)?.id).toBe('t_nand');
  });
});

describe('every playable level', () => {
  const playable = NODES.filter((n) => levelChallenge(n));

  it('has a chip of its own, separate from the sandbox challenge', () => {
    expect(playable.length).toBeGreaterThanOrEqual(15);
    for (const n of playable) {
      expect(levelChallenge(n)!.id).toBe(`cp_${n.id}`);
      expect(nodeOfChip(levelChipId(n))).toBe(n);
      expect(startChallenge(emptyWorkspace(), levelChallenge(n)!).chipId).toBe(levelChipId(n));
    }
  });

  it.each(playable.map((n) => [n.id, n] as const))('%s: the reference answer passes under the campaign rule and meets par', (_, n) => {
    const c = levelChallenge(n)!;
    const chips = c.answer();
    const main = chips[chips.length - 1];
    const lib = new UserLibrary(workspace(main, ...chips.slice(0, -1)));
    for (const d of chips) expect(checkSimulatable(lib.compiled(d.id)!), d.id).toEqual([]);
    const r = checkChallenge(c, lib.compiled(main.id));
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(stars(measured(r.score), n.par)).toBe(3);
  });
});

describe('the campaign rule in a check', () => {
  it('rejects a part the level has not unlocked, accepts one it has', () => {
    // XOR from the library XOR: not unlocked for g_xor (it is what the level builds).
    const xorLib = chip('u_x', 'x', {
      pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('y', 'out', [20, 3])],
      parts: [part('g', { lib: 'xor' }, [8, 1])],
      wires: [wire('w1', 'pin:a', 'g.a'), wire('w2', 'pin:b', 'g.b'), wire('w3', 'g.y', 'pin:y')],
    });
    const lib = new UserLibrary(workspace(xorLib));
    const r = checkChallenge(levelChallenge(nodeById('g_xor')!)!, lib.compiled('u_x'));
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations.join()).toMatch(/not unlocked/);
    // The same circuit for the half adder's XOR part is fine: g_xor is below a_ha.
    expect(libAllowed(ruleFor('a_ha'), 'xor')).toBe(true);
  });
});

describe('the map and the anatomy', () => {
  it('places every level without overlaps', () => {
    const L = mapLayout();
    expect(L.nodes.size).toBe(NODES.length);
    const ps = [...L.nodes.values()];
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const apart = a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
        expect(apart, `${a.node.id} / ${b.node.id}`).toBe(true);
      }
    }
  });

  it('every block is built by some level, no two blocks overlap, links name blocks', () => {
    const by = blockNodes();
    for (const b of BLOCKS) expect(by.get(b.id)!.length, b.id).toBeGreaterThan(0);
    for (let i = 0; i < BLOCKS.length; i++) {
      for (let j = i + 1; j < BLOCKS.length; j++) {
        const a = BLOCKS[i], b = BLOCKS[j];
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} / ${b.id}`).toBe(true);
      }
    }
    for (const l of LINKS) {
      expect(BLOCKS.some((b) => b.id === l.from)).toBe(true);
      expect(BLOCKS.some((b) => b.id === l.to)).toBe(true);
    }
  });
});

describe('progress', () => {
  it('solve keeps the best, skip unlocks, stars follow par', () => {
    const kv = new MapKV();
    const p = new Progress(kv);
    expect(p.solve('g_xor', { nand: 7, depth: 4 }).stars).toBe(1);
    expect(p.solve('g_xor', { nand: 5, depth: 3 }).stars).toBe(2);
    const r = p.solve('g_xor', { nand: 9, depth: 9 });
    expect(r.best).toBe(false);
    expect(p.get('g_xor')!.stars).toBe(2);
    p.skip('g_xor');
    expect(p.get('g_xor')!.status).toBe('solved');
    p.skip('g_or');
    expect(p.get('g_or')!.status).toBe('skipped');
    p.unskip('g_or');
    expect(p.get('g_or')!.status).toBeUndefined();
    // Saved and reloaded.
    const q = new Progress(kv);
    expect(q.get('g_xor')!.best).toEqual({ nand: 5, depth: 3 });
    expect(JSON.parse(kv.getItem(CAMPAIGN_KEY)!).nodes.g_xor.stars).toBe(2);
    p.reset();
    expect(kv.getItem(CAMPAIGN_KEY)).toBeNull();
  });

  it('codex entries unlock with solved / skipped levels and opened lessons', () => {
    const p = new Progress(new MapKV());
    expect(p.codexUnlocked().has('demorgan')).toBe(false);
    p.open('l_bool');
    expect(p.codexUnlocked().has('demorgan')).toBe(true);
    expect(p.codexUnlocked().has('xor')).toBe(false);
    p.skip('g_xor');
    expect(p.codexUnlocked().has('xor')).toBe(true);
    p.setUnlockAll(true);
    expect(p.codexUnlocked().size).toBe(new Set(NODES.flatMap((n) => n.codex)).size);
  });

  it('sanitizes what it reads', () => {
    const st = sanitizeCampaign({ unlockAll: 'yes', nodes: { g_xor: { status: 'solved', stars: 7, best: { nand: -1, depth: 3, evil: 1 } }, nope: { status: 'solved' }, g_and: 5 } });
    expect(st).toEqual({ schema: 1, nodes: { g_xor: { status: 'solved', best: { depth: 3 } } } });
  });

  it('merges: furthest status, better result', () => {
    const a = sanitizeCampaign({ nodes: { g_xor: { status: 'solved', stars: 1, best: { nand: 7, depth: 4 } }, g_or: { status: 'started' } } });
    const b = sanitizeCampaign({ unlockAll: true, nodes: { g_xor: { status: 'skipped', stars: 3, best: { nand: 4, depth: 3 } }, g_or: { status: 'skipped' } } });
    const m = mergeCampaign(a, b);
    expect(m.unlockAll).toBe(true);
    expect(m.nodes.g_xor).toMatchObject({ status: 'solved', stars: 3, best: { nand: 4, depth: 3 } });
    expect(m.nodes.g_or.status).toBe('skipped');
  });

  it('exports progress with the level chips and imports them into another workspace', () => {
    const p = new Progress(new MapKV());
    p.solve('g_not', { nand: 1, depth: 1 });
    const n = nodeById('g_not')!;
    const ws = startChallenge(emptyWorkspace(), levelChallenge(n)!).ws;
    const text = exportCampaign(p.state, ws);
    const r = importCampaign(text, new Progress(new MapKV()).state, emptyWorkspace());
    if ('error' in r) throw new Error(r.error);
    expect(r.state.nodes.g_not.stars).toBe(3);
    expect(r.ws.chips[levelChipId(n)]).toBeDefined();
    expect(importCampaign('{"format":"x"}', p.state, ws)).toEqual({ error: 'not a campaign export' });
    expect(importCampaign('nope', p.state, ws)).toEqual({ error: 'not JSON' });
  });
});

describe('the cache level', () => {
  it('a "cache" that always goes to memory fails: on a hit the memory is not read', async () => {
    const { Builder } = await import('../src/lib/builder');
    const { TIE0 } = await import('../src/lib/transistors');
    const b = new Builder();
    b.pins('clk', 'addr', 'rd', 'wr', 'wdata', 'mdata');
    b.wire('mdata', 'rdata');
    b.wire(b.op1(TIE0, []), 'hit');
    const fake: ComponentDef = {
      id: 'fake_cache', name: 'no cache', category: 'memory', symbol: { kind: 'box' },
      ports: levelChallenge(nodeById('o_cache')!)!.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir === 'out' ? 'out' : 'in' })),
      netlist: () => ({ instances: b.instances, nets: b.nets() }),
    };
    const { docFromDef } = await import('../src/editor/fromdef');
    const doc = docFromDef(fake, { id: 'u_fake_cache' });
    if ('error' in doc) throw new Error(doc.error);
    const r = checkChallenge(levelChallenge(nodeById('o_cache')!)!, new UserLibrary(workspace(doc)).compiled(doc.id));
    expect(r.ok).toBe(false);
  });
});
