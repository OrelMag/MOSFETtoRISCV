// Phase 17c: the out-of-order core's units (chapter 24). Each follows the rules of riscv/ooomodel.ts, the model the
// core must equal cycle for cycle (the plan's "model's rules" list, E:/mockups/ooo/PLAN-17b-17d.md), and each is
// checked against those rules in tests/ooounits.test.ts.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { addSub, andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { readPort, regfile, writeSelect } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { constWord } from './alu';
import { bitwise, orN } from './wide';
import { lowestOne, onehotMux } from './lanes';
import { popcount } from './coding';
import { nonZero } from './pipeline';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}


// ---- the branch target buffer, trained at commit --------------------------------------------------------------------

/** A BTB entry's fields, low bits first: valid, tag = pc[31:6], target, 2-bit counter, jump. */
export const BTB_FIELDS = [1, 26, 32, 2, 1];
const BTB_W = 62;

/**
 * One training of a BTB entry, the model's rules (riscv/ooomodel.ts trainBtb): a branch that hits a branch entry
 * moves its counter one step toward the outcome and takes the new target only when taken; a branch that misses is
 * written only when taken (counter 2); a jump (not a return: those never reach here) is written taken for good
 * (counter 3, jump). we: whether the entry is written; y: the new entry.
 */
export const BTB_TRAIN: ComponentDef = (() => {
  const b = new Builder(18, 20);
  b.pins('old', 'tag', 'branch', 'jump', 'taken', 'next');
  const f = b.op(splitter(BTB_FIELDS), ['old'], undefined, 'f');
  const ctrBits = b.op(splitter([1, 1]), [`${f}.o3`], undefined, 'cb');
  const k2 = b.op1(constWord(2, 2), [], undefined, 'k2'), k3 = b.op1(constWord(2, 3), [], undefined, 'k3');
  const one = b.op1(TIE1, [], undefined, 'one');
  b.next();
  const same = b.op1(equal(26), [`${f}.o1`, 'tag'], undefined, 'sameTag');
  const notJ = b.op1(NOT, [`${f}.o4`], undefined, 'notJump');
  // the saturating step: up when taken (stays at 3), down when not (stays at 0)
  const c1 = `${ctrBits}.o1`, c0 = `${ctrBits}.o0`;
  const nc0 = b.op1(NOT, [c0], undefined, 'nc0');
  const up1 = b.op1(OR, [c1, c0], undefined, 'up1'), up0 = b.op1(OR, [c1, nc0], undefined, 'up0');
  const dn1 = b.op1(AND, [c1, c0], undefined, 'dn1'), dn0 = b.op1(AND, [c1, nc0], undefined, 'dn0');
  b.next();
  const hit = b.name(b.op1(andN(3), [`${f}.o0`, same, notJ], undefined, 'hit'), 'hit', true);
  const n1 = b.op1(busMux2(1), [dn1, up1, 'taken'], undefined, 'n1'), n0 = b.op1(busMux2(1), [dn0, up0, 'taken'], undefined, 'n0');
  b.next();
  const stepped = b.op1(merger([1, 1]), [n0, n1], undefined, 'stepped');
  const ctrB = b.op1(busMux2(2), [k2, stepped, hit], undefined, 'ctrB');
  const tgtB = b.op1(busMux2(32), [`${f}.o2`, 'next', 'taken'], undefined, 'tgtB');
  const wB = b.op1(OR, [hit, 'taken'], undefined, 'wB');
  b.next();
  const tgt = b.op1(busMux2(32), [tgtB, 'next', 'jump'], undefined, 'tgt');
  const ctr = b.op1(busMux2(2), [ctrB, k3, 'jump'], undefined, 'ctr');
  const brW = b.op1(AND, ['branch', wB], undefined, 'brW');
  b.next();
  b.wire(b.op1(merger(BTB_FIELDS), [one, 'tag', tgt, ctr, 'jump'], undefined, 'entry'), 'y');
  b.wire(b.op1(OR, [brW, 'jump'], undefined, 'write'), 'we');
  const R = b.right;
  return define({
    id: 'btbtrain', name: 'BTB training (commit)', category: 'cpu',
    summary: 'How a committing control instruction changes its BTB entry: a branch that hits steps its 2-bit counter toward the outcome and keeps the old target unless taken; a branch that misses is only written when taken (counter 2); a jump is written taken for good. Returns never come here: the return stack predicts them.',
    ports: [bus('old', BTB_W, 'in'), bus('tag', 26, 'in'), bit('branch', 'in'), bit('jump', 'in'), bit('taken', 'in'), bus('next', 32, 'in'), bit('we', 'out'), bus('y', BTB_W, 'out')],
    symbol: { kind: 'box', label: 'TRAIN' },
    netlist: () => ({ pins: { old: [0, 2], tag: [0, 4], branch: [0, 6], jump: [0, 8], taken: [0, 10], next: [0, 12], we: [R, 2], y: [R, 4] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The fetch side of a BTB read: hit and predicted taken (hit, and a jump or counter ≥ 2), and the target. */
export const BTB_LOOKUP: ComponentDef = (() => {
  const b = new Builder(18, 16);
  b.pins('entry', 'tag');
  const f = b.op(splitter([1, 26, 32, 1, 1, 1]), ['entry'], undefined, 'f');
  b.next();
  const same = b.op1(equal(26), [`${f}.o1`, 'tag'], undefined, 'sameTag');
  const dir = b.op1(OR, [`${f}.o5`, `${f}.o4`], undefined, 'dir');
  b.next();
  const hit = b.op1(AND, [`${f}.o0`, same], undefined, 'hit');
  b.next();
  b.wire(b.op1(AND, [hit, dir], undefined, 'taken'), 'taken');
  b.wire(`${f}.o2`, 'target');
  const R = b.right;
  return define({
    id: 'btblookup', name: 'BTB lookup', category: 'cpu',
    summary: 'Is this fetch slot predicted taken? Its entry must be valid with the same tag, and be a jump or have its counter at 2 or 3; then fetch goes to the stored target.',
    ports: [bus('entry', BTB_W, 'in'), bus('tag', 26, 'in'), bit('taken', 'out'), bus('target', 32, 'out')],
    symbol: { kind: 'box', label: 'HIT?' },
    netlist: () => ({ pins: { entry: [0, 2], tag: [0, 4], taken: [R, 2], target: [R, 4] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The out-of-order core's BTB: 16 entries, looked up for both fetch slots (pc and pc + 4) and trained by up to two
 * committing instructions a cycle, the younger seeing the older's write when they share an entry (the model trains
 * them one after the other). Port 1's write wins an entry both write.
 */
export function btbCommit(): ComponentDef {
  return memo('btbc', () => {
    const N = 16, K = 4, R = register(BTB_W), rg = symbolGeom(R);
    const P = Math.max(rg.h + 4, 10);
    const D = decoder(K, true, P), dg = symbolGeom(D);
    const WS = writeSelect(BTB_W), wg = symbolGeom(WS);
    const RP = readPort(K, BTB_W), rpg = symbolGeom(RP);
    // the entry array, drawn like the register files: decoders, write selects, registers, one bundle, read ports
    const dAt: [number, number] = [40, 2];
    const dOut = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1];
    const sTop = (i: number) => dOut(i) - wg.ports.y0.pos[1];
    const xS = dAt[0] + dg.w + 10, xR = xS + wg.w + 6;
    const rTop = (i: number) => sTop(i) + wg.ports.d.pos[1] - rg.ports.d.pos[1];
    const qY = (i: number) => rTop(i) + rg.ports.q.pos[1];
    const xQ = xR + rg.w + 6, mqTop = qY(0) - P / 2;
    const xP = xQ + 10;
    const rpAt = (j: number): [number, number] => [xP, mqTop + 10 + j * (rpg.h + 24)];
    const d1At: [number, number] = [dAt[0], dAt[1] + dg.h + 8];
    const xL = xP + rpg.w + 24;
    const instances: InstanceDef[] = [
      { name: 'dec0', def: D, at: dAt, label: 'train (older)' }, { name: 'dec1', def: D, at: d1At, label: 'train (younger)' },
      { name: 'bundle', def: merger(Array(N).fill(BTB_W), P), at: [xQ, mqTop] },
      ...['F0', 'F1', 'C0', 'C1'].map((n, j): InstanceDef => ({ name: `rd${n}`, def: RP, at: rpAt(j), label: ['fetch, pc', 'fetch, pc + 4', 'train (older)', 'train (younger)'][j] })),
      { name: 'lk0', def: BTB_LOOKUP, at: [xL, rpAt(0)[1]] }, { name: 'lk1', def: BTB_LOOKUP, at: [xL, rpAt(1)[1]] },
      { name: 'tr0', def: BTB_TRAIN, at: [xL, rpAt(2)[1]] }, { name: 'tr1', def: BTB_TRAIN, at: [xL, rpAt(3)[1] + 6] },
      { name: 'fwd', def: busMux2(BTB_W), at: [xL - 12, rpAt(3)[1] - 2], label: 'older\'s write' },
      { name: 'same', def: equal(K), at: [8, d1At[1] + dg.h + 8] }, { name: 'fw', def: AND, at: [20, d1At[1] + dg.h + 8] },
      ...['F0', 'F1', 'C0', 'C1'].map((n, j): InstanceDef => ({ name: `sp${n}`, def: splitter([2, K, 26]), at: [4, 2 + 8 * j] })),
      { name: 'wen0', def: AND, at: [20, d1At[1] + dg.h + 16] }, { name: 'wen1', def: AND, at: [20, d1At[1] + dg.h + 24] },
    ];
    const nets: NetDef[] = [];
    const wd0 = ['tr0.y'], wd1 = ['tr1.y'], clk = ['clk'];
    for (let i = 0; i < N; i++) {
      instances.push({ name: `ws${i}`, def: WS, at: [xS, sTop(i)] }, { name: `w${i}`, def: R, at: [xR, rTop(i)], label: `entry ${i}` });
      nets.push(
        { name: `p0w${i}`, ends: [`dec0.y${i}`, `ws${i}.y0`] },
        { name: `p1w${i}`, ends: [`dec1.y${i}`, `ws${i}.y1`], tags: true },
        { name: `d${i}`, ends: [`ws${i}.d`, `w${i}.d`] }, { name: `en${i}`, ends: [`ws${i}.en`, `w${i}.en`] },
        { name: `q${i}`, ends: [`w${i}.q`, `bundle.i${i}`] },
      );
      wd0.push(`ws${i}.wd0`); wd1.push(`ws${i}.wd1`); clk.push(`w${i}.clk`);
    }
    nets.push(
      { name: 'new0', ends: wd0, tags: true }, { name: 'new1', ends: wd1, tags: true }, { name: 'clk', ends: clk, trunk: xR + rg.w + 2 },
      { name: 'entries', ends: ['bundle.out', 'rdF0.words', 'rdF1.words', 'rdC0.words', 'rdC1.words'], trunk: xP - 3 },
      ...(['F0', 'F1', 'C0', 'C1'] as const).flatMap((n): NetDef[] => [
        { name: `pc${n}`, ends: [`pc${n}`, `sp${n}.in`] },
        { name: `idx${n}`, ends: [`sp${n}.o1`, `rd${n}.sel`, ...(n === 'C0' ? ['dec0.a', 'same.a'] : n === 'C1' ? ['dec1.a', 'same.b'] : [])], tags: true },
        { name: `tag${n}`, ends: [`sp${n}.o2`, n[0] === 'F' ? `lk${n[1]}.tag` : `tr${n[1]}.tag`], tags: true },
      ]),
      { name: 'eF0', ends: ['rdF0.y', 'lk0.entry'] }, { name: 'eF1', ends: ['rdF1.y', 'lk1.entry'] },
      { name: 'eC0', ends: ['rdC0.y', 'tr0.old'] }, { name: 'eC1', ends: ['rdC1.y', 'fwd.a'], tags: true },
      { name: 'old1', ends: ['fwd.y', 'tr1.old'], tags: true },
      { name: 'fromOlder', ends: ['tr0.y', 'fwd.b'], tags: true },
      { name: 'sameEntry', ends: ['same.eq', 'fw.a'] }, { name: 'useOlder', ends: ['fw.y', 'fwd.s'], tags: true },
      { name: 'we0', ends: ['tr0.we', 'wen0.a'], tags: true }, { name: 'we1', ends: ['tr1.we', 'wen1.a'], tags: true },
      { name: 'v0', ends: ['v0', 'wen0.b'], tags: true }, { name: 'v1', ends: ['v1', 'wen1.b'], tags: true },
      { name: 'write0', ends: ['wen0.y', 'dec0.en', 'fw.b'], tags: true }, { name: 'write1', ends: ['wen1.y', 'dec1.en'], tags: true },
      ...[0, 1].flatMap((k): NetDef[] => [
        { name: `branch${k}`, ends: [`branch${k}`, `tr${k}.branch`], tags: true }, { name: `jump${k}`, ends: [`jump${k}`, `tr${k}.jump`], tags: true },
        { name: `taken${k}`, ends: [`taken${k}`, `tr${k}.taken`], tags: true }, { name: `next${k}`, ends: [`next${k}`, `tr${k}.next`], tags: true },
        { name: `pt${k}`, ends: [`lk${k}.taken`, `pt${k}`], tags: true }, { name: `tgt${k}`, ends: [`lk${k}.target`, `tgt${k}`], tags: true },
      ]),
    );
    const ins = ['pcF0', 'pcF1', 'pcC0', 'v0', 'branch0', 'jump0', 'taken0', 'next0', 'pcC1', 'v1', 'branch1', 'jump1', 'taken1', 'next1', 'clk'];
    const xO = xL + 40, bottom = Math.max(rTop(N - 1) + rg.h, rpAt(3)[1] + rpg.h + 30) + 6;
    return define({
      id: 'btbc', name: 'Branch target buffer (trained at commit)', category: 'cpu',
      summary: '16 entries {valid, tag, target, 2-bit counter, jump}, looked up for both fetch slots and trained by up to two committing control instructions a cycle, in order: the younger sees the older\'s write when they share an entry. Trained at commit, so only instructions that really ran change it.',
      ports: [bus('pcF0', 32, 'in'), bus('pcF1', 32, 'in'), bus('pcC0', 32, 'in'), bit('v0', 'in'), bit('branch0', 'in'), bit('jump0', 'in'), bit('taken0', 'in'), bus('next0', 32, 'in'),
        bus('pcC1', 32, 'in'), bit('v1', 'in'), bit('branch1', 'in'), bit('jump1', 'in'), bit('taken1', 'in'), bus('next1', 32, 'in'), bit('clk', 'in', 'bottom', true),
        bit('pt0', 'out'), bus('tgt0', 32, 'out'), bit('pt1', 'out'), bus('tgt1', 32, 'out')],
      symbol: { kind: 'box', label: 'BTB (COMMIT)' },
      netlist: () => ({
        pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, bottom + 2 * i] as [number, number]])), pt0: [xO, 2], tgt0: [xO, 4], pt1: [xO, 6], tgt1: [xO, 8] },
        instances, nets,
      }),
    });
  });
}

// ---- the issue queue ---------------------------------------------------------------------------------------------

/** The tag of an operand's producer: its reorder-buffer entry. */
export const TAG = 4;

/** The stores a load still waits for: its mask, without the stores that are done (mask AND NOT done). */
export const STORES_LEFT: ComponentDef = (() => {
  const b = new Builder(10, 10);
  b.pins('mask', 'done');
  const m = b.op(splitter([1, 1, 1, 1]), ['mask'], undefined, 'm'), d = b.op(splitter([1, 1, 1, 1]), ['done'], undefined, 'd');
  b.next();
  const nd = [0, 1, 2, 3].map((i) => b.op1(NOT, [`${d}.o${i}`], undefined, `nd${i}`));
  b.next();
  const y = [0, 1, 2, 3].map((i) => b.op1(AND, [`${m}.o${i}`, nd[i]], undefined, `y${i}`));
  b.next();
  b.wire(b.op1(merger([1, 1, 1, 1]), y, undefined, 'out'), 'y');
  const R = b.right;
  return define({
    id: 'storesleft', name: 'Stores still pending', category: 'cpu',
    summary: 'Of the store-queue entries a load waits for, those whose store has not executed yet.',
    ports: [bus('mask', 4, 'in'), bus('done', 4, 'in'), bus('y', 4, 'out')],
    symbol: { kind: 'box', label: 'AND NOT' },
    spec: ([m, d]) => [m & ~d & 15],
    netlist: () => ({ pins: { mask: [0, 2], done: [0, 4], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * One issue-queue entry. Dispatch allocates it (alloc: every field from the inputs; an operand already ready, or
 * captured from a bus by dispatch, comes with rdy = 1). Then each cycle an operand whose producer's tag is on a
 * result bus wakes up: ready and its value captured at the end of the cycle, and meanwhile opA / opB pass the bus
 * value on, so the entry can be picked in that very cycle. A load's store mask drops the stores that are done.
 * ready: valid, both operands ready or on a bus now, and (a load) every store it waits for done. pick or flush
 * empties the entry.
 */
export function iqEntry(P: number): ComponentDef {
  return memo(`iqe${P}`, () => {
    const b = new Builder(18, 22);
    const ins = ['alloc', 'port', 'load', 'div', 'lat2', 'tagA', 'rdyA', 'valA', 'tagB', 'rdyB', 'valB', 'smask', 'pay',
      'bv0', 'bt0', 'bx0', 'bv1', 'bt1', 'bx1', 'sdone', 'pick', 'flush', 'clk'];
    b.pins(...ins);
    const one = b.op1(TIE1, [], undefined, 'one');
    // what only dispatch writes
    b.op(register(4), [b.op1(merger([1, 1, 1, 1]), ['port', 'load', 'div', 'lat2'], undefined, 'fl'), 'alloc', 'clk'], 'port, load, div, lat2', 'flags');
    b.op(register(2 * TAG), [b.op1(merger([TAG, TAG]), ['tagA', 'tagB'], undefined, 'tg'), 'alloc', 'clk'], 'producers', 'tags');
    b.op(register(P), ['pay', 'alloc', 'clk'], 'payload', 'payR');
    b.next();
    const fs = b.op(splitter([1, 1, 1, 1]), ['flags.q'], undefined, 'fs');
    const ts = b.op(splitter([TAG, TAG]), ['tags.q'], undefined, 'ts');
    b.next();
    // wakeup: the producer's tag on either bus
    const wake = (op: 'A' | 'B', t: string) => {
      const e0 = b.op1(equal(TAG), [t, 'bt0'], undefined, `e0${op}`), e1 = b.op1(equal(TAG), [t, 'bt1'], undefined, `e1${op}`);
      const h0 = b.op1(AND, [e0, 'bv0'], undefined, `h0${op}`);
      const h1 = b.name(b.op1(AND, [e1, 'bv1'], undefined, `h1${op}`), `${op} on bus 1`, true);
      // only a waiting operand wakes (a tag is reused once its instruction is gone: a ready value stays)
      const onBus = b.op1(OR, [h0, h1], undefined, `o${op}`);
      return { h1, any: b.name(b.op1(AND, [onBus, b.op1(NOT, [`rdy${op}Q.q`], undefined, `nw${op}`)], undefined, `w${op}`), `${op} wakes`, true) };
    };
    const wA = wake('A', `${ts}.o0`), wB = wake('B', `${ts}.o1`);
    b.next();
    const bA = b.name(b.op1(busMux2(32), ['bx0', 'bx1', wA.h1], undefined, 'busA'), 'bus A', true);
    const bB = b.name(b.op1(busMux2(32), ['bx0', 'bx1', wB.h1], undefined, 'busB'), 'bus B', true);
    const stayA = b.op1(OR, ['rdyAQ.q', wA.any], undefined, 'stayA'), stayB = b.op1(OR, ['rdyBQ.q', wB.any], undefined, 'stayB');
    const capA = b.op1(busMux2(32), ['valAQ.q', bA, wA.any], undefined, 'capA'), capB = b.op1(busMux2(32), ['valBQ.q', bB, wB.any], undefined, 'capB');
    const left = b.name(b.op1(STORES_LEFT, ['smQ.q', 'sdone'], undefined, 'left'), 'stores left', true);
    b.next();
    // the operands' state: written by dispatch, or by a wakeup
    const nrA = b.op1(busMux2(1), [stayA, 'rdyA', 'alloc'], undefined, 'nrA'), nrB = b.op1(busMux2(1), [stayB, 'rdyB', 'alloc'], undefined, 'nrB');
    const nvA = b.op1(busMux2(32), [capA, 'valA', 'alloc'], undefined, 'nvA'), nvB = b.op1(busMux2(32), [capB, 'valB', 'alloc'], undefined, 'nvB');
    const nsm = b.op1(busMux2(4), [left, 'smask', 'alloc'], undefined, 'nsm');
    const nPick = b.op1(NOT, ['pick'], undefined, 'nPick'), nFlush = b.op1(NOT, ['flush'], undefined, 'nFlush');
    b.next();
    b.op(register(1), [nrA, one, 'clk'], 'A ready', 'rdyAQ');
    b.op(register(1), [nrB, one, 'clk'], 'B ready', 'rdyBQ');
    b.op(register(32), [nvA, one, 'clk'], 'A', 'valAQ');
    b.op(register(32), [nvB, one, 'clk'], 'B', 'valBQ');
    b.op(register(4), [nsm, one, 'clk'], 'stores', 'smQ');
    // valid: set by alloc, cleared by pick or flush
    const stay = b.op1(AND, ['vQ.q', nPick], undefined, 'stay');
    b.next();
    const vn = b.op1(AND, [b.op1(OR, ['alloc', stay], undefined, 'set'), nFlush], undefined, 'vn');
    b.next();
    b.op(register(1), [vn, one, 'clk'], 'valid', 'vQ');
    // ready now: both operands ready or on a bus; a load, every store before it done
    const lft = b.op(splitter([1, 1, 1, 1]), [left], undefined, 'lft');
    const waiting = b.op1(orN(4), [0, 1, 2, 3].map((i) => `${lft}.o${i}`), undefined, 'waiting');
    b.next();
    const ldWait = b.op1(AND, [`${fs}.o1`, waiting], undefined, 'ldWait');
    b.next();
    const stOk = b.op1(NOT, [ldWait], undefined, 'stOk');
    b.next();
    b.wire(b.op1(andN(4), ['vQ.q', stayA, stayB, stOk], undefined, 'rdy'), 'ready');
    b.wire(b.op1(busMux2(32), [bA, 'valAQ.q', 'rdyAQ.q'], undefined, 'opAm'), 'opA');
    b.wire(b.op1(busMux2(32), [bB, 'valBQ.q', 'rdyBQ.q'], undefined, 'opBm'), 'opB');
    b.wire('vQ.q', 'valid');
    b.wire(`${fs}.o0`, 'portQ'); b.wire(`${fs}.o1`, 'loadQ'); b.wire(`${fs}.o2`, 'divQ'); b.wire(`${fs}.o3`, 'lat2Q');
    b.wire('payR.q', 'payQ');
    const R = b.right;
    const W: Record<string, number> = { tagA: TAG, tagB: TAG, valA: 32, valB: 32, smask: 4, pay: P, bt0: TAG, bt1: TAG, bx0: 32, bx1: 32, sdone: 4 };
    const outs: [string, number][] = [['valid', 1], ['ready', 1], ['portQ', 1], ['loadQ', 1], ['divQ', 1], ['lat2Q', 1], ['opA', 32], ['opB', 32], ['payQ', P]];
    return define({
      id: `iqe${P}`, name: 'Issue-queue entry', category: 'cpu',
      summary: 'An instruction waiting for its operands. Each operand is ready, or tagged with the reorder-buffer entry that will produce it; that tag on a result bus wakes the operand up (its value captured, and passed on at once, so the entry can go in the same cycle). A load also waits for the stores before it. Picked or flushed, the entry is free again.',
      ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), ...outs.map(([n, w]) => (w > 1 ? bus(n, w, 'out') : bit(n, 'out')))],
      symbol: { kind: 'box', label: 'IQ ENTRY' },
      netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map(([n], i) => [n, [R, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Where "entry i is older than entry j" sits in the age matrix's 56 bits (i ≠ j). */
export const ageBit = (i: number, j: number) => i * 7 + (j < i ? j : j - 1);

/**
 * One bit of the age matrix, "i is older than j", next state. When j is allocated, i is older if it holds an
 * instruction already, or is slot 0's entry while j is slot 1's; when i is allocated (and j is not), i is the youngest:
 * not older; otherwise the bit holds.
 */
export const AGE_CELL: ComponentDef = (() => {
  const b = new Builder(12, 12);
  b.pins('old', 'validI', 'a0I', 'allocI', 'a1J', 'allocJ');
  const both = b.op1(AND, ['a1J', 'a0I'], undefined, 'pair');
  const nI = b.op1(NOT, ['allocI'], undefined, 'nI');
  b.next();
  const now = b.op1(OR, ['validI', both], undefined, 'now');
  const keep = b.op1(AND, ['old', nI], undefined, 'keep');
  b.next();
  b.wire(b.op1(busMux2(1), [keep, now, 'allocJ'], undefined, 'next'), 'y');
  const R = b.right;
  return define({
    id: 'agecell', name: 'Age bit', category: 'cpu',
    summary: '"Entry i is older than entry j", next cycle. Set when j is allocated behind an entry i that already holds an instruction (or i is the first of the pair allocated together), cleared when i is allocated (it is the newest), else kept.',
    ports: [bit('old', 'in'), bit('validI', 'in'), bit('a0I', 'in'), bit('allocI', 'in'), bit('a1J', 'in'), bit('allocJ', 'in'), bit('y', 'out')],
    symbol: { kind: 'box', label: 'AGE' },
    spec: ([old, v, a0i, ai, a1j, aj]) => [aj ? (v || (a1j && a0i) ? 1 : 0) : ai ? 0 : old],
    netlist: () => ({ pins: { old: [0, 2], validI: [0, 4], a0I: [0, 6], allocI: [0, 8], a1J: [0, 10], allocJ: [0, 12], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();


/**
 * Select: the oldest candidate. Entry e is granted when it is a candidate and no other candidate is older than it
 * (the age matrix). One-hot (or none).
 */
export const SELECT8: ComponentDef = (() => {
  const b = new Builder(18, 16, 3);
  b.pins('cand', 'older');
  const c = b.op(splitter(Array(8).fill(1)), ['cand'], undefined, 'cs');
  const o = b.op(splitter(Array(56).fill(1)), ['older'], undefined, 'os');
  b.next();
  const blocked: string[] = [];
  for (let e = 0; e < 8; e++) {
    const older = [0, 1, 2, 3, 4, 5, 6, 7].filter((j) => j !== e).map((j) => b.op1(AND, [`${c}.o${j}`, `${o}.o${ageBit(j, e)}`], undefined, `o${j}_${e}`));
    blocked.push(b.name(b.op1(orN(7), older, undefined, `blk${e}`), `older than ${e}`, true));
    if (e % 2 === 1) b.next();
  }
  b.next();
  const g = Array.from({ length: 8 }, (_, e) => b.op1(AND, [`${c}.o${e}`, b.op1(NOT, [blocked[e]], undefined, `nb${e}`)], undefined, `g${e}`));
  b.next();
  b.wire(b.op1(merger(Array(8).fill(1)), g, undefined, 'grant'), 'grant');
  const R = b.right;
  return define({
    id: 'select8', name: 'Select (oldest ready)', category: 'cpu',
    summary: 'Grants the oldest of the candidate entries: a candidate wins when no other candidate is older (the age matrix). With wakeup it forms the loop that sets the clock: a result\'s tag wakes its consumers, and select must pick among them in the same cycle.',
    ports: [bus('cand', 8, 'in'), bus('older', 56, 'in'), bus('grant', 8, 'out')],
    symbol: { kind: 'box', label: 'SELECT' },
    netlist: () => ({ pins: { cand: [0, 2], older: [0, 4], grant: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Fields a dispatch slot hands the issue queue, in the entry's order (iqEntry). */
const IQ_FIELDS = (P: number): [string, number][] => [
  ['port', 1], ['load', 1], ['div', 1], ['lat2', 1], ['tagA', TAG], ['rdyA', 1], ['valA', 32], ['tagB', TAG], ['rdyB', 1], ['valB', 32], ['smask', 4], ['pay', P],
];

/** A payload split for the one-hot muxes (32 bits at most each: their specs are exact to 32). */
const chunks = (P: number) => Array.from({ length: Math.ceil(P / 32) }, (_, i) => Math.min(32, P - 32 * i));

/**
 * The issue queue: 8 entries, two dispatch slots (each to the lowest free entry), two ports. Each port picks the
 * oldest candidate bound to it: ready, and its result bus free when it would arrive (a 1-cycle instruction needs
 * next cycle's bus; a 2-cycle one never collides at pick; a divide needs the divider free). Outputs per port: the
 * picked entry's operands, payload and class; free1 / free2: room for one / two; cnt0 / cnt1: entries bound to each
 * port before this cycle's picks (port binding balances them, taking this cycle's picks off itself).
 */
export function issueQueue(P: number): ComponentDef {
  return memo(`iq8_${P}`, () => {
    const F = IQ_FIELDS(P), FW = F.reduce((a, [, w]) => a + w, 0), E = iqEntry(P);
    const b = new Builder(18, 22, 4);
    const slotIns = [0, 1].flatMap((s) => F.map(([n]) => `s${s}_${n}`));
    const ins = ['alloc0', 'alloc1', ...slotIns, 'bv0', 'bt0', 'bx0', 'bv1', 'bt1', 'bx1', 'sdone', 'busNext0', 'busNext1', 'divFree', 'flush', 'clk'];
    b.pins(...ins);
    // free entries: the lowest two
    const valid = b.name(b.op1(merger(Array(8).fill(1)), Array.from({ length: 8 }, (_, e) => `e${e}.valid`), undefined, 'valid'), 'valid', true);
    const s0 = b.op1(merger(F.map(([, w]) => w)), F.map(([n]) => `s0_${n}`), 'slot 0', 'slot0');
    const s1 = b.op1(merger(F.map(([, w]) => w)), F.map(([n]) => `s1_${n}`), 'slot 1', 'slot1');
    b.next();
    const free = b.op1(invertN(8), [valid], undefined, 'free');
    b.next();
    const l0 = b.op(lowestOne(8), [free], 'first free', 'low0');
    const rest = b.op1(bitwise('and', 8), [free, b.op1(invertN(8), [`${l0}.y`], undefined, 'nl0')], undefined, 'rest');
    b.next();
    const l1 = b.op(lowestOne(8), [rest], 'second free', 'low1');
    b.next();
    const fan = (s: string, nm: string) => b.op1(merger(Array(8).fill(1)), Array(8).fill(s), undefined, nm);
    const A0 = b.name(b.op1(bitwise('and', 8), [`${l0}.y`, fan('alloc0', 'f0')], undefined, 'A0'), 'slot 0 →', true);
    const for1 = b.op1(busMux2(8), [`${l0}.y`, `${l1}.y`, 'alloc0'], undefined, 'for1');
    b.next();
    const A1 = b.name(b.op1(bitwise('and', 8), [for1, fan('alloc1', 'f1')], undefined, 'A1'), 'slot 1 →', true);
    b.next();
    const a0s = b.op(splitter(Array(8).fill(1)), [A0], undefined, 'a0s'), a1s = b.op(splitter(Array(8).fill(1)), [A1], undefined, 'a1s');
    b.op(AGE8, [A0, A1, valid, 'clk'], undefined, 'age');
    b.next();
    // the entries
    const picks: string[] = [];
    for (let e = 0; e < 8; e++) {
      const al = b.op1(OR, [`${a0s}.o${e}`, `${a1s}.o${e}`], undefined, `al${e}`);
      const nf = b.op(splitter(F.map(([, w]) => w)), [b.op1(busMux2(FW), [s0, s1, `${a1s}.o${e}`], undefined, `in${e}`)], undefined, `nf${e}`);
      picks.push(`pk${e}.y`);
      b.op(E, [al, ...F.map((_, i) => `${nf}.o${i}`), 'bv0', 'bt0', 'bx0', 'bv1', 'bt1', 'bx1', 'sdone', `pk${e}.y`, 'flush', 'clk'], `entry ${e}`, `e${e}`);
    }
    b.next();
    // candidates: ready, and the result bus free when the result would arrive (a divide: the divider free)
    const cand = [0, 1].map(() => [] as string[]);
    for (let e = 0; e < 8; e++) {
      const bn = b.op1(busMux2(1), ['busNext0', 'busNext1', `e${e}.portQ`], undefined, `bn${e}`);
      const busOk = b.op1(OR, [`e${e}.lat2Q`, b.op1(NOT, [bn], undefined, `nb${e}`)], undefined, `bo${e}`);
      const ok = b.op1(busMux2(1), [busOk, 'divFree', `e${e}.divQ`], undefined, `ok${e}`);
      const c = b.op1(AND, [`e${e}.ready`, ok], undefined, `c${e}`);
      cand[1].push(b.op1(AND, [c, `e${e}.portQ`], undefined, `c1_${e}`));
      cand[0].push(b.op1(AND, [c, b.op1(NOT, [`e${e}.portQ`], undefined, `np${e}`)], undefined, `c0_${e}`));
    }
    b.next();
    const grants = [0, 1].map((p) => b.op1(SELECT8, [b.op1(merger(Array(8).fill(1)), cand[p], undefined, `cand${p}`), 'age.older'], `port ${p}`, `sel${p}`));
    b.next();
    const gs = grants.map((g, p) => b.op(splitter(Array(8).fill(1)), [g], undefined, `gs${p}`));
    b.next();
    for (let e = 0; e < 8; e++) b.op1(OR, [`${gs[0]}.o${e}`, `${gs[1]}.o${e}`], undefined, `pk${e}`);
    b.next();
    // per port: the picked entry's operands, class and payload; how many wait on each port after the picks
    for (const p of [0, 1]) {
      const g = grants[p], from = (port: string) => Array.from({ length: 8 }, (_, e) => `e${e}.${port}`);
      b.wire(b.op1(orN(8), Array.from({ length: 8 }, (_, e) => `${gs[p]}.o${e}`), undefined, `any${p}`), `go${p}`);
      b.wire(b.op1(onehotMux(8, 32), [g, ...from('opA')], undefined, `opA${p}m`), `opA${p}`);
      b.wire(b.op1(onehotMux(8, 32), [g, ...from('opB')], undefined, `opB${p}m`), `opB${p}`);
      const cls = Array.from({ length: 8 }, (_, e) => b.op1(merger([1, 1, 1]), [`e${e}.loadQ`, `e${e}.divQ`, `e${e}.lat2Q`], undefined, `cls${p}_${e}`));
      const cs = b.op(splitter([1, 1, 1]), [b.op1(onehotMux(8, 3), [g, ...cls], undefined, `cls${p}m`)], undefined, `cl${p}`);
      b.wire(`${cs}.o0`, `load${p}`); b.wire(`${cs}.o1`, `div${p}`); b.wire(`${cs}.o2`, `lat2${p}`);
      const pieces = Array.from({ length: 8 }, (_, e) => b.op(splitter(chunks(P)), [`e${e}.payQ`], undefined, `ps${p}_${e}`));
      const parts = chunks(P).map((w, k) => b.op1(onehotMux(8, w), [g, ...pieces.map((x) => `${x}.o${k}`)], undefined, `pay${p}m${k}`));
      b.wire(chunks(P).length > 1 ? b.op1(merger(chunks(P)), parts, undefined, `pay${p}j`) : parts[0], `pay${p}`);
      // entries bound to this port, counted before this cycle's picks (early: binding takes the picks off late)
      const mine = Array.from({ length: 8 }, (_, e) => b.op1(AND, [`e${e}.valid`, p ? `e${e}.portQ` : `np${e}.y`], undefined, `w${p}_${e}`));
      b.wire(b.op1(popcount(8), [b.op1(merger(Array(8).fill(1)), mine, undefined, `waiting${p}`)], undefined, `cnt${p}c`), `cnt${p}`);
    }
    b.wire(`${l0}.any`, 'free1');
    b.wire(`${l1}.any`, 'free2');
    const R = b.right;
    const W: Record<string, number> = { bt0: TAG, bt1: TAG, bx0: 32, bx1: 32, sdone: 4 };
    for (const s of [0, 1]) for (const [n, w] of F) if (w > 1) W[`s${s}_${n}`] = w;
    const outs: [string, number][] = [['free1', 1], ['free2', 1], ['cnt0', 4], ['cnt1', 4],
      ...[0, 1].flatMap((p): [string, number][] => [[`go${p}`, 1], [`opA${p}`, 32], [`opB${p}`, 32], [`pay${p}`, P], [`load${p}`, 1], [`div${p}`, 1], [`lat2${p}`, 1]])];
    return define({
      id: `iq8_${P}`, name: 'Issue queue (8 entries, 2 ports)', category: 'cpu',
      summary: 'Where dispatched instructions wait for their operands. Each port picks, every cycle, the oldest entry bound to it that is ready and whose result will find its bus free; the result buses wake the waiting operands up. Dispatch fills the lowest free entries, two a cycle; an entry picked or flushed is free from the next cycle.',
      ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), ...outs.map(([n, w]) => (w > 1 ? bus(n, w, 'out') : bit(n, 'out')))],
      symbol: { kind: 'box', label: 'ISSUE QUEUE' },
      netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map(([n], i) => [n, [R, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** n inverters side by side. */
export function invertN(n: number): ComponentDef {
  return memo(`inv${n}`, () => {
    const b = new Builder(10, 10, 2);
    b.pins('a');
    const s = b.op(splitter(Array(n).fill(1)), ['a'], undefined, 's');
    b.next();
    const y = Array.from({ length: n }, (_, i) => b.op1(NOT, [`${s}.o${i}`], undefined, `n${i}`));
    b.next();
    b.wire(b.op1(merger(Array(n).fill(1)), y, undefined, 'm'), 'y');
    const R = b.right;
    return define({
      id: `inv${n}`, name: `${n}-bit inverter`, category: 'gate', summary: `Every bit of a ${n}-bit word inverted.`,
      ports: [bus('a', n, 'in'), bus('y', n, 'out')], symbol: { kind: 'box', label: 'NOT' },
      spec: ([a]) => [~a & (2 ** n - 1)],
      netlist: () => ({ pins: { a: [0, 2], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the rename table ------------------------------------------------------------------------------------------------

/**
 * One register's rename entry {mapped, tag}, next state: dispatch maps it (slot 1 last: it is younger), else a
 * commit of the instruction it names unmaps it (the register file has the value now), else a flush unmaps it.
 */
export const RAT_CELL: ComponentDef = (() => {
  const b = new Builder(14, 14);
  b.pins('q', 'wr0', 'tag0', 'wr1', 'tag1', 'clr', 'flush');
  const k1 = b.op1(TIE1, [], undefined, 'one');
  const m0 = b.op1(merger([1, TAG]), [k1, 'tag0'], undefined, 'map0'), m1 = b.op1(merger([1, TAG]), [k1, 'tag1'], undefined, 'map1');
  const qs = b.op(splitter([1, TAG]), ['q'], undefined, 'qs');
  b.next();
  const gone = b.op1(OR, ['clr', 'flush'], undefined, 'gone');
  b.next();
  const keepV = b.op1(AND, [`${qs}.o0`, b.op1(NOT, [gone], undefined, 'nGone')], undefined, 'keepV');
  b.next();
  const kept = b.op1(merger([1, TAG]), [keepV, `${qs}.o1`], undefined, 'kept');
  b.next();
  const w0 = b.op1(busMux2(1 + TAG), [kept, m0, 'wr0'], undefined, 'w0');
  b.next();
  const w1 = b.op1(busMux2(1 + TAG), [w0, m1, 'wr1'], undefined, 'w1');
  b.next();
  // a flush also undoes this cycle's mappings: everything dispatched is gone
  b.wire(b.op1(bitwise('and', 1 + TAG), [w1, b.op1(merger([1, TAG]), [b.op1(NOT, ['flush'], undefined, 'nFlush'), b.op1(constWord(TAG, 15), [], undefined, 'all')], undefined, 'mask')], undefined, 'y'), 'y');
  const R = b.right;
  return define({
    id: 'ratcell', name: 'Rename entry', category: 'cpu',
    summary: 'Which reorder-buffer entry will write this register, if any. Dispatch maps it (the second instruction of a pair last); the commit of the instruction it names, or a flush, unmaps it: the register file holds the value again.',
    ports: [bus('q', 1 + TAG, 'in'), bit('wr0', 'in'), bus('tag0', TAG, 'in'), bit('wr1', 'in'), bus('tag1', TAG, 'in'), bit('clr', 'in'), bit('flush', 'in'), bus('y', 1 + TAG, 'out')],
    symbol: { kind: 'box', label: 'MAP' },
    spec: ([q, wr0, t0, wr1, t1, clr, flush]) => {
      if (flush) return [((wr1 ? 1 + 2 * t1 : wr0 ? 1 + 2 * t0 : q) & ~1) & 31];
      return [wr1 ? 1 + 2 * t1 : wr0 ? 1 + 2 * t0 : clr ? q & ~1 & 31 : q];
    },
    netlist: () => ({ pins: { q: [0, 2], wr0: [0, 4], tag0: [0, 6], wr1: [0, 8], tag1: [0, 10], clr: [0, 12], flush: [0, 14], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();



// ---- the reorder buffer ------------------------------------------------------------------------------------------------

/**
 * One reorder-buffer entry's next state: {done, D (what dispatch writes), V (the result: value and execution info)}.
 * Allocated by dispatch slot 0 or 1 (D, done when the value is known at decode, V then), else written by result bus
 * 0 or 1 (done, V), else held.
 */
export function robCell(D: number, V: number): ComponentDef {
  return memo(`robc${D}_${V}`, () => {
    const b = new Builder(16, 18);
    b.pins('q', 'a0', 'a1', 'dd0', 'dd1', 'dn0', 'dn1', 'dv0', 'dv1', 'b0', 'b1', 'bv0', 'bv1');
    const qs = b.op(splitter([1, D, V]), ['q'], undefined, 'qs');
    const one = b.op1(TIE1, [], undefined, 'one');
    b.next();
    const vb = b.op1(busMux2(V), [b.op1(busMux2(V), [`${qs}.o2`, 'bv1', 'b1'], undefined, 'vb1'), 'bv0', 'b0'], undefined, 'vb0');
    const db = b.op1(busMux2(1), [`${qs}.o0`, one, b.op1(OR, ['b0', 'b1'], undefined, 'bus')], undefined, 'db');
    b.next();
    const v1 = b.op1(busMux2(V), [vb, 'dv1', 'a1'], undefined, 'va1'), d1 = b.op1(busMux2(1), [db, 'dn1', 'a1'], undefined, 'da1');
    const D1 = b.op1(busMux2(D), [`${qs}.o1`, 'dd1', 'a1'], undefined, 'Da1');
    b.next();
    const v0 = b.op1(busMux2(V), [v1, 'dv0', 'a0'], undefined, 'va0'), d0 = b.op1(busMux2(1), [d1, 'dn0', 'a0'], undefined, 'da0');
    const D0 = b.op1(busMux2(D), [D1, 'dd0', 'a0'], undefined, 'Da0');
    b.next();
    b.wire(b.op1(merger([1, D, V]), [d0, D0, v0], undefined, 'next'), 'y');
    const R = b.right;
    const W = 1 + D + V;
    return define({
      id: `robc${D}_${V}`, name: 'Reorder-buffer entry (next)', category: 'cpu',
      summary: 'What a reorder-buffer entry holds next cycle: a dispatched instruction (its fields, and its value at once when decode knows it), else a result from a bus (done), else what it holds.',
      ports: [bus('q', W, 'in'), bit('a0', 'in'), bit('a1', 'in'), bus('dd0', D, 'in'), bus('dd1', D, 'in'), bit('dn0', 'in'), bit('dn1', 'in'), bus('dv0', V, 'in'), bus('dv1', V, 'in'),
        bit('b0', 'in'), bit('b1', 'in'), bus('bv0', V, 'in'), bus('bv1', V, 'in'), bus('y', W, 'out')],
      symbol: { kind: 'box', label: 'ROB ENTRY' },
      netlist: () => ({ pins: { q: [0, 2], a0: [0, 4], a1: [0, 6], dd0: [0, 8], dd1: [0, 10], dn0: [0, 12], dn1: [0, 14], dv0: [0, 16], dv1: [0, 18], b0: [0, 20], b1: [0, 22], bv0: [0, 24], bv1: [0, 26], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The reorder buffer: 16 entries in program order between head and head + count. Dispatch allocates up to two at the
 * tail (slot 1 only with slot 0); the result buses write entries by tag; commit retires up to two from the head
 * (ce0, ce1: decided outside, from h0 / h1); flush empties it (after this cycle's commits). free1 / free2: room for one
 * / two (entries committed this cycle are not reused before the next). Operand reads by tag: done and value (the low
 * 32 bits of V).
 */
export function reorderBuffer(D: number, V: number): ComponentDef {
  return memo(`rob16_${D}_${V}`, () => {
    const N = 16, W = 1 + D + V, C = robCell(D, V), R = register(W), DEC = decoder(4, true, 10);
    const b = new Builder(18, 24, 4);
    const ins = ['a0', 'a1', 'dd0', 'dd1', 'dn0', 'dn1', 'dv0', 'dv1', 'bw0', 'btag0', 'bv0', 'bw1', 'btag1', 'bv1', 'ce0', 'ce1', 'flush', 'rtag0', 'rtag1', 'rtag2', 'rtag3', 'clk'];
    b.pins(...ins);
    const one = b.op1(TIE1, [], undefined, 'one'), zero = b.op1(TIE0, [], undefined, 'zero');
    // pointers: head, and count (0 … 16); the tail is head + count
    const cs = b.op(splitter([4, 1]), ['cnt.q'], undefined, 'cs');
    const tail = b.name(b.op1(rca(4), ['head.q', `${cs}.o0`, zero], undefined, 'tail'), 'tail', true);
    const tail1 = b.name(b.op1(incrementer(4), [tail], undefined, 'tail1'), 'tail + 1', true);
    const head1 = b.name(b.op1(incrementer(4), ['head.q'], undefined, 'head1'), 'head + 1', true);
    b.next();
    b.op(DEC, [tail, 'a0'], 'allocate, slot 0', 'al0');
    b.op(DEC, [tail1, 'a1'], 'allocate, slot 1', 'al1');
    b.op(DEC, ['btag0', 'bw0'], 'bus 0', 'wb0');
    b.op(DEC, ['btag1', 'bw1'], 'bus 1', 'wb1');
    b.next();
    const qs: string[] = [];
    for (let e = 0; e < N; e++) {
      b.name(`al0.y${e}`, `a0_${e}`, true); b.name(`al1.y${e}`, `a1_${e}`, true); b.name(`wb0.y${e}`, `b0_${e}`, true); b.name(`wb1.y${e}`, `b1_${e}`, true);
      const nx = b.op1(C, [`r${e}.q`, `al0.y${e}`, `al1.y${e}`, 'dd0', 'dd1', 'dn0', 'dn1', 'dv0', 'dv1', `wb0.y${e}`, `wb1.y${e}`, 'bv0', 'bv1'], undefined, `nx${e}`);
      b.op(R, [nx, one, 'clk'], `entry ${e}`, `r${e}`);
      qs.push(`r${e}.q`);
      if (e % 4 === 3) b.next();
    }
    b.next();
    // the entries bundled field by field: done, dispatch fields, value, execution info (each bundle within a sandbox
    // pin's 1024 bits, and an operand reads only done and value)
    const F = [1, D, 32, V - 32];
    const fsp = qs.map((q, e) => b.op(splitter(F), [q], undefined, `fs${e}`));
    b.next();
    const bund = F.map((w, i) => b.name(b.op1(merger(Array(N).fill(w), 2), fsp.map((x) => `${x}.o${i}`), undefined, `all${i}`), ['done', 'dispatched', 'values', 'info'][i], true));
    b.next();
    const rd = (i: number, sel: string, nm: string, label?: string) => b.op1(readPort(4, F[i]), [bund[i], sel], label, nm);
    // the two oldest, for commit; operands by tag
    const heads = ([['head.q', 'h0', 'head'], [head1, 'h1', 'head + 1']] as const).map(([sel, nm, lb]) => F.map((_, i) => rd(i, sel, `${nm}f${i}`, i ? undefined : lb)));
    const ops = [0, 1, 2, 3].map((k) => [rd(0, `rtag${k}`, `ro${k}d`, `operand ${k}`), rd(2, `rtag${k}`, `ro${k}v`)]);
    b.next();
    // pointer updates: head += commits; count += allocations − commits; a flush leaves it empty
    const nC = b.op1(merger([1, 1]), [b.op1(XOR, ['ce0', 'ce1'], undefined, 'c1'), b.op1(AND, ['ce0', 'ce1'], undefined, 'c2')], undefined, 'nC');
    const nA = b.op1(merger([1, 1]), [b.op1(XOR, ['a0', 'a1'], undefined, 'na1'), b.op1(AND, ['a0', 'a1'], undefined, 'na2')], undefined, 'nA');
    const k0 = (w: number, nm: string) => b.op1(constWord(w, 0), [], undefined, nm);
    b.next();
    const headN = b.op1(rca(4), ['head.q', b.op1(merger([2, 2]), [nC, k0(2, 'z2')], undefined, 'nC4'), zero], undefined, 'headN');
    const plus = b.op1(addSub(5), ['cnt.q', b.op1(merger([2, 3]), [nA, k0(3, 'z3a')], undefined, 'nA5'), zero], undefined, 'plus');
    b.next();
    const minus = b.op1(addSub(5), [plus, b.op1(merger([2, 3]), [nC, k0(3, 'z3c')], undefined, 'nC5'), one], undefined, 'minus');
    b.next();
    const cntN = b.op1(busMux2(5), [minus, k0(5, 'z5'), 'flush'], undefined, 'cntN');
    b.next();
    b.op(register(4), [headN, one, 'clk'], 'head', 'head');
    b.op(register(5), [cntN, one, 'clk'], 'count', 'cnt');
    b.next();
    // room: fewer than 16 (one), fewer than 15 (two); the head entries hold instructions: count ≥ 1, ≥ 2
    const full = b.op1(OR, [`${cs}.o1`, b.op1(equal(4), [`${cs}.o0`, b.op1(constWord(4, 15), [], undefined, 'k15')], undefined, 'is15')], undefined, 'atLeast15');
    b.wire(b.op1(NOT, [`${cs}.o1`], undefined, 'room1'), 'free1');
    b.wire(b.op1(NOT, [full], undefined, 'room2'), 'free2');
    b.wire(b.op1(nonZero(5), ['cnt.q'], undefined, 'any'), 'h0valid');
    b.wire(b.op1(nonZero(4), [`${b.op(splitter([1, 4]), ['cnt.q'], undefined, 'c2s')}.o1`], undefined, 'twoPlus'), 'h1valid');
    heads.forEach((h, k) => { b.wire(h[0], `h${k}done`); b.wire(h[1], `h${k}d`); b.wire(b.op1(merger([32, V - 32]), [h[2], h[3]], undefined, `hv${k}`), `h${k}v`); });
    b.wire('head.q', 'headTag'); b.wire(head1, 'head1Tag'); b.wire(tail, 'tailTag'); b.wire(tail1, 'tail1Tag');
    for (const k of [0, 1, 2, 3]) { b.wire(ops[k][0], `rdone${k}`); b.wire(ops[k][1], `rval${k}`); }
    const R0 = b.right;
    const Wd: Record<string, number> = { dd0: D, dd1: D, dv0: V, dv1: V, btag0: 4, bv0: V, btag1: 4, bv1: V, rtag0: 4, rtag1: 4, rtag2: 4, rtag3: 4 };
    const outs: [string, number][] = [['free1', 1], ['free2', 1], ['h0valid', 1], ['h0done', 1], ['h0d', D], ['h0v', V], ['h1valid', 1], ['h1done', 1], ['h1d', D], ['h1v', V],
      ['headTag', 4], ['head1Tag', 4], ['tailTag', 4], ['tail1Tag', 4], ...[0, 1, 2, 3].flatMap((k): [string, number][] => [[`rdone${k}`, 1], [`rval${k}`, 32]])];
    return define({
      id: `rob16_${D}_${V}`, name: 'Reorder buffer (16 entries)', category: 'cpu',
      summary: 'The instructions in flight, in program order: dispatch appends up to two at the tail, a result bus marks its entry done with the value, and commit retires up to two done entries from the head, so the register file only ever sees results in order. A value waits here until then: P6 style, the entry\'s number is the instruction\'s tag.',
      ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : Wd[n] ? bus(n, Wd[n], 'in') : bit(n, 'in'))), ...outs.map(([n, w]) => (w > 1 ? bus(n, w, 'out') : bit(n, 'out')))],
      symbol: { kind: 'box', label: 'REORDER BUFFER' },
      netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map(([n], i) => [n, [R0, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the store queue and the data memory -------------------------------------------------------------------------------

/** A 4-bit word rotated right by k (bit j of y = bit (j + k) mod 4 of x): an entry's position from the queue's head. */
export const ROT4: ComponentDef = (() => {
  const b = new Builder(12, 12);
  b.pins('x', 'k');
  const s = b.op(splitter([1, 1, 1, 1]), ['x'], undefined, 's');
  b.next();
  const rot = [0, 1, 2, 3].map((k) => b.op1(merger([1, 1, 1, 1]), [0, 1, 2, 3].map((j) => `${s}.o${(j + k) % 4}`), undefined, `r${k}`));
  b.next();
  b.wire(b.op1(muxTree(2, 4), [...rot, 'k'], undefined, 'm'), 'y');
  const R = b.right;
  return define({
    id: 'rot4', name: '4-bit rotate', category: 'routing',
    summary: 'Rotates a 4-bit word right by 0 to 3 places: in a circular queue, entry (head + j) moves to position j, the oldest first.',
    ports: [bus('x', 4, 'in'), bus('k', 2, 'in'), bus('y', 4, 'out')],
    symbol: { kind: 'box', label: 'ROT' },
    spec: ([x, k]) => [((x >> k) | (x << (4 - k))) & 15],
    netlist: () => ({ pins: { x: [0, 2], k: [0, 4], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The inverse rotation: left by k. */
export const ROT4L: ComponentDef = (() => {
  const b = new Builder(12, 12);
  b.pins('x', 'k');
  const s = b.op(splitter([1, 1, 1, 1]), ['x'], undefined, 's');
  b.next();
  const rot = [0, 1, 2, 3].map((k) => b.op1(merger([1, 1, 1, 1]), [0, 1, 2, 3].map((j) => `${s}.o${(j - k + 4) % 4}`), undefined, `r${k}`));
  b.next();
  b.wire(b.op1(muxTree(2, 4), [...rot, 'k'], undefined, 'm'), 'y');
  const R = b.right;
  return define({
    id: 'rot4l', name: '4-bit rotate left', category: 'routing',
    summary: 'Rotates a 4-bit word left by 0 to 3 places: a queue position back to its entry (position j is entry head + j).',
    ports: [bus('x', 4, 'in'), bus('k', 2, 'in'), bus('y', 4, 'out')],
    symbol: { kind: 'box', label: 'ROT←' },
    spec: ([x, k]) => [((x << k) | (x >> (4 - k))) & 15],
    netlist: () => ({ pins: { x: [0, 2], k: [0, 4], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The youngest of the older stores that match: a mask by queue position (0 = the oldest), the first k of them older. */
export const YOUNGEST_OLDER: ComponentDef = (() => {
  const b = new Builder(14, 14);
  b.pins('m', 'k');
  const ms = b.op(splitter([1, 1, 1, 1]), ['m'], undefined, 'ms'), ks = b.op(splitter([1, 1, 1]), ['k'], undefined, 'ks');
  b.next();
  // older[j]: j < k (k = 0 … 4)
  const k0 = `${ks}.o0`, k1 = `${ks}.o1`, k2 = `${ks}.o2`;
  const o0 = b.op1(orN(3), [k0, k1, k2], undefined, 'o0');
  const o1 = b.op1(OR, [k1, k2], undefined, 'o1');
  const o2 = b.op1(OR, [b.op1(AND, [k1, k0], undefined, 'k3'), k2], undefined, 'o2');
  const o3 = k2;
  b.next();
  const c = [o0, o1, o2, o3].map((o, j) => b.op1(AND, [`${ms}.o${j}`, o], undefined, `c${j}`));
  b.next();
  // the highest such position: reverse, lowest one, reverse back
  const low = b.op(lowestOne(4), [b.op1(merger([1, 1, 1, 1]), [c[3], c[2], c[1], c[0]], undefined, 'rev')], undefined, 'low');
  b.next();
  const ls = b.op(splitter([1, 1, 1, 1]), [`${low}.y`], undefined, 'ls');
  b.next();
  b.wire(b.op1(merger([1, 1, 1, 1]), [`${ls}.o3`, `${ls}.o2`, `${ls}.o1`, `${ls}.o0`], undefined, 'y'), 'y');
  b.wire(`${low}.any`, 'hit');
  const R = b.right;
  return define({
    id: 'youngestolder', name: 'Youngest older match', category: 'cpu',
    summary: 'Among the matching stores, by position in the queue (0 the oldest), the youngest of the first k: the stores older than the load. Store-to-load forwarding takes its data.',
    ports: [bus('m', 4, 'in'), bus('k', 3, 'in'), bus('y', 4, 'out'), bit('hit', 'out')],
    symbol: { kind: 'box', label: 'YOUNGEST' },
    spec: ([m, k]) => {
      let y = 0;
      for (let j = 0; j < Math.min(k, 4); j++) if ((m >> j) & 1) y = 1 << j;
      return [y, y ? 1 : 0];
    },
    netlist: () => ({ pins: { m: [0, 2], k: [0, 4], y: [R, 2], hit: [R, 4] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The store queue: 4 stores in program order (head and count; 3-bit pointers so a full queue is told from an empty
 * one). Dispatch appends the pair's stores (al0: slot 0's, al1: slot 1's); a store's execution writes its address
 * and data by index and marks it done at the end of that cycle; commit drains the head (one a cycle) into memory
 * (memWe / memAddr / memData); a flush drops what is left after this cycle's commit. A load's forwarding: of the
 * stores older than it (those before the tail it saw at dispatch, ltail) the youngest with its word address, if
 * any. pend: entries holding a store not yet executed (a dispatched load waits for those); done: executed.
 */
export const STORE_QUEUE: ComponentDef = (() => {
  const E = 1 + 30 + 32; // done, word address, data
  const b = new Builder(18, 24, 4);
  const ins = ['al0', 'al1', 'sw', 'sidx', 'saddr', 'sdata', 'cs', 'flush', 'ltail', 'laddr', 'clk'];
  b.pins(...ins);
  const one = b.op1(TIE1, [], undefined, 'one'), zero = b.op1(TIE0, [], undefined, 'zero');
  const k0 = (w: number, nm: string) => b.op1(constWord(w, 0), [], undefined, nm);
  const hs = b.op(splitter([2, 1]), ['head.q'], undefined, 'hs');
  const tail = b.name(b.op1(rca(3), ['head.q', 'cnt.q', zero], undefined, 'tail'), 'tail', true);
  const tl = b.op(splitter([2, 1]), [tail], undefined, 'tl');
  const t1 = b.op1(incrementer(2), [`${tl}.o0`], undefined, 'tail1');
  const sa = b.op(splitter([2, 30]), ['saddr'], undefined, 'sa');
  const la = b.op(splitter([2, 30]), ['laddr'], undefined, 'la');
  b.next();
  // where each dispatched store goes: slot 0's at the tail, slot 1's after it (or at the tail alone)
  const at1 = b.op1(busMux2(2), [`${tl}.o0`, t1, 'al0'], undefined, 'at1');
  b.op(decoder(2, true, 4), [`${tl}.o0`, 'al0'], 'slot 0', 'd0');
  b.op(decoder(2, true, 4), [at1, 'al1'], 'slot 1', 'd1');
  b.op(decoder(2, true, 4), ['sidx', 'sw'], 'execute', 'dx');
  b.next();
  const entry = b.op1(merger([1, 30, 32]), [one, `${sa}.o1`, 'sdata'], undefined, 'exec');
  const qs: string[] = [], dones: string[] = [], vs: string[] = [];
  const cs = b.op(splitter([1, 1, 1, 1]), [b.op1(cntMask(), ['cnt.q', `${hs}.o0`], undefined, 'occ')], undefined, 'occs');
  for (let e = 0; e < 4; e++) {
    // dispatch clears the entry (not done); execution fills it; else it holds
    const al = b.op1(OR, [`d0.y${e}`, `d1.y${e}`], undefined, `al${e}`);
    const cleared = b.op1(busMux2(E), [`q${e}.q`, k0(E, `ze${e}`), al], undefined, `cl${e}`);
    b.op(register(E), [b.op1(busMux2(E), [cleared, entry, `dx.y${e}`], undefined, `n${e}`), one, 'clk'], `store ${e}`, `q${e}`);
    const f = b.op(splitter([1, 30, 32]), [`q${e}.q`], undefined, `f${e}`);
    qs.push(f); dones.push(b.op1(AND, [`${f}.o0`, `${cs}.o${e}`], undefined, `dn${e}`)); vs.push(`${cs}.o${e}`);
  }
  b.next();
  const doneV = b.op1(merger([1, 1, 1, 1]), dones, undefined, 'doneV');
  const pend = b.op1(merger([1, 1, 1, 1]), [0, 1, 2, 3].map((e) => b.op1(AND, [vs[e], b.op1(NOT, [`${qs[e]}.o0`], undefined, `nd${e}`)], undefined, `p${e}`)), undefined, 'pendV');
  // forwarding: matches by entry, then by position from the head; the older ones are the first (ltail - head)
  const match = b.op1(merger([1, 1, 1, 1]), [0, 1, 2, 3].map((e) => b.op1(andN(3), [vs[e], `${qs[e]}.o0`, b.op1(equal(30), [`${qs[e]}.o1`, `${la}.o1`], undefined, `eq${e}`)], undefined, `m${e}`)), undefined, 'matchV');
  b.next();
  const older = b.op1(addSub(3), ['ltail', 'head.q', one], undefined, 'older');
  const pos = b.op1(ROT4, [match, `${hs}.o0`], undefined, 'pos');
  b.next();
  const yo = b.op(YOUNGEST_OLDER, [pos, older], undefined, 'yo');
  b.next();
  const pick = b.op1(ROT4L, [`${yo}.y`, `${hs}.o0`], undefined, 'pick');
  b.next();
  b.wire(b.op1(onehotMux(4, 32), [pick, ...qs.map((f) => `${f}.o2`)], undefined, 'fdata'), 'fwdData');
  b.wire(`${yo}.hit`, 'fwdHit');
  // commit: the head store to memory
  const hd = b.op(splitter([1, 30, 32]), [b.op1(muxTree(2, E), [...[0, 1, 2, 3].map((e) => `q${e}.q`), `${hs}.o0`], undefined, 'headE')], undefined, 'hd');
  b.wire(b.op1(merger([2, 30]), [k0(2, 'z2'), `${hd}.o1`], undefined, 'maddr'), 'memAddr');
  b.wire(`${hd}.o2`, 'memData');
  b.wire('cs', 'memWe');
  b.next();
  // pointers: head += commit, count += stores dispatched − commit (a flush: none left)
  const nA = b.op1(merger([1, 1]), [b.op1(XOR, ['al0', 'al1'], undefined, 'na1'), b.op1(AND, ['al0', 'al1'], undefined, 'na2')], undefined, 'nA');
  const headN = b.op1(rca(3), ['head.q', b.op1(merger([1, 2]), ['cs', k0(2, 'z2b')], undefined, 'cs3'), zero], undefined, 'headN');
  const plus = b.op1(addSub(3), ['cnt.q', b.op1(merger([2, 1]), [nA, k0(1, 'z1')], undefined, 'nA3'), zero], undefined, 'plus');
  b.next();
  const minus = b.op1(addSub(3), [plus, b.op1(merger([1, 2]), ['cs', k0(2, 'z2c')], undefined, 'cs3b'), one], undefined, 'minus');
  b.next();
  const cntN = b.op1(busMux2(3), [minus, k0(3, 'z3'), 'flush'], undefined, 'cntN');
  b.next();
  b.op(register(3), [headN, one, 'clk'], 'head', 'head');
  b.op(register(3), [cntN, one, 'clk'], 'count', 'cnt');
  b.next();
  const cnt = b.op(splitter([1, 1, 1]), ['cnt.q'], undefined, 'cn');
  b.wire(b.op1(NOT, [`${cnt}.o2`], undefined, 'room1'), 'free1');
  b.wire(b.op1(NOT, [b.op1(OR, [`${cnt}.o2`, b.op1(AND, [`${cnt}.o1`, `${cnt}.o0`], undefined, 'is3')], undefined, 'atLeast3')], undefined, 'room2'), 'free2');
  b.wire(tail, 'tail'); b.wire(`${tl}.o0`, 'idx0'); b.wire(at1, 'idx1'); b.wire(pend, 'pend'); b.wire(doneV, 'done');
  const R0 = b.right;
  const W: Record<string, number> = { sidx: 2, saddr: 32, sdata: 32, ltail: 3, laddr: 32 };
  const outs: [string, number][] = [['free1', 1], ['free2', 1], ['tail', 3], ['idx0', 2], ['idx1', 2], ['pend', 4], ['done', 4], ['fwdHit', 1], ['fwdData', 32], ['memWe', 1], ['memAddr', 32], ['memData', 32]];
  return define({
    id: 'storeq4', name: 'Store queue (4 entries)', category: 'cpu',
    summary: 'Stores wait here from dispatch to commit: executing writes their address and data, commit drains the oldest into the data memory, one a cycle, so memory only ever changes in program order. A load meanwhile takes its value from the youngest older store to the same word, if there is one (store-to-load forwarding).',
    ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), ...outs.map(([n, w]) => (w > 1 ? bus(n, w, 'out') : bit(n, 'out')))],
    symbol: { kind: 'box', label: 'STORE QUEUE' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map(([n], i) => [n, [R0, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Which of the 4 queue entries hold a store: the `count` entries from the head (circular). */
function cntMask(): ComponentDef {
  return memo('sqocc', () => {
    const b = new Builder(12, 12);
    b.pins('cnt', 'head');
    // position j holds a store when j < count; entry e is position (e - head) mod 4
    const k = b.op(splitter([1, 1, 1]), ['cnt'], undefined, 'k');
    b.next();
    const o0 = b.op1(orN(3), [`${k}.o0`, `${k}.o1`, `${k}.o2`], undefined, 'o0'), o1 = b.op1(OR, [`${k}.o1`, `${k}.o2`], undefined, 'o1');
    const o2 = b.op1(OR, [b.op1(AND, [`${k}.o1`, `${k}.o0`], undefined, 'k3'), `${k}.o2`], undefined, 'o2');
    b.next();
    const posMask = b.op1(merger([1, 1, 1, 1]), [o0, o1, o2, `${k}.o2`], undefined, 'pm');
    b.next();
    b.wire(b.op1(ROT4L, [posMask, 'head'], undefined, 'y'), 'y');
    const R = b.right;
    return define({
      id: 'sqocc', name: 'Queue occupancy', category: 'cpu',
      summary: 'Which entries of a 4-entry circular queue hold something: count of them, from the head on.',
      ports: [bus('cnt', 3, 'in'), bus('head', 2, 'in'), bus('y', 4, 'out')],
      symbol: { kind: 'box', label: 'IN USE' },
      spec: ([c, h]) => { let y = 0; for (let j = 0; j < Math.min(c, 4); j++) y |= 1 << ((h + j) % 4); return [y]; },
      netlist: () => ({ pins: { cnt: [0, 2], head: [0, 4], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The out-of-order core's data memory: 2^k words read at one address (a load) while another is written (a store
 * draining at commit). Its words are w0 … in `ram` (a register file without a hard-wired zero), as every data memory's,
 * so the readers find them.
 */
export function dataMemory2(k: number): ComponentDef {
  return memo(`dmem2_${k}`, () => {
    const RF = regfile(k, 32, false), rg = symbolGeom(RF);
    const b = new Builder(12, 14);
    b.pins('raddr', 'waddr', 'wd', 'we', 'clk');
    const ra = b.op(splitter([2, k, 30 - k]), ['raddr'], undefined, 'ra'), wa = b.op(splitter([2, k, 30 - k]), ['waddr'], undefined, 'wa');
    b.next();
    b.op(RF, [`${wa}.o1`, `${ra}.o1`, `${ra}.o1`, 'wd', 'we', 'clk'], 'words', 'ram');
    b.next();
    b.wire('ram.rd1', 'rd');
    void rg;
    const R = b.right;
    return define({
      id: `dmem2_${k}`, name: 'Data memory (read and write port)', category: 'memory',
      summary: `${2 ** k} words. A load reads one address while a committing store writes another, in the same cycle: separate read and write ports.`,
      ports: [bus('raddr', 32, 'in'), bus('waddr', 32, 'in'), bus('wd', 32, 'in'), bit('we', 'in'), bit('clk', 'in', 'bottom', true), bus('rd', 32, 'out')],
      symbol: { kind: 'box', label: 'DATA MEMORY' },
      netlist: () => ({ pins: { raddr: [0, 2], waddr: [0, 4], wd: [0, 6], we: [0, 8], clk: [0, 10], rd: [R, 2] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- arrays drawn as rows on shared wires ---------------------------------------------------------------------------

/**
 * Rows of one part stacked at one pitch, the shared inputs on vertical trunks at the left (pins at the bottom-left),
 * a per-row constant (the row's own number) beside each row, every row's output bundled into one word at the right:
 * drawn with wires, as the register files are, rather than with a label per row.
 */
function rowArray(o: {
  id: string; name: string; summary: string; label: string; row: ComponentDef | ((r: number) => ComponentDef); n: number; first?: number;
  /** The row input taking a constant (the row's number), and its width; none if absent. */
  me?: { port: string; width: number };
  /** Bundled output: the rows' `out`, entry 0 (or a constant for the rows below `first`) first. */
  out: string; outWidth: number; zeroBelow?: boolean;
  /** Ports, and which row input each shared input feeds (same name if absent). */
  shared: PortDef[];
}): ComponentDef {
  const { n } = o, first = o.first ?? 0, rowOf = typeof o.row === 'function' ? o.row : () => o.row as ComponentDef, rg = symbolGeom(rowOf(first));
  const P = rg.h + 2, top = (r: number) => 2 + r * P;
  const inPorts = o.shared.filter((p) => p.dir === 'in');
  const xT = (k: number) => 6 + 2 * k, xC = 6 + 2 * inPorts.length + 4, xRow = xC + 12;
  const instances: InstanceDef[] = [], nets: NetDef[] = [];
  const outY = (r: number) => top(r) + rg.ports[o.out].pos[1];
  const xQ = xRow + rg.w + 6, mqTop = outY(0) - P / 2;
  instances.push({ name: 'bundle', def: merger(Array(n).fill(o.outWidth), P), at: [xQ, mqTop] });
  const sinks = new Map<string, string[]>(inPorts.map((p) => [p.name, [p.name]]));
  for (let r = 0; r < n; r++) {
    if (r < first) {
      instances.push({ name: `z${r}`, def: constWord(o.outWidth, 0), at: [xRow + rg.w - 6, outY(r) - 1], label: `${r}: none` });
      nets.push({ name: `q${r}`, ends: [`z${r}.y`, `bundle.i${r}`] });
      continue;
    }
    instances.push({ name: `r${r}`, def: rowOf(r), at: [xRow, top(r)], label: `${r}` });
    if (o.me) {
      const k = constWord(o.me.width, r), kg = symbolGeom(k);
      instances.push({ name: `k${r}`, def: k, at: [xC, top(r) + rg.ports[o.me.port].pos[1] - kg.ports.y.pos[1]] });
      nets.push({ name: `me${r}`, ends: [`k${r}.y`, `r${r}.${o.me.port}`] });
    }
    for (const p of inPorts) sinks.get(p.name)!.push(`r${r}.${p.name}`);
    nets.push({ name: `q${r}`, ends: [`r${r}.${o.out}`, `bundle.i${r}`] });
  }
  inPorts.forEach((p, k) => nets.push({ name: p.name, ends: sinks.get(p.name)!, trunk: xT(k) }));
  const outP = o.shared.filter((p) => p.dir === 'out');
  nets.push({ name: outP[0].name, ends: ['bundle.out', outP[0].name] });
  const bottom = top(n) + 4;
  return define({
    id: o.id, name: o.name, category: 'cpu', summary: o.summary, ports: o.shared,
    symbol: { kind: 'box', label: o.label },
    netlist: () => ({
      pins: { ...Object.fromEntries(inPorts.map((p, k) => [p.name, [0, bottom + 2 * k] as [number, number]])), [outP[0].name]: [xQ + 10, mqTop + (n * P) / 2] },
      instances, nets,
    }),
  });
}

/**
 * One register of the rename table, with its own name decoding: it is mapped when a dispatch slot's destination
 * is this register (me), unmapped when a committing instruction's destination is, and it still names it.
 */
export const RAT_ROW: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['me', 'rd0', 'wr0', 'tag0', 'rd1', 'wr1', 'tag1', 'crd0', 'un0', 'crd1', 'un1', 'flush', 'clk'];
  b.pins(...ins);
  const one = b.op1(TIE1, [], undefined, 'one');
  const hit = (rd: string, en: string, nm: string) => b.op1(AND, [b.op1(equal(5), ['me', rd], undefined, `is${nm}`), en], undefined, nm);
  const w0 = hit('rd0', 'wr0', 'w0'), w1 = hit('rd1', 'wr1', 'w1'), u0 = hit('crd0', 'un0', 'u0'), u1 = hit('crd1', 'un1', 'u1');
  b.next();
  const clr = b.op1(OR, [u0, u1], undefined, 'clr');
  b.next();
  const nx = b.op1(RAT_CELL, ['map.q', w0, 'tag0', w1, 'tag1', clr, 'flush'], undefined, 'next');
  b.next();
  b.op(register(1 + TAG), [nx, one, 'clk'], 'mapping', 'map');
  b.wire('map.q', 'q');
  const R = b.right;
  const W: Record<string, number> = { me: 5, rd0: 5, tag0: TAG, rd1: 5, tag1: TAG, crd0: 5, crd1: 5 };
  return define({
    id: 'ratrow', name: 'Rename-table row', category: 'cpu',
    summary: 'One register\'s mapping, with its own name: a dispatch slot whose destination is this register maps it, a committing instruction whose destination it is unmaps it (if it still names that instruction), a flush unmaps it.',
    ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), bus('q', 1 + TAG, 'out')],
    symbol: { kind: 'box', label: 'MAPPING' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), q: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The rename table's 31 rows (x0 never mapped), bundled: 32 × {mapped, tag}. */
export const RAT_ARRAY: ComponentDef = rowArray({
  id: 'ratarray', name: 'Rename-table rows', label: 'MAPPINGS', row: RAT_ROW, n: 32, first: 1, me: { port: 'me', width: 5 }, out: 'q', outWidth: 1 + TAG,
  summary: 'The 31 registers\' mappings, one row each on shared wires: every row recognizes its own register number among the dispatch and commit destinations.',
  shared: [bus('rd0', 5, 'in'), bit('wr0', 'in'), bus('tag0', TAG, 'in'), bus('rd1', 5, 'in'), bit('wr1', 'in'), bus('tag1', TAG, 'in'), bus('crd0', 5, 'in'), bit('un0', 'in'),
    bus('crd1', 5, 'in'), bit('un1', 'in'), bit('flush', 'in'), bit('clk', 'in', 'bottom', true), bus('maps', 32 * (1 + TAG), 'out')],
});

/**
 * One row of the age matrix: entry i's 7 bits "i is older than j" (j ≠ i), from the allocations of this cycle (as
 * AGE_CELL) and the entries' valid bits.
 */
export function ageRow(i: number): ComponentDef {
  return memo(`agerow${i}`, () => {
    const b = new Builder(18, 24, 3);
    b.pins('alloc0', 'alloc1', 'alloc', 'valid', 'clk');
    const one = b.op1(TIE1, [], undefined, 'one');
    const s = (bus: string) => b.op(splitter(Array(8).fill(1)), [bus], undefined, `${bus}S`);
    const a0 = s('alloc0'), a1 = s('alloc1'), al = s('alloc'), v = s('valid'), old = b.op(splitter(Array(7).fill(1)), ['bits.q'], undefined, 'oldS');
    b.next();
    const js = [0, 1, 2, 3, 4, 5, 6, 7].filter((j) => j !== i);
    const cells = js.map((j, k) => b.op1(AGE_CELL, [`${old}.o${k}`, `${v}.o${i}`, `${a0}.o${i}`, `${al}.o${i}`, `${a1}.o${j}`, `${al}.o${j}`], `${i} older than ${j}`, `c${j}`));
    b.next();
    b.op(register(7), [b.op1(merger(Array(7).fill(1)), cells, undefined, 'nx'), one, 'clk'], `${i} older than`, 'bits');
    b.wire('bits.q', 'older');
    const R = b.right;
    return define({
      id: `agerow${i}`, name: `Age-matrix row ${i}`, category: 'cpu',
      summary: `Whether entry ${i} holds an older instruction than each other entry, kept up to date as entries are allocated.`,
      ports: [bus('alloc0', 8, 'in'), bus('alloc1', 8, 'in'), bus('alloc', 8, 'in'), bus('valid', 8, 'in'), bit('clk', 'in', 'bottom', true), bus('older', 7, 'out')],
      symbol: { kind: 'box', label: `AGE ${i}` },
      netlist: () => ({ pins: { alloc0: [0, 2], alloc1: [0, 4], alloc: [0, 6], valid: [0, 8], clk: [0, 10], older: [R, 2] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The issue queue's age matrix: for every pair of entries, which holds the older instruction (56 bits, ageBit). */
export const AGE_ARRAY: ComponentDef = rowArray({
  id: 'agearray', name: 'Age-matrix rows', label: 'AGE ROWS', row: ageRow, n: 8, out: 'older', outWidth: 7,
  summary: 'The age matrix as eight rows on shared wires, row i holding whether entry i is older than each other entry.',
  shared: [bus('alloc0', 8, 'in'), bus('alloc1', 8, 'in'), bus('alloc', 8, 'in'), bus('valid', 8, 'in'), bit('clk', 'in', 'bottom', true), bus('older', 56, 'out')],
});

export const AGE8: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('alloc0', 'alloc1', 'valid', 'clk');
  const al = b.op1(bitwise('or', 8), ['alloc0', 'alloc1'], 'allocated', 'al');
  b.next();
  b.op(AGE_ARRAY, ['alloc0', 'alloc1', al, 'valid', 'clk'], undefined, 'rows');
  b.next();
  b.wire('rows.older', 'older');
  const R = b.right;
  return define({
    id: 'age8', name: 'Age matrix (8 entries)', category: 'cpu',
    summary: 'Which of any two issue-queue entries holds the older instruction, one bit per ordered pair: a new entry is younger than every entry already there (and the second of a pair dispatched together younger than the first). Select uses it to find the oldest ready entry without keeping the queue in order.',
    ports: [bus('alloc0', 8, 'in'), bus('alloc1', 8, 'in'), bus('valid', 8, 'in'), bit('clk', 'in', 'bottom', true), bus('older', 56, 'out')],
    symbol: { kind: 'box', label: 'AGE MATRIX' },
    netlist: () => ({ pins: { alloc0: [0, 2], alloc1: [0, 4], valid: [0, 6], clk: [0, 8], older: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The rename table (P6 style: a register maps to the reorder-buffer entry of its youngest in-flight writer). Four
 * lookups (two sources of each dispatch slot; slot 1's sources see slot 0's destination), two mappings a cycle, two
 * unmappings at commit (only when the register still names the committing instruction: a younger writer keeps it),
 * and a flush that unmaps everything. x0 is never mapped.
 */
export const RAT: ComponentDef = (() => {
  const E = 1 + TAG, RP = readPort(5, E);
  const b = new Builder(18, 24, 4);
  const ins = ['rs1_0', 'rs2_0', 'rs1_1', 'rs2_1', 'rd0', 'we0', 'tag0', 'rd1', 'we1', 'tag1', 'crd0', 'cv0', 'ctag0', 'crd1', 'cv1', 'ctag1', 'flush', 'clk'];
  b.pins(...ins);
  const one = b.op1(TIE1, [], undefined, 'one');
  // writes: x0 never
  const wr0 = b.name(b.op1(AND, ['we0', b.op1(nonZero(5), ['rd0'], undefined, 'nz0')], undefined, 'wr0'), 'map0', true);
  const wr1 = b.op1(AND, ['we1', b.op1(nonZero(5), ['rd1'], undefined, 'nz1')], undefined, 'wr1');
  b.op(RP, ['rows.maps', 'crd0'], 'commit, older', 'rc0');
  b.op(RP, ['rows.maps', 'crd1'], 'commit, younger', 'rc1');
  b.next();
  // a commit unmaps a register only if it still names the committing instruction
  const unmap = (k: number) => {
    const sp = b.op(splitter([1, TAG]), [`rc${k}.y`], undefined, `rcs${k}`);
    const same = b.op1(equal(TAG), [`${sp}.o1`, `ctag${k}`], undefined, `same${k}`);
    return b.op1(andN(3), [`cv${k}`, `${sp}.o0`, same], undefined, `un${k}`);
  };
  const un0 = unmap(0), un1 = unmap(1);
  b.next();
  b.op(RAT_ARRAY, ['rd0', wr0, 'tag0', 'rd1', wr1, 'tag1', 'crd0', un0, 'crd1', un1, 'flush', 'clk'], undefined, 'rows');
  b.name('rows.maps', 'maps', true);
  b.next();
  // lookups: slot 1's sources see slot 0's destination
  const look = ['rs1_0', 'rs2_0', 'rs1_1', 'rs2_1'].map((rs, i) => b.op1(RP, ['rows.maps', rs], `lookup ${rs}`, `rd${i}`));
  b.next();
  ['a0', 'b0', 'a1', 'b1'].forEach((nm, i) => {
    let y = look[i];
    if (i >= 2) {
      const hit = b.op1(AND, [wr0, b.op1(equal(5), [['rs1_1', 'rs2_1'][i - 2], 'rd0'], undefined, `byp${i}e`)], undefined, `byp${i}`);
      y = b.op1(busMux2(E), [y, b.op1(merger([1, TAG]), [one, 'tag0'], undefined, `t0m${i}`), hit], undefined, `by${i}`);
    }
    const sp = b.op(splitter([1, TAG]), [y], undefined, `os${i}`);
    b.wire(`${sp}.o0`, `${nm}v`); b.wire(`${sp}.o1`, `${nm}t`);
  });
  const R0 = b.right;
  const W: Record<string, number> = { rs1_0: 5, rs2_0: 5, rs1_1: 5, rs2_1: 5, rd0: 5, tag0: TAG, rd1: 5, tag1: TAG, crd0: 5, ctag0: TAG, crd1: 5, ctag1: TAG };
  const outs = ['a0', 'b0', 'a1', 'b1'].flatMap((n): [string, number][] => [[`${n}v`, 1], [`${n}t`, TAG]]);
  return define({
    id: 'rat', name: 'Rename table', category: 'cpu',
    summary: 'For each register, the reorder-buffer entry of the youngest instruction in flight that writes it, or none (the register file has the value). Dispatch looks up both instructions\' sources (the second sees the first\'s destination) and maps their destinations; a commit unmaps a register still naming the committing instruction; a flush unmaps them all.',
    ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), ...outs.map(([n, w]) => (w > 1 ? bus(n, w, 'out') : bit(n, 'out')))],
    symbol: { kind: 'box', label: 'RENAME TABLE' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map(([n], i) => [n, [R0, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  });
})();
