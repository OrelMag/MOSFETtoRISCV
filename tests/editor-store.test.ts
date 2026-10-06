// Persistence: storage round trip, damaged and future data, file export / import.

import { describe, expect, it } from 'vitest';
import { emptyChip, emptyWorkspace, type ChipDoc, type Vec, type Workspace } from '../src/editor/model';
import {
  BACKUP_KEY, FORMAT, KEY, closure, exportJson, importJson, loadWorkspace, migrate, sanitizeChip, saveWorkspace, type KV,
} from '../src/editor/store';

class MapKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

/** A chip placing the given chips, with one pin and one wire so content is not trivial. */
function chip(id: string, uses: string[] = [], name = id): ChipDoc {
  return {
    ...emptyChip(id, name),
    pins: [{ id: 'pin1', name: 'a', dir: 'in', width: 1, at: [0, 0] }],
    parts: uses.map((u, i) => ({ id: `u${i + 1}`, ref: { chip: u }, at: [10, 4 * i] as Vec })),
    wires: uses.length ? [{ id: 'w1', a: { pin: 'pin1' }, b: { part: 'u1', port: 'a' }, pts: [[5, 0]] }] : [],
  };
}

const ws = (...chips: ChipDoc[]): Workspace => ({ schema: 1, chips: Object.fromEntries(chips.map((c) => [c.id, c])), open: [chips[0].id] });

describe('storage', () => {
  it('round-trips a workspace', () => {
    const kv = new MapKV();
    const w = { ...ws(chip('u_full', ['u_half']), chip('u_half')), purist: true };
    expect(saveWorkspace(w, kv)).toEqual({ ok: true });
    expect(loadWorkspace(kv)).toEqual(w);
  });

  it('starts empty when nothing is stored, and without storage', () => {
    expect(loadWorkspace(new MapKV())).toEqual(emptyWorkspace());
    expect(loadWorkspace(null)).toEqual(emptyWorkspace());
    expect(saveWorkspace(emptyWorkspace(), null).ok).toBe(false);
  });

  it('keeps corrupt or future data aside instead of losing it', () => {
    for (const bad of ['{not json', JSON.stringify({ schema: 99, chips: {} })]) {
      const kv = new MapKV();
      kv.setItem(KEY, bad);
      expect(loadWorkspace(kv)).toEqual(emptyWorkspace());
      expect(kv.getItem(BACKUP_KEY)).toBe(bad);
    }
  });

  it('reports a full storage', () => {
    const kv = new MapKV();
    kv.setItem = () => { throw Object.assign(new Error('exceeded the quota'), { name: 'QuotaExceededError' }); };
    const r = saveWorkspace(emptyWorkspace(), kv);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/full/);
  });

  it('never throws, even when storage does', () => {
    const kv = new MapKV();
    kv.getItem = () => { throw new Error('denied'); };
    expect(loadWorkspace(kv)).toEqual(emptyWorkspace());
  });
});

describe('migrate', () => {
  it('refuses a future schema and non-workspaces', () => {
    expect(migrate({ schema: 2, chips: {} })).toEqual({ error: expect.stringMatching(/newer/) });
    expect('error' in migrate([])).toBe(true);
    expect('error' in migrate({ chips: {} })).toBe(true);
  });

  it('drops objects with missing fields and wires that ended on them', () => {
    const raw = {
      schema: 1,
      open: ['u_a', 'u_gone', 'u_a'],
      chips: {
        u_a: {
          id: 'u_a', name: 'A', hue: 400, extra: 'ignored',
          pins: [{ id: 'pin1', name: 'x', dir: 'in', width: 1, at: [0, 0] }, { id: 'pin2', name: 'y', dir: 'sideways', width: 1, at: [0, 2] },
            { id: 'pin3', name: 'x', dir: 'out', width: 1, at: [9, 9] }, { id: 'pin4', name: 'io', dir: 'inout', width: 1, at: [0, 4] }],
          parts: [{ id: 'g1', ref: { lib: 'nand' }, at: [4, 0] }, { id: 'g2', ref: { bogus: 1 }, at: [4, 8] }, { id: 'g3', at: [1, 1] }],
          wires: [
            { id: 'w1', a: { pin: 'pin1' }, b: { part: 'g1', port: 'a' }, pts: [] },
            { id: 'w2', a: { pin: 'pin2' }, b: { part: 'g1', port: 'b' }, pts: [] },
            { id: 'w3', a: { wire: 'w2', at: [2, 2] }, b: { part: 'g1', port: 'b' }, pts: [] },
            { id: 'w4', a: { pin: 'pin1' }, b: { part: 'g1', port: 'b' }, pts: [[1, 'x']] },
          ],
          labels: [{ id: 'l1', name: '', at: [0, 0] }, { id: 'l2', name: 'clk', at: [3, 3], face: 'diagonal' }],
        },
        u_b: { name: 'no id' },
      },
    };
    const r = migrate(raw);
    expect('error' in r).toBe(false);
    const w = r as Workspace;
    expect(Object.keys(w.chips)).toEqual(['u_a']);
    expect(w.open).toEqual(['u_a']);
    const a = w.chips.u_a;
    expect(a.hue).toBe(40);
    expect('extra' in a).toBe(false);
    expect(a.pins.map((p) => p.id)).toEqual(['pin1', 'pin4']); // pin2 bad dir, pin3 duplicate name
    expect(a.parts.map((p) => p.id)).toEqual(['g1']);
    expect(a.wires.map((x) => x.id)).toEqual(['w1']); // w2 → pin2 gone, w3 → w2 gone, w4 bad corner
    expect(a.labels).toEqual([{ id: 'l2', name: 'clk', at: [3, 3] }]);
  });

  it('keeps a well-formed flip-flop marking, drops a malformed one', () => {
    const ff = { d: 'd', q: 'q', clk: 'clk', en: 'en' };
    expect(sanitizeChip({ id: 'u_f', ff: { ...ff, extra: 1 } })!.ff).toEqual(ff);
    expect(sanitizeChip({ id: 'u_f', ff: { d: 'd', q: 'q' } })!.ff).toBeUndefined();
    expect(sanitizeChip({ id: 'u_f', ff: { d: 'd', q: 'q', clk: 'c', en: 3 } })!.ff).toBeUndefined();
  });

  it('sanitizes every part kind', () => {
    const refs = [
      { lib: 'nand' }, { chip: 'u_x' }, { split: [1, 3], pitch: 2 }, { merge: [4] }, { const: { width: 4, value: 9 } },
      { display: 'seg7', width: 4 }, { rom: { k: 4, w: 32, addr: 'rv32', lang: 'asm', src: 'nop' } }, { ram: { k: 4, w: 8 } },
    ];
    const c = sanitizeChip({ id: 'u_k', parts: refs.map((ref, i) => ({ id: `p${i}`, ref, at: [0, 0] })) })!;
    expect(c.parts.map((p) => p.ref)).toEqual(refs);
    expect(c.name).toBe('u_k');
    const bad = [{ split: [] }, { const: { width: 0, value: 1 } }, { display: 'lamp' }, { rom: { k: 4, w: 12, addr: 'word', lang: 'hex', src: '' } }, { ram: { k: 4 } }];
    expect(sanitizeChip({ id: 'u_k', parts: bad.map((ref, i) => ({ id: `p${i}`, ref, at: [0, 0] })) })!.parts).toEqual([]);
  });
});

describe('files', () => {
  const w = ws(chip('u_top', ['u_mid', 'u_leaf']), chip('u_mid', ['u_leaf']), chip('u_leaf'), chip('u_other'));

  it('closure lists dependencies first, each once', () => {
    expect(closure(w, ['u_top']).map((c) => c.id)).toEqual(['u_leaf', 'u_mid', 'u_top']);
    expect(closure(w, ['u_other', 'u_mid', 'u_missing']).map((c) => c.id)).toEqual(['u_other', 'u_leaf', 'u_mid']);
  });

  it('export then import into an empty workspace adds the closure', () => {
    const text = exportJson(w, ['u_top']);
    expect(JSON.parse(text)).toMatchObject({ format: FORMAT, schema: 1 });
    const r = importJson(text, emptyWorkspace());
    if ('error' in r) throw new Error(r.error);
    expect(r.added).toEqual(['u_leaf', 'u_mid', 'u_top']);
    expect(r.ws.chips.u_top).toEqual(w.chips.u_top);
  });

  it('skips identical chips, renames differing ones and rewrites references to them', () => {
    // The target already has the same u_leaf, a different u_mid, and nothing else.
    const target = ws(chip('u_leaf'), chip('u_mid', [], 'Mine'));
    const r = importJson(exportJson(w, ['u_top']), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.skipped).toEqual(['u_leaf']);
    expect(r.renamed).toEqual({ u_mid: 'u_mid_2' });
    expect(r.added).toEqual(['u_mid_2', 'u_top']);
    expect(r.ws.chips.u_mid).toBe(target.chips.u_mid); // never overwritten
    expect(r.ws.chips.u_mid_2.parts[0].ref).toEqual({ chip: 'u_leaf' });
    expect(r.ws.chips.u_top.parts.map((p) => p.ref)).toEqual([{ chip: 'u_mid_2' }, { chip: 'u_leaf' }]);
    // Importing the same file again changes nothing new for identical chips.
    const again = importJson(exportJson(w, ['u_leaf']), r.ws);
    expect('error' in again ? again : again.added).toEqual([]);
  });

  it('a changed dependency renames its users too', () => {
    const target = ws(chip('u_leaf', [], 'Other leaf'), chip('u_mid', ['u_leaf']));
    const r = importJson(exportJson(w, ['u_mid']), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.renamed).toEqual({ u_leaf: 'u_leaf_2', u_mid: 'u_mid_2' });
    expect(r.ws.chips.u_mid_2.parts[0].ref).toEqual({ chip: 'u_leaf_2' });
  });

  it('rejects files that are not exports', () => {
    expect(importJson('nope', emptyWorkspace())).toEqual({ error: expect.any(String) });
    expect(importJson('{"format":"other","schema":1,"chips":[]}', emptyWorkspace())).toEqual({ error: expect.any(String) });
    expect(importJson(`{"format":"${FORMAT}","schema":7,"chips":[]}`, emptyWorkspace())).toEqual({ error: expect.stringMatching(/newer/) });
    expect(importJson(`{"format":"${FORMAT}","schema":1,"chips":[{"name":"x"}]}`, emptyWorkspace())).toEqual({ error: expect.any(String) });
  });
});
