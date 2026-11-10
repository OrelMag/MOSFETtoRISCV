// Examples ▸ PDP-8 in gates: the processor part, the RAM holding Hello, world and the teletype, run in the sandbox's
// own simulation: LOAD_ADD (PC ← SR = 0200), START, and the teleprinter prints what the model prints.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { PDP8_HELLO } from '../src/pdp8/programs';

describe('Examples ▸ PDP-8 in gates', () => {
  it('prints Hello, world after LOAD_ADD and START', () => {
    const ex = EXAMPLES.find((e) => e.id === 'pdp8g')!;
    const { ws, id } = addExample(emptyWorkspace(), ex);
    const lib = new UserLibrary(ws);
    const c = lib.compiled(id)!;
    expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
    const es = new EditorSim({ debounceMs: 0 });
    const pins = ws.chips[id].pins;
    es.update(c, pins);
    const pin = (n: string) => pins.find((p) => p.name === n)!;
    es.runCycles(2);
    es.setInput(pin('LOAD_ADD'), 1);
    es.runCycles(2);
    es.setInput(pin('LOAD_ADD'), 0);
    es.setInput(pin('START'), 1);
    es.runCycles(2000);
    const n = ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console')!;
    expect(consoleText(ioState(es.sim!, n.node) as ConsoleState)).toBe(PDP8_HELLO.prints.replace(/\r\n$/, '\n').replace(/\r/g, ''));
  });
});
