// The machine hall's body (loaded on demand by widgets/hall.ts): a CPU built from relays on 2 m racks or from tubes in
// ENIAC panels, at physical scale, coloured by block (lib/hall.ts lays it out), with a person for scale and the same
// CPU in CMOS at its true size on a table. Every relay or tube on the racks is drawn, up to the real count, and while
// the program runs each one follows a NAND output of its block in the gate-level simulation (DualSim on the cycle
// engine): a relay's armature lights while its coil is energized (output 1), a tube glows brighter while its triode
// conducts (output 0). A click on a rack names its block and links to its schematic. Without WebGL2 (or after a
// lost context) the same layout is drawn as a flat isometric picture.

import '../styles/relay3d.css';
import '../styles/hall.css';
import { CssColors, mixRgb, scaleRgb, watchTheme } from '../gl/color';
import { INSTANCE_FLOATS, writeInstance, type Instance, type RGB } from '../gl/instances';
import { cross3, norm3, sub3, type Vec3 } from '../gl/math';
import type { Renderer } from '../gl/renderer';
import { hallCpu, hallFacts, nandOutputsByBlock, hallLayout, periodIn, cabinetCounts, type Hall, type HallDesign, type HallTech } from '../lib/hall';
import { resolveComponent } from '../lib/resolve';
import { fmtArea, fmtMass, fmtRate, fmtTime, fmtWatts } from '../lib/tech';
import { clockCycle } from '../riscv/cosim';
import { DualSim } from '../sim/dualsim';
import { flatten, type FlatDesign } from '../sim/flatten';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';

const num = (n: number) => Math.round(n).toLocaleString('en-US');
/** A clock rate, as Hz below 1 Hz too (not mHz). */
const hz = (period: number) => (period > 1 ? `${(1 / period).toFixed(2)} Hz` : fmtRate(period));

// ---------------------------------------------------------------- where every device sits

/** Relays on a rack's front: a grid of columns × rows inside a margin; tubes on an ENIAC panel's shelves. */
const RELAY_COLS = 20;
const TUBE_SHELVES = 11, TUBE_ACROSS = 10, TUBE_DEEP = 4;
const PERSON = 1.75;
const TABLE_H = 0.9;

interface Box { pos: Vec3; scale: Vec3 }
/** A device's place: where its instance goes. */
type Slot = Box;

function relaySlots(x: number, z: number, n: number, sp: Hall['spec']): Slot[] {
  const rows = Math.ceil(sp.per / RELAY_COLS), mx = 0.04, my = 0.07;
  const cw = (sp.w - 2 * mx) / RELAY_COLS, ch = (sp.h - 2 * my) / rows, front = z + sp.d;
  const out: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / RELAY_COLS), c = i % RELAY_COLS;
    out.push({ pos: [x + mx + (c + 0.5) * cw, sp.h - my - (r + 0.5) * ch, front + 0.006 + 0.0175], scale: [cw * 0.78, ch * 0.8, 0.035] });
  }
  return out;
}

const shelfY = (s: number, sp: Hall['spec']) => 0.1 + s * ((sp.h - 0.16) / TUBE_SHELVES);

function tubeSlots(x: number, z: number, n: number, sp: Hall['spec']): Slot[] {
  // Front row of every shelf first (top shelf down), then the rows behind: the front looks full.
  const cw = (sp.w - 0.04) / TUBE_ACROSS, dw = (sp.d - 0.06) / TUBE_DEEP, out: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const per = TUBE_SHELVES * TUBE_ACROSS, r = Math.floor(i / per), k = i % per;
    const s = TUBE_SHELVES - 1 - Math.floor(k / TUBE_ACROSS), c = k % TUBE_ACROSS;
    out.push({ pos: [x + 0.02 + (c + 0.5) * cw, shelfY(s, sp) + 0.015 + 0.0375, z + sp.d - 0.03 - (r + 0.5) * dw], scale: [0.03, 0.075, 0.03] });
  }
  return out;
}

// ---------------------------------------------------------------- palette

interface Palette {
  hues: RGB[]; floor: RGB; face: RGB; chassis: RGB; relay: RGB; on: RGB; glass: RGB; glow: RGB; person: RGB; table: RGB; die: RGB; ring: RGB;
}

// ---------------------------------------------------------------- the live simulation

interface Live {
  design: FlatDesign;
  sim: DualSim;
  /** NAND output nets per top-level instance, in flattening order. */
  groups: Map<string, number[]>;
  cycles: number;
  halted: boolean;
  /** The halt output (cpu4) or the PC (a self-loop halts the RV32I programs). */
  halt: number[] | null;
  pc: number[] | null;
}

function buildLive(design: HallDesign): Live {
  const d = flatten(hallCpu(design).def);
  const groups = nandOutputsByBlock(d);
  const sim = new DualSim(d);
  for (const p of hallCpu(design).def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
  sim.reset('zero');
  sim.settle();
  sim.preferFast = true;
  return { design: d, sim, groups, cycles: 0, halted: false, halt: d.root.ports.halt ?? null, pc: d.root.ports.pcOut ?? null };
}

// ---------------------------------------------------------------- sound: a relay's click

class Clicker {
  private ctx: AudioContext | null = null;
  private buf: AudioBuffer | null = null;
  start(): void {
    if (!this.ctx) {
      const AC = typeof AudioContext === 'function' ? AudioContext : null;
      if (!AC) return;
      this.ctx = new AC();
      // 6 ms of noise, falling off fast: the armature hitting its stop.
      const n = Math.round(this.ctx.sampleRate * 0.006), b = this.ctx.createBuffer(1, n, this.ctx.sampleRate), ch = b.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n / 5));
      this.buf = b;
    }
    void this.ctx.resume();
  }
  /** A batch of contact changes: a few clicks spread over a few tens of ms, louder for more. */
  batch(changes: number): void {
    const c = this.ctx, b = this.buf;
    if (!c || !b || !changes || c.state !== 'running') return;
    const k = Math.min(6, 1 + Math.floor(Math.log2(changes)));
    for (let i = 0; i < k; i++) {
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = b;
      f.type = 'bandpass'; f.frequency.value = 2200 + Math.random() * 1800; f.Q.value = 1.4;
      g.gain.value = 0.35 / Math.sqrt(k);
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(c.currentTime + 0.005 + Math.random() * 0.05);
    }
  }
  stop(): void { void this.ctx?.suspend(); }
  destroy(): void { void this.ctx?.close(); this.ctx = null; }
}

// ---------------------------------------------------------------- the widget

type Speed = 'real' | 'slow' | 'max';

export function hallView(): Widget {
  let design: HallDesign = 'rv32i', tech: HallTech = 'relay', speed: Speed = 'real';
  let hall = hallLayout(hallCpu(design).def, tech);
  let mode: 'wait' | 'gl' | 'flat' = 'wait';
  let renderer: Renderer | null = null, dead = false, selected = -1;
  let live: Live | null = null, liveFor: HallDesign | null = null, liveTimer = 0;
  let running = false, raf = 0, owed = 0, last = 0, lastPaint = 0, sound = false;
  const clicker = new Clicker();

  // ---- controls
  const seg = <T extends string>(label: string, opts: [T, string][], get: () => T, set: (v: T) => void) => {
    const btns = opts.map(([v, t]) => h('button', { type: 'button', 'data-v': v }, t) as HTMLButtonElement);
    const el = h('div', { class: 'seg', role: 'group', 'aria-label': label }, ...btns);
    const sync = () => btns.forEach((b) => { const on = b.dataset.v === get(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    el.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) { set(b.dataset.v as T); sync(); } });
    sync();
    return { el, sync };
  };
  const designSeg = seg<HallDesign>('CPU', [['cpu4', '4-bit CPU'], ['rv32i', 'RV32I single-cycle']], () => design, (v) => { if (v !== design) { design = v; relayout(); } });
  const techSeg = seg<HallTech>('Technology', [['relay', 'Relays'], ['tube', 'Tubes']], () => tech, (v) => { if (v !== tech) { tech = v; relayout(); } });
  const runBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Run') as HTMLButtonElement;
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step') as HTMLButtonElement;
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset') as HTMLButtonElement;
  const speedSel = h('select', { 'aria-label': 'Clock speed' }) as HTMLSelectElement;
  const soundBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: 'Relay clicks (WebAudio), off by default' }, 'Sound') as HTMLButtonElement;
  const chipBtn = h('button', { type: 'button', class: 'btn sm' }, 'Find the CMOS chip') as HTMLButtonElement;
  const viewBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset view') as HTMLButtonElement;
  const cycOut = h('span', { class: 'hall-cyc', 'aria-live': 'off' });
  const ctl = h('div', { class: 'hall-ctl' }, designSeg.el, techSeg.el, chipBtn, viewBtn);
  const run = h('div', { class: 'hall-run' }, runBtn, stepBtn, resetBtn, speedSel, soundBtn, cycOut);

  // ---- stage
  const canvas = h('canvas', { class: 'r3-canvas', tabindex: 0, 'aria-label': 'The CPU as a hall of racks in 3D: drag to orbit, wheel or pinch to zoom, click a rack to name its block' }) as HTMLCanvasElement;
  const flat = h('canvas', { class: 'hall-flat', tabindex: 0, 'aria-label': 'The CPU as a hall of racks, drawn flat: click a rack to name its block' }) as HTMLCanvasElement;
  flat.style.display = 'none';
  const labels = h('div', { class: 'r3-labels', 'aria-hidden': 'true' });
  const stateChip = h('span', { class: 'r3-chip' }), engineChip = h('span', { class: 'r3-chip' });
  const stage = h('div', { class: 'r3-stage' }, canvas, flat, labels, h('div', { class: 'r3-chips' }, stateChip, engineChip));
  const HINT_GL = 'Real size. Drag to orbit, wheel or pinch to zoom, double-click to reset; click a rack for its block.';
  const hint = h('div', { class: 'r3-hint' }, HINT_GL);
  const sum = h('div', { class: 'hall-sum' }), sub = h('p', { class: 'hall-sub' });
  const legend = h('div', { class: 'hall-legend' });
  const card = h('div', { class: 'hall-card', 'aria-live': 'polite' });
  const el = h('div', { class: 'hall' }, ctl, run, stage, hint, sum, sub, legend, card);

  const colors = new CssColors(el);
  let palette: Palette | null = null;
  const pal = (): Palette => {
    if (palette) return palette;
    const c = (t: string) => colors.rgb(t);
    const p: Palette = {
      hues: Array.from({ length: 10 }, (_, i) => c(`--hl-${i + 1}`)),
      floor: c('--hl-floor'), face: c('--hl-face'), chassis: c('--hl-chassis'), relay: c('--hl-relay'), on: c('--hl-on'),
      glass: c('--hl-glass'), glow: c('--hl-glow'), person: c('--hl-person'), table: c('--hl-table'), die: c('--hl-die'), ring: c('--hl-ring'),
    };
    if (el.isConnected) palette = p;
    return p;
  };
  const hueOf = (b: number) => pal().hues[(hall.blocks[b].hue - 1) % 10];

  // ---- the scene: static parts, devices
  /** Every device of the hall in order (cabinet by cabinet), its slot and its block. */
  let slots: Slot[] = [], slotBlock = new Int32Array(0), devNets = new Int32Array(0), state = new Uint8Array(0);
  let devData = new Float32Array(0);
  const dieSide = () => Math.sqrt(hallFacts(design).cmos.area!);
  /** The die drawn as thin as a twentieth of its side (its logic area is what is measured; a thick sliver looks like a post). */
  const dieThick = () => dieSide() / 20;
  const diePos = (): Vec3 => [hall.speck[0], TABLE_H + 0.03 + dieThick() / 2, hall.speck[1]];

  const placeDevices = () => {
    const list: Slot[] = [], blocks: number[] = [];
    for (const c of hall.cabinets) {
      const s = tech === 'relay' ? relaySlots(c.x, c.z, c.devices, hall.spec) : tubeSlots(c.x, c.z, c.devices, hall.spec);
      for (const x of s) list.push(x), blocks.push(c.block);
    }
    slots = list;
    slotBlock = Int32Array.from(blocks);
    state = new Uint8Array(list.length);
    devData = new Float32Array(list.length * INSTANCE_FLOATS);
    mapNets();
  };
  /** Device i of a block follows NAND (i mod n) of that block: extra coils and followers repeat a net. */
  const mapNets = () => {
    devNets = new Int32Array(slots.length).fill(-1);
    if (!live || liveFor !== design) return;
    let i = 0;
    for (const c of hall.cabinets) {
      const nets = live.groups.get(hall.blocks[c.block].name) ?? [];
      for (let k = 0; k < c.devices; k++, i++) if (nets.length) devNets[i] = nets[(c.first + k) % nets.length];
    }
  };

  const staticParts = (): { box: Instance[]; cyl: Instance[]; sph: Instance[]; ring: Instance[] } => {
    const P = pal(), sp = hall.spec, box: Instance[] = [], cyl: Instance[] = [], sph: Instance[] = [], ring: Instance[] = [];
    const b = (pos: Vec3, scale: Vec3, color: RGB, spec = 0, emissive?: RGB) => box.push({ pos, scale, color, spec, emissive });
    // floor
    const x0 = -3, x1 = hall.width + 2, z0 = -hall.depth - 2, z1 = 3;
    b([(x0 + x1) / 2, -0.01, (z0 + z1) / 2], [x1 - x0, 0.02, z1 - z0], P.floor);
    for (const c of hall.cabinets) {
      const sel = c.block === selected, hue = selected >= 0 && !sel ? mixRgb(hueOf(c.block), pal().chassis, 0.6) : hueOf(c.block), em = sel ? scaleRgb(hue, 0.3) : undefined;
      const cx = c.x + sp.w / 2;
      if (tech === 'relay') {
        b([cx, sp.h / 2, c.z + sp.d / 2], [sp.w, sp.h, sp.d], hue, 0.12, em);
        b([cx, sp.h / 2, c.z + sp.d + 0.003], [sp.w - 0.06, sp.h - 0.1, 0.006], P.face, 0.05);
      } else {
        const t = 0.02;
        b([c.x + t / 2, sp.h / 2, c.z + sp.d / 2], [t, sp.h, sp.d], hue, 0.12, em);
        b([c.x + sp.w - t / 2, sp.h / 2, c.z + sp.d / 2], [t, sp.h, sp.d], hue, 0.12, em);
        b([cx, sp.h / 2, c.z + t / 2], [sp.w - 2 * t, sp.h, t], scaleRgb(hue, 0.75), 0.05, em);
        b([cx, sp.h - 0.02, c.z + sp.d / 2], [sp.w, 0.04, sp.d], hue, 0.12, em);
        b([cx, 0.05, c.z + sp.d / 2], [sp.w, 0.1, sp.d], scaleRgb(hue, 0.6), 0.05, em);
        for (let s = 0; s < TUBE_SHELVES; s++) b([cx, shelfY(s, sp) + 0.0075, c.z + sp.d / 2], [sp.w - 2 * t, 0.015, sp.d - t], P.chassis, 0.3);
      }
    }
    // a person, 1.75 m, facing the racks' fronts... and the viewer
    const [px, pz] = hall.person;
    for (const s of [-1, 1]) {
      cyl.push({ pos: [px + s * 0.09, 0.43, pz], scale: [0.13, 0.86, 0.15], color: P.person });
      cyl.push({ pos: [px + s * 0.25, 1.12, pz], scale: [0.08, 0.62, 0.09], color: P.person });
    }
    box.push({ pos: [px, 1.15, pz], scale: [0.38, 0.6, 0.22], color: P.person, spec: 0.05 });
    cyl.push({ pos: [px, 1.48, pz], scale: [0.1, 0.08, 0.1], color: P.person });
    sph.push({ pos: [px, PERSON - 0.115, pz], scale: [0.2, 0.23, 0.21], color: P.person });
    // the table and the same CPU in CMOS on it, at true size, in a ring 1 cm across
    const [tx, tz] = hall.speck, side = dieSide();
    box.push({ pos: [tx, TABLE_H + 0.015, tz], scale: [0.42, 0.03, 0.42], color: P.table, spec: 0.1 });
    cyl.push({ pos: [tx, TABLE_H / 2, tz], scale: [0.06, TABLE_H, 0.06], color: P.table });
    box.push({ pos: diePos(), scale: [side, dieThick(), side], color: P.die, spec: 0.4 });
    ring.push({ pos: [tx, TABLE_H + 0.0305, tz], scale: [0.01, 0.0006, 0.01], color: P.ring, emissive: scaleRgb(P.ring, 0.5) });
    return { box, cyl, sph, ring };
  };

  // ---- device colours from the simulation
  /** Read every device's net; true when anything changed. Counts the changes for the clicks. */
  let changes = 0;
  const readStates = (): boolean => {
    let any = false;
    const sim = live && liveFor === design ? live.sim : null;
    changes = 0;
    for (let i = 0; i < devNets.length; i++) {
      const n = devNets[i];
      const v = sim && n >= 0 ? sim.get(n) : 2;
      // relay: the coil is energized at output 1; tube: the triode conducts at output 0
      const s = v === (tech === 'relay' ? 1 : 0) ? 1 : 0;
      if (s !== state[i]) { state[i] = s; any = true; changes++; }
    }
    return any;
  };
  const writeDevices = () => {
    const P = pal(), n = slots.length;
    for (let i = 0; i < n; i++) {
      const hue = hueOf(slotBlock[i]), on = state[i] === 1, s = slots[i];
      if (tech === 'relay') {
        const color = on ? mixRgb(P.on, hue, 0.3) : mixRgb(P.relay, hue, 0.35);
        writeInstance(devData, i, { pos: s.pos, scale: s.scale, color, emissive: on ? scaleRgb(P.on, 0.35) : undefined, spec: 0.25 });
      } else {
        // every heater glows; a conducting tube's plate glows too
        const color = on ? mixRgb(P.glass, P.glow, 0.55) : P.glass;
        writeInstance(devData, i, { pos: s.pos, scale: s.scale, color, emissive: scaleRgb(P.glow, on ? 0.85 : 0.18), spec: 0.5 });
      }
    }
  };

  const pushScene = () => {
    if (mode !== 'gl' || !renderer) return;
    const st = staticParts();
    const pack = (list: Instance[]) => { const d = new Float32Array(list.length * INSTANCE_FLOATS); list.forEach((x, i) => writeInstance(d, i, x)); return d; };
    renderer.updateBatch(0, pack(st.box));
    renderer.updateBatch(1, pack(st.cyl));
    renderer.updateBatch(2, pack(st.sph));
    renderer.updateBatch(3, pack(st.ring));
    writeDevices();
    renderer.updateBatch(tech === 'relay' ? 4 : 5, devData);
    renderer.updateBatch(tech === 'relay' ? 5 : 4, new Float32Array(0));
  };

  // ---- labels over the 3D view
  interface Anchor { p: Vec3; el: HTMLElement; side: 't' | 'l' | 'r'; w?: number }
  let anchors: Anchor[] = [];
  const makeLabels = () => {
    const sp = hall.spec, out: Anchor[] = [];
    const lbl = (p: Vec3, text: string, side: Anchor['side'], cls: string) => {
      const e = h('span', { class: `r3-lbl ${side} ${cls}` }, h('i'), h('b', null, text));
      labels.append(e);
      out.push({ p, el: e, side });
    };
    labels.replaceChildren();
    // priority order: the CMOS chip, the person, then blocks largest first
    lbl(diePos(), `the same CPU in CMOS (${Math.round(dieSide() * 1e6)} µm square)`, 'l', 'die');
    lbl([hall.person[0] + 0.2, PERSON, hall.person[1]], `${PERSON} m`, 'r', 'minor');
    hall.blocks.forEach((b, bi) => {
      const own = hall.cabinets.filter((c) => c.block === bi && c.row === hall.cabinets.find((q) => q.block === bi)!.row);
      const x = (own[0].x + own[own.length - 1].x + sp.w) / 2;
      lbl([x, sp.h + 0.05, own[0].z + sp.d], b.label, 't', `blk${bi > 3 && b.cabinets < 2 ? ' small' : ''}`);
    });
    anchors = out;
  };
  /** A label that would overlap one already placed is hidden (the legend and a click still name its block). */
  const placeLabels = () => {
    if (mode !== 'gl' || !renderer) return;
    const w = canvas.clientWidth, hh = canvas.clientHeight, taken: [number, number, number, number][] = [];
    for (const a of anchors) {
      const p = renderer.project(a.p);
      if (!p || p[0] < 4 || p[1] < 4 || p[0] > w - 4 || p[1] > hh - 14) { a.el.style.display = 'none'; continue; }
      a.el.style.display = '';
      a.w ||= (a.el.lastElementChild as HTMLElement).offsetWidth;
      const rect = (side: Anchor['side']): [number, number, number, number] => side === 't' ? [p[0] - a.w! / 2, p[1] - 24, p[0] + a.w! / 2, p[1]]
        : side === 'l' ? [p[0] - 9 - a.w!, p[1] - 9, p[0] + 3, p[1] + 9] : [p[0] - 3, p[1] - 9, p[0] + 9 + a.w!, p[1] + 9];
      // a side label that would leave the frame goes to the other side
      let side = a.side, r = rect(side);
      if (side !== 't' && (r[0] < 0 || r[2] > w)) { side = side === 'l' ? 'r' : 'l'; r = rect(side); }
      a.el.classList.toggle('l', side === 'l'); a.el.classList.toggle('r', side === 'r');
      if (r[0] < 0 || r[2] > w || taken.some((q) => r[0] < q[2] && q[0] < r[2] && r[1] < q[3] && q[1] < r[3])) { a.el.style.display = 'none'; continue; }
      taken.push(r);
      a.el.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
    }
  };

  // ---- camera
  /** From the front left and above, the whole floor (the person and the table too) in the frame. */
  const homeView = () => {
    const x0 = hall.person[0] - 0.5, x1 = hall.width, z0 = -hall.depth, z1 = hall.person[1] + 0.4, H = hall.spec.h;
    const R = 0.5 * Math.hypot(x1 - x0, z1 - z0, H), aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight) || 1.6;
    const fv = (35 * Math.PI) / 180, fh = 2 * Math.atan(Math.tan(fv / 2) * aspect);
    return { target: [(x0 + x1) / 2, H * 0.3, (z0 + z1) / 2] as Vec3, yaw: -0.62, pitch: 0.52, dist: ((aspect < 1 ? 1 : 0.75) * R) / Math.sin(Math.min(fv, fh) / 2) };
  };
  const rehome = () => {
    if (!renderer) return;
    const v = homeView();
    renderer.camera.rehome(v, { minDist: 0.0008, maxDist: v.dist * 3 });
    renderer.invalidate();
  };

  // ---- the flat fallback: the mockup's isometric drawing from the same layout
  let flatHits: { block: number; pts: [number, number][][] }[] = [];
  const css = (c: RGB, k = 1) => `rgb(${c.map((v) => Math.round(Math.min(1, v * k) * 255)).join(' ')})`;
  const drawFlat = () => {
    if (mode !== 'flat') return;
    const W = flat.clientWidth, H = flat.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!W || !H) return;
    flat.width = Math.round(W * dpr); flat.height = Math.round(H * dpr);
    const ctx = flat.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = pal(), sp = hall.spec;
    ctx.fillStyle = css(P.floor); ctx.fillRect(0, 0, W, H);
    // floor x right, z towards the viewer; iso: screen x = (x + z)·cos30, y = (x − z)·sin30 − height
    const c30 = Math.cos(Math.PI / 6);
    const iso = (x: number, y: number, z: number): [number, number] => [(x + z) * c30, (z - x) * 0.5 - y];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    const grow = (x: number, y: number, z: number) => { const [a, b] = iso(x, y, z); a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); };
    grow(0, sp.h, -hall.depth); grow(hall.width, 0, 0); grow(0, 0, 0); grow(hall.width, sp.h, -hall.depth); grow(hall.person[0], 0, hall.person[1]); grow(hall.person[0], PERSON, hall.person[1]);
    const pad = 24, sc = Math.min((W - 2 * pad) / (a1 - a0), (H - 2 * pad) / (b1 - b0));
    const ox = pad - a0 * sc + (W - 2 * pad - (a1 - a0) * sc) / 2, oy = pad - b0 * sc + (H - 2 * pad - (b1 - b0) * sc) / 2;
    const S = (x: number, y: number, z: number): [number, number] => { const [a, b] = iso(x, y, z); return [ox + a * sc, oy + b * sc]; };
    const poly = (pts: [number, number][], fill: string) => {
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.5; ctx.stroke();
    };
    flatHits = [];
    // back rows first, within a row right to left (the left faces show: x grows away from the viewer's left)
    const order = hall.cabinets.map((c, i) => ({ c, i })).sort((p, q) => p.c.z - q.c.z || q.c.x - p.c.x);
    let dev = 0;
    const firstDev = new Int32Array(hall.cabinets.length);
    hall.cabinets.forEach((c, i) => { firstDev[i] = dev; dev += c.devices; });
    for (const { c, i } of order) {
      const hue = hueOf(c.block), k = c.block === selected ? 1.25 : 1, { w, d, h: hh } = sp;
      const top: [number, number][] = [S(c.x, hh, c.z), S(c.x + w, hh, c.z), S(c.x + w, hh, c.z + d), S(c.x, hh, c.z + d)];
      const front: [number, number][] = [S(c.x, 0, c.z + d), S(c.x + w, 0, c.z + d), S(c.x + w, hh, c.z + d), S(c.x, hh, c.z + d)];
      const left: [number, number][] = [S(c.x, 0, c.z), S(c.x, 0, c.z + d), S(c.x, hh, c.z + d), S(c.x, hh, c.z)];
      poly(left, css(hue, 0.62 * k)); poly(top, css(hue, 1.15 * k)); poly(front, css(hue, 0.85 * k));
      // devices on the front, when they are big enough to see
      const cols = tech === 'relay' ? RELAY_COLS : TUBE_ACROSS, rows = tech === 'relay' ? Math.ceil(sp.per / RELAY_COLS) : TUBE_SHELVES;
      const cell = (sc * w) / cols;
      if (cell > 1.6) {
        const shown = tech === 'relay' ? c.devices : Math.min(c.devices, rows * cols);
        for (let j = 0; j < shown; j++) {
          const r = Math.floor(j / cols), q = j % cols, on = state[firstDev[i] + j] === 1;
          const y = tech === 'relay' ? hh - 0.07 - (r + 0.5) * ((hh - 0.14) / rows) : shelfY(rows - 1 - r, sp) + 0.05;
          const [px, py] = S(c.x + (q + 0.5) * (w / cols), y, c.z + d);
          ctx.fillStyle = tech === 'relay' ? (on ? css(P.on) : css(P.face)) : css(P.glow, on ? 1 : 0.45);
          const sz = Math.max(1, cell * 0.5);
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
      }
      flatHits.push({ block: c.block, pts: [front, top, left] });
    }
    // the person and the CMOS table
    const [fx, fy] = S(hall.person[0], 0, hall.person[1]), [hx, hy] = S(hall.person[0], PERSON, hall.person[1]);
    ctx.strokeStyle = css(P.person); ctx.lineWidth = Math.max(2, sc * 0.3); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, hy + sc * 0.3); ctx.stroke();
    ctx.beginPath(); ctx.arc(hx, hy + sc * 0.12, Math.max(2.5, sc * 0.12), 0, 2 * Math.PI); ctx.fillStyle = css(P.person); ctx.fill();
    const [dx, dy] = S(hall.speck[0], TABLE_H, hall.speck[1]);
    ctx.beginPath(); ctx.arc(dx, dy, 3, 0, 2 * Math.PI); ctx.strokeStyle = css(P.ring); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.font = '600 11px system-ui, sans-serif'; ctx.fillStyle = css(P.ring); ctx.textAlign = 'left';
    ctx.fillText('the same CPU in CMOS', dx + 7, dy + 14);
    ctx.fillStyle = css(P.person); ctx.textAlign = 'right';
    ctx.fillText(`${PERSON} m`, fx - 8, hy + 10);
  };
  const inPoly = (x: number, y: number, pts: [number, number][]) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  // ---- picking a rack in 3D: a ray through the pixel against every cabinet's box
  const pick3d = (px: number, py: number): number => {
    if (!renderer) return -1;
    const cam = renderer.camera, eye = cam.eye(), w = canvas.clientWidth, hh = canvas.clientHeight;
    const f = norm3(sub3(cam.target, eye)), r = norm3(cross3(f, [0, 1, 0])), u = cross3(r, f), t = Math.tan(cam.fov / 2);
    const nx = (px / w) * 2 - 1, ny = 1 - (py / hh) * 2;
    const dir: Vec3 = [0, 1, 2].map((k) => f[k] + r[k] * nx * t * (w / hh) + u[k] * ny * t) as Vec3;
    let best = Infinity, hit = -1;
    const sp = hall.spec;
    for (const c of hall.cabinets) {
      const lo: Vec3 = [c.x, 0, c.z], hi: Vec3 = [c.x + sp.w, sp.h, c.z + sp.d + 0.05];
      let t0 = 0, t1 = Infinity;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(dir[k]) < 1e-12) { if (eye[k] < lo[k] || eye[k] > hi[k]) { t0 = Infinity; break; } continue; }
        let a = (lo[k] - eye[k]) / dir[k], b = (hi[k] - eye[k]) / dir[k];
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      if (t0 <= t1 && t0 < best) { best = t0; hit = c.block; }
    }
    return hit;
  };

  // ---- text: totals, legend, the block card
  const describe = () => {
    const f = hallFacts(design), t = hall.total, sp = hall.spec, { used, packed } = cabinetCounts(hall);
    const per = periodIn(f.steps, tech), cmos = periodIn(f.steps, 'cmos');
    sum.textContent = `${num(t.devices)} ${sp.devices} · ${used} ${sp.word}${packed < used ? ` (${packed} if packed full)` : ''} · ${num(hall.floor)} m² with aisles · ${fmtMass(t.mass!)} · ${fmtWatts(t.power!)}`;
    sub.textContent = `${hallCpu(design).name}, ${num(f.nands)} NANDs without its program ROM (the program comes off cards). Clock: ${f.steps} ${tech} steps = ${fmtTime(per)} per instruction (${hz(per)}); in CMOS ${fmtTime(cmos)} (${fmtRate(cmos)}) on ${fmtArea(f.cmos.area!)} of silicon.`;
    legend.replaceChildren(...hall.blocks.map((b, bi) => {
      const btn = h('button', { type: 'button', class: bi === selected ? 'on' : '', title: `${b.label}: ${num(b.devices)} ${sp.devices}` },
        h('i', { style: `background: var(--hl-${b.hue})` }), `${b.label} · ${b.cabinets}`);
      btn.addEventListener('click', () => select(bi === selected ? -1 : bi));
      return btn;
    }));
    showCard();
  };
  const showCard = () => {
    const sp = hall.spec;
    if (selected < 0) {
      card.replaceChildren(`Click a ${sp.one} (or a name above) for its block. ${sp.word[0].toUpperCase()}${sp.word.slice(1)} are not shared between blocks, so a small block fills one of its own.`);
      return;
    }
    const b = hall.blocks[selected];
    const extra = b.devices - b.priced.devices;
    const own = resolveComponent(b.def.id) === b.def;
    card.replaceChildren(
      h('div', null, h('i', { class: 'hall-sw', style: `background: var(--hl-${b.hue})` }), h('b', null, b.label), ' ', h('code', null, b.name), b.def.name !== b.label ? ` (${b.def.name})` : ''),
      h('p', null, `${num(b.nands)} NANDs → ${num(b.priced.devices)} ${sp.devices}${b.priced.fanout ? ` (${num(b.priced.fanout)} of them for fan-out)` : ''}`,
        extra ? `, ${extra > 0 ? '+' : '−'}${num(Math.abs(extra))} for nets between blocks` : '', ` → ${b.cabinets} ${b.cabinets === 1 ? sp.one : sp.word}.`),
      own ? h('p', null, h('a', { href: `#/workbench/${b.def.id}` }, 'Open its schematic'), ' in the workbench: the same box, down to the NANDs.')
        : h('p', null, b.def.summary ?? 'Part of this CPU only: open the CPU in its chapter and drill into it.'),
    );
  };
  const select = (bi: number) => {
    selected = bi;
    describe();
    if (mode === 'gl') pushScene(); else drawFlat();
  };

  // ---- running
  const setChips = () => {
    const l = live && liveFor === design ? live : null;
    cycOut.textContent = l ? `${num(l.cycles)} cycles` : '';
    stateChip.textContent = !l ? 'powering on…' : l.halted ? 'halted' : running ? 'running' : 'stopped';
    stateChip.className = `r3-chip ${l?.halted ? 'warn' : running ? 'good' : ''}`;
    engineChip.textContent = l ? (l.sim.engine === 'cycle' ? 'cycle engine' : 'gate engine') : '';
    engineChip.style.display = l && l.cycles ? '' : 'none';
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.disabled = stepBtn.disabled = !l || l.halted;
  };
  const speeds = () => {
    const per = periodIn(hallFacts(design).steps, tech);
    speedSel.replaceChildren(
      h('option', { value: 'real' }, `${tech === 'relay' ? 'Relay' : 'Tube'} speed (${hz(per)})`),
      h('option', { value: 'slow' }, '2 cycles/s'),
      h('option', { value: 'max' }, 'As fast as it simulates'),
    );
    speedSel.value = speed;
  };
  const rate = () => (speed === 'real' ? 1 / periodIn(hallFacts(design).steps, tech) : speed === 'slow' ? 2 : Infinity);

  const paint = () => {
    const any = readStates();
    if (sound && tech === 'relay' && running) clicker.batch(changes);
    if (!any && mode !== 'wait') return;
    if (mode === 'gl' && renderer) { writeDevices(); renderer.updateBatch(tech === 'relay' ? 4 : 5, devData); }
    else if (mode === 'flat') drawFlat();
  };

  const cycle = (l: Live) => {
    const before = l.pc ? l.sim.getBits(l.pc).join('') : '';
    clockCycle(l.sim);
    l.cycles++;
    if (l.halt && l.sim.get(l.halt[0]) === 1) l.halted = true;
    if (l.pc && l.sim.getBits(l.pc).join('') === before) l.halted = true;
  };

  const tick = (now: number) => {
    raf = 0;
    const l = live;
    if (!running || !l || liveFor !== design) return;
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const r = rate(), t0 = performance.now();
    owed = Math.min(owed + dt * r, Number.isFinite(r) ? Math.max(2, r * 0.25) : Infinity);
    while ((owed >= 1 || !Number.isFinite(r)) && performance.now() - t0 < 10 && !l.halted) { cycle(l); owed--; }
    if (l.halted) running = false;
    if (now - lastPaint >= (reducedMotion() ? 250 : 50)) { lastPaint = now; paint(); setChips(); }
    if (running) raf = requestAnimationFrame(tick);
    else { paint(); setChips(); }
  };
  const start = () => {
    const l = live;
    if (!l || l.halted) return;
    clicker.stop();
    if (sound) clicker.start();
    l.sim.prepare();
    running = true; owed = 0; last = performance.now();
    raf = requestAnimationFrame(tick);
    setChips();
  };
  const pause = () => { running = false; cancelAnimationFrame(raf); raf = 0; paint(); setChips(); };
  const powerOn = () => {
    pause();
    clearTimeout(liveTimer);
    live = null; liveFor = null;
    mapNets(); paint(); setChips();
    const want = design;
    // after the picture: flattening and settling the RV32I takes a few hundred ms
    liveTimer = window.setTimeout(() => {
      if (dead || design !== want) return;
      live = buildLive(want); liveFor = want;
      mapNets(); paint(); setChips();
    }, 60);
  };

  runBtn.addEventListener('click', () => (running ? pause() : start()));
  stepBtn.addEventListener('click', () => { const l = live; if (!l || l.halted || running) return; cycle(l); paint(); setChips(); });
  resetBtn.addEventListener('click', () => powerOn());
  speedSel.addEventListener('change', () => { speed = speedSel.value as Speed; owed = 0; });
  soundBtn.addEventListener('click', () => {
    sound = !sound;
    soundBtn.setAttribute('aria-pressed', String(sound));
    if (sound) clicker.start(); else clicker.stop();
  });
  viewBtn.addEventListener('click', () => { renderer?.camera.reset(); renderer?.invalidate(); });
  chipBtn.addEventListener('click', () => {
    if (!renderer) return;
    const cam = renderer.camera;
    cam.target = diePos(); cam.dist = Math.max(dieSide() * 14, 0.004); cam.pitch = 0.75; cam.yaw = -0.4;
    renderer.invalidate();
  });

  // click (not a drag) on the canvas: pick a rack
  let down: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
    down = null;
    const r = canvas.getBoundingClientRect(), b = pick3d(e.clientX - r.left, e.clientY - r.top);
    if (b !== selected) select(b);
  });
  flat.addEventListener('click', (e) => {
    const r = flat.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    for (let i = flatHits.length - 1; i >= 0; i--) if (flatHits[i].pts.some((p) => inPoly(x, y, p))) { select(flatHits[i].block); return; }
    select(-1);
  });

  // ---- switching CPU or technology
  function relayout() {
    const changed = liveFor !== design;
    hall = hallLayout(hallCpu(design).def, tech);
    selected = -1;
    placeDevices();
    speeds();
    describe();
    makeLabels();
    rehome();
    if (mode === 'gl') pushScene(); else drawFlat();
    if (changed) powerOn(); else { state.fill(0); paint(); setChips(); }
    designSeg.sync(); techSeg.sync();
  }

  const setMode = (m: 'gl' | 'flat') => {
    mode = m;
    const on = m === 'flat';
    canvas.style.display = on ? 'none' : '';
    flat.style.display = on ? '' : 'none';
    labels.style.display = on ? 'none' : '';
    chipBtn.style.display = viewBtn.style.display = on ? 'none' : '';
    hint.textContent = on ? 'A flat drawing of the same hall: this browser has no WebGL2 for the 3D one. Click a rack for its block.' : HINT_GL;
    state.fill(0);
    if (on) drawFlat(); else pushScene();
    paint();
  };

  const applyLights = () => renderer?.setLights({ sky: colors.rgb('--hl-sky'), ground: colors.rgb('--hl-ground'), key: colors.rgb('--hl-key') });
  const unwatch = watchTheme(() => {
    colors.invalidate(); palette = null;
    applyLights();
    if (mode === 'gl') pushScene(); else drawFlat();
  });
  const ro = new ResizeObserver(() => { if (mode === 'flat') drawFlat(); });
  ro.observe(flat);

  placeDevices();
  speeds();
  describe();
  makeLabels();
  setChips();
  powerOn();
  void import('../gl/renderer').then(({ createRenderer, OrbitCamera, boxMesh, cylinderMesh, sphereMesh, torusMesh }) => {
    if (dead) return;
    const v = homeView();
    const cam = new OrbitCamera(v, { minDist: 0.0008, maxDist: v.dist * 3, minPitch: 0.02 });
    try {
      renderer = createRenderer(canvas, cam, { onRender: placeLabels, onLost: () => setMode('flat'), onRestored: () => setMode('gl') });
    } catch { renderer = null; }
    if (!renderer) { setMode('flat'); return; }
    const empty = () => new Float32Array(0), boxM = boxMesh();
    renderer.setScene([
      { mesh: boxM, data: empty() }, { mesh: cylinderMesh(16), data: empty() }, { mesh: sphereMesh(14, 8), data: empty() },
      { mesh: torusMesh(32, 4, 0.06), data: empty() },
      { mesh: boxM, data: empty() }, // relays
      { mesh: cylinderMesh(8), data: empty() }, // tubes
    ]);
    applyLights();
    setMode('gl');
    // for scripts/hall-perf: draw now and report the instances (no public API; a debugging aid)
    (canvas as unknown as { hallRender?: () => number }).hallRender = () => { renderer?.render(); return slots.length; };
  }).catch(() => { if (!dead) setMode('flat'); });

  return {
    el,
    destroy() {
      dead = true;
      pause();
      clearTimeout(liveTimer);
      ro.disconnect();
      unwatch();
      renderer?.destroy();
      renderer = null;
      colors.destroy();
      clicker.destroy();
      live = null;
    },
  };
}
