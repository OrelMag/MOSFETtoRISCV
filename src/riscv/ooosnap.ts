// The out-of-order core's state read from its gates (lib/ooocore.ts): what is in the fetch register, the reorder
// buffer, the issue queue, the rename table and the store queue, every field from the registers that hold it. The Out
// of order panel shows it; tests/ooosnap.test.ts holds it equal to riscv/ooomodel.ts's state every cycle.

import { FD, PAY, ROB_D, ROB_V } from '../lib/ooocore';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';

type Reader = Pick<Sim, 'getBits'>;

export interface RobRow {
  /** Entry number: the instruction's tag. */
  tag: number;
  pc: number;
  rd: number;
  done: boolean;
  /** Done and found mispredicted: commit flushes everything younger. */
  mis: boolean;
  store: boolean;
  /** Its result, once done. */
  value: number;
}

export interface IqRow {
  /** Issue-queue slot. */
  slot: number;
  tag: number;
  pc: number;
  port: number;
  /** Operands still waiting: the producers' tags (null: ready). */
  waitA: number | null;
  waitB: number | null;
  /** Ready to be picked this cycle (operands, and a load's older stores). */
  ready: boolean;
  load: boolean;
}

export interface SqRow { tag: number; executed: boolean; addr: number; data: number }

export interface OooSnap {
  /** Fetched, waiting to dispatch (slot 0 first). */
  fetched: { pc: number; word: number }[];
  /** Head first. */
  rob: RobRow[];
  /** Oldest first. */
  iq: IqRow[];
  /** Registers that name a reorder-buffer entry, by number. */
  rat: [number, number][];
  /** Oldest first (stores between dispatch and commit). */
  sq: SqRow[];
}

const child = (n: HierNode, ...path: string[]): HierNode => path.reduce((x, p) => {
  const c = x.children?.get(p);
  if (!c) throw new Error(`ooosnap: no ${p} in ${x.def.id}`);
  return c;
}, n);

/** A port's bits as fields of the given widths, unsigned. */
function fields(sim: Reader, nets: number[], widths: readonly number[]): number[] {
  const bits = sim.getBits(nets);
  let at = 0;
  return widths.map((w) => {
    let v = 0;
    for (let i = w - 1; i >= 0; i--) v = v * 2 + (bits[at + i] === 1 ? 1 : 0);
    at += w;
    return v >>> 0;
  });
}
const word = (sim: Reader, nets: number[]) => fields(sim, nets, [nets.length])[0];
const pos = (layout: [string, number][], name: string) => layout.findIndex(([f]) => f === name);

/** Is `root` the out-of-order core (a reorder buffer and an issue queue at its top)? */
export function isOooCore(root: HierNode): boolean {
  const k = root.children;
  return !!k?.get('rob')?.def.id.startsWith('rob16') && !!k.get('iq')?.def.id.startsWith('iq8');
}

export function oooSnap(sim: Reader, root: HierNode): OooSnap {
  const rob = child(root, 'rob'), iq = child(root, 'iq'), rat = child(root, 'rat'), sq = child(root, 'sq');
  const fdW = FD.map(([, w]) => w), dW = ROB_D.map(([, w]) => w), vW = ROB_V.map(([, w]) => w), pW = PAY.map(([, w]) => w);

  const fetched: OooSnap['fetched'] = [];
  for (const s of [0, 1]) {
    const f = fields(sim, child(root, `fd${s}`).ports.q, fdW);
    if (f[0]) fetched.push({ pc: f[pos(FD, 'pc')], word: f[pos(FD, 'word')] });
  }

  const head = word(sim, child(rob, 'head').ports.q), cnt = word(sim, child(rob, 'cnt').ports.q);
  const robRows: RobRow[] = [];
  for (let k = 0; k < cnt; k++) {
    const tag = (head + k) & 15;
    const [done, ...rest] = fields(sim, child(rob, `r${tag}`).ports.q, [1, ...dW, ...vW]);
    const d = rest.slice(0, dW.length), v = rest.slice(dW.length);
    robRows.push({ tag, pc: d[pos(ROB_D, 'pc')], rd: d[pos(ROB_D, 'rd')], store: !!d[pos(ROB_D, 'store')], done: !!done, mis: !!done && !!v[pos(ROB_V, 'mis')], value: v[pos(ROB_V, 'value')] });
  }

  const iqRows: IqRow[] = [];
  for (let slot = 0; slot < 8; slot++) {
    const e = child(iq, `e${slot}`);
    if (!word(sim, e.ports.valid)) continue;
    const [tagA, tagB] = fields(sim, child(e, 'tags').ports.q, [4, 4]);
    const rdyA = word(sim, child(e, 'rdyAQ').ports.q), rdyB = word(sim, child(e, 'rdyBQ').ports.q);
    const pay = fields(sim, e.ports.payQ, pW);
    iqRows.push({ slot, tag: pay[pos(PAY, 'tag')], pc: pay[pos(PAY, 'pc')], port: word(sim, e.ports.portQ), load: !!word(sim, e.ports.loadQ),
      waitA: rdyA ? null : tagA, waitB: rdyB ? null : tagB, ready: !!word(sim, e.ports.ready) });
  }
  // age: distance from the reorder buffer's head
  iqRows.sort((a, b) => ((a.tag - head) & 15) - ((b.tag - head) & 15));

  const ratRows: [number, number][] = [];
  const rows = child(rat, 'rows');
  for (let r = 1; r < 32; r++) {
    const [mapped, tag] = fields(sim, child(rows, `r${r}`).ports.q, [1, 4]);
    if (mapped) ratRows.push([r, tag]);
  }

  // the store queue: entries head … head + count − 1 (indices mod 4), the stores in the reorder buffer in order
  const [sHead] = fields(sim, child(sq, 'head').ports.q, [2, 1]), sCnt = word(sim, child(sq, 'cnt').ports.q);
  const stores = robRows.filter((r) => r.store);
  const sqRows: SqRow[] = [];
  for (let k = 0; k < sCnt; k++) {
    const [executed, addr, data] = fields(sim, child(sq, `q${(sHead + k) & 3}`).ports.q, [1, 30, 32]);
    sqRows.push({ tag: stores[k]?.tag ?? -1, executed: !!executed, addr: (addr * 4) >>> 0, data });
  }
  return { fetched, rob: robRows, iq: iqRows, rat: ratRows, sq: sqRows };
}

/** The instruction each port picks this cycle (its PC; -1: none), from the issue queue's grants. */
export function oooIssued(sim: Reader, root: HierNode): number[] {
  const iq = child(root, 'iq'), pc = pos(PAY, 'pc'), at = PAY.slice(0, pc).reduce((a, [, w]) => a + w, 0);
  return [0, 1].map((p) => (word(sim, iq.ports[`go${p}`]) ? word(sim, iq.ports[`pay${p}`].slice(at, at + 32)) : -1));
}
