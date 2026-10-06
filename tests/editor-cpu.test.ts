// The sandbox's CPU description (editor/cpu.ts): detection on CPUs opened with "Open in Sandbox"
// and on the fetch-loop example, the readers, and the golden model in lock-step through
// EditorSim's edge hooks (run to halt with no mismatch; a wrong setup reports one).

import { describe, expect, it } from 'vitest';
import { CpuMonitor, detectCpu, mismatchText, readCpu, resolveCpu, sanitizeCpu } from '../src/editor/cpu';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { singleCycleCpu } from '../src/lib/cpu';
import { multicycleCpu } from '../src/lib/multicycle';
import { pipelinedCpu } from '../src/lib/pipeline';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import type { ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';

const prog = (id: string) => assemble(PROGRAMS.find((p) => p.id === id)!.source).words;

/** A remixed CPU running in an EditorSim, as the sandbox runs it. */
function open(def: ComponentDef): { ws: Workspace; id: string; doc: () => ChipDoc; es: EditorSim; lib: UserLibrary; set(d: ChipDoc): void } {
  const r = remixDef(emptyWorkspace(), def);
  if ('error' in r) throw new Error(r.error);
  let ws = r.ws;
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(r.id)!, ws.chips[r.id].pins);
  return {
    ws, id: r.id, lib, es, doc: () => ws.chips[r.id],
    set(d) {
      ws = { ...ws, chips: { ...ws.chips, [r.id]: d } };
      lib.update(ws);
      es.update(lib.compiled(r.id)!, d.pins);
    },
  };
}

/** The ISS run to its end: the registers the hardware must finish with. */
const golden = (words: number[]) => {
  const iss = new ISS(words);
  iss.run(100000);
  return iss;
};

describe('EditorSim edge hooks', () => {
  it('before / after every rising edge; in gate mode after waits until the logic is quiet', () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'fetch')!);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(new UserLibrary(ws).compiled(id)!, ws.chips[id].pins);
    const pc = () => pack(es.pinBits('pc')!);
    const seen: string[] = [];
    es.edgeHooks.add({ before: () => seen.push(`b${pc()}`), after: () => seen.push(`a${pc()}`) });
    es.stepOnce();
    es.runCycles(2);
    expect(seen).toEqual(['b0', 'a4', 'b4', 'a8', 'b8', 'a12']);
    seen.length = 0;
    es.setMode('gate');
    es.stepOnce(); // the clock rises: the edge is open until the PC has changed and the logic is quiet
    expect(seen).toEqual(['b12']);
    expect(es.inEdge).toBe(true);
    let ticks = 0;
    while (es.inEdge && ticks++ < 500) es.stepOnce();
    expect(seen).toEqual(['b12', 'a16']);
    expect(ticks).toBeGreaterThan(3);
  });
});

describe('detectCpu', () => {
  it('a remixed single-cycle CPU: ROM, PC pin, register file, data memory, one instruction per cycle', () => {
    const c = open(singleCycleCpu(prog('sum')));
    const d = detectCpu(c.doc())!;
    expect(d).toMatchObject({ rom: 'imem', pc: { pin: 'pcOut' }, regs: 'rf', dmem: 'dm', iss: {} });
    expect(d.retire).toBeUndefined();
    expect(d.pipeline).toBeUndefined();
  });

  it('multicycle: its retire output', () => {
    const c = open(multicycleCpu(prog('sum')));
    expect(detectCpu(c.doc())).toMatchObject({ rom: 'imem', pc: { pin: 'pcOut' }, regs: 'rf', dmem: 'dm', retire: { pin: 'retire' } });
  });

  it('pipelined: retire when a valid instruction is in W, no PC comparison', () => {
    const c = open(pipelinedCpu(prog('sum')));
    expect(detectCpu(c.doc())).toMatchObject({ rom: 'imem', pc: { pin: 'pcF' }, regs: 'rf', retire: { pin: 'validW' }, pipeline: true });
  });

  it('the fetch-loop example: a ROM and a PC, nothing else', () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'fetch')!);
    const d = detectCpu(ws.chips[id])!;
    expect(d).toMatchObject({ rom: 'rom', pc: { pin: 'pc' } });
    expect(d.regs).toBeUndefined();
    expect(d.dmem).toBeUndefined();
    // It runs: the PC walks through the ROM; there is nothing to compare.
    const lib = new UserLibrary(ws);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(id)!, ws.chips[id].pins);
    const m = new CpuMonitor(es, () => ws.chips[id]);
    expect(m.checking).toBe(false);
    m.stepInstr();
    m.stepInstr();
    expect(readCpu(es, ws.chips[id], m.desc!)).toMatchObject({ pc: 8, x: null, dmem: null });
    expect(m.mismatch).toBeNull();
    expect(m.retired).toBe(2);
  });

  it('no program ROM, no CPU; a chip setting overrides detection; the sanitizer keeps it', () => {
    expect(detectCpu({ id: 'u_x', name: 'X', pins: [], parts: [], wires: [], labels: [] })).toBeNull();
    const c = open(singleCycleCpu(prog('sum')));
    const d = resolveCpu({ ...c.doc(), cpu: { regs: '', retire: 'every', pc: { pointer: 'pc' } } })!;
    expect(d.regs).toBeUndefined();
    expect(d.pc).toEqual({ pointer: 'pc' });
    expect(d.auto.has('pc')).toBe(false);
    expect(d.auto.has('dmem')).toBe(true);
    const raw = JSON.parse(JSON.stringify({ ...c.doc(), cpu: { rom: 'imem', pc: { part: 'pc', port: 'q' }, retire: 'every', iss: { system: true, dmemWords: 64, bogus: 1 }, junk: 3 } }));
    expect(sanitizeChip(raw)!.cpu).toEqual({ rom: 'imem', pc: { part: 'pc', port: 'q' }, retire: 'every', iss: { system: true, dmemWords: 64 } });
    expect(sanitizeCpu({ pc: { wire: 3 } })).toBeUndefined();
  });
});

describe('golden model in lock-step', { timeout: 60000 }, () => {
  it('single-cycle: a program runs to halt with no mismatch; registers and memory as the ISS ends', () => {
    const words = prog('fib');
    const c = open(singleCycleCpu(words));
    const m = new CpuMonitor(c.es, c.doc);
    expect(m.checking).toBe(true);
    while (!m.done && c.es.cycles < 2000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    const g = golden(words);
    const r = m.read()!;
    expect(r.x).toEqual([...g.x].map((v) => v >>> 0));
    expect(r.dmem).toEqual([...g.dmem]);
    expect(m.retired).toBe(g.steps);
    expect(c.es.cycles).toBe(g.steps);
    // A power cycle restarts the golden model with the hardware.
    c.es.reset();
    m.sync();
    expect(m.retired).toBe(0);
    expect(m.checking).toBe(true);
  });

  it('multicycle: one ISS step per retire, PC checked at each boundary', () => {
    const words = prog('sum');
    const c = open(multicycleCpu(words));
    const m = new CpuMonitor(c.es, c.doc);
    while (!m.done && c.es.cycles < 2000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    expect(m.retired).toBe(golden(words).steps);
    expect(c.es.cycles / m.retired).toBeGreaterThan(3);
    // Step instruction: several cycles, one retirement.
    c.es.reset();
    m.sync();
    const n = m.stepInstr();
    expect(n).toBeGreaterThan(2);
    expect(m.retired).toBe(1);
  });

  it('pipelined: retires through W; the registers match after every retirement', () => {
    const words = prog('fib');
    const c = open(pipelinedCpu(words));
    const m = new CpuMonitor(c.es, c.doc);
    while (!m.done && c.es.cycles < 3000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    const g = golden(words);
    expect(m.read()!.x).toEqual([...g.x].map((v) => v >>> 0));
    expect(m.read()!.dmem).toEqual([...g.dmem]);
  });

  it('a wrong description reports the first difference', () => {
    const words = prog('sum');
    const c = open(pipelinedCpu(words));
    // Without its retire signal the pipeline looks like one instruction per cycle: the model runs ahead.
    c.set({ ...c.doc(), cpu: { retire: 'every' } });
    const m = new CpuMonitor(c.es, c.doc);
    m.runToHalt(Infinity, 60);
    expect(m.mismatch).not.toBeNull();
    expect(mismatchText(m.mismatch!)).toMatch(/after “.+”, cycle \d+: expected 0x[0-9a-f]{8}, got 0x[0-9a-f]{8}/);
  });

  it('a program edited in the ROM restarts the model with the new program', () => {
    const c = open(singleCycleCpu(prog('sum')));
    const m = new CpuMonitor(c.es, c.doc);
    m.runToHalt(Infinity, 10);
    const doc = c.doc();
    const src = PROGRAMS.find((p) => p.id === 'gcd')!.source;
    c.set({ ...doc, parts: doc.parts.map((p) => ('rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, lang: 'asm' as const, src } } } : p)) });
    expect(m.sync()).toBe(true);
    // Mid-run the hardware is not where the new program starts: the check waits for a reset.
    expect(m.checking).toBe(false);
    c.es.reset();
    m.sync();
    expect(m.checking).toBe(true);
    while (!m.done && c.es.cycles < 2000) m.runToHalt(Infinity);
    expect(m.mismatch).toBeNull();
    expect(m.iss!.halted).toBe(true);
    expect(m.read()!.x).toEqual([...golden(assemble(src).words).x].map((v) => v >>> 0));
  });
});
