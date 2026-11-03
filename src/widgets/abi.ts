// Chapter 13's pseudo-instructions and calling convention, generated from the assembler and the ISA tables:
// nothing in the expansion table is typed in.

import { assemble } from '../riscv/asm';
import { ABI, disasm } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

/** Pseudo-instructions with a label L two words ahead (so the offsets read as +8 and the like). */
export const PSEUDOS = [
  'li t0, 5', 'li t0, 0x12345', 'li t0, 0x12345000', 'mv a0, a1', 'not a0, a1', 'neg a0, a1', 'seqz a0, a1', 'snez a0, a1',
  'beqz a0, L', 'bgt a0, a1, L', 'j L', 'jr ra', 'ret', 'call L', 'tail L', 'la a0, L', 'nop',
];

/** What a line assembles to: its machine instructions, as the assembler emits them. */
export function expand(line: string): { words: string[]; error?: string } {
  const r = assemble(`${line}\nL: nop`);
  if (r.errors.length) return { words: [], error: r.errors[0].message };
  return { words: r.lines.filter((l) => l.srcLine === 1).map((l) => disasm(l.word, l.addr)) };
}

export function pseudoWidget(): Widget {
  const row = (line: string) => {
    const e = expand(line);
    return h('tr', null, h('td', null, h('code', null, line)), h('td', null, e.error ? h('span', { class: 'asm-errors' }, e.error) : h('code', null, e.words.join('  ;  '))),
      h('td', { class: 'r' }, e.error ? '' : `${4 * e.words.length} B`));
  };
  const body = h('tbody', null, PSEUDOS.map(row));
  const input = h('input', { type: 'text', value: 'li a0, 100000', 'aria-label': 'a line to expand', class: 'asm-try', spellcheck: 'false' }) as HTMLInputElement;
  const out = h('div', { class: 'sub' });
  const show = () => {
    const e = expand(input.value);
    out.textContent = e.error ? e.error : `${e.words.length} instruction${e.words.length > 1 ? 's' : ''}: ${e.words.join('  ;  ')}`;
  };
  input.addEventListener('input', show);
  show();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'Assembly lines and what they become'),
      h('table', { class: 'mini abi-tab' }, h('thead', null, h('tr', null, h('th', null, 'you write'), h('th', null, 'the assembler emits'), h('th', null, 'size'))), body),
      h('p', { class: 'sub' }, 'A label L two words ahead. Try your own line:'), input, out)),
  };
}

/** The register roles, 32 registers in the groups the calling convention defines. */
export const ABI_GROUPS: { name: string; regs: string[]; who: string }[] = [
  { name: 'arguments, results', regs: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'], who: 'caller-saved' },
  { name: 'temporaries', regs: ['t0', 't1', 't2', 't3', 't4', 't5', 't6'], who: 'caller-saved' },
  { name: 'return address', regs: ['ra'], who: 'caller-saved' },
  { name: 'saved', regs: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'], who: 'callee-saved' },
  { name: 'stack pointer', regs: ['sp'], who: 'callee-saved' },
  { name: 'zero, global, thread', regs: ['zero', 'gp', 'tp'], who: 'fixed' },
];

/** Registers as runs of consecutive numbers: "a0–a7 (x10–x17)". */
export function regRuns(regs: string[]): string[] {
  const idx = regs.map((r) => ABI.indexOf(r)).sort((a, b) => a - b), runs: number[][] = [];
  for (const i of idx) { const last = runs[runs.length - 1]; if (last && i === last[last.length - 1] + 1 && ABI[i][0] === ABI[last[0]][0] && ABI[i] !== 'zero') last.push(i); else runs.push([i]); }
  return runs.map((r) => (r.length === 1 ? `${ABI[r[0]]} (x${r[0]})` : `${ABI[r[0]]}–${ABI[r[r.length - 1]]} (x${r[0]}–x${r[r.length - 1]})`));
}

export const abiTable = () => `<table class="mini"><tr><th>role</th><th>registers</th><th>preserved by</th></tr>${ABI_GROUPS.map((g) =>
  `<tr><td>${g.name}</td><td>${regRuns(g.regs).map((r) => `<code>${r}</code>`).join(', ')}</td><td>${g.who}</td></tr>`).join('')}</table>`;

/** The chapter's recursive example: sum(n) = n + sum(n − 1), a frame of 16 bytes holding ra and s0. */
export const SUM_CALLS = `        li   sp, 128       # the stack starts at the top of the 128-byte data memory
        li   a0, 3         # argument: n
        call sumto         # result comes back in a0
        sw   a0, 0(zero)
halt:   j    halt

# sumto(n) = n + sumto(n - 1), sumto(0) = 0
sumto:  addi sp, sp, -16   # open a frame (sp stays 16-byte aligned)
        sw   ra, 12(sp)    # a call overwrites ra: save it
        sw   s0, 8(sp)     # s0 is ours to use only if we restore it
        mv   s0, a0        # keep n across the call
        beqz a0, base
        addi a0, a0, -1
        call sumto
        add  a0, a0, s0    # n + sumto(n - 1)
        j    done
base:   li   a0, 0
done:   lw   s0, 8(sp)
        lw   ra, 12(sp)
        addi sp, sp, 16    # close the frame
        ret`;

/** The example run on the golden model for sumto(n): instructions, stack depth in bytes, result, and the words left in memory. */
export function sumRun(n: number) {
  const iss = new ISS(assemble(SUM_CALLS.replace('li   a0, 3 ', `li   a0, ${n} `)).words);
  let steps = 0, low = 128;
  while (!iss.halted && steps < 1000) { iss.step(); steps++; low = Math.min(low, iss.x[2]); }
  return { instrs: steps, depth: 128 - low, result: iss.dmem[0], mem: [...iss.dmem].map((v, k) => [k * 4, v] as const).filter(([a, v]) => v && a >= low) };
}
export const SUM_RUN = sumRun(3);
