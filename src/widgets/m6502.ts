// Appendix A's running 6502: the transistor-level chip on the stage (NmosSim) with a memory on its
// pins, and a panel that runs it (cycle, instruction, run), lists the program, shows the registers,
// the bus cycle by cycle (as a logic analyzer on the pins would) and the output port, and checks
// every bus cycle against the ISS.

import { m6502 } from '../lib/m6502/chip';
import { assemble, toImage, type AsmResult } from '../m6502/asm';
import { Chip6502 } from '../m6502/chip';
import { disasmAt } from '../m6502/isa';
import { Cpu6502, type Cpu6502State, Ram64 } from '../m6502/iss';
import { IO6502, PROGRAMS } from '../m6502/programs';
import type { NmosSim } from '../sim/nmossim';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { codeEditor } from './codeedit';

export interface M6502SceneOptions {
  /** Assembler source (default: the hello program). */
  source?: string;
  /** Open this deep on load, highlight these blocks. */
  path?: string[];
  highlight?: string[];
}

const hex = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

export function m6502Scene(opts: M6502SceneOptions = {}): Scene {
  return {
    root: m6502(),
    engine: 'nmos',
    inputs: { phi0: 1, resb: 1, irqb: 1, nmib: 1 },
    hiddenInputs: ['phi0', 'resb', 'irqb', 'nmib', 'd'],
    autoClock: false,
    path: opts.path,
    highlight: opts.highlight,
    panels: [m6502Panel(opts)],
  };
}

interface BusRow { cycle: number; t: number; addr: number; data: number; write: boolean; sync: number }

/** Run budget per animation frame (ms of simulation). */
const FRAME_MS = 12;
const TRACE_ROWS = 12;

function m6502Panel(opts: M6502SceneOptions): ScenePanel {
  return (stage: Stage): Widget => {
    const source = opts.source ?? PROGRAMS[0].source;
    const asm: AsmResult = assemble(source);
    const image = toImage(asm);
    const mem = new Ram64();
    const issMem = new Ram64();
    const chip = new Chip6502(mem, stage.sim as NmosSim);
    let iss = new Cpu6502(issMem);
    let mismatch: string | null = null;
    let cycles = 0, instrs = 0;
    let out = '';
    let irqHeld = false, nmiLeft = 0;
    const trace: BusRow[] = [];
    let curPc = -1;
    let running: number | null = null;

    /** One clock cycle on the chip and the ISS, compared; the I/O devices act on the bus. */
    const cycle = () => {
      chip.irq = iss.irq = irqHeld;
      const nmi = nmiLeft > 0;
      chip.nmi = iss.nmi = nmi;
      if (nmiLeft > 0) nmiLeft--;
      const t = chip.tstate();
      chip.cycle();
      iss.tick();
      cycles++;
      stage.cycles++;
      if (chip.sync) { instrs++; curPc = chip.addr; }
      trace.push({ cycle: cycles, t, addr: chip.addr, data: chip.data, write: chip.write, sync: chip.sync });
      if (trace.length > TRACE_ROWS) trace.shift();
      if (chip.write) lastWrite = chip.addr;
      if (chip.write && chip.addr === IO6502.OUT) out += String.fromCharCode(chip.data);
      if (chip.write && chip.addr === IO6502.IRQ_ACK) irqHeld = false;
      if (!mismatch && (iss.busAddr !== chip.addr || iss.busData !== chip.data || iss.busWrite !== chip.write || iss.busSync !== chip.sync))
        mismatch = `cycle ${cycles}: the chip ${chip.write ? 'wrote' : 'read'} $${hex(chip.data)} at $${hex(chip.addr, 4)}, the model ${iss.busWrite ? 'wrote' : 'read'} $${hex(iss.busData)} at $${hex(iss.busAddr, 4)}`;
    };
    /** A program is done when it jumps to itself (JMP *). */
    const halted = () => {
      if (curPc < 0) return false;
      return mem.mem[curPc] === 0x4c && mem.mem[curPc + 1] === (curPc & 0xff) && mem.mem[curPc + 2] === curPc >> 8;
    };
    /** Power on, RES held low for two cycles, the model given the chip's (arbitrary) registers, the reset sequence run. */
    const powerUp = () => {
      mem.mem.set(image);
      issMem.mem.set(image);
      out = ''; cycles = 0; instrs = 0; mismatch = null; lastWrite = -1; trace.length = 0; curPc = -1; irqHeld = false; nmiLeft = 0;
      chip.res = true;
      chip.cycle(); chip.cycle();
      chip.res = false;
      iss = new Cpu6502(issMem);
      const r = chip.regs();
      Object.assign(iss, { pc: r.pc, s: r.s, a: r.a, x: r.x, y: r.y, p: r.p & 0xef });
      iss.reset();
      for (let i = 0; i < 7; i++) cycle();
    };

    const stopRun = () => {
      if (running) cancelAnimationFrame(running);
      running = null;
      runBtn.textContent = 'Run';
    };
    const act = (f: () => void) => () => {
      stopRun();
      stage.checkpoint();
      f();
      stage.refresh();
    };
    const runBtn = h('button', { class: 'btn sm primary', title: 'Run until the program jumps to itself (or Stop)' }, 'Run');
    runBtn.addEventListener('click', () => {
      if (running) return stopRun();
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      const tick = () => {
        const t0 = performance.now();
        while (performance.now() - t0 < FRAME_MS && !halted() && !mismatch) cycle();
        stage.refresh();
        if (halted() || mismatch) return stopRun();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });
    const stepBtn = h('button', { class: 'btn sm', title: 'One clock cycle (φ1 and φ2)', onclick: act(cycle) }, 'Cycle');
    const instrBtn = h('button', {
      class: 'btn sm', title: 'Run to the next opcode fetch',
      onclick: act(() => { let n = 0; do cycle(); while (!chip.sync && ++n < 16); }),
    }, 'Instr');
    const resetBtn = h('button', { class: 'btn sm', title: 'Pull RES low, reload the program, run the reset sequence', onclick: act(powerUp) }, 'Reset');
    const irqBtn = h('button', { class: 'btn sm', title: 'Hold IRQ low until the program acknowledges it (a write to $F002)' }, 'IRQ');
    irqBtn.addEventListener('click', act(() => { irqHeld = true; }));
    const nmiBtn = h('button', { class: 'btn sm', title: 'Pulse NMI low for two cycles (an edge)' }, 'NMI');
    nmiBtn.addEventListener('click', act(() => { nmiLeft = 2; }));

    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const p of PROGRAMS) sel.append(h('option', { value: p.name }, p.title));
    sel.append(h('option', { value: '__custom' }, 'My program'));
    sel.value = PROGRAMS.find((p) => p.source === source)?.name ?? '__custom';
    sel.addEventListener('change', () => {
      const p = PROGRAMS.find((q) => q.name === sel.value);
      if (p) stage.load(m6502Scene({ ...opts, source: p.source }));
    });
    const errBox = h('div', { class: 'asm-errors' });
    const editor = codeEditor({ value: source, lang: 'm6502asm', rows: 14, onChange: () => { errBox.textContent = ''; } });
    editor.el.classList.add('asm-editor');
    const editWrap = h('div', { class: 'cpu-edit', style: 'display:none' }, editor.el, errBox,
      h('div', { style: 'display:flex;gap:6px;margin-top:6px' },
        h('button', {
          class: 'btn sm primary', onclick: () => {
            const r = assemble(editor.value);
            editor.setDiagnostics(r.errors);
            if (r.errors.length) { errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n'); return; }
            stage.load(m6502Scene({ ...opts, source: editor.value }));
          },
        }, 'Assemble & load'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = 'none'; } }, 'Close')));
    const editBtn = h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = editWrap.style.display === 'none' ? 'block' : 'none'; } }, 'Edit');

    const status = h('div', { class: 'cpu-status' });
    const listing = h('div', { class: 'cpu-listing m65-listing' });
    const regs = h('div', { class: 'cpu-regs m65-regs' });
    const flags = h('div', { class: 'm65-flags' });
    const pins = h('table', { class: 'm65-trace' });
    const console_ = h('div', { class: 'm65-out', 'aria-label': 'output port' });
    // a page of memory (zero page, the stack, the program, the data the samples write at $0300)
    let page = 0, lastWrite = -1;
    const memGrid = h('div', { class: 'm65-mem' });
    const pages = h('span', { class: 'm65-pages' }, ...[0, 1, 2, 3].map((p) => h('button', {
      class: 'btn sm', 'data-page': String(p), onclick: () => { page = p; update(); },
    }, `${hex(p)}`)));
    const body = h('div', { class: 'cpu-body' },
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, editBtn),
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, resetBtn, stepBtn, instrBtn, runBtn, irqBtn, nmiBtn),
      editWrap, status,
      h('div', { class: 'cpu-sec' }, 'Program'), listing,
      h('div', { class: 'cpu-sec' }, 'Registers'), regs, flags,
      h('div', { class: 'cpu-sec' }, 'Pins', h('span', { class: 'cpu-sec-hint' }, 'a row per cycle, newest last')), pins,
      h('div', { class: 'cpu-sec' }, `Output port ${hex(IO6502.OUT, 4)}`), console_,
      h('div', { class: 'cpu-sec' }, 'Memory, page ', pages), memGrid);
    const el = h('div', { class: 'mem-panel cpu-panel m65-panel', 'data-dock': 'right', 'data-fold': 'narrow' },
      h('h4', null, 'MOS 6502, transistor level', h('span', { class: 'fold-hint' })), body);

    stage.historyHooks.add({
      save: () => ({ iss: iss.save(), mem: mem.mem.slice(), issMem: issMem.mem.slice(), out, cycles, instrs, mismatch, trace: trace.slice(), curPc, irqHeld, nmiLeft }),
      restore: (v) => {
        const s = v as { iss: Cpu6502State; mem: Uint8Array; issMem: Uint8Array; out: string; cycles: number; instrs: number; mismatch: string | null; trace: BusRow[]; curPc: number; irqHeld: boolean; nmiLeft: number };
        stopRun();
        iss.restore(s.iss);
        mem.mem.set(s.mem); issMem.mem.set(s.issMem);
        ({ out, cycles, instrs, mismatch, curPc, irqHeld, nmiLeft } = s);
        trace.splice(0, trace.length, ...s.trace);
      },
    });
    stage.resetHooks.add(() => { stopRun(); powerUp(); });

    const update = () => {
      status.replaceChildren(
        h('span', null, `cycle ${cycles}`), h('span', null, `${instrs} opcode fetches`),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`)
          : h('span', { class: 'good', title: 'Every bus cycle (address, data, R/W, SYNC) matches the instruction-set simulator' }, '✓ bus matches the reference model'),
        ...(halted() ? [h('span', { class: 'warn' }, 'halted (JMP to itself)')] : []),
        ...(irqHeld ? [h('span', { class: 'warn' }, 'IRQ held low')] : []));
      const keep = listing.scrollTop;
      listing.replaceChildren(...asm.lines.filter((l) => l.bytes.length || l.source.trim()).map((l) => h('div', { class: `ln${l.bytes.length && l.addr === curPc ? ' cur' : ''}` },
        h('span', { class: 'a' }, l.bytes.length ? hex(l.addr, 4) : ''),
        h('span', { class: 'w' }, l.bytes.slice(0, 3).map((b) => hex(b)).join(' ') + (l.bytes.length > 3 ? '…' : '')),
        h('span', { class: 't' }, l.source.replace(/\s+/g, ' ').trim()))));
      const cur = listing.querySelector('.cur') as HTMLElement | null;
      if (running && cur) listing.scrollTop = Math.max(0, cur.offsetTop - listing.offsetTop - 40);
      else listing.scrollTop = keep;
      const r = chip.regs();
      regs.replaceChildren(...([['A', r.a, 2], ['X', r.x, 2], ['Y', r.y, 2], ['S', r.s, 2], ['PC', r.pc, 4], ['IR', r.ir, 2]] as const).map(([n, v, w]) =>
        h('div', { class: 'r' }, h('span', { class: 'n' }, n), h('span', { class: 'v' }, hex(v, w)))));
      flags.replaceChildren(...['N', 'V', '–', 'B', 'D', 'I', 'Z', 'C'].map((f, i) => {
        const bit = 7 - i, on = f !== 'B' && f !== '–' && ((r.p >> bit) & 1) === 1;
        return h('span', { class: `f${on ? ' on' : ''}`, title: f === 'B' ? 'B exists only on the stack (pushed 1 by BRK / PHP, 0 by an interrupt)' : f === '–' ? 'bit 5: always 1 when pushed' : `${f} = ${on ? 1 : 0}` }, f);
      }), h('span', { class: 'm65-p' }, `P = $${hex(r.p)}`));
      pins.replaceChildren(
        h('tr', null, ...['cycle', 'T', 'A15–A0', 'D', 'R/W', 'SYNC', ''].map((x) => h('th', null, x))),
        ...trace.map((b) => h('tr', { class: b.sync ? 'sync' : '' },
          h('td', null, String(b.cycle)), h('td', null, b.t ? `T${b.t}` : ''), h('td', null, `$${hex(b.addr, 4)}`), h('td', null, hex(b.data)),
          h('td', { class: b.write ? 'w' : '' }, b.write ? 'W' : 'R'), h('td', null, String(b.sync)),
          h('td', { class: 'note' }, b.sync ? disasmAt((a) => mem.mem[a], b.addr).text : b.write ? 'write' : ''))));
      console_.textContent = out || ' ';
      pages.querySelectorAll('button').forEach((b) => b.classList.toggle('primary', b.dataset.page === String(page)));
      memGrid.replaceChildren(...Array.from({ length: 16 }, (_, r) => h('div', { class: 'row' },
        h('span', { class: 'a' }, hex(page * 256 + r * 16, 4)),
        ...Array.from({ length: 16 }, (_, c) => {
          const a = page * 256 + r * 16 + c, v = mem.mem[a];
          return h('span', { class: `${v ? '' : 'z'}${a === lastWrite ? ' w' : ''}` }, hex(v));
        }))));
    };

    powerUp();
    update();
    return { el, update, destroy: stopRun };
  };
}
