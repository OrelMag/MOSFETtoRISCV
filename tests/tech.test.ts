import { describe, expect, it } from 'vitest';
import '../src/lib/index';
import { alu } from '../src/lib/alu';
import { rca } from '../src/lib/combinational';
import { cpu4 } from '../src/lib/cpu4';
import { singleCycleCpu } from '../src/lib/cpu';
import { bigRam } from '../src/lib/bigmem';
import { RELAY_FA, RELAY_NAND, relayAdder } from '../src/lib/relays';
import { register } from '../src/lib/sequential';
import {
  FOLLOWER_POWER, PLATE_FANOUT, RELAY_MASS, RELAY_POWER, RELAY_VOLUME, TECH, TUBE_BRICK_POWER, TUBE_MASS, TUBE_VOLUME,
  cabinets, fmtTime, partKind, price, relayExtra, withoutParts,
} from '../src/lib/tech';
import { TUBE_FA, TUBE_NAND } from '../src/lib/tubes';
import { NAND } from '../src/lib/transistors';
import { RELAY_COIL_POWER, RELAY_STEP_MS } from '../src/phys/relay';
import { gateLevels, nandBrickPower, sectionPower } from '../src/phys/triode';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { fanHistogram, fanSum } from '../src/sim/techcount';
import { type ComponentDef, netlistOf } from '../src/sim/types';

/** The reference: flatten everything and count the NAND inputs on each net. */
function flatReads(def: ComponentDef): Map<number, number> {
  const f = flatten(def, { expand: () => true });
  const reads = new Map<number, number>();
  for (const l of f.leaves) if (l.def.prim === 'nand') for (const ins of l.inputs) for (const n of ins) reads.set(n, (reads.get(n) ?? 0) + 1);
  const hist = new Map<number, number>();
  for (const k of reads.values()) hist.set(k, (hist.get(k) ?? 0) + 1);
  return hist;
}

describe('fan-out counted from the hierarchy', () => {
  const designs: [string, () => ComponentDef][] = [
    ['rca(8)', () => rca(8)], ['alu(32)', () => alu(32)], ['register(32)', () => register(32)],
    ['cpu4', () => cpu4(new Array(256).fill(0))], ['RV32I single-cycle', () => singleCycleCpu([0x00000013])],
  ];
  for (const [name, make] of designs) {
    it(`equals the flattened design's, net for net: ${name}`, () => {
      const d = make();
      expect(fanHistogram(d)).toEqual(flatReads(d));
    });
  }

  it('reaches a large memory without building it flat', () => {
    const d = bigRam(10, 8);
    const t = performance.now();
    expect(fanSum(d, relayExtra)).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('technology constants come from the device models', () => {
  it('relay: the model\'s settled time, half a coil\'s power, a rack\'s litre, the Z3\'s mass', () => {
    expect(TECH.relay.step).toBeCloseTo(RELAY_STEP_MS * 1e-3, 12);
    expect(RELAY_POWER).toBeCloseTo(RELAY_COIL_POWER / 2, 12);
    expect(RELAY_POWER).toBeCloseTo(0.72, 2);
    expect(RELAY_VOLUME).toBeCloseTo(1e-3, 6);
    expect(RELAY_MASS).toBeCloseTo(0.385, 3);
  });

  it('tube: the brick\'s power, a plate\'s fan-out from the levels, ENIAC\'s volume and mass per tube', () => {
    expect(TUBE_BRICK_POWER).toBeCloseTo(nandBrickPower().total, 12);
    expect(TUBE_BRICK_POWER).toBeCloseTo(4.86, 2);
    expect(FOLLOWER_POWER).toBeCloseTo(sectionPower().average, 12);
    expect(PLATE_FANOUT).toBe(3);
    expect(gateLevels(PLATE_FANOUT).marginLow).toBeGreaterThan(0);
    expect(gateLevels(PLATE_FANOUT + 1).marginLow).toBeLessThan(0);
    expect(TUBE_VOLUME).toBeCloseTo(2.08e-3, 5);
    expect(TUBE_MASS).toBeCloseTo(1.55, 2);
  });
});

describe('pricing', () => {
  it('a NAND: 4 transistors, 1 relay, a 6SN7 and a 6AL5', () => {
    const p = (t: 'cmos' | 'relay' | 'tube') => price(NAND, t, 1)!;
    expect(p('cmos').devices).toBe(4);
    expect(p('relay').devices).toBe(1);
    expect(p('tube').devices).toBe(2);
    expect(p('relay').time).toBeCloseTo(8.2e-3, 9);
    expect(p('tube').power).toBeCloseTo(TUBE_BRICK_POWER, 9);
    expect(p('relay').energy).toBeCloseTo(RELAY_POWER * 8.2e-3, 9);
  });

  it('the RV32I CPU: relays exceed NANDs by the fan-out, tubes add cathode followers', () => {
    const d = singleCycleCpu([0x00000013]);
    const n = stats(d).nands, r = price(d, 'relay', null)!, t = price(d, 'tube', null)!;
    expect(r.devices).toBe(n + r.fanout);
    expect(r.fanout).toBe(fanSum(d, relayExtra));
    expect(r.fanout / n).toBeGreaterThan(0.1);
    expect(t.triodes).toBe(n + t.fanout);
    expect(t.diodes).toBe(2 * n);
    expect(cabinets(r)).toBe(Math.ceil(r.devices / 800));
  });

  it('a CPU without its program ROM: the ROM's NANDs gone, nothing else', () => {
    const d = singleCycleCpu([0x00000013]);
    const imem = netlistOf(d)!.instances.find((i) => i.name === 'imem')!.def;
    const w = withoutParts(d, ['imem']);
    expect(stats(w).nands).toBe(stats(d).nands - stats(imem).nands);
    expect(withoutParts(d, ['imem'])).toBe(w);
    expect(price(w, 'relay', null)!.devices).toBeLessThan(price(d, 'relay', null)!.devices);
  });

  it('native parts are priced in their own technology only', () => {
    expect(partKind(RELAY_FA)).toBe('relay');
    expect(price(RELAY_FA, 'cmos', 1)).toBeNull();
    expect(price(RELAY_FA, 'tube', 1)).toBeNull();
    expect(price(RELAY_FA, 'relay', 1)).toMatchObject({ devices: 2, native: true, fanout: 0 });
    expect(price(relayAdder(32), 'relay', 1)!.devices).toBe(64);
    expect(price(RELAY_NAND, 'relay', 1)!.devices).toBe(2);
    expect(partKind(TUBE_FA)).toBe('tube');
    expect(price(TUBE_FA, 'tube', null)).toMatchObject({ triodes: 9, diodes: 18, native: true });
    expect(price(TUBE_NAND, 'relay', 1)).toBeNull();
  });

  it('formats times across scales', () => {
    expect(fmtTime(8.2e-3)).toBe('8.2 ms');
    expect(fmtTime(25e-12)).toBe('25 ps');
    expect(fmtTime(1.271)).toBe('1.27 s');
  });
});
