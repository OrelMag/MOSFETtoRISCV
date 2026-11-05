// The USB primitives (comm/usb.ts) against values that do not come from this repository: tests/fixtures/usb-vectors.txt says where each came from.

import { describe, expect, it } from 'vitest';
import {
  BIT_CLOCKS, CRC16_RESIDUE, CRC5_RESIDUE, UsbMonitor, crc16, crc5Sof, crc5Token, dataBytes, handshakeBytes, nrziSymbols, packetSymbols, parsePacket, PID,
  pidByte, stuffedBits, symbolClocks, tokenBytes,
} from '../src/comm/usb';

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

describe('CRCs and packets against sources', () => {
  it('crc5 of tokens and SOF equal valentyusb\'s doctests', () => {
    expect([crc5Token(0, 0), crc5Token(92, 0), crc5Token(3, 0), crc5Token(56, 4)]).toEqual([0x2, 0x1c, 0xa, 0xb]);
    expect([crc5Sof(1429), crc5Sof(1013)]).toEqual([0x1, 0x5]);
  });
  it('CRC-16/USB check value of "123456789" is B4C8', () => {
    expect(crc16(Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0xb4c8);
  });
  it('known bus bytes: SETUP 2D 00 10, IN 69 00 10, zero-length DATA1 4B 00 00, GET_DESCRIPTOR(device, 64) C3 .. DD 94, ACK D2', () => {
    expect(hex(tokenBytes(PID.SETUP, 0, 0))).toBe('2D 00 10');
    expect(hex(tokenBytes(PID.IN, 0, 0))).toBe('69 00 10');
    expect(hex(dataBytes(PID.DATA1, []))).toBe('4B 00 00');
    expect(hex(dataBytes(PID.DATA0, [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00]))).toBe('C3 80 06 00 01 00 00 40 00 DD 94');
    expect(hex(handshakeBytes(PID.ACK))).toBe('D2');
    expect(pidByte(PID.STALL)).toBe(0x1e);
  });
  it('residues: a packet with its own check bits leaves the register at a constant (spec: CRC16 residual 800D, CRC5 01100, in the bit order of the MSB-first register)', () => {
    // the reflected register holds the bit reversal of the spec's remainders: 0x800D reversed is 0xB001, 01100 reversed is 00110
    expect(CRC16_RESIDUE).toBe(0xb001);
    expect(CRC5_RESIDUE).toBe(0b00110);
    for (const [a, e] of [[0, 0], [5, 1], [127, 15], [92, 0]]) expect(parsePacket(tokenBytes(PID.OUT, a, e))).toMatchObject({ addr: a, ep: e, crc5Ok: true });
  });
  it('NRZI and stuffing equal valentyusb\'s doctests and wrap_packet(ACK)', () => {
    expect(nrziSymbols([...[1, 1], ...[0, 0, 0, 0, 0, 0, 0, 1]])).toBe('JJKJKJKJKK');
    // 'JJ KJKJKJKK' without the space
    expect('JJKJKJKJKK').toBe('JJ KJKJKJKK'.replace(' ', ''));
    // ten 1s: six, a stuffed 0, four more
    expect(nrziSymbols([1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1])).toBe('JJJJJJKKKKK');
    expect(packetSymbols(handshakeBytes(PID.ACK))).toBe('KJKJKJKKJJKJJKKK__J');
  });
  it('stuffing counts SYNC\'s closing 1, stuffs after a trailing run of six, and the monitor undoes it', () => {
    // PID byte FF would not be a PID, but the stuffer takes any bytes: SYNC ends in 1, so five more 1s already need a 0
    const bits = stuffedBits([0x1f]);
    expect(bits.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(bits.slice(8, 15)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    // 0xFC: LSB first 0 0 1 1 1 1 1 1 then the stuffed 0
    expect(stuffedBits([0xfc]).slice(8)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 0]);
    const mon = new UsbMonitor();
    const clocks = [...Array(9).fill([1, 0]), ...symbolClocks(packetSymbols([0xd2, 0xff, 0x3f])), ...Array(9).fill([1, 0])] as [number, number][];
    let got: number[] | undefined;
    for (const [dp, dm] of clocks) { const s = mon.push(dp, dm); if (s) got = s.wire; }
    expect(got).toEqual([0xd2, 0xff, 0x3f]);
    expect(mon.seen[0]).toMatchObject({ stuffError: false, syncOk: true, byteAligned: true });
    expect(BIT_CLOCKS).toBe(4);
  });
  it('the monitor reads runs of 3 and 5 clocks as one bit (a host clock a little off)', () => {
    const wire = tokenBytes(PID.SETUP, 7, 0), syms = packetSymbols(wire);
    const widths = Array.from(syms, (_, i) => (i % 3 === 0 ? 3 : i % 3 === 1 ? 5 : 4));
    const mon = new UsbMonitor();
    let got: number[] | undefined;
    for (const [dp, dm] of [...Array(9).fill([1, 0]), ...symbolClocks(syms, widths), ...Array(9).fill([1, 0])] as [number, number][]) { const s = mon.push(dp, dm); if (s) got = s.wire; }
    expect(got).toEqual(wire);
  });
});
