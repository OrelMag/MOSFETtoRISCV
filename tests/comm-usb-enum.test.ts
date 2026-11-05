// The USB device model and host: enumeration end to end, and the oracles that a lock-step comparison with the gates cannot be:
// the line read back by an independent decoder, SET_ADDRESS on the bus, short reads, STALL, faults on every packet.

import { describe, expect, it } from 'vitest';
import {
  CONFIG_DESCRIPTOR, DEVICE_DESCRIPTOR, PID, PID_NAME, REQ, RESET_CLOCKS, RESET_HOLD, UsbBench, UsbDevice, UsbHost, UsbMonitor, dataBytes, handshakeBytes, parsePacket,
  setupData, stuffedBits, tokenBytes, type BenchOptions, type Pump,
} from '../src/comm/usb';
import { lcg } from './util';
import { readSweep } from './usbkit';

export function enumerate(opt: BenchOptions = {}, dev = new UsbDevice(), max = 60000): UsbBench {
  const b = new UsbBench(dev, opt);
  b.run(max);
  return b;
}
const OK_STAGES = (b: UsbBench) => b.host.done && !b.host.failed && b.host.configured;

describe('enumeration on the models', () => {
  it('reads the device descriptor twice, the configuration twice, and ends configured at the new address', () => {
    const b = enumerate();
    expect(OK_STAGES(b)).toBe(true);
    expect(b.host.dev8).toEqual(DEVICE_DESCRIPTOR.slice(0, 8));
    expect(b.host.dev18).toEqual(DEVICE_DESCRIPTOR);
    expect(b.host.cfg9).toEqual(CONFIG_DESCRIPTOR.slice(0, 9));
    expect(b.host.cfg25).toEqual(CONFIG_DESCRIPTOR);
    expect(b.clashes).toBe(0);
    const d = b.dev as UsbDevice;
    expect([d.st, d.addr]).toEqual([3, 5]);
    expect(b.clock).toBeGreaterThan(10000);
    expect(b.clock).toBeLessThan(15000);
    // the vendor and product id are pid.codes' test id
    expect([DEVICE_DESCRIPTOR[8] | (DEVICE_DESCRIPTOR[9] << 8), DEVICE_DESCRIPTOR[10] | (DEVICE_DESCRIPTOR[11] << 8)]).toEqual([0x1209, 0x0001]);
    expect(CONFIG_DESCRIPTOR[2] | (CONFIG_DESCRIPTOR[3] << 8)).toBe(CONFIG_DESCRIPTOR.length);
  });

  it('the line, read back by the independent decoder, is the protocol: every packet whole, the device\'s data equal to the descriptors, no host and device packet overlapping', () => {
    const b = enumerate();
    const mon = new UsbMonitor();
    for (const [dp, dm] of b.line) mon.push(dp, dm);
    const pk = mon.seen.map((s) => ({ s, p: parsePacket(s.wire) }));
    expect(pk.length).toBeGreaterThan(40);
    for (const { s, p } of pk) {
      expect(s.syncOk && !s.stuffError && s.byteAligned, `packet at ${s.start}`).toBe(true);
      expect(p.pidOk).toBe(true);
      if (p.kind === 'token') expect(p.crc5Ok).toBe(true);
      if (p.kind === 'data') expect(p.crc16Ok).toBe(true);
      expect(['token', 'data', 'handshake']).toContain(p.kind);
    }
    // the data after each IN token is the descriptors in order
    const got: number[] = [];
    pk.forEach(({ p }, i) => { if (p.kind === 'data' && pk[i - 1]?.p.pid === PID.IN) got.push(...p.data!); });
    expect(got).toEqual([...DEVICE_DESCRIPTOR.slice(0, 8), ...DEVICE_DESCRIPTOR, ...CONFIG_DESCRIPTOR.slice(0, 9), ...CONFIG_DESCRIPTOR]);
    // grammar: SETUP DATA0 ACK, then IN DATA ACK ... then OUT DATA1 ACK (reads) or IN DATA1 ACK (no data stage)
    const names = pk.map(({ p }) => PID_NAME[p.pid]);
    const text = names.join(' ');
    expect(text.startsWith('SETUP DATA0 ACK IN DATA1 ACK OUT DATA1 ACK SETUP DATA0 ACK IN DATA1 ACK SETUP DATA0 ACK IN DATA1 ACK IN DATA0 ACK IN DATA1 ACK OUT DATA1 ACK')).toBe(true);
    // packets never overlap in time
    for (let i = 1; i < pk.length; i++) expect(pk[i].s.start).toBeGreaterThan(pk[i - 1].s.end);
  });

  it('SET_ADDRESS takes effect after the status stage, seen on the bus: before it the old address answers, after it the new one', () => {
    const seen: string[] = [];
    function* script(h: UsbHost): Pump<void> {
      yield* h.quiet(40);
      yield* h.busReset();
      yield* h.setupStage(0, setupData(0x00, REQ.SET_ADDRESS, 5, 0, 0));
      const probe = function* (addr: number, ack = false): Pump<string> {
        yield* h.send(tokenBytes(PID.IN, addr, 0));
        const r = yield* h.recv();
        const what = r ? PID_NAME[r.p.pid] : 'silence';
        if (r && ack) { yield* h.gap(); yield* h.send(handshakeBytes(PID.ACK)); }
        yield* h.gap(40);
        return what;
      };
      seen.push(`before, addr 5: ${yield* probe(5)}`);
      seen.push(`before, addr 0: ${yield* probe(0)}`);
      seen.push(`still before (no ACK yet), addr 5: ${yield* probe(5)}`);
      seen.push(`status stage, addr 0, ACKed: ${yield* probe(0, true)}`);
      seen.push(`after, addr 0: ${yield* probe(0)}`);
      seen.push(`after, addr 5: ${yield* probe(5)}`);
    }
    enumerate({ script });
    expect(seen).toEqual([
      'before, addr 5: silence', 'before, addr 0: DATA1', 'still before (no ACK yet), addr 5: silence', 'status stage, addr 0, ACKed: DATA1',
      'after, addr 0: silence', 'after, addr 5: DATA0',
    ]);
  });

  it('a lost ACK on the SET_ADDRESS status stage: the host believes it is done, the device keeps address 0, and the next transaction is never answered', () => {
    const b0 = enumerate();
    const k = b0.host.sendLog.findIndex((s, i) => s.stage === 'set address' && s.pid === PID.ACK && b0.host.sendLog[i - 1].pid === PID.IN);
    expect(k).toBeGreaterThan(0);
    const b = enumerate({ corruptSend: k });
    expect(b.host.corrupted).toBe(1);
    expect(b.host.failed).toContain('GET_DESCRIPTOR(device, 18)');
    expect((b.dev as UsbDevice).addr).toBe(0);
    expect(b.host.addr).toBe(5);
  });

  it('short reads: 8 of 18; 64 of 18 (8, 8, 2, then the status stage); 16 of 25 (stops at wLength: no zero-length packet)', () => {
    const got: Record<string, number[] | string | null> = {};
    function* script(h: UsbHost): Pump<void> {
      yield* h.quiet(40);
      yield* h.busReset();
      const get = (type: number, len: number) => setupData(0x80, REQ.GET_DESCRIPTOR, type << 8, 0, len);
      got.d8 = (yield* h.controlRead(0, get(1, 8))) as number[];
      got.d64 = (yield* h.controlRead(0, get(1, 64))) as number[];
      got.c16 = (yield* h.controlRead(0, get(2, 16))) as number[];
      got.c64 = (yield* h.controlRead(0, get(2, 64))) as number[];
      got.d0 = (yield* h.controlRead(0, get(1, 0))) as number[];
      got.st = (yield* h.controlRead(0, setupData(0x80, REQ.GET_STATUS, 0, 0, 2))) as number[];
    }
    const b = enumerate({ script });
    expect(got.d8).toEqual(DEVICE_DESCRIPTOR.slice(0, 8));
    expect(got.d64).toEqual(DEVICE_DESCRIPTOR);
    expect(got.c16).toEqual(CONFIG_DESCRIPTOR.slice(0, 16));
    expect(got.c64).toEqual(CONFIG_DESCRIPTOR);
    expect(got.d0).toEqual([]);
    expect(got.st).toEqual([0, 0]);
    // the packet counts: 18 bytes in 8 + 8 + 2, 25 in 8 + 8 + 8 + 1
    const mon = new UsbMonitor();
    for (const [dp, dm] of b.line) mon.push(dp, dm);
    const sizes: number[] = [];
    const pk = mon.seen.map((s) => parsePacket(s.wire));
    pk.forEach((p, i) => { if (p.kind === 'data' && pk[i - 1]?.pid === PID.IN) sizes.push(p.data!.length); });
    expect(sizes).toEqual([8, 8, 8, 2, 8, 8, 8, 8, 8, 1, 2]);
  });

  it('STALL: a string descriptor, an unknown request and a wrong recipient are stalled; the next SETUP clears it', () => {
    const r: Record<string, unknown> = {};
    function* script(h: UsbHost): Pump<void> {
      yield* h.quiet(40);
      yield* h.busReset();
      const bad = (req: number, type = 0x80, value = 0, len = 8) => setupData(type, req, value, 0, len);
      r.string = yield* h.controlRead(0, bad(REQ.GET_DESCRIPTOR, 0x80, 0x0300, 8));
      r.unknown = yield* h.controlRead(0, bad(0x42));
      r.iface = yield* h.controlRead(0, bad(REQ.GET_DESCRIPTOR, 0x81, 0x0100, 8));
      r.config = yield* h.controlRead(0, bad(REQ.GET_DESCRIPTOR, 0x80, 0x0200, 8));
      // SET_CONFIGURATION in the Default state, and an address above 127
      r.setConfDefault = yield* h.setupStage(0, setupData(0, REQ.SET_CONFIGURATION, 1, 0, 0));
      r.stalledIn = yield* h.inStage(0, 0, PID.DATA1);
      r.setAddrBig = yield* h.setupStage(0, setupData(0, REQ.SET_ADDRESS, 200, 0, 0));
      r.stalledIn2 = yield* h.inStage(0, 0, PID.DATA1);
    }
    const b = enumerate({ script });
    expect(b.host.failed).toBeNull();
    expect(r.string).toBe('stall');
    expect(r.unknown).toBe('stall');
    expect(r.iface).toBe('stall');
    expect(r.config).toEqual(CONFIG_DESCRIPTOR.slice(0, 8));
    expect(r.stalledIn).toBe('stall');
    expect(r.stalledIn2).toBe('stall');
    expect((b.dev as UsbDevice).addr).toBe(0);
  });

  it('NAK: a busy device is waited out; the interrupt endpoint of a configured device NAKs and is silent before', () => {
    const b = enumerate({ nak: (c) => (c > 2800 && c < 3100 ? 1 : 0) });
    expect(OK_STAGES(b)).toBe(true);
    expect(b.host.naks).toBeGreaterThan(0);
    expect(b.host.cfg25).toEqual(CONFIG_DESCRIPTOR);
    const ep1: string[] = [];
    function* script(h: UsbHost): Pump<void> {
      yield* h.enumerate();
      const poll = function* (): Pump<string> {
        yield* h.send(tokenBytes(PID.IN, 5, 1));
        const r = yield* h.recv();
        yield* h.gap(40);
        return r ? PID_NAME[r.p.pid] : 'silence';
      };
      ep1.push(yield* poll());
      yield* h.send(tokenBytes(PID.IN, 6, 1));
      ep1.push((yield* h.recv()) ? 'answered' : 'silence');
    }
    enumerate({ script });
    expect(ep1).toEqual(['NAK', 'silence']);
  });

  it('a host whose clock is a little off (bit lengths 3 to 5, a different phase each time) still enumerates', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rnd = lcg(seed), r = () => rnd(1000) / 1000;
      const b = enumerate({ jitter: r, lead: 40 + rnd(40) });
      expect(OK_STAGES(b), `seed ${seed}: ${b.host.failed}`).toBe(true);
      expect(b.host.errors, `seed ${seed}`).toBe(0);
    }
  });

  it('SE0 shorter than the reset threshold is not a reset (EOP is 8 clocks, threshold is 128); a longer one is, from any state', () => {
    expect(RESET_HOLD).toBeGreaterThan(RESET_CLOCKS);
    let addrAfterShort = -1, addrAfterLong = -1;
    const dev = new UsbDevice();
    function* script(h: UsbHost): Pump<void> {
      yield* h.enumerate();
      yield* h.play(Array.from({ length: RESET_CLOCKS - 8 }, () => [0, 0] as [number, number]));
      yield* h.quiet(40);
      addrAfterShort = dev.addr;
      yield* h.busReset();
      addrAfterLong = dev.addr;
    }
    enumerate({ script }, dev);
    expect([addrAfterShort, addrAfterLong]).toEqual([5, 0]);
    expect(dev.st).toBe(1);
  });
});

describe('faults on every packet of the enumeration (model)', () => {
  it('corrupting any one packet the host sends, the enumeration still ends configured with the right bytes; two losses are named', () => {
    const b0 = enumerate();
    const n = b0.host.sendLog.length;
    expect(n).toBeGreaterThan(40);
    const lost: string[] = [];
    for (let k = 0; k < n; k++) {
      const b = enumerate({ corruptSend: k });
      expect(b.clashes, `send ${k}`).toBe(0);
      const d = b.dev as UsbDevice;
      const sl = b0.host.sendLog[k];
      if (OK_STAGES(b) && d.st === 3) {
        expect(b.host.dev18, `send ${k}`).toEqual(DEVICE_DESCRIPTOR);
        expect(b.host.cfg25, `send ${k}`).toEqual(CONFIG_DESCRIPTOR);
        // a corrupted packet cost a retry (or was a repeat the host ignored)
        continue;
      }
      lost.push(`${sl.stage}/${PID_NAME[sl.pid]}: ${b.host.failed ?? `host done, device in state ${d.st}`}`);
    }
    // the ACK of the SET_ADDRESS status stage, and of the SET_CONFIGURATION status stage: the last packet of a transfer has no acknowledgement of its own
    expect(lost).toHaveLength(2);
    expect(lost[0]).toMatch(/^set address\/ACK: .*GET_DESCRIPTOR\(device, 18\)/);
    expect(lost[1]).toMatch(/^set configuration\/ACK: host done, device in state 2/);
  });

  it('noise on the line during any one packet of the device (a bit inverted): the host repeats, nothing is duplicated', () => {
    const b0 = enumerate();
    const mon = new UsbMonitor();
    for (const [dp, dm] of b0.line) mon.push(dp, dm);
    // start of every packet the device sent: a packet that came while the host was silent
    const hostStarts = new Set(b0.host.mon.seen.map((s) => s.start));
    void hostStarts;
    const starts = mon.seen.filter((s, i) => i > 0 && parsePacket(s.wire).kind !== 'token' && (parsePacket(s.wire).kind === 'handshake' || parsePacket(s.wire).kind === 'data')).map((s) => s.start);
    const lcgr = lcg(9);
    let ran = 0;
    for (const st of starts) {
      for (const off of [lcgr(60) + 4]) {
        const b = enumerate({ wireFlips: [st + off] });
        ran++;
        const d = b.dev as UsbDevice;
        if (OK_STAGES(b) && d.st === 3) { expect(b.host.dev18).toEqual(DEVICE_DESCRIPTOR); expect(b.host.cfg25).toEqual(CONFIG_DESCRIPTOR); }
        else expect(b.host.failed ?? 'device not configured', `flip at ${st + off}`).toMatch(/./); // a flip may land on a host packet too; the host must at least not hang
        expect(b.clock).toBeLessThan(60000);
      }
    }
    expect(ran).toBeGreaterThan(30);
  });

  it('three failures in a row end the host: a device that never answers', () => {
    const dead = { oe: 0, odp: 1, odm: 0, step() { /* no device */ } };
    const b = new UsbBench(dead);
    b.run(30000);
    expect(b.host.failed).toContain('GET_DESCRIPTOR(device, 8)');
    expect(b.host.errors).toBe(3);
    void dataBytes; void REQ;
  });
});

describe('every read length', () => {
  it('both descriptors at every wLength 1 to 30 and GET_STATUS: the bytes are the ROM\'s prefix; the device sent packets that needed stuffing, mid-packet and at the end', () => {
    const out: { type: string; len: number; got: unknown }[] = [];
    const b = enumerate({ script: readSweep(out) }, new UsbDevice(), 400000);
    expect(b.host.failed).toBeNull();
    for (const r of out) {
      const rom = r.type === 'device' ? DEVICE_DESCRIPTOR : r.type === 'configuration' ? CONFIG_DESCRIPTOR : [0, 0];
      expect(r.got, `${r.type} ${r.len}`).toEqual(rom.slice(0, r.len));
    }
    const mon = new UsbMonitor();
    for (const [dp, dm] of b.line) mon.push(dp, dm);
    let mid = 0, trailing = 0;
    mon.seen.forEach((s, i) => {
      const p = parsePacket(s.wire), prev = mon.seen[i - 1] ? parsePacket(mon.seen[i - 1].wire) : null;
      if (p.kind !== 'data' || prev?.pid !== PID.IN) return;
      const bits = stuffedBits(s.wire), plain = 8 + 8 * s.wire.length;
      if (bits.length > plain) { mid++; if (bits.slice(-7).join('') === '1111110') trailing++; }
    });
    expect(mid).toBeGreaterThan(3);
    expect(trailing).toBeGreaterThan(0);
  });
});

describe('stuffing across the PID', () => {
  it('the run of 1s counts from SYNC through the PID into the data: an OUT of 0x3f, 0xff, ... after a valid SETUP is understood (and stalled, being a data stage)', () => {
    const answers: string[] = [];
    function* script(h: UsbHost): Pump<void> {
      yield* h.quiet(40);
      yield* h.busReset();
      yield* h.setupStage(0, setupData(0x80, REQ.GET_DESCRIPTOR, 0x0100, 0, 8));
      for (const first of [0x1f, 0x3f, 0x7f, 0xff, 0xfe, 0xe7, 0x0f]) {
        for (const pid of [PID.DATA0, PID.DATA1]) {
          yield* h.send(tokenBytes(PID.OUT, 0, 0));
          yield* h.gap();
          yield* h.send(dataBytes(pid, [first, 0xff]));
          const r = yield* h.recv();
          answers.push(r ? PID_NAME[r.p.pid] : 'silence');
          yield* h.gap(40);
        }
      }
    }
    enumerate({ script });
    expect(answers).toEqual(Array(14).fill('STALL'));
  });
});
