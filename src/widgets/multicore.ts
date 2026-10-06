// Chapter 24 widgets: the dual-core scene (both cores, shared memory, golden-model lock-step) and
// the cache-coherence explorer.

import { dualCore } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { cpuState } from '../riscv/cosim';
import { ABI, disasm } from '../riscv/isa';
import { MC_PROGRAMS } from '../riscv/mcprograms';
import { MultiISS } from '../riscv/multi';
import { Coherence, type CoherenceEvent, type Protocol } from '../sim/coherence';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const SHOWN = [5, 6, 7, 8, 9, 10, 11, 28];

export function dualCoreScene(source: string): Scene {
  const asm = assemble(source);
  return { root: dualCore(asm.words), inputs: { clk: 0 }, highlight: ['arb'], panels: [dualPanel(source, asm)] };
}

function dualPanel(source: string, asm: AsmResult): ScenePanel {
  return (stage: Stage): Widget => {
    let m = new MultiISS(asm.words);
    let mismatch: string | null = null;
    let stalls = [0, 0];
    let running: number | null = null;
    let lastStall = [false, false];
    const status = h('div', { class: 'cpu-status' });
    const cols = h('div', { class: 'dual-cols' });
    const mem = h('div', { class: 'cpu-mem' });
    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const p of MC_PROGRAMS) sel.append(h('option', { value: p.id }, p.name));
    sel.value = MC_PROGRAMS.find((p) => p.source === source)?.id ?? MC_PROGRAMS[0].id;
    sel.addEventListener('change', () => stage.load(dualCoreScene(MC_PROGRAMS.find((p) => p.id === sel.value)!.source)));
    const runBtn = h('button', { class: 'btn sm primary' }, 'Run to halt');
    const stop = () => { if (running) cancelAnimationFrame(running); running = null; runBtn.textContent = 'Run to halt'; };
    runBtn.addEventListener('click', () => {
      if (running) return stop();
      runBtn.textContent = 'Stop';
      const tick = () => {
        stage.runCycles(6, () => m.halted);
        if (m.halted || mismatch || stage.cycles > 5000) return stop();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });
    const title = h('h4', null, 'Two cores, one memory', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'click to collapse'));
    const el = h('div', { class: 'mem-panel cpu-panel', 'data-dock': 'right' }, title,
      h('div', { class: 'cpu-body' }, h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, runBtn), status, cols,
        h('div', { class: 'cpu-sec' }, 'Shared memory (non-zero words; counter at 0x40, lock at 0x44)'), mem));
    title.addEventListener('click', () => { el.classList.toggle('collapsed'); stage.setInset(el.classList.contains('collapsed') ? 0 : el.getBoundingClientRect().width + 24); });
    stage.edgeHooks.add({
      before: () => {
        const sim = stage.sim;
        if (!sim || m.halted) return;
        const hw = [0, 1].map((i) => sim.getBits(sim.design.root.ports[`retire${i}`])[0] === 1);
        const r = m.step();
        lastStall = r.map((x) => !x);
        r.forEach((x, i) => { if (!x) stalls[i]++; });
        if (!mismatch && (hw[0] !== r[0] || hw[1] !== r[1])) mismatch = `arbitration differs from the model at cycle ${m.cycles}`;
      },
      after: () => {
        const sim = stage.sim;
        if (!sim || mismatch) return;
        [0, 1].forEach((i) => {
          const st = cpuState(sim, sim.design.root.children!.get(`core${i}`)!);
          const d = st.x.findIndex((v, k) => v !== m.harts[i].x[k]);
          if (d >= 0) mismatch = `core ${i}: ${ABI[d]} differs from the model`;
          else if (st.pc !== m.harts[i].pc) mismatch = `core ${i}: PC differs from the model`;
        });
      },
    });
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      if (stage.cycles === 0 && m.cycles > 0) { m = new MultiISS(asm.words); mismatch = null; stalls = [0, 0]; lastStall = [false, false]; }
      const root = sim.design.root;
      const dm = root.children!.get('dm')!.children!.get('ram')!;
      const words = Array.from({ length: 32 }, (_, i) => pack(sim.getBits(dm.children!.get(`w${i}`)!.ports.q)) >>> 0);
      status.replaceChildren(
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, `stall cycles: core 0 ${stalls[0]}, core 1 ${stalls[1]}`),
        h('span', null, `counter = ${words[16]}`),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good' }, '✓ matches the multi-hart golden model'),
        ...(m.halted ? [h('span', { class: 'warn' }, 'both halted')] : []));
      cols.replaceChildren(...[0, 1].map((i) => {
        const st = cpuState(sim, root.children!.get(`core${i}`)!);
        const w = asm.words[st.pc >>> 2] ?? 0x13;
        return h('div', { class: 'dual-core' },
          h('div', { class: 'cpu-sec' }, `core ${i}`, lastStall[i] ? h('span', { class: 'warn', style: 'margin-left:6px' }, 'stalled') : ''),
          h('div', { class: 'cpu-now' }, h('code', null, `${hex(st.pc, 3)}  ${disasm(w, st.pc)}`)),
          h('div', { class: 'cpu-mem' }, ...SHOWN.map((r) => h('div', { class: `m${st.x[r] ? '' : ' z'}` }, h('span', { class: 'n' }, ABI[r]), h('span', { class: 'v' }, hex(st.x[r]))))));
      }));
      const nz = words.map((v, i) => [i, v] as const).filter(([, v]) => v);
      mem.replaceChildren(...(nz.length ? nz.map(([i, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, `[${hex(i * 4, 2)}]`), h('span', { class: 'v' }, hex(v)), h('span', { class: 'd' }, String(v | 0)))) : [h('div', { class: 'm z' }, 'all zero')]));
    };
    update();
    return { el, update, destroy: stop };
  };
}

/** MSI / MESI on a snooping bus: click accesses or play a scenario, watch states and bus traffic. */
export function coherenceWidget(): Widget {
  let protocol: Protocol = 'MESI', cores = 2;
  let c = new Coherence(cores, protocol);
  const log: CoherenceEvent[] = [];
  let timer: number | null = null;
  const NAMES = ['A', 'B', 'C', 'D'];
  const grid = h('div', { class: 'coh-grid' });
  const logEl = h('div', { class: 'coh-log' });
  const stats = h('div', { class: 'sub' });
  const reset = () => { if (timer) clearInterval(timer); timer = null; c = new Coherence(cores, protocol); log.length = 0; render(); };
  const doAccess = (core: number, block: number, write: boolean) => { log.unshift(c.access(core, block, write)); if (log.length > 12) log.pop(); render(); };
  const SCEN: Record<string, { label: string; ops: [number, number, boolean][] }> = {
    readshare: { label: 'Read sharing', ops: [[0, 0, false], [1, 0, false], [0, 0, false], [1, 0, false], [0, 0, false], [1, 0, false]] },
    pingpong: { label: 'Ping-pong writes', ops: [[0, 0, true], [1, 0, true], [0, 0, true], [1, 0, true], [0, 0, true], [1, 0, true]] },
    falseshare: { label: 'False sharing (x and y in one block)', ops: [[0, 0, true], [1, 0, true], [0, 0, true], [1, 0, true], [0, 0, true], [1, 0, true]] },
    padded: { label: 'Padded (x in A, y in B)', ops: [[0, 0, true], [1, 1, true], [0, 0, true], [1, 1, true], [0, 0, true], [1, 1, true]] },
    private: { label: 'Private read-then-write', ops: [[0, 0, false], [0, 0, true], [1, 1, false], [1, 1, true], [0, 2, false], [0, 2, true]] },
  };
  const play = (k: string) => {
    reset();
    const ops = SCEN[k].ops;
    let i = 0;
    timer = window.setInterval(() => {
      if (i >= ops.length) { if (timer) clearInterval(timer); timer = null; return; }
      const [core, block, w] = ops[i++];
      doAccess(core, block, w);
    }, 600);
  };
  const render = () => {
    const last = log[0];
    grid.replaceChildren(
      h('div', { class: 'coh-row head' }, h('span', null, ''), ...NAMES.map((n) => h('span', null, `block ${n}`))),
      ...c.state.map((row, core) => h('div', { class: 'coh-row' },
        h('span', { class: 'coh-core' }, `core ${core}`),
        ...row.map((s, b) => {
          const hot = last && last.block === b && (last.core === core || last.invalidated.includes(core) || last.flush === core);
          return h('span', { class: `coh-cell st-${s}${hot ? ' hot' : ''}` },
            h('b', null, s),
            h('button', { class: 'btn xs', title: `core ${core} reads ${NAMES[b]}`, onclick: () => doAccess(core, b, false) }, 'R'),
            h('button', { class: 'btn xs', title: `core ${core} writes ${NAMES[b]}`, onclick: () => doAccess(core, b, true) }, 'W'));
        }))));
    logEl.replaceChildren(...log.map((e) => h('div', null,
      `core ${e.core} ${e.write ? 'writes' : 'reads'} ${NAMES[e.block]}: `,
      e.hit ? h('span', { class: 'good' }, `hit (${e.from}${e.from !== e.to ? ` → ${e.to}` : ''})`) : h('span', { class: 'bad' }, `${e.bus} on the bus, ${e.from} → ${e.to}`),
      e.flush !== null ? `; core ${e.flush} supplies the dirty block (write-back)` : '',
      e.invalidated.length ? `; invalidates core ${e.invalidated.join(', ')}` : '')));
    const s = c.stats;
    stats.textContent = `${s.accesses} accesses, ${s.hits} hits, ${s.bus} bus transactions, ${s.invalidations} invalidations, ${s.writebacks} write-backs, ${s.memReads} memory reads.`;
  };
  const psel = h('select', { 'aria-label': 'protocol' }) as HTMLSelectElement;
  for (const p of ['MESI', 'MSI']) psel.append(h('option', { value: p }, p));
  psel.addEventListener('change', () => { protocol = psel.value as Protocol; reset(); });
  const csel = h('select', { 'aria-label': 'cores' }) as HTMLSelectElement;
  for (const n of [2, 3, 4]) csel.append(h('option', { value: String(n) }, `${n} cores`));
  csel.addEventListener('change', () => { cores = Number(csel.value); reset(); });
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Cache coherence on a snooping bus'),
      h('p', { class: 'sub' }, 'Each core has a private cache. M = modified (the only valid copy, dirty), E = exclusive (only copy, clean; MESI), S = shared (clean, maybe in other caches), I = invalid. Every cache watches (snoops) the bus.'),
      h('div', { class: 'param-row' }, psel, csel, h('button', { class: 'btn sm', onclick: reset }, 'Reset')),
      h('div', { class: 'param-row' }, ...Object.entries(SCEN).map(([k, v]) => h('button', { class: 'btn sm', onclick: () => play(k) }, v.label))),
      grid, stats, logEl)),
    destroy: () => { if (timer) clearInterval(timer); },
  };
}
