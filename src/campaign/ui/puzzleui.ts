// A program puzzle in the level panel: the RV16 code editor (source saved as typed), Run tests
// (a table of every test with why it failed), and a stepper over one test on the golden model
// (registers, the current line, outputs). A pass records size and cycles. A kernel puzzle (lanes)
// steps the warp instead: every lane's registers in a column, the active mask, the stack depth and
// the lane utilization so far; its pass records idle lanes too. Two warps: both side by side, each
// with its PC, mask, stack and whether it waits at the barrier. With the rasterizer (p_spin): the 32 × 32
// screen, as the golden model left it, and the triangles drawn so far.

import { h, icon } from '../../ui/dom';
import { codeEditor } from '../../widgets/codeedit';
import { assemble16, type AsmResult16 } from '../../riscv/rv16/asm16';
import { REG_NAMES16 } from '../../riscv/rv16/isa16';
import { Iss16 } from '../../riscv/rv16/iss16';
import type { Simt16 } from '../../riscv/rv16/simt16';
import { Warps16 } from '../../riscv/rv16/warps16';
import { progress } from '../progress';
import { FB16, rgb565, SCREEN16 } from '../../gfx/raster16';
import { PUZZLES, puzzleMachine, puzzleUnit, runPuzzle } from '../puzzles';
import type { CampaignNode } from '../types';

const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;
const signed = (v: number) => String((v << 16) >> 16);

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
    const lanes = r.idle !== undefined;
    const rows = r.results.map((t) => h('tr', { class: t.ok ? 'ok' : 'bad' },
      h('td', null, t.ok ? icon('check', 13) : icon('close', 13)), h('td', null, t.name), h('td', { class: 'n' }, `${t.steps}`),
      lanes ? h('td', { class: 'n' }, `${t.idle ?? 0} %`) : null, h('td', null, t.why ?? '')));
    const head = r.ok ? (() => {
      const g = pr.solve(n.id, { size: r.size, cycles: r.cycles, ...(lanes ? { laneops: r.laneOps } : {}) });
      return h('p', null, h('b', null, icon('check', 14), ' All tests pass '),
        `${'★'.repeat(g.stars)}${'☆'.repeat(3 - g.stars)} · ${r.size} words · ${r.cycles} ${puzzleUnit(p)} on average${lanes ? ` · ${r.laneOps} lane-ops · ${r.idle} % idle lanes` : ''}${g.best && !g.first ? ' (new best)' : ''}`);
    })() : h('p', null, h('b', null, `${r.results.filter((t) => !t.ok).length} of ${r.results.length} tests fail`), ` · ${r.size} words`);
    result.replaceChildren(head, h('table', { class: 'cp-pz-tests' },
      h('tr', null, h('th'), h('th', null, 'Test'), h('th', null, puzzleUnit(p)[0].toUpperCase() + puzzleUnit(p).slice(1)),
        lanes ? h('th', { title: 'Lane-steps with the lane masked off' }, 'Idle') : null, h('th')), rows));
  };

  // ---- the stepper ----
  const tests = p.tests();
  const sel = h('select', { 'aria-label': 'Test to step through' }, tests.map((t, i) => h('option', { value: String(i) }, t.name))) as HTMLSelectElement;
  let mc: Iss16 | Simt16 | Warps16 | null = null;
  let irqs = new Set<number>();
  const reset = () => {
    diagnose();
    if (asm.errors.length) {
      mc = null;
      return show(`Does not assemble (line ${asm.errors[0].line}).`);
    }
    const t = tests[Number(sel.value)];
    mc = puzzleMachine(p, asm.words, asm.data, t);
    irqs = new Set(t.irqAt ?? []);
    show();
  };
  const step = (k: number) => {
    if (!mc) reset();
    if (!mc) return;
    for (let i = 0; i < k && !mc.halted; i++) {
      if (mc instanceof Iss16 && irqs.has(mc.steps)) mc.irq = 1;
      mc.step();
    }
    show();
  };
  const show = (msg?: string) => {
    if (!mc) {
      ed.setActiveLine(null);
      dbg.replaceChildren(h('p', { class: 'sub' }, msg ?? ''));
      return;
    }
    const pc = mc.pc;
    ed.setActiveLine(mc.halted ? null : asm.lines.find((l) => l.addr === pc)?.srcLine ?? null);
    const t = tests[Number(sel.value)];
    const what = mc instanceof Iss16 ? 'instructions' : mc instanceof Warps16 ? 'cycles' : 'warp instructions';
    const status = h('p', { class: 'sub' }, mc.error ? `Stopped: ${mc.error}` : mc.halted ? `Halted after ${mc.steps} ${what}.` : `pc = ${hex(mc.pc)} · ${mc.steps} ${what} so far`);
    const io = h('p', { class: 'cp-pz-io' }, h('b', null, 'OUT '), mc.out.join(', ') || '—',
      mc instanceof Iss16 && mc.console ? [h('b', null, ' · console '), `"${mc.console}"`] : null,
      t.expect.out ? [h('b', null, ' · expected '), t.expect.out.map((v) => v & 0xffff).join(', ')] : null,
      t.expect.console !== undefined ? [h('b', null, ' · expected '), `"${t.expect.console}"`] : null);
    if (mc instanceof Iss16) {
      dbg.replaceChildren(status,
        h('div', { class: 'cp-pz-regs' }, [...mc.x].map((v, i) => h('span', null, h('i', null, REG_NAMES16[i]), hex(v), h('small', null, signed(v))))),
        io);
      return;
    }
    // The warp: a column per lane; a masked-off lane is dimmed (its registers keep their values).
    // Two warps: their lanes side by side, headed by thread number.
    const ws: Simt16[] = mc instanceof Warps16 ? mc.warps : [mc];
    const many = mc instanceof Warps16 ? mc : null;
    const on = (w: Simt16, i: number) => ((w.mask >>> i) & 1) === 1;
    const cols = ws.flatMap((w) => w.lanes.map((_, i) => ({ w, i })));
    const info = ws.map((w, k) => {
      const parked = w.stack.filter((e) => e.pending).length;
      const state = !many ? null : w.halted ? (w.mask ? 'halted' : 'ended') : many.waiting[k] ? 'waits at bar' : many.next === k ? 'issues next' : null;
      return h('p', { class: 'cp-pz-io' },
        many ? [h('b', null, `warp ${k} `), `pc ${hex(w.pc)}${state ? ` (${state})` : ''} · `] : null,
        h('b', null, 'mask '), w.mask.toString(2).padStart(w.n, '0'),
        h('b', null, ' · stack '), `${w.stack.length} of ${w.depth}${parked ? ` (${parked} waiting)` : ''}`,
        many ? null : [h('b', null, ' · lanes busy '), `${Math.round(100 * w.utilization)} %`],
        w.divergences ? [h('b', null, ' · divergent branches '), String(w.divergences)] : null);
    });
    dbg.replaceChildren(status, ...info, ...(many && p.raster ? [screenOf(many)] : []),
      ...(many ? [h('p', { class: 'cp-pz-io' }, h('b', null, 'lanes busy '), `${Math.round(100 * many.utilization)} % of the issue slots’ lanes`)] : []),
      h('div', { class: 'cp-pz-lanes-wrap' }, h('table', { class: 'cp-pz-lanes' },
        h('tr', null, h('th'), cols.map(({ w, i }) => h('th', { class: on(w, i) ? 'on' : 'off', title: `${many ? `warp ${w.warp}, lane ${i}: ` : ''}${on(w, i) ? 'active' : 'masked off'}` },
          many ? `tid ${w.warp * w.n + i}` : `lane ${i}`))),
        REG_NAMES16.slice(1).map((r, k) => h('tr', null, h('th', null, r),
          cols.map(({ w, i }) => { const v = w.lanes[i].x[k + 1]; return h('td', { class: on(w, i) ? null : 'off', title: signed(v) }, hex(v)); }))))),
      io);
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
    h('details', { class: 'cp-pz-step' }, h('summary', null, p.warps ? 'Step through a test (the warps)' : p.lanes ? 'Step through a test (the warp)' : 'Step through a test'),
      h('div', { class: 'cp-pz-bar' }, sel,
        h('button', { class: 'btn sm', onclick: () => reset() }, icon('reset', 13), 'Restart'),
        h('button', { class: 'btn sm', onclick: () => step(1) }, icon('step', 13), 'Step'),
        h('button', { class: 'btn sm', onclick: () => step(p.maxSteps) }, icon('play', 13), 'Run')),
      dbg));
  return card;
}

/** The screen in the golden model's memory (0xF000 + 32·y + x, RGB565), and the triangles drawn so far. */
function screenOf(m: Warps16): HTMLElement {
  const cv = h('canvas', { class: 'cp-pz-screen', width: SCREEN16, height: SCREEN16, 'aria-label': 'the 32 by 32 screen' }) as HTMLCanvasElement;
  const ctx = cv.getContext('2d');
  if (ctx) {
    const im = ctx.createImageData(SCREEN16, SCREEN16);
    for (let i = 0; i < SCREEN16 * SCREEN16; i++) im.data.set([...rgb565(m.dmem[FB16 + i]), 255], 4 * i);
    ctx.putImageData(im, 0, 0);
  }
  return h('div', { class: 'cp-pz-screen-wrap' }, cv, h('p', { class: 'cp-pz-io' }, h('b', null, 'screen '), `0xF000 … 0xF3FF · ${m.draws.length} triangle${m.draws.length === 1 ? '' : 's'} drawn`));
}
