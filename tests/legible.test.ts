import { describe, expect, it } from 'vitest';
import { hiddenKinds, NAME_MIN_PX, nameLayout, planLayouts, planTags, TAG_MAX_K, LABEL_UNITS, NAME_PX, MIN_TEXT_PX, nameEligible, nameRotated, needsFixedNames, planNames, TEXT_UNITS, type NameBox } from '../src/view/legible';
import { fpAdd, fpMul, fpDiv, type FpFormat } from '../src/lib/fpu';
import { fpAddNearFar } from '../src/lib/fpnearfar';
import { symbolGeom } from '../src/sim/geometry';

const box = (cx: number, cy: number, w: number, h: number, chars = 6): NameBox => ({ cx, cy, w, h, chars, rot: nameRotated(w, h) });

describe('text thresholds', () => {
  it('hides a kind exactly when it would render under 7 px', () => {
    const at = MIN_TEXT_PX / TEXT_UNITS.port;
    expect(hiddenKinds(at - 0.01)).toContain('port');
    expect(hiddenKinds(at + 0.01)).not.toContain('port');
  });
  it('hides everything at a CPU-sized fit and nothing when zoomed in', () => {
    expect(hiddenKinds(1.5).sort()).toEqual(Object.keys(TEXT_UNITS).sort());
    expect(hiddenKinds(30)).toEqual([]);
  });
  it('keeps block names fixed until the label itself reaches 12 px', () => {
    expect(needsFixedNames(NAME_PX / LABEL_UNITS - 0.01)).toBe(true);
    expect(needsFixedNames(NAME_PX / LABEL_UNITS + 0.01)).toBe(false);
    expect(needsFixedNames(0)).toBe(false);
  });
});

describe('which blocks get a name', () => {
  it('skips unnamed, one-character, constant-like and small blocks', () => {
    expect(nameEligible(undefined, 20, 20)).toBe(false);
    expect(nameEligible('1', 20, 20)).toBe(false);
    expect(nameEligible('0', 20, 20)).toBe(false);
    expect(nameEligible('x', 20, 20)).toBe(false);
    expect(nameEligible('ALU', 4, 10)).toBe(false);
    expect(nameEligible('ALU', 6, 6)).toBe(true);
    expect(nameEligible('IF/ID', 3, 24)).toBe(true);
    // a ratio in a name is not an assignment: the ALU's result mux (MUX 8:1) is named at the fit
    expect(nameEligible('MUX 8:1', 10, 116)).toBe(true);
    expect(nameEligible('bit0 := 0', 20, 20)).toBe(false);
    expect(nameEligible('x0 = 0', 20, 20)).toBe(false);
    // the bypass's comparators are named by what they compare
    expect(nameEligible('wa = ra1', 12, 20)).toBe(true);
  });
  it('turns a tall narrow block\'s name', () => {
    expect(nameRotated(4, 30)).toBe(true);
    expect(nameRotated(10, 20)).toBe(false);
  });
});

describe('planNames', () => {
  const scale = 2;
  it('draws nothing once labels are big enough themselves', () => {
    expect(planNames([box(0, 0, 20, 20)], 12)).toEqual([false]);
  });
  it('draws a lone name', () => {
    expect(planNames([box(0, 0, 20, 20)], scale)).toEqual([true]);
  });
  it('lets the larger block keep its name when two collide, whatever the order', () => {
    const small = box(0, 0, 8, 8, 8), big = box(2, 0, 30, 30, 8);
    expect(planNames([small, big], scale)).toEqual([false, true]);
    expect(planNames([big, small], scale)).toEqual([true, false]);
  });
  it('keeps names that do not overlap', () => {
    expect(planNames([box(0, 0, 10, 10), box(100, 0, 10, 10)], scale)).toEqual([true, true]);
  });
  it('drops blocks too small on screen to hold a name', () => {
    expect(planNames([box(0, 0, 6, 6)], 1)).toEqual([false]);
  });
  it('measures a turned name by its height', () => {
    // two tall registers side by side: turned names are 15 px wide, so 8 units (16 px) apart both stay
    expect(planNames([box(0, 0, 3, 40), box(8, 0, 3, 40)], scale)).toEqual([true, true]);
    expect(planNames([box(0, 0, 3, 40), box(5, 0, 3, 40)], scale)).toEqual([true, false]);
  });
  it('is stable as the scale grows: a name that fits stays', () => {
    const bs = [box(0, 0, 20, 20), box(14, 0, 20, 20)];
    const lo = planNames(bs, 1), hi = planNames(bs, 5);
    expect(lo.filter(Boolean).length).toBeLessThanOrEqual(hi.filter(Boolean).length);
  });
});

describe('trivial labels get no fixed name', () => {
  it('skips assignments and constants drawn as boxes, keeps real names', () => {
    expect(nameEligible('bit0 := 0', 20, 20)).toBe(false);
    expect(nameEligible('0x0', 20, 20)).toBe(false);
    expect(nameEligible('+4', 20, 20)).toBe(false);
    expect(nameEligible('I/O', 8, 8)).toBe(true);
    expect(nameEligible('NEXT PC', 8, 8)).toBe(true);
  });
});

describe('names sit inside their block', () => {
  const b = (w: number, h: number, text: string, rot = false): NameBox => ({ cx: 0, cy: 0, w, h, chars: text.length, rot, text });
  const width = (l: { px: number; lines: string[] }) => Math.max(...l.lines.map((x) => x.length)) * l.px * 0.68;
  it('shrinks a name that is wider than its block at 12 px', () => {
    const l = nameLayout(b(10, 16, 'UNPACK'), 3.3);
    expect(l.px).toBeLessThan(NAME_PX);
    expect(l.px).toBeGreaterThanOrEqual(NAME_MIN_PX);
    expect(width(l)).toBeLessThanOrEqual(10 * 3.3);
  });
  it('wraps onto two lines where that gives a larger size', () => {
    const l = nameLayout(b(22, 12, 'NORMALIZE & ROUND'), 3.3);
    expect(l.lines).toEqual(['NORMALIZE &', 'ROUND']);
    expect(nameLayout(b(14, 8, 'ADD/SUB'), 2.4).lines.length).toBeGreaterThan(0);
  });
  it('keeps a name that fits at 12 px unchanged', () => {
    expect(nameLayout(b(30, 20, 'ALU'), 2)).toEqual({ px: NAME_PX, lines: ['ALU'] });
  });
  it('a block too small for any size keeps its name at the floor instead of losing it', () => {
    const l = nameLayout(b(10, 10, 'DECODER'), 2);
    expect(l.px).toBe(MIN_TEXT_PX);
    expect(planNames([b(10, 10, 'DECODER')], 2)).toEqual([true]);
  });
  it('every name of the floating-point units is drawn inside its block at phone and desktop fits', () => {
    const f = { E: 4, M: 3 } as FpFormat;
    for (const def of [fpAdd(f), fpMul(f), fpDiv(f, true), fpAddNearFar(f)]) {
      const insts = def.netlist!().instances.filter((i) => i.def.symbol.kind === 'box');
      for (const scale of [3, 3.3, 4.5, 6]) {
        const boxes = insts.flatMap((i) => {
          const { w, h } = symbolGeom(i.def), at = i.at ?? [0, 0], t = i.def.symbol.label ?? i.def.name;
          return nameEligible(t, w, h) ? [{ i, box: { cx: at[0] + w / 2, cy: at[1] + h / 2, w, h, chars: t.length, rot: nameRotated(w, h), text: t } }] : [];
        });
        const plan = planLayouts(boxes.map((x) => x.box), scale);
        boxes.forEach((x, k) => {
          const l = plan[k], where = `${def.id} ${x.i.name} at ${scale}`;
          expect(l, where).not.toBeNull();
          if (l && !x.box.rot) expect(width(l), where).toBeLessThanOrEqual(x.box.w * scale);
        });
      }
    }
  });
});

describe('planTags', () => {
  const tag = (x: number, y: number): { tip: [number, number]; rect: { x: number; y: number; w: number; h: number } } => ({ tip: [x, y], rect: { x, y: y - 0.7, w: 4, h: 1.35 } });
  it('enlarges tags whose text is under the floor, to put it at the floor', () => {
    const [k] = planTags([tag(0, 0)], [], 5);
    expect(k! * TEXT_UNITS.tag * 5).toBeCloseTo(MIN_TEXT_PX, 5);
  });
  it('leaves tags alone when the text is big enough, or would need more than TAG_MAX_K', () => {
    expect(planTags([tag(0, 0)], [], 9)).toEqual([null]);
    expect(planTags([tag(0, 0)], [], 7 / TEXT_UNITS.tag / (TAG_MAX_K + 0.1))).toEqual([null]);
  });
  it('never lets an enlarged tag cover a block or a tag kept before it', () => {
    expect(planTags([tag(0, 0)], [{ x: 5, y: -1, w: 3, h: 2 }], 5)).toEqual([null]);
    const r = planTags([tag(0, 0), tag(0, 0.5), tag(0, 10)], [], 5);
    expect(r[0]).not.toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).not.toBeNull();
  });
});
