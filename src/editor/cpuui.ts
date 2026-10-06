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
import { ABI, decode, disasm, FABI } from '../riscv/isa';
import { CAUSE } from '../riscv/iss';
import { bitsToF32, flagNames, RM_NAMES } from '../sim/fpref';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { h, icon } from '../ui/dom';
import type { FieldKey } from '../riscv/fields';
import { instrBreakdown } from '../widgets/instrfields';
import { instrMarks, instrUse, STAGE_UNITS, stageUse } from '../widgets/insthw';
import { PipeHistory, pipeGridRows } from '../widgets/pipegrid';
import {
  type CpuDesc, type CpuDoc, CpuMonitor, type CpuRead, cpuGaps, detectCpu, fmtWord, mismatchText, type NetRef, nestedRoms, partAt, partNode,
  pinNamed, pipelineSlots, resolveCpu, romParts, storageOf,
} from './cpu';
import { dockPane, paneShown, showPane, undockPane } from './dock';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { romImage } from './memory';
import { openProgramEditor } from './memui';
import type { ChipDoc } from './model';
import { detectMulti, type MultiDesc, MultiMonitor } from './multicpu';
import { registerPropsSection } from './props';
import type { EdgeHook, EditorSim } from './runtime';

/** Cycles Run to halt gives a program before it stops on its own. */
const RUN_CAP = 20000;
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

type Mon = CpuMonitor | MultiMonitor;
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
  private slow: ReturnType<typeof setTimeout> | null = null;
  private slowRate = 2;
  private sel: number | null = null;
  private fieldPin: FieldKey | null = null;
  private fieldHover: FieldKey | null = null;
  private syncing = false;
  private descDoc: ChipDoc | null = null;
  private descChips: unknown = null;
  private desc: CpuDesc | null = null;
  private multi: MultiDesc | null = null;
  private width = 0;
  private off: (() => void)[] = [];

  private title = h('h3', null);
  private status = h('div', { class: 'cpu-status' });
  private gaps = h('div', { class: 'sb-cpu-gaps' });
  private now = h('div', { class: 'cpu-now' });
  private listing = h('div', { class: 'cpu-listing sb-cpu-list' });
  private use = h('div', { class: 'cpu-use' });
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
      h('div', { class: 'cpu-sec sb-cpu-sechead' }, h('span', null, 'Program', h('span', { class: 'cpu-sec-hint' }, 'click a line: the parts it uses')),
        h('button', { class: 'btn ghost sm', title: 'Edit the program in the ROM (Apply resets the CPU to run it)', onclick: () => this.editProgram() }, icon('code', 13), 'Edit…')),
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
      }
      // Monitors of chips that are gone, replaced by another simulation, or of another kind now.
      for (const [k, v] of this.monitors) {
        const kind = v.chip === chip && (v.mon instanceof MultiMonitor ? !this.multi : !!this.multi);
        if (!ed.ws.open.includes(v.chip) || (v.chip === chip && k !== es) || kind) { this.drop(k, v); this.monitors.delete(k); }
      }
      let entry = this.monitors.get(es);
      if ((this.desc || this.multi) && !entry) {
        const doc = () => ed.ws.chips[chip] ?? ed.doc, ws = () => ed.ws.chips;
        const mon: Mon = this.multi ? new MultiMonitor(es, doc, ws) : new CpuMonitor(es, doc, ws);
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
        if ((this.desc?.regs || this.multi) && !this.closed.has(chip)) this.setOpen(true);
        else if (!this.desc && !this.multi) this.setOpen(false);
      }
      this.redock();
      if (this.open) this.render();
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
    const tick = () => {
      const m = this.mon;
      if (!m || !this.running) return;
      m.runToHalt(12, this.runCap);
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
    return mon instanceof MultiMonitor ? !!mon.m?.halted : !!mon.iss?.halted;
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
    const rom = this.mon instanceof MultiMonitor ? this.multi?.cores[0]?.rom : this.desc?.rom;
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

  private render(): void {
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
        h('p', { class: 'sb-sum' }, 'What counts as the PC, the registers and the memory is set in the chip’s properties (CPU), when nothing is selected.')]);
      return;
    }
    this.renderButtons(mon);
    if (mon instanceof MultiMonitor) return this.renderMulti(mon);
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
    this.runBtn.title = mon.checking ? `Clock until the program halts (the golden model says when), a mismatch, or ${RUN_CAP.toLocaleString('en')} cycles`
      : 'Needs the golden model (a register file to check, a program that builds, a Reset) to know when the program halts';
    this.stepBtn.title = multi ? 'One clock cycle: every core that is not stalled retires an instruction' : 'Clock until the next instruction retires';
    keyed(this.slowBtn, `${!!this.slow}`, () => [icon(this.slow ? 'pause' : 'play', 14), this.slow ? 'Pause' : 'Slow']);
    this.slowBtn.classList.toggle('on', !!this.slow);
    this.slowBtn.title = `Run ${multi ? 'one cycle' : 'one instruction'} at a time at the rate beside it: the current instruction and the parts it uses stay marked`;
    this.rateSel.title = multi ? 'Cycles per second' : 'Instructions per second';
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
      const what = ['registers', ...(r.f ? ['f registers'] : []), ...(r.fcsr !== null ? ['fcsr'] : []), ...(d.pipeline ? [] : ['the PC']), ...(d.dmem ? ['memory'] : []), ...(d.iss.system ? ['console', 'LEDs'] : [])];
      bits.push(h('span', { class: 'good', title: `After every retired instruction ${what.join(', ')} match the instruction-set simulator${d.pipeline && d.dmem ? ' (the memory at the halt: a pipeline’s stores run ahead)' : ''}` }, '✓ matches golden model'));
    }
    if (mon.iss?.halted) bits.push(h('span', { class: 'warn' }, 'halted'));
    const key = bits.map((b) => (typeof b === 'string' ? b : b.outerHTML)).join('');
    keyed(this.status, key, () => bits);
    const gaps = cpuGaps(d, r);
    keyed(this.gaps, gaps.join('|'), () => (gaps.length ? [h('div', null, h('b', null, 'Shown as far as it goes: '), gaps.join('; '), '.'),
      h('div', { class: 'sb-sum' }, 'Set the missing pieces in the chip’s properties (CPU), with nothing selected.')] : []));
  }

  /** The program with the current line and tags (pipeline stages, or which core is where). */
  private renderListing(mon: Mon, pc: number | null, tags: { tag: string; pc: number; title?: string }[] | null, noPc: string): void {
    const rom = mon instanceof MultiMonitor ? this.multi?.cores[0]?.rom : this.desc?.rom;
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
      this.rows = (img?.lines ?? []).map((l) => {
        const row = h('div', { class: 'ln', 'data-pc': String(l.addr), title: 'Mark the parts this instruction uses' },
          h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')), h('span', { class: 'w' }, hex8(l.word)), h('span', { class: 't' }, l.text));
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
    if (mon instanceof MultiMonitor) return;
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    this.now.replaceChildren(...(w === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, noPc)]
      : [h('span', { class: 'fmt' }, `${decode(w).fmt}-type`), h('code', null, disasm(w, pc!)), h('span', { class: 'hexw' }, `0x${hex4(pc!)}`)]));
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
    if (this.sel !== null) return { pc: this.sel, role: 'selected' };
    if (mon instanceof MultiMonitor) return null;
    const d = mon.desc;
    if (d?.pipeline) {
      const dpc = pipelineSlots(this.ed.sim, this.ed.doc, d)?.find((s) => s.stage === 'D')?.pc;
      if (dpc !== undefined) return { pc: dpc, role: 'in Decode' };
    }
    const pc = d?.pc ? mon.read()?.pc ?? null : null;
    return pc !== null && pc >= 0 ? { pc, role: 'current' } : null;
  }

  private renderFields(mon: CpuMonitor, _d: CpuDesc, _r: CpuRead | null): void {
    const f = this.running ? null : this.focusPc();
    const w = f ? mon.wordAt(f.pc) : null;
    this.fieldsSec.hidden = this.fields.hidden = !this.running && w === null;
    if (this.running) return; // frozen while running fast: a breakdown per frame is noise
    keyed(this.fields, f && w !== null ? `${f.pc}:${w}:${f.role}` : 'none', () => (f && w !== null ? [
      h('div', { class: 'cpu-fields-head' }, h('code', null, disasm(w, f.pc)), h('span', null, f.role)),
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

  /** The system CPU's I/O: what it printed, its LEDs, the switches and interrupt line it reads, its CSRs. */
  private renderIo(mon: CpuMonitor): void {
    const doc = this.ed.doc, sim = this.ed.sim.sim;
    const swPin = pinNamed(doc, 'in', 8, 'switches');
    const has = !!(pinNamed(doc, 'out', 1, 'consoleValid') || pinNamed(doc, 'out', 8, 'leds') || swPin);
    this.ioSec.hidden = this.io.hidden = !has;
    if (!has || !sim) return;
    keyed(this.con, mon.console, () => [mon.console || ' ']);
    this.con.scrollTop = this.con.scrollHeight;
    const ledv = mon.leds;
    keyed(this.leds, String(ledv), () => Array.from({ length: 8 }, (_, i) => h('span', { class: `led${ledv !== null && ledv >= 0 && (ledv >> (7 - i)) & 1 ? ' on' : ''}`, title: `LED ${7 - i}` })));
    const swv = typeof swPin?.value === 'number' ? swPin.value : 0;
    keyed(this.sw, `${swPin?.id}|${swv}`, () => Array.from({ length: 8 }, (_, i) => {
      const b = 7 - i, on = (swv >> b) & 1;
      return h('button', { class: `sw${on ? ' on' : ''}`, title: `switch ${b} (the switches pin, bit ${b})`, disabled: !swPin, onclick: () => swPin && this.ed.setPinValue(swPin.id, swv ^ (1 << b)) }, String(b));
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
    keyed(this.mem, words ? words.join(',') : 'none', () => {
      if (!words) return [h('div', { class: 'm z' }, 'not readable (no word registers found)')];
      const nz = words.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
      return [...(nz.length ? nz.slice(0, 64).map(([i, v]) => h('div', { class: 'm' },
        h('span', { class: 'n' }, `[0x${(4 * i).toString(16).padStart(2, '0')}]`), h('span', { class: 'v' }, fmtWord(v)), h('span', { class: 'd' }, v < 0 ? '?' : String(v | 0))))
        : [h('div', { class: 'm z' }, 'all zero')]), ...(nz.length > 64 ? [h('div', { class: 'm z' }, `… ${nz.length - 64} more`)] : [])];
    });
  }

  private renderTrace(mon: Mon): void {
    const show = mon instanceof MultiMonitor || !!mon.desc?.regs;
    this.traceSec.hidden = this.trace.hidden = !show;
    if (mon.seq === this.seqSeen) return;
    this.seqSeen = mon.seq;
    this.trace.replaceChildren(...mon.log.slice(-40).map((e) => h('div', { class: 'tr', title: 'Select this instruction in the listing', onclick: () => this.select(e.pc) },
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
        h('code', null, w === null ? 'PC unknown' : `${hex4(c.pc!)}  ${disasm(w, c.pc!)}`),
        mon.lastStall[i] ? h('span', { class: 'warn', title: 'Lost the memory port to the other core at the last edge' }, 'stalled') : null);
    }))]);
    this.renderListing(mon, null, cores.flatMap((c, i) => (c.pc !== null && c.pc >= 0 ? [{ tag: `C${i}`, pc: c.pc, title: `core ${i} (${d.cores[i].part}) fetches this` }] : [])), '');
    // the selected line's breakdown only (each core runs its own instruction)
    const w = this.sel !== null ? mon.wordAt(this.sel) : null;
    this.fieldsSec.hidden = this.fields.hidden = w === null;
    keyed(this.fields, w === null ? 'none' : `${this.sel}:${w}`, () => (w === null ? [] : [
      h('div', { class: 'cpu-fields-head' }, h('code', null, disasm(w, this.sel!)), h('span', null, 'selected')),
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

  // ---- marks on the canvas ---------------------------------------------------------------

  private marked: string[] = [];
  private wireMarks = new Map<string, string>();
  private useKey = '';
  private wiresOfNet: { built: unknown; map: Map<number, string[]> } = { built: null, map: new Map() };

  /**
   * What to mark: the selected instruction (or, in slow mode, the one running) — the parts it uses
   * and the wires that carry its fields (the field pointed at in the breakdown: only those). In a
   * pipeline, the field wires carry the instruction in D, and slow mode marks each stage's share.
   */
  private computeMarks(): void {
    const mon = this.mon, ed = this.ed;
    let units: string[] = [];
    let word: number | null = null;
    let path = '';
    const f = this.sel !== null ? { pc: this.sel, role: 'selected' } : this.slow ? this.focusPc() : null;
    const focus = this.fieldHover ?? this.fieldPin;
    if (mon && f && !(mon instanceof MultiMonitor) && this.sel === null && mon.desc?.pipeline) {
      // slow mode in a pipeline: every stage's part of the work
      const slots = pipelineSlots(ed.sim, ed.doc, mon.desc) ?? [];
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
    const inD = !(mon instanceof CpuMonitor && mon.desc?.pipeline) || (f && this.focusPcIsD(f.pc));
    const def = (ed.sim.built ?? ed.compiled)?.def;
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
      keyed(this.use, `${this.sel}|${word}|${this.marked.length}`, () => [h('code', null, disasm(word!, this.sel!)),
        h('div', null, this.marked.length ? path : 'No parts named like the chapters’ CPU (rf, alu, imm, …) to mark here.')]);
    } else keyed(this.use, '', () => []);
  }

  private focusPcIsD(pc: number): boolean {
    const mon = this.mon;
    if (!(mon instanceof CpuMonitor) || !mon.desc) return false;
    return !!pipelineSlots(this.ed.sim, this.ed.doc, mon.desc)?.some((s) => s.stage === 'D' && s.pc === pc);
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
  return ed.doc.parts.filter((p) => !('rom' in p.ref) && (kids ? !!storageOf(kids.get(p.id)) : 'ram' in p.ref || 'chip' in p.ref)).map((p) => p.id);
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
    const setIss = (k: 'system' | 'm' | 'f', v: boolean) => setCpu(ed, { iss: { ...iss, [k]: v } });
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
        check('M', !!iss.m, (v) => setIss('m', v), 'Multiply / divide legal in system mode'),
        check('F', !!iss.f, (v) => setIss('f', v), 'Single-precision floating point legal in system mode')),
      h('div', { class: 'sb-btns' },
        h('button', { class: 'btn sm', onclick: () => panel?.setOpen(true, true) }, icon('code', 14), 'CPU panel'),
        doc.cpu ? h('button', { class: 'btn sm ghost', title: 'Forget the settings above: detect everything', onclick: () => setCpu(ed, { rom: undefined, pc: undefined, regs: undefined, fregs: undefined, dmem: undefined, retire: undefined, pipeline: undefined, iss: undefined }) }, 'Detect again') : null));
  },
});
