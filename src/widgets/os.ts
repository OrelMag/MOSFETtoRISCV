// Chapter 'os' (A tiny operating system): the explainers and the scene panel. The scenes run the kernel of riscv/osprograms.ts on the
// virtual-memory system CPU in gates (cpuScene({ vm: true }), the golden model in lock step); every number a widget shows comes from the
// golden model's run of the same image (riscv/osrun.ts, held to the gates' stall cycles by tests/os-kernel.test.ts) or is read off the
// gates as they run (the time-slice strip).

import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { counter, osImage, OS_DMEM_K, OS_IMEM_K, OS_SLICE, PCB, PCB0, PCB_SIZE, spinner2, type OsImage } from '../riscv/osprograms';
import { captureSwitch, overheadAt, planOf, type Overhead, type SwitchFrame } from '../riscv/osrun';
import { cpuScene } from './cpupanel';
import '../styles/vmem.css';
import '../styles/os.css';

const hex = (v: number, d = 0) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
export const PROC_NAMES = ['A', 'B'];
const REGS = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];

/** The standard pair of processes of the chapter's scenes. */
export const sharePair = (): string[] => [counter(1, 6), counter(10, 6)];

/** A scene: the kernel with these processes on the virtual-memory CPU, the cycle engine, the CPU panel, the translation panel and the strip. */
export function osScene(o: { procs: string[]; slice?: number; highlight?: string[]; keep?: 'open' | 'folded' }): Scene {
  const img = osImage(o.procs, { slice: o.slice });
  const reload = (slice: number) => osScene({ ...o, slice });
  return {
    ...cpuScene({ vm: true, source: img.source, highlight: o.highlight, imemK: OS_IMEM_K, dmemK: OS_DMEM_K, hideFiller: true, extraPanels: [osPanel({ slice: o.slice ?? OS_SLICE, reload, keep: o.keep })] }),
    engine: 'cycle', autoClock: false, noRemix: true,
  };
}

// ---- the time-slice strip, read off the gates -------------------------------------------------------------------------------

type Kind = 0 | 1 | 2 | 3; // process A, process B, the kernel (machine mode), a walk stalling the CPU

const KIND_NAME = ['process A', 'process B', 'kernel', 'page-table walk'];
const WINDOW = 2400;

/** The data memory's words, from the RAM leaf of the vm CPU. */
function dmemOf(sim: Sim, root: HierNode): ArrayLike<number> | undefined {
  const dm = root.children?.get('dm');
  if (!dm || dm.leafIndex === undefined) return undefined;
  return (sim.leafState(dm.leafIndex) as { mem: ArrayLike<number> } | undefined)?.mem;
}

export function osPanel(o: { slice: number; reload: (slice: number) => Scene; keep?: 'open' | 'folded' }): ScenePanel {
  return (stage: Stage): Widget => {
    let segs: { k: Kind; n: number }[] = [];
    let win = 0;
    const total = [0, 0, 0, 0];
    let con: { who: number; ch: string }[] = [];
    let switches = 0, lastRun = -1;
    const strip = h('div', { class: 'os-strip', role: 'img', 'aria-label': 'who had the CPU in each recent cycle: process A, process B, the kernel, a page-table walk' });
    const legend = h('div', { class: 'os-legend' });
    const consoleEl = h('pre', { class: 'console os-console' });
    const blocks = h('div', { class: 'os-blocks' });
    const slices = [200, 600, 1500, 4000];
    const sel = h('select', { 'aria-label': 'time slice in retired instructions' }, ...slices.map((s) => h('option', { value: String(s) }, `${s} instructions`))) as HTMLSelectElement;
    sel.value = String(slices.includes(o.slice) ? o.slice : OS_SLICE);
    sel.addEventListener('change', () => stage.load(o.reload(Number(sel.value))));

    const push = (k: Kind) => {
      total[k]++;
      const last = segs[segs.length - 1];
      if (last && last.k === k) last.n++; else segs.push({ k, n: 1 });
      win++;
      while (win > WINDOW) {
        const f = segs[0], cut = Math.min(f.n, win - WINDOW);
        f.n -= cut; win -= cut;
        if (f.n === 0) segs.shift();
      }
    };
    stage.edgeHooks.add({
      before: () => {
        const sim = stage.sim, root = stage.rootCtx?.node;
        if (!sim || !root?.children) return;
        const mem = dmemOf(sim, root), csr = root.children.get('csr')?.children, mmu = root.children.get('mmu');
        if (!mem || !csr || !mmu) return;
        const priv = (~pack(sim.getBits(csr.get('privN')!.ports.q))) & 3;
        const cur = mem[0] >>> 0, who = Math.min(1, Math.max(0, Math.floor((cur - PCB0) / PCB_SIZE)));
        const stalled = sim.getBits(mmu.ports.stall)[0] === 1;
        const kind: Kind = stalled ? 3 : priv === 3 ? 2 : (who as Kind);
        if (lastRun !== -1 && kind < 2 && kind !== lastRun) switches++;
        if (kind < 2) lastRun = kind;
        push(kind);
        if (sim.getBits(root.ports.consoleValid)[0] === 1) {
          const gone = mem[(cur + PCB.state) / 4] === 2;
          con.push({ who: gone ? 2 : who, ch: String.fromCharCode(pack(sim.getBits(root.ports.consoleData)) & 0xff) });
          if (con.length > 600) con = con.slice(-500);
        }
      },
    });
    stage.historyHooks.add({
      save: () => ({ segs: segs.map((s) => ({ ...s })), win, total: [...total], con: [...con], switches, lastRun }),
      restore: (v) => { const s = v as { segs: typeof segs; win: number; total: number[]; con: typeof con; switches: number; lastRun: number }; segs = s.segs.map((x) => ({ ...x })); win = s.win; s.total.forEach((t, i) => (total[i] = t)); con = [...s.con]; switches = s.switches; lastRun = s.lastRun; },
    });
    const el = h('div', { class: 'mem-panel io-panel os-panel', 'data-dock': 'left', 'data-fold': 'narrow', 'data-phone': 'flow', ...(o.keep ? { 'data-keep': o.keep } : {}) },
      h('h4', null, 'Who has the CPU', h('span', { class: 'fold-hint' })),
      h('div', { class: 'param-row' }, h('label', { class: 'os-slice' }, 'Time slice ', sel)),
      strip, legend,
      h('div', { class: 'cpu-sec' }, 'Console, by process'), consoleEl,
      h('div', { class: 'cpu-sec' }, 'Process control blocks'), blocks);
    const update = () => {
      const sim = stage.sim, root = stage.rootCtx?.node;
      if (stage.cycles === 0) { segs = []; win = 0; total.fill(0); con = []; switches = 0; lastRun = -1; }
      strip.replaceChildren(...segs.map((s) => h('div', { class: `os-seg k${s.k}`, style: `flex:${s.n}`, title: `${KIND_NAME[s.k]}: ${s.n} cycles` }, s.n >= WINDOW / 28 && s.k < 2 ? PROC_NAMES[s.k] : '')));
      const all = total[0] + total[1] + total[2] + total[3];
      legend.replaceChildren(
        ...[0, 1, 2, 3].map((k) => h('span', null, h('i', { class: `os-seg k${k}` }), `${KIND_NAME[k]} ${total[k]}`)),
        h('span', { class: 'os-sum' }, `${switches} switches · the kernel and the walks took ${all ? Math.round((100 * (total[2] + total[3])) / all) : 0} % of ${all} cycles (the last ${WINDOW} drawn)`));
      // the console, one colour per process
      const parts: (string | HTMLElement)[] = [];
      let run = '', who = -1;
      const flush = () => { if (run) parts.push(h('span', { class: `os-c${who}` }, run)); run = ''; };
      for (const c of con) { if (c.who !== who) { flush(); who = c.who; } run += c.ch; }
      flush();
      consoleEl.replaceChildren(...(parts.length ? parts : [' ']));
      consoleEl.scrollTop = consoleEl.scrollHeight;
      const mem = sim && root ? dmemOf(sim, root) : undefined;
      if (!mem || !sim || !root) return;
      const csr = root.children?.get('csr')?.children;
      const priv = csr ? (~pack(sim.getBits(csr.get('privN')!.ports.q))) & 3 : 3;
      const cur = mem[0] >>> 0;
      const names = ['free', 'ready', 'gone'];
      blocks.replaceChildren(h('table', { class: 'data os-pcb' },
        h('tr', null, h('th', null, ''), ...PROC_NAMES.map((n) => h('th', null, n))),
        h('tr', null, h('td', null, 'state'), ...PROC_NAMES.map((_, p) => { const a = PCB0 + p * PCB_SIZE, st = mem[(a + PCB.state) / 4]; return h('td', null, st === 1 && cur === a && priv === 0 ? 'running' : names[st] ?? '?'); })),
        h('tr', null, h('td', null, 'saved pc'), ...PROC_NAMES.map((_, p) => h('td', null, mem[(PCB0 + p * PCB_SIZE) / 4] ? hex(mem[(PCB0 + p * PCB_SIZE) / 4], 4) : '-'))),
        h('tr', null, h('td', null, 'satp'), ...PROC_NAMES.map((_, p) => h('td', null, mem[(PCB0 + p * PCB_SIZE + PCB.satp) / 4] ? hex(mem[(PCB0 + p * PCB_SIZE + PCB.satp) / 4], 8) : '-'))),
        h('tr', null, h('td', null, 'slices'), ...PROC_NAMES.map((_, p) => h('td', null, String(mem[(PCB0 + p * PCB_SIZE + PCB.slices) / 4] >>> 0)))),
        h('tr', null, h('td', null, 'user cycles'), ...PROC_NAMES.map((_, p) => h('td', null, String(total[p]))))));
    };
    update();
    return { el, update };
  };
}

// ---- step 1: the plan of memory ----------------------------------------------------------------------------------------------

export function planWidget(): Widget {
  const img = osImage(sharePair());
  const plan = planOf(img);
  const owner = (o: number) => (o === 2 ? 'k' : o === 0 ? 'a' : o === 1 ? 'b' : 'free');
  const frame = (f: { owner: number; role: string }, i: number, base: number) => h('div', { class: `os-frame o-${owner(f.owner)}`, title: `${hex(base + i * 4096, 5)}: ${f.role}` },
    h('b', null, f.owner === 2 ? 'K' : f.owner >= 0 ? PROC_NAMES[f.owner] : ''), h('span', null, hex(base + i * 4096)), h('span', { class: 'r' }, f.role.replace('kernel: variables, process control blocks', 'kernel data').replace('process ', '')));
  const table = (p: number) => h('table', { class: 'data os-map' },
    h('caption', null, `Process ${PROC_NAMES[p]}: satp = ${hex(plan.satp[p], 8)}, root table at ${hex((plan.satp[p] & 0x3fffff) * 4096)}`),
    h('tr', null, ...['virtual', 'entry', 'flags', 'physical', 'what'].map((t) => h('th', null, t))),
    ...plan.maps[p].map((r) => h('tr', null, h('td', null, hex(r.va, 4)), h('td', null, hex(r.pte, 8)), h('td', null, h('code', null, r.flags)), h('td', null, hex(r.pa, 4)), h('td', null, r.what))));
  const el = h('div', { class: 'widget vm-widget os-widget' },
    h('div', { class: 'sub' }, 'Data memory, 16 frames of 4 KiB, as the kernel has set them up when it is about to run the first process:'),
    h('div', { class: 'os-frames' }, ...plan.dataFrames.map((f, i) => frame(f, i, 0))),
    h('div', { class: 'sub' }, 'Instruction ROM, 4 frames:'),
    h('div', { class: 'os-frames rom' }, ...plan.romFrames.map((f, i) => frame(f, i, 0))),
    h('div', { class: 'os-legend' }, ...[['k', 'kernel'], ['a', 'process A'], ['b', 'process B'], ['free', 'unused']].map(([c, l]) => h('span', null, h('i', { class: `os-frame o-${c}` }), l))),
    h('div', { class: 'os-maps' }, table(0), table(1)),
    h('p', { class: 'sub' }, 'Both processes use the same virtual addresses and none of the same physical ones. The kernel never appears in their frames except the one entry with U = 0 (flags without a U): they can see its address and may not touch it. These tables are read from memory after the kernel\'s boot code ran on the golden model, not drawn.'));
  return { el };
}

// ---- step 4: the context switch, instruction by instruction -------------------------------------------------------------------

const PHASES: Record<SwitchFrame['phase'], string> = {
  save: 'Save: every register of the process that was running goes into its control block',
  choose: 'Choose: find the next ready process, give it a fresh slice',
  restore: 'Restore: its satp, then its registers out of its control block, then mret',
  user: 'The other process runs',
};

export function switchWidget(): Widget {
  const frames = captureSwitch(osImage(sharePair()));
  let at = 0, timer: number | null = null;
  const view = h('div', { class: 'os-sw' });
  const slider = h('input', { type: 'range', min: '0', max: String(frames.length - 1), value: '0', 'aria-label': 'instruction of the switch' }) as HTMLInputElement;
  const play = h('button', { type: 'button', class: 'btn sm primary' }, 'Play');
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } play.textContent = 'Play'; };
  const go = (n: number) => { at = Math.max(0, Math.min(frames.length - 1, n)); slider.value = String(at); draw(); };
  play.addEventListener('click', () => {
    if (timer !== null) { stop(); return; }
    if (at >= frames.length - 1) go(0);
    play.textContent = 'Pause';
    timer = window.setInterval(() => { if (at >= frames.length - 1) stop(); else go(at + 1); }, 60);
  });
  slider.addEventListener('input', () => { stop(); go(Number(slider.value)); });
  const grid = (title: string, words: number[], hot: number, cls: string) => h('div', { class: `os-rf ${cls}` }, h('h5', null, title),
    h('div', { class: 'os-cells' }, ...words.map((v, i) => i === 0 && cls !== 'cpu' ? h('div', { class: `os-cell pc${hot === i ? ' hot' : ''}` }, h('span', null, 'pc'), h('code', null, v ? hex(v) : '·'))
      : i === 0 ? null : h('div', { class: `os-cell${hot === i ? ' hot' : ''}${v ? ' nz' : ''}` }, h('span', null, REGS[i]), h('code', null, v ? hex(v) : '·')))));
  const draw = () => {
    const f = frames[at];
    const hotCpu = f.wrote, hotA = f.stored && f.stored[0] === 0 ? f.stored[1] : -1, hotB = f.stored && f.stored[0] === 1 ? f.stored[1] : -1;
    view.replaceChildren(
      h('div', { class: `os-now ph-${f.phase}` }, h('code', null, `${hex(f.pc, 4)}  ${f.text}`), h('span', null, PHASES[f.phase]),
        h('b', null, `cycle ${f.i + 1} of ${frames.length} · ${f.cycles} clock ${f.cycles === 1 ? 'cycle' : 'cycles'} since the interrupt`)),
      h('div', { class: 'os-rfs' }, grid('Process A\'s control block', f.pcb[0], hotA, 'a'), grid('The CPU\'s registers', f.regs, hotCpu, 'cpu'), grid('Process B\'s control block', f.pcb[1], hotB, 'b')));
  };
  const last = frames[frames.length - 1];
  const el = h('div', { class: 'widget vm-widget os-widget' },
    h('div', { class: 'rb-ctl' }, play, h('button', { type: 'button', class: 'btn sm', onclick: () => { stop(); go(at - 1); } }, 'Back'), h('button', { type: 'button', class: 'btn sm', onclick: () => { stop(); go(at + 1); } }, 'Step'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { stop(); go(0); } }, 'Restart'), slider),
    view,
    h('p', { class: 'sub' }, `One switch from process A to process B, taken from the golden model running the kernel of this chapter: ${frames.length} cycles of work and ${last.cycles - frames.length} of waiting for a page-table walk: ${last.cycles} clock cycles from the interrupt to the first instruction of B.`));
  go(0);
  return { el, destroy: stop };
}

// ---- step 7: what sharing costs --------------------------------------------------------------------------------------------------

export const SLICES = [100, 200, 400, 800, 1600, 3200, 6400, 12800];
export const OVERHEAD_STEPS = 40000;
export const spinnerImage = (slice: number): OsImage => osImage([spinner2, spinner2], { slice });
let table: Overhead[] | undefined;
export const overheadTable = (): Overhead[] => (table ??= SLICES.map((s) => overheadAt(s, OVERHEAD_STEPS, spinnerImage)));

export function sliceWidget(): Widget {
  const rows = overheadTable();
  const sw = captureSwitch(osImage(sharePair()));
  const switchCycles = sw[sw.length - 1].cycles;
  let pick = 3;
  const out = h('div', null);
  const draw = () => {
    const r = rows[pick];
    out.replaceChildren(
      h('table', { class: 'data os-cost' },
        h('tr', null, ...['slice', 'switches in 40 000 instructions', 'kernel', 'walks', 'sharing costs'].map((t) => h('th', null, t))),
        ...rows.map((x, i) => h('tr', { class: i === pick ? 'sel' : '', onclick: () => { pick = i; draw(); } },
          h('td', null, `${x.slice} instr.`), h('td', null, String(x.switches)), h('td', null, `${x.kernel}`), h('td', null, `${x.walk}`),
          h('td', null, h('span', { class: 'os-bar' }, h('i', { style: `width:${Math.min(100, Math.round(100 * x.overhead))}%` })), ` ${(100 * x.overhead).toFixed(1)} %`)))),
      h('p', { class: 'sub' }, `With a slice of ${r.slice} instructions the CPU spends ${(100 * r.overhead).toFixed(1)} % of its cycles in the kernel and in page-table walks, and a process that is ready may wait up to ${r.slice} + ${switchCycles} cycles for its turn. A longer slice wastes less and answers slower.`));
  };
  const el = h('div', { class: 'widget vm-widget os-widget' }, out,
    h('p', { class: 'sub' }, 'Two processes that only compute, run for 40 000 retired instructions on the golden model; "kernel" counts the cycles in machine mode after the boot, "walks" the stall cycles of the TLB refills after each satp write.'));
  draw();
  return { el };
}
