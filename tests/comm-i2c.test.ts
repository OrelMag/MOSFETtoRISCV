// Chapter 44's I²C: the gate-level controller and target against their models, every output after every clock, on a bus
// that is a wired AND of whoever pulls a line low, in seeded random sessions (ACK, NACK, an address nobody has, stretching,
// arbitration lost at every bit of the address).

import { describe, expect, it } from 'vitest';
import { I2cController, I2cTarget, READ, START, STOP, WRITE } from '../src/comm/i2c';
import { i2cController, i2cTarget } from '../src/lib/i2c';
import { simulate } from '../src/sim/harness';
import { lcg, out, set } from './util';
import { tick as yieldTick } from './yieldtick';

type Cmd = [number, number];
const addrW = (a: number): Cmd => [WRITE, a << 1], addrR = (a: number): Cmd => [WRITE, (a << 1) | 1];

/** One controller (gates and model) and any number of targets on a wired-AND bus; every clock compares gates with models. */
async function session(script: Cmd[], opt: { targets: { adr: number; stretch?: number }[]; ctls?: number; seed?: number; limit?: number }) {
  const nCtl = opt.ctls ?? 1;
  const gc = Array.from({ length: nCtl }, () => simulate(i2cController())), mc = Array.from({ length: nCtl }, () => new I2cController());
  const gt = opt.targets.map(() => simulate(i2cTarget())), mt = opt.targets.map(() => new I2cTarget());
  const scripts: Cmd[][] = nCtl === 1 ? [script] : (script as unknown as Cmd[][]);
  const idx = scripts.map(() => 0), last = scripts.map(() => -1);
  let sda = 1, scl = 1;
  const log = { acks: [] as number[], reads: [] as number[], lost: [] as number[] };
  for (let c = 0; c < (opt.limit ?? 3000); c++) {
    const rst = c === 0 ? 1 : 0;
    const o = { sda: [] as number[], scl: [] as number[] };
    for (let k = 0; k < nCtl; k++) {
      const ready = mc[k].out.ready;
      let go = 0, cmd = 0, din = 0;
      if (!rst && ready && idx[k] < scripts[k].length && !(mc[k].lost && scripts[k][idx[k]][0] !== START)) { go = 1; [cmd, din] = scripts[k][idx[k]++]; }
      if (go && last[k] === READ) log.reads.push(mc[k].out.dout); // the byte just read: the next command overwrites the shift register
      if (go) last[k] = cmd;
      const i = { rst, go, cmd, din, sda_i: sda, scl_i: scl };
      set(gc[k], i); set(gc[k], { clk: 1 }); set(gc[k], { clk: 0 });
      mc[k].step(i);
      const mo = mc[k].out;
      for (const key of ['ready', 'dout', 'ack', 'lost', 'sda_o', 'scl_o'] as const) expect(out(gc[k], key), `ctl${k} ${key} @${c}`).toBe(mo[key]);
      o.sda.push(mo.sda_o); o.scl.push(mo.scl_o);
    }
    for (let t = 0; t < gt.length; t++) {
      const i = { rst, sda_i: sda, scl_i: scl, adr: opt.targets[t].adr, stretch: opt.targets[t].stretch ?? 0 };
      set(gt[t], i); set(gt[t], { clk: 1 }); set(gt[t], { clk: 0 });
      mt[t].step(i);
      const mo = mt[t].out;
      for (const key of ['sda_o', 'scl_o'] as const) expect(out(gt[t], key), `tgt${t} ${key} @${c}`).toBe(mo[key]);
      o.sda.push(mo.sda_o); o.scl.push(mo.scl_o);
    }
    sda = o.sda.some((x) => x) ? 0 : 1;
    scl = o.scl.some((x) => x) ? 0 : 1;
    if (c % 150 === 0) await yieldTick();
    if (mc.every((m, k) => (m.out.ready && idx[k] >= scripts[k].length) || m.lost) && c > 8 && mc.every((m) => m.out.ready)) { for (let z = 0; z < 6; z++) { /* settle */ } break; }
  }
  return { mc, mt, log };
}

describe('I²C controller and target (gates against models)', () => {
  it('writes a register, sets the pointer, reads it back with a repeated START, and ACKs and NACKs', async () => {
    const { mc, mt, log } = await session([
      [START, 0], addrW(0x50), [WRITE, 1], [WRITE, 0xa7], [STOP, 0],
      [START, 0], addrW(0x50), [WRITE, 1], [START, 0], addrR(0x50), [READ, 0], [READ, 1], [STOP, 0],
    ], { targets: [{ adr: 0x50 }] });
    expect(mt[0].mem[1]).toBe(0xa7);
    expect(log.reads).toEqual([0xa7, 0]); // register 1, then register 2 (the pointer advanced on the ACK)
    expect(mc[0].lost).toBe(0);
  });
  it('an address nobody has is NACKed, and the target stays out of the rest of the frame', async () => {
    const { mc, mt } = await session([[START, 0], addrW(0x2a), [WRITE, 3], [WRITE, 0x11], [STOP, 0]], { targets: [{ adr: 0x50 }] });
    expect(mc[0].ack).toBe(0);
    expect(mt[0].mem).toEqual([0, 0, 0, 0]);
  });
  it('a target that stretches SCL holds the frame, the data arrive unharmed', async () => {
    const { log } = await session([
      [START, 0], addrW(0x51), [WRITE, 2], [WRITE, 0x5c], [START, 0], addrW(0x51), [WRITE, 2], [START, 0], addrR(0x51), [READ, 1], [STOP, 0],
    ], { targets: [{ adr: 0x51, stretch: 5 }] });
    expect(log.reads).toEqual([0x5c]);
  });
  it('two targets on one bus: each answers only to its own address', async () => {
    const { mt } = await session([
      [START, 0], addrW(0x50), [WRITE, 0], [WRITE, 0x01], [START, 0], addrW(0x51), [WRITE, 0], [WRITE, 0x02], [STOP, 0],
    ], { targets: [{ adr: 0x50 }, { adr: 0x51 }] });
    expect(mt[0].mem[0]).toBe(1);
    expect(mt[1].mem[0]).toBe(2);
  });
});

describe('I²C arbitration', () => {
  it('two controllers start together: the one that sends a 1 where the other sends a 0 loses in that bit, the winner finishes', async () => {
    for (let bit = 0; bit < 7; bit++) {
      const a = 0x50, b = a ^ (1 << (6 - bit)); // differ first at address bit `bit` (MSB first); the higher address loses
      const win = Math.min(a, b), lose = Math.max(a, b);
      const sc = (x: number): Cmd[] => [[START, 0], addrW(x), [WRITE, 0], [WRITE, 0x3c], [STOP, 0]];
      const { mc, mt } = await session([sc(win), sc(lose)] as unknown as Cmd[], { targets: [{ adr: win }], ctls: 2 });
      expect(mc[0].lost, `winner @${bit}`).toBe(0);
      expect(mc[1].lost, `loser @${bit}`).toBe(1);
      expect(mt[0].mem[0], `data @${bit}`).toBe(0x3c);
    }
  });
});

describe('seeded random sessions', () => {
  it('random scripts against random targets, gates equal models on every clock', async () => {
    const rnd = lcg(11);
    for (let s = 0; s < 3; s++) {
      const adr = 0x40 + rnd(8);
      const script: Cmd[] = [[START, 0]];
      for (let k = 0; k < 4; k++) {
        const to = rnd(5) === 0 ? adr ^ 1 : adr;
        script.push(addrW(to), [WRITE, rnd(4)], [WRITE, rnd(256)]);
        if (rnd(2)) script.push([START, 0], addrR(to), [READ, 0], [READ, 1]);
        script.push([START, 0]);
      }
      script.push([STOP, 0]);
      await session(script, { targets: [{ adr, stretch: rnd(4) }], limit: 6000 });
    }
  });
});
