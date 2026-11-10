// RV16 custom instructions (riscv/rv16/custom16.ts): rows in OPX's free funct3 values. Without rows nothing moves:
// every rv16_* part and every campaign reference answer that places one keeps the fingerprint pinned in
// tests/rv16-fingerprints.json (scripts/rv16-fp.ts --write, taken before rows existed). With rows, the control unit
// follows controlSpec and both cores follow the golden model, register write by register write and store by store.

import { describe, expect, it } from 'vitest';
import '../src/lib/index';
import { NODES } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { control16, controlSpec, CTL16, CTL_OUTS, RV16_CORE, rv16Core } from '../src/lib/rv16/cpu';
import { RV16_PIPE, rv16Pipe } from '../src/lib/rv16/pipe';
import { RV16_ALU16 } from '../src/lib/rv16/logic';
import { runCore, type CoreTest } from '../src/campaign/corecheck';
import { alu16, problems16, sanitizeRows16, type Custom16Row } from '../src/riscv/rv16/custom16';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { decode16, disasm16 } from '../src/riscv/rv16/isa16';
import { Iss16 } from '../src/riscv/rv16/iss16';
import { randomProgram } from '../src/riscv/rv16/randprog';
import { RV16_COMPOSE, rv16Compose } from '../src/riscv/rv16/compose16';
import { evalOnce, simulate } from '../src/sim/harness';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { rv16Fingerprints } from './rv16fingerprint';
import pinned from './rv16-fingerprints.json';

describe('RV16 without custom rows', () => {
  it('every rv16 part and campaign answer keeps its fingerprint', () => {
    const now = rv16Fingerprints(NODES.map((n) => () => levelChallenge(n)));
    // every answer pinned before the custom rows existed is unchanged; levels added since (the Debugging act, m_lut, s_icg …)
    // place rv16 parts too and simply are not in the pin, so they are not compared
    for (const [id, f] of Object.entries(pinned.answers)) expect((now.answers as Record<string, string>)[id], id).toBe(f);
    for (const [id, f] of Object.entries(pinned.parts)) expect(now.parts[id], id).toBe(f);
  }, 60_000);

  it('the cores are the same objects', () => {
    expect(rv16Core(true)).toBe(RV16_CORE);
    expect(rv16Core(true, false, '', false, [])).toBe(RV16_CORE);
    expect(rv16Pipe({ fwd: true, stall: true, flush: true })).toBe(RV16_PIPE);
    expect(rv16Pipe({ fwd: true, stall: true, flush: true, custom: [] })).toBe(RV16_PIPE);
    expect(control16([])).toBe(CTL16);
    expect(CTL16.id).toBe('rv16_ctl');
  });

  it('random programs are the same without rows', () => {
    expect(randomProgram(9, 3, 40, undefined, [])).toBe(randomProgram(9, 3, 40));
    // the hash of these three programs as randprog.ts made them before rows existed (origin/main 48736b0a)
    const s = ([1, 2, 3] as const).map((l) => randomProgram(9, l, 40, l === 3 ? 'all' : undefined)).join('|');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    expect([(h >>> 0).toString(16), s.length]).toEqual(['e9977f70', 3399]);
  });
});

const LWX: Custom16Row = { name: 'lwx', f3: 1, alu: 'add', result: 'mem' };
const LWSUB: Custom16Row = { name: 'lwsub', f3: 7, alu: 'sub', result: 'mem' };
const LWOR: Custom16Row = { name: 'lwor', f3: 6, alu: 'f3', result: 'mem' };
const SETS: Custom16Row[][] = [
  [LWX],
  [LWX, LWSUB, LWOR],
  // every free funct3, every ALU choice, both results
  [
    { name: 'lwx', f3: 1, alu: 'add', result: 'mem' }, { name: 'slt2', f3: 2, alu: 'f3', result: 'alu' },
    { name: 'lwsltu', f3: 3, alu: 'f3', result: 'mem' }, { name: 'rsub', f3: 4, alu: 'sub', result: 'alu' },
    { name: 'plus', f3: 6, alu: 'add', result: 'alu' }, { name: 'lwand', f3: 7, alu: 'f3', result: 'mem' },
  ],
];

describe('RV16 custom rows: the model', () => {
  it('the ALU reference is the hardware ALU at every control value', () => {
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) & 0xffff;
    const A = [0, 1, 0xffff, 0x8000, 0x7fff, 15, 16, 2, 0], B = [0, 0xffff, 1, 1, 0x8000, 3, 17, 15, 0];
    for (let ctl = 0; ctl < 16; ctl++) for (let k = 0; k < 300; k++) {
      const a = k < A.length ? A[k] : rnd(), b = k < B.length ? B[k] : rnd();
      expect(alu16(ctl, a, b), `ctl ${ctl} a ${a} b ${b}`).toBe(RV16_ALU16.spec!([a, b, ctl])[0]);
    }
  });

  it('controlSpec: words that are not rows are as before; a row is OP with its ALU control and result', () => {
    for (const rows of SETS) for (let w = 0; w < 65536; w++) {
      const r = (w & 15) === 2 ? rows.find((x) => x.f3 === w >> 13) : undefined;
      const got = controlSpec(w, rows), base = controlSpec(w);
      if (!r) { expect(got).toEqual(base); continue; }
      expect(got.out).toEqual([1, 0, 0, r.alu === 'add' ? 0 : r.alu === 'sub' ? 8 : r.f3, 0, r.result === 'mem' ? 1 : 0, 0, 0, 0]);
      expect(got.care).toEqual(base.care);
    }
  });

  it('the control unit with rows does what controlSpec says, on every word it cares about', () => {
    for (const rows of SETS) {
      const sim = simulate(control16(rows));
      for (let w = 0; w < 65536; w += (w & 15) === 2 ? 1 : 7) {
        const { out, care } = controlSpec(w, rows), got = evalOnce(sim, [w]);
        CTL_OUTS.forEach((n, i) => expect(got[i] & care[i], `${n} of 0x${w.toString(16)}`).toBe(out[i] & care[i]));
      }
    }
  }, 60_000);

  it('assembles, decodes and disassembles rows; refuses bad ones', () => {
    const rows = [LWX, LWSUB, LWOR];
    const a = assemble16('lwx a0, a1, a2\nlwsub t0, sp, ra\nlwor t1, a0, zero', rows);
    expect(a.errors).toEqual([]);
    expect(a.words.map((w) => disasm16(w, 0, rows))).toEqual(['lwx a0, a1, a2', 'lwsub t0, sp, ra', 'lwor t1, a0, zero']);
    expect(decode16(a.words[0]).spec).toBe(null);
    expect(assemble16('lwx a0, a1, a2').errors.length).toBe(1);
    expect(problems16({ name: 'add', f3: 1, alu: 'add', result: 'mem' }, new Set(['add'])).some((p) => p.level === 'bad')).toBe(true);
    expect(problems16(LWX, new Set())).toEqual([]);
    expect(problems16({ ...LWX, result: 'alu' }, new Set())[0].level).toBe('warn');
    expect(sanitizeRows16([LWX, { ...LWSUB, f3: 1 }, { ...LWOR, f3: 5 }, LWOR, 'x'])).toEqual([LWX, LWOR]);
  });

  it('the instruction builder and tiles know them (rv16Compose)', () => {
    const isa = rv16Compose([LWX, LWOR]);
    const w = assemble16('lwx a0, a1, a2', [LWX]).words[0];
    expect(isa.encode('lwx', { rd: 3, rs1: 4, rs2: 5 })).toBe(w);
    expect(isa.decode(w)).toEqual({ id: 'lwx', parts: { rd: 3, rs1: 4, rs2: 5 } });
    expect(isa.text(w)).toBe('lwx a0, a1, a2');
    expect(isa.program('lwx a0, a1, a2\nlwor t0, a0, zero').errors).toEqual([]);
    expect(isa.groups.find((g) => g.name === 'Yours')!.ids).toEqual(['lwx', 'lwor']);
    expect(RV16_COMPOSE.decode(w)).toBe(null);
    expect(rv16Compose()).not.toBe(RV16_COMPOSE);
  });

  it('the golden model runs them', () => {
    const rows = [LWX, LWSUB, LWOR];
    const a = assemble16('.data\nd: .word 5, 6, 7, 8\n.text\nli a0, 1\nli a1, 2\nlwx t0, a0, a1\nlwsub t1, a1, a0\nlwor a2, a0, a1\nhalt', rows);
    const iss = new Iss16(a.words, { custom: rows }, a.data);
    iss.run();
    expect(iss.error).toBe(null);
    expect([iss.x[6], iss.x[7], iss.x[5]]).toEqual([8, 6, 8]);
  });
});

// ---- the hardware against the golden model ----

const DIRECTED: CoreTest[] = [
  // a memory row's value used at once (the pipeline's load-use stall), then forwarded on
  { name: 'use', src: '.data\nd: .word 10, 20, 30, 40, 50\n.text\nli a0, 1\nli a1, 2\nlwx t0, a0, a1\nadd t1, t0, t0\nlwx a2, t0, zero\nadd a2, a2, t1\nhalt' },
  // an address made by the instruction before (forwarding into the row's ALU)
  { name: 'fwd', src: '.data\nd: .word 3, 1, 4, 1, 5, 9, 2, 6\n.text\nli a0, 2\naddi a1, a0, 1\nlwx t0, a1, a0\nlwx t1, t0, a0\nsw t1, 8(zero)\nlw a2, 8(zero)\nhalt' },
  // a loop summing an array through the indexed load
  { name: 'loop', src: '.data\nd: .word 1, 2, 3, 4, 5, 6, 7, 8\n.text\nli a0, 0\nli a1, 8\nli a2, 0\nl: lwx t0, zero, a0\nadd a2, a2, t0\naddi a0, a0, 1\nblt a0, a1, l\nhalt' },
];

/** Every row on a few operand pairs, each result used by the next instruction. */
const rowProgram = (rows: Custom16Row[]): CoreTest => ({
  name: 'rows', src: ['.data', 'd: .word 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16', '.text', 'li a0, 3', 'li a1, 2', 'li a2, 1',
    ...rows.flatMap((r) => [`${r.name} t0, a0, a1`, `${r.name} t1, a1, a0`, `${r.name} ra, a2, a2`, 'add sp, t0, t1']), 'halt'].join('\n'),
});

describe('RV16 custom rows: the cores against the golden model', () => {
  for (const [k, rows] of SETS.entries()) {
    const cores = [
      { what: 'single-cycle', core: () => rv16Core(true, false, '', false, rows), cpi: 1 },
      { what: 'pipelined', core: () => rv16Pipe({ fwd: true, stall: true, flush: true, custom: rows }), cpi: 3 },
    ];
    for (const { what, core, cpi } of cores) {
      it(`${what}, row set ${k}: directed and random programs`, () => {
        const usable = (t: CoreTest) => assemble16(t.src!, rows).errors.length === 0;
        const tests = [...DIRECTED.filter(usable), rowProgram(rows),
          ...Array.from({ length: 24 }, (_, s): CoreTest => ({ name: `random ${s}`, src: randomProgram(100 + s + 31 * k, 3, 40, undefined, rows) }))];
        const r = runCore(core(), 'gate', { tests: () => tests, budget: { cpi, extra: 40 }, custom: rows });
        expect(r.failures).toEqual([]);
        expect(r.tested).toBe(tests.length);
      }, 120_000);
    }
  }

  // the row variants are never built by the registry-wide layout tests: what look inside draws on a { core16 } part
  for (const [what, d] of [
    ['the control unit', () => control16(SETS[2])],
    ['the single-cycle core', () => rv16Core(true, false, '', false, SETS[2])],
    ['the pipeline', () => rv16Pipe({ fwd: true, stall: true, flush: true, custom: SETS[2] })],
  ] as const) {
    it(`${what} with rows draws cleanly`, () => {
      const def = d(), nl = netlistOf(def)!;
      expect(symbolOverlaps(nl)).toEqual([]);
      expect(labelOverlaps(def, nl)).toEqual([]);
      expect(wireOverlaps(routeNetlist(def, nl).nets).length).toBe(0);
    });
  }
});
