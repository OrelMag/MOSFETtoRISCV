// Appendix F's instruction-set widget: an AGC program in the assembler's language (agc/asm.ts) on the golden model
// (agc/iss.ts, checked against yaAGC in CI), step by step: the registers in octal, the program's erasable words, the
// last instructions with the memory cycles each took, and the time at 11.7 µs a cycle (R-700 Table 2-1).

import { AgcAsmError, assembleAgc, type AgcProgram } from '../agc/asm';
import { AgcISS, type AgcStep } from '../agc/iss';
import { val15, val16 } from '../agc/word';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/agc.css';

/** One memory cycle (MCT), µs: R-700 vol. III Table 2-1 gives 11.7 µs for Block II. */
export const MCT_US = 11.7;

/** The chapter's program: the sum of a table, with CCS counting down, the AGC's loop. */
export const AGC_SUM_SOURCE = `# The sum of a table of five words: CCS counts down, INDEX picks the word.
COUNT   = 61            # erasable words for the counter and the sum
SUM     = 62
        SETLOC 4000     # fixed-fixed memory, where the AGC starts
        INHINT          # no interrupts
        CA      FOUR    # COUNT = 4: the table's last word first
        TS      COUNT
        CA      ZERO
        TS      SUM
LOOP    INDEX   COUNT   # add COUNT to the next instruction's address
        CA      TABLE
        AD      SUM
        TS      SUM
        CCS     COUNT   # COUNT > 0: A = COUNT - 1, go on; +0: skip one
        TCF     NEXT
        TCF     DONE
NEXT    TS      COUNT
        TCF     LOOP
DONE    TCF     DONE    # a jump to itself: the end
FOUR    DEC     4
TABLE   DEC     30
        DEC     -12
        DEC     7
        DEC     100
        DEC     -1
`;

const oct = (v: number, n: number) => v.toString(8).padStart(n, '0');

export function agcRunWidget(source = AGC_SUM_SOURCE): Widget {
  const src = h('textarea', { class: 'agc-src', spellcheck: 'false', rows: 18, 'aria-label': 'AGC program' }) as HTMLTextAreaElement;
  src.value = source;
  const msg = h('p', { class: 'agc-msg', 'aria-live': 'polite' });
  const regs = h('div', { class: 'agc-regs' });
  const vars = h('div', { class: 'agc-vars' });
  const trace = h('table', { class: 'data agc-trace' });
  let prog: AgcProgram | null = null, m: AgcISS | null = null, last: AgcStep[] = [], halted = false;

  const load = () => {
    try {
      prog = assembleAgc(src.value); m = new AgcISS(prog.fixed); last = []; halted = false;
      msg.textContent = `Assembled: ${prog.listing.length} words of fixed memory. Step, or run to the end.`;
      msg.classList.remove('bad');
    } catch (e) {
      prog = null; m = null;
      msg.textContent = e instanceof AgcAsmError ? `Line ${e.line}: ${e.message.replace(/^line \d+: /, '')}` : String(e);
      msg.classList.add('bad');
    }
    paint();
  };
  const step = (n: number) => {
    if (!m || halted) return;
    try {
      for (let i = 0; i < n && !halted; i++) {
        const z = m.z, s = m.step();
        last.push(s); if (last.length > 12) last.shift();
        if ((s.name === 'TCF' || s.name === 'TC') && m.z === z) halted = true;
      }
      if (halted) msg.textContent = `Halted: a jump to itself at ${oct(m.z, 4)}. ${m.steps} instructions, ${m.mct} memory cycles, ${(m.mct * MCT_US).toFixed(1)} µs.`;
    } catch (e) { msg.textContent = String((e as Error).message); msg.classList.add('bad'); halted = true; }
    paint();
  };

  const paint = () => {
    if (!m || !prog) { regs.replaceChildren(); vars.replaceChildren(); trace.replaceChildren(); return; }
    const cell = (name: string, v: string, title: string) => h('div', { title }, h('span', null, name), h('code', null, v));
    regs.replaceChildren(
      cell('Z', oct(m.z, 4), 'the address of the next instruction'),
      cell('A', `${oct(m.a, 6)} (${val16(m.a)})`, 'the accumulator: 16 bits, the top two the signs S2 and S1'),
      cell('L', `${oct(m.l, 6)} (${val16(m.l)})`, 'the lower accumulator'),
      cell('Q', oct(m.q, 6), 'the return address a TC leaves'),
      cell('instructions', String(m.steps), ''),
      cell('cycles', `${m.mct} = ${(m.mct * MCT_US).toFixed(1)} µs`, `memory cycles of ${MCT_US} µs`));
    vars.replaceChildren(...[...prog.symbols].filter(([, a]) => a >= 0o10 && a < 0o2000).map(([n, a]) =>
      h('div', null, h('span', null, `${n} (${oct(a, 4)})`), h('code', null, `${oct(m!.e[a], 5)} = ${val15(m!.e[a])}`))));
    const lineOf = (s: AgcStep) => prog!.listing.find((l) => l.addr === s.z)?.text ?? '';
    trace.replaceChildren(h('tr', null, h('th', null, 'Z'), h('th', null, 'word'), h('th', null, 'instruction'), h('th', null, 'MCT'), h('th', null, 'source')),
      ...last.map((s) => h('tr', null, h('td', null, oct(s.z, 4)), h('td', null, h('code', null, oct(s.word, 5))), h('td', null, (s.extra ? 'EXTEND · ' : '') + s.name), h('td', null, String(s.mct)), h('td', null, h('code', null, lineOf(s))))));
  };

  const btn = (label: string, f: () => void, title: string) => h('button', { type: 'button', class: 'btn sm', title, onclick: f }, label);
  const el = h('div', { class: 'widget agc-run' },
    h('div', { class: 'panel' }, h('h3', null, 'An AGC program, on the golden model'), src,
      h('div', { class: 'sb-btns' }, btn('Assemble and reset', load, 'assemble the text and start at 4000'), btn('Step', () => step(1), 'one instruction'),
        btn('Run to the end', () => step(100_000), 'until a jump to itself'), btn('Reset', load, 'back to the start')), msg),
    h('div', { class: 'panel' }, h('h3', null, 'Registers'), regs, h('h3', null, 'Erasable words'), vars, h('h3', null, 'The last instructions'), trace));
  load();
  return { el };
}
