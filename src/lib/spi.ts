// Chapter 44's SPI in gates: a master (any of the four modes, CS, a done flag) and a target with a 256-byte memory behind the
// 25-series command set. Both are written with lib/rtl.ts, so they are NAND gates and the library's flip-flops in boxes of their
// own; comm/spi.ts holds the models the tests compare them with every cycle.

import { Rtl } from './rtl';
import { bigRam } from './bigmem';
import { define } from './define';
import { edgeKind, peerMiso, type SpiMode } from '../comm/spi';
import { simulate } from '../sim/harness';
import { pack } from '../sim/values';
import type { ComponentDef } from '../sim/types';

let master: ComponentDef | undefined;

/** The master: a prescaler (SCLK edges every second clock), a five-bit edge counter, one shift register both ways, CS = not busy. */
export function spiMaster(): ComponentDef {
  if (master) return master;
  const m = new Rtl({
    id: 'spi_master', name: 'SPI master', category: 'sequential', label: 'SPI master',
    summary: 'Shifts one byte out on MOSI while one comes in on MISO, in any of the four SPI modes (CPOL, CPHA). Every SCLK edge is two system clocks after the last; CS is low while busy or while hold = 1 (one transaction of several bytes), one half period before the first edge and after the last.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), start = m.input('start'), hold = m.input('hold'), cpol = m.input('cpol'), cpha = m.input('cpha');
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
  m.output('sclk', sclk); m.output('mosi', mo); m.output('cs_n', m.nor(busy, hold)); m.outputBus('rx', sh); m.output('busy', busy); m.output('done', done);
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

let pair: ComponentDef | undefined;

/**
 * Chapter 44's scene: one master and two memories on the four shared wires (SCLK, MOSI, MISO) and a chip select each. `sel` picks
 * which CS follows the master's; mode3 sets CPOL = CPHA (the memories take mode 0 or 3).
 */
export function spiPair(): ComponentDef {
  if (pair) return pair;
  const m = new Rtl({
    id: 'spi_pair', name: 'SPI master with two memories', category: 'cell', label: 'SPI bus',
    summary: 'A master and two 256-byte SPI memories on SCLK, MOSI and MISO, with a chip select each: sel chooses which one is addressed. MISO is the OR of the two (a real part lets go of the line while its CS is high).',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), start = m.input('start'), hold = m.input('hold'), sel = m.input('sel'), mode3 = m.input('mode3');
  const tx = m.inputBus('tx', 8);
  const miso = m.fwd('miso_in');
  const [sclk, mosi, csn, rxb, busy, done] = m.part(spiMaster(), [clk, rst, start, hold, mode3, mode3, m.bus(tx), miso], 'master', 'master');
  const cs0 = m.name(m.or(csn, sel), 'cs0_n'), cs1 = m.name(m.or(csn, m.not(sel)), 'cs1_n');
  const d0 = m.part(spiDevice(), [sclk, cs0, mosi], 'memory 0', 'mem0')[0], d1 = m.part(spiDevice(), [sclk, cs1, mosi], 'memory 1', 'mem1')[0];
  m.drive(miso, m.name(m.or(d0, d1), 'miso'));
  m.outputBus('rx', m.unbus(rxb, 8)); m.output('busy', busy); m.output('done', done);
  m.output('sclk', sclk); m.output('mosi', mosi); m.output('miso', miso); m.output('cs0_n', cs0); m.output('cs1_n', cs1);
  pair = m.build();
  return pair;
}

/** One clock of a recorded master transfer. */
export interface MasterClock { sclk: number; mosi: number; miso: number; cs_n: number }
export interface MasterRun { clocks: MasterClock[]; rx: number; /** clock indices of the SCLK edges, in order */ edges: number[] }

/**
 * The gate-level master driving one byte in `mode` against a peer that follows the mode's rules (comm/spi.ts peerMiso): every
 * clock's SCLK, MOSI, MISO and CS, read off the circuit. Two clocks of idle first and last.
 */
export function masterRun(mode: SpiMode, tx: number, peer: number): MasterRun {
  const g = simulate(spiMaster());
  const out = (p: string) => pack(g.getBits(g.design.root.ports[p]));
  const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) g.setInput(k, x); g.settle(); };
  const clocks: MasterClock[] = [], edges: number[] = [];
  let changes = 0, edgeNo = 0, prev: number = mode.cpol, miso = peerMiso(mode, peer, 0);
  set({ rst: 1, start: 0, hold: 0, cpol: mode.cpol, cpha: mode.cpha, tx: 0, miso });
  set({ clk: 1 }); set({ clk: 0 }); set({ rst: 0 });
  const rec = () => clocks.push({ sclk: out('sclk'), mosi: out('mosi'), miso, cs_n: out('cs_n') });
  rec(); rec();
  set({ tx, start: 1 });
  for (let c = 0; c < 200; c++) {
    set({ clk: 1 }); set({ clk: 0 }); set({ start: 0 });
    const sc = out('sclk');
    if (sc !== prev) {
      if (edgeKind(mode, edgeNo).sample === false) changes++;
      edges.push(clocks.length);
      edgeNo++; prev = sc;
      miso = peerMiso(mode, peer, changes);
      set({ miso });
    }
    rec();
    if (out('done')) break;
  }
  rec(); rec();
  return { clocks, rx: out('rx'), edges };
}
