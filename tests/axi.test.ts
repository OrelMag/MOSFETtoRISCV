import { describe, expect, it } from 'vitest';
import { FLASH_TIMES } from '../src/flash/model';
import { busBench } from '../src/lib/axi';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

const IMAGE = Array.from({ length: 64 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 0));

function bench(wait = 0) {
  const sim = new GateSim(flatten(busBench(IMAGE, 10, wait)));
  sim.reset('zero');
  for (const p of ['req', 'we', 'addr', 'wdata', 'be', 'clk']) sim.setInput(p, 0);
  sim.settle();
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
  let cycle = 0;
  const tick = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); cycle++; };
  /** One access as the CPU makes it: request until done; returns the data and the cycles it took. */
  const access = (we: boolean, addr: number, wdata = 0, be = 15) => {
    sim.setInput('req', 1); sim.setInput('we', +we); sim.setInput('addr', addr); sim.setInput('wdata', wdata); sim.setInput('be', be);
    sim.settle();
    for (let n = 1; n < 2000; n++) {
      const done = out('done') === 1, data = out('rdata') >>> 0;
      tick();
      if (done) { sim.setInput('req', 0); sim.settle(); return { data, cycles: n }; }
    }
    throw new Error('the access never finished');
  };
  const idle = (n: number) => { for (let i = 0; i < n; i++) tick(); };
  return { sim, access, idle, out, cycle: () => cycle };
}

describe('the bus (gate level)', () => {
  it('stores and loads the RAM in two cycles each, with byte enables', () => {
    const b = bench();
    expect(b.access(true, 0x0000_0010, 0xdeadbeef).cycles).toBe(2);
    const r = b.access(false, 0x0000_0010);
    expect(r.data).toBe(0xdeadbeef);
    expect(r.cycles).toBe(2);
    b.access(true, 0x0000_0010, 0x5a5a5a5a, 0b0100); // a byte store: the lane-replicated byte, one strobe
    expect(b.access(false, 0x0000_0010).data).toBe(0xde5abeef);
  });

  it('adds the wait states of a slow slave', () => {
    const b = bench(3);
    expect(b.access(true, 0x0000_0004, 7).cycles).toBe(5);
    expect(b.access(false, 0x0000_0004)).toEqual({ data: 7, cycles: 5 });
  });

  it('reads the flash through its page buffer, and the default slave answers the rest', () => {
    const b = bench();
    const first = b.access(false, 0x1000_0000);
    expect(first.data).toBe(IMAGE[0]);
    expect(first.cycles).toBe(FLASH_TIMES.read + 2);
    expect(b.access(false, 0x1000_0004)).toEqual({ data: IMAGE[1], cycles: 3 }); // same page: from the buffer
    expect(b.access(false, 0x1000_0040).cycles).toBe(FLASH_TIMES.read + 2); // the next page
    expect(b.access(false, 0x7000_0000)).toEqual({ data: 0, cycles: 2 });
  });

  it('copies flash to RAM by DMA, raises irq at the end, and shares the bus with the CPU meanwhile', () => {
    const b = bench();
    b.access(true, 0x4000_0000, 0x1000_0000);
    b.access(true, 0x4000_0004, 0x0000_0100);
    b.access(true, 0x4000_0008, 32);
    expect(b.access(false, 0x4000_0008).data).toBe(32);
    b.access(true, 0x4000_000c, 1); // go
    expect(b.access(false, 0x4000_000c).data & 1).toBe(1); // busy
    // the CPU keeps using the RAM while the copy runs
    b.access(true, 0x0000_0000, 0x1234);
    expect(b.access(false, 0x0000_0000).data).toBe(0x1234);
    let n = 0;
    while (b.out('irq') !== 1 && n++ < 5000) b.idle(1);
    expect(b.out('irq')).toBe(1);
    expect(b.access(false, 0x4000_000c).data).toBe(0b10); // done, not busy
    for (let i = 0; i < 32; i++) expect(b.access(false, 0x0000_0100 + 4 * i).data, `word ${i}`).toBe(IMAGE[i]);
    b.access(true, 0x4000_000c, 2); // clear done
    expect(b.out('irq')).toBe(0);
  });
});
