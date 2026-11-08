// Numbers the pcie / ethernet / switch / network chapters type in their prose (where they cannot be computed in place) equal the
// models they describe, and the computed ones read as intended. The codex entries' own numbers are pinned by content-codexcomm*.test.ts.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { chapterById } from '../src/chapters';
import { binomialTail, runTraffic, sharedCapacity } from '../src/comm/ethswitch';
import { HEADER_BYTES } from '../src/comm/ethframe';

const text = (id: string) => {
  const ch = chapterById(id)!;
  const parts: string[] = [];
  for (const s of ch.steps) { parts.push(s.body); if (s.challenge && s.challenge.kind === 'quiz') parts.push(s.challenge.explain, ...s.challenge.options); }
  parts.push(...(ch.recap?.keep ?? []));
  return parts.join('\n');
};

describe('switch chapter', () => {
  it('the 50-source quiz states the capacity at the convention "overflow = more than u busy"', () => {
    const q = sharedCapacity(50, 0.05, 1e-6);
    expect(q).toBe(12);
    expect(binomialTail(50, 0.05, q)).toBeLessThan(1e-6);
    expect(binomialTail(50, 0.05, q - 1)).toBeGreaterThan(1e-6);
    expect(text('switch')).toContain(`${q} units, plus a queue`);
  });

  it('the typed head-of-line figures equal the switch model (64-byte frames, full load, as the widget runs them)', () => {
    const o = (voq: boolean, cells: number) => runTraffic({ pattern: 'uniform', load: 1, frameBytes: 64, cycles: 40000, seed: 11, opts: { cellK: 7, voq, cells } }).throughput;
    const t = text('switch');
    expect(Math.abs(o(false, 4) - 0.68)).toBeLessThan(0.01);
    expect(Math.abs(o(true, 4) - 0.80)).toBeLessThan(0.01);
    expect(Math.abs(o(true, 8) - 0.88)).toBeLessThan(0.01);
    expect(Math.abs(o(true, 16) - 0.92)).toBeLessThan(0.01);
    for (const v of ['0.68', '0.80', '0.88', '0.92']) expect(t).toContain(v);
  });
});

describe('pcie, ethernet and network chapters', () => {
  it('name PCIe\'s generation, and say which chapters they follow', () => {
    expect(text('pcie')).toContain('PCIe 5.0 at ×16');
    expect(chapterById('pcie')!.builds).toEqual(expect.arrayContaining(['serial', 'clocks', 'errors', 'codes', 'bus']));
    expect(chapterById('ethernet')!.builds).toEqual(expect.arrayContaining(['pcie', 'wire']));
  });

  it('ethernet expands CSMA/CD where it first uses it, and its frame headers are 14 bytes', () => {
    expect(text('ethernet')).toMatch(/CSMA\/CD<\/strong> \(carrier sense, multiple access with collision detection/);
    expect(HEADER_BYTES).toBe(14);
  });

  it('network: an echo or datagram has 128 - 42 bytes of data room in the bench switch cell', () => {
    expect(text('network')).toContain(`${128 - (14 + 20 + 8)} bytes of data`);
  });
});
