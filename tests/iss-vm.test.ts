// The golden model's privilege modes and Sv32 (riscv/iss.ts, the `vm` option): directed programs for every walk and
// every fault, the mode rules of CSRs and system instructions, interrupts across modes, and the proof that without
// the option nothing changed. Spike checks the same rules on random programs (tests/verify/spike.ts, config `vm`).
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { CSRS, decode, disasm } from '../src/riscv/isa';
import { CAUSE, ISS, PRIV, type StepInfo } from '../src/riscv/iss';
import { CODE, ORACLE_CONFIGS, compareWithSpike, issAsSpikeLog, oracleCase, oracleIss, parseSpikeLog } from './verify/spike';

const V = 1, R = 2, W = 4, X = 8, U = 16, A = 64, D = 128;
const pte = (ppn: number, flags: number) => ((ppn << 10) | flags) >>> 0;
const satpOf = (rootPpn: number) => (0x80000000 | rootPpn) >>> 0;

/** A machine with 16 KiB of each memory, translation set up by hand: root table at data PA 0, a leaf table at 0x1000. */
function machine() {
  const iss = new ISS([], { system: true, vm: true, m: true, dmemWords: 16384, imemWords: 4096 });
  iss.mtvec = 0x100;
  return iss;
}
function put(iss: ISS, addr: number, src: string) {
  const a = assemble(src);
  if (a.errors.length) throw new Error(a.errors[0].message);
  a.words.forEach((w, i) => { iss.imem[addr / 4 + i] = w; });
}
const setPte = (iss: ISS, pa: number, v: number) => { iss.dmem[pa >>> 2] = v >>> 0; };
/** Root[0] -> the leaf table (ppn 1); L0[i] for the given pages. Code at VA 0x1000 maps to the same instruction-memory address. */
function tables(iss: ISS, leaves: Record<number, number>) {
  setPte(iss, 0, pte(1, V));
  for (const [i, v] of Object.entries(leaves)) setPte(iss, 0x1000 + 4 * Number(i), v);
}
function enter(iss: ISS, priv: number, pc = 0x1000, root = 0) {
  iss.priv = priv;
  iss.pc = pc;
  iss.satp = satpOf(root);
}
function runTrap(iss: ISS, max = 200): StepInfo {
  for (let i = 0; i < max; i++) {
    const info = iss.step();
    if (info.trap) return info;
  }
  throw new Error('no trap');
}
/** Run `src` as the user program at VA 0x1000 and return the first trap. */
function trapOf(src: string, leaves: Record<number, number>, priv: number = PRIV.U, setup?: (iss: ISS) => void) {
  const iss = machine();
  tables(iss, { 1: pte(1, V | R | X | U | A), ...leaves });
  put(iss, 0x1000, src);
  enter(iss, priv);
  setup?.(iss);
  const info = runTrap(iss);
  return { iss, info };
}

describe('Sv32 walk', () => {
  it('walks two levels to a 4 KiB page and reads the data there', () => {
    const iss = machine();
    tables(iss, { 1: pte(1, V | R | X | U | A), 5: pte(7, V | R | W | U | A | D) });
    iss.dmem[(7 * 4096 + 0x24) >>> 2] = 0xcafe1234;
    put(iss, 0x1000, 'li t0, 0x5024\nlw a0, -4(t0)\nlw a1, 0(t0)\nj done\ndone: j done');
    // 0x5024: vpn1 = 0, vpn0 = 5, offset 0x24 -> ppn 7
    enter(iss, PRIV.U);
    iss.run(20);
    expect(iss.x[11]).toBe(0xcafe1234);
    const w = iss.lastWalk!;
    expect(w.access).toBe('fetch'); // the last thing translated is the next fetch
    const loadWalk = iss.walk(0x5024, 'load');
    expect(loadWalk.ptes).toEqual([{ addr: 0, pte: pte(1, V), level: 1 }, { addr: 0x1000 + 4 * 5, pte: pte(7, V | R | W | U | A | D), level: 0 }]);
    expect(loadWalk.pa).toBe(7 * 4096 + 0x24);
    expect(loadWalk.superpage).toBe(false);
  });

  it('maps a 4 MiB superpage: offset bits from the virtual page number', () => {
    const iss = machine();
    tables(iss, { 1: pte(1, V | R | X | U | A) });
    setPte(iss, 4 * 2, pte(0, V | R | W | U | A | D)); // root[2]: VA 0x0080_0000 -> PA 0
    iss.dmem[0x3010 >>> 2] = 0x600dbeef;
    put(iss, 0x1000, 'li t0, 0x803010\nlw a0, 0(t0)\nsw a0, 4(t0)\nj .');
    enter(iss, PRIV.U);
    iss.run(10);
    expect(iss.x[10]).toBe(0x600dbeef);
    expect(iss.dmem[0x3014 >>> 2]).toBe(0x600dbeef);
    const w = iss.walk(0x803010, 'load');
    expect(w.superpage).toBe(true);
    expect(w.ptes.length).toBe(1);
    expect(w.pa).toBe(0x3010);
  });

  it('M never translates, even with satp on; S and U do', () => {
    const iss = machine();
    tables(iss, { 1: pte(1, V | R | X | U | A) });
    put(iss, 0x1000, 'li t0, 0x2000\nlw a0, 0(t0)\nj .');
    iss.dmem[0x2000 >>> 2] = 77;
    enter(iss, PRIV.M);
    iss.run(10);
    expect(iss.x[10]).toBe(77); // untranslated: PA = VA
    expect(iss.translating()).toBe(false);
    iss.priv = PRIV.S;
    expect(iss.translating()).toBe(true);
  });
});

describe('page faults', () => {
  const load = 'li t0, 0x5000\nlw a0, 0(t0)';
  const store = 'li t0, 0x5000\nsw a0, 0(t0)';
  const fetch = 'li t0, 0x5000\njalr t0';
  const rw = V | R | W | U | A | D;

  it('V = 0, reserved W without R, and a missing leaf table: load page fault, mtval = the virtual address', () => {
    for (const p of [0, pte(9, V | W | U | A | D), pte(9, R | U | A | D)]) {
      const { iss, info } = trapOf(load, { 5: p });
      expect(info.trap!.cause).toBe(CAUSE.LOAD_PAGE);
      expect([iss.mcause, iss.mtval, iss.priv, iss.mpp]).toEqual([13, 0x5000, PRIV.M, PRIV.U]);
      expect(iss.mepc).toBe(info.pc);
    }
  });

  it('a pointer with A, D or U set, or a leaf pointer at the last level, faults', () => {
    for (const f of [A, D, U]) {
      const iss = machine();
      setPte(iss, 0, pte(1, V | f));
      put(iss, 0x1000, load);
      enter(iss, PRIV.U);
      // the fetch itself already fails: the root pointer is the one for VA 0 too
      expect(iss.step().trap!.cause).toBe(CAUSE.FETCH_PAGE);
    }
    const { info } = trapOf(load, { 5: pte(1, V) }); // a pointer where the leaf must be
    expect(info.trap!.cause).toBe(CAUSE.LOAD_PAGE);
  });

  it('stores: no W, or D = 0 (software keeps the bits): cause 15; the same page loads fine', () => {
    for (const p of [pte(9, V | R | U | A | D), pte(9, V | R | W | U | A)]) {
      const { iss, info } = trapOf(store, { 5: p });
      expect(info.trap!.cause).toBe(CAUSE.STORE_PAGE);
      expect(iss.mtval).toBe(0x5000);
    }
    const ok = machine();
    tables(ok, { 1: pte(1, V | R | X | U | A), 5: pte(9, V | R | W | U | A) });
    put(ok, 0x1000, `${load}\nj .`);
    enter(ok, PRIV.U);
    ok.run(5);
    expect(ok.mcause).toBe(0);
  });

  it('A = 0 faults a load and a fetch too', () => {
    expect(trapOf(load, { 5: pte(9, V | R | W | U | D) }).info.trap!.cause).toBe(CAUSE.LOAD_PAGE);
    const { iss, info } = trapOf(fetch, { 5: pte(1, V | R | X | U) });
    expect(info.trap!.cause).toBe(CAUSE.FETCH_PAGE);
    expect(iss.mtval).toBe(0x5000);
    expect(iss.mepc).toBe(0x5000); // the fetch that failed, not the jalr
  });

  it('fetch needs X: a readable page is not executable', () => {
    const { iss, info } = trapOf(fetch, { 5: pte(1, rw) });
    expect([info.trap!.cause, iss.mtval]).toEqual([12, 0x5000]);
  });

  it('a misaligned superpage (ppn[0] != 0) faults', () => {
    const iss = machine();
    tables(iss, { 1: pte(1, V | R | X | U | A) });
    setPte(iss, 4 * 2, pte(3, V | R | W | U | A | D));
    put(iss, 0x1000, 'li t0, 0x800000\nlw a0, 0(t0)');
    enter(iss, PRIV.U);
    const info = runTrap(iss);
    expect(info.trap!.cause).toBe(CAUSE.LOAD_PAGE);
    expect(iss.mtval).toBe(0x800000);
  });

  it('U against the mode: U runs only U pages; S runs no U page, and loads from one only with SUM', () => {
    // U accessing a supervisor page
    expect(trapOf(load, { 5: pte(9, V | R | W | A | D) }).info.trap!.cause).toBe(CAUSE.LOAD_PAGE);
    // S fetching from a U page: the code page itself
    const iss = machine();
    tables(iss, { 1: pte(1, V | R | X | U | A) });
    put(iss, 0x1000, 'nop');
    enter(iss, PRIV.S);
    expect(iss.step().trap!.cause).toBe(CAUSE.FETCH_PAGE);
    // S: code on a supervisor page, data on a U page
    const s = (sum: boolean) => {
      const m = machine();
      tables(m, { 1: pte(1, V | R | X | A), 5: pte(9, rw) });
      m.dmem[9 * 1024] = 5;
      put(m, 0x1000, `${load}\nj .`);
      enter(m, PRIV.S);
      m.sum = sum;
      m.run(6);
      return m;
    };
    expect(s(false).mcause).toBe(CAUSE.LOAD_PAGE);
    const withSum = s(true);
    expect(withSum.mcause).toBe(0);
    expect(withSum.x[10]).toBe(5);
  });

  it('MXR: a load from an execute-only page works only with it', () => {
    const xo = pte(9, V | X | U | A);
    expect(trapOf(load, { 5: xo }).info.trap!.cause).toBe(CAUSE.LOAD_PAGE);
    const { iss } = (() => {
      const m = machine();
      tables(m, { 1: pte(1, V | R | X | U | A), 5: xo });
      m.dmem[9 * 1024] = 6;
      put(m, 0x1000, `${load}\nj .`);
      enter(m, PRIV.U);
      m.mxr = true;
      m.run(6);
      return { iss: m };
    })();
    expect([iss.mcause, iss.x[10]]).toEqual([0, 6]);
  });

  it('access faults: a PTE or a final address at or above 2^32, or a table in I/O space; mtval is the virtual address', () => {
    const cases: [string, (m: ISS) => void, number, number][] = [
      ['root beyond 2^32', (m) => { m.satp = satpOf(0x300000); }, CAUSE.FETCH_ACCESS, 0x1000],
      ['leaf beyond 2^32', (m) => setPte(m, 0x1000 + 4 * 5, pte(0x100001, rw)), CAUSE.LOAD_ACCESS, 0x5000],
      ['table in I/O', (m) => setPte(m, 0, pte(0x80000, V)), CAUSE.FETCH_ACCESS, 0x1000],
    ];
    for (const [, setup, cause, tval] of cases) {
      const { iss, info } = trapOf(load, { 5: pte(9, rw) }, PRIV.U, setup);
      expect([info.trap!.cause, iss.mtval]).toEqual([cause, tval]);
    }
    // a store through a superpage to PA 2^32
    const m = machine();
    tables(m, { 1: pte(1, V | R | X | U | A) });
    setPte(m, 4 * 2, pte(0x100000, rw));
    put(m, 0x1000, 'li t0, 0x800000\nsw a0, 0(t0)');
    enter(m, PRIV.U);
    const info = runTrap(m);
    expect([info.trap!.cause, m.mtval]).toEqual([CAUSE.STORE_ACCESS, 0x800000]);
  });

  it('a page-fault walk is recorded: lastWalk and StepInfo.walks', () => {
    const { iss, info } = trapOf(load, { 5: 0 });
    expect(iss.lastWalk!.fault).toBe(13);
    expect(info.walks!.map((w) => w.access)).toEqual(['fetch', 'load']);
    expect(info.priv).toBe(PRIV.U);
    expect(info.trap!.tval).toBe(0x5000);
  });

  it('bare satp (MODE 0): S and U see physical addresses', () => {
    const iss = machine();
    put(iss, 0x1000, 'li t0, 0x2000\nlw a0, 0(t0)\nj .');
    iss.dmem[0x2000 >>> 2] = 9;
    iss.priv = PRIV.U;
    iss.pc = 0x1000;
    iss.run(5);
    expect(iss.x[10]).toBe(9);
  });
});

describe('privilege', () => {
  it('ecall: cause 8 from U, 9 from S, 11 from M; the mode is saved in MPP', () => {
    for (const [priv, cause] of [[PRIV.U, 8], [PRIV.S, 9], [PRIV.M, 11]] as const) {
      const iss = machine();
      put(iss, 0x1000, 'ecall');
      iss.priv = priv;
      iss.pc = 0x1000;
      const info = iss.step();
      expect(info.trap!.cause).toBe(cause);
      expect([iss.priv, iss.mpp]).toEqual([PRIV.M, priv]);
    }
  });

  it('CSRs above the mode are illegal instructions; an S CSR is fine in S, not in U; counters need M', () => {
    const run = (priv: number, src: string) => {
      const iss = machine();
      put(iss, 0x1000, src);
      iss.priv = priv;
      iss.pc = 0x1000;
      return iss.step();
    };
    expect(run(PRIV.U, 'csrr t0, mstatus').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.U, 'csrr t0, sstatus').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.U, 'csrr t0, satp').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.S, 'csrr t0, mscratch').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.S, 'csrr t0, mhartid').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.S, 'csrr t0, sstatus').trap).toBeUndefined();
    expect(run(PRIV.S, 'csrw sscratch, t0').trap).toBeUndefined();
    expect(run(PRIV.M, 'csrr t0, mstatus').trap).toBeUndefined();
    expect(run(PRIV.U, 'csrr t0, cycle').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.S, 'csrr t0, cycle').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.M, 'csrr t0, cycle').trap).toBeUndefined();
    // a write to a read-only CSR is illegal even in M; a read (csrr, or a set with x0) is not
    expect(run(PRIV.M, 'csrw mhartid, t0').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.M, 'csrr t0, mhartid').trap).toBeUndefined();
    expect(run(PRIV.M, 'csrrs t0, mhartid, zero').trap).toBeUndefined();
  });

  it('mret, sret, sfence.vma and wfi by mode', () => {
    const run = (priv: number, src: string, setup?: (i: ISS) => void) => {
      const iss = machine();
      put(iss, 0x1000, src);
      iss.priv = priv;
      iss.pc = 0x1000;
      setup?.(iss);
      return { iss, info: iss.step() };
    };
    expect(run(PRIV.S, 'mret').info.trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.U, 'mret').info.trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.U, 'sret').info.trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.U, 'sfence.vma').info.trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.U, 'wfi').info.trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run(PRIV.S, 'sfence.vma zero, zero').info.trap).toBeUndefined();
    expect(run(PRIV.M, 'sfence.vma t0, t1').info.trap).toBeUndefined();
    expect(run(PRIV.S, 'wfi').info.trap).toBeUndefined();
    // sret: to SPP, SIE <- SPIE, SPIE <- 1, SPP <- U, pc <- sepc
    const r = run(PRIV.S, 'sret', (i) => { i.sepc = 0x1230; i.spp = false; i.spie = true; });
    expect([r.iss.priv, r.iss.pc, r.iss.sie, r.iss.spie, r.iss.spp]).toEqual([PRIV.U, 0x1230, true, true, false]);
    const r2 = run(PRIV.M, 'sret', (i) => { i.sepc = 0x1230; i.spp = true; });
    expect(r2.iss.priv).toBe(PRIV.S);
  });

  it('mret goes to MPP and leaves MPP = U; MPP is WARL (2 reads back as U); sstatus is a view of mstatus', () => {
    const iss = machine();
    put(iss, 0x1000, `li t0, ${(PRIV.S << 11) | 0x20 | 0x40000}\ncsrw mstatus, t0\nli t1, 0x2000\ncsrw mepc, t1\ncsrr a0, mstatus\ncsrr a1, sstatus\nmret`);
    iss.priv = PRIV.M;
    iss.pc = 0x1000;
    iss.run(8);
    expect(iss.x[10]).toBe((1 << 11) | 0x20 | 0x40000 | 0x80 * 0); // MPP = S, SPIE, SUM
    expect(iss.x[11]).toBe(0x20 | 0x40000);
    expect([iss.priv, iss.pc, iss.mpp]).toEqual([PRIV.S, 0x2000, PRIV.U]);
    expect(iss.mpie).toBe(true);
    iss.priv = PRIV.M;
    iss.csrRead(CSRS.mstatus);
    iss.pc = 0x1000;
    put(iss, 0x1000, 'li t0, 0x1000\ncsrw mstatus, t0\ncsrr a0, mstatus');
    iss.run(3);
    expect(iss.x[10]).toBe(0); // MPP = 2 (reserved) became U
  });

  it('an interrupt in U (MIE clear) is taken, with MPP = U; in M it waits for MIE', () => {
    const mk = (priv: number) => {
      const iss = machine();
      put(iss, 0x1000, 'l: addi t0, t0, 1\nj l');
      iss.mtie = true;
      iss.mtimecmp = 3;
      iss.priv = priv;
      iss.pc = 0x1000;
      return iss;
    };
    const u = mk(PRIV.U);
    let info!: StepInfo;
    for (let i = 0; i < 10 && !info?.trap; i++) info = u.step();
    expect(info.trap).toMatchObject({ cause: CAUSE.TIMER_IRQ, interrupt: true });
    expect([u.priv, u.mpp, u.mie, u.mpie]).toEqual([PRIV.M, PRIV.U, false, false]);
    const m = mk(PRIV.M);
    for (let i = 0; i < 10; i++) m.step();
    expect(m.mcause).toBe(0);
    m.mie = true;
    expect(m.step().trap!.cause).toBe(CAUSE.TIMER_IRQ);
    expect(m.mpp).toBe(PRIV.M);
  });

  it('from M to U to a handler and back: boot code, mret, ecall, mret again', () => {
    const iss = machine();
    iss.mtvec = 0x100;
    // boot (M): a handler address, user entry, mret
    put(iss, 0, `li t0, 0x100\ncsrw mtvec, t0\nli t0, 0x1000\ncsrw mepc, t0\nli t0, ${satpOf(0)}\ncsrw satp, t0\nmret`);
    // handler: record the cause, skip the ecall, return
    put(iss, 0x100, 'csrr t3, mcause\ncsrr t4, mepc\naddi t4, t4, 4\ncsrw mepc, t4\nmret');
    put(iss, 0x1000, 'li a0, 41\naddi a0, a0, 1\necall\naddi a1, a0, 1\nj .');
    tables(iss, { 1: pte(1, V | R | X | U | A) });
    iss.run(40);
    expect([iss.x[10], iss.x[11], iss.x[28]]).toEqual([42, 43, 8]);
    expect(iss.priv).toBe(PRIV.U);
  });
});

describe('the option off changes nothing', () => {
  it('without vm: mstatus reads MPP = 11, sret / sfence.vma are illegal, the new CSRs do not exist, ecall is 11', () => {
    const run = (src: string) => {
      const iss = new ISS(assemble(src).words, { system: true });
      return iss.step();
    };
    expect(run('csrr t0, mstatus').trap).toBeUndefined();
    const iss = new ISS(assemble('csrr a0, mstatus\ncsrw mstatus, zero\ncsrr a1, mstatus\necall').words, { system: true });
    iss.run(3);
    expect([iss.x[10], iss.x[11]]).toEqual([0x1800, 0x1800]);
    expect(iss.step().trap!.cause).toBe(11);
    expect(iss.priv).toBe(PRIV.M);
    expect(run('sret').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run('sfence.vma').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run('csrr t0, satp').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run('csrr t0, sstatus').trap!.cause).toBe(CAUSE.ILLEGAL);
    expect(run('csrw mhartid, t0').trap).toBeUndefined(); // the old behaviour: a write to a read-only CSR is ignored
    expect(() => new ISS([], { vm: true })).toThrow();
    expect(new ISS([], { system: true }).csrRead(CSRS.misa)).toBe(0x40000100);
  });

  it('save and restore cover the new state', () => {
    const iss = machine();
    tables(iss, { 1: pte(1, V | R | X | U | A) });
    put(iss, 0x1000, 'addi a0, a0, 1\necall\nj .');
    enter(iss, PRIV.U);
    iss.spp = true; iss.sum = true; iss.sscratch = 7; iss.stvec = 0x40;
    const s = iss.save();
    iss.run(5);
    expect(iss.priv).toBe(PRIV.M);
    iss.restore(s);
    expect([iss.priv, iss.pc, iss.sum, iss.sscratch, iss.satp, iss.mpp]).toEqual([PRIV.U, 0x1000, true, 7, satpOf(0), PRIV.U]);
    iss.run(2);
    expect(iss.mcause).toBe(8);
  });
});

describe('encodings', () => {
  it('sret, sfence.vma and the supervisor CSRs assemble, decode and disassemble', () => {
    const w = assemble('sret\nsfence.vma\nsfence.vma a0, a1\ncsrw satp, t0\ncsrr t1, sstatus').words;
    expect(w[0]).toBe(0x10200073);
    expect(w[1]).toBe(0x12000073);
    expect(w[2]).toBe(0x12b50073);
    expect(decode(w[0]).name).toBe('sret');
    expect(decode(w[2]).name).toBe('sfence.vma');
    expect(disasm(w[0])).toBe('sret');
    expect(disasm(w[2])).toBe('sfence.vma a0, a1');
    expect(disasm(w[3])).toBe('csrrw zero, satp, t0');
    expect(disasm(w[4])).toBe('csrrs t1, sstatus, zero');
    expect(CSRS.satp).toBe(0x180);
    expect(CSRS.sstatus).toBe(0x100);
  });
});

describe('the vm oracle programs', () => {
  it('boot in M, drop to U or S, reach the halt through the final ecall, and meet every kind of fault', () => {
    const cfg = ORACLE_CONFIGS.find((c) => c.id === 'vm')!;
    const seen = new Set<string>();
    let sMode = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const c = oracleCase(cfg, seed);
      const iss = oracleIss(c);
      const modes = new Set<number>();
      let n = 0;
      for (; iss.pc !== CODE + c.halt && n < 20000; n++) {
        const info = iss.step();
        modes.add(info.priv!);
        if (info.trap) seen.add(`${info.priv}:${info.trap.cause}`);
      }
      expect(iss.pc, `seed ${seed}`).toBe(CODE + c.halt);
      expect(iss.priv).toBe(PRIV.M);
      if (modes.has(PRIV.S)) sMode++;
      expect(modes.has(PRIV.S) && modes.has(PRIV.U)).toBe(false);
      // Spike-format self log agrees with the model
      expect(compareWithSpike(c, parseSpikeLog(issAsSpikeLog(c))).diff, `seed ${seed}`).toBe('');
    }
    expect(sMode).toBeGreaterThan(5);
    for (const k of ['0:12', '0:13', '0:15', '0:8', '0:2', '0:5', '0:7', '0:1', '1:13', '1:15', '1:9', '1:12']) expect(seen, k).toContain(k);
  });
});
