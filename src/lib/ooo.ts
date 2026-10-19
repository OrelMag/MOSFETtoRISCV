// Phase 17c: the out-of-order core's units (chapter 24). Each follows the rules of riscv/ooomodel.ts, the model the
// core must equal cycle for cycle (the plan's "model's rules" list, E:/mockups/ooo/PLAN-17b-17d.md), and each is
// checked against those rules in tests/ooounits.test.ts.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { readPort, writeSelect } from './regfile';
import { register } from './sequential';
import { TIE1 } from './transistors';
import { constWord } from './alu';

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
