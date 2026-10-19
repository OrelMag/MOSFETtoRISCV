// Chapter 33's last two steps: the row buffer over a request stream (banks, open / closed page,
// address mapping) and DDR4's timings in clock cycles at any CPU clock. Both from dram/timing.ts,
// which the controller of chapter 34 is checked against.

import { accessCycles, CLOCK_NS, cyclesOf, DDR4_3200, type DramGeometry, type PagePolicy, RowBuffers, TIMING, type DramTiming } from '../dram/timing';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const ROW_WORDS = 16, LINE = 4, REQUESTS = 64, SHOWN = 12;

type Pattern = 'seq' | 'copy' | 'stride' | 'random';
const PATTERNS: [Pattern, string, string][] = [
  ['seq', 'Sequential', 'Lines 0, 1, 2 … in order: four lines fill a row.'],
  ['copy', 'Copy', 'Read a line of the source, write it to the destination 1 024 words further: two streams, alternating.'],
  ['stride', 'Stride', 'One line per row of bank 0: every access needs a different row of the same bank.'],
  ['random', 'Random', 'Lines anywhere in a 4 K-word memory.'],
];

/** Word addresses of the requests (each a 4-word line). */
export function requestStream(p: Pattern, banks: number): number[] {
  const out: number[] = [];
  let seed = 12345;
  for (let i = 0; i < REQUESTS; i++) {
    if (p === 'seq') out.push(i * LINE);
    else if (p === 'copy') out.push((i >> 1) * LINE + (i & 1 ? 1024 : 0));
    else if (p === 'stride') out.push(i * ROW_WORDS * banks);
    else {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      out.push(((seed >>> 8) % 1024) * LINE);
    }
  }
  return out;
}

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

/** Segments of one access on a timeline: precharge, activate, column command, the burst. */
function gantt(o: 'hit' | 'miss' | 'conflict' | 'closed', t: DramTiming, scale: number): HTMLElement {
  const row = h('div', { class: 'gantt-bar' });
  const add = (cls: string, n: number, label: string) => {
    if (n > 0) row.append(h('span', { class: `g-${cls}`, style: `width:${n * scale}px`, title: `${label}: ${n} cycles` }, n * scale >= 26 ? label : ''));
  };
  if (o === 'conflict') add('pre', t.tRP, 'PRE');
  if (o !== 'hit') add('act', t.tRCD, 'ACT');
  add('rd', t.tCAS, 'RD');
  add('data', t.burst, 'data');
  return row;
}

export function rowBufferWidget(): Widget {
  let pattern: Pattern = 'copy', banks = 2, policy: PagePolicy = 'open', hash = false;
  const out = h('div', { class: 'rb-out' });
  const desc = h('p', { class: 'sub' });
  const update = () => {
    for (const s of segs) s.sync();
    desc.textContent = PATTERNS.find((p) => p[0] === pattern)![2];
    const g: DramGeometry = { banks, rowWords: ROW_WORDS, hash };
    const rb = new RowBuffers(g, policy);
    const reqs = requestStream(pattern, banks);
    const acc = reqs.map((w) => ({ w, ...rb.access(w) }));
    const fixed = REQUESTS * 8;
    const pct = (n: number) => `${Math.round((100 * n) / REQUESTS)} %`;
    const scale = 9;
    const lines = h('div', { class: 'rb-lines' });
    for (const a of acc.slice(0, SHOWN)) {
      lines.append(h('div', { class: `rb-line ${a.outcome}` },
        h('span', { class: 'rb-addr' }, `0x${(a.w * 4).toString(16).padStart(4, '0')}`),
        h('span', { class: 'rb-br' }, `bank ${a.bank} · row ${a.row}`),
        h('span', { class: `rb-kind ${a.outcome}` }, a.outcome === 'closed' ? 'closed page' : `row ${a.outcome}`),
        gantt(a.outcome, TIMING, scale),
        h('span', { class: 'rb-cyc' }, `${a.cycles}`)));
    }
    out.replaceChildren(
      h('div', { class: 'kv rb-sum' },
        h('span', null, `${REQUESTS} line fills`), h('b', null, `${rb.cycles} cycles (${(rb.cycles / REQUESTS).toFixed(1)} a line)`),
        h('span', null, 'Fixed 8 a line (today\'s caches)'), h('b', null, `${fixed} cycles`),
        ...(policy === 'open' ? [h('span', null, 'Row hits · misses · conflicts'), h('b', null, `${pct(rb.hits)} · ${pct(rb.misses)} · ${pct(rb.conflicts)}`)] : [h('span', null, 'Every access'), h('b', null, `activate, read, precharge: ${accessCycles('closed', TIMING)} cycles`)])),
      h('div', { class: 'rb-open' }, ...rb.open.map((r, b) => h('span', null, `bank ${b}: ${r < 0 ? 'closed' : `row ${r} open`}`))),
      h('div', { class: 'cpu-sec' }, `The first ${SHOWN} requests`), lines);
  };
  const segs = [
    seg(PATTERNS.map(([v, l]) => [v, l] as [Pattern, string]), () => pattern, (v) => { pattern = v; update(); }, 'Access pattern'),
    seg([[1, '1 bank'], [2, '2 banks'], [4, '4 banks']] as [number, string][], () => banks, (v) => { banks = v; update(); }, 'Banks'),
    seg([['open', 'Open page'], ['closed', 'Closed page']] as [PagePolicy, string][], () => policy, (v) => { policy = v; update(); }, 'Page policy'),
    seg([[0, 'Plain mapping'], [1, 'XOR bank hash']] as [number, string][], () => (hash ? 1 : 0), (v) => { hash = !!v; update(); }, 'Address mapping'),
  ];
  const el = h('div', { class: 'widget rb-widget' },
    h('div', { class: 'rb-ctl' }, ...segs.map((s) => s.el)), desc,
    h('p', { class: 'sub' }, `Rows of ${ROW_WORDS} words interleaved over the banks (word → column, bank, row); one 4-word line per request, one request at a time. tRCD = tCAS = tRP = ${TIMING.tRCD} cycles.`),
    out,
    h('div', { class: 'legend rb-legend' }, ...[['pre', 'precharge (tRP)'], ['act', 'activate (tRCD)'], ['rd', 'column read (tCAS)'], ['data', 'burst, a word a cycle']].map(([c, l]) => h('span', null, h('i', { class: `g-${c}` }), l))));
  update();
  return { el };
}

/** Clocks to try, MHz: ours first. */
const CLOCKS = [1000 / CLOCK_NS, 500, 1000, 2000, 3000, 4000];

export function timingWidget(): Widget {
  let mhz = CLOCKS[0];
  const out = h('div', null);
  const update = () => {
    for (const s of segs) s.sync();
    const period = 1000 / mhz;
    const t: DramTiming = { ...TIMING, tRCD: cyclesOf(DDR4_3200.tRCD, period), tCAS: cyclesOf(DDR4_3200.tCAS, period), tRP: cyclesOf(DDR4_3200.tRP, period), tRAS: cyclesOf(DDR4_3200.tRAS, period),
      tREFI: Math.floor(DDR4_3200.tREFI / period), tRFC: cyclesOf(DDR4_3200.tRFC, period) };
    const rows: [string, string, number, string][] = [
      ['tRCD', `${DDR4_3200.tRCD} ns`, t.tRCD, 'ACT → column command: the word line rises, the cells share their charge, the amplifiers settle.'],
      ['tCAS', `${DDR4_3200.tCAS} ns`, t.tCAS, 'column command → first word: column decoder, data lines, the output path.'],
      ['tRP', `${DDR4_3200.tRP} ns`, t.tRP, 'PRE → ACT: word line down, both bit lines equalized back to VDD/2.'],
      ['tRAS', `${DDR4_3200.tRAS} ns`, t.tRAS, 'ACT → PRE at the earliest: the amplifiers must finish writing the row back.'],
      ['tREFI', `${DDR4_3200.tREFI / 1000} µs`, t.tREFI, `one REF command at least this often: 8 192 of them cover every row in ${DDR4_3200.retentionMs} ms.`],
      ['tRFC', `${DDR4_3200.tRFC} ns`, t.tRFC, `the device is busy refreshing: ${((100 * DDR4_3200.tRFC) / DDR4_3200.tREFI).toFixed(1)} % of the time.`],
    ];
    const max = accessCycles('conflict', t), scale = Math.min(14, 360 / max);
    out.replaceChildren(
      h('div', { class: 'scroll' }, h('table', { class: 'data tm-table' },
        h('tr', null, h('th', null, ''), h('th', null, 'DDR4-3200'), h('th', null, `cycles at ${Math.round(mhz)} MHz`), h('th', { class: 't' }, 'where it comes from')),
        ...rows.map(([n, ns, c, why]) => h('tr', null, h('td', null, n), h('td', null, ns), h('td', null, String(c)), h('td', { class: 't' }, why))))),
      h('div', { class: 'cpu-sec' }, 'One cache line (4 words) from the row buffer'),
      ...(['hit', 'miss', 'conflict'] as const).map((o) => h('div', { class: 'rb-line' },
        h('span', { class: `rb-kind ${o}` }, `row ${o}`), gantt(o, t, scale), h('span', { class: 'rb-cyc' }, `${accessCycles(o, t)} cycles`))),
      h('p', { class: 'sub' }, mhz === CLOCKS[0]
        ? `At our clock (${CLOCK_NS.toFixed(2)} ns) a row hit costs ${accessCycles('hit', t)} cycles: exactly the fixed miss penalty chapter 21's caches assume. They have been assuming a DRAM that always hits.`
        : `The nanoseconds are the same; only the clock got faster. A row conflict now costs ${accessCycles('conflict', t)} cycles: the memory wall. Caches, row-buffer hits and reordering (chapter 34) are how a fast CPU lives with it.`));
  };
  const segs = [seg(CLOCKS.map((c, i) => [c, i ? `${c >= 1000 ? c / 1000 + ' GHz' : c + ' MHz'}` : `ours, ${Math.round(c)} MHz`] as [number, string]), () => mhz, (v) => { mhz = v; update(); }, 'CPU clock')];
  const el = h('div', { class: 'widget tm-widget' }, h('div', { class: 'rb-ctl' }, ...segs.map((s) => s.el)), out);
  update();
  return { el };
}
