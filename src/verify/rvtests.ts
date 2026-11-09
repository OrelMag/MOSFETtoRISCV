// The official riscv-tests in the browser (DOM-free; the chapter "How do you know it works?"): every rv32ui test a
// word-only RV32I CPU with a ROM can run, on any such CPU (healthy or with a planted fault), up to 32 at once on BitSim
// lanes, each test's verdict read from tohost. The images, the loader and the lanes are the microcode painter's
// (lib/ucodecheck.ts, riscv/rvimage.ts); CI runs the same images on every CPU (tests/verify-*.test.ts).

import { ISS } from '../riscv/iss';
import { loadable, verdict, type RvImage } from '../riscv/rvimage';
import { LANES } from '../sim/bitsim';
import type { ComponentDef } from '../sim/types';
import { runLanes, rv32uiImages, slicer, type Job } from '../lib/ucodecheck';

export { rv32uiImages };

export interface RvTestResult {
  /** e.g. "add" (rv32ui-add). */
  name: string;
  pass: boolean;
  /** "pass", "fails test 7", "no result" … */
  text: string;
  /** The failing case's number (the test's TEST_CASE n), when it names one. */
  failCase?: number;
  cycles: number;
  instructions: number;
}

/** Cycles per instruction a CPU may take before a test counts as hung. */
const MAX_CPI = 6;

/** Every word-access rv32ui test on `build`'s CPU, in batches of 32 sharing an instruction-memory size. */
export async function runRv32ui(build: (words: number[], imemK: number, dmemK: number) => ComponentDef,
  opts: { onProgress?: (done: number, total: number) => void; signal?: { aborted: boolean }; only?: string[] } = {}): Promise<RvTestResult[]> {
  const tick = slicer(opts.signal);
  const imgs = (await rv32uiImages()).filter((i) => !opts.only || opts.only.includes(i.name.slice(7)));
  const jobs: { img: RvImage; job: Job; imemK: number; dmemK: number }[] = [];
  for (const img of imgs) {
    await tick();
    const l = loadable(img, 6, 5);
    const iss = new ISS(l.words, { dmemWords: 2 ** l.dmemK, imemWords: 2 ** l.imemK });
    while (!iss.halted && iss.steps < 100_000) {
      iss.step();
      if (iss.dmem[l.tohost]) break;
    }
    jobs.push({ img, imemK: l.imemK, dmemK: l.dmemK, job: { name: img.name, label: img.name.slice(7), words: l.words, golden: { instructions: iss.steps, x: [...iss.x], dmem: [...iss.dmem] }, max: Math.ceil(iss.steps * MAX_CPI * 1.25) + 100, tohost: l.tohost } });
  }
  const out: RvTestResult[] = [];
  const groups = new Map<number, typeof jobs>();
  for (const j of jobs) groups.set(j.dmemK, [...(groups.get(j.dmemK) ?? []), j]);
  for (const [dmemK, all] of groups) {
    for (let at = 0; at < all.length; at += LANES) {
      const batch = all.slice(at, at + LANES), imemK = Math.max(...batch.map((j) => j.imemK));
      const r = await runLanes(build(batch[0].job.words, imemK, dmemK), batch.map((b) => b.job), imemK, tick);
      batch.forEach((b, l) => {
        const v = verdict(r.verdicts[l], 'bare'), t = r.verdicts[l];
        out.push({ name: b.job.label, pass: v.pass, text: v.text, ...(!v.pass && t && t & 1 && t < 4096 ? { failCase: t >>> 1 } : {}), cycles: r.cycles[l], instructions: b.job.golden.instructions });
      });
      opts.onProgress?.(out.length, jobs.length);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
