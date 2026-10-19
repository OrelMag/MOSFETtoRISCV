// The return-address stack (Phase 17: the dual-issue pipeline and the out-of-order core). A call (jal / jalr
// writing ra or t0) pushes pc + 4, a return (jalr x0, 0(ra | t0)) pops, and fetch predicts a return from the
// top while the stack is not empty. Four entries, each {valid, address}: a push shifts {1, value} in at the
// top (the oldest falls off the bottom when full), a pop shifts an empty entry in at the bottom, so "not
// empty" is the top entry's valid bit: the same rules as riscv/ooomodel.ts (a list of at most `ras` entries).
// Two copies: the speculative one fetch updates, and the committed one the instructions that really ran update;
// a flush (`restore`) loads the speculative copy from the committed copy's next state.

import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { muxTree } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { register } from './sequential';
import { TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** The model's stack: the next state after a push (value) or a pop (null), at most n entries. */
export function rasNext(st: number[], op: number | null, n = 4): number[] {
  if (op === null) return st.slice(0, -1);
  return [...st, op >>> 0].slice(-n);
}

/**
 * One copy of the stack: n entries of {valid, w-bit address} (bundled: entry 0, the top, first; in each the
 * address in the low w bits, valid above). Each edge: ld loads d, else push shifts {1, v} in, else pop shifts
 * up, else hold. nx is the next state (what the registers load), for the other copy's restore.
 */
export function rasStack(n: number, w: number): ComponentDef {
  return memo(`rasst${n}x${w}`, () => {
    const E = w + 1, MX = muxTree(2, E), R = register(E);
    const b = new Builder(10, 10);
    b.pins('push', 'pop', 'v', 'ld', 'd', 'clk');
    // select: 00 hold, 01 push, 10 pop, 11 load (load first, then push, then pop)
    const npush = b.op1(NOT, ['push'], undefined, 'npush');
    const s0 = b.name(b.op1(OR, ['ld', 'push'], undefined, 's0'), 's0', true);
    const popOnly = b.op1(AND, ['pop', npush], undefined, 'popOnly');
    const s1 = b.name(b.op1(OR, ['ld', popOnly], undefined, 's1'), 's1', true);
    const sel = b.name(b.op1(merger([1, 1]), [s0, s1], undefined, 'sel'), 'sel', true);
    const one = b.op1(TIE1, [], undefined, 'one');
    const top = b.name(b.op1(merger([w, 1]), ['v', one], undefined, 'new'), 'pushed', true);
    const empty = b.name(b.op1(constWord(E, 0), [], 'empty', 'empty'), 'empty', true);
    const dIn = b.op(splitter(Array(n).fill(E)), ['d'], undefined, 'ds');
    b.next();
    const regs = Array.from({ length: n }, (_, i) => `r${i}`);
    const q = (i: number) => `${regs[i]}.q`;
    const muxes = Array.from({ length: n }, (_, i) =>
      b.op1(MX, [q(i), i === 0 ? top : q(i - 1), i === n - 1 ? empty : q(i + 1), `${dIn}.o${i}`, sel], undefined, `m${i}`));
    b.next();
    for (let i = 0; i < n; i++) {
      b.op(R, [muxes[i], one, 'clk'], `entry ${i}`, regs[i]);
      b.name(q(i), `e${i}`, true);
      b.name(muxes[i], `n${i}`, true);
    }
    b.next();
    b.wire(b.op1(merger(Array(n).fill(E)), regs.map((_, i) => q(i)), undefined, 'qs'), 'q');
    b.wire(b.op1(merger(Array(n).fill(E)), muxes, undefined, 'nxs'), 'nx');
    const R0 = b.right;
    return define({
      id: `rasst${n}x${w}`, name: `Return stack copy (${n} × ${w})`, category: 'sequential',
      summary: `${n} entries of {valid, address}, entry 0 on top. A push shifts {1, value} in at the top (a full stack loses its oldest), a pop shifts an empty entry in at the bottom, a load takes another copy's next state (a flush). Not empty = entry 0 is valid.`,
      ports: [bit('push', 'in'), bit('pop', 'in'), bus('v', w, 'in'), bit('ld', 'in'), bus('d', n * E, 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true },
        bus('q', n * E, 'out'), bus('nx', n * E, 'out')],
      symbol: { kind: 'box', label: 'STACK' },
      netlist: () => ({ pins: { push: [0, 2], pop: [0, 4], v: [0, 6], ld: [0, 8], d: [0, 10], clk: [0, 12], q: [R0, 2], nx: [R0, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The return-address stack: a speculative copy (fetch: pushF / popF with valF) and a committed copy (pushC /
 * popC with valC, from the instructions that really ran); restore (a flush) loads the speculative copy from the
 * committed one's next state. top / any: the speculative copy's top entry (any = not empty).
 */
export function ras(n = 4, w = 32): ComponentDef {
  return memo(`ras${n}x${w}`, () => {
    const S = rasStack(n, w), E = w + 1;
    const b = new Builder(10, 12);
    b.pins('pushF', 'popF', 'valF', 'pushC', 'popC', 'valC', 'restore', 'clk');
    const zero = b.op1(constWord(1, 0), [], undefined, 'never');
    const nil = b.op1(constWord(n * E, 0), [], undefined, 'nil');
    b.next();
    b.op(S, ['pushC', 'popC', 'valC', zero, nil, 'clk'], 'committed', 'cmt');
    b.op(S, ['pushF', 'popF', 'valF', 'restore', 'cmt.nx', 'clk'], 'speculative', 'spec');
    b.name('cmt.nx', 'committed next', true);
    b.next();
    const sp = b.op(splitter([w, 1, (n - 1) * E]), ['spec.q'], undefined, 'top');
    b.next();
    b.wire(`${sp}.o0`, 'top');
    b.wire(`${sp}.o1`, 'any');
    b.name(`${sp}.o0`, 'top', false);
    b.name(`${sp}.o1`, 'any', false);
    const R0 = b.right;
    return define({
      id: `ras${n}x${w}`, name: `Return-address stack (${n} entries)`, category: 'cpu',
      summary: `Predicts returns: a call pushes its return address, a return pops it. Fetch updates a speculative copy as it predicts; the committed copy follows the instructions that really ran, and a misprediction's flush copies it back. ${n} entries: deeper calls lose the oldest.`,
      ports: [bit('pushF', 'in'), bit('popF', 'in'), bus('valF', w, 'in'), bit('pushC', 'in'), bit('popC', 'in'), bus('valC', w, 'in'), bit('restore', 'in'),
        { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('top', w, 'out'), bit('any', 'out')],
      symbol: { kind: 'box', label: 'RETURN STACK' },
      netlist: () => ({
        pins: { pushF: [0, 2], popF: [0, 4], valF: [0, 6], pushC: [0, 10], popC: [0, 12], valC: [0, 14], restore: [0, 18], clk: [0, 20], top: [R0, 4], any: [R0, 8] },
        instances: b.instances, nets: b.nets(),
      }),
      hdl: {
        verilog: `// {valid, address} entries, e[0] on top
always_ff @(posedge clk) begin
  if (pushC) cmt <= {1'b1, valC, cmt[0:${n - 2}]}; else if (popC) cmt <= {cmt[1:${n - 1}], EMPTY};
  if (restore) spec <= cmt_next;
  else if (pushF) spec <= {1'b1, valF, spec[0:${n - 2}]}; else if (popF) spec <= {spec[1:${n - 1}], EMPTY};
end
assign top = spec[0].addr;  assign any = spec[0].valid;`,
      },
    });
  });
}
