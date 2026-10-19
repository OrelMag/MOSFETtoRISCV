// The dual-issue in-order pipeline (Phase 17b, lib/pipe2w.ts) and its parts: the 4-read 2-write register file,
// and the CPU in lock-step with the golden model (two instructions may retire a cycle, oldest first).

import { describe, expect, it } from 'vitest';
import { regfile2w, writeSelect } from '../src/lib/regfile';
import { simulate } from '../src/sim/harness';
import { checkSpec, lcg, out, set, tick } from './util';

describe('register file, 4 read and 2 write ports', () => {
  it('write select: either port enables, port 1 wins', () => checkSpec(writeSelect(4)));

  it('two writes a cycle (port 1 wins one register both write), four reads, x0 = 0', () => {
    const s = simulate(regfile2w(3, 8)), r = lcg(7), regs = Array(8).fill(0);
    set(s, { clk: 0, we0: 1, we1: 0, wa0: 0, wa1: 0, wd0: 0, wd1: 0 });
    for (let a = 1; a < 8; a++) { set(s, { wa0: a }); tick(s); }
    for (let t = 0; t < 120; t++) {
      const v = { we0: r(2), we1: r(2), wa0: r(8), wa1: t % 5 === 0 ? -1 : r(8), wd0: r(256), wd1: r(256), ra1: r(8), ra2: r(8), ra3: r(8), ra4: r(8) };
      if (v.wa1 < 0) v.wa1 = v.wa0; // both ports on one register now and then
      set(s, v);
      for (let p = 1; p <= 4; p++) expect(out(s, `rd${p}`), `t ${t} rd${p}`).toBe(regs[v[`ra${p}` as 'ra1']]);
      tick(s);
      if (v.we0 && v.wa0) regs[v.wa0] = v.wd0;
      if (v.we1 && v.wa1) regs[v.wa1] = v.wd1;
    }
  });
});
