// A model's stage (loaded with the model): the canvas on the WebGL renderer, or without WebGL2 (or after a lost context)
// the same parts as a flat SVG drawing from a fixed view; labels over it, status chips, the theme followed. A model only
// says what its parts and labels are: draw() calls paint() whenever they, the theme or the mode change.

import '../styles/relay3d.css';
import '../styles/model3d.css';
import { CssColors, watchTheme } from '../gl/color';
import { packInstances, type RGBA } from '../gl/instances';
import { dot3, sub3 } from '../gl/math';
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
}

/** A preset view: picked from the stage's view bar (setView), Reset view then comes back to it. */
export interface ModelView { label: string; view: OrbitView; title?: string }

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
  /** Move the camera (a model's preset views). */
  setView(v: OrbitView): void;
  /** The preset views as a button group with Reset view at its end (o.views, or these). */
  viewBar(views?: readonly ModelView[]): HTMLElement;
  destroy(): void;
}

const FW = 640, FH = 480;
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
  const note = o.note ? `${o.note} ` : '';

  // 'wait' until the renderer chunk answers; 'flat' without WebGL2 or while the context is lost.
  let mode: 'wait' | 'gl' | 'flat' = 'wait', renderer: Renderer | null = null, dead = false;
  let last: readonly Anchor[] = [], lblEls: HTMLElement[] = [];
  // The flat view's extent only grows, so a part that moves does not rescale the drawing.
  let fit: [number, number, number, number] | null = null;

  const placeLabels = () => {
    if (mode !== 'gl' || !renderer) return;
    const eye = renderer.camera.eye();
    last.forEach((a, k) => {
      const p = renderer!.project(a.p), e = lblEls[k];
      if (!p) { e.style.display = 'none'; return; }
      e.style.display = '';
      e.classList.toggle('away', dot3(a.n, sub3(eye, a.p)) < 0);
      e.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
    });
    declutterLabels(lblEls);
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

  const setMode = (m: 'gl' | 'flat') => {
    const on = m === 'flat';
    mode = m;
    canvas.style.display = on ? 'none' : '';
    flat.style.display = on ? '' : 'none';
    labels.style.display = on ? 'none' : '';
    resetBtn.style.display = on ? 'none' : '';
    frame.setFlat(on);
    hint.textContent = on ? `${note}A flat view: this browser has no WebGL2 for the 3D one.` : `${note}${ORBIT_HINT}`;
    o.draw();
  };

  const applyLights = () => renderer?.setLights({ sky: colors.rgb('--rl-sky'), ground: colors.rgb('--rl-ground'), key: colors.rgb('--rl-key') });
  const unwatch = watchTheme(() => { colors.invalidate(); applyLights(); o.draw(); });
  resetBtn.addEventListener('click', () => { renderer?.camera.reset(); renderer?.invalidate(); });

  void import('../gl/renderer').then(({ createRenderer, OrbitCamera, boxMesh, cylinderMesh }) => {
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
    setView(v) {
      o.camera = v;
      const c = renderer?.camera;
      if (!c) { if (mode === 'flat') o.draw(); return; }
      c.rehome(v, c.limits);
      renderer?.invalidate();
    },
    viewBar(views = o.views ?? []) {
      const btns = views.map((v) => {
        const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', ...(v.title ? { title: v.title } : {}) }, v.label) as HTMLButtonElement;
        b.addEventListener('click', () => {
          this.setView({ ...v.view, target: [...v.view.target] });
          for (const x of btns) x.setAttribute('aria-pressed', String(x === b));
        });
        return b;
      });
      btns[0]?.setAttribute('aria-pressed', 'true');
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
