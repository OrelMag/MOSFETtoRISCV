// "A computer": the learner's single-cycle core with a program ROM (given), a RAM and an LED
// register behind an address decoder, all in one sandbox chip. Checked cycle by cycle: the LEDs
// after every clock edge must show what the golden model's LEDS register holds after as many
// instructions. The ROM is a sandbox part, so the learner can then load their own RV16 program.

import type { BuildChallenge, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import { RV16_LEDS } from '../editor/memory';
import type { ChipDoc, PartDoc, PartRef } from '../editor/model';
import { partDef } from '../editor/parts';
import { Builder } from '../lib/builder';
import { splitter } from '../lib/define';
import { AND, NOT } from '../lib/gates';
import { ram } from '../lib/memory';
import { RV16_CORE } from '../lib/rv16/cpu';
import { register } from '../lib/sequential';
import { assemble16 } from '../riscv/rv16/asm16';
import { Iss16 } from '../riscv/rv16/iss16';
import type { ComponentDef } from '../sim/types';

export const COMPUTER_ROM: PartRef = { rom: { k: 5, w: 16, addr: 'word', lang: 'rv16', src: RV16_LEDS } };
const ROM_PART: PartDoc = { id: 'rom', ref: COMPUTER_ROM, at: [20, 30], label: 'program' };

/** LEDs after each of n instructions on the golden model. */
function ledTimeline(n: number): number[] {
  const a = assemble16(RV16_LEDS);
  const iss = new Iss16(a.words);
  return Array.from({ length: n }, () => {
    iss.step();
    return iss.leds;
  });
}

function computerSteps(): SeqStep[] {
  const leds = ledTimeline(110);
  return [{ set: { rst: 1 }, tick: true, expect: {} }, ...leds.map((v, i): SeqStep => ({ ...(i === 0 ? { set: { rst: 0 } } : {}), tick: true, expect: { leds: v } }))];
}

let refDef: ComponentDef | null = null;
/** The reference computer as a library-style definition (its ROM is the sandbox part). */
function computerDef(): ComponentDef {
  if (refDef) return refDef;
  const romDef = partDef(COMPUTER_ROM, () => undefined);
  if ('error' in romDef) throw new Error(romDef.error);
  const b = new Builder(12, 16, 8);
  b.pins('clk', 'rst');
  const core = b.op(RV16_CORE, ['clk', 'rst', '', ''], 'your core');
  b.next();
  const pcs = b.op(splitter([5, 11], 4), [`${core}.pc`]);
  const ds = b.op(splitter([6, 9, 1], 4), [`${core}.daddr`], 'address');
  b.next();
  const rom = b.op(romDef, [`${pcs}.o0`], 'program');
  const io = b.name(`${ds}.o2`, 'io', true);
  const nio = b.op1(NOT, [io]);
  b.next();
  const ramWe = b.op1(AND, [`${core}.dwe`, nio], 'RAM write');
  const ledWe = b.op1(AND, [`${core}.dwe`, io], 'LED write');
  b.next();
  const mem = b.op(ram(6, 16), [`${ds}.o0`, `${core}.dwdata`, ramWe, 'clk'], 'RAM');
  const leds = b.op(register(16), [`${core}.dwdata`, ledWe, 'clk'], 'LEDs');
  b.wire(`${rom}.data`, `${core}.instr`);
  b.wire(`${mem}.dout`, `${core}.drdata`);
  b.wire(`${leds}.q`, 'leds');
  const R = b.right;
  // Not registered in the library: it holds a sandbox ROM, which no library id brings back.
  refDef = {
    id: 'rv16_computer', name: 'RV16 computer', category: 'cpu',
    summary: 'A core, a 32-word program ROM, a 64-word RAM and an LED register. Partial address decoding: bit 15 of the data address selects the I/O (the LEDs), the low 6 bits address the RAM.',
    ports: [{ name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'rst', width: 1, dir: 'in' }, { name: 'leds', width: 16, dir: 'out' }],
    symbol: { kind: 'box', label: 'COMPUTER' },
    netlist: () => ({ pins: { clk: [0, 4], rst: [0, 8], leds: [R, 6] }, instances: b.instances, nets: b.nets() }),
  };
  return refDef;
}

let answer: ChipDoc[] | null = null;

export const BUILDH: Record<string, () => BuildChallenge> = {
  c_computer: () => ({
    id: 'c_computer', title: 'A computer', level: 'cpu', allowed: 'nand',
    brief: 'Make a computer: your single-cycle core (Core III), the given program <b>ROM</b> (32 words; feed it pc[4:0]), a 64-word <b>RAM</b> on the data port (address daddr[5:0]) and a 16-bit <b>LED register</b> on the pin <code>leds</code>. Decode the address: a store with daddr[15] = 1 writes the LEDs (the program writes them at 0xFFFB), any other store writes the RAM. The program shows Fibonacci numbers, each one passed through the RAM. Then load your own RV16 program into the ROM.',
    ports: [{ name: 'clk', dir: 'in', width: 1, clock: true }, { name: 'rst', dir: 'in', width: 1 }, { name: 'leds', dir: 'out', width: 16 }],
    given: [ROM_PART],
    check: { kind: 'sequence', init: { rst: 1 }, steps: computerSteps() },
    answer: () => {
      if (!answer) {
        const romDef = partDef(COMPUTER_ROM, () => undefined);
        const doc = docFromDef(computerDef(), { id: 'u_ref_cp_c_computer', name: 'A computer ref', refOf: (d) => (d === romDef ? COMPUTER_ROM : undefined) });
        if ('error' in doc) throw new Error(`reference c_computer: ${doc.error}`);
        answer = [{ ...doc, notes: `Reference answer. ${computerDef().summary}` }];
      }
      return answer;
    },
  }),
};
