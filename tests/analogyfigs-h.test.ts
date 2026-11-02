// Merge H analogy figures (kitchen, squad, movers, doorbell, fourway): every number they show against the site's own
// models: OooModel, SimtISS, the gate-level bus bench, the golden model's timer program and the gate-level arbiter.

import { describe, expect, it } from 'vitest';
import { FLASH_TIMES } from '../src/flash/model';
import { arbiterN } from '../src/lib';
import { busBench } from '../src/lib/axi';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { OooModel } from '../src/riscv/ooomodel';
import { SimtISS } from '../src/riscv/simt';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';
import {
  arbMaxWait, cpuAlone, arbRun, arbStart, arbStep, doorbellRun, doorCosts, interruptSource, kitchenCycles, kitchenRun, moveRun, squadRun, squadSource,
  KITCHEN_WINDOWS, MOVE_GAP, SQUAD_LANES, type SquadCond,
} from '../src/widgets/analogy/system';

describe('kitchen (ooo)', () => {
  it('replays OooModel: the pass never holds more than the window, and serves tickets in order', () => {
    for (const program of ['chains', 'dot']) for (const rob of KITCHEN_WINDOWS) {
      const r = kitchenRun(program, rob);
      const served: number[] = [];
      for (const f of r.frames) {
        expect(f.rob.length).toBeLessThanOrEqual(rob);
        served.push(...f.out);
      }
      expect(served.length).toBe(r.instructions);
      expect(served).toEqual([...served].sort((a, b) => a - b)); // ticket order (seq is fetch order)
      expect(r.frames.at(-1)!.served).toBe(r.instructions);
      expect(r.frames.length).toBe(r.cycles);
    }
  });
  it('a bigger window finishes sooner, and a full pass costs cycles (numbers shown on the figure)', () => {
    const c = (p: string, w: number) => kitchenCycles(p, w);
    expect([4, 8, 16].map((w) => c('dot', w))).toEqual([97, 70, 64]);
    expect([4, 8, 16].map((w) => c('chains', w))).toEqual([386, 324, 324]);
    expect([4, 8, 16].map((w) => kitchenRun('dot', w).robFull)).toEqual([55, 23, 1]);
    expect(kitchenRun('chains', 4).robFull).toBe(328);
  });
  it('is the model itself: as many frames as OooModel steps', () => {
    const w = assemble('li t0,1\nli t1,2\nadd t2,t0,t1\nh: j h').words;
    const m = new OooModel(w, { rob: 8, iq: 8 }, { dmemWords: 64, imemWords: 128 });
    let n = 0;
    while (!m.halted && n < 100) { m.step(); n++; }
    expect(n).toBe(m.stats.cycles);
  });
});

describe('squad (simt)', () => {
  const dmem = (cond: SquadCond) => {
    const w = new SimtISS(assemble(squadSource(cond)).words, { lanes: SQUAD_LANES });
    w.run();
    return [...w.dmem.slice(0, SQUAD_LANES)];
  };
  it('every condition computes what its lanes should', () => {
    expect(dmem('half')).toEqual([0, 3, 1, 9]); // even lanes lane / 2, odd lanes 3 * lane
    expect(dmem('all')).toEqual([0, 3, 6, 9]);
    expect(dmem('one')).toEqual([0, 0, 1, 1]);
  });
  it('the mask per step: the odd group steps forward, then the other, then everyone', () => {
    const half = squadRun('half');
    expect(half.steps.map((s) => s.mask)).toEqual([15, 15, 15, 10, 10, 10, 10, 10, 5, 5, 5, 15, 15, 15]);
    expect(half.slots).toBe(14);
    expect(half.utilization).toBeCloseTo(40 / 56, 10);
  });
  it('a split costs both groups; agreeing lanes skip the other path', () => {
    expect(squadRun('all').slots).toBe(11);
    expect(squadRun('all').utilization).toBe(1);
    expect(squadRun('one').slots).toBe(14);
    expect(squadRun('one').steps.map((s) => s.mask)).toEqual([15, 15, 15, 1, 1, 1, 1, 1, 14, 14, 14, 15, 15, 15]);
    expect(squadRun('half').slots - squadRun('all').slots).toBe(3); // the other group's extra three steps
  });
});

// ---- movers against the gate-level bench (same helper as tests/axi.test.ts) ----
const IMAGE = Array.from({ length: 64 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 0));
function bench() {
  const sim = new GateSim(flatten(busBench(IMAGE, 10, 0)));
  sim.reset('zero');
  for (const p of ['req', 'we', 'addr', 'wdata', 'be', 'clk']) sim.setInput(p, 0);
  sim.settle();
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
  let cycle = 0;
  const tick = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); cycle++; };
  const access = (we: boolean, addr: number, wdata = 0) => {
    sim.setInput('req', 1); sim.setInput('we', +we); sim.setInput('addr', addr); sim.setInput('wdata', wdata); sim.setInput('be', 15);
    sim.settle();
    for (let n = 1; n < 2000; n++) {
      const done = out('done') === 1;
      tick();
      if (done) { sim.setInput('req', 0); sim.settle(); return n; }
    }
    throw new Error('never finished');
  };
  const start = (src: number, len: number) => {
    access(true, 0x4000_0000, src); access(true, 0x4000_0004, 0x200); access(true, 0x4000_0008, len); access(true, 0x4000_000c, 1);
  };
  return { out, tick, access, start, cycle: () => cycle };
}

describe('movers (bus / DMA)', () => {
  const cases: [string, number, 'ram' | 'flash', number][] = [['RAM', 16, 'ram', 0x100], ['flash', 4, 'flash', 0x1000_0000], ['flash', 20, 'flash', 0x1000_0000]];
  for (const [name, len, src, addr] of cases) {
    it(`DMA alone, ${len} words from ${name}: cycles from go to irq equal the gate-level bench`, () => {
      const b = bench();
      b.start(addr, len);
      const t0 = b.cycle();
      let n = 0;
      while (b.out('irq') !== 1 && n++ < 5000) b.tick();
      expect(moveRun(len, src, -1).irqAt).toBe(b.cycle() - t0);
    });
  }
  it("the figure's constants are the bench's: RAM 2 cycles, a flash page read FLASH_TIMES.read + 2, then 3", () => {
    expect(moveRun(1, 'ram', -1).irqAt).toBe(4);
    expect(moveRun(1, 'flash', -1).irqAt).toBe(FLASH_TIMES.read + 2 + 2);
    expect(moveRun(2, 'flash', -1).irqAt).toBe(FLASH_TIMES.read + 2 + 2 + 3 + 2);
    expect(moveRun(17, 'flash', -1).irqAt - moveRun(16, 'flash', -1).irqAt).toBe(FLASH_TIMES.read + 2 + 2);
  });
  for (const [name, len, src, addr] of [cases[0], cases[1]]) {
    it(`a CPU hammering RAM while ${len} words copy from ${name}: every load's wait equals the bench`, () => {
      const b = bench();
      b.start(addr, len);
      const t0 = b.cycle(), lat: number[] = [];
      let n = 0;
      while (b.out('irq') !== 1 && n++ < 5000) lat.push(b.access(false, 0));
      const m = moveRun(len, src, 0, true);
      // the bench issues one more load after the last word lands; compare the ones the model has
      expect(lat.slice(0, m.loads.length)).toEqual(m.loads);
      const total = b.cycle() - t0; // the last load starts at or after irq's cycle minus its own length
      expect(total).toBeGreaterThanOrEqual(m.irqAt);
      expect(total).toBeLessThanOrEqual(m.irqAt + lat.at(-1)!);
    });
  }
  it('the CPU alone does 3 ALU instructions and a 2-cycle load every 5 cycles', () => {
    expect(cpuAlone(100)[100]).toBe(79); // 19 rounds of 4 instructions, then the 3 ALU ones of the 20th
  });
  it("the figure's CPU (3 ALU instructions, then a load) waits while the DMA holds the bus", () => {
    const busy = moveRun(16, 'ram', MOVE_GAP), none = moveRun(16, 'ram', -1);
    expect(busy.irqAt).toBeGreaterThan(none.irqAt); // the CPU's loads take bus turns
    const done = moveRun(16, 'ram', MOVE_GAP);
    expect(done.words.at(-1)).toBe(16); // every word has landed when the bell rings
    expect(done.words.length).toBe(done.irqAt + 1);
    const flash = moveRun(16, 'flash', MOVE_GAP);
    expect(Math.max(...flash.loads)).toBeGreaterThan(FLASH_TIMES.read); // a load behind the page read waits for the rest of it
    expect(Math.max(...flash.loads)).toBeLessThanOrEqual(FLASH_TIMES.read + 2 + 2);
  });
});

describe('doorbell (traps)', () => {
  it('costs are read off the golden model: trap entry 1, the handler 7, a poll that finds nothing 3, the polled service 7', () => {
    expect(doorCosts()).toEqual({ trap: 1, handler: 7, check: 3, serve: 7 });
  });
  it("the interrupt version is the chapter's program: a tick every 40 cycles, 8 of them the trap and handler", () => {
    const r = doorbellRun('irq', 40, 0, 200);
    const traps = r.slices.map((s, i) => (s === 'trap' ? i : -1)).filter((i) => i >= 0);
    expect(traps).toEqual(r.arrivals.filter((a) => a < 200)); // taken the cycle the visitor arrives
    expect(r.delays.every((d) => d === 0)).toBe(true);
    expect(r.slices.slice(0, 190).filter((s) => s !== 'work').length).toBe(4 * 8); // arrivals at 34, 74, 114, 154
    const iss = new ISS(assemble(interruptSource(40)).words, { system: true, mmio: true } as never);
    for (let i = 0; i < 220; i++) iss.step();
    expect(iss.x[9]).toBe(5); // s1 counts the ticks
  });
  it('polling: a check every work + 3 cycles, a visitor waits for the next check', () => {
    const r = doorbellRun('poll', 40, 6, 400);
    expect(r.delays.length).toBeGreaterThan(5);
    for (const d of r.delays) expect(d).toBeLessThanOrEqual(6 + 3 + 3); // a check that read mtime just before the arrival, then the work, then the next check
  });
  it("the slider's crossover: polling less often wastes less, and a rare visitor favours the bell", () => {
    const idle = (m: 'poll' | 'irq', every: number, work = 6) => doorbellRun(m, every, work, 1000).idle;
    expect(idle('irq', 80)).toBeLessThan(idle('poll', 80, 6));
    expect(idle('poll', 80, 30)).toBeLessThan(idle('poll', 80, 6));
    expect(idle('irq', 12)).toBeGreaterThan(idle('poll', 12, 30));
  });
});

// ---- fourway against the gate-level arbiter ----
function grantsOf(n: number, reqs: boolean[][]): number[] {
  const s = simulate(arbiterN(n));
  const out: number[] = [];
  s.setInput('clk', 0);
  for (const r of reqs) {
    r.forEach((x, i) => s.setInput(`r${i}`, x ? 1 : 0));
    s.settle();
    out.push(Array.from({ length: n }, (_, i) => pack(s.getBits(s.design.root.ports[`g${i}`]))).indexOf(1));
    s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle();
  }
  return out;
}

describe('fourway (multicore)', () => {
  const scripts: number[][] = [[6, 2, 2, 2], [3, 3, 3, 3], [0, 5, 0, 1], [1, 0, 4, 4], [8, 8, 0, 0]];
  for (const want of scripts) {
    it(`round robin [${want}]: the same grants as arbiterN simulated in gates`, () => {
      for (const n of [4, 3, 2]) {
        const w = want.slice(0, n);
        const grants = arbRun(w, 'rr');
        // the requests each cycle are the cores with requests left, as the figure raises them
        let s = arbStart(w);
        const reqs: boolean[][] = [];
        for (let i = 0; i < grants.length; i++) { reqs.push(s.want.map((x) => x > 0)); s = arbStep(s, 'rr'); }
        expect(grantsOf(n, reqs)).toEqual(grants);
        expect(grants.length).toBe(w.reduce((a, b) => a + b, 0));
      }
    });
  }
  it('first come (lowest core) makes the others wait out a core that keeps asking; round robin serves each within n grants', () => {
    expect(arbRun([6, 2, 2, 2], 'first')).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3]);
    expect(arbRun([6, 2, 2, 2], 'rr')).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 0, 0, 0]);
    const want = [6, 2, 2, 2];
    expect(arbMaxWait(arbRun(want, 'first'), want, 3)).toBe(10);
    for (const c of [1, 2, 3]) expect(arbMaxWait(arbRun(want, 'rr'), want, c)).toBeLessThanOrEqual(3);
  });
});
