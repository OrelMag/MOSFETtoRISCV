// Appendix C's scenes: the SAP-1 (Ben Eater's breadboard computer) at gate level, on breadboards (saplayout.ts) with
// the SAP panel beside it: the control word by name, this step's microcode row, the RAM as a listing with the PC,
// A / B / OUT / flags, and the golden model (sap/iss.ts) in lock step at every rising clock edge (sapmon.ts), a
// difference shown loudly. Single modules get a board of their own with DIP switches on their inputs; the tri-state
// scene shows what the computer's wired-OR bus stands in for, at switch level.

import '../styles/sap.css';
import { SAP_AREG, SAP_ALU, SAP_CLOCK, SAP_PC, sapComputer } from '../lib/sap';
import { PULLDOWN, TRIBUF } from '../lib/switchparts';
import { assembleSap, type SapAsmResult } from '../sap/asm';
import { CTRL, CTRL_LABEL, ctrlText, disasm, microcode, SAP_CTRL, SAP_STEPS } from '../sap/isa';
import { SAP_PROGRAMS } from '../sap/programs';
import { shortText, SwitchSim } from '../sim/switchsim';
import { B0, B1, type ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { codeEditor } from './codeedit';
import { moduleLayout, sapLayout } from './saplayout';
import { type FollowerState, SapFollower, sapGloss, sapHw, sapRam } from './sapmon';
import { frameRun } from './slowctl';

export interface SapSceneOptions {
  /** A sample's id (sap/programs.ts) or assembler source; default the first sample. */
  program?: string;
  source?: string;
  /** Start with an empty RAM, to be programmed with the switches. */
  empty?: boolean;
  /** Open on the schematic at this path instead of the boards. */
  path?: string[];
  highlight?: string[];
  /** false: the clock stays still on load (an exercise counted in pulses). Default false. */
  autoClock?: boolean;
  /** Hide the program editor (a step about the hardware). */
  fixed?: boolean;
}

const hx = (v: number, n = 2) => (v < 0 ? 'X'.repeat(n) : v.toString(16).toUpperCase().padStart(n, '0'));
const bin = (v: number, n: number) => (v < 0 ? 'x'.repeat(n) : v.toString(2).padStart(n, '0'));

/** The program a scene runs: its source and assembly. */
function programOf(o: SapSceneOptions): { source: string; asm: SapAsmResult; id: string | null } {
  if (o.empty) return { source: '', asm: assembleSap(''), id: null };
  const sample = SAP_PROGRAMS.find((p) => p.id === o.program) ?? (o.source === undefined ? SAP_PROGRAMS[0] : undefined);
  const source = o.source ?? sample!.src;
  return { source, asm: assembleSap(source), id: sample && sample.src === source ? sample.id : null };
}

/** The whole computer on its breadboards, running a program, with the SAP panel. */
export function sapScene(o: SapSceneOptions = {}): Scene {
  const { asm } = programOf(o);
  const root = sapComputer(asm.bytes);
  return {
    root,
    clock: 'clk',
    inputs: { prog: 0, addrSw: 0, dataSw: 0, write: 0, rst: 0 },
    path: o.path,
    highlight: o.highlight,
    autoClock: o.autoClock ?? false,
    breadboard: sapLayout(root),
    panels: [sapPanel(o)],
  };
}

/** One module on a board of its own, its inputs on DIP switches (Ben tests every board before the next). */
export function sapModuleScene(def: ComponentDef, title: string, o: { highlight?: string[]; inputs?: Record<string, number>; drives?: string; loads?: string; before?: boolean } = {}): Scene {
  const before = o.before ? ['astable', 'monostable', 'bistable'].map((r) => ({ part: 'NE555', dip: 8, role: `The ${r} 555: drawn, not simulated (the stage's clock is osc).` })) : undefined;
  return {
    root: def,
    inputs: o.inputs,
    highlight: o.highlight,
    autoClock: false,
    breadboard: moduleLayout(def, { title, drives: o.drives, loads: o.loads, before }),
  };
}

export const sapAregScene = () => sapModuleScene(SAP_AREG, 'A register', { drives: 'ao', loads: 'ai', inputs: { bus: 0x2a } });
export const sapAluScene = () => sapModuleScene(SAP_ALU, 'ALU', { drives: 'eo', inputs: { a: 28, b: 14 } });
export const sapPcScene = () => sapModuleScene(SAP_PC, 'Program counter', { drives: 'co', loads: 'j', inputs: { ce: 1 } });
export const sapClockScene = () => sapModuleScene(SAP_CLOCK, 'Clock', { before: true });

// ---- the SAP panel ---------------------------------------------------------------------------------------------

/** Clock periods a Run may take before it gives up (a program that never halts). */
const RUN_LIMIT = 20000;

export function sapPanel(o: SapSceneOptions): ScenePanel {
  return (stage: Stage): Widget => {
    const { source, asm, id } = programOf(o);
    const mon = new SapFollower(asm.bytes);
    const labelAt = new Map<number, string>();
    for (const [n, a] of asm.labels) if (!labelAt.has(a)) labelAt.set(a, n);
    const srcAt = new Map(asm.lines.map((l) => [l.addr, l]));
    let stopRun: (() => void) | null = null;

    stage.edgeHooks.add({ before: () => stage.sim && mon.before(stage.sim), after: () => stage.sim && mon.after(stage.sim) });
    stage.historyHooks.add({ save: () => mon.save(), restore: (v) => mon.restore(v as FollowerState) });
    stage.resetHooks.add(() => { stopRun?.(); mon.reset(); });

    const halted = () => !!stage.sim && stage.value('halt') === 1;
    const runBtn = h('button', { class: 'btn sm primary', title: 'Run at full speed until HLT (or a mismatch, or Stop)' }, 'Run to HLT') as HTMLButtonElement;
    const stop = () => { stopRun?.(); };
    runBtn.addEventListener('click', () => {
      if (stopRun) return stop();
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      const start = mon.iss.cycles;
      stopRun = frameRun(stage, () => halted() || !!mon.mismatch || mon.iss.cycles - start > RUN_LIMIT, () => {
        stopRun = null;
        runBtn.textContent = 'Run to HLT';
        stage.refresh();
      });
    });
    const instrBtn = h('button', {
      class: 'btn sm', title: 'Clock to the next T0: the rest of this instruction (all five steps from T0)',
      onclick: () => {
        stop();
        stage.checkpoint();
        let n = 0;
        stage.runCycles(SAP_STEPS, () => n++ > 0 && (halted() || (stage.sim ? sapHw(stage.sim).step === 0 : true)));
      },
    }, 'Instruction');

    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const p of SAP_PROGRAMS) sel.append(h('option', { value: p.id }, p.name));
    sel.append(h('option', { value: '__mine' }, 'My program'));
    sel.value = id ?? '__mine';
    sel.addEventListener('change', () => {
      if (sel.value === '__mine') { editWrap.hidden = false; return; }
      stage.load(sapScene({ ...o, empty: false, program: sel.value, source: undefined }));
    });
    const errBox = h('div', { class: 'asm-errors' });
    const editor = codeEditor({
      value: source || SAP_PROGRAMS[0].src, lang: 'sapasm', rows: 12,
      onChange: () => { const r = assembleSap(editor.value); editor.setDiagnostics(r.errors); errBox.textContent = ''; },
    });
    const editWrap = h('div', { class: 'cpu-edit', hidden: true }, editor.el, errBox,
      h('div', { class: 'param-row', style: 'margin-top:6px' },
        h('button', {
          class: 'btn sm primary', onclick: () => {
            const r = assembleSap(editor.value);
            editor.setDiagnostics(r.errors);
            if (r.errors.length) { errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n'); return; }
            stage.load(sapScene({ ...o, empty: false, program: undefined, source: editor.value }));
          },
        }, 'Assemble & load'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.hidden = true; } }, 'Close')));
    const editBtn = h('button', { class: 'btn sm', 'aria-expanded': 'false', onclick: () => { editWrap.hidden = !editWrap.hidden; editBtn.setAttribute('aria-expanded', String(!editWrap.hidden)); } }, 'Edit') as HTMLButtonElement;

    const alarm = h('div', { class: 'sap-alarm', role: 'alert', hidden: true });
    const status = h('div', { class: 'cpu-status', 'aria-live': 'polite' });
    const now = h('div', { class: 'sap-now' });
    const lines = h('div', { class: 'sap-lines', role: 'group', 'aria-label': 'control lines' },
      ...SAP_CTRL.map((n) => h('span', { class: 'ln', 'data-line': n, title: `${CTRL_LABEL[n]}` }, CTRL_LABEL[n])));
    const steps = h('table', { class: 'sap-mc live' });
    const regs = h('div', { class: 'cpu-regs sap-regs' });
    const listing = h('div', { class: 'cpu-listing sap-listing', role: 'list', 'aria-label': 'RAM' });
    const outs = h('div', { class: 'sap-outs' });
    const body = h('div', { class: 'cpu-body' },
      o.fixed ? null : h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, editBtn),
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, instrBtn, runBtn),
      o.fixed ? null : editWrap, alarm, status, now,
      h('div', { class: 'cpu-sec' }, 'Control word', h('span', { class: 'cpu-sec-hint' }, 'the EEPROMs\' 16 outputs now')), lines,
      h('div', { class: 'cpu-sec' }, 'This instruction\'s steps'), steps,
      h('div', { class: 'cpu-sec' }, 'Registers'), regs,
      h('div', { class: 'cpu-sec' }, 'RAM', h('span', { class: 'cpu-sec-hint' }, '▸ PC · ● the instruction in the IR')), listing,
      h('div', { class: 'cpu-sec' }, 'OUT so far'), outs);
    // the title carries the verdict, so a folded panel still says it
    const verdict = h('span', { class: 'sap-verdict' });
    const el = h('div', { class: 'mem-panel cpu-panel sap-panel', 'data-dock': 'right', 'data-fold': 'narrow' },
      h('h4', null, 'SAP-1 ', verdict, h('span', { class: 'fold-hint' })), body);

    let lastKey = '';
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      mon.look(sim);
      const hw = sapHw(sim), ram = sapRam(sim);
      const key = `${sim.time}|${mon.iss.cycles}|${mon.mismatch}|${mon.stale}|${ram.join(',')}|${hw.cw}|${stage.getInput('prog')}`;
      if (key === lastKey) return;
      lastKey = key;
      verdict.textContent = mon.mismatch ? '✗ mismatch' : mon.stale ? 'programming' : '✓ in step';
      verdict.className = `sap-verdict ${mon.mismatch ? 'bad' : mon.stale ? 'warn' : 'good'}`;
      alarm.hidden = !mon.mismatch;
      alarm.textContent = mon.mismatch ? `✗ Not in step with the golden model: ${mon.mismatch}` : '';
      const op = hw.ir < 0 ? -1 : hw.ir >> 4;
      const prog = stage.getInput('prog') === 1;
      status.replaceChildren(
        h('span', null, `cycle ${mon.iss.cycles}`),
        mon.mismatch ? h('span', { class: 'bad' }, '✗ mismatch')
          : mon.stale || prog ? h('span', { class: 'warn', title: 'The switches write the RAM: the model takes the hardware\'s state when PROG goes back to 0' }, 'programming: model paused')
            : h('span', { class: 'good', title: 'Every register, the step, the control word and the RAM match the golden model at every clock edge' }, '✓ in step with the golden model'),
        ...(hw.cw >= 0 && hw.cw & CTRL.hlt ? [h('span', { class: 'warn' }, 'halted: HLT gates the clock')] : []),
        ...(hw.clash === 1 ? [h('span', { class: 'bad' }, 'two drivers on the bus')] : []));
      const instr = op < 0 ? '?' : disasm(hw.ir);
      now.replaceChildren(
        h('code', null, `${instr} · T${hw.step < 0 ? '?' : hw.step}`), h('span', { class: 'cw' }, hw.cw < 0 ? 'X' : ctrlText(hw.cw) || '(no lines)'),
        h('span', { class: 'what' }, hw.cw > 0 ? sapGloss(hw.cw) : hw.cw === 0 ? 'nothing moves' : ''));
      for (const s of lines.children as HTMLCollectionOf<HTMLElement>) {
        const n = s.dataset.line as (typeof SAP_CTRL)[number];
        const on = hw.cw >= 0 && (hw.cw & CTRL[n]) !== 0;
        s.classList.toggle('on', on);
        s.setAttribute('aria-label', `${CTRL_LABEL[n]} ${on ? 'on' : 'off'}`);
      }
      steps.replaceChildren(
        h('tr', null, h('th', null, 'step'), h('th', null, 'lines'), h('th', null, 'what moves')),
        ...Array.from({ length: SAP_STEPS }, (_, t) => {
          const w = op < 0 ? 0 : microcode(op, t, hw.cf & 1, hw.zf & 1);
          return h('tr', { class: t === hw.step ? 'cur' : '' }, h('td', null, `T${t}`), h('td', null, h('code', null, ctrlText(w) || '–')), h('td', null, w ? sapGloss(w) : 'nothing'));
        }));
      const reg = (n: string, v: string, title: string) => h('div', { class: 'r', title }, h('span', { class: 'n' }, n), h('span', { class: 'v' }, v));
      regs.replaceChildren(
        reg('PC', hw.pc < 0 ? 'X' : String(hw.pc), 'program counter (4 bits)'),
        reg('MAR', hw.mar < 0 ? 'X' : String(hw.mar), 'memory address register'),
        reg('IR', `${hx(hw.ir)} ${instr}`, 'instruction register: opcode · operand'),
        reg('step', hw.step < 0 ? 'X' : `T${hw.step}`, 'the step counter'),
        reg('A', hw.a < 0 ? 'X' : `${hw.a} · ${hx(hw.a)}`, 'A register'),
        reg('B', hw.b < 0 ? 'X' : `${hw.b} · ${hx(hw.b)}`, 'B register'),
        reg('OUT', hw.out < 0 ? 'X' : String(hw.out), 'output register (the display)'),
        reg('CF ZF', `${hw.cf < 0 ? 'X' : hw.cf} ${hw.zf < 0 ? 'X' : hw.zf}`, 'carry and zero flags'),
        reg('bus', hw.bus < 0 ? 'X' : `${bin(hw.bus, 8)}`, 'the bus now'));
      const keep = listing.scrollTop;
      listing.replaceChildren(...ram.map((v, a) => {
        const src = srcAt.get(a);
        const text = src && src.byte === v ? src.text.replace(/\s+/g, ' ') : v < 0 ? '?' : disasm(v);
        const lab = labelAt.get(a);
        const here = a === hw.pc, inIr = a === mon.cur;
        return h('div', { class: `ln${here ? ' cur' : ''}${inIr ? ' ir' : ''}`, role: 'listitem' },
          h('span', { class: 'm' }, here ? '▸' : inIr ? '●' : ''),
          h('span', { class: 'a' }, hx(a, 1)),
          h('span', { class: 'w' }, bin(v, 8)),
          h('span', { class: 't' }, `${lab ? `${lab}: ` : ''}${text}`),
          h('span', { class: 'd' }, v < 0 ? '' : String(v)));
      }));
      listing.scrollTop = keep;
      outs.textContent = mon.outs.length ? mon.outs.join(' · ') : 'nothing yet';
    };
    return { el, update, destroy: stop };
  };
}

// ---- the real bus: three tri-state drivers at switch level -----------------------------------------------------

/**
 * Three tri-state buffers (each 8 transistors) on one line, with a pull-down (Ben's bus has one per bit): the bus as
 * the 74LS245s make it, without the computer's wired-OR stand-in. Two enabled with different values short VDD to GND.
 */
export const TRISTATE_BUS: ComponentDef = (() => {
  const ys = [3, 11, 19];
  const ports = [0, 1, 2].flatMap((k) => [{ name: `en${k}`, width: 1, dir: 'in' as const }, { name: `d${k}`, width: 1, dir: 'in' as const }]);
  return {
    id: 'sap_tristate', name: 'Three drivers on one line', category: 'cell',
    summary: 'Three tri-state buffers drive one bus line with a pull-down: one enabled sets the line, none leaves it to the pull-down (0), two that disagree short VDD to GND.',
    ports: [...ports, { name: 'line', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'BUS LINE' },
    netlist: () => ({
      level: 'switch',
      pins: {
        ...Object.fromEntries(ys.flatMap((y, k) => [[`en${k}`, [0, y - 2]], [`d${k}`, [0, y + 2]]])),
        line: [30, 11],
      },
      instances: [
        ...ys.map((y, k) => ({ name: `u${k}`, def: TRIBUF, at: [12, y] as [number, number], label: `driver ${k}` })),
        { name: 'pd', def: PULLDOWN, at: [21, 15] as [number, number], label: 'pull-down' },
      ],
      nets: [
        ...ys.flatMap((_, k) => [{ name: `en${k}`, ends: [`en${k}`, `u${k}.en`] }, { name: `d${k}`, ends: [`d${k}`, `u${k}.a`] }]),
        { name: 'line', ends: ['u0.y', 'u1.y', 'u2.y', 'pd.y', 'line'], trunk: 19 },
      ],
    }),
  };
})();

export function tristateScene(): Scene {
  return {
    root: TRISTATE_BUS,
    inputs: { en0: 1, d0: 1, en1: 0, d1: 0, en2: 0, d2: 1 },
    highlight: [],
    panels: [tristatePanel],
  };
}

/** The line's state in words, and the short named when there is one. */
const tristatePanel: ScenePanel = (stage: Stage): Widget => {
  const state = h('div', { class: 'sap-tri' });
  const el = h('div', { class: 'mem-panel sap-tri-panel', 'data-dock': 'left' }, h('h4', null, 'The bus line'), state);
  const update = () => {
    const sim = stage.sim;
    if (!sim) return;
    const on = [0, 1, 2].filter((k) => stage.getInput(`en${k}`) === 1);
    const line = sim.getBits(sim.design.root.ports.line)[0];
    const short = sim instanceof SwitchSim && sim.hasShort ? shortText(sim, sim.shorts()[0]) : null;
    const v = line === B1 ? '1' : line === B0 ? '0' : 'X';
    state.replaceChildren(
      h('p', null, `${on.length ? `Enabled: driver ${on.join(', driver ')}` : 'No driver enabled'} · the line reads `, h('b', null, v),
        on.length === 0 ? ' (the pull-down)' : ''),
      short ? h('p', { class: 'sap-alarm', role: 'alert' }, `Short: ${short}. On the board this is current from 5 V to ground through two output stages: hot chips, a sagging supply, a bus value nobody chose.`)
        : h('p', { class: 'muted' }, on.length > 1 ? 'Two drivers agree: no current flows, but nothing guarantees they keep agreeing.' : 'One driver or none: the line is well defined.'));
  };
  return { el, update };
};
