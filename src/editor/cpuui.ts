// The CPU panel of the sandbox: for a chip that is a processor (a CPU opened with "Open in
// Sandbox", or one the learner built), the chapters' companion panel in a drawer of the right-hand
// dock (dock.ts): status with the golden-model check, the program with the current instruction (a
// click marks the parts it uses and colours its field wires; the field breakdown below points at
// one field), the pipeline diagram, the system CPU's I/O (console, LEDs, switches, interrupt
// button, machine CSRs), registers, floating-point registers and fcsr, data memory and the last
// retired instructions; Run to halt, Step instruction, Slow (one instruction at a learner-set
// rate, the hardware it uses marked as it runs), Reset. A chip of several cores (the dual-core)
// gets the multi-hart view: each core's instruction, registers side by side, which core retired,
// the shared memory. A properties section sets or overrides what detection found (cpu.ts).

import '../styles/sbcpu.css';
import { wordsHash } from '../lib/bigmem';
import { ABI, decode, disasm, FABI } from '../riscv/isa';
import { CAUSE } from '../riscv/iss';
import { bitsToF32, flagNames, RM_NAMES } from '../sim/fpref';
import { DualSim } from '../sim/dualsim';
import { energyFj, fmtEnergy, fmtPower, POWER_NOTE, PowerMeter, powerW } from '../sim/power';
import type { Sim } from '../sim/sim';
import { analyzeTiming } from '../sim/timing';
import { pack } from '../sim/values';
import { h, icon } from '../ui/dom';
import type { FieldKey } from '../riscv/fields';
import { instrBreakdown } from '../widgets/instrfields';
import { instrMarks, instrUse, STAGE_UNITS, stageUse } from '../widgets/insthw';
import { PipeHistory, pipeGridRows } from '../widgets/pipegrid';
import {
  type CpuDesc, type CpuDoc, CpuMonitor, type CpuRead, cpuGaps, detectCpu, fmtWord, mismatchText, type NetRef, nestedRoms, partAt, partNode,
  memStoreOf, pinNamed, pipelineSlots, readMem, refValue, resolveCpu, romParts,
} from './cpu';
import { dockPane, paneShown, showPane, undockPane } from './dock';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { ioInfo, ioLeaf, type SwitchState } from './ioparts';
import { romImage } from './memory';
import { openProgramEditor } from './memui';
import type { ChipDoc } from './model';
import { detectMulti, type MultiDesc, MultiMonitor } from './multicpu';
import { detectRv16, type Rv16Desc, Rv16Monitor } from './cpu16';
import { disasm16, REG_NAMES16 } from '../riscv/rv16/isa16';
import { OPCODES } from '../m6502/isa';
import { type Cpu4Desc, Cpu4Monitor, cpu4Use, detectCpu4 } from './cpu4mon';
import { detectLanes16, type LaneDesc, LaneMonitor } from './lanemon';
import { detect6502, flags6502, type M6502Desc, M6502Monitor } from './m6502mon';
import { registerPropsSection } from './props';
import { type EdgeHook, type EditorSim, FrameBudget } from './runtime';

/** Cycles Run to halt gives a program before it stops on its own. */
const RUN_CAP = 20000;
/** How often the panel redraws while the clock runs (ms). */
const RENDER_MS = 100;
const now = () => performance.now();
/** Slow mode: instructions (cycles, for several cores) per second. */
const SLOW_RATES = [0.5, 1, 2, 4, 8, 16];

const hex8 = (v: number) => (v < 0 ? 'xxxxxxxx' : (v >>> 0).toString(16).padStart(8, '0'));
/** As the chapters' CPU panel writes a register: 0x0000002A. */
const hexR = (v: number) => (v < 0 ? '0x????????' : `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);
const hex4 = (v: number) => (v < 0 ? 'xxxx' : (v >>> 0).toString(16).padStart(4, '0'));
const refText = (r: NetRef | 'every' | undefined): string =>
  !r ? '—' : r === 'every' ? 'every cycle' : 'pin' in r ? `pin ${r.pin}` : 'pointer' in r ? `pointer ${r.pointer}` : 'wire' in r ? `wire ${r.wire}` : `${r.part}.${r.port}`;
const FLD = ['fld', 'fld-op', 'fld-rd', 'fld-rs', 'fld-fn', 'fld-imm', 'fld-off'];

const CAUSE_NAMES: Record<number, string> = {
  [CAUSE.MISALIGNED_FETCH]: 'misaligned fetch', [CAUSE.ILLEGAL]: 'illegal instruction', [CAUSE.BREAKPOINT]: 'breakpoint',
  [CAUSE.MISALIGNED_LOAD]: 'misaligned load', [CAUSE.MISALIGNED_STORE]: 'misaligned store', [CAUSE.ECALL]: 'ecall',
  [CAUSE.TIMER_IRQ]: 'timer interrupt', [CAUSE.EXTERNAL_IRQ]: 'external interrupt',
};

type Mon = CpuMonitor | MultiMonitor | Rv16Monitor | LaneMonitor | Cpu4Monitor | M6502Monitor;
const monKind = (m: Mon) => (m instanceof MultiMonitor ? 'multi' : m instanceof Rv16Monitor ? 'rv16' : m instanceof LaneMonitor ? 'lanes' : m instanceof Cpu4Monitor ? 'cpu4' : m instanceof M6502Monitor ? 'm6502' : 'cpu');
/** Monitors whose ROM listing is word addressed (rows keyed 4 × the word index, like the RV32 listings; the 6502's: a byte a word). */
const wordListed = (m: Mon): m is Rv16Monitor | LaneMonitor | Cpu4Monitor | M6502Monitor => m instanceof Rv16Monitor || m instanceof LaneMonitor || m instanceof Cpu4Monitor || m instanceof M6502Monitor;
interface Entry { chip: string; mon: Mon; pipe: PipeHistory; hook: EdgeHook }

/** Children replaced only when `key` changed (the panel redraws on every simulation change). */
function keyed(el: HTMLElement, key: string, build: () => (Node | string)[]): void {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(...build());
}

const panels = new WeakMap<Editor, CpuPanel>();

class CpuPanel {
  readonly el: HTMLElement;
  open = false;
  private monitors = new Map<EditorSim, Entry>();
  /** Chips whose panel the user closed (not reopened automatically this session). */
  private closed = new Set<string>();
  private shownFor = '';
  private running = 0;
  private runCap = 0;
  /** Run to halt's per-frame simulation budget (kept across runs: it has learnt the page's frame cost). */
  private runBudget = new FrameBudget(2, 14, 12);
  private slow: ReturnType<typeof setTimeout> | null = null;
  private slowRate = 2;
  /** While the clock runs fast, the panel redraws at most every RENDER_MS (a trailing redraw shows the last state). */
  private lastRender = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private sel: number | null = null;
  private fieldPin: FieldKey | null = null;
  private fieldHover: FieldKey | null = null;
  private syncing = false;
  /** Energy per instruction (gate mode only: the cycle engine counts no toggles), from where the meter started. */
  private meter: PowerMeter | null = null;
  private meterRetired = 0;
  private meterCycles = 0;
  private periods = new WeakMap<object, number | null>();
  private descDoc: ChipDoc | null = null;
  private descChips: unknown = null;
  private desc: CpuDesc | null = null;
  private multi: MultiDesc | null = null;
  /** An RV16 computer (an RV16 ROM and a placed core): checked through the core's write ports. */
  private rv16: Rv16Desc | null = null;
  private lanes: LaneDesc | null = null;
  /** A 4-bit CPU (a ROM in 4-bit assembly): the example's registers checked every clock. */
  private cpu4: Cpu4Desc | null = null;
  /** A 6502 part (and a ROM in 6502 assembly): followed instruction by instruction (the part is the cycle-exact model). */
  private m6502: M6502Desc | null = null;
  private width = 0;
  private off: (() => void)[] = [];

  private title = h('h3', null);
  private status = h('div', { class: 'cpu-status' });
  private gaps = h('div', { class: 'sb-cpu-gaps' });
  private now = h('div', { class: 'cpu-now' });
  private listing = h('div', { class: 'cpu-listing sb-cpu-list' });
  private use = h('div', { class: 'cpu-use' });
  private progHint = h('span', { class: 'cpu-sec-hint' }, 'click a line: the parts it uses');
  /** Custom instructions on an RV32I core (editor/owninstr.ts): shown when the CPU has one. */
  private customBtn = h('button', { class: 'btn ghost sm', hidden: true, title: 'Your own instructions: a free opcode, its behaviour as a row of control signals; the core and the golden model learn it', onclick: () => void import('./owninstr').then((m) => m.openCustomInstructions(this.ed)) }, 'Custom…') as HTMLButtonElement;
  private fieldsSec = h('div', { class: 'cpu-sec' }, 'Fields', h('span', { class: 'cpu-sec-hint' }, 'point at a field: its wires'));
  private fields = h('div', { class: 'cpu-fields' });
  private pipeSec = h('div', { class: 'cpu-sec' }, 'Pipeline', h('span', { class: 'cpu-sec-hint' }, 'stage × cycle, last 7 cycles'));
  private pipe = h('div', { class: 'pipe-grid sb-cpu-pipe' });
  private ioSec = h('div', { class: 'cpu-sec' }, 'I/O', h('span', { class: 'cpu-sec-hint' }, 'memory-mapped at 0x8000_0000'));
  private io: HTMLElement;
  private con = h('pre', { class: 'console' });
  private leds = h('div', { class: 'leds' });
  private sw = h('div', { class: 'switches' });
  private csrs = h('div', { class: 'cpu-mem' });
  private regsSec = h('div', { class: 'cpu-sec' }, 'Registers');
  private regs = h('div', { class: 'cpu-regs' });
  private fregsSec = h('div', { class: 'cpu-sec' }, 'Floating-point registers (non-zero)');
  private fregs = h('div', { class: 'cpu-mem' });
  private memSec = h('div', { class: 'cpu-sec' });
  private mem = h('div', { class: 'cpu-mem' });
  private trace = h('div', { class: 'cpu-trace sb-cpu-trace' });
  private traceSec = h('div', { class: 'cpu-sec' }, 'Retired', h('span', { class: 'cpu-sec-hint' }, 'by the golden model, newest last'));
  private runBtn: HTMLButtonElement;
  private stepBtn: HTMLButtonElement;
  private slowBtn: HTMLButtonElement;
  private rateSel: HTMLSelectElement;
  private body: HTMLElement;
  private none: HTMLElement;

  // what is drawn, to redraw only what changed
  private listKey = '';
  private rows: HTMLElement[] = [];
  private rowOf = new Map<number, HTMLElement>();
  private curKey = '';
  private lastX: (number[] | null)[] = [];
  private changed: Set<number>[] = [];
  private seqSeen = -1;
  private regSeq = -1;

  constructor(private ed: Editor) {
    // Registered first: opening the panel below redraws the toolbar, whose CPU toggle looks it up.
    panels.set(ed, this);
    this.runBtn = h('button', { class: 'btn sm primary', onclick: () => this.toggleRun() }) as HTMLButtonElement;
    this.stepBtn = h('button', { class: 'btn sm', onclick: () => this.stepInstr() }, icon('step', 14), 'Step') as HTMLButtonElement;
    this.slowBtn = h('button', { class: 'btn sm toggle', onclick: () => this.toggleSlow() }) as HTMLButtonElement;
    this.rateSel = h('select', { class: 'sb-cpu-rate', 'aria-label': 'Slow-mode speed' }, SLOW_RATES.map((r) => h('option', { value: String(r), selected: r === this.slowRate }, `${r}/s`))) as HTMLSelectElement;
    this.rateSel.addEventListener('change', () => { this.slowRate = Number(this.rateSel.value); });
    const reset = h('button', { class: 'btn sm ghost icon-only sb-cpu-reset', title: 'Reset: power-cycle the circuit and restart the golden model', 'aria-label': 'Reset', onclick: () => this.reset() }, icon('reset', 15));
    const irq = h('button', { class: 'btn sm', title: 'Raise the external interrupt (the irq pin) for one clock cycle', onclick: () => this.pulseIrq() }, 'IRQ (one cycle)');
    this.io = h('div', { class: 'sb-cpu-io' }, this.con,
      h('div', { class: 'io-row' }, h('div', null, h('div', { class: 'cpu-sec' }, 'LEDs'), this.leds), h('div', null, h('div', { class: 'cpu-sec' }, 'Switches'), this.sw)),
      h('div', { class: 'sb-cpu-irq' }, irq), h('div', { class: 'cpu-sec' }, 'Machine-mode CSRs'), this.csrs);
    this.none = h('div', { class: 'sb-cpu-none' });
    this.body = h('div', { class: 'sb-cpu-body' },
      h('div', { class: 'sb-btns sb-cpu-btns' }, this.runBtn, this.stepBtn, this.slowBtn, this.rateSel, reset),
      this.status, this.gaps, this.now,
      h('div', { class: 'cpu-sec sb-cpu-sechead' }, h('span', null, 'Program', this.progHint),
        h('span', { class: 'sb-cpu-secbtns' }, this.customBtn,
          h('button', { class: 'btn ghost sm', title: 'Edit the program in the ROM (Apply resets the CPU to run it)', onclick: () => this.editProgram() }, icon('code', 13), 'Edit…'))),
      this.listing, this.use,
      this.fieldsSec, this.fields,
      this.pipeSec, this.pipe,
      this.ioSec, this.io,
      this.regsSec, this.regs,
      this.fregsSec, this.fregs,
      this.memSec, this.mem,
      this.traceSec, this.trace);
    this.el = h('aside', { class: 'sb-drawer sb-cpu', 'aria-label': 'CPU' },
      h('div', { class: 'sb-drawer-head' }, icon('code', 15), this.title,
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the CPU panel', onclick: () => this.setOpen(false, true) }, icon('close', 15))),
      this.none, this.body);
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.setOpen(false, true);
    });
    this.off.push(ed.onSimChange(() => this.sync()), ed.onChange(() => this.sync()));
    this.sync();
  }

  destroy(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.stopRun();
    this.stopSlow();
    this.off.forEach((f) => f());
    for (const [es, e] of this.monitors) this.drop(es, e);
    this.monitors.clear();
    this.clearMarks();
    if (this.open) undockPane(this.ed, 'cpu');
  }

  /** The monitor of the simulation on screen (made on demand for a chip with a program ROM). */
  get mon(): Mon | null {
    return this.monitors.get(this.ed.sim)?.mon ?? null;
  }

  private get entry(): Entry | undefined {
    return this.monitors.get(this.ed.sim);
  }

  /** The toolbar's CPU button: open, bring to the front of the dock, or close. */
  toggle(): void {
    if (!this.open) this.setOpen(true, true);
    else if (!paneShown(this.ed, 'cpu')) showPane(this.ed, 'cpu');
    else this.setOpen(false, true);
  }

  setOpen(on: boolean, byUser = false): void {
    if (on === this.open) return;
    this.open = on;
    if (byUser && !on) this.closed.add(this.ed.chipId);
    if (byUser && on) this.closed.delete(this.ed.chipId);
    if (on) {
      this.width = 0;
      this.redock();
      this.listKey = this.curKey = '';
      this.seqSeen = this.regSeq = -1;
      this.el.querySelectorAll<HTMLElement>('[data-key]').forEach((e) => delete e.dataset.key);
      this.render();
    } else {
      undockPane(this.ed, 'cpu');
      this.stopRun();
      this.stopSlow();
      this.sel = null;
      this.fieldPin = this.fieldHover = null;
      this.clearMarks();
    }
    this.ed.renderActions();
  }

  /** Dock at the width the CPU needs (the multi-core view is wider). */
  private redock(): void {
    const w = this.multi ? 420 : 360;
    if (!this.open || w === this.width) return;
    this.width = w;
    dockPane(this.ed, { id: 'cpu', label: 'CPU', icon: 'code', el: this.el, width: w });
  }

  private drop(es: EditorSim, e: Entry): void {
    e.mon.destroy();
    es.edgeHooks.delete(e.hook);
  }

  private sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const ed = this.ed, es = ed.sim, chip = ed.chipId, chips = ed.ws.chips;
      if (this.descDoc !== ed.doc || this.descChips !== chips) {
        this.descDoc = ed.doc;
        this.descChips = chips;
        this.multi = detectMulti(ed.doc, chips);
        this.desc = this.multi ? null : resolveCpu(ed.doc, chips);
        this.customBtn.hidden = !this.desc?.core;
        this.customBtn.textContent = this.desc?.iss.custom?.length ? `Custom: ${this.desc.iss.custom.map((r) => r.name).join(', ')}` : 'Custom…';
        this.rv16 = this.multi || this.desc ? null : detectRv16(ed.doc, chips);
        this.lanes = this.multi || this.desc || this.rv16 ? null : detectLanes16(ed.doc, chips);
        this.m6502 = this.multi || this.desc || this.rv16 || this.lanes ? null : detect6502(ed.doc, chips);
        this.cpu4 = this.multi || this.desc || this.rv16 || this.lanes || this.m6502 ? null : detectCpu4(ed.doc, chips);
      }
      const want = this.multi ? 'multi' : this.rv16 ? 'rv16' : this.lanes ? 'lanes' : this.m6502 ? 'm6502' : this.cpu4 ? 'cpu4' : 'cpu';
      // Monitors of chips that are gone, replaced by another simulation, or of another kind now.
      for (const [k, v] of this.monitors) {
        const kind = v.chip === chip && monKind(v.mon) !== want;
        if (!ed.ws.open.includes(v.chip) || (v.chip === chip && k !== es) || kind) { this.drop(k, v); this.monitors.delete(k); }
      }
      let entry = this.monitors.get(es);
      if ((this.desc || this.multi || this.rv16 || this.lanes || this.cpu4 || this.m6502) && !entry) {
        const doc = () => ed.ws.chips[chip] ?? ed.doc, ws = () => ed.ws.chips;
        const mon: Mon = this.multi ? new MultiMonitor(es, doc, ws) : this.rv16 ? new Rv16Monitor(es, doc, ws) : this.lanes ? new LaneMonitor(es, doc, ws) : this.m6502 ? new M6502Monitor(es, doc, ws) : this.cpu4 ? new Cpu4Monitor(es, doc, ws) : new CpuMonitor(es, doc, ws);
        const pipe = new PipeHistory();
        const hook: EdgeHook = { after: () => { if (es.sim) pipe.record(es.sim, es.sim.design.root, es.cycles); } };
        es.edgeHooks.add(hook);
        entry = { chip, mon, pipe, hook };
        this.monitors.set(es, entry);
      }
      const changed = entry?.mon.sync();
      if (entry && changed) {
        // A new program (or a new idea of what the CPU is): start the hardware and the golden
        // model over together; the old run's state means nothing to the new one.
        es.reset();
        entry.mon.sync();
        ed.toast(changed === 'program' ? 'Program changed: the CPU was reset to run it from the start' : 'CPU settings changed: the CPU was reset so the golden model starts with it');
      }
      if (chip !== this.shownFor) {
        this.shownFor = chip;
        this.sel = null;
        this.fieldPin = this.fieldHover = null;
        this.stopRun();
        this.stopSlow();
        // A complete CPU opens its panel by itself (unless closed there); a chip without a program
        // ROM closes it; a bare datapath (a ROM and a PC) leaves it as it was.
        if ((this.desc?.regs || this.multi || this.rv16 || this.lanes || this.cpu4 || this.m6502) && !this.closed.has(chip)) this.setOpen(true);
        else if (!this.desc && !this.multi && !this.rv16 && !this.lanes && !this.cpu4 && !this.m6502) this.setOpen(false);
      }
      this.redock();
      if (this.open) this.renderThrottled();
    } finally {
      this.syncing = false;
    }
  }

  // ---- actions ---------------------------------------------------------------------------

  private toggleRun(): void {
    if (this.running) return this.stopRun();
    const mon = this.mon;
    if (!mon?.checking) return;
    if (mon.done) return this.ed.toast(mon.mismatch ? 'Stopped at a mismatch: Reset to run again' : 'The program has halted: Reset to run it again');
    this.stopSlow();
    this.ed.sim.pause();
    this.runCap = this.ed.sim.cycles + RUN_CAP;
    // as Run's loop (runtime.ts FrameBudget): as much simulating per frame as keeps the page at its frame rate
    let last = performance.now(), work = 0;
    const tick = () => {
      const m = this.mon;
      if (!m || !this.running) return;
      const t = performance.now();
      this.runBudget.frame(t - last, work);
      last = t;
      m.runToHalt(this.runBudget.ms, this.runCap);
      work = performance.now() - t;
      if (m.done || this.ed.sim.cycles >= this.runCap) {
        if (!m.done) this.ed.toast(`Stopped after ${RUN_CAP.toLocaleString('en')} cycles without halting`);
        return this.stopRun();
      }
      this.running = requestAnimationFrame(tick);
    };
    this.running = requestAnimationFrame(tick);
    this.render();
  }

  private stopRun(): void {
    if (this.running) cancelAnimationFrame(this.running);
    this.running = 0;
    if (this.open) this.render();
  }

  private halted(mon: Mon): boolean {
    return mon instanceof MultiMonitor ? !!mon.m?.halted : mon instanceof LaneMonitor ? mon.halted && mon.done : mon instanceof M6502Monitor ? mon.done : !!mon.iss?.halted;
  }

  private stepInstr(): void {
    const mon = this.mon;
    if (!mon) return;
    this.stopRun();
    this.stopSlow();
    this.ed.sim.pause();
    if (this.halted(mon)) return this.ed.toast('The program has halted: Reset to run it again');
    mon.stepInstr();
  }

  /** Slow mode: one instruction per tick at the chosen rate; the marks follow execution. */
  private toggleSlow(): void {
    if (this.slow) return this.stopSlow();
    const mon = this.mon;
    if (!mon) return;
    if (mon.done && mon.checking) return this.ed.toast(mon.mismatch ? 'Stopped at a mismatch: Reset to run again' : 'The program has halted: Reset to run it again');
    this.stopRun();
    this.ed.sim.pause();
    const loop = () => {
      const m = this.mon;
      if (!m || !this.slow) return;
      m.stepInstr();
      if (m.done && m.checking) return this.stopSlow();
      this.slow = setTimeout(loop, 1000 / this.slowRate);
    };
    this.slow = setTimeout(loop, 0);
    this.render();
  }

  private stopSlow(): void {
    if (this.slow) clearTimeout(this.slow);
    const was = !!this.slow;
    this.slow = null;
    if (was) {
      this.computeMarks();
      if (this.open) this.render();
    }
  }

  private reset(): void {
    this.stopRun();
    this.stopSlow();
    this.ed.sim.pause();
    this.ed.sim.reset();
    this.entry?.pipe.clear();
  }

  private editProgram(): void {
    const mon = this.mon;
    const rom = mon instanceof MultiMonitor ? this.multi?.cores[0]?.rom : mon && wordListed(mon) ? mon.desc?.rom : this.desc?.rom;
    if (!rom) return;
    const at = partAt(this.ed.doc, rom, this.ed.ws.chips);
    if (at) openProgramEditor(this.ed, at.part.id, at.doc.id);
  }

  /** The irq pin high for one rising edge. */
  private pulseIrq(): void {
    const ed = this.ed;
    const pin = pinNamed(ed.doc, 'in', 1, 'irq');
    if (!pin) return;
    ed.setPinValue(pin.id, 1);
    if (ed.sim.running) {
      const es = ed.sim;
      const once: EdgeHook = { after: () => { es.edgeHooks.delete(once); if (ed.sim === es) ed.setPinValue(pin.id, 0); } };
      es.edgeHooks.add(once);
    } else {
      ed.sim.runCycles(1);
      ed.setPinValue(pin.id, 0);
    }
  }

  // ---- drawing ---------------------------------------------------------------------------

  /**
   * render(), but while the circuit runs (Run, or Run to halt) at most every RENDER_MS: the listing,
   * registers and trace would otherwise be rebuilt on every frame, costing more than the simulation.
   */
  private renderThrottled(): void {
    if (!this.ed.sim.running && !this.running) return this.render();
    const wait = this.lastRender + RENDER_MS - now();
    if (wait <= 0) return this.render();
    this.renderTimer ??= setTimeout(() => { this.renderTimer = null; this.render(); }, wait);
  }

  private render(): void {
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    this.lastRender = now();
    if (!this.open) return;
    const ed = this.ed, mon = this.mon, doc = ed.doc;
    this.title.textContent = `${mon instanceof MultiMonitor ? `${this.multi?.cores.length ?? 2} cores` : 'CPU'} · ${doc.name}`;
    const any = !!(mon && (mon instanceof MultiMonitor ? mon.desc : mon.desc));
    this.none.hidden = any;
    this.body.hidden = !any;
    if (!any || !mon) {
      keyed(this.none, 'none', () => [
        h('p', null, h('b', null, 'No program ROM in this chip.')),
        h('p', null, 'A CPU here is a chip with a ', h('b', null, 'Program ROM (RV32)'), ' (Memory palette: byte addressed, 32-bit words), directly or inside one of its chips. Add one, or open a CPU from the chapters with ',
          h('i', null, 'Open in Sandbox'), '. The panel then follows its PC; with a register file it checks every instruction against the golden model. Two or more placed CPUs sharing a memory run against the multi-hart model.'),
        h('p', null, 'An ', h('b', null, 'RV16'), ' computer (the campaign’s) is a ROM in RV16 assembly next to a placed core with the campaign’s core pins (pc, rwe, rwa, rwd, dwe, daddr, dwdata): its register writes and stores are checked against the RV16 golden model.'),
        h('p', null, 'A ', h('b', null, '6502'), ' (Examples ▸ 6502 computer) is a placed 6502 part next to a ROM in 6502 assembly: the panel follows it instruction by instruction, with its registers, flags and bus.'),
        h('p', null, 'A ', h('b', null, '4-bit CPU'), ' (Examples ▸ 4-bit CPU) is a ROM in 4-bit assembly: the panel follows the address it reads, and with the example’s registers it checks every one of them against the 4-bit golden model at every clock.'),
        h('p', { class: 'sb-sum' }, 'What counts as the PC, the registers and the memory is set in the chip’s properties (CPU), when nothing is selected.')]);
      return;
    }
    this.renderButtons(mon);
    this.progHint.textContent = mon instanceof M6502Monitor ? 'at the CPU addresses the ROM answers at' : 'click a line: the parts it uses';
    this.regsSec.hidden = this.regs.hidden = false; // a custom table's view hides them
    if (mon instanceof MultiMonitor) return this.renderMulti(mon);
    if (mon instanceof Rv16Monitor) return this.renderRv16(mon);
    if (mon instanceof LaneMonitor) return this.renderLanes(mon);
    if (mon instanceof Cpu4Monitor) return this.renderCpu4(mon);
    if (mon instanceof M6502Monitor) return this.render6502(mon);
    const d = mon.desc!;
    const r = mon.read();
    this.renderStatus(mon, d, r);
    this.renderListing(mon, r?.pc ?? null, pipelineSlots(this.ed.sim, doc, d)?.map((s) => ({ tag: s.stage, pc: s.pc })) ?? null, r?.pc === null ? 'not found' : 'unknown (X)');
    this.renderFields(mon, d, r);
    this.renderPipe(mon);
    this.renderIo(mon);
    this.renderRegs(mon, r);
    this.renderMem(d, r);
    this.renderTrace(mon);
    this.computeMarks();
  }

  private renderButtons(mon: Mon): void {
    const multi = mon instanceof MultiMonitor;
    keyed(this.runBtn, `${!!this.running}`, () => [icon(this.running ? 'pause' : 'play', 14), this.running ? 'Stop' : 'Run to halt']);
    this.runBtn.disabled = !mon.checking;
    this.runBtn.title = mon instanceof M6502Monitor ? `Clock until the program jumps to itself, or ${RUN_CAP.toLocaleString('en')} cycles` : mon.checking ? `Clock until the program halts (the golden model says when), a mismatch, or ${RUN_CAP.toLocaleString('en')} cycles`
      : 'Needs the golden model (a register file to check, a program that builds, a Reset) to know when the program halts';
    this.stepBtn.title = multi ? 'One clock cycle: every core that is not stalled retires an instruction'
      : mon instanceof Rv16Monitor ? 'Clock until the core’s next register write or store' : mon instanceof LaneMonitor ? 'Clock until the core’s next checked write (a register write, a store or a pixel of any lane)' : mon instanceof Cpu4Monitor ? 'One clock: one instruction' : mon instanceof M6502Monitor ? 'Clock to the next opcode fetch: one instruction (2 to 7 cycles)' : 'Clock until the next instruction retires';
    keyed(this.slowBtn, `${!!this.slow}`, () => [icon(this.slow ? 'pause' : 'play', 14), this.slow ? 'Pause' : 'Slow']);
    this.slowBtn.classList.toggle('on', !!this.slow);
    this.slowBtn.title = `Run ${multi ? 'one cycle' : 'one instruction'} at a time at the rate beside it: the current instruction and the parts it uses stay marked`;
    this.rateSel.title = multi ? 'Cycles per second' : 'Instructions per second';
  }

  /**
   * Energy per instruction and power on GateSim (sim/power.ts), as the chapters' CPU panel shows it. Counted while
   * the gate engine runs: a stretch on the cycle engine, a Reset or a step back starts the count again.
   */
  private energy(mon: CpuMonitor): HTMLElement[] {
    const es = this.ed.sim, sim = es.sim;
    if (!(sim instanceof DualSim) || sim.engine !== 'gate' || es.mode !== 'gate') { this.meter = null; return []; }
    if (!this.meter || this.meter.sim !== sim.gate || es.cycles < this.meterCycles || mon.retired < this.meterRetired) {
      this.meter = this.meter?.sim === sim.gate ? this.meter : new PowerMeter(sim.gate);
      this.meter.reset();
      this.meterRetired = mon.retired;
      this.meterCycles = es.cycles;
    }
    const steps = mon.retired - this.meterRetired, cycles = es.cycles - this.meterCycles;
    if (steps <= 0 || cycles <= 0) return [];
    let period = this.periods.get(sim.design);
    if (period === undefined) this.periods.set(sim.design, (period = analyzeTiming(sim.design)?.period ?? null));
    const fj = energyFj(this.meter.totals().switched);
    return [h('span', { title: `${POWER_NOTE} Over the last ${steps} instructions run in gate mode (from a Reset, a step back or the switch to gate mode); power at the clock static timing allows.` },
      `≈ ${fmtEnergy(fj / steps)} / instr${period ? ` · ${fmtPower(powerW(fj / cycles, period))}` : ''}`)];
  }

  private renderStatus(mon: CpuMonitor, d: CpuDesc, r: CpuRead | null): void {
    const es = this.ed.sim;
    const bits: (HTMLElement | string)[] = [h('span', null, `cycle ${es.cycles}`)];
    if (d.retire || d.pipeline || mon.retired !== es.cycles) bits.push(h('span', null, `retired ${mon.retired}${mon.retired ? ` · CPI ${(es.cycles / mon.retired).toFixed(2)}` : ''}`));
    else if (r?.pc !== null && r?.pc !== undefined) bits.push(h('span', null, `PC ${r.pc < 0 ? 'x' : `0x${hex4(r.pc)}`}`));
    if (r && !r.retiring && !d.pipeline && mon.retired > 0 && !mon.iss?.halted) bits.push(h('span', { class: 'warn', title: 'No instruction completes at the next edge: a multi-cycle instruction under way, a cache miss or a divide holds the PC and the register write' }, 'retire = 0'));
    if (mon.mismatch) bits.push(h('span', { class: 'bad', title: 'The first difference between the hardware and the instruction-set simulator; the check stops there' }, `✗ ${mismatchText(mon.mismatch)}`));
    else if (mon.problem) bits.push(h('span', { class: 'warn' }, `no golden model: ${mon.problem}`));
    else if (!d.regs || !r?.x) bits.push(h('span', { class: 'warn', title: 'Set the register file in the chip’s properties (CPU)' }, 'not checked'));
    else if (!mon.synced) bits.push(h('span', { class: 'warn', title: 'The golden model starts with the hardware at cycle 0' }, 'golden model joins at the next Reset'));
    else {
      const what = ['registers', ...(r.f ? ['f registers'] : []), ...(r.fcsr !== null ? ['fcsr'] : []), ...(d.pipeline ? [] : ['the PC']), ...(d.dmem ? ['memory'] : []), ...(d.iss.system || d.iss.mmio ? ['console', 'LEDs'] : [])];
      bits.push(h('span', { class: 'good', title: `After every retired instruction ${what.join(', ')} match the instruction-set simulator${d.pipeline && d.dmem ? ' (the memory at the halt: a pipeline’s stores run ahead)' : ''}` }, '✓ matches golden model'));
    }
    if (mon.iss?.halted) bits.push(h('span', { class: 'warn' }, 'halted'));
    bits.push(...this.energy(mon));
    const key = bits.map((b) => (typeof b === 'string' ? b : b.outerHTML)).join('');
    keyed(this.status, key, () => bits);
    const gaps = cpuGaps(d, r);
    keyed(this.gaps, gaps.join('|'), () => (gaps.length ? [h('div', null, h('b', null, 'Shown as far as it goes: '), gaps.join('; '), '.'),
      h('div', { class: 'sb-sum' }, 'Set the missing pieces in the chip’s properties (CPU), with nothing selected.')] : []));
  }

  /** The program with the current line and tags (pipeline stages, or which core is where). */
  private renderListing(mon: Mon, pc: number | null, tags: { tag: string; pc: number; title?: string }[] | null, noPc: string): void {
    const rom = mon instanceof MultiMonitor ? this.multi?.cores[0]?.rom : wordListed(mon) ? mon.desc?.rom : this.desc?.rom;
    const part = rom ? partAt(this.ed.doc, rom, this.ed.ws.chips)?.part : undefined;
    const rr = part && 'rom' in part.ref ? part.ref.rom : null;
    const lk = rr ? `${rom}|${rr.src}|${rr.k}|${rr.lang}` : '';
    if (lk !== this.listKey) {
      // A new program: the selected line no longer means the same instruction.
      if (this.listKey && this.sel !== null) {
        this.sel = null;
        this.fieldPin = null;
        this.use.replaceChildren();
      }
      this.listKey = lk;
      this.curKey = '';
      const img = rr ? romImage(rr) : null;
      this.rowOf.clear();
      if (rr?.lang === '6502') {
        // a row per instruction (and data byte) at the CPU address it answers at, its bytes beside it
        const ls = img?.lines ?? [];
        this.rows = ls.filter((l) => l.text).map((l) => {
          const n = l.op ? OPCODES[l.word]?.bytes ?? 1 : 1;
          const bytes = ls.slice(l.addr / 4, l.addr / 4 + n).map((x) => x.word.toString(16).padStart(2, '0')).join(' ');
          const row = h('div', { class: 'ln', 'data-pc': String(l.addr), title: 'Select this instruction' },
            h('span', { class: 'a' }, l.at !== undefined ? l.at.toString(16).padStart(4, '0') : `[${l.addr / 4}]`), h('span', { class: 'w' }, bytes.padEnd(8)), h('span', { class: 't' }, l.text));
          row.addEventListener('click', () => this.select(l.addr));
          this.rowOf.set(l.addr, row);
          return row;
        });
      } else this.rows = (img?.lines ?? []).map((l) => {
        const row = h('div', { class: 'ln', 'data-pc': String(l.addr), title: 'Mark the parts this instruction uses' },
          h('span', { class: 'a' }, (rr!.lang === 'rv16' || rr!.lang === 'cpu4' || rr!.lang === 'isa' ? l.addr / 4 : l.addr).toString(16).padStart(rr!.lang === 'cpu4' || rr!.lang === 'isa' ? 2 : 4, '0')), h('span', { class: 'w' }, rr!.w <= 16 ? hex4(l.word) : hex8(l.word)), h('span', { class: 't' }, l.text));
        row.addEventListener('click', () => this.select(l.addr));
        this.rowOf.set(l.addr, row);
        return row;
      });
      this.listing.replaceChildren(...(this.rows.length ? this.rows : [h('div', { class: 'ln' }, img?.error ?? 'empty program')]));
    }
    const ck = `${pc}|${this.sel}|${tags?.map((s) => `${s.tag}${s.pc}`).join(',')}`;
    if (ck === this.curKey) return;
    this.curKey = ck;
    for (const row of this.rows) {
      const a = Number(row.dataset.pc);
      row.classList.toggle('cur', a === pc || (pc === null && !!tags?.some((t) => t.pc === a)));
      row.classList.toggle('sel', a === this.sel);
      row.querySelectorAll('.stg').forEach((e) => e.remove());
      for (const s of tags ?? []) if (s.pc === a) row.append(h('span', { class: 'stg', title: s.title ?? `in stage ${s.tag}` }, s.tag));
    }
    const at = pc ?? tags?.[0]?.pc ?? null;
    const cur = at !== null && at >= 0 ? this.rowOf.get(at) : undefined;
    if (cur && this.sel === null) {
      const top = cur.offsetTop - this.listing.offsetTop, bottom = top + cur.offsetHeight;
      if (top < this.listing.scrollTop || bottom > this.listing.scrollTop + this.listing.clientHeight) this.listing.scrollTop = Math.max(0, top - this.listing.clientHeight / 3);
    }
    if (mon instanceof MultiMonitor || wordListed(mon)) return;
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    this.now.replaceChildren(...(w === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, noPc)]
      : [h('span', { class: 'fmt' }, `${decode(w, this.desc?.iss.custom).fmt}-type`), h('code', null, disasm(w, pc!, this.desc?.iss.custom)), h('span', { class: 'hexw' }, `0x${hex4(pc!)}`)]));
  }

  /** A listing line clicked: mark the parts its instruction uses (the site's CPUs' names), or clear. */
  private select(pc: number): void {
    this.sel = this.sel === pc ? null : pc;
    this.fieldPin = this.fieldHover = null;
    this.curKey = '';
    this.render();
  }

  /** The instruction the marks and the field breakdown are about now, and why. */
  private focusPc(): { pc: number; role: string } | null {
    const mon = this.mon;
    if (!mon) return null;
    if (wordListed(mon)) return null;
    if (this.sel !== null) return { pc: this.sel, role: 'selected' };
    if (mon instanceof MultiMonitor) return null;
    const d = mon.desc;
    if (d?.pipeline) {
      const dpc = pipelineSlots(this.ed.sim, this.ed.doc, d)?.find((s) => s.stage === 'D')?.pc;
      if (dpc !== undefined) return { pc: dpc, role: 'in Decode' };
    }
    const pc = d?.pc ? refValue(this.ed.sim, this.ed.doc, d.pc) : null;
    return pc !== null && pc >= 0 ? { pc, role: 'current' } : null;
  }

  private renderFields(mon: CpuMonitor, _d: CpuDesc, _r: CpuRead | null): void {
    const f = this.running ? null : this.focusPc();
    const w = f ? mon.wordAt(f.pc) : null;
    this.fieldsSec.hidden = this.fields.hidden = !this.running && w === null;
    if (this.running) return; // frozen while running fast: a breakdown per frame is noise
    keyed(this.fields, f && w !== null ? `${f.pc}:${w}:${f.role}` : 'none', () => (f && w !== null ? [
      h('div', { class: 'cpu-fields-head' }, h('code', null, disasm(w, f.pc, this.desc?.iss.custom)), h('span', null, f.role)),
      instrBreakdown(w, {
        compact: true, selected: this.fieldPin, onField: (k, sticky) => {
          if (sticky) this.fieldPin = this.fieldPin === k ? null : k;
          else this.fieldHover = k;
          this.fields.querySelectorAll<HTMLElement>('[data-field]').forEach((e) => e.classList.toggle('on', e.dataset.field === this.fieldPin));
          this.computeMarks();
        },
      })] : []));
  }

  private renderPipe(mon: CpuMonitor): void {
    const e = this.entry;
    const sim = this.ed.sim.sim;
    if (e && sim && this.ed.sim.cycles === 0) {
      e.pipe.clear();
      e.pipe.record(sim, sim.design.root, 0);
    }
    const snaps = e?.pipe.snaps ?? [];
    this.pipeSec.hidden = this.pipe.hidden = !snaps.length;
    if (!snaps.length) return;
    keyed(this.pipe, `${snaps[snaps.length - 1].cycle}|${snaps.length}|${this.listKey}`, () => pipeGridRows(snaps, (pc) => mon.wordAt(pc) ?? undefined, 7));
  }

  /**
   * The system CPU's I/O: what it printed, its LEDs, the switches and interrupt line it reads, its
   * CSRs; or a chip's console, LED bank and switch-bank parts (memory-mapped I/O without the system).
   */
  private renderIo(mon: CpuMonitor): void {
    const doc = this.ed.doc, sim = this.ed.sim.sim;
    const swPin = pinNamed(doc, 'in', 8, 'switches');
    const has = !!(pinNamed(doc, 'out', 1, 'consoleValid') || pinNamed(doc, 'out', 8, 'leds') || swPin) || mon.hasIo;
    this.ioSec.hidden = this.io.hidden = !has;
    if (!has || !sim) return;
    keyed(this.con, mon.console, () => [mon.console || ' ']);
    this.con.scrollTop = this.con.scrollHeight;
    const ledv = mon.leds;
    keyed(this.leds, String(ledv), () => Array.from({ length: 8 }, (_, i) => h('span', { class: `led${ledv !== null && ledv >= 0 && (ledv >> (7 - i)) & 1 ? ' on' : ''}`, title: `LED ${7 - i}` })));
    // a switch bank part (no switches pin): its leaf holds the positions, a click flips one there
    const bank = mon.switchBank, li = bank ? ioLeaf(bank) : undefined;
    const bankInfo = bank ? ioInfo(bank.def) : null;
    const width = bankInfo?.kind === 'switches' ? bankInfo.width : 8;
    const swv = swPin ? (typeof swPin.value === 'number' ? swPin.value : 0) : li !== undefined ? (sim.leafState(li) as SwitchState | undefined)?.v ?? 0 : 0;
    const flip = (b: number) => {
      if (swPin) this.ed.setPinValue(swPin.id, swv ^ (1 << b));
      else if (li !== undefined) this.ed.sim.pokeLeaf(li, { v: swv ^ (1 << b) } satisfies SwitchState);
    };
    keyed(this.sw, `${swPin?.id}|${li}|${swv}`, () => Array.from({ length: 8 }, (_, i) => {
      const b = 7 - i, on = (swv >> b) & 1;
      const where = swPin ? 'the switches pin' : bank ? `switch bank ${bank.path.join('.')}` : 'no switches';
      return h('button', { class: `sw${on ? ' on' : ''}`, title: `switch ${b} (${where}, bit ${b})`, disabled: !swPin && (li === undefined || b >= width), onclick: () => flip(b) }, String(b));
    }));
    this.io.querySelector('.sb-cpu-irq')?.toggleAttribute('hidden', !pinNamed(doc, 'in', 1, 'irq'));
    const rows = csrRows(sim);
    keyed(this.csrs, rows.map((r) => r.join('=')).join('|'), () => rows.map(([k, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, k), h('span', { class: 'v' }, v))));
    this.csrs.hidden = !rows.length;
    this.csrs.previousElementSibling?.toggleAttribute('hidden', !rows.length);
  }

  private trackChanges(mon: Mon, xs: (number[] | null)[]): void {
    if (mon.seq === this.regSeq && this.lastX.length === xs.length) return;
    // Changed by the last retirement (or since the last look, without a golden model).
    this.changed = xs.map((x, k) => {
      const prev = this.lastX[k];
      const s = new Set<number>();
      if (x && prev) x.forEach((v, i) => { if (v !== prev[i]) s.add(i); });
      return s;
    });
    this.regSeq = mon.seq;
    this.lastX = xs.map((x) => (x ? [...x] : null));
  }

  private renderRegs(mon: CpuMonitor, r: CpuRead | null): void {
    const x = r?.x ?? null;
    this.trackChanges(mon, [x]);
    const chg = this.changed[0] ?? new Set<number>();
    this.regsSec.textContent = 'Registers';
    if (!x) keyed(this.regs, 'none', () => [h('div', { class: 'sb-sum sb-cpu-span' }, 'No register file found.')]);
    else {
      keyed(this.regs, `${x.join(',')}|${[...chg].join(',')}`, () => x.map((v, i) => h('div', { class: `r${chg.has(i) && this.ed.sim.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `x${i} = ${v < 0 ? 'unknown' : v | 0}` },
        h('span', { class: 'n' }, ABI[i]), h('span', { class: 'v' }, hexR(v)))));
    }
    this.regs.classList.remove('sb-cpu-mregs');
    const f = r?.f;
    this.fregsSec.hidden = this.fregs.hidden = !f;
    if (f) {
      const fc = r?.fcsr ?? null;
      keyed(this.fregs, `${f.join(',')}|${fc}`, () => {
        const nz = f.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
        return [
          ...(fc !== null ? [h('div', { class: 'm', title: 'fcsr: the dynamic rounding mode frm and the accrued exception flags (sticky)' },
            h('span', { class: 'n' }, 'fcsr'), h('span', { class: 'v' }, fc < 0 ? 'frm ?' : `frm ${RM_NAMES[fc >> 5] ?? fc >> 5}`), h('span', { class: 'd' }, fc < 0 ? '' : `flags ${flagNames(fc & 31)}`))] : []),
          ...(nz.length ? nz.map(([i, v]) => h('div', { class: 'm' },
            h('span', { class: 'n' }, FABI[i]), h('span', { class: 'v' }, hexR(v)), h('span', { class: 'd' }, v < 0 ? '?' : String(+bitsToF32(v).toPrecision(8)))))
            : [h('div', { class: 'm z' }, 'all +0.0')])];
      });
    }
  }

  private renderMem(d: CpuDesc | null, r: CpuRead | null, words: number[] | null = r?.dmem ?? null, label = 'Data memory'): void {
    const dm = d?.dmem ?? this.multi?.dmem;
    this.memSec.hidden = this.mem.hidden = !dm;
    if (!dm) return;
    keyed(this.memSec, `${label}|${dm}|${words?.length}`, () => [label, h('span', { class: 'cpu-sec-hint' }, `${dm}${words ? ` · ${words.length} words, non-zero shown` : ''}`)]);
    // a hash, not the words joined: a large data memory has 65 536 of them
    keyed(this.mem, words ? `${words.length}:${wordsHash(words)}` : 'none', () => {
      if (!words) return [h('div', { class: 'm z' }, 'not readable (no word registers found)')];
      const nz = words.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
      return [...(nz.length ? nz.slice(0, 64).map(([i, v]) => h('div', { class: 'm' },
        h('span', { class: 'n' }, `[0x${(4 * i).toString(16).padStart(2, '0')}]`), h('span', { class: 'v' }, fmtWord(v)), h('span', { class: 'd' }, v < 0 ? '?' : String(v | 0))))
        : [h('div', { class: 'm z' }, 'all zero')]), ...(nz.length > 64 ? [h('div', { class: 'm z' }, `… ${nz.length - 64} more`)] : [])];
    });
  }

  private renderTrace(mon: Mon): void {
    const show = mon instanceof CpuMonitor ? !!mon.desc?.regs : mon instanceof Cpu4Monitor ? !mon.desc?.table : true;
    const rv16 = mon instanceof Rv16Monitor || mon instanceof LaneMonitor;
    const m65 = mon instanceof M6502Monitor;
    keyed(this.traceSec, rv16 ? 'rv16' : m65 ? 'm6502' : 'cpu', () => (rv16 ? ['Checked writes', h('span', { class: 'cpu-sec-hint' }, 'register writes and stores, newest last')]
      : ['Retired', h('span', { class: 'cpu-sec-hint' }, m65 ? 'what each did, its stores and cycles; newest last' : 'by the golden model, newest last')]));
    // An RV16 listing's rows are keyed like the others' (4 × the word index).
    const row = (pc: number) => (mon instanceof M6502Monitor ? 4 * (mon.romIndex(pc) ?? 0) : wordListed(mon) ? 4 * pc : pc);
    this.traceSec.hidden = this.trace.hidden = !show;
    if (mon.seq === this.seqSeen) return;
    this.seqSeen = mon.seq;
    this.trace.replaceChildren(...mon.log.slice(-40).map((e) => h('div', { class: 'tr', title: 'Select this instruction in the listing', onclick: () => this.select(row(e.pc)) },
      h('span', { class: 'c' }, String(e.cycle)), h('span', { class: 't' }, e.hart !== undefined ? h('b', { class: 'sb-cpu-hart' }, `C${e.hart}`) : null, e.text), h('span', { class: 'eff' }, e.effect))));
    this.trace.lastElementChild?.classList.add('new');
    this.trace.scrollTop = this.trace.scrollHeight;
  }

  // ---- several cores ---------------------------------------------------------------------

  private renderMulti(mon: MultiMonitor): void {
    const es = this.ed.sim, d = mon.desc!;
    const cores = mon.read();
    const bits: HTMLElement[] = [h('span', null, `cycle ${es.cycles}`),
      h('span', { title: 'Cycles each core waited for the shared memory port' }, `stalls ${mon.stalls.map((s, i) => `C${i} ${s}`).join(', ')}`)];
    if (mon.mismatch) bits.push(h('span', { class: 'bad', title: 'The first difference between the hardware and the multi-hart model; the check stops there' }, `✗ ${mismatchText(mon.mismatch)}`));
    else if (mon.problem) bits.push(h('span', { class: 'warn' }, `no golden model: ${mon.problem}`));
    else if (!mon.synced) bits.push(h('span', { class: 'warn', title: 'The golden model starts with the hardware at cycle 0' }, 'golden model joins at the next Reset'));
    else bits.push(h('span', { class: 'good', title: 'Every cycle: which cores retired (the arbitration), every core’s registers and PC, and the shared memory match the multi-hart model' }, '✓ matches the multi-hart golden model'));
    if (mon.m?.halted) bits.push(h('span', { class: 'warn' }, 'all halted'));
    keyed(this.status, bits.map((b) => b.outerHTML).join(''), () => bits);
    keyed(this.gaps, '', () => []);
    keyed(this.now, cores.map((c, i) => `${c.pc}|${mon.lastStall[i]}`).join(','), () => [h('div', { class: 'sb-cpu-cores' }, cores.map((c, i) => {
      const w = c.pc !== null && c.pc >= 0 ? mon.wordAt(c.pc) : null;
      return h('div', { class: 'sb-cpu-core' }, h('b', { class: 'sb-cpu-hart' }, `C${i}`),
        h('code', null, w === null ? 'PC unknown' : `${hex4(c.pc!)}  ${disasm(w, c.pc!, this.desc?.iss.custom)}`),
        mon.lastStall[i] ? h('span', { class: 'warn', title: 'Lost the memory port to the other core at the last edge' }, 'stalled') : null);
    }))]);
    this.renderListing(mon, null, cores.flatMap((c, i) => (c.pc !== null && c.pc >= 0 ? [{ tag: `C${i}`, pc: c.pc, title: `core ${i} (${d.cores[i].part}) fetches this` }] : [])), '');
    // the selected line's breakdown only (each core runs its own instruction)
    const w = this.sel !== null ? mon.wordAt(this.sel) : null;
    this.fieldsSec.hidden = this.fields.hidden = w === null;
    keyed(this.fields, w === null ? 'none' : `${this.sel}:${w}`, () => (w === null ? [] : [
      h('div', { class: 'cpu-fields-head' }, h('code', null, disasm(w, this.sel!, this.desc?.iss.custom)), h('span', null, 'selected')),
      instrBreakdown(w, { compact: true })]));
    this.pipeSec.hidden = this.pipe.hidden = this.ioSec.hidden = this.io.hidden = this.fregsSec.hidden = this.fregs.hidden = true;
    // registers side by side: the ones any core has set
    const xs = cores.map((c) => c.x);
    this.trackChanges(mon, xs);
    this.regsSec.textContent = 'Registers (non-zero in any core)';
    this.regs.classList.add('sb-cpu-mregs');
    this.regs.style.setProperty('--n', String(cores.length));
    const shown = Array.from({ length: 32 }, (_, i) => i).filter((i) => xs.some((x) => x && x[i] !== 0));
    keyed(this.regs, `${xs.map((x) => x?.join(',')).join('|')}|${this.changed.map((s) => [...s].join(',')).join('|')}`, () => [
      h('span', { class: 'hd' }, ''), ...cores.map((_, i) => h('span', { class: 'hd' }, `core ${i}`)),
      ...(shown.length ? shown.flatMap((i) => [h('span', { class: 'n' }, ABI[i]), ...xs.map((x, k) => {
        const v = x?.[i] ?? -1;
        return h('span', { class: `v${this.changed[k]?.has(i) && es.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `core ${k}: x${i} = ${v < 0 ? 'unknown' : v | 0}` }, hexR(v));
      })]) : [h('span', { class: 'sb-sum sb-cpu-span' }, 'all zero')]),
    ]);
    this.renderMem(null, null, mon.readMem(), 'Shared memory');
    this.renderTrace(mon);
    this.computeMarks();
  }

  // ---- an RV16 computer ------------------------------------------------------------------

  private renderRv16(mon: Rv16Monitor): void {
    const es = this.ed.sim;
    const pc = mon.pc;
    const leds = mon.leds;
    const bits: HTMLElement[] = [h('span', null, `cycle ${es.cycles}`), h('span', { title: 'Register writes and stores the core made, each matched with the golden model' }, `writes ${mon.retired}`)];
    if (leds !== null) bits.push(h('span', { title: 'The leds pin' }, `LEDs ${leds < 0 ? '????' : `0x${hex4(leds)}`}`));
    if (mon.mismatch) bits.push(h('span', { class: 'bad', title: 'The first difference between the core and the RV16 golden model; the check stops there' }, `✗ ${mismatchText(mon.mismatch)}`));
    else if (mon.problem) bits.push(h('span', { class: 'warn' }, `no golden model: ${mon.problem}`));
    else if (!mon.synced) bits.push(h('span', { class: 'warn', title: 'The golden model starts with the hardware at cycle 0' }, 'golden model joins at the next Reset'));
    else bits.push(h('span', { class: 'good', title: `Every register write on ${mon.desc!.core}'s write port (rwe, rwa, rwd) and every store (dwe, daddr, dwdata) matches the RV16 golden model, in program order: the campaign's core bench, live` }, '✓ matches the RV16 golden model'));
    if (mon.iss?.halted && mon.done) bits.push(h('span', { class: 'warn' }, 'halted'));
    const next = mon.next;
    if (next) bits.push(h('span', { class: 'sb-cpu-next', title: 'The next register write or store the golden model expects from the core' }, `next: ${next}`));
    keyed(this.status, bits.map((b) => b.outerHTML).join(''), () => bits);
    keyed(this.gaps, '', () => []);
    this.renderListing(mon, pc !== null && pc >= 0 ? 4 * pc : pc, null, '');
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    keyed(this.now, `${pc}|${w}`, () => (w === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, pc === null ? 'not found' : 'unknown (X)')]
      : [h('span', { class: 'fmt' }, 'RV16'), h('code', null, disasm16(w, pc!)), h('span', { class: 'hexw' }, `0x${hex4(pc!)}`)]));
    this.fieldsSec.hidden = this.fields.hidden = this.pipeSec.hidden = this.pipe.hidden = this.ioSec.hidden = this.io.hidden = true;
    this.fregsSec.hidden = this.fregs.hidden = this.memSec.hidden = this.mem.hidden = true;
    keyed(this.use, '', () => []);
    const x = [...mon.hw];
    this.regsSec.textContent = 'Registers (as the core wrote them)';
    this.regs.classList.remove('sb-cpu-mregs');
    this.regs.style.removeProperty('--n');
    const model = mon.iss ? [...mon.iss.x] : null;
    keyed(this.regs, `${x.join(',')}|${mon.lastWrite}|${es.cycles > 0}`, () => x.map((v, i) => h('div', {
      class: `r${i === mon.lastWrite && es.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`,
      title: `x${i} = ${v} (${(v << 16) >> 16} signed)${model && model[i] !== v ? `; the golden model has run ahead to 0x${hex4(model[i])}` : ''}`,
    }, h('span', { class: 'n' }, REG_NAMES16[i]), h('span', { class: 'v' }, `0x${hex4(v).toUpperCase()}`))));
    this.renderTrace(mon);
    this.computeMarks();
  }

  // ---- an RV16 lane core (act 9) ----------------------------------------------------------

  private renderLanes(mon: LaneMonitor): void {
    const es = this.ed.sim, d = mon.desc!;
    const pc = mon.pc, warp = mon.warp;
    const bits: HTMLElement[] = [h('span', null, `cycle ${es.cycles}`), h('span', { title: 'Register writes, stores and pixel writes the core made, each matched with the golden model' }, `writes ${mon.retired}`)];
    if (d.raster) bits.push(h('span', { title: 'Pixel writes of the rasterizer (fa, fd, fwe), matched with the triangles the golden model drew' }, `pixels ${mon.pixels}`));
    if (mon.mismatch) bits.push(h('span', { class: 'bad', title: 'The first difference between the core and the lane golden model; the check stops there' }, `✗ ${mismatchText(mon.mismatch)}`));
    else if (mon.problem) bits.push(h('span', { class: 'warn' }, `no golden model: ${mon.problem}`));
    else if (mon.error) bits.push(h('span', { class: 'warn', title: 'The golden model stopped: the program does something the lanes cannot (the hardware does whatever its gates do)' }, `golden model stopped: ${mon.error}`));
    else if (!mon.synced) bits.push(h('span', { class: 'warn', title: 'The golden model starts with the hardware at cycle 0' }, 'golden model joins at the next Reset'));
    else {
      const ports = d.warps === 2 ? 'its write port (rwe, rwa, rwd<i>), the load port (lwe, lwa, lwd<i>: the previous cycle’s warp)' : 'the write port (rwe, rwa, rwd<i>)';
      bits.push(h('span', { class: 'good', title: `Every lane’s register writes on ${ports} and stores (dwe, daddr<i>, dwdata<i>)${d.raster ? ', and every pixel the rasterizer writes,' : ''} match the ${d.warps === 2 ? 'two-warp' : 'lane'} golden model, in order: the level’s bench, live` }, `✓ matches the ${d.warps === 2 ? 'two-warp' : 'lane'} golden model`));
    }
    if (mon.halted && mon.done) bits.push(h('span', { class: 'warn' }, 'halted'));
    const next = mon.next;
    if (next) bits.push(h('span', { class: 'sb-cpu-next', title: 'The oldest write the golden model expects from the core' }, `next: ${next}`));
    keyed(this.status, bits.map((b) => b.outerHTML).join(''), () => bits);
    keyed(this.gaps, '', () => []);
    const at = pc !== null && pc >= 0 ? 4 * pc : pc;
    this.renderListing(mon, at, warp !== null && warp >= 0 && at !== null && at >= 0 ? [{ tag: `W${warp}`, pc: at, title: `warp ${warp} issues this` }] : null, '');
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    keyed(this.now, `${pc}|${w}|${warp}`, () => (w === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, pc === null ? 'not found' : 'unknown (X)')]
      : [h('span', { class: 'fmt' }, warp !== null && warp >= 0 ? `warp ${warp}` : 'RV16'), h('code', null, disasm16(w, pc!)), h('span', { class: 'hexw' }, `0x${hex4(pc!)}`)]));
    this.fieldsSec.hidden = this.fields.hidden = this.pipeSec.hidden = this.pipe.hidden = this.ioSec.hidden = this.io.hidden = true;
    this.fregsSec.hidden = this.fregs.hidden = this.memSec.hidden = this.mem.hidden = true;
    keyed(this.use, '', () => []);
    // every thread's registers side by side, as its write ports set them
    const T = mon.threads, n = d.lanes;
    const head = (t: number) => (d.warps === 2 ? `w${Math.floor(t / n)} l${t % n}` : `lane ${t}`);
    this.regsSec.textContent = 'Registers (as the core wrote them)';
    this.regs.classList.add('sb-cpu-mregs');
    this.regs.style.setProperty('--n', String(T));
    keyed(this.regs, `${mon.hw.map((x) => x.join(',')).join('|')}|${mon.lastWrite.join(',')}|${es.cycles > 0}`, () => [
      h('span', { class: 'hd' }, ''), ...Array.from({ length: T }, (_, t) => h('span', { class: 'hd', title: `thread ${t} (tid)` }, head(t))),
      ...Array.from({ length: 8 }, (_, r) => [h('span', { class: 'n' }, REG_NAMES16[r]), ...mon.hw.map((x, t) => {
        const v = x[r];
        return h('span', { class: `v${mon.lastWrite[t] === r && es.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `${head(t)}: x${r} = ${v} (${(v << 16) >> 16} signed)` }, hex4(v).toUpperCase());
      })]).flat(),
    ]);
    this.renderTrace(mon);
    this.computeMarks();
  }

  // ---- a 6502 ----------------------------------------------------------------------------

  private render6502(mon: M6502Monitor): void {
    const es = this.ed.sim, d = mon.desc!;
    const pc = mon.pc, r = mon.read(), bus = mon.bus;
    const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
    const bits: HTMLElement[] = [h('span', null, `cycle ${es.cycles}`), h('span', null, `retired ${mon.retired}${mon.retired ? ` · CPI ${(es.cycles / mon.retired).toFixed(2)}` : ''}`)];
    if (mon.problem) bits.push(h('span', { class: 'warn' }, mon.problem));
    else bits.push(h('span', { class: 'good', title: 'The part is the cycle-exact model (the transistor-level chip makes the same bus cycles; double-click it): nothing to check against, so the panel follows it, instruction by instruction' }, 'cycle-exact model'));
    if (mon.halted) bits.push(h('span', { class: 'warn', title: 'The last instruction jumped to itself (JMP *, or a branch to itself)' }, 'halted'));
    keyed(this.status, bits.map((b) => b.outerHTML).join(''), () => bits);
    const gap = d.rom ? '' : 'no ROM in 6502 assembly found (a ROM part with Language 6502 assembly, here or in a chip placed here): no listing';
    keyed(this.gaps, gap, () => (gap ? [h('div', null, h('b', null, 'Followed as far as it goes: '), gap, '.')] : []));
    const ri = pc !== null && pc >= 0 ? mon.romIndex(pc) : null;
    this.renderListing(mon, ri !== null ? 4 * ri : pc, null, '');
    const cur = mon.current;
    // the instruction under way, the cycle within it and this cycle's bus
    keyed(this.now, `${pc}|${cur}|${mon.tcycle}|${bus ? `${bus.addr}${bus.write}${bus.data}` : ''}`, () => (cur === null || pc === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, pc === null ? (r ? 'in the reset sequence' : 'not simulated') : 'unknown (X)')]
      : [h('span', { class: 'fmt' }, '6502'), h('code', null, cur), h('span', { class: 'hexw' }, `$${hx(pc, 4)}`),
        ...(bus ? [h('span', { class: 'sb-cpu-bus', title: 'The last bus cycle: its address, a read or a write, the byte, and which cycle of the instruction it was (T0: the opcode fetch)' },
          `T${Math.max(0, mon.tcycle - 1)} ${bus.write ? 'W' : 'R'} $${hx(bus.addr, 4)} ${hx(bus.data)}${bus.sync ? ' SYNC' : ''}`)] : [])]));
    this.fieldsSec.hidden = this.fields.hidden = this.pipeSec.hidden = this.pipe.hidden = this.ioSec.hidden = this.io.hidden = true;
    this.fregsSec.hidden = this.fregs.hidden = true;
    keyed(this.use, '', () => []);
    // registers: A, X, Y, S, P with its flags, PC
    const names = ['A', 'X', 'Y', 'S', 'P', 'PC'];
    const x = r ? [r.a, r.x, r.y, r.s, r.p, r.pc] : null;
    this.trackChanges(mon, [x]);
    const chg = this.changed[0] ?? new Set<number>();
    this.regsSec.textContent = 'Registers';
    this.regs.classList.remove('sb-cpu-mregs');
    this.regs.style.removeProperty('--n');
    if (!x) keyed(this.regs, 'none', () => [h('div', { class: 'sb-sum sb-cpu-span' }, mon.problem ?? 'Not simulated.')]);
    else {
      keyed(this.regs, `${x.join(',')}|${[...chg].join(',')}`, () => x.map((v, i) => h('div', {
        class: `r${chg.has(i) && es.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`,
        title: i === 4 ? `P = ${flags6502(v)}: N negative, V overflow, B break (only on the stack), D decimal, I interrupts off, Z zero, C carry` : i === 5 ? `PC = $${hx(v, 4)}: the next byte the CPU fetches` : `${names[i]} = ${v} (${(v << 24) >> 24} signed)`,
      }, h('span', { class: 'n' }, names[i]), h('span', { class: 'v' }, i === 4 ? `${hx(v)} ${flags6502(v)}` : `$${hx(v, i === 5 ? 4 : 2)}`))));
    }
    // the RAM: its non-zero bytes (the zero page and the stack first)
    const ram = d.ram && es.sim ? readMem(es.sim, d.ram) : null;
    this.memSec.hidden = this.mem.hidden = !d.ram;
    if (d.ram) {
      keyed(this.memSec, `${d.ram}|${ram?.length}`, () => ['RAM', h('span', { class: 'cpu-sec-hint' }, `${d.ram}${ram ? ` · ${ram.length} bytes by its own address, non-zero shown` : ''}`)]);
      keyed(this.mem, ram ? `${ram.length}:${wordsHash(ram)}` : 'none', () => {
        if (!ram) return [h('div', { class: 'm z' }, 'not readable')];
        const nz = ram.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
        return [...(nz.length ? nz.slice(0, 64).map(([i, v]) => h('div', { class: 'm' },
          h('span', { class: 'n' }, `[$${hx(i, 4)}]`), h('span', { class: 'v' }, v < 0 ? '??' : `$${hx(v)}`), h('span', { class: 'd' }, v < 0 ? '?' : String(v))))
          : [h('div', { class: 'm z' }, 'all zero')]), ...(nz.length > 64 ? [h('div', { class: 'm z' }, `… ${nz.length - 64} more`)] : [])];
      });
    }
    this.renderTrace(mon);
    this.computeMarks();
  }

  // ---- a 4-bit CPU ------------------------------------------------------------------------

  private renderCpu4(mon: Cpu4Monitor): void {
    const es = this.ed.sim;
    const pc = mon.pc, r = mon.read(), isa = mon.isa;
    const bits: HTMLElement[] = [h('span', null, `cycle ${es.cycles}`), ...(mon.iss ? [h('span', null, `retired ${mon.retired}`)] : [])];
    if (mon.mismatch) bits.push(h('span', { class: 'bad', title: 'The first difference between the hardware and the 4-bit golden model; the check stops there' }, `✗ ${mismatchText(mon.mismatch)}`));
    else if (mon.desc?.table) bits.push(h('span', { class: 'warn', title: mon.problem ?? '' }, 'not checked: no golden model for a custom instruction set'));
    else if (mon.problem) bits.push(h('span', { class: 'warn' }, `no golden model: ${mon.problem}`));
    else if (mon.unchecked) bits.push(h('span', { class: 'warn', title: mon.unchecked }, 'not checked'));
    else if (!mon.synced) bits.push(h('span', { class: 'warn', title: 'The golden model starts with the hardware at cycle 0' }, 'golden model joins at the next Reset'));
    else bits.push(h('span', { class: 'good', title: 'After every clock the PC, A, CY, R0–R15, the stack, SRC and the five output ports match the 4-bit golden model' }, '✓ matches golden model'));
    if (mon.iss?.halted) bits.push(h('span', { class: 'warn' }, 'halted'));
    keyed(this.status, bits.map((b) => b.outerHTML).join(''), () => bits);
    keyed(this.gaps, mon.unchecked ?? '', () => (mon.unchecked ? [h('div', null, h('b', null, 'Followed, not checked: '), mon.unchecked, '.')] : []));
    this.renderListing(mon, pc !== null && pc >= 0 ? 4 * pc : pc, null, '');
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    const hx2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    keyed(this.now, `${pc}|${w}`, () => (w === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, pc === null ? 'not found' : 'unknown (X)')]
      : [h('span', { class: 'fmt' }, mon.desc?.table ? mon.desc.table.name : '4-bit'), h('code', null, isa.disasm(w, pc!)), h('span', { class: 'hexw' }, `0x${hx2(pc!)}`)]));
    // The field breakdown of the selected instruction, else the current one (frozen while running fast).
    const fpc = this.sel !== null ? this.sel / 4 : pc !== null && pc >= 0 ? pc : null;
    const fw = fpc !== null && !this.running ? mon.wordAt(fpc) : null;
    this.fieldsSec.hidden = this.fields.hidden = fw === null;
    const ROLE = { op: 'f-op', reg: 'f-rd', imm: 'f-imm', cond: 'f-fn', none: 'f-imm unused' } as const;
    keyed(this.fields, fw === null ? 'none' : `${fpc}:${fw}:${this.sel !== null}`, () => {
      if (fw === null) return [];
      let hi = isa.wordBits - 1;
      const boxes = isa.fields(fw).map((f) => {
        const top = hi;
        hi -= f.bits;
        return h('div', { class: ROLE[f.kind], style: `--w:${f.bits}`, title: `${f.name}, bits ${top}:${top - f.bits + 1} = ${f.value}` },
          h('div', { class: 'fname' }, f.name),
          h('div', { class: 'fbits' }, Array.from({ length: f.bits }, (_, i) => h('span', { class: 'bit' }, String((fw >>> (top - i)) & 1)))));
      });
      return [
        h('div', { class: 'cpu-fields-head' }, h('code', null, isa.disasm(fw, fpc!)), h('span', null, this.sel !== null ? 'selected' : 'current')),
        h('div', { class: 'ibd' }, h('div', { class: 'fields' }, boxes)),
        // A selected line's path is in the box under the listing already.
        ...(isa.disasm(fw).startsWith('.word') ? [h('div', { class: 'sb-sum' }, mon.desc?.table ? 'No instruction of the table has this code.' : 'No instruction has this code: it runs as NOP.')]
          : this.sel === null && mon.describe(fw) ? [h('div', { class: 'sb-sum' }, mon.describe(fw)!)] : []),
      ];
    });
    this.pipeSec.hidden = this.pipe.hidden = this.ioSec.hidden = this.io.hidden = true;
    this.fregsSec.hidden = this.fregs.hidden = this.memSec.hidden = this.mem.hidden = true;
    // Registers: A, CY, PC, SRC, the stack, R0–R15 and the output ports.
    const names = ['A', 'CY', 'PC', 'SRC', 'S1', 'S2', 'S3', ...Array.from({ length: 16 }, (_, i) => `R${i}`), 'port 0', 'port 1', 'port 2', 'port 3', 'LEDs'];
    const digits = [1, 1, 2, 2, 2, 2, 2, ...Array<number>(16).fill(1), 1, 1, 1, 1, 1];
    const x = r ? [r.a, r.cy, r.pc, r.src, ...r.stack, ...r.r, ...r.ports] : null;
    this.trackChanges(mon, [x]);
    const chg = this.changed[0] ?? new Set<number>();
    this.regsSec.textContent = 'Registers';
    this.regs.classList.remove('sb-cpu-mregs');
    // A custom table names no registers: nothing to show.
    this.regsSec.hidden = this.regs.hidden = !!mon.desc?.table;
    if (!x) keyed(this.regs, 'none', () => [h('div', { class: 'sb-sum sb-cpu-span' }, 'Not found: the 4-bit CPU example keeps them at pcs.pc, acc.a, acc.cy, io.src, pcs.s1–s3, regs.r0–r15 and io.port0–4.')]);
    else {
      keyed(this.regs, `${x.join(',')}|${[...chg].join(',')}`, () => x.map((v, i) => h('div', { class: `r${chg.has(i) && es.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `${names[i]} = ${v < 0 ? 'unknown' : v}` },
        h('span', { class: 'n' }, names[i]), h('span', { class: 'v' }, v < 0 ? '?'.repeat(digits[i]) : `0x${v.toString(16).toUpperCase().padStart(digits[i], '0')}`))));
    }
    this.renderTrace(mon);
    this.computeMarks();
  }

  /** The blocks the selected instruction (or, in slow mode, the running one) uses. */
  private computeMarks4(mon: Cpu4Monitor): void {
    const ed = this.ed;
    const pc = this.sel !== null ? this.sel / 4 : this.slow ? mon.pc : null;
    const built = ed.sim.built ?? ed.compiled;
    const key = [ed.chipId, pc, this.sel, !!this.slow, this.open].join('|');
    if (key === this.markKey && built === this.markBuilt) return this.applyMarks();
    this.markKey = key;
    this.markBuilt = built;
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    const u = w !== null && !mon.desc?.table ? cpu4Use(w) : null;
    const have = new Set(ed.doc.parts.map((p) => p.id));
    this.marked = u ? u.units.filter((n) => have.has(n)) : [];
    this.wireMarks = new Map();
    this.useKey = '';
    this.applyMarks();
    const what = w !== null ? mon.describe(w) : null;
    if (this.sel !== null && w !== null && what && this.open) keyed(this.use, `${this.sel}|${w}|${this.marked.length}`, () => [h('code', null, mon.isa.disasm(w, pc!)), h('div', null, what)]);
    else keyed(this.use, '', () => []);
  }

  // ---- marks on the canvas ---------------------------------------------------------------

  private marked: string[] = [];
  private wireMarks = new Map<string, string>();
  private useKey = '';
  private markKey = '';
  private markBuilt: unknown = null;
  private wiresOfNet: { built: unknown; map: Map<number, string[]> } = { built: null, map: new Map() };

  /**
   * What to mark: the selected instruction (or, in slow mode, the one running) — the parts it uses
   * and the wires that carry its fields (the field pointed at in the breakdown: only those). In a
   * pipeline, the field wires carry the instruction in D, and slow mode marks each stage's share.
   */
  private computeMarks(): void {
    const mon = this.mon, ed = this.ed;
    if (mon instanceof Cpu4Monitor) return this.computeMarks4(mon);
    if (mon instanceof Rv16Monitor || mon instanceof LaneMonitor || mon instanceof M6502Monitor) {
      // The parts an instruction uses are named after the chapters' RV32 CPUs: nothing to mark here.
      if (this.marked.length || this.wireMarks.size) this.clearMarks();
      return;
    }
    let units: string[] = [];
    let word: number | null = null;
    let path = '';
    const f = this.sel !== null ? { pc: this.sel, role: 'selected' } : this.slow ? this.focusPc() : null;
    const focus = this.fieldHover ?? this.fieldPin;
    const slots = mon instanceof CpuMonitor && mon.desc?.pipeline ? pipelineSlots(ed.sim, ed.doc, mon.desc) ?? [] : null;
    const built = ed.sim.built ?? ed.compiled;
    // Recomputed only when what it depends on changed (the panel redraws every frame while running).
    const key = [ed.chipId, f?.pc, this.sel, !!this.slow, focus, slots?.map((x) => x.stage + x.pc).join(), this.open].join('|');
    if (key === this.markKey && built === this.markBuilt) return this.applyMarks();
    this.markKey = key;
    this.markBuilt = built;
    if (mon && f && slots && this.sel === null) {
      // slow mode in a pipeline: every stage's part of the work
      units = slots.flatMap((s) => (s.stage in STAGE_UNITS ? stageUse(s.stage as keyof typeof STAGE_UNITS, instrUse(mon.wordAt(s.pc) ?? 0x13)) : []));
      word = mon.wordAt(f.pc);
    } else if (mon && f) {
      word = mon.wordAt(f.pc);
      if (word !== null) {
        const u = instrUse(word);
        units = u.units;
        path = u.path;
      }
    }
    // field wires: only while the instruction is in D, where a pipeline splits it
    const inD = !slots || (!!f && slots.some((x) => x.stage === 'D' && x.pc === f.pc));
    const def = built?.def;
    const m = def && word !== null && inD ? instrMarks(def, word, focus) : null;
    if (m && focus) units = m.units;
    const have = new Set(ed.doc.parts.map((p) => p.id));
    this.marked = [...new Set(units)].filter((n) => have.has(n));
    this.wireMarks = new Map();
    if (m) {
      const byNet = this.netWires();
      for (const [i, cls] of m.nets) for (const w of byNet.get(i) ?? []) this.wireMarks.set(w, cls);
    }
    this.useKey = '';
    this.applyMarks();
    if (this.sel !== null && word !== null && this.open) {
      keyed(this.use, `${this.sel}|${word}|${this.marked.length}`, () => [h('code', null, disasm(word!, this.sel!, this.desc?.iss.custom)),
        h('div', null, this.marked.length ? path : 'No parts named like the chapters’ CPU (rf, alu, imm, …) to mark here.')]);
    } else keyed(this.use, '', () => []);
  }

  /** Wire ids of each net of the compile the simulation runs (instrMarks numbers nets like the netlist). */
  private netWires(): Map<number, string[]> {
    const b = this.ed.sim.built ?? this.ed.compiled;
    if (this.wiresOfNet.built !== b) {
      const map = new Map<number, string[]>();
      for (const [w, i] of b?.netOfWire ?? []) if (i >= 0) map.set(i, [...(map.get(i) ?? []), w]);
      this.wiresOfNet = { built: b, map };
    }
    return this.wiresOfNet.map;
  }

  private clearMarks(): void {
    this.markKey = '';
    this.marked = [];
    this.wireMarks = new Map();
    this.useKey = '';
    this.applyMarks();
  }

  /** Halo the marked parts and colour the field wires (again after a repaint rewrote their classes). */
  applyMarks(): void {
    const svg = this.ed.view.svg;
    const count = () => `${svg.querySelectorAll('.ed-cpu-use').length}|${svg.querySelectorAll('.wire.fld').length}`;
    const key = `${this.ed.chipId}|${this.marked.join(',')}|${[...this.wireMarks].join(',')}`;
    if (`${key}|${count()}` === this.useKey) return;
    svg.querySelectorAll('.ed-cpu-use').forEach((e) => e.classList.remove('ed-cpu-use'));
    svg.querySelectorAll('.wire.fld').forEach((e) => e.classList.remove(...FLD));
    for (const id of this.marked) svg.querySelector(`[data-part="${CSS.escape(id)}"]`)?.classList.add('ed-cpu-use');
    for (const [w, cls] of this.wireMarks) svg.querySelector(`path.wire[data-wire="${CSS.escape(w)}"]`)?.classList.add(...cls.split(' '));
    this.useKey = `${key}|${count()}`;
  }
}

/** The system CPU's machine-mode CSRs and timer, read from its CSR unit and I/O unit (none: []). */
function csrRows(sim: Sim): [string, string][] {
  const csr = partNode(sim, 'csr'), io = partNode(sim, 'io');
  const q = (n: typeof csr, inst: string) => {
    const p = n?.children?.get(inst)?.ports.q;
    return p ? pack(sim.getBits(p)) : null;
  };
  const mie = q(csr, 'rMIE');
  if (mie === null) return [];
  const f = (v: number | null, s = (x: number) => hexR(x)) => (v === null || v < 0 ? '?' : s(v));
  const en = q(csr, 'rMIEN'), cause = q(csr, 'rCause'), epc = q(csr, 'rEpc');
  return [
    ['mstatus', `MIE=${f(mie, String)} MPIE=${f(q(csr, 'rMPIE'), String)}`],
    ['mie', en === null || en < 0 ? '?' : `MTIE=${en & 1} MEIE=${(en >> 1) & 1}`],
    ['mtvec', f(q(csr, 'rTvec'), (v) => hexR(v * 4))],
    ['mepc', f(epc, (v) => hexR(v * 4))],
    ['mcause', f(cause, (v) => `${hexR(v)} ${v === 0 && epc === 0 ? '(no trap yet)' : CAUSE_NAMES[v >>> 0] ?? ''}`)],
    ['mtval', f(q(csr, 'rTval'))],
    ['mtime', f(q(io, 'mtime'), String)],
    ['mtimecmp', f(q(io, 'rCmp'), String)],
  ];
}

registerEditorPlugin((ed) => {
  const p = new CpuPanel(ed);
  const repaint = () => p.applyMarks();
  ed.paintHooks.add(repaint);
  return () => {
    ed.paintHooks.delete(repaint);
    p.destroy();
  };
});

registerToolbarAction({
  id: 'cpu', title: 'CPU panel: program, registers, memory, I/O, checked against the golden model', icon: 'code', label: 'CPU', order: 62,
  run: (ed) => panels.get(ed)?.toggle(),
  active: (ed) => !!panels.get(ed)?.open,
});

// ---- properties: what makes this chip a CPU -------------------------------------------------

/** Parts that hold words (register file, RAM, data memory), for the dropdowns. */
function storageParts(ed: Editor): string[] {
  const sim = ed.sim.sim;
  const kids = sim?.design.root.children;
  return ed.doc.parts.filter((p) => !('rom' in p.ref) && (kids && sim ? !!memStoreOf(sim, kids.get(p.id)) : 'ram' in p.ref || 'chip' in p.ref)).map((p) => p.id);
}

function netOptions(ed: Editor, width: number): [string, string][] {
  const doc = ed.doc;
  const out: [string, string][] = [];
  for (const p of doc.pins) if (p.width === width) out.push([JSON.stringify({ pin: p.id }), `pin ${p.name}`]);
  // Pointers of that width (all of them before the first build).
  const nets = ed.sim.sim?.design.root.nets, built = ed.sim.built;
  const wide = (id: string) => {
    const i = built?.netOfLabel.get(id);
    return !nets || i === undefined || i < 0 || nets[i]?.length === width;
  };
  for (const n of [...new Set(doc.labels.filter((l) => wide(l.id)).map((l) => l.name))].sort()) out.push([JSON.stringify({ pointer: n }), `pointer ${n}`]);
  for (const p of doc.parts) {
    const def = ed.defOf(p);
    if (!def || 'split' in p.ref || 'merge' in p.ref || 'const' in p.ref || /^tie[01]$/.test(def.id)) continue;
    for (const q of def.ports) if (q.dir === 'out' && q.width === width) out.push([JSON.stringify({ part: p.id, port: q.name }), `${p.id}.${q.name}`]);
  }
  return out;
}

function setCpu(ed: Editor, patch: Partial<Record<keyof CpuDoc, unknown>>): void {
  ed.edit((d) => {
    const cpu: Record<string, unknown> = { ...(d.cpu ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cpu[k];
      else cpu[k] = v;
    }
    const n = { ...d };
    if (Object.keys(cpu).length) n.cpu = cpu as CpuDoc;
    else delete n.cpu;
    return n;
  });
}

function dropdown(label: string, value: string, options: [string, string][], commit: (v: string) => void, hint: string): HTMLElement {
  const sel = h('select', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))) as HTMLSelectElement;
  sel.addEventListener('change', () => commit(sel.value));
  return h('label', { class: 'sb-row', title: hint }, h('span', null, label), sel);
}

registerPropsSection({
  id: 'cpu', order: 16,
  render(ed) {
    if (ed.selCount) return null;
    const doc = ed.doc, chips = ed.ws.chips;
    const roms = [...romParts(doc).map((p) => p.id), ...nestedRoms(doc, chips)];
    const multi = detectMulti(doc, chips);
    const panel = panels.get(ed);
    if (multi) {
      return h('section', { class: 'sb-sec-props sb-cpu-props' },
        h('h3', null, 'CPU'),
        h('p', { class: 'sb-sum' }, `${multi.cores.length} cores (${multi.cores.map((c) => c.part).join(', ')}), each a placed CPU chip, ${multi.dmem ? `sharing '${multi.dmem}'` : 'with no shared memory found'}. `,
          'The CPU panel runs them against the multi-hart golden model: one program, one memory port, round-robin arbitration. Each core’s own settings are in its chip.'),
        h('div', { class: 'sb-btns' }, h('button', { class: 'btn sm', onclick: () => panel?.setOpen(true, true) }, icon('code', 14), 'CPU panel')));
    }
    if (!roms.length && !doc.cpu) return null;
    const set = doc.cpu ?? {};
    const det = detectCpu(doc, chips);
    const d = resolveCpu(doc, chips);
    const AUTO = '__auto', NONE = '';
    const autoLabel = (v: string | undefined) => `auto${v ? ` (${v})` : ' (none found)'}`;
    const partSel = (key: 'regs' | 'fregs' | 'dmem', label: string, hint: string) => {
      const opts: [string, string][] = [[AUTO, autoLabel(det?.[key])], [NONE, 'none'], ...storageParts(ed).map((id): [string, string] => [id, id])];
      const cur = set[key] === undefined ? AUTO : set[key]!;
      if (cur !== AUTO && !opts.some(([v]) => v === cur)) opts.push([cur, `${cur} (missing)`]);
      return dropdown(label, cur, opts, (v) => setCpu(ed, { [key]: v === AUTO ? undefined : v }), hint);
    };
    const netSel = (key: 'pc' | 'retire', label: string, width: number, extra: [string, string][], hint: string) => {
      const opts: [string, string][] = [[AUTO, `auto (${det?.[key] ? refText(det[key]) : key === 'retire' ? 'every cycle' : 'none found'})`], ...extra, ...netOptions(ed, width)];
      const cur = set[key] === undefined ? AUTO : JSON.stringify(set[key]);
      if (cur !== AUTO && !opts.some(([v]) => v === cur)) opts.push([cur, `${refText(set[key])} (missing)`]);
      return dropdown(label, cur, opts, (v) => setCpu(ed, { [key]: v === AUTO ? undefined : JSON.parse(v) }), hint);
    };
    const check = (label: string, on: boolean, f: (v: boolean) => void, hint: string) => {
      const box = h('input', { type: 'checkbox', checked: on }) as HTMLInputElement;
      box.addEventListener('change', () => f(box.checked));
      return h('label', { class: 'sb-check', title: hint }, box, label);
    };
    const iss = d?.iss ?? {};
    const setIss = (k: 'system' | 'mmio' | 'm' | 'f', v: boolean) => setCpu(ed, { iss: { ...iss, [k]: v } });
    return h('section', { class: 'sb-sec-props sb-cpu-props' },
      h('h3', null, 'CPU'),
      h('p', { class: 'sb-sum' }, 'With a program ROM this chip can run as a processor: the CPU panel follows the PC through the program and, given the register file, checks every retired instruction against the golden model (an instruction-set simulator). ',
        'Detected from the names the chapters’ CPUs use; override anything here.'),
      dropdown('Program', set.rom ?? AUTO, [[AUTO, autoLabel(det?.rom)], ...roms.map((p): [string, string] => [p, p])], (v) => setCpu(ed, { rom: v === AUTO ? undefined : v }), 'The ROM the CPU fetches from (byte addressed, 32-bit words), here or inside one of the chips placed here'),
      netSel('pc', 'PC', 32, [], 'The address of the instruction being fetched: a pin, a pointer or a part output'),
      partSel('regs', 'Registers', 'x1..x31: a part whose registers are named w1..w31 (the library’s register file, or a RAM)'),
      partSel('dmem', 'Data memory', 'Shown in the panel and checked after every store; its size sets the golden model’s memory'),
      partSel('fregs', 'FP registers', 'f0..f31 (RV32F)'),
      netSel('retire', 'Retire', 1, [[JSON.stringify('every'), 'every cycle']], '1 when an instruction completes at the next rising edge: the golden model steps then'),
      check('Pipeline: the PC runs ahead, compare registers only', !!d?.pipeline, (v) => setCpu(ed, { pipeline: v }), 'A pipeline fetches several instructions ahead of the one that retires; its memory is compared at the halt'),
      h('div', { class: 'sb-cpu-iss', title: 'What the golden model (the instruction-set simulator) implements' }, h('span', null, 'ISS'),
        check('system', !!iss.system, (v) => setIss('system', v), 'Zicsr, machine-mode traps and interrupts, memory-mapped I/O (the chapters’ complete machine): the console, LEDs, switches and irq pins'),
        check('MMIO', !!iss.mmio, (v) => setIss('mmio', v), 'Memory-mapped I/O only (no CSRs, traps or timer): a store to 0x8000_0000 prints on the console, 0x8000_0004 sets the LEDs, a load from 0x8000_0008 reads the switches; other addresses with bit 31 set are left to the hardware (a screen). The console, switch-bank and LED-bank (named leds) parts are compared'),
        check('M', !!iss.m, (v) => setIss('m', v), 'Multiply / divide legal in system mode'),
        check('F', !!iss.f, (v) => setIss('f', v), 'Single-precision floating point legal in system mode')),
      h('div', { class: 'sb-btns' },
        h('button', { class: 'btn sm', onclick: () => panel?.setOpen(true, true) }, icon('code', 14), 'CPU panel'),
        doc.cpu ? h('button', { class: 'btn sm ghost', title: 'Forget the settings above: detect everything', onclick: () => setCpu(ed, { rom: undefined, pc: undefined, regs: undefined, fregs: undefined, dmem: undefined, retire: undefined, pipeline: undefined, iss: undefined }) }, 'Detect again') : null));
  },
});
