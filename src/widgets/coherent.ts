// Chapter 27's cache steps: the coherent dual-core (lib/coherent.ts) with the Coherence panel. The panel shows both
// caches line by line (read from the flip-flops), the reservations, the bus's last transactions and its counters; it
// follows the gates with riscv/cohmodel.ts (the cycle-exact timing model: every retirement, every line, every edge)
// and with a plain sequentially consistent replay of the same retirement order (what the program would see if there
// were one memory), which is what the first cache step's stale read is measured against.

import { coherentDualCore } from '../lib/coherent';
import { readCache, readMem } from '../lib/cohread';
import { assemble, type AsmResult } from '../riscv/asm';
import { type BusEvent, CohModel, ST_NAMES } from '../riscv/cohmodel';
import { COH_PROGRAMS } from '../riscv/cohprograms';
import { runCoherent } from '../riscv/cohrun';
import { cpuState } from '../riscv/cosim';
import { ABI, disasm } from '../riscv/isa';
import { MultiISS } from '../riscv/multi';
import { h } from '../ui/dom';
import { holdHeight } from '../ui/holdsize';
import { cohUse, isMem } from './cohuse';
import { showInstrUse, slowControls } from './slowctl';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const num = (v: number) => (v >>> 0 < 100000 ? String(v >>> 0) : hex(v, 8));
const SHOWN = [5, 6, 7, 10, 11, 12];
const OP_TIP: Record<string, string> = {
  BusRd: 'a read miss: the line comes from memory, or from the cache that holds it Modified',
  BusRdX: 'a write miss: the line comes with ownership; every other copy is invalidated',
  BusUpgr: 'a write to a Shared line: no data, the other copies are invalidated',
};

export interface CoherentSceneOpts {
  /** false: private write-back caches that never snoop. */
  coherent?: boolean;
  /** Programs (COH_PROGRAMS ids) the panel's selector offers. */
  programs?: string[];
  /** Programs measured on the model and tabulated under the caches, and what one unit of work is called (the per-unit divisor). */
  measure?: { ids: string[]; unit: string; per: number };
  /** Instances to light on load. */
  highlight?: string[];
  autoClock?: boolean;
}

export function coherentScene(source: string, opts: CoherentSceneOpts = {}): Scene {
  const asm = assemble(source);
  return {
    root: coherentDualCore(asm.words, { coherent: opts.coherent }), inputs: { clk: 0 }, highlight: opts.highlight ?? ['bus'], autoClock: opts.autoClock,
    panels: [coherencePanel(source, asm, opts)],
  };
}

/** What the program saw at the first register that differs from sequentially consistent memory. */
interface Stale { core: number; reg: number; got: number; want: number; cycle: number; pc: number }

function coherencePanel(source: string, asm: AsmResult, opts: CoherentSceneOpts): ScenePanel {
  const coherent = opts.coherent !== false;
  return (stage: Stage): Widget => {
    let model = new CohModel(asm.words, { coherent });
    let ref = new MultiISS(asm.words, 2);
    let mismatch: string | null = null;
    let stale: Stale | null = null;
    let running: number | null = null;
    let sel: { core: number; set: number } | null = null;
    const status = holdHeight(h('div', { class: 'cpu-status' }));
    const verdict = h('div', { class: 'coh-verdict' });
    const cores = h('div', { class: 'coh-cores' });
    const busEl = h('div', { class: 'coh-bus' });
    const stats = h('div', { class: 'coh-stats' });
    const measured = h('div', { class: 'coh-measured' });
    const listingBody = h('div', { class: 'coh-listing-body' });
    const listing = h('details', { class: 'coh-listing', open: '' }, h('summary', null, 'Program, with each core\'s PC (click a line: its hardware)'), listingBody);
    const usePath = h('div', { class: 'ibd' });
    let selPc: number | null = null;
    const ids = opts.programs ?? COH_PROGRAMS.map((p) => p.id);
    const picker = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const id of ids) { const p = COH_PROGRAMS.find((q) => q.id === id)!; picker.append(h('option', { value: p.id }, p.name)); }
    picker.value = COH_PROGRAMS.find((p) => p.source === source && ids.includes(p.id))?.id ?? ids[0];
    picker.addEventListener('change', () => stage.load(coherentScene(COH_PROGRAMS.find((p) => p.id === picker.value)!.source, opts)));
    const runBtn = h('button', { class: 'btn sm primary' }, 'Run to halt');
    const stop = () => { if (running) cancelAnimationFrame(running); running = null; runBtn.textContent = 'Run to halt'; };
    const finished = () => model.halted || !!mismatch || stage.cycles > 20000;
    const slow = slowControls(stage, { multiCycle: true, finished, onStart: stop, maxCycles: 60 });
    runBtn.addEventListener('click', () => {
      if (running) return stop();
      slow.stop();
      slow.tracing = false;
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      const tick = () => {
        stage.runCycles(8, () => model.halted);
        if (model.halted || mismatch || stage.cycles > 20000) return stop();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    });
    const title = h('h4', null, coherent ? 'Coherent caches' : 'Private caches', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel coh-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
      h('div', { class: 'cpu-body' }, h('div', { class: 'param-row', style: 'margin-bottom:6px' }, picker, runBtn), slow.el, status, verdict, cores, busEl, stats, listing, usePath, measured));

    const compareHw = (): void => {
      const sim = stage.sim;
      if (!sim || mismatch) return;
      const root = sim.design.root, K = model.K, s = model.s;
      for (let i = 0; i < 2; i++) {
        const st = cpuState(sim, root.children!.get(`core${i}`)!), hart = model.m.harts[i];
        const d = st.x.findIndex((v, k) => v !== hart.x[k]);
        if (d >= 0) { mismatch = `core ${i}: ${ABI[d]} differs from the model`; return; }
        if (st.pc !== hart.pc) { mismatch = `core ${i}: PC differs from the model`; return; }
        const hw = readCache(sim, root, i, K), m = s.caches[i];
        if (hw.st.join() !== m.st.join() || hw.data.join() !== m.data.join()) { mismatch = `cache ${i} differs from the model`; return; }
        if (hw.resV !== (hart.resValid ? 1 : 0)) { mismatch = `cache ${i}: the reservation differs from the model`; return; }
      }
      if (sim.getBits(root.ports.busy)[0] !== (s.busy ? 1 : 0)) mismatch = 'the bus differs from the model';
      else if (readMem(sim, root, K).join() !== s.mem.join()) mismatch = 'memory differs from the model';
    };
    stage.edgeHooks.add({
      before: () => {
        const sim = stage.sim;
        if (!sim || model.halted) return;
        const root = sim.design.root;
        const hw = [0, 1].map((i) => sim.getBits(root.ports[`retire${i}`])[0] === 1);
        const pre = model.m.harts.map((x): [boolean, number] => [x.resValid, x.resLine]);
        const r = model.step();
        if (r[0] || r[1]) slow.retired();
        if (!mismatch && (hw[0] !== r[0] || hw[1] !== r[1])) mismatch = `retirement differs from the model at cycle ${model.cycles}`;
        // the same retirements on one plain memory, the reservations as the caches left them
        r.forEach((x, i) => { if (x) { ref.harts[i].resValid = pre[i][0]; ref.harts[i].resLine = pre[i][1]; ref.harts[i].step(); } });
        if (!stale) {
          for (let i = 0; i < 2 && !stale; i++) {
            const a = model.m.harts[i], b = ref.harts[i];
            const d = a.x.findIndex((v, k) => v !== b.x[k]);
            if (d >= 0) stale = { core: i, reg: d, got: a.x[d], want: b.x[d], cycle: model.cycles, pc: a.pc };
            else if (a.pc !== b.pc) stale = { core: i, reg: -1, got: a.pc, want: b.pc, cycle: model.cycles, pc: a.pc };
          }
        }
      },
      after: () => { if (!stage.inEdge) compareHw(); },
    });
    // Back: the model, the replay and the verdicts return with the hardware.
    stage.historyHooks.add({
      save: () => ({ m: model.save(), r: ref.save(), mismatch, stale }),
      restore: (v) => {
        const st = v as { m: ReturnType<CohModel['save']>; r: ReturnType<MultiISS['save']>; mismatch: string | null; stale: Stale | null };
        stop();
        model.restore(st.m); ref.restore(st.r);
        mismatch = st.mismatch; stale = st.stale;
      },
    });

    const chip = (s: number) => h('span', { class: `coh-st st-${ST_NAMES[s]}`, title: ['Invalid', 'Shared: clean, other caches may hold it', 'Modified: dirty, the only valid copy'][s] }, ST_NAMES[s]);
    const lineAddr = (tag: number, set: number) => hex(((tag << 2) | set) * 16, 2);
    const reveal = (core: number, set: number, what: 'state' | 'tag') => {
      sel = { core, set };
      if (what === 'state') stage.reveal([`cache${core}`, 'ctags'], `u${1 + set}`);
      else stage.reveal([`cache${core}`, 'acc'], 'tagEq');
      update();
    };
    const lastTx = (core: number) => model.s.log.length && model.s.log[model.s.log.length - 1].core === core ? model.s.log[model.s.log.length - 1] : null;
    const effect = (e: BusEvent): string => {
      const x = 1 - e.core, parts: string[] = [];
      if (e.writeback) parts.push('victim written back');
      if (e.other) parts.push(`c${x} ${ST_NAMES[e.other.from]}→${ST_NAMES[e.other.to]}${e.flush ? ' Flush' : ''}`);
      if (e.resvLost) parts.push(`c${x} reservation lost`);
      if (!parts.length) parts.push(e.op === 'BusUpgr' ? 'no other copy' : 'from memory');
      return parts.join(', ');
    };
    const lineTable = (core: number) => {
      const sim = stage.sim!, hw = readCache(sim, sim.design.root, core, model.K);
      const rows = [0, 1, 2, 3].map((set) => {
        const live = hw.st[set] !== 0;
        return h('tr', { class: `${sel && sel.core === core && sel.set === set ? 'sel' : ''}` },
          h('td', { class: 'mono' }, String(set)),
          h('td', { class: 'mono' }, live ? lineAddr(hw.tag[set], set) : '—'),
          h('td', null, chip(hw.st[set])),
          h('td', { class: 'mono words' }, live ? hw.data.slice(set * 4, set * 4 + 4).map((v) => num(v)).join(' · ') : ''),
          h('td', { class: 'acts' },
            h('button', { class: 'btn xs', title: `light the state flip-flops of set ${set} in cache ${core}`, 'aria-label': `cache ${core} set ${set}: state flip-flops`, onclick: () => reveal(core, set, 'state') }, 'FF'),
            h('button', { class: 'btn xs', title: 'light the tag comparator of the core side', 'aria-label': `cache ${core}: tag comparator`, onclick: () => reveal(core, set, 'tag') }, '=')));
      });
      return h('table', { class: 'coh-lines' }, h('thead', null, h('tr', null, ...['set', 'line', 'state', 'words', ''].map((t) => h('th', null, t)))), h('tbody', null, ...rows));
    };
    /** Light the clicked line's hardware, or in Slow mode what each core's current instruction uses. */
    const showUse = (): void => {
      const sim = stage.sim;
      if (!sim) return;
      if (selPc !== null) {
        const word = asm.words[selPc >>> 2] ?? 0x13, u = cohUse(word, 0);
        const units = isMem(word) ? ['core0', 'core1', 'cache0', 'cache1', 'bus'] : ['core0', 'core1'];
        return showInstrUse(stage, usePath, { pc: selPc, word, use: { units, path: u.path }, where: 'not necessarily the current instruction of either core' });
      }
      if (!slow.tracing) return showInstrUse(stage, usePath, null);
      const s = model.s, pcs = [0, 1].map((i) => cpuState(sim, sim.design.root.children!.get(`core${i}`)!).pc);
      const uses = [0, 1].map((i) => cohUse(asm.words[pcs[i] >>> 2] ?? 0x13, i, { bus: s.busy ? s.owner === i : !!model.last[i]?.need, flush: s.busy && s.owner === i && s.flush }));
      const first = [0, 1].find((i) => isMem(asm.words[pcs[i] >>> 2] ?? 0x13)) ?? 0;
      showInstrUse(stage, usePath, { pc: pcs[first], word: asm.words[pcs[first] >>> 2] ?? 0x13, use: { units: [...new Set(uses.flatMap((u) => u.units))], path: uses.map((u, i) => `core ${i}: ${u.path}`).join(' | ') } });
    };
    const update = (): void => {
      const sim = stage.sim;
      if (!sim) return;
      slow.update();
      if (stage.cycles === 0 && model.cycles > 0) { slow.tracing = false; model = new CohModel(asm.words, { coherent }); ref = new MultiISS(asm.words, 2); mismatch = null; stale = null; }
      const root = sim.design.root, s = model.s;
      status.replaceChildren(
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, `waiting: core 0 ${s.stalls[0]}, core 1 ${s.stalls[1]}`),
        ...(model.halted ? [h('span', { class: 'warn' }, 'both halted')] : []));
      verdict.replaceChildren(
        mismatch ? h('div', { class: 'bad' }, `✗ ${mismatch}`) : h('div', { class: 'good' }, '✓ the gates match the timing model at every edge'),
        stale
          ? h('div', { class: coherent ? 'bad' : 'warn' }, coherent
            ? `✗ core ${stale.core} differs from one plain memory at cycle ${stale.cycle}`
            : `core ${stale.core} read ${stale.reg >= 0 ? `${ABI[stale.reg]} = ${num(stale.got)}` : `PC ${hex(stale.got, 3)}`} at cycle ${stale.cycle}, but one memory holds ${stale.reg >= 0 ? num(stale.want) : hex(stale.want, 3)}: a stale copy.`)
          : cycleNote(coherent));
      cores.replaceChildren(...[0, 1].map((i) => {
        const st = cpuState(sim, root.children!.get(`core${i}`)!), look = model.last[i];
        const w = asm.words[st.pc >>> 2] ?? 0x13, hw = readCache(sim, root, i, model.K);
        const waiting = look && look.kind !== 'none' && !look.grant;
        const tx = lastTx(i);
        return h('div', { class: 'coh-core' },
          h('div', { class: 'cpu-sec' }, `core ${i}`, waiting ? h('span', { class: 'warn', style: 'margin-left:6px' }, s.busy && s.owner === i ? 'waits for its line' : `waits for the bus: ${look.upgr ? 'BusUpgr' : look.wr ? 'BusRdX' : 'BusRd'}`) : '',
            tx && s.busy && s.owner === i ? h('span', { class: 'bus-tag', title: OP_TIP[tx.op] }, tx.op) : ''),
          h('div', { class: 'cpu-now' }, h('code', null, `${hex(st.pc, 3)}  ${disasm(w, st.pc)}`)),
          lineTable(i),
          h('div', { class: 'coh-res' }, hw.resV ? `reservation: line ${hex(hw.resLine * 16, 2)}` : 'reservation: none'),
          h('div', { class: 'cpu-mem coh-regs' }, ...SHOWN.map((r) => h('div', { class: `m${st.x[r] ? '' : ' z'}` }, h('span', { class: 'n' }, ABI[r]), h('span', { class: 'v' }, num(st.x[r]))))));
      }));
      showUse();
      if (listing.open) {
        const pcs = [0, 1].map((i) => cpuState(sim, root.children!.get(`core${i}`)!).pc);
        listingBody.replaceChildren(...asm.words.map((w, k) => h('div', { class: `coh-ln${pcs.includes(k * 4) ? ' at' : ''}${selPc === k * 4 ? ' sel' : ''}`, title: 'Show the hardware this instruction uses', onclick: () => { selPc = selPc === k * 4 ? null : k * 4; update(); } },
          h('span', { class: 'mono' }, hex(k * 4, 3)), h('code', null, disasm(w, k * 4)), h('span', { class: 'bus-tag mark' }, [0, 1].filter((i) => pcs[i] === k * 4).map((i) => `c${i}`).join(' ')))));
      }
      const log = s.log.slice(-6).reverse();
      busEl.replaceChildren(
        h('div', { class: 'cpu-sec' }, 'Bus', s.busy ? h('span', { class: 'bus-tag', style: 'margin-left:6px' }, `busy: core ${s.owner}, step ${s.cnt}`) : h('span', { style: 'margin-left:6px;color:var(--muted)' }, 'idle')),
        log.length
          ? h('table', { class: 'coh-trace' }, h('thead', null, h('tr', null, ...['cycle', 'who', 'op', 'line', 'effect'].map((t) => h('th', null, t)))),
            h('tbody', null, ...log.map((e) => h('tr', null, h('td', { class: 'mono' }, String(e.cycle)), h('td', null, `c${e.core}`), h('td', { class: 'op', title: OP_TIP[e.op] }, e.op), h('td', { class: 'mono' }, hex(e.line, 2)), h('td', null, effect(e))))))
          : h('div', { class: 'sub' }, 'no transaction yet'));
      const tx = s.tx.rd + s.tx.rdx + s.tx.upgr;
      stats.replaceChildren(
        stat('bus busy', `${s.cycles ? Math.round((100 * s.busBusy) / s.cycles) : 0} %`), stat('transactions', String(tx)),
        stat('invalidations', String(s.invalidations)), stat('flushes', String(s.flushes)), stat('write-backs', String(s.writebacks)),
        stat('sc failures', String(s.scFails[0] + s.scFails[1])));
    };
    const measure = opts.measure;
    if (measure) {
      const rows = measure.ids.map((id) => {
        const p = COH_PROGRAMS.find((q) => q.id === id)!, r = runCoherent(p.source, { coherent });
        return h('tr', null, h('td', null, p.name), h('td', { class: 'mono' }, String(r.cycles)), h('td', { class: 'mono' }, String(r.bus)), h('td', { class: 'mono' }, (r.bus / measure.per).toFixed(1)),
          h('td', { class: 'mono' }, String(r.invalidations)), h('td', { class: 'mono' }, `${Math.round(100 * r.busyShare)} %`));
      });
      measured.append(h('div', { class: 'cpu-sec' }, 'Measured, run to halt'),
        h('table', { class: 'coh-trace' }, h('thead', null, h('tr', null, ...['program', 'cycles', 'bus', `per ${measure.unit}`, 'inval.', 'bus busy'].map((t) => h('th', null, t)))), h('tbody', null, ...rows)));
    }
    listing.addEventListener('toggle', () => update());
    update();
    return { el, update, destroy: stop };
  };
}

const cycleNote = (coherent: boolean) => h('div', { class: 'good' }, coherent ? '✓ every register equals a plain one-memory replay of the same retirements' : 'no snooping: nothing tells a cache when another core wrote the line');
const stat = (k: string, v: string) => h('span', { class: 'coh-stat' }, h('b', null, v), ` ${k}`);
