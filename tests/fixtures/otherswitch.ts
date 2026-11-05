// A four-port switch of another design than the library's, made to the capstone's sheet from parts its rule allows, so that the bench is held to
// passing a design it was not fitted to: two single-port frame buffers per input taking turns, the header in registers, a lookup at the twelfth
// byte, eight table rows of registers and comparators, no ageing (the sheet says "may"), and a copy of a flooded frame per output, one after another.

import { bigRam } from '../../src/lib/bigmem';
import { equal } from '../../src/lib/combinational';
import { arbiterN } from '../../src/lib/mpdecode';
import { Rtl, type Sig } from '../../src/lib/rtl';
import type { ComponentDef } from '../../src/sim/types';

const memoOne = <T>(f: () => T) => { let v: T | undefined; return () => (v ??= f()); };

const counter = (m: Rtl, clk: Sig, w: number, name: string) => Array.from({ length: w }, (_, i) => m.reg(clk, `${name}${i}`));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Frames in, the header out for the lookup, the buffers read towards one output at a time. */
const inputUnit = memoOne((): ComponentDef => {
  const m = new Rtl({ id: 'os_input', name: 'Input', category: 'sequential', summary: 'Two frame buffers taking turns.' });
  const clk = m.input('clk', { clock: true }), rxData = m.inputBus('rxData', 8), rxValid = m.input('rxValid'), rxLast = m.input('rxLast'), rxErr = m.input('rxErr');
  const grant = m.input('grant'), maskIn = range(4).map((j) => m.input(`maskIn${j}`)), g = range(4).map((j) => m.input(`g${j}`)), adv = m.input('adv');
  const wb = m.reg(clk, 'wb'), rb = m.reg(clk, 'rb'), full = [m.reg(clk, 'full0'), m.reg(clk, 'full1')];
  const wcnt = counter(m, clk, 7, 'wcnt'), rcnt = counter(m, clk, 7, 'rcnt');
  const hdrDone = m.reg(clk, 'hdrDone'), reqP = m.reg(clk, 'reqP'), sending = m.reg(clk, 'sending');
  const masks = [0, 1].map((b) => counter(m, clk, 4, `mask${b}_`)), lens = [0, 1].map((b) => counter(m, clk, 7, `len${b}_`));
  const hdr = counter(m, clk, 96, 'hdr');
  const isB = (sel: Sig, b: number) => (b ? sel : m.not(sel));
  const muxB = (sel: Sig, a: Sig[], b: Sig[]) => a.map((x, i) => m.mux(sel, x, b[i]));

  // writing
  const writing = [0, 1].map((b) => m.and(isB(wb, b), m.not(full[b])));
  const lastByte = m.and(rxValid, rxLast), shift = m.and(rxValid, m.not(hdrDone)), at12 = m.and(shift, m.eqConst(wcnt, 11));
  const up = m.inc(wcnt);
  wcnt.forEach((q, i) => m.setD(q, m.mux(rxValid, q, m.and(m.not(rxLast), up[i]))));
  hdr.forEach((q, i) => m.setD(q, m.mux(shift, q, i >= 88 ? rxData[i - 88] : hdr[i + 8])));
  m.setD(hdrDone, m.and(m.not(lastByte), m.or(hdrDone, at12)));
  m.setD(reqP, m.and(m.or(reqP, at12), m.not(grant)));

  // reading
  const curMask = muxB(rb, masks[0], masks[1]), curLen = muxB(rb, lens[0], lens[1]);
  const l = range(4).map((j) => m.andN([curMask[j], ...range(j).map((k) => m.not(curMask[k]))]));
  const active = m.and(m.mux(rb, full[0], full[1]), m.not(sending));
  const lastNow = m.eq(rcnt, curLen), finish = m.and(adv, lastNow), upR = m.inc(rcnt);
  rcnt.forEach((q, i) => m.setD(q, m.mux(adv, q, m.and(m.not(lastNow), upR[i]))));
  m.setD(sending, m.and(m.or(sending, m.orN(g)), m.not(finish)));
  const done = m.and(finish, m.not(m.orN(range(4).map((j) => m.and(curMask[j], m.not(l[j]))))));
  m.setD(rb, m.xor(rb, done));

  // a frame that ends whole and has somewhere to go takes its buffer
  const commit = m.and(lastByte, m.not(rxErr));
  const takes = [0, 1].map((b) => m.andN([commit, writing[b], m.orN(masks[b])]));
  m.setD(wb, m.xor(wb, m.or(takes[0], takes[1])));
  for (const b of [0, 1]) {
    m.setD(full[b], m.and(m.or(full[b], takes[b]), m.not(m.and(done, isB(rb, b)))));
    const ld = m.and(grant, isB(wb, b));
    masks[b].forEach((q, j) => m.setD(q, m.mux(ld, m.and(q, m.not(m.andN([finish, isB(rb, b), l[j]]))), maskIn[j])));
    lens[b].forEach((q, i) => m.setD(q, m.mux(m.and(lastByte, writing[b]), q, wcnt[i])));
  }

  // the two memories
  const ramDef = bigRam(7, 8);
  const dout = [0, 1].map((b) => {
    const addr = wcnt.map((w, i) => m.mux(writing[b], rcnt[i], w));
    return m.unbus(m.part(ramDef, [m.bus(addr), m.bus(rxData), m.and(writing[b], rxValid), clk], `frame buffer ${b}`, `buf${b}`)[0], 8);
  });

  m.output('rxReady', m.not(m.mux(wb, full[0], full[1])));
  m.output('req', reqP);
  m.outputBus('hdr', hdr);
  range(4).forEach((j) => m.output(`r${j}`, m.and(active, l[j])));
  m.outputBus('data', muxB(rb, dout[0], dout[1]));
  m.output('last', lastNow);
  return m.build();
});

/** Eight rows, one lookup a cycle, learning as it looks. */
const tableUnit = memoOne((): ComponentDef => {
  const m = new Rtl({ id: 'os_table', name: 'Table', category: 'sequential', summary: 'Eight rows of registers and comparators.' });
  const clk = m.input('clk', { clock: true }), req = range(4).map((i) => m.input(`req${i}`)), hdrs = range(4).map((i) => m.inputBus(`hdr${i}`, 96));
  const g = m.part(arbiterN(4), [...req, clk], 'who looks', 'arb');
  const any = m.orN(g), hdr = range(96).map((b) => m.orN(range(4).map((i) => m.and(g[i], hdrs[i][b]))));
  const dst = hdr.slice(0, 48), src = hdr.slice(48), self = [m.or(g[1], g[3]), m.or(g[2], g[3])];
  const ptr = counter(m, clk, 3, 'ptr'), rows = range(8);
  const addr = rows.map((r) => counter(m, clk, 48, `addr${r}_`)), port = rows.map((r) => counter(m, clk, 2, `port${r}_`)), valid = rows.map((r) => m.reg(clk, `valid${r}`));
  // the palette's comparator stops at 32 bits
  const hit = (key: Sig[], tag: string) => rows.map((r) => m.andN([valid[r], m.part(equal(32), [m.bus(addr[r].slice(0, 32)), m.bus(key.slice(0, 32))], '', `${tag}${r}l`)[0], m.part(equal(16), [m.bus(addr[r].slice(32)), m.bus(key.slice(32))], '', `${tag}${r}h`)[0]]));
  const hitD = hit(dst, 'cmpD'), hitS = hit(src, 'cmpS');
  const anyD = m.orN(hitD), anyS = m.orN(hitS);
  const up = m.inc(ptr), bump = m.and(any, m.not(anyS));
  ptr.forEach((q, i) => m.setD(q, m.mux(bump, q, up[i])));
  for (const r of rows) {
    const wr = m.and(any, m.or(hitS[r], m.and(m.not(anyS), m.eqConst(ptr, r))));
    addr[r].forEach((q, i) => m.setD(q, m.mux(wr, q, src[i])));
    port[r].forEach((q, i) => m.setD(q, m.mux(wr, q, self[i])));
    m.setD(valid[r], m.or(valid[r], wr));
  }
  const known = [0, 1].map((b) => m.orN(rows.map((r) => m.and(hitD[r], port[r][b]))));
  const flood = m.or(dst[0], m.not(anyD));
  range(4).forEach((j) => m.output(`g${j}`, g[j]));
  range(4).forEach((j) => m.output(`mask${j}`, m.andN([any, m.not(g[j]), m.or(flood, m.eqConst(known, j))])));
  return m.build();
});

/** One input at a time. */
const outputUnit = memoOne((): ComponentDef => {
  const m = new Rtl({ id: 'os_output', name: 'Output', category: 'sequential', summary: 'An arbiter, a busy flag and a data mux.' });
  const clk = m.input('clk', { clock: true }), r = range(4).map((i) => m.input(`r${i}`)), ready = m.input('txReady');
  const ds = range(4).map((i) => m.inputBus(`d${i}`, 8)), ls = range(4).map((i) => m.input(`l${i}`));
  const busy = m.reg(clk, 'busy'), src = counter(m, clk, 2, 'src');
  const g = m.part(arbiterN(4), [...r.map((x) => m.and(x, m.not(busy))), clk], 'who goes', 'arb');
  const any = m.orN(g), sel = range(4).map((i) => m.and(busy, m.eqConst(src, i)));
  const last = m.orN(range(4).map((i) => m.and(sel[i], ls[i])));
  m.setD(busy, m.or(any, m.and(busy, m.not(m.and(ready, last)))));
  m.setD(src[0], m.mux(any, src[0], m.or(g[1], g[3])));
  m.setD(src[1], m.mux(any, src[1], m.or(g[2], g[3])));
  range(4).forEach((i) => m.output(`g${i}`, g[i]));
  range(4).forEach((i) => m.output(`adv${i}`, m.and(sel[i], ready)));
  m.outputBus('txData', range(8).map((b) => m.orN(range(4).map((i) => m.and(sel[i], ds[i][b])))));
  m.output('txValid', busy);
  m.output('txLast', last);
  return m.build();
});

export const otherSwitchParts = (): ComponentDef[] => [inputUnit(), tableUnit(), outputUnit()];

export const otherSwitch = memoOne((): ComponentDef => {
  const m = new Rtl({ id: 'os_switch', name: 'Another switch', category: 'routing', summary: 'A second design of the capstone.' });
  const clk = m.input('clk', { clock: true }), P = range(4);
  const inp = P.map((i) => ({ data: m.inputBus(`rxData${i}`, 8), valid: m.input(`rxValid${i}`), last: m.input(`rxLast${i}`), err: m.input(`rxErr${i}`), ready: m.input(`txReady${i}`) }));
  const grant = P.map(() => m.fwd()), maskIn = P.map(() => P.map(() => m.fwd())), gOut = P.map(() => P.map(() => m.fwd())), adv = P.map(() => P.map(() => m.fwd()));
  const ins = P.map((i) => m.part(inputUnit(), [clk, m.bus(inp[i].data), inp[i].valid, inp[i].last, inp[i].err, grant[i], ...maskIn[i], ...P.map((j) => gOut[j][i]), m.orN(P.map((j) => adv[j][i]))], `input ${i}`, `in${i}`));
  // rxReady, req, hdr, r0..3, data, last
  const tab = m.part(tableUnit(), [clk, ...ins.map((x) => x[1]), ...ins.map((x) => x[2])], 'table', 'table');
  P.forEach((i) => { m.drive(grant[i], tab[i]); P.forEach((j) => m.drive(maskIn[i][j], tab[4 + j])); });
  P.forEach((j) => {
    const o = m.part(outputUnit(), [clk, ...P.map((i) => ins[i][3 + j]), inp[j].ready, ...P.map((i) => ins[i][7]), ...P.map((i) => ins[i][8])], `output ${j}`, `out${j}`);
    P.forEach((i) => { m.drive(gOut[j][i], o[i]); m.drive(adv[j][i], o[4 + i]); });
    m.output(`rxReady${j}`, ins[j][0]);
    m.outputBus(`txData${j}`, m.unbus(o[8], 8));
    m.output(`txValid${j}`, o[9]);
    m.output(`txLast${j}`, o[10]);
  });
  return m.build();
});
