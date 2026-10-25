// Chapter 36's measurements: the benchmarks (and a memory copy) priced by the cycle-exact controller
// under a page policy, a bank count and an address mapping; and the reordering step's queue, FCFS
// against FR-FCFS.

import type { DramConfig } from '../dram/controller';
import { schedule, type SchedPolicy, twoStreams } from '../dram/schedule';
import { accessCycles, type PagePolicy, TIMING } from '../dram/timing';
import { price, workloads } from '../dram/workload';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

function seg<T extends string | number>(opts: [T, string][], get: () => T, set: (v: T) => void, label: string) {
  const g = h('span', { class: 'seg', role: 'group', 'aria-label': label });
  const btns = opts.map(([v, l]) => {
    const b = h('button', { type: 'button' }, l);
    b.addEventListener('click', () => set(v));
    g.append(b);
    return [v, b] as const;
  });
  return { el: g, sync: () => btns.forEach(([v, b]) => { b.classList.toggle('on', v === get()); b.setAttribute('aria-pressed', String(v === get())); }) };
}

const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))} %`;

export function ctrlExplorer(): Widget {
  let policy: PagePolicy = 'open', banks = 2, hash = false;
  const out = h('div', null);
  const update = () => {
    for (const s of segs) s.sync();
    const rows = workloads().map((w) => {
      const c: DramConfig = { k: Math.log2(w.dmemWords), banks, rowWords: 16, policy, hash };
      return { w, p: price(w, c) };
    });
    out.replaceChildren(h('div', { class: 'scroll' }, h('table', { class: 'tm-table ce-table' },
      h('tr', null, ...['program', 'instructions', 'line requests', 'fixed 8 / 12', 'over DRAM', 'slower by', 'row hits · misses · conflicts', 'refreshes'].map((x, i) => h('th', i ? null : { class: 't' }, x))),
      ...rows.map(({ w, p }) => h('tr', null,
        h('td', null, w.name), h('td', null, String(w.instructions)), h('td', null, String(w.reqs.length)),
        h('td', null, String(w.instructions + p.fixed)), h('td', null, String(p.cycles)),
        h('td', null, `${(((p.cycles / (w.instructions + p.fixed)) - 1) * 100).toFixed(1)} %`),
        h('td', null, policy === 'open' ? `${pct(p.hits, w.reqs.length)} · ${pct(p.misses, w.reqs.length)} · ${pct(p.conflicts, w.reqs.length)}` : 'every access opens its row'),
        h('td', null, String(p.refreshes)))))));
  };
  const segs = [
    seg([['open', 'Open page'], ['closed', 'Closed page']] as [PagePolicy, string][], () => policy, (v) => { policy = v; update(); }, 'Page policy'),
    seg([[2, '2 banks'], [4, '4 banks']] as [number, string][], () => banks, (v) => { banks = v; update(); }, 'Banks'),
    seg([[0, 'Plain mapping'], [1, 'XOR bank hash']] as [number, string][], () => (hash ? 1 : 0), (v) => { hash = !!v; update(); }, 'Address mapping'),
  ];
  const el = h('div', { class: 'widget rb-widget' }, h('div', { class: 'rb-ctl' }, ...segs.map((s) => s.el)),
    h('p', { class: 'sub' }, 'Single-cycle CPU with the 64-byte 2-way write-back cache; rows of 16 words. Each program runs on the golden model, its loads and stores go through the cache model, and every line request is priced by the cycle-exact controller and device, refresh included. For the four benchmarks at 2 banks, plain mapping, these are the gate-level CPUs\' cycle counts exactly (sc-wb2, sc-wb2-dram, sc-wb2-dramc).'),
    out);
  update();
  return { el };
}

export function reorderWidget(): Widget {
  let policy: SchedPolicy = 'frfcfs', depth = 4;
  const out = h('div', null);
  const update = () => {
    for (const s of segs) s.sync();
    const reqs = twoStreams();
    const served = schedule(reqs, policy, depth, 2);
    const end = served.at(-1)!.end;
    const wait = (src: number) => Math.max(...served.filter((s) => s.src === src).map((s) => s.end - s.arrive));
    const hits = served.filter((s) => s.outcome === 'hit').length;
    const scale = Math.min(3, 760 / end);
    const bar = h('div', { class: 'ro-bar', style: `width:${end * scale}px` });
    for (const s of served) bar.append(h('span', { class: `ro-s src${s.src} ${s.outcome}`, style: `left:${s.start * scale}px;width:${Math.max(1, (s.end - s.start) * scale - 1)}px`, title: `${s.src ? 'write buffer' : 'CPU'} request ${s.id}: arrived ${s.arrive}, served ${s.start}–${s.end} (row ${s.outcome})` }));
    out.replaceChildren(
      h('div', { class: 'rb-sum' },
        h('span', null, 'All 32 requests done'), h('b', null, `cycle ${end}`),
        h('span', null, 'Row hits'), h('b', null, `${hits} of ${served.length}`),
        h('span', null, 'Longest wait, CPU · write buffer'), h('b', null, `${wait(0)} · ${wait(1)} cycles`)),
      h('div', { class: 'scroll' }, bar),
      h('div', { class: 'rb-legend' }, h('span', null, h('i', { class: 'ro-k src0' }), 'CPU reads (row 1)'), h('span', null, h('i', { class: 'ro-k src1' }), 'write buffer (row 5, same bank)'), h('span', null, 'darker: a row conflict (16 cycles); lighter: a row hit (8)')));
  };
  const segs = [
    seg([['fcfs', 'FCFS: oldest first'], ['frfcfs', 'FR-FCFS: row hits first']] as [SchedPolicy, string][], () => policy, (v) => { policy = v; update(); }, 'Scheduling'),
    seg([[1, 'queue of 1'], [2, '2'], [4, '4'], [8, '8']] as [number, string][], () => depth, (v) => { depth = v; update(); }, 'Queue depth'),
  ];
  const el = h('div', { class: 'widget rb-widget' }, h('div', { class: 'rb-ctl' }, ...segs.map((s) => s.el)),
    h('p', { class: 'sub' }, `A CPU reads a line every 6 cycles from row 1; a write buffer drains a line every 6 cycles into row 5 of the same bank. Served one at a time: a row hit ${accessCycles('hit', TIMING)} cycles, a conflict ${accessCycles('conflict', TIMING)}.`),
    out);
  update();
  return { el };
}
