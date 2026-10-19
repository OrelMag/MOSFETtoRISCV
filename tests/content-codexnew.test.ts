// The numbers codexnew.ts / codexmore2.ts / codexcheck4.ts quote, against the library, the models and the chapters
// that teach them. Each check reads the entry's text, so a change to either side fails here.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECK4 } from '../src/campaign/codexcheck4';
import { moreOf } from '../src/campaign/codexmore';
import { CODEX_NEW } from '../src/campaign/codexnew';
import { NODES } from '../src/campaign/nodes';
import { chapterById } from '../src/chapters';
import { DDR4_3200 } from '../src/dram/timing';
import { carrySelect, carrySkip } from '../src/lib/adders';
import { wayLookup2 } from '../src/lib/cache';
import { sramArray } from '../src/lib/arrays';
import { hammingDecodeRef, hammingDec, hammingEnc, hammingEncodeRef } from '../src/lib/coding';
import { rca } from '../src/lib/combinational';
import { koggeStone } from '../src/lib/fastadd';
import { fpAdd, fpFma, fpMul } from '../src/lib/fpu';
import { MP_DECODE } from '../src/lib/mpdecode';
import { BOOTH_ENC, csa, treeMul } from '../src/lib/muldiv';
import { boothMul } from '../src/lib/multiply';
import { SCAN_OUT } from '../src/lib/raster';
import { DFF, DFFE } from '../src/lib/sequential';
import { SB_CHECK, SCOREBOARD } from '../src/lib/warps';
import { Coherence } from '../src/sim/coherence';
import { F32 } from '../src/sim/fpref';
import { FF_DRIVER, FF_INPUT, FF_WIRE, VDD } from '../src/sim/power';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';

/** 26348 → "26 348", as the entries write numbers. */
const f = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECK4[id] ?? [];
  return [codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' ');
}
const nands = (d: ComponentDef) => stats(d).nands;
const quotes = (id: string, ...ns: number[]) => { for (const n of ns) expect(text(id), `${id}: ${f(n)}`).toContain(f(n)); };
/** The chapter step's prose contains the string (a chapter number the codex repeats). */
const stepSays = (ch: string, step: number, s: string) => expect(String(chapterById(ch)!.steps[step].body), `${ch} ${step}: ${s}`).toContain(s);

describe('the journey\'s codex entries', () => {
  it('are complete and taught by a level', () => {
    for (const e of CODEX_NEW) {
      expect(moreOf(e.id)?.chapters?.length, `${e.id}: chapters`).toBeGreaterThan(0);
      expect(CHECK4[e.id]?.length, `${e.id}: questions`).toBe(2);
      for (const q of CHECK4[e.id]) expect(q.answer, `${e.id}: answer first`).toBe(0);
      expect(NODES.some((n) => n.codex.includes(e.id)), `${e.id}: level`).toBe(true);
    }
  });

  it('quote the adders as measured', () => {
    const cs = carrySelect(32, 4), sk = carrySkip(32, 4), r = rca(32), ks = koggeStone(32);
    quotes('carryselect', nands(cs), logicDepth(cs)!, nands(sk), logicDepth(sk)!, nands(r), logicDepth(r)!, nands(ks), logicDepth(ks)!);
    quotes('carryselect', nands(carrySelect(8)), logicDepth(carrySelect(8))!, nands(koggeStone(8)));
    expect([logicDepth(carrySelect(8)), logicDepth(koggeStone(8))]).toEqual([14, 14]);
    stepSays('fastadd', 4, 'about 31 NAND delays');
    quotes('carrysave', nands(csa(8)), logicDepth(csa(8))!, logicDepth(rca(8))!);
    expect(nands(csa(8))).toBe(nands(rca(8)));
    expect(nands(csa(32))).toBe(9 * 32);
  });

  it('quote the multipliers and the FMA as measured', () => {
    const b8 = boothMul(8), t8 = treeMul(8, true), b32 = boothMul(32), t32 = treeMul(32, true);
    quotes('booth', nands(b8), logicDepth(b8)!, nands(t8), logicDepth(t8)!, nands(b32), logicDepth(b32)!, nands(t32), logicDepth(t32)!);
    expect(nands(BOOTH_ENC)).toBe(14);
    expect(text('booth')).toContain('14 NANDs');
    const fma = fpFma(F32);
    quotes('fma', nands(fma), logicDepth(fma)!, logicDepth(fpMul(F32))! + logicDepth(fpAdd(F32))!);
    expect(text('fma')).toContain(`${logicDepth(fpMul(F32))} + ${logicDepth(fpAdd(F32))}`);
    stepSays('float', 11, 'multiply (92 deep)'); stepSays('float', 16, 'from 274 to 368');
  });

  it('quote ECC, SRAM, flip-flops and decoders as measured', () => {
    quotes('ecc', nands(hammingEnc(8)), logicDepth(hammingEnc(8))!, nands(hammingDec(8)), logicDepth(hammingDec(8))!, nands(hammingEnc(64)));
    const c = hammingEncodeRef(1, 8);
    expect(c).toBe(0b1111);
    expect(hammingDecodeRef(c ^ (1 << 6), 8)).toMatchObject({ d: 1, syndrome: 6, single: 1, double: 0 });
    expect(hammingDecodeRef(c ^ (1 << 6) ^ (1 << 9), 8)).toMatchObject({ syndrome: 15, single: 0, double: 1 });
    const a4 = stats(sramArray(4, 4)).transistors, a8 = stats(sramArray(8, 8)).transistors;
    quotes('sram', a4, a8, 16 * 6, 64 * 6, stats(DFFE).transistors, nands(DFFE));
    expect(Math.round((100 * 64 * 6) / a8)).toBe(43);
    expect(Math.round((100 * 16 * 6) / a4)).toBe(30);
    expect(nands(DFF)).toBe(11);
    quotes('metastability', 2 * nands(DFF), nands(DFF));
    quotes('atomics', nands(MP_DECODE));
    const w = wayLookup2(3, 8);
    quotes('assoc', nands(w), logicDepth(w)!);
  });

  it('quote the warp core and the screen as measured', () => {
    quotes('scoreboard', nands(SCOREBOARD), nands(SB_CHECK));
    quotes('doublebuffer', nands(SCAN_OUT));
    stepSays('warps', 4, '110 715'); stepSays('warps', 4, '92 564'); stepSays('warps', 4, '65 536');
    quotes('occupancy', 110715, 92564, 65536);
    stepSays('warps', 0, '266 cycles'); stepSays('warps', 3, '192 cycles'); stepSays('warps', 3, '172 cycles');
    stepSays('pixels', 3, '12 032'); stepSays('pixels', 3, '76 more cycles');
    quotes('zbuffer', 12032);
    stepSays('graphics', 1, '6 144');
  });

  it('agree with the coherence model', () => {
    const run = (p: 'MSI' | 'MESI', ops: [number, number, boolean][]) => { const c = new Coherence(2, p); for (const [k, b, wr] of ops) c.access(k, b, wr); return c.stats; };
    const priv: [number, number, boolean][] = [[0, 0, false], [0, 0, true], [1, 1, false], [1, 1, true], [0, 2, false], [0, 2, true]];
    const fs: [number, number, boolean][] = [0, 1, 0, 1, 0, 1].map((k) => [k, 0, true]);
    const pad: [number, number, boolean][] = [0, 1, 0, 1, 0, 1].map((k) => [k, k, true]);
    expect([run('MSI', priv).bus, run('MESI', priv).bus]).toEqual([6, 3]);
    expect(run('MESI', fs)).toMatchObject({ bus: 6, invalidations: 5, writebacks: 5 });
    expect(run('MESI', pad).bus).toBe(2);
    expect(text('coherence')).toContain('6 transactions, 5 invalidations, 5 write-backs');
  });

  it('get the arithmetic right', () => {
    const amdahl = (p: number, n: number) => 1 / ((1 - p) + p / n);
    expect(amdahl(0.9, 8).toFixed(1)).toBe('4.7');
    expect(amdahl(0.95, 8).toFixed(1)).toBe('5.9');
    expect(amdahl(0.9, 64).toFixed(1)).toBe('8.8');
    expect((4 + 0.05 * (12 + 0.2 * 250)).toFixed(1)).toBe('7.1');
    expect(((188 + 4 * 8) / 188).toFixed(2)).toBe('1.17');
    expect(((188 + 32 * 8) / 188).toFixed(2)).toBe('2.36');
    // power: a NAND output on two NAND inputs
    const C = FF_DRIVER + 2 * (FF_INPUT + FF_WIRE);
    expect(C).toBeCloseTo(2.1, 9);
    expect(VDD).toBe(0.9);
    expect((0.5 * C * VDD * VDD).toFixed(2)).toBe('0.85');
    // row hammer: activations of one row per 64 ms window at DDR4-3200's tRC
    const tRC = DDR4_3200.tRAS + DDR4_3200.tRP;
    expect(tRC).toBe(45.75);
    expect((64e6 / tRC / 1e6).toFixed(1)).toBe('1.4');
    stepSays('dram', 3, '139 000');
    // metastability: the illustrative MTBFs
    expect(Math.exp(5) / 2e5 * 1e3).toBeCloseTo(0.74, 2);
    expect(Math.round(Math.exp(47.5) / 2e5 / 3.156e7 / 1e6)).toBe(67);
  });
});
