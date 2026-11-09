// src/fpga/fpgacosts.json (scripts/fpga-pnr.ts --write, .github/workflows/fpga.yml) is measured on the sandbox's FPGA
// export of each example: when the export changes, the numbers are stale, so the hash of what the export writes now
// must equal the one they were measured on. Run `npx vite-node scripts/fpga-pnr.ts --write` (needs yowasp-yosys and
// yowasp-nextpnr-himbaechel-gowin from pip) or the fpga workflow, and commit the file.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { fpgaExport } from '../src/editor/fpga';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { exportHash, type FpgaCosts } from '../src/fpga/costs';
import costs from '../src/fpga/fpgacosts.json';

const data = costs as FpgaCosts;

describe('the FPGA numbers', () => {
  for (const [id, ex] of Object.entries(data.examples)) {
    it(`${id}: measured on the export as it is now`, () => {
      const e = EXAMPLES.find((x) => x.id === id)!;
      const { ws, id: chip } = addExample(emptyWorkspace(), e);
      const out = fpgaExport(new UserLibrary(ws).compiled(chip)!.def, id);
      expect(out.ok).toBe(true);
      expect(exportHash(out.files), `${id}: the export changed; run scripts/fpga-pnr.ts --write`).toBe(ex.exportHash);
    }, 60_000);

    it(`${id}: the numbers hang together`, () => {
      for (const u of Object.values(ex.device)) expect(u.used).toBeLessThanOrEqual(u.available);
      expect(ex.fmax.clk).toBeGreaterThan(0);
      const c = ex.critical;
      expect(c.skew + c.clkToQ + c.logic + c.routing + c.setup).toBeCloseTo(c.ns, 2);
      expect(ex.ours.lutLevels).toBeGreaterThan(0);
    });
  }

  it('records the tools it was measured with', () => {
    expect(data.tools.yosys).toMatch(/^Yosys \d/);
    expect(data.tools.nextpnr).toMatch(/^nextpnr-\d/);
    expect(Object.keys(data.examples).sort()).toEqual(['computer', 'counter7']);
  });
});
