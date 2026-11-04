// Chapter 44's I²C: an open-drain pad from two kinds of device (an NMOS to ground and a buffer that reads the wire back), a
// controller and a target written in gates (lib/rtl.ts), and the bus they share: SDA and SCL, each pulled up by a resistor and
// pulled down by any pad whose controller or target says so. comm/i2c.ts has the models the gates follow every clock.

import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';
import { define, merger, ones } from './define';
import { symbolGeom } from '../sim/geometry';
import { TIE0, TIE1 } from './transistors';
import { PULLUP } from './switchparts';
import { GND, INV_CMOS, NMOS } from './transistors';
import { Rtl } from './rtl';

// ---- the pad ----------------------------------------------------------------------------------------------------------

/**
 * An open-drain pin: `low` = 1 turns an NMOS on and pulls the wire to ground; `low` = 0 lets go of it (the wire floats, or a
 * pull-up holds it). `rx` is the wire read back through a buffer, whoever is pulling it.
 */
export const I2C_PAD: ComponentDef = define({
  id: 'i2c_pad', name: 'Open-drain pad', category: 'cell',
  summary: 'One NMOS from the wire to ground and a two-inverter buffer that reads the wire back. It can pull the wire low; it can never pull it high.',
  ports: [
    { name: 'low', width: 1, dir: 'in', doc: '1: pull the wire to ground; 0: let go' },
    { name: 'bus', width: 1, dir: 'inout', side: 'bottom', doc: 'the shared wire' },
    { name: 'rx', width: 1, dir: 'out', doc: 'the wire, read back' },
  ],
  symbol: { kind: 'box', label: 'pad', w: 8, h: 6 },
  netlist: () => ({
    level: 'switch',
    pins: { low: [1, 6], bus: [14, 20], rx: [38, 6] },
    pinDirs: { bus: 'down' },
    instances: [
      { name: 'n', def: NMOS, at: [10, 8] },
      { name: 'gnd', def: GND, at: [12, 16] },
      { name: 'i1', def: INV_CMOS, at: [20, 1] },
      { name: 'i2', def: INV_CMOS, at: [30, 1] },
    ],
    nets: [
      { name: 'low', ends: ['low', 'n.g'], trunk: 4 },
      { name: 'bus', ends: ['bus', 'n.d', 'i1.a'], via: { 'i1.a': [[16, 20], [16, 4]] } },
      { ends: ['n.s', 'gnd.p'] },
      { ends: ['i1.y', 'i2.a'] },
      { name: 'rx', ends: ['i2.y', 'rx'] },
    ],
  }),
  notes: 'The pad is why a wire shared by many devices is safe: nobody drives it high, so two devices cannot fight. The 1 comes from the resistor that pulls the wire up whenever every NMOS is off.',
  hdl: { verilog: 'module i2c_pad (input low, inout bus, output rx);\n  assign bus = low ? 1\'b0 : 1\'bz;   // open drain\n  assign rx = bus;\nendmodule' },
});

// ---- the controller ---------------------------------------------------------------------------------------------------

let controller: ComponentDef | undefined;

/** The controller: START, WRITE a byte (ACK read back), READ a byte (ACK or NACK sent), STOP, one command at a time, 4 phases of 2 clocks per bit. */
export function i2cController(): ComponentDef {
  if (controller) return controller;
  const m = new Rtl({
    id: 'i2c_controller', name: 'I²C controller', category: 'sequential', label: 'I²C controller',
    summary: 'Runs one command at a time (0 START, 1 WRITE a byte, 2 READ a byte, 3 STOP), each as 4-phase bit cells of 2 clocks. Pulls SDA / SCL low through sda_o / scl_o, reads them back as sda_i / scl_i, waits for SCL to rise (clock stretching) and gives up both lines in the bit where it released SDA and read a 0 (arbitration lost).',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), go = m.input('go');
  const cmdIn = m.inputBus('cmd', 2), din = m.inputBus('din', 8);
  const sdaIn = m.input('sda_i'), sclIn = m.input('scl_i');
  const rstn = m.not(rst);
  const act = m.reg(clk, 'act'), pre = m.reg(clk, 'pre'), ack = m.reg(clk, 'ack'), lost = m.reg(clk, 'lost');
  const sdaO = m.reg(clk, 'sda_o_q'), sclO = m.reg(clk, 'scl_o_q'), sdaS = m.reg(clk, 'sda_s'), sclS = m.reg(clk, 'scl_s');
  const c = [0, 1].map((i) => m.reg(clk, `cmd${i}`)), p = [0, 1].map((i) => m.reg(clk, `ph${i}`));
  const bc = [0, 1, 2, 3].map((i) => m.reg(clk, `bc${i}`)), sh = din.map((_, i) => m.reg(clk, `sh${i}`));

  m.scope('smp', 'input samplers', () => { m.setD(sdaS, sdaIn); m.setD(sclS, sclIn); });
  const d = m.scope('dec', 'decode, events', () => {
    const nc0 = m.not(c[0]), nc1 = m.not(c[1]), np0 = m.not(p[0]), np1 = m.not(p[1]);
    const isWrite = m.name(m.and(nc1, c[0]), 'is_write'), isRead = m.name(m.and(c[1], nc0), 'is_read');
    const byte = m.name(m.or(isWrite, isRead), 'is_byte');
    const ph1 = m.and(np1, p[0]), ph2 = m.and(p[1], np0), ph3 = m.name(m.and(p[1], p[0]), 'ph3');
    const goEff = m.name(m.and(m.and(m.not(act), go), m.or(m.not(lost), m.nor(cmdIn[0], cmdIn[1]))), 'go_eff');
    const adv = m.name(m.and(m.and(act, pre), m.not(m.and(ph1, m.not(sclS)))), 'adv');
    const bc3 = bc[3];
    const lostNow = m.name(m.and(m.and(m.and(adv, ph2), m.and(isWrite, m.not(bc3))), m.and(sh[7], m.not(sdaS))), 'lost_now');
    const fin = m.name(m.and(m.and(adv, ph3), m.or(m.not(byte), bc3)), 'fin');
    return { isWrite, isRead, byte, ph2, ph3, goEff, adv, lostNow, fin, ph1, np0 };
  });
  const { isWrite, isRead, byte, ph2, ph3, goEff, adv, lostNow, fin } = d;
  m.scope('seq', 'phase, bit count, command', () => {
    m.setD(act, m.and(rstn, m.or(goEff, m.and(act, m.nor(fin, lostNow)))));
    m.setD(pre, m.and(m.and(rstn, act), m.not(pre)));
    c.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(goEff, q, cmdIn[i]))));
    const phInc = m.inc(p);
    p.forEach((q, i) => m.setD(q, m.and(rstn, m.and(m.not(goEff), m.mux(adv, q, phInc[i])))));
    const bcInc = m.inc(bc);
    const bcEn = m.and(m.and(adv, ph3), byte);
    bc.forEach((q, i) => m.setD(q, m.and(rstn, m.and(m.not(goEff), m.mux(bcEn, q, bcInc[i])))));
    m.setD(lost, m.and(m.and(rstn, m.not(goEff)), m.or(lost, lostNow)));
    m.setD(ack, m.and(rstn, m.mux(goEff, m.mux(m.and(m.and(adv, ph2), m.and(isWrite, bc[3])), ack, m.not(sdaS)), din[0])));
  });
  m.scope('shift', 'shift register', () => {
    const rdsh = m.and(m.and(adv, ph2), m.and(isRead, m.not(bc[3])));
    const wrsh = m.and(m.and(adv, ph3), m.and(isWrite, m.not(bc[3])));
    const en = m.or(rdsh, wrsh);
    sh.forEach((q, i) => {
      const shin = i === 0 ? m.and(sdaS, isRead) : sh[i - 1];
      m.setD(q, m.and(rstn, m.mux(goEff, m.mux(en, q, shin), din[i])));
    });
  });
  m.scope('drive', 'SDA and SCL drive', () => {
    // the phase being entered: 0 on a go, else ph + 1
    const ngo = m.not(goEff);
    const q0 = m.and(ngo, m.not(p[0])), q1 = m.and(ngo, m.xor(p[1], p[0]));
    const qz = m.and(m.not(q1), m.not(q0)), q3 = m.and(q1, q0);
    const e0 = m.mux(goEff, c[0], cmdIn[0]), e1 = m.mux(goEff, c[1], cmdIn[1]);
    const eStop = m.and(e0, e1), eByte = m.xor(e0, e1);
    const sclNew = m.or(qz, m.and(q3, m.not(eStop)));
    const bc7 = m.and(m.and(bc[0], bc[1]), bc[2]);
    // read: the ACK slot sends the NACK flag; write: bit 6 moves up into place, and the ACK slot releases
    const sbit = m.mux(goEff, m.mux(isWrite, m.mux(bc7, m.const(1), ack), m.mux(bc7, sh[6], m.const(1))), m.mux(m.and(e0, m.not(e1)), m.const(1), din[7]));
    const sdaNew = m.mux(eByte, m.xor(q1, eStop), m.mux(qz, sdaO, m.not(sbit)));
    const upd = m.or(goEff, m.and(adv, m.nor(fin, lostNow)));
    m.setD(sclO, m.and(m.and(rstn, m.not(lostNow)), m.mux(upd, sclO, sclNew)));
    m.setD(sdaO, m.and(m.and(rstn, m.not(lostNow)), m.mux(upd, sdaO, sdaNew)));
  });
  m.output('ready', m.not(act)); m.outputBus('dout', sh); m.output('ack', ack); m.output('lost', lost);
  m.output('sda_o', sdaO); m.output('scl_o', sclO);
  controller = m.build();
  return controller;
}

// ---- the target -------------------------------------------------------------------------------------------------------

let target: ComponentDef | undefined;

/** The target: 4 registers behind a 7-bit address (pins), pointer write, auto-increment read, optional clock stretching before a read. */
export function i2cTarget(): ComponentDef {
  if (target) return target;
  const m = new Rtl({
    id: 'i2c_target', name: 'I²C target', category: 'sequential', label: 'I²C target',
    summary: 'Four 8-bit registers behind a 7-bit address (the adr pins). START and STOP are found from two samples of each line; the address, then bytes: with R/W = 0 the first sets the register pointer and the rest are written at the pointer; with R/W = 1 the register at the pointer is sent and the pointer advances on each ACK. stretch holds SCL low for that many clocks before the first data bit of a read.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), sdaIn = m.input('sda_i'), sclIn = m.input('scl_i');
  const adr = m.inputBus('adr', 7), st = m.inputBus('stretch', 3);
  const rstn = m.not(rst);
  const sdaS = m.reg(clk, 'sda_s'), sclS = m.reg(clk, 'scl_s'), sdaP = m.reg(clk, 'sda_p'), sclP = m.reg(clk, 'scl_p');
  const ph = [0, 1, 2].map((i) => m.reg(clk, `phase${i}`)), n = [0, 1, 2].map((i) => m.reg(clk, `n${i}`));
  const sh = Array.from({ length: 8 }, (_, i) => m.reg(clk, `sh${i}`));
  const rw = m.reg(clk, 'rw'), ptr = [0, 1].map((i) => m.reg(clk, `ptr${i}`));
  const pnext = m.reg(clk, 'pnext'), mack = m.reg(clk, 'mack'), sdaO = m.reg(clk, 'sda_o_q'), sclO = m.reg(clk, 'scl_o_q'), wpend = m.reg(clk, 'wpend');
  const scnt = [0, 1, 2].map((i) => m.reg(clk, `scnt${i}`));
  const n7 = m.name(m.andN(n), 'n7');

  m.scope('smp', 'samplers', () => { m.setD(sdaS, sdaIn); m.setD(sclS, sclIn); m.setD(sdaP, sdaS); m.setD(sclP, sclS); });
  const e = m.scope('ev', 'START, STOP, edges, phase', () => {
    const hi = m.and(sclS, sclP);
    const start = m.name(m.and(hi, m.and(sdaP, m.not(sdaS))), 'start'), stop = m.name(m.and(hi, m.and(m.not(sdaP), sdaS)), 'stop');
    const nrm = m.name(m.nor(start, stop), 'nrm');
    const rise = m.and(nrm, m.and(sclS, m.not(sclP))), fall = m.and(nrm, m.and(m.not(sclS), sclP));
    const is = (v: number) => m.eqConst(ph, v);
    const iAddr = is(1), iAack = is(2), iWr = is(3), iWack = is(4), iRd = is(5), iRack = is(6);
    const iAck = m.or(iAack, iWack);
    const take = m.name(m.and(rise, m.or(iAddr, iWr)), 'take');
    const addrDone = m.name(m.and(m.and(take, iAddr), n7), 'addr_done');
    const wrDone = m.name(m.and(m.and(take, iWr), n7), 'wr_done');
    const ackBegin = m.name(m.and(m.and(fall, iAck), m.not(sdaO)), 'ack_begin');
    const ackEnd = m.name(m.and(m.and(fall, iAck), sdaO), 'ack_end');
    const rdShift = m.name(m.and(m.and(fall, iRd), m.not(n7)), 'rd_shift');
    const rdLast = m.name(m.and(m.and(fall, iRd), n7), 'rd_last');
    const rackNext = m.name(m.and(m.and(fall, iRack), mack), 'rack_next');
    const rackIdle = m.name(m.and(m.and(fall, iRack), m.not(mack)), 'rack_idle');
    const rackRise = m.and(rise, iRack);
    const ackRd = m.name(m.and(m.and(ackEnd, iAack), rw), 'ack_rd');
    return { start, stop, rise, take, addrDone, wrDone, ackBegin, ackEnd, rdShift, rdLast, rackNext, rackIdle, rackRise, ackRd, iRack };
  });
  const { start, stop, take, addrDone, wrDone, ackBegin, ackEnd, rdShift, rdLast, rackNext, rackIdle, rackRise, ackRd, iRack } = e;
  const mem = m.scope('mem', 'four registers', () => {
    const ptrNext = m.inc(ptr);
    const ra = [m.mux(iRack, ptr[0], ptrNext[0]), m.mux(iRack, ptr[1], ptrNext[1])];
    // reset to 0 like the model; a register is written the clock after its byte completes (wpend), at the pointer
    const regs = [0, 1, 2, 3].map((r) => {
      const we = m.and(wpend, m.eqConst(ptr, r));
      return sh.map((d, b) => { const q = m.reg(clk, `r${r}_${b}`); m.setD(q, m.and(rstn, m.mux(we, q, d))); return q; });
    });
    const rdata = sh.map((_, b) => m.mux(ra[1], m.mux(ra[0], regs[0][b], regs[1][b]), m.mux(ra[0], regs[2][b], regs[3][b])));
    return { rdata, ptrNext };
  });
  const load = m.or(ackRd, rackNext);
  m.scope('fsm', 'phase, bit count, flags', () => {
    const match = m.eq(sh.slice(0, 7), adr);
    const goMatch = m.and(addrDone, match), goNo = m.and(addrDone, m.not(match));
    const ackWr = m.and(ackEnd, m.not(ackRd));
    const evAny = m.orN([start, stop, addrDone, ackEnd, wrDone, rdLast, rackNext, rackIdle]);
    const code0 = m.orN([start, ackRd, rackNext, ackWr]), code1 = m.orN([goMatch, ackWr, rdLast]), code2 = m.orN([ackRd, wrDone, rdLast, rackNext]);
    void goNo;
    [code0, code1, code2].forEach((c, i) => m.setD(ph[i], m.and(rstn, m.mux(evAny, ph[i], c))));
    const nInc = m.inc(n);
    const zero = m.orN([start, ackEnd, rackNext]), step = m.or(take, rdShift);
    n.forEach((q, i) => m.setD(q, m.and(m.and(rstn, m.not(zero)), m.mux(step, q, nInc[i]))));
    m.setD(rw, m.and(rstn, m.mux(addrDone, rw, sdaS)));
    m.setD(pnext, m.and(rstn, m.or(addrDone, m.and(pnext, m.not(wrDone)))));
    m.setD(mack, m.and(rstn, m.mux(rackRise, mack, m.not(sdaS))));
    m.setD(wpend, m.and(rstn, m.and(wrDone, m.not(pnext))));
    const setPtr = m.and(wrDone, pnext), incPtr = m.or(wpend, rackNext);
    ptr.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(setPtr, m.mux(incPtr, q, mem.ptrNext[i]), i === 0 ? sdaS : sh[0]))));
  });
  m.scope('shift', 'shift register', () => {
    const shiftEn = m.or(take, rdShift);
    sh.forEach((q, i) => {
      const prev = i === 0 ? m.and(sdaS, take) : sh[i - 1];
      m.setD(q, m.and(rstn, m.mux(load, m.mux(shiftEn, q, prev), mem.rdata[i])));
    });
  });
  m.scope('line', 'SDA and SCL drive', () => {
    const setv = m.orN([ackBegin, m.and(load, m.not(mem.rdata[7])), m.and(rdShift, m.not(sh[6]))]);
    const change = m.orN([start, stop, ackBegin, ackEnd, rdLast, rackNext, rdShift]);
    m.setD(sdaO, m.and(rstn, m.mux(change, sdaO, setv)));
    const dec = m.inc(scnt.map((q) => m.not(q))).map((q) => m.not(q)); // scnt - 1
    const decNz = m.orN(dec);
    m.setD(sclO, m.and(m.and(rstn, m.not(stop)), m.mux(ackRd, m.and(sclO, decNz), m.orN(st))));
    scnt.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(ackRd, m.and(m.not(stop), m.mux(sclO, q, dec[i])), st[i]))));
  });
  void rackIdle;
  m.output('sda_o', sdaO); m.output('scl_o', sclO);
  target = m.build();
  return target;
}

// ---- the bus ----------------------------------------------------------------------------------------------------------

export interface I2cTargetSpec { adr: number }

const busCache = new Map<string, ComponentDef>();

/**
 * A bus at switch level: `ctls` controllers and the given targets side by side, each behind two open-drain pads (SDA, SCL) onto two
 * rails, each rail pulled up by its own resistor. The controllers' and targets' gates are flattened to transistors with the pads and
 * resistors: nothing here is a lookup. Ports: clk, rst and per controller go / cmd / din in and ready / dout / ack / lost out, per target stretch in (clocks of SCL held low before a read); the
 * rails sda and scl are inout, so a stage can read them (and a learner can pull one low by hand).
 */
export function i2cBus(ctls: number, targets: I2cTargetSpec[]): ComponentDef {
  const key = `${ctls}c${targets.map((t) => t.adr.toString(16)).join('_')}`;
  const hit = busCache.get(key);
  if (hit) return hit;
  const C = i2cController(), T = i2cTarget();
  const cg = symbolGeom(C), tg = symbolGeom(T), pg = symbolGeom(I2C_PAD), ug = symbolGeom(PULLUP);
  const instances: InstanceDef[] = [];
  const nets: NetDef[] = [];
  const ports: ComponentDef['ports'] = [
    { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, { name: 'rst', width: 1, dir: 'in' },
  ];
  const sdaEnds: string[] = [], sclEnds: string[] = [];
  const clkEnds = ['clk'], rstEnds = ['rst'];
  const pins: Record<string, [number, number]> = { clk: [0, 0], rst: [0, 2] };
  let x = 12, inY = 6, outY = 4, right = 0;
  const gap = 14;
  const devH = Math.max(cg.h, tg.h) + 2;
  const padY = devH + 8, railS = padY + pg.h + 8, railC = railS + 4;
  const pad = (name: string, dev: string, lowPort: string, rxPort: string, dx: number, rail: string[], tag: string) => {
    instances.push({ name, def: I2C_PAD, at: [dx, padY] });
    nets.push({ name: `${tag}_o_${dev}`, ends: [`${dev}.${lowPort}`, `${name}.low`], tags: true });
    nets.push({ name: `${tag}_i_${dev}`, ends: [`${name}.rx`, `${dev}.${rxPort}`], tags: true });
    rail.push(`${name}.bus`);
  };
  for (let k = 0; k < ctls; k++) {
    const d = `c${k}`;
    instances.push({ name: d, def: C, at: [x, 2], label: `controller ${k}` });
    clkEnds.push(`${d}.clk`); rstEnds.push(`${d}.rst`);
    for (const [p, w] of [['go', 1], ['cmd', 2], ['din', 8]] as [string, number][]) {
      const n = `${p}${k}`;
      ports.push({ name: n, width: w, dir: 'in' }); pins[n] = [0, inY]; inY += 2;
      nets.push({ name: n, ends: [n, `${d}.${p}`], tags: true });
    }
    for (const [p, w] of [['ready', 1], ['dout', 8], ['ack', 1], ['lost', 1]] as [string, number][]) {
      const n = `${p}${k}`;
      ports.push({ name: n, width: w, dir: 'out' }); pins[n] = [-1, outY]; outY += 2; // x fixed up below
      nets.push({ name: n, ends: [`${d}.${p}`, n], tags: true });
    }
    pad(`ps${k}`, d, 'sda_o', 'sda_i', x + 2, sdaEnds, 'sda'); pad(`pc${k}`, d, 'scl_o', 'scl_i', x + 2 + pg.w + 4, sclEnds, 'scl');
    x += Math.max(cg.w, 2 * pg.w + 10) + gap;
  }
  targets.forEach((tspec, k) => {
    const d = `t${k}`;
    instances.push({ name: d, def: T, at: [x, 2], label: `target ${k}: 0x${tspec.adr.toString(16)}` });
    clkEnds.push(`${d}.clk`); rstEnds.push(`${d}.rst`);
    // address and stretch are wired to the rails with tie cells, one per bit
    const bits = (name: string, w: number, v: number, ty: number) => {
      const ts = Array.from({ length: w }, (_, i) => `${d}_${name}${i}`);
      ts.forEach((tn, i) => { instances.push({ name: tn, def: (v >> i) & 1 ? TIE1 : TIE0, at: [x - 12, ty + 3 * i] }); });
      instances.push({ name: `${d}_${name}_m`, def: merger(ones(w)), at: [x - 7, ty] });
      ts.forEach((tn, i) => nets.push({ name: `${tn}`, ends: [`${tn}.y`, `${d}_${name}_m.i${i}`], tags: true }));
      nets.push({ name: `${d}_${name}`, ends: [`${d}_${name}_m.out`, `${d}.${name}`], tags: true });
    };
    bits('adr', 7, tspec.adr, 2);
    const sn = `stretch${k}`;
    ports.push({ name: sn, width: 3, dir: 'in' }); pins[sn] = [0, inY]; inY += 2;
    nets.push({ name: sn, ends: [sn, `${d}.stretch`], tags: true });
    pad(`ps_t${k}`, d, 'sda_o', 'sda_i', x + 2, sdaEnds, 'sda'); pad(`pc_t${k}`, d, 'scl_o', 'scl_i', x + 2 + pg.w + 4, sclEnds, 'scl');
    x += Math.max(tg.w, 2 * pg.w + 10) + gap;
  });
  right = x;
  // pull-ups at the right end of each rail
  instances.push({ name: 'pus', def: PULLUP, at: [right, railS - ug.ports.y.pos[1] - 3] }, { name: 'puc', def: PULLUP, at: [right + 8, railC - ug.ports.y.pos[1] - 3] });
  sdaEnds.push('pus.y'); sclEnds.push('puc.y');
  nets.push({ name: 'sda', ends: ['sda', ...sdaEnds], trunk: railS }, { name: 'scl', ends: ['scl', ...sclEnds], trunk: railC });
  nets.push({ name: 'clk', ends: clkEnds, tags: true }, { name: 'rst', ends: rstEnds, tags: true });
  ports.push({ name: 'sda', width: 1, dir: 'inout' }, { name: 'scl', width: 1, dir: 'inout' });
  pins.sda = [right + 14, railS]; pins.scl = [right + 14, railC];
  for (const p of ports) if (p.dir === 'out' && p.name !== 'sda' && p.name !== 'scl') pins[p.name] = [right + 14, pins[p.name][1]];
  const def = define({
    id: `i2c_bus_${key}`, name: `I²C bus (${ctls} controller${ctls === 1 ? '' : 's'}, ${targets.length} target${targets.length === 1 ? '' : 's'})`, category: 'cell',
    summary: 'Controllers and targets in gates, each behind an open-drain pad on two wires that two resistors pull up: the whole bus is solved at switch level, down to the transistors in every NAND.',
    ports,
    symbol: { kind: 'box', label: 'I²C bus' },
    netlist: () => ({ level: 'switch', pins, instances, nets }),
  });
  busCache.set(key, def);
  return def;
}

let wired: ComponentDef | undefined;

/**
 * Two open-drain stages and one pull-up on a wire: chapter 2's wired-AND, with the pad of the bus. a and b are what each stage
 * wants to say (1: let go); the wire is 1 only if both let go; y reads it back.
 */
export function i2cWired2(): ComponentDef {
  if (wired) return wired;
  wired = define({
    id: 'i2c_wired2', name: 'Wired-AND of two open-drain stages', category: 'cell',
    summary: 'Two pads (an NMOS to ground each) and a pull-up resistor on one wire. Each input says what its stage wants: 1 lets go of the wire, 0 pulls it to ground. The wire is the AND of the two, with no gate in it.',
    ports: [
      { name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' },
      { name: 'wire', width: 1, dir: 'out', tri: true, doc: 'the shared wire' },
    ],
    symbol: { kind: 'box', label: 'wired-AND', w: 10, h: 8 },
    spec: ([a, b]) => [a & b],
    netlist: () => ({
      level: 'switch',
      pins: { a: [1, 3], b: [1, 17], wire: [48, 10] },
      instances: [
        { name: 'ia', def: INV_CMOS, at: [5, 1] }, { name: 'ib', def: INV_CMOS, at: [5, 15] },
        { name: 'pa', def: I2C_PAD, at: [14, 0], label: 'stage a' }, { name: 'pb', def: I2C_PAD, at: [14, 14], label: 'stage b' },
        { name: 'pu', def: PULLUP, at: [34, 0] },
      ],
      nets: [
        { name: 'a', ends: ['a', 'ia.a'] }, { name: 'b', ends: ['b', 'ib.a'] },
        { name: 'low_a', ends: ['ia.y', 'pa.low'], tags: true }, { name: 'low_b', ends: ['ib.y', 'pb.low'], tags: true },
        { name: 'wire', ends: ['wire', 'pa.bus', 'pb.bus', 'pu.y'], trunk: 30 },
      ],
    }),
  });
  return wired;
}
