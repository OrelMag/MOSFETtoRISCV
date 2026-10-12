// The sandbox's analysis tools and performance caches, DOM-free: incremental hops, the derived
// model cache, probe lanes remapped across rebuilds, static timing mapped back to the drawing,
// and the lint checks.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { allHops, HopCache, type ShapeWire } from '../src/editor/hops';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { type ChipDoc, type DefOf, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { resolveProbe, sameTarget } from '../src/editor/probes';
import { EditorSim } from '../src/editor/runtime';
import { chipTiming } from '../src/editor/sta';
import { logicDepth } from '../src/sim/stats';
import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../src/sim/timing';
import type { Vec } from '../src/sim/geometry';
import { chip, compileLib, halfAdder, lbl, part, pin, wire, workspace } from './editorkit';
import { lcg } from './util';

describe('incremental hops', () => {
  const randomWires = (rnd: () => number, n: number): ShapeWire[] =>
    Array.from({ length: n }, (_, i) => {
      // Short wires on a large board, two per net (a fan-out), as on a real chip.
      const pts: Vec[] = [[Math.floor(rnd() * 120), Math.floor(rnd() * 90)]];
      for (let k = 0; k < 3; k++) {
        const [x, y] = pts[pts.length - 1];
        const d = Math.floor(rnd() * 25) - 12;
        pts.push(k % 2 ? [x, y + d] : [x + d, y]);
      }
      return { id: `w${i}`, group: i >> 1, poly: rnd() < 0.05 ? null : pts };
    });

  it('a partial recompute equals a full one after every move', () => {
    const r = lcg(7);
    const rnd = () => r(1 << 30) / (1 << 30);
    let wires = randomWires(rnd, 60);
    const cache = new HopCache();
    cache.update(wires);
    expect(cache.d).toEqual(allHops(wires));
    let partial = 0;
    for (let step = 0; step < 200; step++) {
      // Move one or two wires (as a drag of a part moves the wires on its ports).
      const moved = new Set([Math.floor(rnd() * wires.length), Math.floor(rnd() * wires.length)].slice(0, 1 + (step % 2)));
      const dx = Math.floor(rnd() * 5) - 2, dy = Math.floor(rnd() * 5) - 2;
      wires = wires.map((w, i) => (moved.has(i) && w.poly ? { ...w, poly: w.poly.map(([x, y]): Vec => [x + dx, y + dy]) } : w));
      if (step % 50 === 49) wires = wires.slice(1); // a wire deleted: everything regroups
      const before = new Map(cache.d);
      const changed = cache.update(wires);
      const full = allHops(wires);
      expect(cache.d).toEqual(full);
      for (const [id, d] of full) if (before.get(id) !== d) expect(changed.has(id), id).toBe(true);
      if (cache.lastRecomputed < wires.length) partial++;
    }
    expect(partial).toBeGreaterThan(150); // most moves recompute only part of the wires
  });
});

describe('derived model cache', () => {
  const nor = (at: Vec = [8, 1], swap = false) => chip('u_nor', 'NOR', {
    pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('y', 'out', [20, 3])],
    parts: [part('g', { lib: 'nor_cmos' }, at)],
    wires: [wire('w1', 'pin:a', swap ? 'g.b' : 'g.a'), wire('w2', 'pin:b', swap ? 'g.a' : 'g.b'), wire('w3', 'g.y', 'pin:y')],
  });

  it('moving parts reuses the derived truth table; rewiring derives again', () => {
    const c1 = compileLib(nor());
    expect(c1.mode).toBe('switch');
    expect(c1.derived?.ok).toBe(true);
    const c2 = compileLib(nor([9, 3]));
    expect(c2.def).not.toBe(c1.def); // the drawing changed: a new def …
    expect(c2.connKey).toBe(c1.connKey);
    expect(c2.derived).toBe(c1.derived); // … with the same model, not derived again
    const c3 = compileLib(nor([8, 1], true));
    expect(c3.connKey).not.toBe(c1.connKey);
    expect(c3.derived).not.toBe(c1.derived);
  });

  it('a chip placing an edited chip derives again even if its own wiring is the same', () => {
    const inner = nor();
    const outer = (d: ChipDoc) => chip('u_out', 'OUT', {
      pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('y', 'out', [30, 3])],
      // A transistor part of its own keeps it at switch level (the user chip alone would be
      // used through its derived model).
      parts: [part('n', { chip: d.id }, [8, 0]), part('g', { lib: 'nor_cmos' }, [20, 0])],
      wires: [wire('w1', 'pin:a', 'n.a'), wire('w2', 'pin:b', 'n.b'), wire('w4', 'pin:b', 'g.b'), wire('w5', 'n.y', 'g.a'), wire('w3', 'g.y', 'pin:y')],
    });
    const lib = new UserLibrary(workspace(outer(inner), inner));
    const d1 = lib.compiled('u_out')!.derived;
    expect(d1?.ok).toBe(true);
    lib.update(workspace(outer(inner), nor([8, 5]))); // inner moved: same structure
    expect(lib.compiled('u_out')!.derived).toBe(d1);
    lib.update(workspace(outer(inner), nor([8, 1], true))); // inner rewired (a NOR is symmetric, but it is another circuit)
    expect(lib.compiled('u_out')!.derived).not.toBe(d1);
  });
});

const defOf: DefOf = (p) => {
  const r = partDef(p.ref, () => undefined);
  return 'error' in r ? undefined : r;
};
const sim = (doc: ChipDoc) => {
  const c = compileLib(doc);
  const s = new EditorSim({ debounceMs: 0 });
  s.update(c, doc.pins);
  return { c, s, design: s.sim!.design };
};

describe('probe lanes follow the drawing', () => {
  it('a wire probe resolves to the same signal after the nets are renumbered', () => {
    const ha = halfAdder();
    const a = sim(ha);
    const r = resolveProbe({ wires: ['w5'] }, ha, a.c, a.design)!;
    expect(r.label).toBe('s'); // named after the chip pin on its net
    expect(r.nets).toEqual(a.design.root.ports.s);
    // A new part and wire drawn first: every net index moves.
    const more: ChipDoc = {
      ...ha, parts: [part('k', { lib: 'not' }, [8, 14]), ...ha.parts], pins: [...ha.pins, pin('o', 'out', [20, 15])],
      wires: [wire('w0', { wire: 'w3', at: [6, 6] }, 'k.a', [[6, 15]]), wire('w9', 'k.y', 'pin:o'), ...ha.wires],
    };
    const b = sim(more);
    expect(b.c.netOfWire.get('w5')).not.toBe(a.c.netOfWire.get('w5'));
    const r2 = resolveProbe(r.target, more, b.c, b.design)!;
    expect(r2.nets).toEqual(b.design.root.ports.s);
    expect(resolveProbe({ pin: 'c' }, more, b.c, b.design)!.nets).toEqual(b.design.root.ports.c);
  });

  it('keeps a lane while any wire of its net is left, drops it with the last one', () => {
    const ha = halfAdder();
    const a = sim(ha);
    // Clicked on w2 (a branch of a's net): the lane learns the net's other wire.
    const r = resolveProbe({ wires: ['w2'] }, ha, a.c, a.design)!;
    expect(r.target).toEqual({ wires: ['w2', 'w1'] });
    const noBranch = { ...ha, wires: ha.wires.filter((w) => w.id !== 'w2') };
    const b = sim(noBranch);
    expect(resolveProbe(r.target, noBranch, b.c, b.design)!.nets).toEqual(b.design.root.ports.a);
    const r5 = resolveProbe({ wires: ['w5'] }, ha, a.c, a.design)!;
    const noS = { ...ha, wires: ha.wires.filter((w) => w.id !== 'w5') };
    const c = sim(noS);
    expect(resolveProbe(r5.target, noS, c.c, c.design)).toBeNull();
  });

  it('a probe on a pointer follows its name; same net = same lane', () => {
    const doc = chip('u_p', 'P', {
      pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [30, 2])],
      parts: [part('n', { lib: 'not' }, [10, 0])],
      labels: [lbl('l1', 'mid', [20, 2]), lbl('l2', 'mid', [24, 2], 'left')],
      wires: [wire('w1', 'pin:a', 'n.a'), wire('w2', 'n.y', 'lbl:l1'), wire('w3', 'lbl:l2', 'pin:y')],
    });
    const a = sim(doc);
    const r = resolveProbe({ pointer: 'mid' }, doc, a.c, a.design)!;
    expect(r.nets).toEqual(a.design.root.ports.y);
    expect(sameTarget({ pointer: 'mid' }, { wires: ['w3'] }, doc, a.c)).toBe(true);
    expect(sameTarget({ pointer: 'mid' }, { wires: ['w1'] }, doc, a.c)).toBe(false);
  });
});

/** A 4-bit counter drawn from parts: an incrementer feeding a register, its output fed back. */
function counterDoc(): ChipDoc {
  return chip('u_cnt', 'Counter', {
    pins: [{ ...pin('clk', 'in', [20, 10]), kind: 'clock' }, { ...pin('en', 'in', [17, 7]), value: 1 }, pin('q', 'out', [40, 3], 4)],
    parts: [part('inc', { lib: 'inc4' }, [10, 0]), part('reg', { lib: 'reg4' }, [24, 0])],
    wires: [
      wire('wy', 'inc.y', 'reg.d'),
      wire('wc', 'pin:clk', 'reg.clk', [[28, 10]]),
      wire('we', 'pin:en', 'reg.en', [[22, 7], [22, 4]]),
      wire('wq', 'reg.q', 'pin:q'),
      wire('wb', { wire: 'wq', at: [35, 3] }, 'inc.a', [[35, -3], [7, -3], [7, 3]]),
    ],
  });
}

describe('static timing on the drawing', () => {
  it('maps the critical path of a counter to its parts, wires and pins', () => {
    const doc = counterDoc();
    const { c, design } = sim(doc);
    const t = chipTiming(doc, c, design);
    if (!t.ok) throw new Error(t.why);
    const r = t.report;
    expect(r.period).toBe(CLK_TO_Q + r.logic + SETUP);
    expect(r.path[r.path.length - 1].arrival).toBe(CLK_TO_Q + r.logic);
    expect(t.path.parts.sort()).toEqual(['inc', 'reg']);
    expect(t.path.wires.sort()).toEqual(['wb', 'wq', 'wy']); // not the clock or enable wires
    expect(t.path.pins).toEqual(['q']);
    expect(t.mhz).toBeCloseTo(1e6 / (r.period * PS_PER_NAND));
    // Every leaf on the path belongs to a highlighted part.
    for (const p of r.path) expect(t.path.parts).toContain(p.node[0]);
  });

  it('says why when there is nothing to time, with the depth the chip shows', () => {
    const ha = halfAdder();
    const a = sim(ha);
    const t = chipTiming(ha, a.c, a.design);
    expect(t.ok).toBe(false);
    if (t.ok) return;
    expect(t.depth).toBe(logicDepth(a.c.def));
    expect(t.why).toMatch(/combinational/);
    const sw = compileLib(chip('u_s', 'S', {
      pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('y', 'out', [20, 3])], parts: [part('g', { lib: 'nor_cmos' }, [8, 1])],
      wires: [wire('w1', 'pin:a', 'g.a'), wire('w2', 'pin:b', 'g.b'), wire('w3', 'g.y', 'pin:y')],
    }));
    const ts = chipTiming(ha, sw, null);
    expect(!ts.ok && ts.why).toMatch(/Switch level/);
  });
});

describe('lint', () => {
  const lint = (doc: ChipDoc) => {
    const c = compileLib(doc);
    const polys = new Map(doc.wires.flatMap((w) => {
      const p = polyline(doc, w, defOf);
      return p ? [[w.id, p] as const] : [];
    }));
    return lintChip(doc, c, polys);
  };

  it('finds two nets drawn along one line, not one net over itself', () => {
    const doc = chip('u_l', 'L', {
      pins: [pin('a', 'in', [0, 1]), pin('b', 'in', [0, 5])],
      parts: [part('g1', { lib: 'and' }, [10, 0]), part('g2', { lib: 'and' }, [10, 4])],
      wires: [wire('wa', 'pin:a', 'g1.a'), wire('wb', 'pin:b', 'g2.a', [[2, 5], [2, 1], [8, 1], [8, 5]]),
        wire('wa2', { wire: 'wa', at: [4, 1] }, 'g1.b', [[6, 1], [6, 3]])],
    });
    const r = lint(doc);
    const over = r.diags.filter((d) => /one line/.test(d.msg));
    // wb runs along a's wire and along its branch (which itself lies on wa: same net, fine):
    // one warning for the two nets on that line.
    expect(over).toHaveLength(1);
    expect(over[0].wires!.sort()).toEqual(['wa', 'wa2', 'wb']);
    expect(over[0].msg).toBe('two nets drawn on one line (y = 1): a and b');
    // g2.b is open; the outputs g1.y and g2.y are not inputs.
    expect(r.open).toEqual([{ part: 'g2', port: 'b' }]);
    expect(r.diags.some((d) => /1 input not connected, reading X: g2\.b/.test(d.msg) && !!d.parts?.includes('g2'))).toBe(true);
  });

  it('flags a pointer that has no twin', () => {
    const doc = chip('u_l2', 'L2', {
      pins: [pin('a', 'in', [0, 2])],
      labels: [lbl('l1', 'nowhere', [8, 2]), lbl('l2', 'alone', [8, 8])],
      wires: [wire('w1', 'pin:a', 'lbl:l1')],
    });
    const msgs = lint(doc).diags.map((d) => d.msg);
    expect(msgs).toContain("pointer 'nowhere' has no twin: its wire ends there");
    expect(msgs).toContain("pointer 'alone' connects nothing");
    expect(lint(halfAdder()).diags).toEqual([]); // a finished circuit is clean
  });

  it('flags parts whose outputs reach no output, through other dead parts too', () => {
    // a → g1 → y is live; a → g2 → g3 goes nowhere (g3.y unwired), so both are dead.
    const doc = chip('u_d', 'D', {
      pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [30, 2])],
      parts: [part('g1', { lib: 'not' }, [8, 1]), part('g2', { lib: 'not' }, [8, 6]), part('g3', { lib: 'not' }, [16, 6])],
      wires: [wire('w1', 'pin:a', 'g1.a'), wire('w2', 'g1.y', 'pin:y'), wire('w3', 'pin:a', 'g2.a'), wire('w4', 'g2.y', 'g3.a')],
    });
    const d = lint(doc).diags.find((x) => x.msg.includes('driving nothing'));
    expect(d?.parts).toEqual(['g2', 'g3']);
    // A chip with no output (nothing to reach yet) is still being drawn: no warning.
    const draft = { ...doc, pins: [doc.pins[0]], wires: doc.wires.filter((w) => w.id !== 'w2') };
    expect(lint(draft).diags.some((x) => x.msg.includes('driving nothing'))).toBe(false);
  });
});
