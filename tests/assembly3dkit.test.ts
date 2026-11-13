// The assembly line on the studio renderer (widgets/assembly3dkit.ts): every part of it that moves or lights comes from the
// schedule tests/model-assembly.test.ts holds to the gate-level pipeline (forwardA / forwardB included): a pallet per
// palletsAt pallet, placed by its move; a chute lit and a value riding it exactly on the clocks that forward through it;
// the stall tag on a load-use stall only; the flush arm only around a flush, swung about its pivot.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { pipeSchedule } from '../src/riscv/pipetrace';
import { HAZARDS } from '../src/chapters/ch-pipe';
import { applyMat } from '../src/gl/kit/scene';
import { kindOfWord, palletsAt } from '../src/widgets/assembly3dparts';
import { ARM_PIVOT, BEAT_EVENTS, armAngle, armMove, armShown, asmModel, chutePath, chutesUsed, clockOf, palletMove, riders, type AsmLook, type AsmRgb } from '../src/widgets/assembly3dkit';

const words = assemble(HAZARDS).words, plan = pipeSchedule(words, 60);
const word = (pc: number) => words[(pc >>> 2) & 63] ?? 0;
const ctx = { kindOf: (pc: number) => kindOfWord(word(pc)), mnemonicOf: (pc: number) => disasm(word(pc), pc).split(' ')[0], textOf: (pc: number) => disasm(word(pc), pc), hexOf: (pc: number) => String(pc) };
const rgb: AsmRgb = { alu: [0, 0, 1], load: [0, 1, 0], store: [1, 0, 1], ctl: [1, 1, 0], wrong: [1, 0, 0], bubble: [0.3, 0.3, 0.3], hold: [0, 1, 1], off: [0.2, 0.2, 0.2], fwd: [1, 0.8, 0.2] };
const look = (t: number, u = 1, detail: AsmLook['detail'] = 'full'): AsmLook => ({ detail, plan, t, u, ctx, rgb });

describe('what moves comes from the schedule', () => {
  it('a pallet item pair per palletsAt pallet, grouped for its move; the move puts it where palletsAt says, at its size', () => {
    for (const [t, u] of [[5, 1], [8, 0.4], [12, 0]] as const) {
      const m = asmModel(look(t, u)), ps = palletsAt(plan, t, u, ctx);
      for (const p of ps) expect(m.items.some((it) => it.group === `pal${p.seq}`)).toBe(true);
      expect(new Set(m.items.filter((it) => it.group?.startsWith('pal')).map((it) => it.group)).size).toBe(ps.length);
      for (const p of ps) {
        const at = applyMat(palletMove(p), [0, 0, 0]), one = applyMat(palletMove(p), [1, 0, 0]);
        at.forEach((v, k) => expect(v).toBeCloseTo([p.x, p.y, p.z][k], 4));
        expect(one[0] - at[0]).toBeCloseTo(Math.max(1e-3, p.size), 5);
      }
    }
  });
  it('a chute is lit, and a value rides it, exactly on the clocks the hazard unit forwards through it', () => {
    let seen = 0;
    plan.forEach((c, t) => {
      const used = chutesUsed(c), m = asmModel(look(t));
      expect(used.size).toBe(new Set(c.fwd.filter((f) => f > 0)).size);
      for (const from of [3, 4] as const) {
        const chute = m.items.find((it) => it.name === `forwarding from ${from === 3 ? 'Memory' : 'Writeback'}`)!;
        expect(!!chute.mat.emit).toBe(used.has(from));
      }
      const r = riders(c, 1, rgb);
      expect(r).toHaveLength(used.size);
      r.forEach((x) => { const end = chutePath(3)[5]; expect(x.pos[0]).toBeCloseTo(end[0], 9); expect(x.pos[1]).toBeCloseTo(end[1], 9); });
      if (used.size) seen++;
    });
    expect(seen).toBeGreaterThan(0);
  });
  it('the stall tag only on a load-use stall; the flush arm only around a flush, still unless its edge is under way', () => {
    plan.forEach((c, t) => {
      const m = asmModel(look(t));
      expect(m.items.some((it) => it.group === 'stall')).toBe(c.stall);
      expect(m.items.some((it) => it.group === 'arm')).toBe(armShown(plan, t));
      expect(armAngle(plan, t, 1)).toBeCloseTo(0, 9);
      if (t > 0 && plan[t - 1].flush) expect(armAngle(plan, t, 0.5)).toBeGreaterThan(1);
      else expect(armAngle(plan, t, 0.5)).toBe(0);
    });
  });
  it('the arm turns about its pivot, back toward the far side of the belt', () => {
    const [py, pz] = ARM_PIVOT, piv = applyMat(armMove(0.8), [5, py, pz]);
    expect(piv[1]).toBeCloseTo(py, 5); expect(piv[2]).toBeCloseTo(pz, 5);
    expect(applyMat(armMove(0.8), [0, py - 10, pz])[2]).toBeLessThan(pz);
  });
});

describe('the tour', () => {
  it('each beat goes to the first clock its event happens on in the chapter’s hazard program', () => {
    expect(BEAT_EVENTS).toHaveLength(asmModel(look(0)).beats!.length);
    const st = clockOf(plan, 'stall')!, fl = clockOf(plan, 'flush')!, fw = clockOf(plan, 'forward')!;
    expect(plan[st].stall).toBe(true); expect(plan.slice(0, st).some((c) => c.stall)).toBe(false);
    expect(plan[fl].flush).toBe(true);
    expect(chutesUsed(plan[fw]).size).toBeGreaterThan(0);
    expect(plan[clockOf(plan, 'full')!].slots.every((s) => s.valid)).toBe(true);
  });
  it('the flat drawing places the pallets itself (no moves there)', () => {
    const m = asmModel(look(9, 0.5, 'flat')), ps = palletsAt(plan, 9, 0.5, ctx);
    for (const p of ps) expect(m.items.find((it) => it.group === `pal${p.seq}`)!.at).toEqual([p.x, p.y, p.z]);
  });
});
