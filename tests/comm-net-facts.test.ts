// The numbers chapter 50 quotes about its ping come from one place (comm/stack/netfacts.ts: the ping's size and netcosts.json). This pins them against
// the frames, the NIC's DMA counts measured on the gates, and the pins' edges, and checks that the prose says what they say.
import { describe, expect, it } from 'vitest';
import { chNetwork } from '../src/chapters/ch-comm-net';
import { icmpEchoFrame, ip4, onesSum } from '../src/comm/netframes';
import { PING_DATA, pingApp } from '../src/comm/stack/apps';
import NET from '../src/comm/stack/netcosts.json';
import { A_ECHO_RX, A_ECHO_TX, B_BUSY_PERCENT, B_ECHO, BYTES_PERCENT, dmaRx, dmaTx, MIN_FRAME_TIME, PING_DMA, PING_FRAME, PING_FRAME_TIME, PING_SERIAL, roundTrip } from '../src/comm/stack/netfacts';

const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');

describe('the ping frame', () => {
  it('is the 74 bytes the program sends: 14 + 20 + 8 + 32', () => {
    const f = icmpEchoFrame({ srcMac: [2, 0, 0, 0, 0, 1], dstMac: [2, 0, 0, 0, 0, 2], src: ip4(10, 0, 0, 1), dst: ip4(10, 0, 0, 2), id: 1, ident: 0x1234, seq: 1, data: Array.from({ length: PING_DATA }, (_, i) => 16 + i) });
    expect(f.bytes.length).toBe(74);
    expect(PING_FRAME).toBe(74);
    expect(pingApp(1)).toBe(pingApp(1, PING_DATA));
    expect(pingApp(1)).toContain(`icmp_echo(target, 0x1234, seq, ${PING_DATA})`);
  });
  it('holds one link for 2 752 clocks, 3 136 with the gap; a minimum frame 2 688', () => {
    expect(PING_SERIAL).toBe(2752);
    expect(PING_FRAME_TIME).toBe(3136);
    expect(MIN_FRAME_TIME).toBe(2688);
  });
  it('costs the NIC 23 DMA transactions to send and 22 to receive, and the measured counts of both computers are the sum over their frames', () => {
    expect(PING_DMA.send.reads + PING_DMA.send.writes).toBe(23);
    expect(PING_DMA.receive.reads + PING_DMA.receive.writes).toBe(22);
    const sum = (list: { reads: number; writes: number }[]) => list.reduce((s, d) => ({ reads: s.reads + d.reads, writes: s.writes + d.writes }), { reads: 0, writes: 0 });
    // A sends an ARP request (42 bytes) and the echo, receives the ARP reply and the echo reply; B the mirror image
    expect(NET.dma.a).toEqual(sum([dmaTx(42), dmaTx(PING_FRAME), dmaRx(42), dmaRx(PING_FRAME)]));
    expect(NET.dma.b).toEqual(sum([dmaRx(42), dmaTx(42), dmaRx(PING_FRAME), dmaTx(PING_FRAME)]));
    // the 50-byte frame the chapter once assumed would not have fitted
    expect(NET.dma.a).not.toEqual(sum([dmaTx(42), dmaTx(50), dmaRx(42), dmaRx(50)]));
  });
});

describe('where the round trip goes', () => {
  const rt = roundTrip();
  it('four serializations of the ping frame, measured on the transmit and carrier pins', () => {
    const w = NET.wire as unknown as Record<string, [number, number][]>;
    for (const k of ['aTx', 'toB', 'bTx', 'toA']) expect(w[k][1][1] - w[k][1][0], k).toBe(PING_SERIAL);
    expect(rt.cable).toBe(4 * PING_SERIAL);
    expect(rt.cable).toBe(11008);
  });
  it('adds up exactly: cable, switch turnaround and software are the whole round trip', () => {
    expect(rt.cable + rt.turnaround + rt.software).toBe(NET.rtt);
    expect(rt.aSend + rt.bReply + rt.aReceive).toBe(rt.software);
    expect(rt.bNotice + rt.bWork).toBe(rt.bReply);
    expect(rt.turnaround).toBe(8);
    expect([rt.aSend, rt.bNotice, rt.bWork, rt.aReceive].every((x) => x > 0)).toBe(true);
  });
  it('the cost table\'s windows run past the doorbell and the timestamp, so their sum exceeds the software share', () => {
    expect(rt.tails).toBe(A_ECHO_TX.total.clocks + B_ECHO.total.clocks + A_ECHO_RX.total.clocks);
    expect(rt.tails).toBeGreaterThan(rt.software);
    expect(rt.aReceive).toBeLessThan(A_ECHO_RX.total.clocks);
  });
  it('B is busy 60 % of a frame time, and 48 % of an echo\'s clocks are the byte helpers', () => {
    expect(B_BUSY_PERCENT).toBe(60);
    expect(BYTES_PERCENT).toBe(48);
  });
});

describe('the checksum\'s blind spots', () => {
  const block = (w: number[]) => w.flatMap((x) => [x >> 8, x & 255]);
  it('a swap of the bytes of 0x00ff is caught; 0x0000 for 0xffff and two swapped words are not', () => {
    expect(onesSum(block([0x1234, 0x00ff]))).not.toBe(onesSum(block([0x1234, 0xff00])));
    expect(onesSum(block([0x1234, 0x0000, 0x00ff]))).toBe(onesSum(block([0x1234, 0xffff, 0x00ff])));
    expect(onesSum(block([0x1234, 0x5678]))).toBe(onesSum(block([0x5678, 0x1234])));
  });
});

describe('what the chapter says', () => {
  const text = (): string => {
    const parts: string[] = [];
    const walk = (o: unknown, seen = new Set<unknown>()) => {
      if (typeof o === 'string') parts.push(o);
      else if (o && typeof o === 'object' && !seen.has(o)) { seen.add(o); for (const v of Object.values(o)) walk(v, seen); }
    };
    walk(chNetwork);
    return parts.join('\n');
  };
  it('uses the ping frame\'s numbers everywhere and none of the 50-byte ones', () => {
    const t = text();
    expect(t).not.toMatch(/50-byte|2 688 clocks of frames|17 transactions|18 to receive|more than half|thirty lines|three quarters/);
    expect(t).toContain(n0(PING_FRAME_TIME));
    expect(t).toContain('23 transactions to send a 74-byte frame, 22 to receive it');
    expect(t).toContain(`${B_BUSY_PERCENT} %`);
    expect(t).toContain(`${BYTES_PERCENT} %`);
    expect(t).toContain(n0(rt0().cable));
  });
  it('says the ICMP layer does not learn from a packet\'s source', () => {
    expect(text()).not.toContain('from this very packet');
    expect(text()).toContain('never learn from a packet');
  });
});
const rt0 = roundTrip;
