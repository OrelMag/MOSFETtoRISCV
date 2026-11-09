import { it, expect } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { lockstep } from './verify/vmlock';
it('smoke', async () => {
  const a = assemble('addi x1, x0, 5\naddi x2, x1, 7\nsw x2, 8(x0)\nlw x3, 8(x0)\ncsrr x4, misa\ncsrr x5, mstatus\necall\nj .');
  expect(a.errors).toEqual([]);
  const t0 = Date.now();
  const r = await lockstep(a.words, { imemK: 6, dmemK: 12, maxCycles: 40 });
  console.log('RES', r.ok, r.why, r.cycles, r.steps, Date.now() - t0);
  expect(r.ok).toBe(true);
}, 120000);
