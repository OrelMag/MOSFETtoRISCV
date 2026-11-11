// The first computer's scenes and panel (chapter 'firstcomputer'): the gate-level machine (lib/acc8.ts) with the golden
// model (acc8/acc8.ts) beside it, compared before and after every rising edge; a listing of the ROM with the PC, the
// registers, the control lines the decoder raises now, the RAM and what OUT has shown. A click on a line lights the
// parts that instruction uses. AccFollower is DOM-free (tests drive it as the stage would).

import '../styles/acc8.css';
import { ACC8_PRESET, ACC_OPS, ACC_PROGRAMS, type AccOp, AccISS, type AccProgram, accAssembleFull, accDisasm, accOp } from '../acc8/acc8';
import { ACC_CTL_OUTS, ACC_STATE, accControl, accMachine } from '../lib/acc8';
import { findNode, type HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { h, icon } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { codeEditor } from './codeedit';
import { frameRun } from './slowctl';

/** The machine's state as the gates hold it (-1: a value with an unknown bit). */
export interface AccHw { pc: number; a: number; out: number; z: number; instr: number; mem: number[] }

const netCache = new WeakMap<HierNode, Map<string, readonly number[] | null>>();
const read = (sim: Sim, path: string, port: string): number => {
  const root = sim.design.root;
  let m = netCache.get(root);
  if (!m) netCache.set(root, (m = new Map()));
  const key = `${path}:${port}`;
  let nets = m.get(key);
  if (nets === undefined) m.set(key, (nets = findNode(root, path.split('.'))?.ports[port] ?? null));
  return nets ? pack(sim.getBits(nets)) : -1;
};

export function accHw(sim: Sim): AccHw {
  return {
    pc: read(sim, ACC_STATE.pc, 'q'), a: read(sim, ACC_STATE.a, 'q'), out: read(sim, ACC_STATE.out, 'q'),
    z: read(sim, 'zero', 'z'), instr: read(sim, ACC_STATE.rom, 'data'),
    mem: Array.from({ length: 32 }, (_, i) => read(sim, `${ACC_STATE.ram}.w${i}`, 'q')),
  };
}

const hx = (v: number) => (v < 0 ? 'X' : v.toString(16).toUpperCase().padStart(2, '0'));

export interface AccFollowerState { iss: ReturnType<AccISS['save']>; mismatch: string | null }

/** The golden model in lock step: equal before every rising edge, one instruction at it, equal again after. */
export class AccFollower {
  iss: AccISS;
  mismatch: string | null = null;
  constructor(private readonly words: readonly number[]) {
    this.iss = new AccISS([...words]);
  }
  reset(): void {
    this.iss = new AccISS([...this.words]);
    this.mismatch = null;
  }
  private compare(sim: Sim, when: string): void {
    if (this.mismatch) return;
    const hw = accHw(sim), m = this.iss;
    const diff = hw.pc !== m.pc ? `PC is ${hw.pc} in the gates, ${m.pc} in the model`
      : hw.a !== m.a ? `A is ${hx(hw.a)} in the gates, ${hx(m.a)} in the model`
        : hw.out !== m.out ? `OUT is ${hx(hw.out)} in the gates, ${hx(m.out)} in the model`
          : (() => { const i = hw.mem.findIndex((v, k) => v !== m.mem[k]); return i < 0 ? '' : `M[${i}] is ${hx(hw.mem[i])} in the gates, ${hx(m.mem[i])} in the model`; })();
    if (diff) this.mismatch = `${when} clock ${m.steps + (when === 'after' ? 0 : 1)}: ${diff}`;
  }
  before(sim: Sim): void { this.compare(sim, 'before'); }
  after(sim: Sim): void {
    if (this.mismatch) return;
    this.iss.step();
    this.compare(sim, 'after');
  }
  save(): AccFollowerState { return { iss: this.iss.save(), mismatch: this.mismatch }; }
  restore(s: AccFollowerState): void { this.iss.restore(s.iss); this.mismatch = s.mismatch; }
}

/** The parts an instruction uses, by instance name (fetch included): the listing's click lights them. */
export function accUse(op: AccOp): string[] {
  const fetch = ['pc', 'inc', 'jmux', 'rom', 'f', 'ctl'];
  const more: Record<AccOp, string[]> = {
    LDA: ['ram', 'mux1', 'mux2', 'acc'], ADD: ['ram', 'alu', 'mux1', 'mux2', 'acc'], SUB: ['ram', 'alu', 'mux1', 'mux2', 'acc'],
    STA: ['ram', 'acc'], LDI: ['kx', 'k0', 'mux2', 'acc'], JMP: ['self', 'hlt'], JZ: ['zero', 'acc'], OUT: ['outr', 'acc'],
  };
  return [...fetch, ...more[op]];
}

/** What each control line does, for the panel's titles. */
export const ACC_LINE_TITLE: Record<(typeof ACC_CTL_OUTS)[number], string> = {
  la: 'load A at the edge', am: 'A\'s next value from the RAM (else the adder)', ak: 'A\'s next value is k, the word\'s low 5 bits',
  sub: 'the adder subtracts', we: 'write A into M[x] at the edge', jump: 'the PC takes x, not PC + 1', out: 'OUT takes A at the edge',
  jmp: 'this is JMP (the halt test reads it)',
};

export interface AccSceneOptions { program?: AccProgram; source?: string; highlight?: string[]; fixed?: boolean; autoClock?: boolean }

const sourceOf = (o: AccSceneOptions) => o.source ?? ACC_PROGRAMS[o.program ?? 'mul'];

export function accScene(o: AccSceneOptions = {}): Scene {
  const asm = accAssembleFull(sourceOf(o));
  return {
    root: accMachine(asm.words),
    clock: 'clk',
    inputs: {},
    highlight: o.highlight,
    autoClock: o.autoClock ?? false,
    panels: [accPanel(o)],
  };
}

const RUN_LIMIT = 5000;

export function accPanel(o: AccSceneOptions): ScenePanel {
  return (stage: Stage): Widget => {
    const source = sourceOf(o), asm = accAssembleFull(source), words = asm.words;
    const srcLines = source.split('\n');
    const labelAt = new Map<number, string>();
    for (const [n, a] of asm.labels) if (!labelAt.has(a)) labelAt.set(a, n);
    const lineAt = new Map(asm.lines.map((l) => [l.addr, l]));
    const mon = new AccFollower(words);
    let stopRun: (() => void) | null = null;
    stage.edgeHooks.add({ before: () => stage.sim && !stage.inEdge && mon.before(stage.sim), after: () => stage.sim && mon.after(stage.sim) });
    stage.historyHooks.add({ save: () => mon.save(), restore: (v) => { stopRun?.(); mon.restore(v as AccFollowerState); } });
    stage.resetHooks.add(() => { stopRun?.(); mon.reset(); });

    const halted = () => mon.iss.halted;
    const runBtn = h('button', { class: 'btn sm primary', title: 'Clock until the program jumps to itself (or the gates and the model disagree)' }, 'Run to halt') as HTMLButtonElement;
    runBtn.addEventListener('click', () => {
      if (stopRun) { stopRun(); return; }
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      const start = mon.iss.steps;
      stopRun = frameRun(stage, () => halted() || !!mon.mismatch || mon.iss.steps - start > RUN_LIMIT, () => {
        stopRun = null;
        runBtn.textContent = 'Run to halt';
        stage.refresh();
      });
    });

    const names = Object.keys(ACC_PROGRAMS) as AccProgram[];
    const TITLES: Record<AccProgram, string> = { mul: '6 × 7 by adding', countdown: 'Count down', sum: '1 + … + 10', fetch: 'The fetch loop' };
    const sel = h('select', { 'aria-label': 'program' }, ...names.map((n) => h('option', { value: n }, TITLES[n])), h('option', { value: '__mine' }, 'My program')) as HTMLSelectElement;
    sel.value = o.source ? '__mine' : o.program ?? 'mul';
    const errBox = h('div', { class: 'acc-errors', 'aria-live': 'polite' });
    const editor = codeEditor({
      value: source, lang: { table: ACC8_PRESET }, rows: 12,
      onChange: () => { const r = accAssembleFull(editor.value); editor.setDiagnostics(r.errors); errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n'); },
    });
    const load = () => {
      const r = accAssembleFull(editor.value);
      if (r.words.length > 32) r.errors.push({ line: 0, message: `${r.words.length} words: the ROM holds 32` });
      editor.setDiagnostics(r.errors);
      errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n');
      if (!r.errors.length) stage.load(accScene({ ...o, program: undefined, source: editor.value }));
    };
    const editWrap = h('div', { class: 'cpu-edit', hidden: true }, editor.el, errBox,
      h('div', { class: 'param-row', style: 'margin-top:6px' },
        h('button', { class: 'btn sm primary', onclick: load }, 'Assemble & load'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.hidden = true; editBtn.setAttribute('aria-expanded', 'false'); } }, 'Close')));
    const editBtn = h('button', { class: 'btn sm', 'aria-expanded': 'false', onclick: () => { editWrap.hidden = !editWrap.hidden; editBtn.setAttribute('aria-expanded', String(!editWrap.hidden)); } }, 'Edit') as HTMLButtonElement;
    sel.addEventListener('change', () => {
      if (sel.value === '__mine') { editWrap.hidden = false; editBtn.setAttribute('aria-expanded', 'true'); return; }
      stage.load(accScene({ ...o, source: undefined, program: sel.value as AccProgram }));
    });

    const alarm = h('div', { class: 'acc-alarm', role: 'alert', hidden: true });
    const status = h('div', { class: 'cpu-status', 'aria-live': 'polite' });
    const lines = h('div', { class: 'acc-lines', role: 'group', 'aria-label': 'control lines' },
      ...ACC_CTL_OUTS.filter((n) => n !== 'jmp').map((n) => h('span', { class: 'ln', 'data-line': n, title: ACC_LINE_TITLE[n] }, n)));
    const regs = h('div', { class: 'cpu-regs acc-regs' });
    const listing = h('div', { class: 'cpu-listing acc-listing', role: 'list', 'aria-label': 'program ROM' });
    const ram = h('div', { class: 'acc-ram', role: 'group', 'aria-label': 'data RAM, 32 bytes' });
    const outs = h('div', { class: 'acc-outs' });
    let picked = -1;
    const body = h('div', { class: 'cpu-body' },
      o.fixed ? null : h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, editBtn),
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, runBtn,
        h('button', { class: 'btn sm ghost', title: 'Start again: power-cycle the machine and the golden model', 'aria-label': 'Reset', onclick: () => stage.powerCycle() }, icon('reset', 14), 'Reset')),
      o.fixed ? null : editWrap, alarm, status,
      h('div', { class: 'cpu-sec' }, 'Control lines', h('span', { class: 'cpu-sec-hint' }, 'what the decoder raises now')), lines,
      h('div', { class: 'cpu-sec' }, 'Registers'), regs,
      h('div', { class: 'cpu-sec' }, 'Program', h('span', { class: 'cpu-sec-hint' }, '▸ PC · click a line to light its parts')), listing,
      h('div', { class: 'cpu-sec' }, 'RAM', h('span', { class: 'cpu-sec-hint' }, 'M[0] … M[31]')), ram,
      h('div', { class: 'cpu-sec' }, 'OUT so far'), outs);
    const verdict = h('span', { class: 'acc-verdict' });
    const el = h('div', { class: 'mem-panel cpu-panel acc-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' },
      h('h4', null, 'The machine ', verdict, h('span', { class: 'fold-hint' })), body);

    let lastKey = '';
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      const hw = accHw(sim);
      const key = `${sim.time}|${mon.iss.steps}|${mon.mismatch}|${hw.pc}|${hw.a}|${hw.mem.join(',')}|${picked}`;
      if (key === lastKey) return;
      lastKey = key;
      verdict.textContent = mon.mismatch ? '✗ mismatch' : '✓ in step';
      verdict.className = `acc-verdict ${mon.mismatch ? 'bad' : 'good'}`;
      alarm.hidden = !mon.mismatch;
      alarm.textContent = mon.mismatch ? `✗ Not in step with the golden model: ${mon.mismatch}` : '';
      status.replaceChildren(
        h('span', null, `clock ${mon.iss.steps}`),
        mon.mismatch ? h('span', { class: 'bad' }, '✗ mismatch')
          : h('span', { class: 'good', title: 'PC, A, OUT and every RAM byte equal the golden model before and after every clock edge' }, '✓ in step with the golden model'),
        ...(halted() ? [h('span', { class: 'warn' }, 'halted: a jump to itself')] : []));
      const op = hw.instr < 0 ? -1 : hw.instr >> 5;
      const ctl = op < 0 || hw.z < 0 ? null : accControl(op, hw.z);
      for (const s of lines.children as HTMLCollectionOf<HTMLElement>) {
        const n = s.dataset.line as (typeof ACC_CTL_OUTS)[number];
        const on = !!ctl && ctl[n] === 1;
        s.classList.toggle('on', on);
        s.setAttribute('aria-label', `${n} ${on ? 'on' : 'off'}: ${ACC_LINE_TITLE[n]}`);
      }
      const reg = (n: string, v: string, title: string) => h('div', { class: 'r', title }, h('span', { class: 'n' }, n), h('span', { class: 'v' }, v));
      regs.replaceChildren(
        reg('PC', hw.pc < 0 ? 'X' : String(hw.pc), 'program counter (5 bits)'),
        reg('A', hw.a < 0 ? 'X' : `${hw.a}`, `the accumulator (0x${hx(hw.a)})`),
        reg('Z', hw.z < 0 ? 'X' : String(hw.z), 'Z = 1 while A is 0'),
        reg('OUT', hw.out < 0 ? 'X' : String(hw.out), 'the output register'));
      const keep = listing.scrollTop;
      listing.replaceChildren(...Array.from({ length: Math.max(words.length, 1) }, (_, a) => {
        const l = lineAt.get(a), w = words[a] ?? 0, lab = labelAt.get(a);
        const comment = l ? (srcLines[l.srcLine - 1] ?? '').split('#')[1]?.trim() : '';
        const row = h('div', { class: `ln${a === hw.pc ? ' cur' : ''}${a === picked ? ' sel' : ''}`, role: 'listitem', tabindex: '0', title: comment || undefined },
          h('span', { class: 'm' }, a === hw.pc ? '▸' : ''),
          h('span', { class: 'a' }, hx(a)),
          h('span', { class: 'w' }, hx(w)),
          h('span', { class: 't' }, `${lab ? `${lab}: ` : ''}${accDisasm(w, a)}`),
          h('span', { class: 'd' }, comment ?? ''));
        const pick = () => {
          picked = picked === a ? -1 : a;
          stage.highlight(picked < 0 ? (o.highlight ?? []) : accUse(accOp(w)), picked >= 0);
          lastKey = '';
          update();
        };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        return row;
      }));
      listing.scrollTop = keep;
      const x = hw.instr < 0 ? -1 : hw.instr & 31, usesM = op >= 0 && ['LDA', 'ADD', 'SUB', 'STA'].includes(ACC_OPS[op]);
      ram.replaceChildren(...hw.mem.map((v, i) => h('span', { class: `${v ? 'nz' : ''}${usesM && i === x ? ' at' : ''}`, title: `M[${i}] = ${v < 0 ? 'X' : v}` }, v < 0 ? 'X' : String(v))));
      outs.textContent = mon.iss.outs.length ? mon.iss.outs.map((x) => x.value).join(' · ') : 'nothing yet';
    };
    return { el, update, destroy: () => stopRun?.() };
  };
}
