// The puzzle device part (puzzles/devices.ts): one per device puzzle, placed by the puzzle's Start, never from the palette.
// Like PUZZLE IN it is an external part (sim/types isExternal: a behaviour with no structure, zero cost, a comment in
// Verilog) whose world lives in the leaf's private state. It is a `seq` behaviour: the world moves only at a rising clk
// edge (with `en`, only where en = 1), from the drive pins as they were just before it, and the sense pins follow the
// world alone, so a controller wired straight back into it makes no loop and the cycle engine runs it. After a fault or
// once the world is done it stands still: Check and the player read where and why from the state. No DOM.

import type { Sim } from '../sim/sim';
import type { ComponentDef, PortDef } from '../sim/types';
import { DEVICE_TESTS, DEVICES, type DeviceFrame, type DeviceId, isDeviceId, stepWorld } from '../puzzles/devices';

export const DEVICE_PREFIX = 'puzzle_dev_';

/** Private state of a device leaf. */
export interface DeviceState {
  /** The clk level last seen (-1: none yet). */
  c: number;
  dev: DeviceId;
  /** The test whose world this is. */
  test: number;
  w: unknown;
  /** Steps taken. */
  n: number;
  /** The first broken rule and the step it came (the world then stands still). */
  fault: string | null;
  frames: DeviceFrame[];
}

/** The world of test `test` at its start (keeping the clk level an old state saw). */
export function deviceState(dev: DeviceId, test = 0, old?: unknown): DeviceState {
  const tests = DEVICE_TESTS[dev];
  const t = tests[Math.max(0, Math.min(tests.length - 1, test))];
  return { c: (old as DeviceState | undefined)?.c ?? -1, dev, test, w: DEVICES[dev].start(t), n: 0, fault: null, frames: [] };
}

/** Where each device's face sits in its box (grid units), and the box. */
export const DEVICE_BOX: Record<DeviceId, { w: number; h: number; face: { x: number; y: number; w: number; h: number }; drive: number[]; sense: number[] }> = {
  crossing: { w: 20, h: 15, face: { x: 5, y: 3, w: 10, h: 9.5 }, drive: [3, 5, 7, 9, 11], sense: [7] },
  maze: { w: 26, h: 20, face: { x: 6, y: 3, w: 14, h: 14.5 }, drive: [4, 6, 8, 10], sense: [4, 6, 8, 10] },
  vend: { w: 20, h: 14, face: { x: 5, y: 3, w: 10, h: 8.5 }, drive: [4, 6, 8], sense: [4, 6, 8] },
};

const defs = new Map<string, ComponentDef>();
const ofDef = new WeakMap<ComponentDef, { dev: DeviceId; en: boolean }>();

/** The device part (memoized: one object per device and enable). */
export function deviceDef(dev: DeviceId, en = false): ComponentDef {
  const key = `${dev}${en ? '_en' : ''}`;
  let d = defs.get(key);
  if (d) return d;
  const m = DEVICES[dev], box = DEVICE_BOX[dev];
  const ports: PortDef[] = [
    ...m.drive.map((p): PortDef => ({ name: p.name, width: p.width, dir: 'in', doc: p.doc })),
    ...(en ? [{ name: 'en', width: 1, dir: 'in', doc: 'The world steps only at a rising clk edge where en = 1' } as PortDef] : []),
    { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true, doc: `The world takes a step at its rising edge${en ? ' (where en = 1)' : ''}` },
    ...m.sense.map((p): PortDef => ({ name: p.name, width: p.width, dir: 'out', doc: p.doc })),
  ];
  const portPos: Record<string, number> = {};
  [...m.drive.map((p) => p.name), ...(en ? ['en'] : [])].forEach((n, i) => (portPos[n] = box.drive[i]));
  m.sense.forEach((p, i) => (portPos[p.name] = box.sense[i]));
  const nIn = m.drive.length + (en ? 1 : 0);
  d = {
    id: `${DEVICE_PREFIX}${key}`, name: m.title, category: 'plumbing',
    summary: `A puzzle device: the ${m.title.toLowerCase()}'s world behind its pins. It takes a step at each rising clk edge${en ? ' where en = 1' : ''}, `
      + 'reading the pins on its left; its pins on the right follow the world. Check plays every test on it and its rules judge each step. '
      + 'Outside the circuit: no gates, nothing in Verilog.',
    ports,
    symbol: { kind: 'box', label: m.label, w: box.w, h: box.h, portPos, keepOut: [box.face] },
    behavior: {
      // edge-triggered: the outputs follow the world alone (no input → output path), so the cycle engine runs a loop through it
      seq: { clk: 'clk', comb: [] },
      init: () => deviceState(dev),
      carry: (prev) => {
        const p = prev as DeviceState | undefined;
        return p && p.dev === dev ? structuredCloneState(p) : deviceState(dev);
      },
      eval: (inputs, s) => {
        const st = s as DeviceState;
        const clk = inputs[nIn];
        if (clk === 1 && st.c === 0 && (!en || inputs[nIn - 1] === 1) && st.fault === null && !m.done(st.w)) {
          const drive = inputs.slice(0, m.drive.length);
          const sense = m.sensors(st.w);
          const why = stepWorld(m, st.w, drive);
          st.frames.push({ step: st.n, drive, sense, ...(why ? { fault: why } : {}) });
          st.n++;
          if (why) st.fault = why;
        }
        if (clk === 0 || clk === 1) st.c = clk;
        return m.sensors(st.w);
      },
    },
  };
  defs.set(key, d);
  ofDef.set(d, { dev, en });
  return d;
}

/** A copy of a state for a rebuilt simulation (the world's own clone, so nothing is shared). */
function structuredCloneState(p: DeviceState): DeviceState {
  return { ...p, w: DEVICES[p.dev].clone(p.w), frames: p.frames.slice() };
}

/** Which device a definition is (null for any other). */
export const deviceOf = (d: ComponentDef | undefined): { dev: DeviceId; en: boolean } | null => (d ? ofDef.get(d) ?? null : null);

export const deviceRefDef = (ref: { device: unknown; en?: unknown }): ComponentDef | { error: string } =>
  isDeviceId(ref.device) ? deviceDef(ref.device, ref.en === true) : { error: `unknown puzzle device '${String(ref.device)}'` };

export interface DeviceLeaf { li: number; path: string[]; dev: DeviceId; en: boolean }

/** The devices of a simulation, at any depth. */
export function deviceLeaves(sim: Sim): DeviceLeaf[] {
  const out: DeviceLeaf[] = [];
  sim.design.leaves.forEach((l, li) => {
    const k = deviceOf(l.def);
    if (k) out.push({ li, path: l.node.path, ...k });
  });
  return out;
}
