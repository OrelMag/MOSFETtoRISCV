// A studio model's stage: the canvas on gl/studio.ts, or without WebGL2 the same model drawn flat in SVG from its home
// view. The canvas comes first and takes its aspect from the model (a tall tube gets a tall canvas), the model fitted
// to it with a small margin; the controls follow under it. Labels sit in gutters beside the canvas with leader lines to
// their parts; on a phone the gutters hold numbered badges (the names in a list under the canvas), so a label never
// sits on what it names. Hover a part for its card (name, material, dimension, source), click to keep it. Sliders for
// the exploded view and the cut; the tour's beats as Back / Next with a caption, the camera easing to frame each
// beat's subject. The corner tools every model has (turn, save image, full screen). ?stats shows each frame's cost.

import '../styles/relay3d.css';
import '../styles/model3d.css';
import '../styles/studio3d.css';
import { CssColors, watchTheme } from '../gl/color';
import type { OrbitLimits, OrbitView } from '../gl/camera';
import { flatView } from '../gl/parts';
import { dot3, norm3, sub3, type Vec3 } from '../gl/math';
import type { RGB } from '../gl/instances';
import type { Renderer } from '../gl/renderer';
import type { Geo } from '../gl/kit/geo';
import type { Colour, Material } from '../gl/kit/materials';
import { anchorAt, applyMat, aspectOf, boundsOf, boundsOfNamed, cutsAt, fitView, isCut, itemMatrix, pick, type Item, type Model3, type Moves, type StudioAnchor } from '../gl/kit/scene';
import type { Studio } from '../gl/studio';
import { h, icon, s } from '../ui/dom';
import { settings } from '../ui/settings';
import { framing, namesShown } from '../gl/kit/names';
import { reducedMotion } from '../ui/motion';
import { modelFrame } from './modelframe';

export interface StudioStageOptions {
  aria: string;
  /** The home direction (yaw, pitch); its target and distance are fitted to the model unless `fit` is false. */
  home: OrbitView;
  fit?: boolean;
  /** Fit home to these groups or names, not the whole model (the subject first: a device under its wiring). */
  homeFrame?: string[];
  /** Fit home to a sphere of this radius round the framed box's centre instead of the box's corners (a round model: a
   *  radiation pattern, a ring), which would otherwise leave it small. */
  homeRadius?: number;
  /** homeRadius on a canvas narrow enough for badges (a phone): further out, so no main part's anchor sits under a badge at the edge. */
  homeRadiusNarrow?: number;
  /** The canvas's aspect (w / h) when the model's own would mislead: a model built only once on the page (empty at
   *  first), or one whose home view is a set camera (fit: false). */
  aspect?: number;
  /** Groups or names hidden outside the tour and in beats that do not say (a beat's `hide: []` shows them). */
  hidden?: string[];
  /** A scale bar under the canvas following the zoom: the label for a length in model units (1-2-5 steps). */
  scaleBar?: (len: number) => string;
  /** Called when the tour goes to beat i (-1: the tour ended). */
  onBeat?: (i: number) => void;
  /** The cut and explode the stage opens at (a cutaway as the first view). */
  knobs?: { cut?: number; explode?: number };
  /** The cut or explode moved (a slider or the tour): parts the host draws itself (particles) can follow. */
  onKnobs?: (k: { cut: number; explode: number }) => void;
  limits?: Partial<OrbitLimits>;
  note?: string;
  /** The note's longer part (sources, every simplification): plain text in a folded "Sources and simplifications" after the hint. */
  noteMore?: string;
  /** The model now, at a detail: 'flat' for the SVG fallback (fewer facets). */
  build: (detail: 'full' | 'flat') => Model3;
}

export interface StudioStage {
  el: HTMLElement;
  /** Under the canvas, before the stage's own controls: the host's controls go here. */
  slot: HTMLElement;
  chips: HTMLElement;
  hint: HTMLElement;
  /** Rebuild the model (a state changed). */
  refresh(): void;
  /** Ease the camera to a view and make it home (a host's own view buttons; with fit: false). */
  goTo(view: OrbitView): void;
  /** Put the camera at a view now, without a tween and without making it home (a camera following a moving part). */
  look(view: OrbitView): void;
  /** `casts`: the set casts shadows (the shadow's fit then takes it in). */
  instances(key: string, geo: Geo, mat: Material, data: Float32Array, casts?: boolean): void;
  /** Leave the tour (a host whose model changes under it: its beats may no longer be the same). */
  endTour(): void;
  /** Parts moved by the physics this frame. */
  move(moves: Moves): void;
  studio(): Studio | null;
  isFlat(): boolean;
  rgb(token: string): RGB;
  knobs(): { cut: number; explode: number };
  /** Set the cutaway and explode sliders (a control that needs the cut open, say). */
  setKnobs(k: { cut?: number; explode?: number }): void;
  destroy(): void;
}

const FW = 640, FH = 520;
/** The narrowest canvas the names may flank: below it, numbered badges and the list (measured, not by device). */
const MIN_CANVAS = 260, MIN_CANVAS_H = 240, GUTTER_MIN = 56, GUTTER_MAX = 150;
/** The canvas's aspect (w / h) is the model's, held within these. */
const ASPECT_MIN = 0.62, ASPECT_MAX = 1.9;
const ease = (t: number) => t * t * (3 - 2 * t);

export function studioStage(o: StudioStageOptions): StudioStage {
  const canvas = h('canvas', { class: 'r3-canvas', tabindex: 0, 'aria-label': `${o.aria}: drag to turn, wheel or pinch to zoom; point at a part for its name` }) as HTMLCanvasElement;
  const flat = s('svg', { class: 'r3-flat', viewBox: `0 0 ${FW} ${FH}`, role: 'img', 'aria-label': o.aria }) as SVGSVGElement;
  flat.style.display = 'none';
  const leaders = s('svg', { class: 'st-leaders', 'aria-hidden': 'true' }) as SVGSVGElement;
  const gutL = h('div', { class: 'st-gutter l', 'aria-hidden': 'true' }), gutR = h('div', { class: 'st-gutter r', 'aria-hidden': 'true' });
  const badges = h('div', { class: 'st-badges', 'aria-hidden': 'true' });
  const card = h('div', { class: 'st-card', role: 'status' });
  card.style.display = 'none';
  const chips = h('div', { class: 'r3-chips' });
  const stats = h('div', { class: 'st-stats' });
  const scaleLbl = h('span'), scaleBar = h('div', { class: 'st-scale', 'aria-hidden': 'true' }, h('i'), scaleLbl);
  if (!o.scaleBar) scaleBar.style.display = 'none';
  stats.style.display = /stats/.test(location.hash + location.search) ? '' : 'none';
  // the gutters lie over the canvas's side bands: the canvas takes the column's width and the model is fitted between them
  const view = h('div', { class: 'st-view r3-stage' }, canvas, flat, gutL, gutR, leaders, badges, card, chips, stats, scaleBar);
  const stage = h('div', { class: 'st-stage' }, view);
  const list = h('ol', { class: 'st-list' });

  const exIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Exploded view' }) as HTMLInputElement;
  const cutIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: o.knobs?.cut ?? 0, 'aria-label': 'Cutaway' }) as HTMLInputElement;
  exIn.value = String(o.knobs?.explode ?? 0);
  const prev = h('button', { type: 'button', class: 'btn sm' }, '‹ Back') as HTMLButtonElement;
  const next = h('button', { type: 'button', class: 'btn sm primary' }, 'Tour ›') as HTMLButtonElement;
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset view') as HTMLButtonElement;
  const cap = h('div', { class: 'st-caption', 'aria-live': 'polite' });
  const slot = h('div', { class: 'st-slot' });
  const bar = h('div', { class: 'st-bar' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Cutaway'), cutIn),
    h('label', { class: 'r3-sl' }, h('span', null, 'Explode'), exIn),
    h('div', { class: 'r3-btns' }, prev, next, resetBtn));
  const hint = h('div', { class: 'r3-hint' });
  const more = o.noteMore ? h('details', { class: 'deeper st-more' }, h('summary', null, 'Sources and simplifications'), h('p', null, o.noteMore)) : null;
  const el = h('div', { class: 'st' }, stage, list, cap, slot, bar, hint, ...(more ? [more] : []));

  const colors = new CssColors(el); // in the stage: its --st-* tokens apply, and the host's (a model's palette) are inherited
  const resolve = (c: Colour): RGB => (typeof c === 'string' ? colors.rgb(c) : c);

  let mode: 'wait' | 'gl' | 'flat' = 'wait', st: Studio | null = null, dead = false;
  let model: Model3 = o.build('full');
  /** The parts the physics moved last (kept here so the flat drawing, the labels and a rebuilt renderer follow). */
  let curMoves: Moves = new Map();
  let beat = -1, tween = 0, pinned: Item | null = null, hoverRaf = 0, hiddenNow: ReadonlySet<string> | null = null;
  const defHidden: ReadonlySet<string> | null = o.hidden?.length ? new Set(o.hidden) : null;
  hiddenNow = defHidden;
  // home frames what home shows: parts hidden outside the tour (o.hidden) do not widen it
  const shownModel = (): Model3 => (defHidden ? { ...model, items: model.items.filter((it) => !((it.group && defHidden.has(it.group)) || (it.name && defHidden.has(it.name)))) } : model);
  const homeBox = () => (o.homeFrame ? boundsOfNamed(model, o.homeFrame) : boundsOf(shownModel()));
  // ---- names: the corner tag button, N, settings.modelNames ----
  let namesOn = settings.modelNames;
  // a tag (the icon set is on the first-load path; this one lives with the only button that uses it)
  const tag = icon('plus', 16);
  tag.innerHTML = '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>';
  const namesBtn = h('button', { type: 'button', class: 'r3-tool st-names' }, tag) as HTMLButtonElement;
  namesBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  namesBtn.addEventListener('click', () => settings.set('modelNames', !namesOn));
  const showNamesBtn = () => {
    const label = namesOn ? 'Hide names' : 'Show names';
    namesBtn.setAttribute('aria-label', label); namesBtn.title = `${label} (N)`; namesBtn.setAttribute('aria-pressed', String(namesOn));
  };
  showNamesBtn();
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    settings.set('modelNames', !namesOn);
  });
  /** The switch moved: names, list and gutters follow; the canvas widens or narrows (home refits only if the view is home). */
  function applyNames(): void {
    namesOn = settings.modelNames;
    showNamesBtn();
    list.hidden = !namesOn;
    el.classList.toggle('st-nonames', !namesOn);
    layout();
    if (mode === 'flat') drawFlat(); else { placeLabels(); st?.invalidate(); }
  }
  const frame = modelFrame({ stage: view, name: o.aria, renderer: () => (mode === 'gl' ? (st as unknown as Renderer) : null), root: () => el.closest<HTMLElement>('.m3d, .widget') ?? el });
  frame.el.prepend(namesBtn);
  list.hidden = !namesOn;
  el.classList.toggle('st-nonames', !namesOn);

  // ---------------------------------------------------------------- framing

  /** The model's aspect as seen from home. The canvas is sized from it in one rule for both label forms: the content (the
   *  part the model is fitted to) is the column less two gutters (none with badges), as tall as the model's aspect asks but
   *  at least MIN_CANVAS_H and at most most of the screen's height (a tall model then narrows, centred); the canvas is
   *  that content plus the gutters, which lie over its side bands. A long, low model so fills the column; a tall one
   *  keeps its portrait. */
  let aspect = 4 / 3, gutNow = 0, shownSize = '';
  const shape = () => {
    const box = homeBox();
    aspect = o.aspect ?? Math.max(ASPECT_MIN, Math.min(ASPECT_MAX, aspectOf(box, o.home.yaw, o.home.pitch) * 1.15));
    layout();
  };
  // the canvas box is sized as with names on (turning them off never moves the page); off, the model takes the gutters' width
  const frameNow = () => framing(namesOn, el.clientWidth, gutterW, rows.length, MIN_CANVAS);
  const isNarrow = () => frameNow().form;
  const layout = () => {
    const C = el.clientWidth;
    if (!C) return;
    const fr = frameNow(), narrow = fr.form, g = fr.size, maxH = Math.max(MIN_CANVAS_H, Math.min(window.innerHeight * 0.78, 760));
    let wc = C - 2 * g, hh = Math.max(MIN_CANVAS_H, wc / aspect);
    if (hh > maxH) { hh = maxH; wc = Math.min(wc, hh * aspect); }
    const W = Math.round(wc + 2 * g), H = Math.round(hh), key = `${W}x${H}x${fr.fit}`;
    gutNow = fr.fit;
    if (el.classList.contains('narrow') !== narrow) el.classList.toggle('narrow', narrow);
    if (key === shownSize) return;
    shownSize = key;
    view.style.setProperty('--st-gw', `${fr.fit}px`);
    view.style.aspectRatio = (W / H).toFixed(4);
    view.style.maxWidth = `${W}px`;
    st?.invalidate();
  };
  /** The width over height of the part of the canvas the model is fitted to (between the gutters). */
  const contentAspect = () => Math.max(0.2, ((canvas.clientWidth || 4) - 2 * gutNow) / (canvas.clientHeight || 3));
  /** A home the host set with goTo is a view it chose (target and distance included): a resize keeps it, never refits it. */
  let homeGiven = false;
  const homeView = (): OrbitView => {
    if (o.fit === false || homeGiven || !st) return o.home;
    const box = homeBox();
    const radius = (isNarrow() && o.homeRadiusNarrow) || o.homeRadius;
    if (radius) {
      const c: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
      const half = Math.atan(Math.tan(st.camera.fov / 2) * Math.min(1, contentAspect())) * 0.94;
      return { yaw: o.home.yaw, pitch: o.home.pitch, target: c, dist: radius / Math.sin(half) };
    }
    const f = fitView(box, o.home.yaw, o.home.pitch, st.camera.fov, contentAspect(), 0.06);
    return { yaw: o.home.yaw, pitch: o.home.pitch, target: f.target, dist: f.dist };
  };
  let fitFor = '';
  const refit = () => {
    if (!st) return;
    const key = `${canvas.clientWidth}x${canvas.clientHeight}x${gutNow}`;
    if (key === fitFor || !st.camera.atHome() || !canvas.clientWidth) return;
    fitFor = key;
    const v = homeView();
    st.camera.rehome(v, { maxDist: Math.max(st.camera.limits.maxDist, v.dist * 3), minDist: Math.min(st.camera.limits.minDist, v.dist / 8), maxPan: Math.max(st.camera.limits.maxPan, v.dist) });
    st.invalidate();
  };

  // ---------------------------------------------------------------- labels: gutters, leaders, phone badges

  let lblKey = '', gutterW = 112;
  /** The gutter width the longest name needs, from the label's own font. */
  const measureGutter = () => {
    const probe = h('span', { class: 'st-lbl', style: 'position:absolute;visibility:hidden;left:auto;right:auto;width:auto;overflow:visible' });
    el.append(probe);
    let w = 0;
    for (const r of rows) { probe.textContent = r.a.text; w = Math.max(w, probe.getBoundingClientRect().width); }
    probe.remove();
    gutterW = Math.round(Math.max(GUTTER_MIN, Math.min(GUTTER_MAX, w + 4)));
  };
  let rows: { a: StudioAnchor; el: HTMLElement; badge: HTMLElement; li: HTMLElement }[] = [];
  const makeLabels = () => {
    const anchors = (model.anchors ?? []).filter((a) => !a.minor);
    const key = anchors.map((a) => a.text).join('|');
    if (key === lblKey) return;
    lblKey = key;
    gutL.replaceChildren(); gutR.replaceChildren(); // the old names, or they stay where they were last placed
    rows = anchors.map((a, i) => ({ a, el: h('span', { class: 'st-lbl' }, a.text), badge: h('span', { class: 'st-badge' }, String(i + 1)), li: h('li', null, h('b', null, String(i + 1)), ' ', a.text) }));
    badges.replaceChildren(...rows.map((r) => r.badge));
    list.replaceChildren(...rows.map((r) => r.li));
    measureGutter();
  };
  /** Spread n wanted heights at least `gap` apart within [top, bottom], keeping their order. */
  const spread = (want: number[], gap: number, top: number, bottom: number) => {
    const ys = want.map((y) => Math.min(bottom, Math.max(top, y)));
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + gap);
    for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i], (i < ys.length - 1 ? ys[i + 1] : bottom + gap) - gap);
    return ys;
  };
  const placeLabels = () => {
    if (mode !== 'gl' || !st) return;
    makeLabels();
    refit();
    layout();
    const W = canvas.clientWidth, H = canvas.clientHeight, cam = st.camera, eye = cam.eye(), under = cam.pitch < -0.25, narrow = gutNow === 0, g = gutNow;
    const k = st.knobs().explode;
    const seen: { r: typeof rows[number]; x: number; y: number; away: boolean }[] = [];
    const quiet = !namesShown(namesOn, beat >= 0 ? model.beats?.[beat]?.labels : undefined);
    const cutNow = model.cutLabels ? cutsAt(model, st.knobs().cut) : [], isOpen = st.knobs().cut > 0.5;
    for (const r of rows) {
      const hiddenPart = !!hiddenNow && !!r.a.on && hiddenNow.has(r.a.on);
      const p3 = anchorAt(model, r.a, k, curMoves), p = st.project(p3);
      const ok = !quiet && !hiddenPart && !isCut(cutNow, p3) && (r.a.whenCut === undefined || r.a.whenCut === isOpen) && !!p && !!r.a.under === under && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H;
      r.el.style.display = 'none'; r.badge.style.display = 'none';
      r.li.hidden = !!r.a.under !== under || (r.a.whenCut !== undefined && r.a.whenCut !== isOpen) || hiddenPart; r.li.classList.toggle('off', !ok);
      if (!ok) continue;
      seen.push({ r, x: p![0], y: p![1], away: dot3(r.a.n, sub3(eye, p3)) < 0 });
    }
    // Each label on the side its anchor is nearer (or its `gutter`), stacked in the order of their heights. Wide: the names in the gutters
    // over the canvas's side bands; narrow: numbered badges just inside its edges (the names are in the list below).
    const lines: SVGElement[] = [];
    for (const side of ['l', 'r'] as const) {
      const col = seen.filter((q) => (q.r.a.gutter ?? (q.x < W / 2 ? 'l' : 'r')) === side).sort((a, b) => a.y - b.y);
      // the right column stops above the corner buttons, the left above the scale bar
      // on a phone the left badges start below the status chips (top left, over the canvas)
      const top = narrow && side === 'l' && chips.childElementCount ? Math.max(12, chips.offsetTop + chips.offsetHeight + 18) : 12;
      const ys = spread(col.map((q) => q.y), narrow ? 24 : 22, top, side === 'r' ? H - (narrow ? 70 : 56) : o.scaleBar ? H - (narrow ? 58 : 40) : H - 12);
      col.forEach((q, i) => {
        const y = ys[i];
        let gx: number, elbow: number;
        if (narrow) {
          q.r.badge.style.display = '';
          gx = side === 'l' ? 14 : W - 14;
          q.r.badge.style.transform = `translate(${gx.toFixed(1)}px, ${y.toFixed(1)}px)`;
          q.r.badge.classList.toggle('away', q.away);
          gx += side === 'l' ? 10 : -10;
          elbow = side === 'l' ? 32 : W - 32;
        } else {
          const gut = side === 'l' ? gutL : gutR;
          if (q.r.el.parentElement !== gut) gut.append(q.r.el);
          q.r.el.style.display = '';
          q.r.el.style.transform = `translateY(${(y - 9).toFixed(1)}px)`;
          q.r.el.classList.toggle('away', q.away);
          gx = side === 'l' ? g - 2 : W - g + 2;
          elbow = side === 'l' ? g + 8 : W - g - 8;
        }
        lines.push(s('polyline', { points: `${gx},${y} ${elbow},${y} ${q.x},${q.y}`, class: q.away ? 'away' : '' }));
        lines.push(s('circle', { cx: q.x, cy: q.y, r: 2.6, class: q.away ? 'away' : '' }));
      });
    }
    leaders.setAttribute('width', String(W)); leaders.setAttribute('height', String(H));
    leaders.replaceChildren(...lines);
  };

  /** The scale bar: the 1-2-5 length nearest 90 px at the camera's target, short enough to end before the corner tools
   *  (on a phone a long one ran under them). */
  const placeScale = () => {
    if (!st || !o.scaleBar) return;
    const u = st.camera.unitsPerPx(canvas.clientHeight || 1), want = 90 * u, p = 10 ** Math.floor(Math.log10(want));
    const room = Math.max(24, (canvas.clientWidth || 300) - 2 * gutNow - 20 - toolsW());
    const fits = [0.1, 0.2, 0.5, 1, 2, 5, 10].map((m) => m * p).filter((l) => l / u <= room);
    const len = (fits.length ? fits : [0.1 * p]).reduce((a, b) => (Math.abs(Math.log(b / want)) < Math.abs(Math.log(a / want)) ? b : a));
    (scaleBar.firstChild as HTMLElement).style.width = `${(len / u).toFixed(1)}px`;
    scaleLbl.textContent = o.scaleBar(len);
  };

  /** The corner tools' width (they sit bottom right, over the canvas). */
  const toolsW = () => { const t = view.querySelector<HTMLElement>('.r3-tools, .m3-tools'); return t ? t.getBoundingClientRect().width + 10 : 140; };

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
    card.style.transform = `translate(${Math.max(8, Math.min(W - cw - 8, x + 14)).toFixed(0)}px, ${Math.max(8, Math.min(canvas.clientHeight - 120, y + 14)).toFixed(0)}px)`;
  };
  const hitAt = (x: number, y: number) => {
    if (!st) return null;
    const r = st.ray(x, y);
    return pick(model, r.o, r.d, st.knobs(), { moves: st.moves(), hidden: hiddenNow ?? undefined })?.item ?? null;
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
  const applyKnobs = () => { const k = knobs(); st?.setKnobs(k); o.onKnobs?.(k); if (mode === 'flat') drawFlat(); };
  exIn.addEventListener('input', applyKnobs);
  cutIn.addEventListener('input', applyKnobs);

  const goBeat = (i: number) => {
    const beats = model.beats ?? [];
    if (!beats.length) return;
    beat = Math.max(0, Math.min(beats.length - 1, i));
    // first, so a beat that changes the model's state (and rebuilds it) gets its caption from the rebuilt model
    o.onBeat?.(beat);
    const b = (model.beats ?? beats)[beat] ?? beats[beat];
    cap.replaceChildren(h('b', null, `${beat + 1} / ${beats.length} · ${b.title}. `), b.text);
    prev.disabled = beat === 0;
    next.textContent = beat === beats.length - 1 ? 'Done' : 'Next ›';
    st?.setFocus(b.show ? new Set(b.show) : null);
    hiddenNow = b.hide ? new Set(b.hide) : defHidden;
    st?.setHidden(hiddenNow);
    const to = { explode: b.explode ?? knobs().explode, cut: b.cut ?? knobs().cut };
    // the beat's subject framed from its direction, at the knobs it ends on
    let dest: OrbitView = b.view;
    if (b.frame && st) {
      const f = fitView(boundsOfNamed(model, b.frame, to.explode), b.view.yaw, b.view.pitch, st.camera.fov, contentAspect(), 0.12);
      dest = { yaw: b.view.yaw, pitch: b.view.pitch, target: f.target, dist: f.dist };
    }
    const from = { ...knobs(), cam: st ? { target: [...st.camera.target] as Vec3, yaw: st.camera.yaw, pitch: st.camera.pitch, dist: st.camera.dist } : null };
    cancelAnimationFrame(tween);
    const dur = reducedMotion() ? 0 : 900, t0 = performance.now();
    const dy = from.cam ? ((((dest.yaw - from.cam.yaw) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI : 0;
    const step = (now: number) => {
      const f = dur ? ease(Math.min(1, (now - t0) / dur)) : 1;
      exIn.value = String(from.explode + (to.explode - from.explode) * f);
      cutIn.value = String(from.cut + (to.cut - from.cut) * f);
      if (st && from.cam) {
        const c = st.camera, lim = c.limits;
        lim.maxDist = Math.max(lim.maxDist, dest.dist * 1.5); lim.minDist = Math.min(lim.minDist, dest.dist * 0.5);
        lim.maxPan = Math.max(lim.maxPan, 400); lim.minPitch = Math.min(lim.minPitch, dest.pitch);
        c.target = from.cam.target.map((v, j) => v + (dest.target[j] - v) * f) as Vec3;
        c.yaw = from.cam.yaw + dy * f; c.pitch = from.cam.pitch + (dest.pitch - from.cam.pitch) * f; c.dist = from.cam.dist * Math.pow(dest.dist / from.cam.dist, f);
      }
      applyKnobs();
      st?.invalidate();
      tween = f < 1 ? requestAnimationFrame(step) : 0;
    };
    tween = requestAnimationFrame(step);
  };
  const goTo = (dest: OrbitView) => {
    homeGiven = true;
    if (!st) { o.home = dest; return; }
    const c = st.camera, from = { target: [...c.target] as Vec3, yaw: c.yaw, pitch: c.pitch, dist: c.dist };
    cancelAnimationFrame(tween);
    const dur = reducedMotion() ? 0 : 800, t0 = performance.now();
    const dy = ((((dest.yaw - from.yaw) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const lim = c.limits;
    lim.maxDist = Math.max(lim.maxDist, dest.dist * 1.5); lim.minDist = Math.min(lim.minDist, dest.dist * 0.5); lim.minPitch = Math.min(lim.minPitch, dest.pitch);
    const step = (now: number) => {
      const f = dur ? ease(Math.min(1, (now - t0) / dur)) : 1;
      c.target = from.target.map((v, j) => v + (dest.target[j] - v) * f) as Vec3;
      c.yaw = from.yaw + dy * f; c.pitch = from.pitch + (dest.pitch - from.pitch) * f; c.dist = from.dist * Math.pow(dest.dist / from.dist, f);
      st?.invalidate();
      if (f < 1) tween = requestAnimationFrame(step);
      else { tween = 0; o.home = dest; st?.camera.rehome(dest); }
    };
    tween = requestAnimationFrame(step);
  };
  const endTour = () => { beat = -1; cap.replaceChildren(); next.textContent = 'Tour ›'; prev.disabled = true; st?.setFocus(null); hiddenNow = defHidden; st?.setHidden(defHidden); o.onBeat?.(-1); if (mode === 'flat') drawFlat(); };
  next.addEventListener('click', () => { if (beat === (model.beats ?? []).length - 1) endTour(); else goBeat(beat + 1); });
  prev.addEventListener('click', () => goBeat(beat - 1));
  prev.disabled = true;
  resetBtn.addEventListener('click', () => { st?.camera.reset(); st?.invalidate(); });

  // ---------------------------------------------------------------- the flat drawing

  const drawFlat = () => {
    const m = o.build('flat'), pr = flatView(o.home.yaw, o.home.pitch), k = knobs(), cuts = cutsAt(m, k.cut), L = norm3([-0.5, 0.85, 0.45]);
    const faces: { pts: [number, number][]; z: number; fill: string; it: number }[] = [], M = new Float32Array(16), far: number[] = [];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [ii, it] of m.items.entries()) {
      far[ii] = Infinity;
      if (it.mat.beam) continue;
      // a hidden group or name (a beat's hide, the frame boxes a model fits by) is not drawn, as on the GPU and in pick
      if (hiddenNow && ((it.group && hiddenNow.has(it.group)) || (it.name && hiddenNow.has(it.name)))) continue;
      itemMatrix(it, k.explode, M, curMoves);
      const P = it.geo.positions, I = it.geo.indices, glass = (it.mat.transmit ?? 0) > 0.3, cut = (it.cut ?? 'section') !== 'none' && cuts.length > 0;
      const base = resolve(it.mat.base), em = it.mat.emit ? resolve(it.mat.emit).map((v) => v * Math.min(1, it.mat.glow ?? 0)) : [0, 0, 0];
      for (let t = 0; t < I.length; t += 3) {
        const w = [I[t], I[t + 1], I[t + 2]].map((i) => applyMat(M, [P[3 * i], P[3 * i + 1], P[3 * i + 2]]));
        // one plane: the triangle clipped to what is kept (a face straddling the cut is cut, not kept or dropped whole); a
        // wedge (two planes keep the union of two sides) still goes by the triangle's centre
        let poly: Vec3[] = w;
        if (cut && cuts.length === 1) { poly = clipKeep(w, cuts[0]); if (poly.length < 3) continue; }
        else if (cut) {
          const c: Vec3 = [(w[0][0] + w[1][0] + w[2][0]) / 3, (w[0][1] + w[1][1] + w[2][1]) / 3, (w[0][2] + w[1][2] + w[2][2]) / 3];
          if (isCut(cuts, c)) continue;
        }
        const q = poly.map(pr), n = norm3(crossv(sub3(w[1], w[0]), sub3(w[2], w[0])));
        if ((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]) <= 0 && !glass) continue;
        const lit = 0.45 + 0.55 * Math.max(0, dot3(n, L)), col = base.map((v, i) => Math.min(1, v * lit + em[i]));
        const fill = `rgb(${col.map((v) => Math.round(v * 255)).join(' ')} / ${glass ? 0.12 : 1})`;
        faces.push({ pts: q.map((v) => [v[0], v[1]]), z: q.reduce((a, v) => a + v[2], 0) / q.length, fill, it: ii });
        far[ii] = Math.min(far[ii], ...q.map((v) => v[2]));
        for (const v of q) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
      }
    }
    // per triangle by default; a model of separate layers (stacked platters, thin overlays) asks for whole items back to
    // front by their farthest point, then the triangles within each, which long thin triangles cannot interleave
    if (m.flatOrder === 'items') faces.sort((a, b) => far[a.it] - far[b.it] || a.it - b.it || a.z - b.z);
    else faces.sort((a, b) => a.z - b.z);
    const sc = Math.min((FW * 0.9) / (x1 - x0 || 1), (FH * 0.9) / (y1 - y0 || 1)), X = (x: number) => FW / 2 + (x - (x0 + x1) / 2) * sc, Y = (y: number) => FH / 2 - (y - (y0 + y1) / 2) * sc;
    const g = s('g');
    for (const f of faces) g.append(s('polygon', { points: f.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' '), style: `fill:${f.fill};stroke:${f.fill}`, class: 'st-face' }));
    for (const a of namesOn ? m.anchors ?? [] : []) {
      if (a.minor || a.under) continue;
      const [x, y] = pr(anchorAt(m, a, k.explode, curMoves));
      g.append(s('text', { x: X(x), y: Y(y), class: 'm3-flat-lbl', 'text-anchor': 'middle' }, a.text));
    }
    flat.replaceChildren(g);
  };
  /** A convex polygon cut to the side a cut keeps (n·p ≤ d). */
  const clipKeep = (pts: Vec3[], c: { n: Vec3; d: number }): Vec3[] => {
    const out: Vec3[] = [], f = (p: Vec3) => dot3(c.n, p) - c.d;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], fa = f(a), fb = f(b);
      if (fa <= 0) out.push(a);
      if ((fa <= 0) !== (fb <= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    }
    return out;
  };
  const crossv = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // ---------------------------------------------------------------- modes

  const lights = () => st?.setEnv({ sky: colors.rgb('--st-sky'), ground: colors.rgb('--st-ground'), key: colors.rgb('--st-key'), accent: colors.rgb('--st-accent') });
  const setMode = (m: 'gl' | 'flat') => {
    mode = m;
    canvas.style.display = m === 'flat' ? 'none' : '';
    flat.style.display = m === 'flat' ? '' : 'none';
    leaders.style.display = badges.style.display = m === 'flat' ? 'none' : '';
    // the flat drawing is fitted, not to scale: no bar (it showed as a stray square)
    scaleBar.style.display = m === 'flat' || !o.scaleBar ? 'none' : '';
    // the gutters keep their columns (hidden, not removed), so the view stays in the middle one
    gutL.style.visibility = gutR.style.visibility = m === 'flat' ? 'hidden' : '';
    frame.setFlat(m === 'flat');
    hint.textContent = m === 'flat' ? `${o.note ?? ''} A flat view: this browser has no WebGL2 for the 3D one (no shadows, glass or cut faces).` : `${o.note ?? ''} Point at a part for its name, size and source; click to keep the card. Drag to turn, right-drag to pan, wheel or pinch to zoom; the corner buttons turn it, save an image and go full screen.`;
    refresh();
  };
  const refresh = () => {
    if (dead) return;
    model = o.build(mode === 'flat' ? 'flat' : 'full');
    shape();
    if (mode === 'flat') { drawFlat(); return; }
    st?.setModel(model, resolve);
    st?.setKnobs(knobs());
  };
  const unwatch = watchTheme(() => { colors.invalidate(); lights(); refresh(); });
  // one setting for every model (the menu's "3D model names", another model's button): follow it live
  const unnames = settings.onChange(() => { if (settings.modelNames !== namesOn) applyNames(); });
  // a column that changes width (a window resize, a drawer) re-lays the canvas out; the render that follows refits home
  const ro = new ResizeObserver(() => { layout(); st?.invalidate(); });
  ro.observe(el);

  const forceFlat = /flat3d/.test(location.hash + location.search);
  shape();
  void import('../gl/studio').then(({ createStudio, OrbitCamera }) => {
    if (dead) return;
    if (forceFlat) { setMode('flat'); return; }
    const cam = new OrbitCamera(o.home, o.limits);
    try {
      st = createStudio(canvas, cam, {
        onRender: () => {
          placeLabels();
          if (o.scaleBar) placeScale();
          const f = st!.last();
          stats.textContent = `${f.cpuMs.toFixed(1)} ms cpu${f.gpuMs !== null ? ` · ${f.gpuMs.toFixed(1)} ms gpu` : ''} · ${f.draws} draws · ${(f.tris / 1000).toFixed(0)}k tris · ${(f.px / 1e6).toFixed(2)} Mpx · ${f.tier}${f.shadowRedrawn ? ' · shadow' : ''}`;
        },
        onLost: () => setMode('flat'), onRestored: () => setMode('gl'),
      });
    } catch (e) { console.error(e); st = null; }
    if (!st) { setMode('flat'); return; }
    (window as unknown as { __studio?: Studio }).__studio = st;
    if (curMoves.size) st.move(curMoves);
    st.setHidden(defHidden);
    lights();
    setMode('gl');
  }).catch(() => { if (!dead) setMode('flat'); });

  return {
    el, slot, chips, hint, refresh, goTo,
    endTour() { if (beat >= 0) endTour(); },
    look(v: OrbitView) {
      if (!st) { o.home = v; return; }
      cancelAnimationFrame(tween); tween = 0;
      const c = st.camera, lim = c.limits;
      lim.maxDist = Math.max(lim.maxDist, v.dist * 1.5); lim.minDist = Math.min(lim.minDist, v.dist * 0.5);
      c.target = [...v.target] as Vec3; c.yaw = v.yaw; c.pitch = v.pitch; c.dist = v.dist;
      st.invalidate();
    },
    instances(key, geo, mat, data, casts) { st?.setInstances(key, geo, mat, data, undefined, casts); },
    move(m) { curMoves = m; if (mode === 'flat') drawFlat(); else st?.move(m); },
    studio: () => st,
    isFlat: () => mode === 'flat',
    rgb: (t) => colors.rgb(t),
    knobs: () => knobs(),
    setKnobs(k) { if (k.cut !== undefined) cutIn.value = String(k.cut); if (k.explode !== undefined) exIn.value = String(k.explode); applyKnobs(); },
    destroy() { dead = true; cancelAnimationFrame(tween); cancelAnimationFrame(hoverRaf); ro.disconnect(); frame.destroy(); unwatch(); unnames(); st?.destroy(); st = null; colors.destroy(); },
  };
}
