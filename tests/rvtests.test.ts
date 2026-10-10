// The official riscv-tests (prebuilt images, tests/verify/riscv-tests) on the golden model, and the bench
// itself: the loader, the verdicts, and the bit-parallel runs agreeing with the event-driven simulator.
// The CPUs run them in rvtests-*.test.ts.

import { describe, expect, it } from 'vitest';
import { ISS } from '../src/riscv/iss';
import { CPUS, notApplicable, type Isa } from './verify/cpus';
import { image, imageFile, images, jalTarget, loadable, verdict, type Env } from './verify/images';
import { cpuJobs, runLanes, runOnCpu, runOnIss } from './verify/run';

/** The golden model's ISA in each environment: everything it implements. */
const GOLDEN: Record<Env, Isa> = {
  bare: { sub: true, m: true, f: true },
  'bare-mp': { sub: true, mp: true },
  p: { sub: true, m: true, system: true },
};

describe('riscv-tests images', () => {
  it('record their source revision and toolchain', () => {
    for (const env of ['p', 'bare', 'bare-mp'] as const) {
      const f = imageFile(env);
      expect(f.revision['riscv-tests']).toMatch(/^[0-9a-f]{40}$/);
      expect(f.toolchain).toMatch(/gcc/);
      expect(Object.keys(f.tests).length).toBeGreaterThan(50);
    }
  });

  it('load their data through code appended to the image', () => {
    const img = image('bare', 'rv32ui-lw');
    const l = loadable(img);
    expect(jalTarget(l.words[0], 0)).toBe(4 * img.text.length);
    const iss = new ISS(l.words, { dmemWords: 2 ** l.dmemK, imemWords: 2 ** l.imemK });
    while (iss.pc !== jalTarget(img.text[0], 0)) iss.step();
    expect([...iss.dmem.slice(0, img.data.length)]).toEqual(img.data);
    expect([...iss.x]).toEqual(new Array(32).fill(0));
  });

  it('report pass, failing test numbers and traps', () => {
    expect(verdict(1, 'bare')).toEqual({ pass: true, text: 'pass' });
    expect(verdict((7 << 1) | 1, 'bare').text).toBe('fails test 7');
    expect(verdict(1337 | 4, 'p').text).toMatch(/unexpected trap/);
    expect(verdict(0, 'p').pass).toBe(false);
  });
});

describe('official riscv-tests on the golden model', () => {
  for (const env of ['bare', 'bare-mp', 'p'] as const) {
    it(`env ${env}: every implemented test passes`, () => {
      const failed: string[] = [];
      let n = 0;
      for (const img of images(env)) {
        if (notApplicable({ isa: GOLDEN[env] }, img.name)) continue;
        const r = runOnIss(img, loadable(img), { system: !!GOLDEN[env].system, m: !!GOLDEN[env].m, f: !!GOLDEN[env].f });
        n++;
        if (!r.pass) failed.push(`${img.name}: ${r.text}`);
      }
      expect(failed).toEqual([]);
      expect(n).toBeGreaterThan(40);
    });
  }

  it('a broken golden model fails them (the tests are not vacuous)', () => {
    // sub executed as add: rv32ui-sub must fail, and say which test
    const img = image('bare', 'rv32ui-sub'), l = loadable(img);
    const words = l.words.map((w) => ((w & 0xfe00707f) === 0x40000033 ? w & ~0x40000000 : w));
    expect(runOnIss(img, { ...l, words }, {}).text).toMatch(/^fails test \d+$/);
  });
});

describe('bit-parallel runs agree with the event-driven simulator', () => {
  for (const [id, name] of [['sc', 'rv32ui-sw'], ['pipe-m', 'rv32um-div'], ['sys', 'rv32mi-scall']] as const) {
    it(`${id}: ${name}`, () => {
      const cfg = CPUS.find((c) => c.id === id)!;
      const batch = cpuJobs(cfg, [image(cfg.env, name)])[0];
      const lanes = runLanes(cfg, batch.jobs, batch.imemK, batch.dmemK)[0];
      const j = batch.jobs[0];
      const gate = runOnCpu(cfg, j.img, { ...j.l, imemK: batch.imemK }, j.max);
      expect(lanes.pass).toBe(true);
      expect(gate.pass).toBe(true);
      expect(gate.count).toBe(lanes.count); // both look at tohost every 8 cycles
    }, 120_000);
  }
});
