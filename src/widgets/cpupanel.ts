// Companion panel for a running CPU scene: the program with the current instruction, the
// register file, data memory, and a live check against the golden model (the ISS runs in
// lock-step and every register is compared after each clock edge).

import { singleCycleCpu } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { cpuState } from '../riscv/cosim';
import { ABI, decode, disasm } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

export interface CpuSceneOptions {
  source: string;
  highlight?: string[];
  /** Show the program editor. */
  editable?: boolean;
}

/** A scene running `source` on the single-cycle CPU, with the CPU panel attached. */
export function cpuScene(opts: CpuSceneOptions): Scene {
  const asm = assemble(opts.source);
  return {
    root: singleCycleCpu(asm.words),
    inputs: { clk: 0 },
    highlight: opts.highlight,
    panels: [cpuPanel({ ...opts, asm })],
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
        stage.runCycles(4, () => iss.halted);
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
    const title = h('h4', null, 'RV32I CPU', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
    const el = h('div', { class: 'mem-panel cpu-panel', 'data-dock': 'right' }, title, body);
    title.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      stage.setInset(el.classList.contains('collapsed') ? 0 : el.getBoundingClientRect().width + 24);
    });

    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      // Keep the golden model in lock-step with the hardware's clock.
      if (stage.cycles < iss.steps) {
        iss = new ISS(asm.words);
        mismatch = null;
      }
      while (iss.steps < stage.cycles && !iss.halted) iss.step();
      const st = cpuState(sim);
      changed = new Set();
      st.x.forEach((v, i) => { if (v !== lastX[i]) changed.add(i); });
      lastX = st.x;
      if (!mismatch) {
        const diff = st.x.findIndex((v, i) => v !== iss.x[i]);
        if (st.pc !== iss.pc) mismatch = `PC differs: hardware ${hex(st.pc)}, model ${hex(iss.pc)}`;
        else if (diff >= 0) mismatch = `${ABI[diff]} differs: hardware ${hex(st.x[diff])}, model ${hex(iss.x[diff])}`;
      }
      const halted = iss.halted && stage.cycles >= iss.steps;
      const parts: HTMLElement[] = [
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, `PC ${hex(st.pc, 4)}`),
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
