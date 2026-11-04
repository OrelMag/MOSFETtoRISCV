import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BROADCAST, ETHERTYPE_IPV4, frameBody, frameBytes, GAP_BYTES, isGroup, MAX_FRAME, MIN_FRAME, MIN_PAYLOAD, parseFrame, wireBytes } from '../src/comm/ethframe';
import { pcapFile, PCAP_MAGIC, readPcap } from '../src/comm/pcap';

const A = [2, 0, 0, 0, 0, 1], B = [2, 0, 0, 0, 0, 2];

describe('Ethernet II frames', () => {
  it('pads to the minimum and appends the FCS least significant byte first, as zlib computes it', () => {
    const f = frameBytes({ dst: B, src: A, type: ETHERTYPE_IPV4, payload: [1, 2, 3] });
    expect(f.length).toBe(MIN_FRAME);
    const body = f.slice(0, -4), fcs = zlibCrc32(Uint8Array.from(body));
    expect(f.slice(-4)).toEqual([fcs & 255, (fcs >>> 8) & 255, (fcs >>> 16) & 255, fcs >>> 24]);
  });
  it('a long payload is not padded, and the limits are the published ones', () => {
    expect(MIN_PAYLOAD).toBe(46);
    expect(frameBytes({ dst: B, src: A, type: 0x0800, payload: new Array(1500).fill(7) }).length).toBe(MAX_FRAME);
    expect(() => frameBody({ dst: B, src: A, type: 0x0800, payload: new Array(1501).fill(7) })).toThrow();
    expect(GAP_BYTES).toBe(12);
  });
  it('parses back, and a flipped bit fails the FCS', () => {
    const f = frameBytes({ dst: BROADCAST, src: A, type: 0x0806, payload: new Array(46).fill(9) });
    const p = parseFrame(f);
    expect(p).toMatchObject({ dst: BROADCAST, src: A, type: 0x0806, fcsOk: true, runt: false, tooLong: false });
    expect(p.payload.length).toBe(46);
    f[20] ^= 4;
    expect(parseFrame(f).fcsOk).toBe(false);
    expect(parseFrame(f.slice(0, 40)).runt).toBe(true);
  });
  it('the wire form starts with seven 0x55 and the SFD; broadcast is a group address', () => {
    expect(wireBytes({ dst: B, src: A, type: 0x0800, payload: [] }).slice(0, 8)).toEqual([0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0xd5]);
    expect(isGroup(BROADCAST)).toBe(true);
    expect(isGroup(A)).toBe(false);
  });
});

describe('pcap files', () => {
  it('writes the classic header, byte for byte', () => {
    const b = pcapFile([]);
    expect([...b]).toEqual([0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 1, 0, 0, 0]);
    expect(new DataView(b.buffer).getUint32(0, true)).toBe(PCAP_MAGIC);
  });
  it('round-trips frames and their times', () => {
    const f = frameBody({ dst: B, src: A, type: 0x0800, payload: [1] });
    const back = readPcap(pcapFile([{ us: 0, bytes: f }, { us: 2_500_001, bytes: [1, 2, 3] }]));
    expect(back.map((x) => x.us)).toEqual([0, 2_500_001]);
    expect(Array.from(back[0].bytes)).toEqual(f);
    expect(Array.from(back[1].bytes)).toEqual([1, 2, 3]);
  });
});
