// Chapter 25's 64-bit core on the stage: the RV64IM single-cycle CPU (lib/cpu64.ts xlenCpu) with a CPU panel of its
// own, the golden model (riscv/iss64.ts) in lock step after every retirement. Registers are 64 bits, so every value
// is read as a BigInt (sim/values.ts packBig), never through a JS number.

import { xlenCpu } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { retiring, wideState } from '../riscv/cosim';
import { ABI, disasm, regNumber } from '../riscv/isa';
import { ISS64 } from '../riscv/iss64';
import type { ModelState } from '../riscv/iss';
import { PROGRAMS64 } from '../riscv/programs64';
import { BENCHMARKS, benchSource } from '../riscv/benchprograms';
import { debounce, h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { codeEditor } from './codeedit';
import { slowControls } from './slowctl';
import { timingPanel } from './timing';

export interface Cpu64SceneOptions {
  source: string;
  /** The core's width: the same generator at 32 bits runs the RV32 programs. */
  xlen?: 32 | 64;
  m?: boolean;
  timing?: boolean;
  imemK?: number;
  dmemK?: number;
}

/** Programs offered in the panel: the RV64 samples, then the benchmarks (RV64 versions where they differ). */
const PROGS = [
  ...PROGRAMS64.map((p) => ({ id: p.id, name: p.name, source: p.source, result: p.result.reg })),
  ...BENCHMARKS.filter((b) => !b.needs?.f).map((b) => ({ id: `b-${b.id}`, name: `Benchmark: ${b.name}`, source: benchSource(b, 64), result: '' })),
];

const hex64 = (v: bigint) => `0x${v.toString(16).toUpperCase().padStart(16, '0').replace(/(.{8})(?=.)/, '$1_')}`;
const signed = (v: bigint) => BigInt.asIntN(64, v);

export function cpu64Scene(opts: Cpu64SceneOptions): Scene {
  const xlen = opts.xlen ?? 64;
  const asm = assemble(opts.source, [], { xlen });
  const m = opts.m ?? true;
  // the smallest ROM that holds the program, 64 words at least: the size XLEN_COSTS measures
  const imemK = opts.imemK ?? Math.max(6, Math.ceil(Math.log2(Math.max(1, asm.words.length))));
  return {
    root: xlenCpu(asm.words, { xlen, m, imemK, dmemK: opts.dmemK ?? 5 }),
    inputs: { clk: 0 },
    panels: [cpu64Panel({ ...opts, xlen, m, imemK }, asm), ...(opts.timing ? [timingPanel] : [])],
  };
}

function cpu64Panel(opts: Cpu64SceneOptions & { xlen: 32 | 64; m: boolean }, asm: AsmResult): ScenePanel {
  return (stage: Stage): Widget => {
    const imemWords = 2 ** opts.imemK!, dmemWords = 2 ** (opts.dmemK ?? 5) * (opts.xlen / 32);
    const fresh = () => new ISS64(asm.words, { m: opts.m, imemWords, dmemWords });
    let iss = fresh();
    let mismatch: string | null = null;
    let running: number | null = null;
    let lastX: bigint[] = new Array(32).fill(0n);
    const log: { cycle: number; text: string; effect: string }[] = [];

    const status = h('div', { class: 'cpu-status' });
    const now = h('div', { class: 'cpu-now' });
    const listing = h('div', { class: 'cpu-listing' });
    const trace = h('div', { class: 'cpu-trace' });
    const regs = h('div', { class: 'cpu-regs cpu-regs64' });
    const mem = h('div', { class: 'cpu-mem' });
    const haltLine = h('div', { class: 'cpu-halt', role: 'status', hidden: true });

    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const p of PROGS) sel.append(h('option', { value: p.id }, p.name));
    sel.append(h('option', { value: '__custom' }, 'My program'));
    const match = PROGS.find((p) => p.source === opts.source);
    sel.value = match ? match.id : '__custom';
    sel.addEventListener('change', () => {
      const p = PROGS.find((q) => q.id === sel.value);
      if (p) stage.load(cpu64Scene({ ...opts, imemK: undefined, source: p.source }));
    });

    const runBtn = h('button', { class: 'btn sm primary', title: 'Run until the program halts' }, 'Run to halt');
    const stopRun = () => {
      if (running) cancelAnimationFrame(running);
      running = null;
      runBtn.textContent = 'Run to halt';
    };
    const finished = () => iss.halted || !!mismatch || stage.cycles > 50000;
    runBtn.addEventListener('click', () => {
      if (running) return stopRun();
      slowCtl.stop();
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      const tick = () => {
        stage.runCycles(20, () => iss.halted);
        if (finished()) return stopRun();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });
    const slowCtl = slowControls(stage, { multiCycle: opts.m, finished, onStart: () => stopRun() });

    const errBox = h('div', { class: 'asm-errors' });
    const check = debounce(() => editor.setDiagnostics(assemble(editor.value, [], { xlen: opts.xlen }).errors), 300);
    const editor = codeEditor({ value: opts.source, lang: 'rvasm', rows: 14, onChange: () => { errBox.textContent = ''; check(); } });
    editor.el.classList.add('asm-editor');
    const editWrap = h('div', { class: 'cpu-edit', style: 'display:none' }, editor.el, errBox,
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' },
        h('button', {
          class: 'btn sm primary', onclick: () => {
            const r = assemble(editor.value, [], { xlen: opts.xlen });
            editor.setDiagnostics(r.errors);
            if (r.errors.length) return void (errBox.textContent = r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n'));
            stage.load(cpu64Scene({ ...opts, imemK: undefined, source: editor.value }));
          },
        }, 'Assemble & load'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = 'none'; } }, 'Close')));
    const editBtn = h('button', { class: 'btn sm', onclick: () => { editWrap.style.display = editWrap.style.display === 'none' ? 'block' : 'none'; } }, 'Edit');

    const name = `RV${opts.xlen}I${opts.m ? 'M' : ''} CPU`;
    const el = h('div', { class: 'mem-panel cpu-panel', 'data-dock': 'right', 'data-fold': 'narrow' },
      h('h4', null, name, h('span', { class: 'fold-hint' })),
      h('div', { class: 'cpu-body' },
        h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, editBtn, runBtn),
        slowCtl.el, editWrap, status, haltLine, now,
        h('div', { class: 'cpu-sec' }, 'Program'), listing,
        h('div', { class: 'cpu-sec' }, 'Trace', h('span', { class: 'cpu-sec-hint' }, 'retired instructions, newest last')), trace,
        h('div', { class: 'cpu-sec' }, `Registers (${opts.xlen} bits)`), regs,
        h('div', { class: 'cpu-sec' }, 'Data memory (non-zero doublewords)'), mem));

    // the golden model steps when the hardware retires (every cycle, except while the divider runs)
    let willRetire = false;
    stage.edgeHooks.add({
      before: () => { willRetire = !!stage.sim && retiring(stage.sim); },
      after: () => {
        if (willRetire) slowCtl.retired();
        if (!willRetire || iss.halted || !stage.sim) return;
        const info = iss.step();
        const eff = info.store ? `mem[${hex64(info.store.addr).slice(-6)}] ← ${info.store.value.toString(16)}` : info.rd ? `${ABI[info.rd]} = ${signed(info.value!)}` : '';
        log.push({ cycle: stage.cycles, text: info.text, effect: eff });
        if (log.length > 200) log.shift();
        if (!mismatch) {
          const x = wideState(stage.sim).x;
          const d = x.findIndex((v, i) => v !== iss.x[i]);
          if (d >= 0) mismatch = `${ABI[d]} differs after "${info.text}": hardware ${hex64(x[d])}, model ${hex64(iss.x[d])}`;
        }
      },
    });
    stage.historyHooks.add({
      save: () => ({ iss: iss.save(), mismatch, log: log.slice(), lastX: lastX.slice() }),
      restore: (v) => {
        const st = v as { iss: ModelState; mismatch: string | null; log: typeof log; lastX: bigint[] };
        stopRun();
        slowCtl.stop();
        iss.restore(st.iss);
        mismatch = st.mismatch;
        log.splice(0, log.length, ...st.log);
        lastX = st.lastX.slice();
      },
    });

    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      slowCtl.update();
      if (stage.cycles === 0 && iss.steps > 0) { iss = fresh(); mismatch = null; log.length = 0; }
      const st = wideState(sim);
      if (!mismatch && !stage.inEdge && st.pc !== iss.pc) mismatch = `PC differs: hardware ${hex64(st.pc)}, model ${hex64(iss.pc)}`;
      const stalled = opts.m && !retiring(sim);
      status.replaceChildren(
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, `retired ${iss.steps}${iss.steps ? ` · CPI ${(stage.cycles / iss.steps).toFixed(2)}` : ''}`),
        ...(stalled ? [h('span', { class: 'warn', title: 'The iterative divider is working; the PC and register writes wait' }, 'dividing… stalled')] : []),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good', title: 'Every register and the PC match the golden model after every instruction' }, '✓ matches golden model'),
        ...(iss.halted ? [h('span', { class: 'warn' }, 'halted')] : []));
      const res = match?.result ? regNumber(match.result) : null;
      haltLine.hidden = !iss.halted || !!mismatch;
      if (iss.halted && !mismatch) haltLine.replaceChildren(`Halted after ${iss.steps.toLocaleString()} instructions (${stage.cycles.toLocaleString()} cycles)`,
        res !== null && match ? h('span', null, ' · result ', h('b', null, `${match.result} = ${signed(iss.x[res])}`)) : '');
      const pc = st.pc;
      const w = asm.words[Number(pc >> 2n)] ?? 0x13;
      now.replaceChildren(h('code', null, disasm(w, Number(pc & 0xffffffffn), undefined, opts.xlen)), h('span', { class: 'hexw' }, `0x${w.toString(16).padStart(8, '0')}`));
      const keep = listing.scrollTop;
      listing.replaceChildren(...asm.lines.map((l) => h('div', { class: `ln${BigInt(l.addr) === pc ? ' cur' : ''}` },
        h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
        h('span', { class: 'w' }, l.word.toString(16).padStart(8, '0')),
        h('span', { class: 't' }, l.text))));
      const cur = listing.querySelector('.cur') as HTMLElement | null;
      listing.scrollTop = cur && running === null ? Math.max(0, cur.offsetTop - listing.offsetTop - 40) : keep;
      trace.replaceChildren(...log.slice(-40).map((e) => h('div', { class: 'tr' }, h('span', { class: 'c' }, String(e.cycle)), h('span', { class: 't' }, e.text), h('span', { class: 'eff' }, e.effect))));
      trace.scrollTop = trace.scrollHeight;
      regs.replaceChildren(...st.x.map((v, i) => h('div', { class: `r${v !== lastX[i] && stage.cycles > 0 ? ' chg' : ''}${v ? '' : ' z'}`, title: `x${i} = ${signed(v)}` },
        h('span', { class: 'n' }, ABI[i]), h('span', { class: 'v' }, opts.xlen === 64 ? hex64(v) : `0x${v.toString(16).toUpperCase().padStart(8, '0')}`))));
      if (!stage.inEdge) lastX = st.x;
      const dws = st.dmem.map((v, i) => [i, v] as const).filter(([, v]) => v !== 0n);
      const step = opts.xlen / 8;
      mem.replaceChildren(...(dws.length ? dws.map(([i, v]) => h('div', { class: 'm' },
        h('span', { class: 'n' }, `[${(i * step).toString(16).padStart(3, '0')}]`), h('span', { class: 'v' }, opts.xlen === 64 ? hex64(v) : `0x${v.toString(16).padStart(8, '0')}`),
        h('span', { class: 'd' }, String(opts.xlen === 64 ? signed(v) : BigInt.asIntN(32, v))))) : [h('div', { class: 'm z' }, 'all zero')]));
    };
    update();
    return { el, update, destroy: () => { stopRun(); slowCtl.stop(); } };
  };
}
