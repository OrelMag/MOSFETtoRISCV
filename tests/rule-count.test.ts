import { describe, expect, it } from 'vitest';
import { ruleFor, unlockedPartCount } from '../src/campaign/graph';

describe('"NAND + n unlocked parts"', () => {
  it('counts what the palette lists, wildcards expanded (not one per `prefix*` entry)', () => {
    for (const [id, n] of [['c_ctl', 16], ['a_alu16', 26], ['c_core1', 43], ['c_core3', 49], ['pi_core1', 56]] as const) {
      const r = ruleFor(id);
      expect(unlockedPartCount(r), id).toBe(n);
      expect(r.label, id).toBe(`NAND + ${n} unlocked parts`);
    }
  });
});
