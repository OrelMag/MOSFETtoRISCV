// Act 10 (memory in depth): the benches catch what their levels are about. A column with no reference capacitance
// cannot sense; a bank that never refreshes loses a row; a controller that skips refresh or tRCD breaks the chip's
// rules; a bus that re-arbitrates mid-transfer, a DMA that lets go of its request early, a page store that never
// collects all fail; and every message names the rule.

import { describe, expect, it } from 'vitest';
import { senseSeq } from '../src/campaign/buildm';
import { BANK, bankTraces, DCMD, Dram16Model, DRAM16, FCMD, Flash16Model, runBank, runCtrl, runDma, runFlash } from '../src/campaign/memcheck';
import { nodeById } from '../src/campaign/nodes';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { DMA_DEV16, Iss16 } from '../src/riscv/rv16/iss16';
import { checkChallenge, scoreUnit } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { levelChallenge } from '../src/campaign/levels';
import { BANK16, bankOf, BUS16, busOf, CTRL16, ctrlOf, DMA16, dmaOf, DRAM_COL2, FLASH_STORE16, flashOf } from '../src/lib/rv16/mem16';
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

  it('the reference issues each command at the first cycle the chip allows: par is the chip\'s, not one cycle more', () => {
    // A read opening bank 0 row 5, then a row conflict on the same bank: ACT 21, RD 25 (tRCD), data 29 (tCAS);
    // PRE 30 (tRAS = 9 after 21), ACT 34 (tRP), RD 38, data 42: done at the end of 42.
    const A = Dram16Model.addr;
    const trace = { name: 'conflict', lead: 20, reqs: [{ addr: A(0, 5, 3), we: false, wd: 0, gap: 0 }, { addr: A(0, 9, 7), we: false, wd: 0, gap: 0 }] };
    const r = runCtrl(CTRL16, 'gate', [trace]);
    expect(r.failures).toEqual([]);
    expect(r.cycles).toBe(43);
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

describe('m_bus: two masters, one bus', () => {
  it('a grant that moves while a slave is still waiting fails the sequence', () => {
    const c = levelChallenge(nodeById('m_bus')!)!;
    expect(checkChallenge(c, compiled(BUS16, 'gate')).failures).toEqual([]);
    expect(checkChallenge(c, compiled(busOf('nolock'), 'gate')).failures.length).toBeGreaterThan(0);
  });
});

describe('m_dma: a DMA engine', () => {
  it('the reference copies every job on every memory; one that lets go of its request early is named', () => {
    const r = runDma(DMA16, 'gate');
    expect(r.failures).toEqual([]);
    expect(r.cycles).toBe(nodeById('m_dma')!.par!.cycles);
    expect(runDma(dmaOf('nohold'), 'gate').failures.join('\n')).toMatch(/hold the address and data until ready|outside the destination/);
  });
});

describe('m_flash: a page store over flash', () => {
  it('the reference keeps every page readable through its collections; without them the chip refuses a program', () => {
    const r = runFlash(FLASH_STORE16, 'gate');
    expect(r.failures).toEqual([]);
    expect(r.cycles).toBe(nodeById('m_flash')!.par!.cycles);
    expect(runFlash(flashOf('nogc'), 'gate').failures.join('\n')).toMatch(/flash cannot overwrite a page until its block is erased/);
  });

  it('the chip model: a page programs once, a block erases whole, nothing while busy', () => {
    const f = new Flash16Model();
    f.edge(FCMD.PROG, 5, 0x1234, 3, 10);
    f.edge(FCMD.READ, 5, 0, 0, 12);
    expect(f.why).toMatch(/while the chip is busy/);
    const g = new Flash16Model();
    g.edge(FCMD.PROG, 5, 0x1234, 3, 10);
    g.edge(FCMD.READ, 5, 0, 0, 20);
    expect(g.out(21).fbusy).toBe(1);
    expect(g.out(23)).toEqual({ fbusy: 0, fq: 0x1234, fqt: 3 });
    g.edge(FCMD.PROG, 5, 0x0000, 3, 30);
    expect(g.why).toMatch(/PROG page 5 \(block 1\), which holds data/);
    const h = new Flash16Model();
    h.edge(FCMD.PROG, 5, 0x1234, 3, 10);
    h.edge(FCMD.ERASE, 4, 0, 0, 20);
    h.edge(FCMD.PROG, 5, 0x4321, 1, 50);
    expect(h.why).toBe('');
    expect(h.erases).toEqual([0, 1, 0, 0]);
  });
});

describe('p_boot: the golden model with a DMA engine and flash', () => {
  const run = (src: string, mem: Record<number, number>) => {
    const a = assemble16(src);
    const iss = new Iss16(a.words, { system: true, dma: true }, new Map(Object.entries(mem).map(([k, v]) => [Number(k), v])));
    iss.run(2000);
    return iss;
  };
  it('copies a word every DMA_DEV16.WORD cycles and raises the interrupt line after the last', () => {
    const iss = run('li t0, 0x8000\nsw t0, -16(x0)\nli t0, 0x100\nsw t0, -15(x0)\nli t0, 5\nsw t0, -14(x0)\nw: lw t1, -7(x0)\nbeqz t1, w\nhalt\n', { 0x8000: 11, 0x8001: 22, 0x8002: 33, 0x8003: 44, 0x8004: 55 });
    expect([...iss.dmem.slice(0x100, 0x105)]).toEqual([11, 22, 33, 44, 55]);
    expect(iss.irq).toBe(1);
    expect(iss.dma.left).toBe(0);
    // 5 words at 4 cycles each, counted from the store that started it: the wait loop ends within a loop turn of it
    expect(iss.steps).toBeGreaterThanOrEqual(7 + 5 * DMA_DEV16.WORD);
    expect(iss.steps).toBeLessThanOrEqual(7 + 5 * DMA_DEV16.WORD + 3);
  });
  it('a load from flash stalls DMA_DEV16.STALL cycles; a store to flash is an error', () => {
    expect(run('li t0, 0x8000\nlw t1, 0(t0)\nhalt\n', {}).steps).toBe(1 + 1 + DMA_DEV16.STALL + 1); // li (one lui), the load and its stall, halt
    expect(run('li t0, 0x8000\nsw t0, 0(t0)\nhalt\n', {}).error).toMatch(/a store to flash/);
  });
});

describe('act 10 schematics', () => {
  it.each([DRAM_COL2, BANK16, CTRL16, BUS16, DMA16, FLASH_STORE16].map((d) => [d.id, d] as const))('%s: no symbol on another, no label over one, no two nets on a line', (_, d) => {
    const nl = netlistOf(d)!;
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(boxTextOverlaps(d)).toEqual([]);
    expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
  });
});

describe('scoreUnit: what a level is graded in', () => {
  it('a level whose par is in transistors (m_sense, act 0) scores in transistors, not "0 NAND depth 0"', () => {
    expect(scoreUnit(levelChallenge(nodeById('m_sense')!)!)).toBe('transistors');
    expect(scoreUnit(levelChallenge(nodeById('t_inv')!)!)).toBe('transistors');
    expect(scoreUnit(levelChallenge(nodeById('g_not')!)!)).toBe('nand');
    expect(scoreUnit(levelChallenge(nodeById('r_nand')!)!)).toBe('devices');
  });
});
