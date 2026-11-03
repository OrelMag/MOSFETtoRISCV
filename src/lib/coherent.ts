// Chapter 27's coherent dual-core: each core behind a private write-back cache of 4 sets x 4 words that snoops a
// shared bus (MSI: two state bits per line; BusRd, BusRdX, BusUpgr; a Modified holder answers with a Flush that
// is written back to memory on the same transaction). Beside dualCore (lib/multicore.ts), which stays as it is:
// the cores are the same ComponentDef, the arbiter is the same ARBITER2, the memory the same dataMemory.
// riscv/cohmodel.ts is the specification (its header) and the golden timing model of this file.
//
// cache i:   COH_ACCESS (decode + hit / grant / need), two copies of the {m, v, tag} array (the core's and the
//            snoop port's, written together), a data array with a second read port for the bus, COH_RES (the
//            lr.w / sc.w reservation). The core never waits for a snoop lookup.
// bus:       COH_BUS: the arbiter (gated while busy), busy / owner / count / flush flip-flops, the address and data
//            multiplexers in front of the shared memory.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { andN, busMux2, equal, incrementer } from './combinational';
import { sharedMemory } from './multicore';
import { singleCycleCpu } from './cpu';
import { define, merger, splitter } from './define';
import { ARBITER2 } from './mpdecode';
import { AND, MUX2, NOT, OR, XNOR, XOR } from './gates';
import { DFF, DFFE, register } from './sequential';
import { regfileMP } from './storage';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clock = (): PortDef => ({ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** A box whose netlist is a Builder's: inputs down the left edge, outputs down the right. */
function boxOf(id: string, name: string, label: string, summary: string, ports: PortDef[], b: Builder): ComponentDef {
  const R = b.right, pins: Record<string, [number, number]> = {};
  let yi = 4, yo = 4;
  for (const p of ports) {
    if (p.dir === 'in') { pins[p.name] = [0, yi]; yi += 4; } else { pins[p.name] = [R, yo]; yo += 4; }
  }
  return define({ id, name, category: 'memory', summary, ports, symbol: { kind: 'box', label }, netlist: () => ({ pins, instances: b.instances, nets: b.nets() }) });
}

/** Equality of two w-bit buses (one XNOR for a single bit). */
const eq = (b: Builder, w: number, x: string, y: string, label?: string) => (w === 1 ? b.op1(XNOR, [x, y], label) : b.op1(equal(w), [x, y], label));

/**
 * What a core's access asks of its cache. From the instruction (instrOut) it tells lw / sw / amo* / lr.w / sc.w
 * apart (the core's own decoder takes lr.w and sc.w for an amoswap), then, from the state of the set the address
 * names, whether the access hits, may go on (grant), or needs the bus (BusRd, BusRdX or BusUpgr), with a dirty
 * victim to write back first.
 */
export function cohAccess(t: number): ComponentDef {
  return memo(`cohacc${t}`, () => {
    const b = new Builder(18, 16, 6);
    b.pins('instr', 'req', 'tagA', 'tagS', 'v', 'm', 'resHit');
    const sp = b.op(splitter([7, 20, 5]), ['instr']);
    const f5 = b.op(splitter([1, 1, 1, 1, 1]), [`${sp}.o2`]);
    b.next();
    const isAmo = b.name(b.op1(equal(7), [`${sp}.o0`, b.op1(constWord(7, 0b0101111), [])], 'AMO opcode?'), 'isAmo', true);
    const isStore = b.name(b.op1(equal(7), [`${sp}.o0`, b.op1(constWord(7, 0b0100011), [])], 'store opcode?'), 'isStore', true);
    const hi = b.op1(OR, [b.op1(OR, [`${f5}.o2`, `${f5}.o3`]), `${f5}.o4`], 'funct5 >= 4');
    const lrsc = b.op1(AND, [`${f5}.o1`, b.op1(NOT, [hi])], 'lr / sc (funct5 = 0001x)');
    b.next();
    const isLR = b.name(b.op1(andN(3), [isAmo, lrsc, b.op1(NOT, [`${f5}.o0`])], 'lr.w'), 'isLR', true);
    const isSC = b.name(b.op1(andN(3), [isAmo, lrsc, `${f5}.o0`], 'sc.w'), 'isSC', true);
    b.next();
    const wr = b.name(b.op1(OR, [isStore, b.op1(AND, [isAmo, b.op1(NOT, [isLR])])], 'writes: sw, amo, sc'), 'wr', true);
    const scFail = b.name(b.op1(AND, [isSC, b.op1(NOT, ['resHit'])], 'sc.w, no reservation'), 'scFail', true);
    const tm = b.name(eq(b, t, 'tagA', 'tagS', 'tag match'), 'tm', true);
    b.next();
    const hit = b.name(b.op1(AND, [tm, 'v'], 'hit'), 'hit', true);
    const perm = b.name(b.op1(AND, [hit, b.op1(OR, [b.op1(NOT, [wr]), 'm'], 'read, or Modified')], 'may go on'), 'perm', true);
    b.next();
    const grant = b.name(b.op1(OR, [scFail, perm], 'grant'), 'grant', true);
    const need = b.name(b.op1(AND, ['req', b.op1(NOT, [grant])], 'needs the bus'), 'need', true);
    b.next();
    b.wire(grant, 'grant');
    b.wire(need, 'need');
    b.wire(b.op1(AND, [need, hit], 'BusUpgr'), 'upgr');
    b.wire(b.op1(andN(3), [need, b.op1(NOT, [tm]), 'm'], 'dirty victim'), 'wb');
    b.wire(wr, 'wr');
    b.wire(isLR, 'isLR');
    b.wire(isSC, 'isSC');
    b.wire(scFail, 'scFail');
    return boxOf(`cohacc${t}`, 'Cache access decode', 'ACCESS',
      'From the instruction: lw, sw, amoswap / amoadd (they need the line Modified), lr.w (a read that sets the reservation), sc.w (a write that fails at once without a reservation). From the set the address names: hit = valid and equal tags; grant = a failed sc.w, or a hit that allows the access (a write needs M). Otherwise the cache needs the bus: BusUpgr when it holds the line Shared and writes, else BusRd / BusRdX; wb = the set holds a dirty line of another address, written back first.',
      [bus('instr', 32, 'in'), bit('req', 'in'), bus('tagA', t, 'in'), bus('tagS', t, 'in'), bit('v', 'in'), bit('m', 'in'), bit('resHit', 'in'),
        bit('grant', 'out'), bit('need', 'out'), bit('upgr', 'out'), bit('wb', 'out'), bit('wr', 'out'), bit('isLR', 'out'), bit('isSC', 'out'), bit('scFail', 'out')], b);
  });
}

/**
 * The reservation of lr.w / sc.w: valid + the line address. lr.w sets it; any sc.w clears it (after it was
 * tested); another cache's BusRdX / BusUpgr for the line (the snooped invalidation) and this cache's own fill
 * evicting the line clear it, and a clear wins over a set at the same edge.
 */
export function cohRes(k2: number, coh: boolean): ComponentDef {
  return memo(`cohres${k2}${coh ? '' : 'n'}`, () => {
    const b = new Builder(18, 16, 6);
    b.pins('req', 'grant', 'isLR', 'isSC', 'line', 'busLine', 'busSet', 'grantCyc', 'lastCyc', 'isCur', 'busWr', 'busUpgr', 'clk');
    const rv = b.add(DFF, 'reservation valid', 'rv');
    const rl = b.add(register(k2), 'reserved line', 'rl');
    b.wire('clk', `${rv}.clk`); b.wire('clk', `${rl}.clk`);
    const v = b.name(`${rv}.q`, 'resV', true), line = b.name(`${rl}.q`, 'resLine', true);
    b.next();
    const mCore = b.op1(equal(k2), [line, 'line'], 'same line as the access');
    const mBus = b.name(b.op1(equal(k2), [line, 'busLine'], 'same line as the bus'), 'sameBus', true);
    const sl = b.op(splitter([2, k2 - 2]), [line]);
    const setEq = b.op1(equal(2), [`${sl}.o0`, 'busSet'], 'same set as the fill');
    b.next();
    b.wire(b.op1(AND, [v, mCore], 'holds'), 'resHit');
    const retire = b.op1(AND, ['req', 'grant'], 'access done');
    const lrRet = b.name(b.op1(AND, [retire, 'isLR'], 'lr.w done'), 'lrDone', true);
    const scAny = b.op1(AND, [retire, 'isSC'], 'sc.w done');
    const ownClr = b.op1(andN(4), [b.op1(AND, ['lastCyc', 'isCur']), b.op1(NOT, ['busUpgr']), b.op1(AND, [v, setEq]), b.op1(NOT, [mBus])], 'own fill evicts it');
    let clr = ownClr;
    if (coh) {
      const lrSame = b.op1(AND, [lrRet, b.op1(equal(k2), ['line', 'busLine'], 'lr.w of the invalidated line')], 'lr.w done on the line');
      clr = b.op1(OR, [ownClr, b.op1(andN(3), [b.op1(AND, ['grantCyc', b.op1(NOT, ['isCur'])]), 'busWr', b.op1(OR, [b.op1(AND, [v, mBus]), lrSame])], 'snooped invalidation')], 'lost');
    }
    b.next();
    b.wire(b.op1(AND, [b.op1(NOT, [clr]), b.op1(OR, [lrRet, b.op1(AND, [v, b.op1(NOT, [scAny])])])], 'next valid'), `${rv}.d`);
    b.wire('line', `${rl}.d`);
    b.wire(lrRet, `${rl}.en`);
    return boxOf(`cohres${k2}${coh ? '' : 'n'}`, 'LR / SC reservation', 'RESERVE',
      'valid + line address (16-byte granule). lr.w sets it; any sc.w clears it; a snooped BusRdX / BusUpgr for the line, or this cache evicting the line to fill another, clears it, and a clear wins over a set at the same edge. resHit = valid and the access is to the reserved line.',
      [bit('req', 'in'), bit('grant', 'in'), bit('isLR', 'in'), bit('isSC', 'in'), bus('line', k2, 'in'), bus('busLine', k2, 'in'), bus('busSet', 2, 'in'), bit('grantCyc', 'in'), bit('lastCyc', 'in'), bit('isCur', 'in'), bit('busWr', 'in'), bit('busUpgr', 'in'), clock(),
        bit('resHit', 'out')], b);
  });
}

/**
 * One core's cache: {m, v, tag} per set kept twice (the core's copy, read at the core's address; the snoop copy,
 * read at the bus's: both written from the bus side only, because under MSI a hit changes no state), 16 words of
 * data with a second read port for the bus (write-back to memory, Flush to the other cache), the access decode and
 * the reservation. `coh` false: the snoop port stays unused (the chapter's first cache step).
 */
export function coherentCache(K: number, coh = true): ComponentDef {
  const t = K - 4, k2 = K - 2, rest = 32 - 6 - t;
  return memo(`cohcache${K}${coh ? '' : 'n'}`, () => {
    const b = new Builder(18, 16, 6);
    b.pins('instr', 'memAddr', 'memWData', 'memWE', 'memReq', 'isCur', 'grantCyc', 'lastCyc', 'dataPh', 'busWr', 'busUpgr', 'busAddr', 'word', 'dbus', 'clk');
    const sa = b.op(splitter([2, 2, 2, t, rest]), ['memAddr'], 'address fields');
    const ba = b.op(splitter([2, 2, 2, t, rest]), ['busAddr'], 'bus address fields');
    const set = b.name(`${sa}.o2`, 'set', true), tagA = b.name(`${sa}.o3`, 'tag', true), busSet = b.name(`${ba}.o2`, 'busSet', true), busTag = b.name(`${ba}.o3`, 'busTag', true);
    const coreIdx = b.name(b.op1(merger([2, 2]), [`${sa}.o1`, set], '{set, word}'), 'coreIdx', true);
    const line = b.name(b.op1(merger([2, t]), [set, tagA], 'line'), 'line', true);
    const busLine = b.name(b.op1(merger([2, t]), [busSet, busTag], 'bus line'), 'busLine', true);
    const busIdx = b.name(b.op1(merger([2, 2]), ['word', busSet], '{set, word} of the bus'), 'busIdx', true);
    b.next();
    // the two tag / state arrays
    const ct = b.op(regfileMP(2, t + 2, 1, 1), ['clk', '', '', '', set], 'core tags {m, v, tag}', 'ctags');
    const st = coh ? b.op(regfileMP(2, t + 2, 1, 1), ['clk', '', '', '', busSet], 'snoop tags {m, v, tag}', 'stags') : '';
    const cs = b.op(splitter([t, 1, 1]), [`${ct}.rd0`], undefined, 'cs');
    const ss = coh ? b.op(splitter([t, 1, 1]), [`${st}.rd0`], undefined, 'ss') : '';
    b.next();
    const acc = b.op(cohAccess(t), ['instr', 'memReq', tagA, `${cs}.o0`, `${cs}.o1`, `${cs}.o2`, ''], 'access', 'acc');
    const grant = b.name(`${acc}.grant`, 'grant', true), wr = b.name(`${acc}.wr`, 'wr', true), isLR = b.name(`${acc}.isLR`, 'isLR', true), isSC = b.name(`${acc}.isSC`, 'isSC', true), scFail = b.name(`${acc}.scFail`, 'scFail', true);
    const res = b.op(cohRes(k2, coh), ['memReq', grant, isLR, isSC, line, busLine, busSet, 'grantCyc', 'lastCyc', 'isCur', 'busWr', 'busUpgr', 'clk'], 'reservation', 'res');
    b.wire(`${res}.resHit`, `${acc}.resHit`);
    // the snoop lookup
    const sHit = coh ? b.name(b.op1(AND, [eq(b, t, `${ss}.o0`, busTag, 'tag match'), `${ss}.o1`], 'snoop hit'), 'snoopHit', true) : '';
    const sM = coh ? b.name(b.op1(AND, [sHit, `${ss}.o2`], 'snoop: Modified'), 'snoopM', true) : '';
    b.next();
    // tag writes: the owner at the last cycle of its transaction, the other cache at the grant edge
    const wOwn = b.op1(AND, ['lastCyc', 'isCur'], 'own fill / upgrade done');
    const we = b.name(coh ? b.op1(OR, [wOwn, b.op1(AND, [b.op1(AND, ['grantCyc', b.op1(NOT, ['isCur'])]), sHit])], 'snooped line changes') : wOwn, 'tagWE', true);
    const wd = b.name(b.op1(merger([t, 1, 1]), [busTag, b.op1(OR, ['isCur', b.op1(NOT, ['busWr'])], 'valid'), b.op1(AND, ['isCur', wr], 'Modified')], '{m, v, tag}'), 'tagWD', true);
    for (const a of coh ? [ct, st] : [ct]) { b.wire(we, `${a}.we0`); b.wire(busSet, `${a}.wa0`); b.wire(wd, `${a}.wd0`); }
    // the data array: port 0 the core's (and the fill), port 1 the bus's
    const fillSel = b.name(b.op1(andN(3), ['isCur', 'dataPh', b.op1(NOT, ['busUpgr'])], 'fill a word'), 'fill', true);
    const coreWE = b.op1(andN(3), ['memWE', b.op1(NOT, [isLR]), b.op1(NOT, [scFail])], 'store done');
    const dwe = b.op1(OR, [fillSel, coreWE], 'data write');
    const dwa = b.op1(busMux2(4), [coreIdx, busIdx, fillSel], 'write address');
    const dwd = b.op1(busMux2(32), ['memWData', 'dbus', fillSel], 'write data');
    b.next();
    const data = b.op(regfileMP(4, 32, 2, 1), ['clk', dwe, dwa, dwd, coreIdx, busIdx], '16 words, 2 read ports', 'data');
    b.next();
    const rdata = b.op1(busMux2(32), [`${data}.rd0`, b.op1(merger([1, 31]), [scFail, b.op1(constWord(31, 0), [])], 'sc.w result'), isSC], 'read data / sc result');
    b.wire(rdata, 'memRData');
    b.wire(grant, 'grant');
    b.wire(`${acc}.need`, 'need');
    b.wire(`${acc}.upgr`, 'upgr');
    b.wire(`${acc}.wb`, 'wb');
    b.wire(wr, 'wr');
    b.wire(coh ? sM : b.op1(TIE0, []), 'snoopM');
    b.wire(`${data}.rd1`, 'rd1');
    b.wire(`${cs}.o0`, 'vtag');
    return boxOf(`cohcache${K}${coh ? '' : 'n'}`, `Write-back cache${coh ? ' with an MSI snoop port' : ' (no snooping)'}`, coh ? 'MSI $' : 'WB $',
      `4 sets × 4 words, direct-mapped, write-back. Per set {m, v, tag}: I = 00, S = 10, M = 11 (two state bits), kept in two arrays written together, one read at the core's address, one at the bus's, so a snoop never takes the core's tag port. ${coh ? 'The other cache\'s BusRd turns M into S (it supplies the line), BusRdX and BusUpgr turn a hit into I, at the grant edge.' : 'This variant never looks at the bus: nothing is invalidated and nothing is supplied.'}`,
      [bus('instr', 32, 'in'), bus('memAddr', 32, 'in'), bus('memWData', 32, 'in'), bit('memWE', 'in'), bit('memReq', 'in'),
        bit('isCur', 'in'), bit('grantCyc', 'in'), bit('lastCyc', 'in'), bit('dataPh', 'in'), bit('busWr', 'in'), bit('busUpgr', 'in'), bus('busAddr', 32, 'in'), bus('word', 2, 'in'), bus('dbus', 32, 'in'), clock(),
        bit('grant', 'out'), bus('memRData', 32, 'out'), bit('need', 'out'), bit('upgr', 'out'), bit('wb', 'out'), bit('wr', 'out'), bit('snoopM', 'out'), bus('rd1', 32, 'out'), bus('vtag', t, 'out')], b);
  });
}

/**
 * The bus: one transaction at a time. Idle, the requests go to ARBITER2; the winner is granted in that cycle
 * (the other cache's line changes at its edge) and busy / owner / flush / count are loaded: count 0 if a dirty
 * victim goes back first (0-3), else 4; 4-7 move the line (a word a cycle, from the Modified holder if there is one,
 * which writes it to memory in the same cycle, else from memory); a BusUpgr is the single cycle 4. It drives the
 * shared memory's address, data and write enable and the data bus.
 */
export function cohBus(K: number): ComponentDef {
  const t = K - 4, rest = 32 - 6 - t;
  return memo(`cohbus${K}`, () => {
    const b = new Builder(18, 16, 6);
    b.pins('need0', 'need1', 'upgr0', 'upgr1', 'wb0', 'wb1', 'wr0', 'wr1', 'snm0', 'snm1', 'addr0', 'addr1', 'vtag0', 'vtag1', 'drd0', 'drd1', 'memRd', 'clk');
    const busy = b.add(DFF, 'busy', 'busy'), owner = b.add(DFFE, 'owner', 'owner'), flush = b.add(DFFE, 'flush: the other cache supplies', 'flush'), cnt = b.add(register(3), 'count', 'cnt');
    for (const f of [busy, owner, flush, cnt]) b.wire('clk', `${f}.clk`);
    const bz = b.name(`${busy}.q`, 'busy', true), ow = b.name(`${owner}.q`, 'owner', true), fl = b.name(`${flush}.q`, 'flush', true);
    const cs = b.op(splitter([1, 1, 1]), [`${cnt}.q`], undefined, 'cs');
    const c0 = b.name(`${cs}.o0`, 'c0', true), c1 = b.name(`${cs}.o1`, 'c1', true), c2 = b.name(`${cs}.o2`, 'c2', true);
    b.next();
    const nb = b.op1(NOT, [bz]);
    const arb = b.op(ARBITER2, [b.op1(AND, ['need0', nb], 'asks'), b.op1(AND, ['need1', nb], 'asks'), 'clk'], 'arbiter (idle only)', 'arb');
    const g1 = b.name(`${arb}.g1`, 'g1', true);
    const grantCyc = b.name(b.op1(OR, [`${arb}.g0`, g1], 'a grant cycle'), 'grantCyc', true);
    const cur = b.name(b.op1(MUX2, [g1, ow, bz], 'the core in turn'), 'cur', true);
    b.next();
    const upC = b.name(b.op1(MUX2, ['upgr0', 'upgr1', cur]), 'busUpgr', true), wrC = b.name(b.op1(MUX2, ['wr0', 'wr1', cur]), 'busWr', true);
    const wbC = b.op1(MUX2, ['wb0', 'wb1', cur]), snO = b.op1(MUX2, ['snm1', 'snm0', cur], 'the other cache: Modified');
    const busAddr = b.name(b.op1(busMux2(32), ['addr0', 'addr1', cur], 'address of the transaction'), 'busAddr', true);
    b.next();
    const flushN = b.op1(AND, [snO, b.op1(NOT, [upC])], 'it supplies the line');
    const last = b.name(b.op1(andN(3), [bz, c2, b.op1(OR, [upC, b.op1(AND, [c1, c0])])], 'last cycle'), 'lastCyc', true);
    const inc = b.op1(incrementer(3), [`${cnt}.q`], 'count + 1');
    const start = b.op1(merger([2, 1]), [b.op1(constWord(2, 0), []), b.op1(NOT, [wbC])], 'start: 0 or 4');
    b.wire(b.op1(busMux2(3), [inc, start, grantCyc], 'next count'), `${cnt}.d`);
    b.wire(b.op1(OR, [grantCyc, bz]), `${cnt}.en`);
    b.wire(b.op1(OR, [grantCyc, b.op1(AND, [bz, b.op1(NOT, [last])])], 'next busy'), `${busy}.d`);
    b.wire(g1, `${owner}.d`); b.wire(grantCyc, `${owner}.en`);
    b.wire(flushN, `${flush}.d`); b.wire(grantCyc, `${flush}.en`);
    const dataPh = b.name(b.op1(AND, [bz, c2], 'moving the line'), 'dataPh', true), wbPh = b.name(b.op1(AND, [bz, b.op1(NOT, [c2])], 'writing the victim back'), 'wbPh', true);
    b.next();
    const wdSel = b.name(b.op1(busMux2(32), ['drd0', 'drd1', b.op1(XOR, [ow, c2], 'who has the data')], 'word from the supplier'), 'wd', true);
    const dbus = b.op1(busMux2(32), ['memRd', wdSel, fl], 'data bus');
    const vtagO = b.op1(busMux2(t), ['vtag0', 'vtag1', ow], 'victim tag');
    const sb = b.op(splitter([2, 2, 2, t, rest]), [busAddr]);
    const tagSel = b.op1(busMux2(t), [`${sb}.o3`, vtagO, wbPh], 'tag: line or victim');
    const memAddr = b.op1(merger([2, 2, 2, t, rest]), [b.op1(constWord(2, 0), []), b.op1(merger([1, 1]), [c0, c1], 'word'), `${sb}.o2`, tagSel, b.op1(constWord(rest, 0), [])], 'memory address');
    b.wire(grantCyc, 'grantCyc'); b.wire(last, 'lastCyc'); b.wire(dataPh, 'dataPh');
    b.wire(b.op1(NOT, [cur]), 'isCur0'); b.wire(cur, 'isCur1');
    b.wire(wrC, 'busWr'); b.wire(upC, 'busUpgr'); b.wire(busAddr, 'busAddr');
    b.wire(b.op1(merger([1, 1]), [c0, c1], 'word'), 'word');
    b.wire(dbus, 'dbus'); b.wire(bz, 'busy');
    b.wire(memAddr, 'memAddr'); b.wire(wdSel, 'memWd'); b.wire(b.op1(OR, [wbPh, b.op1(AND, [dataPh, fl])], 'memory write'), 'memWE');
    return boxOf(`cohbus${K}`, 'Snooping bus', 'BUS',
      'One transaction at a time. Idle: the round-robin arbiter picks a requester (a grant cycle: the other cache\'s copy changes at its edge). Busy: count 0-3 writes a dirty victim back, 4-7 moves the line a word a cycle, from the Modified holder if there is one (the Flush, written to memory in the same cycle) else from memory; a BusUpgr is the single cycle 4.',
      [bit('need0', 'in'), bit('need1', 'in'), bit('upgr0', 'in'), bit('upgr1', 'in'), bit('wb0', 'in'), bit('wb1', 'in'), bit('wr0', 'in'), bit('wr1', 'in'), bit('snm0', 'in'), bit('snm1', 'in'),
        bus('addr0', 32, 'in'), bus('addr1', 32, 'in'), bus('vtag0', t, 'in'), bus('vtag1', t, 'in'), bus('drd0', 32, 'in'), bus('drd1', 32, 'in'), bus('memRd', 32, 'in'), clock(),
        bit('grantCyc', 'out'), bit('lastCyc', 'out'), bit('dataPh', 'out'), bit('isCur0', 'out'), bit('isCur1', 'out'), bit('busWr', 'out'), bit('busUpgr', 'out'), bus('busAddr', 32, 'out'), bus('word', 2, 'out'), bus('dbus', 32, 'out'),
        bit('busy', 'out'), bus('memAddr', 32, 'out'), bus('memWd', 32, 'out'), bit('memWE', 'out')], b);
  });
}

export interface CoherentOptions {
  /** Shared memory 2^dmemK words (5 or 6). */
  dmemK?: number;
  imemK?: number;
  /** false: the caches never snoop (chapter 27's first cache step). */
  coherent?: boolean;
}

/**
 * The dual-core of chapter 27 behind coherent caches. The cores are dualCore's; each core's data port goes to its
 * cache instead of the arbiter, and the caches share the bus. Outputs per core: pc, retire (low while its access
 * waits), grant (the cache lets the access go on); busy for the bus.
 */
export function coherentDualCore(program: number[], opts: CoherentOptions = {}): ComponentDef {
  const K = opts.dmemK ?? 5, imemK = opts.imemK ?? 6, coh = opts.coherent !== false;
  if (K < 5 || K > 6) throw new Error('coherentDualCore: dmemK 5 or 6');
  const CORE = singleCycleCpu(program, { shared: true, adder: 'ks', imemK });
  const key = `cohdual_${CORE.id}_d${K}${coh ? '' : '_nc'}`;
  return memo(key, () => {
    const cg = symbolGeom(CORE), CA = coherentCache(K, coh), ag = symbolGeom(CA), BU = cohBus(K), bg = symbolGeom(BU), DM = sharedMemory(K), dg = symbolGeom(DM);
    const xC = 20, xA = xC + cg.w + 40, xB = xA + ag.w + 40, xD = xB + bg.w + 40, xP = xD + dg.w + 24;
    const y0 = 4, y1 = y0 + Math.max(cg.h, ag.h) + 24;
    const T = true as const;
    const I = [0, 1];
    return {
      id: key, name: `Dual-core RV32I (${coh ? 'coherent' : 'private'} caches)`, category: 'cpu',
      summary: coh
        ? 'Two cores, each behind a private write-back cache (4 sets × 4 words), kept coherent by snooping a shared bus with MSI. A miss takes the bus: a line from memory, or from the other cache if it holds it Modified (a Flush, written back on the way). A write to a Shared line broadcasts BusUpgr and the other copy is invalidated. lr.w / sc.w use a reservation per cache.'
        : 'The coherent dual-core\'s caches with the snooping switched off: each cache is a private write-back copy that never looks at the bus. Each core sees its own writes only; memory is stale until a line is evicted.',
      ports: [{ name: 'clk', width: 1, dir: 'in', side: 'left', clock: true }, ...I.map((i) => bus(`pc${i}`, 32, 'out')), ...I.map((i) => bit(`retire${i}`, 'out')), ...I.map((i) => bit(`grant${i}`, 'out')), bit('busy', 'out')],
      symbol: { kind: 'box', label: coh ? '2 × RV32I + MSI $' : '2 × RV32I + $' },
      netlist: () => ({
        pins: { clk: [0, y1 - 6], ...Object.fromEntries(I.flatMap((i) => [[`pc${i}`, [xP, y0 + 4 + 4 * i]], [`retire${i}`, [xP, y0 + 12 + 4 * i]], [`grant${i}`, [xP, y0 + 20 + 4 * i]]])), busy: [xP, y0 + 28] },
        instances: [
          ...I.flatMap((i) => [
            { name: `h${i}`, def: constWord(32, i), at: [4, (i ? y1 : y0) + 4] as [number, number], label: `hart ${i}` },
            { name: `core${i}`, def: CORE, at: [xC, i ? y1 : y0] as [number, number], label: `core ${i}` },
            { name: `cache${i}`, def: CA, at: [xA, i ? y1 : y0] as [number, number], label: `cache ${i}` },
          ]),
          { name: 'bus', def: BU, at: [xB, (y0 + y1) / 2 - 4], label: 'snooping bus' },
          { name: 'dm', def: DM, at: [xD, (y0 + y1) / 2 - 4], label: 'shared memory' },
        ],
        nets: [
          { name: 'clk', ends: ['clk', 'core0.clk', 'core1.clk', 'cache0.clk', 'cache1.clk', 'bus.clk', 'dm.clk'], tags: T },
          ...I.flatMap((i) => [
            { name: `hart${i}`, ends: [`h${i}.y`, `core${i}.hartid`] },
            { name: `instr${i}`, ends: [`core${i}.instrOut`, `cache${i}.instr`], tags: T },
            { name: `addr${i}`, ends: [`core${i}.memAddr`, `cache${i}.memAddr`, `bus.addr${i}`], tags: T },
            { name: `wdata${i}`, ends: [`core${i}.memWData`, `cache${i}.memWData`], tags: T },
            { name: `we${i}`, ends: [`core${i}.memWE`, `cache${i}.memWE`], tags: T },
            { name: `req${i}`, ends: [`core${i}.memReq`, `cache${i}.memReq`], tags: T },
            { name: `grant${i}`, ends: [`cache${i}.grant`, `core${i}.grant`, `grant${i}`], tags: T },
            { name: `rdata${i}`, ends: [`cache${i}.memRData`, `core${i}.memRData`], tags: T },
            { name: `need${i}`, ends: [`cache${i}.need`, `bus.need${i}`], tags: T },
            { name: `upgr${i}`, ends: [`cache${i}.upgr`, `bus.upgr${i}`], tags: T },
            { name: `wb${i}`, ends: [`cache${i}.wb`, `bus.wb${i}`], tags: T },
            { name: `wr${i}`, ends: [`cache${i}.wr`, `bus.wr${i}`], tags: T },
            { name: `snoopM${i}`, ends: [`cache${i}.snoopM`, `bus.snm${i}`], tags: T },
            { name: `vtag${i}`, ends: [`cache${i}.vtag`, `bus.vtag${i}`], tags: T },
            { name: `rd1_${i}`, ends: [`cache${i}.rd1`, `bus.drd${i}`], tags: T },
            { name: `isCur${i}`, ends: [`bus.isCur${i}`, `cache${i}.isCur`], tags: T },
            { name: `pc${i}`, ends: [`core${i}.pcOut`, `pc${i}`], tags: T },
            { name: `retire${i}`, ends: [`core${i}.retire`, `retire${i}`], tags: T },
          ]),
          ...(['grantCyc', 'lastCyc', 'dataPh', 'busWr', 'busUpgr', 'busAddr', 'word', 'dbus'] as const).map((n) => ({ name: n, ends: [`bus.${n}`, 'cache0.' + n, 'cache1.' + n], tags: T })),
          { name: 'busy', ends: ['bus.busy', 'busy'], tags: T },
          { name: 'memAddr', ends: ['bus.memAddr', 'dm.addr'], tags: T }, { name: 'memWd', ends: ['bus.memWd', 'dm.wd'], tags: T }, { name: 'memWE', ends: ['bus.memWE', 'dm.we'], tags: T },
          { name: 'memRd', ends: ['dm.rd', 'bus.memRd'], tags: T },
        ],
      }),
    } satisfies ComponentDef;
  });
}

