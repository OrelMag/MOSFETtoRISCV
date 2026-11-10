// The core benches (campaign/bench.ts: the debug bench of a failing test, with or without the interrupt line, and the io
// bench Pong runs on) are placed by hand in two rows: no part sits on another and no wire runs through a part, in every
// variant, and the chip stays about as wide as two rows make it (it was one 285-unit strip).

import { describe, expect, it } from 'vitest';
import { BENCH_AT, benchChip, PONG16_TEST } from '../src/campaign/bench';
import { partBox } from '../src/editor/geom';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, polyline, type ChipDoc } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import '../src/lib';
import { RV16_CORE } from '../src/lib/rv16/cpu';
import { RV16_CPU_IRQ } from '../src/lib/rv16/system';

type Box = { x: number; y: number; w: number; h: number };
const inside = (r: Box, lx: number, hx: number, ly: number, hy: number) => hx > r.x + 0.1 && lx < r.x + r.w - 0.1 && hy > r.y + 0.1 && ly < r.y + r.h - 0.1;

function faults(doc: ChipDoc) {
  const lib = new UserLibrary({ ...emptyWorkspace(), chips: { [doc.id]: doc } });
  const defOf = (p: ChipDoc['parts'][number]) => { const d = partDef(p.ref, (x) => lib.defOf(x)); return !d || 'error' in d ? undefined : d; };
  const boxes = doc.parts.map((p) => ({ id: p.id, r: partBox(defOf(p)!, p.at, p.flip, p.rot) as Box }));
  const overlaps: string[] = [], through: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].r, b = boxes[j].r;
    if (a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01) overlaps.push(`${boxes[i].id} / ${boxes[j].id}`);
  }
  for (const w of doc.wires) {
    const p = polyline(doc, w, defOf as never);
    if (!p) continue;
    const ends = new Set([w.a, w.b].map((e) => ('part' in e ? e.part : '')));
    for (const bx of boxes) {
      if (ends.has(bx.id)) continue;
      for (let i = 0; i + 1 < p.length; i++) {
        const [[x0, y0], [x1, y1]] = [p[i], p[i + 1]];
        if (inside(bx.r, Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1))) { through.push(`${w.id} → ${bx.id}`); break; }
      }
    }
  }
  const xs = doc.parts.flatMap((p) => { const r = boxes.find((b) => b.id === p.id)!.r; return [r.x, r.x + r.w]; });
  return { overlaps, through, width: Math.max(...xs) - Math.min(...xs) };
}

describe('core benches', () => {
  const IN_TEST = { name: 'a + b', src: 'lw a0, -4(x0)\nlw a1, -4(x0)\nadd a0, a0, a1\nsw a0, -3(x0)\nhalt\n', input: [2, 3] };
  const variants = [['debug', RV16_CORE, false, PONG16_TEST], ['debug with irq', RV16_CPU_IRQ, false, PONG16_TEST], ['debug with IN', RV16_CORE, false, IN_TEST], ['debug with IN and irq', RV16_CPU_IRQ, false, IN_TEST], ['Pong', RV16_CORE, true, PONG16_TEST], ['Pong with irq', RV16_CPU_IRQ, true, PONG16_TEST], ['io with IN', RV16_CPU_IRQ, true, IN_TEST]] as const;
  it.each(variants)('%s: no part on another, no wire through a part, two rows wide', (_, core, io, test) => {
    const doc = benchChip(core, '', 'core', test, { io, id: 'u_b', name: 'b', coreRef: { lib: core.id } });
    if ('error' in doc) throw new Error(doc.error);
    expect(doc.parts.map((p) => p.id).filter((id) => !(id in BENCH_AT))).toEqual([]);
    const f = faults(doc);
    expect(f.overlaps).toEqual([]);
    expect(f.through).toEqual([]);
    expect(f.width).toBeLessThan(130);
  });
});
