// Chapter 36's flash panels: the switch-level arrays driven as a flash chip drives them (read a row,
// program a row pulse by pulse with a verify read after each, erase the block), every cell's threshold
// shown; the translation layer on a small device; and garbage collection and wear over a long workload.

import { FlashDevice, FLASH_TIMES, Ftl, type FtlEvent, randomWrites } from '../flash/model';
import { nandBlock, norArray, V_READ, vtOf } from '../lib/flash';
import { findNode } from '../sim/flatten';
import { FG_STEP, type SwitchSim } from '../sim/switchsim';
import { B0, B1 } from '../sim/types';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

export interface FlashSceneOptions {
  kind: 'nor' | 'nand';
  /** Rows written at load (bit c = string / column c; 0 bits programmed). */
  pattern?: number[];
  path?: string[];
  highlight?: string[];
}

interface PanelState { reads: { row: number; v: number }[]; pulses: number; erases: number }
const states = new WeakMap<Stage, PanelState>();
export const flashState = (st: Stage) => states.get(st);
const actions = new WeakMap<Stage, { read(row: number): number; program(row: number, data: number): number; erase(): void }>();
export const flashActions = (st: Stage) => actions.get(st);

const COLS = 4;

export function flashScene(o: FlashSceneOptions): Scene {
  const root = o.kind === 'nor' ? norArray(4, COLS) : nandBlock(COLS, 8);
  return {
    root,
    inputs: { row: 0, rd: 0, pgm: 0, ers: 0, ...Object.fromEntries(Array.from({ length: COLS }, (_, c) => [`din${c}`, 1])) },
    hiddenInputs: ['row', 'rd', 'pgm', 'ers', ...Array.from({ length: COLS }, (_, c) => `din${c}`)],
    path: o.path,
    highlight: o.highlight,
    panels: [flashPanel(o)],
  };
}

const bits = (v: number) => Array.from({ length: COLS }, (_, c) => (v >> (COLS - 1 - c)) & 1).join('');

function flashPanel(o: FlashSceneOptions): ScenePanel {
  return (stage: Stage): Widget => {
    const sim = () => stage.sim as SwitchSim;
    const root = () => sim().design.root;
    const rows = 2 ** root().def.ports.find((p) => p.name === 'row')!.width;
    const leaf = (r: number, c: number) => findNode(root(), [`c${r}_${c}`])!.leafIndex!;
    const st: PanelState = { reads: [], pulses: 0, erases: 0 };
    states.set(stage, st);
    let sel = { row: 0, col: 0, data: 0b1010 };
    let log: string[] = [];
    stage.historyHooks.add({
      save: () => ({ st: { ...st, reads: st.reads.slice() }, sel: { ...sel }, log: log.slice() }),
      restore: (v) => { const x = v as { st: PanelState; sel: typeof sel; log: string[] }; Object.assign(st, { ...x.st, reads: x.st.reads.slice() }); sel = { ...x.sel }; log = x.log.slice(); },
    });
    const drive = (vals: Record<string, number>) => { for (const [k, v] of Object.entries(vals)) sim().setInput(k, v); sim().settle(); };
    const din = (data: number) => Object.fromEntries(Array.from({ length: COLS }, (_, c) => [`din${c}`, (data >> c) & 1]));
    const read = (row: number) => {
      drive({ pgm: 0, ers: 0, row, rd: 1 });
      let v = 0;
      for (let c = 0; c < COLS; c++) {
        const b = sim().get(root().ports[`dout${c}`][0]);
        if (b !== B0 && b !== B1) { v = -1; break; }
        v |= b << c;
      }
      drive({ rd: 0 });
      return v;
    };
    /** Program and verify: pulse, read back, repeat until every 0 reads 0 (at most 8 pulses). */
    const program = (row: number, data: number) => {
      log = [];
      for (let n = 1; n <= 8; n++) {
        drive({ rd: 0, ers: 0, row, ...din(data) });
        drive({ pgm: 1 });
        drive({ pgm: 0, ...din(0b1111) });
        st.pulses++;
        const v = read(row), ok = v >= 0 && (v & ~data & 0b1111) === 0;
        log.push(`pulse ${n}: verify reads ${v < 0 ? 'X' : bits(v)}${ok ? ' ✓' : ''}`);
        if (ok) return n;
      }
      return -1;
    };
    const erase = () => { drive({ rd: 0, pgm: 0, ers: 1 }); drive({ ers: 0 }); st.erases++; log = ['erased: every cell of the block back to 1']; };
    actions.set(stage, { read, program, erase });
    const op = (f: () => void) => () => { stage.checkpoint(); f(); stage.refresh(); };

    // load: the pattern, programmed as the panel would
    if (o.pattern) o.pattern.forEach((d, r) => { if ((d & 0b1111) !== 0b1111) program(r, d); });
    log = [];
    st.pulses = 0;

    const seg = (n: number, get: () => number, set: (v: number) => void, label: string) => {
      const g = h('span', { class: 'seg dram-seg', role: 'group', 'aria-label': label });
      for (let i = 0; i < n; i++) {
        const b = h('button', { type: 'button' }, String(i));
        b.addEventListener('click', () => { set(i); update(); });
        g.append(b);
      }
      return { el: g, sync: () => g.querySelectorAll('button').forEach((b, i) => { b.classList.toggle('on', i === get()); b.setAttribute('aria-pressed', String(i === get())); }) };
    };
    const rowSeg = seg(rows, () => sel.row, (v) => (sel.row = v), 'Row');
    const dataBtns = h('span', { class: 'seg dram-seg', role: 'group', 'aria-label': 'Data to program' });
    for (let c = COLS - 1; c >= 0; c--) {
      const b = h('button', { type: 'button', title: `bit ${c}: 0 programs the cell, 1 leaves it` }, '');
      b.addEventListener('click', () => { sel.data ^= 1 << c; update(); });
      dataBtns.append(b);
    }
    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => {
      const b = h('button', { class: cls, title }, label);
      b.addEventListener('click', f);
      return b;
    };
    const grid = h('div', { class: 'fl-grid' });
    const plot = s('svg', { viewBox: '0 0 300 120', class: 'fl-plot', role: 'img', 'aria-label': 'Drain current against gate voltage for the selected cell' });
    const msg = h('div', { class: 'dram-note' });
    const title = h('h4', null, o.kind === 'nor' ? 'NOR flash 4 × 4' : 'NAND flash: 4 strings × 8', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel dram-panel fl-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
      h('div', { class: 'dram-sel' }, h('span', null, 'row'), rowSeg.el, h('span', null, 'data'), dataBtns),
      h('div', { class: 'dram-ops' },
        btn('Read row', 'The row at the read voltage: an erased cell conducts (1), a programmed one does not (0)', op(() => { const v = read(sel.row); st.reads.push({ row: sel.row, v }); log = [`row ${sel.row} reads ${v < 0 ? 'X' : bits(v)}`]; }), 'btn sm primary'),
        btn('Program row', 'Program the 0 bits of the data into the row, a pulse at a time, verifying after each', op(() => { const n = program(sel.row, sel.data); if (n < 0) log.push('gave up: a bit will not program (it may need an erase first?)'); })),
        btn('Erase block', 'Every cell back to 1, all at once', op(erase))),
      grid, plot, msg);

    const drawPlot = (q: number) => {
      const W = 300, H = 120, L = 26, B = 18, T = 8, vx = (v: number) => L + (v / 7) * (W - L - 8), iy = (i: number) => H - B - i * (H - B - T);
      const curve = (vt: number) => Array.from({ length: 71 }, (_, i) => { const v = i / 10; return `${vx(v)},${iy(Math.min(1, Math.max(0, v - vt) ** 2 / 9))}`; }).join(' ');
      plot.replaceChildren(
        s('line', { x1: L, x2: W - 8, y1: H - B, y2: H - B, class: 'fl-axis' }), s('line', { x1: L, x2: L, y1: T, y2: H - B, class: 'fl-axis' }),
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((v) => s('text', { x: vx(v), y: H - 4, 'text-anchor': 'middle', class: 'fl-tick' }, String(v))),
        s('text', { x: L - 4, y: T + 8, 'text-anchor': 'end', class: 'fl-tick' }, 'Id'),
        s('polyline', { points: curve(vtOf(0)), class: 'fl-erased' }),
        s('polyline', { points: curve(vtOf(q)), class: 'fl-curve' }),
        s('line', { x1: vx(V_READ), x2: vx(V_READ), y1: T, y2: H - B, class: 'fl-read' }),
        s('text', { x: vx(V_READ) + 3, y: T + 8, class: 'fl-tick' }, `read ${V_READ} V`),
      );
    };

    const update = () => {
      rowSeg.sync();
      dataBtns.querySelectorAll('button').forEach((b, i) => { const c = COLS - 1 - i, on = (sel.data >> c) & 1; b.textContent = String(on); b.classList.toggle('on', !on); });
      grid.replaceChildren(h('div', { class: 'fl-row head' }, h('span', null, ''), ...Array.from({ length: COLS }, (_, c) => h('span', null, `${o.kind === 'nor' ? 'bit line' : 'string'} ${COLS - 1 - c}`))));
      for (let r = 0; r < rows; r++) {
        const line = h('div', { class: `fl-row${r === sel.row ? ' sel' : ''}` }, h('span', { class: 'lbl' }, `row ${r}`));
        for (let c = COLS - 1; c >= 0; c--) {
          const q = sim().fgCharge(leaf(r, c)), vt = vtOf(q), prog = vt >= V_READ;
          const b = h('button', { type: 'button', class: `fl-cell${prog ? ' prog' : q > 0 ? ' part' : ''}${r === sel.row && c === sel.col ? ' sel' : ''}`, title: `row ${r}, bit ${c}: Vt ${vt.toFixed(1)} V (${prog ? 'programmed: 0' : 'erased: 1'})` }, `${vt.toFixed(1)}`);
          b.addEventListener('click', () => { sel.row = r; sel.col = c; update(); });
          line.append(b);
        }
        grid.append(line);
      }
      drawPlot(sim().fgCharge(leaf(sel.row, sel.col)));
      msg.textContent = log.length ? log.join(' · ') : `Thresholds in volts: erased ${vtOf(0)} V reads 1; each program pulse adds ${(5 * FG_STEP).toFixed(1)} V; at ${V_READ} V or more the cell reads 0. A chip spends ${FLASH_TIMES.program} cycles programming a page, ${FLASH_TIMES.erase} erasing a block.`;
    };
    update();
    return { el, update, destroy: () => { states.delete(stage); actions.delete(stage); } };
  };
}

/** The translation layer on 4 blocks of 4 pages: write logical pages, watch them land, go stale and be collected. */
export function ftlWidget(): Widget {
  const G = { blocks: 4, pagesPerBlock: 4, wordsPerPage: 1 }, LOGICAL = 7;
  let dev = new FlashDevice(G), ftl = new Ftl(dev, { logical: LOGICAL, wearLevel: true });
  let last: FtlEvent | null = null, n = 0;
  const out = h('div', null);
  const write = (lpn: number) => { last = ftl.write(lpn, [n++]); update(); };
  const reset = () => { dev = new FlashDevice(G); ftl = new Ftl(dev, { logical: LOGICAL, wearLevel: true }); last = null; n = 0; update(); };
  const update = () => {
    const blocks = h('div', { class: 'ftl-blocks' });
    for (let b = 0; b < G.blocks; b++) {
      const col = h('div', { class: `ftl-block${b === ftl.active ? ' active' : ''}${last?.erased.includes(b) ? ' erased' : ''}` }, h('b', null, `block ${b}`), h('span', { class: 'sub' }, `${dev.erases[b]} erases`));
      for (let p = 0; p < G.pagesPerBlock; p++) {
        const page = b * G.pagesPerBlock + p, lpn = ftl.p2l[page];
        const state = lpn >= 0 ? 'valid' : dev.programmed[page] ? 'stale' : 'free';
        col.append(h('span', { class: `ftl-page ${state}${last?.page === page ? ' new' : ''}${last?.copies.includes(page) ? ' copy' : ''}` }, lpn >= 0 ? `L${lpn}` : state));
      }
      blocks.append(col);
    }
    const table = h('div', { class: 'ftl-table' }, h('b', null, 'L2P'), ...Array.from({ length: LOGICAL }, (_, l) => h('span', null, `L${l} → ${ftl.l2p[l] < 0 ? '·' : `B${Math.floor(ftl.l2p[l] / G.pagesPerBlock)} P${ftl.l2p[l] % G.pagesPerBlock}`}`)));
    const ev = last ? `L${last.lpn} written to block ${Math.floor(last.page / G.pagesPerBlock)} page ${last.page % G.pagesPerBlock}${last.copies.length || last.erased.length ? `; garbage collection copied ${last.copies.length} valid page${last.copies.length === 1 ? '' : 's'} and erased block ${last.erased.join(', ')}` : ''}.` : 'Write some logical pages.';
    out.replaceChildren(h('div', { class: 'ftl-wrap' }, blocks, table),
      h('p', { class: 'sub' }, ev),
      h('div', { class: 'rb-sum' }, h('span', null, 'Host writes · page programs · erases'), h('b', null, `${ftl.hostWrites} · ${ftl.programs} · ${dev.erases.reduce((a, x) => a + x, 0)}`),
        h('span', null, 'Write amplification'), h('b', null, ftl.writeAmplification.toFixed(2))));
  };
  const btns = h('div', { class: 'rb-ctl' }, ...Array.from({ length: LOGICAL }, (_, l) => { const b = h('button', { class: 'btn sm', type: 'button' }, `Write L${l}`); b.addEventListener('click', () => write(l)); return b; }),
    (() => { const b = h('button', { class: 'btn sm', type: 'button' }, 'Reset'); b.addEventListener('click', reset); return b; })());
  const el = h('div', { class: 'widget rb-widget' }, btns,
    h('p', { class: 'sub' }, `${G.blocks} blocks of ${G.pagesPerBlock} pages; the host sees ${LOGICAL} pages, the rest is spare. A write never overwrites: it goes to the next free page, and the old copy is stale until its block is erased.`),
    out);
  update();
  return { el };
}

/** A long workload on a 16-block device: write amplification against spare space, erase counts per block, wear-out. */
export function wearWidget(): Widget {
  let spare = 25, hot = true, wl = true;
  const G = { blocks: 16, pagesPerBlock: 16, wordsPerPage: 1 }, ENDURANCE = 400, WRITES = 20000;
  const out = h('div', null);
  const update = () => {
    for (const x of segs) x.sync();
    const dev = new FlashDevice(G, ENDURANCE, [11]);
    const usable = G.blocks - 1, logical = Math.min(Math.floor((usable * G.pagesPerBlock) * (1 - spare / 100)), (usable - 2) * G.pagesPerBlock - 1);
    const ftl = new Ftl(dev, { logical, wearLevel: wl });
    let done = 0, failed = '';
    try {
      for (const lpn of randomWrites(WRITES, logical, 17, hot ? Math.max(1, Math.floor(logical / 10)) : 0, 0.9)) { ftl.write(lpn, [done]); done++; }
    } catch (e) { failed = String((e as Error).message); }
    const max = Math.max(...dev.erases, 1);
    const bars = h('div', { class: 'wear-bars' }, ...Array.from(dev.erases).map((e, b) => h('span', { class: `wear-bar${dev.bad[b] ? ' bad' : ''}`, title: `block ${b}: ${e} erases${dev.bad[b] ? (b === 11 ? ', bad from the factory' : ', worn out') : ''}` },
      h('i', { style: `height:${(100 * Math.min(e, ENDURANCE)) / Math.max(max, ENDURANCE)}%` }), h('em', null, String(b)))));
    out.replaceChildren(
      h('div', { class: 'rb-sum' },
        h('span', null, 'Host writes'), h('b', null, `${done}${failed ? ` (then: ${failed})` : ''}`),
        h('span', null, 'Logical / physical pages'), h('b', null, `${logical} / ${usable * G.pagesPerBlock} (${spare} % spare)`),
        h('span', null, 'Write amplification'), h('b', null, ftl.writeAmplification.toFixed(2)),
        h('span', null, 'Erases: max · min'), h('b', null, `${Math.max(...dev.erases)} · ${Math.min(...Array.from(dev.erases).filter((_, b) => b !== 11))}`),
        h('span', null, 'Bad blocks'), h('b', null, String(dev.bad.reduce((a, x) => a + x, 0)))),
      bars);
  };
  const seg = <T,>(opts: [T, string][], get: () => T, set: (v: T) => void, label: string) => {
    const g = h('span', { class: 'seg', role: 'group', 'aria-label': label });
    const bs = opts.map(([v, l]) => { const b = h('button', { type: 'button' }, l); b.addEventListener('click', () => { set(v); update(); }); g.append(b); return [v, b] as const; });
    return { el: g, sync: () => bs.forEach(([v, b]) => { b.classList.toggle('on', v === get()); b.setAttribute('aria-pressed', String(v === get())); }) };
  };
  const segs = [
    seg([[7, '7 % spare'], [25, '25 %'], [50, '50 %']] as [number, string][], () => spare, (v) => (spare = v), 'Spare space'),
    seg([[true, 'Hot data'], [false, 'Uniform']] as [boolean, string][], () => hot, (v) => (hot = v), 'Workload'),
    seg([[true, 'Wear levelling'], [false, 'None']] as [boolean, string][], () => wl, (v) => (wl = v), 'Wear levelling'),
  ];
  const el = h('div', { class: 'widget rb-widget' }, h('div', { class: 'rb-ctl' }, ...segs.map((x) => x.el)),
    h('p', { class: 'sub' }, `${G.blocks} blocks of ${G.pagesPerBlock} pages, block 11 bad from the factory, each block good for ${ENDURANCE} erases (real SLC: about 100 000; TLC: 3 000). ${WRITES.toLocaleString('en-US')} host writes; hot data: 90 % of them to a tenth of the pages.`),
    out);
  update();
  return { el };
}
