import { describe, expect, it } from 'vitest';
import '../src/lib';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type TableDoc, type Workspace } from '../src/editor/model';
import { sanitizeChip } from '../src/editor/store';
import { isGenerated } from '../src/editor/hdl';
import {
  addInput, addOutput, detachTable, equation, newTableChip, removeInput, removeOutput, setTable, tableCost, tableDef, tableLogic, tableMatches,
} from '../src/editor/ttable';
import { cover, minimumCover } from '../src/lib/sop';
import { setUserResolver } from '../src/lib/resolve';
import { evalOnce, simulate } from '../src/sim/harness';
import { deadInstances } from '../src/sim/dead';
import { netlistOf } from '../src/sim/types';

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

function randomTable(r: () => number, n: number, m: number, form: TableDoc['form']): TableDoc {
  const ins = 'abcdefgh'.split('').slice(0, n), outs = ['y', 'z', 's', 't', 'u', 'v', 'w', 'q'].slice(0, m);
  const dcRate = r() < 0.5 ? 0 : 0.3;
  const rows = outs.map(() => Array.from({ length: 1 << n }, () => (r() < dcRate ? '-' : r() < 0.5 ? '1' : '0')).join(''));
  return { ins, outs, rows, form };
}

/** Every row of the table on the gates of a def (ports: the inputs, then the outputs). */
function checkDef(t: TableDoc, def: ReturnType<typeof tableDef>): void {
  const sim = simulate(def);
  const got = Array.from({ length: 1 << t.ins.length }, (_, r) => evalOnce(sim, t.ins.map((_, i) => (r >> (t.ins.length - 1 - i)) & 1)));
  t.outs.forEach((o, j) => expect(tableMatches(t, j, (r) => got[r][j]), `${o} of ${JSON.stringify(t)}`).toBe(true));
}

const compileAll = (ws: Workspace, id: string) => {
  const lib = new UserLibrary(ws);
  setUserResolver(lib.resolver());
  const c = lib.compiled(id)!;
  expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
  return lib.defOf(id)!;
};

describe('two-level minimization (lib/sop.ts)', () => {
  it('uses don\'t-cares: BCD "is prime" is a 2:1 mux', () => {
    const terms = minimumCover(4, [2, 3, 5, 7], [10, 11, 12, 13, 14, 15]);
    expect(terms.length).toBe(2);
    expect(terms.reduce((a, t) => a + 4 - [...t.mask.toString(2)].filter((c) => c === '1').length, 0)).toBe(4);
  });
  it('falls back to a greedy cover past the budget, still a cover', () => {
    const r = rng(11);
    const ones = Array.from({ length: 256 }, (_, i) => i).filter(() => r() < 0.5);
    const c = cover(8, ones, [], 50);
    expect(c.exact).toBe(false);
    for (const m of ones) expect(c.terms.some((t) => (m & ~t.mask) === t.val)).toBe(true);
  });
});

describe('truth-table chips (editor/ttable.ts)', () => {
  it('builds every random table correctly, in both forms', () => {
    const r = rng(7);
    for (let k = 0; k < 60; k++) {
      const n = 1 + Math.floor(r() * 5), m = 1 + Math.floor(r() * 3);
      const t = randomTable(r, n, m, k % 2 ? 'andor' : 'nand');
      const def = tableDef(t);
      checkDef(t, def);
      expect(deadInstances(netlistOf(def)!, def.ports), JSON.stringify(t)).toEqual([]);
    }
  });

  it('NAND–NAND uses only NANDs and inverters', () => {
    const r = rng(3);
    for (let k = 0; k < 20; k++) {
      const t = randomTable(r, 2 + Math.floor(r() * 3), 2, 'nand');
      const ids = new Set(netlistOf(tableDef(t))!.instances.map((i) => i.def.id));
      for (const id of ids) expect(['nand', 'nand3', 'not', 'tie0', 'tie1'].includes(id) || /^and\d*$/.test(id), id).toBe(true);
    }
  });

  it('shares a term between outputs and states the equations', () => {
    // y = a·b, z = a·b + c
    const t: TableDoc = { ins: ['a', 'b', 'c'], outs: ['y', 'z'], rows: ['00000011', '01010111'], form: 'andor' };
    const logic = tableLogic(t);
    expect(logic.terms.length).toBe(2);
    expect(equation(t, 0, logic)).toBe('y = a·b');
    expect(equation(t, 1, logic)).toMatch(/^z = (c \+ a·b|a·b \+ c)$/);
    expect(tableCost(t).nands).toBeGreaterThan(0);
  });

  it('a new chip compiles to its table, redraws on edits, keeps input values, detaches', () => {
    let { ws, id } = newTableChip(emptyWorkspace());
    expect(isGenerated(ws, id)).toBe(true);
    const t = ws.chips[id].table!;
    checkDef(t, compileAll(ws, id));
    // XOR of a and b, c a don't-care
    const next: TableDoc = { ...t, rows: ['0-1-1-0-'] };
    ws = { ...ws, chips: { ...ws.chips, [id]: { ...ws.chips[id], pins: ws.chips[id].pins.map((p) => (p.name === 'a' ? { ...p, value: 1 } : p)) } } };
    const w2 = setTable(ws, id, next);
    if ('error' in w2) throw new Error(w2.error);
    checkDef(next, compileAll(w2, id));
    expect(w2.chips[id].pins.find((p) => p.name === 'a')!.value).toBe(1);
    expect(setTable(w2, id, { ...next, outs: ['a'] })).toHaveProperty('error');
    const d = detachTable(w2, id);
    expect(isGenerated(d, id)).toBe(false);
    expect(d.chips[id].parts).toEqual(w2.chips[id].parts);
  });

  it('constant outputs and every input count from 1 to 8', () => {
    for (let n = 1; n <= 8; n++) {
      const t: TableDoc = { ins: 'abcdefgh'.split('').slice(0, n), outs: ['y', 'z', 'p'], rows: ['0'.repeat(1 << n), '1'.repeat(1 << n), Array.from({ length: 1 << n }, (_, r) => ([...r.toString(2)].filter((c) => c === '1').length % 2 ? '1' : '0')).join('')], form: n % 2 ? 'nand' : 'andor' };
      const { ws, id } = newTableChip(emptyWorkspace(), t);
      checkDef(t, compileAll(ws, id));
    }
  });

  it('adding / removing pins keeps the function', () => {
    const t: TableDoc = { ins: ['a', 'b'], outs: ['y'], rows: ['0110'], form: 'nand' };
    const t2 = addInput(t);
    expect(t2.ins).toEqual(['a', 'b', 'c']);
    expect(t2.rows[0]).toBe('00111100');
    expect(removeInput(t2, 2)).toEqual(t);
    const t3 = addOutput(t);
    expect(t3.outs).toEqual(['y', 'z']);
    expect(removeOutput(t3, 1)).toEqual(t);
  });

  it('survives the store\'s sanitizer, and a broken table is dropped', () => {
    const { ws, id } = newTableChip(emptyWorkspace());
    expect(sanitizeChip(JSON.parse(JSON.stringify(ws.chips[id])))!.table).toEqual(ws.chips[id].table);
    expect(sanitizeChip({ ...ws.chips[id], table: { ...ws.chips[id].table, rows: ['01'] } })!.table).toBeUndefined();
  });
});
