// The crossbar switch in 3D on the studio renderer (loaded on demand, modelhost.ts): the machine behind the chapter's relay
// crossbar (crossbar3dkit.ts). The state machine is phys/crossbar.ts, driven by a marker that serves one request at a time;
// this plays its frames slowed and draws the bars, fingers and springs where motionAt puts them. The learner picks a vertical
// (the caller) and a level (the called line), calls, and hangs up. It opens with one call held.

import '../styles/crossbar3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import type { Model3 } from '../gl/kit/scene';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import {
  BARS, LEVELS, PAIRS, SELECT_MS, HOLD_MS, RELEASE_MS, VERTICALS, apply, closedList, fresh, framesOf, markerCall, markerHang, motionAt, run, stateAt, type Frame, type Op, type Xb,
} from '../phys/crossbar';
import { CL, CV, MATS, OUTLINE, SPRING_GEO, XB_HOME, springData, xbModel } from './crossbar3dkit';

/** Shown this many times slower than the model's (illustrative) times, so a bar's tilt takes most of a second. */
export const SLOW = 25;
/** The chapter's relay crossbar: 3 × 3 crosspoints on 21 relays (lib/telegraph.ts CROSSBAR3). */
const CHAPTER_RELAYS = 21, CHAPTER_POINTS = 9;

const BASE = run(fresh(), markerCall(fresh(), 2, 7).ops);
const S2 = run(BASE, [{ kind: 'select', l: CL }]), S3 = run(S2, [{ kind: 'hold', v: CV }]), S4 = run(S3, [{ kind: 'unselect' }]);
const S5 = run(S4, markerCall(S4, 13, 2).ops);
/** Each beat's starting state and what it plays. */
const SCRIPT: [Xb, Op[]][] = [
  [BASE, []], [BASE, [{ kind: 'select', l: CL }]], [S2, [{ kind: 'hold', v: CV }]], [S3, [{ kind: 'unselect' }]],
  [S4, markerCall(S4, 13, 2).ops], [S5, [{ kind: 'select', l: 1 }]], [S5, markerHang(CV)],
];

export function crossbarView(): Widget {
  let frames: Frame[] = [{ t: 0, x: BASE }], tm = 0, playing = false, ready = false, shownKey = '', msg = '';
  let pickV = CV, pickL = CL;
  const end = () => frames[frames.length - 1].t;
  const now = (): Xb => stateAt(frames, tm);

  const panel = h('div', { class: 'panel xb3' });
  const stage = studioStage({
    aria: 'A Bell System Type B crossbar switch in 3D: five select bars across the front with flexible fingers, twenty vertical units of contact springs, each with a holding bar and a hold magnet at its foot',
    home: XB_HOME,
    aspect: 1.45,
    // the switch fitted as a sphere round its middle: it fills the column
    homeRadius: 185,
    homeRadiusNarrow: 260, // a phone: every badge's dot inside the frame and clear of the scale bar
    scaleBar: (len) => (len >= 10 ? `${len / 10} cm` : `${len} mm`),
    limits: { minDist: 40, maxDist: 2400, maxPan: 600 },
    onBeat: (i) => beat(i),
    build: (detail) => model(detail),
    note: `A Bell System Type B crossbar switch, 200 points, three wires a crosspoint. The counts and the order of operations are the sources' (the Survey of Telephone Switching's No. 1 Crossbar chapter; Wikipedia's "Crossbar switch"): ${LEVELS} levels and ${VERTICALS} verticals, ${BARS} select bars of two select magnets each, a hold magnet per vertical, ${PAIRS} contact pairs a crosspoint, one select at a time. No dimensioned drawing was found: the outline (${OUTLINE.l} × ${OUTLINE.h} × ${OUTLINE.d} mm) is a 200-point unit's size from a sale listing, and every part's size inside it is the model's. The magnets' times (${SELECT_MS}, ${HOLD_MS} and ${RELEASE_MS} ms) are illustrative, shown ${SLOW} times slower. Left out: the off-normal springs, the multiple wiring behind the levels.`,
  });

  function model(detail: 'full' | 'flat'): Model3 {
    if (!ready || !panel.isConnected) return { items: [] };
    const m = motionAt(frames, tm), mod = xbModel(m, detail);
    if (detail === 'full') stage.instances('xb:springs', SPRING_GEO, MATS.spring, springData(m), true);
    return mod;
  }
  function paint(): void {
    const m = motionAt(frames, tm), key = [...m.tilt, ...m.hold].map((v) => v.toFixed(3)).join() + m.trapped.join();
    if (key !== shownKey) { shownKey = key; stage.refresh(); }
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), note = h('p', { class: 'r3-hint xb-note', 'aria-live': 'polite' });
  stage.chips.append(chip);
  function readout(): void {
    const x = now(), calls = closedList(x), sel = x.select, holds = x.hold.filter(Boolean).length;
    chip.textContent = playing ? 'Setting up' : sel !== null ? `Select magnet up: level ${sel}` : `${calls.length} call${calls.length === 1 ? '' : 's'} held`;
    chip.className = `r3-chip ${calls.length ? 'good' : ''}`;
    const rows: [string, string][] = [
      ['Calls held', calls.length ? calls.map(([l, v]) => `vertical ${v} → level ${l}`).join(', ') : 'none'],
      ['Magnets energized', `${holds} hold${sel !== null ? ', 1 select' : ''} of ${2 * BARS + VERTICALS}`],
      ['This switch', `${LEVELS * VERTICALS} crosspoints on ${2 * BARS + VERTICALS} magnets`],
      ['The chapter\'s relay grid', `${CHAPTER_POINTS} crosspoints on ${CHAPTER_RELAYS} relays`],
      ['Shown at', `1/${SLOW} speed (times illustrative)`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    note.textContent = msg;
  }

  const loop = frameLoop((_now, dt) => {
    if (playing) { tm = Math.min(end(), tm + (dt * 1000) / SLOW); if (tm >= end()) { playing = false; readout(); } }
    paint();
  }, () => playing);
  function play(from: Xb, ops: readonly Op[]): void {
    frames = framesOf(from, ops); tm = 0; playing = frames.length > 1;
    if (reducedMotion()) { tm = end(); playing = false; }
    readout(); paint(); loop.kick();
  }
  function beat(i: number): void {
    if (i < 0) return;
    const [from, ops] = SCRIPT[i];
    msg = i === 5 ? `A second select now would be refused: ${apply(run(S5, [{ kind: 'select', l: 1 }]), { kind: 'select', l: 8 }).refused}.` : '';
    play(from, ops);
  }
  function callNow(): void {
    // a call starts from where the last one ended: a select still up from the tour is let go first
    let x = stateAt(frames, end());
    const pre: Op[] = x.select !== null ? [{ kind: 'unselect' }] : [];
    x = run(x, pre);
    const m = markerCall(x, pickV, pickL);
    msg = m.refused ? `Refused: ${m.refused}${m.refused.includes('busy') ? ' (the caller hears the busy tone)' : ''}.` : '';
    play(stateAt(frames, end()), [...pre, ...m.ops]);
  }
  function hangNow(): void {
    const x = stateAt(frames, end());
    msg = x.hold[pickV] ? '' : `Vertical ${pickV} holds no call.`;
    play(x, [...(x.select !== null ? [{ kind: 'unselect' } as Op] : []), ...markerHang(pickV)]);
  }

  const sel = (label: string, n: number, v: number, on: (k: number) => void) => {
    const s = h('select', { 'aria-label': label }, ...Array.from({ length: n }, (_, k) => h('option', { value: String(k), selected: k === v }, String(k)))) as HTMLSelectElement;
    s.addEventListener('change', () => on(Number(s.value)));
    return s;
  };
  const callBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Call') as HTMLButtonElement;
  callBtn.addEventListener('click', callNow);
  const hangBtn = h('button', { type: 'button', class: 'btn sm' }, 'Hang up') as HTMLButtonElement;
  hangBtn.addEventListener('click', hangNow);
  const clearBtn = h('button', { type: 'button', class: 'btn sm' }, 'Clear all') as HTMLButtonElement;
  clearBtn.addEventListener('click', () => { msg = ''; const x = stateAt(frames, end()); play(x, [...(x.select !== null ? [{ kind: 'unselect' } as Op] : []), ...x.hold.flatMap((on, v) => (on ? markerHang(v) : []))]); });
  stage.slot.append(h('div', { class: 'r3-ctl' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Caller (vertical)'), sel('Caller: vertical', VERTICALS, pickV, (k) => { pickV = k; })),
    h('label', { class: 'r3-sl' }, h('span', null, 'Called line (level)'), sel('Called line: level', LEVELS, pickL, (k) => { pickL = k; })),
    h('div', { class: 'r3-btns' }, callBtn, hangBtn, clearBtn)));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The crossbar itself'),
    h('p', { class: 'm3-sub' }, `A Bell System Type B switch: ${LEVELS * VERTICALS} crosspoints, each a set of ${PAIRS} contact pairs, on ${2 * BARS + VERTICALS} magnets. Pick a caller (a vertical) and a called line (a level) and call: the marker raises a select magnet, then the vertical's hold magnet, then lets the select go. A called line already in use is refused.`),
    stage.el, note,
    h('div', { class: 'xb-below' }, h('h4', null, 'This switch ', h('span', { class: 'r3-badge' }, 'model')), kv));
  ready = true;
  readout();
  requestAnimationFrame(function onPage() { if (panel.isConnected) { shownKey = ''; paint(); } else if (ready) requestAnimationFrame(onPage); });
  return { el: panel, destroy() { ready = false; loop.stop(); stage.destroy(); } };
}

