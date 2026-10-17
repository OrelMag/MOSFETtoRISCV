// Act 10 (memory in depth): the benches catch what their levels are about. A column with no reference capacitance
// cannot sense; a bank that never refreshes loses a row; a controller that skips refresh or tRCD breaks the chip's
// rules; and every message names the rule.

import { describe, expect, it } from 'vitest';
import { senseSeq } from '../src/campaign/buildm';
import { BANK, bankTraces, DCMD, Dram16Model, DRAM16, runBank, runCtrl } from '../src/campaign/memcheck';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { levelChallenge } from '../src/campaign/levels';
import { BANK16, bankOf, CTRL16, ctrlOf, DRAM_COL2 } from '../src/lib/rv16/mem16';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { boxTextOverlaps } from '../src/view/boxtext';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const compiled = (def: ComponentDef, mode: 'gate' | 'switch'): Compiled =>
  ({ def, diags: [], mode, netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;

describe('m_sense: a DRAM column', () => {
  it('reads both cells twice after writing them: the read restores what it destroys', () => {
    const r = checkChallenge(levelChallenge(nodeById('m_sense')!)!, compiled(DRAM_COL2, 'switch'));
    expect(r.failures).toEqual([]);
    expect(senseSeq().filter((s) => 'q' in s.expect).length).toBeGreaterThan(20);
  });

  it('a reference line without capacitance has no level to compare with: the reads fail', () => {
    const nl = DRAM_COL2.netlist!();
    const bad: ComponentDef = {
      ...DRAM_COL2, id: 't_col_nocap',
      netlist: () => ({ ...nl, instances: nl.instances.filter((i) => i.name !== 'cr'), nets: nl.nets.map((n) => ({ ...n, ends: n.ends.filter((e) => e !== 'cr.a') })) }),
    };
    const r = checkChallenge(levelChallenge(nodeById('m_sense')!)!, compiled(bad, 'switch'));
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/q/);
  });
});

describe('m_bank: a bank with refresh', () => {
  it('the reference passes every trace with every row opened in time', () => {
    const r = runBank(BANK16, 'gate');
    expect(r.failures).toEqual([]);
    expect(r.cycles).toBe(nodeById('m_bank')!.par!.cycles);
  });

  it('a bank that never refreshes loses a row, and the bench says which and since when', () => {
    const r = runBank(bankOf('norefresh'), 'gate');
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.join('\n')).toMatch(new RegExp(`row \\d+ was last opened at cycle \\d+: its cells leaked away \\(each row must be opened at least every ${BANK.RET} cycles\\)`));
  });

  it('the long-pause trace alone outlasts the retention time', () => {
    const t = bankTraces().find((x) => x.name === 'long pauses')!;
    expect(t.lead!).toBeGreaterThan(BANK.RET);
  });
});

describe('m_ctrl: a row-buffer controller', () => {
  it('the reference keeps every rule of the chip', () => {
    const r = runCtrl(CTRL16, 'gate');
    expect(r.failures).toEqual([]);
    expect(r.cycles).toBe(nodeById('m_ctrl')!.par!.cycles);
  });

  it('without refresh the chip forgets', () => {
    expect(runCtrl(ctrlOf('norefresh'), 'gate').failures.join('\n')).toMatch(new RegExp(`no REF for \\d+ cycles: the chip needs one at least every ${DRAM16.tREFI} cycles`));
  });

  it('a read straight after ACT breaks tRCD', () => {
    expect(runCtrl(ctrlOf('notrcd'), 'gate').failures.join('\n')).toMatch(/(RD|WR) bank \d \d cycles after its ACT \(tRCD = 4/);
  });

  it('the chip model: data tCAS after RD, rules named', () => {
    const d = new Dram16Model(1);
    const a = Dram16Model.addr(1, 5, 3);
    d.edge(DCMD.ACT, 1, 5, 0, 0, 10);
    d.edge(DCMD.RD, 1, 0, 3, 0, 14);
    expect(d.dq(18)).toEqual({ v: d.mem[a], addr: a });
    expect(d.dq(17).addr).toBe(-1);
    expect(d.why).toBe('');
    d.edge(DCMD.PRE, 1, 0, 0, 0, 16);
    expect(d.why).toBe('cycle 16: PRE closes bank 1 6 cycles after its ACT (tRAS = 9: the row is still being restored)');
  });
});

describe('act 10 schematics', () => {
  it.each([DRAM_COL2, BANK16, CTRL16].map((d) => [d.id, d] as const))('%s: no symbol on another, no label over one, no two nets on a line', (_, d) => {
    const nl = netlistOf(d)!;
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(boxTextOverlaps(d)).toEqual([]);
    expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
  });
});
