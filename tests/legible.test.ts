import { describe, expect, it } from 'vitest';
import { hiddenKinds, LABEL_UNITS, NAME_PX, MIN_TEXT_PX, nameEligible, nameRotated, needsFixedNames, planNames, TEXT_UNITS, type NameBox } from '../src/view/legible';

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
