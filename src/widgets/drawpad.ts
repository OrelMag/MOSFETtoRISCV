// Chapter 30's last step: the learner draws (triangles, polygons, brush strokes) and the gate-level GPU draws it. The
// pad shows the shapes as drawn (smooth, each at its opacity); gfx/tessellate.ts cuts them into triangles; the screen
// panel feeds them to the rasterizer and the result is compared, pixel for pixel, with the reference picture.

import { FB_W, type Vtx } from '../gfx/raster';
import {
  cross, type Drawing, drawingCost, drawingOps, drawingPicture, MAX_SHAPES, MAX_TRIANGLES, SAMPLE_DRAWINGS, type Shape, shapeTriangles, type Tool,
} from '../gfx/tessellate';
import { GPU30Z, VERTEX_PINS } from '../lib/raster';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { rgb332 } from '../gfx/raster';
import { CLEAR, type DrawLink, opInputs, screenPanel } from './screen';

/** The pad's colours (RGB332): greys, then a wheel, then earth and sky. */
export const PAD_COLOURS = [0x00, 0x49, 0x92, 0xff, 0xe0, 0xf0, 0xfc, 0x1c, 0x34, 0x1f, 0x57, 0x03, 0x63, 0xe3, 0x64, 0xd1];

const STORE = 'mosfet:gfx-drawing';
const css332 = (c: number, alpha = 1) => { const [r, g, b] = rgb332(c); return `rgba(${r},${g},${b},${alpha})`; };

function loadDrawing(): Drawing {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Drawing | null;
    if (d && typeof d.bg === 'number' && Array.isArray(d.shapes)) return d;
  } catch { /* no storage, or not ours: start from the sample */ }
  return structuredClone(SAMPLE_DRAWINGS[0].d);
}
function saveDrawing(d: Drawing): void {
  try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* the drawing just is not kept */ }
}

/** The last step: GPU30Z on the cycle engine, the drawing pad on the left feeding the screen panel on the right. */
export function drawScene(): Scene {
  const link: DrawLink = {};
  return {
    root: GPU30Z,
    inputs: { ...opInputs(CLEAR), go: 0, swap: 0, sync: 1, clk: 0 },
    highlight: ['rast', 'rop'], autoClock: false, engine: 'cycle',
    // the pad and the screen panel drive every pin but the clock: the stage keeps its height for them
    hiddenInputs: [...VERTEX_PINS, 'z0', 'z1', 'z2', 'col', 'a', 'zt', 'clr', 'go', 'swap', 'sync'],
    panels: [screenPanel({ gpu: true, link }), drawPanel(link)],
  };
}

function drawPanel(link: DrawLink): ScenePanel {
  return (stage: Stage): Widget => {
    let d = loadDrawing();
    const undo: string[] = [];
    let tool: Tool = 'poly', col = 0xe0, alpha = 7, width = 2, showTris = false;
    /** Corners clicked so far (triangle, polygon) or the stroke being drawn. */
    let draft: Vtx[] = [], hover: Vtx | null = null, stroking = false;
    /** The drawing's version, and what the last send gave back. */
    let version = 0;
    let result: { version: number; cycles: number; predicted: number; diff: number } | null = null;
    let sending = false;
    // the cost walks every triangle: once per change, not per pointer move
    let costOf = { version: -1, cost: drawingCost({ bg: 0, shapes: [] }), over: false };

    const S = 2; // canvas pixels per quarter pixel
    const pad = h('canvas', { class: 'gfx-pad', width: 256 * S, height: 256 * S, tabindex: '0', 'aria-label': 'drawing pad, 64 by 64 pixels' }) as HTMLCanvasElement;
    const status = h('div', { class: 'cpu-status' });
    const hint = h('p', { class: 'cpu-sec-hint' });

    const change = (f: () => void) => {
      undo.push(JSON.stringify(d));
      if (undo.length > 100) undo.shift();
      f();
      version++;
      saveDrawing(d);
      draw();
    };

    // ---- tools ----
    const toolBtns = new Map<Tool, HTMLButtonElement>();
    const toolRow = h('div', { class: 'gfx-tools param-row' });
    for (const [t, label, title] of [
      ['tri', 'Triangle', 'three clicks: one triangle, sent as clicked if "keep my winding" is ticked'],
      ['poly', 'Polygon', 'click the corners; click the first one again (or double-click, or Enter) to close'],
      ['brush', 'Brush', 'drag to paint a stroke'],
    ] as [Tool, string, string][]) {
      const b = h('button', { class: 'btn sm', title }, label) as HTMLButtonElement;
      b.addEventListener('click', () => { tool = t; draft = []; syncTools(); draw(); });
      toolBtns.set(t, b);
      toolRow.append(b);
    }
    const widthSel = h('select', { 'aria-label': 'brush width', title: 'brush width' },
      ...[1, 2, 3, 4, 6].map((w) => h('option', { value: String(w) }, `${w} px`))) as HTMLSelectElement;
    widthSel.value = String(width);
    widthSel.addEventListener('change', () => { width = Number(widthSel.value); });
    const alphaSel = h('select', { 'aria-label': 'opacity', title: 'opacity, in eighths: the ROP blends (s·(a + 1) + d·(7 − a)) / 8' },
      ...[7, 5, 3, 1].map((a) => h('option', { value: String(a) }, a === 7 ? 'opaque' : `${a + 1}/8`))) as HTMLSelectElement;
    alphaSel.addEventListener('change', () => { alpha = Number(alphaSel.value); });
    toolRow.append(widthSel);

    const swatches = h('div', { class: 'gfx-swatches', role: 'radiogroup', 'aria-label': 'colour' });
    const swBtns = PAD_COLOURS.map((c) => {
      const b = h('button', { class: 'gfx-swatch', title: `0x${c.toString(16).padStart(2, '0')}`, 'aria-label': `colour 0x${c.toString(16)}`, style: `background:${css332(c)}` });
      b.addEventListener('click', () => { col = c; syncTools(); });
      swatches.append(b);
      return b;
    });
    const syncTools = () => {
      toolBtns.forEach((b, t) => b.classList.toggle('on', t === tool));
      swBtns.forEach((b, i) => b.classList.toggle('on', PAD_COLOURS[i] === col));
      widthSel.hidden = tool !== 'brush';
      pad.style.cursor = 'crosshair';
      hint.textContent = tool === 'tri' ? 'Click three corners.'
        : tool === 'poly' ? 'Click the corners, then the first one again to close (or double-click, or Enter). Esc drops it.'
        : 'Drag to paint.';
    };

    // ---- actions ----
    const bgBtn = h('button', { class: 'btn sm', title: 'the clear colour: the back frame is cleared to it before the shapes' }, 'Background');
    bgBtn.addEventListener('click', () => change(() => { d.bg = col; }));
    const undoBtn = h('button', { class: 'btn sm', title: 'take back the last change' }, 'Undo');
    undoBtn.addEventListener('click', () => {
      if (draft.length) { draft = []; draw(); return; }
      const prev = undo.pop();
      if (!prev) return;
      d = JSON.parse(prev) as Drawing;
      version++;
      saveDrawing(d);
      draw();
    });
    const clearBtn = h('button', { class: 'btn sm', title: 'remove every shape' }, 'Clear');
    clearBtn.addEventListener('click', () => { if (d.shapes.length) change(() => { d.shapes = []; }); });
    const sampleSel = h('select', { 'aria-label': 'start from', title: 'start from a drawing (Undo brings yours back)' },
      h('option', { value: '' }, 'Start from…'), ...SAMPLE_DRAWINGS.map((s) => h('option', { value: s.id }, s.title))) as HTMLSelectElement;
    sampleSel.addEventListener('change', () => {
      const s = SAMPLE_DRAWINGS.find((x) => x.id === sampleSel.value);
      sampleSel.value = '';
      if (s) change(() => { d = { ...structuredClone(s.d), keepWinding: d.keepWinding }; });
    });
    const trisBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    trisBox.addEventListener('change', () => { showTris = trisBox.checked; draw(); });
    const windBox = h('input', { type: 'checkbox', checked: !!d.keepWinding }) as HTMLInputElement;
    windBox.addEventListener('change', () => change(() => { d.keepWinding = windBox.checked; }));
    const sendBtn = h('button', { class: 'btn sm primary', title: 'clear the back frame, draw every triangle on the gate-level rasterizer, swap' }, 'Send to the GPU');
    sendBtn.addEventListener('click', () => {
      if (!link.play) return;
      const v = version, want = drawingPicture(d), cost = drawingCost(d);
      sending = true;
      draw();
      link.play(drawingOps(d), (shown, cycles) => {
        let diff = 0;
        for (let i = 0; i < shown.length; i++) if (shown[i] !== want[i]) diff++;
        result = { version: v, cycles, predicted: cost.clear + cost.draw, diff };
        sending = false;
        draw();
      });
    });
    stage.resetHooks.add(() => { sending = false; draw(); });

    // ---- the pad ----
    const at = (ev: PointerEvent | MouseEvent): Vtx => {
      const r = pad.getBoundingClientRect();
      const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 256)));
      return [q((ev.clientX - r.left) / r.width), q((ev.clientY - r.top) / r.height)];
    };
    const near = (a: Vtx, b: Vtx) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 8;
    const commit = (s: Shape) => {
      draft = [];
      if (d.shapes.length >= MAX_SHAPES) { hint.textContent = `${MAX_SHAPES} shapes is the most a drawing can hold (each needs a depth of its own).`; draw(); return; }
      change(() => { d.shapes.push(s); });
    };
    const closePoly = () => {
      const p = draft.filter((v, i) => i === 0 || !near(v, draft[i - 1]));
      if (p.length >= 3) commit({ tool: 'poly', pts: p, col, a: alpha });
      else { draft = []; draw(); }
    };
    pad.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      pad.focus();
      const p = at(ev);
      if (tool === 'brush') {
        stroking = true;
        draft = [p];
        pad.setPointerCapture(ev.pointerId);
      } else if (tool === 'tri') {
        draft.push(p);
        if (draft.length === 3) commit({ tool: 'tri', pts: draft, col, a: alpha });
      } else if (draft.length >= 3 && near(p, draft[0])) closePoly();
      else if (!draft.length || !near(p, draft[draft.length - 1])) draft.push(p);
      draw();
    });
    pad.addEventListener('pointermove', (ev) => {
      hover = at(ev);
      if (stroking) {
        const last = draft[draft.length - 1];
        if (Math.hypot(hover[0] - last[0], hover[1] - last[1]) >= 4) draft.push(hover);
      }
      draw();
    });
    const endStroke = () => {
      if (!stroking) return;
      stroking = false;
      commit({ tool: 'brush', pts: draft, col, a: alpha, w: width });
    };
    pad.addEventListener('pointerup', endStroke);
    pad.addEventListener('pointercancel', endStroke);
    pad.addEventListener('pointerleave', () => { hover = null; draw(); });
    pad.addEventListener('dblclick', () => { if (tool === 'poly') closePoly(); });
    pad.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && tool === 'poly') { closePoly(); ev.preventDefault(); }
      else if (ev.key === 'Escape' && draft.length) { draft = []; draw(); ev.preventDefault(); }
      else return;
      ev.stopPropagation();
    });

    const shapePath = (c: CanvasRenderingContext2D, pts: Vtx[], close: boolean) => {
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x * S, y * S) : c.moveTo(x * S, y * S)));
      if (close) c.closePath();
    };
    const paintShape = (c: CanvasRenderingContext2D, s: Shape) => {
      const a = (s.a + 1) / 8;
      if (s.tool === 'brush') {
        if (s.pts.length === 1) {
          const hw = 2 * (s.w ?? 2) * S;
          c.fillStyle = css332(s.col, a);
          c.fillRect(s.pts[0][0] * S - hw, s.pts[0][1] * S - hw, 2 * hw, 2 * hw);
          return;
        }
        c.strokeStyle = css332(s.col, a);
        c.lineWidth = 4 * (s.w ?? 2) * S;
        c.lineCap = 'square'; c.lineJoin = 'miter'; c.miterLimit = 2;
        shapePath(c, s.pts, false);
        c.stroke();
        return;
      }
      if (s.tool === 'tri' && d.keepWinding && s.pts.length === 3 && cross(s.pts[0], s.pts[1], s.pts[2]) < 0) {
        // a back face: the GPU culls it; show its outline only
        c.setLineDash([6, 5]); c.lineWidth = 2; c.strokeStyle = css332(s.col);
        shapePath(c, s.pts, true); c.stroke(); c.setLineDash([]);
        const cx = (s.pts[0][0] + s.pts[1][0] + s.pts[2][0]) / 3 * S, cy = (s.pts[0][1] + s.pts[1][1] + s.pts[2][1]) / 3 * S;
        c.font = '600 18px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillText('back face', cx, cy);
        return;
      }
      c.fillStyle = css332(s.col, a);
      shapePath(c, s.pts, true);
      c.fill('evenodd');
    };

    const draw = () => {
      const c = pad.getContext('2d')!, W = pad.width;
      c.fillStyle = css332(d.bg);
      c.fillRect(0, 0, W, W);
      for (const s of d.shapes) paintShape(c, s);
      // the pixel grid, faint
      c.strokeStyle = 'rgba(128,128,128,0.16)'; c.lineWidth = 1; c.beginPath();
      for (let i = 1; i < FB_W; i++) { const p = i * 4 * S + 0.5; c.moveTo(p, 0); c.lineTo(p, W); c.moveTo(0, p); c.lineTo(W, p); }
      c.stroke();
      if (showTris) {
        for (const s of d.shapes) for (const t of shapeTriangles(s, d.keepWinding)) {
          shapePath(c, t, true);
          c.lineWidth = 2.5; c.strokeStyle = 'rgba(0,0,0,0.5)'; c.stroke();
          c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.9)'; c.stroke();
        }
      }
      // the shape being drawn
      if (draft.length) {
        const live = tool === 'brush' ? { tool, pts: draft, col, a: alpha, w: width } as Shape : null;
        if (live) paintShape(c, live);
        else {
          c.setLineDash([5, 4]); c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,0.9)';
          shapePath(c, hover ? [...draft, hover] : draft, false); c.stroke(); c.setLineDash([]);
          draft.forEach(([x, y], i) => {
            c.beginPath(); c.arc(x * S, y * S, i === 0 && tool === 'poly' && draft.length >= 3 && hover && near(hover, draft[0]) ? 9 : 5, 0, 7);
            c.fillStyle = css332(col); c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.stroke();
          });
        }
      }
      if (costOf.version !== version) costOf = { version, cost: drawingCost(d), over: d.shapes.reduce((n, s) => n + shapeTriangles(s, d.keepWinding).length, 0) > MAX_TRIANGLES };
      const { cost, over } = costOf;
      const fmt = (n: number) => n.toLocaleString('en');
      status.replaceChildren(
        h('span', null, `${d.shapes.length} shape${d.shapes.length === 1 ? '' : 's'}`),
        h('span', { title: 'triangles sent to the rasterizer' }, `${fmt(cost.triangles)} triangle${cost.triangles === 1 ? '' : 's'}`),
        ...(cost.culled ? [h('span', { class: 'warn', title: 'wound counter-clockwise: set-up culls them after three cycles' }, `${cost.culled} back face${cost.culled > 1 ? 's' : ''}`)] : []),
        h('span', { title: 'pixel writes (a pixel two triangles cover counts twice)' }, `${fmt(cost.pixels)} pixels`),
        h('span', { title: `clear ${fmt(cost.clear)} + triangles ${fmt(cost.draw)} (of which set-up ${fmt(cost.setup)})` }, `${fmt(cost.clear + cost.draw)} cycles`),
        ...(over ? [h('span', { class: 'warn' }, `only the first ${MAX_TRIANGLES} triangles are sent`)] : []),
        ...(sending ? [h('span', { class: 'warn' }, 'the GPU is drawing…')] : []),
        ...(result ? [h('span', { class: result.diff ? 'bad' : 'good', title: 'the frame the scan-out sent, against the reference rasterizer\'s picture of the same triangles' },
          `${result.version === version ? 'Sent' : 'Last sent (before your edits)'}: ${fmt(result.cycles)} cycles${result.cycles === result.predicted ? ', as predicted' : ` (predicted ${fmt(result.predicted)})`}; `
          + (result.diff ? `${result.diff} pixels differ from the reference` : 'the screen matches the reference, pixel for pixel'))] : []));
      sendBtn.toggleAttribute('disabled', sending || !link.play);
    };

    const title = h('h4', null, 'Your drawing', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel gfx-panel gfx-draw-panel', 'data-dock': 'left' }, title,
      h('div', { class: 'cpu-body' },
        toolRow, swatches,
        h('div', { class: 'gfx-pad-wrap' }, pad),
        hint,
        h('div', { class: 'param-row' }, sendBtn, undoBtn, clearBtn, alphaSel),
        h('div', { class: 'param-row' }, sampleSel, bgBtn),
        h('div', { class: 'param-row' },
          h('label', { class: 'gfx-check', title: 'outline the triangles each shape is cut into' }, trisBox, 'show triangles'),
          h('label', { class: 'gfx-check', title: 'send a clicked triangle as clicked: wound counter-clockwise, it is a back face and the GPU culls it' }, windBox, 'keep my winding')),
        status));
    title.addEventListener('click', () => { el.classList.toggle('collapsed'); stage.layoutDock(); });
    syncTools();
    draw();
    // The pad and the screen sit side by side; on a narrow stage both panels slim down so neither hides the other.
    // The stage appends the panel after building it: observe its canvas from the first update on.
    let ro: ResizeObserver | null = null;
    const fit = () => {
      const canvas = el.parentElement?.parentElement;
      if (!canvas) return;
      const narrow = canvas.clientWidth < 2 * 300 + 60;
      if (narrow === el.classList.contains('narrow')) return;
      canvas.querySelectorAll('.gfx-panel').forEach((p) => p.classList.toggle('narrow', narrow));
      stage.layoutDock();
    };
    const update = () => {
      if (ro || !el.isConnected || !el.parentElement?.parentElement) return;
      ro = new ResizeObserver(fit);
      ro.observe(el.parentElement.parentElement);
    };
    requestAnimationFrame(update);
    return { el, update, destroy: () => ro?.disconnect() };
  };
}
