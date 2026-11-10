// The PDP-8 (src/pdp8): the instruction table (isa/presets.ts PDP8_PRESET) and the machine model, each instruction against
// what DEC's handbooks say it does, worked out by hand here; the classic program against the text it should print.

import { describe, expect, it } from 'vitest';
import { PDP8_PRESET } from '../src/isa/presets';
import { tableOf } from '../src/isa/table';
import { Pdp8 } from '../src/pdp8/pdp8';
import { assemblePdp8, PDP8_HELLO } from '../src/pdp8/programs';

const t = tableOf(PDP8_PRESET);
const asm = (src: string, org = 0o200) => {
  const r = t.assemble(`.org ${org.toString(8)}\n${src}`);
  if (r.errors.length) throw new Error(r.errors[0].message);
  return r.words;
};
/** A machine with `src` at 0200 (a HLT put in before its first data word), run from there until it halts. */
function run(src: string, setup: (m: Pdp8) => void = () => {}, n = 1000): Pdp8 {
  const lines = src.split('\n');
  const data = lines.findIndex((l) => l.includes('.word'));
  if (data < 0) lines.push(' HLT');
  else lines.splice(data, 0, ' HLT');
  const m = new Pdp8(asm(lines.join('\n')));
  m.pc = 0o200;
  setup(m);
  m.cont();
  m.runFor(n);
  return m;
}

describe('the PDP-8 table', () => {
  it('has no problems', () => expect(t.problems).toEqual([]));
  it('every word disassembles to text that assembles back to it, on two pages', () => {
    for (const pc of [0o200, 0o5600]) for (let w = 0; w < 4096; w++) {
      const r = t.assemble(`.org ${pc.toString(8)}\n${t.disasm(w, pc)}`);
      expect(r.errors, `${w.toString(8)} at ${pc.toString(8)}`).toEqual([]);
      expect(r.words[pc], `${w.toString(8)}: ${t.disasm(w, pc)}`).toBe(w);
    }
  });
  it('memory reference: the page bit from the target, I for indirect', () => {
    expect(asm('TAD 17')[0o200]).toBe(0o1017); // page zero
    expect(asm('TAD 250')[0o200]).toBe(0o1250); // this page: Z = 1, offset 050
    expect(asm('JMP I 10')[0o200]).toBe(0o5410);
    expect(asm('DCA I 377')[0o200]).toBe(0o3777);
    expect(() => asm('TAD 400')).toThrow(/neither on page zero nor on this page \(0200–0377\)/);
    expect(t.disasm(0o1250, 0o200)).toBe('TAD  0250');
    expect(t.disasm(0o1250, 0o4400)).toBe('TAD  4450');
  });
  it('operate microinstructions of one group share a line, OR\'ed', () => {
    expect(asm('CLA CLL')[0o200]).toBe(0o7300);
    expect(asm('CLA')[0o200]).toBe(0o7200);
    expect(asm('SMA CLA')[0o200]).toBe(0o7700);
    expect(asm('CLA SZA')[0o200]).toBe(0o7640);
    expect(asm('CMA IAC')[0o200]).toBe(0o7041);
    expect(asm('MQA MQL')[0o200]).toBe(0o7521);
    expect(() => asm('RAL SMA')).toThrow(/one group/);
    expect(t.disasm(0o7300)).toBe('CLL CLA');
    expect(t.disasm(0o7041)).toBe('CIA');
    expect(t.disasm(0o7600)).toBe('OPR  600'); // group 2's CLA alone: "CLA" would assemble to 7200
  });
  it('numbers are octal', () => {
    expect(asm('.word 777, 15')[0o200]).toBe(511);
    expect(() => asm('.word 18')).toThrow(/not an octal number/);
  });
});

describe('the PDP-8 model', () => {
  it('TAD adds into AC and a carry out complements L; AND masks', () => {
    let m = run('TAD a\n TAD b\na: .word 7777\nb: .word 2');
    expect([m.ac, m.l]).toEqual([0o7777 + 2 - 0o10000, 1]);
    m = run('TAD a\n AND b\na: .word 7070\nb: .word 0770');
    expect(m.ac).toBe(0o0070);
  });
  it('ISZ skips when the word wraps to 0; DCA stores and clears', () => {
    const m = run('ISZ c\n JMP no\n TAD one\n DCA d\nno: HLT\nc: .word 7777\none: .word 5\nd: .word 0');
    expect([m.mem[0o206], m.mem[0o210], m.ac]).toEqual([0, 5, 0]); // c and d, after the HLT run() puts in
  });
  it('JMS leaves the return address and goes on after it; JMP I returns through it', () => {
    const m = run('JMS sub\n TAD one\n HLT\nsub: .word 0\n IAC\n JMP I sub\none: .word 10');
    expect(m.mem[0o204]).toBe(0o201); // sub, after the HLT run() puts in
    expect(m.ac).toBe(0o11);
  });
  it('an indirect reference through 0010–0017 adds 1 to the pointer first; elsewhere not', () => {
    const words = asm('TAD I 10\n TAD I 20\n HLT');
    const m = new Pdp8(words);
    m.mem[0o10] = 0o300; m.mem[0o301] = 4;
    m.mem[0o20] = 0o302; m.mem[0o302] = 0o40;
    m.pc = 0o200; m.cont(); m.runFor(10);
    expect([m.mem[0o10], m.mem[0o20], m.ac]).toEqual([0o301, 0o302, 0o44]);
  });
  it('memory cycles: Fetch, Defer when indirect, Execute but for JMP', () => {
    const cycles = (src: string) => { const m = new Pdp8(asm(src)); m.mem[0o20] = 0o300; m.pc = 0o200; return m.step().cycles; };
    expect([cycles('TAD 300'), cycles('TAD I 20'), cycles('JMP 300'), cycles('JMP I 20'), cycles('JMS 300'), cycles('CLA'), cycles('TLS')]).toEqual([2, 3, 1, 2, 2, 1, 1]);
  });
  it('group 1 acts in order: CLA CLL, CMA CML, IAC, then the rotate', () => {
    expect(run('CLA CMA IAC').ac).toBe(0); // 0 → 7777 → 0000 (the carry out flips L)
    expect(run('CLA CMA IAC').l).toBe(1);
    expect(run('TAD a\n STL RAL\na: .word 4001').ac).toBe(0o0003); // L:AC = 1:4001 → 1:0003 after one left (L gets 1)
    expect(run('TAD a\n CLL RTR\na: .word 0003').ac).toBe(0o4000); // L:AC 0:0003, two right: 1:4000 (the low 1s go round through L)
    expect(run('TAD a\n BSW\na: .word 1234').ac).toBe(0o3412);
  });
  it('group 2: OR of SMA / SZA / SNL, AND of the reversed ones, then CLA, OSR, HLT', () => {
    const skips = (setup: string, op: string) => run(`${setup}\n ${op}\n JMP no\n IAC\nno: HLT\nneg: .word 4000\nz: .word 0`).ac;
    expect(skips('TAD neg', 'SMA')).toBe(0o4001);
    expect(skips('TAD z', 'SMA')).toBe(0);
    expect(skips('TAD z', 'SZA')).toBe(1);
    expect(skips('TAD neg', 'SPA')).toBe(0o4000);
    expect(skips('TAD z', 'SPA SNA')).toBe(0); // AC = 0: SNA fails, no skip
    expect(skips('TAD z', 'SKP')).toBe(1);
    expect(run('TAD neg\n SMA CLA\n HLT\n IAC\nneg: .word 4000').ac).toBe(1); // tested before cleared: skipped, then IAC
    expect(run('CLA OSR', (m) => { m.sr = 0o5252; }).ac).toBe(0o5252);
  });
  it('group 3: MQL, MQA, SWP', () => {
    expect(run('TAD a\n MQL\n TAD b\n MQA\na: .word 70\nb: .word 7').ac).toBe(0o77);
    const m = run('TAD a\n MQL\n TAD b\n SWP\na: .word 70\nb: .word 7');
    expect([m.ac, m.mq]).toEqual([0o70, 0o7]);
  });
  it('the teletype: TLS prints and raises the flag, TSF skips on it, KRB reads a key', () => {
    const m = run('TAD c\n TLS\n TSF\n JMP .\n KSF\n JMP no\n KRB\nno: HLT\nc: .word 101', (x) => x.type('Z'));
    expect(m.out).toBe('A');
    expect(m.ac).toBe(0o200 | 0o132);
  });
  it('ION: an interrupt is a JMS 0, taken after the instruction that follows ION', () => {
    const m = new Pdp8(asm('TLS\n ION\n IAC\n IAC\n HLT'));
    m.mem[1] = 0o7402; // HLT at 0001
    m.pc = 0o200; m.cont(); m.runFor(20);
    expect([m.pc, m.mem[0], m.ac]).toEqual([2, 0o203, 1]);
  });
  it('the front panel: LOAD ADD, DEP, EXAM', () => {
    const m = new Pdp8();
    m.sr = 0o200; m.loadAddress();
    m.sr = 0o7001; m.deposit();
    m.sr = 0o7402; m.deposit();
    m.sr = 0o200; m.loadAddress(); m.examine();
    expect([m.mem[0o200], m.mem[0o201], m.mb, m.pc]).toEqual([0o7001, 0o7402, 0o7001, 0o201]);
    m.sr = 0o200; m.loadAddress(); m.start(); m.runFor(10);
    expect([m.ac, m.run]).toEqual([1, false]);
  });
});

describe('Hello, world', () => {
  it('prints its text, halts, and CONT prints it again', () => {
    const a = assemblePdp8(PDP8_HELLO.src);
    expect(a.errors).toEqual([]);
    const m = new Pdp8(a.words);
    m.sr = PDP8_HELLO.start; m.loadAddress(); m.start(); m.runFor(10_000);
    expect(m.out).toBe(PDP8_HELLO.prints);
    expect(m.run).toBe(false);
    m.cont(); m.runFor(10_000);
    expect(m.out).toBe(PDP8_HELLO.prints.repeat(2));
  });
});
