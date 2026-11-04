// Chapter 44's SPI in gates: a master (any of the four modes, CS, a done flag) and a target with a 256-byte memory behind the
// 25-series command set. Both are written with lib/rtl.ts, so they are NAND gates and the library's flip-flops in boxes of their
// own; comm/spi.ts holds the models the tests compare them with every cycle.

import { symbolGeom } from '../sim/geometry';
import { OR, NOT } from './gates';
import { TIE0 } from './transistors';
import { Rtl } from './rtl';
import { bigRam } from './bigmem';
import { define } from './define';
import { edgeKind, peerMiso, type SpiMode } from '../comm/spi';
import { simulate } from '../sim/harness';
import { pack } from '../sim/values';
import type { ComponentDef, NetDef } from '../sim/types';

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
  const DIV: [string, string] = ['div', 'prescaler, edge counter'], CTL: [string, string] = ['ctl', 'busy, SCLK, done'], SHF: [string, string] = ['shift', 'shift register, MOSI'];
  const busy = m.reg(clk, 'busy', CTL), done = m.reg(clk, 'done', CTL), sclk = m.reg(clk, 'sclk_q', CTL);
  const ph = m.reg(clk, 'ph', DIV), cnt = [0, 1, 2, 3, 4].map((i) => m.reg(clk, `cnt${i}`, DIV));
  const mo = m.reg(clk, 'mo', SHF), sh = tx.map((_, i) => m.reg(clk, `sh${i}`, SHF));
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
 * The target: 256 bytes behind a subset of the 25-series command set (read 0x03, write 0x02; real parts also need a write-enable command and
 * wrap writes within a page) in mode 0. It is not a mode 3 part: its last byte of a write is committed on the falling edge after the eighth rising
 * edge, which a mode 3 master (SCLK idles high) never makes before it raises CS; a real part commits on CS rising. Everything inside is
 * clocked by SCLK itself, rising for what it samples and falling for what it changes, and reset while CS is high; there is no
 * system clock. MISO is 0 while CS is high (a real part lets go of the line there; the switch-level bus of chapters 5 and 44 can show that).
 */
export function spiDevice(): ComponentDef {
  if (device) return device;
  const m = new Rtl({
    id: 'spi_device', name: 'SPI memory', category: 'memory', label: 'SPI memory 256 B',
    summary: '256 bytes behind an SPI port, mode 0: command 0x03 reads from an address on, 0x02 writes, address and data auto-increment while CS stays low. Clocked by SCLK alone: sampled on the rising edge, shifted out on the falling edge.',
  });
  const sclk = m.input('sclk', { clock: true }), csn = m.input('cs_n'), mosi = m.input('mosi');
  const cs = m.not(csn);
  const nsclk = m.not(sclk);
  const IN: [string, string] = ['in', 'bit counter, input shift'], ST: [string, string] = ['state', 'command, address, data'], AD: [string, string] = ['addr', 'address, +1'], OUT: [string, string] = ['out', 'output shift register'];
  const cnt = [0, 1, 2].map((i) => m.regR(sclk, cs, `bcnt${i}`, IN));
  const sh = Array.from({ length: 8 }, (_, i) => m.regR(sclk, cs, `rsh${i}`, IN));
  const any = m.regR(sclk, cs, 'any', IN);
  const A = m.regR(nsclk, cs, 'A', ST), B = m.regR(nsclk, cs, 'B', ST), rd = m.regR(nsclk, cs, 'rd', ST), wr = m.regR(nsclk, cs, 'wr', ST);
  const addr = Array.from({ length: 8 }, (_, i) => m.regR(nsclk, cs, `addr${i}`, AD));
  const osh = Array.from({ length: 8 }, (_, i) => m.regR(nsclk, cs, `osh${i}`, OUT));
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
 * Chapter 44's scene: one master and two 256-byte memories on SCLK, MOSI and MISO, with a chip select each: `sel` chooses which
 * select follows the master's; the master runs in mode 0 (the memories' only mode). Placed by hand: the master left, the two
 * memories right, the select glue between, every wire a net label.
 */
export function spiPair(): ComponentDef {
  if (pair) return pair;
  const M = spiMaster(), D = spiDevice();
  const mg = symbolGeom(M), dg = symbolGeom(D), og = symbolGeom(OR), ng = symbolGeom(NOT);
  const mx = 22, my = 4, gx = 52, dx = 70, dy0 = 4, dy1 = dy0 + dg.h + 10;
  const pm = (p: string): [number, number] => [mx + mg.ports[p].pos[0], my + mg.ports[p].pos[1]];
  const pins: Record<string, [number, number]> = {};
  for (const p of ['rst', 'start', 'hold', 'tx']) pins[p] = [0, pm(p)[1]];
  pins.clk = [pm('clk')[0], my + mg.h + 5];
  pins.sel = [0, my + mg.h + 6];
  const W = dx + dg.w + 22;
  const rightY = (p: string) => pm(p)[1];
  for (const p of ['rx', 'busy', 'done', 'sclk', 'mosi']) pins[p] = [W, rightY(p)];
  pins.cs0_n = [W, dy0 + dg.ports.cs_n.pos[1]]; pins.cs1_n = [W, dy1 + dg.ports.cs_n.pos[1]];
  pins.miso = [W, dy1 + dg.h + 6];
  const gy = my + mg.h + 4;
  const instances = [
    { name: 'master', def: M, at: [mx, my] as [number, number], label: 'controller' },
    { name: 'tie0', def: TIE0, at: [mx - 8, my + 2] as [number, number] },
    { name: 'nsel', def: NOT, at: [gx, gy + 6] as [number, number] },
    { name: 'or0', def: OR, at: [gx, gy] as [number, number], label: 'CS 0' },
    { name: 'or1', def: OR, at: [gx + 8, gy + 6] as [number, number], label: 'CS 1' },
    { name: 'mem0', def: D, at: [dx, dy0] as [number, number], label: 'memory 0' },
    { name: 'mem1', def: D, at: [dx, dy1] as [number, number], label: 'memory 1' },
    { name: 'orm', def: OR, at: [gx + 8, dy1 + dg.h + 4] as [number, number], label: 'MISO' },
  ];
  void og; void ng;
  const nets: NetDef[] = [
    { name: 'clk', ends: ['clk', 'master.clk'] }, { name: 'rst', ends: ['rst', 'master.rst'] }, { name: 'start', ends: ['start', 'master.start'] },
    { name: 'hold', ends: ['hold', 'master.hold'] }, { name: 'tx', ends: ['tx', 'master.tx'] }, { name: 'mode0', ends: ['tie0.y', 'master.cpol', 'master.cpha'], tags: true },
    { name: 'sel', ends: ['sel', 'or0.b', 'nsel.a'], tags: true }, { name: 'nsel', ends: ['nsel.y', 'or1.b'], tags: true },
    { name: 'cs_n', ends: ['master.cs_n', 'or0.a', 'or1.a'], tags: true },
    { name: 'cs0_n', ends: ['or0.y', 'mem0.cs_n', 'cs0_n'], tags: true }, { name: 'cs1_n', ends: ['or1.y', 'mem1.cs_n', 'cs1_n'], tags: true },
    { name: 'sclk', ends: ['master.sclk', 'mem0.sclk', 'mem1.sclk', 'sclk'], tags: true }, { name: 'mosi', ends: ['master.mosi', 'mem0.mosi', 'mem1.mosi', 'mosi'], tags: true },
    { name: 'miso0', ends: ['mem0.miso', 'orm.a'], tags: true }, { name: 'miso1', ends: ['mem1.miso', 'orm.b'], tags: true },
    { name: 'miso', ends: ['orm.y', 'master.miso', 'miso'], tags: true },
    { name: 'rx', ends: ['master.rx', 'rx'] }, { name: 'busy', ends: ['master.busy', 'busy'] }, { name: 'done', ends: ['master.done', 'done'] },
  ];
  pair = define({
    id: 'spi_pair', name: 'SPI master with two memories', category: 'cell',
    summary: 'A master and two 256-byte SPI memories on SCLK, MOSI and MISO, with a chip select each: sel chooses which one is addressed. MISO is the OR of the two (a real part lets go of the line while its CS is high).',
    ports: [
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, { name: 'rst', width: 1, dir: 'in' }, { name: 'start', width: 1, dir: 'in' }, { name: 'hold', width: 1, dir: 'in' },
      { name: 'sel', width: 1, dir: 'in' }, { name: 'tx', width: 8, dir: 'in' },
      { name: 'rx', width: 8, dir: 'out' }, { name: 'busy', width: 1, dir: 'out' }, { name: 'done', width: 1, dir: 'out' },
      { name: 'sclk', width: 1, dir: 'out' }, { name: 'mosi', width: 1, dir: 'out' }, { name: 'miso', width: 1, dir: 'out' }, { name: 'cs0_n', width: 1, dir: 'out' }, { name: 'cs1_n', width: 1, dir: 'out' },
    ],
    symbol: { kind: 'box', label: 'SPI bus' },
    netlist: () => ({ pins, pinDirs: { clk: 'up' as const }, instances, nets }),
  });
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
