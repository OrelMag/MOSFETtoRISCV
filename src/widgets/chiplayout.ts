// The dual-core as placed and routed by the real open-source flow (Yosys + OpenROAD, SkyWater
// 130 nm). The layout workflow publishes summary.json, cells.json and a tile pyramid rendered from
// the GDS by KLayout; the deploy copies them to layout/ next to the site.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { installPinch } from '../view/pinch';

interface LayoutSummary {
  generated: string;
  platform: string;
  die: number[];
  core: number[];
  source?: { nands: number } | null;
  run?: { seconds: number } | null;
  tiles?: { levels: number; tile: number; x0: number; y0: number; side: number } | null;
  kinds: Record<string, number>;
  blockArea: Record<string, number>;
  masters: [string, number][];
  metrics: Record<string, number | string>;
}
interface CellData { blocks: string[]; kinds: string[]; cells: number[][] }

const BLOCK_C = ['#3b82f6', '#8b5cf6', '#16a34a', '#f59e0b', '#64748b'];
const KIND_C = ['#60a5fa', '#f43f5e', '#facc15', '#22d3ee', '#334155'];

export function chipLayoutWidget(): Widget {
  const root = h('div', null, h('p', { class: 'sub' }, 'Loading the layout…'));
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' },
    h('h3', null, 'Our dual-core, placed and routed in SkyWater 130 nm'),
    h('p', { class: 'sub' }, 'Produced by the real open-source flow: the Verilog exported from this site\'s netlists, then Yosys (synthesis to sky130 standard cells), OpenROAD (floorplan, placement, clock tree, routing) and KLayout (rendering the GDS). Drag to pan; wheel, pinch or buttons to zoom.'),
    root));
  let raf = 0;
  let alive = true;
  void load();

  async function load() {
    let sum: LayoutSummary, data: CellData;
    try {
      const r = await fetch('layout/summary.json');
      if (!r.ok) throw new Error(String(r.status));
      sum = await r.json();
      data = await (await fetch('layout/cells.json')).json();
    } catch {
      root.replaceChildren(h('p', { class: 'sub' }, 'The layout has not been generated for this build yet. It is produced by the "Chip layout" GitHub workflow (Yosys + OpenROAD on sky130), published as a release and copied into the site by the deploy. Locally: npm run layout:fetch.'));
      return;
    }
    if (!alive) return;
    build(sum, data);
  }

  function build(sum: LayoutSummary, data: CellData) {
    const [dx0, dy0, dx1, dy1] = sum.die;
    const T = sum.tiles ?? { levels: 0, tile: 512, x0: dx0, y0: dy0, side: Math.max(dx1 - dx0, dy1 - dy0) };
    const W = 640, H = 640;
    const view = h('div', { class: 'chip-view', style: `width:100%;max-width:${W}px;aspect-ratio:1` });
    const tilesEl = h('div', { class: 'chip-tiles' });
    const cv = h('canvas', { class: 'chip-overlay', width: String(W * 2), height: String(H * 2) }) as HTMLCanvasElement;
    const tip = h('div', { class: 'chip-tip' });
    view.append(tilesEl, cv, tip);
    let scale = W / T.side, ox = 0, oy = 0; // px per µm, offset in px
    const hasBlocks = Object.keys(sum.blockArea).some((b) => b.startsWith('core')) && (sum.blockArea.other ?? 0) < 0.5 * Object.values(sum.blockArea).reduce((a, v) => a + v, 0);
    let mode: 'block' | 'kind' | 'none' = sum.tiles ? 'none' : hasBlocks ? 'block' : 'kind';
    let showTiles = !!sum.tiles;
    const toScreen = (x: number, y: number): [number, number] => [ox + (x - T.x0) * scale, oy + (T.y0 + T.side - y) * scale];

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
          tilesEl.append(h('img', { src: `layout/tiles/${z}/${ix}_${iy}.png`, alt: '', style: `left:${x * k}px;top:${y * k}px;width:${tw * k + 0.5}px;height:${tw * k + 0.5}px` }));
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
        g.fillStyle = mode === 'block' ? BLOCK_C[c[0]] : KIND_C[c[1]];
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
        ? `${data.blocks[hit[0]]} · ${data.kinds[hit[1]]} · ${hit[4].toFixed(2)} × ${hit[5].toFixed(2)} µm at (${hit[2].toFixed(1)}, ${hit[3].toFixed(1)})`
        : `(${x.toFixed(1)}, ${y.toFixed(1)}) µm`;
    });

    const modeSel = h('select', { 'aria-label': 'colour cells by' }) as HTMLSelectElement;
    for (const [v, t] of [['none', 'cells: off'], ['block', 'colour by block'], ['kind', 'colour by cell type']]) modeSel.append(h('option', { value: v }, t));
    modeSel.value = mode;
    const legendEl = h('div', { class: 'cx-legend' });
    const legend = () => legendEl.replaceChildren(...(mode === 'none' ? [] : (mode === 'block' ? data.blocks : data.kinds.slice(0, 4))
      .map((n, i) => h('span', null, h('i', { style: `background:${(mode === 'block' ? BLOCK_C : KIND_C)[i]}` }), n))));
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
      ['area by block', Object.entries(sum.blockArea).map(([b, a]) => `${b} ${(a / 1e3).toFixed(1)}k µm²`).join(' · ')],
    ];
    if (Number.isFinite(util)) rows.push(['utilization', `${(util * 100).toFixed(0)} %`]);
    if (Number.isFinite(wl)) rows.push(['routed wire', `${(wl / 1000).toFixed(1)} mm`]);
    if (Number.isFinite(ws)) rows.push(['setup slack (40 ns clock)', `${ws.toFixed(2)} ns, so fmax ≈ ${(1000 / (40 - ws)).toFixed(0)} MHz`]);
    if (Number.isFinite(power)) rows.push(['power (estimate)', `${(power * 1000).toFixed(1)} mW`]);
    rows.push(['most used cells', sum.masters.slice(0, 8).map(([n, c]) => `${n.replace('sky130_fd_sc_hd__', '')} ×${c}`).join(', ')]);
    rows.push(['generated', `${new Date(sum.generated).toLocaleString()}${sum.run ? `, flow ran ${Math.round(sum.run.seconds / 60)} min` : ''}`]);

    const GALLERY: [string, string][] = [
      ['final_all', 'everything'], ['final_placement', 'placed cells'], ['final_routing', 'routing'], ['final_clocks', 'the clock tree'],
      ['final_congestion', 'routing congestion'], ['final_ir_drop', 'IR drop on the power grid'], ['final_worst_path', 'the critical path'],
    ];
    const gallery = h('div', { class: 'chip-gallery' }, ...GALLERY.map(([f, cap]) => h('a', { href: `layout/reports/base/${f}.webp.png`, target: '_blank', rel: 'noopener' },
      h('img', { src: `layout/reports/base/${f}.webp.png`, alt: cap, loading: 'lazy', onerror: (e: Event) => ((e.target as HTMLElement).parentElement!.style.display = 'none') }), h('span', null, cap))));
    const btn = (label: string, f: () => void) => h('button', { class: 'btn sm', onclick: f }, label);
    root.replaceChildren(
      h('div', { class: 'param-row' },
        btn('+', () => zoomAt(1.5, W / 2, H / 2)), btn('−', () => zoomAt(1 / 1.5, W / 2, H / 2)), btn('fit', () => { scale = W / T.side; ox = oy = 0; redraw(); }),
        modeSel,
        ...(sum.tiles ? [h('label', { class: 'lay-chk' }, h('input', { type: 'checkbox', checked: '', onchange: (e: Event) => { showTiles = (e.target as HTMLInputElement).checked; redraw(); } }), 'GDS layers')] : [])),
      legendEl, view,
      h('div', { class: 'cpu-mem chip-stats' }, ...rows.map(([k, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, k), h('span', { class: 'v' }, v)))),
      h('div', { class: 'cpu-sec' }, 'OpenROAD\'s own views of the result'), gallery,
      h('p', { class: 'sub' }, h('a', { href: 'layout/mosfet_riscv.v', download: '' }, 'Download the exported Verilog'), '. The flow reports are in layout/reports/.'));
    redraw();
  }

  return { el, destroy: () => { alive = false; cancelAnimationFrame(raf); } };
}
