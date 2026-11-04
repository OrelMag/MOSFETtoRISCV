// Chapter 44's SPI master as a bus slave (lib/spi.ts axiSpi, the sandbox's SPI controller): a store to DATA sends a byte, STATUS says busy / done,
// a load reads what came in. Driven the way the interconnect would, against chapter 44's 256-byte SPI memory, on the engine the sandbox runs in cycle
// mode (DualSim, preferFast); the golden model is comm/spi.ts's.

import { describe, expect, it } from 'vitest';
import { define } from '../src/lib/define';
import { axiSpi, axiSpiB, spiDevice } from '../src/lib/spi';
import { bundled } from '../src/lib/axi';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { pack } from '../src/sim/values';
import { SpiTarget } from '../src/comm/spi';
import type { ComponentDef, PortDef } from '../src/sim/types';
import { tick } from './yieldtick';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, clock });

/** The controller and a memory on SCLK, MOSI, MISO and CS, the bus pins out to the test. */
function bench(withMemory: boolean): ComponentDef {
  const S = axiSpi(), M = spiDevice();
  const pinned = withMemory ? ['sclk', 'mosi', 'cs_n', 'miso'] : [];
  const inPorts = S.ports.filter((p) => p.dir === 'in' && !pinned.includes(p.name));
  const outPorts = S.ports.filter((p) => p.dir === 'out' && !pinned.includes(p.name));
  return define({
    id: withMemory ? 'spi_bus_bench' : 'spi_bus_bench_pins', name: 'SPI controller and memory', category: 'cell', summary: 'test bench',
    ports: [...inPorts.map((p): PortDef => ({ ...p, side: undefined })), ...outPorts, ...(withMemory ? [bit('csn', 'out')] : [])],
    symbol: { kind: 'box', label: 'BENCH' },
    netlist: () => ({
      pins: Object.fromEntries([...inPorts.map((p, i) => [p.name, [0, 2 + 3 * i] as [number, number]]), ...outPorts.map((p, i) => [p.name, [40, 2 + 3 * i] as [number, number]]), ...(withMemory ? [['csn', [40, 40] as [number, number]]] : [])]),
      instances: [{ name: 'spi', def: S, at: [10, 2] }, ...(withMemory ? [{ name: 'mem', def: M, at: [10, 60] as [number, number] }] : [])],
      nets: [
        ...[...inPorts, ...outPorts].map((p) => ({ name: p.name, ends: [p.name, `spi.${p.name}`] })),
        ...(withMemory ? [{ name: 'sclk', ends: ['spi.sclk', 'mem.sclk'] }, { name: 'mosi', ends: ['spi.mosi', 'mem.mosi'] },
          { name: 'cs_n', ends: ['spi.cs_n', 'mem.cs_n', 'csn'] }, { name: 'miso', ends: ['mem.miso', 'spi.miso'] }] : []),
      ],
    }),
  });
}

class Bus {
  sim: DualSim;
  clocks = 0;
  /** Without a gate-level memory: SpiTarget (comm/spi.ts) answers on the pins, sampled after every clock. */
  target?: SpiTarget;
  private sclk = 0;
  constructor(withMemory: boolean) {
    if (!withMemory) this.target = new SpiTarget();
    this.sim = new DualSim(flatten(bench(withMemory)));
    this.sim.preferFast = true;
    this.sim.reset('zero');
    for (const [k, v] of Object.entries({ clk: 0, awvalid: 0, wvalid: 0, awaddr: 0, wdata: 0, wstrb: 0, bready: 1, arvalid: 0, araddr: 0, rready: 1 })) this.sim.setInput(k, v);
    if (this.target) this.sim.setInput('miso', 0);
    this.sim.settle(); this.sim.prepare(); this.sim.settle();
  }
  out = (p: string) => pack(this.sim.getBits(this.sim.design.root.ports[p]));
  get csn() { return this.target ? this.out('cs_n') : this.out('csn'); }
  clock(n = 1) { for (let i = 0; i < n; i++) { this.sim.setInput('clk', 1); this.sim.settle(); this.sim.setInput('clk', 0); this.sim.settle(); this.clocks++; this.peer(); } }
  /** The pins after a clock: the target sees CS, and a rising or falling SCLK; MISO is set for the next clock. */
  private peer() {
    const t = this.target;
    if (!t) return;
    if (this.out('cs_n') === 1) t.csHigh();
    else {
      const sc = this.out('sclk');
      if (sc !== this.sclk) { if (sc === 1) t.rising(this.out('mosi')); else t.falling(); this.sclk = sc; }
    }
    this.sim.setInput('miso', t.miso); this.sim.settle();
  }
  set(v: Record<string, number>) { for (const [k, x] of Object.entries(v)) this.sim.setInput(k, x); this.sim.settle(); }
  write(off: number, data: number) {
    this.set({ awvalid: 1, wvalid: 1, awaddr: off, wdata: data, wstrb: 15 });
    this.clock();
    this.set({ awvalid: 0, wvalid: 0 });
    this.clock(2);
  }
  read(off: number): number {
    this.set({ arvalid: 1, araddr: off });
    this.clock();
    this.set({ arvalid: 0 });
    const v = this.out('rdata');
    this.clock(2);
    return v;
  }
  /** Send one byte and wait for done; returns the byte that came in. `last`: drop HOLD once the byte is under way, so CS rises after it (dropping it between bytes would end the transaction). */
  async xfer(byte: number, last = false): Promise<number> {
    this.write(0, byte);
    if (last) this.write(8, 0);
    for (let i = 0; i < 400 && (this.read(4) & 2) === 0; i++) if (i % 50 === 0) await tick();
    return this.read(0);
  }
}

describe('the SPI controller as a bus slave', () => {
  it('has the sandbox part\'s shape: packed slave link, pins sclk / mosi / cs_n / miso / irq', () => {
    const d = axiSpiB();
    expect(d.id).toBe('axi_spi_b');
    expect(d.ports.map((p) => `${p.dir[0]}:${p.name}`)).toEqual(expect.arrayContaining(['i:req', 'o:rsp', 'i:miso', 'o:sclk', 'o:mosi', 'o:cs_n', 'o:irq', 'i:clk']));
    expect(bundled(axiSpi(), [['', 'slave']], 'axi_spi_b')).toBe(d);
  });

  const memoryRoundTrip = async (b: Bus) => {
    expect(b.csn).toBe(1);
    // mode 0, CS held low across the bytes of a transaction (CTRL bit 2)
    b.write(8, 0b100);
    expect(b.read(8)).toBe(0b100);
    // write 0xA7, 0x3C at address 5: command, address, two data bytes (hold off before the last)
    await b.xfer(0x02); await b.xfer(5); await b.xfer(0xa7);
    await b.xfer(0x3c, true);
    expect(b.csn).toBe(1);
    // read them back: 0x03, address, then two dummy bytes whose replies are the data
    b.write(8, 0b100);
    await b.xfer(0x03); await b.xfer(5); const first = await b.xfer(0);
    const second = await b.xfer(0, true);
    expect([first, second]).toEqual([0xa7, 0x3c]);
  };

  it('on the cycle engine the controller writes and reads back a 256-byte memory (comm/spi.ts SpiTarget on the pins)', async () => {
    const b = new Bus(false);
    expect(b.sim.engine, b.sim.whyNot ?? '').toBe('cycle');
    await memoryRoundTrip(b);
    expect(b.sim.engine).toBe('cycle');
    expect([...b.target!.mem.slice(5, 7)]).toEqual([0xa7, 0x3c]);
  }, 120000);

  it('against the gate-level SPI memory the pair runs on GateSim: the memory is clocked by SCLK, a flip-flop output (a ripple clock to the cycle engine)', async () => {
    const b = new Bus(true);
    expect(b.sim.engine).toBe('gate');
    expect(b.sim.whyNot ?? '').toMatch(/ripple clock/);
    await memoryRoundTrip(b);
  }, 120000);

  it('STATUS: busy while a byte shifts, done afterwards and cleared by writing 1 to bit 1; irq follows done when enabled', async () => {
    const b = new Bus(false);
    expect(b.read(4)).toBe(0);
    b.write(8, 0b1000);
    b.write(0, 0x55);
    expect(b.read(4) & 1).toBe(1);
    expect(b.out('irq')).toBe(0);
    for (let i = 0; i < 400 && (b.read(4) & 1) === 1; i++);
    expect(b.read(4)).toBe(2);
    expect(b.out('irq')).toBe(1);
    b.write(4, 2);
    expect(b.read(4)).toBe(0);
    expect(b.out('irq')).toBe(0);
    // a store while busy is ignored
    b.write(0, 0x11);
    b.write(0, 0x22);
    for (let i = 0; i < 400 && (b.read(4) & 1) === 1; i++);
    expect(b.read(0)).toBe(0); // MISO was 0 (CS high): the byte that came in
  }, 60000);
});
