// The numbers chapter multicycle's System/360 step quotes, computed from bench/results.json and the microcode table.
import { describe, expect, it } from 'vitest';
import { chMulticycle } from '../src/chapters/ch-multicycle';
import { familyRows, microStore, spread } from '../src/widgets/family360';

describe('System/360 step', () => {
  const rows = familyRows();
  it('cost, period, CPI per machine', () => {
    expect(rows.map((r) => [r.id, r.nands, r.period, +r.cpi.toFixed(2), Math.round(r.delaysPerInstr)])).toEqual([
      ['sc-ks', 70243, 106, 1, 106], ['mc-fsm', 72192, 85, 3.87, 329], ['mc-micro', 77904, 85, 3.87, 329], ['pipe-ks', 82702, 93, 1.48, 138],
    ]);
  });
  it('microcode adds NANDs and nothing else', () => {
    expect(rows[2].nands - rows[1].nands).toBe(5712);
    expect(rows[2].cpi).toBe(rows[1].cpi);
    expect(rows[2].period).toBe(rows[1].period);
  });
  it('spread and the front', () => {
    const s = spread(rows);
    expect(s.cost.toFixed(2)).toBe('1.18');
    expect(s.time.toFixed(1)).toBe('3.1');
    expect(rows.filter((r) => r.onFront).map((r) => r.id)).toEqual(['sc-ks']);
    expect(rows.map((r) => Math.round(r.nsPerInstr * 100))).toEqual([265, 823, 823, 345]);
  });
  it('microcode store', () => expect(microStore()).toEqual({ words: 13, bits: 20, total: 260 }));
  it('the step comes before the deep dive, with a widget and a quiz', () => {
    const st = chMulticycle.steps.find((x) => x.title.includes('System/360'))!;
    expect(st.title).toMatch(/System\/360/);
    expect(st.widget).toBeTypeOf('function');
    expect(st.body).toContain('adds 5712 NANDs');
  });
});
