// Chapter "Designing state machines": the circuit that cleans a button. A mechanical contact bounces for a few
// milliseconds, so the raw signal is first sampled by a two-flip-flop synchronizer (lib/sync.ts: it may be undecided
// for a cycle), then a counter-based debouncer accepts a new level only after it has been different from the
// output for 2^n clock samples in a row. Everything is NANDs and the library's flip-flops.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, equal, incrementer } from './combinational';
import { define } from './define';
import { AND, NOT, XOR } from './gates';
import { DFF, register } from './sequential';
import { SYNC2 } from './sync';
import { TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Samples in a row a new level must last before the debouncer's output follows it. */
export const debounceSamples = (n: number): number => 2 ** n;

/**
 * A counter debouncer: q is the accepted level. While d differs from q a counter counts clock edges (it is cleared the
 * moment d agrees with q again); when it has counted to 2^n − 1 and d still differs, q takes d's level at the next edge
 * and the counter clears. So q follows d only after d has held a new level for 2^n samples in a row. Powers up at 0.
 */
export function debouncer(n: number): ComponentDef {
  return memo(`debounce${n}`, () => {
    const b = new Builder(12, 12);
    b.pins('d', 'clk');
    const cnt = b.op(register(n), ['', b.op1(TIE1, []), 'clk'], 'count', 'cnt');
    const q = b.op(DFF, ['', 'clk'], 'q', 'q');
    // named nets: a pointer reads as what it carries, not a number
    b.name(`${q}.q`, 'q'); b.name(`${cnt}.q`, 'count');
    b.next();
    const diff = b.name(b.op1(XOR, ['d', `${q}.q`], 'd ≠ q', 'diff'), 'diff', true);
    const full = b.name(b.op1(equal(n), [`${cnt}.q`, b.name(b.op1(constWord(n, 2 ** n - 1), []), 'last')], `= ${2 ** n - 1}`, 'full'), 'full', true);
    const inc = b.op1(incrementer(n), [`${cnt}.q`], '+ 1', 'inc');
    b.next();
    const flip = b.op1(AND, [diff, full], 'flip', 'flip');
    const go = b.op1(AND, [diff, b.name(b.op1(NOT, [full], undefined, 'nfull'), '¬full')], 'count on', 'go');
    b.next();
    b.wire(b.name(b.op1(busMux2(n), [b.name(b.op1(constWord(n, 0), [], undefined, 'zero'), '0'), inc, go], 'count or clear', 'mx'), 'next count'), `${cnt}.d`);
    b.wire(b.name(b.op1(XOR, [`${q}.q`, flip], 'q or ¬q', 'nq'), 'next q'), `${q}.d`);
    b.next();
    b.wire(`${q}.q`, 'q');
    b.wire(`${cnt}.q`, 'count');
    const R = b.right;
    return define({
      id: `debounce${n}`, name: `Debouncer (${2 ** n} samples)`, category: 'sequential',
      summary: `Accepts a new level only after d has differed from q for ${2 ** n} clock samples in a row: a ${n}-bit counter counts the samples that disagree with q and is cleared when d agrees again. Bounces shorter than ${2 ** n} clocks never reach q. Powers up at 0.`,
      ports: [bit('d', 'in'), bit('clk', 'in', 'bottom', true), bit('q', 'out'), bus('count', n, 'out')],
      symbol: { kind: 'box', label: 'DEBOUNCE' },
      netlist: () => ({ pins: { d: [0, 4], clk: [0, 10], q: [R, 4], count: [R, 8] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `always_ff @(posedge clk) begin
  if (d == q) count <= 0;
  else if (count == ${2 ** n - 1}) begin q <= d; count <= 0; end
  else count <= count + 1;
end`,
      },
    });
  });
}

/** A button's input stage: raw (any time) → two flip-flops (sync) → debouncer → q; `sync` is the synchronized level. */
export function buttonInput(n: number): ComponentDef {
  return memo(`button${n}`, () => {
    const b = new Builder(12, 12);
    b.pins('raw', 'clk');
    const s = b.op(SYNC2, ['raw', 'clk'], 'synchronizer', 'sync');
    b.next();
    const d = b.op(debouncer(n), [`${s}.q`, 'clk'], 'debouncer', 'deb');
    b.name(`${s}.q`, 'synced', true);
    b.next();
    b.wire(`${d}.q`, 'q');
    b.wire(`${s}.q`, 'sync');
    b.wire(`${d}.count`, 'count');
    const R = b.right;
    const dg = symbolGeom(debouncer(n));
    void dg;
    return define({
      id: `button${n}`, name: 'Button input', category: 'sequential',
      summary: `The input stage of a button: a two-flip-flop synchronizer, then a debouncer that wants ${2 ** n} samples in a row. q is the clean level, sync the level after the synchronizer, count the debouncer's counter.`,
      ports: [bit('raw', 'in'), bit('clk', 'in', 'bottom', true), bit('q', 'out'), bit('sync', 'out'), bus('count', n, 'out')],
      symbol: { kind: 'box', label: 'BUTTON' },
      netlist: () => ({ pins: { raw: [0, 4], clk: [0, 10], q: [R, 4], sync: [R, 8], count: [R, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

export const DEBOUNCE3: ComponentDef = debouncer(3);
export const BUTTON3: ComponentDef = buttonInput(3);
