// The Memory chapter's core plane, wired: the gate-level 16 x 4 core store (lib/coremem.ts) on the stage, and its panel. The panel
// starts read and write cycles (the hidden addr / din / we / go inputs), clocks one phase at a time, and reads every core's bit from
// its leaf, so the learner sees a read empty the word and the write put it back.

import { CORE_PLANES, CORE_WORDS, coreName, coreStore } from '../lib/coremem';
import { isCoreState } from '../sim/core';
import { findNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

/** The words the step's store powers on holding (word 6, row 1 column 2, holds 1011: three planes switch when it is read). */
export const CORE_SAMPLE: readonly number[] = [0x3, 0x0, 0x9, 0x5, 0xc, 0x1, 0xb, 0x6, 0x0, 0xe, 0x2, 0x7, 0x4, 0xf, 0x8, 0xa];

/** The store's phases, as its phase output counts them (bit 0 READ, bit 1 WRITE). */
export const PHASE_NAMES = ['IDLE', 'READ', 'WRITE'] as const;

/** What the panel and a challenge read off the circuit now. */
export interface CoreView {
  /** 0 idle, 1 READ, 2 WRITE. */
  phase: number;
  /** The address register (the word being cycled). */
  addr: number;
  /** The buffer register. */
  buf: number;
  /** Every word as its cores hold it (-1 where a core is unknown). */
  words: number[];
  /** Each plane's sense line now (bit p = plane p). */
  sense: number;
  /** Each plane's inhibit wire now. */
  inhibit: number;
  /** The inhibit drivers' switch (the hidden input inhOn). */
  inhOn: boolean;
}

/** The store's state read from a stage showing it. */
export function coreView(stage: Stage): CoreView | null {
  const sim = stage.sim;
  if (!sim) return null;
  const root = sim.design.root;
  if (!root.ports.phase || !root.ports.addr) return null;
  const q = (path: string[], port = 'q') => { const n = findNode(root, path); return n ? pack(sim.getBits(n.ports[port])) : -1; };
  const words = Array.from({ length: CORE_WORDS }, (_, a) => {
    let w = 0;
    for (let p = 0; p < CORE_PLANES; p++) {
      const n = findNode(root, [`p${p}`, coreName(a >> 2, a & 3)]);
      const st = n?.leafIndex === undefined ? undefined : sim.leafState(n.leafIndex);
      const b = isCoreState(st) ? st.b : -1;
      if (b < 0) return -1;
      w |= b << p;
    }
    return w;
  });
  let addr = 0, buf = 0, sense = 0, inhibit = 0;
  for (let i = 0; i < 4; i++) addr |= Math.max(0, q([`a${i}`])) << i;
  for (let p = 0; p < CORE_PLANES; p++) {
    buf |= Math.max(0, q([`buf${p}`])) << p;
    sense |= Math.max(0, q([`p${p}`], 's')) << p;
    inhibit |= Math.max(0, q([`inh${p}`], 'y')) << p;
  }
  return { phase: pack(sim.getBits(root.ports.phase)), addr, buf, words, sense, inhibit, inhOn: sim.getInput('inhOn') === 1 };
}

const bits4 = (v: number) => (v < 0 ? 'xxxx' : v.toString(2).padStart(4, '0'));
const planesOf = (mask: number) => Array.from({ length: CORE_PLANES }, (_, p) => p).filter((p) => mask >> p & 1);
const list = (ps: number[]) => (ps.length ? ps.map((p) => `plane ${p}`).join(', ') : 'none');

/** The word the last READ took out of the cores (its address and value), while WRITE has yet to put it back. */
const takenBy = new WeakMap<Stage, () => { addr: number; word: number } | null>();
export const coreTaken = (st: Stage) => takenBy.get(st)?.() ?? null;

/** The actions a challenge's solve uses: start a cycle, clock a phase. */
const actions = new WeakMap<Stage, { start: (addr: number, we: boolean, din?: number) => void; phase: () => void; finish: () => void; inhibit: (on: boolean) => void }>();
export const coreActions = (st: Stage) => actions.get(st);

export interface CoreSceneOptions {
  /** Open this deep (e.g. ['p0']: plane 0's cores). */
  path?: string[];
  highlight?: string[];
}

export function coreScene(o: CoreSceneOptions = {}): Scene {
  return {
    root: coreStore(CORE_SAMPLE),
    inputs: { addr: 6, din: 0, we: 0, go: 0, inhOn: 1, clk: 0 },
    hiddenInputs: ['addr', 'din', 'we', 'go', 'inhOn'],
    autoClock: false,
    memory: false,
    path: o.path,
    highlight: o.highlight,
    panels: [corePanel()],
  };
}

function corePanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const sim = () => stage.sim!;
    let sel = 6, data = 0b0101;
    /** The word a READ took out, kept while WRITE puts it back (the panel's "read out" mark). */
    let taken: { addr: number; word: number } | null = null;
    const hook = {
      before: () => {
        const v = coreView(stage);
        if (v?.phase === 1) taken = { addr: v.addr, word: v.words[v.addr] };
        else if (v?.phase === 2) taken = null;
      },
    };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({ save: () => taken && { ...taken }, restore: (s) => { taken = s ? { ...(s as { addr: number; word: number }) } : null; } });

    const start = (addr: number, we: boolean, din = data) => {
      const v = coreView(stage);
      if (!v || v.phase) return;
      stage.checkpoint();
      sim().setInput('addr', addr);
      sim().setInput('din', din);
      sim().setInput('we', +we);
      sim().setInput('go', 1);
      sim().settle();
      stage.runCycles(1);
      sim().setInput('go', 0);
      sim().settle();
      stage.refresh();
    };
    const phase = () => { stage.checkpoint(); stage.runCycles(1); stage.refresh(); };
    const finish = () => { stage.checkpoint(); stage.runCycles(3, () => coreView(stage)?.phase === 0); stage.refresh(); };
    const inhibit = (on: boolean) => { stage.checkpoint(); sim().setInput('inhOn', +on); sim().settle(); stage.refresh(); };
    actions.set(stage, { start, phase, finish, inhibit });
    takenBy.set(stage, () => taken);

    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => {
      const b = h('button', { class: cls, title }, label);
      b.addEventListener('click', f);
      return b;
    };
    const addrSel = h('select', { class: 'mc-sel', 'aria-label': 'Word' }) as HTMLSelectElement;
    for (let a = 0; a < CORE_WORDS; a++) addrSel.append(h('option', { value: String(a) }, `word ${a}: row ${a >> 2}, column ${a & 3}`));
    addrSel.value = String(sel);
    addrSel.addEventListener('change', () => { sel = Number(addrSel.value); update(); });
    const dataBits = Array.from({ length: CORE_PLANES }, (_, i) => {
      const p = CORE_PLANES - 1 - i;
      const b = h('button', { class: 'btn sm core-bit', 'aria-label': `Data bit ${p}`, title: `Bit ${p}: plane ${p}` }, '0');
      b.addEventListener('click', () => { data ^= 1 << p; update(); });
      return { p, b };
    });
    const inh = h('input', { type: 'checkbox', 'aria-label': 'Inhibit drivers on' }) as HTMLInputElement;
    inh.addEventListener('change', () => inhibit(inh.checked));
    const readB = btn('Read', 'Start a read cycle of this word: READ, then WRITE puts it back', () => start(sel, false), 'btn sm primary');
    const writeB = btn('Write', 'Start a write cycle: READ empties the word, WRITE puts the data in', () => start(sel, true));
    const nextB = btn('Next phase', 'One clock edge: end this phase', phase);
    const endB = btn('Finish', 'Clock to the end of the cycle', finish);
    const status = h('div', { class: 'mc-status core-status' });
    const say = h('p', { class: 'core-say' });
    const grid = h('div', { class: 'core-words' });
    const el = h('div', { class: 'mem-panel cpu-panel core-panel', 'data-dock': 'right' },
      h('h4', null, 'Core store', h('span', { class: 'fold-hint' })),
      h('div', { class: 'mc-row' }, addrSel),
      h('div', { class: 'mc-row' }, h('span', null, 'data'), ...dataBits.map((d) => d.b), h('label', { class: 'core-inh' }, inh, ' inhibit drivers on')),
      h('div', { class: 'dram-ops' }, readB, writeB, nextB, endB),
      status, say,
      h('div', { class: 'cpu-sec' }, 'The words, as the cores hold them'), grid);

    const update = () => {
      const v = coreView(stage);
      if (!v) return;
      for (const d of dataBits) d.b.textContent = String(data >> d.p & 1);
      inh.checked = v.inhOn;
      for (const b of [readB, writeB]) b.disabled = v.phase !== 0;
      for (const b of [nextB, endB]) b.disabled = v.phase === 0;
      status.replaceChildren(
        h('span', null, 'phase ', h('b', null, PHASE_NAMES[v.phase] ?? '?')),
        h('span', null, 'word ', h('b', null, String(v.addr))),
        h('span', null, 'buffer ', h('b', null, bits4(v.buf))));
      const r = v.addr >> 2, c = v.addr & 3;
      say.textContent = v.phase === 1
        ? `READ: row ${r}'s X wire and column ${c}'s Y wire each carry a read half. Word ${v.addr}'s cores see two halves and switch to 0; the other cores on those lines see one and hold. Sense wires pulsing: ${list(planesOf(v.sense))} (the planes where it held a 1). The edge that ends READ strobes them into the buffer.`
        : v.phase === 2
          ? `WRITE: write halves on the same two wires. ${!v.inhOn ? 'The inhibit drivers are off, so every core of the word sees two halves and switches to 1, whatever the buffer holds.'
            : v.inhibit ? `The inhibit carries a half the other way in ${list(planesOf(v.inhibit))} (a 0 in the buffer), so those cores see one half and stay 0; the others switch to 1.`
              : 'The buffer holds no 0, so no inhibit wire carries current and every core of the word switches to 1.'} A core switching to 1 pulses its sense wire too, the other way; nothing strobes it.`
          : 'Idle: no current in any wire. Pick a word and Read it, or set the data and Write.';
      grid.replaceChildren(...v.words.map((w, a) => {
        const out = taken?.addr === a && v.phase === 2;
        return h('div', { class: `core-word${a === (v.phase ? v.addr : sel) ? ' cur' : ''}${out ? ' out' : ''}` },
          h('span', null, String(a)), h('b', null, bits4(w)),
          h('span', { class: 'sub' }, out ? `read out: ${bits4(taken!.word)} is in the buffer` : ''));
      }));
    };
    update();
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); actions.delete(stage); takenBy.delete(stage); } };
  };
}
