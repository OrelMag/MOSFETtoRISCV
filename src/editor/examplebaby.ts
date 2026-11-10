// Examples ▸ Manchester Baby: the 1948 machine (lib/baby.ts) as one part holding Kilburn's highest-factor routine in its
// store ({ baby: { src } }, editor/babypart.ts), a clock, the regeneration switch and the lamps the operators watched:
// CI (the control register), A (the accumulator), the line the store is addressing, the beat, and the Stop lamp wired to a
// halt part. Open the part to see the store, the control and the accumulator; the CPU drawer follows it against the golden
// model (editor/babymon.ts).

import { instPort } from '../sim/geometry';
import { KILBURN_ANSWER_LINE, kilburnSource } from '../ssem/programs';
import { ssemWords } from '../ssem/asm';
import type { ChipDoc, PartDoc, PartRef, PinDoc, Vec, WireDoc } from './model';
import { isError, partDef } from './parts';

/** The number whose highest proper factor the example finds (its answer, 30, ends up in line 27). */
export const BABY_EXAMPLE_N = 60;

export const BABY_NOTES = `The Small-Scale Experimental Machine of 21 June 1948 ("the Baby"): 32 lines of 32 digits held as charge on one Williams tube, a control register CI, the present instruction PI, an accumulator A, seven instructions (JMP JRP LDN STO SUB CMP STP) and four beats to an instruction, in 22 694 NANDs. `
  + `The store holds Kilburn's highest-factor routine on ${BABY_EXAMPLE_N} (Tootill's notebook, 18 July 1948; Edit program… on the Baby part). Run: when it stops, the Stop lamp lights and line ${KILBURN_ANSWER_LINE} of the store holds ${BABY_EXAMPLE_N / 2}, the highest proper factor of ${BABY_EXAMPLE_N}. `
  + 'The REGEN switch rewrites each line before its charge fades; switch it off and a faded line reads as dots, so the routine soon loses its Stop instruction and runs on. '
  + 'Double-click the part to look inside: the store opens to its 1024 flip-flops, seeded from the tube.';

type Port = { name: string; width: number };

/** The example's chip, with `src` (default Kilburn's routine) in the store. */
export function babyChip(id: string, name: string, src = kilburnSource(BABY_EXAMPLE_N)): ChipDoc {
  ssemWords(src); // a program that does not assemble is an author's error
  const ref: PartRef = { baby: { src } };
  const def = partDef(ref, () => undefined);
  if (isError(def)) throw new Error(`Baby example: ${def.error}`);
  const at: Vec = [20, 8];
  const port = (n: string): Vec => instPort(def, at, false, n).pos;

  const parts: PartDoc[] = [{ id: 'baby', ref, at, label: 'Baby' }];
  const wires: WireDoc[] = [];
  const pins: PinDoc[] = [];
  // outputs: [port, display, label]
  const outs: [string, PartRef, string][] = [
    ['ci', { display: 'value', width: 32 }, 'CI'], ['a', { display: 'value', width: 32 }, 'A'],
    ['line', { display: 'value', width: 5 }, 'line'], ['beat', { display: 'value', width: 2 }, 'beat'],
    ['stop', { display: 'led', width: 1 }, 'Stop'],
  ];
  const right = port('ci')[0], y0 = port('ci')[1] - 1, n = outs.length;
  outs.forEach(([p, ref2, label], i) => {
    const d = partDef(ref2, () => undefined);
    if (isError(d)) throw new Error(`Baby example: ${d.error}`);
    const from = port(p);
    const off = instPort(d, [0, 0], false, 'a').pos;
    const to: Vec = [right + 2 * n + 4, y0 + i * 8];
    const mx = right + 2 + 2 * (n - 1 - i);
    parts.push({ id: `o_${p}`, ref: ref2, at: [to[0] - off[0], to[1] - off[1]], label });
    wires.push({ id: `w_${p}`, a: { part: 'baby', port: p }, b: { part: `o_${p}`, port: 'a' }, pts: [[mx, from[1]], [mx, to[1]]] });
  });
  // Stop also halts Run: a halt part on the same net, a row below the lamp
  const hd = partDef({ display: 'halt', width: 1 }, () => undefined);
  if (isError(hd)) throw new Error(`Baby example: ${hd.error}`);
  const hoff = instPort(hd, [0, 0], false, 'a').pos, stopY = port('stop')[1];
  parts.push({ id: 'halt', ref: { display: 'halt', width: 1 }, at: [right + 2 * n + 4 - hoff[0], y0 + n * 8 - hoff[1]], label: 'halt' });
  wires.push({ id: 'w_halt', a: { part: 'baby', port: 'stop' }, b: { part: 'halt', port: 'a' }, pts: [[right + 2 * n + 2, stopY], [right + 2 * n + 2, y0 + n * 8]] });
  // inputs
  const clk = port('clk'), regen = port('regen');
  pins.push({ id: 'clk', name: 'clk', dir: 'in', width: 1, at: [2, clk[1] + 6], kind: 'clock' });
  pins.push({ id: 'regen', name: 'regen', dir: 'in', width: 1, at: [2, regen[1]], kind: 'toggle', value: 1 });
  wires.push({ id: 'w_regen', a: { pin: 'regen' }, b: { part: 'baby', port: 'regen' }, pts: [] });
  wires.push({ id: 'w_clk', a: { pin: 'clk' }, b: { part: 'baby', port: 'clk' }, pts: [[clk[0], clk[1] + 6]] });
  return { id, name, notes: BABY_NOTES, pins, parts, wires, labels: [] };
}

export type { Port };
