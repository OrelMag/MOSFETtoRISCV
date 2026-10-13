// What the CPU panel and the Warp panels share: Slow mode (a learner-set pace at gate, cycle or
// instruction level, Step, Back) and the listing's marks (the hardware an instruction uses lit at the
// top level, its field wires coloured wherever the view knows them: insthw.ts instrMarks).

import type { FieldKey } from '../riscv/fields';
import { disasm } from '../riscv/isa';
import { fmtRate, ratePos, rateScale } from '../riscv/trace';
import { DualSim } from '../sim/dualsim';
import { h, icon } from '../ui/dom';
import { settings, type TraceLevel } from '../ui/settings';
import type { Stage } from '../view/stage';
import { instrMarks, type InstrUse } from './insthw';

export interface SlowOptions {
  /** Instructions can take several cycles: offer the cycle level (else instr is one cycle). */
  multiCycle: boolean;
  /** The program is over (halted, a mismatch, a cycle cap): Slow stops, Step does nothing. */
  finished(): boolean;
  /** Slow or Step is about to act: stop the panel's own run. */
  onStart?(): void;
  /** What an instruction is to the learner, for the titles ('instruction', 'issue'). */
  instr?: { unit: string; title: string; label?: string };
  /** The instr level gives up after this many cycles without an instruction (a stall, a long wait). */
  maxCycles?: number;
}

export interface SlowControls {
  /** Slow, Back, Step, the level and the rate. */
  el: HTMLElement;
  /** The highlight follows execution: Slow or Step ran since the last Run to halt or reset. */
  tracing: boolean;
  /** The hardware completed an instruction at this edge (from an edge hook's `after`): the instr level stops there. */
  retired(): void;
  /** Pause Slow mode. */
  stop(): void;
  /** Refresh Back's state (call from the panel's update). */
  update(): void;
}

export function slowControls(stage: Stage, opts: SlowOptions): SlowControls {
  let slow: ReturnType<typeof setTimeout> | null = null;
  let retiredSinceTick = false;
  const unit = opts.instr ?? { unit: 'instr', title: 'Instructions per second' };
  let level: TraceLevel = settings.traceLevel === 'cycle' && !opts.multiCycle ? 'instr' : settings.traceLevel;
  let stepRate = settings.traceRate, gateRate = settings.speed;
  const RANGE: Record<'gate' | 'steps', [number, number]> = { gate: [2, 400], steps: [0.25, 20] };
  const range = () => RANGE[level === 'gate' ? 'gate' : 'steps'];
  const rate = () => (level === 'gate' ? gateRate : stepRate);
  const interval = () => 1000 / rate();
  const ctl: SlowControls = {
    el: h('div'), tracing: false,
    retired: () => { retiredSinceTick = true; },
    stop: () => {
      if (slow) clearTimeout(slow);
      slow = null;
      slowBtn.classList.remove('on');
      slowIdle();
    },
    update: () => { backBtn.disabled = !stage.canBack; },
  };
  const tick = () => {
    ctl.tracing = true;
    stage.checkpoint();
    const flow = Math.min(600, (level === 'gate' ? 0.95 : 0.8) * interval());
    if (level === 'gate') {
      // gate delays need GateSim: DualSim hands its state over for the edge
      if (stage.inEdge) stage.edgeStep(flow);
      else stage.startEdge();
    } else if (level === 'cycle') stage.pulse(flow);
    else {
      // up to the next instruction (a divide, a cache miss or a warp waiting on memory takes dozens of cycles)
      retiredSinceTick = false;
      stage.runCycles(opts.maxCycles ?? 200, () => retiredSinceTick, flow);
    }
  };
  const slowBtn = h('button', { class: 'btn sm toggle', title: 'Run the program at the speed below: the current instruction and the hardware it uses stay highlighted' }) as HTMLButtonElement;
  const slowIdle = () => slowBtn.replaceChildren(icon('play', 14), 'Slow');
  slowIdle();
  const loop = () => {
    tick();
    if (opts.finished()) return ctl.stop();
    slow = setTimeout(loop, interval());
  };
  slowBtn.addEventListener('click', () => {
    if (slow) return ctl.stop();
    if (opts.finished()) return;
    opts.onStart?.();
    stage.stopClock();
    // the cycle engine is built now rather than inside the first tick
    if (level !== 'gate' && stage.sim instanceof DualSim) stage.sim.prepare();
    slowBtn.classList.add('on');
    slowBtn.replaceChildren(icon('pause', 14), 'Pause');
    loop();
  });
  const stepBtn = h('button', { class: 'btn sm ghost', title: 'One step at the chosen level', onclick: () => {
    ctl.stop();
    opts.onStart?.();
    stage.stopClock();
    if (!opts.finished() || (level === 'gate' && stage.inEdge)) tick();
  } }, icon('step', 14), 'Step');
  const backBtn = h('button', { class: 'btn sm ghost', title: 'Step back: undo the last step (the golden model and the panel go back too)', onclick: () => {
    ctl.stop();
    opts.onStart?.();
    stage.back();
  } }, icon('stepBack', 14), 'Back') as HTMLButtonElement;
  const rateIn = h('input', { type: 'range', min: 0, max: 1000, 'aria-label': 'Slow-mode speed' }) as HTMLInputElement;
  const rateLbl = h('span', { class: 'cpu-rate-v' });
  const unitOf = () => (level === 'gate' ? 'delays' : level === 'cycle' ? 'cycles' : unit.unit);
  const showRate = () => {
    rateLbl.textContent = `${fmtRate(rate())} ${unitOf()}/s`;
    rateIn.title = level === 'gate' ? 'Gate delays per second' : level === 'cycle' ? 'Clock cycles per second' : unit.title;
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
  const instrLabel = unit.label ?? 'instr';
  const LEVELS: [TraceLevel, string, string][] = [
    ['gate', 'gate', 'One gate delay per step: watch each clock edge ripple through the datapath'],
    ...(opts.multiCycle ? [['cycle', 'cycle', 'One clock cycle per step'] as [TraceLevel, string, string]] : []),
    ['instr', opts.multiCycle ? instrLabel : `${instrLabel} / cycle`, opts.multiCycle ? `Run until the next ${unit.unit === 'instr' ? 'instruction retires' : unit.unit}` : 'One instruction (one clock cycle) per step'],
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
  ctl.el = h('div', { class: 'cpu-slow' }, slowBtn, backBtn, stepBtn, seg, h('label', { class: 'cpu-rate' }, rateIn, rateLbl));
  return ctl;
}

/**
 * Light what `word` uses in the view shown now and colour the wires that carry its fields (null: no
 * colours). At the top level `units` stand unless a field is in focus; inside IMM_GEN, CONTROL or
 * the opcode decoder the marks choose the parts. Returns instrMarks' note for the panel.
 */
export function markInstr(stage: Stage, word: number | null, units: string[], focus: FieldKey | null = null): string | undefined {
  const atRoot = stage.path.length === 0;
  const light = (names: string[]) => {
    const have = stage.rootCtx?.node.children;
    if (atRoot) stage.highlight(names.filter((n) => have?.has(n)), true);
  };
  const def = stage.ctx?.def;
  const m = def && word !== null ? instrMarks(def, word, focus) : null;
  stage.markNets(m?.nets ?? new Map());
  if (!m) light(units);
  else if (atRoot) light(focus ? m.units : units);
  else stage.highlight(m.units, m.units.length > 0);
  return m?.note;
}

/** No instruction marked: the scene's own highlight at the top level, nothing inside a block the marks know. */
export function clearInstr(stage: Stage): void {
  stage.markNets(new Map());
  if (stage.path.length === 0) stage.highlight(stage.scene?.highlight ?? []);
  else if (stage.ctx && instrMarks(stage.ctx.def, 0x13)) stage.highlight([]);
}

/**
 * The line under a listing for the instruction at `pc` (null: none, the scene's highlight back): what it
 * is, where it runs now (`where`), its data path; its hardware lit and its fields coloured.
 */
export function showInstrUse(stage: Stage, box: HTMLElement, at: { pc: number; word: number; use: InstrUse; where?: string } | null): void {
  if (!at) {
    box.replaceChildren();
    clearInstr(stage);
    return;
  }
  const note = markInstr(stage, at.word, at.use.units);
  box.replaceChildren(h('code', null, disasm(at.word, at.pc)), at.where ? h('span', null, ` · ${at.where}`) : '',
    h('div', null, at.use.path), note ? h('div', { class: 'ibd-note' }, note) : '');
}

/**
 * Run until `until()` (or `stop` is called), as many cycles as fit in ~12 ms of each animation frame,
 * then one redraw: the cycle engine runs tens of thousands of cycles a second, GateSim a few hundred.
 * Returns the stop function; `onStop` runs once when it ends.
 */
export function frameRun(stage: Stage, until: () => boolean, onStop: () => void, budgetMs = 12): () => void {
  let raf: number | null = null, done = false;
  const stop = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    if (done) return;
    done = true;
    onStop();
  };
  if (stage.sim instanceof DualSim) stage.sim.prepare();
  const tick = () => {
    const deadline = performance.now() + budgetMs;
    stage.runCycles(1e7, () => until() || performance.now() > deadline);
    if (until()) return stop();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
