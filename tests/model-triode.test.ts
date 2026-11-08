// The triode close-up held to the Tung-Sol 6SN7GTB datasheet and to phys/triode.ts.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { plateCurrent, V_LOW } from '../src/phys/triode';
import { GRID_MAX, PIN_ROLES, PLATE_RATING_W, pinPos, returned, stateAt, tubeParts, type Palette } from '../src/widgets/triode3dview';

const G: RGB = [0.5, 0.5, 0.5], GA: RGBA = [0.5, 0.5, 0.5, 0.2];
const P: Palette = {
  bakelite: G, pin: G, plate: G, nickel: G, oxide: G, red: G, orange: G, heater: G, grid: G, rod: G, mica: GA, glass: GA, press: GA,
  getter: GA, getterCup: G, electron: [0, 0, 1], role: { g: G, p: G, k: G, h: G },
};

describe('the 6SN7GT drawing against its datasheet', () => {
  it('seats eight pins on a 17.5 mm circle, 45 degrees apart, the key midway between pins 8 and 1', () => {
    const ang = (k: number) => { const [x, z] = pinPos(k); return Math.atan2(x, z); };
    for (let k = 1; k <= 8; k++) expect(Math.hypot(...pinPos(k))).toBeCloseTo(8.75, 6);
    for (let k = 1; k < 8; k++) expect(((ang(k + 1) - ang(k) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI).toBeCloseTo(Math.PI / 4, 6);
    // the key sits at angle pi from +z (x = 0, z < 0); pin 1 and pin 8 are 22.5 degrees either side of it
    const away = (k: number) => Math.abs(((ang(k) - Math.PI + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(away(1)).toBeCloseTo(Math.PI / 8, 6);
    expect(away(8)).toBeCloseTo(Math.PI / 8, 6);
  });

  it('is a T-9 bulb 28.6 mm across and fits the 84 mm overall length', () => {
    const parts = tubeParts(stateAt(0, 20), P);
    expect(parts.find((p) => p.kind === 'wall')!.scale![0]).toBeCloseTo(28.6, 6);
    const top = Math.max(...parts.filter((p) => p.kind === 'dome').map((p) => p.pos[1] + p.scale![1] / 2));
    const bottom = Math.min(...parts.filter((p) => p.kind === 'sph').map((p) => p.pos[1] - p.scale![1] / 2));
    expect(top - bottom).toBeLessThanOrEqual(84);
  });

  it('gives the pins their datasheet roles: g2 p2 k2 g1 p1 k1 and two heater pins', () => {
    expect([...PIN_ROLES]).toEqual(['g2', 'p2', 'k2', 'g1', 'p1', 'k1', 'h', 'h']);
  });
});

describe('the electrons and the readout against the model', () => {
  it('falls back to the cathode for more than 99 % of the emission at the full current, and none while emission limits it', () => {
    expect(returned(stateAt(0, 20))).toBeGreaterThan(0.99);
    expect(1 - returned(stateAt(0, 20))).toBeCloseTo(plateCurrent(0, V_LOW) / stateAt(0, 20).sat, 9);
    expect(returned(stateAt(0, 0.2))).toBeCloseTo(0, 6);
  });

  it('draws the space-charge sheath only when asked, and only with emission that falls back', () => {
    const sheath = (st: ReturnType<typeof stateAt>, charge: boolean) => tubeParts(st, P, { charge }).filter((p) => p.glass && p.kind === 'cyl' && p.color[2] === 1 && p.color[0] === 0);
    expect(sheath(stateAt(0, 20), true)).toHaveLength(1);
    expect(sheath(stateAt(0, 20), false)).toHaveLength(0);
    expect(sheath(stateAt(0, 0), true)).toHaveLength(0);
  });

  it('stops the grid slider at 0 V and rates the plate at 2.5 W', () => {
    expect(GRID_MAX).toBe(0);
    expect(PLATE_RATING_W).toBe(2.5);
    const st = stateAt(0, 20);
    expect(st.vp * st.ip).toBeLessThan(PLATE_RATING_W);
  });
});
