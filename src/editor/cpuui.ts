// The CPU panel of the sandbox: for a chip that is a processor (a CPU opened with "Open in
// Sandbox", or one the learner built), the chapters' companion panel in a drawer over the
// canvas: status with the golden-model check, the program with the current instruction (a click
// marks the parts it uses), registers, floating-point registers, data memory and the last
// retired instructions; Run to halt, Step instruction, Reset. A properties section sets or
// overrides what detection found (cpu.ts). Everything plugs in through the editor's registries.

import '../styles/sbcpu.css';
import { ABI, decode, disasm, FABI } from '../riscv/isa';
import { bitsToF32 } from '../sim/fpref';
import { h, icon } from '../ui/dom';
import { instrUse } from '../widgets/insthw';
import {
  type CpuDesc, type CpuDoc, CpuMonitor, type CpuRead, cpuGaps, detectCpu, fmtWord, mismatchText, type NetRef, pipelineSlots,
  resolveCpu, romParts, storageOf,
} from './cpu';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { romImage } from './memory';
import { openProgramEditor } from './memui';
import type { ChipDoc } from './model';
import { registerPropsSection } from './props';
import type { EditorSim } from './runtime';

/** Cycles Run to halt gives a program before it stops on its own. */
const RUN_CAP = 20000;

const hex8 = (v: number) => (v < 0 ? 'xxxxxxxx' : (v >>> 0).toString(16).padStart(8, '0'));
/** As the chapters' CPU panel writes a register: 0x0000002A. */
const hexR = (v: number) => (v < 0 ? '0x????????' : `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);
const refText = (r: NetRef | 'every' | undefined): string =>
  !r ? '—' : r === 'every' ? 'every cycle' : 'pin' in r ? `pin ${r.pin}` : 'pointer' in r ? `pointer ${r.pointer}` : 'wire' in r ? `wire ${r.wire}` : `${r.part}.${r.port}`;

const panels = new WeakMap<Editor, CpuPanel>();

class CpuPanel {
  readonly el: HTMLElement;
  open = false;
  private monitors = new Map<EditorSim, { chip: string; mon: CpuMonitor }>();
  /** Chips whose panel the user closed (not reopened automatically this session). */
  private closed = new Set<string>();
  private shownFor = '';
  private running = 0;
  private runCap = 0;
  private sel: number | null = null;
  private syncing = false;
  private descDoc: ChipDoc | null = null;
  private desc: CpuDesc | null = null;
  private off: (() => void)[] = [];

  private title = h('h3', null);
  private status = h('div', { class: 'cpu-status' });
  private gaps = h('div', { class: 'sb-cpu-gaps' });
  private now = h('div', { class: 'cpu-now' });
  private listing = h('div', { class: 'cpu-listing sb-cpu-list' });
  private use = h('div', { class: 'cpu-use' });
  private regs = h('div', { class: 'cpu-regs' });
  private fregsSec = h('div', { class: 'cpu-sec' }, 'Floating-point registers (non-zero)');
  private fregs = h('div', { class: 'cpu-mem' });
  private memSec = h('div', { class: 'cpu-sec' });
  private mem = h('div', { class: 'cpu-mem' });
  private trace = h('div', { class: 'cpu-trace sb-cpu-trace' });
  private traceSec = h('div', { class: 'cpu-sec' }, 'Retired', h('span', { class: 'cpu-sec-hint' }, 'by the golden model, newest last'));
  private runBtn: HTMLButtonElement;
  private stepBtn: HTMLButtonElement;
  private body: HTMLElement;
  private none: HTMLElement;

  // what is drawn, to redraw only what changed
  private listKey = '';
  private rows: HTMLElement[] = [];
  private rowOf = new Map<number, HTMLElement>();
  private curKey = '';
  private lastX: number[] | null = null;
  private changed = new Set<number>();
  private seqSeen = -1;
  private memKey = '';
  private fKey = '';
  private useKey = '';

  constructor(private ed: Editor) {
    // Registered first: opening the panel below redraws the toolbar, whose CPU toggle looks it up.
    panels.set(ed, this);
    this.runBtn = h('button', { class: 'btn sm primary', title: 'Clock until the program halts (the golden model says when), a mismatch, or 20 000 cycles', onclick: () => this.toggleRun() }) as HTMLButtonElement;
    this.stepBtn = h('button', { class: 'btn sm', title: 'Clock until the next instruction retires', onclick: () => this.stepInstr() }, icon('step', 14), 'Step instr') as HTMLButtonElement;
    const reset = h('button', { class: 'btn sm ghost', title: 'Power-cycle the circuit and restart the golden model', onclick: () => this.reset() }, icon('reset', 14), 'Reset');
    this.none = h('div', { class: 'sb-cpu-none' });
    this.body = h('div', { class: 'sb-cpu-body' },
      h('div', { class: 'sb-btns sb-cpu-btns' }, this.runBtn, this.stepBtn, reset),
      this.status, this.gaps, this.now,
      h('div', { class: 'cpu-sec sb-cpu-sechead' }, h('span', null, 'Program', h('span', { class: 'cpu-sec-hint' }, 'click a line: the parts it uses')),
        h('button', { class: 'btn ghost sm', title: 'Edit the program in the ROM (Apply resets the CPU to run it)', onclick: () => { const d = this.mon?.desc; if (d) openProgramEditor(ed, d.rom); } }, icon('code', 13), 'Edit…')),
      this.listing, this.use,
      h('div', { class: 'cpu-sec' }, 'Registers'), this.regs,
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
    this.off.forEach((f) => f());
    for (const { mon } of this.monitors.values()) mon.destroy();
    this.monitors.clear();
    this.mark([]);
    this.el.remove();
  }

  /** The monitor of the simulation on screen (made on demand for a chip with a program ROM). */
  get mon(): CpuMonitor | null {
    return this.monitors.get(this.ed.sim)?.mon ?? null;
  }

  setOpen(on: boolean, byUser = false): void {
    if (on === this.open) return;
    this.open = on;
    if (byUser && !on) this.closed.add(this.ed.chipId);
    if (byUser && on) this.closed.delete(this.ed.chipId);
    if (on) {
      this.ed.slots.overlay.append(this.el);
      this.listKey = this.curKey = this.memKey = this.fKey = '';
      this.seqSeen = -1;
      this.render();
    } else {
      this.el.remove();
      this.stopRun();
      this.sel = null;
      this.mark([]);
    }
    this.ed.renderActions();
  }

  private sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const ed = this.ed, es = ed.sim, chip = ed.chipId;
      // Monitors of chips that are gone (or replaced by another simulation of the same chip).
      for (const [k, v] of this.monitors) {
        if (!ed.ws.open.includes(v.chip) || (v.chip === chip && k !== es)) { v.mon.destroy(); this.monitors.delete(k); }
      }
      if (this.descDoc !== ed.doc) {
        this.descDoc = ed.doc;
        this.desc = resolveCpu(ed.doc);
      }
      const desc = this.desc;
      let entry = this.monitors.get(es);
      if (desc && !entry) {
        entry = { chip, mon: new CpuMonitor(es, () => ed.ws.chips[chip] ?? ed.doc) };
        this.monitors.set(es, entry);
      }
      if (entry && entry.mon.sync() && es.cycles > 0) {
        // A new program: run it from the start (the old one's state means nothing to it).
        es.reset();
        entry.mon.sync();
        ed.toast('Program changed: the CPU was reset to run it from the start');
      }
      if (chip !== this.shownFor) {
        this.shownFor = chip;
        this.sel = null;
        this.stopRun();
        // A complete CPU opens its panel by itself (unless closed there); a chip without a program
        // ROM closes it; a bare datapath (a ROM and a PC) leaves it as it was.
        if (desc?.regs && !this.closed.has(chip)) this.setOpen(true);
        else if (!desc) this.setOpen(false);
      }
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

  private stepInstr(): void {
    const mon = this.mon;
    if (!mon) return;
    this.stopRun();
    this.ed.sim.pause();
    if (mon.iss?.halted) return this.ed.toast('The program has halted: Reset to run it again');
    mon.stepInstr();
  }

  private reset(): void {
    this.stopRun();
    this.ed.sim.pause();
    this.ed.sim.reset();
  }

  // ---- drawing ---------------------------------------------------------------------------

  private render(): void {
    if (!this.open) return;
    const ed = this.ed, mon = this.mon, doc = ed.doc;
    this.title.textContent = `CPU · ${doc.name}`;
    const d = mon?.desc ?? null;
    this.none.hidden = !!d;
    this.body.hidden = !d;
    if (!d || !mon) {
      this.none.replaceChildren(
        h('p', null, h('b', null, 'No program ROM in this chip.')),
        h('p', null, 'A CPU here is a chip with a ', h('b', null, 'Program ROM (RV32)'), ' (Memory palette: byte addressed, 32-bit words). Add one, or open a CPU from the chapters with ',
          h('i', null, 'Open in Sandbox'), '. The panel then follows its PC; with a register file it checks every instruction against the golden model.'),
        h('p', { class: 'sb-sum' }, 'What counts as the PC, the registers and the memory is set in the chip’s properties (CPU), when nothing is selected.'));
      return;
    }
    const r = mon.read();
    this.renderStatus(mon, d, r);
    this.renderListing(mon, d, r, doc);
    this.renderRegs(r);
    this.renderMem(d, r);
    this.renderTrace(mon);
  }

  private renderStatus(mon: CpuMonitor, d: CpuDesc, r: CpuRead | null): void {
    const es = this.ed.sim;
    const iss = mon.iss;
    this.runBtn.replaceChildren(icon(this.running ? 'pause' : 'play', 14), this.running ? 'Stop' : 'Run to halt');
    this.runBtn.disabled = !mon.checking;
    this.runBtn.title = mon.checking ? 'Clock until the program halts (the golden model says when), a mismatch, or 20 000 cycles'
      : 'Needs the golden model (a register file to check, a program that builds, a Reset) to know when the program halts';
    const bits: (HTMLElement | string)[] = [h('span', null, `cycle ${es.cycles}`)];
    if (d.retire || d.pipeline || mon.retired !== es.cycles) bits.push(h('span', null, `retired ${mon.retired}${mon.retired ? ` · CPI ${(es.cycles / mon.retired).toFixed(2)}` : ''}`));
    else if (r?.pc !== null && r?.pc !== undefined) bits.push(h('span', null, `PC ${r.pc < 0 ? 'x' : `0x${(r.pc >>> 0).toString(16).padStart(4, '0')}`}`));
    if (mon.mismatch) bits.push(h('span', { class: 'bad', title: 'The first difference between the hardware and the instruction-set simulator; the check stops there' }, `✗ ${mismatchText(mon.mismatch)}`));
    else if (mon.problem) bits.push(h('span', { class: 'warn' }, `no golden model: ${mon.problem}`));
    else if (!d.regs || !r?.x) bits.push(h('span', { class: 'warn', title: 'Set the register file in the chip’s properties (CPU)' }, 'not checked'));
    else if (!mon.synced) bits.push(h('span', { class: 'warn', title: 'The golden model starts with the hardware at cycle 0' }, 'golden model joins at the next Reset'));
    else bits.push(h('span', { class: 'good', title: `After every retired instruction the registers${d.pipeline ? '' : ' and the PC'} match the instruction-set simulator` }, '✓ matches golden model'));
    if (iss?.halted) bits.push(h('span', { class: 'warn' }, 'halted'));
    const key = bits.map((b) => (typeof b === 'string' ? b : b.outerHTML)).join('');
    if (this.status.dataset.key !== key) {
      this.status.dataset.key = key;
      this.status.replaceChildren(...bits);
    }
    const gaps = cpuGaps(d, r);
    const gk = gaps.join('|');
    if (this.gaps.dataset.key !== gk) {
      this.gaps.dataset.key = gk;
      this.gaps.replaceChildren(...(gaps.length ? [h('div', null, h('b', null, 'Shown as far as it goes: '), gaps.join('; '), '.'),
        h('div', { class: 'sb-sum' }, 'Set the missing pieces in the chip’s properties (CPU), with nothing selected.')] : []));
    }
  }

  private renderListing(mon: CpuMonitor, d: CpuDesc, r: CpuRead | null, doc: ChipDoc): void {
    const part = doc.parts.find((p) => p.id === d.rom);
    const rom = part && 'rom' in part.ref ? part.ref.rom : null;
    const lk = rom ? `${d.rom}|${rom.src}|${rom.k}|${rom.lang}` : '';
    if (lk !== this.listKey) {
      // A new program: the selected line no longer means the same instruction.
      if (this.listKey && this.sel !== null) {
        this.sel = null;
        this.use.replaceChildren();
        this.mark([]);
      }
      this.listKey = lk;
      this.curKey = '';
      const img = rom ? romImage(rom) : null;
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
    const slots = pipelineSlots(this.ed.sim, doc, d);
    const pc = r?.pc ?? null;
    const ck = `${pc}|${this.sel}|${slots?.map((s) => `${s.stage}${s.pc}`).join(',')}`;
    if (ck === this.curKey) return;
    this.curKey = ck;
    for (const row of this.rows) {
      const a = Number(row.dataset.pc);
      row.classList.toggle('cur', a === pc);
      row.classList.toggle('sel', a === this.sel);
      row.querySelectorAll('.stg').forEach((e) => e.remove());
      for (const s of slots ?? []) if (s.pc === a) row.append(h('span', { class: 'stg' }, s.stage));
    }
    const cur = pc !== null && pc >= 0 ? this.rowOf.get(pc) : undefined;
    if (cur && this.sel === null) {
      const top = cur.offsetTop - this.listing.offsetTop, bottom = top + cur.offsetHeight;
      if (top < this.listing.scrollTop || bottom > this.listing.scrollTop + this.listing.clientHeight) this.listing.scrollTop = Math.max(0, top - this.listing.clientHeight / 3);
    }
    const w = pc !== null && pc >= 0 ? mon.wordAt(pc) : null;
    this.now.replaceChildren(...(w === null
      ? [h('span', { class: 'fmt' }, 'PC'), h('code', null, pc === null ? 'not found' : 'unknown (X)')]
      : [h('span', { class: 'fmt' }, `${decode(w).fmt}-type`), h('code', null, disasm(w, pc!)), h('span', { class: 'hexw' }, `0x${(pc! >>> 0).toString(16).padStart(4, '0')}`)]));
  }

  /** A listing line clicked: mark the parts its instruction uses (the site's CPUs' names), or clear. */
  private select(pc: number): void {
    this.sel = this.sel === pc ? null : pc;
    const w = this.sel === null ? null : this.mon?.wordAt(this.sel) ?? null;
    if (w === null) {
      this.use.replaceChildren();
      this.mark([]);
    } else {
      const u = instrUse(w);
      const have = new Set(this.ed.doc.parts.map((p) => p.id));
      const units = u.units.filter((n) => have.has(n));
      this.use.replaceChildren(h('code', null, disasm(w, this.sel!)), h('div', null, units.length ? u.path : 'No parts named like the chapters’ CPU (rf, alu, imm, …) to mark here.'));
      this.mark(units);
    }
    this.curKey = '';
    this.render();
  }

  private marked: string[] = [];
  /** Halo the parts an instruction uses (kept across redraws until cleared). */
  mark(ids: string[]): void {
    this.marked = ids;
    this.useKey = '';
    this.applyMarks();
  }

  applyMarks(): void {
    const svg = this.ed.view.svg;
    const key = `${this.ed.chipId}|${this.marked.join(',')}|${svg.querySelectorAll('.ed-cpu-use').length}`;
    if (key === this.useKey) return;
    svg.querySelectorAll('.ed-cpu-use').forEach((e) => e.classList.remove('ed-cpu-use'));
    for (const id of this.marked) svg.querySelector(`[data-part="${CSS.escape(id)}"]`)?.classList.add('ed-cpu-use');
    this.useKey = `${this.ed.chipId}|${this.marked.join(',')}|${svg.querySelectorAll('.ed-cpu-use').length}`;
  }

  private renderRegs(r: CpuRead | null): void {
    const mon = this.mon!;
    if (mon.seq !== this.seqSeen || !this.lastX) {
      // Changed by the last retirement (or since the last look, without a golden model).
      if (r?.x && this.lastX) {
        this.changed = new Set();
        r.x.forEach((v, i) => { if (v !== this.lastX![i]) this.changed.add(i); });
      }
      this.lastX = r?.x ?? null;
    }
    const x = r?.x;
    if (!x) {
      if (this.regs.dataset.key !== 'none') {
        this.regs.dataset.key = 'none';
        this.regs.replaceChildren(h('div', { class: 'sb-sum sb-cpu-span' }, 'No register file found.'));
      }
    } else {
      const key = `${x.join(',')}|${[...this.changed].join(',')}`;
      if (this.regs.dataset.key !== key) {
        this.regs.dataset.key = key;
        this.regs.replaceChildren(...x.map((v, i) => h('div', { class: `r${this.changed.has(i) && this.ed.sim.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `x${i} = ${v < 0 ? 'unknown' : v | 0}` },
          h('span', { class: 'n' }, ABI[i]), h('span', { class: 'v' }, hexR(v)))));
      }
    }
    const f = r?.f;
    this.fregsSec.hidden = this.fregs.hidden = !f;
    if (f) {
      const key = f.join(',');
      if (key !== this.fKey) {
        this.fKey = key;
        const nz = f.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
        this.fregs.replaceChildren(...(nz.length ? nz.map(([i, v]) => h('div', { class: 'm' },
          h('span', { class: 'n' }, FABI[i]), h('span', { class: 'v' }, hexR(v)), h('span', { class: 'd' }, v < 0 ? '?' : String(+bitsToF32(v).toPrecision(8)))))
          : [h('div', { class: 'm z' }, 'all +0.0')]));
      }
    }
  }

  private renderMem(d: CpuDesc, r: CpuRead | null): void {
    const words = r?.dmem;
    this.memSec.hidden = this.mem.hidden = !d.dmem;
    if (!d.dmem) return;
    this.memSec.replaceChildren('Data memory', h('span', { class: 'cpu-sec-hint' }, `${d.dmem}${words ? ` · ${words.length} words, non-zero shown` : ''}`));
    const key = words ? words.join(',') : 'none';
    if (key === this.memKey) return;
    this.memKey = key;
    if (!words) return void this.mem.replaceChildren(h('div', { class: 'm z' }, 'not readable (no word registers found)'));
    const nz = words.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
    this.mem.replaceChildren(...(nz.length ? nz.slice(0, 64).map(([i, v]) => h('div', { class: 'm' },
      h('span', { class: 'n' }, `[0x${(4 * i).toString(16).padStart(2, '0')}]`), h('span', { class: 'v' }, fmtWord(v)), h('span', { class: 'd' }, v < 0 ? '?' : String(v | 0))))
      : [h('div', { class: 'm z' }, 'all zero')]), ...(nz.length > 64 ? [h('div', { class: 'm z' }, `… ${nz.length - 64} more`)] : []));
  }

  private renderTrace(mon: CpuMonitor): void {
    this.traceSec.hidden = this.trace.hidden = !mon.desc?.regs;
    if (mon.seq === this.seqSeen) return;
    this.seqSeen = mon.seq;
    this.trace.replaceChildren(...mon.log.slice(-40).map((e) => h('div', { class: 'tr', title: 'Select this instruction in the listing', onclick: () => this.select(e.pc) },
      h('span', { class: 'c' }, String(e.cycle)), h('span', { class: 't' }, e.text), h('span', { class: 'eff' }, e.effect))));
    this.trace.lastElementChild?.classList.add('new');
    this.trace.scrollTop = this.trace.scrollHeight;
  }
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
  id: 'cpu', title: 'CPU panel: program, registers, memory, checked against the golden model', icon: 'code', label: 'CPU', order: 62,
  run: (ed) => { const p = panels.get(ed); p?.setOpen(!p.open, true); },
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
  for (const n of [...new Set(doc.labels.map((l) => l.name))].sort()) out.push([JSON.stringify({ pointer: n }), `pointer ${n}`]);
  for (const p of doc.parts) {
    const def = ed.defOf(p);
    if (!def || 'split' in p.ref || 'merge' in p.ref || 'const' in p.ref) continue;
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
    const doc = ed.doc;
    const roms = romParts(doc);
    if (!roms.length && !doc.cpu) return null;
    const set = doc.cpu ?? {};
    const det = detectCpu(doc);
    const d = resolveCpu(doc);
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
    const panel = panels.get(ed);
    return h('section', { class: 'sb-sec-props sb-cpu-props' },
      h('h3', null, 'CPU'),
      h('p', { class: 'sb-sum' }, 'With a program ROM this chip can run as a processor: the CPU panel follows the PC through the program and, given the register file, checks every retired instruction against the golden model (an instruction-set simulator). ',
        'Detected from the names the chapters’ CPUs use; override anything here.'),
      dropdown('Program', set.rom ?? AUTO, [[AUTO, autoLabel(det?.rom)], ...roms.map((p): [string, string] => [p.id, p.id])], (v) => setCpu(ed, { rom: v === AUTO ? undefined : v }), 'The ROM the CPU fetches from (byte addressed, 32-bit words)'),
      netSel('pc', 'PC', 32, [], 'The address of the instruction being fetched: a pin, a pointer or a part output'),
      partSel('regs', 'Registers', 'x1..x31: a part whose registers are named w1..w31 (the library’s register file, or a RAM)'),
      partSel('dmem', 'Data memory', 'Shown in the panel; its size sets the golden model’s memory'),
      partSel('fregs', 'FP registers', 'f0..f31 (RV32F)'),
      netSel('retire', 'Retire', 1, [[JSON.stringify('every'), 'every cycle']], '1 when an instruction completes at the next rising edge: the golden model steps then'),
      check('Pipeline: the PC runs ahead, compare registers only', !!d?.pipeline, (v) => setCpu(ed, { pipeline: v }), 'A pipeline fetches several instructions ahead of the one that retires'),
      h('div', { class: 'sb-cpu-iss', title: 'What the golden model (the instruction-set simulator) implements' }, h('span', null, 'ISS'),
        check('system', !!iss.system, (v) => setIss('system', v), 'Zicsr, machine-mode traps and interrupts, memory-mapped I/O (the chapters’ complete machine)'),
        check('M', !!iss.m, (v) => setIss('m', v), 'Multiply / divide legal in system mode'),
        check('F', !!iss.f, (v) => setIss('f', v), 'Single-precision floating point legal in system mode')),
      h('div', { class: 'sb-btns' },
        h('button', { class: 'btn sm', onclick: () => panel?.setOpen(true, true) }, icon('code', 14), 'CPU panel'),
        doc.cpu ? h('button', { class: 'btn sm ghost', title: 'Forget the settings above: detect everything', onclick: () => setCpu(ed, { rom: undefined, pc: undefined, regs: undefined, fregs: undefined, dmem: undefined, retire: undefined, pipeline: undefined, iss: undefined }) }, 'Detect again') : null));
  },
});
