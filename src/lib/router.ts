// Chapter 51's fast path in gates, on comm/ethframe.ts's byte stream: net/fastpath.ts is its golden model, compared at every output of
// every clock (tests/net-fastpath.test.ts). Memories are bigRam (roadmap decision 11): the packet buffer, the routes as a binary trie, the
// next-hop table as bytes, so no 48-bit register or comparator exists anywhere: a MAC is checked and written a byte at a time.

import { ACT_DROP, ACT_PUNT, C_FORWARD, C_LOCAL, C_NO_ROUTE, posOf, S_ADJ, S_DECIDE, S_RX, S_TX, S_WALK, verdict } from '../net/fastpath';
import { TTL_DELTA } from '../net/ipv4';
import { ADJ_K, BUF_K, PORT_CPU, TRIE_K } from '../net/trie';
import type { ComponentDef, PortDef } from '../sim/types';
import { kit } from './axi';
import { bigRam, bigRamWithInit } from './bigmem';
import { Builder } from './builder';
import { equal, incrementer, rca } from './combinational';
import { define, ones } from './define';
import { XOR } from './gates';
import { DFF, DFFE, register } from './sequential';
import { tableBlock } from './serdes';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);
const sidePins = (ports: PortDef[], right: number, pitch = 3): Record<string, [number, number]> => {
  const pins: Record<string, [number, number]> = {};
  let yl = 2, yr = 2;
  for (const p of ports) if (p.dir === 'in') { pins[p.name] = [0, yl]; yl += pitch; } else { pins[p.name] = [right, yr]; yr += pitch; }
  return pins;
};

/** Where a byte is in the frame, from the counter's low six bits and "the rest are zero". */
export const RT_POS = tableBlock('rtpos', 'Frame position decoder', 'What the byte counter means: the MAC fields and their byte index, the type, the IP header\'s version, TTL, checksum and destination bytes. Offsets are from the destination address; IP starts at 14.',
  [{ name: 'lo', width: 6 }, { name: 'zero', width: 1 }],
  [{ name: 'mac', width: 1 }, { name: 'src', width: 1 }, { name: 'i12', width: 1 }, { name: 'i13', width: 1 }, { name: 'i14', width: 1 }, { name: 'i22', width: 1 }, { name: 'i24', width: 1 }, { name: 'i25', width: 1 }, { name: 'dst', width: 1 }, { name: 'hdr', width: 1 }, { name: 'i33', width: 1 }, { name: 'idx', width: 3 }],
  ([lo, z]) => { if (!z) return Array<number>(12).fill(0); const p = posOf(lo); return [p.mac, p.src, p.i12, p.i13, p.i14, p.i22, p.i24, p.i25, p.dst, p.hdr, p.i33].map(Number).concat(p.idx); }, 'POS');

/** The four byte values the header is tested against. */
export const RT_BYTE = tableBlock('rtbyte', 'Header byte tests', 'Is this byte 0xFF (broadcast MAC), 0x08 or 0x00 (the IPv4 type), or 0x45 (version 4, five header words)?',
  [{ name: 'd', width: 8 }], [{ name: 'ff', width: 1 }, { name: 'x08', width: 1 }, { name: 'x00', width: 1 }, { name: 'x45', width: 1 }],
  ([d]) => [d === 0xff, d === 0x08, d === 0, d === 0x45].map(Number), 'BYTE=');

/** DECIDE: the frame's facts to drop, slow path or lookup. */
export const RT_VERDICT = tableBlock('rtverdict', 'What to do with the frame', 'From what the receive side collected: drop it, hand it to the slow path (and why), or look its destination up.',
  [{ name: 'me', width: 1 }, { name: 'bcast', width: 1 }, { name: 'len14', width: 1 }, { name: 'isip', width: 1 }, { name: 'r34', width: 1 }, { name: 'ip45', width: 1 }, { name: 'sumok', width: 1 }, { name: 'ttlok', width: 1 }],
  [{ name: 'act', width: 2 }, { name: 'cause', width: 3 }],
  ([me, bcast, len14, isIp, r34, ip45, sumOk, ttlOk]) => { const v = verdict({ me, bcast, len14, isIp, r34, ip45, sumOk, ttlOk }); return [v.act, v.cause]; }, 'VERDICT');

/** The state machine as a table, unused state codes don't-care. */
export const RT_CTL = tableBlock('rtctl', 'Fast path control', 'RX → DECIDE → WALK → ADJ → TX → RX, with a drop going straight back and the slow path skipping the lookup.',
  [{ name: 's', width: 3 }, { name: 'rxdone', width: 1 }, { name: 'act', width: 2 }, { name: 'wend', width: 1 }, { name: 'rz', width: 1 }, { name: 'txdone', width: 1 }],
  [{ name: 'ns', width: 3 }, { name: 'clr', width: 1 }, { name: 'rx', width: 1 }, { name: 'dec', width: 1 }, { name: 'walk', width: 1 }, { name: 'adj', width: 1 }, { name: 'tx', width: 1 }, { name: 'nr', width: 1 }],
  ([s, rxdone, act, wend, rz, txdone]) => {
    let ns = s, clr = 0, nr = 0;
    if (s === S_RX && rxdone) ns = S_DECIDE;
    else if (s === S_DECIDE) { if (act === ACT_DROP) { ns = S_RX; clr = 1; } else ns = act === ACT_PUNT ? S_TX : S_WALK; }
    else if (s === S_WALK && wend) { if (rz) { ns = S_TX; nr = 1; } else ns = S_ADJ; }
    else if (s === S_ADJ) ns = S_TX;
    else if (s === S_TX && txdone) { ns = S_RX; clr = 1; }
    return [ns, clr, s === S_RX ? 1 : 0, s === S_DECIDE ? 1 : 0, s === S_WALK ? 1 : 0, s === S_ADJ ? 1 : 0, s === S_TX ? 1 : 0, nr];
  }, 'CTL', (v) => v[0] <= S_TX);

const anyOf = (g: ReturnType<typeof kit>, x: string, w: number): string => g.or(...g.split(x, ones(w)));

/** A flag set by `set`, held until `clr`. */
function sticky(b: Builder, g: ReturnType<typeof kit>, set: string, clr: string, label: string, name: string): string {
  const f = b.op(DFF, ['', 'clk'], label, name);
  b.wire(g.and(g.or(`${f}.q`, set), g.not(clr)), `${f}.d`);
  return `${f}.q`;
}

/** The receive side: what the header says, a byte a cycle, including the one's-complement sum of its twenty bytes. */
export const RT_CHECK: ComponentDef = (() => {
  const ports: PortDef[] = [bus('d', 8, 'in'), bit('mv', 'in'), bus('own', 8, 'in'), bit('odd', 'in'), bit('mac', 'in'), bit('i12', 'in'), bit('i13', 'in'), bit('i14', 'in'), bit('i22', 'in'), bit('i24', 'in'), bit('i25', 'in'), bit('hdr', 'in'), bit('i33', 'in'), bit('clr', 'in'), clk(),
    bus('act', 2, 'out'), bus('cause', 3, 'out'), bus('ttl', 8, 'out'), bus('chk', 16, 'out')];
  const b = new Builder(24, 18, 5), g = kit(b);
  b.maxH = 70;
  b.pins('d', 'mv', 'own', 'odd', 'mac', 'i12', 'i13', 'i14', 'i22', 'i24', 'i25', 'hdr', 'i33', 'clr', 'clk');
  const tests = b.op(RT_BYTE, ['d'], 'byte tests', 'tests');
  const same = b.op1(equal(8), ['d', 'own'], 'our MAC?', 'same');
  const inMac = b.name(g.and('mv', 'mac'), 'a MAC byte', true);
  b.next();
  const meBad = sticky(b, g, g.and(inMac, g.not(same)), 'clr', 'not our MAC', 'mebad');
  const bBad = sticky(b, g, g.and(inMac, g.not(`${tests}.ff`)), 'clr', 'not broadcast', 'bbad');
  const m13 = b.name(g.and('mv', 'i13'), 'byte 13', true);
  const len14 = sticky(b, g, m13, 'clr', '14 bytes seen', 'len14');
  const typeBad = sticky(b, g, g.or(g.and('mv', 'i12', g.not(`${tests}.x08`)), g.and(m13, g.not(`${tests}.x00`))), 'clr', 'not type 0x0800', 'typebad');
  const verBad = sticky(b, g, g.and('mv', 'i14', g.not(`${tests}.x45`)), 'clr', 'not 0x45', 'verbad');
  const r34 = sticky(b, g, g.and('mv', 'i33'), 'clr', '34 bytes seen', 'r34');
  b.next();
  const ttl = b.op(register(8), ['d', g.and('mv', 'i22'), 'clk'], 'TTL', 'ttl');
  const chkHi = b.op(register(8), ['d', g.and('mv', 'i24'), 'clk'], 'checksum, high byte', 'chkhi');
  const chkLo = b.op(register(8), ['d', g.and('mv', 'i25'), 'clk'], 'checksum, low byte', 'chklo');
  b.next();
  // the sum: a byte in its half of the word, the carry kept for the next add (one's complement, end-around in time)
  const zero8 = g.konst(8, 0);
  const word = g.merge([g.mux(8, 'd', zero8, g.not('odd')), g.mux(8, 'd', zero8, 'odd')], [8, 8]);
  const add = b.op(rca(16), ['', word, ''], 'one\'s complement sum', 'add');
  const nclr = g.not('clr');
  const sumEn = g.or(g.and('mv', 'hdr'), 'clr');
  const sum = b.op(register(16), [g.gate(`${add}.s`, 16, nclr), sumEn, 'clk'], 'sum so far', 'sum');
  const c = b.op(DFFE, [g.and(`${add}.cout`, nclr), sumEn, 'clk'], 'carry', 'c');
  b.wire(`${sum}.q`, `${add}.a`);
  b.wire(`${c}.q`, `${add}.cin`);
  b.next();
  const [s0, sHi] = g.split(`${sum}.q`, [1, 15]);
  const sumOk = g.and(b.op1(XOR, [s0, `${c}.q`]), g.and(...g.split(sHi, ones(15))));
  const [, tHi] = g.split(`${ttl}.q`, [1, 7]);
  const ttlOk = anyOf(g, tHi, 7);
  b.next();
  const v = b.op(RT_VERDICT, [g.not(meBad), g.not(bBad), len14, g.not(typeBad), r34, g.not(verBad), sumOk, ttlOk], 'verdict', 'verdict');
  b.wire(`${v}.act`, 'act'); b.wire(`${v}.cause`, 'cause'); b.wire(`${ttl}.q`, 'ttl');
  b.wire(g.merge([`${chkLo}.q`, `${chkHi}.q`], [8, 8]), 'chk');
  return define({
    id: 'rtcheck', name: 'Header checks', category: 'sequential',
    summary: 'Watches the bytes as they go into the buffer: our MAC or broadcast, type 0x0800, version and length 0x45, the checksum summed as it passes, TTL. Everything DECIDE needs, and no byte is read twice.',
    ports, symbol: { kind: 'box', label: 'CHECK' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/** The lookup: the destination shifted out a bit a read, a node address, and the best next hop passed so far. */
export const RT_WALK: ComponentDef = (() => {
  const ports: PortDef[] = [bus('d', 8, 'in'), bit('mv', 'in'), bit('dstb', 'in'), bit('dec', 'in'), bit('walk', 'in'), bus('word', 24, 'in'), clk(),
    bus('n', TRIE_K, 'out'), bus('best', 4, 'out'), bit('wend', 'out'), bit('rz', 'out')];
  const b = new Builder(24, 18, 5), g = kit(b);
  b.pins('d', 'mv', 'dstb', 'dec', 'walk', 'word', 'clk');
  const dst = b.op(register(32), ['', '', 'clk'], 'destination, next bit on top', 'dst');
  const depth = b.op(register(6), ['', '', 'clk'], 'bits used', 'depth');
  const node = b.op(register(TRIE_K), ['', '', 'clk'], 'node', 'node');
  const best = b.op(register(4), ['', '', 'clk'], 'best hop', 'best');
  b.next();
  const [c1, c0, hop] = g.split('word', [TRIE_K, TRIE_K, 4]);
  const [lo31, top] = g.split(`${dst}.q`, [31, 1]);
  const [lo24] = g.split(`${dst}.q`, [24, 8]);
  const child = b.name(g.mux(TRIE_K, c0, c1, top, 'child this bit picks'), 'child', true);
  const hopNz = anyOf(g, hop, 4);
  const nb = b.name(g.gate(g.mux(4, `${best}.q`, hop, hopNz), 4, g.not('dec')), 'best so far', true);
  const anyChild = anyOf(g, child, TRIE_K);
  const [, d5] = g.split(`${depth}.q`, [5, 1]);
  const wend = b.name(g.or(d5, g.not(anyChild)), 'walk ends', true);
  b.next();
  const step = b.name(g.and('walk', g.not(wend)), 'step', true);
  const zero1 = g.konst(1, 0);
  b.wire(g.mux(32, g.merge(['d', lo24], [8, 24]), g.merge([zero1, lo31], [1, 31]), 'walk'), `${dst}.d`);
  b.wire(g.or(g.and('mv', 'dstb'), step), `${dst}.en`);
  const adv = g.or('dec', step);
  b.wire(g.gate(b.op1(incrementer(6), [`${depth}.q`]), 6, g.not('dec')), `${depth}.d`);
  b.wire(adv, `${depth}.en`);
  b.wire(g.gate(child, TRIE_K, g.not('dec')), `${node}.d`);
  b.wire(adv, `${node}.en`);
  b.wire(nb, `${best}.d`);
  b.wire(g.or('dec', 'walk'), `${best}.en`);
  b.next();
  b.wire(`${node}.q`, 'n'); b.wire(`${best}.q`, 'best'); b.wire(wend, 'wend');
  b.wire(g.not(anyOf(g, nb, 4)), 'rz');
  return define({
    id: 'rtwalk', name: 'Trie walk', category: 'sequential',
    summary: 'One memory read a cycle: take the child the next destination bit picks, remember the longest route passed, stop at no child or after 32 bits. Up to 33 cycles for a lookup, whatever the size of the table.',
    ports, symbol: { kind: 'box', label: 'WALK' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

/** The two fields that change. The checksum is RFC 1624's: complement, add 0xFEFF, end-around carry, complement. */
export const RT_REWRITE: ComponentDef = (() => {
  const ports: PortDef[] = [bus('buf', 8, 'in'), bus('adj', 8, 'in'), bus('ttl', 8, 'in'), bus('chk', 16, 'in'), bit('rw', 'in'), bit('mac2', 'in'), bit('i22', 'in'), bit('i24', 'in'), bit('i25', 'in'), bit('tx', 'in'),
    bus('y', 8, 'out')];
  const b = new Builder(24, 18, 5), g = kit(b);
  b.pins('buf', 'adj', 'ttl', 'chk', 'rw', 'mac2', 'i22', 'i24', 'i25', 'tx');
  const allOnes = g.konst(16, 0xffff);
  const inv = b.op1(bitwise('xor', 16), ['chk', allOnes]);
  const add = b.op(rca(16), [inv, g.konst(16, TTL_DELTA), g.konst(1, 0)], 'add 0xFEFF', 'add');
  b.next();
  const again = b.op1(incrementer(16), [`${add}.s`], 'end-around carry', 'inc');
  const folded = g.mux(16, `${add}.s`, again, `${add}.cout`);
  b.next();
  const hc = b.name(b.op1(bitwise('xor', 16), [folded, allOnes]), 'new checksum', true);
  const [hcLo, hcHi] = g.split(hc, [8, 8]);
  const ttl1 = b.op(rca(8), ['ttl', g.konst(8, 0xff), g.konst(1, 0)], 'TTL − 1', 'dec');
  b.next();
  let y = g.mux(8, 'buf', 'adj', g.and('rw', 'mac2'), 'MAC bytes');
  y = g.mux(8, y, `${ttl1}.s`, g.and('rw', 'i22'), 'TTL');
  y = g.mux(8, y, hcHi, g.and('rw', 'i24'), 'checksum');
  y = g.mux(8, y, hcLo, g.and('rw', 'i25'), 'checksum');
  b.wire(g.gate(y, 8, 'tx'), 'y');
  return define({
    id: 'rtrewrite', name: 'Frame rewrite', category: 'arithmetic',
    summary: 'A forwarded frame is the stored one except in four places: the two MAC addresses, TTL − 1, and the checksum updated from the old one without summing the header again.',
    ports, symbol: { kind: 'box', label: 'REWRITE' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
})();

const cache = new Map<string, ComponentDef>();

/** The fast path. With tables, the memories hold them at power-on; the cfg port (a slow path's writes) reaches both either way. */
export function routerFastPath(trie?: ArrayLike<number>, adj?: ArrayLike<number>, key = ''): ComponentDef {
  const id = `rtfast${key}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const ports: PortDef[] = [bus('rxd', 8, 'in'), bit('rxv', 'in'), bit('rxl', 'in'), bit('txr', 'in'), bit('cfg_we', 'in'), bit('cfg_t', 'in'), bus('cfg_a', TRIE_K, 'in'), bus('cfg_d', 24, 'in'), clk(),
    bit('rxr', 'out'), bus('txd', 8, 'out'), bit('txv', 'out'), bit('txl', 'out'), bus('port', 2, 'out'), bus('cause', 3, 'out'), bus('state', 3, 'out')];
  const b = new Builder(26, 22, 6), g = kit(b);
  b.pins('rxd', 'rxv', 'rxl', 'txr', 'cfg_we', 'cfg_t', 'cfg_a', 'cfg_d', 'clk');

  // column: control
  const st = b.op(register(3), ['', g.konst(1, 1), 'clk'], 'state', 'st');
  const ctl = b.op(RT_CTL, [`${st}.q`, '', '', '', '', ''], 'control', 'ctl');
  const name = (x: string, n: string) => b.name(x, n, true);
  name(`${ctl}.rx`, 'in RX'); name(`${ctl}.dec`, 'in DECIDE'); name(`${ctl}.walk`, 'in WALK'); name(`${ctl}.adj`, 'in ADJ'); name(`${ctl}.tx`, 'in TX'); name(`${ctl}.clr`, 'clear');
  const mv = name(g.and(`${ctl}.rx`, 'rxv'), 'a byte moves in');
  const rxdone = name(g.and(mv, 'rxl'), 'last byte in');
  b.wire(`${ctl}.ns`, `${st}.d`);
  b.wire(rxdone, `${ctl}.rxdone`);
  b.next();

  // column: the byte counter, shared by both directions, and the position it means
  const cnt = b.op(register(BUF_K), ['', '', 'clk'], 'byte counter', 'cnt');
  const len = b.op(register(BUF_K), [`${cnt}.q`, rxdone, 'clk'], 'last byte\'s index', 'len');
  const atEnd = b.op1(equal(BUF_K), [`${cnt}.q`, `${len}.q`], 'at the last byte?', 'atend');
  const [lo6, hi5] = g.split(`${cnt}.q`, [6, BUF_K - 6]);
  const [odd] = g.split(`${cnt}.q`, [1, BUF_K - 1]);
  const pos = b.op(RT_POS, [lo6, g.not(anyOf(g, hi5, BUF_K - 6))], 'where in the frame', 'pos');
  const txmv = name(g.and(`${ctl}.tx`, 'txr'), 'a byte moves out');
  const txdone = name(g.and(txmv, atEnd), 'last byte out');
  b.wire(txdone, `${ctl}.txdone`);
  const inc = b.op1(incrementer(BUF_K), [`${cnt}.q`]);
  b.wire(g.gate(inc, BUF_K, g.not(g.or(rxdone, `${ctl}.clr`))), `${cnt}.d`);
  b.wire(g.or(mv, txmv, `${ctl}.clr`), `${cnt}.en`);
  b.next();

  // column: the memories
  const cfgTrie = name(g.and('cfg_we', g.not('cfg_t')), 'write a route');
  const cfgAdj = name(g.and('cfg_we', 'cfg_t'), 'write a next hop');
  const [cfgA7] = g.split('cfg_a', [ADJ_K, TRIE_K - ADJ_K]);
  const [cfgD8] = g.split('cfg_d', [8, 16]);
  const packet = b.op(bigRam(BUF_K, 8), [`${cnt}.q`, 'rxd', mv, 'clk'], 'packet buffer', 'buf');
  const trieRam = trie ? bigRamWithInit(TRIE_K, 24, padded(trie, 1 << TRIE_K)) : bigRam(TRIE_K, 24);
  const adjRam = adj ? bigRamWithInit(ADJ_K, 8, padded(adj, 1 << ADJ_K)) : bigRam(ADJ_K, 8);
  const trieM = b.op(trieRam, ['', 'cfg_d', cfgTrie, 'clk'], 'routes (trie)', 'trie');
  const adjM = b.op(adjRam, ['', cfgD8, cfgAdj, 'clk'], 'next hops', 'adj');
  b.next();

  // column: the blocks
  const chk = b.op(RT_CHECK, ['rxd', mv, `${adjM}.dout`, odd, `${pos}.mac`, `${pos}.i12`, `${pos}.i13`, `${pos}.i14`, `${pos}.i22`, `${pos}.i24`, `${pos}.i25`, `${pos}.hdr`, `${pos}.i33`, `${ctl}.clr`, 'clk'], 'header checks', 'check');
  const walk = b.op(RT_WALK, ['rxd', mv, `${pos}.dst`, `${ctl}.dec`, `${ctl}.walk`, `${trieM}.dout`, 'clk'], 'lookup', 'walk');
  b.wire(`${chk}.act`, `${ctl}.act`);
  b.wire(`${walk}.wend`, `${ctl}.wend`);
  b.wire(`${walk}.rz`, `${ctl}.rz`);
  b.wire(g.mux(TRIE_K, `${walk}.n`, 'cfg_a', cfgTrie, 'trie address'), `${trieM}.addr`);
  // next-hop address: entry 0 (our MAC) unless ADJ or the destination MAC going out
  const useHop = g.or(`${ctl}.adj`, g.and(`${ctl}.tx`, `${pos}.mac`));
  const hopSel = g.gate(`${walk}.best`, 4, useHop);
  const entry = g.mux(3, `${pos}.idx`, g.konst(3, 6), `${ctl}.adj`);
  b.wire(g.mux(ADJ_K, g.merge([entry, hopSel], [3, 4]), cfgA7, cfgAdj, 'next-hop address'), `${adjM}.addr`);
  b.next();

  // column: what leaves
  const [portIn] = g.split(`${adjM}.dout`, [2, 6]);
  const local = name(b.op1(equal(2), [portIn, g.konst(2, PORT_CPU)]), 'our own address');
  const nr = `${ctl}.nr`, punt = name(g.and(`${ctl}.dec`, b.op1(equal(2), [`${chk}.act`, g.konst(2, ACT_PUNT)])), 'to the slow path');
  const toCpu = g.or(punt, nr);
  const port = b.op(register(2), [g.mux(2, portIn, g.konst(2, PORT_CPU), toCpu), g.or(toCpu, `${ctl}.adj`), 'clk'], 'output port', 'port');
  // the cause: DECIDE's, then "no route", "local" or "forwarded"
  const later = g.mux(3, g.mux(3, g.konst(3, C_FORWARD), g.konst(3, C_LOCAL), local), g.konst(3, C_NO_ROUTE), nr);
  const cause = b.op(register(3), [g.mux(3, later, `${chk}.cause`, `${ctl}.dec`), g.or(`${ctl}.dec`, nr, `${ctl}.adj`), 'clk'], 'why', 'cause');
  const rw = b.op(DFF, ['', 'clk'], 'rewrite this frame', 'rw');
  b.wire(g.and(g.or(`${rw}.q`, g.and(`${ctl}.adj`, g.not(local))), g.not(`${ctl}.clr`)), `${rw}.d`);
  const rew = b.op(RT_REWRITE, [`${packet}.dout`, `${adjM}.dout`, `${chk}.ttl`, `${chk}.chk`, `${rw}.q`, g.or(`${pos}.mac`, `${pos}.src`), `${pos}.i22`, `${pos}.i24`, `${pos}.i25`, `${ctl}.tx`], 'frame going out', 'rewrite');
  b.next();
  b.wire(`${ctl}.rx`, 'rxr');
  b.wire(`${rew}.y`, 'txd');
  b.wire(`${ctl}.tx`, 'txv');
  b.wire(g.and(`${ctl}.tx`, atEnd), 'txl');
  b.wire(`${port}.q`, 'port');
  b.wire(`${cause}.q`, 'cause');
  b.wire(`${st}.q`, 'state');
  const d = define({
    id, name: 'Router fast path', category: 'memory',
    summary: 'A frame in on the stream, into the packet buffer; checks as it passes; a trie walk, one read a level; out with new MACs, TTL − 1 and an updated checksum. Everything else goes up to the slow path unchanged.',
    ports, symbol: { kind: 'box', label: 'FAST PATH' },
    netlist: () => ({ pins: sidePins(ports, b.right), instances: b.instances, nets: b.nets() }),
  });
  cache.set(id, d);
  return d;
}

const padded = (a: ArrayLike<number>, n: number): number[] => { const o = new Array<number>(n).fill(0); for (let i = 0; i < a.length; i++) o[i] = a[i]; return o; };

export const ROUTER_FAST = routerFastPath();
