// The water kit (analogies, Merge B): tank, pipe, valve, wheel, glass column and instanced drops on the site's own WebGL2
// renderer (src/gl), shared by the loop of chapter 0, the faucet of "Three regions" and the CMOS column. A scene (waterscenes.ts)
// says what to draw each frame through `Parts`; mountWater() owns the canvas, orbit controls, labels over it, the theme, the
// animation loop (stopped when hidden, reduced motion or the host leaves the page) and a flat SVG drawing of the very same
// parts when there is no WebGL2. Loaded as its own chunk.

import '../styles/water.css';
import { CssColors, mixRgb, scaleRgb, watchTheme } from '../gl/color';
import type { OrbitLimits, OrbitView } from '../gl/camera';
import { packInstances, type Instance, type RGB, type RGBA } from '../gl/instances';
import { cross3, norm3, quatAxisAngle, quatRotate, sub3, type Quat, type Vec3 } from '../gl/math';
import { createRenderer, OrbitCamera, boxMesh, cylinderMesh, sphereMesh, type Renderer } from '../gl/renderer';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { pointAlong, polyLength, type P3 } from './water';

// ---------------------------------------------------------------- palette (CSS tokens: theme.css --wt-*)

export interface Palette {
  water: RGB; drop: RGB; pipe: RGB; dark: RGB; pmos: RGB; nmos: RGB; lamp: RGB; wood: RGB; glass: RGB;
  sky: RGB; ground: RGB; key: RGB;
}

const paletteOf = (c: CssColors): Palette => ({
  water: c.rgb('--wt-water'), drop: c.rgb('--wt-drop'), pipe: c.rgb('--wt-pipe'), dark: c.rgb('--wt-dark'), pmos: c.rgb('--wt-pmos'),
  nmos: c.rgb('--wt-nmos'), lamp: c.rgb('--wt-lamp'), wood: c.rgb('--wt-wood'), glass: c.rgb('--wt-glass'),
  sky: c.rgb('--wt-sky'), ground: c.rgb('--wt-ground'), key: c.rgb('--wt-key'),
});

// ---------------------------------------------------------------- parts

export type Kind = 'box' | 'cyl' | 'cylo' | 'sph';
/** solid: drawn first, opaque; water and glass: blended, glass over water. */
export type Layer = 'solid' | 'water' | 'glass';
export interface WPart extends Instance { kind: Kind; layer: Layer }

const KINDS: Kind[] = ['box', 'cyl', 'cylo', 'sph'];
const LAYERS: Layer[] = ['solid', 'water', 'glass'];

const ALONG_Z = quatAxisAngle([1, 0, 0], Math.PI / 2); // a cylinder's axis turned from y to z
const rotZ = (a: number): Quat => quatAxisAngle([0, 0, 1], a);

/** The turn that takes a unit cylinder's y axis onto direction d. */
export function alongQuat(d: Vec3): Quat {
  const n = norm3(d), ax = cross3([0, 1, 0], n), sn = Math.hypot(ax[0], ax[1], ax[2]);
  if (sn < 1e-6) return n[1] >= 0 ? [0, 0, 0, 1] : quatAxisAngle([1, 0, 0], Math.PI);
  return quatAxisAngle(ax, Math.atan2(sn, n[1]));
}

/** One frame's parts. Every method adds instances; the scene never touches the renderer. */
export class Parts {
  readonly list: WPart[] = [];
  constructor(readonly P: Palette) {}

  private add(kind: Kind, layer: Layer, inst: Instance): void { this.list.push({ kind, layer, ...inst }); }

  box(c: Vec3, size: Vec3, color: RGB, spec = 0.15): void { this.add('box', 'solid', { pos: c, scale: size, color, spec }); }
  sphere(c: Vec3, r: number, color: RGB, emissive?: RGB, spec = 0.3): void { this.add('sph', 'solid', { pos: c, scale: [2 * r, 2 * r, 2 * r], color, emissive, spec }); }
  /** A cylinder of radius r and height hgt along y (or z). */
  disc(c: Vec3, r: number, hgt: number, color: RGB, alongZ = false, spec = 0.2): void {
    this.add('cyl', 'solid', { pos: c, scale: [2 * r, hgt, 2 * r], rot: alongZ ? ALONG_Z : undefined, color, spec });
  }

  /** A glass pipe full of water from a to b; `fill` 0..1 of the bore. */
  tube(a: Vec3, b: Vec3, r: number, fill = 1): void {
    const d = sub3(b, a), L = Math.hypot(d[0], d[1], d[2]), rot = alongQuat(d), mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    this.add('cyl', 'glass', { pos: mid, scale: [2 * r, L, 2 * r], rot, color: [...this.P.glass, 0.3] });
    if (fill > 0) this.add('cyl', 'water', { pos: mid, scale: [1.6 * r, L, 1.6 * r], rot, color: [...this.P.water, 0.85] });
  }
  /** A pipe along a polyline, a ball at each bend. */
  pipe(pts: readonly Vec3[], r = 0.11): void {
    for (let i = 0; i + 1 < pts.length; i++) this.tube(pts[i], pts[i + 1], r);
    for (let i = 1; i + 1 < pts.length; i++) {
      this.add('sph', 'glass', { pos: pts[i], scale: [2.04 * r, 2.04 * r, 2.04 * r], color: [...this.P.glass, 0.3] });
      this.add('sph', 'water', { pos: pts[i], scale: [1.6 * r, 1.6 * r, 1.6 * r], color: [...this.P.water, 0.85] });
    }
  }
  /** A flange ring round a pipe (a restriction's ends). */
  flange(c: Vec3, r: number, dir: Vec3): void {
    this.add('cyl', 'solid', { pos: c, scale: [2 * r, 0.05, 2 * r], rot: alongQuat(dir), color: this.P.dark, spec: 0.3 });
  }

  /** A glass tank with water to `level` (0..1) of its height, on four posts. */
  tank(cx: number, y0: number, cz: number, w: number, hgt: number, d: number, level: number): void {
    const lv = Math.max(0.004, Math.min(1, level)) * hgt;
    this.add('box', 'water', { pos: [cx, y0 + lv / 2, cz], scale: [w * 0.96, lv, d * 0.96], color: [...this.P.water, 0.85] });
    this.add('box', 'glass', { pos: [cx, y0 + hgt / 2, cz], scale: [w, hgt, d], color: [...this.P.glass, 0.2] });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.box([cx + (sx * w) / 2, y0 + hgt / 2, cz + (sz * d) / 2], [0.05, hgt, 0.05], this.P.pipe, 0.3);
    this.box([cx, y0 - 0.02, cz], [w + 0.08, 0.05, d + 0.08], this.P.dark);
  }

  /** A glass column of radius r and height hgt, water to `level`. */
  column(cx: number, y0: number, cz: number, r: number, hgt: number, level: number): void {
    const lv = Math.max(0.004, Math.min(1, level)) * hgt;
    this.add('cyl', 'water', { pos: [cx, y0 + lv / 2, cz], scale: [1.9 * r, lv, 1.9 * r], color: [...this.P.water, 0.85] });
    this.add('cylo', 'glass', { pos: [cx, y0 + hgt / 2, cz], scale: [2 * r, hgt, 2 * r], color: [...this.P.glass, 0.22] });
    for (const y of [y0, y0 + hgt]) this.add('cyl', 'solid', { pos: [cx, y, cz], scale: [2.2 * r, 0.05, 2.2 * r], color: this.P.pipe, spec: 0.3 });
  }

  /** A valve on a pipe along x: open 0..1; the handle lies along the pipe when open, across it when shut. */
  valve(c: Vec3, open: number, handle: RGB): void {
    const a = (1 - Math.max(0, Math.min(1, open))) * (Math.PI / 2), q = rotZ(a), at = (x: number, z: number): Vec3 => {
      const v = quatRotate(q, [x, 0, 0]);
      return [c[0] + v[0], c[1] + v[1], c[2] + z];
    };
    this.sphere(c, 0.22, this.P.dark);
    this.add('cyl', 'solid', { pos: [c[0], c[1], c[2] + 0.2], scale: [0.07, 0.32, 0.07], rot: ALONG_Z, color: this.P.pipe, spec: 0.3 });
    this.add('box', 'solid', { pos: at(0.24, 0.36), scale: [0.62, 0.08, 0.06], rot: q, color: handle, spec: 0.2 });
    this.sphere(at(0.55, 0.36), 0.06, handle);
  }

  /** A water wheel in a glass housing, axis z, turned to `ang`. */
  wheel(c: Vec3, ang: number, r = 0.36): void {
    this.add('cyl', 'solid', { pos: c, scale: [0.14, 0.3, 0.14], rot: ALONG_Z, color: this.P.pipe, spec: 0.3 });
    for (let i = 0; i < 8; i++) {
      const a = ang + (i / 8) * 2 * Math.PI, v = quatRotate(rotZ(a), [0, r / 2, 0]);
      this.add('box', 'solid', { pos: [c[0] + v[0], c[1] + v[1], c[2]], scale: [0.05, r, 0.24], rot: rotZ(a), color: this.P.wood, spec: 0.05 });
    }
    this.add('cylo', 'glass', { pos: c, scale: [2 * (r + 0.08), 0.34, 2 * (r + 0.08)], rot: ALONG_Z, color: [...this.P.glass, 0.2] });
  }

  /** Evenly spaced drops along a path; `phase` (0..1 of the spacing's cycle) moves them. */
  drops(path: readonly P3[], n: number, phase: number, r = 0.045): void {
    const L = polyLength(path);
    for (let i = 0; i < n; i++) {
      const p = pointAlong(path, ((i + phase) / n) * L);
      this.add('sph', 'solid', { pos: p, scale: [2 * r, 2 * r, 2 * r], color: this.P.drop, emissive: scaleRgb(mixRgb(this.P.drop, [1, 1, 1], 0.4), 0.5), spec: 0.5 });
    }
  }

  pack(i: number): Float32Array {
    const k = KINDS[i % KINDS.length], l = LAYERS[Math.floor(i / KINDS.length)];
    return packInstances(this.list.filter((p) => p.kind === k && p.layer === l));
  }
}

// ---------------------------------------------------------------- scenes

export interface WLabel { text: string; p: Vec3; side: 'l' | 'r' | 't' | 'b'; minor?: boolean; hidden?: boolean }

export interface WaterScene {
  /** What the picture is, for assistive technology. */
  alt: string;
  view: OrbitView;
  /** Width over height of the stage (the scene's own shape: a tall column wants a squarer one). */
  aspect: number;
  limits?: Partial<OrbitLimits>;
  /** The flat fallback's window on the xy plane (y up). */
  flat: { x0: number; y0: number; w: number; h: number };
  labels: () => WLabel[];
  /** Move the animation on by dt seconds. `settle`: reduced motion, jump to the steady state instead of animating. */
  advance(dt: number, settle: boolean): void;
  /** Still moving or flowing, so frames keep coming. */
  active(): boolean;
  build(p: Parts): void;
}

export interface WaterMount {
  /** The scene's state changed: draw it (and keep drawing while it moves). */
  kick(): void;
  destroy(): void;
}

const HINT_GL = 'Drag to orbit, wheel or pinch to zoom, double-click to reset.';
const HINT_FLAT = 'A flat view: this browser has no WebGL2 for the 3D one.';

const css3 = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;

function partShape(p: WPart): SVGElement | null {
  const [x, y] = p.pos, sc = p.scale ?? [1, 1, 1], rot = p.rot ?? [0, 0, 0, 1];
  const col = p.color as RGBA, fill = css3([col[0], col[1], col[2]]), op = col[3] ?? 1;
  const e = p.emissive, shown = e && e.some((v) => v > 0.01) ? css3([Math.min(1, col[0] + e[0]), Math.min(1, col[1] + e[1]), Math.min(1, col[2] + e[2])]) : fill;
  const cls = `wt-p ${p.layer}`;
  if (p.kind === 'sph') return s('circle', { cx: x, cy: -y, r: sc[0] / 2, fill: shown, 'fill-opacity': op, class: cls });
  const ux = quatRotate(rot, [1, 0, 0]), uy = quatRotate(rot, [0, 1, 0]);
  if ((p.kind === 'cyl' || p.kind === 'cylo') && Math.abs(uy[2]) > 0.9) return s('circle', { cx: x, cy: -y, r: sc[0] / 2, fill: p.kind === 'cylo' ? 'none' : shown, 'fill-opacity': op, class: `${cls}${p.kind === 'cylo' ? ' ring' : ''}` });
  if (p.kind === 'box' && Math.abs(quatRotate(rot, [0, 0, 1])[2]) < 0.9) return null; // turned out of the plane: no flat shape
  return s('rect', {
    x: -sc[0] / 2, y: -sc[1] / 2, width: sc[0], height: sc[1], fill: shown, 'fill-opacity': op, class: cls,
    transform: `matrix(${ux[0].toFixed(4)} ${(-ux[1]).toFixed(4)} ${uy[0].toFixed(4)} ${(-uy[1]).toFixed(4)} ${x.toFixed(3)} ${(-y).toFixed(3)})`,
  });
}

/** Labels are written V_DS: the site's subscript style (as HTML or as SVG tspans), not a raw underscore. */
const SUB_RE = /_([A-Za-z0-9]+)/g;
export const htmlSub = (t: string): (string | Node)[] => t.split(SUB_RE).map((p, i) => (i % 2 ? h('sub', null, p) : p));
const svgSub = (t: string): (string | Node)[] => t.split(SUB_RE).map((p, i) => (i % 2 ? s('tspan', { 'baseline-shift': 'sub', 'font-size': '75%' }, p) : p));

function drawFlat(svg: SVGSVGElement, parts: WPart[], marks: WLabel[], px: number): void {
  const order = parts.map((p, i) => ({ p, i, l: LAYERS.indexOf(p.layer), z: p.pos[2] + (p.scale?.[2] ?? 1) / 2 })).sort((a, b) => a.l - b.l || a.z - b.z || a.i - b.i);
  const g = s('g');
  for (const { p } of order) { const e = partShape(p); if (e) g.append(e); }
  for (const m of marks) {
    if (m.minor || m.hidden) continue;
    const dx = m.side === 'l' ? -0.12 : m.side === 'r' ? 0.12 : 0, dy = m.side === 't' ? -0.12 : m.side === 'b' ? 0.3 : 0.08;
    g.append(s('text', { x: m.p[0] + dx, y: -m.p[1] + dy, class: 'wt-flat-lbl', style: `font-size:${(11.5 / px).toFixed(3)}px`, 'text-anchor': m.side === 'l' ? 'end' : m.side === 'r' ? 'start' : 'middle' }, ...svgSub(m.text)));
  }
  svg.replaceChildren(g);
}

/** Draw `scene` into `host`. `onFrame` runs after every drawn frame (readouts that follow the scene's own dynamics). */
export function mountWater(host: HTMLElement, scene: WaterScene, onFrame?: () => void): WaterMount {
  const canvas = h('canvas', { class: 'wt-canvas', tabindex: 0, 'aria-label': `${scene.alt} Drag to orbit, wheel or pinch to zoom, arrow keys to turn.` }) as HTMLCanvasElement;
  const f = scene.flat;
  const flatSvg = s('svg', { class: 'wt-flat', viewBox: `${f.x0} ${-(f.y0 + f.h)} ${f.w} ${f.h}`, role: 'img', 'aria-label': scene.alt }) as SVGSVGElement;
  flatSvg.style.display = 'none';
  const labels = h('div', { class: 'wt-labels', 'aria-hidden': 'true' });
  const hint = h('div', { class: 'wt-hint' }, HINT_GL);
  const stage = h('div', { class: 'wt-stage' }, canvas, flatSvg, labels);
  stage.style.aspectRatio = String(scene.aspect);
  host.append(stage, hint);

  const colors = new CssColors(stage);
  let palette: Palette | null = null;
  const pal = (): Palette => {
    if (palette) return palette;
    const p = paletteOf(colors);
    if (stage.isConnected) palette = p;
    return p;
  };

  let renderer: Renderer | null = null, mode: 'gl' | 'flat' = 'gl', dead = false, seen = false, visible = true, raf = 0, last = 0;
  const lbls = scene.labels();
  const lblEls = lbls.map((a) => { const b = h('b', null, ...htmlSub(a.text)); b.dataset.t = a.text; return { el: labels.appendChild(h('span', { class: `wt-lbl ${a.side}${a.minor ? ' minor' : ''}` }, h('i'), b)), b }; });
  const widths = new Map<string, number>();
  let lastW = 0;
  const placeLabels = () => {
    if (mode !== 'gl' || !renderer) return;
    const W = canvas.clientWidth;
    if (W !== lastW) { widths.clear(); lastW = W; }
    scene.labels().forEach((a, k) => {
      const l = lblEls[k];
      if (!l) return;
      const e = l.el;
      if (l.b.dataset.t !== a.text) { l.b.dataset.t = a.text; l.b.replaceChildren(...htmlSub(a.text)); }
      const p = renderer!.project(a.p);
      if (!p || a.hidden) { e.style.display = 'none'; return; }
      e.style.display = '';
      e.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
      // Keep the text inside the stage: a side label flips to the roomier side, a centred one slides along.
      let w = widths.get(a.text);
      if (w === undefined) { w = l.b.offsetWidth; if (w) widths.set(a.text, w); }
      let side = a.side, shift = 0;
      if (w) {
        if (side === 'r' && p[0] + 9 + w > W - 2 && p[0] - 9 - w >= 2) side = 'l';
        else if (side === 'l' && p[0] - 9 - w < 2 && p[0] + 9 + w <= W - 2) side = 'r';
        if (side === 't' || side === 'b') shift = Math.max(0, 3 - (p[0] - w / 2)) - Math.max(0, p[0] + w / 2 - (W - 3));
      }
      l.b.style.marginLeft = shift ? `${shift.toFixed(1)}px` : '';
      e.className = `wt-lbl ${side}${a.minor ? ' minor' : ''}`;
    });
  };

  const applyLights = () => renderer?.setLights({ sky: pal().sky, ground: pal().ground, key: pal().key });

  const draw = () => {
    const parts = new Parts(pal());
    scene.build(parts);
    if (mode === 'gl' && renderer) for (let i = 0; i < KINDS.length * LAYERS.length; i++) renderer.updateBatch(i, parts.pack(i));
    else if (mode === 'flat') drawFlat(flatSvg, parts.list, scene.labels(), Math.max(20, Math.min(stage.clientWidth / f.w, stage.clientHeight / f.h)) || 50);
    onFrame?.();
  };

  const setMode = (m: 'gl' | 'flat') => {
    mode = m;
    const flat = m === 'flat';
    canvas.style.display = flat ? 'none' : '';
    flatSvg.style.display = flat ? '' : 'none';
    labels.style.display = flat ? 'none' : '';
    hint.textContent = flat ? HINT_FLAT : HINT_GL;
    draw();
  };

  const alive = (): boolean => {
    if (dead) return false;
    if (stage.isConnected) seen = true;
    else if (seen) { destroy(); return false; }
    return true;
  };
  const tick = (now: number) => {
    raf = 0;
    if (!alive()) return;
    const reduced = reducedMotion(), dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    scene.advance(reduced ? 0 : dt, reduced);
    draw();
    if (visible && !reduced && scene.active()) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (raf || dead) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  try {
    const cam = new OrbitCamera(scene.view, { minDist: scene.view.dist / 2.5, maxDist: scene.view.dist * 2.5, ...scene.limits });
    renderer = createRenderer(canvas, cam, { onRender: placeLabels, onLost: () => setMode('flat'), onRestored: () => setMode('gl') });
    if (renderer) renderer.setScene(Array.from({ length: KINDS.length * LAYERS.length }, (_, i) => ({
      mesh: KINDS[i % KINDS.length] === 'box' ? boxMesh() : KINDS[i % KINDS.length] === 'sph' ? sphereMesh(14, 8) : cylinderMesh(24, KINDS[i % KINDS.length] === 'cyl'),
      data: new Float32Array(0),
      transparent: i >= KINDS.length,
    })));
  } catch { renderer = null; }
  if (!renderer) mode = 'flat';
  applyLights();
  setMode(mode);

  const unwatch = watchTheme(() => { colors.invalidate(); palette = null; applyLights(); draw(); });
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) kick(); }) : null;
  io?.observe(stage);

  function destroy(): void {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    unwatch();
    io?.disconnect();
    renderer?.destroy();
    renderer = null;
    colors.destroy();
  }

  kick();
  return { kick, destroy };
}
