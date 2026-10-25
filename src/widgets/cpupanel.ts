// Companion panel for a running CPU scene: the program with the current instruction, the
// register file, data memory, and a live check against the golden model (the ISS runs in
// lock-step and every register is compared after each clock edge).

import type { DramConfig } from '../dram/controller';
import { GateSim } from '../sim/gatesim';
import { energyFj, fmtEnergy, fmtPower, POWER_NOTE, PowerMeter, powerW } from '../sim/power';
import type { Sim } from '../sim/sim';
import { analyzeTiming } from '../sim/timing';
import { MC_FIELDS, MC_FSM_SPEC, MC_STATES, dualPipeCpu, microword, multicycleCpu, oooCpu, pipelinedCpu, pipelinedFpCpu, singleCycleCpu, systemCpu } from '../lib';
import { fsmView } from './fsmpanel';
import { assemble, type AsmResult } from '../riscv/asm';
import { cacheLines, cpuState, retireCount, retiring } from '../riscv/cosim';
import { ABI, decode, disasm, regNumber } from '../riscv/isa';
import { ISS, type ModelState } from '../riscv/iss';
import { disasmC, expand16, parcelAt } from '../riscv/rvc';
import { PROGRAMS } from '../riscv/programs';
import { SYSTEM_PROGRAMS } from '../riscv/sysprograms';
import { M_PROGRAMS } from '../riscv/mprograms';
import { PIPE_M_PROGRAMS } from '../riscv/pmprograms';
import { CACHE_CPU_PROGRAMS } from '../riscv/cprograms';
import { F_PROGRAMS } from '../riscv/fprograms';
import { FABI } from '../riscv/isa';
import { bitsToF32, flagNames, RM_NAMES } from '../sim/fpref';
import { CAUSE } from '../riscv/iss';
import { pack } from '../sim/values';
import { debounce, h } from '../ui/dom';
import { codeEditor } from './codeedit';
import { stepEffect } from '../riscv/trace';
import { DECK_EXT, deckFromJson, deckToJson } from '../cards/card';
import { deckProgram, programCards } from '../cards/program';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import type { FieldKey } from '../riscv/fields';
import { instrUse, oooUse, stageUse, STAGE_UNITS } from './insthw';
import { isOooCore, oooSnap } from '../riscv/ooosnap';
import { oooPanel, type OooLink } from './ooopanel';
import { clearInstr, markInstr, slowControls } from './slowctl';
import { instrBreakdown } from './instrfields';
import { PipeHistory, pipeGridRows } from './pipegrid';
import { timingPanel } from './timing';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

export interface CpuSceneOptions {
  source: string;
  highlight?: string[];
  adder?: 'rca' | 'ks';
  /** Attach the static-timing panel. */
  timing?: boolean;
  /** Use the five-stage pipelined CPU (adds the pipeline diagram). */
  pipeline?: boolean;
  balanced?: boolean;
  predictor?: boolean;
  /** The complete machine: Zicsr, traps, interrupts and memory-mapped I/O (adds the I/O panel). */
  system?: boolean;
  /** Add the M extension to the system CPU (multiply / divide unit). */
  m?: boolean;
  /** Single-cycle CPU with a data cache in front of a slow main memory (adds cache statistics): see CpuOptions.dcache. */
  dcache?: boolean | 'wb' | 'wb2';
  /** With dcache 'wb' / 'wb2': main memory is chapter 36's DRAM controller and device. */
  dram?: DramConfig;
  /** Fetch through an instruction cache (adds fetch-miss stalls). */
  icache?: boolean;
  /** The multicycle CPU with a hardwired or microprogrammed controller (adds the controller panel). */
  multicycle?: 'fsm' | 'micro';
  /** Single-cycle CPU with the FPU and f registers (chapter 24). */
  fpu?: boolean;
  /** Show the program editor. */
  editable?: boolean;
  /** The dual-issue RV32IM pipeline of chapter 26 (implies pipeline and m: two lanes in the listing and the diagram). */
  wide?: boolean;
  /** Chapter 26's out-of-order core (implies m; runs on the cycle engine; adds the Out of order panel). */
  ooo?: boolean;
  /** The single-cycle CPU's ROM (2^imemK words) and data memory (2^dmemK words), when not the defaults (6 and 5). */
  imemK?: number;
  dmemK?: number;
  /** Panels docked beside the CPU panel (chapter 15's Python panel); with them the program is theirs to choose. */
  extraPanels?: ScenePanel[];
  /** The single-cycle RV32IC CPU (chapter 25): 16-bit instructions in the listing at 2-byte addresses. */
  c?: boolean;
}

/** The out-of-order core's instruction ROM: 2^k words, at least 64. */
const oooImemK = (words: number[]) => Math.max(6, Math.ceil(Math.log2(Math.max(1, words.length))));

/** A scene running `source` on the single-cycle CPU, with the CPU panel attached. */
export function cpuScene(sceneOpts: CpuSceneOptions): Scene {
  const opts = sceneOpts.wide ? { ...sceneOpts, pipeline: true, m: true } : sceneOpts.ooo ? { ...sceneOpts, m: true } : sceneOpts;
  // the C core runs any program compressed, unless the program says otherwise (.option norvc / rvc)
  const asm = assemble(opts.c && !/^\s*\.option\s/m.test(opts.source) ? `.option rvc\n${opts.source}` : opts.source);
  // the CPU panel and the Out of order panel share the selected instruction
  const link: OooLink = {};
  return {
    ...(opts.ooo ? { engine: 'cycle' as const } : {}),
    root: opts.wide ? dualPipeCpu(asm.words, { dmemK: 6 })
      : opts.ooo ? oooCpu(asm.words, { imemK: oooImemK(asm.words), dmemK: 6 })
      : opts.multicycle ? multicycleCpu(asm.words, { control: opts.multicycle, adder: opts.adder })
      : opts.system ? systemCpu(asm.words, { adder: opts.adder, m: opts.m })
      : opts.pipeline && opts.fpu ? pipelinedFpCpu(asm.words, { adder: opts.adder })
      : opts.pipeline ? pipelinedCpu(asm.words, { adder: opts.adder, balanced: opts.balanced, predictor: opts.predictor, dcache: opts.dcache === true ? 'wt' : opts.dcache || undefined, m: opts.m, dram: opts.dram })
        : singleCycleCpu(asm.words, opts.dcache || opts.icache ? { adder: opts.adder, ...(opts.dcache ? { dmemK: 6, dcache: opts.dcache, dram: opts.dram } : {}), icache: opts.icache } : { adder: opts.adder, fpu: opts.fpu, imemK: opts.imemK, dmemK: opts.dmemK, c: opts.c }),
    inputs: opts.system ? { clk: 0, switches: 0, irq: 0 } : { clk: 0 },
    highlight: opts.highlight,
    panels: [cpuPanel({ ...opts, asm, link }), ...(opts.pipeline ? [pipeDiagram(asm)] : []),
      ...(opts.ooo ? [oooPanel(asm.words, { imemWords: 2 ** oooImemK(asm.words), dmemWords: 64 }, link)] : []), ...(opts.system ? [ioPanel] : []), ...(opts.multicycle ? [controllerPanel(opts.multicycle, true)] : []), ...(opts.timing ? [timingPanel] : []), ...(opts.extraPanels ?? [])],
  };
}

function cpuPanel(opts: CpuSceneOptions & { asm: AsmResult; link?: OooLink }): ScenePanel {
  return (stage: Stage): Widget => {
    const asm = opts.asm;
    const issOpts = opts.system ? { system: true, imemWords: 128, m: !!opts.m } : opts.ooo ? { dmemWords: 64, imemWords: 2 ** oooImemK(asm.words) } : opts.dcache || opts.wide ? { dmemWords: 64 }
      : { ...(opts.imemK ? { imemWords: 2 ** opts.imemK } : {}), ...(opts.dmemK ? { dmemWords: 2 ** opts.dmemK } : {}), ...(opts.c ? { c: true } : {}) };
    let iss = new ISS(asm.words, issOpts);
    let lastX: number[] = new Array(32).fill(0);
    let changed = new Set<number>();
    let mismatch: string | null = null;
    let running: number | null = null;
    /** Retired instructions, newest last (the last LOG_MAX are kept). */
    const LOG_MAX = 200;
    const log: { cycle: number; pc: number; text: string; effect: string }[] = [];
    let logSeq = 0, logShown = 0;
    const trace = h('div', { class: 'cpu-trace' });
    /** The listing line the user clicked: its hardware stays highlighted. */
    let selPc: number | null = null;
    /** The out-of-order core: the port the selected instruction was bound to (-1: not known). */
    let selPort = -1;
    if (opts.link) {
      opts.link.select = (pc, port = -1) => { selPc = pc; selPort = port; update(); };
      opts.link.selected = () => selPc;
    }
    const usePath = h('div', { class: 'cpu-use' });
    /** Instruction breakdown: the field pinned by a click, the one under the pointer. */
    let fieldPin: FieldKey | null = null, fieldHover: FieldKey | null = null;
    const fieldsBox = h('div', { class: 'cpu-fields' });
    let fieldsShown = '';

    const status = h('div', { class: 'cpu-status' });
    // On a halt, in words: how long it ran, and the answer when the program names its register (Program.result).
    const haltLine = h('div', { class: 'cpu-halt', role: 'status', hidden: true });
    const listing = h('div', { class: 'cpu-listing' });
    const regs = h('div', { class: 'cpu-regs' });
    const mem = h('div', { class: 'cpu-mem' });
    const now = h('div', { class: 'cpu-now' });
    const dlines = h('div', { class: 'cpu-mem dcache-lines' });
    const fregs = h('div', { class: 'cpu-mem' });
    let loads = 0, misses = 0, prevStall = false, stallRun = 0;
    /** Energy (sim/power.ts): toggles counted from reset, or from the last Back (a restored state's toggles are not known). */
    let meter: PowerMeter | null = null, meterSteps = 0, meterCycles = 0, period: number | null | undefined;
    const restartMeter = () => { meter?.reset(); meterSteps = iss.steps; meterCycles = stage.cycles; };
    const energy = (sim: Sim): HTMLElement[] => {
      if (!(sim instanceof GateSim)) return [];
      if (!meter || meter.sim !== sim) { meter = new PowerMeter(sim); meterSteps = iss.steps; meterCycles = stage.cycles; }
      const steps = iss.steps - meterSteps, cycles = stage.cycles - meterCycles;
      if (steps <= 0 || cycles <= 0 || stage.inEdge) return [];
      if (period === undefined) period = analyzeTiming(sim.design)?.period ?? null;
      const fj = energyFj(meter.totals().switched);
      return [h('span', { title: `${POWER_NOTE} Over the last ${steps} instructions (from reset or the last Back); power at the clock static timing allows.` },
        `≈ ${fmtEnergy(fj / steps)} / instr${period ? ` · ${fmtPower(powerW(fj / cycles, period))}` : ''}`)];
    };
    const wb = opts.dcache === 'wb' || opts.dcache === 'wb2';
    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    const progs = opts.fpu ? [...F_PROGRAMS, ...PROGRAMS] : opts.dcache ? [...CACHE_CPU_PROGRAMS, ...PROGRAMS] : (opts.pipeline || opts.ooo) && opts.m ? [...PIPE_M_PROGRAMS, ...PROGRAMS] : opts.m ? [...M_PROGRAMS, ...SYSTEM_PROGRAMS, ...PROGRAMS] : opts.system ? [...SYSTEM_PROGRAMS, ...PROGRAMS] : PROGRAMS;
    for (const p of progs) sel.append(h('option', { value: p.id }, p.name));
    sel.append(h('option', { value: '__custom' }, 'My program'));
    const match = progs.find((p) => p.source === opts.source);
    sel.value = match ? match.id : '__custom';
    sel.addEventListener('change', () => {
      const p = progs.find((q) => q.id === sel.value);
      if (p) stage.load(cpuScene({ ...opts, source: p.source }));
    });

    const runBtn = h('button', { class: 'btn sm primary', title: 'Run until the program halts' }, 'Run to halt');
    const stopRun = () => {
      if (running) cancelAnimationFrame(running);
      running = null;
      runBtn.textContent = 'Run to halt';
    };
    runBtn.addEventListener('click', () => {
      if (running) return stopRun();
      slowCtl.stop();
      slowCtl.tracing = false;
      // Back after a run returns to where it started.
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      const tick = () => {
        stage.runCycles(opts.ooo ? 2 : opts.pipeline ? 3 : opts.m || opts.fpu || opts.dcache || opts.icache || opts.multicycle ? 10 : 4, () => iss.halted);
        if (iss.halted || mismatch || stage.cycles > 20000) return stopRun();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });

    // Slow mode: the learner sets the pace and the level of detail; the highlight follows execution.
    /** Cycles and instructions differ only when an instruction can take several cycles. */
    const multiCycle = !!(opts.pipeline || opts.ooo || opts.multicycle || opts.m || opts.dcache || opts.icache);
    const finished = () => iss.halted || !!mismatch || stage.cycles > 20000;
    const slowCtl = slowControls(stage, { multiCycle, finished, onStart: () => stopRun() });

    // Errors go to the gutter as you type (debounced) and below the box on Assemble & load.
    const errBox = h('div', { class: 'asm-errors' });
    const check = debounce(() => editor.setDiagnostics(assemble(editor.value).errors), 300);
    const editor = codeEditor({ value: opts.source, lang: 'rvasm', rows: 14, onChange: () => { errBox.textContent = ''; check(); } });
    editor.el.classList.add('asm-editor');
    const editWrap = h('div', { class: 'cpu-edit', style: 'display:none' }, editor.el, errBox,
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' },
        h('button', {
          class: 'btn sm primary', onclick: () => {
            const r = assemble(editor.value);
            editor.setDiagnostics(r.errors);
            if (r.errors.length) {
              errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n');
              return;
            }
            stage.load(cpuScene({ ...opts, source: editor.value }));
          },
        }, 'Assemble & load'),
        h('button', { class: 'btn sm', title: 'Download the program as a deck of punched cards (.deck.json): one card a word, printed with its source line', onclick: saveAsDeck }, 'Save as deck'),
        h('button', { class: 'btn sm', title: 'Put the words of a deck of cards in the box (.word lines, each card’s print a comment)', onclick: loadDeck }, 'Load deck…'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = 'none'; } }, 'Close')));
    // Decks of punched cards (cards/program.ts, shared with the sandbox's ROMs): one object card a word.
    function saveAsDeck(): void {
      const r = assemble(editor.value);
      editor.setDiagnostics(r.errors);
      if (r.errors.length) return void (errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n'));
      if (!r.words.length) return void (errBox.textContent = 'The program is empty: nothing to punch.');
      const name = progs.find((p) => p.id === sel.value)?.name ?? 'my program';
      const deck = programCards(name, editor.value, r.lines.map((l) => ({ word: l.word, srcLine: l.srcLine, dis: disasm(l.word, l.addr) })));
      const file = `${name.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'program'}${DECK_EXT}`;
      void import('../view/image').then((m) => m.saveFile(file, deckToJson(deck)));
    }
    function loadDeck(): void {
      const input = h('input', { type: 'file', accept: `${DECK_EXT},.json,application/json`, style: 'display:none' }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        input.remove();
        if (!f) return;
        void f.text().then((text) => {
          const d = deckFromJson(text);
          if (typeof d === 'string') return void (errBox.textContent = `${f.name}: ${d}`);
          editor.value = deckProgram(d, 32, 'asm');
          errBox.textContent = '';
          check();
        }, () => { errBox.textContent = `${f.name}: could not be read`; });
      });
      editWrap.append(input);
      input.click();
    }
    const editBtn = h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = editWrap.style.display === 'none' ? 'block' : 'none'; } }, 'Edit');

    const body = h('div', { class: 'cpu-body' },
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, ...(opts.extraPanels?.length ? [] : [sel, editBtn]), runBtn),
      slowCtl.el,
      editWrap, status, haltLine, now,
      h('div', { class: 'cpu-sec' }, 'Program', h('span', { class: 'cpu-sec-hint' }, 'click a line: its hardware')), listing, usePath,
      h('div', { class: 'cpu-sec' }, 'Fields', h('span', { class: 'cpu-sec-hint' }, 'point at a field: its wires')), fieldsBox,
      h('div', { class: 'cpu-sec' }, 'Trace', h('span', { class: 'cpu-sec-hint' }, 'retired instructions, newest last')), trace,
      h('div', { class: 'cpu-sec' }, 'Registers'), regs,
      ...(opts.fpu ? [h('div', { class: 'cpu-sec' }, 'Floating-point registers (non-zero)'), fregs] : []),
      ...(opts.dcache ? [h('div', { class: 'cpu-sec' }, opts.dcache === 'wb2' ? 'Data cache (2 sets × 2 ways × 4 words, write-back)' : opts.dcache === 'wb' ? 'Data cache (4 lines × 4 words, write-back)' : 'Data cache (4 lines × 4 words)'), dlines] : []),
      h('div', { class: 'cpu-sec' }, wb ? 'Memory as the program sees it (dirty lines included)' : opts.dcache ? 'Main memory (non-zero words)' : 'Data memory (non-zero words)'), mem);
    const title = h('h4', null, opts.multicycle ? 'RV32I multicycle' : opts.fpu ? (opts.pipeline ? 'RV32IF pipeline' : 'RV32IF CPU') : opts.system ? (opts.m ? 'RV32IM system' : 'RV32I system') : opts.wide ? 'RV32IM dual-issue pipeline' : opts.ooo ? 'RV32IM out-of-order core' : opts.pipeline ? (opts.m ? 'RV32IM pipeline' : 'RV32I pipeline') : opts.c ? 'RV32IC CPU' : 'RV32I CPU', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' }, title, body);

    // Golden model in lock-step: it executes one instruction whenever the hardware retires one
    // (every cycle for the single-cycle CPU; when a valid instruction leaves W for the pipeline;
    // as many as retire, oldest first, for a CPU that retires several a cycle).
    let willRetire = 0;
    stage.edgeHooks.add({
      before: () => {
        willRetire = stage.sim ? retireCount(stage.sim) : 0;
        stallRun = stage.sim && cacheStall(stage.sim) ? stallRun + 1 : 0;
        if (opts.dcache && stage.sim) {
          const dm = stage.sim.design.root.children!.get('dm')!;
          // an access completes when it does not stall; a miss starts on the first stalled cycle
          const dst = stage.sim.getBits(dm.ports.stall)[0] === 1;
          const acc = stage.sim.getBits(dm.ports.re)[0] === 1 || (wb && stage.sim.getBits(dm.ports.we)[0] === 1);
          if (acc && !dst) loads++;
          if (dst && !prevStall) misses++;
          prevStall = dst;
        }
        if (opts.system) {
          iss.irq = stage.getInput('irq') === 1;
          iss.switches = stage.getInput('switches');
        }
      },
      after: () => {
        if (willRetire) slowCtl.retired();
        if (!willRetire || iss.halted || !stage.sim) return;
        for (let k = 0; k < willRetire && !iss.halted; k++) {
          const info = iss.step();
          log.push({ cycle: stage.cycles, pc: info.pc, text: info.text, effect: stepEffect(info) });
          if (log.length > LOG_MAX) log.shift();
          logSeq++;
        }
        if (!mismatch) {
          const x = cpuState(stage.sim).x;
          const diff = x.findIndex((v, i) => v !== iss.x[i]);
          const f = cpuState(stage.sim).f;
          const fd = f ? f.findIndex((v, i) => v !== iss.f[i]) : -1;
          if (fd >= 0 && diff < 0) mismatch = `${FABI[fd]} differs: hardware ${hex(f![fd])}, model ${hex(iss.f[fd])}`;
          const fc = cpuState(stage.sim).fcsr;
          if (fc !== undefined && fc !== ((iss.frm << 5) | iss.fflags) && diff < 0 && fd < 0) mismatch = `fcsr differs: hardware ${hex(fc, 2)}, model ${hex((iss.frm << 5) | iss.fflags, 2)}`;
          if (diff >= 0) mismatch = `${ABI[diff]} differs after "${disasm(iss.imem[(iss.pc >>> 2) % (issOpts.imemWords ?? 64)] ?? 0x13)}": hardware ${hex(x[diff])}, model ${hex(iss.x[diff])}`;
        }
      },
    });
    // Back: the golden model, the trace and the counters return with the hardware.
    stage.historyHooks.add({
      save: () => ({ iss: iss.save(), lastX: lastX.slice(), mismatch, log: log.slice(), logSeq, loads, misses, prevStall, stallRun }),
      restore: (v) => {
        const st = v as { iss: ModelState; lastX: number[]; mismatch: string | null; log: typeof log; logSeq: number; loads: number; misses: number; prevStall: boolean; stallRun: number };
        stopRun();
        slowCtl.stop();
        iss.restore(st.iss);
        lastX = st.lastX.slice();
        mismatch = st.mismatch;
        log.splice(0, log.length, ...st.log);
        logSeq = st.logSeq;
        ({ loads, misses, prevStall, stallRun } = st);
        // rebuilt in full by the next showTrace
        trace.replaceChildren();
        logShown = logSeq - log.length;
        if (!log.length) logShown = logSeq;
        restartMeter();
      },
    });
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      slowCtl.update();
      if (stage.cycles === 0 && iss.steps > 0) {
        iss = new ISS(asm.words, issOpts);
        mismatch = null;
        slowCtl.tracing = false;
        log.length = 0;
        logSeq = logShown = 0;
        trace.replaceChildren();
        loads = misses = 0;
        prevStall = false;
        stallRun = 0;
        restartMeter();
      }
      const st = cpuState(sim);
      changed = new Set();
      st.x.forEach((v, i) => { if (v !== lastX[i]) changed.add(i); });
      // During a slow-mode edge, keep comparing with the registers before it.
      if (!stage.inEdge) lastX = st.x;
      const atBoundary = !sim.design.root.ports.fetch || sim.getBits(sim.design.root.ports.fetch)[0] === 1;
      // Mid-edge the PC register has already moved but the golden model steps only when the edge is done.
      if (!mismatch && !opts.pipeline && !opts.ooo && !stage.inEdge && atBoundary && st.pc !== iss.pc) mismatch = `PC differs: hardware ${hex(st.pc)}, model ${hex(iss.pc)}`;
      const halted = iss.halted;
      const parts: HTMLElement[] = [
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, opts.pipeline || opts.m || opts.fpu || opts.multicycle ? `retired ${iss.steps}${iss.steps ? ` · CPI ${(stage.cycles / iss.steps).toFixed(2)}` : ''}` : `PC ${hex(st.pc, 4)}`),
        ...(opts.m && !opts.ooo && (opts.pipeline ? divStall(sim) : !retiring(sim)) ? [h('span', { class: 'warn', title: 'The iterative divider is working; the PC and register writes are stalled' }, 'dividing… stalled')] : []),
        ...(opts.fpu && !opts.pipeline && !retiring(sim) ? [h('span', { class: 'warn', title: 'An iterative unit (fdiv.s / fsqrt.s) is working; the PC and register writes are stalled' }, 'fdiv / fsqrt… stalled')] : []),
        ...(opts.dcache ? [h('span', null, `${wb ? 'accesses' : 'loads'} ${loads} · misses ${misses}${loads ? ` · hit rate ${(100 * (loads - misses) / loads).toFixed(0)} %` : ''}`)] : []),
        ...((opts.dcache || opts.icache) && cacheStall(sim) ? [h('span', { class: 'warn', title: 'A cache missed: the PC and register write wait while the line is moved' }, `miss: waiting for memory (cycle ${stallRun + 1})`)] : []),
        ...energy(sim),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good', title: 'Every register and the PC match the instruction-set simulator after every cycle' }, '✓ matches golden model'),
      ];
      if (halted) parts.push(h('span', { class: 'warn' }, 'halted'));
      status.replaceChildren(...parts);
      haltLine.hidden = !halted || !!mismatch;
      if (halted && !mismatch) {
        const res = match?.result, r = res ? regNumber(res.reg) : null;
        haltLine.replaceChildren(`Halted after ${iss.steps.toLocaleString()} instruction${iss.steps === 1 ? '' : 's'}`,
          multiCycle ? ` (${stage.cycles.toLocaleString()} cycles)` : '',
          res && r !== null ? h('span', { title: `The program leaves its answer in ${res.reg}` }, ' · result ', h('b', null, `${res.reg} = ${st.x[r] | 0}`), ` (${hex(st.x[r])})`) : '');
      }
      const shownPc = opts.multicycle && !atBoundary ? iss.pc : st.pc;
      const w = wordAt(shownPc);
      const d = decode(w);
      const short = opts.c ? parcelAt(asm.words, shownPc) : null;
      now.replaceChildren(
        h('span', { class: 'fmt' }, short?.size === 2 ? `16-bit → ${d.fmt}-type` : `${d.fmt}-type`),
        h('code', null, dis(shownPc)),
        h('span', { class: 'hexw' }, short?.size === 2 ? hex(short.bits, 4) : hex(w)),
      );
      // Pipelined CPU: where every in-flight instruction is right now.
      const inFlight = new Map<number, string[]>();
      if (opts.pipeline) {
        const root = sim.design.root.children!;
        const v = (inst: string, port: string) => pack(sim.getBits(root.get(inst)!.ports[port]));
        const slots: [string, number, boolean][] = [
          ['F', v('pc', 'q'), true], ['D', v('FD', 'pcD'), v('FD', 'validD') === 1], ['E', v('DE', 'pcE'), v('DE', 'validE') === 1],
          ['M', v('EM', 'pcM'), v('EM', 'validM') === 1],
          // the pipelined FPU CPU has a sixth stage, X, between M and W
          ...(root.has('MX') ? [['X', v('MX', 'pcX'), v('MX', 'validX') === 1], ['W', v('XW', 'pcW'), v('XW', 'validW') === 1]] as [string, number, boolean][]
            : [['W', v('MW', 'pcW'), v('MW', 'validW') === 1]] as [string, number, boolean][]),
          // the dual-issue pipeline's second lane (the younger instruction of each stage)
          ...(root.has('FD1') ? [['F₁', (v('pc', 'q') + 4) >>> 0, v('fctl', 'valid1') === 1], ['D₁', v('FD1', 'pcD'), v('FD1', 'validD') === 1],
            ['E₁', v('DE1', 'pcE'), v('DE1', 'validE') === 1], ['M₁', v('EM1', 'pcM'), v('EM1', 'validM') === 1], ['W₁', v('MW1', 'pcW'), v('MW1', 'validW') === 1]] as [string, number, boolean][] : []),
        ];
        for (const [stg, pc, valid] of slots) if (valid && pc >= 0) inFlight.set(pc >>> 0, [...(inFlight.get(pc >>> 0) ?? []), stg]);
      } else if (opts.ooo && isOooCore(sim.design.root)) {
        // the out-of-order core: fetched, waiting in the issue queue, executing, done in the reorder buffer
        const snap = oooSnap(sim, sim.design.root), at = (pc: number, s: string) => inFlight.set(pc >>> 0, [...(inFlight.get(pc >>> 0) ?? []), s]);
        for (const f of snap.fetched) at(f.pc, 'F');
        for (const r of snap.rob) at(r.pc, r.done ? 'ROB' : snap.iq.some((e) => e.tag === r.tag) ? 'IQ' : 'EX');
      }
      const keepScroll = listing.scrollTop;
      listing.replaceChildren(...asm.lines.map((l) => {
        const sel = l.addr === selPc;
        const line = h('div', { class: `ln${l.addr === shownPc ? ' cur' : ''}${sel ? ' sel' : ''}`, title: 'Show the hardware this instruction uses' },
          h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
          h('span', { class: 'w' }, l.word.toString(16).padStart(l.size === 2 ? 4 : 8, '0')),
          h('span', { class: 't' }, l.text),
          ...(inFlight.get(l.addr) ?? []).map((s) => h('span', { class: 'stg' }, s)),
          // the C core's ROM is two banks of halfwords: no single word to open at
          sel && !opts.c && stage.rootCtx?.canOpen('imem') ? h('button', { class: 'rom-btn', title: 'Open the instruction memory at the word that holds this instruction', onclick: (e: Event) => {
            e.stopPropagation();
            stage.reveal(opts.icache ? ['imem', 'rom'] : ['imem'], `c${(l.addr >>> 2)}`);
          } }, 'in ROM ↗') : null);
        line.addEventListener('click', () => {
          selPc = sel ? null : l.addr;
          update();
        });
        return line;
      }));
      const cur = listing.querySelector('.cur') as HTMLElement | null;
      if (selPc !== null) listing.scrollTop = keepScroll;
      else if (cur) listing.scrollTop = Math.max(0, cur.offsetTop - listing.offsetTop - 40);
      showUse(inFlight, shownPc);
      showTrace();
      regs.replaceChildren(...st.x.map((v, i) => h('div', { class: `r${changed.has(i) && stage.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `x${i} = ${v | 0}` },
        h('span', { class: 'n' }, `${ABI[i]}`), h('span', { class: 'v' }, hex(v)))));
      if (st.f) {
        const nz = st.f.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
        const fc = st.fcsr ?? 0;
        const fcsrRow = h('div', { class: 'm', title: 'fcsr: the dynamic rounding mode frm and the accrued exception flags (sticky)' },
          h('span', { class: 'n' }, 'fcsr'), h('span', { class: 'v' }, `frm ${RM_NAMES[fc >> 5] ?? fc >> 5}`), h('span', { class: 'd' }, `flags ${flagNames(fc & 31)}`));
        fregs.replaceChildren(fcsrRow, ...(nz.length ? nz.map(([i, v]) => h('div', { class: 'm' },
          h('span', { class: 'n' }, FABI[i]), h('span', { class: 'v' }, hex(v)), h('span', { class: 'd' }, String(+bitsToF32(v).toPrecision(8))))) : [h('div', { class: 'm z' }, 'all +0.0')]));
      }
      if (opts.dcache) {
        const lines = cacheLines(sim, sim.design.root.children!.get('dm')!);
        const twoWay = lines.some((l) => l.way > 0);
        dlines.replaceChildren(...lines.map((l) => h('div', { class: `m${l.valid ? '' : ' z'}` },
          h('span', { class: 'n' }, `${l.set}${twoWay ? `.${l.way}` : ''}: ${l.valid ? `tag ${l.tag}${l.dirty ? ' dirty' : ''}` : 'empty'}`),
          h('span', { class: 'v' }, l.valid ? l.words.map((v) => v.toString(16)).join(' ') : ''))));
      }
      const words = st.dmem.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
      mem.replaceChildren(...(words.length ? words.map(([i, v]) => h('div', { class: 'm' },
        h('span', { class: 'n' }, `[${hex(i * 4, 2)}]`), h('span', { class: 'v' }, hex(v)), h('span', { class: 'd' }, String(v | 0)))) : [h('div', { class: 'm z' }, 'all zero')]));
    };
    /** The instruction at pc as the core runs it (a 16-bit one: its expansion), and as written. */
    const wordAt = (pc: number) => {
      if (!opts.c) return asm.words[pc >>> 2] ?? 0x13;
      const p = parcelAt(asm.words, pc);
      return p.size === 2 ? expand16(p.bits) ?? 0 : p.bits;
    };
    const dis = (pc: number) => {
      const p = opts.c ? parcelAt(asm.words, pc) : null;
      return p?.size === 2 ? disasmC(p.bits, pc) : disasm(wordAt(pc), pc);
    };
    const fieldFocus = () => fieldHover ?? fieldPin;
    /** Colour the fields of `word` and light `units` (slowctl.ts markInstr). Returns a note for the use line. */
    const markFields = (word: number | null, units: string[]): string | undefined => markInstr(stage, word, units, fieldFocus());
    /** The breakdown of the instruction at pc, rebuilt only when that instruction changes. */
    const showFields = (pc: number, role: string) => {
      const w = wordAt(pc);
      const key = `${pc}:${w}:${role}`;
      if (key !== fieldsShown) {
        fieldsShown = key;
        fieldsBox.replaceChildren(
          h('div', { class: 'cpu-fields-head' }, h('code', null, dis(pc)), h('span', null, opts.c && dis(pc).startsWith('c.') ? `${role} · runs as ${disasm(w, pc)}` : role)),
          instrBreakdown(w, {
            compact: true, onField: (k, sticky) => {
              if (sticky) fieldPin = fieldPin === k ? null : k;
              else fieldHover = k;
              update();
            },
          }));
      }
      fieldsBox.querySelectorAll<HTMLElement>('[data-field]').forEach((e) => e.classList.toggle('on', e.dataset.field === fieldPin));
    };
    /**
     * Highlight what the selected instruction uses (or, in the pipeline, the stage it is in now).
     * In slow mode with nothing selected, follow execution: the current instruction, or every
     * in-flight instruction's part of the work in its stage. The wires of the instruction's fields
     * take their colours, also inside the immediate generator and the control unit.
     */
    const showUse = (inFlight: Map<number, string[]>, shownPc: number) => {
      // The pipeline splits the instruction in Decode, so its field wires carry the one in D.
      const dPc = [...inFlight].find(([, s]) => s.includes('D'))?.[0];
      const bdPc = selPc ?? dPc ?? shownPc;
      showFields(bdPc, selPc !== null ? 'selected' : dPc !== undefined ? 'in Decode' : 'current');
      if (selPc === null && slowCtl.tracing && opts.pipeline && !fieldFocus()) {
        const order = Object.keys(STAGE_UNITS);
        const rows = [...inFlight].flatMap(([pc, stgs]) => stgs.map((s) => [s as keyof typeof STAGE_UNITS, pc] as const))
          .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
        const note = markFields(dPc === undefined ? null : wordAt(dPc), rows.flatMap(([s, pc]) => stageUse(s, instrUse(wordAt(pc)))));
        usePath.replaceChildren(...rows.map(([s, pc]) => h('div', { class: 'flight' }, h('span', { class: 'stg' }, s), h('code', null, disasm(wordAt(pc), pc)))),
          note ? h('div', { class: 'ibd-note' }, note) : '');
        return;
      }
      const pc = selPc ?? (slowCtl.tracing || fieldFocus() ? bdPc : null);
      if (pc === null) {
        usePath.replaceChildren();
        clearInstr(stage);
        return;
      }
      const w = wordAt(pc);
      const use = opts.ooo ? oooUse(w, pc === selPc ? selPort : -1) : instrUse(w);
      const stages = inFlight.get(pc) ?? [];
      // the out-of-order core decodes in two slots: no single set of field wires to colour
      const carried = !opts.ooo && (!opts.pipeline || !stages.length || stages.includes('D'));
      const note = markFields(carried ? w : null, stages.length && !opts.ooo ? stages.flatMap((s) => stageUse(s as keyof typeof STAGE_UNITS, use)) : use.units);
      usePath.replaceChildren(h('code', null, dis(pc)), h('span', null,
        opts.ooo ? (stages.length ? ` · now ${stages.join(' + ')} (F fetched, IQ waiting, EX executing, ROB done); highlighted: all the hardware it uses.` : ' · not in flight now; highlighted: all the hardware it uses.')
          : opts.pipeline ? (stages.length ? ` · now in ${stages.join(' + ')}; highlighted: that stage's part of the work.` : ' · not in the pipeline now; highlighted: all the hardware it uses.') : ''),
        h('div', null, use.path),
        !carried && !opts.ooo ? h('div', { class: 'ibd-note' }, 'Field colours appear while it is in D, where the instruction is split.') : '',
        note ? h('div', { class: 'ibd-note' }, note) : '');
    };
    /** Append the newly retired instructions to the trace (the log is never rebuilt while it grows). */
    const showTrace = () => {
      const fresh = logSeq - logShown;
      if (!fresh) return;
      if (fresh >= log.length) trace.replaceChildren();
      trace.querySelector('.new')?.classList.remove('new');
      for (const e of log.slice(-Math.min(fresh, log.length))) {
        trace.append(h('div', { class: 'tr', title: 'Select this instruction in the listing', onclick: () => { selPc = e.pc; update(); } },
          h('span', { class: 'c' }, String(e.cycle)), h('span', { class: 't' }, e.text), h('span', { class: 'eff' }, e.effect)));
      }
      while (trace.childElementCount > LOG_MAX) trace.firstElementChild!.remove();
      trace.lastElementChild?.classList.add('new');
      trace.scrollTop = trace.scrollHeight;
      logShown = logSeq;
    };
    // Opening the immediate generator or the control unit keeps the instruction's colours.
    const unNav = stage.onNavigate(() => update());
    update();
    return {
      el, update, destroy: () => {
        stopRun();
        slowCtl.stop();
        unNav();
        stage.markNets(new Map());
        if (stage.path.length === 0) stage.highlight(stage.scene?.highlight ?? []);
      },
    };
  };
}

/** Pipeline diagram: which instruction occupies each stage in each cycle. */
function pipeDiagram(asm: AsmResult): ScenePanel {
  return (stage: Stage): Widget => {
    const history = new PipeHistory();
    const grid = h('div', { class: 'pipe-grid' });
    // folded by the stage (data-fold): it may start folded when it would squeeze the circuit
    const title = h('h4', null, h('span', null, 'Pipeline diagram ', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'stage × cycle')), h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel pipe-panel', 'data-dock': 'left', 'data-fold': 'narrow', 'data-phone': 'flow' }, title, grid);
    const record = () => {
      const sim = stage.sim, root = stage.rootCtx?.node;
      if (sim && root) history.record(sim, root, stage.cycles);
    };
    stage.edgeHooks.add({ after: record });
    const update = () => {
      if (stage.cycles === 0 || history.last?.cycle !== stage.cycles) {
        if (stage.cycles === 0) history.clear();
        record();
      }
      grid.replaceChildren(...pipeGridRows(history.snaps, (pc) => asm.words[pc >>> 2]));
      grid.scrollLeft = grid.scrollWidth; // the newest cycle in view (a narrow panel scrolls the grid)
    };
    update();
    return { el, update };
  };
}

const CAUSE_NAMES: Record<number, string> = {
  [CAUSE.MISALIGNED_FETCH]: 'misaligned fetch', [CAUSE.ILLEGAL]: 'illegal instruction', [CAUSE.BREAKPOINT]: 'breakpoint',
  [CAUSE.MISALIGNED_LOAD]: 'misaligned load', [CAUSE.MISALIGNED_STORE]: 'misaligned store', [CAUSE.ECALL]: 'ecall',
  [CAUSE.TIMER_IRQ]: 'timer interrupt', [CAUSE.EXTERNAL_IRQ]: 'external interrupt',
};

/** Console, LEDs, switches, the IRQ button and the machine-mode CSRs of a system CPU scene. */
const ioPanel: ScenePanel = (stage: Stage): Widget => {
  let text = '';
  const con = h('pre', { class: 'console' });
  const leds = h('div', { class: 'leds' });
  const sw = h('div', { class: 'switches' });
  const csrs = h('div', { class: 'cpu-mem' });
  const irqBtn = h('button', { class: 'btn sm primary', title: 'Raise the external interrupt for one clock cycle' }, 'IRQ (one cycle)');
  irqBtn.addEventListener('click', () => {
    stage.setInputs({ irq: 1 });
    stage.pulse();
    stage.setInputs({ irq: 0 });
  });
  stage.edgeHooks.add({
    before: () => {
      const sim = stage.sim;
      if (!sim) return;
      const r = sim.design.root;
      if (sim.getBits(r.ports.consoleValid)[0] === 1) text += String.fromCharCode(pack(sim.getBits(r.ports.consoleData)) & 0xff);
    },
  });
  // Folded by the stage (data-fold): it may start folded on a small stage. Two columns where the dock is wide
  // (app.css: a container query), so it takes half the height off the circuit.
  const title = h('h4', null, 'I/O & machine state', h('span', { class: 'fold-hint' }));
  const el = h('div', { class: 'mem-panel io-panel', 'data-dock': 'left', 'data-fold': 'narrow', 'data-phone': 'flow' }, title,
    h('div', { class: 'io-cols' },
      h('div', null,
        h('div', { class: 'cpu-sec' }, 'Console', h('span', { class: 'cpu-sec-hint' }, 'memory-mapped at 0x8000_0000')), con,
        h('div', { class: 'io-row' }, h('div', null, h('div', { class: 'cpu-sec' }, 'LEDs'), leds), h('div', null, h('div', { class: 'cpu-sec' }, 'Switches'), sw)),
        h('div', { style: 'margin:6px 0' }, irqBtn)),
      h('div', null, h('div', { class: 'cpu-sec' }, 'Machine-mode CSRs'), csrs)));
  stage.historyHooks.add({ save: () => text, restore: (v) => { text = v as string; } });
  const update = () => {
    const sim = stage.sim, root = stage.rootCtx?.node;
    if (!sim || !root?.children) return;
    if (stage.cycles === 0) text = '';
    con.textContent = text || ' ';
    con.scrollTop = con.scrollHeight;
    const ledv = pack(sim.getBits(root.ports.leds));
    leds.replaceChildren(...Array.from({ length: 8 }, (_, i) => h('span', { class: `led${(ledv >> (7 - i)) & 1 ? ' on' : ''}`, title: `LED ${7 - i}` })));
    const swv = stage.getInput('switches');
    sw.replaceChildren(...Array.from({ length: 8 }, (_, i) => {
      const b = 7 - i, on = (swv >> b) & 1;
      return h('button', { class: `sw${on ? ' on' : ''}`, title: `switch ${b}`, onclick: () => stage.setInputs({ switches: swv ^ (1 << b) }) }, String(b));
    }));
    const csr = root.children.get('csr')!, io = root.children.get('io')!;
    const q = (n: typeof csr, inst: string) => pack(sim.getBits(n.children!.get(inst)!.ports.q)) >>> 0;
    const mie = q(csr, 'rMIE'), mpie = q(csr, 'rMPIE'), en = q(csr, 'rMIEN');
    const cause = q(csr, 'rCause');
    const rows: [string, string][] = [
      ['mstatus', `MIE=${mie} MPIE=${mpie}`],
      ['mie', `MTIE=${en & 1} MEIE=${(en >> 1) & 1}`],
      ['mtvec', hex(q(csr, 'rTvec') * 4)],
      ['mepc', hex(q(csr, 'rEpc') * 4)],
      ['mcause', `${hex(cause)} ${cause === 0 && q(csr, 'rEpc') === 0 ? '(no trap yet)' : CAUSE_NAMES[cause] ?? ''}`],
      ['mtval', hex(q(csr, 'rTval'))],
      ['mtime', String(q(io, 'mtime'))],
      ['mtimecmp', String(q(io, 'rCmp'))],
    ];
    csrs.replaceChildren(...rows.map(([k, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, k), h('span', { class: 'v' }, v))));
  };
  update();
  return { el, update };
};

/** The view each controller panel opens in (kept while the page lives): the diagram where the controller is the scene. */
const controllerView = { full: 'diagram', compact: 'table' };

/**
 * The controller as a state diagram (lib/fsm.ts MC_FSM_SPEC, live) or as its state table, the current state
 * highlighted (and, for microcode, the microwords).
 */
export function controllerPanel(control: 'fsm' | 'micro', compact = false): ScenePanel {
  return (stage: Stage): Widget => {
    const body = h('div', { class: 'mc-table' });
    const key = compact ? 'compact' : 'full';
    // Inside a CPU the controller is instance ctrl; on its own it is the scene, whose AND gates an arc can light.
    const diagram = fsmView(stage, MC_FSM_SPEC, compact ? { inputs: { op: 'ctrl.op' } } : { parts: control === 'fsm' });
    const seg = h('span', { class: 'seg mc-seg', onclick: (e: Event) => e.stopPropagation() });
    const title = h('h4', null, h('span', null, compact ? 'Controller' : control === 'fsm' ? 'Controller: state machine' : 'Controller: microcode ROM'), seg, compact ? null : h('span', { class: 'fold-hint' }));
    const legend = h('div', { class: 'fsm-legend' }, h('span', null, h('i', { class: 'cur' }), 'current'), h('span', null, h('i', { class: 'last' }), 'last edge'),
      h('span', null, h('i', { class: 'next' }), 'next edge (by op)'), h('span', null, h('b', { class: 'fsm-badge-k' }, '2'), 'cycle of this instruction'));
    const el = h('div', { class: `mem-panel mc-panel${compact ? ' compact' : ''}`, 'data-dock': 'left' }, title, body, diagram.el, legend);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));
    const show = (v: string) => {
      controllerView[key] = v;
      el.classList.toggle('diagram', v === 'diagram');
      body.hidden = v === 'diagram';
      diagram.el.hidden = legend.hidden = v !== 'diagram';
      seg.replaceChildren(...['diagram', 'table'].map((x) => h('button', { class: x === v ? 'on' : '', onclick: () => show(x) }, x === 'diagram' ? 'Diagram' : 'Table')));
      stage.layoutDock();
    };
    show(controllerView[key]);
    const ctrlBits = MC_FIELDS.reduce((a, [, n]) => a + n, 0);
    const nextText = (n: (typeof MC_STATES)[number]['next']) => (typeof n === 'number' ? MC_STATES[n].name : n === 'decode' ? (compact ? 'by opcode' : 'dispatch (opcode)') : (compact ? 'ld / st' : 'dispatch (load / store)'));
    const rows = MC_STATES.map((st, i) => {
      const w = microword(st);
      return h('div', { class: 'mc-row', 'data-i': String(i) },
        h('span', { class: 'mc-i' }, String(i)),
        h('span', { class: 'mc-n' }, st.name),
        compact ? h('span') : control === 'micro'
          ? h('code', { class: 'mc-w', title: 'microword: sequencing | next address | control fields' }, `${(w >>> (ctrlBits + 4)).toString(2).padStart(2, '0')} ${((w >>> ctrlBits) & 15).toString(2).padStart(4, '0')} ${(w & (2 ** ctrlBits - 1)).toString(2).padStart(ctrlBits, '0')}`)
          : h('span', { class: 'mc-d' }, st.does),
        h('span', { class: 'mc-x' }, `→ ${nextText(st.next)}`));
    });
    body.append(...rows);
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      const cur = pack(sim.getBits(sim.design.root.ports.state));
      rows.forEach((r, i) => r.classList.toggle('cur', i === cur));
      diagram.update?.();
    };
    update();
    return { el, update, destroy: diagram.destroy };
  };
}

/** Is a cache (data or instruction) holding the processor this cycle? */
/** The pipelined RV32IM CPU: the divider holds the front of the pipeline. */
function divStall(sim: Sim): boolean {
  const p = sim.design.root.children?.get('dive')?.ports.stall;
  return !!p && sim.getBits(p)[0] === 1;
}

function cacheStall(sim: Sim): boolean {
  const root = sim.design.root;
  const p = root.children?.get('dm')?.ports.stall ?? root.children?.get('imem')?.ports.stall;
  const q = root.children?.get('imem')?.ports.stall;
  return (!!p && sim.getBits(p)[0] === 1) || (!!q && sim.getBits(q)[0] === 1);
}
