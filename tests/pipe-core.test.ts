// The sandbox's pipelined RV32I core (rv32i_pipe_core: pipelinedCpu with { ports: true }): the program and the data memory on ports,
// the single-cycle port core's memory timing. Checked: nothing else changed (the plain pipelines and CONTROL gate for gate, the port
// core exactly the plain one without its two memories), the part resolves and its drawing is clean, the computer example runs in
// lock step with the drawer's monitor (pipeline diagram included), and custom rows reach it through the part ref, the drawer's
// detection and the golden model.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CpuMonitor, detectCpu, mismatchText, pipelineSlots, resolveCpu } from '../src/editor/cpu';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState, type ScreenState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeRef } from '../src/editor/store';
import { control, CONTROL, dataMemory, rom } from '../src/lib/cpu';
import { registry } from '../src/lib/define';
import { pipelinedCpu } from '../src/lib/pipeline';
import { regenerable, resolveComponent } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { CUSTOM_PRESETS, type CustomRow } from '../src/riscv/custom';
import { clockCycle, cpuState, dmemWords, retireCount, retirePc } from '../src/riscv/cosim';
import { randomProgram32 } from '../src/riscv/randprog32';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import type { PortDef } from '../src/sim/types';
const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
import { tick } from './yieldtick';
import { COMPUTER_PROGRAMS, DONE_TEXT, GREETING, PICTURE } from '../src/riscv/ioprograms';
import { ISS } from '../src/riscv/iss';
import { PipeHistory } from '../src/widgets/pipegrid';
import { coreUnitNames, instrUse } from '../src/widgets/insthw';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());
const P = Object.fromEntries(CUSTOM_PRESETS.map((r) => [r.name, r]));
const EX = EXAMPLES.find((e) => e.id === 'computer-pipe')!;

function open(mutate?: (ws: ReturnType<typeof emptyWorkspace>, id: string) => ReturnType<typeof emptyWorkspace>) {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (mutate) ws = mutate(ws, id);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new CpuMonitor(es, () => ws.chips[id], () => ws.chips);
  return { ws, id, es, mon, lib };
}

async function run(es: EditorSim, mon: CpuMonitor, cap: number): Promise<void> {
  const stop = () => mon.done;
  while (es.cycles < cap && !stop()) {
    es.runCycles(Math.min(2000, cap - es.cycles), stop, 1e9);
    await breathe();
  }
}

describe('rv32i_pipe_core: the library part', () => {
  it('changes nothing else: CONTROL is 152 NANDs and the port core is the plain pipeline without its two memories', () => {
    expect(stats(CONTROL).nands).toBe(152);
    expect(stats(control([])).nands).toBe(152);
    const plain = pipelinedCpu([], { adder: 'ks' }), port = pipelinedCpu([], { adder: 'ks', ports: true });
    expect(plain.id).not.toBe(port.id);
    expect(pipelinedCpu([], { adder: 'ks' })).toBe(plain); // memoized apart from the port variant
    // the plain pipeline's own ROM is 2^6 words and its data memory 2^5 (the defaults the ports replace)
    expect(stats(port).nands).toBe(stats(plain).nands - stats(rom([], 6)).nands - stats(dataMemory(5)).nands);
  });

  it('resolves by id on a fresh page, with the pins the CPU drawer and the memory side expect', () => {
    expect(atLoad.has('rv32i_pipe_core') || regenerable('rv32i_pipe_core')).toBe(true);
    const d = resolveComponent('rv32i_pipe_core')!;
    expect(d.id).toBe('rv32i_pipe_core');
    const ports = Object.fromEntries(d.ports.map((p) => [p.name, `${p.dir}${p.width ?? 1}`]));
    expect(ports).toEqual({
      clk: 'in1', pcOut: 'out32', retire: 'out1', pcW: 'out32', instr: 'in32', memRData: 'in32', memAddr: 'out32', memWData: 'out32', memWE: 'out1',
    });
    // the single-cycle port core has all of these (and more): a core can be swapped for the other
    const single = resolveComponent('rv32i_core')!;
    for (const p of d.ports.filter((q) => q.name !== 'pcW')) expect(single.ports.find((q) => q.name === p.name && q.dir === p.dir), p.name).toBeDefined();
  });

  it('draws cleanly: no symbol on another, no wires on a line, no label hiding one', () => {
    for (const custom of [[], [P.lwx!, P.subi!]]) {
      const d = pipelinedCpu([], { adder: 'ks', ports: true, custom });
      const nl = netlistOf(d)!;
      const r = routeNetlist(d, nl).nets;
      expect(symbolOverlaps(nl), d.id).toEqual([]);
      expect(wireOverlaps(r), d.id).toEqual([]);
      expect(labelOverlaps(d, nl), d.id).toEqual([]);
    }
  });

  it('a { core: { custom, pipe } } ref survives the store and builds the rows into the pipeline', () => {
    const rows = [P.lwx!];
    const ref = sanitizeRef({ core: { custom: rows, pipe: true } }) as PartRef;
    expect(ref).toEqual({ core: { custom: rows, pipe: true } });
    expect(sanitizeRef({ core: { custom: [], pipe: true } })).toEqual({ lib: 'rv32i_pipe_core' });
    expect(sanitizeRef({ core: { custom: [] } })).toEqual({ lib: 'rv32i_core' });
    const d = partDef(ref, () => undefined);
    expect(d && !('error' in d) && d.id.startsWith('rv32i_pipe_cx')).toBe(true);
    expect(stats(d as never).nands).toBeGreaterThan(stats(resolveComponent('rv32i_pipe_core')!).nands);
  });
});

describe('Examples ▸ the pipelined computer', () => {
  it('places only parts a fresh page load resolves and draws without lint warnings', () => {
    const { ws } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const lost = Object.values(ws.chips).flatMap((c) => c.parts).flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
    for (const [cid, doc] of Object.entries(ws.chips)) {
      const c = lib.compiled(cid)!;
      expect(c.diags, cid).toEqual([]);
      const defOf = (p: { ref: PartRef }) => {
        const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
        return !d || 'error' in d ? undefined : d;
      };
      const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
      expect(lintChip(doc, c, polys).diags, cid).toEqual([]);
    }
  });

  it('the drawer finds a pipeline: the core, its register file, retire from the part, the RAM inside the memory side', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const d = resolveCpu(ws.chips[id], ws.chips)!;
    expect(d).toMatchObject({ rom: 'imem', regs: 'cpu.rf', dmem: 'mem.ram', core: 'cpu', pipeline: true, retire: { part: 'cpu', port: 'retire' }, iss: { mmio: true } });
    expect(detectCpu(ws.chips[id], ws.chips)!.iss.custom).toBeUndefined();
  });

  it('runs to its halt in lock step: the greeting, the LEDs, the picture; the pipeline diagram reads the core', async () => {
    const SW = 0xe3;
    const { ws, id, es, mon } = open();
    const sw = es.sim!.design.leaves.findIndex((l) => l.node.path.join('.') === 'dev.sw');
    es.pokeLeaf(sw, { v: SW });
    const hist = new PipeHistory();
    let slots = 0;
    es.edgeHooks.add({ after: () => {
      const root = es.sim!.design.root.children!.get('cpu')!;
      hist.record(es.sim!, root, es.cycles);
      if (pipelineSlots(es, ws.chips[id], mon.desc!)?.some((s) => s.stage === 'W')) slots++;
    } });
    await run(es, mon, 20000);
    expect(mon.mismatch && mismatchText(mon.mismatch)).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(es.halted).toBe(true); // the delayed halt part saw `j .` go round again
    expect(hist.snaps.length).toBeGreaterThan(10);
    expect(slots).toBeGreaterThan(10);
    const ref = new ISS(assemble(PICTURE).words, { mmio: true, imemWords: 1024, dmemWords: 4096 });
    ref.switches = SW;
    for (let n = 0; n < 100000 && !ref.halted; n++) ref.step();
    expect(mon.retired).toBe(ref.retired);
    const io = (kind: 'console' | 'screen') => ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === kind)!.node);
    expect(consoleText(io('console') as ConsoleState)).toBe(GREETING + DONE_TEXT);
    expect(mon.leds).toBe(SW);
    const px = (io('screen') as ScreenState).px;
    expect(px[10 * 64 + 32]).toBe(SW);
    expect(px[63 * 64 + 63]).toBe(0xfd);
    // a pipeline finishes in more cycles than instructions (CPI above 1), the single-cycle core in exactly one each
    expect(es.cycles).toBeGreaterThan(mon.retired);
  });

  it('live switches: a flipped switch repaints the square, the console and LEDs compared a store behind the core, the switches read an edge early', async () => {
    const src = COMPUTER_PROGRAMS.find((p) => p.id === 'liveswitches')!.source;
    const { es, mon } = open((ws, id) => {
      const doc = ws.chips[id];
      return { ...ws, chips: { ...ws.chips, [id]: { ...doc, parts: doc.parts.map((p) => (p.id === 'imem' && 'rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, src } } } as typeof p : p)) } } };
    });
    const sw = es.sim!.design.leaves.findIndex((l) => l.node.path.join('.') === 'dev.sw');
    await run(es, mon, 2500);
    for (const v of [0x1c, 0xe0, 0x03]) {
      es.pokeLeaf(sw, { v });
      await run(es, mon, es.cycles + 2500);
      expect(mon.mismatch && mismatchText(mon.mismatch)).toBeNull();
      expect(mon.leds).toBe(v);
    }
    expect(mon.iss!.halted).toBe(false);
    expect(mon.retired).toBeGreaterThan(1000);
    const px = (ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'screen')!.node) as ScreenState).px;
    expect(px[30 * 64 + 30]).toBe(0x03);
  }, 120_000);

  it('custom rows: Apply\'s ref on the core and the ROM, the drawer running them in lock step against ISS({ custom })', async () => {
    const lwx = P.lwx!, subi = P.subi!;
    const src = `li a0, 64
      li t0, 3
      sw t0, 0(a0)
      li t0, 5
      sw t0, 4(a0)
      li t0, 0
      li t1, 4
      lwx t2, a0, t0
      lwx t3, a0, t1
      add t4, t2, t3
      subi t5, t4, 2
      li s1, 0x80000000
      sw t5, 4(s1)
h:    j h`;
    const { es, mon } = open((ws, id) => {
      const doc = ws.chips[id];
      const parts = doc.parts.map((p) => {
        if (p.id === 'cpu') return { ...p, ref: { core: { custom: [lwx, subi], pipe: true as const } } } as typeof p;
        if (p.id === 'imem' && 'rom' in p.ref) return { ...p, ref: { rom: { ...p.ref.rom, src, custom: [lwx, subi] } } } as typeof p;
        return p;
      });
      return { ...ws, chips: { ...ws.chips, [id]: { ...doc, parts } } };
    });
    expect(mon.desc!.core).toBe('cpu');
    expect(mon.desc!.pipeline).toBe(true);
    expect(mon.desc!.iss.custom).toEqual([lwx, subi]);
    expect(mon.problem).toBeNull();
    await run(es, mon, 600);
    expect(mon.mismatch && mismatchText(mon.mismatch)).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(mon.leds).toBe(6); // 3 + 5 - 2
    // the listing line of a custom instruction lights the units its row uses, on the core's own instances
    const use = instrUse(assemble(src, [lwx, subi]).words[7]!, [lwx, subi]);
    const inner = [...es.sim!.design.root.children!.get('cpu')!.children!.keys()];
    const lit = coreUnitNames(use.units, inner);
    expect(lit).toEqual(expect.arrayContaining(['rf', 'alu', 'srcA', 'srcB', 'res', 'ctl', 'pc']));
    expect(lit.includes('dm')).toBe(false); // the data memory is outside the core
  });
});

// The port core's memory timing is the data memory's: wired to a ROM and a dataMemory it is the plain pipeline again, so random
// programs (hazards, loads right after stores, branches over them) end where the golden model ends, register by register.
describe('rv32i_pipe_core with a ROM and a data memory on its ports', () => {
  const harness = (words: number[], imemK: number, custom: CustomRow[] = []): ComponentDef => ({
    id: `t_pipe_port_${words.length}_${custom.length}`, name: 'harness', category: 'custom', symbol: { kind: 'box' },
    ports: [bit('clk', 'in')],
    netlist: () => ({
      instances: [
        { name: 'core', def: pipelinedCpu([], { adder: 'ks', ports: true, custom }) }, { name: 'imem', def: rom(words, imemK) }, { name: 'dm', def: dataMemory(5) },
      ],
      nets: [
        { ends: ['clk', 'core.clk', 'dm.clk'] }, { ends: ['core.pcOut', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        { ends: ['core.memAddr', 'dm.addr'] }, { ends: ['core.memWData', 'dm.wd'] }, { ends: ['core.memWE', 'dm.we'] }, { ends: ['dm.rd', 'core.memRData'] },
      ],
    }),
  });

  const cases = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ seed: i + 1, custom: i % 2 ? [P.lwx!, P.subi!] : [] as CustomRow[] }));
  it.each(cases.map((c) => [c.seed, c] as const))('random program %i ends in the golden model\'s state', async (_s, c) => {
    const asm = assemble(randomProgram32(c.seed, { n: 40, ...(c.custom.length ? { custom: c.custom } : {}) }), c.custom);
    expect(asm.errors).toEqual([]);
    const imemK = Math.max(6, Math.ceil(Math.log2(asm.words.length)));
    const sim = new GateSim(flatten(harness(asm.words, imemK, c.custom)));
    sim.setInput('clk', 0);
    sim.settle();
    const core = sim.design.root.children!.get('core')!;
    const iss = new ISS(asm.words, { dmemWords: 32, imemWords: 2 ** imemK, ...(c.custom.length ? { custom: c.custom } : {}) });
    for (let cyc = 1; cyc < 4000 && !iss.halted; cyc++) {
      const ret = retireCount(sim, core);
      if (ret) expect(retirePc(sim, core), `cycle ${cyc}: retiring pc`).toBe(iss.pc);
      clockCycle(sim);
      if (!ret) continue;
      iss.step();
      expect(cpuState(sim, core).x, `cycle ${cyc} after ${iss.steps} instructions`).toEqual([...iss.x].map((v) => v >>> 0));
      if (cyc % 64 === 0) await tick();
    }
    expect(iss.halted).toBe(true);
    for (let k = 0; k < 8; k++) clockCycle(sim);
    expect(dmemWords(sim, sim.design.root.children!.get('dm')!)).toEqual([...iss.dmem].map((v) => v >>> 0));
  }, 120_000);
});
