// A studio model's stage (the prototype of what modelStage would become): the canvas on gl/studio.ts, or without WebGL2
// the same model drawn flat in SVG from its home view; labels set out in gutters beside the canvas with leader lines to
// their parts (on a phone: numbered dots and a list under it), so a label never sits on what it names; hover a part
// for its card (name, material, dimension, source), click to keep it; sliders for the exploded view and the cut; the
// tour's beats as Back / Next with a caption, the camera easing to each.

import '../styles/relay3d.css';
import '../styles/model3d.css';
import '../styles/studio3d.css';
import { CssColors, watchTheme } from '../gl/color';
import type { OrbitLimits, OrbitView } from '../gl/camera';
import { flatView } from '../gl/parts';
import { dot3, norm3, sub3, type Vec3 } from '../gl/math';
import type { RGB } from '../gl/instances';
import type { Geo } from '../gl/kit/geo';
import type { Colour, Material } from '../gl/kit/materials';
import { anchorAt, applyMat, cutsAt, isCut, itemMatrix, pick, type Item, type Model3, type StudioAnchor } from '../gl/kit/scene';
import type { Studio } from '../gl/studio';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';

export interface StudioStageOptions {
  aria: string;
  home: OrbitView;
  limits?: Partial<OrbitLimits>;
  note?: string;
  /** The model now, at a detail: 'flat' for the SVG fallback (fewer facets). */
  build: (detail: 'full' | 'flat') => Model3;
}

export interface StudioStage {
  el: HTMLElement;
  /** Explode, cut and the tour, for the host to place. */
  bar: HTMLElement;
  chips: HTMLElement;
  hint: HTMLElement;
  /** Rebuild the model (a state changed). */
  refresh(): void;
  instances(key: string, geo: Geo, mat: Material, data: Float32Array): void;
  studio(): Studio | null;
  isFlat(): boolean;
  rgb(token: string): RGB;
  destroy(): void;
}

const FW = 640, FH = 520, NARROW = 560;
const ease = (t: number) => t * t * (3 - 2 * t);

export function studioStage(o: StudioStageOptions): StudioStage {
  const canvas = h('canvas', { class: 'r3-canvas', tabindex: 0, 'aria-label': `${o.aria}: drag to turn, wheel or pinch to zoom; point at a part for its name` }) as HTMLCanvasElement;
  const flat = s('svg', { class: 'r3-flat', viewBox: `0 0 ${FW} ${FH}`, role: 'img', 'aria-label': o.aria }) as SVGSVGElement;
  flat.style.display = 'none';
  const leaders = s('svg', { class: 'st-leaders', 'aria-hidden': 'true' }) as SVGSVGElement;
  const gutL = h('div', { class: 'st-gutter l', 'aria-hidden': 'true' }), gutR = h('div', { class: 'st-gutter r', 'aria-hidden': 'true' });
  const dots = h('div', { class: 'st-dots', 'aria-hidden': 'true' });
  const card = h('div', { class: 'st-card', role: 'status' });
  card.style.display = 'none';
  const chips = h('div', { class: 'r3-chips' });
  const stats = h('div', { class: 'st-stats' });
  stats.style.display = /stats/.test(location.hash + location.search) ? '' : 'none';
  const view = h('div', { class: 'st-view' }, canvas, flat, leaders, dots, card, chips, stats);
  const stage = h('div', { class: 'st-stage' }, gutL, view, gutR);
  const list = h('ol', { class: 'st-list' });

  // Explode, cut, tour.
  const exIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Exploded view' }) as HTMLInputElement;
  const cutIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Cutaway' }) as HTMLInputElement;
  const prev = h('button', { type: 'button', class: 'btn sm' }, '‹ Back') as HTMLButtonElement;
  const next = h('button', { type: 'button', class: 'btn sm primary' }, 'Tour ›') as HTMLButtonElement;
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset view') as HTMLButtonElement;
  const cap = h('div', { class: 'st-caption', 'aria-live': 'polite' });
  const bar = h('div', { class: 'st-bar' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Cutaway'), cutIn),
    h('label', { class: 'r3-sl' }, h('span', null, 'Explode'), exIn),
    h('div', { class: 'r3-btns' }, prev, next, resetBtn));
  const hint = h('div', { class: 'r3-hint' });
  const el = h('div', { class: 'st' }, bar, stage, cap, list, hint);

  const colors = new CssColors(el); // in the stage: its --st-* tokens apply, and the host's (a model's palette) are inherited
  const resolve = (c: Colour): RGB => (typeof c === 'string' ? colors.rgb(c) : c);

  let mode: 'wait' | 'gl' | 'flat' = 'wait', st: Studio | null = null, dead = false;
  let model: Model3 = o.build('full');
  let beat = -1, tween = 0, pinned: Item | null = null, hoverRaf = 0;

  // ---------------------------------------------------------------- labels: gutters and leaders

  let lblKey = '';
  let rows: { a: StudioAnchor; el: HTMLElement; dot: HTMLElement; li: HTMLElement }[] = [];
  const makeLabels = () => {
    const anchors = (model.anchors ?? []).filter((a) => !a.minor);
    const key = anchors.map((a) => a.text).join('|');
    if (key === lblKey) return;
    lblKey = key;
    rows = anchors.map((a, i) => ({ a, el: h('span', { class: 'st-lbl' }, a.text), dot: h('span', { class: 'st-dot' }, String(i + 1)), li: h('li', null, a.text) }));
    dots.replaceChildren(...rows.map((r) => r.dot));
    list.replaceChildren(...rows.map((r) => r.li));
  };
  const placeLabels = () => {
    if (mode !== 'gl' || !st) return;
    makeLabels();
    const W = canvas.clientWidth, H = canvas.clientHeight, cam = st.camera, eye = cam.eye(), under = cam.pitch < -0.25, narrow = el.clientWidth < NARROW;
    el.classList.toggle('narrow', narrow);
    const k = st.knobs().explode;
    const seen: { r: typeof rows[number]; x: number; y: number; away: boolean }[] = [];
    for (const r of rows) {
      const p3 = anchorAt(model, r.a, k), p = st.project(p3);
      const ok = !!p && !!r.a.under === under && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H;
      r.el.style.display = 'none'; r.dot.style.display = 'none'; r.li.classList.toggle('off', !ok); r.li.hidden = !!r.a.under !== under;
      if (!ok) continue;
      seen.push({ r, x: p![0], y: p![1], away: dot3(r.a.n, sub3(eye, p3)) < 0 });
    }
    const lines: SVGElement[] = [];
    if (narrow) {
      // numbered dots on the parts, the names in the list below
      for (const q of seen) { q.r.dot.style.display = ''; q.r.dot.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px)`; q.r.dot.classList.toggle('away', q.away); }
      leaders.replaceChildren();
      return;
    }
    // Gutters: each label on the side its anchor is nearer, stacked in the order of their heights, at least 22 px apart.
    const ox = 0, oy = 0; // the leaders sit in the view; the gutters start at its top
    for (const side of ['l', 'r'] as const) {
      const col = seen.filter((q) => (q.x < W / 2) === (side === 'l')).sort((a, b) => a.y - b.y), gut = side === 'l' ? gutL : gutR;
      const gap = 22, top = 10, bottom = H - 10;
      const ys = col.map((q) => Math.min(bottom, Math.max(top, q.y)));
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + gap);
      for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - gap);
      col.forEach((q, i) => {
        if (q.r.el.parentElement !== gut) gut.append(q.r.el);
        q.r.el.style.display = '';
        q.r.el.style.transform = `translateY(${(ys[i] + oy - 9).toFixed(1)}px)`;
        q.r.el.classList.toggle('away', q.away);
        const gx = side === 'l' ? ox - 6 : ox + W + 6, gy = ys[i] + oy, ax = q.x + ox, ay = q.y + oy;
        const elbow = side === 'l' ? ox + 10 : ox + W - 10;
        lines.push(s('polyline', { points: `${gx},${gy} ${elbow},${gy} ${ax},${ay}`, class: q.away ? 'away' : '' }));
        lines.push(s('circle', { cx: ax, cy: ay, r: 2.6, class: q.away ? 'away' : '' }));
      });
    }
    leaders.setAttribute('width', String(W)); leaders.setAttribute('height', String(H));
    leaders.replaceChildren(...lines);
  };

  // ---------------------------------------------------------------- the card

  const showCard = (it: Item | null, x = 0, y = 0) => {
    if (!it) { card.style.display = 'none'; return; }
    const i = it.info ?? model.items.find((m) => m.name === it.name && m.info)?.info ?? {};
    card.replaceChildren(
      h('b', null, it.name ?? ''),
      h('span', { class: 'st-mat' }, it.mat.label ?? ''),
      ...(i.dim ? [h('span', null, i.dim)] : []),
      ...(i.note ? [h('span', { class: 'st-note' }, i.note)] : []),
      ...(i.source ? [h('span', { class: 'st-src' }, `Source: ${i.source}`)] : []));
    card.style.display = '';
    const W = canvas.clientWidth, cw = Math.min(260, W - 16);
    card.style.maxWidth = `${cw}px`;
    card.style.transform = `translate(${Math.max(8, Math.min(W - cw - 8, x + 14)).toFixed(0)}px, ${Math.max(8, y + 14).toFixed(0)}px)`;
  };
  const hitAt = (x: number, y: number) => {
    if (!st) return null;
    const r = st.ray(x, y);
    return pick(model, r.o, r.d, st.knobs())?.item ?? null;
  };
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons || mode !== 'gl' || e.pointerType === 'touch') return;
    const rc = canvas.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    cancelAnimationFrame(hoverRaf);
    hoverRaf = requestAnimationFrame(() => {
      const it = hitAt(x, y);
      st?.setHover(it?.name ?? null);
      canvas.style.cursor = it ? 'pointer' : '';
      if (!pinned) showCard(it, x, y);
    });
  });
  canvas.addEventListener('pointerleave', () => { st?.setHover(pinned?.name ?? null); if (!pinned) showCard(null); });
  let down: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const rc = canvas.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top, it = hitAt(x, y);
    pinned = it && pinned?.name !== it.name ? it : null;
    st?.setHover(pinned?.name ?? it?.name ?? null);
    showCard(pinned ?? (e.pointerType === 'touch' ? null : it), x, y);
  });

  // ---------------------------------------------------------------- knobs and the tour

  const knobs = () => ({ explode: Number(exIn.value), cut: Number(cutIn.value) });
  const applyKnobs = () => { st?.setKnobs(knobs()); if (mode === 'flat') drawFlat(); };
  exIn.addEventListener('input', applyKnobs);
  cutIn.addEventListener('input', applyKnobs);

  const goBeat = (i: number) => {
    const beats = model.beats ?? [];
    if (!beats.length) return;
    beat = Math.max(0, Math.min(beats.length - 1, i));
    const b = beats[beat];
    cap.replaceChildren(h('b', null, `${beat + 1} / ${beats.length} · ${b.title}. `), b.text);
    prev.disabled = beat === 0;
    next.textContent = beat === beats.length - 1 ? 'Done' : 'Next ›';
    st?.setFocus(b.show ? new Set(b.show) : null);
    const from = { ...knobs(), cam: st ? { target: [...st.camera.target] as Vec3, yaw: st.camera.yaw, pitch: st.camera.pitch, dist: st.camera.dist } : null };
    const to = { explode: b.explode ?? from.explode, cut: b.cut ?? from.cut };
    cancelAnimationFrame(tween);
    const dur = reducedMotion() ? 0 : 900, t0 = performance.now();
    // the shorter way round in yaw
    const dy = from.cam ? ((((b.view.yaw - from.cam.yaw) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI : 0;
    const step = (now: number) => {
      const f = dur ? ease(Math.min(1, (now - t0) / dur)) : 1;
      exIn.value = String(from.explode + (to.explode - from.explode) * f);
      cutIn.value = String(from.cut + (to.cut - from.cut) * f);
      if (st && from.cam) {
        const c = st.camera, lim = c.limits;
        lim.maxDist = Math.max(lim.maxDist, b.view.dist * 1.5); lim.maxPan = Math.max(lim.maxPan, 200); lim.minPitch = Math.min(lim.minPitch, b.view.pitch);
        c.target = from.cam.target.map((v, k) => v + (b.view.target[k] - v) * f) as Vec3;
        c.yaw = from.cam.yaw + dy * f; c.pitch = from.cam.pitch + (b.view.pitch - from.cam.pitch) * f; c.dist = from.cam.dist * Math.pow(b.view.dist / from.cam.dist, f);
      }
      applyKnobs();
      st?.invalidate();
      tween = f < 1 ? requestAnimationFrame(step) : 0;
    };
    tween = requestAnimationFrame(step);
  };
  next.addEventListener('click', () => {
    const n = (model.beats ?? []).length;
    if (beat === n - 1) { beat = -1; cap.replaceChildren(); next.textContent = 'Tour ›'; prev.disabled = true; st?.setFocus(null); return; }
    goBeat(beat + 1);
  });
  prev.addEventListener('click', () => goBeat(beat - 1));
  prev.disabled = true;
  resetBtn.addEventListener('click', () => { st?.camera.reset(); st?.invalidate(); });

  // ---------------------------------------------------------------- the flat drawing

  const drawFlat = () => {
    const m = o.build('flat'), pr = flatView(o.home.yaw, o.home.pitch), k = knobs(), cuts = cutsAt(m, k.cut), L = norm3([-0.5, 0.85, 0.45]);
    const faces: { pts: [number, number][]; z: number; fill: string }[] = [], M = new Float32Array(16);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const it of m.items) {
      itemMatrix(it, k.explode, M);
      const P = it.geo.positions, I = it.geo.indices, glass = (it.mat.transmit ?? 0) > 0.3, cut = (it.cut ?? 'section') !== 'none' && cuts.length > 0;
      const base = resolve(it.mat.base), em = it.mat.emit ? resolve(it.mat.emit).map((v) => v * Math.min(1, it.mat.glow ?? 0)) : [0, 0, 0];
      for (let t = 0; t < I.length; t += 3) {
        const w = [I[t], I[t + 1], I[t + 2]].map((i) => applyMat(M, [P[3 * i], P[3 * i + 1], P[3 * i + 2]]));
        const c: Vec3 = [(w[0][0] + w[1][0] + w[2][0]) / 3, (w[0][1] + w[1][1] + w[2][1]) / 3, (w[0][2] + w[1][2] + w[2][2]) / 3];
        if (cut && isCut(cuts, c)) continue;
        const q = w.map(pr), n = norm3(crossv(sub3(w[1], w[0]), sub3(w[2], w[0])));
        // facing the viewer (the projection's depth grows towards it)
        if ((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]) <= 0 && !glass) continue;
        const lit = 0.45 + 0.55 * Math.max(0, dot3(n, L)), col = base.map((v, i) => Math.min(1, v * lit + em[i]));
        const fill = `rgb(${col.map((v) => Math.round(v * 255)).join(' ')} / ${glass ? 0.12 : 1})`;
        faces.push({ pts: q.map((v) => [v[0], v[1]]), z: (q[0][2] + q[1][2] + q[2][2]) / 3, fill });
        for (const v of q) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
      }
    }
    faces.sort((a, b) => a.z - b.z);
    const sc = Math.min((FW * 0.9) / (x1 - x0 || 1), (FH * 0.9) / (y1 - y0 || 1)), X = (x: number) => FW / 2 + (x - (x0 + x1) / 2) * sc, Y = (y: number) => FH / 2 - (y - (y0 + y1) / 2) * sc;
    const g = s('g');
    for (const f of faces) g.append(s('polygon', { points: f.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' '), style: `fill:${f.fill};stroke:${f.fill}`, class: 'st-face' }));
    for (const a of m.anchors ?? []) {
      if (a.minor || a.under) continue;
      const [x, y] = pr(anchorAt(m, a, k.explode));
      g.append(s('text', { x: X(x), y: Y(y), class: 'm3-flat-lbl', 'text-anchor': 'middle' }, a.text));
    }
    flat.replaceChildren(g);
  };
  const crossv = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // ---------------------------------------------------------------- modes

  const lights = () => st?.setEnv({ sky: colors.rgb('--st-sky'), ground: colors.rgb('--st-ground'), key: colors.rgb('--st-key'), accent: colors.rgb('--st-accent') });
  const setMode = (m: 'gl' | 'flat') => {
    mode = m;
    canvas.style.display = m === 'flat' ? 'none' : '';
    flat.style.display = m === 'flat' ? '' : 'none';
    // the gutters keep their columns (hidden, not removed), so the view stays in the middle one
    leaders.style.display = dots.style.display = m === 'flat' ? 'none' : '';
    gutL.style.visibility = gutR.style.visibility = m === 'flat' ? 'hidden' : '';
    hint.textContent = m === 'flat' ? `${o.note ?? ''} A flat view: this browser has no WebGL2 for the 3D one (no shadows, glass or cut faces).` : `${o.note ?? ''} Point at a part for its name, size and source; click to keep the card. Drag to turn, wheel or pinch to zoom.`;
    refresh();
  };
  const refresh = () => {
    if (dead) return;
    if (mode === 'flat') { drawFlat(); return; }
    model = o.build('full');
    st?.setModel(model, resolve);
    st?.setKnobs(knobs());
  };
  const unwatch = watchTheme(() => { colors.invalidate(); lights(); refresh(); });

  const forceFlat = /flat3d/.test(location.hash + location.search);
  void import('../gl/studio').then(({ createStudio, OrbitCamera }) => {
    if (dead) return;
    if (forceFlat) { setMode('flat'); return; }
    const cam = new OrbitCamera(o.home, o.limits);
    try {
      st = createStudio(canvas, cam, {
        onRender: () => {
          placeLabels();
          const f = st!.last();
          stats.textContent = `${f.cpuMs.toFixed(1)} ms cpu${f.gpuMs !== null ? ` · ${f.gpuMs.toFixed(1)} ms gpu` : ''} · ${f.draws} draws · ${(f.tris / 1000).toFixed(0)}k tris · ${(f.px / 1e6).toFixed(2)} Mpx${f.shadowRedrawn ? ' · shadow' : ''}`;
        },
        onLost: () => setMode('flat'), onRestored: () => setMode('gl'),
      });
    } catch (e) { console.error(e); st = null; }
    if (!st) { setMode('flat'); return; }
    (window as unknown as { __studio?: Studio }).__studio = st;
    lights();
    setMode('gl');
  }).catch(() => { if (!dead) setMode('flat'); });

  return {
    el, bar, chips, hint, refresh,
    instances(key, geo, mat, data) { st?.setInstances(key, geo, mat, data); },
    studio: () => st,
    isFlat: () => mode === 'flat',
    rgb: (t) => colors.rgb(t),
    destroy() { dead = true; cancelAnimationFrame(tween); cancelAnimationFrame(hoverRaf); unwatch(); st?.destroy(); st = null; colors.destroy(); },
  };
}
