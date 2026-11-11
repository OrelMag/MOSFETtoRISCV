// The side-channels chapter's quoted numbers, recomputed: the golden model for the password check, the out-of-order
// model in spec mode for the cache and Spectre steps, and the gate-level out-of-order core for the transient secret.

import { describe, expect, it } from 'vitest';
import '../src/lib/index';
import { chSidechan } from '../src/chapters/ch-sidechan';
import { oooCpu } from '../src/lib/ooocore';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { clockCycle } from '../src/riscv/cosim';
import { OooModel } from '../src/riscv/ooomodel';
import { oooSnap } from '../src/riscv/ooosnap';
import {
  callsSource, GATE_SECRET, GATE_SOURCE, LEN, NOTHING, probeSource, pwRun, PW_LETTERS, PASSWORD, sideConfig, SIDE_CACHE, SIDE_MISS, SIDE_OPTS, SIDE_SPEC,
  spectreWords, STREAM_SOURCE, timesIn, MAP,
} from '../src/riscv/sideprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { groupDigits } from '../src/sim/numfmt';
import { LAT } from '../src/riscv/ilp';
import type { ISS } from '../src/riscv/iss';

const text = [...chSidechan.steps.map((s) => s.body), ...chSidechan.recap!.keep].join(' ').replace(/[ \t\r\n]+/g, ' ');
const quoted = (v: string) => expect(text, v).toContain(v);
const dmemOf = (m: OooModel) => (m as unknown as { iss: ISS }).iss.dmem;
const run = (words: number[], cfg: ConstructorParameters<typeof OooModel>[1]) => { const m = new OooModel(words, cfg, SIDE_OPTS); m.historyMax = 1e9; m.run(2_000_000); return m; };

describe('side channels: the numbers it quotes', () => {
  it('step 1: the password check', () => {
    const wrong = pwRun('-').cycles, one = pwRun(PASSWORD[0]).cycles, two = pwRun(PASSWORD.slice(0, 2)).cycles;
    const right = pwRun(PASSWORD), ct = [...PW_LETTERS].map((c) => pwRun(c + PASSWORD.slice(1), true).cycles);
    expect(right.ok).toBe(true);
    expect(new Set(ct).size).toBe(1); // constant time: every guess the same
    quoted(`takes ${wrong} cycles in the check`);
    quoted(`${one - wrong} cycles more`);
    quoted(`The right password takes ${right.cycles}`);
    quoted(`That check takes ${ct[0]} cycles for every guess`);
    quoted(`${PW_LETTERS.length * 4} in all`);
    quoted(groupDigits(PW_LETTERS.length ** 4));
    expect((chSidechan.steps[0].challenge as { options: string[] }).options[0]).toBe(String(two));
  });

  it('step 2: the cache and evict + reload', () => {
    const t = timesIn(dmemOf(run(assemble(probeSource(9)).words, { spec: SIDE_SPEC })));
    const hit = Math.min(...t), miss = Math.max(...t);
    expect(t.indexOf(hit)).toBe(9);
    expect(t.filter((v) => v === hit)).toHaveLength(1);
    quoted(`${SIDE_CACHE.size / SIDE_CACHE.line} lines of ${SIDE_CACHE.line} bytes`);
    quoted(`a load that hits takes ${LAT.load} cycles, one that misses ${SIDE_MISS}`);
    quoted(`One reload comes back in ${hit} cycles, the other fifteen in ${miss}`);
    quoted(`one comes back in ${hit} cycles, the rest in ${miss}`);
  });

  it('steps 4 and 5: the attack\'s window', () => {
    const m = run(spectreWords([0xa]), sideConfig('none'));
    const check = [...m.history].reverse().find((u) => u.text.startsWith('bgeu') && u.state === 'committed' && u.next !== u.pc + 4)!;
    const probe = m.history.find((u) => u.wrong && u.seq > check.seq && u.cls === 'load' && u.addr! >= MAP.probe && u.addr! < MAP.probe + 256)!;
    expect(probe.miss).toBe(true);
    quoted(`the check waits ${SIDE_MISS} cycles for memory`);
    quoted(`the second load starts ${probe.s - check.f} cycles after the branch was fetched`);
    quoted(`flushes ${check.c - check.f} cycles after it was fetched`);
    quoted(`a 2-wide, ${new OooModel([], {}).cfg.rob}-entry reorder buffer`);
  });

  it('step 6: a round', () => {
    const c = (n: number) => run(spectreWords(Array.from({ length: n }, (_, i) => (i * 5 + 1) & 15)), sideConfig('none')).stats.cycles;
    quoted(`about ${Math.round((c(6) - c(1)) / 5 / 50) * 50} cycles here`);
  });

  it('step 7: without training only the first nibble leaks', () => {
    const secret = [0x3, 0xa, 0x5, 0xc], m = run(spectreWords(secret, 'none', false), sideConfig('none'));
    const out = secret.map((_, k) => (dmemOf(m)[(MAP.out + k) >> 2] >>> (8 * ((MAP.out + k) & 3))) & 255);
    expect(out).toEqual([secret[0], NOTHING, NOTHING, NOTHING]);
  });

  it('steps 8–10: cycles a call, and fill-at-commit\'s cost', () => {
    const per = (g: 'none' | 'fence' | 'mask' | 'fill') => {
      const c = (n: number) => run(assemble(callsSource(g === 'fill' ? 'none' : g, n)).words, sideConfig(g)).stats.cycles;
      return (c(48) - c(16)) / 32;
    };
    const none = per('none');
    expect(per('fill')).toBe(none);
    quoted(`the victim took ${none} cycles a call; with the fence it takes ${per('fence')}`);
    quoted(`${per('mask')} cycles a call against ${none}`);
    quoted(`The victim's cycles a call do not move: ${none}`);
    const opts = { dmemWords: 1 << 12, imemWords: 1 << 12 };
    const cyc = (src: string, fillAtCommit: boolean) => new OooModel(assemble(src).words, { spec: { ...SIDE_SPEC, fillAtCommit } }, opts).run().cycles;
    for (const b of BENCHMARKS.filter((q) => !q.needs?.f)) expect(cyc(b.source, true), b.id).toBe(cyc(b.source, false));
    quoted(`takes ${cyc(STREAM_SOURCE, true)} cycles against ${cyc(STREAM_SOURCE, false)}`);
    expect(cyc(STREAM_SOURCE, true)).toBeGreaterThan(cyc(STREAM_SOURCE, false));
  });

  it('the memory map keeps its sets apart', () => {
    const set = (a: number) => Math.floor(a / SIDE_CACHE.line) % (SIDE_CACHE.size / SIDE_CACHE.line);
    const probe = Array.from({ length: 16 }, (_, i) => set(MAP.probe + 16 * i));
    const others = [set(MAP.array1), set(MAP.secret), set(MAP.len), set(MAP.out), ...Array.from({ length: 4 }, (_, i) => set(MAP.times + 16 * i))];
    expect(new Set([...probe, ...others]).size).toBe(probe.length + others.length);
    expect(LEN).toBe(16);
  });
});

describe('side channels: step 3 on the gates', () => {
  it('the wrong-path load holds the secret in the reorder buffer, then the flush removes it', () => {
    const a = assemble(GATE_SOURCE), lwPc = a.words.findIndex((w, i) => i > 4 && (w & 0x7f) === 0x03) * 4;
    const design = flatten(oooCpu(a.words, { imemK: 6, dmemK: 6 }));
    const sim = new GateSim(design);
    sim.reset('zero');
    sim.settle();
    let held = 0, after = false;
    for (let c = 0; c < 60; c++) {
      clockCycle(sim);
      const has = oooSnap(sim, design.root).rob.some((r) => r.pc === lwPc && r.done && r.value === GATE_SECRET);
      if (has) { held++; expect(after, 'held once, in one stretch').toBe(false); }
      else if (held) after = true;
    }
    expect(after).toBe(true);
    quoted(`the wrong-path <code>lw</code> holds 0x${GATE_SECRET.toString(16).toUpperCase()} for ${held} cycles`);
    quoted(`0x${(GATE_SECRET * 2).toString(16).toUpperCase()}`);
    quoted(`a divide, ${LAT.div} cycles`);
  }, 120_000);
});

describe('side channels: the codex quotes the same numbers', () => {
  it('every number in the entries, their fuller texts and questions is the chapter\'s', async () => {
    const { CODEX_SIDE } = await import('../src/campaign/codexside');
    const { MORESIDE } = await import('../src/campaign/codexmoreside');
    const { CHECKSIDE } = await import('../src/campaign/codexcheckside');
    const all = JSON.stringify([CODEX_SIDE, MORESIDE, CHECKSIDE]).replace(/\u202f|\u202f/g, ' ');
    const has = (s: string) => expect(all, s).toContain(s);
    const wrong = pwRun('-').cycles, step = pwRun(PASSWORD[0]).cycles - wrong;
    has(`takes ${wrong} cycles for a wrong first letter and ${step} more`);
    has(`takes ${pwRun('aaaa', true).cycles} cycles for every guess, against ${wrong} to ${pwRun(PASSWORD).cycles}`);
    const t = timesIn(dmemOf(run(assemble(probeSource(9)).words, { spec: SIDE_SPEC })));
    has(`comes back in ${Math.min(...t)} cycles, the others in ${Math.max(...t)} (a hit against a miss of ${SIDE_MISS}`);
    has(`one in ${Math.min(...t)} cycles, fifteen in ${Math.max(...t)}`);
    const per = (g: 'none' | 'fence' | 'mask') => { const c = (n: number) => run(assemble(callsSource(g, n)).words, sideConfig(g)).stats.cycles; return (c(48) - c(16)) / 32; };
    has(`${per('fence')} cycles a call against ${per('none')} without it`);
    has(`(${per('mask')} cycles a call)`);
    has(`for 16 cycles`);
    expect(all).toContain(`a 20-cycle miss`);
  });
});

describe('side channels: the widget\'s probe-line card', () => {
  it('names a wrong-path probe load only when it issued (the mask leaves one fetched, never issued)', async () => {
    const { attack } = await import('../src/widgets/sidechan');
    const probes = (g: 'none' | 'mask') => attack([0xa], g).window.filter((u) => u.wrong && u.cls === 'load' && u.addr !== undefined && u.addr >= MAP.probe && u.addr < MAP.probe + 256);
    expect(probes('none').some((u) => u.s >= 0)).toBe(true);
    expect(probes('mask').length).toBeGreaterThan(0);
    expect(probes('mask').every((u) => u.s < 0)).toBe(true);
  });
});
