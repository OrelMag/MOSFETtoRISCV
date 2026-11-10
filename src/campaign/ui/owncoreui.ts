// "Run the tests on: Golden model | Your core" on a program level's card (campaign/owncore.ts does the work). The
// golden model still grades; with Your core chosen, a pass on the model is then run on the chip of a core level the
// learner passed: the result says it agrees (with its cycles, CPI and time in NAND delays beside the other cores
// tried) or where it parts from the model (the instruction lit in the code, Step to it: both register files, Open on
// a bench, Fix <core> →). The switch is remembered per level, the best cycles per core too; neither earns a star.

import { groupDigits } from '../../sim/numfmt';
import { h, icon } from '../../ui/dom';
import { disasm16, REG_NAMES16 } from '../../riscv/rv16/isa16';
import { loadWorkspace, saveWorkspace } from '../../editor/store';
import type { Workspace } from '../../editor/model';
import { actName, nodeById } from '../nodes';
import { progress } from '../progress';
import { type ProgramPuzzle, puzzleUnit } from '../puzzles';
import type { CampaignNode } from '../types';
import { coreOptions, modelOnly } from '../owncorefit';
import type { OwnRun, OwnTest } from '../owncore';

/** The runner (the chip compiled, the benches, the bench builder): loaded on the first use. */
type Runner = typeof import('../owncore');
let runner: Runner | null = null;
const loadRunner = (): Promise<Runner> => import('../owncore').then((m) => (runner = m));

const hex = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const num = (v: number) => groupDigits(v);
/** Simulation time a frame while a run goes on. */
const FRAME_MS = 12;

export interface OwnCoreUi {
  el: HTMLElement;
  /** Whether a run of the tests should go on to the core. */
  on(): boolean;
  /** Run on the chosen core (the model passed) and show it under the model's result. */
  run(src: string, into: HTMLElement): void;
  /** A new run of the tests: the last verdict's lit line goes. */
  clear(): void;
}

/** The switch for a program level; null for a level no RV16 core runs (the NIC driver). */
export function ownCoreUi(n: CampaignNode, p: ProgramPuzzle, lineOf: (pc: number) => number | null, light: (line: number | null) => void): OwnCoreUi | null {
  if (p.nic) return null;
  const pr = progress();
  const only = modelOnly(p);
  const isSolved = (id: string) => pr.get(id)?.status === 'solved';
  const opts = coreOptions(p, isSolved);
  const fit = opts.filter((o) => !o.why);
  const ready = fit.filter((o) => o.solved);
  const saved = pr.get(n.id)?.on;
  let core = ready.find((o) => o.id === saved)?.id ?? ready.at(-1)?.id;
  let mine = !!saved && !!core;

  const label = h('span', { class: 'lbl', id: `cp-runon-${n.id}` }, 'Run the tests on');
  const bModel = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Golden model') as HTMLButtonElement;
  const bCore = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Your core') as HTMLButtonElement;
  const seg = h('span', { class: 'cp-seg', role: 'group', 'aria-labelledby': label.id }, bModel, bCore);
  const pick = h('select', { 'aria-label': 'Which of your cores' }) as HTMLSelectElement;
  const sub = h('p', { class: 'sub' });
  const ws = (): Workspace => loadWorkspace();
  // a core's facts are its static timing: worked out one core a frame, the list redrawn as each arrives
  let missing: string[] = [];
  const more = () => {
    const id = missing.shift();
    if (!id || !runner) return;
    runner.coreFacts(ws(), id);
    fill();
  };
  const fill = () => {
    const w = ws();
    missing = [];
    pick.replaceChildren(...opts.filter((o) => !o.why || o.solved).map((o) => {
      const f = o.solved && !o.why && runner ? runner.coreFacts(w, o.id, true) : null;
      if (o.solved && !o.why && runner && !f) missing.push(o.id);
      // the level's short name ("Core III: control flow" → "Core III"), so the facts fit the select; the full title on hover
      const name = o.title.split(':')[0];
      const text = o.why ? `${name} · ${o.why}` : !o.solved ? `${name} · not passed yet` : `${name}${f ? ` · ${num(f.nands)} NANDs${f.period !== null ? ` · period ${f.period}` : ''}` : ''}`;
      return h('option', { value: o.id, title: o.title, ...(o.why || !o.solved ? { disabled: true } : {}), ...(o.id === core ? { selected: true } : {}) }, text);
    }));
    if (!runner) void loadRunner().then(fill);
    else if (missing.length) setTimeout(more, 0);
  };
  let out: HTMLElement | null = null;
  // the run in progress: a new run, a switch or a core change stops it
  let ticket = 0;
  const clear = () => {
    ticket++;
    light(null);
    out?.replaceChildren();
  };
  const paint = () => {
    bModel.setAttribute('aria-pressed', String(!mine));
    bCore.setAttribute('aria-pressed', String(mine));
    bCore.disabled = !!only || !ready.length;
    pick.hidden = !mine;
    if (only) sub.textContent = `This level runs on the golden model only: ${only}.`;
    else if (!ready.length) {
      const first = nodeById(fit[0]?.id ?? '');
      sub.textContent = first ? `Pass ${first.title} (${actName(first.act)}) to run your programs on hardware you built.` : 'No campaign core runs this program yet.';
    } else sub.textContent = mine ? 'The model still decides pass or fail; your core must agree with it at every register write and store.' : '';
  };
  bModel.onclick = () => { mine = false; pr.setRunOn(n.id, undefined); clear(); paint(); };
  bCore.onclick = () => {
    if (!core) return;
    mine = true;
    pr.setRunOn(n.id, core);
    clear();
    fill();
    paint();
  };
  pick.onchange = () => { core = pick.value; pr.setRunOn(n.id, core); clear(); };
  if (mine) fill();
  paint();
  const el = h('div', { class: 'cp-runon' }, h('div', { class: 'cp-runon-row' }, label, seg, pick), sub);

  const run = (src: string, into: HTMLElement) => {
    if (!mine || !core) return;
    out = into;
    const id = core, title = nodeById(id)?.title ?? id;
    const box = h('div', { class: 'cp-own', role: 'status' }, h('p', { class: 'sub' }, `Running on ${title}…`));
    into.append(box);
    // let the model's result paint first: a pipeline on a long test takes a moment
    const run1 = ++ticket;
    const t0 = performance.now();
    void loadRunner().then((m) => {
      const w = ws();
      const g = m.runOnCoreSteps(p, src, id, w);
      // a slice of the run a frame (FRAME_MS), so the page stays live on a long kernel
      const slice = () => {
        if (run1 !== ticket) return;
        const end = performance.now() + FRAME_MS;
        let r: IteratorResult<void, OwnRun>;
        do r = g.next(); while (!r.done && performance.now() < end);
        if (!r.done) {
          const secs = (performance.now() - t0) / 1000;
          if (secs > 1) box.firstElementChild!.textContent = `Running on ${title}… ${secs.toFixed(0)} s`;
          setTimeout(slice, 0);
          return;
        }
        const res = r.value;
        box.replaceChildren(...view(m, res, id, title, w, src));
        box.classList.toggle('ok', res.kind === 'done' && res.ok);
        box.classList.toggle('bad', res.kind === 'error' || (res.kind === 'done' && !res.ok));
        if (res.kind === 'model') box.remove();
      };
      setTimeout(slice, 30);
    });
  };

  const view = (m: Runner, r: OwnRun, id: string, title: string, w: Workspace, src: string): (HTMLElement | string)[] => {
    if (r.kind === 'error') return [h('p', { class: 'cp-own-bad' }, h('b', null, `Cannot run on ${title}: `), r.error)];
    if (r.kind === 'model') return [];
    const unit = puzzleUnit(p);
    if (r.ok) {
      light(null);
      const f = m.coreFacts(w, id);
      pr.coreRun(n.id, id, r.cycles);
      const cpi = r.steps ? r.cycles / r.steps : 0;
      const rows = r.tests.map((t) => h('tr', null, h('td', { class: 'ok' }, icon('check', 12)), h('td', null, t.name),
        h('td', { class: 'n' }, num(t.steps)), h('td', { class: 'n' }, num(t.cycles)), h('td', { class: 'n' }, t.steps ? (t.cycles / t.steps).toFixed(2) : '—')));
      const best = pr.get(n.id)?.cores ?? {};
      const times = Object.entries(best).map(([c, cyc]) => ({ c, cyc, f: m.coreFacts(w, c) })).filter((x) => x.f?.period)
        .map((x) => ({ c: x.c, t: x.cyc * x.f!.period!, cyc: x.cyc }));
      const top = Math.max(1, ...times.map((x) => x.t));
      const out: (HTMLElement | null)[] = [
        h('p', { class: 'cp-own-ok' }, h('b', null, icon('check', 14), ` ${title} agrees`), ' on every register write and store'),
        h('table', { class: 'cp-pz-tests' }, h('tr', null, h('th'), h('th', null, 'Test'), h('th', { class: 'n' }, unit === 'instructions' ? 'Instr.' : unit[0].toUpperCase() + unit.slice(1)),
          h('th', { class: 'n' }, 'Cycles'), h('th', { class: 'n' }, 'CPI')), rows),
        h('dl', { class: 'cp-own-readout' },
          h('dt', null, title), h('dd', null, f ? `${num(f.nands)} NANDs${f.period !== null ? ` · period ${f.period}` : ''} · CPI ${cpi.toFixed(2)}` : `CPI ${cpi.toFixed(2)}`),
          h('dt', null, 'This program'), h('dd', null, f?.period ? `${num(r.cycles)} cycles × ${f.period} = ${num(r.cycles * f.period)} NAND delays` : `${num(r.cycles)} cycles on average`)),
        times.length > 1 ? h('div', { class: 'cp-own-bars', 'aria-label': 'Best time of this program on each core you ran it on, in NAND delays' },
          times.sort((a, b) => a.t - b.t).map((x) => h('div', { class: x.c === id ? 'cur' : null },
            h('span', null, nodeById(x.c)?.title ?? x.c), h('i', { style: `width:${Math.max(2, (100 * x.t) / top)}%` }), h('span', { class: 'n' }, num(x.t))))) : null,
        h('p', { class: 'sub' }, 'Time is a readout, not a grade: the best per core is kept with the level.'),
      ];
      return out.filter((x): x is HTMLElement => !!x);
    }
    const i = r.tests.findIndex((t) => !t.ok), t = r.tests[i];
    const why = t.why;
    const line = why?.pc !== undefined ? lineOf(why.pc) : null;
    light(line);
    const where = why?.pc !== undefined && why.instr !== undefined
      ? [`, instruction ${num((why.step ?? 0) + 1)} (pc ${hex(why.pc)}, `, h('code', null, disasm16(why.instr, why.pc)), ')'] : [];
    const said = !why ? [`: ${t.text ?? 'it does not agree'}.`]
      : why.kind === 'stuck' ? [`: it did not finish in ${num(why.cycle)} cycles; the model needed ${num(t.steps)} ${unit}.`]
      : why.kind === 'x' ? [`: ${why.got} at cycle ${num(why.cycle)}.`]
      : why.kind === 'extra' ? [`: after the program ended it went on writing (`, h('code', null, why.got ?? ''), ').']
      : [': the model ', why.kind === 'store' ? 'stores ' : 'writes ', h('code', null, why.expected ?? ''), ', your core ', why.kind === 'store' ? 'stored ' : 'wrote ', h('code', null, why.got ?? ''), '.'];
    const before = why ? ` The ${num(why.agreed)} register write${why.agreed === 1 ? '' : 's'} and stores before it agreed.` : '';
    const regs = h('div', { class: 'cp-own-regs', hidden: true });
    const stepTo = () => {
      const s = m.registersAt(p, src, i, t);
      if (!s) return;
      regs.hidden = false;
      regs.replaceChildren(h('p', { class: 'sub' }, `Just ${s.after ? 'after' : 'before'} instruction ${num((why!.step ?? 0) + 1)} (pc ${hex(s.pc)}, ${s.text}):`),
        h('table', { class: 'cp-pz-tests' }, h('tr', null, h('th', null, 'reg'), h('th', { class: 'n' }, 'model'), h('th', { class: 'n' }, 'your core')),
          REG_NAMES16.slice(1).map((name, k) => {
            const a = s.model[k + 1], b = s.core[k + 1];
            return h('tr', { class: a === b ? null : 'diff' }, h('th', null, name), h('td', { class: 'n' }, hex(a)), h('td', { class: 'n' }, hex(b)));
          })));
    };
    const test = (() => { const all = m.ownTests(p, src); return Array.isArray(all) ? all[i] : null; })();
    const benchWhy = p.lanes ? 'a lane core’s bench opens from its own level' : !test ? 'the code does not assemble' : m.benchRefusal(test);
    const bench = () => {
      if (!test) return;
      const b = m.ownBench(loadWorkspace(), id, test);
      if ('error' in b) { regs.hidden = false; regs.replaceChildren(h('p', { class: 'sub' }, `Cannot build the bench: ${b.error}.`)); return; }
      saveWorkspace(b.ws);
      location.hash = `#/sandbox/${b.id}`;
    };
    return [
      h('p', { class: 'cp-own-bad' }, h('b', null, icon('close', 14), ` ${title} disagrees`), ' in test ', h('b', null, t.name), ...where, ...said, before),
      h('div', { class: 'cp-pz-bar' },
        !p.lanes && why?.step !== undefined ? h('button', { class: 'btn sm', onclick: stepTo }, icon('step', 13), 'Step to it') : null,
        h('button', { class: 'btn sm ghost', onclick: bench, ...(benchWhy ? { disabled: true, title: `Not for this test: ${benchWhy}` } : { title: 'Build the computer around your core with this test and open it in the sandbox' }) }, 'Open on a bench'),
        h('a', { class: 'btn sm ghost', href: `#/campaign/n/${id}` }, `Fix ${title} →`)),
      regs,
      h('p', { class: 'sub' }, 'Stars on the model are kept: the program is right. The core’s time is not recorded until it agrees.'),
    ];
  };

  return { el, on: () => mine && !!core, run, clear };
}

export type { OwnTest };
