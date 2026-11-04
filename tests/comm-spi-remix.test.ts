// "Open in Sandbox" on chapter 44's scenes and blocks: the remix does not fail, every library reference resolves on a fresh load,
// and the chip compiled in the sandbox has the same ports.

import { describe, expect, it } from 'vitest';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { remixDef, stableRef } from '../src/editor/remix';
import { i2cBus, i2cController, i2cTarget, i2cWired2, I2C_PAD } from '../src/lib/i2c';
import { resolveComponent } from '../src/lib/resolve';
import { spiDevice, spiMaster, spiPair } from '../src/lib/spi';
import type { ComponentDef } from '../src/sim/types';

const io = (d: ComponentDef) => d.ports.map((p) => `${p.name} ${p.dir} ${p.width}`).sort();

describe('chapter 44: Open in Sandbox', () => {
  const defs: [string, () => ComponentDef][] = [
    ['spi_pair', spiPair], ['spi_master', spiMaster], ['spi_device', spiDevice], ['i2c_wired2', i2cWired2], ['i2c_pad', () => I2C_PAD],
    ['i2c_controller', i2cController], ['i2c_target', i2cTarget], ['i2c bus 1+1', () => i2cBus(1, [{ adr: 0x50 }])], ['i2c bus 2+1', () => i2cBus(2, [{ adr: 0x50 }])],
  ];
  for (const [name, mk] of defs) {
    it(`${name} remixes into a chip with the same ports`, () => {
      const def = mk();
      const r = remixDef(emptyWorkspace(), def);
      if ('error' in r) throw new Error(r.error);
      const doc = r.ws.chips[r.id];
      for (const p of doc.parts) if ('lib' in p.ref) expect(stableRef(resolveComponent(p.ref.lib)!), p.ref.lib).toBe(true);
      const back = new UserLibrary(r.ws).defOf(r.id)!;
      expect(back, 'the chip compiles').toBeTruthy();
      expect(io(back)).toEqual(io(def));
    }, 60000);
  }
});
