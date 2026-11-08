// The CRT model (widgets/crt3dparts.ts) is held to the gates: its scan-out reference to lib/raster.ts SCAN_OUT cycle by cycle,
// the beam's position to the address the scan-out sends, the painted colours to the frame it reads, the timing to VGA's
// published proportions, and the tube's geometry to the figures it quotes.
import { describe, expect, it } from 'vitest';
import { FB_W } from '../src/gfx/raster';
import { barsPicture, ringsPicture } from '../src/gfx/scenepics';
import { displayTop, SCAN_OUT } from '../src/lib/raster';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import {
  crtAnchors, magnetRings, maskBeam, maskParts, MASK, memWord, NTSC, NTSC_SCALED, pathAt, REAL_FRAME_MS, sagAt, TRIADS_PER_CELL, fieldTicks,
  beamAt, beamPath, cellCentre, CrtRun, decayTicks, frameTicks, GEOM, hTotal, insideFunnel, levelsOf, ScanRef, SCANOUT, spotOf, staticParts, poseParts,
  VGA_FULL, VGA_PIXEL_CLOCK, VGA_SCALED, vTotal, W, WORDS, yokeCurrent, type CrtPalette, type Timing,
} from '../src/widgets/crt3dparts';
import { lcg } from './util';

const bars = barsPicture(), rings = ringsPicture();
const pics: [Uint8Array, Uint8Array] = [bars, rings];

describe('the scan-out reference', () => {
  it('equals SCAN_OUT cycle by cycle, with swaps, mid-frame ones, and sync on and off', () => {
    const r = lcg(33), sim = new BitSim(flatten(SCAN_OUT)), ref = new ScanRef();
    let sync = 1, flips = 0, last = 0;
    for (let c = 0; c < 4 * WORDS + 300; c++) {
      const swap = r(40) === 0 ? 1 : 0;
      if (c % 777 === 400) sync ^= 1;
      sim.setInput('swap', swap); sim.setInput('sync', sync); sim.settle();
      const o = ref.out();
      expect([sim.get('ra', 1)[0], sim.get('vsync', 1)[0], sim.get('front', 1)[0]], `cycle ${c}`).toEqual([o.ra, o.vsync, o.front]);
      if (o.front !== last) { flips++; last = o.front; }
      sim.cycle(); ref.step(swap, sync);
    }
    expect(flips).toBeGreaterThan(2);
  });
});

describe('the beam follows the scan-out', () => {
  it('the address is 16 words a row, 64 rows, vsync on the last word', () => {
    const b = beamAt(SCANOUT, 4 * 1023 + 0.5);
    expect([b.addr, b.line, b.px >> 2, b.blanked]).toEqual([1023, 63, 15, false]);
    expect(new ScanRef().out().vsync).toBe(0);
    const s = new ScanRef(); s.addr = 1023; expect(s.out().vsync).toBe(1);
  });

  for (const tm of [SCANOUT, VGA_SCALED] as Timing[]) {
    it(`${tm.id}: at every active pixel the beam is on the pixel the scan-out sends, with the colours of its frame (gate-level display)`, () => {
      // The gates are clocked only on the cycles the beam is active (a real controller holds its address in blanking).
      const sim = new BitSim(flatten(displayTop(bars, rings)));
      const run = new CrtRun(tm, pics), r = lcg(5);
      const T = 2 * frameTicks(tm) + 40;
      let swapNext = false, active = 0, checked = 0;
      for (let tk = 0; tk < T; tk++) {
        if (tk % 4 === 0 && tk > 0 && tk % 1000 < 4 && r(3) === 0) swapNext = true;
        const b = beamAt(tm, tk + 0.5), sub = tk & 3;
        if (!b.blanked) {
          if (sub === 0) {
            sim.setInput('sync', 1); sim.setInput('swap', swapNext ? 1 : 0); sim.settle();
            run.swapReq = swapNext;
          }
          // the pixel under the beam is word ra, byte sub, from the gate-level pixels port
          const q = sim.get('pixels', 1)[0], byte = Math.floor(q / 2 ** (8 * sub)) & 255;
          run.advance(tk + 1);
          expect(Math.floor(b.x) + FB_W * Math.floor(b.y), `tick ${tk}`).toBe(b.pixel);
          expect(run.litCol[b.pixel], `tick ${tk} colour`).toBe(byte);
          expect(run.litAt[b.pixel]).toBe(tk);
          checked++;
          if (sub === 3) { sim.cycle(); swapNext = false; active++; }
        } else {
          run.advance(tk + 1);
          expect(b.addr).toBe(-1);
        }
      }
      expect(checked).toBeGreaterThan(2 * W * W);
      expect(active).toBeGreaterThan(2 * WORDS - 4);
      expect(run.frames).toBeGreaterThanOrEqual(2);
    });
  }

  it('the word address of every active cycle is the scan-out counter (gate level)', () => {
    // BitSim of the bare SCAN_OUT clocked on the active cycles of each timing: ra equals the beam's addr
    for (const tm of [SCANOUT, VGA_SCALED]) {
      const sim = new BitSim(flatten(SCAN_OUT));
      sim.setInput('swap', 0); sim.setInput('sync', 1);
      let n = 0;
      for (let tk = 0; tk < frameTicks(tm) + 8; tk += 4) {
        const b = beamAt(tm, tk + 0.5);
        if (b.blanked) continue;
        sim.settle();
        expect(sim.get('ra', 1)[0], `${tm.id} tick ${tk}`).toBe(b.addr);
        sim.cycle(); n++;
      }
      expect(n).toBeGreaterThanOrEqual(WORDS);
    }
  });

  it('no cycle of our scan-out is blanked: the next word follows the last of a row, and word 0 follows word 1023', () => {
    for (let c = 0; c < 2 * WORDS; c++) expect(beamAt(SCANOUT, 4 * c + 2).addr).toBe(c % WORDS);
    expect(frameTicks(SCANOUT)).toBe(4 * WORDS);
  });

  it('the scan-out is held in blanking: the vga timeline has the same words, in the same order, with gaps', () => {
    let want = 0, seen = 0;
    for (let c = 0; c < frameTicks(VGA_SCALED) / 4; c++) {
      const b = beamAt(VGA_SCALED, 4 * c + 2);
      if (b.blanked) continue;
      expect(b.addr).toBe(want++ % WORDS);
      seen++;
    }
    expect(seen).toBe(WORDS);
    expect(frameTicks(VGA_SCALED) / 4).toBe(20 * 70);
  });
});

describe('VGA proportions', () => {
  it('640 x 480 @ 59.94 Hz: 800 x 525 at 25.175 MHz', () => {
    expect(hTotal(VGA_FULL)).toBe(800);
    expect(vTotal(VGA_FULL)).toBe(525);
    expect(VGA_PIXEL_CLOCK / 800).toBeCloseTo(31468.75, 2);
    expect(VGA_PIXEL_CLOCK / frameTicks(VGA_FULL)).toBeCloseTo(59.94, 2);
  });
  it('our scaled timeline keeps the blanking shares (20 % of a line, 8.6 % of a frame) to a pixel / a line', () => {
    const h = (hTotal(VGA_FULL) - VGA_FULL.hAct) / hTotal(VGA_FULL), v = (vTotal(VGA_FULL) - VGA_FULL.vAct) / vTotal(VGA_FULL);
    expect((hTotal(VGA_SCALED) - VGA_SCALED.hAct) / hTotal(VGA_SCALED)).toBeCloseTo(h, 2);
    expect(Math.abs((vTotal(VGA_SCALED) - VGA_SCALED.vAct) / vTotal(VGA_SCALED) - v)).toBeLessThan(0.01);
    expect(hTotal(VGA_SCALED) % 4).toBe(0);
  });
  it('sync pulses fall where VGA puts them: after the front porch, vertical sync 1 line after the active ones', () => {
    const t = VGA_SCALED;
    const hs = Array.from({ length: hTotal(t) }, (_, px) => beamAt(t, px + 0.5).hsync);
    expect(hs.indexOf(true)).toBe(t.hAct + t.hFp);
    expect(hs.filter(Boolean).length).toBe(t.hSync);
    const vs = Array.from({ length: vTotal(t) }, (_, l) => beamAt(t, l * hTotal(t) + 0.5).vsync);
    expect(vs.indexOf(true)).toBe(t.vAct + t.vFp);
  });
  it('the beam is blanked and returns during retrace: x back to 0, y back to 0, active everywhere else', () => {
    const t = VGA_SCALED, HT = hTotal(t);
    expect(beamAt(t, 63.9).phase).toBe('active');
    expect(beamAt(t, 64.5).phase).toBe('hretrace');
    expect(beamAt(t, HT - 0.01).x).toBeLessThan(0.5);
    expect(beamAt(t, 64 * HT + 3).phase).toBe('vretrace');
    expect(beamAt(t, frameTicks(t) - 0.01).y).toBeLessThan(0.1);
    expect(beamAt(t, 63 * HT + 63.5).y).toBeLessThan(64);
  });
});

describe('phosphor', () => {
  it('a struck cell fades; a cell the beam skipped never lights', () => {
    const run = new CrtRun(SCANOUT, pics);
    run.advance(100);
    const tau = decayTicks(SCANOUT, 1);
    expect(tau).toBeCloseTo((1 / (1000 / 59.94)) * 4096, 3);
    expect(run.glow(99, 99, tau)).toBe(1);
    expect(run.glow(99, 99 + tau, tau)).toBeCloseTo(Math.exp(-1), 6);
    expect(run.glow(500, 100, tau)).toBe(0);
  });
  it('the cells hold the frame the scan-out sent after a whole pass (bars, then rings from the frame after the one the swap was asked in)', () => {
    const run = new CrtRun(SCANOUT, pics);
    run.advance(4096);
    expect(Array.from(run.litCol)).toEqual(Array.from(bars));
    run.swapReq = true;
    run.advance(3 * 4096);
    expect(run.scan.front).toBe(1);
    expect(Array.from(run.litCol)).toEqual(Array.from(rings));
  });
});

const P: CrtPalette = { glass: [0.7, 0.8, 0.8], aquadag: [0.05, 0.05, 0.06], copper: [0.8, 0.45, 0.2], ferrite: [0.2, 0.2, 0.22], metal: [0.6, 0.6, 0.65],
  pin: [0.7, 0.7, 0.7], cellOff: [0.1, 0.1, 0.12], mask: [0.4, 0.4, 0.45], heater: [1, 0.5, 0.2], ghost: [0.8, 0.8, 0.8], bezel: [0.1, 0.1, 0.1] };

describe('the tube', () => {
  it('quotes its figures: 29.1 mm neck, 90 degrees to the corners, 4:3, ten stem pins', () => {
    expect(GEOM.NECK_OD).toBe(29.1);
    expect(GEOM.PINS).toBe(10);
    expect(GEOM.W_MM / GEOM.H_MM).toBeCloseTo(4 / 3, 9);
    expect((2 * Math.atan(Math.hypot(GEOM.W_MM, GEOM.H_MM) / 2 / GEOM.D) * 180) / Math.PI).toBeCloseTo(90, 9);
  });
  it('the yoke straddles the neck/funnel join and sits ahead of the gun', () => {
    expect(GEOM.YOKE_X0).toBeLessThan(GEOM.JOIN_X);
    expect(GEOM.YOKE_X1).toBeGreaterThan(GEOM.JOIN_X);
    expect(GEOM.GUN_EXIT).toBeLessThan(GEOM.YOKE_X0);
  });
  it('the funnel clears the beams to every corner of the screen, all along', () => {
    for (let x = 0; x <= GEOM.D; x += 5) for (const [sy, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const k = x / GEOM.D;
      expect(insideFunnel(x, (sy * GEOM.H_MM / 2) * k, (sz * GEOM.W_MM / 2) * k), `x ${x}`).toBe(true);
    }
  });
  it('the beam ends on the lit cell: its last point is the cell centre for the pixel under the beam', () => {
    for (const i of [0, 63, 64 * 32 + 20, 4095]) {
      const b = beamAt(SCANOUT, 4 * (i >> 2) + (i & 3) + 0.5), spot = spotOf(b.x, b.y), c = cellCentre(i);
      expect(b.pixel).toBe(i);
      expect(Math.abs(spot[2] - c[2])).toBeLessThan(GEOM.W_MM / 64 / 2 + 1e-9);
      expect(Math.abs(spot[1] - c[1])).toBeLessThan(GEOM.H_MM / 64 / 2 + 1e-9);
      const path = beamPath(0, spot);
      expect(path[path.length - 1]).toEqual(spot);
      expect(path[path.length - 1][0]).toBe(spot[0]);
    }
  });
  it('the beams come out of the gun in line and are aimed through the yoke: the last leg passes the deflection centre', () => {
    const spot = spotOf(10.2, 50.3), path = beamPath(0, spot), n = path.length;
    const a = path[n - 2], b = path[n - 1], t = (0 - a[0]) / (b[0] - a[0]);
    const atC = [a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    expect(Math.hypot(atC[0], atC[1])).toBeLessThan(1e-6);
    expect(path[0][0]).toBe(GEOM.GUN_EXIT);
  });
  it('yoke currents are the deflection: zero at the centre, +-1 at the edges, a sawtooth over a line', () => {
    expect(yokeCurrent({ x: 32, y: 32 })).toEqual({ h: 0, v: 0 });
    expect(yokeCurrent({ x: 0, y: 64 })).toEqual({ h: -1, v: 1 });
    const xs = Array.from({ length: 64 }, (_, i) => beamAt(SCANOUT, i + 0.5).x);
    expect(xs.every((x, i) => i === 0 || x > xs[i - 1])).toBe(true);
  });
  it('builds its parts: opaque and clear, 4096 cells, three beams while a pixel is lit, one faint ghost while blanked', () => {
    const st = staticParts(P), cell = () => levelsOf(0xff) as [number, number, number];
    expect(st.length).toBeGreaterThan(300);
    const b = beamAt(SCANOUT, 100.5), lv = levelsOf(0xff);
    const live = poseParts(P, { beam: b, levels: lv, cell, current: yokeCurrent(b) });
    const flat = poseParts(P, { beam: b, levels: lv, cell, current: yokeCurrent(b), bin: 2 });
    expect(live.length - flat.length).toBe(4096 - 1024);
    const dark = poseParts(P, { beam: beamAt(VGA_SCALED, 66 * hTotal(VGA_SCALED) + 3), levels: lv, cell, current: { h: 0, v: 0 } });
    expect(dark.length).toBeLessThan(live.length);
    for (const p of [...st, ...live]) { expect(p.pos.every(Number.isFinite)).toBe(true); expect((p.scale ?? [1, 1, 1]).every(Number.isFinite)).toBe(true); }
  });
});

describe('the three beams', () => {
  const S = GEOM.GUN_PITCH, spots = [spotOf(10.2, 50.3), spotOf(32, 32), spotOf(63.5, 0.5), spotOf(0.5, 63.5)];
  it('keep their 5.5 mm in-line offset through the yoke, and cross in the mask hole, not at the yoke', () => {
    for (const spot of spots) {
      const [r, g, b] = [-S, 0, S].map((z) => beamPath(z, spot)), mx = spot[0] - GEOM.Q;
      // at the yoke's front they are still 5.5 mm apart ...
      expect(pathAt(r, GEOM.YOKE_X1)[2] - pathAt(g, GEOM.YOKE_X1)[2]).toBeCloseTo(-S, 6);
      expect(pathAt(b, GEOM.YOKE_X1)[2] - pathAt(g, GEOM.YOKE_X1)[2]).toBeCloseTo(S, 6);
      // ... and in the plane of the mask hole all three are at one point
      for (const p of [r, b]) for (let k = 0; k < 3; k++) expect(pathAt(p, mx)[k]).toBeCloseTo(pathAt(g, mx)[k], 9);
      // the spread closes steadily from the yoke to the mask, then reopens behind it
      const gap = (x: number) => Math.abs(pathAt(b, x)[2] - pathAt(r, x)[2]);
      expect(gap(GEOM.YOKE_X1)).toBeCloseTo(2 * S, 6);
      expect(gap(0.5 * (GEOM.YOKE_X1 + mx))).toBeLessThan(gap(GEOM.YOKE_X1));
      expect(gap(mx)).toBeLessThan(1e-9);
      expect(gap(spot[0])).toBeGreaterThan(0);
      // the crossing is nowhere near the deflection centre
      expect(mx).toBeGreaterThan(GEOM.YOKE_X1 + 50);
    }
  });
  it('land on three dots TRIAD / 3 apart, the beam from -z on the +z dot, centred on the triad', () => {
    for (const spot of spots) {
      const dots = [-S, 0, S].map((z) => beamPath(z, spot).at(-1)!);
      expect(dots[0][2] - dots[1][2]).toBeCloseTo(GEOM.TRIAD / 3, 9);
      expect(dots[1][2] - dots[2][2]).toBeCloseTo(GEOM.TRIAD / 3, 9);
      expect(dots[1]).toEqual(spot);
    }
  });
  it('the mask-to-screen gap follows from the pitch and the gun spacing: Q * S / (D - Q) = TRIAD / 3', () => {
    expect((GEOM.Q * S) / (GEOM.D - GEOM.Q)).toBeCloseTo(GEOM.TRIAD / 3, 9);
    expect(GEOM.TRIAD).toBe(0.27);
    expect(GEOM.Q).toBeGreaterThan(1); expect(GEOM.Q).toBeLessThan(6);
    const [a, b, c] = [-S, 0, S].map(maskBeam);
    expect(a[1]).toEqual(b[1]); expect(b[1]).toEqual(c[1]); // the close-up's crossing
    expect(a[1][0]).toBeCloseTo(GEOM.D - GEOM.Q, 9);
    expect(a[2][2] - c[2][2]).toBeCloseTo((2 * GEOM.TRIAD) / 3, 9);
  });
  it('the curved face: the rim is pulled back by r^2 / 2R, the spot stays on the ray from the deflection centre', () => {
    expect(spotOf(32, 32)[0]).toBeCloseTo(GEOM.D, 3);
    const corner = spotOf(0, 0);
    expect(corner[0]).toBeLessThan(GEOM.D - 5);
    expect(GEOM.D - corner[0]).toBeCloseTo(sagAt(corner[1], corner[2]), 1);
    expect(corner[1] / corner[0]).toBeCloseTo(GEOM.H_MM / 2 / GEOM.D, 6);
  });
  it('the mask patch: 35 holes, a triad of dots behind each, and about 16 triads in one of our cells', () => {
    const parts = maskParts(P, [1, 1, 1], false);
    expect(MASK.COLS * MASK.ROWS).toBeGreaterThanOrEqual(30);
    expect(parts.length).toBeGreaterThan(MASK.COLS * MASK.ROWS * 3);
    expect(parts.length).toBeLessThan(260);
    expect(TRIADS_PER_CELL).toBeCloseTo(GEOM.W_MM / 64 / 0.27, 9);
    expect(Math.round(TRIADS_PER_CELL)).toBe(16);
    for (const p of parts) expect(p.pos.every(Number.isFinite)).toBe(true);
  });
  it('rings on the neck, three labels on a phone and every label named', () => {
    expect(magnetRings(P).length).toBe(36);
    expect(crtAnchors('overview', true).length).toBe(3);
    expect(crtAnchors('mask').some((a) => /beams cross/.test(a.text))).toBe(true);
    expect(crtAnchors('yoke').some((a) => /magnets/.test(a.text))).toBe(true);
    expect(crtAnchors('gun').some((a) => /about 10 pins/.test(a.text))).toBe(true);
  });
});

describe('broadcast interlace', () => {
  const T = NTSC_SCALED, HT = hTotal(T);
  it('525 lines at 4.5 MHz / 286: 63.56 us a line, 33.37 ms a frame, 59.94 fields a second', () => {
    expect(NTSC.LINE_HZ).toBeCloseTo(15734.2657, 3);
    expect(NTSC.lineUs()).toBeCloseTo(63.556, 3);
    expect(NTSC.frameMs()).toBeCloseTo(33.367, 3);
    expect(NTSC.fieldHz()).toBeCloseTo(59.94, 2);
    expect(NTSC.LINES / 2).toBe(NTSC.LINES_FIELD);
    expect(NTSC.CLOCK_601 / NTSC.SAMPLES_LINE).toBeCloseTo(NTSC.LINE_HZ, 0); // BT.601's 858 samples at 13.5 MHz
    expect(REAL_FRAME_MS).toBeCloseTo(1000 / NTSC.fieldHz(), 2);
  });
  it('scaled to 64 rows: the same shares, a whole field of 35 lines, a frame of two', () => {
    expect(HT).toBe(76); expect(HT % 4).toBe(0);
    expect(HT).toBe(Math.round(64 / (NTSC.SAMPLES_ACTIVE / NTSC.SAMPLES_LINE)));
    expect(T.vAct + T.vFp + T.vSync + T.vBp).toBeCloseTo((NTSC.LINES_FIELD * 64) / 480, 9);
    expect(T.vAct).toBe((NTSC.ACTIVE_FIELD * 64) / 480);
    expect(fieldTicks(T)).toBe(76 * 35);
    expect(frameTicks(T)).toBe(2 * fieldTicks(T));
    expect(frameTicks(T) / HT).toBe(70); // 525 lines x 64 / 480
  });
  it('the first field draws the odd lines (rows 0, 2, ...), the second the even ones, every row once a frame', () => {
    const seen = new Map<number, number[]>();
    for (let tk = 0; tk < frameTicks(T); tk++) {
      const b = beamAt(T, tk + 0.5);
      if (b.blanked) continue;
      expect(b.row % 2).toBe(b.field);
      expect(b.row).toBe(2 * b.line + b.field);
      expect(b.pixel).toBe(b.row * 64 + b.px);
      (seen.get(b.pixel) ?? seen.set(b.pixel, []).get(b.pixel)!).push(tk);
    }
    expect(seen.size).toBe(4096);
    for (const [, v] of seen) expect(v.length).toBe(1);
    expect(seen.get(0)![0]).toBeLessThan(fieldTicks(T));
    expect(Math.floor(seen.get(64)![0] / fieldTicks(T))).toBe(1);
  });
  it('the scan-out counter with its field bit moved to the row bottom reads the frame buffer in that order, in lock step with the beam', () => {
    const run = new CrtRun(T, pics), seenWords = new Set<number>();
    for (let tk = 0; tk < 2 * frameTicks(T); tk++) {
      const b = beamAt(T, tk + 0.5), sub = tk & 3;
      if (!b.blanked) {
        const o = run.scan.out();
        expect(b.addr, `tick ${tk}`).toBe(o.ra);
        expect(4 * memWord(o.ra, T) + sub, `tick ${tk}`).toBe(b.pixel);
        if (tk < frameTicks(T)) seenWords.add(memWord(o.ra, T));
      }
      run.advance(tk + 1);
    }
    expect(seenWords.size).toBe(WORDS);
    expect(run.frames).toBeGreaterThanOrEqual(1);
    for (let ra = 0; ra < WORDS; ra++) expect(memWord(ra, SCANOUT)).toBe(ra);
  });
  it('the beam is blanked between the fields and starts the other field on its first row', () => {
    const FF = fieldTicks(T);
    expect(beamAt(T, FF - 0.01).blanked).toBe(true);
    expect(beamAt(T, FF - 0.01).phase).toBe('vretrace');
    expect(Math.abs(beamAt(T, FF - 0.01).y - 1)).toBeLessThan(0.1); // the odd field ends on row 62, moves to row 1
    expect(Math.abs(beamAt(T, frameTicks(T) - 0.01).y)).toBeLessThan(0.1);
  });
  it('a fade of about a field leaves the other field dimmer: the comb', () => {
    const run = new CrtRun(T, pics), tau = decayTicks(T, 1, 16);
    run.advance(fieldTicks(T));
    expect(run.glow(0, fieldTicks(T) - 1, tau)).toBeGreaterThan(0);
    expect(run.glow(64, fieldTicks(T) - 1, tau)).toBe(0); // row 1 belongs to the next field
    run.advance(frameTicks(T));
    const t2 = frameTicks(T) - 1;
    expect(run.glow(64, t2, tau)).toBeGreaterThan(run.glow(0, t2, tau));
  });
});

describe('the Mask view labels (batch 24 review)', () => {
  it('names the hole the three beams cross in, and puts the mask label on steel', () => {
    const a = crtAnchors('mask'), hole = a.find((x) => /cross in this hole/.test(x.text))!, steel = a.find((x) => /steel shadow mask/.test(x.text))!;
    const mx = GEOM.D - GEOM.Q, T = GEOM.TRIAD;
    // every beam passes the hole's axis (y = z = 0) at the mask
    for (const zi of [-GEOM.GUN_PITCH, 0, GEOM.GUN_PITCH]) { const m = maskBeam(zi)[1]; expect(m[0]).toBeCloseTo(mx, 9); expect(m[1]).toBe(0); expect(m[2]).toBe(0); }
    expect(hole.p[1]).toBe(0); expect(hole.p[2]).toBe(0); expect(hole.p[0]).toBeCloseTo(mx - MASK.THICK, 9);
    // steel: off every hole by more than half a hole in y (rows are a pitch apart)
    const dy = Math.abs(steel.p[1] / T - Math.round(steel.p[1] / T)) * T;
    expect(dy).toBeGreaterThan(MASK.HOLE / 2);
  });
});
