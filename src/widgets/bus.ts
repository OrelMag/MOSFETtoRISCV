// Chapter 36's panels. The bus bench: a request port (standing in for the CPU) and the DMA engine on one
// bus to RAM, flash and the DMA's registers; the panel makes reads, writes and a DMA copy, and draws
// every cycle's handshakes and who holds the bus. The computer: the system CPU on that bus, booting
// from flash (or from punched cards); the panel runs it and shows its console, LEDs and where it executes.

import { LOAD_AT, LOAD_WORDS } from '../bus/programs';
import { busBench, isKeyQueue, KEY_QUEUE_DEPTH } from '../lib/axi';
import { ramLeafState } from '../lib/bigmem';
import { CARD_COMPUTER, CARD_DECK, CHAPTER_COMPUTER, SOC_SCREEN, SYSTEM_COMPUTER } from '../lib/soc';
import { type CardReaderState, readerProgress } from '../cards/reader';
import { findNode } from '../sim/flatten';
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

function busBenchPanel(wait: number): ScenePanel {
  return (stage: Stage): Widget => {
    const sim = () => stage.sim!;
    const root = () => sim().design.root;
    const out = (p: string) => pack(sim().getBits(root().ports[p]));
    const node = (path: string[]) => findNode(root(), path);
    const port = (path: string[], p: string) => { const n = node(path); return n ? pack(sim().getBits(n.ports[p])) : 0; };
    const st: BenchState = { txns: [], trace: [], cycles: 0 };
    benchStates.set(stage, st);
    let sel = 0, data = 0x12345678;
    const hook = {
      before: () => {
        const cpu = port(['cpu'], 'awvalid') ? 'W' : port(['cpu'], 'arvalid') ? 'R' : port(['cpu'], 'done') ? '✓' : '';
        const dma = port(['dma'], 'm_awvalid') ? 'W' : port(['dma'], 'm_arvalid') ? 'R' : '';
        const g0 = port(['bus', 'grant'], 'grant0'), g1 = port(['bus', 'grant'], 'grant1'), busy = port(['bus', 'grant'], 'busy');
        const grant = !busy && !(cpu || dma) ? '' : g0 ? 'CPU' : g1 ? 'DMA' : '';
        const s = ['RAM', 'flash', 'DMA', 'none'].find((_, k) => port(['bus', 'dec'], `sel${k}`) === 1 && (busy || cpu || dma)) ?? '';
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
    engine: 'cycle',
    panels: [computerPanel(false)],
  };
}

/** The computer booting from punched cards: the card boot ROM, the reader holding CARD_DECK at 0x7000_0000. */
export function cardComputerScene(): Scene {
  return {
    root: CARD_COMPUTER,
    inputs: { clk: 0, switches: 0 },
    hiddenInputs: ['switches'],
    autoClock: false,
    engine: 'cycle',
    panels: [computerPanel(false, true)],
  };
}

/** The last step's computer: DRAM, screen and keyboard on the bus too. Both computers run on the cycle engine. */
export function systemComputerScene(): Scene {
  return {
    root: SYSTEM_COMPUTER,
    inputs: { clk: 0, switches: 0 },
    hiddenInputs: ['switches'],
    autoClock: false,
    engine: 'cycle',
    panels: [computerPanel(true)],
  };
}

interface CompState { console: string; retired: number; cycles: number; inRam: number; dmaCycles: number; booted: number; dram: { hit: number; miss: number; conflict: number; refresh: number } }
const compStates = new WeakMap<Stage, CompState>();
export const busComputerState = (st: Stage) => compStates.get(st);
const compActs = new WeakMap<Stage, { type(text: string): void; run(cycles: number, until?: () => boolean): void }>();
/** Type into the computer's keyboard, and run it (the last step's challenge). */
export const busComputerActions = (st: Stage) => compActs.get(st);

/** An RGB332 byte as red, green, blue. */
const rgb332 = (v: number): [number, number, number] => [Math.round(((v >> 5) & 7) * 255 / 7), Math.round(((v >> 2) & 7) * 255 / 7), Math.round((v & 3) * 255 / 3)];

/** A key as the keyboard sends it (ASCII; Enter 10, Backspace 8), or null. */
const keyCode = (e: KeyboardEvent): number | null => (e.key === 'Enter' ? 10 : e.key === 'Backspace' ? 8 : e.key.length === 1 && e.key.charCodeAt(0) < 128 ? e.key.charCodeAt(0) : null);

const computerPanel = (full: boolean, cards = false): ScenePanel => (stage: Stage): Widget => {
  const sim = () => stage.sim!;
  const root = () => sim().design.root;
  const out = (p: string) => pack(sim().getBits(root().ports[p]));
  const node = (path: string[]) => findNode(root(), path);
  const port = (path: string[], p: string) => { const n = node(path); return n ? pack(sim().getBits(n.ports[p])) : 0; };
  const st: CompState = { console: '', retired: 0, cycles: 0, inRam: 0, dmaCycles: 0, booted: -1, dram: { hit: 0, miss: 0, conflict: 0, refresh: 0 } };
  compStates.set(stage, st);
  const hook = {
    before: () => {
      st.cycles++;
      if (out('retire') === 1) { st.retired++; if ((out('pcOut') >>> 0) >= 0x200) st.inRam++; }
      if (st.booted < 0 && (out('pcOut') >>> 0) === LOAD_AT) st.booted = st.cycles - 1;
      if (out('dmaBusy') === 1) st.dmaCycles++;
      if (out('consoleValid') === 1) st.console += String.fromCharCode(out('consoleData'));
      if (full) {
        const d = st.dram, c = ['dram', 'ctrl'];
        if (port(c, 'hit') === 1) d.hit++;
        else if (port(c, 'miss') === 1) d.miss++;
        else if (port(c, 'conflict') === 1) d.conflict++;
        if (port(c, 'cmd') === 6) d.refresh++;
      }
    },
  };
  stage.edgeHooks.add(hook);
  stage.historyHooks.add({ save: () => ({ ...st, dram: { ...st.dram } }), restore: (v) => { const x = v as CompState; Object.assign(st, x, { dram: { ...x.dram } }); } });
  // ---- the keyboard: typed keys go into its queue (the KEY_QUEUE leaf's state, through Sim.poke)
  const kbdLeaf = () => node(['kbd'])?.leafIndex;
  const waiting = (): number[] => { const li = kbdLeaf(), s = li === undefined ? null : sim().leafState(li); return isKeyQueue(s) ? s.q : []; };
  const press = (code: number) => {
    const li = kbdLeaf(), s = li === undefined ? null : sim().leafState(li);
    if (li === undefined || !isKeyQueue(s) || s.q.length >= KEY_QUEUE_DEPTH) return;
    sim().poke(li, { ...s, q: [...s.q, code] });
  };
  let stop: (() => void) | null = null;
  const runBtn = h('button', { class: 'btn sm primary', title: 'Run the computer (Pause to stop)' }, 'Run');
  const run = () => {
    if (stop) return;
    stage.checkpoint();
    runBtn.textContent = 'Pause';
    stop = frameRun(stage, () => false, () => { stop = null; runBtn.textContent = 'Run'; stage.refresh(); });
  };
  runBtn.addEventListener('click', () => { if (stop) stop(); else run(); });
  const step = h('button', { class: 'btn sm', title: 'Run to the next printed character, or 2 000 cycles' }, 'Run to output');
  step.addEventListener('click', () => {
    stage.checkpoint();
    const n = st.console.length;
    stage.runCycles(2000, () => st.console.length > n);
    stage.refresh();
  });
  compActs.set(stage, {
    type: (text) => { for (const c of text) press(c.charCodeAt(0)); },
    run: (cycles, until) => { stage.runCycles(cycles, until); stage.refresh(); },
  });
  const status = h('div', { class: 'mc-status' });
  const con = h('pre', { class: 'bus-console' });
  const leds = h('div', { class: 'bus-leds' });
  const title = h('h4', null, full ? 'Everything on one bus' : cards ? 'Booting from cards' : 'Computer on a bus', h('span', { class: 'fold-hint' }));
  const rows: [string, string][] = [['0x0000_0000', `boot ROM (fetch only), ${0x200} bytes`], ['0x0000_0000 …', 'RAM: code above the ROM, and every load and store'], ['0x1000_0000', cards ? 'flash (read only): empty, the program is on the cards' : 'flash (read only): the program to load'],
    ...(full ? [['0x2000_0000', 'DRAM, 16 KB (chapter 34\'s controller)'] as [string, string]] : []),
    ['0x4000_0000', 'DMA: source, destination, length, control'],
    ...(cards ? [['0x7000_0000', 'card reader: +0 status (bit 0 a card waits, bit 1 hopper empty), +4 the word on the card (taken)']] as [string, string][] : []),
    ...(full ? [['0x5000_0000', `screen: ${SOC_SCREEN} × ${SOC_SCREEN}, a byte a pixel (RGB332)`], ['0x6000_0000', 'keyboard: +0 the oldest key (taken), +4 status']] as [string, string][] : []),
    ['0x8000_0000', 'console, LEDs, switches, timer (inside the CPU)']];
  const map = h('div', { class: 'bus-map' }, ...rows.map(([a, d]) => h('div', null, h('span', null, a), h('span', null, d))));
  const parts: (Node | string)[] = [title, h('div', { class: 'dram-ops' }, runBtn, step), status];
  // ---- the card reader: where it is in the deck (the reader leaf's state)
  const reader = h('div', { class: 'mc-status' });
  const readerState = (): CardReaderState | null => { const li = node(['cards'])?.leafIndex; return li === undefined ? null : sim().leafState(li) as CardReaderState; };
  if (cards) parts.push(h('div', { class: 'cpu-sec' }, `Card reader: ${CARD_DECK.name}, ${CARD_DECK.cards.length} cards`), reader);
  // ---- the full system: screen, keyboard, DRAM counters
  let paint = () => {};
  const extra = h('div', { class: 'mc-status' });
  let typed: HTMLElement | null = null;
  if (full) {
    const canvas = h('canvas', { class: 'bus-screen', width: String(SOC_SCREEN), height: String(SOC_SCREEN), 'aria-label': 'The screen' }) as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    const img = ctx?.createImageData(SOC_SCREEN, SOC_SCREEN);
    paint = () => {
      if (!ctx || !img) return;
      const lanes = [0, 1, 2, 3].map((i) => ramLeafState(sim(), node(['screen', `lane${i}`]) ?? undefined));
      for (let p = 0; p < SOC_SCREEN * SOC_SCREEN; p++) {
        const v = lanes[p & 3]?.mem[p >> 2] ?? 0, [r, g, b] = rgb332(v);
        img.data.set([r, g, b, 255], 4 * p);
      }
      ctx.putImageData(img, 0, 0);
    };
    const input = h('input', { class: 'bus-type', type: 'text', placeholder: 'Type here (Enter too)', 'aria-label': 'Type on the computer\'s keyboard', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      const c = keyCode(e);
      if (c === null || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      press(c);
      if (!stop) run();
      update();
    });
    const hello = h('button', { class: 'btn sm', title: 'Type h, e, l, l, o and Enter, and run' }, 'Type hello⏎');
    hello.addEventListener('click', () => { for (const c of 'hello\n') press(c.charCodeAt(0)); if (!stop) run(); update(); });
    typed = h('span', { class: 'sub' });
    parts.push(h('div', { class: 'cpu-sec' }, 'Screen'), canvas, h('div', { class: 'cpu-sec' }, 'Keyboard'), h('div', { class: 'bus-keys' }, input, hello), typed, extra);
  }
  parts.push(h('div', { class: 'cpu-sec' }, 'Console'), con, h('div', { class: 'cpu-sec' }, 'LEDs'), leds, h('div', { class: 'cpu-sec' }, 'Memory map'), map);
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel bus-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, ...parts);
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
  function update() {
    const pc = out('pcOut') >>> 0;
    status.replaceChildren(h('span', null, 'PC ', h('b', null, hex(pc)), pc < 0x200 ? ' (boot ROM)' : ' (RAM)'),
      h('span', null, `${st.cycles} cycles · ${st.retired} instructions (${st.inRam} from RAM)`),
      ...(cards ? [] : [h('span', null, `DMA busy ${st.dmaCycles} cycles`)]), h('span', null, `loaded at ${hex(LOAD_AT, 3)}`),
      ...(st.booted >= 0 ? [h('span', null, `jumped there at cycle ${st.booted}`)] : []));
    if (cards) {
      const rs = readerState(), p = rs ? readerProgress(rs) : null;
      const card = p && p.at !== null ? CARD_DECK.cards[p.at] : null;
      reader.replaceChildren(
        h('span', null, p ? `${p.taken} of ${p.cards} cards read` : '(no reader)'),
        h('span', null, !p ? '' : p.at === null ? 'hopper empty' : p.feeding ? `card ${p.at + 1} feeding` : `card ${p.at + 1} at the station`),
        ...(card ? [h('span', { class: 'mono' }, card.print.slice(0, 48).trimEnd())] : []));
    }
    con.textContent = st.console || '(nothing yet)';
    const v = out('leds');
    leds.replaceChildren(...Array.from({ length: 8 }, (_, i) => h('span', { class: `bus-led${(v >> (7 - i)) & 1 ? ' on' : ''}` })));
    if (full) {
      const d = st.dram;
      extra.replaceChildren(h('span', null, 'DRAM ', h('b', null, `${d.hit} row hits`), ` · ${d.miss} closed banks · ${d.conflict} row conflicts · ${d.refresh} refreshes`));
      const q = waiting();
      typed!.textContent = q.length ? `Waiting in the keyboard: ${q.map((c) => (c === 10 ? '⏎' : String.fromCharCode(c))).join('')}` : 'No key waiting.';
      paint();
    }
  }
  update();
  return { el, update, destroy: () => { stop?.(); stage.edgeHooks.delete(hook); compStates.delete(stage); compActs.delete(stage); } };
};
