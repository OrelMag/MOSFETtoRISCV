// The single-cycle chapter's last step: design a custom instruction. The single-cycle CPU runs a program that uses `lwx` (an
// indexed load, rd ← mem[rs1 + rs2]) with a draft row that does not load anything yet; the panel beside it is the
// sandbox dialog's row editor (widgets/ownrow.ts), reduced to what the program fixes: the learner sets the
// control signals, sees the NANDs the control unit grows by, and rebuilds the CPU. The golden model runs the same
// row, so lock step cannot tell a wrong definition from a right one: only the program's answer can.

import { andN } from '../lib/combinational';
import { control, CONTROL } from '../lib/cpu';
import { cpuState } from '../riscv/cosim';
import { meaning, problemsOf, signalsOf, type CustomRow } from '../riscv/custom';
import { BY_NAME } from '../riscv/isa';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { cpuScene } from './cpupanel';
import { dataPath, LINES } from './ownrow';

/** The array sum with the instruction the learner designs: eight words 3, 5 … 17 at byte 64, their sum stored at 0. */
export const OWN_SOURCE = `# fill 8 words at 64 with 3, 5 ... 17
        li   a0, 64
        li   t0, 0
        li   t1, 3
        li   t3, 32
fill:   add  t2, a0, t0
        sw   t1, 0(t2)
        addi t1, t1, 2
        addi t0, t0, 4
        bne  t0, t3, fill
# sum them: one lwx replaces add + lw
        li   t0, 0
        li   t1, 0
sum:    lwx  t2, a0, t0     # t2 = mem[a0 + t0]
        add  t1, t1, t2
        addi t0, t0, 4
        bne  t0, t3, sum
        sw   t1, 0(zero)    # mem[0] = 80
halt:   j    halt`;
export const OWN_SUM = 80;

/** The draft: R-type on custom-1, an adder that writes nothing. */
export const OWN_DRAFT: CustomRow = { name: 'lwx', slot: 1, fmt: 'R', funct3: 0, regWrite: false, srcA: 'rs1', srcB: 'rs2', alu: 'add', memWrite: false, result: 'alu', next: 'pc4' };
/** The answer: rd ← mem[rs1 + rs2]. */
export const OWN_ANSWER: CustomRow = { ...OWN_DRAFT, regWrite: true, result: 'mem' };

const TAKEN = new Set(BY_NAME.keys());

/** The control unit's NANDs: plain, one class's AND on the opcode rails, and with lwx. */
export const OWN_COST = { control: stats(CONTROL).nands, and5: stats(andN(5)).nands, lwx: stats(control([OWN_ANSWER])).nands };

/** The rows the scene on the stage runs (the challenge's check reads the machine; "Do it for me" sets these). */
let applyRows: ((rows: CustomRow[]) => void) | null = null;

export function ownInstrScene(rows: CustomRow[] = [OWN_DRAFT]): Scene {
  return cpuScene({ source: OWN_SOURCE, custom: rows, highlight: ['ctl'], extraPanels: [ownInstrPanel(rows)] });
}

function ownInstrPanel(initial: CustomRow[]): ScenePanel {
  return (stage: Stage): Widget => {
    let row = structuredClone(initial[0]);
    const built = JSON.stringify(initial[0]);
    const base = stats(CONTROL).nands;
    const lines = h('div', { class: 'oi-ctl' });
    const info = h('div', { class: 'oi-ctl' });
    const dp = h('div', { class: 'oi-side' });
    const build = h('button', { class: 'btn sm primary', title: 'Rebuild the CPU with this row: the control unit gains an opcode class' }, 'Build the CPU') as HTMLButtonElement;
    const result = h('div', { class: 'oi-sem', role: 'status', 'aria-live': 'polite' });

    const render = () => {
      lines.replaceChildren(...LINES.map((l) => h('div', { class: 'oi-line' }, h('span', null, l.label),
        h('span', { class: 'oi-seg', role: 'group', 'aria-label': l.label }, l.opts.map(([v, t]) => h('button', {
          type: 'button', class: row[l.key] === v ? 'on' : '', 'aria-pressed': String(row[l.key] === v),
          onclick: () => { row = { ...row, [l.key]: v } as CustomRow; render(); },
        }, t))))));
      const probs = problemsOf(row, TAKEN);
      const bad = probs.some((p) => p.level === 'bad');
      const now = stats(control([row])).nands;
      info.replaceChildren(
        h('div', { class: 'oi-sem' }, ...meaning(row).map((m) => h('div', null, m))),
        h('p', { class: 'oi-sigs' }, signalsOf(row).length ? signalsOf(row).map((x) => h('code', null, x)) : h('span', { class: 'py-hint' }, 'asserts no signal')),
        h('div', { class: 'py-hint' }, `Control unit: ${base} → ${now} NANDs (+${now - base}): one 5-input AND for the class, one more OR input per signal.`),
        h('div', { class: 'oi-probs' }, ...probs.map((p) => h('div', { class: p.level }, p.text))));
      dp.replaceChildren(dataPath(row));
      build.disabled = bad || JSON.stringify(row) === built;
      build.textContent = JSON.stringify(row) === built ? 'CPU is built with this row' : 'Build the CPU';
    };
    build.addEventListener('click', () => stage.load(ownInstrScene([row])));
    applyRows = (rows) => { row = structuredClone(rows[0]); stage.load(ownInstrScene([row])); };

    const title = h('h4', null, 'Your instruction: lwx rd, rs1, rs2', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel oi-panel', 'data-dock': 'left' }, title,
      h('p', { class: 'py-hint' }, 'The program below uses lwx t2, a0, t0 and wants t2 ← mem[a0 + t0]. The draft only adds. Set the signals, then build the CPU and run it.'),
      h('div', { class: 'oi-cols' }, h('div', null, lines, info), dp),
      h('div', { class: 'py-row' }, build), result);
    title.addEventListener('click', () => { el.classList.toggle('collapsed'); stage.layoutDock(); });
    render();

    const update = () => {
      let got: number | null = null;
      try { got = stage.sim ? cpuState(stage.sim).dmem[0] : null; } catch { /* a rebuild in flight */ }
      result.replaceChildren(h('div', null, `mem[0] = ${got ?? '?'}   (the sum should be ${OWN_SUM})`),
        h('div', { class: 'py-hint' }, got === OWN_SUM ? 'Correct: the loop sums the array.' : 'Run the program (Run to halt in the CPU panel), then compare.'));
    };
    update();
    return { el, update };
  };
}

/** "Do it for me": the answer row, the CPU rebuilt with it, the program run to its halt. */
export function solveOwnInstr(stage: Stage): void {
  const before = stage.sim;
  applyRows?.([OWN_ANSWER]);
  let started = false;
  const run = () => {
    if (started) return true;
    if (!stage.sim || stage.sim === before) return false;
    started = true;
    stage.runCycles(400, () => { try { return cpuState(stage.sim!).dmem[0] === OWN_SUM; } catch { return false; } });
    return true;
  };
  if (run()) return;
  const off = stage.onChange(() => { if (run()) off(); });
}

export const ownInstrSolved = (stage: Stage): boolean => {
  try { return !!stage.sim && cpuState(stage.sim).dmem[0] === OWN_SUM; } catch { return false; }
};
