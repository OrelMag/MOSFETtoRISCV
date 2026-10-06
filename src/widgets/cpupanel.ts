// Companion panel for a running CPU scene: the program with the current instruction, the
// register file, data memory, and a live check against the golden model (the ISS runs in
// lock-step and every register is compared after each clock edge).

import { pipelinedCpu, singleCycleCpu } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { cpuState, retiring } from '../riscv/cosim';
import { ABI, decode, disasm } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
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
  /** Show the program editor. */
  editable?: boolean;
}

/** A scene running `source` on the single-cycle CPU, with the CPU panel attached. */
export function cpuScene(opts: CpuSceneOptions): Scene {
  const asm = assemble(opts.source);
  return {
    root: opts.pipeline ? pipelinedCpu(asm.words, { adder: opts.adder, balanced: opts.balanced, predictor: opts.predictor }) : singleCycleCpu(asm.words, { adder: opts.adder }),
    inputs: { clk: 0 },
    highlight: opts.highlight,
    panels: [cpuPanel({ ...opts, asm }), ...(opts.pipeline ? [pipeDiagram(asm)] : []), ...(opts.timing ? [timingPanel] : [])],
  };
}

function cpuPanel(opts: CpuSceneOptions & { asm: AsmResult }): ScenePanel {
  return (stage: Stage): Widget => {
    const asm = opts.asm;
    let iss = new ISS(asm.words);
    let lastX: number[] = new Array(32).fill(0);
    let changed = new Set<number>();
    let mismatch: string | null = null;
    let running: number | null = null;

    const status = h('div', { class: 'cpu-status' });
    const listing = h('div', { class: 'cpu-listing' });
    const regs = h('div', { class: 'cpu-regs' });
    const mem = h('div', { class: 'cpu-mem' });
    const now = h('div', { class: 'cpu-now' });
    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const p of PROGRAMS) sel.append(h('option', { value: p.id }, p.name));
    sel.append(h('option', { value: '__custom' }, 'My program'));
    const match = PROGRAMS.find((p) => p.source === opts.source);
    sel.value = match ? match.id : '__custom';
    sel.addEventListener('change', () => {
      const p = PROGRAMS.find((q) => q.id === sel.value);
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
        stage.runCycles(opts.pipeline ? 3 : 4, () => iss.halted);
        if (iss.halted || mismatch || stage.cycles > 5000) return stopRun();
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
      h('div', { class: 'cpu-sec' }, 'Data memory (non-zero words)'), mem);
    const title = h('h4', null, opts.pipeline ? 'RV32I pipeline' : 'RV32I CPU', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
    const el = h('div', { class: 'mem-panel cpu-panel', 'data-dock': 'right' }, title, body);
    title.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      stage.setInset(el.classList.contains('collapsed') ? 0 : el.getBoundingClientRect().width + 24);
    });

    // Golden model in lock-step: it executes one instruction whenever the hardware retires one
    // (every cycle for the single-cycle CPU; when a valid instruction leaves W for the pipeline).
    let willRetire = false;
    stage.edgeHooks.add({
      before: () => { willRetire = !opts.pipeline || (!!stage.sim && retiring(stage.sim)); },
      after: () => {
        if (!willRetire || iss.halted || !stage.sim) return;
        iss.step();
        if (!mismatch) {
          const x = cpuState(stage.sim).x;
          const diff = x.findIndex((v, i) => v !== iss.x[i]);
          if (diff >= 0) mismatch = `${ABI[diff]} differs after "${disasm(iss.imem[(iss.pc >>> 2) % 64] ?? 0x13)}": hardware ${hex(x[diff])}, model ${hex(iss.x[diff])}`;
        }
      },
    });
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      if (stage.cycles === 0 && iss.steps > 0) {
        iss = new ISS(asm.words);
        mismatch = null;
      }
      const st = cpuState(sim);
      changed = new Set();
      st.x.forEach((v, i) => { if (v !== lastX[i]) changed.add(i); });
      lastX = st.x;
      if (!mismatch && !opts.pipeline && st.pc !== iss.pc) mismatch = `PC differs: hardware ${hex(st.pc)}, model ${hex(iss.pc)}`;
      const halted = iss.halted;
      const parts: HTMLElement[] = [
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, opts.pipeline ? `retired ${iss.steps}${iss.steps ? ` · CPI ${(stage.cycles / iss.steps).toFixed(2)}` : ''}` : `PC ${hex(st.pc, 4)}`),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good', title: 'Every register and the PC match the instruction-set simulator after every cycle' }, '✓ matches golden model'),
      ];
      if (halted) parts.push(h('span', { class: 'warn' }, 'halted'));
      status.replaceChildren(...parts);
      const w = asm.words[st.pc >>> 2] ?? 0x13;
      const d = decode(w);
      now.replaceChildren(
        h('span', { class: 'fmt' }, `${d.fmt}-type`),
        h('code', null, disasm(w, st.pc)),
        h('span', { class: 'hexw' }, hex(w)),
      );
      listing.replaceChildren(...asm.lines.map((l) => h('div', { class: `ln${l.addr === st.pc ? ' cur' : ''}` },
        h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
        h('span', { class: 'w' }, l.word.toString(16).padStart(8, '0')),
        h('span', { class: 't' }, l.text))));
      const cur = listing.querySelector('.cur') as HTMLElement | null;
      if (cur) listing.scrollTop = Math.max(0, cur.offsetTop - listing.offsetTop - 40);
      regs.replaceChildren(...st.x.map((v, i) => h('div', { class: `r${changed.has(i) && stage.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `x${i} = ${v | 0}` },
        h('span', { class: 'n' }, `${ABI[i]}`), h('span', { class: 'v' }, hex(v)))));
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
