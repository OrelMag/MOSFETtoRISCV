// Examples ▸ PDP-8 in gates: the processor part, the RAM holding Hello, world and the teletype, run in the sandbox's
// own simulation: LOAD_ADD (PC ← SR = 0200), START, and the teleprinter prints what the model prints.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { detectPdp8, Pdp8Monitor } from '../src/editor/pdp8mon';
import { assemblePdp8, PDP8_HELLO } from '../src/pdp8/programs';

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

describe('the CPU drawer\'s PDP-8 monitor', () => {
  const setup = (words?: number[], start = 0o200) => {
    const ex = EXAMPLES.find((e) => e.id === 'pdp8g')!;
    let { ws, id } = addExample(emptyWorkspace(), ex);
    if (words) {
      const doc = ws.chips[id];
      const parts = doc.parts.map((p) => (p.id === 'core' && 'ram' in p.ref ? { ...p, ref: { ram: { ...p.ref.ram, init: words } } } : p));
      const pins = doc.pins.map((p) => (p.name === 'SR' ? { ...p, value: start } : p));
      ws = { ...ws, chips: { ...ws.chips, [id]: { ...doc, parts, pins } } };
    }
    const lib = new UserLibrary(ws);
    const es = new EditorSim({ debounceMs: 0 });
    const pins = ws.chips[id].pins;
    es.update(lib.compiled(id)!, pins);
    const mon = new Pdp8Monitor(es, () => ws.chips[id], () => ws.chips);
    const press = (n: string) => { const p = pins.find((q) => q.name === n)!; es.setInput(p, 1); es.runCycles(1); es.setInput(p, 0); };
    return { es, mon, press, desc: detectPdp8(ws.chips[id]) };
  };

  it('finds the processor, its RAM, the keyboard and the panel pins', () => {
    const { desc } = setup();
    expect(desc).toMatchObject({ core: 'cpu', ram: 'core', kbd: 'kbd', sr: 'SR', keys: { ld: 'LOAD_ADD', start: 'START', sstep: 'SING_STEP' } });
  });

  it('follows Hello, world in lock step with the golden model to the HLT', () => {
    const { es, mon, press } = setup();
    es.runCycles(2);
    press('LOAD_ADD');
    press('START');
    es.runCycles(5000, () => mon.done);
    expect(mon.mismatch).toBeNull();
    expect(mon.halted).toBe(true);
    expect(mon.retired).toBeGreaterThan(100);
    expect(mon.iss!.out).toBe(PDP8_HELLO.prints);
  });

  it('matches the model on random cores', () => {
    let seed = 5;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 4; k++) {
      const words = Array.from({ length: 4096 }, () => { const w = Math.floor(r() * 4096); return (w & 0o7401) === 0o7400 ? w & ~2 : w; }); // no HLT
      const { es, mon, press } = setup(words, Math.floor(r() * 4096));
      es.runCycles(1);
      press('LOAD_ADD');
      press('START');
      es.runCycles(1500, () => mon.done);
      expect(mon.mismatch, `core ${k}`).toBeNull();
      expect(mon.retired + (mon.halted ? 1000 : 0), `core ${k}`).toBeGreaterThan(300);
    }
  });
});

describe('the PDP-8 monitor with the keyboard', () => {
  it('stays in lock step through keyboard interrupts, keys typed while it runs', () => {
    const src = `.org 0
    .word 0
    JMP I v
v:  .word srv
.org 200
    ION
idle: JMP idle
srv: KSF
    JMP out
    KRB
    TLS
    ISZ cnt
    JMP back
    HLT
out: TCF
back: ION
    JMP I 0
cnt: .word 7775`;
    const words = Array.from(assemblePdp8(src).words);
    const ex = EXAMPLES.find((e) => e.id === 'pdp8g')!;
    let { ws, id } = addExample(emptyWorkspace(), ex);
    const doc = ws.chips[id];
    ws = { ...ws, chips: { ...ws.chips, [id]: { ...doc, parts: doc.parts.map((p) => (p.id === 'core' && 'ram' in p.ref ? { ...p, ref: { ram: { ...p.ref.ram, init: words } } } : p)) } } };
    const lib = new UserLibrary(ws);
    const es = new EditorSim({ debounceMs: 0 });
    const pins = ws.chips[id].pins;
    es.update(lib.compiled(id)!, pins);
    const mon = new Pdp8Monitor(es, () => ws.chips[id], () => ws.chips);
    const press = (n: string) => { const p = pins.find((q) => q.name === n)!; es.setInput(p, 1); es.runCycles(1); es.setInput(p, 0); };
    es.runCycles(1);
    press('LOAD_ADD');
    press('START');
    es.runCycles(20);
    for (const c of 'PDP') es.typeKey(c.charCodeAt(0)); // three at once: KRB leaves two waiting
    es.runCycles(3000, () => mon.done);
    expect(mon.mismatch, JSON.stringify(mon.mismatch) + mon.log.slice(-6).map((l) => `
${l.pc.toString(8)} ${l.text} ${l.effect}`).join('')).toBeNull();
    expect(mon.halted).toBe(true);
    expect(mon.iss!.out).toBe('PDP');
  });
});
