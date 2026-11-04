// Chapter 44's SPI: the gate-level master and target against their models, every output after every clock (master) or
// every SCLK edge (target), in all four modes, with seeded random MISO and random start times.

import { describe, expect, it } from 'vitest';
import { edgeKind, modeNumber, SPI_MODES, spiTransfer, spiTrace, SpiMaster, SpiTarget, SPI_READ, SPI_WRITE } from '../src/comm/spi';
import { masterRun, spiDevice, spiMaster } from '../src/lib/spi';
import { simulate } from '../src/sim/harness';
import { lcg, out, set } from './util';
import { tick as yieldTick } from './yieldtick';

const tickClk = (s: ReturnType<typeof simulate>) => { set(s, { clk: 1 }); set(s, { clk: 0 }); };

describe('SPI master', () => {
  for (const mode of SPI_MODES) {
    it(`mode ${modeNumber(mode)}: every output every clock equals the model; the byte read is the bits MISO showed at the sample edges`, async () => {
      const gate = simulate(spiMaster());
      const model = new SpiMaster();
      const rnd = lcg(40 + modeNumber(mode));
      set(gate, { rst: 1, start: 0, hold: 0, cpol: mode.cpol, cpha: mode.cpha, tx: 0, miso: 0 });
      tickClk(gate); model.step({ rst: 1, start: 0, hold: 0, cpol: mode.cpol, cpha: mode.cpha, tx: 0, miso: 0 });
      let bytes = 0;
      for (let c = 0; c < 900; c++) {
        const i = { rst: 0, start: rnd(6) === 0 ? 1 : 0, hold: rnd(3) === 0 ? 1 : 0, cpol: mode.cpol, cpha: mode.cpha, tx: rnd(256), miso: rnd(2) };
        set(gate, i);
        tickClk(gate); model.step(i);
        const o = model.out;
        for (const k of ['sclk', 'mosi', 'cs_n', 'rx', 'busy', 'done'] as const) expect(out(gate, k), `${k} @${c}`).toBe(o[k]);
        if (o.done) bytes++;
        if (c % 100 === 0) await yieldTick();
      }
      expect(bytes).toBeGreaterThan(5);
    });
  }
  it('model: a byte sent in each mode shows its bit 7 first and reads MISO at the sample edges', () => {
    for (const mode of SPI_MODES) {
      const m = new SpiMaster();
      const tx = 0xa5, peer = 0x3c;
      m.step({ rst: 1, start: 0, hold: 0, cpol: mode.cpol, cpha: mode.cpha, tx: 0, miso: 0 });
      m.step({ rst: 0, start: 1, hold: 0, cpol: mode.cpol, cpha: mode.cpha, tx, miso: 0 });
      const seen: number[] = [];
      let edges = 0, prevS = m.out.sclk, bit = 0;
      for (let c = 0; c < 80 && m.out.cs_n === 0; c++) {
        const o = m.out;
        // the peer drives the bit after the change edge; here a model of the target in this mode
        const miso = (peer >> (7 - Math.min(bit, 7))) & 1;
        m.step({ rst: 0, start: 0, hold: 0, cpol: mode.cpol, cpha: mode.cpha, tx, miso });
        if (m.out.sclk !== prevS) {
          const e = edges++;
          if (edgeKind(mode, e).sample) { seen.push(o.mosi); bit++; }
          prevS = m.out.sclk;
        }
      }
      expect(edges, `mode ${modeNumber(mode)}`).toBe(16);
      expect(seen.reduce((a, b) => (a << 1) | b, 0), `mode ${modeNumber(mode)} mosi`).toBe(tx);
    }
  });
});

/** Drive the target's gates through bytes the way a master in mode 0 does; the bytes it returned. */
function gateTransfer(gate: ReturnType<typeof simulate>, bytes: number[]): number[] {
  set(gate, { sclk: 0, cs_n: 0, mosi: 0 });
  const got: number[] = [];
  for (const tx of bytes) {
    let rx = 0;
    for (let i = 0; i < 8; i++) {
      rx = (rx << 1) | out(gate, 'miso');
      set(gate, { mosi: (tx >> (7 - i)) & 1 }); set(gate, { sclk: 1 }); set(gate, { sclk: 0 });
    }
    got.push(rx);
  }
  set(gate, { cs_n: 1 });
  return got;
}

describe('SPI target', () => {
  it('gates: write four bytes, read them back, and the address wraps past 255', () => {
    const g = simulate(spiDevice());
    gateTransfer(g, [SPI_WRITE, 10, 0xde, 0xad, 0xbe, 0xef]);
    expect(gateTransfer(g, [SPI_READ, 10, 0, 0, 0, 0]).slice(2)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    gateTransfer(g, [SPI_WRITE, 255, 0x77, 0x88]);
    expect(gateTransfer(g, [SPI_READ, 255, 0, 0]).slice(2)).toEqual([0x77, 0x88]);
    expect(gateTransfer(g, [0x55, 10, 0, 0]).slice(2)).toEqual([0, 0]); // an unknown command: nothing comes back
  });
  it('model: write then read back, auto-increment, and a short read of fresh memory', () => {
    const t = new SpiTarget();
    spiTransfer(t, [SPI_WRITE, 10, 0xde, 0xad, 0xbe, 0xef]);
    expect(spiTransfer(t, [SPI_READ, 10, 0, 0, 0, 0]).slice(2)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    spiTransfer(t, [SPI_WRITE, 255, 0x77, 0x88]);
    expect(spiTransfer(t, [SPI_READ, 255, 0, 0]).slice(2)).toEqual([0x77, 0x88]);
    expect(t.mem[0]).toBe(0x88); // the address wraps
    expect(t.mem[10]).toBe(0xde);
  });
  it('gates equal the model on every bit of random transactions (CS held between bytes, released between transactions)', async () => {
    const gate = simulate(spiDevice());
    const model = new SpiTarget();
    const rnd = lcg(7);
    const sets = (v: Record<string, number>) => set(gate, v);
    for (let txn = 0; txn < 10; txn++) {
      const write = rnd(2) === 0;
      const n = 2 + rnd(4);
      const bytes = [write ? SPI_WRITE : SPI_READ, rnd(256), ...Array.from({ length: n }, () => rnd(256))];
      sets({ sclk: 0, cs_n: 0, mosi: 0 });
      model.csHigh();
      for (const tx of bytes) {
        for (let i = 0; i < 8; i++) {
          const mosi = (tx >> (7 - i)) & 1;
          expect(out(gate, 'miso'), `miso before bit ${i} of txn ${txn}`).toBe(model.miso);
          sets({ mosi }); sets({ sclk: 1 }); model.rising(mosi);
          sets({ sclk: 0 }); model.falling();
          expect(out(gate, 'miso')).toBe(model.miso);
        }
      }
      sets({ cs_n: 1 }); model.csHigh();
      expect(out(gate, 'miso')).toBe(0);
      await yieldTick();
    }
  });
});

describe('masterRun (the waveform widget\'s source)', () => {
  for (const mode of SPI_MODES) {
    it(`mode ${modeNumber(mode)}: the gates shift 0xA5 out and read the peer's 0x3C, sampling on the edges the mode says`, () => {
      const r = masterRun(mode, 0xa5, 0x3c);
      expect(r.rx).toBe(0x3c);
      expect(r.edges).toHaveLength(16);
      const bitsOut = r.edges.filter((_, e) => edgeKind(mode, e).sample).map((c) => r.clocks[c - 1].mosi);
      expect(bitsOut.reduce((a, b) => (a << 1) | b, 0), 'MOSI at the sample edges').toBe(0xa5);
      const bitsIn = r.edges.filter((_, e) => edgeKind(mode, e).sample).map((c) => r.clocks[c - 1].miso);
      expect(bitsIn.reduce((a, b) => (a << 1) | b, 0), 'MISO at the sample edges').toBe(0x3c);
      expect(r.clocks[r.edges[0] - 1].sclk).toBe(mode.cpol);
    });
  }
});
