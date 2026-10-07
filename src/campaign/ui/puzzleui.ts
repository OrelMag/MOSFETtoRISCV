// A program puzzle in the level panel: the RV16 code editor (source saved as typed), Run tests
// (a table of every test with why it failed), and a stepper over one test on the golden model
// (registers, the current line, outputs). A pass records size and cycles.

import { h, icon } from '../../ui/dom';
import { codeEditor } from '../../widgets/codeedit';
import { assemble16, type AsmResult16 } from '../../riscv/rv16/asm16';
import { REG_NAMES16 } from '../../riscv/rv16/isa16';
import { Iss16 } from '../../riscv/rv16/iss16';
import { progress } from '../progress';
import { PUZZLES, runPuzzle } from '../puzzles';
import type { CampaignNode } from '../types';

const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;

export function puzzleCard(n: CampaignNode): HTMLElement {
  const p = PUZZLES[n.id];
  if (!p) return h('p', { class: 'sub' }, 'Unknown puzzle.');
  const pr = progress();
  let timer = 0;
  const ed = codeEditor({
    value: pr.get(n.id)?.src ?? p.starter, lang: 'rv16asm', rows: 16,
    onChange: (v) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        pr.setSource(n.id, v);
        diagnose();
      }, 300);
    },
  });
  const result = h('div', { class: 'cp-pz-result', role: 'status', 'aria-live': 'polite' });
  const dbg = h('div', { class: 'cp-pz-dbg' });
  let asm: AsmResult16 = assemble16(ed.value);
  const diagnose = () => {
    asm = assemble16(ed.value);
    ed.setDiagnostics(asm.errors);
  };
  diagnose();

  const runTests = () => {
    diagnose();
    const r = runPuzzle(p, ed.value);
    if (r.errors.length) {
      result.className = 'cp-pz-result bad';
      result.replaceChildren(h('b', null, 'Does not assemble: '), `line ${r.errors[0].line}: ${r.errors[0].message}`);
      return;
    }
    result.className = `cp-pz-result ${r.ok ? 'ok' : 'bad'}`;
    const rows = r.results.map((t) => h('tr', { class: t.ok ? 'ok' : 'bad' },
      h('td', null, t.ok ? icon('check', 13) : icon('close', 13)), h('td', null, t.name), h('td', { class: 'n' }, `${t.steps}`), h('td', null, t.why ?? '')));
    const head = r.ok ? (() => {
      const g = pr.solve(n.id, { size: r.size, cycles: r.cycles });
      return h('p', null, h('b', null, icon('check', 14), ' All tests pass '), `${'★'.repeat(g.stars)}${'☆'.repeat(3 - g.stars)} · ${r.size} words · ${r.cycles} cycles on average${g.best && !g.first ? ' (new best)' : ''}`);
    })() : h('p', null, h('b', null, `${r.results.filter((t) => !t.ok).length} of ${r.results.length} tests fail`), ` · ${r.size} words`);
    result.replaceChildren(head, h('table', { class: 'cp-pz-tests' }, h('tr', null, h('th'), h('th', null, 'Test'), h('th', null, 'Steps'), h('th')), rows));
  };

  // ---- the stepper ----
  const tests = p.tests();
  const sel = h('select', { 'aria-label': 'Test to step through' }, tests.map((t, i) => h('option', { value: String(i) }, t.name))) as HTMLSelectElement;
  let iss: Iss16 | null = null;
  let irqs = new Set<number>();
  const reset = () => {
    diagnose();
    if (asm.errors.length) {
      iss = null;
      return show(`Does not assemble (line ${asm.errors[0].line}).`);
    }
    const t = tests[Number(sel.value)];
    const data = new Map(asm.data);
    for (const [k, v] of Object.entries(t.mem ?? {})) data.set(Number(k), v);
    iss = new Iss16(asm.words, { m: p.m, system: p.system }, data);
    iss.input = [...(t.input ?? [])];
    iss.switches = t.switches ?? 0;
    irqs = new Set(t.irqAt ?? []);
    show();
  };
  const step = (k: number) => {
    if (!iss) reset();
    if (!iss) return;
    for (let i = 0; i < k && !iss.halted; i++) {
      if (irqs.has(iss.steps)) iss.irq = 1;
      iss.step();
    }
    show();
  };
  const show = (msg?: string) => {
    if (!iss) {
      ed.setActiveLine(null);
      dbg.replaceChildren(h('p', { class: 'sub' }, msg ?? ''));
      return;
    }
    const line = asm.lines.find((l) => l.addr === iss!.pc)?.srcLine ?? null;
    ed.setActiveLine(iss.halted ? null : line);
    const t = tests[Number(sel.value)];
    dbg.replaceChildren(
      h('p', { class: 'sub' }, iss.error ? `Stopped: ${iss.error}` : iss.halted ? `Halted after ${iss.steps} instructions.` : `pc = ${hex(iss.pc)} · ${iss.steps} instructions so far`),
      h('div', { class: 'cp-pz-regs' }, [...iss.x].map((v, i) => h('span', null, h('i', null, REG_NAMES16[i]), hex(v), h('small', null, String((v << 16) >> 16))))),
      h('p', { class: 'cp-pz-io' }, h('b', null, 'OUT '), iss.out.join(', ') || '—', iss.console ? [h('b', null, ' · console '), `"${iss.console}"`] : null,
        t.expect.out ? [h('b', null, ' · expected '), t.expect.out.map((v) => v & 0xffff).join(', ')] : null,
        t.expect.console !== undefined ? [h('b', null, ' · expected '), `"${t.expect.console}"`] : null));
  };
  sel.addEventListener('change', reset);

  const card = h('div', { class: 'cp-puzzle' },
    ed.el,
    h('div', { class: 'cp-pz-bar' },
      h('button', { class: 'btn sm primary', onclick: runTests }, icon('play', 13), 'Run the tests'),
      h('button', { class: 'btn sm ghost', title: 'Back to the starter code', onclick: () => {
        if (!confirm('Replace your code with the starter?')) return;
        ed.value = p.starter;
        pr.setSource(n.id, p.starter);
        diagnose();
      } }, 'Reset'),
      h('button', { class: 'btn sm ghost', title: 'Replace your code with the reference solution', onclick: () => {
        if (!confirm('Replace your code with the reference solution?')) return;
        ed.value = p.ref;
        pr.setSource(n.id, p.ref);
        diagnose();
      } }, 'Show solution')),
    result,
    h('details', { class: 'cp-pz-step' }, h('summary', null, 'Step through a test'),
      h('div', { class: 'cp-pz-bar' }, sel,
        h('button', { class: 'btn sm', onclick: () => reset() }, icon('reset', 13), 'Restart'),
        h('button', { class: 'btn sm', onclick: () => step(1) }, icon('step', 13), 'Step'),
        h('button', { class: 'btn sm', onclick: () => step(p.maxSteps) }, icon('play', 13), 'Run')),
      dbg));
  return card;
}
