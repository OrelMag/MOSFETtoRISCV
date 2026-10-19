import { CSR_UNIT, LOAD_EXTRACT, STORE_ALIGN, TRAP_UNIT, bankedMemory, systemCpu } from '../lib';
import { withoutParts } from '../lib/tech';
import { cpuState } from '../riscv/cosim';
import { SYSTEM_PROGRAMS } from '../riscv/sysprograms';
import { stats } from '../sim/stats';
import { pack } from '../sim/values';
import { cpuScene } from '../widgets/cpupanel';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

const sys = (id: string) => SYSTEM_PROGRAMS.find((p) => p.id === id)!.source;

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
export const kNands = (n: number) => (Math.round(n / 1000) * 1000).toLocaleString('en-US').replace(/,/g, ' ');

function csrq(st: Stage, inst: string): number {
  const csr = st.rootCtx?.node.children?.get('csr');
  const n = csr?.children?.get(inst);
  return n ? pack(st.sim!.getBits(n.ports.q)) >>> 0 : -1;
}

export const chIO: Chapter = {
  id: 'io', num: 18, title: 'Bytes and the outside world', level: 'System',
  blurb: 'Byte and halfword memory access, and memory-mapped I/O: a console, LEDs, switches and a timer.',
  goals: [
    'store a byte or halfword into a word memory with replicated data and byte enables',
    'extract a byte or halfword on a load and sign- or zero-extend it',
    'say which accesses are misaligned',
    'drive a console, LEDs and switches with ordinary loads and stores to I/O addresses',
  ],
  builds: ['memory', 'cpu'],
  recap: {
    keep: [
      'A store replicates the byte (or half) into every lane and raises byte enables only for the addressed bytes: <code>sb</code> to address 2 → be = 0100, <code>sh</code> to address 2 → 1100.',
      'The data memory is four 8-bit banks, each written when we ∧ be<sub>i</sub>; a read returns the whole word.',
      'A load picks the lane with a 4:1 (byte) or 2:1 (half) mux, then sign- or zero-extends by wiring alone: the cost is all in the multiplexers.',
      'A halfword at an odd address or a word off a 4-byte boundary is misaligned. RISC-V lets an implementation handle it in hardware or trap; the complete CPU traps.',
      `Addresses with bit 31 set go to the I/O unit: a store to 0x8000_0000 prints a byte, 0x8000_0004 sets the LEDs, a load from 0x8000_0008 reads the switches. The whole machine is about ${kNands(sysNands(false).core)} NANDs without its program ROM.`,
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
        explain: 'An aligned word sits on a 4-byte boundary; address 6 spans two words. RISC-V lets a core either split such an access in hardware or trap; the complete CPU raises a misaligned-load exception (next chapter).',
        why: ['', 'A halfword needs only an even address.', 'A byte can sit at any address.', '8 is a multiple of 4.'],
      },
      {
        question: 'How does the CPU print to the console without a print instruction?',
        options: ['A store to an address with bit 31 set goes to the I/O unit, which sends the byte to the console', 'funct3 of <code>sb</code> selects a console mode', 'The console reads the data memory every cycle', 'Only an <code>ecall</code> can print'],
        answer: 0,
        explain: 'Memory-mapped I/O: the address decides where a store goes. Devices get addresses, and ordinary loads and stores talk to them.',
        why: ['', 'funct3 only gives the access size and sign; the address decides where the store goes.', 'Nothing watches the data memory: the store never reaches it, the I/O unit takes it instead.', 'An ecall traps to software, and that software still prints with a store to the console address.'],
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
        trap and leave it to software; the complete CPU traps.</p>
        <div class="try">Set size = 0 (byte) and step addr through 0–3: one enable bit moves across.</div>`,
      scene: () => ({ root: STORE_ALIGN, inputs: { wd: 0xab, addr: 2, size: 0 } }),
      tries: [(st) => st.getInput('size') === 0 && st.getInput('addr') !== 2],
    },
    {
      title: 'Four byte-wide banks',
      body: `
        <p>The data memory becomes <span data-show="b0 b1 b2 b3">four 8-bit memories</span> side by side, one per byte lane, each with its own write enable
        (<span data-show="w0 w1 w2 w3">we AND be<sub>i</sub></span>). Real SRAM macros do exactly this: per-byte write masks.</p>
        <p>Reads always return the whole word.</p>`,
      scene: () => ({ root: bankedMemory(2), inputs: { addr: 4, wdata: 0x11223344, be: 0b0100, we: 1, clk: 0 } }),
    },
    {
      title: 'Loading a byte',
      body: `
        <p>The <strong>load extraction</strong> unit picks the addressed byte (<span data-show="bsel">a 4:1 mux of lanes</span>)
        or half (<span data-show="hsel">2:1</span>), then <span data-show="fsel">funct3 chooses</span>
        sign extension (<span data-show="sb sh"><code>lb</code>, <code>lh</code>: copy the top bit</span>) or zero extension
        (<span data-show="zb zh"><code>lbu</code>, <code>lhu</code></span>).
        Both extensions are pure wiring, so the cost is all in the multiplexers.</p>`,
      scene: () => ({ root: LOAD_EXTRACT, inputs: { rdata: 0x12ab5678, addr: 2, funct3: 0 } }),
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
        <span data-show="csr trap">CSRs, a trap unit</span> and interrupts. Every RV32I instruction plus Zicsr, about
        ${kNands(sysNands(false).core)} NAND gates without the program ROM (${kNands(sysNands(false).all)} with it), and still checked against the instruction-set simulator every cycle.</p>
        <p>Addresses with bit 31 set go to <strong>memory-mapped I/O</strong> instead of the data memory. A store to
        0x8000_0000 is not a store at all: the I/O unit sends the byte to the <span data-show="pin:consoleData">console</span>. That is how most processors talk to
        the outside world, from UARTs to GPUs; x86 also keeps a separate 64 K I/O port space with its own <code>in</code> / <code>out</code> instructions,
        now used mostly by legacy devices.</p>
        <div class="try">Run the program. The console fills one <code>sb</code> at a time.</div>`,
      scene: () => cpuScene({ source: sys('hello'), system: true }),
      challenge: {
        kind: 'reach', goal: 'Run the program until the console shows the whole greeting.',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x.length > 0 && st.cycles >= 31 : false; } catch { return false; } },
        hints: [
          'Nothing prints until a store reaches 0x8000_0000, so the clock has to run.',
          'Each character costs two instructions (load it into a register, store it): count the characters in the greeting.',
        ],
        answer: 'Press "Run to halt" (or Pulse ~31 times): 15 characters, one li + sb pair each.',
        solve: (st) => { st.runCycles(40); },
      },
    },
    {
      title: 'Switches in, LEDs out',
      body: `
        <p>Inputs work the same way: a load from 0x8000_0008 returns the <span data-show="pin:switches">switches</span>, a
        store to 0x8000_0004 latches the <span data-show="pin:leds">LEDs</span>. The <span data-show="io">I/O unit</span>
        decodes both. This program copies one to the other in a loop.</p>
        <div class="try">Let the clock run (or press Run), then flip switches in the I/O panel.</div>`,
      scene: () => cpuScene({ source: sys('leds'), system: true }),
      tries: [(st) => st.value('leds') > 0],
    },
  ],
};

export const chTraps: Chapter = {
  id: 'traps', num: 19, title: 'Traps and interrupts', level: 'Privileged ISA',
  blurb: 'CSRs, exceptions, ecall, timer and external interrupts: how hardware hands control to software.',
  goals: [
    'read and write CSRs with csrrw, csrrs and csrrc, and name the machine-mode registers a trap uses',
    'list what the hardware does on a trap and on mret, register by register',
    'tell a pending interrupt from a taken one: mip, mie and mstatus.MIE',
    'order the trap causes by priority and give each its mcause',
  ],
  builds: ['cpu', 'io'],
  recap: {
    keep: [
      'CSRs: a separate space of 12-bit addresses, accessed with <code>csrrw</code> (swap), <code>csrrs</code> (set bits), <code>csrrc</code> (clear bits) and their immediate forms. This CPU has sixteen, one address comparator each.',
      'A trap: PC ← mtvec, mepc ← the address of the trapping instruction, mcause ← the reason, MPIE ← MIE, MIE ← 0. <code>mret</code> jumps to mepc and restores MIE. mtvec\'s low two bits are its MODE: 0 direct (every trap to BASE), 1 vectored (interrupt <em>n</em> to BASE + 4<em>n</em>); here MODE is wired to 0.',
      'mcause: 2 illegal instruction, 3 breakpoint, 4 misaligned load, 6 misaligned store, 11 ecall; interrupts set bit 31 (0x80000007 timer, 0x8000000B external). A trapping instruction writes nothing.',
      'An interrupt is pending in mip while its source holds, and taken at the next instruction boundary only if enabled in mie and globally by mstatus.MIE.',
      'Priority: interrupts (external, then timer), then illegal instruction, ebreak, ecall, misaligned fetch, load, store. CSR unit, trap unit and system decoder: about 10 000 NANDs.',
      'The hardware saves only the PC and the cause: a handler saves every register it uses (mscratch gives it a register to swap with sp), nests only by saving mepc and mcause and setting MIE again, and an idle loop waits in <code>wfi</code>. Machine mode is the only mode here; with user mode, mstatus.MPP says where a trap came from and ecall\'s cause is 8 from U, 11 from M.',
    ],
    practise: ['y_csr', 'y_trap', 'y_irq', 'p_handler', 'y_final'],
    check: [
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
      body: `
        <p>A second, separate register space: <strong>CSRs</strong>, addressed by a 12-bit number and accessed only with
        <code>csrrw</code> (swap), <code>csrrs</code> (set bits) and <code>csrrc</code> (clear bits), plus immediate forms. This CPU implements a
        working subset of machine mode: mstatus, misa, mie, mtvec, mscratch, mepc, mcause, mtval, mip, mcycle/cycle and mhartid, plus the identity
        registers every core must have (mvendorid, marchid, mimpid) and RV32's upper half of mstatus (mstatush), which read 0. Left out: minstret,
        the counters' upper halves (mcycleh …) and 64 bits of time; here mcycle reads the 32-bit timer mtime.</p>
        <p>Open the CSR unit: sixteen <span data-show="is_mstatus is_mtvec is_mepc is_mcause">address comparators</span>, a
        <span data-show="rsel">read multiplexer</span>, the <span data-show="orOld andOld opSel">read-modify-write logic</span>,
        and the <span data-show="rTvec rEpc rCause rTval">registers</span>, some of them written by hardware on a trap.</p>`,
      scene: () => ({ root: CSR_UNIT, inputs: { addr: 0x305, funct3: 1, rs1v: 0x40, csrWrite: 1, clk: 0 } }),
    },
    {
      title: 'ecall: asking the operating system',
      body: `
        <p>A <strong>trap</strong> is a forced, hardware-performed jump (<span data-show="trap">the trap unit</span> decides):
        the PC goes to <code>mtvec</code> through the <span data-show="trapmux">trap / mret multiplexer</span>, the address of the
        interrupted instruction is saved in <code>mepc</code>, the reason in <code>mcause</code> (both in the
        <span data-show="csr">CSR unit</span>), and interrupts are disabled
        (MIE → MPIE, MIE = 0). The handler ends with <code>mret</code>, which jumps back to <code>mepc</code> and restores MIE.
        mtvec's low two bits are its MODE: 0 <em>direct</em> sends every trap to the same address, 1 <em>vectored</em> sends interrupt <em>n</em>
        to BASE + 4<em>n</em> (exceptions still to BASE), saving the handler the dispatch on mcause. Here the two bits are wired to 0: direct only.</p>
        <p><code>ecall</code> traps on purpose: it is how a program calls the operating system. Here a three-line "OS" prints the
        character in a0. Note the handler adds 4 to mepc so that <code>mret</code> returns <em>after</em> the ecall.</p>
        <details class="deeper"><summary>Deeper: privilege modes</summary>
        <p>This CPU has only machine mode (M), the one mode every RISC-V core must have, so the "OS" and the program share it. A real system runs
        programs in user mode (U), and an OS with virtual memory in supervisor mode (S). A trap goes to M (or, if delegated, S) and records the mode
        it came from in mstatus.MPP (2 bits: 0 U, 1 S, 3 M); <code>mret</code> returns to that mode. Hence three ecall causes: 8 from U, 9 from S,
        11 from M. In U, an access to a machine CSR or an <code>mret</code> is an illegal instruction, and PMP registers fence off memory: that is
        what stops a program from taking over the machine. Here MPP is wired to 3 and ecall's cause is always 11.</p></details>
        <div class="try">Pulse to the ecall and watch mepc and mcause (11 = ecall) change in the I/O panel, and the PC jump to the handler.</div>`,
      scene: () => cpuScene({ source: sys('syscall'), system: true, highlight: ['trap', 'csr', 'trapmux'] }),
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
        fetch, load and store. A trapping instruction writes nothing: its register write, memory write and CSR write are all suppressed.</p>`,
      scene: () => cpuScene({ source: sys('faults'), system: true, highlight: ['sys', 'trap'] }),
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
        undoes it all before <code>mret</code>. That is the foundation of every multitasking operating system's scheduler tick: save one
        program's registers, load another's.</p>
        <details class="deeper"><summary>Deeper: nested interrupts</summary>
        <p>The hardware does not nest: there is one mepc and one mcause, and the trap cleared MIE. A handler that should itself be interruptible
        (a slow one, under a more urgent device) saves mepc, mcause and mstatus on its stack, then sets MIE again; before returning it clears MIE
        and restores them. Cores with many interrupt levels (RISC-V's CLIC, Arm's NVIC) do that stacking in hardware.</p></details>
        <div class="try">Let the clock run and watch the dots, mepc (where the loop was interrupted) and s1 (tick count).</div>`,
      scene: () => cpuScene({ source: sys('timer'), system: true, highlight: ['io', 'csr'] }),
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
        <div class="try">Pulse a few cycles to finish the setup, then press "IRQ (one cycle)" in the I/O panel.</div>`,
      scene: () => cpuScene({ source: sys('irq'), system: true, highlight: ['csr', 'trap'] }),
      challenge: {
        kind: 'quiz', question: 'A device raises its interrupt line, and holds it until the handler services it, while MIE = 0 (we are inside a handler). What happens?',
        options: ['It is lost', 'It stays pending in mip and is taken after mret sets MIE again', 'It interrupts the handler anyway', 'The CPU halts'],
        answer: 1,
        why: ['Pending and enabled are separate: mip keeps showing the request for as long as the device holds the line.', '', 'MIE = 0 is exactly what keeps a handler from being interrupted.', 'Nothing halts: the interrupt just waits for MIE.'],
        explain: 'Pending and enabled are separate: mip shows the line for as long as the device holds it, and the interrupt is taken as soon as mret restores MIE. That is why handlers must clear the cause at the device. This scene\'s IRQ button is different: it raises the line for one cycle and nothing latches it, so a press during the handler is lost. Real systems latch the request, in the device or in an interrupt controller (RISC-V\'s PLIC), until software acknowledges it.',
      },
    },
    {
      title: 'Inside the trap unit',
      body: `
        <p>Seven 2:1 multiplexer pairs in a chain build the <span data-show="c0 c1 c2 c3 c4 c5 c6">cause</span> and
        <span data-show="v0 v1 v2 v3 v4 v5 v6">mtval</span>; the trap signal is <span data-show="any">the OR of all sources</span>.
        Together with the CSR unit and the system decoder this is about 10 000 NANDs: privilege and interrupts are not free, but
        they are what turns a calculator into a computer that can run an operating system.</p>`,
      scene: () => ({ root: TRAP_UNIT, inputs: { illegal: 1 } }),
    },
  ],
};

