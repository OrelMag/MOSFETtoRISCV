import { describe, expect, it } from 'vitest';
import { hiddenKinds, NAME_MIN_PX, abbreviate, fitLayout, NAME_OVER_MAX_PX, LARGE_BLOCK_PX, nameRect, truncLayout, planLayouts, planTags, TAG_MAX_K, LABEL_UNITS, NAME_PX, MIN_TEXT_PX, nameEligible, nameRotated, needsFixedNames, planNames, TEXT_UNITS, type NameBox } from '../src/view/legible';
import { fpAdd, fpMul, fpDiv } from '../src/lib/fpu';
import type { FpFormat } from '../src/sim/fpref';
import { singleCycleCpu } from '../src/lib/cpu';
import { CSR_UNIT } from '../src/lib/system';
import { routeNetlist } from '../src/view/route';
import { isConstantDef } from '../src/sim/constant';
import { constWord } from '../src/lib/alu';
import { TIE0 } from '../src/lib/transistors';
import { keyPart, partDef } from '../src/editor/parts';
import type { PartRef } from '../src/editor/model';
import type { ComponentDef } from '../src/sim/types';
import type { Seg } from '../src/view/legible';
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
  const b = (w: number, h: number, text: string, rot = false, cx = 0, cy = 0): NameBox => ({ cx, cy, w, h, chars: text.length, rot, text });
  const width = (l: { px: number; lines: string[] }) => Math.max(...l.lines.map((x) => x.length)) * l.px * 0.68;
  it('shrinks a name that is wider than its block at 12 px', () => {
    const l = fitLayout(b(10, 16, 'UNPACK'), 3.3)!;
    expect(l.px).toBeLessThan(NAME_PX);
    expect(l.px).toBeGreaterThanOrEqual(NAME_MIN_PX);
    expect(width(l)).toBeLessThanOrEqual(10 * 3.3);
  });
  it('wraps onto two lines where that gives a larger size, also at the phone fit of a 22 x 12 block', () => {
    expect(fitLayout(b(22, 12, 'NORMALIZE & ROUND'), 3.3)!.lines.length).toBe(2);
    const l = fitLayout(b(22, 12, 'NORMALIZE & ROUND'), 2.05)!;
    expect(l.lines).toEqual(['NORMALIZE', '& ROUND']);
  });
  it('keeps a name that fits at 12 px unchanged', () => {
    expect(fitLayout(b(30, 20, 'ALU'), 2)).toEqual({ px: NAME_PX, lines: ['ALU'] });
  });
  it('abbreviates word by word', () => {
    expect(abbreviate('INSTR MEM')).toBe('INSTR MEM');
    expect(abbreviate('REGISTERS')).toBe('REGS');
    expect(abbreviate('NORMALIZE & ROUND')).toBe('NORM & RND');
    expect(abbreviate('ADD/SUB')).toBe('ADD/SUB');
  });
  it('draws the full name over its block when nothing else is in the way', () => {
    const l = planLayouts([b(10, 10, 'REGISTERS')], 2)[0]!;
    expect(l.over).toBe(true);
    expect(l.lines.join(' ')).toBe('REGISTERS');
  });
  it('prefers the abbreviation inside the block to a full name spilling well past it, and keeps overflow small', () => {
    const l = planLayouts([b(6, 10, 'REGISTERS')], 4)[0]!;
    expect(l).toEqual({ px: expect.any(Number), lines: ['REGS'] });
    const o = planLayouts([b(10, 10, 'REGISTERS')], 4)[0]!;
    expect(o.over ? o.px : 0).toBeLessThanOrEqual(NAME_PX);
  });
  it('abbreviates when the full name would collide, then truncates, then drops', () => {
    // a neighbour's block 14 units to the right: 'REGISTERS' (about 9 chars at 12 px) would reach it, 'REGS' would not
    const neighbour = b(10, 10, 'ZZ', false, 12, 0);
    const lay = planLayouts([b(8, 10, 'REGISTERS'), neighbour], 2, 10, [{ x: -4, y: -5, w: 8, h: 10 }, { x: 7, y: -5, w: 10, h: 10 }])[0]!;
    expect(lay.lines.join(' ')).toBe('REGS');
    expect(planLayouts([b(8, 10, 'REGISTERS')], 2, 10, [{ x: -4, y: -5, w: 8, h: 10 }, { x: 4.2, y: -5, w: 3, h: 10 }, { x: -7.5, y: -5, w: 3, h: 10 }])[0]).toBeNull();
    expect(truncLayout(b(10, 10, 'DECODER'), 2)).toEqual({ px: NAME_MIN_PX, lines: ['DE…'] });
    expect(truncLayout(b(6, 10, 'DECODER'), 2)).toBeNull();
  });
  it('the single-cycle CPU top at its 1280 px fit: the names are drawn in full, colliding with no name and no block', () => {
    const def = singleCycleCpu([0x00000013]);
    const insts = def.netlist!().instances;
    const blocks = insts.map((i) => { const { w, h } = symbolGeom(i.def), at = i.at ?? [0, 0]; return { x: at[0], y: at[1], w, h }; });
    const named = insts.flatMap((i, k) => {
      const { w, h } = symbolGeom(i.def), t = i.def.symbol.label ?? i.def.name;
      return i.def.symbol.kind === 'box' && nameEligible(t, w, h) ? [{ k, t, box: { cx: blocks[k].x + w / 2, cy: blocks[k].y + h / 2, w, h, chars: t.length, rot: nameRotated(w, h), text: t, ports: Object.keys(symbolGeom(insts[k].def).ports).length } }] : [];
    });
    const bb = { x0: Math.min(...blocks.map((r) => r.x)), x1: Math.max(...blocks.map((r) => r.x + r.w)) };
    const scale = 400 / (bb.x1 - bb.x0);
    const nlc = def.netlist!();
    const wires = routeNetlist(def, nlc).nets.flatMap((n) => n.paths.flatMap((p) => p.slice(1).map((q, i): Seg => [p[i][0], p[i][1], q[0], q[1]])));
    const plan = planLayouts(named.map((n) => n.box), scale, 10, blocks, wires);
    const full = ['INSTR MEM', 'REGISTERS', 'DATA MEM', 'NEXT PC'];
    for (const f of full) {
      const k = named.findIndex((n) => n.t.toUpperCase() === f);
      expect(k, f + ' is a block of the top').toBeGreaterThanOrEqual(0);
      expect(plan[k]?.lines.join(' '), f).toBe(f);
      expect(plan[k]!.px, f + ' size').toBeGreaterThanOrEqual(10);
    }
    // no name covers another name or another block
    const rects = plan.map((l, k) => (l ? nameRect(named[k].box, l, scale) : null));
    rects.forEach((a, i) => {
      if (!a) return;
      rects.slice(i + 1).forEach((c) => { if (c) expect(a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h, 'name x name').toBe(false); });
      blocks.forEach((r, k) => { if (k !== named[i].k && a.x < r.x + r.w && r.x < a.x + a.w && a.y < r.y + r.h && r.y < a.y + a.h) throw new Error(named[i].t + ' covers ' + insts[k].name); });
    });
  });
  it('every name of the floating-point units is drawn at scales 3 to 6, inside its block or over it clear of everything', () => {
    const f = { E: 4, M: 3 } as FpFormat;
    for (const def of [fpAdd(f), fpMul(f), fpDiv(f, true), fpAddNearFar(f)]) {
      const insts = def.netlist!().instances;
      const blocks = insts.map((i) => { const { w, h } = symbolGeom(i.def), at = i.at ?? [0, 0]; return { x: at[0], y: at[1], w, h }; });
      for (const scale of [2.3, 3, 3.3, 4.5, 6]) {
        const boxes = insts.flatMap((i, k) => {
          const { w, h } = symbolGeom(i.def), t = i.def.symbol.label ?? i.def.name;
          return i.def.symbol.kind === 'box' && nameEligible(t, w, h) ? [{ i, k, box: { cx: blocks[k].x + w / 2, cy: blocks[k].y + h / 2, w, h, chars: t.length, rot: nameRotated(w, h), text: t, ports: Object.keys(symbolGeom(i.def).ports).length } }] : [];
        });
        const plan = planLayouts(boxes.map((x) => x.box), scale, 10, blocks);
        boxes.forEach((x, n) => {
          const l = plan[n], where = `${def.id} ${x.i.name} at ${scale}`;
          expect(l, where).not.toBeNull();
          if (!l || x.box.rot) return;
          const r = nameRect(x.box, l, scale);
          // a large name over a block only on one that is wide enough and not densely pinned (a phone's UNPACK, SPECIAL stay quiet)
          if (l.over && l.px > NAME_OVER_MAX_PX) { expect(x.box.w * scale, where).toBeGreaterThanOrEqual(LARGE_BLOCK_PX); expect(x.box.ports!, where).toBeLessThanOrEqual(8); }
          if (!l.over) { expect(width(l), where).toBeLessThanOrEqual(x.box.w * scale); return; }
          blocks.forEach((o, k) => { if (k !== x.k) expect(r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h, where + ' covers ' + insts[k].name).toBe(false); });
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

describe('constants and wires', () => {
  const wiresOf = (def: Parameters<typeof routeNetlist>[0]): Seg[] => {
    const nl = def.netlist!();
    return routeNetlist(def, nl).nets.flatMap((n) => n.paths.flatMap((p) => p.slice(1).map((q, i): Seg => [p[i][0], p[i][1], q[0], q[1]])));
  };
  it('a CSR unit at its fit shows every constant value at 7 px or more, or leaves a capsule only where that would collide', () => {
    const nl = CSR_UNIT.netlist!();
    const insts = nl.instances;
    const blocks = insts.map((i) => { const { w, h } = symbolGeom(i.def), at = i.at ?? [0, 0]; return { x: at[0], y: at[1], w, h }; });
    const consts = insts.flatMap((i, k) => {
      const { w, h } = symbolGeom(i.def), t = i.def.symbol.label ?? i.def.name;
      return isConstantDef(i.def) && (i.def.symbol.label?.length ?? 0) >= 2
        ? [{ k, box: { cx: blocks[k].x + w / 2, cy: blocks[k].y + h / 2, w, h, chars: t.length, rot: false, text: t, ports: 1, const: true } }] : [];
    });
    expect(consts.length).toBeGreaterThanOrEqual(16);
    // every one-port labelled box of the unit is one (the shapes the old rule saw are exactly the constants)
    const shaped = insts.filter((i) => i.def.symbol.kind === 'box' && i.def.ports.length === 1 && (i.def.symbol.label?.length ?? 0) >= 2);
    expect(shaped.length).toBe(consts.length);
    const scale = 1.7;
    const named = insts.flatMap((i, k) => {
      const { w, h } = symbolGeom(i.def), t = i.def.symbol.label ?? i.def.name;
      return !consts.some((c) => c.k === k) && i.def.symbol.kind === 'box' && nameEligible(t, w, h) ? [{ cx: blocks[k].x + w / 2, cy: blocks[k].y + h / 2, w, h, chars: t.length, rot: nameRotated(w, h), text: t, ports: Object.keys(symbolGeom(i.def).ports).length }] : [];
    });
    const plan = planLayouts([...named, ...consts.map((c) => c.box)], scale, 10, blocks);
    let shown = 0;
    consts.forEach((c, n) => {
      const l = plan[named.length + n];
      if (l) { shown++; expect(l.px).toBeGreaterThanOrEqual(MIN_TEXT_PX); return; }
      // not shown: drawn alone it would be (so it was a collision, not a rule)
      expect(planLayouts([c.box], scale, 10, [blocks[c.k]])[0], 'const ' + insts[c.k].name).not.toBeNull();
    });
    expect(shown).toBeGreaterThan(0);
  });
  it('fpdiv at the phone fit draws UNPACK inside its block (UNPK) and no spilled name touches a wire', () => {
    const def = fpDiv({ E: 4, M: 3 } as FpFormat, true);
    const nl = def.netlist!(), wires = wiresOf(def);
    const insts = nl.instances;
    const blocks = insts.map((i) => { const { w, h } = symbolGeom(i.def), at = i.at ?? [0, 0]; return { x: at[0], y: at[1], w, h }; });
    const boxes = insts.flatMap((i, k) => {
      const { w, h } = symbolGeom(i.def), t = i.def.symbol.label ?? i.def.name;
      return i.def.symbol.kind === 'box' && nameEligible(t, w, h) ? [{ k, t, box: { cx: blocks[k].x + w / 2, cy: blocks[k].y + h / 2, w, h, chars: t.length, rot: nameRotated(w, h), text: t, ports: Object.keys(symbolGeom(i.def).ports).length } }] : [];
    });
    const plan = planLayouts(boxes.map((b) => b.box), 2.4, 10, blocks, wires);
    boxes.forEach((b, n) => {
      const l = plan[n]!;
      if (b.t === 'UNPACK') expect(l).toMatchObject({ lines: ['UNPK'] });
      // (a large name over a wide, sparsely pinned block is the CPU top's kind and is not held to this)
      if (l.over && l.px <= NAME_OVER_MAX_PX) {
        const r = nameRect(b.box, l, 2.4), own = blocks[b.k];
        for (const [ax, ay, bx, by] of wires) {
          const x0 = Math.max(Math.min(ax, bx), r.x), x1 = Math.min(Math.max(ax, bx), r.x + r.w), y0 = Math.max(Math.min(ay, by), r.y), y1 = Math.min(Math.max(ay, by), r.y + r.h);
          if (x0 > x1 || y0 > y1) continue;
          expect(x0 >= own.x && x1 <= own.x + own.w && y0 >= own.y && y1 <= own.y + own.h, b.t + ' spills over a wire').toBe(true);
        }
      }
    });
  });
});

describe('isConstantDef', () => {
  const part = (ref: PartRef) => { const d = partDef(ref, () => undefined); if ('error' in d) throw new Error(String(d.error)); return d as ComponentDef; };
  it('is true for constWord, the sandbox constant and the tie cells, and for the CSR unit constants', () => {
    expect(isConstantDef(constWord(32, 0x1800))).toBe(true);
    expect(isConstantDef(constWord(32, 0))).toBe(true);
    expect(isConstantDef(TIE0)).toBe(true);
    expect(isConstantDef(part({ const: { width: 8, value: 5 } }))).toBe(true);
    const csrConsts = CSR_UNIT.netlist!().instances.filter((i) => /^k_|^zero32|^k[TE]$|^misa$|^ones$/.test(i.name));
    expect(csrConsts.length).toBeGreaterThanOrEqual(16);
    for (const c of csrConsts) expect(isConstantDef(c.def), c.name).toBe(true);
  });
  it('is false for a key, an LED, a display or a probe, though they are one-port boxes with a label too', () => {
    expect(isConstantDef(keyPart('Space'))).toBe(false);
    for (const ref of [{ display: 'led' }, { display: 'hex', width: 8 }, { display: 'halt' }, { key: 'a' }, { switches: 4 }] as PartRef[]) expect(isConstantDef(part(ref)), JSON.stringify(ref)).toBe(false);
  });
});
