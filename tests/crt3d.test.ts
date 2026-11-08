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
      expect(path[path.length - 1][0]).toBe(GEOM.D);
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
