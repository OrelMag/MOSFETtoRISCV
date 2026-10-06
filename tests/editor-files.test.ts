// Sandbox files and links (editor/files.ts): the share route, download names, import summaries,
// duplicating and deleting chips, and a share link carried end to end into a workspace that
// already has a different chip under the same id.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chipFileName, chipInfo, deleteChip, duplicateChip, fileBase, shareHash, shareRoute, shareUrl, summarize, summaryLine, workspaceFileName,
} from '../src/editor/files';
import { UserLibrary } from '../src/editor/library';
import type { ChipDoc } from '../src/editor/model';
import { decodeShare, encodeShare } from '../src/editor/share';
import { closure, importChips, importJson, exportJson } from '../src/editor/store';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { chip, halfAdder, part, pin, wire, workspace } from './editorkit';

/** Full adder from two user half adders and an OR. */
const fullAdder = (): ChipDoc => chip('u_fa', 'FA', {
  pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('cin', 'in', [0, 10]), pin('s', 'out', [40, 2]), pin('cout', 'out', [40, 10])],
  parts: [part('h1', { chip: 'u_ha' }, [6, 0]), part('h2', { chip: 'u_ha' }, [18, 0]), part('o', { lib: 'or' }, [30, 8])],
  wires: [
    wire('w1', 'pin:a', 'h1.a'), wire('w2', 'pin:b', 'h1.b'), wire('w3', 'h1.s', 'h2.a'), wire('w4', 'pin:cin', 'h2.b'),
    wire('w5', 'h2.s', 'pin:s'), wire('w6', 'h1.c', 'o.a'), wire('w7', 'h2.c', 'o.b'), wire('w8', 'o.y', 'pin:cout'),
  ],
});

/** Someone else's u_ha: a NOT that happens to have the same id. */
const otherHa = (): ChipDoc => chip('u_ha', 'My gadget', {
  pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [10, 2])],
  parts: [part('g', { lib: 'not' }, [4, 1])],
  wires: [wire('w1', 'pin:a', 'g.a'), wire('w2', 'g.y', 'pin:y')],
});

const expectFullAdder = (lib: UserLibrary, id: string) => {
  expect(lib.compiled(id)!.diags).toEqual([]);
  const def = lib.defOf(id)!;
  const sim = simulate(def);
  forEachInput(def, ([a, b, c]) => expect(evalOnce(sim, [a, b, c])).toEqual([(a + b + c) & 1, (a + b + c) >> 1]));
};

// The 2-chip share link above in its plain-JSON form ('1j'), committed so the route and the
// payload format cannot drift: links already sent must keep opening.
const FIXTURE_URL = 'https://example.org/mosfet/#/sandbox/s/';
const FIXTURE =
  '1jW3siaWQiOiJ1X2hhIiwibmFtZSI6IkhBIiwicGlucyI6W3siaWQiOiJhIiwibmFtZSI6ImEiLCJkaXIiOiJpbiIsIndpZHRoIjoxLCJhdCI6WzAsMl19LHsiaWQiOiJiIiwibmFtZSI6ImIiLCJkaXIiOiJpbiIsIndpZHRoIjoxLCJhdCI6WzAsNl19LHsiaWQiOiJzIiwibmFtZSI6InMiLCJkaXIiOiJvdXQiLCJ3aWR0aCI6MSwiYXQiOlsyMCwzXX0seyJpZCI6ImMiLCJuYW1lIjoiYyIsImRpciI6Im91dCIsIndpZHRoIjoxLCJhdCI6WzIwLDldfV0sInBhcnRzIjpbeyJpZCI6IngiLCJyZWYiOnsibGliIjoieG9yIn0sImF0IjpbOCwxXX0seyJpZCI6Im4iLCJyZWYiOnsibGliIjoiYW5kIn0sImF0IjpbOCw3XX1dLCJ3aXJlcyI6W3siaWQiOiJ3MSIsImEiOnsicGluIjoiYSJ9LCJiIjp7InBhcnQiOiJ4IiwicG9ydCI6ImEifSwicHRzIjpbXX0seyJpZCI6IncyIiwiYSI6eyJ3aXJlIjoidzEiLCJhdCI6WzQsMl19LCJiIjp7InBhcnQiOiJuIiwicG9ydCI6ImEifSwicHRzIjpbWzQsOF1dfSx7ImlkIjoidzMiLCJhIjp7InBpbiI6ImIifSwiYiI6eyJwYXJ0IjoieCIsInBvcnQiOiJiIn0sInB0cyI6W1s2LDZdLFs2LDRdXX0seyJpZCI6Inc0IiwiYSI6eyJ3aXJlIjoidzMiLCJhdCI6WzYsNl19LCJiIjp7InBhcnQiOiJuIiwicG9ydCI6ImIifSwicHRzIjpbWzYsMTBdXX0seyJpZCI6Inc1IiwiYSI6eyJwYXJ0IjoieCIsInBvcnQiOiJ5In0sImIiOnsicGluIjoicyJ9LCJwdHMiOltdfSx7ImlkIjoidzYiLCJhIjp7InBpbiI6ImMifSwiYiI6eyJwYXJ0IjoibiIsInBvcnQiOiJ5In0sInB0cyI6W119XSwibGFiZWxzIjpbXX0seyJpZCI6InVfZmEiLCJuYW1lIjoiRkEiLCJwaW5zIjpbeyJpZCI6ImEiLCJuYW1lIjoiYSIsImRpciI6ImluIiwid2lkdGgiOjEsImF0IjpbMCwyXX0seyJpZCI6ImIiLCJuYW1lIjoiYiIsImRpciI6ImluIiwid2lkdGgiOjEsImF0IjpbMCw0XX0seyJpZCI6ImNpbiIsIm5hbWUiOiJjaW4iLCJkaXIiOiJpbiIsIndpZHRoIjoxLCJhdCI6WzAsMTBdfSx7ImlkIjoicyIsIm5hbWUiOiJzIiwiZGlyIjoib3V0Iiwid2lkdGgiOjEsImF0IjpbNDAsMl19LHsiaWQiOiJjb3V0IiwibmFtZSI6ImNvdXQiLCJkaXIiOiJvdXQiLCJ3aWR0aCI6MSwiYXQiOls0MCwxMF19XSwicGFydHMiOlt7ImlkIjoiaDEiLCJyZWYiOnsiY2hpcCI6InVfaGEifSwiYXQiOls2LDBdfSx7ImlkIjoiaDIiLCJyZWYiOnsiY2hpcCI6InVfaGEifSwiYXQiOlsxOCwwXX0seyJpZCI6Im8iLCJyZWYiOnsibGliIjoib3IifSwiYXQiOlszMCw4XX1dLCJ3aXJlcyI6W3siaWQiOiJ3MSIsImEiOnsicGluIjoiYSJ9LCJiIjp7InBhcnQiOiJoMSIsInBvcnQiOiJhIn0sInB0cyI6W119LHsiaWQiOiJ3MiIsImEiOnsicGluIjoiYiJ9LCJiIjp7InBhcnQiOiJoMSIsInBvcnQiOiJiIn0sInB0cyI6W119LHsiaWQiOiJ3MyIsImEiOnsicGFydCI6ImgxIiwicG9ydCI6InMifSwiYiI6eyJwYXJ0IjoiaDIiLCJwb3J0IjoiYSJ9LCJwdHMiOltdfSx7ImlkIjoidzQiLCJhIjp7InBpbiI6ImNpbiJ9LCJiIjp7InBhcnQiOiJoMiIsInBvcnQiOiJiIn0sInB0cyI6W119LHsiaWQiOiJ3NSIsImEiOnsicGFydCI6ImgyIiwicG9ydCI6InMifSwiYiI6eyJwaW4iOiJzIn0sInB0cyI6W119LHsiaWQiOiJ3NiIsImEiOnsicGFydCI6ImgxIiwicG9ydCI6ImMifSwiYiI6eyJwYXJ0IjoibyIsInBvcnQiOiJhIn0sInB0cyI6W119LHsiaWQiOiJ3NyIsImEiOnsicGFydCI6ImgyIiwicG9ydCI6ImMifSwiYiI6eyJwYXJ0IjoibyIsInBvcnQiOiJiIn0sInB0cyI6W119LHsiaWQiOiJ3OCIsImEiOnsicGFydCI6Im8iLCJwb3J0IjoieSJ9LCJiIjp7InBpbiI6ImNvdXQifSwicHRzIjpbXX1dLCJsYWJlbHMiOltdfV0';

describe('share route', () => {
  it('finds the payload of #/sandbox/s/<payload> only', () => {
    expect(shareRoute('#/sandbox/s/1zAbC-_9')).toBe('1zAbC-_9');
    expect(shareRoute('#sandbox/s/1jxyz/')).toBe('1jxyz');
    for (const h of ['', '#/', '#/sandbox', '#/sandbox/u_main', '#/sandbox/s', '#/sandbox/s/', '#/sandbox/s/a/b', '#/workbench/s/1zA']) expect(shareRoute(h), h).toBeNull();
  });

  it('builds a link on the current page, replacing its hash', () => {
    expect(shareHash('1zQ')).toBe('#/sandbox/s/1zQ');
    expect(shareUrl('https://x.org/site/?a=1#/sandbox/u_top', '1zQ')).toBe('https://x.org/site/?a=1#/sandbox/s/1zQ');
    expect(shareUrl('http://localhost:4313/', '1jQ')).toBe('http://localhost:4313/#/sandbox/s/1jQ');
  });
});

describe('file names', () => {
  it('keeps names readable and safe', () => {
    expect(fileBase('Full adder')).toBe('Full-adder');
    expect(fileBase('a/b:c*?"<>|d')).toBe('a_b_c_d');
    expect(fileBase('  ..  ')).toBe('chip');
    expect(fileBase('Ünïcode ⊕')).toBe('Ünïcode-⊕');
    expect(fileBase('x'.repeat(200)).length).toBe(80);
    expect(chipFileName({ name: '4-bit ALU' })).toBe('4-bit-ALU.chip.json');
    expect(workspaceFileName(new Date(2026, 0, 5))).toBe('sandbox-chips-2026-01-05.json');
  });
});

describe('chip management', () => {
  const ws = workspace(fullAdder(), halfAdder());

  it('reports size and users', () => {
    expect(chipInfo(ws, 'u_ha')).toEqual({ parts: 2, wires: 6, pins: 4, usedBy: ['u_fa'] });
    expect(chipInfo(ws, 'u_fa').usedBy).toEqual([]);
  });

  it('duplicates under a new id and name, right after the original', () => {
    const r = duplicateChip(ws, 'u_ha')!;
    expect(r.id).toBe('u_ha_copy');
    expect(Object.keys(r.ws.chips)).toEqual(['u_fa', 'u_ha', 'u_ha_copy']);
    const c = r.ws.chips.u_ha_copy;
    expect(c).toEqual({ ...ws.chips.u_ha, id: 'u_ha_copy', name: 'HA copy' });
    expect(c.parts).not.toBe(ws.chips.u_ha.parts);
    expect(ws.chips.u_ha_copy).toBeUndefined();
    const again = duplicateChip(r.ws, 'u_ha')!;
    expect(again.ws.chips[again.id].name).toBe('HA copy 2');
    expect(duplicateChip(ws, 'nope')).toBeNull();
    // The copy simulates like the original.
    const lib = new UserLibrary(r.ws);
    expect(lib.compiled('u_ha_copy')!.diags).toEqual([]);
  });

  it('refuses to delete a chip in use, and names the users', () => {
    expect(deleteChip(ws, 'u_ha')).toEqual({ error: 'used by FA', usedBy: ['u_fa'] });
  });

  it('deletes, keeping an open tab and never an empty workspace', () => {
    const r = deleteChip(ws, 'u_fa');
    if ('error' in r) throw new Error(r.error);
    expect(Object.keys(r.ws.chips)).toEqual(['u_ha']);
    expect(r.ws.open).toEqual(['u_ha']);
    const last = deleteChip(r.ws, 'u_ha');
    if ('error' in last) throw new Error(last.error);
    expect(Object.keys(last.ws.chips)).toEqual(['u_main']);
    expect(last.ws.open).toEqual(['u_main']);
  });
});

describe('import summary', () => {
  it('numbers the name of a renamed chip whose name is taken too', () => {
    const r = importJson(exportJson(workspace(fullAdder(), halfAdder()), ['u_fa']), workspace({ ...otherHa(), name: 'HA' }));
    if ('error' in r) throw new Error(r.error);
    expect(r.ws.chips.u_ha.name).toBe('HA');
    expect(r.ws.chips.u_ha_2.name).toBe('HA 2');
    expect(summarize(r).renamed).toEqual([{ from: 'u_ha', to: 'u_ha_2', name: 'HA 2' }]);
    // Again: recognized as the same chips despite the new name.
    const again = importJson(exportJson(workspace(fullAdder(), halfAdder()), ['u_fa']), r.ws);
    if ('error' in again) throw new Error(again.error);
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual(['u_ha_2', 'u_fa']);
  });

  it('names what was added, renamed and skipped, and opens the top chip', () => {
    const target = workspace(otherHa());
    const r = importJson(exportJson(workspace(fullAdder(), halfAdder()), ['u_fa']), target);
    if ('error' in r) throw new Error(r.error);
    const s = summarize(r);
    expect(s.added).toEqual([{ id: 'u_ha_2', name: 'HA' }, { id: 'u_fa', name: 'FA' }]);
    expect(s.renamed).toEqual([{ from: 'u_ha', to: 'u_ha_2', name: 'HA' }]);
    expect(s.skipped).toEqual([]);
    expect(s.open).toBe('u_fa');
    expect(summaryLine(s)).toBe('2 chips added (1 renamed)');
    // The same file again: everything is already there (u_ha under the id it was renamed to).
    const again = importJson(exportJson(workspace(fullAdder(), halfAdder()), ['u_fa']), r.ws);
    if ('error' in again) throw new Error(again.error);
    const s2 = summarize(again);
    expect(s2.added).toEqual([]);
    expect(s2.skipped.map((c) => c.id)).toEqual(['u_ha_2', 'u_fa']);
    expect(again.ws).toBe(r.ws);
    expect(s2.open).toBe('u_fa');
    expect(summaryLine(s2)).toBe('2 already here');
  });
});

describe('a share link, end to end', () => {
  afterEach(() => vi.unstubAllGlobals());
  const source = workspace(fullAdder(), halfAdder());

  const importInto = async (url: string) => {
    const payload = shareRoute(new URL(url).hash);
    expect(payload).not.toBeNull();
    const chips = await decodeShare(payload!);
    if ('error' in chips) throw new Error(chips.error);
    expect(chips.map((c) => c.id)).toEqual(['u_ha', 'u_fa']);
    const mine = otherHa();
    const r = importChips(chips, workspace(mine));
    // The user's own u_ha is untouched; the shared one comes in beside it.
    expect(r.ws.chips.u_ha).toBe(mine);
    expect(r.renamed).toEqual({ u_ha: 'u_ha_2' });
    expect(r.added).toEqual(['u_ha_2', 'u_fa']);
    expect(r.ws.chips.u_fa.parts.filter((p) => 'chip' in p.ref).map((p) => p.ref)).toEqual([{ chip: 'u_ha_2' }, { chip: 'u_ha_2' }]);
    expect(summarize(r).open).toBe('u_fa');
    // Identical to the source apart from the renamed reference, and it still adds.
    expect({ ...r.ws.chips.u_ha_2, id: 'u_ha' }).toEqual(source.chips.u_ha);
    expectFullAdder(new UserLibrary(r.ws), 'u_fa');
  };

  it('built from a workspace (compressed) imports into a conflicting one', async () => {
    const url = shareUrl('https://example.org/mosfet/#/sandbox/u_fa', await encodeShare(closure(source, ['u_fa'])));
    expect(url).toMatch(/^https:\/\/example\.org\/mosfet\/#\/sandbox\/s\/1z[A-Za-z0-9_-]+$/);
    await importInto(url);
  });

  it('the committed plain-JSON fixture still opens', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const payload = await encodeShare(closure(source, ['u_fa']));
    expect(FIXTURE_URL + payload).toBe(FIXTURE_URL + FIXTURE);
    vi.unstubAllGlobals();
    await importInto(FIXTURE_URL + FIXTURE);
  });
});
