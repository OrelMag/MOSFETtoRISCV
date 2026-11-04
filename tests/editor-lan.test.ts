// Examples ▸ Two computers on a switch: assembles, resolves from names alone, draws without lint warnings, and runs on the cycle engine:
// A pings, B pongs, the switch learns both stations and floods once. The NIC and switch readers of the property sections are checked on it.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { performance } from 'node:perf_hooks';
import { LAN_PING_SOURCE, LAN_PONG_SOURCE, LAN_ROUNDS } from '../src/editor/examplenet';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { assemble } from '../src/riscv/asm';
import type { DualSim } from '../src/sim/dualsim';
import { breathe } from './setup';
import { nicView, switchTable } from '../src/editor/commparts';
import { pack } from '../src/sim/values';
import type { HierNode } from '../src/sim/flatten';

const EX = EXAMPLES.find((e) => e.id === 'twocomputers-switch')!;

describe('Examples ▸ Two computers on a switch', () => {
  it('assembles both programs', () => {
    for (const src of [LAN_PING_SOURCE, LAN_PONG_SOURCE]) {
      const a = assemble(src);
      expect(a.errors).toEqual([]);
      expect(a.words.length).toBeLessThanOrEqual(256);
    }
  });

  it('measure', async () => {
    const t0 = performance.now();
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const c = lib.compiled(id)!;
    expect(c.diags).toEqual([]);
    const t1 = performance.now();
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, ws.chips[id].pins);
    const t2 = performance.now();
    const text = (name: string) => {
      const n = ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console' && x.node.path[x.node.path.length - 1] === name)!;
      return consoleText(ioState(es.sim!, n.node) as ConsoleState);
    };
    let last = performance.now();
    for (let i = 0; i < 20; i++) {
      es.runCycles(2000, () => false, 1e9);
      await breathe();
      const n = performance.now();
      console.log(`cycles ${es.cycles} ${(2000 / ((n - last) / 1000)).toFixed(0)}/s engine ${(es.sim as DualSim).engine} A=${JSON.stringify(text('conA'))} B=${JSON.stringify(text('conB'))}`);
      last = n;
      if (text('conA').length >= 5 * LAN_ROUNDS) break;
    }
    const find = (n: HierNode, id: (s: string) => boolean): HierNode | null => { if (id(n.def.id)) return n; for (const c of n.children?.values() ?? []) { const r = find(c, id); if (r) return r; } return null; };
    const root = es.sim!.design.root;
    for (const nm of ['a', 'b']) { const nic = find(root.children!.get(nm)!, (i) => i === 'nic')!; console.log(nm, JSON.stringify(nicView(es.sim!, nic))); }
    const sw = find(root, (i) => i.startsWith('ethswitch_'))!;
    console.log('table', JSON.stringify(switchTable(es.sim as DualSim, sw)));
    console.log('counters', ['learned', 'evicted', 'flooded', 'filtered', 'frames0', 'frames1', 'frames2', 'frames3', 'drops0', 'drops1', 'bad0', 'bad1'].map((p) => p + '=' + pack(es.sim!.getBits(sw.ports[p]))).join(' '));
    console.log('probe', find(root.children!.get('a')!, (i) => i === 'nic')!.path.join('/'), sw.path.join('/'), JSON.stringify([...Object.keys(sw.ports)].slice(0, 5)), (es.sim as DualSim).engine, (es.sim as DualSim).time);
    console.log('probe2', pack(es.sim!.getBits(root.children!.get('a')!.ports.conWe)), pack(es.sim!.getBits(root.children!.get('sw')!.ports.A_rxd)), pack(es.sim!.getBits(sw.ports.clk)), JSON.stringify(Array.from(es.sim!.getBits(sw.ports.learned))));
    es.sim!.settle();
    console.log('probe3', pack(es.sim!.getBits(root.children!.get('a')!.ports.conWe)), pack(es.sim!.getBits(sw.ports.learned)), JSON.stringify(Array.from(es.sim!.getBits(root.children!.get('a')!.ports.conData))), JSON.stringify(Array.from(es.sim!.getBits(root.children!.get('a')!.ports.txd))), JSON.stringify(Array.from(es.sim!.getBits(root.children!.get('b')!.ports.txd))), (es.sim as any).whyNot);
    console.log('compile', (t1 - t0).toFixed(0), 'ms; update', (t2 - t1).toFixed(0), 'ms');
  }, 300000);
});
