// Companion panel for a running CPU scene: the program with the current instruction, the
// register file, data memory, and a live check against the golden model (the ISS runs in
// lock-step and every register is compared after each clock edge).

import type { Sim } from '../sim/sim';
import { MC_FIELDS, MC_STATES, microword, multicycleCpu, pipelinedCpu, pipelinedFpCpu, singleCycleCpu, systemCpu } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { cacheLines, cpuState, retiring } from '../riscv/cosim';
import { ABI, decode, disasm } from '../riscv/isa';
import { ISS } from '../riscv/iss';
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
import { h, icon } from '../ui/dom';
import { settings, type TraceLevel } from '../ui/settings';
import { fmtRate, ratePos, rateScale, stepEffect } from '../riscv/trace';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import type { FieldKey } from '../riscv/fields';
import { instrMarks, instrUse, stageUse, STAGE_UNITS } from './insthw';
import { instrBreakdown } from './instrfields';
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
  /** Fetch through an instruction cache (adds fetch-miss stalls). */
  icache?: boolean;
  /** The multicycle CPU with a hardwired or microprogrammed controller (adds the controller panel). */
  multicycle?: 'fsm' | 'micro';
  /** Single-cycle CPU with the FPU and f registers (chapter 23). */
  fpu?: boolean;
  /** Show the program editor. */
  editable?: boolean;
}

/** A scene running `source` on the single-cycle CPU, with the CPU panel attached. */
export function cpuScene(opts: CpuSceneOptions): Scene {
  const asm = assemble(opts.source);
  return {
    root: opts.multicycle ? multicycleCpu(asm.words, { control: opts.multicycle, adder: opts.adder })
      : opts.system ? systemCpu(asm.words, { adder: opts.adder, m: opts.m })
      : opts.pipeline && opts.fpu ? pipelinedFpCpu(asm.words, { adder: opts.adder })
      : opts.pipeline ? pipelinedCpu(asm.words, { adder: opts.adder, balanced: opts.balanced, predictor: opts.predictor, dcache: opts.dcache === true ? 'wt' : opts.dcache || undefined, m: opts.m })
        : singleCycleCpu(asm.words, opts.dcache || opts.icache ? { adder: opts.adder, ...(opts.dcache ? { dmemK: 6, dcache: opts.dcache } : {}), icache: opts.icache } : { adder: opts.adder, fpu: opts.fpu }),
    inputs: opts.system ? { clk: 0, switches: 0, irq: 0 } : { clk: 0 },
    highlight: opts.highlight,
    panels: [cpuPanel({ ...opts, asm }), ...(opts.pipeline ? [pipeDiagram(asm)] : []), ...(opts.system ? [ioPanel] : []), ...(opts.multicycle ? [controllerPanel(opts.multicycle, true)] : []), ...(opts.timing ? [timingPanel] : [])],
  };
}

function cpuPanel(opts: CpuSceneOptions & { asm: AsmResult }): ScenePanel {
  return (stage: Stage): Widget => {
    const asm = opts.asm;
    const issOpts = opts.system ? { system: true, imemWords: 128, m: !!opts.m } : opts.dcache ? { dmemWords: 64 } : {};
    let iss = new ISS(asm.words, issOpts);
    let lastX: number[] = new Array(32).fill(0);
    let changed = new Set<number>();
    let mismatch: string | null = null;
    let running: number | null = null;
    /** Slow mode: the timer of the next tick, and whether the highlight follows execution. */
    let slow: ReturnType<typeof setTimeout> | null = null;
    let tracing = false;
    let retiredSinceTick = false;
    /** Retired instructions, newest last (the last LOG_MAX are kept). */
    const LOG_MAX = 200;
    const log: { cycle: number; pc: number; text: string; effect: string }[] = [];
    let logSeq = 0, logShown = 0;
    const trace = h('div', { class: 'cpu-trace' });
    /** The listing line the user clicked: its hardware stays highlighted. */
    let selPc: number | null = null;
    const usePath = h('div', { class: 'cpu-use' });
    /** Instruction breakdown: the field pinned by a click, the one under the pointer. */
    let fieldPin: FieldKey | null = null, fieldHover: FieldKey | null = null;
    const fieldsBox = h('div', { class: 'cpu-fields' });
    let fieldsShown = '';

    const status = h('div', { class: 'cpu-status' });
    const listing = h('div', { class: 'cpu-listing' });
    const regs = h('div', { class: 'cpu-regs' });
    const mem = h('div', { class: 'cpu-mem' });
    const now = h('div', { class: 'cpu-now' });
    const dlines = h('div', { class: 'cpu-mem dcache-lines' });
    const fregs = h('div', { class: 'cpu-mem' });
    let loads = 0, misses = 0, prevStall = false, stallRun = 0;
    const wb = opts.dcache === 'wb' || opts.dcache === 'wb2';
    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    const progs = opts.fpu ? [...F_PROGRAMS, ...PROGRAMS] : opts.dcache ? [...CACHE_CPU_PROGRAMS, ...PROGRAMS] : opts.pipeline && opts.m ? [...PIPE_M_PROGRAMS, ...PROGRAMS] : opts.m ? [...M_PROGRAMS, ...SYSTEM_PROGRAMS, ...PROGRAMS] : opts.system ? [...SYSTEM_PROGRAMS, ...PROGRAMS] : PROGRAMS;
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
      stopSlow();
      tracing = false;
      runBtn.textContent = 'Stop';
      const tick = () => {
        stage.runCycles(opts.pipeline ? 3 : opts.m || opts.fpu || opts.dcache || opts.icache || opts.multicycle ? 10 : 4, () => iss.halted);
        if (iss.halted || mismatch || stage.cycles > 20000) return stopRun();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });

    // Slow mode: the learner sets the pace and the level of detail; the highlight follows execution.
    /** Cycles and instructions differ only when an instruction can take several cycles. */
    const multiCycle = !!(opts.pipeline || opts.multicycle || opts.m || opts.dcache || opts.icache);
    let level: TraceLevel = settings.traceLevel === 'cycle' && !multiCycle ? 'instr' : settings.traceLevel;
    let stepRate = settings.traceRate, gateRate = settings.speed;
    const RANGE: Record<'gate' | 'steps', [number, number]> = { gate: [2, 400], steps: [0.25, 20] };
    const range = () => RANGE[level === 'gate' ? 'gate' : 'steps'];
    const rate = () => (level === 'gate' ? gateRate : stepRate);
    const interval = () => 1000 / rate();
    const finished = () => iss.halted || !!mismatch || stage.cycles > 20000;
    const tick = () => {
      tracing = true;
      const flow = Math.min(600, (level === 'gate' ? 0.95 : 0.8) * interval());
      if (level === 'gate') {
        if (stage.inEdge) stage.edgeStep(flow);
        else stage.startEdge();
      } else if (level === 'cycle') stage.pulse(flow);
      else {
        // Up to the next retirement (a divide or a cache miss stalls for dozens of cycles).
        retiredSinceTick = false;
        stage.runCycles(200, () => retiredSinceTick, flow);
      }
    };
    const slowBtn = h('button', { class: 'btn sm toggle', title: 'Run the program at the speed below: the current instruction and the hardware it uses stay highlighted' }) as HTMLButtonElement;
    const slowIdle = () => slowBtn.replaceChildren(icon('play', 14), 'Slow');
    slowIdle();
    const stopSlow = () => {
      if (slow) clearTimeout(slow);
      slow = null;
      slowBtn.classList.remove('on');
      slowIdle();
    };
    const loop = () => {
      tick();
      if (finished()) return stopSlow();
      slow = setTimeout(loop, interval());
    };
    slowBtn.addEventListener('click', () => {
      if (slow) return stopSlow();
      if (finished()) return;
      stopRun();
      stage.stopClock();
      slowBtn.classList.add('on');
      slowBtn.replaceChildren(icon('pause', 14), 'Pause');
      loop();
    });
    const stepBtn = h('button', { class: 'btn sm ghost', title: 'One step at the chosen level', onclick: () => {
      stopSlow();
      stopRun();
      stage.stopClock();
      if (!finished() || (level === 'gate' && stage.inEdge)) tick();
    } }, icon('step', 14), 'Step');
    const rateIn = h('input', { type: 'range', min: 0, max: 1000, 'aria-label': 'Slow-mode speed' }) as HTMLInputElement;
    const rateLbl = h('span', { class: 'cpu-rate-v' });
    const unit = () => (level === 'gate' ? 'delays' : level === 'cycle' ? 'cycles' : 'instr');
    const showRate = () => {
      rateLbl.textContent = `${fmtRate(rate())} ${unit()}/s`;
      rateIn.title = level === 'gate' ? 'Gate delays per second' : `${level === 'cycle' ? 'Clock cycles' : 'Instructions'} per second`;
    };
    const syncRate = () => {
      const [lo, hi] = range();
      rateIn.value = String(Math.round(1000 * ratePos(rate(), lo, hi)));
      showRate();
    };
    rateIn.addEventListener('input', () => {
      const [lo, hi] = range();
      const r = rateScale(+rateIn.value / 1000, lo, hi);
      if (level === 'gate') gateRate = r;
      else stepRate = r;
      showRate();
    });
    // Persist on release only: every settings change refreshes the whole stage.
    rateIn.addEventListener('change', () => settings.set(level === 'gate' ? 'speed' : 'traceRate', rate()));
    const LEVELS: [TraceLevel, string, string][] = [
      ['gate', 'gate', 'One gate delay per step: watch each clock edge ripple through the datapath'],
      ...(multiCycle ? [['cycle', 'cycle', 'One clock cycle per step'] as [TraceLevel, string, string]] : []),
      ['instr', multiCycle ? 'instr' : 'instr / cycle', multiCycle ? 'Run until the next instruction retires' : 'One instruction (one clock cycle) per step'],
    ];
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Slow-mode step' });
    const levelBtns = LEVELS.map(([v, label, title]) => {
      const b = h('button', { title, role: 'radio' }, label);
      b.addEventListener('click', () => {
        level = v;
        levelBtns.forEach((x, i) => { x.classList.toggle('on', LEVELS[i][0] === v); x.setAttribute('aria-checked', String(LEVELS[i][0] === v)); });
        syncRate();
        settings.set('traceLevel', v);
      });
      b.classList.toggle('on', v === level);
      b.setAttribute('aria-checked', String(v === level));
      seg.append(b);
      return b;
    });
    syncRate();
    const slowRow = h('div', { class: 'cpu-slow' }, slowBtn, stepBtn, seg, h('label', { class: 'cpu-rate' }, rateIn, rateLbl));

    const editor = h('textarea', { class: 'asm-editor', spellcheck: 'false', wrap: 'off', rows: 14 }) as HTMLTextAreaElement;
    editor.value = opts.source;
    const errBox = h('div', { class: 'asm-errors' });
    const editWrap = h('div', { class: 'cpu-edit', style: 'display:none' }, editor, errBox,
      h('div', { style: 'display:flex;gap:6px;margin-top:6px' },
        h('button', {
          class: 'btn sm primary', onclick: () => {
            const r = assemble(editor.value);
            if (r.errors.length) {
              errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n');
              return;
            }
            stage.load(cpuScene({ ...opts, source: editor.value }));
          },
        }, 'Assemble & load'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = 'none'; } }, 'Close')));
    const editBtn = h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = editWrap.style.display === 'none' ? 'block' : 'none'; } }, 'Edit');

    const body = h('div', { class: 'cpu-body' },
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, editBtn, runBtn),
      slowRow,
      editWrap, status, now,
      h('div', { class: 'cpu-sec' }, 'Program', h('span', { class: 'cpu-sec-hint' }, 'click a line: its hardware')), listing, usePath,
      h('div', { class: 'cpu-sec' }, 'Fields', h('span', { class: 'cpu-sec-hint' }, 'point at a field: its wires')), fieldsBox,
      h('div', { class: 'cpu-sec' }, 'Trace', h('span', { class: 'cpu-sec-hint' }, 'retired instructions, newest last')), trace,
      h('div', { class: 'cpu-sec' }, 'Registers'), regs,
      ...(opts.fpu ? [h('div', { class: 'cpu-sec' }, 'Floating-point registers (non-zero)'), fregs] : []),
      ...(opts.dcache ? [h('div', { class: 'cpu-sec' }, opts.dcache === 'wb2' ? 'Data cache (2 sets × 2 ways × 4 words, write-back)' : opts.dcache === 'wb' ? 'Data cache (4 lines × 4 words, write-back)' : 'Data cache (4 lines × 4 words)'), dlines] : []),
      h('div', { class: 'cpu-sec' }, wb ? 'Memory as the program sees it (dirty lines included)' : opts.dcache ? 'Main memory (non-zero words)' : 'Data memory (non-zero words)'), mem);
    const title = h('h4', null, opts.multicycle ? 'RV32I multicycle' : opts.fpu ? (opts.pipeline ? 'RV32IF pipeline' : 'RV32IF CPU') : opts.system ? (opts.m ? 'RV32IM system' : 'RV32I system') : opts.pipeline ? (opts.m ? 'RV32IM pipeline' : 'RV32I pipeline') : 'RV32I CPU', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
    const el = h('div', { class: 'mem-panel cpu-panel', 'data-dock': 'right' }, title, body);
    title.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      stage.setInset(el.classList.contains('collapsed') ? 0 : el.getBoundingClientRect().width + 24);
    });

    // Golden model in lock-step: it executes one instruction whenever the hardware retires one
    // (every cycle for the single-cycle CPU; when a valid instruction leaves W for the pipeline).
    let willRetire = false;
    stage.edgeHooks.add({
      before: () => {
        willRetire = !!stage.sim && retiring(stage.sim);
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
        if (willRetire) retiredSinceTick = true;
        if (!willRetire || iss.halted || !stage.sim) return;
        const info = iss.step();
        log.push({ cycle: stage.cycles, pc: info.pc, text: info.text, effect: stepEffect(info) });
        if (log.length > LOG_MAX) log.shift();
        logSeq++;
        if (!mismatch) {
          const x = cpuState(stage.sim).x;
          const diff = x.findIndex((v, i) => v !== iss.x[i]);
          const f = cpuState(stage.sim).f;
          const fd = f ? f.findIndex((v, i) => v !== iss.f[i]) : -1;
          if (fd >= 0 && diff < 0) mismatch = `${FABI[fd]} differs: hardware ${hex(f![fd])}, model ${hex(iss.f[fd])}`;
          const fc = cpuState(stage.sim).fcsr;
          if (fc !== undefined && fc !== ((iss.frm << 5) | iss.fflags) && diff < 0 && fd < 0) mismatch = `fcsr differs: hardware ${hex(fc, 2)}, model ${hex((iss.frm << 5) | iss.fflags, 2)}`;
          if (diff >= 0) mismatch = `${ABI[diff]} differs after "${disasm(iss.imem[(iss.pc >>> 2) % 64] ?? 0x13)}": hardware ${hex(x[diff])}, model ${hex(iss.x[diff])}`;
        }
      },
    });
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      if (stage.cycles === 0 && iss.steps > 0) {
        iss = new ISS(asm.words, issOpts);
        mismatch = null;
        tracing = false;
        log.length = 0;
        logSeq = logShown = 0;
        trace.replaceChildren();
        loads = misses = 0;
        prevStall = false;
        stallRun = 0;
      }
      const st = cpuState(sim);
      changed = new Set();
      st.x.forEach((v, i) => { if (v !== lastX[i]) changed.add(i); });
      // During a slow-mode edge, keep comparing with the registers before it.
      if (!stage.inEdge) lastX = st.x;
      const atBoundary = !sim.design.root.ports.fetch || sim.getBits(sim.design.root.ports.fetch)[0] === 1;
      // Mid-edge the PC register has already moved but the golden model steps only when the edge is done.
      if (!mismatch && !opts.pipeline && !stage.inEdge && atBoundary && st.pc !== iss.pc) mismatch = `PC differs: hardware ${hex(st.pc)}, model ${hex(iss.pc)}`;
      const halted = iss.halted;
      const parts: HTMLElement[] = [
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, opts.pipeline || opts.m || opts.fpu || opts.multicycle ? `retired ${iss.steps}${iss.steps ? ` · CPI ${(stage.cycles / iss.steps).toFixed(2)}` : ''}` : `PC ${hex(st.pc, 4)}`),
        ...(opts.m && (opts.pipeline ? divStall(sim) : !retiring(sim)) ? [h('span', { class: 'warn', title: 'The iterative divider is working; the PC and register writes are stalled' }, 'dividing… stalled')] : []),
        ...(opts.fpu && !opts.pipeline && !retiring(sim) ? [h('span', { class: 'warn', title: 'An iterative unit (fdiv.s / fsqrt.s) is working; the PC and register writes are stalled' }, 'fdiv / fsqrt… stalled')] : []),
        ...(opts.dcache ? [h('span', null, `${wb ? 'accesses' : 'loads'} ${loads} · misses ${misses}${loads ? ` · hit rate ${(100 * (loads - misses) / loads).toFixed(0)} %` : ''}`)] : []),
        ...((opts.dcache || opts.icache) && cacheStall(sim) ? [h('span', { class: 'warn', title: 'A cache missed: the PC and register write wait while the line is moved' }, `miss: waiting for memory (cycle ${stallRun + 1})`)] : []),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good', title: 'Every register and the PC match the instruction-set simulator after every cycle' }, '✓ matches golden model'),
      ];
      if (halted) parts.push(h('span', { class: 'warn' }, 'halted'));
      status.replaceChildren(...parts);
      const shownPc = opts.multicycle && !atBoundary ? iss.pc : st.pc;
      const w = asm.words[shownPc >>> 2] ?? 0x13;
      const d = decode(w);
      now.replaceChildren(
        h('span', { class: 'fmt' }, `${d.fmt}-type`),
        h('code', null, disasm(w, shownPc)),
        h('span', { class: 'hexw' }, hex(w)),
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
        ];
        for (const [stg, pc, valid] of slots) if (valid && pc >= 0) inFlight.set(pc >>> 0, [...(inFlight.get(pc >>> 0) ?? []), stg]);
      }
      const keepScroll = listing.scrollTop;
      listing.replaceChildren(...asm.lines.map((l) => {
        const sel = l.addr === selPc;
        const line = h('div', { class: `ln${l.addr === shownPc ? ' cur' : ''}${sel ? ' sel' : ''}`, title: 'Show the hardware this instruction uses' },
          h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
          h('span', { class: 'w' }, l.word.toString(16).padStart(8, '0')),
          h('span', { class: 't' }, l.text),
          ...(inFlight.get(l.addr) ?? []).map((s) => h('span', { class: 'stg' }, s)),
          sel && stage.rootCtx?.canOpen('imem') ? h('button', { class: 'rom-btn', title: 'Open the instruction memory at the word that holds this instruction', onclick: (e: Event) => {
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
    const wordAt = (pc: number) => asm.words[pc >>> 2] ?? 0x13;
    const atRoot = () => stage.path.length === 0;
    const light = (names: string[]) => {
      const have = stage.rootCtx?.node.children;
      if (atRoot()) stage.highlight(names.filter((n) => have?.has(n)), true);
    };
    const fieldFocus = () => fieldHover ?? fieldPin;
    /**
     * Colour the wires that carry each field of `word` in the view shown now (null: no colours) and
     * highlight. At the top level `units` stand unless a field is in focus; inside IMM_GEN, CONTROL
     * or the opcode decoder the marks choose the parts. Returns a note for the use line.
     */
    const markFields = (word: number | null, units: string[]): string | undefined => {
      const def = stage.ctx?.def;
      const m = def && word !== null ? instrMarks(def, word, fieldFocus()) : null;
      stage.markNets(m?.nets ?? new Map());
      if (!m) light(units);
      else if (atRoot()) light(fieldFocus() ? m.units : units);
      else stage.highlight(m.units, m.units.length > 0);
      return m?.note;
    };
    /** The breakdown of the instruction at pc, rebuilt only when that instruction changes. */
    const showFields = (pc: number, role: string) => {
      const w = wordAt(pc);
      const key = `${pc}:${w}:${role}`;
      if (key !== fieldsShown) {
        fieldsShown = key;
        fieldsBox.replaceChildren(
          h('div', { class: 'cpu-fields-head' }, h('code', null, disasm(w, pc)), h('span', null, role)),
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
      if (selPc === null && tracing && opts.pipeline && !fieldFocus()) {
        const order = Object.keys(STAGE_UNITS);
        const rows = [...inFlight].flatMap(([pc, stgs]) => stgs.map((s) => [s as keyof typeof STAGE_UNITS, pc] as const))
          .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
        const note = markFields(dPc === undefined ? null : wordAt(dPc), rows.flatMap(([s, pc]) => stageUse(s, instrUse(wordAt(pc)))));
        usePath.replaceChildren(...rows.map(([s, pc]) => h('div', { class: 'flight' }, h('span', { class: 'stg' }, s), h('code', null, disasm(wordAt(pc), pc)))),
          note ? h('div', { class: 'ibd-note' }, note) : '');
        return;
      }
      const pc = selPc ?? (tracing || fieldFocus() ? bdPc : null);
      if (pc === null) {
        usePath.replaceChildren();
        stage.markNets(new Map());
        if (atRoot()) stage.highlight(stage.scene?.highlight ?? []);
        else if (stage.ctx && instrMarks(stage.ctx.def, 0x13)) stage.highlight([]);
        return;
      }
      const w = wordAt(pc);
      const use = instrUse(w);
      const stages = inFlight.get(pc) ?? [];
      const carried = !opts.pipeline || !stages.length || stages.includes('D');
      const note = markFields(carried ? w : null, stages.length ? stages.flatMap((s) => stageUse(s as keyof typeof STAGE_UNITS, use)) : use.units);
      usePath.replaceChildren(h('code', null, disasm(w, pc)), h('span', null,
        opts.pipeline ? (stages.length ? ` · now in ${stages.join(' + ')}; highlighted: that stage's part of the work.` : ' · not in the pipeline now; highlighted: all the hardware it uses.') : ''),
        h('div', null, use.path),
        !carried ? h('div', { class: 'ibd-note' }, 'Field colours appear while it is in D, where the instruction is split.') : '',
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
        stopSlow();
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
    type Slot = { pc: number; valid: boolean };
    type Snap = { cycle: number; slots: Slot[]; stall: boolean; flush: boolean; fwdA: number; fwdB: number; byp: boolean };
    const history: Snap[] = [];
    let STAGES = ['F', 'D', 'E', 'M', 'W'];
    const grid = h('div', { class: 'pipe-grid' });
    const title = h('h4', null, 'Pipeline diagram', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'stage × cycle'));
    const el = h('div', { class: 'mem-panel pipe-panel', 'data-dock': 'left' }, title, grid);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));
    const read = (): Snap | null => {
      const sim = stage.sim, root = stage.rootCtx?.node;
      if (!sim || !root?.children) return null;
      const v = (inst: string, port: string) => {
        const bits = sim.getBits(root.children!.get(inst)!.ports[port]);
        let x = 0;
        for (let i = bits.length - 1; i >= 0; i--) x = x * 2 + (bits[i] === 1 ? 1 : 0);
        return x;
      };
      // the pipelined FPU CPU has a sixth stage, X, between M and W
      const six = root.children.has('MX');
      const frozenPipe = !six && root.children.has('gFl1');
      STAGES = six ? ['F', 'D', 'E', 'M', 'X', 'W'] : ['F', 'D', 'E', 'M', 'W'];
      const slots: Slot[] = [
        { pc: v('pc', 'q'), valid: true },
        { pc: v('FD', 'pcD'), valid: v('FD', 'validD') === 1 },
        { pc: v('DE', 'pcE'), valid: v('DE', 'validE') === 1 },
        { pc: v('EM', 'pcM'), valid: v('EM', 'validM') === 1 },
        ...(six ? [{ pc: v('MX', 'pcX'), valid: v('MX', 'validX') === 1 }, { pc: v('XW', 'pcW'), valid: v('XW', 'validW') === 1 }]
          : [{ pc: v('MW', 'pcW'), valid: v('MW', 'validW') === 1 }]),
      ];
      return {
        cycle: stage.cycles, slots,
        // with a data cache, a miss freezes every stage (go = 0) and the flushes are gated (gFl1)
        stall: six ? v('go', 'y') === 0 : v('hz', 'enFD') === 0 || (frozenPipe && v('go', 'y') === 0) || (root.children.has('dive') && v('dive', 'stall') === 1),
        flush: six ? v('hz', 'taken') === 1 : frozenPipe ? v('gFl1', 'y') === 1 : v('hz', 'flushFD') === 1,
        // Balanced design: the E-stage selects travel in ID/EX (the hazard unit's outputs are for D).
        fwdA: root.children.get('DE')!.ports.fwdAE ? v('DE', 'fwdAE') : v('hz', 'forwardA'),
        fwdB: root.children.get('DE')!.ports.fwdBE ? v('DE', 'fwdBE') : v('hz', 'forwardB'),
        byp: v('hz', 'bypassA') === 1 || v('hz', 'bypassB') === 1,
      };
    };
    const record = () => {
      const s = read();
      if (!s) return;
      if (history.length && history[history.length - 1].cycle >= s.cycle) history.length = history.findIndex((x) => x.cycle >= s.cycle);
      history.push(s);
      if (history.length > 200) history.shift();
    };
    stage.edgeHooks.add({ after: record });
    const mnem = (pc: number) => {
      const w = asm.words[pc >>> 2];
      if (w === undefined) return 'nop';
      return disasm(w, pc).split(' ')[0];
    };
    const hue = (pc: number) => (pc * 47) % 360;
    const update = () => {
      if (stage.cycles === 0 || !history.length || history[history.length - 1].cycle !== stage.cycles) {
        if (stage.cycles === 0) history.length = 0;
        record();
      }
      const shown = history.slice(-12);
      const head = h('div', { class: 'pg-row head' }, h('span', { class: 'pg-st' }, ''), shown.map((s) => h('span', { class: 'pg-c' }, String(s.cycle))));
      const rows = STAGES.map((st, si) => h('div', { class: 'pg-row' }, h('span', { class: 'pg-st' }, st),
        shown.map((s) => {
          const slot = s.slots[si];
          if (!slot.valid) return h('span', { class: 'pg-c bubble', title: 'bubble' }, '·');
          return h('span', { class: 'pg-c', style: `--h:${hue(slot.pc)}`, title: `${hex(slot.pc, 4)}: ${disasm(asm.words[slot.pc >>> 2] ?? 0x13, slot.pc)}` }, mnem(slot.pc));
        })));
      const ev = h('div', { class: 'pg-row ev' }, h('span', { class: 'pg-st' }, ''), shown.map((s) => {
        const tags: string[] = [];
        if (s.stall) tags.push('stall');
        if (s.flush) tags.push('flush');
        if (s.fwdA === 2 || s.fwdB === 2) tags.push('M→E');
        if (STAGES.length === 6 && (s.fwdA === 3 || s.fwdB === 3)) tags.push('X→E');
        if (s.fwdA === 1 || s.fwdB === 1) tags.push('W→E');
        if (s.byp) tags.push('W→D');
        return h('span', { class: 'pg-c ev', title: tags.join(', ') }, tags.join(' '));
      }));
      grid.replaceChildren(head, ...rows, ev);
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
  const title = h('h4', null, 'I/O & machine state', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'memory-mapped at 0x8000_0000'));
  const el = h('div', { class: 'mem-panel io-panel', 'data-dock': 'left' }, title,
    h('div', { class: 'cpu-sec' }, 'Console'), con,
    h('div', { class: 'io-row' }, h('div', null, h('div', { class: 'cpu-sec' }, 'LEDs'), leds), h('div', null, h('div', { class: 'cpu-sec' }, 'Switches'), sw)),
    h('div', { style: 'margin:6px 0' }, irqBtn),
    h('div', { class: 'cpu-sec' }, 'Machine-mode CSRs'), csrs);
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
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

/** The controller's state table, the current state highlighted (and, for microcode, the microwords). */
export function controllerPanel(control: 'fsm' | 'micro', compact = false): ScenePanel {
  return (stage: Stage): Widget => {
    const body = h('div', { class: 'mc-table' });
    const title = h('h4', null, control === 'fsm' ? 'Controller: state machine' : 'Controller: microcode ROM', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
    const el = h('div', { class: `mem-panel mc-panel${compact ? ' compact' : ''}`, 'data-dock': 'left' }, title, body);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));
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
    };
    update();
    return { el, update };
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
