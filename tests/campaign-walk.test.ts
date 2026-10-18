// The solution walkthroughs: every level's steps place each part of its reference exactly once,
// the last partial circuit is the reference, the metrics after the last step are Check's score
// with every table row right, costs never fall from one step to the next, and the authored
// scripts name real parts and codex entries.

import { describe, expect, it } from 'vitest';
import { codexById } from '../src/campaign/codex';
import { levelChallenge } from '../src/campaign/levels';
import { NODES, nodeById } from '../src/campaign/nodes';
import { NUDGES } from '../src/campaign/nudges';
import { makeWalk, partialDoc, stepMetrics, walkOf } from '../src/campaign/walk';
import { WALKS } from '../src/campaign/walks';
import { checkChallenge, scoreOf } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { workspace } from './editorkit';
import { breathe } from './setup';

const playable = NODES.filter((n) => levelChallenge(n));
const once = (xs: string[]) => new Set(xs).size === xs.length;

describe('walkthroughs', () => {
  it('are authored for every build and core level, each with one question to predict and a nudge', () => {
    for (const n of playable.filter((x) => x.kind === 'build' || x.kind === 'core')) {
      const script = WALKS[n.id];
      expect(script, `${n.id}: authored walk`).toBeTruthy();
      expect(script.filter((st) => st.ask).length, `${n.id}: one ask`).toBe(1);
      for (const st of script) {
        if (!st.ask) continue;
        expect(st.ask.answer, n.id).toBeLessThan(st.ask.options.length);
        expect(st.ask.why?.length, `${n.id}: a why per option`).toBe(st.ask.options.length);
      }
      expect(NUDGES[n.id]?.trim(), `${n.id}: nudge`).toBeTruthy();
    }
    for (const id of Object.keys(NUDGES)) expect(nodeById(id), `nudge for '${id}'`).toBeTruthy();
  });

  it('draw a wire between two part ports as soon as both parts are placed (one whose ends meet at a point too)', () => {
    for (const n of playable) {
      const w = walkOf(n)!;
      for (const z of w.main.wires) {
        if (!('part' in z.a) || !('part' in z.b)) continue;
        const ends = [z.a.part, z.b.part];
        const k = w.steps.findIndex((_, i) => ends.every((p) => partialDoc(w, i).parts.some((q) => q.id === p)));
        if (k >= 0) expect(partialDoc(w, k).wires.some((x) => x.id === z.id), `${n.id}: wire ${z.id} at step ${k + 1}`).toBe(true);
      }
    }
  });

  it('exist for every playable level and only there', () => {
    for (const n of NODES) expect(!!walkOf(n), n.id).toBe(!!levelChallenge(n));
  });

  it('place each part of the reference exactly once, every wire and pointer at some step, and end on the reference', async () => {
    for (const n of playable) {
      const w = walkOf(n)!;
      const parts = w.steps.flatMap((s) => s.parts);
      expect(once(parts), n.id).toBe(true);
      expect(new Set([...parts, ...w.given]), n.id).toEqual(new Set(w.main.parts.map((p) => p.id)));
      expect(parts.some((p) => w.given.includes(p)), n.id).toBe(false);
      // A step's wires: new, or reshaped (a trunk cut back earlier, now whole); its pointers: new.
      const start = partialDoc(w, -1);
      expect(new Set([...start.wires.map((x) => x.id), ...w.steps.flatMap((s) => s.wires)]), n.id).toEqual(new Set(w.main.wires.map((x) => x.id)));
      expect(new Set([...start.labels.map((x) => x.id), ...w.steps.flatMap((s) => s.labels)]), n.id).toEqual(new Set(w.main.labels.map((x) => x.id)));
      expect(once(w.steps.flatMap((s) => s.labels)), n.id).toBe(true);
      w.steps.forEach((s, k) => {
        const d = partialDoc(w, k);
        for (const x of s.wires) expect(d.wires.some((y) => y.id === x), `${n.id} step ${k}: ${x}`).toBe(true);
      });
      expect(w.steps.every((s) => s.text.length > 0 && s.title.length > 0), n.id).toBe(true);
      const last = partialDoc(w, w.steps.length - 1);
      expect(last.parts, n.id).toEqual(w.main.parts);
      expect(last.wires, n.id).toEqual(w.main.wires);
      expect(last.labels, n.id).toEqual(w.main.labels);
      expect(last.pins, n.id).toEqual(w.main.pins);
      // Before the first step: the pins and the given parts.
      expect(partialDoc(w, -1).parts.map((p) => p.id), n.id).toEqual(w.given);
      // A partial circuit never holds a wire to a part or wire it lacks.
      for (let k = 0; k < w.steps.length; k++) {
        const d = partialDoc(w, k);
        const ps = new Set(d.parts.map((p) => p.id)), ws = new Set(d.wires.map((x) => x.id)), ls = new Set(d.labels.map((l) => l.id));
        for (const x of d.wires) {
          for (const e of [x.a, x.b]) {
            if ('part' in e) expect(ps.has(e.part), `${n.id} step ${k}: ${x.id} → ${e.part}`).toBe(true);
            if ('wire' in e) expect(ws.has(e.wire), `${n.id} step ${k}: ${x.id} → ${e.wire}`).toBe(true);
            if ('label' in e) expect(ls.has(e.label), `${n.id} step ${k}: ${x.id} → ${e.label}`).toBe(true);
          }
        }
      }
      await breathe();
    }
  });

  it('are generated deterministically', async () => {
    for (const n of playable) {
      expect(makeWalk(n), n.id).toEqual(walkOf(n));
      if (WALKS[n.id]) expect(makeWalk(n, null), n.id).toEqual(makeWalk(n, null));
      await breathe();
    }
  });

  it('group a big reference into a handful of steps', () => {
    for (const n of playable) {
      const w = walkOf(n)!;
      if (WALKS[n.id]) continue;
      expect(w.steps.length, n.id).toBeLessThanOrEqual(12);
    }
    // Sixteen XORs side by side and one zero detect: the wide group is halved until there are four steps, not two.
    const eq = makeWalk(nodeById('g_eq16')!, null)!;
    const xors = new Set(eq.main.parts.filter((p) => 'lib' in p.ref && p.ref.lib === 'xor').map((p) => p.id));
    expect(eq.steps.map((s) => s.parts.filter((p) => xors.has(p)).length)).toEqual([4, 4, 8, 0]);
    expect(walkOf(nodeById('a_fa')!)!.steps.map((s) => s.parts)).toEqual([['g1'], ['g2', 'g3', 'g4'], ['g5', 'g9'], ['g6', 'g7', 'g8']]);
  });

  it('generate one short sentence per part from what feeds it', () => {
    const w = makeWalk(nodeById('g_xor')!, null)!;
    expect(w.steps.map((s) => s.authored)).toEqual([false, false, false, false]);
    expect(w.steps[0].text).toBe('Adds g1, a NAND of a and b.');
    expect(w.steps[3].text).toMatch(/^Adds g4, a NAND of g2 and g3; it drives y\. The circuit now matches the reference\.$/);
    expect(makeWalk(nodeById('g_not')!, null)!.steps[0].text).toMatch(/^Adds g, a NAND with both inputs on a/);
    // Splitter outputs are named by the bits they take.
    expect(walkOf(nodeById('a_add4')!)!.steps[0].text).toMatch(/a\[0\]/);
  });

  it('authored scripts name existing parts and codex entries', () => {
    expect(Object.keys(WALKS)).toEqual(expect.arrayContaining(['a_fa', 'a_ha', 'g_and', 'g_mux', 'g_not', 'g_or', 'g_xor', 's_dlatch', 's_sr']));
    for (const [id, script] of Object.entries(WALKS)) {
      const n = nodeById(id);
      expect(n && levelChallenge(n), id).toBeTruthy();
      const w = walkOf(n!)!;
      const ids = new Set(w.main.parts.map((p) => p.id));
      for (const s of script) {
        for (const p of s.parts) expect(ids.has(p), `${id}: part ${p}`).toBe(true);
        for (const c of s.codex ?? []) expect(codexById(c), `${id}: codex ${c}`).toBeDefined();
      }
      expect(w.steps.every((s) => s.authored), id).toBe(true);
    }
  });
});

describe('step metrics', () => {
  it.each(playable.map((n) => [n.id, n] as const))('%s: costs grow step by step and end on Check\'s score', (_, n) => {
    const w = walkOf(n)!, ch = levelChallenge(n)!;
    const ms = w.steps.map((_, k) => stepMetrics(w, k, ch));
    for (let k = 1; k < ms.length; k++) {
      expect(ms[k].nand, `${n.id} step ${k}`).toBeGreaterThanOrEqual(ms[k - 1].nand);
      expect(ms[k].transistors, `${n.id} step ${k}`).toBeGreaterThanOrEqual(ms[k - 1].transistors);
    }
    const last = ms[ms.length - 1];
    for (let k = 1; k < ms.length; k++) {
      // Placing parts only resolves X: an output right on a row stays right.
      ms[k].rows?.forEach((r, i) => expect(r.right, `${n.id} step ${k}: ${r.out}`).toBeGreaterThanOrEqual(ms[k - 1].rows![i].right));
    }
    const lib = new UserLibrary(workspace(w.main, ...w.docs.slice(0, -1)));
    const c = lib.compiled(w.main.id)!;
    const refNet = new Map([...c.netOfEnd].filter(([, v]) => v >= 0));
    // Every partial circuit compiles cleanly (no wire to a missing part, no broken branch) and joins
    // only what the reference joins.
    const plib = new UserLibrary();
    for (let k = -1; k < w.steps.length; k++) {
      plib.update(workspace(partialDoc(w, k), ...w.docs.slice(0, -1)));
      const pc = plib.compiled(w.main.id)!;
      const errs = pc.diags.filter((d) => d.level === 'error' || /branch|wire/.test(d.msg));
      expect(errs.map((d) => d.msg), `${n.id} step ${k}`).toEqual([]);
      const seen = new Map<number, number>();
      for (const [end, net] of pc.netOfEnd) {
        if (net < 0) continue;
        const r = refNet.get(end), first = seen.get(net);
        if (first === undefined) seen.set(net, r!);
        else expect(r, `${n.id} step ${k}: ${end}`).toBe(first);
      }
    }
    // A core level's bench runs programs: compare with the score Check computes, not the whole check.
    const score = ch.check.kind === 'custom' ? scoreOf(c.def, c.mode, true) : checkChallenge(ch, c).score;
    expect({ nand: last.nand, transistors: last.transistors, depth: last.depth }).toEqual({ nand: score.nand, transistors: score.transistors, depth: score.depth });
    if (ch.check.kind === 'table') {
      expect(last.rows!.map((r) => r.out)).toEqual(ch.ports.filter((p) => p.dir === 'out').map((p) => p.name));
      for (const r of last.rows!) expect(r.right, `${n.id}: ${r.out}`).toBe(r.total);
    } else expect(last.rows).toBeUndefined();
  });

  it('count an output nothing drives yet as wrong on every row', () => {
    const n = nodeById('a_ha')!, w = walkOf(n)!, ch = levelChallenge(n)!;
    const m = stepMetrics(w, 0, ch);
    expect(m.rows).toEqual([{ out: 's', right: 0, total: 4 }, { out: 'c', right: 0, total: 4 }]);
    // After the XOR (step 2) s is right and c still undriven.
    expect(stepMetrics(w, 1, ch).rows).toEqual([{ out: 's', right: 4, total: 4 }, { out: 'c', right: 0, total: 4 }]);
    expect(stepMetrics(w, 1, ch)).toMatchObject({ nand: 4, depth: 3 });
  });
});
