// The build challenges, one ladder from transistors to a fetch unit, and their reference
// answers. Each answer is drawn as a learner would draw it (pins, parts, wires, pointers), from
// the answers of the rungs below: the full adder's answer is placed in the adder's, the D latch's
// in the flip-flop's, and so on, so "Show answer" imports a small hierarchy of chips. Port
// positions come from the same geometry the editor uses (the dependencies are compiled here).

import type { ComponentDef } from '../sim/types';
import { instPort } from '../sim/geometry';
import type { BuildChallenge, Level, SeqStep } from './challenges';
import { compileChip } from './compile';
import { FETCH_PROGRAM } from './examples';
import { romImage } from './memory';
import { type ChipDoc, chipDeps, type EndRef, type ExitDir, type PartDoc, type PartRef, type PinDoc, type Vec, type WireDoc } from './model';
import { partDef } from './parts';

// ---- a small drawing kit -----------------------------------------------------------------------

/** Compiled reference chips, by id (their ports place the chips that use them). */
const defs = new Map<string, ComponentDef>();
const docs = new Map<string, ChipDoc>();

const HUE: Record<Level, number> = { transistors: 30, gates: 250, arithmetic: 150, sequential: 330, memory: 55, cpu: 200 };

const L = (lib: string): PartRef => ({ lib });
const C = (id: string): PartRef => ({ chip: id });
const ones = (n: number) => Array.from({ length: n }, () => 1);

class Sketch {
  readonly doc: ChipDoc;
  private n = 0;
  private nl = 0;

  constructor(id: string, name: string, level: Level, notes: string) {
    this.doc = { id, name, hue: HUE[level], notes, pins: [], parts: [], wires: [], labels: [] };
  }

  pin(name: string, dir: PinDoc['dir'], at: Vec, width = 1, kind?: PinDoc['kind']): this {
    this.doc.pins.push({ id: name, name, dir, width, at, ...(kind ? { kind } : {}) });
    return this;
  }

  part(id: string, ref: PartRef, at: Vec, flip = false): this {
    this.doc.parts.push({ id, ref, at, ...(flip ? { flip } : {}) });
    return this;
  }

  /** A pointer; returns its end ('lbl:<id>'). */
  label(name: string, at: Vec, face?: ExitDir): string {
    const id = `l${++this.nl}`;
    this.doc.labels.push({ id, name, at, ...(face ? { face } : {}) });
    return `lbl:${id}`;
  }

  private end(s: string | EndRef): EndRef {
    if (typeof s !== 'string') return s;
    if (s.startsWith('pin:')) return { pin: s.slice(4) };
    if (s.startsWith('lbl:')) return { label: s.slice(4) };
    const i = s.indexOf('.');
    return { part: s.slice(0, i), port: s.slice(i + 1) };
  }

  pos(s: string): Vec {
    const e = this.end(s);
    if ('pin' in e) return this.doc.pins.find((p) => p.id === e.pin)!.at;
    if ('label' in e) return this.doc.labels.find((l) => l.id === e.label)!.at;
    if ('wire' in e) return e.at;
    const p = this.doc.parts.find((q) => q.id === e.part)!;
    const d = partDef(p.ref, (id) => defs.get(id));
    if ('error' in d) throw new Error(`${this.doc.id}: ${p.id}: ${d.error}`);
    return instPort(d, p.at, p.flip, e.port).pos;
  }

  /** One wire; returns its id (to branch off it). */
  wire(a: string | EndRef, b: string | EndRef, pts: Vec[] = [], extra: Partial<WireDoc> = {}): string {
    const id = `w${++this.n}`;
    this.doc.wires.push({ id, a: this.end(a), b: this.end(b), pts, ...extra });
    return id;
  }

  branch(wire: string, at: Vec, to: string, pts: Vec[] = []): string {
    return this.wire({ wire, at }, to, pts);
  }

  /**
   * A net over a vertical trunk at x: one wire from the topmost end to the bottommost, the
   * others branch off the trunk horizontally. Two ends on one row: a straight wire.
   */
  net(ends: string[], x?: number): this {
    const ps = ends.map((e) => ({ e, p: this.pos(e) }));
    if (ps.length === 2 && x === undefined && ps[0].p[1] === ps[1].p[1]) {
      this.wire(ends[0], ends[1]);
      return this;
    }
    const tx = x ?? Math.round((ps[0].p[0] + ps[1].p[0]) / 2);
    const sorted = [...ps].sort((a, b) => a.p[1] - b.p[1]);
    const top = sorted[0], bot = sorted[sorted.length - 1];
    const main = this.wire(top.e, bot.e, [[tx, top.p[1]], [tx, bot.p[1]]]);
    for (const q of ps) if (q !== top && q !== bot) this.branch(main, [tx, q.p[1]], q.e);
    return this;
  }

  /** Register the chip (compiled, so chips placing it know its ports). */
  done(ff?: ChipDoc['ff']): ChipDoc {
    if (ff) this.doc.ff = ff;
    const c = compileChip(this.doc, (ref) => partDef(ref, (id) => defs.get(id)));
    defs.set(this.doc.id, c.def);
    docs.set(this.doc.id, this.doc);
    return this.doc;
  }
}

const memo = <T>(f: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};

/** A reference chip and every chip it places, dependencies first. */
function withDeps(doc: ChipDoc): ChipDoc[] {
  const out: ChipDoc[] = [];
  const seen = new Set<string>();
  const walk = (d: ChipDoc) => {
    for (const id of chipDeps(d)) {
      const c = docs.get(id);
      if (c && !seen.has(id)) { seen.add(id); walk(c); }
    }
    out.push(d);
  };
  walk(doc);
  return out;
}

const ref = (level: Level, id: string, name: string, notes: string) => new Sketch(`u_ref_${id}`, `${name} ref`, level, `Reference answer. ${notes}`);

// ---- transistors -------------------------------------------------------------------------------

const refInv = memo(() => {
  const s = ref('transistors', 'inv', 'Inverter', 'PMOS pull-up, NMOS pull-down, gates tied together.');
  s.pin('a', 'in', [0, 8]).pin('y', 'out', [14, 8]);
  s.part('vdd', L('vdd'), [7, 0]).part('p1', L('pmos'), [5, 3]).part('n1', L('nmos'), [5, 9]).part('gnd', L('gnd'), [7, 14]);
  s.net(['p1.g', 'n1.g', 'pin:a'], 3);
  s.wire('vdd.p', 'p1.s');
  s.branch(s.wire('p1.d', 'n1.d'), [8, 8], 'pin:y');
  s.wire('gnd.p', 'n1.s');
  return s.done();
});

const refNandT = memo(() => {
  const s = ref('transistors', 'cmos_nand', 'CMOS NAND', 'Parallel PMOS pull-ups, series NMOS pull-down.');
  s.pin('a', 'in', [0, 5]).pin('b', 'in', [0, 17]).pin('y', 'out', [22, 8]);
  s.part('vdd', L('vdd'), [10, 0]).part('p1', L('pmos'), [6, 3]).part('p2', L('pmos'), [12, 3])
    .part('n1', L('nmos'), [12, 10]).part('n2', L('nmos'), [12, 15]).part('gnd', L('gnd'), [14, 20]);
  s.net(['pin:a', 'p1.g', 'n1.g'], 4);
  s.net(['pin:b', 'p2.g', 'n2.g'], 10);
  s.branch(s.wire('vdd.p', 'p1.s', [[9, 1]]), [11, 1], 'p2.s', [[15, 1]]);
  const y = s.wire('p2.d', 'n1.d');
  s.branch(y, [15, 8], 'pin:y');
  s.branch(y, [15, 8], 'p1.d', [[9, 8]]);
  s.wire('n1.s', 'n2.d');
  s.wire('gnd.p', 'n2.s');
  return s.done();
});

const refNor = memo(() => {
  const s = ref('transistors', 'cmos_nor', 'CMOS NOR', 'Series PMOS pull-up, parallel NMOS pull-downs.');
  s.pin('a', 'in', [0, 4]).pin('b', 'in', [0, 9]).pin('y', 'out', [20, 12]);
  s.part('vdd', L('vdd'), [12, 0]).part('p1', L('pmos'), [10, 2]).part('p2', L('pmos'), [10, 7])
    .part('n1', L('nmos'), [4, 13]).part('n2', L('nmos'), [10, 13]).part('gnd', L('gnd'), [9, 19]);
  s.net(['pin:a', 'p1.g', 'n1.g'], 2);
  s.net(['pin:b', 'p2.g', 'n2.g'], 8);
  s.wire('vdd.p', 'p1.s');
  s.wire('p1.d', 'p2.s');
  const y = s.wire('p2.d', 'n2.d');
  s.branch(y, [13, 12], 'pin:y');
  s.branch(y, [13, 12], 'n1.d', [[7, 12]]);
  s.branch(s.wire('gnd.p', 'n1.s', [[10, 18], [7, 18]]), [10, 18], 'n2.s', [[13, 18]]);
  return s.done();
});

// ---- gates from NAND (the library NAND: inputs at y + 1, y + 3, output at (x + 4, y + 2)) ---------

const N = L('nand');

const refNot = memo(() => {
  const s = ref('gates', 'not', 'NOT', 'One NAND with its inputs tied: NAND(a, a) = NOT a.');
  s.pin('a', 'in', [0, 2]).pin('y', 'out', [16, 2]).part('g', N, [6, 0]);
  s.net(['g.a', 'g.b', 'pin:a'], 3);
  s.wire('g.y', 'pin:y');
  return s.done();
});

const refAnd = memo(() => {
  const s = ref('gates', 'and', 'AND', 'NAND, then NAND as an inverter.');
  s.pin('a', 'in', [0, 1]).pin('b', 'in', [0, 3]).pin('y', 'out', [24, 2]);
  s.part('g1', N, [6, 0]).part('g2', N, [14, 0]);
  s.wire('pin:a', 'g1.a');
  s.wire('pin:b', 'g1.b');
  s.net(['g2.a', 'g2.b', 'g1.y'], 12);
  s.wire('g2.y', 'pin:y');
  return s.done();
});

const refOr = memo(() => {
  const s = ref('gates', 'or', 'OR', 'De Morgan: a + b = NAND(NOT a, NOT b).');
  s.pin('a', 'in', [0, 2]).pin('b', 'in', [0, 8]).pin('y', 'out', [26, 5]);
  s.part('na', N, [6, 0]).part('nb', N, [6, 6]).part('g', N, [16, 3]);
  s.net(['na.a', 'na.b', 'pin:a'], 3);
  s.net(['nb.a', 'nb.b', 'pin:b'], 3);
  s.net(['na.y', 'g.a'], 13);
  s.net(['nb.y', 'g.b'], 13);
  s.wire('g.y', 'pin:y');
  return s.done();
});

/** The four-NAND XOR (and, with a fifth NAND, the half adder): m = NAND(a, b) is shared. */
function xorCore(s: Sketch): void {
  s.part('g1', N, [8, 5]).part('g2', N, [16, 1]).part('g3', N, [16, 9]).part('g4', N, [24, 5]);
  s.net(['pin:a', 'g2.a', 'g1.a'], 5);
  s.net(['pin:b', 'g1.b', 'g3.b'], 5);
  s.net(['g2.y', 'g4.a'], 22);
  s.net(['g3.y', 'g4.b'], 22);
}

const refXor = memo(() => {
  const s = ref('gates', 'xor', 'XOR', 'm = NAND(a, b); y = NAND(NAND(a, m), NAND(b, m)).');
  s.pin('a', 'in', [0, 2]).pin('b', 'in', [0, 10]).pin('y', 'out', [34, 7]);
  xorCore(s);
  s.net(['g1.y', 'g2.b', 'g3.a'], 14);
  s.wire('g4.y', 'pin:y');
  return s.done();
});

const refMux = memo(() => {
  const s = ref('gates', 'mux', 'MUX', 'y = NAND(NAND(a, NOT s), NAND(b, s)).');
  s.pin('a', 'in', [0, 2]).pin('b', 'in', [0, 8]).pin('s', 'in', [0, 14]).pin('y', 'out', [32, 6]);
  s.part('ns', N, [6, 12]).part('g1', N, [14, 1]).part('g2', N, [14, 7]).part('g3', N, [22, 4]);
  s.wire('pin:a', 'g1.a');
  s.wire('pin:b', 'g2.a');
  const sw = s.wire('ns.a', 'g2.b', [[3, 13], [3, 17], [13, 17], [13, 10]]);
  s.branch(sw, [3, 15], 'ns.b');
  s.branch(sw, [3, 14], 'pin:s');
  s.net(['ns.y', 'g1.b'], 11);
  s.net(['g1.y', 'g3.a'], 20);
  s.net(['g2.y', 'g3.b'], 20);
  s.wire('g3.y', 'pin:y');
  return s.done();
});

// ---- arithmetic ----------------------------------------------------------------------------------

const refHa = memo(() => {
  const s = ref('arithmetic', 'ha', 'HA', 'The XOR\'s first NAND is NOT(a·b): one more NAND gives the carry.');
  s.pin('a', 'in', [0, 2]).pin('b', 'in', [0, 10]).pin('s', 'out', [34, 7]).pin('c', 'out', [34, 17]);
  xorCore(s);
  s.part('g5', N, [16, 15]);
  s.net(['g1.y', 'g2.b', 'g3.a', 'g5.a', 'g5.b'], 14);
  s.wire('g4.y', 'pin:s');
  s.wire('g5.y', 'pin:c');
  return s.done();
});

/** Nine NANDs: two XORs sharing their first NANDs with the carry. cin is the top pin (ripple chains). */
const refFa = memo(() => {
  const s = ref('arithmetic', 'fa', 'FA', 'Nine NANDs: s = a ⊕ b ⊕ cin from two four-NAND XORs, cout = NAND of their first NANDs.');
  s.pin('cin', 'in', [0, 6]).pin('b', 'in', [0, 14]).pin('a', 'in', [0, 22]).pin('s', 'out', [58, 13]).pin('cout', 'out', [58, 25]);
  const g: [string, Vec][] = [['g1', [8, 15]], ['g2', [16, 19]], ['g3', [16, 11]], ['g4', [24, 15]], ['g5', [32, 11]], ['g6', [40, 15]], ['g7', [40, 7]], ['g8', [48, 11]], ['g9', [48, 23]]];
  for (const [id, at] of g) s.part(id, N, at);
  s.net(['pin:a', 'g2.b', 'g1.b'], 5);
  s.net(['pin:b', 'g1.a', 'g3.a'], 5);
  s.net(['g1.y', 'g2.a', 'g3.b', 'g9.a'], 14);
  s.net(['g3.y', 'g4.a'], 22);
  s.net(['g2.y', 'g4.b'], 22);
  s.net(['pin:cin', 'g5.a', 'g7.a'], 30);
  s.net(['g4.y', 'g5.b', 'g6.b'], 30);
  s.net(['g5.y', 'g6.a', 'g7.b', 'g9.b'], 38);
  s.net(['g7.y', 'g8.a'], 46);
  s.net(['g6.y', 'g8.b'], 46);
  s.wire('g8.y', 'pin:s');
  s.wire('g9.y', 'pin:cout');
  return s.done();
});

const refAdd4 = memo(() => {
  const fa = refFa();
  const s = ref('arithmetic', 'add4', 'Add4', 'Four full adders, the carry rippling down; the bits reach them through pointers.');
  s.pin('cin', 'in', [0, 4]).pin('a', 'in', [0, 12], 4).pin('b', 'in', [0, 22], 4).pin('s', 'out', [54, 23], 4).pin('cout', 'out', [54, 50]);
  s.part('sa', { split: ones(4) }, [4, 8]).part('sb', { split: ones(4) }, [4, 18]).part('ms', { merge: ones(4), pitch: 12 }, [46, -1]);
  s.wire('pin:a', 'sa.in');
  s.wire('pin:b', 'sb.in');
  s.wire('ms.out', 'pin:s');
  for (let i = 0; i < 4; i++) {
    const y = 2 + 12 * i;
    s.part(`fa${i}`, C(fa.id), [26, y]);
    s.wire(`sa.o${i}`, s.label(`a${i}`, [8, 9 + 2 * i]));
    s.wire(`sb.o${i}`, s.label(`b${i}`, [8, 19 + 2 * i]));
    s.wire(s.label(`a${i}`, [22, y + 6], 'left'), `fa${i}.a`);
    s.wire(s.label(`b${i}`, [22, y + 4], 'left'), `fa${i}.b`);
    s.wire(`fa${i}.s`, `ms.i${i}`);
    if (i < 3) s.wire(`fa${i}.cout`, `fa${i + 1}.cin`, [[40, y + 5], [40, y + 10], [24, y + 10], [24, y + 14]]);
  }
  s.wire('pin:cin', 'fa0.cin');
  s.wire('fa3.cout', 'pin:cout', [[40, 41], [40, 50]]);
  return s.done();
});

const refInc4 = memo(() => {
  const ha = refHa();
  const s = ref('arithmetic', 'inc4', 'Inc4', 'a + 1: bit 0 is NOT a0 with carry a0, then a chain of half adders.');
  s.pin('a', 'in', [0, 4], 4).pin('y', 'out', [44, 27], 4).pin('c', 'out', [44, 50]);
  s.part('sa', { split: ones(4) }, [4, 0]).part('g0', N, [20, 10]).part('my', { merge: ones(4), pitch: 10 }, [36, 7]);
  s.wire('pin:a', 'sa.in');
  for (let i = 0; i < 4; i++) s.wire(`sa.o${i}`, s.label(`a${i}`, [8, 1 + 2 * i]));
  s.net([s.label('a0', [16, 12], 'left'), 'g0.a', 'g0.b'], 18);
  s.wire('g0.y', 'my.i0');
  for (let i = 1; i < 4; i++) {
    const y = 10 + 10 * i;
    s.part(`ha${i}`, C(ha.id), [20, y]);
    s.wire(`ha${i}.s`, `my.i${i}`);
    s.wire(s.label(`a${i}`, [16, y + 4], 'left'), `ha${i}.b`);
    if (i === 1) s.wire(s.label('a0', [16, y + 2], 'left'), 'ha1.a');
    else s.wire(`ha${i - 1}.c`, `ha${i}.a`, [[30, y - 6], [30, y - 2], [18, y - 2], [18, y + 2]]);
  }
  s.wire('my.out', 'pin:y');
  s.wire('ha3.c', 'pin:c', [[30, 44], [30, 50]]);
  return s.done();
});

const refCmp2 = memo(() => {
  const xor = refXor();
  const s = ref('arithmetic', 'cmp2', 'Cmp2', 'eq = NOR of the bit XORs; lt = (¬a1·b1) + (a1 ≡ b1)·¬a0·b0, in NANDs.');
  s.pin('a', 'in', [0, 4], 2).pin('b', 'in', [0, 12], 2).pin('eq', 'out', [72, 7]).pin('lt', 'out', [72, 24]);
  s.part('sa', { split: [1, 1] }, [4, 2]).part('sb', { split: [1, 1] }, [4, 10]);
  s.wire('pin:a', 'sa.in');
  s.wire('pin:b', 'sb.in');
  for (const [sp, n] of [['sa', 'a'], ['sb', 'b']] as const) {
    const y0 = sp === 'sa' ? 3 : 11;
    for (let i = 0; i < 2; i++) s.wire(`${sp}.o${i}`, s.label(`${n}${i}`, [7, y0 + 2 * i]));
  }
  s.part('x1', C(xor.id), [22, 0]).part('x0', C(xor.id), [22, 8]);
  s.wire(s.label('a1', [20, 2], 'left'), 'x1.a');
  s.wire(s.label('b1', [20, 4], 'left'), 'x1.b');
  s.wire(s.label('a0', [20, 10], 'left'), 'x0.a');
  s.wire(s.label('b0', [20, 12], 'left'), 'x0.b');
  // eq = NOT NAND(NOT x1, NOT x0)
  s.part('e1', N, [38, 1]).part('e0', N, [38, 9]).part('q', N, [48, 5]).part('eqg', N, [58, 5]);
  s.net(['e1.a', 'e1.b', 'x1.y'], 35);
  s.net(['e0.a', 'e0.b', 'x0.y'], 35);
  s.net([s.label('e1', [45, 0], 'up'), 'e1.y', 'q.a'], 45);
  s.net(['e0.y', 'q.b'], 45);
  s.net(['eqg.a', 'eqg.b', 'q.y'], 55);
  s.wire('eqg.y', 'pin:eq');
  // lt = NAND(NAND(¬a1, b1), NAND(e1, ¬a0·b0))
  s.part('na1', N, [22, 18]).part('t1', N, [34, 19]).part('na0', N, [22, 26]).part('u', N, [34, 27]).part('v', N, [42, 27])
    .part('t0', N, [52, 25]).part('ltg', N, [62, 22]);
  s.net(['na1.a', 'na1.b', s.label('a1', [18, 20], 'left')], 20);
  s.wire('na1.y', 't1.a');
  s.wire(s.label('b1', [32, 22], 'left'), 't1.b');
  s.net(['na0.a', 'na0.b', s.label('a0', [18, 28], 'left')], 20);
  s.wire('na0.y', 'u.a');
  s.wire(s.label('b0', [32, 30], 'left'), 'u.b');
  s.net(['v.a', 'v.b', 'u.y'], 40);
  s.wire(s.label('e1', [50, 26], 'left'), 't0.a');
  s.net(['v.y', 't0.b'], 49);
  s.net(['t1.y', 'ltg.a'], 60);
  s.net(['t0.y', 'ltg.b'], 59);
  s.wire('ltg.y', 'pin:lt');
  return s.done();
});

// ---- sequential ------------------------------------------------------------------------------------

const refSr = memo(() => {
  const s = ref('sequential', 'sr', 'SR', 'Cross-coupled NANDs, active-low set and reset. The wires q, q_n hold the power-on state.');
  s.pin('s_n', 'in', [0, 2]).pin('r_n', 'in', [0, 12]).pin('q', 'out', [20, 3]).pin('q_n', 'out', [20, 11]);
  s.part('g1', N, [6, 1]).part('g2', N, [6, 9]);
  s.wire('pin:s_n', 'g1.a');
  s.wire('pin:r_n', 'g2.b');
  const q = s.wire('g1.y', 'pin:q', [], { name: 'q', init: 0 });
  s.branch(q, [13, 3], 'g2.a', [[13, 6], [4, 6], [4, 10]]);
  const qn = s.wire('g2.y', 'pin:q_n', [], { name: 'q_n', init: 1 });
  s.branch(qn, [14, 11], 'g1.b', [[14, 8], [3, 8], [3, 4]]);
  return s.done();
});

const refDlatch = memo(() => {
  const sr = refSr();
  const s = ref('sequential', 'dlatch', 'D latch', 'Four NANDs: s_n = NAND(d, e), r_n = NAND(s_n, e) into the SR latch.');
  s.pin('d', 'in', [0, 3]).pin('e', 'in', [0, 9]).pin('q', 'out', [44, 6]);
  s.part('g1', N, [10, 2]).part('g2', N, [18, 9]).part('sr', C(sr.id), [26, 4]);
  s.wire('pin:d', 'g1.a');
  s.net(['pin:e', 'g1.b', 'g2.b'], 7);
  s.net(['g1.y', 'sr.s_n', 'g2.a'], 16);
  s.net(['g2.y', 'sr.r_n'], 24);
  s.wire('sr.q', 'pin:q');
  return s.done();
});

const refDff = memo(() => {
  const dl = refDlatch();
  const s = ref('sequential', 'dff', 'DFF', 'Master–slave: the master is open while clk = 0, the slave while clk = 1, so q takes d at the rising edge.');
  s.pin('d', 'in', [0, 3]).pin('clk', 'in', [0, 12], 1, 'clock').pin('q', 'out', [44, 5]);
  s.part('inv', N, [4, 8]).part('master', C(dl.id), [10, 1]).part('slave', C(dl.id), [26, 2]);
  s.wire('pin:d', 'master.d');
  s.net(['inv.y', 'master.e'], 9);
  const c = s.wire('pin:clk', 'inv.b', [[2, 12], [2, 11]]);
  s.branch(c, [2, 11], 'inv.a', [[2, 9]]);
  s.branch(c, [2, 12], 'slave.e', [[2, 14], [24, 14], [24, 6]]);
  s.wire('master.q', 'slave.d');
  s.wire('slave.q', 'pin:q');
  return s.done({ d: 'd', q: 'q', clk: 'clk' });
});

const refDffe = memo(() => {
  const mux = refMux(), dff = refDff();
  const s = ref('sequential', 'dffe', 'DFFE', 'A multiplexer feeds q back while en = 0.');
  s.pin('d', 'in', [0, 4]).pin('en', 'in', [0, 6]).pin('clk', 'in', [0, 10], 1, 'clock').pin('q', 'out', [36, 5]);
  s.part('mux', C(mux.id), [6, 0]).part('ff', C(dff.id), [20, 2]);
  s.wire('pin:d', 'mux.b');
  s.wire('pin:en', 'mux.s');
  s.wire('pin:clk', 'ff.clk', [[18, 10], [18, 6]]);
  s.wire('mux.y', 'ff.d');
  const q = s.wire('ff.q', 'pin:q');
  s.branch(q, [32, 5], 'mux.a', [[32, -2], [4, -2], [4, 2]]);
  return s.done({ d: 'd', q: 'q', clk: 'clk', en: 'en' });
});

const refReg4 = memo(() => {
  const ffe = refDffe();
  const s = ref('sequential', 'reg4', 'Reg4', 'Four enable flip-flops sharing en and clk.');
  s.pin('d', 'in', [0, 19], 4).pin('en', 'in', [0, 44]).pin('clk', 'in', [0, 48], 1, 'clock').pin('q', 'out', [40, 21], 4);
  s.part('sd', { split: ones(4), pitch: 10 }, [6, -1]).part('mq', { merge: ones(4), pitch: 10 }, [32, 1]);
  for (let i = 0; i < 4; i++) {
    s.part(`ff${i}`, C(ffe.id), [14, 2 + 10 * i]);
    s.wire(`sd.o${i}`, `ff${i}.d`);
    s.wire(`ff${i}.q`, `mq.i${i}`);
  }
  s.wire('pin:d', 'sd.in');
  s.wire('mq.out', 'pin:q');
  s.net(['pin:en', ...[0, 1, 2, 3].map((i) => `ff${i}.en`)], 10);
  s.net(['pin:clk', ...[0, 1, 2, 3].map((i) => `ff${i}.clk`)], 12);
  return s.done();
});

const refCnt4 = memo(() => {
  const reg = refReg4(), inc = refInc4();
  const s = ref('sequential', 'cnt4', 'Cnt4', 'q ← rst ? 0 : q + 1 while en (or rst) is 1. The incremented value is ANDed with ¬rst; the register loads when en + rst.');
  s.pin('en', 'in', [0, 3]).pin('rst', 'in', [0, 11]).pin('clk', 'in', [0, 46], 1, 'clock').pin('q', 'out', [68, 6], 4);
  s.part('nen', N, [6, 1]).part('nrst', N, [6, 9]).part('ren', N, [16, 4]).part('inc', C(inc.id), [10, 25])
    .part('sy', { split: ones(4), pitch: 6 }, [24, 18]).part('mm', { merge: ones(4), pitch: 6 }, [42, 17]).part('reg', C(reg.id), [48, 2]);
  s.net(['pin:en', 'nen.a', 'nen.b'], 3);
  s.net(['pin:rst', 'nrst.a', 'nrst.b'], 3);
  s.net(['nen.y', 'ren.a'], 13);
  const nr = s.wire('ren.b', 'g3.a', [[14, 7], [14, 15], [27, 15], [27, 37]]);
  s.branch(nr, [14, 11], 'nrst.y');
  s.wire('ren.y', 'reg.en');
  s.net(['inc.y', 'sy.in'], 22);
  for (let i = 0; i < 4; i++) {
    const y = 18 + 6 * i;
    s.part(`g${i}`, N, [28, y]).part(`n${i}`, N, [36, y]);
    if (i < 3) s.branch(nr, [27, y + 1], `g${i}.a`);
    s.wire(`sy.o${i}`, `g${i}.b`);
    s.net([`n${i}.a`, `n${i}.b`, `g${i}.y`], 34);
    s.wire(`n${i}.y`, `mm.i${i}`);
  }
  s.wire('mm.out', 'reg.d', [[45, 29], [45, 4]]);
  s.wire('pin:clk', 'reg.clk', [[47, 46], [47, 8]]);
  s.net(['reg.q', 'pin:q', s.label('q', [64, 10], 'down')], 64);
  s.wire(s.label('q', [6, 28], 'left'), 'inc.a');
  return s.done();
});

// ---- memory and the CPU's first blocks (any library part allowed) ---------------------------------

const refRam = memo(() => {
  const reg = refReg4();
  const s = ref('memory', 'ram4x4', 'RAM 4x4', 'A decoder picks the register that loads; a 4:1 multiplexer reads the addressed one. Shared signals travel by pointer.');
  s.pin('addr', 'in', [0, 8], 2).pin('we', 'in', [0, 12]).pin('d', 'in', [0, 20], 4).pin('clk', 'in', [0, 24], 1, 'clock').pin('q', 'out', [72, 19], 4);
  s.part('dec', L('dec2e'), [8, 4]).part('mux', L('mux4x4'), [60, 14]);
  const a = s.wire('pin:addr', 'dec.a');
  s.branch(a, [3, 8], s.label('addr', [3, 4], 'up'));
  s.wire('pin:we', 'dec.en', [[5, 12], [5, 10]]);
  s.wire('pin:d', s.label('din', [4, 20]));
  s.wire('pin:clk', s.label('clk', [4, 24]));
  for (let i = 0; i < 4; i++) {
    const y = 2 + 12 * i;
    s.wire(`dec.y${i}`, s.label(`wr${i}`, [21, 6 + 2 * i]));
    s.part(`w${i}`, C(reg.id), [36, y]);
    s.wire(s.label('din', [33, y + 2], 'left'), `w${i}.d`);
    s.wire(s.label(`wr${i}`, [33, y + 4], 'left'), `w${i}.en`);
    s.wire(s.label('clk', [33, y + 6], 'left'), `w${i}.clk`);
  }
  s.net(['w0.q', 'mux.d0'], 54);
  s.wire('w1.q', 'mux.d1');
  s.net(['w2.q', 'mux.d2'], 54);
  s.net(['w3.q', 'mux.d3'], 56);
  s.wire(s.label('addr', [62, 27], 'down'), 'mux.s');
  s.wire('mux.y', 'pin:q');
  return s.done();
});

const refAlu = memo(() => {
  const s = ref('cpu', 'alu4', 'ALU4', 'Adder / subtractor, AND, OR side by side; op picks one through a 4:1 multiplexer. op[0] is the subtract line.');
  s.pin('a', 'in', [0, 3], 4).pin('b', 'in', [0, 5], 4).pin('op', 'in', [0, 36], 2).pin('y', 'out', [64, 7], 4).pin('z', 'out', [64, 14]);
  s.part('as', L('addsub4'), [16, 0]).part('and', L('andx4'), [18, 14]).part('or', L('orx4'), [18, 24])
    .part('sop', { split: [1, 1] }, [4, 34]).part('mux', L('mux4x4'), [40, 2]).part('zero', L('zero4'), [52, 12]);
  s.net(['pin:a', 'as.a', 'and.a', 'or.a'], 12);
  s.net(['pin:b', 'as.b', 'and.b', 'or.b'], 10);
  const op = s.wire('pin:op', 'sop.in');
  s.branch(op, [2, 36], 'mux.s', [[2, 40], [42, 40]]);
  s.wire('sop.o0', s.label('sub', [8, 35]));
  s.wire(s.label('sub', [14, 9], 'down'), 'as.sub', [[14, 7]]);
  s.net(['as.s', 'mux.d0', 'mux.d1'], 34);
  s.net(['and.y', 'mux.d2'], 36);
  s.net(['or.y', 'mux.d3'], 38);
  s.net(['mux.y', 'pin:y', 'zero.a'], 48);
  s.wire('zero.z', 'pin:z');
  return s.done();
});

/** The fetch challenge's program and ROM (given: the learner wires around it). */
const FETCH_ROM = { k: 3, w: 32 as const, addr: 'rv32' as const, lang: 'asm' as const, src: FETCH_PROGRAM };
const ROM_PART: PartDoc = { id: 'rom', ref: { rom: FETCH_ROM }, at: [36, 4], label: 'program' };
const fetchWords = memo(() => romImage(FETCH_ROM).words);

const refFetch = memo(() => {
  const s = ref('cpu', 'fetch', 'Fetch', 'PC ← rst ? 0 : PC + 4 every edge; the ROM turns the PC into the instruction. The PC reaches the adder through a pointer pair.');
  s.pin('rst', 'in', [0, 10]).pin('clk', 'in', [0, 12], 1, 'clock').pin('pc', 'out', [56, 1], 32).pin('instr', 'out', [56, 6], 32);
  s.doc.parts.push({ ...ROM_PART });
  s.part('k0', { const: { width: 32, value: 0 } }, [2, 5]).part('m', L('mux2x32'), [12, 2]).part('one', { const: { width: 1, value: 1 } }, [18, 6])
    .part('pcr', L('reg32'), [22, 3]).part('inc', L('plus4'), [24, 15], true);
  s.wire(s.label('next', [10, 4], 'left'), 'm.a');
  s.wire('k0.y', 'm.b');
  s.wire('pin:rst', 'm.s', [[14, 10]]);
  s.wire('m.y', 'pcr.d');
  s.wire('one.y', 'pcr.en');
  s.wire('pin:clk', 'pcr.clk', [[26, 12]]);
  const q = s.wire('pcr.q', 'rom.addr');
  s.branch(q, [32, 6], 'pin:pc', [[32, 1]]);
  s.branch(q, [34, 6], s.label('pc', [34, 10], 'down'));
  s.wire(s.label('pc', [33, 17]), 'inc.a');
  s.wire('inc.y', s.label('next', [22, 17], 'left'));
  s.wire('rom.data', 'pin:instr');
  return s.done();
});

// ---- the challenges --------------------------------------------------------------------------------

const answer = (f: () => ChipDoc) => () => withDeps(f());
const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string) => [
  ...ins.map(([name, width = 1]) => ({ name, dir: 'in' as const, width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]) => ({ name, dir: 'out' as const, width })),
];

/** Steps of a register test: load with en = 1, hold with en = 0 (a value on d must not get in). */
function regSteps(): SeqStep[] {
  const st: SeqStep[] = [];
  let q = 0;
  const vals = [5, 10, 15, 0, 9, 6, 3, 12];
  vals.forEach((v, i) => {
    const en = i % 3 === 2 ? 0 : 1;
    if (en) q = v;
    st.push({ set: { d: v, en }, tick: true, expect: { q } });
    st.push({ set: { d: (v + 7) & 15 }, expect: { q } }); // no edge: no change
  });
  return st;
}

function counterSteps(): SeqStep[] {
  const st: SeqStep[] = [{ set: { rst: 1, en: 0 }, tick: true, expect: { q: 0 } }];
  let q = 0;
  const step = (en: number, rst: number, n = 1) => {
    for (let k = 0; k < n; k++) {
      q = rst ? 0 : en ? (q + 1) & 15 : q;
      st.push({ set: { en, rst }, tick: true, expect: { q } });
    }
  };
  step(1, 0, 18); // wraps past 15
  step(0, 0, 3);
  step(1, 0, 2);
  step(1, 1);
  step(0, 1);
  step(1, 0, 3);
  return st;
}

function ramSteps(): SeqStep[] {
  const st: SeqStep[] = [];
  const mem = [0, 0, 0, 0];
  const write = (addr: number, d: number, we = 1) => {
    if (we) mem[addr] = d;
    st.push({ set: { addr, d, we }, tick: true, expect: { q: mem[addr] } });
  };
  [[0, 3], [1, 12], [2, 5], [3, 10]].forEach(([a, d]) => write(a, d));
  for (const a of [0, 1, 2, 3, 2, 0]) st.push({ set: { addr: a, we: 0 }, expect: { q: mem[a] } });
  write(1, 7, 0); // we = 0: the edge must not write
  write(2, 15);
  for (const a of [3, 2, 1, 0]) st.push({ set: { addr: a, we: 0, d: a * 3 }, tick: true, expect: { q: mem[a] } });
  return st;
}

function fetchSteps(): SeqStep[] {
  const w = fetchWords();
  const word = (pc: number) => w[(pc / 4) % 8] ?? 0x13;
  const st: SeqStep[] = [{ set: { rst: 1 }, tick: true, expect: { pc: 0, instr: word(0) } }];
  for (let k = 1; k <= 10; k++) st.push({ set: { rst: 0 }, tick: true, expect: { pc: 4 * k, instr: word(4 * k) } });
  st.push({ set: { rst: 1 }, tick: true, expect: { pc: 0, instr: word(0) } });
  st.push({ set: { rst: 0 }, tick: true, expect: { pc: 4, instr: word(4) } });
  return st;
}

export const CHALLENGES: BuildChallenge[] = [
  // transistors
  {
    id: 't_inv', title: 'CMOS inverter', level: 'transistors', allowed: 'transistors',
    brief: 'Build <b>y = ¬a</b> from one PMOS and one NMOS. The PMOS (source on VDD) conducts when its gate is 0, the NMOS (source on GND) when it is 1: exactly one of them drives <code>y</code>. Solved switch by switch, so a floating or shorted output fails.',
    ports: pins([['a']], [['y']]), check: { kind: 'table', spec: ([a]) => [a ^ 1] }, limits: { maxTransistors: 2 }, answer: answer(refInv),
  },
  {
    id: 't_nand', title: 'CMOS NAND', level: 'transistors', allowed: 'transistors',
    brief: 'Build <b>y = ¬(a·b)</b>: the pull-down must conduct only when both inputs are 1 (NMOS in series), the pull-up whenever either is 0 (PMOS in parallel). Four transistors: the brick everything else on this site is made of.',
    ports: pins([['a'], ['b']], [['y']]), check: { kind: 'table', spec: ([a, b]) => [(a & b) ^ 1] }, limits: { maxTransistors: 4 }, answer: answer(refNandT),
  },
  {
    id: 't_nor', title: 'CMOS NOR', level: 'transistors', allowed: 'transistors',
    brief: 'Build <b>y = ¬(a + b)</b>: the dual of the NAND. PMOS in series, NMOS in parallel. (Series PMOS are slow: why CMOS libraries prefer NAND.)',
    ports: pins([['a'], ['b']], [['y']]), check: { kind: 'table', spec: ([a, b]) => [(a | b) ^ 1] }, limits: { maxTransistors: 4 }, answer: answer(refNor),
  },
  // gates
  {
    id: 'g_not', title: 'NOT from NAND', level: 'gates', allowed: 'nand',
    brief: 'NAND is the only gate allowed. Make <b>y = ¬a</b>.',
    ports: pins([['a']], [['y']]), check: { kind: 'table', spec: ([a]) => [a ^ 1] }, limits: { maxNand: 1, maxDepth: 1 }, answer: answer(refNot),
  },
  {
    id: 'g_and', title: 'AND from NAND', level: 'gates', allowed: 'nand',
    brief: 'Make <b>y = a·b</b> from NANDs (your NOT chip is welcome: chips you built from NANDs are allowed).',
    ports: pins([['a'], ['b']], [['y']]), check: { kind: 'table', spec: ([a, b]) => [a & b] }, limits: { maxNand: 2, maxDepth: 2 }, answer: answer(refAnd),
  },
  {
    id: 'g_or', title: 'OR from NAND', level: 'gates', allowed: 'nand',
    brief: 'Make <b>y = a + b</b>. De Morgan: a + b = ¬(¬a · ¬b).',
    ports: pins([['a'], ['b']], [['y']]), check: { kind: 'table', spec: ([a, b]) => [a | b] }, limits: { maxNand: 3, maxDepth: 2 }, answer: answer(refOr),
  },
  {
    id: 'g_xor', title: 'XOR from NAND', level: 'gates', allowed: 'nand',
    brief: 'Make <b>y = a ⊕ b</b>. The obvious sum of products costs 5 NANDs or more; par is <b>4</b>: share ¬(a·b) between both halves.',
    ports: pins([['a'], ['b']], [['y']]), check: { kind: 'table', spec: ([a, b]) => [a ^ b] }, limits: { maxNand: 4, maxDepth: 3 }, answer: answer(refXor),
  },
  {
    id: 'g_mux', title: '2:1 multiplexer', level: 'gates', allowed: 'nand',
    brief: '<b>y = s ? b : a</b>. Par: 4 NANDs, depth 3 (one of them inverts <code>s</code>).',
    ports: pins([['a'], ['b'], ['s']], [['y']]), check: { kind: 'table', spec: ([a, b, s]) => [s ? b : a] }, limits: { maxNand: 4, maxDepth: 3 }, answer: answer(refMux),
  },
  // arithmetic
  {
    id: 'a_ha', title: 'Half adder', level: 'arithmetic', allowed: 'nand',
    brief: 'Add two bits: <b>s = a ⊕ b</b>, <b>c = a·b</b>. Par 5 NANDs: the XOR\'s first NAND already computes ¬(a·b).',
    ports: pins([['a'], ['b']], [['s'], ['c']]), check: { kind: 'table', spec: ([a, b]) => [a ^ b, a & b] }, limits: { maxNand: 5, maxDepth: 3 }, answer: answer(refHa),
  },
  {
    id: 'a_fa', title: 'Full adder', level: 'arithmetic', allowed: 'nand',
    brief: 'Add three bits: <b>s = a ⊕ b ⊕ cin</b>, <b>cout = maj(a, b, cin)</b>. Two half adders and an OR cost 13 NANDs; par is <b>9</b> (the carry reuses both XORs\' first NANDs).',
    ports: pins([['a'], ['b'], ['cin']], [['s'], ['cout']]),
    check: { kind: 'table', spec: ([a, b, c]) => [(a + b + c) & 1, (a + b + c) >> 1] }, limits: { maxNand: 9, maxDepth: 6 }, answer: answer(refFa),
  },
  {
    id: 'a_add4', title: '4-bit ripple adder', level: 'arithmetic', allowed: 'nand',
    brief: '<b>{cout, s} = a + b + cin</b> on 4-bit words, from four of your full adders, carry rippling from bit 0 to bit 3. Splitters and mergers are free. The depth grows with every bit: this is why fast adders exist.',
    ports: pins([['a', 4], ['b', 4], ['cin']], [['s', 4], ['cout']]),
    check: { kind: 'table', spec: ([a, b, c]) => [(a + b + c) & 15, (a + b + c) >> 4] }, limits: { maxNand: 36, maxDepth: 12 }, answer: answer(refAdd4),
  },
  {
    id: 'a_inc4', title: '4-bit incrementer', level: 'arithmetic', allowed: 'nand',
    brief: '<b>{c, y} = a + 1</b>. An adder with b = 0 and cin = 1 wastes most of its gates: with one input constant, each bit is a half adder (bit 0 just an inverter).',
    ports: pins([['a', 4]], [['y', 4], ['c']]), check: { kind: 'table', spec: ([a]) => [(a + 1) & 15, (a + 1) >> 4] }, limits: { maxNand: 16, maxDepth: 7 }, answer: answer(refInc4),
  },
  {
    id: 'a_cmp2', title: '2-bit comparator', level: 'arithmetic', allowed: 'nand',
    brief: 'Unsigned compare of 2-bit words: <b>eq = (a = b)</b>, <b>lt = (a &lt; b)</b>. The high bits decide unless they are equal; then the low bits do.',
    ports: pins([['a', 2], ['b', 2]], [['eq'], ['lt']]), check: { kind: 'table', spec: ([a, b]) => [a === b ? 1 : 0, a < b ? 1 : 0] }, limits: { maxNand: 19 }, answer: answer(refCmp2),
  },
  // sequential
  {
    id: 's_sr', title: 'SR latch', level: 'sequential', allowed: 'nand',
    brief: 'Two cross-coupled NANDs. Active-low inputs: <code>s_n</code> = 0 sets q = 1, <code>r_n</code> = 0 resets it, both 1 holds. <code>q_n</code> = ¬q. The test starts with both inputs at 1 and never releases both at once.',
    ports: pins([['s_n'], ['r_n']], [['q'], ['q_n']]),
    check: {
      kind: 'sequence', init: { s_n: 1, r_n: 1 }, steps: [
        { set: { s_n: 0 }, expect: { q: 1, q_n: 0 } }, { set: { s_n: 1 }, expect: { q: 1, q_n: 0 } },
        { set: { r_n: 0 }, expect: { q: 0, q_n: 1 } }, { set: { r_n: 1 }, expect: { q: 0, q_n: 1 } },
        { set: { r_n: 0 }, expect: { q: 0, q_n: 1 } }, { set: { r_n: 1 }, expect: { q: 0, q_n: 1 } },
        { set: { s_n: 0 }, expect: { q: 1, q_n: 0 } }, { set: { s_n: 1 }, expect: { q: 1, q_n: 0 } },
      ],
    },
    limits: { maxNand: 2 }, answer: answer(refSr),
  },
  {
    id: 's_dlatch', title: 'D latch', level: 'sequential', allowed: 'nand',
    brief: 'While <code>e</code> = 1, q follows d (transparent); while e = 0, q holds. Par 4 NANDs: two gate the SR latch, and the second can use the first\'s output instead of ¬d.',
    ports: pins([['d'], ['e']], [['q']]),
    check: {
      kind: 'sequence', steps: [
        { set: { e: 1, d: 1 }, expect: { q: 1 } }, { set: { d: 0 }, expect: { q: 0 } }, { set: { d: 1 }, expect: { q: 1 } },
        { set: { e: 0 }, expect: { q: 1 } }, { set: { d: 0 }, expect: { q: 1 } }, { set: { e: 1 }, expect: { q: 0 } },
        { set: { e: 0 }, expect: { q: 0 } }, { set: { d: 1 }, expect: { q: 0 } }, { set: { d: 0 }, expect: { q: 0 } },
      ],
    },
    limits: { maxNand: 4 }, answer: answer(refDlatch),
  },
  {
    id: 's_dff', title: 'Edge-triggered D flip-flop', level: 'sequential', allowed: 'nand',
    brief: 'q takes d at the <b>rising</b> edge of clk, and only then: d changing while clk is high or low must not reach q. Two D latches, master and slave, enabled on opposite clock phases (par 9 NANDs; the classic 7474 needs 6).',
    ports: pins([['d'], ['clk']], [['q']], 'clk'),
    check: {
      kind: 'sequence', steps: [
        { set: { d: 1 }, tick: true, expect: { q: 1 } }, { set: { d: 0 }, expect: { q: 1 } },
        { set: { clk: 1 }, expect: { q: 0 } }, { set: { d: 1 }, expect: { q: 0 } }, { set: { clk: 0 }, expect: { q: 0 } },
        { set: { d: 0 }, expect: { q: 0 } }, { set: { d: 1 }, expect: { q: 0 } }, { set: { clk: 1 }, expect: { q: 1 } },
        { set: { d: 0 }, expect: { q: 1 } }, { set: { clk: 0 }, expect: { q: 1 } }, { tick: true, expect: { q: 0 } },
        { set: { d: 1 }, tick: true, expect: { q: 1 } }, { tick: true, expect: { q: 1 } },
      ],
    },
    limits: { maxNand: 9 }, answer: answer(refDff),
  },
  {
    id: 's_reg4', title: '4-bit register with enable', level: 'sequential', allowed: 'nand',
    brief: 'At a rising edge of clk, <b>q ← d</b> if <code>en</code> = 1; otherwise q keeps its value. Gating the clock with en would work in simulation and fail on silicon (glitches, skew): feed q back through a multiplexer instead.',
    ports: pins([['d', 4], ['en'], ['clk']], [['q', 4]], 'clk'), check: { kind: 'sequence', steps: regSteps() }, limits: { maxNand: 52 }, answer: answer(refReg4),
  },
  {
    id: 's_cnt4', title: '4-bit counter', level: 'sequential', allowed: 'nand',
    brief: 'At each rising edge: <b>q ← 0</b> if <code>rst</code>, else <b>q ← q + 1</b> if <code>en</code>, else hold. Wraps from 15 to 0. Your register and incrementer do most of the work; a synchronous reset is an AND per bit.',
    ports: pins([['en'], ['rst'], ['clk']], [['q', 4]], 'clk'), check: { kind: 'sequence', steps: counterSteps() }, answer: answer(refCnt4),
  },
  // memory
  {
    id: 'm_ram', title: '4 × 4 RAM', level: 'memory', allowed: 'any',
    brief: 'Four 4-bit words. Read is combinational: <b>q = mem[addr]</b>. Write at the rising edge of clk when <code>we</code> = 1: <b>mem[addr] ← d</b>. Use your register; the library\'s decoder and multiplexer are allowed here.',
    ports: pins([['addr', 2], ['we'], ['d', 4], ['clk']], [['q', 4]], 'clk'), check: { kind: 'sequence', steps: ramSteps() }, answer: answer(refRam),
  },
  // cpu
  {
    id: 'c_alu', title: '4-bit ALU', level: 'cpu', allowed: 'any',
    brief: '<b>y</b> = a + b (op = 0), a − b (1), a AND b (2), a OR b (3), modulo 16; <b>z</b> = (y = 0). One adder subtracts too: a − b = a + ¬b + 1.',
    ports: pins([['a', 4], ['b', 4], ['op', 2]], [['y', 4], ['z']]),
    check: {
      kind: 'table', spec: ([a, b, op]) => {
        const y = [(a + b) & 15, (a - b) & 15, a & b, a | b][op];
        return [y, y === 0 ? 1 : 0];
      },
    },
    answer: answer(refAlu),
  },
  {
    id: 'c_fetch', title: 'Instruction fetch', level: 'cpu', allowed: 'any',
    brief: 'The ROM holds a program (byte-addressed, like a PC). Build the PC: a 32-bit register with <b>pc ← rst ? 0 : pc + 4</b> at every rising edge, and <b>instr</b> = the ROM word at pc. Long feedback wires are what pointers are for: name the PC once, use it anywhere.',
    ports: pins([['rst'], ['clk']], [['pc', 32], ['instr', 32]], 'clk'), given: [ROM_PART],
    check: { kind: 'sequence', steps: fetchSteps() }, answer: answer(refFetch),
  },
];

export const challengeById = (id: string) => CHALLENGES.find((c) => c.id === id);

