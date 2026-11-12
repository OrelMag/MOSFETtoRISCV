// The one-file backup: round trip, merges that keep both sides, rejection of foreign files, idempotence.

import { describe, expect, it } from 'vitest';
import { CAMPAIGN_FORMAT, CAMPAIGN_KEY } from '../src/campaign/progress';
import { NODES } from '../src/campaign/nodes';
import { emptyChip, emptyWorkspace, type ChipDoc, type Vec, type Workspace } from '../src/editor/model';
import { MAIN_PROJECT, PROJECTS_KEY, createProject, projectKey, readProjects } from '../src/editor/projects';
import { FORMAT, KEY, loadWorkspace, saveWorkspace } from '../src/editor/store';
import { PUZZLES_KEY } from '../src/puzzles/grade';
import { NOTES_KEY } from '../src/ui/notes';
import { REVIEW_KEY } from '../src/ui/review';
import { LEARN_KEY } from '../src/learn/store';
import { MapKV, SETTINGS_KEY, applyMerge, makeBackup, mergeBackup, readBackup, summarize } from '../src/ui/backup';

function chip(id: string, uses: string[] = [], name = id): ChipDoc {
  return {
    ...emptyChip(id, name),
    pins: [{ id: 'pin1', name: 'a', dir: 'in', width: 1, at: [0, 0] }],
    parts: uses.map((u, i) => ({ id: `u${i + 1}`, ref: { chip: u }, at: [10, 4 * i] as Vec })),
    wires: [],
  };
}
const ws = (...chips: ChipDoc[]): Workspace => ({ ...emptyWorkspace(), chips: Object.fromEntries(chips.map((c) => [c.id, c])), open: [chips[0].id] });

const builds = NODES.filter((n) => n.kind === 'build');
const levelA = builds[0].id;
const levelB = builds[1].id;

interface Opts { visited?: Record<string, number[]>; solved?: Record<string, boolean>; theme?: string; camp?: Record<string, unknown>; puzzles?: unknown; chips?: ChipDoc[]; extra?: Record<string, string> }

function device(opts: Opts): MapKV {
  const kv = new MapKV();
  kv.setItem(SETTINGS_KEY, JSON.stringify({ theme: opts.theme ?? 'auto', visited: opts.visited ?? {}, solved: opts.solved ?? {}, openActs: {} }));
  if (opts.camp) kv.setItem(CAMPAIGN_KEY, JSON.stringify({ schema: 1, nodes: opts.camp }));
  if (opts.puzzles) kv.setItem(PUZZLES_KEY, JSON.stringify(opts.puzzles));
  if (opts.chips) saveWorkspace(ws(...opts.chips), kv, KEY);
  for (const [k, v] of Object.entries(opts.extra ?? {})) kv.setItem(k, v);
  return kv;
}

const fileOf = (kv: MapKV) => {
  const r = readBackup(makeBackup(kv, '9.9.9'));
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('backup', () => {
  it('round trips every owned key', () => {
    const a = device({
      visited: { ch1: [0, 1, 2] }, solved: { 'ch1:2': true }, camp: { [levelA]: { status: 'solved', stars: 2 } },
      puzzles: { p1: { stars: 2, best: { cycles: 10, nands: 100, words: 4 } } }, chips: [chip('u_x')], extra: { 'mosfet2riscv:hdl-width': '300' },
    });
    a.setItem('other-site:key', 'x');
    const { file } = fileOf(a);
    expect(Object.keys(file.keys).sort()).toEqual([...a.map.keys()].filter((k) => k.startsWith('mosfet2riscv:')).sort());
    const b = new MapKV();
    expect(applyMerge(mergeBackup(file, b), b).ok).toBe(true);
    expect(summarize(b)).toEqual(summarize(a));
    expect(b.getItem('mosfet2riscv:hdl-width')).toBe('300');
    expect(b.getItem('other-site:key')).toBeNull();
    // merging again changes nothing
    expect(mergeBackup(file, b).writes).toEqual({});
  });

  it('merges chapter progress by union and keeps local preferences', () => {
    const a = device({ visited: { ch1: [0, 1], ch2: [0] }, solved: { 'ch1:1': true }, theme: 'dark' });
    const b = device({ visited: { ch1: [1, 2], ch3: [4] }, solved: { 'ch3:4': true }, theme: 'light' });
    applyMerge(mergeBackup(fileOf(b).file, a), a);
    const st = JSON.parse(a.getItem(SETTINGS_KEY)!);
    expect(st.visited).toEqual({ ch1: [0, 1, 2], ch2: [0], ch3: [4] });
    expect(st.solved).toEqual({ 'ch1:1': true, 'ch3:4': true });
    expect(st.theme).toBe('dark');
  });

  it('merges the campaign, puzzles and chips without losing either side', () => {
    const mine = device({
      camp: { [levelA]: { status: 'solved', stars: 3 } }, puzzles: { p1: { stars: 3, best: { cycles: 5, nands: 50, words: 1 } } },
      chips: [chip('u_mine'), chip('u_same', [], 'Same')],
    });
    const theirs = device({
      camp: { [levelA]: { status: 'started' }, [levelB]: { status: 'solved', stars: 1 } },
      puzzles: { p1: { stars: 1, best: { cycles: 1, nands: 1, words: 1 } }, p2: { stars: 2, best: { cycles: 9, nands: 9, words: 1 } } },
      chips: [chip('u_theirs'), chip('u_same', ['u_theirs'], 'Same, edited')],
    });
    const m = mergeBackup(fileOf(theirs).file, mine);
    expect(m.after.chips).toBeGreaterThan(m.before.chips);
    applyMerge(m, mine);
    const camp = JSON.parse(mine.getItem(CAMPAIGN_KEY)!).nodes;
    expect(camp[levelA]).toMatchObject({ status: 'solved', stars: 3 });
    expect(camp[levelB]).toMatchObject({ status: 'solved', stars: 1 });
    const pz = JSON.parse(mine.getItem(PUZZLES_KEY)!);
    expect(pz.p1.stars).toBe(3);
    expect(pz.p2.stars).toBe(2);
    const w = loadWorkspace(mine, KEY);
    expect(Object.keys(w.chips)).toEqual(expect.arrayContaining(['u_mine', 'u_theirs', 'u_same']));
    expect(w.chips.u_same.name).toBe('Same');
    expect(Object.keys(w.chips).length).toBe(4); // the edited u_same came in under another id
  });

  it('adds other projects under their own id, once', () => {
    const mine = device({ chips: [chip('u_a')] });
    const theirs = device({ chips: [chip('u_a')] });
    const made = createProject('CPU build', ws(chip('u_p')), theirs);
    if (!made.ok) throw new Error(made.reason);
    const { file } = fileOf(theirs);
    applyMerge(mergeBackup(file, mine), mine);
    const idx = readProjects(mine);
    expect(idx.list.map((p) => p.id)).toEqual([MAIN_PROJECT, made.id]);
    expect(idx.list[1].name).toBe('CPU build');
    expect(Object.keys(loadWorkspace(mine, projectKey(made.id)).chips)).toEqual(['u_p']);
    expect(mine.getItem(PROJECTS_KEY)).not.toBeNull();
    expect(mergeBackup(file, mine).writes).toEqual({});
  });

  it('keeps local small preferences and says so; unreadable parts are listed, never silently dropped', () => {
    const mine = device({ extra: { 'mosfet2riscv:hdl-width': '300' } });
    const raw = {
      format: 'mosfet2riscv-backup', schema: 1,
      keys: { 'mosfet2riscv:hdl-width': '500', 'mosfet2riscv:fsm-wide': '1', [CAMPAIGN_KEY]: '{not json', 'evil:key': 'x', [PUZZLES_KEY]: '[1]' },
    };
    const f = readBackup(JSON.stringify(raw));
    if ('error' in f) throw new Error(f.error);
    expect(f.dropped).toEqual(['evil:key']);
    const m = mergeBackup(f.file, mine);
    applyMerge(m, mine);
    expect(mine.getItem('mosfet2riscv:hdl-width')).toBe('300');
    expect(mine.getItem('mosfet2riscv:fsm-wide')).toBe('1');
    expect(m.notes.join('\n')).toMatch(/campaign progress/);
    expect(m.notes.join('\n')).toMatch(/puzzle progress/);
    expect(m.notes.join('\n')).toMatch(/1 small preference/);
  });

  it('rejects files that are not backups and points at the right import', () => {
    const err = (t: string) => { const r = readBackup(t); return 'error' in r ? r.error : ''; };
    expect(err('nope')).toMatch(/not a JSON/);
    expect(err('[1]')).toMatch(/not a backup/);
    expect(err('{"format":"x"}')).toMatch(/not a From Switch/);
    expect(err(JSON.stringify({ format: CAMPAIGN_FORMAT }))).toMatch(/campaign page/);
    expect(err(JSON.stringify({ format: FORMAT }))).toMatch(/sandbox/);
    expect(err(JSON.stringify({ format: 'mosfet2riscv-backup', schema: 99, keys: {} }))).toMatch(/newer/);
    expect(err(JSON.stringify({ format: 'mosfet2riscv-backup', schema: 1 }))).toMatch(/no data/);
  });
});

describe('backup of My path', () => {
  it('keeps every test-out and the later start', () => {
    const mine = new MapKV([[LEARN_KEY, JSON.stringify({ schema: 1, start: { persona: 'new', tier: 0, at: 5 }, tested: { basics: 6 } })]]);
    const theirs = new MapKV([[LEARN_KEY, JSON.stringify({ schema: 1, start: { persona: 'logic', tier: 2, at: 9 }, tested: { adders: 7 } })]]);
    const r = readBackup(makeBackup(theirs));
    if ('error' in r) throw new Error(r.error);
    expect(applyMerge(mergeBackup(r.file, mine), mine)).toEqual({ ok: true });
    const st = JSON.parse(mine.getItem(LEARN_KEY)!);
    expect(st.tested).toEqual({ basics: 6, adders: 7 });
    expect(st.start.persona).toBe('logic');
    expect(summarize(mine).other).toBe(0);
  });
});

describe('backup of notes and review', () => {
  const at = 1_700_000_000_000;
  const note = (id: string, text: string, edited: number) => ({ id, type: 'note', place: { kind: 'step', chapter: 'adders', step: 1 }, title: '', text, at, edited });
  const memo = (last: number, miss = false) => ({ n: 1, last, streak: miss ? 0 : 1, due: last, ...(miss ? { miss: true, missed: last } : {}) });

  it('keeps notes and review history from both sides, the newest edit winning', () => {
    const mine = new MapKV([
      [NOTES_KEY, JSON.stringify({ schema: 1, items: { a: note('a', 'mine old', at + 1), b: note('b', 'only mine', at + 5) } })],
      [REVIEW_KEY, JSON.stringify({ schema: 1, memos: { 'c:1': memo(at + 10, true), 'c:2': memo(at + 20) } })],
    ]);
    const theirs = new MapKV([
      [NOTES_KEY, JSON.stringify({ schema: 1, items: { a: note('a', 'theirs newer', at + 9), c: note('c', 'only theirs', at + 2) } })],
      [REVIEW_KEY, JSON.stringify({ schema: 1, memos: { 'c:1': memo(at + 30), 'c:3': memo(at + 4, true) } })],
    ]);
    const r = readBackup(makeBackup(theirs));
    if ('error' in r) throw new Error(r.error);
    const res = mergeBackup(r.file, mine);
    expect(applyMerge(res, mine)).toEqual({ ok: true });
    const notes = JSON.parse(mine.getItem(NOTES_KEY)!).items;
    expect(Object.keys(notes).sort()).toEqual(['a', 'b', 'c']);
    expect(notes.a.text).toBe('theirs newer');
    const memos = JSON.parse(mine.getItem(REVIEW_KEY)!).memos;
    expect(Object.keys(memos).sort()).toEqual(['c:1', 'c:2', 'c:3']);
    expect(memos['c:1'].last).toBe(at + 30);
    expect(memos['c:1'].miss).toBeUndefined();
    // the same file again changes nothing, and the keys are not counted as small preferences
    expect(Object.keys(mergeBackup(r.file, mine).writes)).toEqual([]);
    expect(summarize(mine).other).toBe(0);
  });

  it('takes the file as it is where nothing is stored, and lists an unreadable part', () => {
    const theirs = new MapKV([[NOTES_KEY, JSON.stringify({ schema: 1, items: { a: note('a', 'x', at) } })], [REVIEW_KEY, '[1]']]);
    const r = readBackup(makeBackup(theirs));
    if ('error' in r) throw new Error(r.error);
    const res = mergeBackup(r.file, new MapKV());
    expect(JSON.parse(res.writes[NOTES_KEY]).items.a.text).toBe('x');
    expect(res.notes.some((n) => n.includes('review history'))).toBe(true);
    expect(res.writes[REVIEW_KEY]).toBeUndefined();
  });
});

describe('the summary lists everything a backup merges', () => {
  it('notes, bookmarks, the review queue and My path appear in describe()', async () => {
    const { describe: lines } = await import('../src/ui/backup');
    const kv = device({});
    kv.setItem(NOTES_KEY, JSON.stringify({ schema: 1, items: {
      n1: { id: 'n1', type: 'note', text: 'hi', at: 1, edited: 1, place: { kind: 'step', chapter: 'basics', step: 0 } },
      b1: { id: 'b1', type: 'bookmark', text: '', at: 2, edited: 2, place: { kind: 'step', chapter: 'basics', step: 1 } } } }));
    kv.setItem(REVIEW_KEY, JSON.stringify({ schema: 1, memos: { q1: { n: 1, last: 1, due: 2, streak: 1 } } }));
    kv.setItem(LEARN_KEY, JSON.stringify({ schema: 1, tested: { basics: 5 } }));
    const s = summarize(kv);
    expect([s.notes, s.bookmarks, s.reviewed, s.testedOut]).toEqual([1, 1, 1, 1]);
    const text = lines(s).join('\n');
    expect(text).toMatch(/Notes: 1 note, 1 bookmark/);
    expect(text).toMatch(/Review queue/);
    expect(text).toMatch(/My path: 1 chapter tested out/);
  });
});

describe('backup of a hostile or damaged settings value', () => {
  // Release review N2: a "__proto__" chapter made moveProgress throw (nothing imported) and could set a merged object's prototype.
  const raw = '{"moved":0,"visited":{"__proto__":[1],"gates":[0]},"solved":{"__proto__":true,"gates:1":true},"openActs":{"__proto__":{"x":1}}}';
  for (const mineHas of [false, true]) {
    it(`loses only the "__proto__" entries (${mineHas ? 'merged' : 'into a fresh browser'})`, () => {
      const mine = new MapKV(mineHas ? [[SETTINGS_KEY, JSON.stringify({ visited: { adders: [1] } })]] : []);
      const r = readBackup(JSON.stringify({ format: 'mosfet2riscv-backup', schema: 1, keys: { [SETTINGS_KEY]: raw } }));
      if ('error' in r) throw new Error(r.error);
      expect(applyMerge(mergeBackup(r.file, mine), mine)).toEqual({ ok: true });
      const st = JSON.parse(mine.getItem(SETTINGS_KEY)!);
      expect(Object.getPrototypeOf(st.visited)).toBe(Object.prototype);
      expect(Object.keys(st.visited)).not.toContain('__proto__');
      expect(st.visited.gates).toEqual([0]);
      expect(st.solved['gates:1']).toBe(true);
      expect(Object.keys(st.solved)).not.toContain('__proto__');
    });
  }
});
