import { describe, expect, it } from 'vitest';
import { Cmd, CtrlModel, DeviceModel, type DramConfig, idle, splitLine, transfer } from '../src/dram/controller';
import { accessCycles, TIMING } from '../src/dram/timing';
import { dramCtrl } from '../src/lib/dramctrl';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8);

const CONFIGS: DramConfig[] = [
  { k: 6, banks: 2, rowWords: 16, policy: 'open' },
  { k: 6, banks: 2, rowWords: 16, policy: 'closed' },
  { k: 12, banks: 4, rowWords: 32, policy: 'open', hash: true },
  { k: 12, banks: 1, rowWords: 16, policy: 'closed' },
];

describe('DRAM controller and device models', () => {
  it('a row hit, miss and conflict take the cycles the row-buffer model says', () => {
    const c: DramConfig = { k: 8, banks: 2, rowWords: 16, policy: 'open' };
    const ctrl = new CtrlModel(c), dev = new DeviceModel(c);
    // line 0 is bank 0 row 0; line 8 is bank 0 row 1 (4 lines a row, 2 banks)
    expect(splitLine(c, 8)).toEqual({ col: 0, bank: 0, row: 1 });
    expect(transfer(ctrl, dev, false, 0).cycles).toBe(accessCycles('miss', TIMING));
    expect(transfer(ctrl, dev, false, 1).cycles).toBe(accessCycles('hit', TIMING));
    expect(transfer(ctrl, dev, false, 8).cycles).toBe(accessCycles('conflict', TIMING));
    expect([ctrl.stats.hits, ctrl.stats.misses, ctrl.stats.conflicts]).toEqual([1, 1, 1]);
    expect(dev.err).toBe(false);
  });

  it.each(CONFIGS.map((c) => [`${c.banks} banks, ${c.rowWords}-word rows, ${c.policy} page${c.hash ? ', hash' : ''}`, c] as const))(
    '%s: keeps every rule and every word through refreshes', (_, c) => {
      const ctrl = new CtrlModel(c), dev = new DeviceModel(c);
      const lines = 2 ** (c.k - 2), shadow = new Map<number, number[]>(), r = lcg(7);
      let cycles = 0;
      for (let n = 0; n < 1500; n++) {
        const la = r() % lines, wr = r() % 3 === 0;
        const data = [r(), r(), r(), r()].map((v) => (v * 2654435761) >>> 0);
        const res = transfer(ctrl, dev, wr, la, data);
        cycles += res.cycles;
        if (wr) shadow.set(la, data);
        else if (shadow.has(la)) expect(res.words, `line ${la}`).toEqual(shadow.get(la));
        const gap = r() % 4;
        idle(ctrl, dev, gap);
        cycles += gap;
      }
      expect(dev.err ? dev.why : '').toBe('');
      expect(ctrl.stats.refreshes).toBeGreaterThanOrEqual(Math.floor(cycles / TIMING.tREFI) - 1);
      if (c.policy === 'closed') expect(ctrl.stats.hits + ctrl.stats.conflicts).toBe(0);
    });

  it('the device catches a controller that cuts a corner', () => {
    const c: DramConfig = { k: 6, banks: 2, rowWords: 16, policy: 'open' };
    const dev = new DeviceModel(c);
    dev.edge({ cmd: Cmd.ACT, ba: 0, ra: 1, ca: 0, wd: 0 });
    dev.edge({ cmd: Cmd.RD, ba: 0, ra: 1, ca: 0, wd: 0 });
    expect(dev.err).toBe(true);
    expect(dev.why).toMatch(/tRCD/);
    const d2 = new DeviceModel(c);
    for (let i = 0; i < 10 * TIMING.tREFI; i++) d2.edge({ cmd: Cmd.NOP, ba: 0, ra: 0, ca: 0, wd: 0 });
    expect(d2.why).toMatch(/data lost/);
  });
});

describe('the gate-level controller is the model, cycle for cycle', () => {
  const OUTS = ['cmd', 'ba', 'ra', 'ca', 'word', 'dv', 'wv', 'done', 'hit', 'miss', 'conflict'] as const;
  const cases: DramConfig[] = [
    { k: 6, banks: 2, rowWords: 16, policy: 'open', t: { ...TIMING, tREFI: 200 } },
    { k: 8, banks: 4, rowWords: 8, policy: 'closed', t: { ...TIMING, tREFI: 300 } },
    { k: 10, banks: 2, rowWords: 32, policy: 'open', hash: true, t: { ...TIMING, tREFI: 250 } },
  ];
  it.each(cases.map((c) => [`${c.banks} banks, ${c.rowWords}-word rows, ${c.policy}${c.hash ? ', hash' : ''}`, c] as const))('%s', (_, c) => {
    const def = dramCtrl(c);
    const sim = new GateSim(flatten(def));
    sim.reset('zero');
    const ctrl = new CtrlModel(c), dev = new DeviceModel(c);
    const r = lcg(11), lines = 2 ** (c.k - 2);
    let req = false, wr = false, la = 0, gap = 0;
    const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
    for (let cyc = 0; cyc < 2500; cyc++) {
      if (!req && gap-- <= 0) { req = true; wr = r() % 3 === 0; la = r() % lines; }
      const i = { req, wr, la };
      sim.setInput('req', +req); sim.setInput('wr', +wr); sim.setInput('la', la); sim.setInput('clk', 0);
      sim.settle();
      const o = ctrl.outputs(i);
      const want: Record<string, number> = { ...o, dv: +o.dv, wv: +o.wv, done: +o.done, hit: +o.hit, miss: +o.miss, conflict: +o.conflict };
      for (const p of OUTS) {
        const quiet = p === 'ba' || p === 'ra' || p === 'ca' || p === 'word';
        if (quiet && (p === 'word' ? !(o.dv || o.wv) : o.cmd === Cmd.NOP)) continue; // don't-care while nothing uses them
        expect(out(p), `cycle ${cyc} ${p} (state ${ctrl.state})`).toBe(want[p]);
      }
      dev.edge({ cmd: o.cmd, ba: o.ba, ra: o.ra, ca: o.ca, wd: 0 });
      ctrl.edge(i);
      sim.setInput('clk', 1);
      sim.settle();
      if (o.done) { req = false; gap = r() % 5; }
    }
    expect(dev.err ? dev.why : '').toBe('');
    expect(ctrl.stats.refreshes).toBeGreaterThan(4);
  });
});
