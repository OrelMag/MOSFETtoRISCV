// The USB device in gates against its model (comm/usb.ts UsbDevice): every output after every clock, across a whole enumeration,
// with faults, with a host whose clock is off, with garbage packets; on GateSim and on the cycle engine; the drawings; the costs.

import { describe, expect, it } from 'vitest';
import {
  CONFIG_DESCRIPTOR, DEVICE_DESCRIPTOR, PID, REQ, UsbBench, UsbHost, crc16, dataBytes, handshakeBytes, pidByte, setupData, sofBytes, tokenBytes, type BenchOptions, type Pump,
} from '../src/comm/usb';
import { emptyWorkspace } from '../src/editor/model';
import { remixDef } from '../src/editor/remix';
import { usbCosts, usbDevice } from '../src/lib/usb';
import { deadInstances } from '../src/sim/dead';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { lcg } from './util';
import { cycleDev, GateDev, Pair, readSweep } from './usbkit';
import { tick as yieldTick } from './yieldtick';

/** Run a bench of gates + model to the end of the host's script, yielding now and then; returns the bench. */
async function lockStep(opt: BenchOptions, pair = new Pair(), max = 40000): Promise<{ b: UsbBench; pair: Pair }> {
  const b = new UsbBench(pair, opt);
  while (!b.host.done && b.clock < max) {
    b.step();
    if (b.clock % 1500 === 0) await yieldTick();
  }
  return { b, pair };
}

describe('USB device gates equal the model', () => {
  it('every output after every clock across a whole enumeration', async () => {
    const { b, pair } = await lockStep({});
    expect(b.host.failed).toBeNull();
    expect(b.host.configured).toBe(true);
    expect(b.host.cfg25).toEqual(CONFIG_DESCRIPTOR);
    expect(b.host.dev18).toEqual(DEVICE_DESCRIPTOR);
    expect(pair.mismatch).toBeNull();
    expect(b.clashes).toBe(0);
    expect(pair.gates.o).toMatchObject({ state: 3, addr: 5, oe: 0 });
    console.log(`enumeration: ${b.clock} clocks`);
  }, 240000);

  it('with a corrupted packet at several places, NAKs, a host whose clock is off, and noise on the line', async () => {
    const runs: BenchOptions[] = [
      { corruptSend: 2 }, { corruptSend: 11 }, { corruptSend: 20 }, { corruptSend: 31 },
      { nak: (c) => (c > 2800 && c < 3100 ? 1 : 0) },
      { jitter: (() => { const r = lcg(5); return () => r(1000) / 1000; })(), lead: 53 },
      { wireFlips: [1200, 4300, 7001, 9100] },
    ];
    for (const [i, opt] of runs.entries()) {
      const { b, pair } = await lockStep(opt);
      expect(pair.mismatch, `run ${i}`).toBeNull();
      expect(b.clashes, `run ${i}`).toBe(0);
      expect(b.host.done, `run ${i}`).toBe(true);
    }
  }, 600000);

  it('a bad ACK on the SET_ADDRESS status stage leaves gates and model at address 0 together', async () => {
    const base = new UsbBench(new Pair());
    base.run();
    const k = base.host.sendLog.findIndex((s, i) => s.stage === 'set address' && s.pid === PID.ACK && base.host.sendLog[i - 1].pid === PID.IN);
    const { b, pair } = await lockStep({ corruptSend: k });
    expect(pair.mismatch).toBeNull();
    expect(b.host.failed).toContain('GET_DESCRIPTOR(device, 18)');
    expect(pair.gates.o.addr).toBe(0);
  }, 240000);

  it('every wLength of both descriptors and GET_STATUS: the gates send packets of every size and CRC, with stuffed bits in the middle and at the end', async () => {
    const out: { type: string; len: number; got: unknown }[] = [];
    const { b, pair } = await lockStep({ script: readSweep(out) }, new Pair(), 400000);
    expect(pair.mismatch).toBeNull();
    expect(b.host.failed).toBeNull();
    expect(out).toHaveLength(63);
    expect(out.every((r) => Array.isArray(r.got))).toBe(true);
  }, 600000);

  it('garbage: transactions of every kind with random requests and payloads full of runs of 1s, bad CRCs, odd lengths, bus resets, to the device address and to others', async () => {
    const rnd = lcg(77), pool = [0, 0xff, 0xff, 0xfc, 0x3f, 0x7f, 0xfe, 0x80, 0x01];
    const byte = () => (rnd(3) ? pool[rnd(pool.length)] : rnd(256));
    function* fuzz(h: UsbHost): Pump<void> {
      yield* h.quiet(40);
      yield* h.busReset();
      for (let n = 0; n < 400; n++) {
        if (rnd(40) === 0) { yield* h.busReset(); continue; }
        if (n === 120 || n === 300) { yield* h.busReset(); yield* h.controlNoData(0, setupData(0, REQ.SET_ADDRESS, 5, 0, 0)); yield* h.quiet(40); yield* h.controlNoData(5, setupData(0, REQ.SET_CONFIGURATION, 1, 0, 0)); continue; }
        const k = rnd(20), addr = [0, 0, 5, 5, 5, 7, 127][rnd(7)], ep = [0, 0, 0, 0, 1, 2, 15][rnd(7)];
        if (k < 3) {
          // raw junk: a PID byte with arbitrary bytes after it, a lone handshake, data with no token
          const wire = k === 0 ? [pidByte(rnd(16)), ...Array.from({ length: rnd(5) }, () => rnd(256))] : k === 1 ? handshakeBytes([PID.ACK, PID.ACK, PID.NAK, PID.STALL][rnd(4)]) : dataBytes(rnd(2) ? PID.DATA1 : PID.DATA0, Array.from({ length: rnd(4) }, byte));
          yield* h.send(wire);
          yield* h.quiet(rnd(60));
        } else if (k < 11) {
          // SETUP: a standard request (valid or not) with runs of 1s in its fields
          const type = [0x80, 0x80, 0x80, 0x00, 0x00, 0x21, 0xc0][rnd(7)], req = [6, 6, 6, 5, 9, 0, 1, 12][rnd(8)];
          const data = [type, req, [0, 1, 2, 3, 5, 0x80, 0xff, 0x7f][rnd(8)], [0, 0, 1, 2, 3, 0xff][rnd(6)], byte(), byte(), [0, 1, 2, 8, 18, 25, 64, 255, 0xfc][rnd(9)], rnd(8) === 0 ? 1 : 0];
          const sd = rnd(12) === 0 ? 7 + rnd(3) : 8;
          while (data.length > sd) data.pop();
          while (data.length < sd) data.push(byte());
          yield* h.send(tokenBytes(PID.SETUP, addr, rnd(10) === 0 ? ep : 0));
          yield* h.gap();
          let wire = dataBytes(rnd(6) === 0 ? PID.DATA1 : PID.DATA0, data);
          if (rnd(12) === 0) wire = [wire[0], ...data, (crc16(data) ^ (1 << rnd(8))) & 255, crc16(data) >> 8];
          yield* h.send(wire);
          yield* h.recv();
        } else if (k < 15) {
          yield* h.send(tokenBytes(PID.OUT, addr, ep));
          yield* h.gap();
          const data = Array.from({ length: [0, 0, 0, 1, 2, 9][rnd(6)] }, byte);
          let wire = dataBytes(rnd(4) ? PID.DATA1 : PID.DATA0, data);
          if (rnd(10) === 0) wire = [wire[0], ...data, (crc16(data) ^ (1 << rnd(8))) & 255, crc16(data) >> 8];
          yield* h.send(wire);
          yield* h.recv();
        } else if (k < 19) {
          yield* h.send(rnd(8) === 0 ? sofBytes(rnd(2048)) : tokenBytes(PID.IN, addr, ep));
          const r = yield* h.recv();
          if (r?.good && r.p.kind === 'data' && rnd(5)) { yield* h.gap(); yield* h.send(handshakeBytes(PID.ACK)); }
        } else {
          const t = tokenBytes([PID.OUT, PID.IN, PID.SETUP][rnd(3)], addr, ep);
          t[1 + rnd(2)] ^= 1 << rnd(8);
          yield* h.send(t);
          yield* h.recv();
        }
        yield* h.gap(rnd(30));
      }
    }
    const { b, pair } = await lockStep({ script: fuzz }, new Pair(), 400000);
    expect(pair.mismatch).toBeNull();
    expect(b.clashes).toBe(0);
    expect(b.clock).toBeGreaterThan(40000);
    // the garbage reached the interesting states
    const seen = new Set(b.host.mon.seen.map((s) => s.wire[0] & 15));
    for (const p of [PID.ACK, PID.NAK, PID.STALL, PID.DATA0, PID.DATA1]) expect(seen.has(p), `device answered with PID ${p}`).toBe(true);
    expect([...pair.seen.state].sort()).toEqual([0, 1, 2, 3]);
    expect(pair.seen.stall.size).toBe(2);
    expect(pair.seen.armed.size).toBe(2);
    expect(pair.seen.addr.size).toBeGreaterThan(1);
  }, 900000);
});

describe('on the cycle engine', () => {
  it('the cycle engine runs the device (not refused) and equals the model on every output of a whole enumeration', async () => {
    const dev = cycleDev();
    const pair = new Pair(dev);
    const b = new UsbBench(pair);
    const t0 = performance.now();
    while (!b.host.done && b.clock < 40000) { b.step(); if (b.clock % 3000 === 0) await yieldTick(); }
    const dt = performance.now() - t0;
    expect(pair.mismatch).toBeNull();
    expect(b.host.configured).toBe(true);
    const sim = dev.sim as unknown as { engine: string; whyNot?: string };
    expect(sim.engine, `engine ${sim.engine}: ${sim.whyNot ?? ''}`).toBe('cycle');
    console.log(`USB on the cycle engine: ${Math.round((b.clock / dt) * 1000)} clocks/s`);
  }, 240000);

  it('GateSim speed on the same run', async () => {
    const dev = new GateDev();
    const b = new UsbBench(dev);
    const t0 = performance.now();
    while (!b.host.done && b.clock < 40000) { b.step(); if (b.clock % 3000 === 0) await yieldTick(); }
    console.log(`USB on GateSim: ${Math.round((b.clock / (performance.now() - t0)) * 1000)} clocks/s`);
    expect(b.host.configured).toBe(true);
  }, 240000);
});

describe('costs and drawings', () => {
  it('prices every block in NANDs', () => {
    const c = usbCosts();
    console.log(JSON.stringify(c));
    expect(c.total).toBeGreaterThan(3000);
    expect(c.blocks.rx).toBeGreaterThan(0);
  });
  const all = (() => {
    const seen = new Set<ComponentDef>();
    const visit = (d: ComponentDef) => {
      if (seen.has(d) || !(d.id.startsWith('usb_') || d.id.startsWith('unitcrc'))) return;
      seen.add(d);
      for (const i of netlistOf(d)?.instances ?? []) visit(i.def);
    };
    visit(usbDevice());
    return [...seen].filter((d) => netlistOf(d));
  })();
  it('covers the device and its blocks', () => expect(all.length).toBeGreaterThan(5));
  it.each(all.map((d) => [d.id, d] as const))('%s: no two nets on one line, no label hides another, no symbol on another', (_, d) => {
    const nl = netlistOf(d)!;
    expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
  }, 120000);
  it('the top has nothing dead, no backward wire, and Open in Sandbox works', () => {
    const d = usbDevice(), nl = netlistOf(d)!;
    expect(backwardEnds(d, nl)).toEqual([]);
    expect(deadInstances(nl, d.ports)).toEqual([]);
    const r = remixDef(emptyWorkspace(), d);
    expect('error' in r ? r.error : '').toBe('');
  }, 240000);
});
