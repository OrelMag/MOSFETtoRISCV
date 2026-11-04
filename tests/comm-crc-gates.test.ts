// Chapter 47's CRC gates against the golden model (comm/crc.ts): the next-state networks against their spec, and the
// register, serial and byte-wide, every output after every clock edge on seeded random messages, ending at the CRC-32
// that zlib computes. The costs the chapter quotes are read from stats here.
import { describe, expect, it } from 'vitest';
import { crc32 as zcrc32 } from 'node:zlib';
import { bitsLsb, CRC32_REFLECTED, CRC32_INIT, CRC32_RESIDUE, crc32, crc32Register, fcsBytes, stepBit, stepBits, xorPlan, nextMatrix } from '../src/comm/crc';
import { crcNext, crcUnit } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { checkSpec, lcg, out, set, tick } from './util';
import { tick as yieldTick } from './yieldtick';

describe('CRC next-state networks', () => {
  it('serial and byte-wide, plain and shared, match their spec', () => {
    for (const [w, share] of [[1, false], [8, false], [8, true], [4, false]] as const) checkSpec(crcNext(32, CRC32_REFLECTED, w, share), 300);
    checkSpec(crcNext(8, 0xe0, 8, false), 300);
  });
  it('the serial network is the textbook shift register: one XOR a tap, plus one for the feedback', () => {
    const taps = (CRC32_REFLECTED >>> 0).toString(2).split('1').length - 1; // 14 ones
    expect(taps).toBe(14);
    expect(xorPlan(nextMatrix(32, CRC32_REFLECTED, 1), 33, true).gates).toBe(taps);
  });
  it('costs: serial, byte-wide, byte-wide shared', () => {
    const s = stats(crcNext(32, CRC32_REFLECTED, 1)).nands, b = stats(crcNext(32, CRC32_REFLECTED, 8, false)).nands, bs = stats(crcNext(32, CRC32_REFLECTED, 8, true)).nands;
    // eslint-disable-next-line no-console
    console.log('crc next NANDs serial/byte/shared', s, b, bs, 'depth', logicDepth(crcNext(32, CRC32_REFLECTED, 1)), logicDepth(crcNext(32, CRC32_REFLECTED, 8, false)), logicDepth(crcNext(32, CRC32_REFLECTED, 8, true)));
    expect(b).toBeGreaterThan(s);
    expect(bs).toBeLessThan(b);
  });
});

describe('CRC register', () => {
  it('serial: every cycle equals the model, and the message ends at zlib.crc32', async () => {
    const r = lcg(47), sim = simulate(crcUnit(32, CRC32_REFLECTED, 1));
    for (let m = 0; m < 6; m++) {
      const msg = Uint8Array.from({ length: 1 + r(12) }, () => r(256));
      set(sim, { init: 1, en: 0, d: 0 }); tick(sim); set(sim, { init: 0 });
      let q = CRC32_INIT;
      expect(out(sim, 'q')).toBe(q);
      for (const b of bitsLsb(msg)) {
        set(sim, { d: b, en: 1 }); tick(sim);
        q = stepBit(q, b);
        expect(out(sim, 'q')).toBe(q);
        expect(out(sim, 'fcs')).toBe((~q) >>> 0);
      }
      set(sim, { en: 0 });
      expect(out(sim, 'fcs')).toBe(zcrc32(msg));
      await yieldTick();
    }
  });
  it('the received frame with its FCS leaves the register at the residue', () => {
    const sim = simulate(crcUnit(32, CRC32_REFLECTED, 1)), msg = Uint8Array.from('hello, wire', (c) => c.charCodeAt(0));
    set(sim, { init: 1, en: 0, d: 0 }); tick(sim); set(sim, { init: 0, en: 1 });
    for (const b of bitsLsb([...msg, ...fcsBytes(crc32(msg))])) { set(sim, { d: b }); tick(sim); }
    expect(out(sim, 'q')).toBe(CRC32_RESIDUE);
  });
  it('byte-wide (plain and shared): every cycle equals the model, and ends at zlib.crc32', async () => {
    for (const share of [false, true]) {
      const r = lcg(48), sim = simulate(crcUnit(32, CRC32_REFLECTED, 8, share));
      for (let m = 0; m < 4; m++) {
        const msg = Uint8Array.from({ length: 1 + r(20) }, () => r(256));
        set(sim, { init: 1, en: 0, d: 0 }); tick(sim); set(sim, { init: 0 });
        let q = CRC32_INIT;
        for (const b of msg) {
          set(sim, { d: b, en: 1 }); tick(sim);
          q = stepBits(q, b, 8);
          expect(out(sim, 'q')).toBe(q);
        }
        expect(out(sim, 'fcs')).toBe(zcrc32(msg));
        expect(q).toBe(crc32Register(msg));
        await yieldTick();
      }
    }
  });
  it('en low holds the register', () => {
    const sim = simulate(crcUnit(32, CRC32_REFLECTED, 8));
    set(sim, { init: 1, en: 0, d: 0 }); tick(sim); set(sim, { init: 0, d: 0x5a });
    tick(sim); tick(sim);
    expect(out(sim, 'q')).toBe(CRC32_INIT);
  });
  it('costs of the register: serial and byte-wide', () => {
    const a = stats(crcUnit(32, CRC32_REFLECTED, 1)), b = stats(crcUnit(32, CRC32_REFLECTED, 8));
    // eslint-disable-next-line no-console
    console.log('crc unit NANDs serial/byte', a.nands, b.nands, 'transistors', a.transistors, b.transistors);
    expect(b.nands).toBeGreaterThan(a.nands);
  });
});
