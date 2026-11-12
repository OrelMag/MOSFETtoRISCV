// A model's stage (loaded with the model): the canvas on the WebGL renderer, or without WebGL2 (or after a lost context)
// the same parts as a flat SVG drawing from a fixed view; labels over it, status chips, the theme followed. A model only
// says what its parts and labels are: draw() calls paint() whenever they, the theme or the mode change.

import '../styles/relay3d.css';
import '../styles/model3d.css';
import { CssColors, watchTheme } from '../gl/color';
import { packInstances, type RGBA } from '../gl/instances';
import { dot3, norm3, sub3 } from '../gl/math';
import type { PartLook } from '../gl/kit/looks';
import type { OrbitLimits, OrbitView } from '../gl/camera';
import { flatFaces, flatView, type Anchor, type Part } from '../gl/parts';
import type { Renderer } from '../gl/renderer';
import { h, s } from '../ui/dom';
import { declutterLabels } from './labelfit';
import { ORBIT_ARIA, ORBIT_HINT, modelFrame } from './modelframe';

export interface ModelStageOptions {
  /** What the canvas shows, for a screen reader. */
  aria: string;
  camera: OrbitView;
  limits?: Partial<OrbitLimits>;
  /** What the drawing exaggerates (put before the controls in the hint); empty when nothing. */
  note?: string;
  /** Repaint from the current state: calls paint(). */
  draw: () => void;
  /** Named camera views (front, top, side, iso …) for viewBar(); the first is usually the starting one. */
  views?: readonly ModelView[];
  /** The model's look on the studio renderer (gl/kit/looks.ts): exposure, key light, what its finishes become. */
  look?: PartLook;
}

/** A preset view: picked from the stage's view bar (setView), Reset view then comes back to it. `view` may be computed at
 *  the click (a view that depends on the stage's width); `pick` runs after the camera moved (what the model draws in it). */
export interface ModelView { label: string; view: OrbitView | (() => OrbitView); title?: string; pick?: () => void; /** zoom limits for this view (a close-up); else the current ones */ limits?: Partial<OrbitLimits>; /** the view the model opens on (else the first) */ on?: boolean }

export interface ModelStage {
  el: HTMLElement;
  hint: HTMLElement;
  chips: HTMLElement;
  resetBtn: HTMLButtonElement;
  /** A colour token in the host's context. */
  rgb(token: string): [number, number, number];
  rgba(token: string, alpha: number): RGBA;
  paint(parts: readonly Part[], anchors: readonly Anchor[]): void;
  /** No WebGL2: the flat fallback is showing (a model may draw fewer facets). */
  isFlat(): boolean;
  /** Replace the note (what the drawing exaggerates): a model with several views shows the open one's. */
  setNote(text: string): void;
  /** Move the camera (a model's preset views). */
  setView(v: OrbitView, limits?: Partial<OrbitLimits>): void;
  /** The preset views as a button group with Reset view at its end (o.views, or these). */
  viewBar(views?: readonly ModelView[]): HTMLElement;
  destroy(): void;
}

const FW = 640, FH = 480;
/** Phone framing: below NARROW px the home view may back off up to FIT_MAX × to keep main anchors FIT_X / FIT_Y px inside. */
const NARROW = 480, FIT_MAX = 1.6, FIT_X = 8, FIT_Y = 16;
/** px kept clear around the corner buttons (an anchor that close would have its label pushed off them). */
const TOOL_PAD = 6;
const css = (c: RGBA) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)} / ${c[3].toFixed(2)})`;

export function modelStage(host: HTMLElement, o: ModelStageOptions): ModelStage {
  const canvas = h('canvas', { class: 'r3-canvas', tabindex: 0, 'aria-label': `${o.aria}: ${ORBIT_ARIA}` }) as HTMLCanvasElement;
  const flat = s('svg', { class: 'r3-flat', viewBox: `0 0 ${FW} ${FH}`, role: 'img', 'aria-label': o.aria }) as SVGSVGElement;
  flat.style.display = 'none';
  const labels = h('div', { class: 'r3-labels', 'aria-hidden': 'true' });
  const chips = h('div', { class: 'r3-chips' });
  const hint = h('div', { class: 'r3-hint' });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset view') as HTMLButtonElement;
  const el = h('div', { class: 'r3-stage' }, canvas, flat, labels, chips);
  const colors = new CssColors(host);
  const frame = modelFrame({ stage: el, name: o.aria, renderer: () => (mode === 'gl' ? renderer : null), labels });
  let note = o.note ? `${o.note} ` : '';

  // 'wait' until the renderer chunk answers; 'flat' without WebGL2 or while the context is lost.
  let mode: 'wait' | 'gl' | 'flat' = 'wait', renderer: Renderer | null = null, dead = false;
  // PROTOTYPE (proto/3d-rock): ?studio3d draws the same parts on gl/studio.ts (phase 0: no change to any model)
  const studioMode = /studio3d/.test(location.search + location.hash);
  let paintParts: ((parts: readonly Part[]) => void) | null = null;
  let last: readonly Anchor[] = [], lblEls: HTMLElement[] = [];
  // The flat view's extent only grows, so a part that moves does not rescale the drawing.
  let fit: [number, number, number, number] | null = null;

  const placeLabels = () => {
    if (mode !== 'gl' || !renderer) return;
    fitHome();
    const eye = renderer.camera.eye();
    last.forEach((a, k) => {
      const p = renderer!.project(a.p), e = lblEls[k];
      // An anchor that projects outside the canvas (a close-up view of one end) has no label: it would be clamped to an edge.
      if (!p || p[0] < 0 || p[1] < 0 || p[0] > canvas.clientWidth || p[1] > canvas.clientHeight) { e.style.display = 'none'; return; }
      e.style.display = '';
      e.classList.toggle('away', dot3(a.n, sub3(eye, a.p)) < 0);
      e.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
    });
    declutterLabels(lblEls, { prio: last.map((a) => a.prio) });
  };

  const drawFlat = (parts: readonly Part[], anchors: readonly Anchor[]) => {
    const { yaw, pitch } = o.camera, faces = flatFaces(parts, yaw, pitch), pr = flatView(yaw, pitch);
    for (const f of faces) for (const [x, y] of f.pts) {
      fit = fit ? [Math.min(fit[0], x), Math.max(fit[1], x), Math.min(fit[2], y), Math.max(fit[3], y)] : [x, x, y, y];
    }
    const [x0, x1, y0, y1] = fit ?? [0, 1, 0, 1], k = Math.min((FW * 0.9) / (x1 - x0 || 1), (FH * 0.9) / (y1 - y0 || 1));
    const X = (x: number) => FW / 2 + (x - (x0 + x1) / 2) * k, Y = (y: number) => FH / 2 - (y - (y0 + y1) / 2) * k;
    const g = s('g');
    for (const f of faces) g.append(s('polygon', { points: f.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' '), style: `fill:${css(f.color)}`, class: 'm3-face' }));
    for (const a of anchors) {
      if (a.minor) continue;
      const [x, y] = pr(a.p);
      // a two-line label (a level, then its place) as two lines: SVG text does not break at \n
      const t = s('text', { x: X(x), y: Y(y), class: 'm3-flat-lbl', 'text-anchor': 'middle' });
      a.text.split('\n').forEach((l, i) => t.append(s('tspan', { x: X(x), dy: i ? '1.15em' : '0', ...(i ? { class: 'm3-flat-sub' } : {}) }, l)));
      g.append(t);
    }
    flat.replaceChildren(g);
  };

  const paint = (parts: readonly Part[], anchors: readonly Anchor[]) => {
    if (mode === 'wait') return;
    if (mode === 'flat') { drawFlat(parts, anchors); return; }
    if (!renderer) return;
    if (paintParts) { paintParts(parts); last = anchors; if (anchors.length !== lblEls.length || anchors.some((a, i) => a.text !== lblEls[i]?.textContent)) { lblEls = anchors.map((a) => h('span', { class: `r3-lbl ${a.side}${a.minor ? ' minor' : ''}` }, h('i'), h('b', null, a.text))); labels.replaceChildren(...lblEls); } placeLabels(); return; }
    const clear = (p: Part) => ((p.color as RGBA)[3] ?? 1) < 1;
    const of = (kind: Part['kind'], glass: boolean) => packInstances(parts.filter((p) => p.kind === kind && clear(p) === glass));
    renderer.updateBatch(0, of('box', false));
    renderer.updateBatch(1, of('cyl', false));
    renderer.updateBatch(2, of('box', true));
    renderer.updateBatch(3, of('cyl', true));
    if (anchors.length !== lblEls.length || anchors.some((a, i) => a.text !== last[i]?.text)) {
      lblEls = anchors.map((a) => h('span', { class: `r3-lbl ${a.side}${a.minor ? ' minor' : ''}` }, h('i'), h('b', null, a.text)));
      labels.replaceChildren(...lblEls);
    }
    last = anchors;
    placeLabels();
  };

  // Phone framing: on a narrow canvas the home view backs off until the main labels' anchors are inside it, so a model
  // does not lose half its labels off the top or bottom. Only at home (never after the learner orbits, pans or zooms),
  // refitted from the model's own view whenever the canvas changes size, for that size.
  let fitFor = '';
  const fitHome = () => {
    const c = renderer?.camera, w = canvas.clientWidth, ht = canvas.clientHeight;
    if (!c || !w || !ht || !last.length) return;
    const key = `${w}x${ht}`;
    if (key === fitFor || !c.atHome()) return;
    fitFor = key;
    const base = o.camera, major = last.filter((a) => !a.minor);
    // the corner buttons (modelframe.ts) in canvas px: an anchor under them has no label either (labelfit.ts)
    const tr = frame.el.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const tb = tr.width ? { l: tr.left - cr.left - TOOL_PAD, r: tr.right - cr.left + TOOL_PAD, t: tr.top - cr.top - TOOL_PAD, b: tr.bottom - cr.top + TOOL_PAD } : null;
    const fits = () => major.every((a) => {
      const p = c.project(a.p, w, ht);
      return !p || (p[0] >= FIT_X && p[0] <= w - FIT_X && p[1] >= FIT_Y && p[1] <= ht - FIT_Y && !(tb && p[0] > tb.l && p[0] < tb.r && p[1] > tb.t && p[1] < tb.b));
    });
    let k = 1;
    c.rehome(base);
    if (w < NARROW) while (!fits() && k < FIT_MAX) { k *= 1.08; c.rehome({ ...base, dist: base.dist * k }, { maxDist: Math.max(c.limits.maxDist, base.dist * k) }); }
    if (k !== 1) renderer!.invalidate();
  };

  const hintText = () => (mode === 'flat' ? `${note}A flat view: this browser has no WebGL2 for the 3D one.` : `${note}${ORBIT_HINT}`);
  const setMode = (m: 'gl' | 'flat') => {
    const on = m === 'flat';
    mode = m;
    canvas.style.display = on ? 'none' : '';
    flat.style.display = on ? '' : 'none';
    labels.style.display = on ? 'none' : '';
    resetBtn.style.display = on ? 'none' : '';
    frame.setFlat(on);
    hint.textContent = hintText();
    o.draw();
  };

  const applyLights = () => renderer?.setLights({ sky: colors.rgb('--rl-sky'), ground: colors.rgb('--rl-ground'), key: colors.rgb('--rl-key') });
  const unwatch = watchTheme(() => { colors.invalidate(); applyLights(); o.draw(); });
  resetBtn.addEventListener('click', () => { renderer?.camera.reset(); renderer?.invalidate(); });

  if (studioMode) void Promise.all([import('../gl/studio'), import('../gl/kit/fromparts')]).then(([{ createStudio, OrbitCamera }, { fromParts }]) => {
    if (dead) return;
    const st = createStudio(canvas, new OrbitCamera(o.camera, o.limits), { onRender: placeLabels, onLost: () => setMode('flat'), onRestored: () => setMode('gl') });
    if (!st) { setMode('flat'); return; }
    const rgbOf = (c: string | [number, number, number]) => (typeof c === 'string' ? colors.rgb(c) : c);
    // the frame and the label code only need these of a Renderer
    renderer = {
      camera: st.camera, canvas, render: st.render, invalidate: st.invalidate, project: st.project, destroy: st.destroy,
      setScene: () => {}, updateBatch: () => {},
      setLights: (l) => st.setEnv({ ...(l.sky ? { sky: l.sky } : {}), ...(l.ground ? { ground: l.ground } : {}), ...(l.key ? { key: l.key } : {}) }),
    };
    (window as unknown as { __studio?: unknown }).__studio = st;
    paintParts = (parts) => st.showParts(fromParts(parts, o.look), rgbOf);
    // today's palettes were tuned under half-Lambert light: a little under neutral keeps their colours from washing out
    const k = o.look?.keyDir;
    st.setEnv({ exposure: o.look?.exposure ?? 0.9, ...(k ? { dir: norm3([k[0], k[1], k[2]]) } : {}) });
    applyLights();
    setMode('gl');
  }).catch(() => { if (!dead) setMode('flat'); });
  else void import('../gl/renderer').then(({ createRenderer, OrbitCamera, boxMesh, cylinderMesh }) => {
    if (dead) return;
    const cam = new OrbitCamera(o.camera, o.limits);
    try {
      renderer = createRenderer(canvas, cam, { onRender: placeLabels, onLost: () => setMode('flat'), onRestored: () => setMode('gl') });
    } catch { renderer = null; }
    if (!renderer) { setMode('flat'); return; }
    const b = boxMesh(), c = cylinderMesh(28), none = new Float32Array(0);
    renderer.setScene([{ mesh: b, data: none }, { mesh: c, data: none }, { mesh: b, data: none, transparent: true }, { mesh: c, data: none, transparent: true }]);
    applyLights();
    setMode('gl');
  }).catch(() => { if (!dead) setMode('flat'); });

  return {
    el, hint, chips, resetBtn, paint,
    isFlat: () => mode === 'flat',
    setNote(text) { note = text ? `${text} ` : ''; if (mode !== 'wait') hint.textContent = hintText(); },
    setView(v, limits) {
      o.camera = v; fit = null;
      const c = renderer?.camera;
      if (!c) { if (mode === 'flat') o.draw(); return; }
      c.rehome(v, limits ?? c.limits);
      fitFor = ''; // a new home: fitted again at the next frame
      renderer?.invalidate();
    },
    viewBar(views = o.views ?? []) {
      const btns = views.map((v) => {
        const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', ...(v.title ? { title: v.title } : {}) }, v.label) as HTMLButtonElement;
        b.addEventListener('click', () => {
          const w = typeof v.view === 'function' ? v.view() : v.view;
          this.setView({ ...w, target: [...w.target] }, v.limits);
          for (const x of btns) x.setAttribute('aria-pressed', String(x === b));
          v.pick?.();
        });
        return b;
      });
      btns[Math.max(0, views.findIndex((v) => v.on))]?.setAttribute('aria-pressed', 'true');
      return h('div', { class: 'r3-views', role: 'group', 'aria-label': 'Views' }, ...btns, resetBtn);
    },
    rgb: (t) => colors.rgb(t),
    rgba: (t, alpha) => { const [r, g, b] = colors.rgb(t); return [r, g, b, alpha]; },
    destroy() {
      dead = true;
      frame.destroy();
      unwatch();
      renderer?.destroy();
      renderer = null;
      colors.destroy();
    },
  };
}
