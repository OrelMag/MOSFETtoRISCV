// Program puzzles (src/puzzles): the two ports, words through narrow ports, every reference program passing on
// its ready-wired computer's gates with the measurements refdata.json holds (the pars), the same results on the
// event-driven engine, grading, starting a puzzle, the player stepping back and forth, and the CPU drawer's
// golden models sitting out on a puzzle chip.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { loadedIn, PUZZLE_NO_GOLDEN, puzzleIn, puzzleOut, puzzlePortOf, type PuzzleInState, type PuzzleOutState } from '../src/editor/puzzleparts';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { Rv16Monitor } from '../src/editor/cpu16';
import { computerChip, REF_COMPUTERS } from '../src/puzzles/computers';
import { puzzleStars, refFront } from '../src/puzzles/grade';
import { measureOn } from '../src/puzzles/measure';
import { inputOn, outputFrom, PUZZLE_BY_ID, puzzleChipId, puzzleOfChip, PUZZLES } from '../src/puzzles/puzzles';
import { REF_DATA, REFS, refPoints } from '../src/puzzles/refs';
import { PuzzleReplay } from '../src/puzzles/replay';
import { runPuzzle } from '../src/puzzles/run';
import { startCandidates, startPuzzle, withProgram } from '../src/puzzles/start';
import { ISA4_PRESET } from '../src/isa/presets';
import { docFromDef } from '../src/editor/fromdef';
import { RV16_CORE } from '../src/lib/rv16/cpu';

const echo = PUZZLE_BY_ID.get('echo')!;

function compile(ws: Workspace, id: string) {
  const lib = new UserLibrary(ws);
  return { lib, c: lib.compiled(id)! };
}

describe('puzzle ports', () => {
  it('PUZZLE IN hands out its words, one per rising edge with read = 1, and counts reads past the end', () => {
    const d = puzzleIn(8);
    const st = loadedIn([5, 300, 7]);
    const ev = (read: number, clk: number) => d.behavior!.eval([read, clk], st);
    expect(ev(0, 0)).toEqual([5, 1]);
    expect(ev(0, 1)).toEqual([5, 1]); // an edge without read
    expect(ev(1, 0)).toEqual([5, 1]);
    expect(ev(1, 1)).toEqual([300 & 0xff, 1]); // taken at the edge; 8 bits wide
    ev(1, 0);
    expect(ev(1, 1)).toEqual([7, 1]);
    ev(1, 0);
    expect(ev(1, 1)).toEqual([0, 0]); // all taken
    ev(1, 0); ev(1, 1); // past the end
    expect((st as PuzzleInState).over).toBe(1);
    expect((st as PuzzleInState).e).toBe(5);
  });

  it('PUZZLE OUT records data at rising edges with we = 1, X as -1, with the edge number', () => {
    const d = puzzleOut(8);
    const st = d.behavior!.init!() as PuzzleOutState;
    const ev = (data: number, we: number, clk: number) => d.behavior!.eval([data, we, clk], st);
    ev(9, 1, 0); ev(9, 1, 1); ev(4, 0, 0); ev(4, 0, 1); ev(-1, 1, 0); ev(-1, 1, 1);
    expect(st.out).toEqual([9, -1]);
    expect(st.at).toEqual([1, 3]);
  });

  it('is a part reference that resolves, survives the store, and is recognized', () => {
    const d = partDef({ puzzle: 'in', width: 16 }, () => undefined);
    expect('error' in d).toBe(false);
    expect(puzzlePortOf(d as never)).toEqual({ kind: 'in', width: 16 });
    expect('error' in partDef({ puzzle: 'out', width: 33 }, () => undefined)).toBe(true);
    const doc = computerChip('rv16', 'u_pz_echo', 'echo', REFS.rv16.echo);
    const back = sanitizeChip(JSON.parse(JSON.stringify(doc)))!;
    expect(back.parts.filter((p) => 'puzzle' in p.ref).map((p) => p.ref)).toEqual([{ puzzle: 'in', width: 16 }, { puzzle: 'out', width: 16 }]);
  });
});

describe('words through a port of another width', () => {
  it('splits a word into pieces, most significant first, and joins them back', () => {
    const t = { name: '', input: [0xa5, 0x0f], expect: [] };
    expect(inputOn(echo, t, 4)).toEqual([0xa, 0x5, 0x0, 0xf]);
    expect(inputOn(echo, t, 16)).toEqual([0xa5, 0x0f]);
    expect(outputFrom(echo, [0xa, 0x5, 0x0, 0xf], 4)).toEqual([0xa5, 0x0f]);
    expect(outputFrom(echo, [0xa, -1, 3], 4)).toEqual([-1, -1]); // an X piece; an incomplete last word
    expect(outputFrom(echo, [0x1ff], 16)).toEqual([0xff]); // compared mod 2^bits
  });

  it('chips map back to their puzzle', () => {
    for (const p of PUZZLES) expect(puzzleOfChip(puzzleChipId(p))).toBe(p);
    expect(puzzleOfChip('u_main')).toBeUndefined();
  });
});

describe('reference programs', () => {
  for (const c of REF_COMPUTERS) {
    for (const p of PUZZLES) {
      const src = REFS[c.id][p.id];
      if (!src) continue;
      it(`${p.id} on ${c.id}: every test passes, as measured in refdata.json`, () => {
        const { run, point, diags } = measureOn(c.id, p, src);
        expect(diags).toEqual([]);
        expect(run.problems).toEqual([]);
        expect(run.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.why}`)).toEqual([]);
        expect(REF_DATA[p.id]?.find((r) => r.cpu === c.id)).toEqual(point);
      });
    }
  }

  it('every puzzle has a reference on RV16 and RV32, and on the 4-bit CPU unless it needs memory', () => {
    for (const p of PUZZLES) {
      expect(REFS.rv16[p.id], p.id).toBeTruthy();
      expect(REFS.rv32[p.id], p.id).toBeTruthy();
      if (p.group !== 'memory') expect(REFS.cpu4[p.id], p.id).toBeTruthy();
      expect(refPoints(p.id).length, p.id).toBe(p.group === 'memory' ? 2 : 3);
    }
  });

  it('the event-driven engine gives the same words and cycles as the cycle engine', () => {
    for (const cpu of ['cpu4', 'rv16'] as const) {
      const p = PUZZLE_BY_ID.get('add_pairs')!;
      const doc = computerChip(cpu, 'u_pz_x', 'x', REFS[cpu][p.id]);
      const { c } = compile({ ...emptyWorkspace(), chips: { u_pz_x: doc } }, 'u_pz_x');
      const fast = runPuzzle(p, c, doc.pins);
      const es = new EditorSim({ debounceMs: 0 });
      es.setMode('gate');
      es.update(c, doc.pins);
      const replay = new PuzzleReplay(es, p, p.tests());
      p.tests().forEach((_, k) => {
        replay.load(k);
        replay.toEnd();
        const v = replay.read();
        expect(v.verdict?.ok, `${cpu} test ${k}`).toBe(true);
        expect(v.cycle).toBe(fast.results[k].cycles);
        expect(v.got).toEqual(fast.results[k].got);
      });
      replay.end();
    }
  });
});

describe('grading', () => {
  const refs = [{ cpu: 'cpu4' as const, cycles: 100, words: 10, nands: 3000 }, { cpu: 'rv16' as const, cycles: 20, words: 8, nands: 25000 }];
  it('★ when a reference is as cheap and as fast, ★★ on the front, ★★★ under every product', () => {
    expect(puzzleStars({ cycles: 100, nands: 3000, words: 10 }, refs)).toBe(1); // the 4-bit reference itself
    expect(puzzleStars({ cycles: 30, nands: 26000, words: 9 }, refs)).toBe(1); // RV16 is cheaper and faster
    expect(puzzleStars({ cycles: 90, nands: 3500, words: 9 }, refs)).toBe(2);
    expect(puzzleStars({ cycles: 50, nands: 4000, words: 9 }, refs)).toBe(3);
    expect(refFront([...refs, { cpu: 'rv32', cycles: 22, words: 9, nands: 70000 }]).map((r) => r.cpu)).toEqual(['cpu4', 'rv16']);
  });
});

describe('starting a puzzle', () => {
  it('a ready computer: the chip compiles, the reference fills its ROM and passes', () => {
    const p = PUZZLE_BY_ID.get('countdown')!;
    const ws0 = emptyWorkspace();
    const cands = startCandidates(ws0, () => undefined);
    expect(cands.filter((c) => c.tag === 'ready').map((c) => c.lang)).toEqual(['cpu4', 'rv16', 'asm']);
    const r = startPuzzle(ws0, p, { kind: 'ref', cpu: 'cpu4' }, () => undefined);
    if ('error' in r) throw new Error(r.error);
    expect(r.chipId).toBe(puzzleChipId(p));
    const doc = withProgram(r.ws.chips[r.chipId], REFS.cpu4.countdown)!;
    const ws = { ...r.ws, chips: { ...r.ws.chips, [r.chipId]: doc } };
    const { c } = compile(ws, r.chipId);
    expect(runPuzzle(p, c, doc.pins).ok).toBe(true);
  });

  it('a copy of your chip gets the two ports and a halt part, unwired', () => {
    const ws0 = emptyWorkspace();
    const src = computerChip('rv16', 'u_mine', 'Mine', REFS.rv16.echo);
    const mine = { ...src, parts: src.parts.filter((q) => !('puzzle' in q.ref) && !('display' in q.ref)), wires: [] };
    const ws1 = { ...ws0, chips: { ...ws0.chips, u_mine: mine } };
    const { lib } = compile(ws1, 'u_mine');
    const cand = startCandidates(ws1, (id) => lib.defOf(id)).find((c) => c.tag === 'your chip');
    expect(cand?.lang).toBe('rv16');
    const r = startPuzzle(ws1, echo, cand!.choice, (id) => lib.defOf(id));
    if ('error' in r) throw new Error(r.error);
    const doc = r.ws.chips[r.chipId];
    expect(doc.parts.filter((q) => 'puzzle' in q.ref || 'display' in q.ref).map((q) => q.ref)).toEqual([{ puzzle: 'in', width: 8 }, { puzzle: 'out', width: 8 }, { display: 'halt', width: 1 }]);
    expect(r.ws.chips.u_mine).toBe(mine); // the original stays as it was
    const { c } = compile(r.ws, r.chipId);
    expect(runPuzzle(echo, c, doc.pins).ok).toBe(false);
  });
});

describe('the player', () => {
  it('steps forward and back to the same state, and judges like Check', () => {
    const p = PUZZLE_BY_ID.get('stream_sum')!;
    const doc = computerChip('rv16', 'u_pz_s', 's', REFS.rv16.stream_sum);
    const { c } = compile({ ...emptyWorkspace(), chips: { u_pz_s: doc } }, 'u_pz_s');
    const check = runPuzzle(p, c, doc.pins);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, doc.pins);
    const before = es.sim!.saveState();
    const rp = new PuzzleReplay(es, p, p.tests());
    rp.load(4);
    rp.goto(40);
    const at40 = JSON.stringify(rp.read());
    rp.goto(45);
    rp.step(-5);
    expect(JSON.stringify(rp.read())).toBe(at40);
    rp.goto(3);
    rp.goto(40);
    expect(JSON.stringify(rp.read())).toBe(at40);
    rp.toEnd();
    expect(rp.read().verdict).toEqual(check.results[4]);
    rp.end();
    expect(es.sim!.saveState()).toEqual(before);
  });
});

describe('the CPU drawer on a puzzle chip', () => {
  it('the golden model sits out (the program reads PUZZLE IN)', () => {
    const doc = computerChip('rv16', 'u_pz_echo', 'echo', REFS.rv16.echo);
    const ws = { ...emptyWorkspace(), chips: { u_pz_echo: doc } };
    const { c } = compile(ws, 'u_pz_echo');
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, doc.pins);
    const mon = new Rv16Monitor(es, () => doc, () => ws.chips);
    expect(mon.problem).toBe(PUZZLE_NO_GOLDEN);
    expect(mon.checking).toBe(false);
  });
});

describe('a custom instruction set', () => {
  it('a ROM on a table plays like the built-in language, and the start dialog names the table', () => {
    const p = PUZZLE_BY_ID.get('fibonacci')!;
    const base = computerChip('cpu4', 'u_mine4', 'Mine', REFS.cpu4[p.id]);
    const doc = { ...base, parts: base.parts.map((q) => ('rom' in q.ref ? { ...q, ref: { rom: { ...q.ref.rom, lang: 'isa' as const, isa: ISA4_PRESET } } } : q)) };
    const ws = { ...emptyWorkspace(), chips: { u_mine4: doc } };
    const { lib, c } = compile(ws, 'u_mine4');
    const run = runPuzzle(p, c, doc.pins);
    expect(run.ok).toBe(true);
    expect(run.cycles).toBe(refPoints(p.id).find((r) => r.cpu === 'cpu4')!.cycles);
    const cand = startCandidates(ws, (id) => lib.defOf(id)).find((x) => x.tag === 'your chip')!;
    expect(cand.langLabel).toBe(ISA4_PRESET.name);
  });
});

describe('your own core', () => {
  it('the RV16 puzzle computer around a user chip with the core pins runs the references', () => {
    const core = docFromDef(RV16_CORE, { id: 'u_core', name: 'My core' });
    if ('error' in core) throw new Error(core.error);
    const ws0 = { ...emptyWorkspace(), chips: { u_core: core } };
    const def = new UserLibrary(ws0).defOf('u_core')!;
    const p = PUZZLE_BY_ID.get('gcd')!;
    const doc = computerChip('rv16', 'u_pz_gcd', 'gcd', REFS.rv16.gcd, { def, chip: 'u_core' });
    expect(doc.parts.find((q) => q.id === 'cpu')?.ref).toEqual({ chip: 'u_core' });
    const ws = { ...ws0, chips: { ...ws0.chips, u_pz_gcd: doc } };
    const { c } = compile(ws, 'u_pz_gcd');
    const run = runPuzzle(p, c, doc.pins);
    expect(run.ok).toBe(true);
    expect(run.cycles).toBe(refPoints(p.id).find((r) => r.cpu === 'rv16')!.cycles);
  });
});
