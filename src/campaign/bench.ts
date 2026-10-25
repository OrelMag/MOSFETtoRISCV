// "Debug this test in the sandbox": a failing core-level program as a computer chip around the
// learner's own core: an RV16 ROM holding the program, a 64-word RAM holding its data (decoded on
// the low address bits, as the sandbox's RAM is the size it is), an LED register at LEDS and the
// interrupt line set by stores to IRQ, as the core bench does. The sandbox's CPU drawer then runs it
// against the golden model (editor/cpu16.ts, wrapping its memory the same way) and stops at the
// first wrong register write or store, with probes and the timing panel at hand. The io bench adds a
// 32 × 32 RGB565 screen at SCREEN16_IO (0xF000 + 32·y + x, write-only), eight switches at SWITCHES and a
// reset for the first cycle: Pong (riscv/rv16/pong16.ts) on a passing core, or on the reference core from
// Examples ▸. No DOM.

import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef, Workspace } from '../editor/model';
import { uniqueName } from '../editor/model';
import { isError, MAX_ROM_K, partDef } from '../editor/parts';
import { openChip } from '../editor/session';
import { constWord, isZero } from '../lib/alu';
import { Builder } from '../lib/builder';
import { andN, busMux2 } from '../lib/combinational';
import { merger, ones, splitter } from '../lib/define';
import { AND, NOT, OR } from '../lib/gates';
import { RV16_CORE } from '../lib/rv16/cpu';
import { EQ16, RV16_DREG16 } from '../lib/rv16/logic';
import { DFF, register } from '../lib/sequential';
import { TIE1 } from '../lib/transistors';
import { assemble16 } from '../riscv/rv16/asm16';
import { MMIO16, SCREEN16_IO } from '../riscv/rv16/isa16';
import { PONG16 } from '../riscv/rv16/pong16';
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

/** The io bench's switch bank: eight toggles, zero-extended, read at SWITCHES (the sandbox computer's Pong uses the same switches). */
const BENCH_SWITCHES = 8;

export interface BenchOptions {
  /**
   * The screen and switches as well: a 32 × 32 RGB565 screen painted by stores to SCREEN16_IO (daddr[15:10] = 111100:
   * x = daddr[4:0], y = daddr[9:5]; the RAM is not written) and eight switches read by loads from SWITCHES (0xFFFA).
   */
  io?: boolean;
  /** The chip's id and name (default: from the core and the test). */
  id?: string;
  name?: string;
  /** The core as a part (default: { chip: coreId }). */
  coreRef?: PartRef;
  /** The chip's notes (default: the debug bench's). */
  notes?: string;
  /** Its automatic clock's rate (ChipDoc.hz). */
  hz?: number;
}

/**
 * The bench chip for test `t` around `core` (the chip `coreId`, or opts.coreRef), not added to a workspace. system:
 * the core has an irq input, driven by stores to IRQ. Without opts.io the bench is the debug bench, part for part.
 */
export function benchChip(core: ComponentDef, coreId: string, coreName: string, t: CoreTest, opts: BenchOptions = {}, taken: { ids: string[]; names: string[] } = { ids: [], names: [] }): ChipDoc | { error: string } {
  const prog = sourceOf(t);
  if ('error' in prog) return prog;
  const k = Math.max(2, Math.ceil(Math.log2(Math.max(2, prog.words.length))));
  if (k > MAX_ROM_K) return { error: `${prog.words.length} instructions do not fit in the sandbox's largest ROM (${2 ** MAX_ROM_K} words)` };
  const ramK = BENCH_RAM_K;
  const init = new Array<number>(2 ** ramK).fill(0);
  for (const [a, v] of prog.data) if (a < 0xfff0) init[a % 2 ** ramK] = v & 0xffff;
  const romRef: PartRef = { rom: { k, w: 16, addr: 'word', lang: 'rv16', src: prog.src } };
  const ramRef: PartRef = { ram: { k: ramK, w: 16, ...(init.some((x) => x) ? { init } : {}) } };
  const swRef: PartRef = { switches: BENCH_SWITCHES };
  const scrRef: PartRef = { screen: { mode: 'write', size: SCREEN16_IO.SIZE, color: 'rgb565', scale: 4 } };
  const romDef = partDef(romRef, () => undefined), ramDef = partDef(ramRef, () => undefined);
  const swDef = partDef(swRef, () => undefined), scrDef = partDef(scrRef, () => undefined);
  if (isError(romDef)) return romDef;
  if (isError(ramDef)) return ramDef;
  if (isError(swDef)) return swDef;
  if (isError(scrDef)) return scrDef;
  const irq = core.ports.some((p) => p.name === 'irq' && p.dir === 'in');
  const io = !!opts.io;

  const b = new Builder(12, 16, 8);
  b.pins('clk', 'rst');
  // io: the core is held in reset for its first cycle, as on the level's bench (a multicycle core's state machine
  // starts there): a flip-flop powered on at 0 holds rst for one cycle, and again after every Reset
  const rst = io ? b.op1(OR, ['rst', b.op1(NOT, [b.op1(DFF, [b.op1(TIE1, []), 'clk'], 'powered on')])], 'reset, first cycle') : 'rst';
  if (io) b.next();
  const c = b.op(core, ['clk', rst, '', '', ...(irq ? [''] : [])], 'your core');
  b.next();
  const pcs = b.op(splitter([k, 16 - k], 4), [`${c}.pc`]);
  const ds = b.op(splitter([ramK, 15 - ramK, 1], 4), [`${c}.daddr`], 'address');
  const dw = irq ? b.op(splitter([1, 15], 4), [`${c}.dwdata`]) : '';
  b.next();
  const rom = b.op(romDef, [`${pcs}.o0`], 'program');
  const hi = b.name(`${ds}.o2`, 'io', true);
  const isLeds = b.op(EQ16, [`${c}.daddr`, b.op1(constWord(16, MMIO16.LEDS), [])], '= LEDS');
  const isIrq = irq ? b.op(EQ16, [`${c}.daddr`, b.op1(constWord(16, MMIO16.IRQ), [])], '= IRQ') : '';
  b.next();
  const ramWe = b.op1(AND, [`${c}.dwe`, b.op1(NOT, [hi])], 'RAM write');
  const ledWe = b.op1(AND, [`${c}.dwe`, `${isLeds}.eq`], 'LED write');
  const irqWe = irq ? b.op1(AND, [`${c}.dwe`, `${isIrq}.eq`], 'IRQ write') : '';
  b.next();
  const mem = b.op(ramDef, [`${ds}.o0`, `${c}.dwdata`, ramWe, 'clk'], 'data (64 words)');
  const leds = b.op(register(16), [`${c}.dwdata`, ledWe, 'clk'], 'LEDs');
  if (irq) b.wire(`${b.op(register(1), [`${dw}.o0`, irqWe, 'clk'], 'IRQ line')}.q`, `${c}.irq`);
  b.wire(`${rom}.data`, `${c}.instr`);
  if (io) {
    // the screen: daddr[15:10] = 111100 (0xF000 … 0xF3FF), x = daddr[4:0], y = daddr[9:5]
    b.next();
    const xy = b.op(splitter([5, 5, 6], 4), [`${c}.daddr`], 'screen address');
    const top = b.op(splitter(ones(6), 2), [`${xy}.o2`]);
    const isSw = b.op(EQ16, [`${c}.daddr`, b.op1(constWord(16, MMIO16.SWITCHES), [])], '= SWITCHES');
    const sw = b.op1(swDef, [], 'switches');
    b.next();
    const isScr = b.op1(andN(6), [b.op1(NOT, [`${top}.o0`]), b.op1(NOT, [`${top}.o1`]), `${top}.o2`, `${top}.o3`, `${top}.o4`, `${top}.o5`], 'screen words');
    const swz = b.op1(merger([BENCH_SWITCHES, 16 - BENCH_SWITCHES], 4), [sw, b.op1(constWord(16 - BENCH_SWITCHES, 0), [])], 'switches, 16 bits');
    b.next();
    const scrWe = b.op1(AND, [`${c}.dwe`, isScr], 'screen write');
    b.wire(b.op1(busMux2(16), [`${mem}.dout`, swz, `${isSw}.eq`], 'RAM or switches'), `${c}.drdata`);
    b.next();
    b.op(scrDef, [`${xy}.o0`, `${xy}.o1`, `${c}.dwdata`, scrWe, 'clk'], 'screen (0xF000)');
  } else b.wire(`${mem}.dout`, `${c}.drdata`);
  b.wire(`${leds}.q`, 'leds');
  const R = b.right;
  const def: ComponentDef = {
    id: io ? 'rv16_io_bench' : 'rv16_bench', name: 'bench', category: 'cpu', symbol: { kind: 'box', label: 'BENCH' },
    ports: [{ name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'rst', width: 1, dir: 'in' }, { name: 'leds', width: 16, dir: 'out' }],
    netlist: () => ({ pins: { clk: [0, 4], rst: [0, 8], leds: [R, 6] }, instances: b.instances, nets: b.nets() }),
  };
  const id = opts.id ?? uniqueName(`u_bench_${coreId.replace(/^u_/, '')}`, taken.ids);
  const name = opts.name ?? uniqueName(`Debug: ${t.name}`, taken.names);
  const coreRef = opts.coreRef ?? { chip: coreId };
  const refs = new Map<ComponentDef, PartRef>([[core, coreRef], [romDef, romRef], [ramDef, ramRef], [swDef, swRef], [scrDef, scrRef]]);
  const doc = docFromDef(def, { id, name, refOf: (d) => refs.get(d) });
  if ('error' in doc) return doc;
  return {
    ...doc,
    ...(opts.hz ? { hz: opts.hz } : {}),
    notes: opts.notes ?? `The test “${t.name}” around your core “${coreName}”. The CPU panel runs it against the golden model and stops at the first wrong register write or store; probe the wires that lead to it (P), step a cycle at a time. The data memory is 64 words decoded on daddr[5:0] (the golden model wraps the same way); the LEDs are at 0xFFFB${irq ? ', the interrupt line is set by stores to 0xFFF9' : ''}${io ? '; the screen (32 × 32, RGB565) at 0xF000 + 32·y + x, the switches at 0xFFFA' : ''}. Edit your core in its own tab: this bench follows.`,
  };
}

/** Add the bench chip for test `t` around the core chip `coreId` (compiled as `core`) and open it. */
export function addBench(ws: Workspace, core: ComponentDef, coreId: string, t: CoreTest, opts: BenchOptions = {}): Bench | { error: string } {
  const doc = benchChip(core, coreId, ws.chips[coreId]?.name ?? coreId, t, opts, { ids: Object.keys(ws.chips), names: Object.values(ws.chips).map((x) => x.name) });
  if ('error' in doc) return doc;
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [doc.id]: doc } }, doc.id), id: doc.id };
}

/** The Pong program as a core test (the bench's ROM). */
export const PONG16_TEST: CoreTest = { name: 'Pong', src: PONG16 };

const PONG_NOTES = (core: string) => `Pong (RV16 assembly in the ROM: Edit program…) on ${core}, with the golden model in lock step in the CPU panel. Run (or set the clock rate high): your paddle is the left one, switch 7 up and switch 6 down; the computer plays the right one, or a second player with switch 4 on (switch 1 up, switch 0 down). The LEDs keep the score, yours in bits 7–4; five points win a game. The screen is 32 × 32 RGB565 at 0xF000 + 32·y + x (a store paints a pixel), the switches are read at 0xFFFA, the data memory is 64 words.`;

/** The Pong bench's clock: a frame is about 240 cycles. */
export const PONG_HZ = 5000;

/** Pong on a bench around the core chip `coreId` (compiled as `core`), added and opened. */
export function addPongBench(ws: Workspace, core: ComponentDef, coreId: string): Bench | { error: string } {
  const coreName = ws.chips[coreId]?.name ?? coreId;
  return addBench(ws, core, coreId, PONG16_TEST, {
    io: true,
    name: uniqueName(`Pong on ${coreName}`, Object.values(ws.chips).map((x) => x.name)),
    id: uniqueName(`u_pong_${coreId.replace(/^u_/, '')}`, Object.keys(ws.chips)),
    notes: PONG_NOTES(`your core “${coreName}”`),
    hz: PONG_HZ,
  });
}

/** Pong around the reference single-cycle core (the library's rv16_cpu, Core III's answer): Examples ▸. */
export function pongChip(id: string, name: string): ChipDoc {
  const doc = benchChip(RV16_CORE, '', 'the reference core', PONG16_TEST, { io: true, id, name, hz: PONG_HZ, coreRef: { lib: RV16_CORE.id }, notes: PONG_NOTES('the reference single-cycle core (rv16_cpu, Core III’s answer)') });
  if ('error' in doc) throw new Error(`pong bench: ${doc.error}`);
  return doc;
}

// ---- lane cores (act 9) ------------------------------------------------------------------

/** The bench's data memory: words 0x000–0x3FF; with the rasterizer, the screen at FB16 = 0xF000. */
const LANE_RAM_K = 10;

const laneAddrs = new Map<boolean, ComponentDef>();

/**
 * One lane's address decoding on the bench: a store writes the data memory when daddr[15:10] = 0, the
 * screen memory when daddr[15:10] = 111100 (raster); anything else (the I/O words at 0xFFF0) writes nothing.
 */
function laneAddr(raster: boolean): ComponentDef {
  let d = laneAddrs.get(raster);
  if (d) return d;
  const b = new Builder(12, 12, 4);
  b.pins('daddr', 'dwe');
  const s = b.op(splitter([LANE_RAM_K, 16 - LANE_RAM_K]), ['daddr'], undefined, 'split');
  const bits = raster ? b.op(splitter(ones(16 - LANE_RAM_K)), [`${s}.o1`], undefined, 'bits') : '';
  b.next();
  const data = b.op1(isZero(16 - LANE_RAM_K), [`${s}.o1`], 'data words', 'data');
  let fb = '';
  if (raster) {
    const n10 = b.op1(NOT, [`${bits}.o0`], undefined, 'n10'), n11 = b.op1(NOT, [`${bits}.o1`], undefined, 'n11');
    b.next();
    fb = b.op1(andN(6), [`${bits}.o2`, `${bits}.o3`, `${bits}.o4`, `${bits}.o5`, n10, n11], 'screen words', 'screen');
  }
  b.next();
  b.wire(`${s}.o0`, 'a');
  b.wire(b.op1(AND, ['dwe', data], 'data write', 'dataWe'), 'we');
  if (raster) {
    b.wire(b.op1(AND, ['dwe', fb], 'screen write', 'fbWe'), 'fwe');
    b.wire(fb, 'fb');
  }
  const R = b.right;
  const outs = raster ? ['a', 'we', 'fwe', 'fb'] : ['a', 'we'];
  d = {
    id: `lane_addr16${raster ? '_fb' : ''}`, name: 'lane address', category: 'cpu', symbol: { kind: 'box', label: 'ADDR' },
    ports: [{ name: 'daddr', width: 16, dir: 'in' }, { name: 'dwe', width: 1, dir: 'in' },
      ...outs.map((o) => ({ name: o, width: o === 'a' ? LANE_RAM_K : 1, dir: 'out' as const }))],
    netlist: () => ({ pins: { daddr: [0, 4], dwe: [0, 8], ...Object.fromEntries(outs.map((o, i) => [o, [R, 4 + 4 * i]])) }, instances: b.instances, nets: b.nets() }),
  };
  laneAddrs.set(raster, d);
  return d;
}

/**
 * The bench chip for test `t` around the lane core chip `coreId` (compiled as `core`), opened: the program
 * in a ROM, the core, a data memory with a port per lane (words 0x000–0x3FF, decoded by each lane's
 * address chip). Two warps: each lane's word comes back a cycle late (a register after the read, as the
 * warp bench's synchronous memories). raster: a screen memory at 0xF000 with a fifth port for the
 * rasterizer's pixel writes (which win a word a lane also writes), and a 32 × 32 RGB565 screen showing them.
 */
export function addLaneBench(ws: Workspace, core: ComponentDef, coreId: string, t: CoreTest, spec: CoreSpec): Bench | { error: string } {
  const prog = sourceOf(t);
  if ('error' in prog) return prog;
  const n = spec.lanes ?? 4, warps = (spec.warps ?? 1) > 1, raster = !!spec.raster;
  const need = ['clk', 'rst', 'instr', 'pc', 'dwe', ...Array.from({ length: n }, (_, i) => [`drdata${i}`, `daddr${i}`, `dwdata${i}`]).flat(), ...(raster ? ['fa', 'fd', 'fwe'] : [])];
  const missing = need.filter((p) => !core.ports.some((q) => q.name === p));
  if (missing.length) return { error: `the core has no pin${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
  const k = Math.max(2, Math.ceil(Math.log2(Math.max(2, prog.words.length))));
  if (k > MAX_ROM_K) return { error: `${prog.words.length} instructions do not fit in the sandbox's largest ROM (${2 ** MAX_ROM_K} words)` };
  const init = new Array<number>(2 ** LANE_RAM_K).fill(0);
  for (const [a, v] of prog.data) if (a < init.length) init[a] = v & 0xffff;
  const L = Array.from({ length: n }, (_, i) => i);
  const romRef: PartRef = { rom: { k, w: 16, addr: 'word', lang: 'rv16', src: prog.src } };
  const ramRef: PartRef = { ram: { k: LANE_RAM_K, w: 16, ports: n, ...(init.some((x) => x) ? { init } : {}) } };
  const fbRef: PartRef = { ram: { k: LANE_RAM_K, w: 16, ports: n + 1 } };
  const scrRef: PartRef = { screen: { mode: 'write', size: 32, color: 'rgb565' } };
  const romDef = partDef(romRef, () => undefined), ramDef = partDef(ramRef, () => undefined);
  const fbDef = partDef(fbRef, () => undefined), scrDef = partDef(scrRef, () => undefined);
  if (isError(romDef)) return romDef;
  if (isError(ramDef)) return ramDef;
  if (isError(fbDef)) return fbDef;
  if (isError(scrDef)) return scrDef;
  const ADDR = laneAddr(raster);
  const addrDoc = docFromDef(ADDR, { id: `u_bench_${ADDR.id}`, name: raster ? 'Lane address (data, screen)' : 'Lane address' });
  if ('error' in addrDoc) return addrDoc;
  const addrId = addrDoc.id;

  const b = new Builder(12, 16, 6);
  b.pins('clk', 'rst');
  // the level's bench resets the core for its first cycle (the active mask starts there): a flip-flop
  // powered on at 0 holds rst for one cycle, and again after every Reset
  const por = b.op1(DFF, [b.op1(TIE1, [], undefined, 'one'), 'clk'], 'powered on', 'por');
  const rst = b.op1(OR, ['rst', b.op1(NOT, [por], undefined, 'npor')], 'reset, first cycle', 'reset');
  b.next();
  const c = b.add(core, 'your core', 'core');
  b.wire('clk', `${c}.clk`);
  b.wire(rst, `${c}.rst`);
  b.next();
  const pcs = b.op(splitter([k, 16 - k], 4), [`${c}.pc`], undefined, 'pcs');
  const dwe = b.op(splitter(ones(n)), [`${c}.dwe`], undefined, 'dwes');
  b.next();
  const rom = b.op(romDef, [`${pcs}.o0`], 'program', 'program');
  const dec = L.map((i) => b.op(ADDR, [`${c}.daddr${i}`, `${dwe}.o${i}`], `lane ${i} address`, `addr${i}`));
  b.next();
  const mem = b.add(ramDef, `data, ${2 ** LANE_RAM_K} words`, 'dmem');
  L.forEach((i) => { b.wire(`${dec[i]}.a`, `${mem}.addr${i}`); b.wire(`${c}.dwdata${i}`, `${mem}.wd${i}`); });
  b.wire(b.op1(merger(ones(n)), L.map((i) => `${dec[i]}.we`), undefined, 'dwem'), `${mem}.we`);
  b.wire('clk', `${mem}.clk`);
  let fbm = '';
  if (raster) {
    fbm = b.add(fbDef, 'screen words (0xF000)', 'fbmem');
    L.forEach((i) => { b.wire(`${dec[i]}.a`, `${fbm}.addr${i}`); b.wire(`${c}.dwdata${i}`, `${fbm}.wd${i}`); });
    b.wire(`${c}.fa`, `${fbm}.addr${n}`);
    b.wire(`${c}.fd`, `${fbm}.wd${n}`);
    b.wire(b.op1(merger(ones(n + 1)), [...L.map((i) => `${dec[i]}.fwe`), `${c}.fwe`], undefined, 'fwem'), `${fbm}.we`);
    b.wire('clk', `${fbm}.clk`);
    const xy = b.op(splitter([5, 5]), [`${c}.fa`], undefined, 'xy');
    const scr = b.add(scrDef, 'the rasterizer’s pixels', 'screen');
    b.wire(`${xy}.o0`, `${scr}.x`);
    b.wire(`${xy}.o1`, `${scr}.y`);
    b.wire(`${c}.fd`, `${scr}.color`);
    b.wire(`${c}.fwe`, `${scr}.we`);
    b.wire('clk', `${scr}.clk`);
  }
  b.next();
  L.forEach((i) => {
    let q = raster ? b.op1(busMux2(16), [`${mem}.rd${i}`, `${fbm}.rd${i}`, `${dec[i]}.fb`], `lane ${i} reads`, `rsel${i}`) : `${mem}.rd${i}`;
    if (warps) q = b.op1(RV16_DREG16, [q, 'clk'], `lane ${i}, a cycle late`, `late${i}`);
    b.wire(b.name(q, `drdata${i}`, true), `${c}.drdata${i}`);
  });
  b.wire(b.name(`${rom}.data`, 'instr', true), `${c}.instr`);
  const def: ComponentDef = {
    id: 'rv16_lane_bench', name: 'lane bench', category: 'cpu', symbol: { kind: 'box', label: 'BENCH' },
    ports: [{ name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'rst', width: 1, dir: 'in' }],
    netlist: () => ({ pins: { clk: [0, 4], rst: [0, 8] }, instances: b.instances, nets: b.nets() }),
  };
  const id = uniqueName(`u_bench_${coreId.replace(/^u_/, '')}`, Object.keys(ws.chips));
  const name = uniqueName(`Debug: ${t.name}`, Object.values(ws.chips).map((x) => x.name));
  const doc = docFromDef(def, {
    id, name,
    refOf: (d) => (d === core ? { chip: coreId } : d === ADDR ? { chip: addrId } : d === romDef ? romRef : d === ramDef ? ramRef : d === fbDef ? fbRef : d === scrDef ? scrRef : undefined),
  });
  if ('error' in doc) return doc;
  const what = warps ? 'every thread (warp, lane)' : 'every lane';
  const out: ChipDoc = {
    ...doc,
    notes: `The test “${t.name}” around your core “${ws.chips[coreId]?.name ?? coreId}”. The CPU panel runs it against the lane golden model and stops at the first wrong write: ${what} must make the register writes and stores the model makes, in order${warps ? ' (a load’s word comes back a cycle late, on the load port)' : ''}${raster ? ', and the rasterizer the pixel writes the model draws' : ''}. Probe the wires that lead to it (P), step a cycle at a time. The core is held in reset for its first cycle, as on the level’s bench. `
      + `The data memory holds words 0x000–0x3FF, a port per lane (each lane’s address chip decodes daddr[15:10])${raster ? '; the screen memory 0xF000–0xF3FF, with a fifth port for the rasterizer. The screen shows the rasterizer’s pixel writes; the lanes’ own stores to the screen are in the screen memory' : ''}. Edit your core in its own tab: this bench follows.`,
  };
  const chips = { ...ws.chips, [id]: out, ...(ws.chips[addrId] ? {} : { [addrId]: addrDoc }) };
  return { ws: openChip({ ...ws, chips }, id), id };
}
