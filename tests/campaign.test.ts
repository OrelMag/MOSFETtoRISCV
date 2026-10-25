// The campaign: the graph is well formed (acyclic, required never depends on optional, every
// reference resolves), every playable level's reference answer passes its own test set under the
// campaign's rule and meets par, the map and the anatomy diagram have no overlaps, and progress
// survives storage, export and import.

import { describe, expect, it } from 'vitest';
import { BLOCKS, blockNodes, LINKS } from '../src/campaign/anatomy';
import { partNames } from '../src/campaign/cardlabel';
import { CODEX, codexById } from '../src/campaign/codex';
import { measured, stars } from '../src/campaign/grade';
import { ancestors, nextAvailable, ruleFor, statusOf, topo } from '../src/campaign/graph';
import { FOLDED_H, foldedActs, MAP_MIN_SCALE, MAP_MIN_W, mapColsFor, mapLayout, NODE_H, NODE_W, OPTIONAL_ACTS } from '../src/campaign/layout';
import { LESSONS } from '../src/campaign/lessons';
import { levelChallenge, levelChipId, nodeOfChip, startCandidates, startFrom } from '../src/campaign/levels';
import { ACTS, NODES, nodeById } from '../src/campaign/nodes';
import { CAMPAIGN_KEY, exportCampaign, importCampaign, mergeCampaign, Progress, sanitizeCampaign } from '../src/campaign/progress';
import { chapterById } from '../src/chapters';
import { checkChallenge, type LibRule, libAllowed, startChallenge } from '../src/editor/challenges';
import { checkSimulatable } from '../src/editor/compile';
import { UserLibrary } from '../src/editor/library';
import { deadParts, openInputs } from '../src/editor/lint';
import { emptyWorkspace } from '../src/editor/model';
import { resolveComponent } from '../src/lib/resolve';
import { chip, part, pin, wire, workspace } from './editorkit';
import { deadInstances } from '../src/sim/dead';
import { type ComponentDef, netlistOf } from '../src/sim/types';

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
        if (l.step !== undefined) expect(l.label, `${n.id}: ${l.chapter} step ${l.step}`).toBe(ch!.steps[l.step].title);
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

  // "Parts you may place" lists names: two parts under one name (rv16_rf and the library's regfile8x16, 2 172 and
  // 2 627 NANDs) cannot be told apart.
  it('lists no two unlocked parts under one name', () => {
    for (const n of playable) {
      const ids = ruleFor(n.id).lib.filter((u) => !u.endsWith('*'));
      const byName = new Map<string, string[]>();
      for (const u of ids) {
        const d = resolveComponent(u), k = d?.name ?? u;
        if (d?.category !== 'plumbing') byName.set(k, [...(byName.get(k) ?? []), u]); // constants: free, and named by value
      }
      expect([...byName.values()].filter((v) => v.length > 1), n.id).toEqual([]);
    }
  });

  // Without a par any pass is ★★★ (grade.ts stars).
  it('has a par; every drill is graded on mistakes', () => {
    const graded = NODES.filter((n) => n.kind !== 'lesson' && !n.soon);
    expect(graded.filter((n) => !n.par || !Object.keys(n.par).length).map((n) => n.id)).toEqual([]);
    expect(graded.filter((n) => n.kind === 'drill' && n.par?.mistakes === undefined).map((n) => n.id)).toEqual([]);
  });

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
    for (const d of chips) {
      expect(checkSimulatable(lib.compiled(d.id)!), d.id).toEqual([]);
      // No orphans: every part reaches an output (dead gates would inflate par), every input is wired.
      expect(deadParts(d, lib.compiled(d.id)!), d.id).toEqual([]);
      expect(openInputs(lib.compiled(d.id)!), d.id).toEqual([]);
    }
    // No part serves only an output the level does not check (it would inflate par; a free extra pin like busy is fine).
    const asked = new Set(c.ports.map((p) => p.name));
    const top = lib.compiled(main.id)!.def;
    expect(deadInstances(netlistOf(top)!, top.ports.filter((p) => asked.has(p.name))), 'parts serving only unchecked outputs').toEqual([]);
    const r = checkChallenge(c, lib.compiled(main.id));
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(stars(measured(r.score), n.par)).toBe(3);
  });

  // A part a level unlocks costs what its reference counts (docs/CAMPAIGN.md section 9): where the 49-NAND bus mux is
  // unlocked, no reference holds the library's 64-NAND one or a tree of them, at any depth (memories aside: given).
  it('hold no library 16-bit bus mux where the 49-NAND one is unlocked', () => {
    const LIB16 = /^(mux2x16|mux2tree16|mux\d+x16(_p\d+)?)$/, MEMORY = /^(ram|sb_rom)/;
    const found = new Set<string>();
    for (const n of playable) {
      if (!libAllowed(ruleFor(n.id), 'rv16_mux16')) continue;
      const chips = levelChallenge(n)!.answer();
      const main = chips[chips.length - 1];
      const top = new UserLibrary(workspace(main, ...chips.slice(0, -1))).compiled(main.id)!.def;
      const seen = new Set<ComponentDef>();
      const walk = (d: ComponentDef): void => {
        if (seen.has(d) || MEMORY.test(d.id)) return;
        seen.add(d);
        if (LIB16.test(d.id)) found.add(n.id);
        else if (d.netlist && !d.prim) for (const i of d.netlist().instances) walk(i.def);
      };
      walk(top);
    }
    expect([...found].sort()).toEqual([]);
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

  // A gate-level level is scored in NANDs, where a transistor counts as none: act 0's cells (unlocked by t_inv,
  // t_nor) and raw MOSFETs would make g_not free and g_mux cheaper than par.
  it('keeps transistor-level parts out of every gate-level level', () => {
    const lv = NODES.filter((n) => levelChallenge(n));
    const gateLevel = lv.filter((n) => {
      const a = levelChallenge(n)!.allowed;
      return typeof a === 'object' && !a.strict && !(n.par?.transistors !== undefined && n.par.nand === undefined);
    });
    expect(gateLevel.length).toBeGreaterThan(80);
    for (const n of gateLevel) {
      const rule = levelChallenge(n)!.allowed as LibRule;
      for (const id of ['inv_cmos', 'nor_cmos', 'rv16_dramcol']) expect(libAllowed(rule, id), `${n.id}: ${id}`).toBe(false);
      expect(rule.gates, n.id).toBe(true);
    }
    // m_sense is switch level: its rule keeps them.
    expect((levelChallenge(nodeById('m_sense')!)!.allowed as LibRule).gates).toBeFalsy();
    const io = [pin('a', 'in', [0, 8]), pin('y', 'out', [30, 8])];
    const cell = chip('u_n', 'n', { pins: io, parts: [part('g', { lib: 'inv_cmos' }, [10, 0])], wires: [wire('w1', 'pin:a', 'g.a'), wire('w2', 'g.y', 'pin:y')] });
    const fets = chip('u_f', 'f', {
      pins: io,
      parts: [part('v', { lib: 'vdd' }, [12, 0]), part('p', { lib: 'pmos' }, [10, 3]), part('m', { lib: 'nmos' }, [10, 11]), part('z', { lib: 'gnd' }, [12, 18])],
      wires: [wire('w1', 'pin:a', 'p.g'), wire('w2', 'pin:a', 'm.g'), wire('w3', 'v.p', 'p.s'), wire('w4', 'p.d', 'pin:y'), wire('w5', 'm.d', 'pin:y'), wire('w6', 'm.s', 'z.p')],
    });
    // What the level lists is that rule: g_not is NAND only, and the brief states no rule of its own.
    expect(ruleFor('g_not')).toMatchObject({ lib: ['nand'], label: 'NAND only' });
    for (const n of lv) expect(levelChallenge(n)!.brief, n.id).not.toMatch(/only gate allowed|NAND only/i);
    // Families are listed by name, not as globs.
    const names = partNames(ruleFor('g_eq16').lib.filter((x) => x !== 'nand'), (u) => resolveComponent(u)?.name);
    expect(names).toContain('zero detect (any width)');
    expect(names.join()).not.toMatch(/…|\*/);
    expect(partNames(['rv16_mux*', 'mux2'], (u) => resolveComponent(u)?.name)).toEqual(['RV16 bus multiplexers', '2:1 Multiplexer']);
    for (const [c, why] of [[cell, /CMOS inverter: transistor level/], [fets, /transistor: transistor level/]] as const) {
      const r = checkChallenge(levelChallenge(nodeById('g_not')!)!, new UserLibrary(workspace(c)).compiled(c.id));
      expect(r.ok, c.id).toBe(false);
      expect(r.restrictionViolations.join(), c.id).toMatch(why);
    }
  });
});

describe('the map and the anatomy', () => {
  it('places every level without overlaps, inside its act band, however many columns a line holds', () => {
    for (const cols of [Infinity, 6, 5, 4, 3, 2, 1]) {
      const L = mapLayout(cols);
      expect(L.nodes.size).toBe(NODES.length);
      expect(L.cols).toBeLessThanOrEqual(cols);
      const ps = [...L.nodes.values()];
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        const band = L.bands.find((b) => b.act === a.node.act)!;
        expect(a.y >= band.y && a.y + NODE_H <= band.y + band.h && a.x + NODE_W <= L.w, `${cols}: ${a.node.id}`).toBe(true);
        for (let j = i + 1; j < ps.length; j++) {
          const b = ps[j];
          const apart = a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
          expect(apart, `${cols}: ${a.node.id} / ${b.node.id}`).toBe(true);
        }
      }
    }
  });

  it('fits its pane at desktop and phone widths, shrunk by at most MAP_MIN_SCALE', () => {
    // the map pane beside the level panel at 1280 / 1366 / 1440 / 1920 px, and on a 390 px phone
    for (const pane of [836, 922, 994, 1036, 340]) {
      const L = mapLayout(mapColsFor(pane));
      expect(Math.min(1, pane / L.w), String(pane)).toBeGreaterThanOrEqual(MAP_MIN_SCALE);
    }
    expect(mapLayout(1).w).toBe(MAP_MIN_W);
    // balanced wrapping: no act leaves a column alone on its last line when its lines could share them
    for (const cols of [2, 3, 4, 5]) {
      const L = mapLayout(cols);
      for (const b of L.bands) {
        const ps = [...L.nodes.values()].filter((p) => p.node.act === b.act);
        const perLine = new Map<number, Set<number>>();
        for (const p of ps) perLine.set(p.line, (perLine.get(p.line) ?? new Set()).add(p.x));
        const counts = [...perLine.values()].map((s) => s.size);
        expect(Math.max(...counts) - Math.min(...counts), `${cols}: act ${b.act}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('folds the optional acts to a header until one of their levels is opened, or as the learner left them', () => {
    // Act P and the acts after the finale; never the main path
    expect([...OPTIONAL_ACTS].sort((a, b) => a - b)).toEqual([8, 9, 10, 11]);
    const none = () => undefined;
    expect(foldedActs(none, none)).toEqual(OPTIONAL_ACTS);
    // a level of act P opened (its state exists), or selected: act P unfolds
    expect(foldedActs((id) => (id === 'r_pull' ? { status: 'started' as const } : undefined), none).has(11)).toBe(false);
    expect(foldedActs(none, none, 'r_nand').has(11)).toBe(false);
    // the learner's choice wins either way, except for the selected level's act
    expect(foldedActs(none, (a) => a === 11).has(11)).toBe(false);
    expect(foldedActs((id) => (id === 'r_pull' ? { status: 'started' as const } : undefined), () => false).has(11)).toBe(true);
    expect(foldedActs(none, () => false, 'r_nand').has(11)).toBe(false);
  });

  it('a folded act is one header line: none of its levels placed, the acts after it moved up', () => {
    for (const cols of [Infinity, 4, 1]) {
      const open = mapLayout(cols), L = mapLayout(cols, OPTIONAL_ACTS);
      for (const p of L.nodes.values()) expect(OPTIONAL_ACTS.has(p.node.act), p.node.id).toBe(false);
      expect(L.nodes.size).toBe(NODES.filter((n) => !OPTIONAL_ACTS.has(n.act)).length);
      const bandP = L.bands.find((b) => b.act === 11)!;
      expect(bandP).toMatchObject({ folded: true, h: FOLDED_H });
      // act 1 starts right below act 0 and act P's header
      const act1 = (m: typeof L) => m.bands.find((b) => b.act === 1)!.y;
      expect(act1(L)).toBe(bandP.y + FOLDED_H + (act1(open) - open.bands.find((b) => b.act === 11)!.y - open.bands.find((b) => b.act === 11)!.h));
      expect(act1(L)).toBeLessThan(act1(open));
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

describe('continue from your previous core', () => {
  it('offers the nearest earlier core chip and copies it with the new level\'s pins', () => {
    const core3 = levelChallenge(nodeById('c_core3')!)!.answer().at(-1)!;
    const yIrq = nodeById('y_irq')!;
    let ws = emptyWorkspace();
    expect(startCandidates(yIrq, ws)).toEqual([]);
    const c3 = levelChipId(nodeById('c_core3')!);
    ws = { ...ws, chips: { ...ws.chips, [c3]: { ...core3, id: c3, name: 'Core III' } } };
    expect(startCandidates(yIrq, ws).map((n) => n.id)).toEqual(['c_core3']);
    expect(startCandidates(nodeById('g_and')!, ws)).toEqual([]);
    // a lane core never starts from a scalar core (other pins); the SIMT core starts from the SIMD core
    const fin = levelChipId(nodeById('y_final')!), simd = levelChipId(nodeById('k_simd')!);
    const ws2 = { ...ws, chips: { ...ws.chips, [fin]: { ...core3, id: fin }, [simd]: { ...core3, id: simd } } };
    expect(startCandidates(nodeById('k_simd')!, ws2)).toEqual([]);
    expect(startCandidates(nodeById('k_simt')!, ws2).map((n) => n.id)).toEqual(['k_simd']);
    // the two-warp core adds pins (warp, the load port) to the lane core's: it starts from either
    const simt = levelChipId(nodeById('k_simt')!);
    const ws3 = { ...ws2, chips: { ...ws2.chips, [simt]: { ...core3, id: simt } } };
    expect(startCandidates(nodeById('k_warps')!, ws3).map((n) => n.id)).toEqual(['k_simt', 'k_simd']);
    const r = startFrom(ws, levelChallenge(yIrq)!, c3);
    const doc = r.ws.chips[r.chipId];
    expect(r.created).toBe(true);
    expect(doc.parts).toEqual(core3.parts);
    expect(doc.pins.map((p) => p.name).sort()).toEqual([...core3.pins.map((p) => p.name), 'irq'].sort());
    expect(new Set(doc.pins.map((p) => p.id)).size).toBe(doc.pins.length);
    // Already started: opened as it is.
    const again = startFrom(r.ws, levelChallenge(yIrq)!, c3);
    expect(again.created).toBe(false);
    expect(again.ws.chips[r.chipId]).toBe(doc);
  });
});

describe('codex datasheets', () => {
  it('a component entry reads its parts from the library: pins, cost, a small part\'s truth table', async () => {
    const { datasheets } = await import('../src/campaign/datasheet');
    const withSheets = CODEX.filter((e) => e.kind === 'component' && datasheets(e.id).length);
    expect(withSheets.length).toBeGreaterThan(10);
    for (const e of withSheets) for (const d of datasheets(e.id)) {
      expect(d.pins.length, d.id).toBeGreaterThan(0);
      expect(d.nand, d.id).toBeGreaterThanOrEqual(0);
      if (d.table) expect(d.table.rows.length).toBe(2 ** d.pins.filter((p) => p.dir === 'in').reduce((a, p) => a + p.width, 0));
    }
  });
});

describe('map lines', () => {
  it('draws only direct requirements: every requirement left out is reached through a drawn one', async () => {
    const { drawnRequires } = await import('../src/campaign/ui/svgs');
    let left = 0;
    for (const n of NODES) {
      const drawn = drawnRequires(n);
      for (const r of n.requires) {
        if (drawn.includes(r) || r === 'intro') continue;
        left++;
        expect(drawn.some((d) => ancestors(d).has(r)), `${n.id} ← ${r}`).toBe(true);
      }
    }
    expect(left).toBeGreaterThan(0);
  });
});
