// The verification half of the chapter "How do you know it works?": the ladder of checks, the official riscv-tests run
// in the page, random programs against the golden model (with a real bug planted back), shrinking a failure, coverage,
// and what this repository's checks found. Every number on these panels is computed here, from the same machinery CI
// runs (src/verify/*, held to tests/verify by tests/verify-browser.test.ts).

import { pipelinedCpu } from '../lib/pipeline';
import { disasm } from '../riscv/isa';
import { loadable } from '../riscv/rvimage';
import { PROGRAMS } from '../riscv/programs';
import { groupDigits } from '../sim/numfmt';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { coverProgram, coverRandom, coverRiscvTests, EVENTS, RV32I_WORD, reached, type CoverageReport } from '../verify/coverage';
import { FOUND, LAYERS } from '../verify/data';
import { firstDivergence, fuzzBatch, fuzzCase, shrink, type Verdict } from '../verify/fuzz';
import { FP_PIPE, FP_PIPE_WITH_BUG, SLT_FAULT, withFault } from '../verify/planted';
import { runRv32ui, rv32uiImages, type RvTestResult } from '../verify/rvtests';
import '../styles/verify.css';

const panel = (title: string, sub: string, ...kids: (Node | string)[]) => h('div', { class: 'widget' }, h('div', { class: 'panel vf' }, h('h3', null, title), h('p', { class: 'sub' }, sub), ...kids));
const btn = (label: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls }, label); b.addEventListener('click', f); return b; };
const n0 = (n: number) => groupDigits(n);

/** Step 1: every layer of checking this repository runs, what its oracle is, what it finds and what it cannot. */
export function verifyMap(): Widget {
  const rows = LAYERS.map((l, i) => h('tr', null,
    h('th', null, h('span', { class: 'vf-rung' }, String(i + 1)), l.name),
    h('td', null, l.oracle), h('td', null, l.finds), h('td', { class: 'vf-miss' }, l.misses), h('td', { class: 'vf-where' }, l.where)));
  return {
    el: panel('The ladder of checks', 'Each rung answers "is it right?" with a different oracle: something other than the circuit that says what the right answer is.',
      h('div', { class: 'vf-wrap' }, h('table', { class: 'vf-table' },
        h('thead', null, h('tr', null, h('th', null, 'Check'), h('th', null, 'Oracle'), h('th', null, 'Finds'), h('th', null, 'Cannot find'), h('th', null, 'Runs'))),
        h('tbody', null, ...rows)))),
  };
}

/** Step 3: the rv32ui tests on the pipelined CPU, healthy or with the set-less-than bit stuck at 0. */
export function riscvTestsWidget(): Widget {
  let fault = false, running: { aborted: boolean } | null = null;
  const grid = h('div', { class: 'vf-grid' });
  const status = h('div', { class: 'vf-status', role: 'status' }, 'Press Run: about 30 tests, each a program that checks one instruction against hand-picked values.');
  const detail = h('div', { class: 'vf-detail' });
  const build = (w: number[], i: number, d: number) => (fault ? withFault(pipelinedCpu(w, { imemK: i, dmemK: d }), SLT_FAULT) : pipelinedCpu(w, { imemK: i, dmemK: d }));
  const show = async (r: RvTestResult) => {
    detail.replaceChildren();
    if (r.pass || r.failCase === undefined) return;
    const img = (await rv32uiImages()).find((i) => i.name === `rv32ui-${r.name}`);
    if (!img) return;
    // the failing case's code: TEST_CASE n starts by loading n into gp (x3): li gp, n = addi x3, x0, n
    const words = loadable(img).words, mark = words.findIndex((w) => w === ((r.failCase! << 20) | (3 << 7) | 0x13));
    const lines = mark < 0 ? [] : words.slice(mark, mark + 7).map((w, k) => h('div', { class: 'mono' }, `${(4 * (mark + k)).toString(16).padStart(4, '0')}  ${disasm(w, 4 * (mark + k))}`));
    detail.append(h('p', null, `rv32ui-${r.name}, case ${r.failCase}: the test loads the case number into gp, computes, compares with the expected value and jumps to the failure handler on a difference, which writes (case << 1) | 1 = ${(r.failCase << 1) | 1} to tohost.`), ...lines);
  };
  const run = async () => {
    running && (running.aborted = true);
    const me = (running = { aborted: false });
    grid.replaceChildren(); detail.replaceChildren();
    status.textContent = 'Loading the images…';
    try {
      const t0 = performance.now();
      const res = await runRv32ui(build, { signal: me, onProgress: (d, n) => { status.textContent = `${d} of ${n} tests run on the gates…`; } });
      if (me.aborted) return;
      const fails = res.filter((r) => !r.pass);
      grid.replaceChildren(...res.map((r) => {
        const b = h('button', { class: `vf-test ${r.pass ? 'ok' : 'bad'}`, title: `rv32ui-${r.name}: ${r.text}, ${n0(r.cycles)} cycles for ${n0(r.instructions)} instructions` }, r.name, r.pass ? '' : h('small', null, r.failCase !== undefined ? `case ${r.failCase}` : r.text));
        b.addEventListener('click', () => void show(r));
        return b;
      }));
      status.textContent = `${res.length - fails.length} of ${res.length} pass on the gate-level pipeline${fault ? ' with the set-less-than bit stuck at 0' : ''} (${((performance.now() - t0) / 1000).toFixed(1)} s, up to 32 at once).${fails.length ? ' Click a red one to see its failing case.' : ''}`;
      if (fails.length) void show(fails[0]);
    } catch (e) {
      if ((e as Error).message !== 'aborted') status.textContent = `Could not run: ${(e as Error).message}`;
    }
  };
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'CPU' }, h('option', { value: '0' }, 'the pipelined CPU as it is'), h('option', { value: '1' }, 'with alu.slt stuck at 0')) as HTMLSelectElement;
  sel.addEventListener('change', () => { fault = sel.value === '1'; void run(); });
  return {
    el: panel('riscv-tests on the gates', 'The official tests, built by the RISC-V community, each image run on the gate-level pipeline until it writes its verdict.',
      h('div', { class: 'cx-controls' }, sel, btn('Run', () => void run(), 'btn sm primary')), status, grid, detail),
    destroy: () => { if (running) running.aborted = true; },
  };
}

/** Steps 4 and 5: random programs on the FP pipeline, with the bug random testing found here planted back. */
export function fuzzWidget(opts: { shrinkSeed?: number } = {}): Widget {
  let bug = true, next = 1, running: { aborted: boolean } | null = null;
  const verdicts: Verdict[] = [];
  const status = h('div', { class: 'vf-status', role: 'status' });
  const strip = h('div', { class: 'vf-seeds' });
  const detail = h('div', { class: 'vf-detail' });
  const cpu = () => (bug ? FP_PIPE_WITH_BUG : FP_PIPE);
  const say = () => {
    const bad = verdicts.filter((v) => !v.ok);
    status.textContent = verdicts.length
      ? `${verdicts.length} programs, ${bad.length} fail${bad.length === 1 ? 's' : ''}${bad.length ? ` (seeds ${bad.map((v) => v.seed).join(', ')})` : ''}. ${bug ? 'The bug is planted: pc.en ignores a taken branch.' : 'The pipeline as it is.'}`
      : 'Each program is 60 random units (instructions, short loops, address arithmetic) drawn from its seed, run on the golden model to its halt and then on the gates; the final registers, FP registers, fcsr and memory are compared.';
  };
  const guard = async (f: (me: { aborted: boolean }) => Promise<void>) => {
    running && (running.aborted = true);
    const me = (running = { aborted: false });
    try { await f(me); } catch (e) { if ((e as Error).message !== 'aborted') status.textContent = `Could not run: ${(e as Error).message}`; }
  };
  const tick = (me: { aborted: boolean }) => { let t = performance.now(); return async () => { if (me.aborted) throw new Error('aborted'); if (performance.now() - t > 12) { await new Promise((r) => setTimeout(r, 0)); t = performance.now(); } }; };
  const runMore = () => guard(async (me) => {
    const seeds = Array.from({ length: 32 }, (_, i) => next + i);
    status.textContent = `Seeds ${seeds[0]}–${seeds[31]} on the gates…`;
    const r = await fuzzBatch(cpu(), seeds, tick(me));
    next += 32;
    verdicts.push(...r);
    strip.append(...r.map((v) => {
      const b = h('button', { class: `vf-seed ${v.ok ? 'ok' : 'bad'}`, title: v.ok ? `seed ${v.seed}: equal to the golden model` : `seed ${v.seed}: ${v.diff}` }, v.ok ? '' : String(v.seed));
      if (!v.ok) b.addEventListener('click', () => void explain(v.seed));
      return b;
    }));
    say();
  });
  const explain = (seed: number) => guard(async (me) => {
    const c = fuzzCase(cpu(), seed);
    detail.replaceChildren(h('p', null, `Seed ${seed}: replaying it alone, the golden model stepped at every retirement…`));
    const d = await firstDivergence(cpu(), c, tick(me));
    const shrinkBtn = btn('Make it small', () => void small(seed), 'btn sm primary');
    detail.replaceChildren(h('p', null, h('b', null, `Seed ${seed}. `), d ? d.text : 'no difference in lock step (the final memory differs)'),
      h('p', null, `The program is ${c.source.split('\n').filter((l) => /^\s+[a-z]/.test(l)).length} lines long. `, shrinkBtn));
  });
  const small = (seed: number) => guard(async (me) => {
    const c = fuzzCase(cpu(), seed);
    const prog = h('p', null, 'Shrinking: each pass tries deleting chunks of the program, 32 candidates at once on the gates…');
    detail.replaceChildren(prog);
    const r = await shrink(cpu(), c, tick(me), (k) => { prog.textContent = `Shrinking… ${k} instructions left`; });
    const src = r.source.split('\n').filter((l) => !/^\s*$/.test(l) && !/^[A-Z]\d*:\s*$/.test(l.trim()) && !/^L\d+:\s*$/.test(l.trim()));
    detail.replaceChildren(h('p', null, `${r.before} instructions down to ${r.after} in ${r.passes.length - 1} kept deletions (${r.tried} candidates run). Every candidate still assembled, halted on the golden model and still failed on the gates:`),
      h('pre', { class: 'vf-src' }, src.join('\n')));
  });
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'CPU' }, h('option', { value: '1' }, 'FP pipeline, the old bug planted back'), h('option', { value: '0' }, 'FP pipeline as it is')) as HTMLSelectElement;
  sel.addEventListener('change', () => { bug = sel.value === '1'; next = 1; verdicts.length = 0; strip.replaceChildren(); detail.replaceChildren(); say(); });
  say();
  if (opts.shrinkSeed) void explain(opts.shrinkSeed).then(() => small(opts.shrinkSeed!));
  return {
    el: panel(opts.shrinkSeed ? 'Make a failure small' : 'Random programs', opts.shrinkSeed ? 'Delta debugging: delete what the failure does not need, keep what it does.' : 'Programs nobody wrote, checked against the golden model. A red seed failed: click it.',
      h('div', { class: 'cx-controls' }, sel, btn('Run 32 more', () => void runMore(), 'btn sm primary')), status, strip, detail),
    destroy: () => { if (running) running.aborted = true; },
  };
}

/** Step 6: what a set of programs reached, instruction by instruction and event by event on the pipeline's gates. */
export function coverageWidget(): Widget {
  const status = h('div', { class: 'vf-status', role: 'status' });
  const grid = h('div', { class: 'vf-cov' }), ev = h('div', { class: 'vf-ev' });
  let running: { aborted: boolean } | null = null;
  const draw = (r: CoverageReport, what: string) => {
    const k = reached(r);
    status.textContent = `${what}: ${k.instrs} of ${RV32I_WORD.length} instructions executed, ${k.events} of ${EVENTS.length} pipeline events seen${r.programs > 1 ? ` (${r.programs} programs)` : ''}.`;
    grid.replaceChildren(...RV32I_WORD.map((n) => h('span', { class: `vf-op ${r.instrs[n] ? 'hit' : 'miss'}`, title: `${n}: executed ${n0(r.instrs[n])} times` }, n)));
    ev.replaceChildren(...EVENTS.map((e) => h('div', { class: `vf-evrow ${r.events[e.key] ? 'hit' : 'miss'}` }, h('span', null, e.label), h('b', null, r.events[e.key] ? `${n0(r.events[e.key])} cycles` : 'never'))));
  };
  const pick = async (v: string) => {
    running && (running.aborted = true);
    const me = (running = { aborted: false });
    status.textContent = 'Running…';
    try {
      if (v === 'rt') {
        const r = await coverRiscvTests();
        draw(r, 'The rv32ui tests');
        ev.replaceChildren(h('p', { class: 'sub' }, 'Events are counted on the gates for the programs above; the tests\' images are run on the golden model here, for their instructions.'));
      } else if (v === 'rnd') draw(await coverRandom(32, me), '32 random programs');
      else { const p = PROGRAMS.find((q) => q.id === v)!; draw(await coverProgram(p.source, me), `"${p.name}"`); }
    } catch (e) { if ((e as Error).message !== 'aborted') status.textContent = `Could not run: ${(e as Error).message}`; }
  };
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Programs' }, ...PROGRAMS.map((p) => h('option', { value: p.id }, `Sample: ${p.name}`)), h('option', { value: 'rnd' }, '32 random programs'), h('option', { value: 'rt' }, 'The rv32ui tests')) as HTMLSelectElement;
  sel.addEventListener('change', () => void pick(sel.value));
  void pick(sel.value);
  return {
    el: panel('Coverage', 'What the programs reached: every instruction the golden model executed, every pipeline event read off the gates\' own hazard unit.',
      h('div', { class: 'cx-controls' }, sel), status, h('div', { class: 'cpu-sec' }, 'RV32I (word accesses)'), grid, h('div', { class: 'cpu-sec' }, 'Pipeline events'), ev),
    destroy: () => { if (running) running.aborted = true; },
  };
}

/** Step 7: what this repository's checks have found, by which check. */
export function foundWidget(): Widget {
  return {
    el: panel('What the checks found here', 'Every bug below was in this site\'s code, and every fix came with a failing test first.',
      h('div', { class: 'vf-wrap' }, h('table', { class: 'vf-table' },
        h('thead', null, h('tr', null, h('th', null, 'Where'), h('th', null, 'Bug'), h('th', null, 'Found by'), h('th', null, 'Fix'))),
        h('tbody', null, ...FOUND.map((f) => h('tr', null, h('th', null, f.where), h('td', null, f.bug), h('td', { class: 'vf-by' }, f.foundBy), h('td', null, f.fix))))))),
  };
}
