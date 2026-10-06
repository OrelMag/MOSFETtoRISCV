// Companion panel for a running CPU scene: the program with the current instruction, the
// register file, data memory, and a live check against the golden model (the ISS runs in
// lock-step and every register is compared after each clock edge).

import { MC_FIELDS, MC_STATES, microword, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { cpuState, retiring } from '../riscv/cosim';
import { ABI, decode, disasm } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { SYSTEM_PROGRAMS } from '../riscv/sysprograms';
import { M_PROGRAMS } from '../riscv/mprograms';
import { CACHE_CPU_PROGRAMS } from '../riscv/cprograms';
import { F_PROGRAMS } from '../riscv/fprograms';
import { FABI } from '../riscv/isa';
import { bitsToF32, flagNames, RM_NAMES } from '../sim/fpref';
import { CAUSE } from '../riscv/iss';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
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
  /** Single-cycle CPU with a data cache in front of a slow main memory (adds cache statistics). */
  dcache?: boolean;
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
      : opts.pipeline ? pipelinedCpu(asm.words, { adder: opts.adder, balanced: opts.balanced, predictor: opts.predictor })
        : singleCycleCpu(asm.words, opts.dcache ? { adder: opts.adder, dmemK: 6, dcache: true } : { adder: opts.adder, fpu: opts.fpu }),
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

    const status = h('div', { class: 'cpu-status' });
    const listing = h('div', { class: 'cpu-listing' });
    const regs = h('div', { class: 'cpu-regs' });
    const mem = h('div', { class: 'cpu-mem' });
    const now = h('div', { class: 'cpu-now' });
    const dlines = h('div', { class: 'cpu-mem dcache-lines' });
    const fregs = h('div', { class: 'cpu-mem' });
    let loads = 0, misses = 0;
    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    const progs = opts.fpu ? [...F_PROGRAMS, ...PROGRAMS] : opts.dcache ? [...CACHE_CPU_PROGRAMS, ...PROGRAMS] : opts.m ? [...M_PROGRAMS, ...SYSTEM_PROGRAMS, ...PROGRAMS] : opts.system ? [...SYSTEM_PROGRAMS, ...PROGRAMS] : PROGRAMS;
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
      runBtn.textContent = 'Stop';
      const tick = () => {
        stage.runCycles(opts.pipeline ? 3 : opts.m || opts.fpu || opts.dcache || opts.multicycle ? 10 : 4, () => iss.halted);
        if (iss.halted || mismatch || stage.cycles > 20000) return stopRun();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });

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
      editWrap, status, now,
      h('div', { class: 'cpu-sec' }, 'Program'), listing,
      h('div', { class: 'cpu-sec' }, 'Registers'), regs,
      ...(opts.fpu ? [h('div', { class: 'cpu-sec' }, 'Floating-point registers (non-zero)'), fregs] : []),
      ...(opts.dcache ? [h('div', { class: 'cpu-sec' }, 'Data cache (4 lines × 4 words)'), dlines] : []),
      h('div', { class: 'cpu-sec' }, opts.dcache ? 'Main memory (non-zero words)' : 'Data memory (non-zero words)'), mem);
    const title = h('h4', null, opts.multicycle ? 'RV32I multicycle' : opts.fpu ? 'RV32IF CPU' : opts.system ? (opts.m ? 'RV32IM system' : 'RV32I system') : opts.pipeline ? 'RV32I pipeline' : 'RV32I CPU', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
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
        if (opts.dcache && stage.sim) {
          const dm = stage.sim.design.root.children!.get('dm')!;
          if (stage.sim.getBits(dm.ports.re)[0] === 1) {
            if (willRetire) loads++;
            else if (pack(stage.sim.getBits(dm.children!.get('cnt')!.ports.q)) === 0) misses++;
          }
        }
        if (opts.system) {
          iss.irq = stage.getInput('irq') === 1;
          iss.switches = stage.getInput('switches');
        }
      },
      after: () => {
        if (!willRetire || iss.halted || !stage.sim) return;
        iss.step();
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
        loads = misses = 0;
      }
      const st = cpuState(sim);
      changed = new Set();
      st.x.forEach((v, i) => { if (v !== lastX[i]) changed.add(i); });
      lastX = st.x;
      const atBoundary = !sim.design.root.ports.fetch || sim.getBits(sim.design.root.ports.fetch)[0] === 1;
      if (!mismatch && !opts.pipeline && atBoundary && st.pc !== iss.pc) mismatch = `PC differs: hardware ${hex(st.pc)}, model ${hex(iss.pc)}`;
      const halted = iss.halted;
      const parts: HTMLElement[] = [
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, opts.pipeline || opts.m || opts.fpu || opts.multicycle ? `retired ${iss.steps}${iss.steps ? ` · CPI ${(stage.cycles / iss.steps).toFixed(2)}` : ''}` : `PC ${hex(st.pc, 4)}`),
        ...(opts.m && !retiring(sim) ? [h('span', { class: 'warn', title: 'The iterative divider is working; the PC and register writes are stalled' }, 'dividing… stalled')] : []),
        ...(opts.fpu && !retiring(sim) ? [h('span', { class: 'warn', title: 'An iterative unit (fdiv.s / fsqrt.s) is working; the PC and register writes are stalled' }, 'fdiv / fsqrt… stalled')] : []),
        ...(opts.dcache ? [h('span', null, `loads ${loads} · misses ${misses}${loads ? ` · hit rate ${(100 * (loads - misses) / loads).toFixed(0)} %` : ''}`)] : []),
        ...(opts.dcache && !retiring(sim) ? [h('span', { class: 'warn', title: 'A load missed: the PC and register write wait while the line is fetched' }, `miss: fetching line (${pack(sim.getBits(sim.design.root.children!.get('dm')!.children!.get('cnt')!.ports.q)) + 1} / 8)`)] : []),
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
      listing.replaceChildren(...asm.lines.map((l) => h('div', { class: `ln${l.addr === shownPc ? ' cur' : ''}` },
        h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
        h('span', { class: 'w' }, l.word.toString(16).padStart(8, '0')),
        h('span', { class: 't' }, l.text))));
      const cur = listing.querySelector('.cur') as HTMLElement | null;
      if (cur) listing.scrollTop = Math.max(0, cur.offsetTop - listing.offsetTop - 40);
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
        const dm = sim.design.root.children!.get('dm')!;
        const q = (arr: string, w: string) => pack(sim.getBits(dm.children!.get(arr)!.children!.get(w)!.ports.q)) >>> 0;
        const tb = dm.children!.get('tags')!.def.ports.find((p) => p.name === 'din')!.width - 1;
        dlines.replaceChildren(...[0, 1, 2, 3].map((line) => {
          const tv = q('tags', `w${line}`), valid = (tv >> tb) & 1, tag = tv & ((1 << tb) - 1);
          return h('div', { class: `m${valid ? '' : ' z'}` }, h('span', { class: 'n' }, `${line}: ${valid ? `tag ${tag}` : 'empty'}`),
            h('span', { class: 'v' }, valid ? [0, 1, 2, 3].map((o) => q('data', `w${line * 4 + o}`).toString(16)).join(' ') : ''));
        }));
      }
      const words = st.dmem.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
      mem.replaceChildren(...(words.length ? words.map(([i, v]) => h('div', { class: 'm' },
        h('span', { class: 'n' }, `[${hex(i * 4, 2)}]`), h('span', { class: 'v' }, hex(v)), h('span', { class: 'd' }, String(v | 0)))) : [h('div', { class: 'm z' }, 'all zero')]));
    };
    update();
    return { el, update, destroy: stopRun };
  };
}

/** Pipeline diagram: which instruction occupies each stage in each cycle. */
function pipeDiagram(asm: AsmResult): ScenePanel {
  return (stage: Stage): Widget => {
    type Slot = { pc: number; valid: boolean };
    type Snap = { cycle: number; slots: Slot[]; stall: boolean; flush: boolean; fwdA: number; fwdB: number; byp: boolean };
    const history: Snap[] = [];
    const STAGES = ['F', 'D', 'E', 'M', 'W'];
    const grid = h('div', { class: 'pipe-grid' });
    const title = h('h4', null, 'Pipeline diagram', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'stage × cycle'));
    const el = h('div', { class: 'mem-panel pipe-panel' }, title, grid);
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
      const slots: Slot[] = [
        { pc: v('pc', 'q'), valid: true },
        { pc: v('FD', 'pcD'), valid: v('FD', 'validD') === 1 },
        { pc: v('DE', 'pcE'), valid: v('DE', 'validE') === 1 },
        { pc: v('EM', 'pcM'), valid: v('EM', 'validM') === 1 },
        { pc: v('MW', 'pcW'), valid: v('MW', 'validW') === 1 },
      ];
      return {
        cycle: stage.cycles, slots,
        stall: v('hz', 'enFD') === 0, flush: v('hz', 'flushFD') === 1,
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
  const el = h('div', { class: 'mem-panel io-panel' }, title,
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
    const el = h('div', { class: `mem-panel mc-panel${compact ? ' compact' : ''}` }, title, body);
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
