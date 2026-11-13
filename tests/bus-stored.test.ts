// A workspace saved before the bus parts were packed natively still loads and runs the same. tests/fixtures/bus-stored.json
// was written on main (e115d49e, before this change) by the sandbox's own export: the examples that place bus-bundled
// parts (`_b`), each part's ports and first level as main built them, and what two of the computers printed after a fixed
// number of cycles. The sandbox's `_b` parts must keep all of it: their ports (a stored wire names them), their `core`
// level (probes, the readers and the tests walk `<part>.core.…`) and their behaviour.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { importChips, readExport } from '../src/editor/store';
import fixture from './fixtures/bus-stored.json';
import { breathe } from './setup';

interface Entry { json: string; top: string; parts: Record<string, { ports: [string, string, number][]; level: string[] }>; console?: { cycles: number; text: string[] } }
const EXAMPLES = (fixture as unknown as { examples: Record<string, Entry> }).examples;

function load(e: Entry) {
  const file = readExport(e.json);
  if ('error' in file) throw new Error(file.error);
  const { ws } = importChips(file.chips, emptyWorkspace());
  expect(ws.chips[e.top], 'the top chip keeps its id').toBeTruthy();
  return ws;
}

describe('workspaces saved on main', () => {
  for (const [name, e] of Object.entries(EXAMPLES)) {
    it(`${name}: every bus-bundled part keeps its ports and its level`, () => {
      load(e);
      for (const [id, want] of Object.entries(e.parts)) {
        const got = partDef({ lib: id } as never, () => undefined);
        if ('error' in got) throw new Error(`${id}: ${got.error}`);
        const def = got;
        expect(def.ports.map((q) => [q.name, q.dir, q.width ?? 1]), `${id} ports`).toEqual(want.ports);
        expect(def.netlist ? def.netlist().instances.map((i) => i.name).sort() : [], `${id} level`).toEqual(want.level);
      }
    });
    if (e.console) {
      const run = e.console;
      it(`${name}: compiles and prints what main printed after ${run.cycles} cycles`, async () => {
        const ws = load(e);
        const lib = new UserLibrary(ws), es = new EditorSim({ debounceMs: 0 });
        es.update(lib.compiled(e.top)!, ws.chips[e.top].pins);
        while (es.cycles < run.cycles) { es.runCycles(Math.min(1000, run.cycles - es.cycles), () => false, 1e9); await breathe(); }
        expect(es.cycles).toBe(run.cycles);
        const text = ioNodes(es.sim!.design.root).filter((x) => x.info.kind === 'console').map((x) => consoleText(ioState(es.sim!, x.node) as ConsoleState));
        expect(text).toEqual(run.text);
      });
    }
  }
});
