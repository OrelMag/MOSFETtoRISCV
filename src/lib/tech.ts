// The technology setting (Phase 14c): any design priced in CMOS, relays or vacuum tubes. The netlist and the
// simulation stay the same (unit NAND delays); what changes is what one NAND costs. Each technology's brick is the
// NAND: in relays one coil per NAND output, whose contacts are the inputs of the NANDs reading it (four per relay,
// so a net read more than four times needs another coil per four more); in tubes a triode section with a diode pair
// in front (P2's tube NAND), and a cathode follower wherever a plate would drive more dividers than its levels
// allow. Native relay and tube parts (lib/relays.ts, lib/tubes.ts) are priced by their own devices.
//
// The constants come from the physics models behind P1's and P2's close-ups (phys/relay.ts, phys/triode.ts), sizes
// and masses from the Z3 and ENIAC; tests/tech.test.ts keeps them tied together. All are illustrative, like the
// 25 ps per CMOS NAND.

import {
  DIODE_HEATER_W, ENIAC, ENIAC_PANEL, HEATER_W, TUBE_STEP_US, dividerPower, nandBrickPower, plateFanout, sectionPower,
} from '../phys/triode';
import { RELAY_COIL_POWER, RELAY_RACK, RELAY_STEP_MS, Z3 } from '../phys/relay';
import { fanSum } from '../sim/techcount';
import { stats } from '../sim/stats';
import { PS_PER_NAND } from '../sim/timing';
import { type ComponentDef, netlistOf } from '../sim/types';

export type TechId = 'cmos' | 'relay' | 'tube';
export const TECHS: readonly TechId[] = ['cmos', 'relay', 'tube'];

export interface Tech {
  id: TechId;
  name: string;
  /** What one NAND is made of. */
  brick: string;
  /** One NAND step (s): what a gate delay becomes. */
  step: number;
  stepName: string;
}

export const TECH: Record<TechId, Tech> = {
  cmos: { id: 'cmos', name: 'CMOS', brick: '4 transistors', step: PS_PER_NAND * 1e-12, stepName: 'NAND delay' },
  relay: { id: 'relay', name: 'Relays', brick: '1 coil and its contacts', step: RELAY_STEP_MS * 1e-3, stepName: 'relay step' },
  tube: { id: 'tube', name: 'Tubes', brick: '½ 6SN7 + a 6AL5', step: TUBE_STEP_US * 1e-6, stepName: 'tube step' },
};

/** Contacts per relay: a telephone relay with four changeover poles (P1's relay part has up to six). */
export const RELAY_CONTACTS = 4;
/** A relay's average power (W): its coil at 24 V, on about half the time. */
export const RELAY_POWER = RELAY_COIL_POWER / 2;
/** Volume (m³) and mass (kg) per relay: a rack's share, and the Z3's tonne over its relays. */
export const RELAY_VOLUME = (RELAY_RACK.w * RELAY_RACK.d * RELAY_RACK.h) / RELAY_RACK.relays;
export const RELAY_MASS = Z3.mass / Z3.relays;

/** The tube NAND brick's average power (W): heaters, plate and plate resistor, one divider. */
export const TUBE_BRICK_POWER = nandBrickPower().total;
/** A cathode follower: one triode section with its heater, conducting half the time (W). */
export const FOLLOWER_POWER = sectionPower().average;
/** Dividers one plate can drive (from the model's levels), and one cathode follower (an estimate). */
export const PLATE_FANOUT = plateFanout();
export const FOLLOWER_FANOUT = 10;
/** Volume (m³) and mass (kg) per tube: ENIAC's panels and tonnes over its tubes. */
export const TUBE_VOLUME = (ENIAC_PANEL.w * ENIAC_PANEL.d * ENIAC_PANEL.h) / ENIAC_PANEL.tubes;
export const TUBE_MASS = ENIAC.mass / ENIAC.tubes;

/** A NAND2 in a 28 nm-class process (µm², chapter 26's floorplan) at 70 % utilization. */
export const NAND2_UM2 = 0.3;
export const UTILIZATION = 0.7;

/** Extra coils for a net read by k NAND inputs: one per four contacts beyond the first four. */
export const relayExtra = (k: number) => Math.max(0, Math.ceil(k / RELAY_CONTACTS) - 1);
/** Cathode followers for a net read by k dividers: none within a plate's fan-out, else one per FOLLOWER_FANOUT. */
export const followers = (k: number) => (k <= PLATE_FANOUT ? 0 : Math.ceil(k / FOLLOWER_FANOUT));

export type PartKind = 'nand' | 'transistor' | 'relay' | 'tube' | 'none';

/** What a design is built from: NANDs (priced in every technology), or a native transistor, relay or tube circuit. */
export function partKind(def: ComponentDef): PartKind {
  const s = stats(def);
  if (s.relays) return 'relay';
  if (s.triodes || s.diodes) return 'tube';
  if (s.nands) return 'nand';
  return s.transistors ? 'transistor' : 'none';
}

export interface Priced {
  tech: TechId;
  /** Devices: transistors (CMOS), relays, tubes (glass envelopes: a 6SN7 holds two triodes, a 6AL5 two diodes). */
  devices: number;
  /** Of them, added for fan-out (relay coils, cathode followers). */
  fanout: number;
  /** Relays or tube sections the NANDs became (before fan-out); triode and diode sections for tubes. */
  triodes?: number;
  diodes?: number;
  /** Steps on the worst path (gate delays, relay steps, tube steps) and their time (s); null when unknown. */
  steps: number | null;
  time: number | null;
  /** Average power (W), energy per operation (J): null for CMOS (the Power panel measures it by simulation). */
  power: number | null;
  energy: number | null;
  /** Volume (m³) and mass (kg); for CMOS the silicon area instead (m²). */
  volume: number | null;
  mass: number | null;
  area: number | null;
  /** Built from its own devices, not NAND bricks. */
  native: boolean;
}

/**
 * The design priced in one technology, with `steps` NAND delays (its depth, or a clocked part's period) on its worst
 * path; null when it cannot be built that way (a transistor circuit in relays). A native relay or tube part is priced
 * in its own technology only, with `steps` counted in its own steps.
 */
export function price(def: ComponentDef, tech: TechId, steps: number | null): Priced | null {
  const s = stats(def);
  const kind = partKind(def);
  const time = steps === null ? null : steps * TECH[tech].step;
  const base = { tech, steps, time, native: false, fanout: 0, power: null, energy: null, volume: null, mass: null, area: null };
  if (tech === 'cmos') {
    if (kind !== 'nand' && kind !== 'transistor') return null;
    return { ...base, devices: s.transistors, area: s.nands * NAND2_UM2 * 1e-12 / UTILIZATION, native: kind === 'transistor' };
  }
  if (kind !== 'nand' && kind !== tech) return null;
  const native = kind === tech;
  const withEnergy = (p: Omit<Priced, 'energy'>): Priced => ({ ...p, energy: p.power !== null && time !== null ? p.power * time : null });
  if (tech === 'relay') {
    const fanout = native ? 0 : fanSum(def, relayExtra);
    const n = native ? s.relays : s.nands + fanout;
    return withEnergy({ ...base, native, devices: n, fanout, power: n * RELAY_POWER, volume: n * RELAY_VOLUME, mass: n * RELAY_MASS });
  }
  if (native) {
    // A tube circuit as drawn: each triode section with a divider on its grid, each diode section's heater.
    const tubes = Math.ceil((s.triodes + s.diodes) / 2);
    const power = s.triodes * (sectionPower().average + dividerPower()) + s.diodes * DIODE_HEATER_W;
    return withEnergy({ ...base, native, devices: tubes, triodes: s.triodes, diodes: s.diodes, power, volume: tubes * TUBE_VOLUME, mass: tubes * TUBE_MASS });
  }
  const fanout = fanSum(def, followers);
  const triodes = s.nands + fanout, diodes = 2 * s.nands;
  const tubes = Math.ceil(triodes / 2) + s.nands;
  const power = s.nands * TUBE_BRICK_POWER + fanout * FOLLOWER_POWER;
  return withEnergy({ ...base, devices: tubes, fanout, triodes, diodes, power, volume: tubes * TUBE_VOLUME, mass: tubes * TUBE_MASS });
}

const without = new WeakMap<ComponentDef, Map<string, ComponentDef>>();

/**
 * The design without some of its top-level parts (a CPU's program ROM: in relays or tubes the program comes off
 * cards or tape), for counting. Their nets lose those ends; nothing else changes. Memoized per design and names.
 */
export function withoutParts(def: ComponentDef, names: readonly string[]): ComponentDef {
  const key = [...names].sort().join(',');
  let m = without.get(def);
  if (!m) without.set(def, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const nl = netlistOf(def);
  if (!nl) return def;
  const drop = new Set(names);
  const keep = (end: string) => !drop.has(end.split('.')[0]) || !end.includes('.');
  const d: ComponentDef = {
    ...def, id: `${def.id}~no-${key}`, preferBehavior: false, behavior: undefined,
    netlist: () => ({
      ...nl,
      instances: nl.instances.filter((i) => !drop.has(i.name)),
      nets: nl.nets.map((n) => ({ ...n, ends: n.ends.filter(keep), via: undefined, tags: undefined })).filter((n) => n.ends.length),
    }),
  };
  m.set(key, d);
  return d;
}

/** Every technology the design can be priced in. */
export function priceAll(def: ComponentDef, steps: number | null): Partial<Record<TechId, Priced>> {
  const out: Partial<Record<TechId, Priced>> = {};
  for (const t of TECHS) {
    const p = price(def, t, steps);
    if (p) out[t] = p;
  }
  return out;
}

/** Racks (relays) or ENIAC panels (tubes) a priced design fills. */
export function cabinets(p: Priced): number {
  if (p.tech === 'relay') return Math.ceil(p.devices / RELAY_RACK.relays);
  if (p.tech === 'tube') return Math.ceil(p.devices / ENIAC_PANEL.tubes);
  return 0;
}

// ---- formatting --------------------------------------------------------------------------------------------------

const scaled = (x: number, units: [number, string][], digits = 3): string => {
  for (const [k, u] of units) {
    if (Math.abs(x) >= k) return `${sig(x / k, digits)} ${u}`;
  }
  const [k, u] = units[units.length - 1];
  return `${sig(x / k, digits)} ${u}`;
};
/** At most `digits` significant digits, thousands separated, no exponent. */
function sig(x: number, digits: number): string {
  if (x === 0) return '0';
  const d = Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(x))));
  return Number(x.toFixed(Math.min(d, 6))).toLocaleString('en-US', { maximumFractionDigits: Math.min(d, 6) });
}

export const fmtTime = (s: number) => scaled(s, [[3600, 'h'], [60, 'min'], [1, 's'], [1e-3, 'ms'], [1e-6, 'µs'], [1e-9, 'ns'], [1e-12, 'ps']]);
export const fmtRate = (s: number) => scaled(1 / s, [[1e9, 'GHz'], [1e6, 'MHz'], [1e3, 'kHz'], [1, 'Hz'], [1e-3, 'mHz']]);
export const fmtWatts = (w: number) => scaled(w, [[1e6, 'MW'], [1e3, 'kW'], [1, 'W'], [1e-3, 'mW'], [1e-6, 'µW']]);
export const fmtJoules = (j: number) => scaled(j, [[1e6, 'MJ'], [1e3, 'kJ'], [1, 'J'], [1e-3, 'mJ'], [1e-6, 'µJ'], [1e-9, 'nJ'], [1e-12, 'pJ'], [1e-15, 'fJ']]);
export const fmtVolume = (m3: number) => scaled(m3, [[1, 'm³'], [1e-3, 'L'], [1e-6, 'mL']]);
export const fmtMass = (kg: number) => (kg >= 1000 ? `${sig(kg / 1000, 3)} t` : kg >= 1 ? `${sig(kg, 3)} kg` : `${sig(kg * 1000, 3)} g`);
export const fmtArea = (m2: number) => scaled(m2, [[1e-6, 'mm²'], [1e-12, 'µm²']]);

/** What every technology figure rests on, for a tooltip or a note. */
export const TECH_NOTE = `Illustrative, like the ${PS_PER_NAND} ps per CMOS NAND. Relays: a NAND is one coil (its contacts are the inputs of
the gates reading it, ${RELAY_CONTACTS} per relay, so a wider fan-out needs more coils), ${RELAY_STEP_MS} ms per step (the relay model's
settled time, bounce included), ${RELAY_POWER.toFixed(2)} W (a ${RELAY_COIL_POWER.toFixed(2)} W coil on half the time), a rack's
${RELAY_RACK.relays} relays in ${(RELAY_RACK.w * RELAY_RACK.d * RELAY_RACK.h).toFixed(1)} m³, the Z3's mass per relay. Tubes: a NAND is a
triode section and two diode sections (½ 6SN7 + a 6AL5), ${TUBE_STEP_US.toFixed(1)} µs per step (an R·C estimate),
${TUBE_BRICK_POWER.toFixed(2)} W (heaters ${(HEATER_W + 2 * DIODE_HEATER_W).toFixed(1)} W of it), a cathode follower when a plate would drive
more than ${PLATE_FANOUT} dividers, ENIAC's volume and mass per tube.`;
