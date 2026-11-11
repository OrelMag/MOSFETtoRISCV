import { groupDigits } from '../sim/numfmt';
import { LOAD_EXTRACT, STORE_ALIGN, bankedMemory } from '../lib/lsu';
import { CSR_UNIT, SYS_DECODE, TRAP_UNIT, systemCpu } from '../lib/system';
import { withoutParts } from '../lib/tech';
import { cpuState } from '../riscv/cosim';
import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { SYSTEM_PROGRAMS } from '../riscv/sysprograms';
import { crossover } from '../riscv/pollirq';
import { stats } from '../sim/stats';
import { pack } from '../sim/values';
import { findIt } from '../widgets/findfault';
import { cpuScene } from '../widgets/cpupanel';
import type { Stage } from '../view/stage';
import { IO_MORE, TRAPS_MORE } from './ch-system-more';
import type { Chapter } from './types';
import { numOf } from './order';

const sys = (id: string) => SYSTEM_PROGRAMS.find((p) => p.id === id)!.source;

/** Find it: the system CPU with one bit of a CSR read stuck (sim/faults.ts), never drawn. */
const FIND_SYS = findIt({
  source: sys('syscall'), system: true,
  planted: [{ kind: 'stuck1', end: 'csr.mepcOut', bit: 2 }],
  goal: 'Find the planted fault: name the wire, the bit and the value it is stuck at.',
  hints: [
    'The first wrong register is t2, written by <code>csrr t2, mepc</code> in the handler (the panel shows it as <code>csrrs t2, mepc, zero</code>, what csrr stands for): the hardware read 0x14, the model 0x10.',
    '0x14 and 0x10 differ in one bit, 0x4: bit 2. The trap saved the right address (the first ecall is at 0x10); where does a read of mepc come from?',
    'The CSR unit\'s <code>mepc</code> output, the register\'s value on its way out (to the trap unit for <code>mret</code>, and to the CSR read): bit 2, stuck at 1.',
  ],
  fault: 'Bit 2 of the CSR unit\'s <code>mepc</code> output was stuck at 1. The trap saved the right address in mepc, 0x10, but every read of it came out with bit 2 set: <code>csrr t2, mepc</code> gave 0x14, and the handler returned past the instruction it should have come back to. A single bit, and only on one path: the trap itself was right, which is why the fault showed only once the handler read mepc.',
});
const nd = (d: Parameters<typeof stats>[0]) => stats(d).nands;
/** The byte enables of a store: size 0 byte, 1 half, 2 word, at a byte offset 0..3. */
const enables = (size: number, off: number) => (size === 0 ? 1 << off : size === 1 ? 3 << (off & 2) : 15);
const bin4 = (n: number) => n.toString(2).padStart(4, '0');
/**
 * One timer tick on the golden model (the system-mode ISS, which the CPU panel holds the gates to): the timer program run to its first
 * interrupt and back, the machine-mode state at four moments. The chapter's worked example; tests/worked-examples.test.ts pins it.
 */
export function timerTick() {
  const a = assemble(sys('timer')), iss = new ISS(a.words, { system: true });
  const handler = a.labels.get('handler')!;
  const at = () => ({ pc: iss.pc, mtime: iss.mtime, mtimecmp: iss.mtimecmp, mtip: (iss.mip >> 7) & 1, mie: +iss.mie, mpie: +iss.mpie, mepc: iss.mepc, mcause: iss.mcause >>> 0, retired: iss.retired });
  let guard = 0;
  const run = (until: () => boolean) => { while (!until()) { iss.step(); if (++guard > 500) throw new Error('timerTick: no tick'); } };
  run(() => !!(iss.mip & 0x80) && iss.mie);
  const pending = at();
  iss.step();
  const taken = at();
  run(() => !(iss.mip & 0x80));
  const cleared = at();
  run(() => iss.pc === taken.mepc);
  const back = at();
  return { handler, pending, taken, cleared, back, cost: back.mtime - pending.mtime, period: cleared.mtimecmp - pending.mtimecmp };
}

const hex8 = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** The worked example: the four moments as a table, and what each row shows. */
function tickWorked(): string {
  const T = timerTick();
  const row = (r: typeof T.pending, what: string) => `<tr><th>${what}</th><td>${r.pc}</td><td>${r.mtime}</td><td>${r.mtimecmp}</td><td>${r.mtip}</td><td>${r.mie}</td><td>${r.mpie}</td><td>${r.mepc}</td><td>${hex8(r.mcause)}</td></tr>`;
  return `<details class="deeper"><summary>Worked example: one tick, register by register</summary>
    <p>The program above run on the golden model to its first interrupt and back. Each row is the machine state between two steps.</p>
    <div class="worked-wrap" tabindex="0" role="region" aria-label="Table, scrolls sideways"><table class="pipe-trace"><thead><tr><th></th><th>pc</th><th>mtime</th><th>mtimecmp</th><th>MTIP</th><th>MIE</th><th>MPIE</th><th>mepc</th><th>mcause</th></tr></thead><tbody>
    ${row(T.pending, '1. pending')}${row(T.taken, '2. taken')}${row(T.cleared, '3. source cleared')}${row(T.back, '4. after mret')}</tbody></table></div>
    <ol>
    <li>mtime has reached mtimecmp (${T.pending.mtime} ≥ ${T.pending.mtimecmp}), so MTIP = 1; MTIE and MIE are both set, so the interrupt is taken
    instead of the instruction at pc ${T.pending.pc} (the loop's <code>addi</code>).</li>
    <li>One step and no instruction retired (${T.pending.retired} before, ${T.taken.retired} after). mepc = ${T.taken.mepc}, the instruction that did not run,
    so nothing needs adding to it; mcause = ${hex8(T.taken.mcause)}, bit 31 for an interrupt and ${T.taken.mcause & 0xff} for the machine timer;
    MPIE keeps the old MIE and MIE = 0; pc = mtvec = ${T.handler}.</li>
    <li>The handler's store moves mtimecmp to ${T.cleared.mtimecmp}: mtime (${T.cleared.mtime}) is below it again and MTIP falls. Without this the
    same interrupt would be taken again right after <code>mret</code>.</li>
    <li><code>mret</code>: pc = mepc = ${T.back.pc}, MIE = MPIE = 1. The loop goes on where it was.</li>
    </ol>
    <p>The tick, from pending to back in the loop, took ${T.cost} cycles of mtime: the trap entry and the handler's instructions. One tick every
    ${T.period} cycles: ${Math.round((T.cost / T.period) * 100)} % of the machine.</p></details>`;
}

/** The chapter's common mistakes, each against this machine's own behaviour. */
function trapMistakes(): string {
  const T = timerTick();
  return `<details class="deeper"><summary>Common mistakes with traps and interrupts</summary><ul>
    <li><strong>Adding 4 to mepc for every trap.</strong> mepc holds the instruction that did not run. After an ecall, or a fault the handler emulates
    or skips, the handler moves on (+ 4); after an interrupt it must not, because that instruction never ran: the tick in "The timer interrupt"
    returns to ${T.taken.mepc} itself.</li>
    <li><strong>Reading mcause without bit 31.</strong> ${hex8(T.taken.mcause)} is the machine timer interrupt; ${T.taken.mcause & 0xff} alone would be a
    store access fault. A handler tests bit 31 first, then the code.</li>
    <li><strong>Not clearing the source.</strong> The timer and the external line are levels: while mtime ≥ mtimecmp, or the line is high, the
    interrupt stays pending and <code>mret</code> takes it again at once. The handler moves mtimecmp or acknowledges the device.</li>
    <li><strong>Setting MIE in a handler before saving mepc and mcause.</strong> A second trap overwrites both: there is one copy of each. Save
    them first, as "Nested interrupts" does.</li>
    <li><strong>Using registers the interrupted code owns.</strong> The trap saves only the pc. An interrupt comes between any two instructions,
    so a handler that changes a register without saving and restoring it breaks the program at a random place. The short handlers of this chapter get away with it only because their main programs keep nothing in the registers the handlers use.</li>
    <li><strong>"Interrupts always beat polling."</strong> Each event costs a trap, a handler and an <code>mret</code>. Measured on this machine,
    polling does more work when events come more often than one per ${crossover(6)} cycles (with 6 instructions of work between polls).</li>
  </ul></details>`;
}

/** NANDs of the privileged-architecture hardware: the CSR unit, the trap unit and the system decoder. */
const TRAP_NANDS = nd(CSR_UNIT) + nd(TRAP_UNIT) + nd(SYS_DECODE);

/** NANDs of the complete system CPU (RV32I, or RV32IM with `m`), with and without its program ROM. The ROM is a
 *  fixed 128-word mux tree whatever the program, so an empty program measures it. */
const sysMemo = new Map<boolean, { all: number; core: number; rom: number }>();
export function sysNands(m: boolean): { all: number; core: number; rom: number } {
  let r = sysMemo.get(m);
  if (!r) {
    const d = systemCpu([], { m });
    const all = stats(d).nands, core = stats(withoutParts(d, ['imem'])).nands;
    sysMemo.set(m, (r = { all, core, rom: all - core }));
  }
  return r;
}
/** A count rounded to thousands, spaced as the site writes numbers: 67 131 → "67 000". */
export const kNands = (n: number) => groupDigits(Math.round(n / 1000) * 1000);

function csrq(st: Stage, inst: string): number {
  const csr = st.rootCtx?.node.children?.get('csr');
  const n = csr?.children?.get(inst);
  return n ? pack(st.sim!.getBits(n.ports.q)) >>> 0 : -1;
}

export const chIO: Chapter = {
  id: 'io', num: numOf('io'), title: 'Bytes and the outside world', level: 'System',
  blurb: 'Byte and halfword memory access, and memory-mapped I/O: a console, LEDs, switches and a timer.',
  goals: [
    'store a byte or halfword into a word memory with replicated data and byte enables',
    'extract a byte or halfword on a load and sign- or zero-extend it',
    'say which accesses are misaligned',
    'drive a console, LEDs and switches with ordinary loads and stores to I/O addresses',
    'say why an I/O register is not memory: whole-word writes, reads with side effects, polling the clock',
  ],
  builds: ['memory', 'cpu'],
  recap: {
    keep: [
      'A store replicates the byte (or half) into every lane and raises byte enables only for the addressed bytes: <code>sb</code> to address 2 → be = 0100, <code>sh</code> to address 2 → 1100.',
      'The data memory is four 8-bit banks, each written when we ∧ be<sub>i</sub>; a read returns the whole word.',
      'A load picks the lane with a 4:1 (byte) or 2:1 (half) mux, then sign- or zero-extends by wiring alone: the cost is all in the multiplexers.',
      'A halfword at an odd address or a word off a 4-byte boundary is misaligned. RISC-V lets an implementation handle it in hardware or <span data-ahead="traps">trap (jump to a software handler, chapter 20)</span>; the complete CPU traps.',
      `Addresses with bit 31 set go to the I/O unit: a store to 0x8000_0000 prints a byte, 0x8000_0004 sets the LEDs, a load from 0x8000_0008 reads the switches. The whole machine is about ${kNands(sysNands(false).core)} NANDs without its program ROM.`,
      'An I/O register takes the whole word (a sub-word store is replicated into it), a store can be the action itself, and a read can have a side effect: I/O is never cached or reordered. Polling a clock register quantises time to the loop that reads it.',
    ],
    practise: ['c_computer'],
    check: [
      {
        question: '<code>sh</code> writes to address 6. Which byte enables are raised (be<sub>3</sub>…be<sub>0</sub>)?',
        options: ['1100', '0011', '0110', 'None: the address is misaligned'],
        answer: 0,
        explain: 'Address 6 is word 1, byte offset 2: the half goes to lanes 2 and 3. The low two address bits pick the lanes, the rest pick the word.',
        why: ['', 'That would be address 4: bytes 0–1 of the word.', 'Bytes 1–2 would need an odd address, which is misaligned for a halfword.', 'A halfword is aligned at any even address, and 6 is even.'],
      },
      {
        question: 'Which of these accesses is misaligned?',
        options: ['<code>lw</code> from address 6', '<code>lh</code> from address 6', '<code>lb</code> from address 7', '<code>sw</code> to address 8'],
        answer: 0,
        explain: 'An aligned word sits on a 4-byte boundary; address 6 spans two words. RISC-V lets a core either split such an access in hardware or <span data-ahead="traps">trap (jump to a software handler)</span>; the complete CPU raises a misaligned-load exception (chapter 20).',
        why: ['', 'A halfword needs only an even address.', 'A byte can sit at any address.', '8 is a multiple of 4.'],
      },
      {
        question: 'How does the CPU print to the console without a print instruction?',
        options: ['A store to an address with bit 31 set goes to the I/O unit, which sends the byte to the console', 'funct3 of <code>sb</code> selects a console mode', 'The console reads the data memory every cycle', 'Only an <code>ecall</code> can print'],
        answer: 0,
        explain: 'Memory-mapped I/O: the address decides where a store goes. Devices get addresses, and ordinary loads and stores talk to them.',
        why: ['', 'funct3 only gives the access size and sign; the address decides where the store goes.', 'Nothing watches the data memory: the store never reaches it, the I/O unit takes it instead.', 'An ecall hands control to a software handler (chapter 20), and that handler still prints with a store to the console address.'],
      },
    ],
  },
  steps: [
    {
      title: 'Storing a byte',
      body: `
        <p>So far the data memory moved whole words. RISC-V also has <code>sb</code>/<code>sh</code> and
        <code>lb</code>/<code>lh</code>/<code>lbu</code>/<code>lhu</code>. A 32-bit memory can still do it.</p>
        <p>For a store, the <strong>store alignment</strong> unit <span data-show="r8 r16">replicates the byte (or half)</span> into every lane it could go to,
        and raises <strong><span data-show="dec bsel">byte enables</span></strong> only for the addressed bytes: <code>sb</code> to address 2 enables byte 2, <code>sh</code>
        to address 2 enables bytes 2–3. A halfword at an odd address, or a word not on a 4-byte boundary, is
        <span data-show="mis"><em>misaligned</em></span>. RISC-V lets an implementation either handle a misaligned access (two memory accesses stitched together) or
        <span data-ahead="traps">trap (stop and jump to a handler routine in software; chapter ${numOf('traps')})</span> and leave it to software; the complete CPU traps.</p>
        <p>Replication is the cheap part of the idea: instead of steering the byte to the right lane, put it on all four and let the enables decide which lane listens. The data path is then four copies of the same wires, and the byte never has to reach a chosen lane. The only data multiplexer picks by size alone (byte copies, half copies or the word), not by address; it is most of the unit's cost. The enables are a small
        decoder of the low two address bits and the size: ${nd(STORE_ALIGN)} NANDs for the whole unit. It also produces <em>misaligned</em>, which the CPU turns into a trap.</p>
        <div class="try">Set size = 0 (byte) and step addr through 0–3: one enable bit moves across.</div>`,
      scene: () => ({ root: STORE_ALIGN, inputs: { wd: 0xab, addr: 2, size: 0 } }),
      tries: [(st) => st.getInput('size') === 0 && st.getInput('addr') !== 2],
      tour: {
        beats: [
          { title: 'sb to address 2', show: ['r8', 'dec'], expect: { be: 4, wdata: 0xabababab, misaligned: 0 },
            say: '<p>The byte 0xAB is copied into all four lanes (wdata = {b:wdata}), and only the enable for byte 2 is raised: be = {b:be}.</p>' },
          { title: 'Another byte', set: { addr: 3 }, show: ['dec'], expect: { be: 8 },
            say: '<p>Address 3: the same data, a different enable. be = {b:be}. The data never moved.</p>' },
          { title: 'sh to address 2', set: { size: 1, addr: 2 }, show: ['r16', 'dec'], expect: { be: 12, wdata: 0x00ab00ab },
            say: '<p>A halfword is copied into both halves (wdata = {b:wdata}), and two enables are raised, for bytes 2 and 3: be = {b:be}.</p>' },
          { title: 'A misaligned half', set: { addr: 1 }, show: ['mis'], expect: { misaligned: 1 },
            say: '<p>A halfword at an odd address is misaligned (at offset 3 it would even straddle two words). misaligned = {v:misaligned}: the complete CPU turns that into an <span data-ahead="traps">exception (a jump to a handler routine, chapter 20)</span> rather than store anything.</p>' },
          { title: 'sw', set: { size: 2, addr: 0 }, show: ['dec'], expect: { be: 15, wdata: 0xab, misaligned: 0 },
            say: '<p>A word writes all four lanes from the 32-bit data: be = {b:be}, and no replication is needed (wd is 0xAB here, so the word is 0x000000AB).</p>' },
        ],
      },
      more: {
        derive: `<p>With o the low two address bits: a byte store enables lane o; a halfword store enables lanes 2·o[1] and 2·o[1] + 1 (misaligned if o[0] = 1); a word store enables all four (misaligned if o ≠ 0). The table of enables, most significant lane first:
          byte ${[0, 1, 2, 3].map((o) => `${o}: ${bin4(enables(0, o))}`).join(', ')}; half ${[0, 2].map((o) => `${o}: ${bin4(enables(1, o))}`).join(', ')}; word ${bin4(enables(2, 0))}.</p>`,
        pitfall: `<p>Writing the data into lane 0 only. With be = 0100 and the byte only in lane 0, lane 2 stores whatever its lane of the bus carries (often 0), not the byte. If a byte store puts the wrong value in memory, look at wdata first: all four lanes must show the byte.</p>`,
        real: `<p>SRAM macros expose exactly these byte write masks, and DRAM modules a data mask line per byte. A cache (chapter ${numOf('cache')}) that did not have them would have to read a line, modify it and write it back for every <code>sb</code>.</p>`,
      },
    },
    {
      title: 'Four byte-wide banks',
      body: `
        <p>The data memory becomes <span data-show="b0 b1 b2 b3">four 8-bit memories</span> side by side, one per byte lane, each with its own write enable
        (<span data-show="w0 w1 w2 w3">we AND be<sub>i</sub></span>). Real SRAM macros do exactly this: per-byte write masks.</p>
        <p>Reads always return the whole word.</p>
        <p>Splitting the memory by lane is what makes a partial write possible at all. A single 32-bit memory would have to read the word, replace one byte and write it back (two accesses), or take a mask. Four 8-bit memories take the mask for free: each bank is
        written when we ∧ be<sub>i</sub> and otherwise keeps its byte. This memory is ${nd(bankedMemory(2))} NANDs for 4 words; the write enables cost an AND per bank, nothing against the storage.</p>`,
      scene: () => ({ root: bankedMemory(2), inputs: { addr: 4, wdata: 0x11223344, be: 0b0100, we: 1, clk: 0 } }),
      tour: {
        beats: [
          { title: 'Four banks', reset: true, show: ['b0', 'b1', 'b2', 'b3'], expect: { rdata: 0 },
            say: '<p>Four 8-bit memories, one per byte lane, all empty: rdata = {v:rdata}. The word 0x11223344 is on wdata and we is high.</p>' },
          { title: 'Only byte 2', cycles: 1, show: ['b2', 'w2'], expect: { rdata: 0x00220000 },
            say: '<p>be = 0100: only bank 2 sees its write enable. After the edge the word reads {v:rdata} (0x00220000): byte 2 of wdata, 0x22, in lane 2; the others still empty.</p>' },
          { title: 'Bytes 0 and 1', set: { be: 3 }, cycles: 1, show: ['b0', 'b1', 'w0', 'w1'], expect: { rdata: 0x00223344 },
            say: '<p>be = 0011: banks 0 and 1 write. The word is now {v:rdata} (0x00223344), and byte 2 survived: a partial write leaves the other lanes alone.</p>' },
          { title: 'Byte 3 completes it', set: { be: 8 }, cycles: 1, show: ['b3', 'w3'], expect: { rdata: 0x11223344 },
            say: '<p>be = 1000: the last lane. rdata = {v:rdata}, the whole word, assembled byte by byte.</p>' },
        ],
      },
      more: {
        derive: `<p>Bank i stores bits 8i + 7 … 8i of each word and is written when we ∧ be<sub>i</sub>, so a store with enables e leaves the word w' = (w ∧ ¬m(e)) ∨ (wdata ∧ m(e)), where m(e) expands each enable bit to a byte mask. That is the whole semantics of <code>sb</code> and <code>sh</code> at the memory.</p>`,
        pitfall: `<p>Raising we without the byte enables. A bank writes only when both are 1, so a store with we = 1 and be = 0000 changes nothing, and a word store must drive be = 1111. A store that seems to vanish is usually an enable that stayed 0.</p>`,
        real: `<p>Byte-writable SRAM macros and DDR's data mask pins work like this; ECC memories complicate it, because a partial write must update check bits over the whole word.</p>`,
      },
    },
    {
      title: 'Loading a byte',
      body: `
        <p>The <strong>load extraction</strong> unit picks the addressed byte (<span data-show="bsel">a 4:1 mux of lanes</span>)
        or half (<span data-show="hsel">2:1</span>), then <span data-show="fsel">funct3 chooses</span>
        sign extension (<span data-show="sb sh"><code>lb</code>, <code>lh</code>: copy the top bit</span>) or zero extension
        (<span data-show="zb zh"><code>lbu</code>, <code>lhu</code></span>).
        Both extensions are pure wiring, so the cost is all in the multiplexers.</p>
        <p>Little-endian puts byte 0 in the low bits of the word, so the byte at offset o is bits 8o + 7 … 8o, and a halfword at offset 2 is the top half. The unit is ${nd(LOAD_EXTRACT)} NANDs. Compare the store side: stores replicate and steer by enables, loads select and extend. The asymmetry is
        why a store's multiplexer looks only at the size, while a load needs two levels, chosen by the address.</p>`,
      scene: () => ({ root: LOAD_EXTRACT, inputs: { rdata: 0x12ab5678, addr: 2, funct3: 0 } }),
      tour: {
        beats: [
          { title: 'lb: byte 2, sign-extended', show: ['bsel', 'sb'], expect: { value: 0xffffffab },
            say: '<p>The word is 0x12AB5678. Byte 2 is 0xAB. <code>lb</code> copies its top bit through bits 31:8: value = {v:value} (0xFFFFFFAB, −85).</p>' },
          { title: 'lbu: zero-extended', set: { funct3: 4 }, show: ['zb'], expect: { value: 0xab },
            say: '<p>funct3 = 4 (<code>lbu</code>): the same byte with zeros above it, value = {v:value}.</p>' },
          { title: 'lh: half at offset 2', set: { funct3: 1 }, show: ['hsel', 'sh'], expect: { value: 0x12ab },
            say: '<p>funct3 = 1 (<code>lh</code>): the top half, 0x12AB. Its top bit is 0, so sign extension gives value = {v:value}, the same as zero extension would.</p>' },
          { title: 'A negative half', set: { rdata: 0x92ab5678 }, show: ['sh'], expect: { value: 0xffff92ab },
            say: '<p>With 0x92AB in the top half, <code>lh</code> now extends a 1: value = {v:value} (0xFFFF92AB).</p>' },
          { title: 'lhu', set: { funct3: 5 }, show: ['zh'], expect: { value: 0x92ab },
            say: '<p>funct3 = 5 (<code>lhu</code>): zero-extended, value = {v:value}. The same load, two meanings: which one the programmer wants is part of the instruction.</p>' },
        ],
      },
      more: {
        derive: `<p>funct3[1:0] gives the size (00 byte, 01 half, 10 word) and funct3[2] the unsigned flag. For a byte at offset o: value = {24 copies of (¬u ∧ the byte\'s top bit), the byte}; for a half at offset 0 or 2: {16 copies of (¬u ∧ the half\'s top bit), the half}. The replicated bit is one wire fanned out, which costs only its fan-out load.</p>`,
        pitfall: `<p>Getting the byte order backwards. In a little-endian machine the byte at address 2 of 0x12AB5678 is 0xAB, not 0x56: the least significant byte, 0x78, is at address 0. A quick check on the circuit: with addr = 0 the unit must return 0x78.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Memory holds 0x12AB5678 at address 0. What does lb x5, 2(x0) load?',
        options: ['0x000000AB', '0xFFFFFFAB', '0x00000056', '0xFFFFFF56'], answer: 1,
        why: ['That is lbu. lb copies the byte\'s top bit, and 0xAB has it set.', '', 'Little-endian puts the least significant byte, 0x78, at address 0: 0x56 is byte 1, not byte 2.', '0x56 is byte 1, and its top bit is 0: even sign-extended it would stay 0x00000056.'],
        explain: 'Little-endian: byte 2 is 0xAB. lb sign-extends, and 0xAB has its top bit set, so the result is 0xFFFFFFAB (−85). lbu would give 0x000000AB.',
      },
    },
    {
      title: 'The complete machine',
      body: `
        <p>This is the full processor: the single-cycle datapath plus the <span data-show="st ld">load/store unit</span> and
        <span data-show="dm">byte-banked memory</span>, an <strong><span data-show="io">I/O unit</span></strong>, and (next chapter)
        <span data-show="csr trap">CSRs, a trap unit</span> and <span data-ahead="interrupts">interrupts (a device or timer asking the CPU to stop what it is doing and run a handler)</span>. Every RV32I instruction plus Zicsr, about
        ${kNands(sysNands(false).core)} NAND gates without the program ROM (${kNands(sysNands(false).all)} with it), and still checked against the instruction-set simulator every cycle.</p>
        <p>Addresses with bit 31 set go to <strong>memory-mapped I/O</strong> instead of the data memory. A store to
        0x8000_0000 is not a store at all: the I/O unit sends the byte to the <span data-show="pin:consoleData">console</span>. That is how most processors talk to
        the outside world, from UARTs to GPUs; x86 also keeps a separate 64 K I/O port space with its own <code>in</code> / <code>out</code> instructions,
        now used mostly by legacy devices.</p>
        <p>The machine does not know it is printing. The I/O unit watches the address of every access: with bit 31 set, a store goes to a device register instead of the memory, and a load comes from one. The console register is write-only and always ready; a real UART adds a status register that the
        program polls before each store.</p>
        <div class="try">Run the program. The console fills one <code>sb</code> at a time.</div>`,
      scene: () => cpuScene({ source: sys('hello'), system: true }),
      tour: {
        beats: [
          { title: 'Set up the console address', reset: true, cycles: 1, show: ['io'], expect: { pcOut: 4, consoleValid: 0 },
            say: '<p>The first instruction, <code>li a0, 0x80000000</code>, is a single <code>lui</code>: a0 now holds the console\'s address. Nothing has been printed (consoleValid = {v:consoleValid}).</p>' },
          { title: 'The first store', cycles: 1, show: ['io', 'st'], expect: { pcOut: 8, consoleValid: 1, consoleData: 72 },
            say: '<p>After <code>li t0, \'H\'</code>, <code>sb t0, 0(a0)</code> is at pc = {v:pcOut}. Its address has bit 31 set, so the I/O unit takes it: consoleValid = {v:consoleValid}, consoleData = {v:consoleData}, the code for H. The byte is printed at the coming edge.</p>' },
          { title: 'Nothing while loading', cycles: 1, expect: { pcOut: 12, consoleValid: 0 },
            say: '<p>The next instruction loads the next letter into t0. It is not a store, so consoleValid drops to {v:consoleValid}: the console only sees stores.</p>' },
          { title: 'Next letter', cycles: 1, expect: { pcOut: 16, consoleValid: 1, consoleData: 101 },
            say: '<p>Another <code>sb</code>, now with {v:consoleData}, the code for e. Two instructions per character.</p>' },
          { title: 'A repeated letter', cycles: 3, expect: { pcOut: 28, consoleValid: 1, consoleData: 108 },
            say: '<p>The two l\'s are stored by two <code>sb</code> in a row, with no <code>li</code> between them: t0 already holds 108. The second store is at pc = {v:pcOut}, with consoleData = {v:consoleData} again.</p>' },
        ],
      },
      more: {
        derive: `<p>The CPU decodes <em>io</em> = addr[31] and gates the memory write with it; the I/O unit then selects a register by addr[4:2]: 0 the console strobe (the low byte as data), 1 the LEDs, 2 the switches (a load), 4 mtime, 5 mtimecmp. The data memory sees the access only when io is clear. The program has ${(sys('hello').match(/\bsb\b/g) ?? []).length} stores and ${(sys('hello').match(/\bli\b/g) ?? []).length} <code>li</code> (one is the console address); a letter that repeats needs no new <code>li</code>.</p>`,
        pitfall: `<p>Treating the console like memory. A load from the console address does not return what was stored: the store went to a device, not to a cell. The same applies to any register of a real device, which is why C marks such pointers <code>volatile</code>: the compiler must not assume a second read returns the first value, or that two stores can be merged.</p>`,
        real: `<p>The 16550 UART (behind x86 I/O ports on a PC, memory-mapped on many other boards) and the PL011 on Arm boards each have a status register for "transmitter ready" that this console omits. Memory-mapped I/O needs no extra instructions, but accesses to a device must not be cached or reordered, which is why real cores mark address ranges as device memory.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Run the program until the console shows the whole greeting.',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x.length > 0 && st.cycles >= 31 : false; } catch { return false; } },
        hints: [
          'Nothing prints until a store reaches 0x8000_0000, so the clock has to run.',
          'Each character costs a store, and a new letter also a load-immediate: count the characters in the greeting.',
        ],
        answer: `Press "Run to halt" (or Pulse ~31 times): ${(sys('hello').match(/\bsb\b/g) ?? []).length} characters, as many stores, and ${(sys('hello').match(/\bli\b/g) ?? []).length} load-immediates (one is the console address; the second l reuses its register), then the halt loop.`,
        solve: (st) => { st.runCycles(40); },
      },
    },
    {
      title: 'Switches in, LEDs out',
      body: `
        <p>Inputs work the same way: a load from 0x8000_0008 returns the <span data-show="pin:switches">switches</span>, a
        store to 0x8000_0004 latches the <span data-show="pin:leds">LEDs</span>. The <span data-show="io">I/O unit</span>
        decodes both. This program copies one to the other in a loop.</p>
        <p>Input and output differ only in direction: a store drives the LED register, a load samples the switch pins. The switches are not stored anywhere; a load reads their level at that moment. A program that wants to react to a change has to read repeatedly, which is polling, and the loop here
        does that continuously.</p>
        <div class="try">Let the clock run (or press Run), then flip switches in the I/O panel.</div>`,
      scene: () => cpuScene({ source: sys('leds'), system: true }),
      tour: {
        beats: [
          { title: 'Switches at 0x5A', reset: true, set: { switches: 0x5a }, cycles: 3, show: ['io'], expect: { leds: 0x5a, pcOut: 12 },
            say: '<p>With the switches at 0x5A, one pass of the loop (<code>lw</code>, then <code>sw</code>) has copied them to the LEDs: leds = {v:leds} ({b:leds}).</p>' },
          { title: 'Flip them', set: { switches: 0xa5 }, cycles: 1, show: ['io'], expect: { leds: 0x5a },
            say: '<p>The switches are now 0xA5, but the LEDs still show {v:leds}: the program has not read the switches again yet. Nothing links the two except the loop.</p>' },
          { title: 'The loop catches up', cycles: 2, show: ['io'], expect: { leds: 0xa5, pcOut: 12 },
            say: '<p>One more pass and the LEDs follow: leds = {v:leds}. The response time is 2 to 4 cycles here, depending on where the loop was.</p>' },
        ],
      },
      more: {
        derive: `<p>The loop is three instructions (<code>lw</code>, <code>sw</code>, <code>j</code>), so the LEDs follow the switches in 2 to 4 cycles: a flip just before the <code>lw</code> shows two cycles later, one just after it waits for the next pass, then for its <code>sw</code>. At the scene's 2 Hz clock that is visible; at a hardware clock of tens of MHz it is not.</p>`,
        pitfall: `<p>Expecting an input to be latched. If the switches change and change back between two loads, the program never sees it. Real devices that must not miss events latch them in a status register, or raise an interrupt (the next chapter).</p>`,
      },
      tries: [(st) => st.value('leds') > 0],
    },
    ...IO_MORE,
  ],
};

export const chTraps: Chapter = {
  id: 'traps', num: numOf('traps'), title: 'Traps and interrupts', level: 'Privileged ISA',
  blurb: 'CSRs, exceptions, ecall, timer and external interrupts: how hardware hands control to software.',
  goals: [
    'read and write CSRs with csrrw, csrrs and csrrc, and name the machine-mode registers a trap uses',
    'list what the hardware does on a trap and on mret, register by register',
    'tell a pending interrupt from a taken one: mip, mie and mstatus.MIE',
    'order the trap causes by priority and give each its mcause',
    'weigh polling against interrupts by cycles and latency, and nest, vector and latch interrupts',
  ],
  builds: ['cpu', 'io'],
  recap: {
    keep: [
      'CSRs: a separate space of 12-bit addresses, accessed with <code>csrrw</code> (swap), <code>csrrs</code> (set bits), <code>csrrc</code> (clear bits) and their immediate forms. This CPU has sixteen, one address comparator each.',
      'A trap: PC ← mtvec, mepc ← the address of the trapping instruction, mcause ← the reason, MPIE ← MIE, MIE ← 0. <code>mret</code> jumps to mepc and restores MIE. mtvec\'s low two bits are its MODE: 0 direct (every trap to BASE), 1 vectored (interrupt <em>n</em> to BASE + 4<em>n</em>); here MODE is wired to 0.',
      'mcause: 2 illegal instruction, 3 breakpoint, 4 misaligned load, 6 misaligned store, 11 ecall; interrupts set bit 31 (0x80000007 timer, 0x8000000B external). A trapping instruction writes nothing.',
      'An interrupt is pending in mip while its source holds, and taken at the next instruction boundary only if enabled in mie and globally by mstatus.MIE.',
      `Priority: interrupts (external, then timer), then illegal instruction, ebreak, ecall, misaligned fetch, load, store. CSR unit, trap unit and system decoder: about ${kNands(TRAP_NANDS)} NANDs.`,
      'The hardware saves only the PC and the cause: a handler saves every register it uses (mscratch gives it a register to swap with sp), nests only by saving mepc and mcause and setting MIE again, and an idle loop waits in <code>wfi</code>. Machine mode is the only mode here; with a lower mode, mstatus.MPP says where a trap came from and ecall\'s cause is 8 from U, 11 from M.',
      `Polling spends cycles on looks and reacts at its next look; an interrupt spends a trap, a handler and an mret per event and reacts at the next instruction boundary. Measured here the crossing is at one event per ${crossover(6)} cycles with 6 instructions of work between polls.`,
      'A bare interrupt line forgets a pulse that ends while MIE = 0; an interrupt controller holds a pending bit per source until it is claimed, offers the highest enabled one, and clears it on the claim. Vectored mtvec sends interrupt <em>n</em> to BASE + 4<em>n</em> with five ANDs and four ORs.',
    ],
    practise: ['y_csr', 'y_trap', 'y_irq', 'p_handler', 'y_ptrap', 'y_final'],    check: [
      {
        question: 'An <code>ecall</code> traps to a handler. What must the handler do before <code>mret</code> so that the program continues after the ecall?',
        options: ['Add 4 to mepc', 'Nothing: mepc already points past the ecall', 'Set MIE', 'Clear mcause'],
        answer: 0,
        explain: 'mepc holds the address of the trapping instruction itself, so a fault can be fixed and retried. For an ecall that would call the OS again forever.',
        why: ['', 'mepc points at the ecall itself; returning there would trap again.', 'mret restores MIE from MPIE by itself.', 'mcause is only read by the handler; mret does not look at it.'],
      },
      {
        question: 'In the same cycle a timer interrupt is pending and enabled, and the instruction at the PC is illegal. What does mcause hold in the handler?',
        options: ['0x80000007: interrupts come first', '2: the illegal instruction', 'Both causes, ORed', '11'],
        answer: 0,
        explain: 'The trap unit\'s chain puts interrupts ahead of every exception. mepc points at the illegal instruction, which has not run: after mret it executes and traps with cause 2.',
        why: ['', 'The illegal instruction has not executed yet. The chain of muxes picks the interrupt, and the illegal instruction traps later, when it runs.', 'mcause holds one cause: the chain picks the highest-priority source.', '11 is ecall.'],
      },
      {
        question: 'Which registers does the hardware write on a trap, all in the same cycle?',
        options: ['PC, mepc, mcause, mtval and mstatus (MIE, MPIE)', 'Only the PC', 'PC and ra, like jal', 'All 32 registers, saved to memory'],
        answer: 0,
        explain: 'Everything the handler needs to know where and why, and nothing the interrupted program owns.',
        why: ['', 'Without mepc and mcause the handler could neither return nor know why it was called.', 'A trap must not touch any general register: the interrupted program may be using ra.', 'Saving registers is the handler\'s job, in software; the hardware saves only the PC and the cause.'],
      },
      {
        question: 'The timer and the external interrupt are both pending and both enabled, with MIE = 1. What does mcause hold in the handler?',
        options: ['0x8000000B: external interrupts outrank the timer', '0x80000007: the timer, its cause number is lower', 'Whichever became pending first', 'Both bits, ORed into one cause'],
        answer: 0,
        explain: 'The privileged spec fixes the order among machine interrupts: external (11), then software (3), then timer (7). The CSR unit here picks external over timer; the timer stays pending in mip and is taken right after the handler\'s mret, unless the handler moved mtimecmp.',
        why: ['', 'Priority is not the cause number: the spec puts external interrupts first, since a device cannot wait as long as a tick can.', 'The hardware keeps no arrival order: it looks at what is pending at the instruction boundary and picks by fixed priority.', 'mcause holds one cause; the other interrupt stays pending in mip.'],
      },
    ],
  },
  steps: [
    {
      title: 'Control and status registers',
      reading: {
        source: 'RISC-V Privileged ISA (current AsciiDoc, riscv-isa-manual)', section: 'Machine-Level ISA: Machine Trap-Vector Base-Address (mtvec) Register; Machine Exception Program Counter (mepc) Register; Privilege and Global Interrupt-Enable Stack in mstatus',
        quote: [
          'The mtvec register is an MXLEN-bit WARL read/write register that holds trap vector configuration, consisting of a vector base address (BASE) and a vector mode (MODE).',
          'When a trap is taken into M-mode, mepc is written with the virtual address of the instruction that was interrupted or that encountered the exception.',
          'When a trap is taken from privilege mode y into privilege mode x, xPIE is set to the value of xIE; xIE is set to 0; and xPP is set to y.'],
        note: 'The CSR unit you opened holds mtvec and mepc as registers; the trap unit writes mepc and mcause itself at the edge, and the mstatus bits are the interrupt-enable stack.',
        quizzes: [
          { question: 'An illegal instruction sits at address 0x10 and traps. What does mepc hold?', options: ['0x10', '0x14', 'The instruction word', 'The handler\'s address'], answer: 0,
          why: ['', 'That would skip the instruction. The hardware saves the faulting one, so a handler can fix and retry it.', 'mtval may get the word on an illegal instruction (here it gets 0); mepc never does.', 'That is mtvec\'s BASE.'],
          explain: 'mepc is the address of the instruction that encountered the exception. For ecall, software adds 4 before mret; the hardware never does.' },
          { question: 'A trap is taken with MIE = 1 and MPIE = 0. After it, MIE and MPIE are:', options: ['MIE = 0, MPIE = 1', 'MIE = 1, MPIE = 0', 'MIE = 0, MPIE = 0', 'MIE = 1, MPIE = 1'], answer: 0,
          why: ['', 'Nothing changed, but the rule says interrupts are disabled on entry.', 'MPIE takes the old MIE, which was 1.', 'MIE is cleared on entry.'],
          explain: 'MPIE ← MIE, MIE ← 0: the handler runs with interrupts off and mret restores MIE from MPIE. That is the one-level stack in the quote.' },
          { question: 'This core wires mtvec\'s MODE bits to 0. A handler address of 0x83 is written. What does a read give?', options: ['0x83', '0x80', '0x84', '0x00'], answer: 1,
          why: ['The low two bits are MODE and read as 0 here.', '', 'Nothing rounds up.', 'Only the low two bits are lost.'],
          explain: 'BASE is a multiple of 4: the two MODE bits are not part of the address, so 0x83 reads back as 0x80. Align handlers to 4 bytes.' },
        ],
      },
      body: `
        <p>So far the CPU runs one program that never stops to ask anything. A real computer needs three ways out of it. An instruction that cannot run (an
        undefined word, a misaligned load) must stop somewhere sensible instead of doing something undefined. A program must be able to ask a more privileged
        one, the operating system, to do work for it. And a device must be able to say "now", so the program does not have to keep reading
        <a href="#/c/io/0">chapter ${numOf('io')}</a>'s switches in a loop to notice that one flipped. All three are one mechanism, a <strong>trap</strong>: the hardware
        saves where it was and why, and jumps to a handler written in software. That takes a few registers of its own, which is where this chapter starts.</p>
        <p>A second, separate register space: <strong>CSRs</strong>, addressed by a 12-bit number and accessed only with
        <code>csrrw</code> (swap), <code>csrrs</code> (set bits) and <code>csrrc</code> (clear bits), plus immediate forms. This CPU implements a
        working subset of machine mode: mstatus, misa, mie, mtvec, mscratch, mepc, mcause, mtval, mip, mcycle/cycle and mhartid, plus the identity
        registers every core must have (mvendorid, marchid, mimpid) and RV32's upper half of mstatus (mstatush), which read 0. Left out: minstret,
        the counters' upper halves (mcycleh …) and 64 bits of time; here mcycle reads the 32-bit timer mtime.</p>
        <p>Open the CSR unit: sixteen <span data-show="is_mstatus is_mtvec is_mepc is_mcause">address comparators</span>, a
        <span data-show="rsel">read multiplexer</span>, the <span data-show="orOld andOld opSel">read-modify-write logic</span>,
        and the <span data-show="rTvec rEpc rCause rTval">registers</span>, some of them written by hardware on a trap.</p>
        <p>A CSR instruction reads and writes in one indivisible step: the old value goes to rd, and the new one, formed from the old value and rs1 (or a 5-bit immediate), goes back. The three operations differ only in how the new value is formed: swap, OR, AND-NOT. The unit costs ${nd(CSR_UNIT)} NANDs.</p>`,
      scene: () => ({ root: CSR_UNIT, inputs: { addr: 0x305, funct3: 1, rs1v: 0x40, csrWrite: 1, clk: 0 } }),
      tour: {
        beats: [
          { title: 'Select mtvec', reset: true, show: ['is_mtvec', 'rsel'], expect: { rdata: 0, mtvecOut: 0 },
            say: '<p>addr = 0x305 is mtvec, the trap vector. Its comparator fires and the read multiplexer selects it: rdata = {v:rdata}, the power-on value.</p>' },
          { title: 'csrrw: swap', cycles: 1, show: ['rTvec', 'opSel'], expect: { rdata: 0x40, mtvecOut: 0x40 },
            say: '<p>funct3 = 1 (<code>csrrw</code>) with rs1 = 0x40: the register takes rs1 at the edge. mtvec = {v:mtvecOut}, and the read now shows the new value, {v:rdata}.</p>' },
          { title: 'csrrs: set bits', set: { funct3: 2, rs1v: 0x80 }, cycles: 1, show: ['orOld'], expect: { mtvecOut: 0xc0 },
            say: '<p>funct3 = 2 (<code>csrrs</code>) with rs1 = 0x80: the new value is old OR rs1 = 0x40 | 0x80 = {v:mtvecOut}. Bits set in rs1 are set; the others keep their value.</p>' },
          { title: 'csrrc: clear bits', set: { funct3: 3, rs1v: 0x40 }, cycles: 1, show: ['andOld'], expect: { mtvecOut: 0x80 },
            say: '<p>funct3 = 3 (<code>csrrc</code>) with rs1 = 0x40: old AND NOT rs1 clears that bit: mtvec = {v:mtvecOut}.</p>' },
          { title: 'Read mstatus', set: { addr: 0x300, csrWrite: 0 }, show: ['rsel'], expect: { rdata: 0x1800, mtvecOut: 0x80 },
            say: '<p>With csrWrite = 0 nothing is written. Address 0x300 is mstatus: rdata = {v:rdata} (0x1800), the MPP field set to machine mode. mtvec is unchanged, {v:mtvecOut}.</p>' },
          { title: 'A trap writes mepc', set: { addr: 0x341, trap: 1, trapPC: 0x100, trapCause: 11 }, cycles: 1, show: ['rEpc', 'rCause'], expect: { mepcOut: 0x100, rdata: 0x100 },
            say: '<p>With trap = 1 the hardware writes mepc and mcause in the same edge, without any CSR instruction: mepc = {v:mepcOut}, and reading 0x341 returns it, {v:rdata}.</p>' },
        ],
      },
      more: {
        derive: `<p>Let old be the CSR and s the source (rs1, or zimm). csrrw: new = s. csrrs: new = old ∨ s. csrrc: new = old ∧ ¬s. rd always receives old. The specification says csrrs and csrrc do not write when s is zero (rs1 = x0 or zimm = 0), so reading a read-only CSR never traps:
          <code>csrr rd, csr</code> is <code>csrrs rd, csr, x0</code>. The unit computes all three and selects by funct3[1:0], with the immediate forms choosing zimm over rs1 by funct3[2].</p>`,
        pitfall: `<p>Writing mtvec's low two bits. They are its MODE field; here they are wired to 0, so a base address written with them set reads back with them clear (above: 0x40 | 0x80 | 0x03 would still read 0xC0). A handler address must be 4-byte aligned for that reason.</p>`,
        real: `<p>CSR numbers carry meaning in their bits: the top two give read/write or read-only, the next two the lowest privilege that may access the register (0x300 is machine-mode read/write). Real cores have hundreds of CSRs and decode them in the same way, one comparator or a ROM-like table per register.</p>`,
      },
    },
    {
      title: 'ecall: asking the operating system',
      body: `
        <p>A <strong>trap</strong> is a forced, hardware-performed jump (<span data-show="trap">the trap unit</span> decides):
        the PC goes to <code>mtvec</code> through the <span data-show="trapmux">trap / mret multiplexer</span>, the address of the
        interrupted instruction is saved in <code>mepc</code>, the reason in <code>mcause</code> (both in the
        <span data-show="csr">CSR unit</span>), and interrupts are disabled
        (mstatus's global interrupt-enable bit MIE is saved in MPIE, then cleared). The handler ends with <code>mret</code>, which jumps back to <code>mepc</code> and restores MIE.
        mtvec's low two bits are its MODE: 0 <em>direct</em> sends every trap to the same address, 1 <em>vectored</em> sends interrupt <em>n</em>
        to BASE + 4<em>n</em> (exceptions still to BASE), saving the handler the dispatch on mcause. Here the two bits are wired to 0: direct only.</p>
        <p><code>ecall</code> traps on purpose: it is how a program calls the operating system. Here a six-instruction "OS" prints the
        character in a0. Note the handler adds 4 to mepc so that <code>mret</code> returns <em>after</em> the ecall.</p>
        <p>Everything the hardware does on the trap happens at one clock edge: the PC is replaced, mepc and mcause are written, MIE is cleared, and the instruction that trapped is suppressed. No general register is touched, which is why the handler can start with a free hand only after it has saved
        what it will use.</p>
        <div class="try">Pulse to the ecall and watch mepc and mcause (11 = ecall) change in the I/O panel, and the PC jump to the handler.</div>`,
      scene: () => cpuScene({ source: sys('syscall'), system: true, highlight: ['trap', 'csr', 'trapmux'] }),
      tour: {
        beats: [
          { title: 'Before the ecall', reset: true, cycles: 4, show: ['trap', 'csr'], expect: { pcOut: 16 },
            say: '<p>The program has pointed mtvec at the handler (<code>la</code>, <code>csrw</code>) and loaded the character \'O\' into a0. pc = {v:pcOut}: the <code>ecall</code> is next.</p>' },
          { title: 'The trap', cycles: 1, show: ['trap', 'trapmux'], expect: { pcOut: 40 },
            say: '<p>One edge: pc = {v:pcOut}, the handler. The PC mux took mtvec; mepc now holds 16, the address of the ecall itself, and mcause holds 11.</p>' },
          { title: 'The handler prints', cycles: 1, show: ['io'], expect: { pcOut: 44, consoleValid: 1, consoleData: 79 },
            say: '<p>The handler\'s first instruction has loaded the console address into t1; now the <code>sb</code> at pc = {v:pcOut} stores a0 to the console: consoleData = {v:consoleData}, the code for O.</p>' },
          { title: 'mret', cycles: 5, show: ['trapmux', 'csr'], expect: { pcOut: 20 },
            say: '<p>The handler reads mepc, adds 4, writes it back and executes <code>mret</code>. The trap mux takes mepc: pc = {v:pcOut}, the instruction after the ecall. Without the <code>addi</code> it would return to the ecall and trap forever.</p>' },
        ],
      },
      more: {
        derive: `<p>The trap edge, in order of the registers written: mepc ← pc of the trapping instruction; mcause ← the cause; mtval ← the faulting value; mstatus.MPIE ← MIE and MIE ← 0; pc ← mtvec (BASE). <code>mret</code> reverses it: pc ← mepc, MIE ← MPIE, MPIE ← 1. That is six writes at one edge,
          which is why the hardware needs dedicated paths to those registers and cannot use the normal CSR write port alone.</p>`,
        real: `<p>This CPU has only machine mode (M), the one mode every RISC-V core must have, so the "OS" and the program share it. A real system runs
          programs in user mode (U), and an OS with virtual memory in supervisor mode (S). A trap goes to M (or, if delegated, S) and records the mode
          it came from in mstatus.MPP (2 bits: 0 U, 1 S, 3 M); <code>mret</code> returns to that mode. Hence three ecall causes: 8 from U, 9 from S,
          11 from M. In U, an access to a machine CSR or an <code>mret</code> is an illegal instruction, and PMP registers fence off memory: that is
          what stops a program from taking over the machine. Here MPP is wired to 3 and ecall's cause is always 11.</p>`,
        pitfall: `<p>Returning without moving mepc. For a fault that has been fixed, returning to the trapping instruction retries it, which is the point; for an ecall it traps again at once. The handler adds 4 because ecall is always four bytes, even with the C extension. A handler that skips other instructions (ebreak has a 2-byte form) must look at the instruction's length.</p>`,
      },
      tries: [(st) => { try { return csrq(st, 'rCause') === 11; } catch { return false; } }],
    },
    {
      title: 'Exceptions',
      body: `
        <p>The same mechanism catches errors. This program executes an <strong>illegal instruction</strong> (0xFFFFFFFF,
        caught by the <span data-show="sys">system decoder</span>), a
        <strong>misaligned load</strong> and an <code>ebreak</code>. Each traps to the handler, which logs mcause and mtval
        (the faulting address, for the misaligned load) into memory and skips the instruction.</p>
        <p>The <span data-show="trap">trap unit</span> is a priority chain of multiplexers: interrupts first, then illegal instruction, ebreak, ecall, misaligned
        fetch, load and store. A trapping instruction writes nothing: its register write, memory write and CSR write are all suppressed.</p>
        <p>What the handler learns is the pair (mcause, mtval): what happened and what it happened to. For a misaligned access the value is the address. For an illegal instruction the spec allows the instruction word or zero; this CPU writes zero, so the log's word 1 reads 0. The handler here only logs them. The same code serves all three faults, since only mcause differs.</p>`,
      scene: () => cpuScene({ source: sys('faults'), system: true, highlight: ['sys', 'trap'] }),
      tour: {
        beats: [
          { title: 'An illegal word', reset: true, cycles: 4, show: ['sys'], expect: { pcOut: 16 },
            say: '<p>After the set-up, pc = {v:pcOut}: the word 0xFFFFFFFF, which no instruction uses. The system decoder will flag it illegal.</p>' },
          { title: 'Trap', cycles: 1, show: ['sys', 'trap'], expect: { pcOut: 36 },
            say: '<p>Cause 2, illegal instruction: pc = {v:pcOut}, the handler. mepc holds 16, the instruction that did not run.</p>' },
          { title: 'Handler and return', cycles: 9, show: ['trap'], expect: { pcOut: 20 },
            say: '<p>Nine instructions log mcause and mtval, add 4 to mepc and return. pc = {v:pcOut}: the instruction after the illegal word.</p>' },
          { title: 'A misaligned load', cycles: 2, show: ['trap'], expect: { pcOut: 36 },
            say: '<p><code>lw t2, 1(t1)</code> reads address 3, not a multiple of 4. The load is suppressed and the CPU traps with cause 4: pc = {v:pcOut}, the same handler. mtval will hold the address, 3.</p>' },
        ],
      },
      more: {
        derive: `<p>With several causes at once the trap unit takes the highest in a fixed order, a chain of 2:1 multiplexers from the lowest priority (store misaligned, then load, fetch, ecall, ebreak, illegal) to the interrupt stage, which the CSR unit has already chosen between external and timer. Each stage picks its own cause and tval if its condition holds, else passes the previous
          result on. The chain is ${nd(TRAP_UNIT)} NANDs.</p>`,
        pitfall: `<p>Assuming the faulting instruction partly ran. It did not: its register write, memory write and CSR write are all cancelled, so after <code>mret</code> past it the machine state is exactly as if it had been a NOP. A handler that wants to emulate the instruction must do the work in software.</p>`,
        real: `<p>Real cores add a precise-exception rule: the fault is reported for the oldest faulting instruction, with every older one completed and no younger one visible. In a pipeline that needs flushing; here, with one instruction in flight, it is automatic.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Run until all three exceptions have been logged (mcause values 2, 4 and 3 in memory).',
        check: (st) => { try { const m = st.sim ? cpuState(st.sim).dmem : []; return m[0] === 2 && m[2] === 4 && m[4] === 3; } catch { return false; } },
        hints: [
          'The handler logs each trap and skips the faulting instruction, so the program reaches its end by itself.',
          'Watch data-memory words 0, 2 and 4: each fills when its exception is handled. Keep the clock running until the third.',
        ],
        answer: 'Press "Run to halt". Memory words 0, 2 and 4 hold mcause 2 (illegal), 4 (misaligned load) and 3 (breakpoint); word 3 holds mtval = 3, the misaligned address.',
        solve: (st) => { st.runCycles(80); },
      },
    },
    {
      title: 'The timer interrupt',
      body: `
        <p>An <strong>interrupt</strong> is a trap caused by the outside world. The <span data-show="io">I/O unit</span> has a free-running counter
        <code>mtime</code> and a compare register <code>mtimecmp</code>; while mtime ≥ mtimecmp the timer interrupt is
        <em>pending</em> (mip.MTIP). It is <em>taken</em> at the next instruction boundary if it is enabled (mie.MTIE) and
        interrupts are globally on (mstatus.MIE): three bits in the <span data-show="csr">CSR unit</span>.</p>
        <p>The handler prints a dot and moves mtimecmp 40 cycles ahead. The main loop never knows it was interrupted, but only because this handler
        touches t1, t2 and s1, which the loop does not use. A real handler saves every register it uses first: it swaps sp with
        <code>mscratch</code> (<code>csrrw sp, mscratch, sp</code>), which the OS set to point at a save area, stores the registers there, and
        undoes it all before <code>mret</code>. That is the foundation of every multitasking operating system's time-slicing tick: save one
        program's registers, load another's.</p>
        <details class="deeper"><summary>Deeper: nested interrupts</summary>
        <p>The hardware does not nest: there is one mepc and one mcause, and the trap cleared MIE. A handler that must be interruptible saves them
        and sets MIE again; the step "Nested interrupts" does exactly that.</p></details>
        <p>The compare-and-interrupt arrangement is the same in every timer: a counter that always runs, a register the software sets to "wake me at this time", and a comparator. Because the handler sets the next compare value relative to the previous one, the ticks do not drift even if some handlers
        run late.</p>
        <div class="try">Let the clock run and watch the dots, mepc (where the loop was interrupted) and s1 (tick count).</div>
        ${tickWorked()}`,
      scene: () => cpuScene({ source: sys('timer'), system: true, highlight: ['io', 'csr'] }),
      tour: {
        beats: [
          { title: 'Set up and count', reset: true, cycles: 10, show: ['io', 'csr'], expect: { pcOut: 40, consoleValid: 0 },
            say: '<p>The set-up reads mtime, adds 40 and writes mtimecmp, enables the timer interrupt in mie and the global MIE. Then the loop at pc {v:pcOut} counts in s0.</p>' },
          { title: 'The interrupt is taken', cycles: 35, show: ['csr', 'trap'], expect: { pcOut: 48 },
            say: '<p>The counter mtime has reached mtimecmp: the timer interrupt is pending, enabled and globally enabled, so at the next instruction boundary the CPU traps. pc = {v:pcOut}, the handler; mepc holds the loop instruction that was interrupted.</p>' },
          { title: 'A dot', cycles: 1, show: ['io'], expect: { pcOut: 52, consoleValid: 1, consoleData: 46 },
            say: '<p>The handler stores \'.\' (consoleData = {v:consoleData}) to the console, moves mtimecmp 40 cycles ahead, counts the tick in s1 and returns.</p>' },
          { title: 'Back to the loop', cycles: 6, show: ['csr'], expect: { pcOut: 40 },
            say: '<p><code>mret</code> brings the loop back at pc {v:pcOut}, exactly where it was interrupted. The loop never knew; s0 is still counting.</p>' },
        ],
      },
      more: {
        derive: `<p>The timer line is mtip = (mtime ≥ mtimecmp). It is taken when mtip ∧ mie.MTIE ∧ mstatus.MIE, at an instruction boundary. After the handler writes mtimecmp ← mtimecmp + 40, mtip falls until 40 more cycles have passed, so a tick comes every 40 cycles. Each period includes the trap entry and the handler\'s 7 instructions: 8/40 = ${Math.round((8 / 40) * 100)} %.</p>`,
        pitfall: `<p>Forgetting to move mtimecmp. While mtime ≥ mtimecmp the interrupt stays pending, so <code>mret</code> would take it again immediately and the main program would never run. A level-triggered interrupt must be cleared at its source; this one is cleared by moving the compare value.</p>`,
        real: `<p>RISC-V\'s machine timer is exactly mtime and mtimecmp. Operating systems program it for the scheduler tick (typically 100 to 1000 per second) and, in tickless kernels, for the next event only.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Let the timer interrupt fire five times (s1 = 5).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x[9] >= 5 : false; } catch { return false; } },
        hints: [
          'Interrupts arrive only while the clock runs; the handler counts them in s1.',
          'The handler moves mtimecmp 40 cycles ahead each time: estimate how many cycles five ticks need.',
        ],
        answer: 'Run the clock for ~220 cycles: one interrupt every 40 cycles after the setup.',
        solve: (st) => { st.runCycles(240); },
      },
    },
    {
      title: 'External interrupts',
      body: `
        <p>The IRQ button drives the CPU's <span data-show="pin:irq">external interrupt line</span> (mip.MEIP, in the
        <span data-show="csr">CSR unit</span>; the <span data-show="trap">trap unit</span> takes it). The handler toggles the LEDs and counts presses.
        Because the line is checked at every instruction boundary, the response time is one instruction: hardware latency is
        the reason real-time systems love simple, short pipelines.</p>
        <p>The loop here spins. A real idle loop waits in <code>wfi</code> (wait for interrupt): the core may stop its clock until an interrupt is
        pending and enabled in mie, even with mstatus.MIE = 0. The spec lets <code>wfi</code> be a no-op, and here it is one.</p>
        <p>The difference from the timer is who decides the moment: the timer is internal and predictable, an external line can rise at any cycle. The CPU does not care; it samples the line at each instruction boundary and either takes the interrupt there or does not. That is why the main
        loop can be any code at all.</p>
        <div class="try">Pulse a few cycles to finish the setup, then press "IRQ (one cycle)" in the I/O panel.</div>`,
      scene: () => cpuScene({ source: sys('irq'), system: true, highlight: ['csr', 'trap'] }),
      tour: {
        beats: [
          { title: 'Waiting in the loop', reset: true, cycles: 12, show: ['csr', 'trap'], expect: { pcOut: 32, leds: 0 },
            say: '<p>The set-up enabled the external interrupt in mie and the global MIE. The loop at pc {v:pcOut} counts in s0; the LEDs are {v:leds}.</p>' },
          { title: 'The line rises', set: { irq: 1 }, cycles: 1, show: ['csr', 'trap'], expect: { pcOut: 40, leds: 0 },
            say: '<p>irq = {v:irq}: mip.MEIP is set, the interrupt is enabled, and at the very next instruction boundary the CPU traps. The instruction at pc 32 does not run; pc = {v:pcOut}, the handler, and mepc holds 32.</p>' },
          { title: 'The handler toggles the LEDs', set: { irq: 0 }, cycles: 3, show: ['io'], expect: { pcOut: 52, leds: 255 },
            say: '<p>The button is released. The handler reads the LEDs, flips them and writes them back: leds = {v:leds}.</p>' },
          { title: 'Return', cycles: 2, show: ['csr'], expect: { pcOut: 32 },
            say: '<p><code>mret</code> returns to mepc: pc = {v:pcOut}, the instruction that was held back runs now. The LEDs stay on until the next press.</p>' },
        ],
      },
      more: {
        derive: `<p>Interrupt latency is the time to the next instruction boundary. At one instruction a cycle that is one edge: the instruction that was about to run (mepc) is held back, the trap takes its place, and after <code>mret</code> it runs. Nothing in the main loop is lost or repeated. With a multi-cycle or pipelined core the boundary can be tens of cycles away; with a divide in progress, as in chapter ${numOf('muldiv')}, it waits for the divide.</p>`,
        pitfall: `<p>Holding the IRQ button across the handler. The line is checked at every boundary and the handler clears nothing at the source, so if irq stayed high the CPU would take the interrupt again at the first boundary after <code>mret</code>. The scene\'s button is a one-cycle pulse for that reason; a real device holds its line until software acknowledges it.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A device raises its interrupt line, and holds it until the handler services it, while MIE = 0 (we are inside a handler). What happens?',
        options: ['It is lost', 'It stays pending in mip and is taken after mret sets MIE again', 'It interrupts the handler anyway', 'The CPU halts'],
        answer: 1,
        why: ['Pending and enabled are separate: mip keeps showing the request for as long as the device holds the line.', '', 'MIE = 0 is exactly what keeps a handler from being interrupted.', 'Nothing halts: the interrupt just waits for MIE.'],
        explain: 'Pending and enabled are separate: mip shows the line for as long as the device holds it, and the interrupt is taken as soon as mret restores MIE. That is why handlers must clear the cause at the device. This scene\'s IRQ button is different: it raises the line for one cycle and nothing latches it, so a press during the handler is lost. Real systems latch the request, in the device or in an interrupt controller (RISC-V\'s PLIC), until software acknowledges it.',
      },
    },
    ...TRAPS_MORE,
    {
      title: 'Inside the trap unit',
      body: `
        <p>Seven 2:1 multiplexer pairs in a chain build the <span data-show="c0 c1 c2 c3 c4 c5 c6">cause</span> and
        <span data-show="v0 v1 v2 v3 v4 v5 v6">mtval</span>; the trap signal is <span data-show="any">the OR of all sources</span>.
        Together with the CSR unit and the system decoder this is about ${kNands(TRAP_NANDS)} NANDs: privilege and interrupts are not free, but
        they are what turns a calculator into a computer that can run an operating system.</p>
        <p>Measured: the trap unit is ${nd(TRAP_UNIT)} NANDs, the CSR unit ${nd(CSR_UNIT)} and the system decoder ${nd(SYS_DECODE)}, together ${kNands(TRAP_NANDS)} of the ${kNands(sysNands(false).core)} in the machine without its program ROM.</p>
        ${trapMistakes()}`,
      scene: () => ({ root: TRAP_UNIT, inputs: { illegal: 1 } }),
      tour: {
        beats: [
          { title: 'Illegal instruction', show: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'], expect: { trap: 1, cause: 2 },
            say: '<p>illegal = 1: trap = {v:trap}, cause = {v:cause}.</p>' },
          { title: 'Two at once', set: { ecall: 1 }, show: ['any'], expect: { trap: 1, cause: 2 },
            say: '<p>ecall as well. One real instruction cannot be both, but the unit must still be defined for any inputs: the cause is still {v:cause}, because illegal instruction has the higher priority.</p>' },
          { title: 'ebreak beats ecall', set: { illegal: 0, ebreak: 1 }, expect: { cause: 3 },
            say: '<p>Without the illegal word, ebreak (cause {v:cause}) outranks ecall.</p>' },
          { title: 'ecall alone', set: { ebreak: 0 }, expect: { cause: 11 },
            say: '<p>Only ecall left: cause = {v:cause}.</p>' },
          { title: 'An interrupt outranks everything', set: { irq: 1, irqCause: 0x80000007, illegal: 1 }, show: ['c6', 'v6'], expect: { cause: 0x80000007 },
            say: '<p>A pending timer interrupt, with an illegal instruction and an ecall still asserted: cause = {v:cause} (bit 31 set marks an interrupt, 7 the timer). The faulting instruction has not run and will trap after the handler returns.</p>' },
          { title: 'A misaligned load', set: { irq: 0, illegal: 0, ecall: 0, loadMis: 1, addr: 3 }, show: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'], expect: { cause: 4, tval: 3 },
            say: '<p>Only loadMis: cause = {v:cause}, and mtval = {v:tval} is the address, 3.</p>' },
        ],
      },
      more: {
        derive: `<p>The chain is a priority encoder written as multiplexers: cause<sub>k</sub> = (source k asserted) ? code<sub>k</sub> : cause<sub>k−1</sub>, starting from the lowest priority. The same select picks tval. trap = OR of all sources, so a cycle with no source leaves cause 0 and no trap. Seven stages of a 32-bit 2:1 mux for each of cause and tval account for most of the unit\'s ${nd(TRAP_UNIT)} NANDs.</p>`,
        pitfall: `<p>Reading cause when trap is 0. The chain's output is only meaningful with trap = 1; with no source the multiplexers all pass 0. In software, mcause is read in the handler, never otherwise.</p>`,
        numbers: `<table class="mini"><tr><th>unit</th><th>NANDs</th></tr><tr><td>CSR unit</td><td>${nd(CSR_UNIT)}</td></tr><tr><td>trap unit</td><td>${nd(TRAP_UNIT)}</td></tr><tr><td>system decoder</td><td>${nd(SYS_DECODE)}</td></tr><tr><td>together</td><td>${TRAP_NANDS}</td></tr></table>`,
      },
    },
    {
      title: 'Precise traps in a pipeline',
      body: `
        <p>The single-cycle CPU of this chapter finishes one instruction before it starts the next, so a trap always falls between two instructions.
        The pipeline of <a href="#/c/pipeline/0">chapter ${numOf('pipeline')}</a> holds five at once. A trap there is <strong>precise</strong> when it looks the same:
        every instruction older than the trapping one has finished, none younger has changed a register, memory or a CSR, and mepc names
        the trapping instruction. A handler can then fix the cause and return, and the program cannot tell it was interrupted.</p>
        <p>The rule that makes it work is to take every trap in one stage. The campaign's pipeline (<a href="#/campaign/n/y_ptrap">Pipeline V: exceptions</a>,
        16-bit, but the same design) takes them in E:</p>
        <ul>
        <li><strong>The trapping instruction does nothing.</strong> It has written nothing yet (register writes happen in W, stores in M), and the trap
        clears its own register write and store enable on the way out of E.</li>
        <li><strong>Older instructions finish.</strong> The ones in M and W go on as usual: their results are part of the state the handler sees.</li>
        <li><strong>Younger instructions are flushed.</strong> The two behind it, in F/D and D/E, are cleared exactly as a taken branch clears them, and the PC
        loads mtvec instead of a branch target: the trap is one more input of the redirect.</li>
        <li><strong>Bubbles never trap.</strong> A stall or a flush puts an all-zero word into the pipeline, which decodes as an illegal instruction.
        So every stage carries a <em>valid</em> bit, and only a valid instruction may trap. An interrupt waits for a valid instruction in E too:
        a bubble has no pc of its own to put in mepc.</li>
        </ul>
        <p>E works because every exception of this ISA is known by the end of decode: an illegal word, ecall, ebreak. A cause found later, a
        misaligned or faulting load in M say, is carried down the pipeline with its instruction as a flag and acted on at one commit point,
        so that everything younger can still be flushed. Out-of-order cores do the same at the head of the reorder buffer
        (<a href="#/c/ooo/0">chapter ${numOf('ooo')}</a>).</p>
        <p>The price, measured on the campaign's cores: precise exceptions take Pipeline IV (forwarding, the load-use stall and branch flushes) from 9218 to 12 031 NANDs (the CSR file, the
        system decoder, the valid bits and the trap path) and its period from 78 to 81 delays; the external interrupt on top adds 7 NANDs.</p>`,
      challenge: {
        kind: 'quiz',
        question: 'Pipeline V takes traps in E. An illegal word is in E, an <code>lw</code> in M and an <code>add</code> in D. Which of them changes the machine\'s state?',
        options: ['Only the lw: it finishes, the add is flushed, the illegal word writes nothing', 'None: a trap freezes the whole pipeline', 'The lw and the add: the add was already decoded', 'All three'],
        answer: 0,
        explain: 'Precise: everything older than the trap finishes (the lw writes its register in W), nothing younger runs (the add is flushed with F/D), and the trapping instruction itself writes nothing; mepc holds its address.',
        why: ['', 'Freezing the lw would lose a result the program has already been promised: an older instruction must finish.', 'Decoding changes no state; the add is flushed before it writes anything, as behind a taken branch.', 'The illegal instruction does not run: the trap clears its writes.'],
      },
    },
    {
      title: 'Find it: a handler that returns to the wrong place',
      deep: true,
      body: `
        <p><em>Optional: a deep dive. Nothing later relies on it.</em></p>
        <p>The tiny operating system again: the program puts a character in a0 and traps with <code>ecall</code>; the handler prints it,
        moves mepc past the ecall and returns. One wire in the CPU is stuck at 0 or 1, here one bit of a bus. Find it.</p>
        <p>Press <strong>Run to halt</strong> (or <strong>Step</strong>) in the CPU panel. After every cycle it compares the registers with the
        golden model, so it stops at the first instruction the hardware got wrong, and names the register, both values and the instruction.
        Read that line as a clue: which instruction, which register, which value instead of which. Then right-click the wire you suspect (on a touch screen, press and hold it) and
        choose <strong>It is stuck at 0 here</strong> or <strong>… at 1</strong> (a bus asks for the bit). A wrong guess costs nothing: the
        panel runs the same program with the fault you named instead and says where that one would first show, which is a clue too.</p>
        <p>When the value is a number, compare the two in binary: one stuck bit changes a value by a power of two.</p>`,
      scene: FIND_SYS.scene,
      challenge: FIND_SYS.challenge,
    },
  ],
};

