// Chapter 35's panels. The bus bench: a request port (standing in for the CPU) and the DMA engine on one
// bus to RAM, flash and the DMA's registers; the panel makes reads, writes and a DMA copy, and draws
// every cycle's handshakes and who holds the bus. The computer: the system CPU on that bus, booting
// from flash; the panel runs it and shows its console, LEDs and where it executes.

import { LOAD_AT, LOAD_WORDS } from '../bus/programs';
import { busBench } from '../lib/axi';
import { ramLeafState } from '../lib/bigmem';
import { CHAPTER_COMPUTER } from '../lib/soc';
import { findNode, type HierNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { frameRun } from './slowctl';

/** The bench's flash: recognizable words (0xF1A5_00nn). */
export const BENCH_IMAGE = Array.from({ length: 64 }, (_, i) => (0xf1a50000 + i) >>> 0);

interface Txn { op: string; addr: number; data: number; cycles: number }
interface Cyc { cpu: string; dma: string; grant: string; slave: string; done: boolean }
interface BenchState { txns: Txn[]; trace: Cyc[]; cycles: number }
const benchStates = new WeakMap<Stage, BenchState>();
export const busBenchState = (st: Stage) => benchStates.get(st);
const benchActs = new WeakMap<Stage, { access(we: boolean, addr: number, data?: number): Txn; dmaCopy(src: number, dst: number, n: number): void; runUntilIrq(): void }>();
export const busBenchActions = (st: Stage) => benchActs.get(st);

export function busBenchScene(wait = 0): Scene {
  return {
    root: busBench(BENCH_IMAGE, 10, wait),
    inputs: { req: 0, we: 0, addr: 0, wdata: 0, be: 15, clk: 0 },
    hiddenInputs: ['req', 'we', 'addr', 'wdata', 'be'],
    autoClock: false,
    panels: [busBenchPanel(wait)],
  };
}

const hex = (v: number, n = 8) => `0x${(v >>> 0).toString(16).padStart(n, '0')}`;
const TRACE = 40;
const ADDRS: [string, number][] = [
  ['RAM 0x040', 0x40], ['RAM 0x100', 0x100], ['flash 0x1000_0000', 0x10000000], ['flash 0x1000_0004', 0x10000004],
  ['flash 0x1000_0040', 0x10000040], ['DMA status', 0x4000000c], ['nothing there', 0x70000000],
];

/** The net named `name` inside `node` (its first bit). */
function netIn(node: HierNode | null, name: string): number {
  const i = node?.def.netlist?.().nets.findIndex((n) => n.name === name) ?? -1;
  return i < 0 || !node?.nets ? -1 : node.nets[i][0];
}

function busBenchPanel(wait: number): ScenePanel {
  return (stage: Stage): Widget => {
    const sim = () => stage.sim!;
    const root = () => sim().design.root;
    const out = (p: string) => pack(sim().getBits(root().ports[p]));
    const node = (path: string[]) => findNode(root(), path);
    const bit = (n: number) => (n < 0 ? 0 : sim().getBits([n])[0] === 1 ? 1 : 0);
    const port = (path: string[], p: string) => { const n = node(path); return n ? pack(sim().getBits(n.ports[p])) : 0; };
    const st: BenchState = { txns: [], trace: [], cycles: 0 };
    benchStates.set(stage, st);
    let sel = 0, data = 0x12345678;
    const hook = {
      before: () => {
        const bus = node(['bus']);
        const cpu = port(['cpu'], 'awvalid') ? 'W' : port(['cpu'], 'arvalid') ? 'R' : port(['cpu'], 'done') ? '✓' : '';
        const dma = port(['dma'], 'm_awvalid') ? 'W' : port(['dma'], 'm_arvalid') ? 'R' : '';
        const g0 = bit(netIn(bus, 'grant0')), g1 = bit(netIn(bus, 'grant1')), busy = bit(netIn(bus, 'busy'));
        const grant = !busy && !(cpu || dma) ? '' : g0 ? 'CPU' : g1 ? 'DMA' : '';
        const s = ['RAM', 'flash', 'DMA', 'none'].find((_, k) => bit(netIn(bus, `sel${k}`)) && (busy || cpu || dma)) ?? '';
        st.trace.push({ cpu, dma, grant, slave: s, done: out('done') === 1 });
        if (st.trace.length > TRACE) st.trace.shift();
        st.cycles++;
      },
    };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({
      save: () => ({ txns: st.txns.map((t) => ({ ...t })), trace: st.trace.map((c) => ({ ...c })), cycles: st.cycles }),
      restore: (v) => { const x = v as BenchState; st.txns = x.txns.map((t) => ({ ...t })); st.trace = x.trace.map((c) => ({ ...c })); st.cycles = x.cycles; },
    });
    /** A load or store as the CPU makes it: request until done. */
    const access = (we: boolean, addr: number, d = 0): Txn => {
      const s = sim();
      s.setInput('addr', addr); s.setInput('we', +we); s.setInput('wdata', d >>> 0); s.setInput('be', 15); s.setInput('req', 1);
      s.settle();
      let doneSeen = false, value = 0;
      const start = st.cycles;
      stage.runCycles(4000, () => {
        if (doneSeen) return true;
        if (out('done') === 1) { doneSeen = true; value = out('rdata') >>> 0; }
        return false;
      });
      s.setInput('req', 0);
      s.settle();
      const t = { op: we ? 'write' : 'read', addr, data: we ? d : value, cycles: st.cycles - start };
      st.txns.push(t);
      if (st.txns.length > 8) st.txns.shift();
      return t;
    };
    const dmaCopy = (src: number, dst: number, n: number) => {
      access(true, 0x40000000, src); access(true, 0x40000004, dst); access(true, 0x40000008, n); access(true, 0x4000000c, 1);
    };
    const runUntilIrq = () => { stage.runCycles(20000, () => port(['dma'], 'irq') === 1); };
    benchActs.set(stage, { access, dmaCopy, runUntilIrq });
    const op = (f: () => void) => () => { stage.checkpoint(); f(); stage.refresh(); };

    const addrSel = h('select', { class: 'mc-sel', 'aria-label': 'Address' }) as HTMLSelectElement;
    ADDRS.forEach(([l], i) => addrSel.append(h('option', { value: String(i) }, l)));
    addrSel.addEventListener('change', () => { sel = Number(addrSel.value); });
    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title }, label); b.addEventListener('click', f); return b; };
    const status = h('div', { class: 'mc-status' });
    const wave = h('div', { class: 'bus-wave' });
    const txns = h('div', { class: 'mc-reqs' });
    const ram = h('div', { class: 'bus-ram' });
    const title = h('h4', null, `The bus${wait ? `: RAM with ${wait} wait states` : ''}`, h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel bus-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
      h('div', { class: 'mc-row' }, addrSel),
      h('div', { class: 'dram-ops' },
        btn('Read', 'A load from the address: AR, then R', op(() => access(false, ADDRS[sel][1])), 'btn sm primary'),
        btn('Write', 'A store to the address: AW + W, then B', op(() => { access(true, ADDRS[sel][1], data); data = (data + 0x11111111) >>> 0; })),
        btn('DMA: flash → RAM', `Program the DMA to copy ${LOAD_WORDS} words from 0x1000_0000 to ${hex(0x100, 3)}, and start it`, op(() => dmaCopy(0x10000000, 0x100, LOAD_WORDS))),
        btn('Run until irq', 'Clock until the DMA raises its interrupt', op(runUntilIrq)),
        btn('Clock 10', 'Ten cycles with no request from the CPU', op(() => stage.runCycles(10)))),
      status, h('div', { class: 'cpu-sec' }, `Every cycle, the last ${TRACE}`), wave, h('div', { class: 'cpu-sec' }, 'Transactions'), txns, h('div', { class: 'cpu-sec' }, 'RAM from 0x100'), ram);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));

    const update = () => {
      const dmaBusy = port(['dma'], 'busy') === 1, irq = port(['dma'], 'irq') === 1;
      status.replaceChildren(h('span', null, `${st.cycles} cycles`), h('span', null, 'DMA ', h('b', null, dmaBusy ? 'copying' : irq ? 'done (irq)' : 'idle')));
      const row = (label: string, f: (c: Cyc) => string, cls: (c: Cyc) => string) => h('div', { class: 'bus-row' }, h('span', { class: 'lbl' }, label), ...st.trace.map((c) => h('span', { class: `bus-c ${cls(c)}` }, f(c))));
      wave.replaceChildren(
        row('CPU', (c) => c.cpu, (c) => (c.cpu === 'W' ? 'w' : c.cpu === 'R' ? 'r' : c.cpu ? 'ok' : '')),
        row('DMA', (c) => c.dma, (c) => (c.dma === 'W' ? 'w' : c.dma === 'R' ? 'r' : '')),
        row('bus', (c) => (c.grant ? c.grant[0] : ''), (c) => (c.grant === 'CPU' ? 'gc' : c.grant === 'DMA' ? 'gd' : '')),
        row('slave', (c) => (c.slave ? c.slave[0].toUpperCase() : ''), (c) => (c.slave ? 'sl' : '')),
      );
      txns.replaceChildren(...st.txns.slice().reverse().map((t) => h('div', { class: 'mc-req' }, h('span', null, `${t.op} ${hex(t.addr)}`), h('span', { class: 'mono' }, hex(t.data)), h('b', null, `${t.cycles} cycles`))));
      if (!st.txns.length) txns.append(h('div', { class: 'sub' }, 'Pick an address and read it.'));
      const lanes = [0, 1, 2, 3].map((i) => ramLeafState(sim(), node(['ram', `lane${i}`]) ?? undefined));
      ram.replaceChildren(...Array.from({ length: 8 }, (_, i) => {
        const a = 0x100 / 4 + i, v = lanes.every(Boolean) ? (lanes[0]!.mem[a] | (lanes[1]!.mem[a] << 8) | (lanes[2]!.mem[a] << 16) | (lanes[3]!.mem[a] << 24)) >>> 0 : 0;
        return h('span', { class: 'mono' }, hex(v));
      }));
    };
    update();
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); benchStates.delete(stage); benchActs.delete(stage); } };
  };
}

export function busComputerScene(): Scene {
  return {
    root: CHAPTER_COMPUTER,
    inputs: { clk: 0, switches: 0 },
    hiddenInputs: ['switches'],
    autoClock: false,
    panels: [computerPanel],
  };
}

interface CompState { console: string; retired: number; cycles: number; inRam: number; dmaCycles: number }
const compStates = new WeakMap<Stage, CompState>();
export const busComputerState = (st: Stage) => compStates.get(st);

const computerPanel: ScenePanel = (stage: Stage): Widget => {
  const sim = () => stage.sim!;
  const out = (p: string) => pack(sim().getBits(sim().design.root.ports[p]));
  const st: CompState = { console: '', retired: 0, cycles: 0, inRam: 0, dmaCycles: 0 };
  compStates.set(stage, st);
  const hook = {
    before: () => {
      st.cycles++;
      if (out('retire') === 1) { st.retired++; if ((out('pcOut') >>> 0) >= 0x200) st.inRam++; }
      if (out('dmaBusy') === 1) st.dmaCycles++;
      if (out('consoleValid') === 1) st.console += String.fromCharCode(out('consoleData'));
    },
  };
  stage.edgeHooks.add(hook);
  stage.historyHooks.add({ save: () => ({ ...st }), restore: (v) => Object.assign(st, v as CompState) });
  let stop: (() => void) | null = null;
  const runBtn = h('button', { class: 'btn sm primary', title: 'Run the computer (Pause to stop)' }, 'Run');
  runBtn.addEventListener('click', () => {
    if (stop) { stop(); return; }
    stage.checkpoint();
    runBtn.textContent = 'Pause';
    stop = frameRun(stage, () => false, () => { stop = null; runBtn.textContent = 'Run'; stage.refresh(); });
  });
  const step = h('button', { class: 'btn sm', title: 'Run to the next printed character, or 2 000 cycles' }, 'Run to output');
  step.addEventListener('click', () => {
    stage.checkpoint();
    const n = st.console.length;
    stage.runCycles(2000, () => st.console.length > n);
    stage.refresh();
  });
  const status = h('div', { class: 'mc-status' });
  const con = h('pre', { class: 'bus-console' });
  const leds = h('div', { class: 'bus-leds' });
  const title = h('h4', null, 'Computer on a bus', h('span', { class: 'fold-hint' }));
  const map = h('div', { class: 'bus-map' },
    ...[['0x0000_0000', `boot ROM (fetch only), ${0x200} bytes`], ['0x0000_0000 …', 'RAM: code above the ROM, and every load and store'], ['0x1000_0000', 'flash (read only): the program to load'],
      ['0x4000_0000', 'DMA: source, destination, length, control'], ['0x8000_0000', 'console, LEDs, switches, timer (inside the CPU)']].map(([a, d]) => h('div', null, h('span', null, a), h('span', null, d))));
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel bus-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
    h('div', { class: 'dram-ops' }, runBtn, step), status, h('div', { class: 'cpu-sec' }, 'Console'), con, h('div', { class: 'cpu-sec' }, 'LEDs'), leds, h('div', { class: 'cpu-sec' }, 'Memory map'), map);
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
  const update = () => {
    const pc = out('pcOut') >>> 0;
    status.replaceChildren(h('span', null, 'PC ', h('b', null, hex(pc)), pc < 0x200 ? ' (boot ROM)' : ' (RAM)'),
      h('span', null, `${st.cycles} cycles · ${st.retired} instructions (${st.inRam} from RAM)`),
      h('span', null, `DMA busy ${st.dmaCycles} cycles`), h('span', null, `loaded at ${hex(LOAD_AT, 3)}`));
    con.textContent = st.console || '(nothing yet)';
    const v = out('leds');
    leds.replaceChildren(...Array.from({ length: 8 }, (_, i) => h('span', { class: `bus-led${(v >> (7 - i)) & 1 ? ' on' : ''}` })));
  };
  update();
  return { el, update, destroy: () => { stop?.(); stage.edgeHooks.delete(hook); compStates.delete(stage); } };
};
