// The puzzle devices' faces (devparts.ts): the world drawn on the part, live. The crossing's lamps and WALK sign follow
// the pins as the circuit drives them now; the button, the maze's robot and the vending machine's credit follow the
// world (it moves at each step). A fault stops the world and the face says where. Drawn in the part's own grid units on
// the canvas (view.ts, look inside), and at any size in a standalone SVG for the puzzle strip (deviceFaceSvg). Redrawn
// only when what it shows changed.

import '../styles/devices.css';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import type { ComponentDef } from '../sim/types';
import { s } from '../ui/dom';
import { CHANGE_CENTS, COIN_CENTS, type CrossingWorld, DEVICES, type DeviceId, DIRS, mazeCell, mazeSize, type MazeWorld, type VendWorld } from '../puzzles/devices';
import { DEVICE_BOX, deviceOf, type DeviceState } from './devparts';
import type { IoFace } from './ioface';

type Box = { x: number; y: number; w: number; h: number };

/** Packed value of a leaf input (−1: an X or Z bit). */
function packed(sim: Sim, nets: readonly number[]): number {
  let v = 0;
  for (let i = nets.length - 1; i >= 0; i--) {
    const b = sim.get(nets[i]);
    if (b !== 0 && b !== 1) return -1;
    v = v * 2 + b;
  }
  return v;
}

/** What a face shows: the leaf's state and the drive pins now (null: not simulated). */
export interface FaceInput { st: DeviceState | null; drive: number[] | null }

export function faceInput(sim: Sim | null, node: HierNode | null): FaceInput {
  const li = node?.leafIndex;
  if (!sim || li === undefined) return { st: null, drive: null };
  const leaf = sim.design.leaves[li];
  const st = sim.leafState(li) as DeviceState | undefined;
  if (!st || !st.dev) return { st: null, drive: null };
  return { st, drive: DEVICES[st.dev].drive.map((_, i) => packed(sim, leaf.inputs[i])) };
}

/** A face drawn into `g` over `box`: paint(input) redraws it. */
interface Painter { g: SVGGElement; paint(f: FaceInput): void }

function painter(dev: DeviceId, box: Box): Painter {
  const g = s('g', { class: `dev-face dev-${dev}` });
  g.append(s('rect', { class: 'dev-panel', x: box.x, y: box.y, width: box.w, height: box.h, rx: 0.5 }));
  const body = s('g');
  const foot = s('text', { class: 'dev-foot', x: box.x + box.w / 2, y: box.y + box.h - 0.45, 'text-anchor': 'middle' });
  g.append(body, foot);
  const draw = dev === 'crossing' ? crossingFace(body, box) : dev === 'maze' ? mazeFace(body, box) : vendFace(body, box);
  let shown = '';
  return {
    g,
    paint(f) {
      const key = JSON.stringify([f.st?.test, f.st?.n, f.st?.fault, f.drive]);
      if (key === shown) return;
      shown = key;
      draw(f);
      const st = f.st;
      g.classList.toggle('fault', !!st?.fault);
      foot.textContent = !st ? 'not running' : st.fault ? `✗ step ${st.n - 1}` : DEVICES[dev].done(st.w) ? `✓ done · step ${st.n}` : `step ${st.n}`;
    },
  };
}

// ---- the crossing: three lamps, the WALK / WAIT sign, the button ----------------------------------------------------

function crossingFace(g: SVGGElement, b: Box): (f: FaceInput) => void {
  const cx = b.x + 2.4;
  g.append(s('rect', { class: 'dev-housing', x: b.x + 1, y: b.y + 0.6, width: 2.8, height: 7.3, rx: 0.5 }));
  const lamps = ['r', 'y', 'g'].map((k, i) => {
    const c = s('circle', { class: `dev-lamp lamp-${k}`, cx, cy: b.y + 1.9 + 2.35 * i, r: 0.95 });
    g.append(c);
    return c;
  });
  g.append(s('rect', { class: 'dev-housing', x: b.x + 4.8, y: b.y + 0.6, width: 4.6, height: 3.6, rx: 0.4 }));
  const walk = s('text', { class: 'dev-sign walk', x: b.x + 7.1, y: b.y + 2, 'text-anchor': 'middle' }, 'WALK');
  const wait = s('text', { class: 'dev-sign wait', x: b.x + 7.1, y: b.y + 3.6, 'text-anchor': 'middle' }, 'WAIT');
  const btn = s('circle', { class: 'dev-button', cx: b.x + 7.1, cy: b.y + 6.1, r: 1.05 });
  g.append(walk, wait, btn, s('text', { class: 'dev-small', x: b.x + 7.1, y: b.y + 8, 'text-anchor': 'middle' }, 'button'));
  return ({ st, drive }) => {
    const w = st?.w as CrossingWorld | undefined;
    lamps.forEach((l, i) => l.classList.toggle('on', drive?.[i] === 1));
    walk.classList.toggle('on', drive?.[3] === 1);
    wait.classList.toggle('on', !!drive && drive[3] === 0);
    btn.classList.toggle('on', !!w?.req);
  };
}

// ---- the maze: walls, the trail, the robot ----------------------------------------------------------------------------

function mazeFace(g: SVGGElement, b: Box): (f: FaceInput) => void {
  let drawnFor: string[] | null = null;
  const walls = s('g', { class: 'dev-walls' }), trail = s('g'), bot = s('g', { class: 'dev-bot' }), goal = s('g');
  bot.append(s('circle', { r: 0.62 }), s('path', { class: 'dev-nose', d: 'M0 -0.62 L0.3 -0.12 L-0.3 -0.12 Z' }));
  g.append(walls, goal, trail, bot);
  let cell = 2, ox = 0, oy = 0;
  const at = (r: number, c: number) => [ox + (c + 0.5) * cell, oy + (r + 0.5) * cell];
  return ({ st }) => {
    const w = st?.w as MazeWorld | undefined;
    if (!w) { bot.setAttribute('visibility', 'hidden'); return; }
    if (drawnFor !== w.maze) {
      drawnFor = w.maze;
      const { rows, cols } = mazeSize(w.maze);
      cell = Math.min((b.w - 1) / cols, (b.h - 2) / rows);
      ox = b.x + (b.w - cell * cols) / 2;
      oy = b.y + 0.5;
      walls.replaceChildren(s('rect', { class: 'dev-floor', x: ox, y: oy, width: cell * cols, height: cell * rows }));
      for (let r = 0; r <= 2 * rows; r++) for (let c = 0; c <= 2 * cols; c++) {
        if (w.maze[r][c] !== '#') continue;
        if (r % 2 === 0 && c % 2 === 1) walls.append(s('line', { x1: ox + ((c - 1) / 2) * cell, x2: ox + ((c + 1) / 2) * cell, y1: oy + (r / 2) * cell, y2: oy + (r / 2) * cell }));
        if (r % 2 === 1 && c % 2 === 0) walls.append(s('line', { x1: ox + (c / 2) * cell, x2: ox + (c / 2) * cell, y1: oy + ((r - 1) / 2) * cell, y2: oy + ((r + 1) / 2) * cell }));
      }
      goal.replaceChildren();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (mazeCell(w.maze, r, c) === 'G') {
        const [x, y] = at(r, c);
        goal.append(s('rect', { class: 'dev-goal', x: x - cell * 0.36, y: y - cell * 0.36, width: cell * 0.72, height: cell * 0.72, rx: 0.2 }));
      }
    }
    trail.replaceChildren(...w.trail.slice(0, -1).map((k) => {
      const [x, y] = at(k >> 6, (k >> 2) & 15);
      return s('circle', { class: 'dev-trail', cx: x, cy: y, r: cell * 0.09 });
    }));
    const [x, y] = at(w.r, w.c);
    bot.setAttribute('visibility', 'visible');
    // a CSS transform, so it can glide (devices.css)
    bot.style.transform = `translate(${x}px, ${y}px) rotate(${w.d * 90}deg) scale(${cell / 2})`;
    // the walls it senses now, as short red marks around it
    bot.querySelectorAll('.dev-sense').forEach((e) => e.remove());
    for (const [i, rot] of [[0, 0], [3, -90], [1, 90]] as const) {
      const d = (w.d + i) % 4;
      const blocked = w.maze[2 * w.r + 1 + DIRS[d][0]][2 * w.c + 1 + DIRS[d][1]] === '#';
      if (blocked) bot.append(s('line', { class: 'dev-sense', x1: 0, y1: -0.72, x2: 0, y2: -0.95, transform: `rotate(${rot})` }));
    }
  };
}

// ---- the vending machine: the coin coming, the credit, items dropped, change out ---------------------------------------

function vendFace(g: SVGGElement, b: Box): (f: FaceInput) => void {
  g.append(s('rect', { class: 'dev-housing', x: b.x + 0.8, y: b.y + 0.6, width: b.w - 1.6, height: 2.4, rx: 0.3 }));
  const credit = s('text', { class: 'dev-lcd', x: b.x + b.w / 2, y: b.y + 2.25, 'text-anchor': 'middle' });
  const coin = s('text', { class: 'dev-small', x: b.x + 1, y: b.y + 4.4 });
  const press = s('text', { class: 'dev-small', x: b.x + b.w - 1, y: b.y + 4.4, 'text-anchor': 'end' });
  const tray = s('rect', { class: 'dev-housing', x: b.x + 0.8, y: b.y + 5, width: 4.6, height: 2.2, rx: 0.3 });
  const items = s('text', { class: 'dev-small', x: b.x + 3.1, y: b.y + 6.5, 'text-anchor': 'middle' });
  const chg = s('text', { class: 'dev-small', x: b.x + b.w - 1, y: b.y + 6.5, 'text-anchor': 'end' });
  g.append(credit, coin, press, tray, items, chg);
  return ({ st, drive }) => {
    const w = st?.w as VendWorld | undefined;
    const sense = w && st ? DEVICES.vend.sensors(w) : [0, 0, 0];
    credit.textContent = w ? `${w.credit}¢` : '—';
    coin.textContent = sense[0] ? `coin ${COIN_CENTS[sense[0]]}¢` : '';
    press.textContent = sense[1] ? 'buy' : sense[2] ? 'refund' : '';
    items.textContent = w ? `${w.items} item${w.items === 1 ? '' : 's'}` : '';
    chg.textContent = drive && drive[1] > 0 && drive[1] < 3 ? `↓ ${CHANGE_CENTS[drive[1]]}¢` : w?.returned ? `${w.returned}¢ back` : '';
    tray.classList.toggle('on', drive?.[0] === 1);
  };
}

// ---- on the canvas, and standalone -----------------------------------------------------------------------------------

/** The face of a device part on the canvas (null for any other part): an IoFace, so the view paints it like a console. */
export function drawDeviceFace(def: ComponentDef, flip: boolean): IoFace | null {
  const k = deviceOf(def);
  if (!k) return null;
  const B = DEVICE_BOX[k.dev];
  const box = { ...B.face, x: flip ? B.w - B.face.x - B.face.w : B.face.x };
  const p = painter(k.dev, box);
  return { g: p.g, paint: (sim, node) => p.paint(faceInput(sim, node)) };
}

/** The face alone, as an SVG of its own (the puzzle strip's large copy). */
export function deviceFaceSvg(dev: DeviceId): { svg: SVGSVGElement; paint: (f: FaceInput) => void } {
  const B = DEVICE_BOX[dev].face;
  const svg = s('svg', { class: 'dev-big', viewBox: `0 0 ${B.w} ${B.h}`, role: 'img', 'aria-label': `${DEVICES[dev].title}: the world now` }) as SVGSVGElement;
  const p = painter(dev, { x: 0, y: 0, w: B.w, h: B.h });
  svg.append(p.g);
  return { svg, paint: p.paint };
}
