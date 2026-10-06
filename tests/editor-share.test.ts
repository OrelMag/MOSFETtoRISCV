// Share links: both encodings round-trip, damaged links are refused, and committed fixtures
// keep the format from drifting (old links must keep opening).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChipDoc } from '../src/editor/model';
import { decodeShare, encodeShare } from '../src/editor/share';

const XOR: ChipDoc[] = [{
  id: 'u_xor', name: 'XOR ⊕ Ünïcode',
  pins: [{ id: 'pin1', name: 'a', dir: 'in', width: 1, at: [0, 1] }, { id: 'pin2', name: 'y', dir: 'out', width: 1, at: [12, 2] }],
  parts: [{ id: 'g1', ref: { lib: 'nand' }, at: [4, 0] }],
  wires: [{ id: 'w1', a: { pin: 'pin1' }, b: { part: 'g1', port: 'a' }, pts: [] }, { id: 'w2', a: { part: 'g1', port: 'y' }, b: { pin: 'pin2' }, pts: [] }],
  labels: [{ id: 'l1', name: 'clk', at: [2, 6], face: 'left' }],
}];

// Written once (Node 22's CompressionStream); any conforming inflater must read them back.
const FIXTURE_Z = '1zZdBBasMwEAXQq4S_nkUsShe6RKGrghFlbMmtqCoLVcENQRfoPrvcoYfITXqSImNHhuzESG_-jNoTrIbE4fV7jCB4_jSQeHl63v39nHfXi7_-9qM2IATrvyDbBQTrm_qeQdA2QsJ6ECar0ztkQ-AE2e6pUZkqFBUeb3A8pHvZCBIqK0LgmDbpbyU7mgHyBGc7SHj2GnlhD7Sf1WSj2aipKC4mWL_ukAndXOKY1s5hnM9cLsOcW-efxK3JvTjWdmuC2DZRBMedcZuh3OYbe_eBZQVBj4owcF_qzgwJWWX1Dw';
const FIXTURE_J = '1jW3siaWQiOiJ1X3hvciIsIm5hbWUiOiJYT1Ig4oqVIMOcbsOvY29kZSIsInBpbnMiOlt7ImlkIjoicGluMSIsIm5hbWUiOiJhIiwiZGlyIjoiaW4iLCJ3aWR0aCI6MSwiYXQiOlswLDFdfSx7ImlkIjoicGluMiIsIm5hbWUiOiJ5IiwiZGlyIjoib3V0Iiwid2lkdGgiOjEsImF0IjpbMTIsMl19XSwicGFydHMiOlt7ImlkIjoiZzEiLCJyZWYiOnsibGliIjoibmFuZCJ9LCJhdCI6WzQsMF19XSwid2lyZXMiOlt7ImlkIjoidzEiLCJhIjp7InBpbiI6InBpbjEifSwiYiI6eyJwYXJ0IjoiZzEiLCJwb3J0IjoiYSJ9LCJwdHMiOltdfSx7ImlkIjoidzIiLCJhIjp7InBhcnQiOiJnMSIsInBvcnQiOiJ5In0sImIiOnsicGluIjoicGluMiJ9LCJwdHMiOltdfV0sImxhYmVscyI6W3siaWQiOiJsMSIsIm5hbWUiOiJjbGsiLCJhdCI6WzIsNl0sImZhY2UiOiJsZWZ0In1dfV0';

describe('share links', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips compressed, URL-safe, without padding', async () => {
    const s = await encodeShare(XOR);
    expect(s).toMatch(/^1z[A-Za-z0-9_-]+$/);
    expect(await decodeShare(s)).toEqual(XOR);
  });

  it('falls back to plain JSON without CompressionStream', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const s = await encodeShare(XOR);
    expect(s).toBe(FIXTURE_J);
    expect(await decodeShare(s)).toEqual(XOR);
  });

  it('reads the committed fixtures', async () => {
    expect(await decodeShare(FIXTURE_Z)).toEqual(XOR);
    expect(await decodeShare(`  ${FIXTURE_J}\n`)).toEqual(XOR);
  });

  it('round-trips a large circuit', async () => {
    const big: ChipDoc[] = [{ ...XOR[0], parts: Array.from({ length: 3000 }, (_, i) => ({ id: `g${i + 1}`, ref: { lib: 'nand' }, at: [i % 50, i] as [number, number] })) }];
    const s = await encodeShare(big);
    expect(s.length).toBeLessThan(JSON.stringify(big).length / 4);
    expect(await decodeShare(s)).toEqual(big);
  });

  it('refuses garbage', async () => {
    for (const bad of ['', 'hello', '1z', '1z!!!!', '1zAAAA', '2zAAAA', '1j' + btoa('not json'), '1j' + btoa('{"a":1}'), '1j' + btoa('[{"name":"x"}]'), FIXTURE_Z.slice(0, 40)]) {
      expect(await decodeShare(bad), bad).toEqual({ error: expect.any(String) });
    }
  });

  it('sanitizes what it decodes', async () => {
    const s = '1j' + btoa(JSON.stringify([{ id: 'u_a', pins: [{ id: 'p', name: 'bad name', dir: 'in', width: 1, at: [0, 0] }] }])).replace(/=+$/, '');
    expect(await decodeShare(s)).toEqual([{ id: 'u_a', name: 'u_a', pins: [], parts: [], wires: [], labels: [] }]);
  });
});
