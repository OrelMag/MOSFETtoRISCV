// The Teletype Model 33 selector: its levers read what the chapter's receiver model reads, for every character and clock
// error; one revolution per character, at rest before the next start; the drawing puts each notch under its lever in the
// middle of its unit.
import { describe, expect, it } from 'vitest';
import { REV_UNITS, TTY33, UNIT_MS, leverWord, notchDeg, startStopWord, ttyCode, ttyPose } from '../src/comm/teletype33';
import { frameUnits, receive, toleranceClosedForm } from '../src/comm/startstop';
import { CAM_R, NOTCH_DEPTH, DROP_ANGLE, TIP, camOutline, leverPoints, notchAt, teletypeModel } from '../src/widgets/teletype3dkit';

describe('the Model 33 selector, as a model', () => {
  it('110 baud, 11 units, 100 ms a character, ASCII with even parity', () => {
    expect(frameUnits(TTY33)).toBe(11);
    expect(UNIT_MS * frameUnits(TTY33)).toBeCloseTo(100, 0);
    expect(ttyCode('A')).toBe(0x41); // two ones: parity 0
    expect(ttyCode('C')).toBe(0xc3); // three ones: parity 1
    for (let c = 32; c < 127; c++) { let ones = 0; const w = ttyCode(String.fromCharCode(c)); for (let i = 0; i < 8; i++) ones += (w >> i) & 1; expect(ones % 2).toBe(0); }
  });
  it('the levers read what startstop.ts receive() reads, for every byte and clock error', () => {
    for (let code = 0; code < 256; code++) for (const err of [-0.08, -0.06, -0.055, -0.03, 0, 0.02, 0.05, 0.055, 0.06, 0.08]) {
      expect(leverWord(code, err)).toBe(receive(TTY33, code, { err }).word);
      expect(startStopWord(code, err)).toBe(receive(TTY33, code, { err }).word);
    }
  });
  it('reads right within the chapter’s tolerance and wrong just beyond it', () => {
    const tol = toleranceClosedForm(TTY33);
    const allRight = (err: number) => Array.from({ length: 256 }, (_, c) => leverWord(c, err) === c).every(Boolean);
    expect(allRight(tol.fast - 1e-4)).toBe(true);
    expect(allRight(-tol.slow + 1e-4)).toBe(true);
    expect(allRight(-tol.slow - 0.005)).toBe(false);
  });
  it('one revolution per character, at rest before the next start even with the motor slow', () => {
    for (const err of [-0.08, 0, 0.08]) {
      expect(ttyPose(0x41, err, -0.5).sleeve).toBe(0);
      const end = ttyPose(0x41, err, REV_UNITS / (1 + err) + 1e-6);
      expect(end.sleeve).toBe(360);
      expect(end.clutch).toBe(false);
      expect(REV_UNITS / (1 + err)).toBeLessThan(frameUnits(TTY33));
    }
    expect(ttyPose(0x41, 0, 5).clutch).toBe(true);
  });
  it('a lever drops only for a marking unit, at its notch; push levers hold what was read', () => {
    const code = ttyCode('A'); // 0100 0001: d0 = 1, d1 = 0
    expect(ttyPose(code, 0, 1.5).drop[0]).toBeCloseTo(1, 9);
    expect(ttyPose(code, 0, 2.5).drop[1]).toBe(0);
    expect(ttyPose(code, 0, 3).drop[0]).toBe(0);
    const p = ttyPose(code, 0, 10.5);
    expect(p.set).toEqual([true, false, false, false, false, false, true, false]);
  });
});

describe('the Model 33 selector, as drawn', () => {
  it('each notch is under its lever exactly in the middle of its unit', () => {
    for (let i = 0; i < 8; i++) {
      expect(notchAt(i, notchDeg(i))).toBeCloseTo(90, 9);
      const sleeveMid = ttyPose(0, 0, 1 + i + 0.5).sleeve;
      expect(sleeveMid).toBeCloseTo(notchDeg(i), 9);
      // the cam's lowest point is then at the top, NOTCH_DEPTH below the rim
      const top = Math.max(...camOutline(i, sleeveMid).filter(([, v]) => Math.abs(v) < 0.5).map(([u]) => u));
      expect(top).toBeLessThan(CAM_R - NOTCH_DEPTH * 0.9);
    }
  });
  it('a dropped lever’s tip sits the notch’s depth lower; its tail rises', () => {
    const [, , tip] = leverPoints(DROP_ANGLE), [tail0, , tip0] = leverPoints(0), [tail] = leverPoints(DROP_ANGLE);
    expect(tip0).toEqual(TIP);
    expect(tip[1]).toBeLessThan(TIP[1] - NOTCH_DEPTH * 0.8);
    expect(tail[1]).toBeGreaterThan(tail0[1]);
  });
  it('the model builds at every moment, the clutch and line lit by the state', () => {
    for (const t of [-1, 0.2, 3.5, 9.9, 10.5]) {
      const m = teletypeModel(ttyPose(ttyCode('A'), 0, t));
      for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
      expect(m.items.find((i) => i.name === 'the line')!.mat.emit !== undefined).toBe(ttyPose(ttyCode('A'), 0, t).level === 1);
    }
    expect(teletypeModel(ttyPose(0x41, 0, 5)).beats).toHaveLength(5);
  });
});
