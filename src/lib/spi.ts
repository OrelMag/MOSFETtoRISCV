// Chapter 44's SPI in gates: a master (any of the four modes, CS, a done flag) and a target with a 256-byte memory behind the
// 25-series command set. Both are written with lib/rtl.ts, so they are NAND gates and the library's flip-flops in boxes of their
// own; comm/spi.ts holds the models the tests compare them with every cycle.

import { Rtl, type Sig } from './rtl';
import { bigRam } from './bigmem';
import { define } from './define';
import type { ComponentDef } from '../sim/types';

let master: ComponentDef | undefined;

/** The master: a prescaler (SCLK edges every second clock), a five-bit edge counter, one shift register both ways, CS = not busy. */
export function spiMaster(): ComponentDef {
  if (master) return master;
  const m = new Rtl({
    id: 'spi_master', name: 'SPI master', category: 'sequential', label: 'SPI master',
    summary: 'Shifts one byte out on MOSI while one comes in on MISO, in any of the four SPI modes (CPOL, CPHA). Every SCLK edge is two system clocks after the last; CS is low while busy, one half period before the first edge and after the last.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), start = m.input('start'), cpol = m.input('cpol'), cpha = m.input('cpha');
  const tx = m.inputBus('tx', 8), miso = m.input('miso');
  const rstn = m.not(rst);
  const busy = m.reg(clk, 'busy'), ph = m.reg(clk, 'ph'), done = m.reg(clk, 'done'), sclk = m.reg(clk, 'sclk_q'), mo = m.reg(clk, 'mo');
  const cnt = [0, 1, 2, 3, 4].map((i) => m.reg(clk, `cnt${i}`));
  const sh = tx.map((_, i) => m.reg(clk, `sh${i}`));
  const { tick, edge, endt, bz } = m.scope('div', 'prescaler, edge counter', () => {
    const tick = m.name(m.and(busy, ph), 'tick');
    const tail = cnt[4];
    const edge = m.name(m.and(tick, m.not(tail)), 'edge');
    const endt = m.name(m.and(tick, tail), 'endt');
    const bz = m.name(m.and(busy, rstn), 'bz');
    m.setD(ph, m.and(bz, m.not(ph)));
    const up = m.inc(cnt);
    cnt.forEach((c, i) => m.setD(c, m.and(bz, m.mux(tick, c, up[i]))));
    return { tick, edge, endt, bz };
  });
  void tick; void bz;
  const { load } = m.scope('ctl', 'busy, SCLK, done', () => {
    const load = m.name(m.and(m.not(busy), start), 'load');
    m.setD(busy, m.and(rstn, m.mux(busy, start, m.not(endt))));
    m.setD(done, m.and(rstn, endt));
    m.setD(sclk, m.and(rstn, m.mux(busy, cpol, m.mux(edge, sclk, m.not(sclk)))));
    return { load };
  });
  m.scope('shift', 'shift register, MOSI', () => {
    const sample = m.name(m.and(edge, m.xnor(cnt[0], cpha)), 'sample');
    const change = m.name(m.and(edge, m.xor(cnt[0], cpha)), 'change');
    sh.forEach((q, i) => {
      const shin = i === 0 ? miso : sh[i - 1];
      m.setD(q, m.and(rstn, m.mux(load, m.mux(sample, q, shin), tx[i])));
    });
    m.setD(mo, m.and(rstn, m.mux(load, m.mux(change, mo, sh[7]), m.and(tx[7], m.not(cpha)))));
  });
  m.output('sclk', sclk); m.output('mosi', mo); m.output('cs_n', m.not(busy)); m.outputBus('rx', sh); m.output('busy', busy); m.output('done', done);
  master = m.build();
  return master;
}

let device: ComponentDef | undefined;

/**
 * The target: 256 bytes behind the 25-series command set in mode 0 or 3 (the two sample on the same edge). Everything inside is
 * clocked by SCLK itself, rising for what it samples and falling for what it changes, and reset while CS is high; there is no
 * system clock. MISO is 0 while CS is high (a real part lets go of the line there; the switch-level bus of chapters 5 and 44 can show that).
 */
export function spiDevice(): ComponentDef {
  if (device) return device;
  const m = new Rtl({
    id: 'spi_device', name: 'SPI memory', category: 'memory', label: 'SPI memory 256 B',
    summary: '256 bytes behind an SPI port: command 0x03 reads from an address on, 0x02 writes, address and data auto-increment while CS stays low. Clocked by SCLK alone: sampled on the rising edge, shifted out on the falling edge.',
  });
  const sclk = m.input('sclk', { clock: true }), csn = m.input('cs_n'), mosi = m.input('mosi');
  const cs = m.not(csn);
  const nsclk = m.not(sclk);
  const cnt = [0, 1, 2].map((i) => m.regR(sclk, cs, `bcnt${i}`));
  const sh = Array.from({ length: 8 }, (_, i) => m.regR(sclk, cs, `rsh${i}`));
  const any = m.regR(sclk, cs, 'any');
  const A = m.regR(nsclk, cs, 'A'), B = m.regR(nsclk, cs, 'B'), rd = m.regR(nsclk, cs, 'rd'), wr = m.regR(nsclk, cs, 'wr');
  const addr = Array.from({ length: 8 }, (_, i) => m.regR(nsclk, cs, `addr${i}`));
  const osh = Array.from({ length: 8 }, (_, i) => m.regR(nsclk, cs, `osh${i}`));
  m.scope('in', 'bit counter, input shift', () => {
    const up = m.inc(cnt);
    cnt.forEach((c, i) => m.setD(c, up[i]));
    sh.forEach((q, i) => m.setD(q, i === 0 ? mosi : sh[i - 1]));
    m.setD(any, m.const(1));
  });
  const bc = m.scope('byte', 'byte done?', () => m.name(m.and(m.not(m.orN(cnt)), any), 'bc'));
  const { c0, c1, c2 } = m.scope('state', 'command, address, data', () => {
    const c0 = m.name(m.and(bc, m.not(A)), 'c_cmd');
    const c1 = m.name(m.and(m.and(bc, A), m.not(B)), 'c_adr');
    const c2 = m.name(m.and(bc, B), 'c_dat');
    m.setD(A, m.or(A, bc));
    m.setD(B, m.or(B, m.and(bc, A)));
    m.setD(rd, m.mux(c0, rd, m.eqConst(sh, 0x03)));
    m.setD(wr, m.mux(c0, wr, m.eqConst(sh, 0x02)));
    return { c0, c1, c2 };
  });
  void c0;
  const { anext } = m.scope('addr', 'address, +1', () => {
    const anext = m.inc(addr);
    addr.forEach((q, i) => m.setD(q, m.mux(c2, m.mux(c1, q, sh[i]), anext[i])));
    return { anext };
  });
  const wsel = m.and(c2, wr);
  const mem = m.scope('mem', '256 × 8 memory', () => {
    const ra = sh.map((s, i) => m.mux(B, s, anext[i]));
    const a = addr.map((q, i) => m.mux(wsel, ra[i], q));
    const out = m.part(bigRam(8, 8), [m.bus(a), m.bus(sh), wsel, nsclk]);
    return m.unbus(out[0], 8);
  });
  m.scope('out', 'output shift register', () => {
    osh.forEach((q, i) => m.setD(q, m.mux(bc, i === 0 ? m.const(0) : osh[i - 1], mem[i])));
  });
  m.output('miso', m.and(m.and(osh[7], rd), B));
  device = m.build();
  return device;
}
export { define };
