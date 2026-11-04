// Examples ▸ Two computers on a switch: two RV32I bus cores with a NIC each (chapter 50), a four-port learning switch (chapter 49) between
// them. Compiled from its document it draws without lint warnings, places only parts a fresh page load resolves, runs on the cycle engine:
// A pings, B pongs, three times; the switch floods the first frame, learns both stations and forwards the rest to one port. The property
// sections' readers (editor/commparts.ts nicView, switchTable) are checked against the same run.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { nicView, switchTable } from '../src/editor/commparts';
import { resolveCpu } from '../src/editor/cpu';
import { LAN_PING_SOURCE, LAN_PONG_SOURCE, LAN_ROUNDS } from '../src/editor/examplenet';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { fpgaExport } from '../src/editor/fpga';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { deadParts, lintChip, openInputs } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import type { DualSim } from '../src/sim/dualsim';
import type { HierNode } from '../src/sim/flatten';
import { pack } from '../src/sim/values';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'twocomputers-switch')!;

// nothing large is registered at import: tests/editor-unravel.test.ts round-trips every registered part, and never finishes on the LAN
it('registers none of the NIC, the MACs, the switch or the SPI slave at import', () => {
  expect([...atLoad].filter((k) => /^(nic|eth_mac_|ethswitch_|axi_spi|lan_|eth_station|eth_segment)/.test(k))).toEqual([]);
});

function open() {
  const { ws, id } = addExample(emptyWorkspace(), EX);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return { ws, id, lib, es };
}

const cons = (es: EditorSim): [string, string] => {
  const text = (name: string) => {
    const n = ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console' && x.node.path[x.node.path.length - 1] === name)!;
    return consoleText(ioState(es.sim!, n.node) as ConsoleState);
  };
  return [text('conA'), text('conB')];
};

const find = (n: HierNode, ok: (id: string) => boolean): HierNode | null => {
  if (ok(n.def.id)) return n;
  for (const c of n.children?.values() ?? []) { const r = find(c, ok); if (r) return r; }
  return null;
};

describe('Examples ▸ Two computers on a switch', () => {
  it('assembles both programs into the boot ROMs', () => {
    for (const src of [LAN_PING_SOURCE, LAN_PONG_SOURCE]) {
      const a = assemble(src);
      expect(a.errors).toEqual([]);
      expect(a.words.length).toBeLessThanOrEqual(256);
    }
  });

  it('places only parts a fresh page load resolves, and draws without lint warnings or errors', () => {
    const { ws, lib } = open();
    expect(Object.keys(ws.chips).length).toBe(5); // Main, the two computers, the switch, the top
    for (const doc of Object.values(ws.chips)) {
      const lost = doc.parts.flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
      expect(lost, doc.name).toEqual([]);
      const c = lib.compiled(doc.id)!;
      expect(c.diags, doc.name).toEqual([]);
      const defOf = (p: { ref: PartRef }) => {
        const d = partDef(p.ref, (x) => lib.defOf(x));
        return !d || 'error' in d ? undefined : d;
      };
      const polys = new Map(doc.wires.flatMap((w) => { const q = polyline(doc, w, defOf); return q ? [[w.id, q] as const] : []; }));
      expect(lintChip(doc, c, polys).diags, doc.name).toEqual([]);
      expect(deadParts(doc, c), doc.name).toEqual([]);
      expect(openInputs(c), doc.name).toEqual([]);
    }
  });

  it('is not taken for a CPU the drawer can follow', () => {
    const { ws, id } = open();
    expect(resolveCpu(ws.chips[id], ws.chips)).toBeNull();
  });

  it('A pings three times, B pongs, the switch floods once and learns both stations; the readers see it all', async () => {
    const { es } = open();
    const t0 = performance.now();
    const want = 'pong\n'.repeat(LAN_ROUNDS);
    while (cons(es)[0] !== want && es.cycles < 60000) { es.runCycles(1000, () => false, 1e9); await breathe(); }
    const clocks = es.cycles, secs = (performance.now() - t0) / 1000;
    console.log(`two computers on a switch: ${clocks} clocks in ${secs.toFixed(1)} s = ${(clocks / secs).toFixed(0)} clocks/s (vitest, node)`);
    expect(cons(es)).toEqual([want, 'ping\n'.repeat(LAN_ROUNDS)]);
    expect((es.sim as DualSim).engine).toBe('cycle');
    const sim = es.sim!, root = sim.design.root;
    // the NICs: enabled, their addresses and rings, three frames each way
    for (const [name, mac] of [['a', '02:00:00:00:00:0a'], ['b', '02:00:00:00:00:0b']] as const) {
      const v = nicView(sim, find(root.children!.get(name)!, (i) => i === 'nic')!)!;
      expect(v).toMatchObject({ en: 1, promisc: 0, mac, rxbase: 0x1000, txbase: 0x1040, rxHead: LAN_ROUNDS, txHead: LAN_ROUNDS });
      expect(v.status & 3).toBe(3); // a frame received, a frame sent
    }
    // the switch: two stations learned on ports 0 and 1; the first ping flooded (ports 2 and 3 saw one frame each), the rest forwarded
    const sw = find(root, (i) => i.startsWith('ethswitch_'))!;
    const rows = switchTable(sim, sw)!;
    expect(rows.map((r) => [r.mac, r.port, r.live])).toEqual(expect.arrayContaining([['02:00:00:00:00:0a', 0, true], ['02:00:00:00:00:0b', 1, true]]));
    expect(rows.length).toBe(2);
    const n = (p: string) => pack(sim.getBits(sw.ports[p]));
    expect([n('learned'), n('evicted'), n('flooded'), n('filtered')]).toEqual([2, 0, 1, 0]);
    expect([n('frames0'), n('frames1'), n('frames2'), n('frames3')]).toEqual([LAN_ROUNDS, LAN_ROUNDS, 1, 1]);
    expect([n('drops0'), n('drops1'), n('bad0'), n('bad1')]).toEqual([0, 0, 0, 0]);
  }, 120000);

  it('the FPGA export of the switch and a computer lists real gates: nothing is called a model', () => {
    const { lib, ws } = open();
    for (const doc of Object.values(ws.chips).filter((d) => /Switch|Computer/.test(d.name))) {
      const x = fpgaExport(lib.compiled(doc.id)!.def, 'lan');
      expect(x.ok, doc.name).toBe(true);
      expect(x.issues.filter((i) => /model/i.test(i.text)), doc.name).toEqual([]);
    }
  }, 60000);
});
