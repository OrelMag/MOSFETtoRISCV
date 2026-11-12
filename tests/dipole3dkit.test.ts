// The dipole's studio model (widgets/dipole3dkit.ts) held to its sources and to the chapter: the coax's three layers from the
// semi-rigid .086 data sheet, the arms at the cut length, the pattern and the isotropic sphere of the same power, the
// half-power rings, the aperture A = G λ² / 4π at 2.4 and 28 GHz, the current's colours and the loops' beads.
import { describe, expect, it } from 'vitest';
import { chRadio } from '../src/chapters/ch-comm-radio';
import { boundsOfNamed, itemMatrix, applyMat } from '../src/gl/kit/scene';
import { apertureM2, wavelengthM } from '../src/phys/radio';
import { ANTENNA_GHZ } from '../src/widgets/radio';
import { COAX, GHZ_HI, LOOP_PTS, ROD_R, SRC, apertureMm2, currentColour, dipoleModel, isoRadius, loopBeads, type DipoleLook } from '../src/widgets/dipole3dkit';
import { DipoleRun, LAMBDA, PATTERN_R, SLEEVE_LEN, cutHalf, directivity, gainDbi, halfPower, loopOutline, loopsAt, surfaceAt } from '../src/widgets/dipole3dparts';

const MM = 10;
const rgb = { cu: [0.8, 0.5, 0.3] as [number, number, number], pos: [1, 0, 0] as [number, number, number], neg: [0, 0, 1] as [number, number, number] };
const look = (o: Partial<DipoleLook> = {}): DipoleLook => ({ detail: 'flat', mode: 'power', feed: 'balanced', pattern: true, hi: false, rgb, ...o });
const named = (m: ReturnType<typeof dipoleModel>, n: string) => m.items.filter((it) => it.name === n);

describe('sourced dimensions', () => {
  it('the coax is the semi-rigid .086: 0.0865 in jacket, 0.066 in PTFE, 0.0201 in centre (UT-085C-TP)', () => {
    expect(COAX.jacket).toBeCloseTo(2.197, 3);
    expect(COAX.ptfe).toBeCloseTo(1.676, 3);
    expect(COAX.centre).toBeCloseTo(0.511, 3);
    expect(SRC.coax).toContain('UT-085C-TP');
    const m = dipoleModel(new DipoleRun(), look({ feed: 'coax' }));
    // turned onto -x: the layer's radius is its extent across y and z
    const jacket = named(m, 'coax jacket (copper)')[0], ptfe = named(m, 'PTFE dielectric')[0];
    expect(jacket.geo.max[0]).toBeCloseTo(COAX.jacket / 2, 2);
    expect(ptfe.geo.max[0]).toBeCloseTo(COAX.ptfe / 2, 2);
    expect(jacket.info?.source).toBe(SRC.coax);
  });
  it('the sleeve is a quarter wave long', () => {
    const m = dipoleModel(new DipoleRun(), look({ feed: 'balun' }));
    const s = named(m, 'λ/4 sleeve balun')[0];
    expect(s.geo.max[1] - s.geo.min[1]).toBeCloseTo((SLEEVE_LEN * MM), 2);
    expect(SLEEVE_LEN * MM).toBeCloseTo((wavelengthM(ANTENNA_GHZ) * 1000) / 4, 6);
  });
  it('the arms span the cut half length each side and are drawn at 3x the 2 mm rod', () => {
    const m = dipoleModel(new DipoleRun(), look());
    const b = boundsOfNamed(m, ['arms']);
    expect(b.max[1]).toBeCloseTo(cutHalf(0.5) * MM, 3);
    expect(b.min[1]).toBeCloseTo(-cutHalf(0.5) * MM, 3);
    expect(2 * ROD_R).toBeCloseTo(6, 9);
  });
});

describe('the pattern against the isotropic sphere', () => {
  it('the sphere radiates the same total power: radius 1/D of the power peak, 1/sqrt(D) of the field', () => {
    expect(isoRadius(0.5, 'power')).toBeCloseTo(1 / 1.641, 3);
    expect(isoRadius(0.5, 'field')).toBeCloseTo(1 / Math.sqrt(1.641), 3);
    for (const mode of ['power', 'field'] as const) {
      const iso = named(dipoleModel(new DipoleRun(), look({ mode })), 'isotropic, same power').find((it) => it.scale)!;
      expect(iso.scale![0]).toBeCloseTo(PATTERN_R * MM * isoRadius(0.5, mode), 6);
    }
    // broadside the lobe pokes out by the gain; along the axis it is inside
    expect(surfaceAt(Math.PI / 2, 0.5, 'power') / isoRadius(0.5, 'power')).toBeCloseTo(directivity(0.5), 9);
    expect(10 * Math.log10(directivity(0.5))).toBeCloseTo(2.15, 2);
  });
  it('the half-power rings sit where the power is half its peak', () => {
    const m = dipoleModel(new DipoleRun(), look({ mode: 'power', detail: 'full' })), hp = halfPower(0.5);
    const rings = named(m, 'half-power ring');
    expect(rings.length).toBe(2);
    const R = PATTERN_R * MM, r = R * surfaceAt(hp.hi, 0.5, 'power');
    expect(surfaceAt(hp.hi, 0.5, 'power')).toBeCloseTo(0.5, 6);
    expect(Math.abs(rings[0].at![1])).toBeCloseTo(Math.abs(r * Math.cos(hp.hi)), 6);
    expect(rings[0].geo.max[0]).toBeCloseTo(r * Math.sin(hp.hi) + 0.6, 0); // a 96-sided ring: its bounds within a facet's sag
  });
});

describe('the aperture, at the chapter frequency and at 28 GHz', () => {
  it('A = G lambda^2 / 4 pi: the dipole collects 1.64 times a 0 dBi antenna', () => {
    expect(apertureMm2(0.5, ANTENNA_GHZ) / 100).toBeCloseTo(directivity(0.5) * apertureM2(0, ANTENNA_GHZ) * 1e4, 9);
    expect(apertureMm2(0.5, ANTENNA_GHZ) / 100).toBeCloseTo(20.4, 1);
    expect(apertureMm2(0.5, GHZ_HI) / 100).toBeCloseTo(0.15, 2);
    // the disk's radius gives that area
    const disk = named(dipoleModel(new DipoleRun(), look()), 'aperture')[0];
    expect(Math.PI * disk.geo.max[0] ** 2).toBeCloseTo(apertureMm2(0.5, ANTENNA_GHZ), -1);
  });
  it('the chapter quotes the same 0 dBi apertures and gain the model is built on', () => {
    const body = chRadio.steps[0].body as string;
    expect(body).toContain(`${(apertureM2(0, ANTENNA_GHZ) * 1e4).toFixed(0)} cm²`);
    expect(body).toContain(`${(apertureM2(0, 28) * 1e4).toFixed(2)} cm²`);
    expect(body).toContain(`${gainDbi(0.5).toFixed(2)} dBi`);
    expect(GHZ_HI).toBe(28);
  });
  it('the 28 GHz dipole beside it is the same antenna scaled by the wavelength', () => {
    const m = dipoleModel(new DipoleRun(), look({ hi: true }));
    const arm = named(m, `${GHZ_HI} GHz dipole`)[0], hcs = cutHalf(0.5) * MM * (wavelengthM(GHZ_HI) / wavelengthM(ANTENNA_GHZ));
    expect(arm.geo.max[1]).toBeCloseTo(hcs, 6);
    expect(named(m, 'a phone, for scale').length).toBe(1);
  });
});

describe('the motion follows the current', () => {
  it('an arm is red where the current runs up, blue where it runs down, copper where it is zero', () => {
    const run = new DipoleRun();
    expect(currentColour(1, run, rgb)[0]).toBeGreaterThan(currentColour(1, run, rgb)[2]);
    run.t = 0.5;
    expect(currentColour(1, run, rgb)[2]).toBeGreaterThan(currentColour(1, run, rgb)[0]);
    run.t = 0.25;
    expect(currentColour(1, run, rgb)).toEqual(rgb.cu.map((v) => expect.closeTo(v, 6)));
    // the painted arm carries those colours along its length
    run.t = 0;
    const up = named(dipoleModel(run, look()), 'arm')[0];
    expect(up.geo.colors).toBeTruthy();
  });
  it('the loops are beads on their outlines (mm), alternating in sense', () => {
    const run = new DipoleRun();
    run.t = 1.0;
    const beads = loopBeads(run, { e1: [1, 0.6, 0], e2: [0.6, 0.3, 1] }), ls = loopsAt(1.0);
    expect(beads.length).toBe(ls.length * 2 * LOOP_PTS);
    const p0 = loopOutline(ls[0], 1, LOOP_PTS)[1];
    expect(beads[0].pos).toEqual(p0.map((v) => v * MM));
    expect(LAMBDA * MM).toBeCloseTo(wavelengthM(ANTENNA_GHZ) * 1000, 6);
  });
  it('the arms move with nothing but their paint: the model is rebuilt per phase, its geometry reused', () => {
    const run = new DipoleRun();
    const a = named(dipoleModel(run, look()), 'arm')[0].geo;
    run.step();
    const b = named(dipoleModel(run, look()), 'arm')[0].geo;
    expect(b).toBe(a);
    const M = itemMatrix(named(dipoleModel(run, look()), 'arm')[1], 0);
    expect(applyMat(M, [0, 10, 0])[1]).toBeCloseTo(-10, 9);
  });
});
