// Our processors as placed and routed by the real open-source flow (Yosys + OpenROAD, SkyWater 130 nm):
// the dual-core of chapter 24 and the RV32IM + Zicsr system core. The layout workflow publishes, per
// design, summary.json (the flow's numbers, its critical path, and our own estimates of the same design),
// cells.json and a tile pyramid rendered from the GDS by KLayout; the deploy copies them to layout/
// (the dual-core) and layout/sys/ next to the site.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { installPinch } from '../view/pinch';

/** A sky130_fd_sc_hd__nand2_1: 1.38 × 2.72 µm, the area each of our NAND equivalents is priced at. */
export const SKY130_NAND2_UM2 = 3.75;

interface SourceInfo {
  nands: number;
  name?: string;
  blocks?: { name: string; label: string; nands: number; module?: string | null }[];
  timing?: { period: number; clkToQ: number; setup: number; psPerNand: number; launch: string; capture: string; stages: { block: string; arrival: number }[] };
}
interface FinishTiming {
  periodMin: number | null;
  fmax: number | null;
  start?: string;
  end?: string;
  setup?: number | null;
  cells?: number;
  stages?: { block: string; time: number; cells: number }[];
  slowest?: { master: string; delay: number; fanout: number; block: string }[];
}
export interface LayoutSummary {
  generated: string;
  platform: string;
  die: number[];
  core: number[];
  source?: SourceInfo | null;
  run?: { seconds: number } | null;
  tiles?: { levels: number; tile: number; x0: number; y0: number; side: number } | null;
  kinds: Record<string, number>;
  blocks?: string[];
  blockArea: Record<string, number>;
  synthArea?: Record<string, number>;
  sta?: FinishTiming | null;
  masters: [string, number][];
  metrics: Record<string, number | string>;
}
interface CellData { blocks: string[]; kinds: string[]; cells: number[][] }

const DESIGNS = [
  { base: 'layout/', tab: 'Dual-core', title: 'Our dual-core, placed and routed in SkyWater 130 nm' },
  { base: 'layout/sys/', tab: 'System core (RV32IM)', title: 'Our RV32IM + Zicsr system core, placed and routed in SkyWater 130 nm' },
];
// blocks in the order the summary lists them (largest first), "other" last in grey
const BLOCK_C = ['#3b82f6', '#8b5cf6', '#16a34a', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444', '#a3e635'];
const OTHER_C = '#64748b';
const KIND_C = ['#60a5fa', '#f43f5e', '#facc15', '#22d3ee', '#334155'];
const blockColour = (blocks: string[], b: string) => (b === 'other' || !blocks.includes(b) ? OTHER_C : BLOCK_C[blocks.indexOf(b) % BLOCK_C.length]);

export function chipLayoutWidget(): Widget {
  const title = h('h3', null, DESIGNS[0].title);
  const root = h('div', null, h('p', { class: 'sub' }, 'Loading the layout…'));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'design' });
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' },
    title,
    h('p', { class: 'sub' }, 'Produced by the real open-source flow: the Verilog exported from this site\'s netlists, then Yosys (synthesis to sky130 standard cells), OpenROAD (floorplan, placement, clock tree, routing) and KLayout (rendering the GDS). Drag to pan; wheel, pinch or buttons to zoom.'),
    h('div', { class: 'param-row' }, seg),
    root));
  let raf = 0;
  let alive = true;
  let shown = -1, loads = 0;
  const tabs = DESIGNS.map((d, i) => h('button', { onclick: () => { if (i !== shown) show(i); } }, d.tab));
  seg.append(...tabs);
  show(0);

  function show(i: number) {
    shown = i;
    tabs.forEach((b, k) => b.classList.toggle('on', k === i));
    title.textContent = DESIGNS[i].title;
    cancelAnimationFrame(raf);
    raf = 0;
    root.replaceChildren(h('p', { class: 'sub' }, 'Loading the layout…'));
    void load(DESIGNS[i].base, ++loads);
  }

  async function load(base: string, n: number) {
    let sum: LayoutSummary, data: CellData;
    try {
      const r = await fetch(`${base}summary.json`);
      if (!r.ok) throw new Error(String(r.status));
      sum = await r.json();
      data = await (await fetch(`${base}cells.json`)).json();
    } catch {
      if (alive && n === loads) root.replaceChildren(h('p', { class: 'sub' }, 'This layout has not been generated for this build yet. It is produced by the "Chip layout" GitHub workflow (Yosys + OpenROAD on sky130), published as a release and copied into the site by the deploy. Locally: npm run layout:fetch.'));
      return;
    }
    if (!alive || n !== loads) return;
    build(sum, data, base);
  }

  function build(sum: LayoutSummary, data: CellData, base: string) {
    const [dx0, dy0, dx1, dy1] = sum.die;
    const T = sum.tiles ?? { levels: 0, tile: 512, x0: dx0, y0: dy0, side: Math.max(dx1 - dx0, dy1 - dy0) };
    const W = 640, H = 640;
    const view = h('div', { class: 'chip-view', style: `width:100%;max-width:${W}px;aspect-ratio:1` });
    const tilesEl = h('div', { class: 'chip-tiles' });
    const cv = h('canvas', { class: 'chip-overlay', width: String(W * 2), height: String(H * 2) }) as HTMLCanvasElement;
    const tip = h('div', { class: 'chip-tip' });
    view.append(tilesEl, cv, tip);
    let scale = W / T.side, ox = 0, oy = 0; // px per µm, offset in px
    const total = Object.values(sum.blockArea).reduce((a, v) => a + v, 0);
    const hasBlocks = data.blocks.length > 1 && (sum.blockArea.other ?? 0) < 0.5 * total;
    let mode: 'block' | 'kind' | 'none' = sum.tiles ? 'none' : hasBlocks ? 'block' : 'kind';
    let showTiles = !!sum.tiles;
    const toScreen = (x: number, y: number): [number, number] => [ox + (x - T.x0) * scale, oy + (T.y0 + T.side - y) * scale];
    const blockC = data.blocks.map((b) => blockColour(data.blocks, b));
    const label = labeller(sum);

    const draw = () => {
      raf = 0;
      const k = view.getBoundingClientRect().width / W || 1;
      tilesEl.replaceChildren();
      if (showTiles && sum.tiles) {
        // the pyramid level whose resolution best matches the zoom
        const z = Math.max(0, Math.min(T.levels - 1, Math.ceil(Math.log2((T.side * scale) / T.tile))));
        const n = 2 ** z, tw = (T.side / n) * scale;
        for (let ix = 0; ix < n; ix++) for (let iy = 0; iy < n; iy++) {
          const x = ox + ix * tw, y = oy + iy * tw;
          if (x > W || y > H || x + tw < 0 || y + tw < 0) continue;
          tilesEl.append(h('img', { src: `${base}tiles/${z}/${ix}_${iy}.png`, alt: '', style: `left:${x * k}px;top:${y * k}px;width:${tw * k + 0.5}px;height:${tw * k + 0.5}px` }));
        }
      }
      const g = cv.getContext('2d')!;
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, W, H);
      const [ax, ay] = toScreen(dx0, dy1), [bx, by] = toScreen(dx1, dy0);
      g.strokeStyle = '#94a3b8';
      g.lineWidth = 1;
      g.strokeRect(ax, ay, bx - ax, by - ay);
      if (mode === 'none') return;
      g.globalAlpha = showTiles ? 0.55 : 0.9;
      for (const c of data.cells) {
        if (c[1] === 4) continue; // fillers and well taps
        const [x, y] = toScreen(c[2], c[3] + c[5]);
        const w = c[4] * scale, hh = c[5] * scale;
        if (x > W || y > H || x + w < 0 || y + hh < 0) continue;
        g.fillStyle = mode === 'block' ? blockC[c[0]] : KIND_C[c[1]];
        g.fillRect(x, y, Math.max(w, 0.6), Math.max(hh, 0.6));
      }
      g.globalAlpha = 1;
    };
    const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const zoomAt = (f: number, px: number, py: number) => { ox = px - (px - ox) * f; oy = py - (py - oy) * f; scale *= f; redraw(); };
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
      const r = view.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    view.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = local(e); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, px, py); }, { passive: false });
    let drag: [number, number] | null = null;
    installPinch(view, {
      start: () => { drag = null; },
      move: (k, mid, prev) => {
        const [px, py] = local({ clientX: prev[0], clientY: prev[1] }), [mx, my] = local({ clientX: mid[0], clientY: mid[1] });
        ox += mx - px; oy += my - py;
        zoomAt(k, mx, my);
      },
    });
    view.addEventListener('pointerdown', (e) => { drag = local(e); view.setPointerCapture(e.pointerId); });
    const up = () => { drag = null; };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    view.addEventListener('pointermove', (e) => {
      const [px, py] = local(e);
      if (drag) { ox += px - drag[0]; oy += py - drag[1]; drag = [px, py]; redraw(); return; }
      const x = T.x0 + (px - ox) / scale, y = T.y0 + T.side - (py - oy) / scale;
      const hit = data.cells.find((c) => c[1] !== 4 && x >= c[2] && x <= c[2] + c[4] && y >= c[3] && y <= c[3] + c[5]);
      tip.textContent = hit
        ? `${label(data.blocks[hit[0]])} · ${data.kinds[hit[1]]} · ${hit[4].toFixed(2)} × ${hit[5].toFixed(2)} µm at (${hit[2].toFixed(1)}, ${hit[3].toFixed(1)})`
        : `(${x.toFixed(1)}, ${y.toFixed(1)}) µm`;
    });

    const modeSel = h('select', { 'aria-label': 'colour cells by' }) as HTMLSelectElement;
    for (const [v, t] of [['none', 'cells: off'], ['block', 'colour by block'], ['kind', 'colour by cell type']]) modeSel.append(h('option', { value: v }, t));
    modeSel.value = mode;
    const legendEl = h('div', { class: 'cx-legend' });
    const legend = () => legendEl.replaceChildren(...(mode === 'none' ? [] : mode === 'block'
      ? data.blocks.map((n, i) => h('span', null, h('i', { style: `background:${blockC[i]}` }), label(n)))
      : data.kinds.slice(0, 4).map((n, i) => h('span', null, h('i', { style: `background:${KIND_C[i]}` }), n))));
    modeSel.addEventListener('change', () => { mode = modeSel.value as typeof mode; legend(); redraw(); });
    legend();

    const num = (re: RegExp) => { const e = Object.entries(sum.metrics).find(([k]) => re.test(k)); return e ? Number(e[1]) : NaN; };
    const dieW = dx1 - dx0, dieH = dy1 - dy0;
    const kinds = Object.entries(sum.kinds).filter(([k]) => k !== 'filler');
    const insts = kinds.reduce((a, [, v]) => a + v, 0);
    const ws = num(/finish__timing__setup__ws$/), power = num(/finish__power__total$/), util = num(/finish__design__instance__utilization$/), wl = num(/^detailedroute__route__wirelength$/);
    const rows: [string, string][] = [
      ['die', `${dieW.toFixed(0)} × ${dieH.toFixed(0)} µm (${((dieW * dieH) / 1e6).toFixed(3)} mm²)`],
      ['standard cells', `${insts.toLocaleString()} (${kinds.map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ')})`],
      ['from our netlist', sum.source ? `${sum.source.nands.toLocaleString()} NAND equivalents → ${insts.toLocaleString()} library cells` : '–'],
    ];
    if (!sum.source?.blocks) rows.push(['area by block', Object.entries(sum.blockArea).map(([b, a]) => `${label(b)} ${(a / 1e3).toFixed(1)}k µm²`).join(' · ')]);
    if (Number.isFinite(util)) rows.push(['utilization', `${(util * 100).toFixed(0)} %`]);
    if (Number.isFinite(wl)) rows.push(['routed wire', `${(wl / 1000).toFixed(1)} mm`]);
    if (Number.isFinite(ws)) rows.push(['setup slack (40 ns clock)', `${ws.toFixed(2)} ns`]);
    if (Number.isFinite(power)) rows.push(['power (estimate)', `${(power * 1000).toFixed(1)} mW at 25 MHz`]);
    rows.push(['most used cells', sum.masters.slice(0, 8).map(([n, c]) => `${n.replace('sky130_fd_sc_hd__', '')} ×${c}`).join(', ')]);
    rows.push(['generated', `${new Date(sum.generated).toLocaleString()}${sum.run ? `, flow ran ${Math.round(sum.run.seconds / 60)} min` : ''}`]);

    const GALLERY: [string, string][] = [
      ['final_all', 'everything'], ['final_placement', 'placed cells'], ['final_routing', 'routing'], ['final_clocks', 'the clock tree'],
      ['final_congestion', 'routing congestion'], ['final_ir_drop', 'IR drop on the power grid'], ['final_worst_path', 'the critical path'],
    ];
    const gallery = h('div', { class: 'chip-gallery' }, ...GALLERY.map(([f, cap]) => h('a', { href: `${base}reports/base/${f}.webp.png`, target: '_blank', rel: 'noopener' },
      h('img', { src: `${base}reports/base/${f}.webp.png`, alt: cap, loading: 'lazy', onerror: (e: Event) => ((e.target as HTMLElement).parentElement!.style.display = 'none') }), h('span', null, cap))));
    const btn = (text: string, f: () => void) => h('button', { class: 'btn sm', onclick: f }, text);
    root.replaceChildren(
      h('div', { class: 'param-row' },
        btn('+', () => zoomAt(1.5, W / 2, H / 2)), btn('−', () => zoomAt(1 / 1.5, W / 2, H / 2)), btn('fit', () => { scale = W / T.side; ox = oy = 0; redraw(); }),
        modeSel,
        ...(sum.tiles ? [h('label', { class: 'lay-chk' }, h('input', { type: 'checkbox', checked: '', onchange: (e: Event) => { showTiles = (e.target as HTMLInputElement).checked; redraw(); } }), 'GDS layers')] : [])),
      legendEl, view,
      h('div', { class: 'cpu-mem chip-stats' }, ...rows.map(([k, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, k), h('span', { class: 'v' }, v)))),
      ...estimateVsFlow(sum, data.blocks, label),
      h('div', { class: 'cpu-sec' }, 'OpenROAD\'s own views of the result'), gallery,
      h('p', { class: 'sub' }, h('a', { href: `${base}mosfet_riscv.v`, download: '' }, 'Download the exported Verilog'), `. The flow reports are in ${base}reports/.`));
    redraw();
  }

  return { el, destroy: () => { alive = false; cancelAnimationFrame(raf); } };
}

/** Block names as our netlist labels them ('core0.alu' → 'core 0 › alu'). */
function labeller(sum: LayoutSummary): (b: string) => string {
  const names = new Map((sum.source?.blocks ?? []).map((b) => [b.name, b.label]));
  return (b) => (b === 'other' ? 'other' : b.split('.').map((p, i) => (i === 0 ? names.get(p) ?? p : p)).join(' › '));
}

/** Our estimates of the design (NAND count per block, unit-delay static timing) beside what the flow measured. */
function estimateVsFlow(sum: LayoutSummary, blocks: string[], label: (b: string) => string): HTMLElement[] {
  const src = sum.source;
  if (!src?.blocks || !src.timing) return [];
  const out: HTMLElement[] = [h('div', { class: 'cpu-sec' }, 'Our estimate against sky130')];
  const um = (a: number) => `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  const ratio = (r: number) => (Number.isFinite(r) ? `${r.toFixed(2)} ×` : '–');

  // area: every NAND equivalent priced as a NAND2 cell, against Yosys's area for the blocks it synthesized as modules
  // of their own (a flattened block's cells lose its name, so only these can be told apart), the rest together
  const SA = sum.synthArea ?? {};
  const total = SA.mosfet_riscv ?? Number(sum.metrics.synth__design__instance__area);
  const kept = src.blocks.filter((b) => b.module && SA[b.module] !== undefined);
  if (kept.length && Number.isFinite(total)) {
    const keptNands = kept.reduce((a, b) => a + b.nands, 0), keptArea = kept.reduce((a, b) => a + SA[b.module!], 0);
    const row = (name: string, nands: number, area: number, bold = false) => {
      const td = (t: string, cls?: string) => h('td', cls ? { class: cls } : null, bold ? h('strong', null, t) : t);
      return h('tr', null, td(name), td(nands.toLocaleString(), 'num'), td(um(nands * SKY130_NAND2_UM2), 'num'), td(um(area), 'num'), td(ratio(area / (nands * SKY130_NAND2_UM2)), 'num'));
    };
    out.push(h('div', { class: 'lay-scroll' }, h('table', { class: 'cmp' },
      h('thead', null, h('tr', null, h('th', null, 'block'), h('th', null, 'our NANDs'), h('th', null, `× ${SKY130_NAND2_UM2} µm²`), h('th', null, 'sky130 µm²'), h('th', null, 'sky130 / ours'))),
      h('tbody', null,
        ...kept.map((b) => row(label(b.name), b.nands, SA[b.module!])),
        row('the rest', src.nands - keptNands, total - keptArea),
        row('whole design', src.nands, total, true)))));
    const over = kept.filter((b) => SA[b.module!] > b.nands * SKY130_NAND2_UM2);
    const ha = sum.masters.find(([m]) => m === 'sky130_fd_sc_hd__ha_1')?.[1] ?? 0;
    const placed = Number(sum.metrics.finish__design__instance__area__stdcell);
    out.push(h('p', { class: 'sub' }, `Each of our NAND equivalents is priced as one ${SKY130_NAND2_UM2} µm² NAND2 cell, against the cells Yosys chose for the same logic. The library does better wherever it has one cell for what we build from several NANDs (a flip-flop with an enable, edfxtp, instead of a DFF and a multiplexer; a 2:1 multiplexer, mux2i; an and-or-invert), and Yosys removes logic whose result nothing reads and merges what is computed twice, which our count keeps. `
      + (over.length ? `Where the ratio is above 1 (${over.map((b) => label(b.name)).join(', ')}) it spent more than our count${ha ? `: it built the adders from ${ha.toLocaleString()} half-adder cells (ha_1, 12.5 µm² each) and buffered the heavily loaded nets` : ''}. ` : '')
      + (Number.isFinite(placed) ? `Placement then adds the clock tree, timing repair buffers and well taps: ${um(placed)} µm² of cells on the finished die.` : '')));
  }

  // timing: our unit-delay critical path against OpenSTA's after routing
  const t = src.timing, sta = sum.sta;
  const ns = (t.period * t.psPerNand) / 1000;
  const lines: [string, string][] = [
    ['our critical path', `${t.period} NAND delays (clk-to-q ${t.clkToQ} + logic + setup ${t.setup}), ${pathEnds(t.launch, t.capture, label)}`],
    [`at our illustrative ${t.psPerNand} ps`, `${ns.toFixed(2)} ns, ${(1000 / ns).toFixed(0)} MHz (a 28 nm-class guess)`],
  ];
  if (sta?.periodMin) {
    lines.push(['sky130 after routing', `${sta.periodMin.toFixed(2)} ns, ${(sta.fmax ?? 1000 / sta.periodMin).toFixed(0)} MHz over ${sta.cells ?? '?'} cells (OpenSTA: ${sta.start ?? '?'} → ${sta.end ?? '?'})`]);
    lines.push(['so one of our NAND delays', `≈ ${((sta.periodMin * 1000) / t.period).toFixed(0)} ps in this sky130 layout, against our ${t.psPerNand} ps`]);
  }
  out.push(h('div', { class: 'cpu-mem chip-stats' }, ...lines.map(([k, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, k), h('span', { class: 'v' }, v)))));
  if (sta?.stages?.length) {
    out.push(pathBars(t, sta, blocks, label));
    const slow = sta.slowest?.[0];
    out.push(h('p', { class: 'sub' }, 'The two paths need not be the same one. Ours charges every NAND the same delay; in silicon a gate is slower the more inputs it drives and the longer its wire, so the tools insert buffers, and a path through a few heavily loaded nets can overtake a path with more gates on it.'
      + (slow ? ` The slowest cell on sky130's path is a ${slow.master} in ${label(slow.block)} driving ${slow.fanout} inputs: ${slow.delay.toFixed(2)} ns, several NAND2 delays on its own.` : '')
      + ' The flow was given a relaxed 40 ns clock, so it did not trade area for speed: a tighter clock would get a faster, larger layout.'));
  }
  return out;
}

const pathEnds = (launch: string, capture: string, label: (b: string) => string) =>
  `from ${launch ? label(launch.split('.')[0]) : 'an input'} to ${capture.includes('.') ? label(capture.split('.')[0]) : `the output ${capture}`}`;

/** Both critical paths as bars of the same width, split by the block each stretch of the path is in. */
function pathBars(t: NonNullable<SourceInfo['timing']>, sta: FinishTiming, blocks: string[], label: (b: string) => string): HTMLElement {
  const W = 600, BH = 22;
  type Seg = { name: string; colour: string; dur: number };
  const ours: Seg[] = [];
  let prev = t.launch ? t.clkToQ : 0;
  if (t.launch) ours.push({ name: 'clk-to-q', colour: OTHER_C, dur: t.clkToQ });
  for (const s of t.stages) { ours.push({ name: label(s.block), colour: blockColour(blocks, s.block.split('.')[0]), dur: s.arrival - prev }); prev = s.arrival; }
  if (t.capture.includes('.')) ours.push({ name: 'setup', colour: OTHER_C, dur: t.setup });
  const theirs: Seg[] = [];
  prev = 0;
  for (const s of sta.stages!) { theirs.push({ name: s.block === 'other' ? 'glue' : label(s.block), colour: blockColour(blocks, s.block), dur: s.time - prev }); prev = s.time; }
  if (sta.setup) theirs.push({ name: 'setup', colour: OTHER_C, dur: sta.setup });
  const bar = (segs: Seg[], y: number, unit: string) => {
    const total = segs.reduce((a, s) => a + s.dur, 0);
    let x = 0, s = '';
    for (const g of segs) {
      const w = (g.dur / total) * W;
      const tip = `${g.name}: ${unit === 'ns' ? g.dur.toFixed(2) : g.dur} ${unit}`;
      s += `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(w - 1, 0.5).toFixed(1)}" height="${BH}" fill="${g.colour}"><title>${esc(tip)}</title></rect>`;
      // the last word of a nested name ('core 0 › alu' → 'alu') when the whole one does not fit
      const short = g.name.split(' › ').pop()!;
      const text = w > 6.5 * g.name.length + 6 ? g.name : w > 6.5 * short.length + 6 ? short : '';
      if (text) s += `<text x="${(x + w / 2).toFixed(1)}" y="${y + 15}" text-anchor="middle" class="lp-in">${esc(text)}</text>`;
      x += w;
    }
    return s;
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${2 * BH + 44}`);
  svg.setAttribute('class', 'lay-path');
  svg.innerHTML = `<text x="0" y="12" class="lp-cap">ours: ${t.period} NAND delays</text>${bar(ours, 16, 'NAND delays')}`
    + `<text x="0" y="${BH + 32}" class="lp-cap">sky130: ${(sta.periodMin ?? 0).toFixed(2)} ns</text>${bar(theirs, BH + 36, 'ns')}`;
  return h('div', null, svg);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
