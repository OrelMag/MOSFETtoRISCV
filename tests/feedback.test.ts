import { describe, expect, it } from 'vitest';
import '../src/lib';
import { DRAM_CELL, SRAM_CELL, SRAM_COLUMN } from '../src/lib/cells';
import { DFF, SR_LATCH } from '../src/lib/sequential';
import { MUX2, XOR } from '../src/lib/gates';
import { INV_CMOS, NAND, NMOS_SWITCH, NOR_CMOS, PMOS_SWITCH } from '../src/lib/transistors';
import { hasFeedback } from '../src/sim/stats';

// The inspector refuses a truth table when hasFeedback() is true, so a false positive hides the
// table of a plain combinational cell (the CMOS inverter used to be reported as having feedback).
describe('hasFeedback', () => {
  it('switch-level combinational cells have none', () => {
    for (const d of [INV_CMOS, NOR_CMOS, NAND, NMOS_SWITCH, PMOS_SWITCH]) expect(hasFeedback(d), d.id).toBe(false);
  });
  it('switch-level storage is detected (cross-coupled inverters, capacitor)', () => {
    for (const d of [SRAM_CELL, SRAM_COLUMN, DRAM_CELL]) expect(hasFeedback(d), d.id).toBe(true);
  });
  it('gate level follows logicDepth', () => {
    for (const d of [XOR, MUX2]) expect(hasFeedback(d), d.id).toBe(false);
    for (const d of [SR_LATCH, DFF]) expect(hasFeedback(d), d.id).toBe(true);
  });
});
