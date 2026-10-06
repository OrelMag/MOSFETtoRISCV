// Chapter 21 widgets: the cache explorer (real address traces from the ISS through a configurable
// cache model), DRAM retention and refresh, and the memory hierarchy at a glance.

import { assemble } from '../riscv/asm';
import { TRACE_PROGRAMS } from '../riscv/cprograms';
import { ISS } from '../riscv/iss';
import { CacheModel, type AccessResult, type CacheConfig } from '../sim/cachemodel';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const traces = new Map<string, { addr: number; write: boolean }[]>();
function traceOf(id: string): { addr: number; write: boolean }[] {
  let t = traces.get(id);
  if (!t) {
    const p = TRACE_PROGRAMS.find((q) => q.id === id)!;
    const iss = new ISS(assemble(p.source).words, { dmemWords: 1024 });
    iss.memTrace = [];
    for (let i = 0; i < 50000 && !iss.halted; i++) iss.step();
    traces.set(id, (t = iss.memTrace));
  }
  return t;
}

const sel = (label: string, options: [string, string][], value: string, on: (v: string) => void) => {
  const s = h('select', { 'aria-label': label }) as HTMLSelectElement;
  for (const [v, t] of options) s.append(h('option', { value: v }, t));
  s.value = value;
  s.addEventListener('change', () => on(s.value));
  return h('label', { class: 'cx-field' }, h('span', null, label), s);
};

/** Step a real program's memory trace through a cache of your choice. */
export function cacheExplorer(initial: Partial<CacheConfig> & { trace?: string } = {}): Widget {
  let traceId = initial.trace ?? 'rowmajor';
  const cfg: CacheConfig = { size: 256, line: 16, ways: 1, replacement: 'lru', write: 'wb', ...initial };
  let model = new CacheModel(cfg);
  let pos = 0;
  let last: (AccessResult & { addr: number; write: boolean }) | null = null;
  let timer: number | null = null;

  const grid = h('div', { class: 'cx-grid' });
  const stats = h('div', { class: 'cx-stats' });
  const now = h('div', { class: 'cx-now' });
  const runBtn = h('button', { class: 'btn sm primary' }, 'Run');

  const reset = () => {
    stop();
    if (cfg.ways * cfg.line > cfg.size) cfg.ways = cfg.size / cfg.line;
    model = new CacheModel(cfg);
    pos = 0;
    last = null;
    render();
  };
  const step = (n = 1) => {
    const t = traceOf(traceId);
    for (let i = 0; i < n && pos < t.length; i++, pos++) last = { ...model.access(t[pos].addr, t[pos].write), ...t[pos] };
    render();
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    runBtn.textContent = 'Run';
  };
  runBtn.addEventListener('click', () => {
    if (timer !== null) return stop();
    runBtn.textContent = 'Pause';
    timer = window.setInterval(() => {
      step(1);
      if (pos >= traceOf(traceId).length) stop();
    }, 40);
  });

  const render = () => {
    const t = traceOf(traceId);
    const sets = model.sets;
    const offBits = Math.log2(cfg.line), idxBits = Math.log2(sets);
    // the sets × ways grid (at most 64 sets drawn)
    const rows: HTMLElement[] = [];
    for (let s = 0; s < Math.min(sets, 64); s++) {
      const cells = model.lines[s].map((l, w) => {
        const cur = last && last.set === s && last.way === w;
        return h('span', {
          class: `cx-line${l.valid ? ' v' : ''}${l.dirty ? ' d' : ''}${cur ? (last!.hit ? ' hit' : ' miss') : ''}`,
          title: l.valid ? `set ${s}, way ${w}: tag 0x${l.tag.toString(16)}${l.dirty ? ' (dirty)' : ''}` : `set ${s}, way ${w}: empty`,
        }, l.valid ? l.tag.toString(16) : '');
      });
      rows.push(h('div', { class: `cx-set${last && last.set === s ? ' cur' : ''}` }, h('span', { class: 'cx-si' }, String(s)), ...cells));
    }
    grid.replaceChildren(...rows, ...(sets > 64 ? [h('div', { class: 'sub' }, `… ${sets - 64} more sets`)] : []));
    const st = model.stats;
    const pct = (x: number) => (st.accesses ? ((100 * x) / st.accesses).toFixed(1) : '0.0');
    const bar = (x: number, cls: string, label: string) => h('span', { class: `cx-bar ${cls}`, style: `width:${st.accesses ? (100 * x) / st.accesses : 0}%`, title: `${label}: ${x}` });
    stats.replaceChildren(
      h('div', null, h('strong', null, `${pct(st.hits)} % hits`), ` · ${st.hits} hits, ${st.misses} misses of ${st.accesses} accesses (${pos} / ${t.length})`),
      h('div', { class: 'cx-bars' }, bar(st.hits, 'h', 'hits'), bar(st.compulsory, 'c1', 'compulsory'), bar(st.capacity, 'c2', 'capacity'), bar(st.conflict, 'c3', 'conflict')),
      h('div', { class: 'cx-legend' },
        h('span', null, h('i', { class: 'h' }), 'hit'), h('span', null, h('i', { class: 'c1' }), `compulsory ${st.compulsory}`),
        h('span', null, h('i', { class: 'c2' }), `capacity ${st.capacity}`), h('span', null, h('i', { class: 'c3' }), `conflict ${st.conflict}`)),
      h('div', { class: 'sub' }, `Memory traffic: ${st.wordsRead} words read, ${st.wordsWritten} written (${cfg.write === 'wb' ? 'write-back, write-allocate' : 'write-through, no write-allocate'}).`));
    if (last) {
      const bits = (v: number, n: number) => (n > 0 ? v.toString(2).padStart(n, '0') : '');
      const blockBits = 12 - offBits - idxBits;
      const sp = model.split(last.addr);
      now.replaceChildren(
        h('span', null, `${last.write ? 'store' : 'load'} 0x${last.addr.toString(16).padStart(3, '0')} = `),
        h('code', { class: 'cx-tag' }, bits(sp.tag, blockBits)), h('code', { class: 'cx-idx' }, bits(sp.set, idxBits)), h('code', { class: 'cx-off' }, bits(sp.offset, offBits)),
        h('span', { class: last.hit ? 'good' : 'bad' }, last.hit ? ' hit' : ` miss (${last.kind}${last.writeback ? ', dirty victim written back' : ''})`));
    } else now.replaceChildren(h('span', { class: 'sub' }, 'Address = '), h('code', { class: 'cx-tag' }, 'tag'), h('code', { class: 'cx-idx' }, 'index'), h('code', { class: 'cx-off' }, 'offset'));
  };

  const sizes: [string, string][] = [64, 128, 256, 512, 1024, 2048].map((v) => [String(v), `${v} B`]);
  const linesz: [string, string][] = [4, 8, 16, 32, 64].map((v) => [String(v), `${v} B`]);
  const ways: [string, string][] = [['1', 'direct-mapped'], ['2', '2-way'], ['4', '4-way'], ['8', '8-way'], ['0', 'fully associative']];
  const controls = h('div', { class: 'cx-controls' },
    sel('program', TRACE_PROGRAMS.map((p) => [p.id, p.name]), traceId, (v) => { traceId = v; reset(); }),
    sel('size', sizes, String(cfg.size), (v) => { cfg.size = Number(v); reset(); }),
    sel('line', linesz, String(cfg.line), (v) => { cfg.line = Number(v); reset(); }),
    sel('associativity', ways, String(cfg.ways), (v) => { cfg.ways = Number(v) || cfg.size / cfg.line; reset(); }),
    sel('replacement', [['lru', 'LRU'], ['fifo', 'FIFO'], ['random', 'random']], cfg.replacement, (v) => { cfg.replacement = v as CacheConfig['replacement']; reset(); }),
    sel('writes', [['wb', 'write-back'], ['wt', 'write-through']], cfg.write, (v) => { cfg.write = v as CacheConfig['write']; reset(); }));
  const buttons = h('div', { class: 'param-row' },
    h('button', { class: 'btn sm', onclick: () => step(1) }, 'Step'), runBtn,
    h('button', { class: 'btn sm', onclick: () => { stop(); step(1e9); } }, 'To the end'),
    h('button', { class: 'btn sm', onclick: reset }, 'Reset'));
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel cx' },
      h('h3', null, 'Cache explorer'),
      h('p', { class: 'sub' }, 'The address trace is real: every load and store the program executes on the golden model. Each row is a set; each box a way, showing its tag. Misses are classified: compulsory (first touch), capacity (would miss even fully associative), conflict (only because of the mapping).'),
      controls, buttons, now, grid, stats)),
    destroy: stop,
  };
}

/** DRAM: charge sharing on a read, leakage and refresh. */
export function dramWidget(): Widget {
  let cs = 25, cb = 100, retention = 64, refresh = 32;
  const out = h('div', null);
  const svgNS = 'http://www.w3.org/2000/svg';
  const render = () => {
    const vdd = 1.1, dv = (vdd / 2) * cs / (cs + cb);
    const W = 520, H = 140, T = 200; // ms on the x axis
    const pts: string[] = [];
    let v = vdd, lost = -1;
    for (let ms = 0; ms <= T; ms += 0.5) {
      if (ms > 0 && Math.abs(ms % refresh) < 0.25 && v > vdd / 2) v = vdd;
      v *= 0.5 ** (0.5 / retention); // exponential leak: half the charge every `retention` ms
      if (v < vdd / 2 && lost < 0) lost = ms;
      pts.push(`${(ms / T) * W},${H - (v / vdd) * (H - 10)}`);
    }
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 16}`);
    svg.setAttribute('class', 'dram-plot');
    svg.innerHTML = `<line x1="0" x2="${W}" y1="${H - (H - 10) / 2}" y2="${H - (H - 10) / 2}" class="thr"/>
      <polyline points="${pts.join(' ')}" class="v"/>
      <text x="4" y="${H - (H - 10) / 2 - 4}" class="lbl">sense threshold (VDD/2)</text>
      <text x="${W - 4}" y="${H + 14}" text-anchor="end" class="lbl">${T} ms</text>`;
    out.replaceChildren(svg,
      h('p', { class: 'sub' }, lost < 0
        ? `Refreshed every ${refresh} ms, the stored 1 never falls below the threshold.`
        : `The 1 decays below the threshold after ${lost.toFixed(0)} ms: the bit is lost. Refresh must come more often than the retention time.`),
      h('p', { class: 'sub' }, `Read: the bit line (precharged to VDD/2 = ${(vdd / 2).toFixed(2)} V) shares charge with the cell: ΔV = (VDD/2) · Cs / (Cs + Cb) = ${(dv * 1000).toFixed(0)} mV. A sense amplifier (a cross-coupled latch) turns those millivolts into a full 0 or 1 and writes it back: every DRAM read is destructive and must restore the row.`));
  };
  const slider = (label: string, min: number, max: number, val: number, unit: string, on: (v: number) => void) => {
    const i = h('input', { type: 'range', min: String(min), max: String(max), value: String(val) }) as HTMLInputElement;
    const v = h('span', { class: 'num' }, `${val} ${unit}`);
    i.addEventListener('input', () => { on(Number(i.value)); v.textContent = `${i.value} ${unit}`; render(); });
    return h('label', { class: 'cx-field' }, h('span', null, label), i, v);
  };
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'DRAM: leaking capacitors'),
      h('div', { class: 'cx-controls' },
        slider('refresh interval', 4, 128, refresh, 'ms', (v) => (refresh = v)),
        slider('retention (to half)', 16, 256, retention, 'ms', (v) => (retention = v)),
        slider('cell capacitance', 5, 60, cs, 'fF', (v) => (cs = v)),
        slider('bit-line capacitance', 20, 300, cb, 'fF', (v) => (cb = v))),
      out)),
  };
}

/** The memory hierarchy at a glance: typical capacities and latencies of a desktop core. */
export function hierarchyWidget(): Widget {
  const rows: [string, string, number, string][] = [
    ['Registers', '~1 KB', 0.25, 'flip-flops, in the datapath'],
    ['L1 cache', '32–64 KB', 1, '6T SRAM, per core, split I / D'],
    ['L2 cache', '0.5–2 MB', 4, 'SRAM, per core'],
    ['L3 cache', '8–64 MB', 12, 'SRAM, shared by all cores'],
    ['DRAM', '8–128 GB', 80, '1T1C, off chip, refreshed'],
    ['NVMe SSD', '1–8 TB', 80_000, 'flash, through the OS'],
  ];
  const max = Math.log10(rows[rows.length - 1][2] / 0.1);
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'The memory hierarchy'),
      h('p', { class: 'sub' }, 'Typical figures for a ~4 GHz desktop core (orders of magnitude; they vary by product). The bar is latency on a log scale.'),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, 'level'), h('th', null, 'capacity'), h('th', null, 'latency'), h('th', null, 'cycles'), h('th', null, ''), h('th', null, 'built from'))),
        h('tbody', null, rows.map(([n, c, ns, b]) => h('tr', null,
          h('td', null, n), h('td', null, c), h('td', { class: 'num' }, ns >= 1000 ? `${ns / 1000} µs` : `${ns} ns`), h('td', { class: 'num' }, String(Math.max(1, Math.round(ns * 4)))),
          h('td', { class: 'barcell', style: 'width:28%' }, h('span', { class: 'cbar k', style: `width:${(Math.log10(ns / 0.1) / max) * 100}%` })),
          h('td', { class: 'sub' }, b))))),
      h('p', { class: 'sub', style: 'margin-top:10px' }, 'If a register access took one second, an L1 hit would take 4 s, a DRAM access 5 minutes, and an SSD read 4 days. Caches work because programs reuse data (temporal locality) and touch neighbours (spatial locality).'))),
  };
}
