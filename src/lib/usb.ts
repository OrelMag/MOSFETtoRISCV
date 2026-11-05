// The USB full-speed device in gates (chapter "PCIe and USB"): receiver, control endpoint, transmitter and descriptor ROM as boxes of
// NAND gates and flip-flops written with lib/rtl.ts. comm/usb.ts holds the model (UsbDevice) that tests/comm-usb-gates.test.ts
// compares it with after every clock; the equations are the same, line for line. The CRC registers are lib/crc.ts crcUnit(5, ...)
// and crcUnit(16, ...), one bit a clock; the 16-bit one serves the receiver and the transmitter (a device never does both).
//
// Pins: the line is two inputs (dp, dm) and, when the device drives, three outputs (odp, odm, oe), because tri-state parts would make
// the chip switch level: the bench joins the drivers (comm/usb.ts resolveBus) and nobody driving is J (the pull-up on D+).
// Every output is a flip-flop's, so the bench can read them before it sets the inputs of the same clock.
// Speed: 4 clocks a bit; real full speed is 12 Mb/s, these gates at the single-cycle CPU's clock would carry 63 Mb/s.

import { CRC16_POLY, CRC16_RESIDUE, CRC5_POLY, CRC5_RESIDUE, REQ, USB_ROM } from '../comm/usb';
import { stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { crcUnit } from './crc';
import { Rtl, type Sig } from './rtl';

const regs = (m: Rtl, clk: Sig, name: string, n: number, home: [string, string]): Sig[] => Array.from({ length: n }, (_, i) => m.reg(clk, n === 1 ? name : `${name}${i}`, home));
const nots = (m: Rtl, bits: Sig[]): Sig[] => bits.map((b) => m.not(b));
/** bits == the constant v, with the inverted bits given (computed once per bus). */
const eqC = (m: Rtl, bits: Sig[], nb: Sig[], v: number): Sig => m.andN(bits.map((b, i) => ((v >> i) & 1 ? b : nb[i])));
/** bits >= the constant c. */
function geC(m: Rtl, bits: Sig[], c: number): Sig {
  let g = m.const(1);
  bits.forEach((b, i) => { g = (c >> i) & 1 ? m.and(b, g) : m.or(b, g); });
  return g;
}
/** s ? b : a, bitwise. */
const mux = (m: Rtl, s: Sig, a: Sig[], b: Sig[]): Sig[] => a.map((x, i) => m.mux(s, x, b[i]));
const cbit = (m: Rtl, v: number, i: number): Sig => m.const(((v >> i) & 1) as 0 | 1);

const RX: [string, string] = ['rx', 'bits, NRZI, SYNC'];
const PK: [string, string] = ['pkt', 'PID, bytes, EOP'];
const CT: [string, string] = ['ctl', 'control, state'];
const TX: [string, string] = ['tx', 'transmitter'];

let cache: ComponentDef | undefined;

/**
 * A full-speed device with one control endpoint (EP0, 8-byte packets) and an interrupt endpoint that always NAKs. See comm/usb.ts for
 * the protocol rules (and the simplifications), UsbDevice for what each register does. Built on first use, not at import.
 */
export function usbDevice(): ComponentDef {
  if (cache) return cache;
  const m = new Rtl({
    id: 'usb_device', name: 'USB full-speed device', category: 'sequential', label: 'USB device', columnHeight: 34,
    summary: 'Receiver (bit recovery, NRZI, destuffing, SYNC, PID check, CRC5 / CRC16, EOP), control endpoint (SETUP, IN, OUT, handshakes, the standard requests, device states), transmitter (SYNC, PID, descriptor bytes from a ROM, CRC16, stuffing, NRZI, EOP). Four clocks a bit.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), dpi = m.input('dp'), dmi = m.input('dm'), nak = m.input('nak');
  const rstn = m.not(rst);
  const nm = (s: Sig, n: string) => m.name(s, n);

  // ---- every register, in the block it belongs to (its next state is wired later)
  const [sdp] = regs(m, clk, 'sdp', 1, RX), [sdm] = regs(m, clk, 'sdm', 1, RX), [pdp] = regs(m, clk, 'pdp', 1, RX), [pdm] = regs(m, clk, 'pdm', 1, RX);
  const ph = regs(m, clk, 'ph', 2, RX), [lb] = regs(m, clk, 'lb', 1, RX), ones = regs(m, clk, 'ones', 3, RX), sh = regs(m, clk, 'sh', 8, RX), bc = regs(m, clk, 'bc', 3, RX);
  const [rpid] = regs(m, clk, 'rpid', 1, RX), [rbody] = regs(m, clk, 'rbody', 1, RX), nb = regs(m, clk, 'nb', 4, PK), [rerr] = regs(m, clk, 'rerr', 1, RX);
  const pidr = regs(m, clk, 'pidr', 4, PK), se0c = regs(m, clk, 'se0c', 8, RX);
  const [tkv] = regs(m, clk, 'tkv', 1, PK), tk = regs(m, clk, 'tk', 2, PK), [tp1] = regs(m, clk, 'tp1', 1, PK), [am] = regs(m, clk, 'am', 1, PK), [e0] = regs(m, clk, 'e0', 1, PK), [ez] = regs(m, clk, 'ez', 1, PK);
  const st = regs(m, clk, 'st', 2, CT), addr = regs(m, clk, 'addr', 7, CT);
  const [armed] = regs(m, clk, 'armed', 1, CT), [stall] = regs(m, clk, 'stall', 1, CT), [rin] = regs(m, clk, 'rin', 1, CT), [rout] = regs(m, clk, 'rout', 1, CT);
  const [gd] = regs(m, clk, 'gd', 1, CT), [gs] = regs(m, clk, 'gs', 1, CT), [sa] = regs(m, clk, 'sa', 1, CT), [sc] = regs(m, clk, 'sc', 1, CT);
  const pend = regs(m, clk, 'pend', 8, CT), [tdev] = regs(m, clk, 'tdev', 1, CT), [tcfg] = regs(m, clk, 'tcfg', 1, CT), rem = regs(m, clk, 'rem', 8, CT);
  const pktidx = regs(m, clk, 'pktidx', 2, CT), [tog] = regs(m, clk, 'tog', 1, CT), [wack] = regs(m, clk, 'wack', 1, CT), [paa] = regs(m, clk, 'paa', 1, CT), [pac] = regs(m, clk, 'pac', 1, CT);
  const [tkd] = regs(m, clk, 'tkd', 1, CT), [tkn] = regs(m, clk, 'tkn', 1, CT), [tks] = regs(m, clk, 'tks', 1, CT);
  const [twait] = regs(m, clk, 'twait', 1, TX), [tsync] = regs(m, clk, 'tsync', 1, TX), [tpidp] = regs(m, clk, 'tpidp', 1, TX), [tdata] = regs(m, clk, 'tdata', 1, TX);
  const [tcrc] = regs(m, clk, 'tcrc', 1, TX), [teop] = regs(m, clk, 'teop', 1, TX), tph = regs(m, clk, 'tph', 2, TX), tbc = regs(m, clk, 'tbc', 3, TX), tn = regs(m, clk, 'tn', 4, TX);
  const tones = regs(m, clk, 'tones', 3, TX), [tlv] = regs(m, clk, 'tlv', 1, TX), tsh = regs(m, clk, 'tsh', 8, TX);
  const [oe] = regs(m, clk, 'oe', 1, TX), [odp] = regs(m, clk, 'odp', 1, TX), [odm] = regs(m, clk, 'odm', 1, TX);
  // the check registers' outputs come from the units made last
  const q5 = Array.from({ length: 5 }, (_, i) => m.fwd(`q5_${i}`)), q16 = Array.from({ length: 16 }, (_, i) => m.fwd(`q16_${i}`));

  // ---- receiver front end ------------------------------------------------------------------------------------------------------
  const f = m.scope('rx', RX[1], () => {
    const busrst = se0c[7], cl = nm(m.or(rst, busrst), 'clear'), ncl = m.not(cl);
    const se0 = nm(m.nor(sdp, sdm), 'se0');
    const edge = nm(m.or(m.xor(sdp, pdp), m.xor(sdm, pdm)), 'edge');
    const smp = nm(m.andN([ph[1], m.not(ph[0]), m.not(edge)]), 'smp');
    const sm = nm(m.and(smp, m.not(oe)), 'sm');
    const idle = nm(m.nor(rpid, rbody), 'idle');
    const dsm = m.and(sm, m.not(se0));
    const dbit = nm(m.xnor(sdp, lb), 'dbit');
    const stuffnow = nm(eqC(m, ones, nots(m, ones), 6), 'stuffnow');
    const dd = nm(m.and(dsm, m.not(stuffnow)), 'dd');
    const stuffbad = m.andN([dsm, stuffnow, dbit]);
    const nsh = sh.map((_, i) => (i === 7 ? dbit : sh[i + 1]));
    const bcend = m.andN(bc);
    const sync = nm(m.andN([idle, dd, eqC(m, nsh, nots(m, nsh), 0x80)]), 'sync');
    const pidend = nm(m.andN([rpid, dd, bcend]), 'pidend');
    const pidokv = m.andN([0, 1, 2, 3].map((i) => m.xor(nsh[i], nsh[i + 4])));
    const byteend = nm(m.andN([rbody, dd, bcend]), 'byteend');
    const eop = m.and(m.or(rpid, rbody), m.and(sm, se0));
    // registers
    m.setD(sdp, m.or(rst, dpi)); m.setD(sdm, m.and(rstn, dmi));
    m.setD(pdp, m.or(rst, sdp)); m.setD(pdm, m.and(rstn, sdm));
    m.setD(ph[0], m.or(edge, m.not(ph[0]))); m.setD(ph[1], m.and(m.not(edge), m.xor(ph[1], ph[0])));
    m.setD(lb, m.or(rst, m.mux(smp, lb, m.or(sdp, m.not(sdm)))));
    m.setD(rpid, m.and(ncl, m.or(sync, m.andN([rpid, m.not(pidend), m.not(eop)]))));
    m.setD(rbody, m.and(ncl, m.or(pidend, m.and(rbody, m.not(eop)))));
    const oi = m.inc(ones), up = m.and(dbit, m.not(stuffnow));
    ones.forEach((q, i) => {
      const busy = m.mux(dsm, q, m.and(up, oi[i]));
      m.setD(q, i === 0 ? m.mux(idle, busy, sync) : m.and(m.not(idle), busy));
    });
    const bi = m.inc(bc);
    bc.forEach((q, i) => m.setD(q, m.and(m.not(idle), m.mux(dd, q, bi[i]))));
    const shclr = nm(m.or(oe, m.and(sm, se0)), 'shclr');
    sh.forEach((q, i) => m.setD(q, m.or(shclr, m.mux(dd, q, nsh[i]))));
    m.setD(rerr, m.and(m.not(idle), m.or(rerr, m.or(stuffbad, m.and(pidend, m.not(pidokv))))));
    const si = m.inc(se0c);
    se0c.forEach((q, i) => m.setD(q, m.and(se0, m.mux(se0c[7], si[i], q))));
    return { busrst, cl, ncl, se0, smp, sm, idle, dbit, dd, nsh, byteend, bodyEnd: m.andN([rbody, sm, se0]), sync, pidend };
  });

  // ---- packet level -------------------------------------------------------------------------------------------------------------
  const p = m.scope('pkt', PK[1], () => {
    const nbn = nots(m, nb);
    const z = nm(eqC(m, nb, nbn, 2), 'z');
    const okb = nm(m.andN([f.bodyEnd, m.not(rerr), m.nor(m.or(bc[0], bc[1]), bc[2])]), 'okb');
    const istok = m.and(pidr[0], m.not(pidr[1])), isdat = nm(m.and(pidr[0], pidr[1]), 'isdat'), ishs = m.and(m.not(pidr[0]), pidr[1]);
    const c5ok = eqC(m, q5, nots(m, q5), CRC5_RESIDUE);
    const tokok = m.andN([okb, istok, z, c5ok]);
    const tme = m.andN([am, ez, m.or(st[0], st[1])]);
    const isof = m.and(pidr[2], m.not(pidr[3]));
    const tokme = nm(m.andN([tokok, tme, m.not(isof)]), 'tokme');
    const c16ok = eqC(m, q16, nots(m, q16), CRC16_RESIDUE);
    const datok = m.andN([okb, isdat, c16ok, tkv]);
    const tkSetup = nm(m.and(tk[0], tk[1]), 'tkSetup'), tkOut = m.nor(tk[0], tk[1]);
    const setupdat = nm(m.andN([datok, tkSetup, m.not(tp1), eqC(m, nb, nbn, 10)]), 'setupdat');
    const outdat = nm(m.andN([datok, tkOut, m.not(tp1), armed]), 'outdat');
    const inme = m.andN([tokme, pidr[3], m.not(pidr[2])]);
    const in0 = m.and(inme, m.not(e0)), in1 = m.and(inme, e0);
    const settok = nm(m.and(tokme, m.and(pidr[2], pidr[3])), 'settok');
    const ackpkt = m.andN([okb, ishs, m.nor(pidr[2], pidr[3]), eqC(m, nb, nbn, 0)]);
    const commit = nm(m.and(ackpkt, wack), 'commit');
    // token fields and the registers of this block
    const nsh = f.nsh;
    const first = m.and(f.byteend, eqC(m, nb, nbn, 0)), second = m.and(f.byteend, eqC(m, nb, nbn, 1));
    m.setD(am, m.mux(first, am, m.eq(nsh.slice(0, 7), addr)));
    m.setD(e0, m.mux(first, e0, nsh[7]));
    m.setD(ez, m.mux(second, ez, m.nor(m.or(nsh[0], nsh[1]), nsh[2])));
    m.setD(tkv, m.and(f.ncl, m.mux(f.bodyEnd, tkv, tokme)));
    tk.forEach((q, i) => m.setD(q, m.mux(tokme, q, pidr[2 + i])));
    m.setD(tp1, m.mux(tokme, tp1, e0));
    pidr.forEach((q, i) => m.setD(q, m.mux(f.pidend, q, nsh[i])));
    const nbi = m.inc(nb), take = m.and(f.byteend, m.not(m.andN(nb)));
    nb.forEach((q, i) => m.setD(q, m.and(rbody, m.mux(take, q, nbi[i]))));
    return { z, okb, isdat, tokme, setupdat, outdat, in0, in1, settok, commit, nbn, tkSetup };
  });

  // ---- control endpoint --------------------------------------------------------------------------------------------------------
  const c = m.scope('ctl', CT[1], () => {
    const rData = nm(m.andN([p.in0, armed, m.not(stall), m.not(nak)]), 'rData');
    const rNak = nm(m.orN([m.andN([p.in0, armed, m.not(stall), nak]), m.and(p.in1, m.and(st[0], st[1])), m.andN([p.outdat, p.z, m.not(stall), nak])]), 'rNak');
    const rStall = nm(m.or(m.andN([p.in0, armed, stall]), m.and(p.outdat, m.or(m.not(p.z), stall))), 'rStall');
    const rAck = nm(m.or(p.setupdat, m.andN([p.outdat, p.z, m.not(stall), m.not(nak)])), 'rAck');
    const rAny = nm(m.orN([rData, rNak, rStall, rAck]), 'rAny');
    const nsh = f.nsh, nshn = nots(m, nsh), nbn = p.nbn;
    const capb = m.and(m.andN([rbody, tkv, p.tkSetup, m.not(tp1), p.isdat]), f.byteend);
    const at = (k: number) => m.and(capb, eqC(m, nb, nbn, k));
    const n0 = at(0), n1 = at(1), n2 = at(2), n3 = at(3), n6 = at(6), n7 = at(7);
    m.setD(rin, m.mux(n0, rin, eqC(m, nsh, nshn, 0x80))); m.setD(rout, m.mux(n0, rout, eqC(m, nsh, nshn, 0)));
    m.setD(gd, m.mux(n1, gd, eqC(m, nsh, nshn, REQ.GET_DESCRIPTOR))); m.setD(gs, m.mux(n1, gs, eqC(m, nsh, nshn, REQ.GET_STATUS)));
    m.setD(sa, m.mux(n1, sa, eqC(m, nsh, nshn, REQ.SET_ADDRESS))); m.setD(sc, m.mux(n1, sc, eqC(m, nsh, nshn, REQ.SET_CONFIGURATION)));
    pend.forEach((q, i) => m.setD(q, m.mux(n2, q, nsh[i])));
    m.setD(tdev, m.mux(n3, tdev, eqC(m, nsh, nshn, 1))); m.setD(tcfg, m.mux(n3, tcfg, eqC(m, nsh, nshn, 2)));
    // is the request valid, and how many bytes does it have to give
    const pendn = nots(m, pend);
    const vgd = m.andN([rin, gd, m.or(tdev, tcfg), eqC(m, pend, pendn, 0)]);
    const vgs = m.and(rin, gs);
    const vsa = m.andN([rout, sa, m.not(m.and(st[0], st[1])), pendn[7]]);
    const vsc = m.andN([rout, sc, st[1], m.nor(m.orN(pend.slice(1, 7)), pend[7])]);
    const reqok = m.orN([vgd, vgs, vsa, vsc]);
    const sel18 = m.and(vgd, tdev), sel25 = m.and(vgd, m.not(tdev)), sel2 = m.and(vgs, m.not(vgd));
    const ge18 = geC(m, rem, 18), ge25 = geC(m, rem, 25), ge2 = m.orN(rem.slice(1));
    const minRem = rem.map((r, i) => m.orN([m.and(sel18, m.mux(ge18, r, cbit(m, 18, i))), m.and(sel25, m.mux(ge25, r, cbit(m, 25, i))), m.and(sel2, m.mux(ge2, r, cbit(m, 2, i)))]));
    // the count after an ACK: 8 fewer, or none left
    const ge8 = nm(m.orN(rem.slice(3)), 'ge8');
    const hi = m.inc(rem.slice(3).map((r) => m.not(r))).map((r) => m.not(r));
    const decv = rem.map((r, i) => m.and(ge8, i < 3 ? r : hi[i - 3]));
    let x = mux(m, p.commit, rem, decv);
    x = mux(m, p.setupdat, x, minRem);
    const nzn = m.orN(nsh);
    x = mux(m, n7, x, rem.map((r) => m.or(r, nzn)));
    x = mux(m, n6, x, nsh);
    rem.forEach((q, i) => m.setD(q, x[i]));
    m.setD(tog, m.or(p.setupdat, m.xor(tog, p.commit)));
    const pi = m.inc(pktidx);
    pktidx.forEach((q, i) => m.setD(q, m.and(m.not(p.setupdat), m.mux(p.commit, q, pi[i]))));
    m.setD(wack, m.and(f.ncl, m.or(rData, m.and(m.not(f.bodyEnd), wack))));
    m.setD(armed, m.andN([f.ncl, m.not(p.settok), m.or(p.setupdat, armed)]));
    m.setD(stall, m.andN([f.ncl, m.not(p.settok), m.mux(p.setupdat, stall, m.not(reqok))]));
    m.setD(paa, m.andN([f.ncl, m.not(p.settok), m.mux(p.setupdat, m.and(paa, m.not(p.commit)), vsa)]));
    m.setD(pac, m.andN([f.ncl, m.not(p.settok), m.mux(p.setupdat, m.and(pac, m.not(p.commit)), vsc)]));
    // SET_ADDRESS / SET_CONFIGURATION take effect when the ACK of the status stage arrives
    const cpa = nm(m.and(p.commit, paa), 'cpa'), cpc = nm(m.and(p.commit, pac), 'cpc');
    addr.forEach((q, i) => m.setD(q, m.and(m.not(f.cl), m.mux(cpa, q, pend[i]))));
    const pendz = m.nor(m.orN(pend.slice(0, 4)), m.orN(pend.slice(4, 7)));
    const stn0 = m.mux(cpa, m.mux(cpc, st[0], pend[0]), pendz), stn1 = m.or(m.and(cpa, m.not(pendz)), m.or(cpc, m.and(m.not(cpa), st[1])));
    m.setD(st[0], m.and(rstn, m.or(f.busrst, stn0)));
    m.setD(st[1], m.and(f.ncl, stn1));
    m.setD(tkd, m.mux(rAny, tkd, rData)); m.setD(tkn, m.mux(rAny, tkn, rNak)); m.setD(tks, m.mux(rAny, tks, rStall));
    return { rAny, ge8 };
  });

  // ---- transmitter ---------------------------------------------------------------------------------------------------------------
  const t = m.scope('tx', TX[1], () => {
    const idleT = nm(m.nor(m.orN([twait, tsync, tpidp]), m.orN([tdata, tcrc, teop])), 'txidle');
    const tn4 = nots(m, tn), tones3 = nots(m, tones);
    const tbound = nm(m.andN([m.not(idleT), tph[0], tph[1]]), 'tbound');
    const sending = nm(m.orN([tsync, tpidp, tdata, tcrc]), 'sending');
    const stuff = m.and(sending, eqC(m, tones, tones3, 6));
    const src = m.mux(tcrc, tsh[0], m.not(q16[0]));
    const v = nm(m.and(m.not(stuff), src), 'v');
    const tstep = nm(m.and(tbound, sending), 'tstep');
    const adv = nm(m.and(tstep, m.not(stuff)), 'adv');
    const bend = nm(m.and(adv, m.andN(tbc)), 'bend');
    const tni = m.inc(tn.slice(0, 3));
    const tnext = tni.map((b) => m.and(tdata, b));
    const nz = m.orN(rem);
    const lastbyte = nm(m.mux(c.ge8, m.eq(tnext, rem.slice(0, 3)), m.andN(tn.slice(0, 3))), 'lastbyte');
    const wend = m.andN([tbound, twait, eqC(m, tn, tn4, 3)]);
    const lastcrc = m.andN([tcrc, bend, eqC(m, tn, tn4, 1)]);
    const needstuff = m.and(v, eqC(m, tones, tones3, 5));
    const crcgo = nm(m.and(lastcrc, m.not(needstuff)), 'crcgo');
    const tail = m.andN([tcrc, tbound, eqC(m, tn, tn4, 2)]);
    const pidgo = m.and(tpidp, bend);
    const datastart = m.andN([pidgo, tkd, nz]);
    const dataend = nm(m.andN([tdata, bend, lastbyte]), 'dataend');
    const eopb = nm(m.and(teop, tbound), 'eopb');
    const eopend = m.and(eopb, eqC(m, tn, tn4, 3));
    m.setD(twait, m.and(f.ncl, m.or(c.rAny, m.and(twait, m.not(wend)))));
    m.setD(tsync, m.and(f.ncl, m.or(wend, m.and(tsync, m.not(bend)))));
    m.setD(tpidp, m.and(f.ncl, m.or(m.and(tsync, bend), m.and(tpidp, m.not(bend)))));
    m.setD(tdata, m.and(f.ncl, m.or(datastart, m.and(tdata, m.not(dataend)))));
    m.setD(tcrc, m.and(f.ncl, m.orN([m.andN([pidgo, tkd, m.not(nz)]), dataend, m.andN([tcrc, m.not(crcgo), m.not(tail)])])));
    m.setD(teop, m.and(f.ncl, m.orN([m.and(pidgo, m.not(tkd)), crcgo, tail, m.and(teop, m.not(eopend))])));
    const phi = m.inc(tph);
    tph.forEach((q, i) => m.setD(q, m.and(m.not(idleT), phi[i])));
    const tbi = m.inc(tbc);
    tbc.forEach((q, i) => m.setD(q, m.and(sending, m.mux(adv, q, tbi[i]))));
    const toi = m.inc(tones);
    tones.forEach((q, i) => m.setD(q, m.and(sending, m.mux(tstep, q, m.and(v, toi[i])))));
    // the PID byte, the ROM byte, the load at a byte boundary
    const pidlo = [tkd, m.const(1), tks, m.mux(tkd, m.or(tkn, tks), tog)];
    const pidbyte = [...pidlo, ...pidlo.map((b) => m.not(b))];
    const rom = m.scope('rom', 'descriptor ROM', () => {
      const addrB = [...tnext, pktidx[0], pktidx[1], tcfg];
      const lo = addrB.slice(0, 3), hi = addrB.slice(3, 6);
      const dec = (b: Sig[]) => { const n = nots(m, b); return Array.from({ length: 8 }, (_, k) => eqC(m, b, n, k)); };
      const dl = dec(lo), dh = dec(hi);
      const used = new Map<number, Sig>();
      const mt = (k: number) => { let s = used.get(k); if (!s) used.set(k, (s = m.and(dl[k & 7], dh[k >> 3]))); return s; };
      const ng = m.not(gs);
      return Array.from({ length: 8 }, (_, j) => {
        const ks = USB_ROM.map((val, k) => ((val >> j) & 1 ? k : -1)).filter((k) => k >= 0);
        return m.and(ng, ks.length ? m.orN(ks.map(mt)) : m.const(0));
      });
    });
    const load = mux(m, tsync, rom, pidbyte);
    const shifted = tsh.map((_, i) => (i === 7 ? m.const(0) : tsh[i + 1]));
    const afterAdv = mux(m, adv, tsh, shifted);
    const afterLoad = mux(m, bend, afterAdv, load);
    tsh.forEach((q, i) => m.setD(q, m.mux(twait, afterLoad[i], cbit(m, 0x80, i))));
    const tclr = m.orN([wend, dataend, crcgo, tail, eopend]);
    const tinc = m.orN([m.and(twait, tbound), m.and(tdata, bend), m.and(tcrc, bend), eopb]);
    const inEop = m.orN([twait, tdata, tcrc, teop]);
    const tn1 = m.inc(tn);
    tn.forEach((q, i) => m.setD(q, m.and(inEop, m.and(m.not(tclr), m.mux(tinc, q, tn1[i])))));
    const tlvi = m.mux(tstep, m.or(tlv, m.and(eopb, eqC(m, tn, tn4, 2))), m.xnor(v, tlv));
    m.setD(tlv, m.or(rst, tlvi));
    m.setD(oe, m.and(f.ncl, m.mux(tstep, m.mux(eopb, oe, m.not(eqC(m, tn, tn4, 3))), m.const(1))));
    m.setD(odp, m.or(rst, m.mux(tstep, m.mux(eopb, odp, tn[1]), tlvi)));
    m.setD(odm, m.and(rstn, m.mux(tstep, m.mux(eopb, odm, m.const(0)), m.not(tlvi))));
    return { adv, tstep, idleT };
  });

  // ---- the check registers ---------------------------------------------------------------------------------------------------------
  m.scope('crc', 'CRC5, CRC16', () => {
    const txsel = m.or(tdata, tcrc);
    const d16 = m.mux(txsel, f.dbit, m.mux(tcrc, tsh[0], q16[0]));
    const en16 = m.mux(txsel, m.and(rbody, f.dd), t.adv);
    const init16 = m.orN([rpid, tpidp, rst]);
    const [r16] = m.part(crcUnit(16, CRC16_POLY, 1), [d16, en16, init16, clk], 'CRC-16', 'crc16');
    m.unbus(r16, 16).forEach((s, i) => m.drive(q16[i], s));
    const [r5] = m.part(crcUnit(5, CRC5_POLY, 1), [f.dbit, m.and(rbody, f.dd), m.or(rpid, rst), clk], 'CRC-5', 'crc5');
    m.unbus(r5, 5).forEach((s, i) => m.drive(q5[i], s));
  });

  m.output('odp', odp); m.output('odm', odm); m.output('oe', oe);
  m.outputBus('state', st); m.outputBus('addr', addr); m.output('tog', tog);
  m.output('armed', armed); m.output('stall', stall); m.outputBus('rem', rem);
  m.output('rxact', m.name(m.or(rpid, rbody), 'rxact_o')); m.output('txact', m.name(m.not(t.idleT), 'txact_o'));
  cache = m.build();
  return cache;
}

/** NANDs of the whole device and of each block, from the netlist: the chapter's cost table. */
export function usbCosts(): { total: number; blocks: Record<string, number> } {
  const dev = usbDevice();
  const blocks: Record<string, number> = {};
  for (const inst of dev.netlist!().instances) {
    if (!inst.def.id.startsWith('usb_')) continue;
    blocks[inst.name] = stats(inst.def).nands;
    // the ROM sits inside the transmitter, the two CRC units inside crc
    for (const sub of inst.def.netlist!().instances) if (sub.def.id.startsWith('usb_') || sub.def.id.startsWith('unitcrc')) blocks[`${inst.name}.${sub.name}`] = stats(sub.def).nands;
  }
  return { total: stats(dev).nands, blocks };
}
