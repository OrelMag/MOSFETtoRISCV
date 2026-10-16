// The relay close-up's body (loaded on demand by widgets/relay3d.ts): a telephone relay drawn in 3D from boxes
// and cylinders, every moving part placed by the lumped model (phys/relay.ts) at the scrubbed time; beside it the
// model's current, travel, contact and coil voltage over 25 ms, and its summary. Without WebGL2 (or after a lost
// context) the same parts are drawn as a flat side view in SVG.

import '../styles/relay3d.css';
import { CssColors, mixRgb, scaleRgb, watchTheme } from '../gl/color';
import { packInstances, type Instance, type RGB } from '../gl/instances';
import { dot3, quatAxisAngle, quatRotate, sub3, type Vec3 } from '../gl/math';
import type { Renderer } from '../gl/renderer';
import { RELAY, relaySim, relayStatic, relaySummary, T_END, type RelayRun, type RelaySample } from '../phys/relay';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';

// ---------------------------------------------------------------- geometry (mm; x right, y up, z towards the viewer)

/** Gaps and travel drawn this many times their size (0.85 mm would not show). */
export const EXAG = 6;
const HINGE: Vec3 = [28, 25, 0]; // the armature turns about the yoke's top corner
const POLE_X = 0, LEVER = HINGE[0] - POLE_X; // hinge to the pole's centre
const ARM_X0 = -47, ARM_X1 = 5, ARM_T = 2.5, ARM_W = 12; // armature, along x from the hinge
const SPRING_LX = 3.5; // the return spring, from the hinge (behind it: pulls the armature open)
// The spring stack, along x: solder tails, pile face (the blades' root), contacts, blade tip under the stud; blade
// rest height.
const XTAIL = -46, XR = -34, XC = -25, XT = -16, YB = 16;
const STUD_LX = XT - HINGE[0]; // the lifting stud, from the hinge
const BT = 0.6, BUT = 0.9, BUT_R = 1.8; // blade thickness, contact button height and radius
const STACK = 2 * (BT / 2 + BUT); // blade centre to fixed spring centre with the buttons touching

/** Armature angle (rad, opening up) for armature travel u (m): the gap at the pole, drawn ×EXAG, over the lever. */
const theta = (u: number) => Math.atan(((RELAY.gOpen - u + RELAY.gRes) * 1e3 * EXAG) / LEVER);
/** A point given in the armature's frame (from the hinge, at angle 0), in the world. */
const armAt = (lx: number, ly: number, th: number): [number, number] =>
  [HINGE[0] + lx * Math.cos(th) + ly * Math.sin(th), HINGE[1] - lx * Math.sin(th) + ly * Math.cos(th)];
/** How far the stud has pushed the blade's tip down for armature travel u. */
const push = (u: number) => armAt(STUD_LX, 0, theta(0))[1] - armAt(STUD_LX, 0, theta(u))[1];
/** The contact sits part-way along the cantilever, so it moves that fraction of the tip. */
const AT_CONTACT = (XC - XR) / (XT - XR);
const YNC = YB + STACK, YNO = YB - STACK - push(RELAY.yc) * AT_CONTACT;
/** The NC contact opens once the blade has left it (the mockup's 0.03 mm). */
const ncClosed = (q: RelaySample) => q.y < 0.03e-3;

type Kind = 'box' | 'cyl';
interface Part extends Instance { kind: Kind; id?: string }

interface Palette {
  bakelite: RGB; steel: RGB; steel2: RGB; steel3: RGB; copper: RGB; glow: RGB; spring: RGB; blade: RGB;
  stud: RGB; silver: RGB; good: RGB;
}

const Z = quatAxisAngle([0, 0, 1], 0);
const ALONG_Z = quatAxisAngle([1, 0, 0], Math.PI / 2); // a cylinder's axis turned from y to z

const box = (c: RGB, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, spec = 0): Part =>
  ({ kind: 'box', pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], scale: [x1 - x0, y1 - y0, z1 - z0], color: c, spec });
const cyl = (c: RGB, x: number, z: number, y0: number, y1: number, r: number, spec = 0): Part =>
  ({ kind: 'cyl', pos: [x, (y0 + y1) / 2, z], scale: [2 * r, y1 - y0, 2 * r], color: c, spec });
/** A bar of thickness t and width w from (x0, y0) to (x1, y1) in the z = 0 plane. */
const bar = (c: RGB, x0: number, y0: number, x1: number, y1: number, t: number, w: number, spec = 0): Part => ({
  kind: 'box', pos: [(x0 + x1) / 2, (y0 + y1) / 2, 0], scale: [Math.hypot(x1 - x0, y1 - y0), t, w],
  rot: quatAxisAngle([0, 0, 1], Math.atan2(y1 - y0, x1 - x0)), color: c, spec,
});

/** Every part of the relay with the model at sample q. */
function relayParts(q: RelaySample, P: Palette): Part[] {
  const out: Part[] = [];
  const th = theta(q.x), rot = quatAxisAngle([0, 0, 1], -th);
  // Base, yoke (bottom leg under the coil, upright to the hinge), and the lug the return spring hangs on.
  out.push(box(P.bakelite, -50, 37, -4, 0, -13, 13));
  out.push(box(P.steel2, -10, 28, 0, 3, -7, 7, 0.25), box(P.steel2, 25, 28, 0, 25, -7, 7, 0.25), box(P.steel2, 28, 34, 10, 12, -3, 3, 0.25));
  // Core, pole face, bobbin, winding: warmer and faintly glowing with the current.
  const g = Math.min(1, Math.abs(q.i) / 0.06);
  out.push(cyl(P.steel, POLE_X, 0, 3, 23.5, 3.5, 0.3), cyl(P.steel3, POLE_X, 0, 23.5, 25, 4.5, 0.5));
  out.push(cyl(P.bakelite, POLE_X, 0, 3, 4.5, 10), cyl(P.bakelite, POLE_X, 0, 21.5, 23, 10));
  out.push({ ...cyl(mixRgb(P.copper, P.glow, 0.45 * g), POLE_X, 0, 4.5, 21.5, 9, 0.15), emissive: scaleRgb(P.glow, 0.22 * g), id: 'coil' });
  // Armature (turned about the hinge) and the hinge pin.
  const [ax, ay] = armAt((ARM_X0 + ARM_X1) / 2, ARM_T / 2, th);
  out.push({ kind: 'box', pos: [ax, ay, 0], scale: [ARM_X1 - ARM_X0, ARM_T, ARM_W], rot, color: P.steel3, spec: 0.45 });
  out.push({ ...cyl(P.steel2, HINGE[0], 0, -8, 8, 1.1, 0.4), pos: [HINGE[0], HINGE[1], 0], rot: ALONG_Z });
  // Return spring from the lug to the armature's tail, as turns of wire.
  const [sx, sy] = armAt(SPRING_LX, 0, th), y0 = 12, turns = 9;
  for (let k = 0; k < turns; k++) {
    const y = y0 + ((k + 0.5) / turns) * (sy - y0);
    out.push(cyl(P.spring, sx, 0, y - 0.25, y + 0.25, 1.5, 0.3));
  }
  out.push(cyl(P.spring, sx, 0, y0, sy, 0.35, 0.3));
  // The spring pile: bracket, spacers between the springs, clamp plate and screws.
  const pile = (c: RGB, ya: number, yb: number) => box(c, -42, XR, ya, yb, -5, 5);
  out.push(box(P.steel2, -42, XR, 0, 8, -6, 6, 0.2));
  out.push(pile(P.bakelite, 8, YNO - BT / 2), pile(P.bakelite, YNO + BT / 2, YB - BT / 2), pile(P.bakelite, YB + BT / 2, YNC - BT / 2), pile(P.steel2, YNC + BT / 2, YNC + 3));
  for (const z of [-3.2, 3.2]) out.push(cyl(P.steel, -38, z, 8, YNC + 3.6, 0.8, 0.3), cyl(P.steel, -38, z, YNC + 3, YNC + 4.2, 1.5, 0.4));
  // Fixed springs (NC above the blade, NO below), each with a contact button facing the blade's.
  const nc = ncClosed(q), no = q.closed;
  out.push(bar(P.spring, XTAIL, YNC, XC + 2.5, YNC, BT, 6, 0.3), bar(P.spring, XTAIL, YNO, XC + 2.5, YNO, BT, 6, 0.3));
  const btn = (closed: boolean, x: number, y0b: number) => ({ ...cyl(closed ? P.good : P.silver, x, 0, y0b, y0b + BUT, BUT_R, 0.5), emissive: closed ? scaleRgb(P.good, 0.3) : undefined });
  out.push(btn(nc, XC, YNC - BT / 2 - BUT), btn(no, XC, YNO + BT / 2));
  // The common blade: a cantilever from the pile whose tip the stud pushes down (armature travel x); its contact,
  // part-way along, follows the model's blade position y. Once the contact meets NO the stud keeps going: the bend
  // at the contact is the over-travel that presses the contacts together.
  const yc = YB - push(q.y) * AT_CONTACT, yt = YB - push(q.x);
  out.push(bar(P.blade, XTAIL, YB, XR, YB, BT, 6, 0.3), bar(P.blade, XR, YB, XC, yc, BT, 6, 0.3), bar(P.blade, XC, yc, XT, yt, BT, 6, 0.3));
  out.push(btn(nc, XC, yc + BT / 2), btn(no, XC, yc - BT / 2 - BUT));
  // The stud hangs from the armature onto the blade's tip.
  const [tx, ty] = armAt(STUD_LX, 0, th);
  out.push({ ...cyl(P.stud, tx, 0, yt + BT / 2, ty, 0.9, 0.2), id: 'stud' });
  return out;
}

/** A label: where it points, which side its text sits on, and the way the labelled face looks (dimmed when that
 *  face turns away from the camera: the label would otherwise float over whatever hides it). */
interface Anchor { text: string; p: Vec3; side: 'l' | 'r' | 't' | 'b'; n: Vec3; minor?: boolean }

function anchors(q: RelaySample): Anchor[] {
  const th = theta(q.x), [ax, ay] = armAt(-24, ARM_T, th), [tx, ty] = armAt(STUD_LX, 0, th), [sx] = armAt(SPRING_LX, 0, th);
  return [
    { text: 'coil', p: [POLE_X + 6.4, 9, 6.4], side: 'r', n: [0.7, 0, 0.7] },
    { text: 'pole face', p: [POLE_X + 3, 25, 3], side: 'r', n: [0, 0.5, 1], minor: true },
    { text: 'armature', p: [ax, ay, 0], side: 't', n: [0, 1, 0] },
    { text: 'hinge', p: [HINGE[0], HINGE[1], 8], side: 'r', n: [0, 0, 1], minor: true },
    { text: 'yoke', p: [16, 1.5, 7], side: 'b', n: [0, 0, 1] },
    { text: 'return spring', p: [sx, 11, 3], side: 'b', n: [1, 0, 0.3], minor: true },
    { text: 'stud', p: [tx + 0.9, ty - 5, 0], side: 'r', n: [-0.6, 0, 1], minor: true },
    { text: 'NC', p: [-29, YNC + BT / 2, 3], side: 't', n: [-0.5, 0, 1] },
    { text: 'NO', p: [-29, YNO - BT / 2, 3], side: 'b', n: [-0.5, 0, 1] },
    { text: 'common', p: [XT - 1, YB - push(q.x) - BT / 2, 3], side: 'b', n: [-0.5, 0, 1] },
  ];
}

// ---------------------------------------------------------------- the 2D fallback: the same parts, seen from the front

const F2 = { x0: -55, y0: -6, w: 96, h: 50 };

function partShape(p: Part): SVGElement {
  const [x, y] = p.pos, [w, hh] = p.scale ?? [1, 1, 1], r = p.rot ?? Z;
  const fill = `rgb(${p.color.map((c) => Math.round(c * 255)).join(' ')})`;
  const e = p.emissive;
  const glow = e && e.some((c) => c > 0.01) ? `rgb(${p.color.map((c, i) => Math.round(Math.min(1, c + e[i]) * 255)).join(' ')})` : fill;
  if (p.kind === 'cyl' && Math.abs(quatRotate(r, [0, 1, 0])[2]) > 0.9) return s('circle', { cx: x, cy: -y, r: w / 2, fill: glow, class: 'r3-edge' });
  const a = 2 * Math.atan2(r[2], r[3]), c = Math.cos(a), sn = Math.sin(a);
  const pts = [[-w / 2, -hh / 2], [w / 2, -hh / 2], [w / 2, hh / 2], [-w / 2, hh / 2]].map(([u, v]) => `${(x + u * c - v * sn).toFixed(2)},${(-(y + u * sn + v * c)).toFixed(2)}`);
  return s('polygon', { points: pts.join(' '), fill: glow, class: 'r3-edge' });
}

function drawFlat(svg: SVGSVGElement, parts: Part[], marks: Anchor[]): void {
  // Back to front by each part's front face.
  const order = parts.map((p, i) => ({ p, i, z: p.pos[2] + (p.scale?.[2] ?? 1) / 2 })).sort((a, b) => a.z - b.z || a.i - b.i);
  const g = s('g');
  for (const { p } of order) g.append(partShape(p));
  for (const m of marks) {
    if (m.minor) continue;
    const [x, y] = [m.p[0], -m.p[1]], dx = m.side === 'l' ? -2 : m.side === 'r' ? 2 : 0, dy = m.side === 't' ? -2 : m.side === 'b' ? 4 : 1;
    g.append(s('text', { x: x + dx, y: y + dy, class: 'r3-flat-lbl', 'text-anchor': m.side === 'l' ? 'end' : m.side === 'r' ? 'start' : 'middle' }, m.text));
  }
  svg.replaceChildren(g);
}

// ---------------------------------------------------------------- plots

const PW = 360, PH = 214, PX0 = 34, PX1 = 330;
const tX = (t: number) => PX0 + (t / T_END) * (PX1 - PX0);
const yI = (mA: number) => 92 - (mA / 70) * 80;
const yX = (mm: number) => 92 - (mm / 0.8) * 80;
const yV = (v: number) => 192 - ((v + 120) / 150) * 70;

function drawPlot(svg: SVGSVGElement, run: RelayRun): SVGLineElement {
  const els: SVGElement[] = [];
  const text = (x: number, y: number, t: string, cls = 'tick', anchor = 'end') => els.push(s('text', { x, y, class: cls, 'text-anchor': anchor }, t));
  for (const mA of [0, 20, 40, 60]) { els.push(s('line', { x1: PX0, x2: PX1, y1: yI(mA), y2: yI(mA), class: 'grid' })); text(PX0 - 4, yI(mA) + 3, String(mA)); }
  for (const mm of [0, 0.4, 0.8]) text(PX1 + 4, yX(mm) + 3, mm ? String(mm) : '0', 'tick tr', 'start');
  for (const v of [-100, -50, 0, 24]) { els.push(s('line', { x1: PX0, x2: PX1, y1: yV(v), y2: yV(v), class: 'grid' })); text(PX0 - 4, yV(v) + 3, String(v)); }
  for (let ms = 0; ms <= 25; ms += 5) text(tX(ms / 1e3), 208, `${ms}${ms === 25 ? ' ms' : ''}`, 'tick', 'middle');
  // NO contact closed: spans of the band.
  let start: number | null = null;
  const span = (t0: number, t1: number) => els.push(s('rect', { x: tX(t0), y: 98, width: Math.max(1, tX(t1) - tX(t0)), height: 10, class: 'band' }));
  for (const q of run.s) {
    if (q.closed && start === null) start = q.t;
    if (!q.closed && start !== null) { span(start, q.t); start = null; }
  }
  if (start !== null) span(start, T_END);
  els.push(s('rect', { x: PX0, y: 98, width: PX1 - PX0, height: 10, class: 'band-frame' }));
  const line = (f: (q: RelaySample) => number, cls: string) =>
    els.push(s('polyline', { points: run.s.map((q) => `${tX(q.t).toFixed(1)},${f(q).toFixed(1)}`).join(' '), class: cls }));
  line((q) => yI(q.i * 1e3), 'cur');
  line((q) => yX(q.x * 1e3), 'trav');
  line((q) => yV(Math.max(-120, q.vTerm)), 'volt');
  els.push(s('line', { x1: PX0, x2: PX0, y1: 10, y2: 194, class: 'ax' }));
  text(PX1, 7, 'coil current (mA) · armature travel (mm)', 'axl');
  text(PX1, 118, 'coil terminal (V)', 'axl');
  const cursor = s('line', { x1: 0, x2: 0, y1: 10, y2: 194, class: 'cursor' });
  els.push(cursor);
  svg.replaceChildren(...els);
  return cursor;
}

// ---------------------------------------------------------------- the widget

const fmt = (x: number, d = 1) => x.toFixed(d);
const STATIC = relayStatic();

export function relayView(): Widget {
  let run = relaySim(24), idx = 100; // 10 ms: closed and settled
  // 'wait' until the renderer chunk answers; 'flat' without WebGL2 or while the context is lost.
  let mode: 'wait' | 'gl' | 'flat' = 'wait';
  let playing = 0, renderer: Renderer | null = null, dead = false, pending = 0, cursor: SVGLineElement | null = null;

  // Controls
  const vIn = h('input', { type: 'range', min: 10, max: 30, step: 0.5, value: 24, 'aria-label': 'Supply voltage' }) as HTMLInputElement;
  const vOut = h('output', null, '24 V');
  const tIn = h('input', { type: 'range', min: 0, max: run.s.length - 1, step: 1, value: idx, 'aria-label': 'Time' }) as HTMLInputElement;
  const tOut = h('output', null, '');
  const playBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Play');
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset view');
  const ctl = h('div', { class: 'r3-ctl' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Supply'), vIn, vOut),
    h('label', { class: 'r3-sl' }, h('span', null, 'Time'), tIn, tOut),
    h('div', { class: 'r3-btns' }, playBtn, resetBtn));

  // Stage: the canvas (or the flat drawing), labels over it, status chips.
  const canvas = h('canvas', { class: 'r3-canvas', tabindex: 0, 'aria-label': 'A telephone relay in 3D: drag to orbit, wheel or pinch to zoom, arrow keys to turn' }) as HTMLCanvasElement;
  const flatSvg = s('svg', { class: 'r3-flat', viewBox: `${F2.x0} ${-F2.y0 - F2.h} ${F2.w} ${F2.h}`, role: 'img', 'aria-label': 'A telephone relay seen from the front: coil, yoke, armature and contact springs' }) as SVGSVGElement;
  flatSvg.style.display = 'none';
  const labels = h('div', { class: 'r3-labels', 'aria-hidden': 'true' });
  const state = h('span', { class: 'r3-chip' }), gap = h('span', { class: 'r3-chip' }), spike = h('span', { class: 'r3-chip bad' });
  const hint = h('div', { class: 'r3-hint' }, `Gaps and travel drawn ×${EXAG}. Drag to orbit, wheel or pinch to zoom, double-click to reset.`);
  const stage = h('div', { class: 'r3-stage' }, canvas, flatSvg, labels, h('div', { class: 'r3-chips' }, state, gap, spike));

  // Plots and summary
  const plot = s('svg', { class: 'r3-plot', viewBox: `0 0 ${PW} ${PH}`, role: 'img', 'aria-label': 'Coil current, armature travel, contact state and coil voltage over 25 ms' }) as SVGSVGElement;
  const legend = h('div', { class: 'r3-legend' },
    h('span', null, h('i', { class: 'cur' }), 'coil current'), h('span', null, h('i', { class: 'trav' }), 'armature travel'),
    h('span', null, h('i', { class: 'band' }), 'NO contact closed'), h('span', null, h('i', { class: 'volt' }), 'coil terminal voltage'));
  const kv = h('div', { class: 'r3-kv' });

  const el = h('div', { class: 'r3' },
    h('div', { class: 'r3-main' }, ctl, stage, hint),
    h('div', { class: 'r3-side' }, plot, legend, h('h4', null, 'This relay ', h('span', { class: 'r3-badge' }, 'model')), kv));

  const colors = new CssColors(el);
  let palette: Palette | null = null;
  const pal = (): Palette => {
    if (palette) return palette;
    const p: Palette = {
      bakelite: colors.rgb('--rl-bakelite'), steel: colors.rgb('--rl-steel'), steel2: colors.rgb('--rl-steel-2'), steel3: colors.rgb('--rl-steel-3'),
      copper: colors.rgb('--rl-copper'), glow: colors.rgb('--rl-glow'), spring: colors.rgb('--rl-spring'), blade: colors.rgb('--rl-blade'),
      stud: colors.rgb('--rl-stud'), silver: colors.rgb('--rl-silver'), good: colors.rgb('--rl-contact'),
    };
    // Kept only once the widget is in the page (before that nothing resolves).
    if (el.isConnected) palette = p;
    return p;
  };

  // Label overlays: one element per anchor, re-projected after every frame.
  const lblEls = anchors(run.s[0]).map((a) => labels.appendChild(h('span', { class: `r3-lbl ${a.side}${a.minor ? ' minor' : ''}` }, h('i'), h('b', null, a.text))));
  const placeLabels = () => {
    if (mode !== 'gl' || !renderer) return;
    const eye = renderer.camera.eye();
    anchors(run.s[idx]).forEach((a, k) => {
      const p = renderer!.project(a.p), e = lblEls[k];
      if (!p) { e.style.display = 'none'; return; }
      e.style.display = '';
      e.classList.toggle('away', dot3(a.n, sub3(eye, a.p)) < 0);
      e.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
    });
  };

  const summary = () => {
    const r = relaySummary(run), V = run.V, ms = (t: number | null, d = 2) => (t === null ? '—' : `${fmt(t * 1e3, d)} ms`);
    const rows: [string, string, string?][] = [
      ['Coil', `${V} V, ${RELAY.Rc} Ω, ${RELAY.N.toLocaleString('en-US').replace(/,/g, ' ')} turns`],
      ['Coil power', `${fmt(r.power, 2)} W`],
      ['Pull-in voltage', STATIC.pull === null ? '—' : `${fmt(STATIC.pull)} V`],
      ['Drop-out voltage', STATIC.drop === null ? '—' : `${fmt(STATIC.drop)} V`],
      ['First touch', r.firstTouch === null ? 'never' : ms(r.firstTouch), r.firstTouch === null ? 'bad' : ''],
      ['Bounces', r.firstTouch === null ? '—' : String(r.bounces)],
      ['Settled', ms(r.settled), r.settled === null ? '' : 'good'],
      ['Release', ms(r.release)],
      ['Turn-off spike', `${Math.round(r.spike)} V`, 'bad'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, c]) => [h('span', null, k), h('span', { class: `v ${c ?? ''}` }, v)]));
  };

  const draw = () => {
    const q = run.s[idx];
    tOut.textContent = `${fmt(q.t * 1e3)} ms`;
    state.textContent = q.closed ? 'NO closed' : ncClosed(q) ? 'NC closed' : 'in flight';
    state.className = `r3-chip ${q.closed ? 'good' : ncClosed(q) ? '' : 'warn'}`;
    gap.textContent = `gap ${fmt((RELAY.gOpen - q.x) * 1e3, 2)} mm`;
    spike.textContent = q.vTerm < -40 ? `coil ${Math.round(q.vTerm)} V` : '';
    spike.style.display = q.vTerm < -40 ? '' : 'none';
    if (cursor) { const x = String(tX(q.t)); cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); }
    if (mode === 'wait') return;
    const parts = relayParts(q, pal());
    if (mode === 'gl' && renderer) {
      renderer.updateBatch(0, packInstances(parts.filter((p) => p.kind === 'box')));
      renderer.updateBatch(1, packInstances(parts.filter((p) => p.kind === 'cyl')));
    } else if (mode === 'flat') drawFlat(flatSvg, parts, anchors(q));
  };

  const rerun = () => {
    pending = 0;
    run = relaySim(Number(vIn.value));
    vOut.textContent = `${vIn.value} V`;
    cursor = drawPlot(plot, run);
    summary();
    draw();
  };

  const setIdx = (i: number) => { idx = Math.max(0, Math.min(run.s.length - 1, Math.round(i))); tIn.value = String(idx); draw(); };
  const stop = () => { cancelAnimationFrame(playing); playing = 0; playBtn.textContent = 'Play'; };
  const play = () => {
    if (playing) { stop(); return; }
    if (idx >= run.s.length - 1) setIdx(0);
    // Reduced motion: no animation, straight to the end (the time slider still scrubs).
    if (reducedMotion()) { setIdx(run.s.length - 1); return; }
    playBtn.textContent = 'Pause';
    const t0 = performance.now(), from = run.s[idx].t;
    const tick = (now: number) => {
      const t = from + (now - t0) / 1000 / 400; // 1/400 speed: 25 ms of relay in 10 s
      setIdx((t / T_END) * (run.s.length - 1));
      playing = idx < run.s.length - 1 ? requestAnimationFrame(tick) : 0;
      if (!playing) playBtn.textContent = 'Play';
    };
    playing = requestAnimationFrame(tick);
  };

  vIn.addEventListener('input', () => { vOut.textContent = `${vIn.value} V`; if (!pending) pending = requestAnimationFrame(rerun); });
  tIn.addEventListener('input', () => { stop(); setIdx(Number(tIn.value)); });
  playBtn.addEventListener('click', play);
  resetBtn.addEventListener('click', () => { renderer?.camera.reset(); renderer?.invalidate(); });
  // Scrub by pointing at the plot.
  const scrub = (e: PointerEvent) => {
    const r = plot.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * PW;
    stop();
    setIdx(((x - PX0) / (PX1 - PX0)) * (run.s.length - 1));
  };
  plot.addEventListener('pointerdown', (e) => { plot.setPointerCapture(e.pointerId); scrub(e); });
  plot.addEventListener('pointermove', (e) => { if (plot.hasPointerCapture(e.pointerId)) scrub(e); });

  const setMode = (m: 'gl' | 'flat') => {
    const on = m === 'flat';
    mode = m;
    canvas.style.display = on ? 'none' : '';
    flatSvg.style.display = on ? '' : 'none';
    labels.style.display = on ? 'none' : '';
    hint.textContent = on ? `Gaps and travel drawn ×${EXAG}. A flat view: this browser has no WebGL2 for the 3D one.` : `Gaps and travel drawn ×${EXAG}. Drag to orbit, wheel or pinch to zoom, double-click to reset.`;
    resetBtn.style.display = on ? 'none' : '';
    draw();
  };

  const unwatch = watchTheme(() => {
    colors.invalidate(); palette = null;
    applyLights();
    cursor = drawPlot(plot, run);
    draw();
  });
  const applyLights = () => renderer?.setLights({ sky: colors.rgb('--rl-sky'), ground: colors.rgb('--rl-ground'), key: colors.rgb('--rl-key') });

  rerun();
  void import('../gl/renderer').then(({ createRenderer, OrbitCamera, boxMesh, cylinderMesh }) => {
    if (dead) return;
    const cam = new OrbitCamera({ target: [-10, 13, 0], yaw: -0.42, pitch: 0.34, dist: 118 }, { minDist: 40, maxDist: 400 });
    try {
      renderer = createRenderer(canvas, cam, {
        onRender: placeLabels,
        onLost: () => setMode('flat'),
        onRestored: () => setMode('gl'),
      });
    } catch { renderer = null; }
    if (!renderer) { setMode('flat'); return; }
    renderer.setScene([{ mesh: boxMesh(), data: new Float32Array(0) }, { mesh: cylinderMesh(40), data: new Float32Array(0) }]);
    applyLights();
    setMode('gl');
  }).catch(() => { if (!dead) setMode('flat'); });

  return {
    el,
    destroy() {
      dead = true;
      stop();
      cancelAnimationFrame(pending);
      unwatch();
      renderer?.destroy();
      renderer = null;
      colors.destroy();
    },
  };
}

