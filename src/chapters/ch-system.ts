import { CSR_UNIT, LOAD_EXTRACT, STORE_ALIGN, TRAP_UNIT, bankedMemory } from '../lib';
import { cpuState } from '../riscv/cosim';
import { SYSTEM_PROGRAMS } from '../riscv/sysprograms';
import { pack } from '../sim/values';
import { cpuScene } from '../widgets/cpupanel';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

const sys = (id: string) => SYSTEM_PROGRAMS.find((p) => p.id === id)!.source;

function csrq(st: Stage, inst: string): number {
  const csr = st.rootCtx?.node.children?.get('csr');
  const n = csr?.children?.get(inst);
  return n ? pack(st.sim!.getBits(n.ports.q)) >>> 0 : -1;
}

export const chIO: Chapter = {
  id: 'io', num: 18, title: 'Bytes and the outside world', level: 'System',
  blurb: 'Byte and halfword memory access, and memory-mapped I/O: a console, LEDs, switches and a timer.',
  steps: [
    {
      title: 'Storing a byte',
      body: `
        <p>So far the data memory moved whole words. RISC-V also has <code>sb</code>/<code>sh</code> and
        <code>lb</code>/<code>lh</code>/<code>lbu</code>/<code>lhu</code>. A 32-bit memory can still do it.</p>
        <p>For a store, the <strong>store alignment</strong> unit replicates the byte (or half) into every lane it could go to,
        and raises <strong>byte enables</strong> only for the addressed bytes: <code>sb</code> to address 2 enables byte 2, <code>sh</code>
        to address 2 enables bytes 2–3. A halfword at an odd address, or a word not on a 4-byte boundary, is
        <em>misaligned</em>; the complete CPU turns that into an exception.</p>
        <div class="try">Set size = 0 (byte) and step addr through 0–3: one enable bit moves across.</div>`,
      scene: () => ({ root: STORE_ALIGN, inputs: { wd: 0xab, addr: 2, size: 0 } }),
    },
    {
      title: 'Four byte-wide banks',
      body: `
        <p>The data memory becomes four 8-bit memories side by side, one per byte lane, each with its own write enable
        (we AND be<sub>i</sub>). Real SRAM macros do exactly this: per-byte write masks.</p>
        <p>Reads always return the whole word.</p>`,
      scene: () => ({ root: bankedMemory(2), inputs: { addr: 4, wdata: 0x11223344, be: 0b0100, we: 1, clk: 0 } }),
    },
    {
      title: 'Loading a byte',
      body: `
        <p>The <strong>load extraction</strong> unit picks the addressed byte (a 4:1 mux of lanes) or half (2:1), then funct3 chooses
        sign extension (<code>lb</code>, <code>lh</code>: copy the top bit) or zero extension (<code>lbu</code>, <code>lhu</code>).
        Both extensions are pure wiring, so the cost is all in the multiplexers.</p>`,
      scene: () => ({ root: LOAD_EXTRACT, inputs: { rdata: 0x12ab5678, addr: 2, funct3: 0 } }),
      challenge: {
        kind: 'quiz', question: 'Memory holds 0x12AB5678 at address 0. What does lb x5, 2(x0) load?',
        options: ['0x000000AB', '0xFFFFFFAB', '0x00000056', '0xFFFFFF56'], answer: 1,
        explain: 'Little-endian: byte 2 is 0xAB. lb sign-extends, and 0xAB has its top bit set, so the result is 0xFFFFFFAB (−85). lbu would give 0x000000AB.',
      },
    },
    {
      title: 'The complete machine',
      body: `
        <p>This is the full processor: the single-cycle datapath plus the load/store unit and byte-banked memory, an
        <strong>I/O unit</strong>, and (next chapter) CSRs, a trap unit and interrupts. Every RV32I instruction plus Zicsr, about
        67 000 NAND gates, and still checked against the golden model every cycle.</p>
        <p>Addresses with bit 31 set go to <strong>memory-mapped I/O</strong> instead of the data memory. A store to
        0x8000_0000 is not a store at all: the I/O unit sends the byte to the console. That is how every processor talks to
        the outside world, from UARTs to GPUs.</p>
        <div class="try">Run the program. The console fills one <code>sb</code> at a time.</div>`,
      scene: () => cpuScene({ source: sys('hello'), system: true }),
      challenge: {
        kind: 'reach', goal: 'Run the program until the console shows the whole greeting.',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x.length > 0 && st.cycles >= 31 : false; } catch { return false; } },
        answer: 'Press "Run to halt" (or Pulse ~31 times): 15 characters, one li + sb pair each.',
        solve: (st) => { st.runCycles(40); },
      },
    },
    {
      title: 'Switches in, LEDs out',
      body: `
        <p>Inputs work the same way: a load from 0x8000_0008 returns the switches, a store to 0x8000_0004 latches the LEDs.
        This program copies one to the other in a loop.</p>
        <div class="try">Press Run on the clock, then flip switches in the I/O panel.</div>`,
      scene: () => cpuScene({ source: sys('leds'), system: true }),
    },
  ],
};

export const chTraps: Chapter = {
  id: 'traps', num: 19, title: 'Traps and interrupts', level: 'Privileged ISA',
  blurb: 'CSRs, exceptions, ecall, timer and external interrupts: how hardware hands control to software.',
  steps: [
    {
      title: 'Control and status registers',
      body: `
        <p>A second, separate register space: <strong>CSRs</strong>, addressed by a 12-bit number and accessed only with
        <code>csrrw</code> (swap), <code>csrrs</code> (set bits) and <code>csrrc</code> (clear bits), plus immediate forms. This CPU implements the
        machine-mode set an embedded core needs: mstatus, misa, mie, mtvec, mscratch, mepc, mcause, mtval, mip, mcycle/cycle and mhartid.</p>
        <p>Open the CSR unit: twelve address comparators, a read multiplexer, the read-modify-write logic, and the registers,
        some of them written by hardware on a trap.</p>`,
      scene: () => ({ root: CSR_UNIT, inputs: { addr: 0x305, funct3: 1, rs1v: 0x40, csrWrite: 1, clk: 0 } }),
    },
    {
      title: 'ecall: asking the operating system',
      body: `
        <p>A <strong>trap</strong> is a forced, hardware-performed jump: the PC goes to <code>mtvec</code>, the address of the
        interrupted instruction is saved in <code>mepc</code>, the reason in <code>mcause</code>, and interrupts are disabled
        (MIE → MPIE, MIE = 0). The handler ends with <code>mret</code>, which jumps back to <code>mepc</code> and restores MIE.</p>
        <p><code>ecall</code> traps on purpose: it is how a program calls the operating system. Here a three-line "OS" prints the
        character in a0. Note the handler adds 4 to mepc so that <code>mret</code> returns <em>after</em> the ecall.</p>
        <div class="try">Pulse to the ecall and watch mepc and mcause (11 = ecall) change in the I/O panel, and the PC jump to the handler.</div>`,
      scene: () => cpuScene({ source: sys('syscall'), system: true, highlight: ['trap', 'csr', 'trapmux'] }),
    },
    {
      title: 'Exceptions',
      body: `
        <p>The same mechanism catches errors. This program executes an <strong>illegal instruction</strong> (0xFFFFFFFF), a
        <strong>misaligned load</strong> and an <code>ebreak</code>. Each traps to the handler, which logs mcause and mtval
        (the faulting address, for the misaligned load) into memory and skips the instruction.</p>
        <p>The trap unit is a priority chain of multiplexers: interrupts first, then illegal instruction, ebreak, ecall, misaligned
        fetch, load and store. A trapping instruction writes nothing: its register write, memory write and CSR write are all suppressed.</p>`,
      scene: () => cpuScene({ source: sys('faults'), system: true, highlight: ['sys', 'trap'] }),
      challenge: {
        kind: 'reach', goal: 'Run until all three exceptions have been logged (mcause values 2, 4 and 3 in memory).',
        check: (st) => { try { const m = st.sim ? cpuState(st.sim).dmem : []; return m[0] === 2 && m[2] === 4 && m[4] === 3; } catch { return false; } },
        answer: 'Press "Run to halt". Memory words 0, 2 and 4 hold mcause 2 (illegal), 4 (misaligned load) and 3 (breakpoint); word 3 holds mtval = 3, the misaligned address.',
        solve: (st) => { st.runCycles(80); },
      },
    },
    {
      title: 'The timer interrupt',
      body: `
        <p>An <strong>interrupt</strong> is a trap caused by the outside world. The I/O unit has a free-running counter
        <code>mtime</code> and a compare register <code>mtimecmp</code>; while mtime ≥ mtimecmp the timer interrupt is
        <em>pending</em> (mip.MTIP). It is <em>taken</em> at the next instruction boundary if it is enabled (mie.MTIE) and
        interrupts are globally on (mstatus.MIE).</p>
        <p>The handler prints a dot and moves mtimecmp 40 cycles ahead. The main loop never knows it was interrupted: that is
        the foundation of every multitasking operating system's scheduler tick.</p>
        <div class="try">Run the clock and watch the dots, mepc (where the loop was interrupted) and s1 (tick count).</div>`,
      scene: () => cpuScene({ source: sys('timer'), system: true, highlight: ['io', 'csr'] }),
      challenge: {
        kind: 'reach', goal: 'Let the timer interrupt fire five times (s1 = 5).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x[9] >= 5 : false; } catch { return false; } },
        answer: 'Run the clock for ~220 cycles: one interrupt every 40 cycles after the setup.',
        solve: (st) => { st.runCycles(240); },
      },
    },
    {
      title: 'External interrupts',
      body: `
        <p>The IRQ button drives the CPU's external interrupt line (mip.MEIP). The handler toggles the LEDs and counts presses.
        Because the line is checked at every instruction boundary, the response time is one instruction: hardware latency is
        the reason real-time systems love simple, short pipelines.</p>
        <div class="try">Pulse a few cycles to finish the setup, then press "IRQ (one cycle)" in the I/O panel.</div>`,
      scene: () => cpuScene({ source: sys('irq'), system: true, highlight: ['csr', 'trap'] }),
      challenge: {
        kind: 'quiz', question: 'An interrupt arrives while MIE = 0 (we are inside a handler). What happens?',
        options: ['It is lost', 'It stays pending in mip and is taken after mret sets MIE again', 'It interrupts the handler anyway', 'The CPU halts'],
        answer: 1,
        explain: 'Pending and enabled are separate: the interrupt remains visible in mip (for a level-triggered line, as long as the device holds it) and is taken as soon as mret restores MIE. That is why handlers must clear the cause at the device.',
      },
    },
    {
      title: 'Inside the trap unit',
      body: `
        <p>Seven 2:1 multiplexer pairs in a chain build the cause and mtval; the trap signal is the OR of all sources.
        Together with the CSR unit and the system decoder this is about 4 000 NANDs: privilege and interrupts are not free, but
        they are what turns a calculator into a computer that can run an operating system.</p>`,
      scene: () => ({ root: TRAP_UNIT, inputs: { illegal: 1 } }),
    },
  ],
};

void csrq;
