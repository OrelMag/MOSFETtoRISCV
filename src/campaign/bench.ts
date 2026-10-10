// "Debug this test in the sandbox": a failing core-level program as a computer chip around the
// learner's own core: an RV16 ROM holding the program, a 64-word RAM holding its data (decoded on
// the low address bits, as the sandbox's RAM is the size it is), an LED register at LEDS and the
// interrupt line set by stores to IRQ, as the core bench does. The sandbox's CPU drawer then runs it
// against the golden model (editor/cpu16.ts, wrapping its memory the same way) and stops at the
// first wrong register write or store, with probes and the timing panel at hand. No DOM.

import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef, Workspace } from '../editor/model';
import { uniqueName } from '../editor/model';
import { isError, MAX_ROM_K, partDef } from '../editor/parts';
import { openChip } from '../editor/session';
import { constWord } from '../lib/alu';
import { Builder } from '../lib/builder';
import { splitter } from '../lib/define';
import { AND, NOT } from '../lib/gates';
import { EQ16 } from '../lib/rv16/logic';
import { register } from '../lib/sequential';
import { assemble16 } from '../riscv/rv16/asm16';
import { MMIO16 } from '../riscv/rv16/isa16';
import type { ComponentDef } from '../sim/types';
import type { CoreSpec, CoreTest } from './corecheck';

/** The test a failure line names ("random 3.4: register write #2 …" → "random 3.4"). */
export function failingTest(spec: CoreSpec, failure: string): CoreTest | null {
  const tests = spec.tests();
  return tests.find((t) => failure.startsWith(`${t.name}: `)) ?? null;
}

/** The program as RV16 source (a test given as words: one .word per word, still disassembled in the listing). */
function sourceOf(t: CoreTest): { src: string; words: number[]; data: Map<number, number> } | { error: string } {
  if (t.words) {
    const src = `# ${t.name}\n${t.words.map((w) => `        .word 0x${w.toString(16).padStart(4, '0')}`).join('\n')}\n`;
    return { src, words: t.words, data: t.data ?? new Map() };
  }
  const a = assemble16(t.src ?? '');
  if (a.errors.length) return { error: `${a.errors[0].line}: ${a.errors[0].message}` };
  return { src: t.src!, words: a.words, data: a.data };
}

export interface Bench { ws: Workspace; id: string }

/** The bench's RAM: 64 words at gate level (the address decoding around it takes daddr[5:0]). */
const BENCH_RAM_K = 6;

/**
 * Add the bench chip for test `t` around the core chip `coreId` (compiled as `core`) and open it.
 * system: the core has an irq input, driven by stores to IRQ.
 */
export function addBench(ws: Workspace, core: ComponentDef, coreId: string, t: CoreTest): Bench | { error: string } {
  const prog = sourceOf(t);
  if ('error' in prog) return prog;
  const k = Math.max(2, Math.ceil(Math.log2(Math.max(2, prog.words.length))));
  if (k > MAX_ROM_K) return { error: `${prog.words.length} instructions do not fit in the sandbox's largest ROM (${2 ** MAX_ROM_K} words)` };
  const ramK = BENCH_RAM_K;
  const init = new Array<number>(2 ** ramK).fill(0);
  for (const [a, v] of prog.data) if (a < 0xfff0) init[a % 2 ** ramK] = v & 0xffff;
  const romRef: PartRef = { rom: { k, w: 16, addr: 'word', lang: 'rv16', src: prog.src } };
  const ramRef: PartRef = { ram: { k: ramK, w: 16, ...(init.some((x) => x) ? { init } : {}) } };
  const romDef = partDef(romRef, () => undefined), ramDef = partDef(ramRef, () => undefined);
  if (isError(romDef)) return romDef;
  if (isError(ramDef)) return ramDef;
  const irq = core.ports.some((p) => p.name === 'irq' && p.dir === 'in');

  const b = new Builder(12, 16, 8);
  b.pins('clk', 'rst');
  const c = b.op(core, ['clk', 'rst', '', '', ...(irq ? [''] : [])], 'your core');
  b.next();
  const pcs = b.op(splitter([k, 16 - k], 4), [`${c}.pc`]);
  const ds = b.op(splitter([ramK, 15 - ramK, 1], 4), [`${c}.daddr`], 'address');
  const dw = b.op(splitter([1, 15], 4), [`${c}.dwdata`]);
  b.next();
  const rom = b.op(romDef, [`${pcs}.o0`], 'program');
  const io = b.name(`${ds}.o2`, 'io', true);
  const isLeds = b.op(EQ16, [`${c}.daddr`, b.op1(constWord(16, MMIO16.LEDS), [])], '= LEDS');
  const isIrq = irq ? b.op(EQ16, [`${c}.daddr`, b.op1(constWord(16, MMIO16.IRQ), [])], '= IRQ') : '';
  b.next();
  const ramWe = b.op1(AND, [`${c}.dwe`, b.op1(NOT, [io])], 'RAM write');
  const ledWe = b.op1(AND, [`${c}.dwe`, `${isLeds}.eq`], 'LED write');
  const irqWe = irq ? b.op1(AND, [`${c}.dwe`, `${isIrq}.eq`], 'IRQ write') : '';
  b.next();
  const mem = b.op(ramDef, [`${ds}.o0`, `${c}.dwdata`, ramWe, 'clk'], 'data (64 words)');
  const leds = b.op(register(16), [`${c}.dwdata`, ledWe, 'clk'], 'LEDs');
  if (irq) b.wire(`${b.op(register(1), [`${dw}.o0`, irqWe, 'clk'], 'IRQ line')}.q`, `${c}.irq`);
  b.wire(`${rom}.data`, `${c}.instr`);
  b.wire(`${mem}.dout`, `${c}.drdata`);
  b.wire(`${leds}.q`, 'leds');
  const R = b.right;
  const def: ComponentDef = {
    id: 'rv16_bench', name: 'bench', category: 'cpu', symbol: { kind: 'box', label: 'BENCH' },
    ports: [{ name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'rst', width: 1, dir: 'in' }, { name: 'leds', width: 16, dir: 'out' }],
    netlist: () => ({ pins: { clk: [0, 4], rst: [0, 8], leds: [R, 6] }, instances: b.instances, nets: b.nets() }),
  };
  const id = uniqueName(`u_bench_${coreId.replace(/^u_/, '')}`, Object.keys(ws.chips));
  const name = uniqueName(`Debug: ${t.name}`, Object.values(ws.chips).map((x) => x.name));
  const doc = docFromDef(def, { id, name, refOf: (d) => (d === core ? { chip: coreId } : d === romDef ? romRef : d === ramDef ? ramRef : undefined) });
  if ('error' in doc) return doc;
  const out: ChipDoc = {
    ...doc,
    notes: `The test “${t.name}” around your core “${ws.chips[coreId]?.name ?? coreId}”. The CPU panel runs it against the golden model and stops at the first wrong register write or store; probe the wires that lead to it (P), step a cycle at a time. The data memory is 64 words decoded on daddr[5:0] (the golden model wraps the same way); the LEDs are at 0xFFFB${irq ? ', the interrupt line is set by stores to 0xFFF9' : ''}. Edit your core in its own tab: this bench follows.`,
  };
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: out } }, id), id };
}
