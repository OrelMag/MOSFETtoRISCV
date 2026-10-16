// The 6502 in the sandbox: the part listed, ROMs in 6502 assembly (folded into the ROM's window), the
// 6502 computer example (compiles and draws cleanly, runs each sample to its halt on the cycle engine:
// the console, the LEDs, the RAM), and the CPU drawer's monitor following the part instruction by
// instruction against the ISS.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { libraryItems } from '../src/lib/catalog';
import { registry } from '../src/lib/define';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { computer6502Chip } from '../src/editor/example6502';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { detect6502, flags6502, M6502Monitor } from '../src/editor/m6502mon';
import { convertProgram, romImage, romListing, ROM_SAMPLES, sampleK } from '../src/editor/memory';
import { emptyWorkspace, type PartRef, polyline, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { readMem, resolveCpu } from '../src/editor/cpu';
import { assemble } from '../src/m6502/asm';
import { Cpu6502 } from '../src/m6502/iss';
import { disasm } from '../src/m6502/isa';
import { BCD6502, ECHO6502, FIB6502, HELLO6502, MAP6502, SB_PROGRAMS_6502 } from '../src/m6502/sbprograms';
import { breathe } from './setup';

const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'm6502')!;

/** The ISS on the computer's memory map: RAM repeating every 2K below $4000, the devices, the ROM repeating every 4K. */
class Map6502 {
  ram = new Uint8Array(0x800);
  rom: Uint8Array;
  console = '';
  leds = 0;
  ledWrites: number[] = [];
  constructor(src: string, public sw = 0) {
    const img = romImage({ k: 12, w: 8, lang: '6502', src });
    if (img.error) throw new Error(img.error);
    this.rom = Uint8Array.from({ length: 4096 }, (_, i) => img.words[i] ?? 0);
  }
  read(a: number): number {
    if (a & 0x8000) return this.rom[a & 0xfff];
    if (a & 0x4000) return this.sw;
    return this.ram[a & 0x7ff];
  }
  write(a: number, v: number): void {
    if (a & 0x8000) return;
    if (!(a & 0x4000)) { this.ram[a & 0x7ff] = v; return; }
    if ((a & 3) === 0) this.console += String.fromCharCode(v);
    else if ((a & 3) === 1) { this.leds = v; this.ledWrites.push(v); }
  }
}

/** The reference: the ISS on that map until a JMP to itself (instructions retired: the reset sequence not counted). */
function reference(src: string, sw = 0) {
  const bus = new Map6502(src, sw);
  const cpu = new Cpu6502(bus);
  cpu.reset();
  cpu.step(); // the reset sequence
  let instrs = 0;
  for (let n = 0; n < 200000; n++) {
    const pc = cpu.pc;
    cpu.step();
    instrs++;
    if (cpu.pc === pc) break;
  }
  return { bus, cpu, instrs };
}

function open(src?: string): { ws: Workspace; id: string; es: EditorSim; mon: M6502Monitor } {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (src) {
    const docs = { mem: ws.chips[`${id}_mem`], dev: ws.chips[`${id}_dev`] };
    ws = { ...ws, chips: { ...ws.chips, [id]: computer6502Chip(id, ws.chips[id].name, docs, src) } };
  }
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new M6502Monitor(es, () => ws.chips[id], () => ws.chips);
  return { ws, id, es, mon };
}

const io = (es: EditorSim, kind: 'console') => {
  const n = ioNodes(es.sim!.design.root).find((x) => x.info.kind === kind)!;
  return ioState(es.sim!, n.node);
};
const leaf = (es: EditorSim, path: string) => es.sim!.design.leaves.findIndex((l) => l.node.path.join('.') === path);

async function run(es: EditorSim, mon: M6502Monitor, cap: number): Promise<void> {
  while (es.cycles < cap && !mon.done) {
    es.runCycles(Math.min(2000, cap - es.cycles), () => mon.done, 1e9);
    await breathe();
  }
}

describe('the 6502 part in the sandbox', () => {
  it('is listed under Processor parts', () => {
    const cpu = libraryItems().find((c) => c.cat === 'cpu')!;
    expect(cpu.items.map((i) => i.id)).toContain('m6502_core');
  });
});

describe('ROMs in 6502 assembly', () => {
  it('fold the program into the ROM: code at $F000 and the vectors at $FFFA in 4K', () => {
    const img = romImage({ k: 12, w: 8, lang: '6502', src: HELLO6502 });
    expect(img.problems).toEqual([]);
    const a = assemble(HELLO6502);
    for (const s of a.segments) s.bytes.forEach((b, j) => expect(img.words[(s.addr + j) & 0xfff]).toBe(b));
    expect(img.words.length).toBe(4096);
    const rows = romListing({ w: 8, addr: 'word', lang: '6502' }, img);
    expect(rows[0]).toMatchObject({ addr: '$F000', word: 'a2', text: 'LDX #$FF' });
    expect(rows[1].text).toBe(''); // the operand byte
    expect(rows[0xffc]).toMatchObject({ addr: '$FFFC', word: '00', text: '.byte $00' });
    expect(rows[0x800]).toMatchObject({ addr: '$F800', text: '' }); // fill
  });

  it('two bytes on one word of a small ROM are an error, on their line; the samples size the ROM', () => {
    const img = romImage({ k: 8, w: 8, lang: '6502', src: '*= $F000\n lda #1\n*= $F100\n lda #2' });
    expect(img.error).toMatch(/line 4: \$F100 and \$F000 \(line 2\) are the same byte of a 256-byte ROM/);
    expect(img.problems).toHaveLength(1); // one per line, not per byte
    for (const p of SB_PROGRAMS_6502) {
      const k = sampleK('6502', p.src);
      expect(romImage({ k, w: 8, lang: '6502', src: p.src }).problems, p.id).toEqual([]);
      expect(romImage({ k: k - 1, w: 8, lang: '6502', src: p.src }).problems.length, p.id).toBeGreaterThan(0);
    }
    expect(ROM_SAMPLES.filter((s) => s.lang === '6502').map((s) => s.id)).toEqual(SB_PROGRAMS_6502.map((p) => p.id));
  });

  it('convert to hex bytes and back; a ROM needs 8-bit words; the store keeps the language', () => {
    const hex = convertProgram(FIB6502, 'hex', '6502', undefined, 12)!;
    expect(hex.split('\n')[0]).toBe('0xa2  # LDX #$FF');
    const back = convertProgram(hex, '6502', 'hex')!;
    expect(romImage({ k: 12, w: 8, lang: '6502', src: back }).words).toEqual(romImage({ k: 12, w: 8, lang: '6502', src: FIB6502 }).words);
    expect(convertProgram('1ff', '6502', 'hex')).toBeNull();
    const bad = partDef({ rom: { k: 4, w: 16, addr: 'word', lang: '6502', src: '' } }, () => undefined);
    expect(bad).toEqual({ error: 'ROM: 6502 programs need 8-bit words, word addressed' });
    const raw = { id: 'u_x', name: 'X', parts: [{ id: 'r', ref: { rom: { k: 12, w: 8, addr: 'word', lang: '6502', src: HELLO6502 } }, at: [0, 0] }] };
    expect(sanitizeChip(raw)!.parts[0].ref).toEqual(raw.parts[0].ref);
  });

  it('every sample runs on the ISS on the computer\'s map and halts', () => {
    for (const p of [HELLO6502, FIB6502, BCD6502]) expect(reference(p).cpu.pc).toBeGreaterThanOrEqual(0xf000);
    expect(reference(HELLO6502).bus.console).toBe('Hello from the 6502!\n');
    expect(reference(FIB6502).bus.console).toBe('0 1 1 2 3 5 8 13 21 34 55 89 144 233 377 610 987 1597 2584 4181 6765 \n');
    const bcd = reference(BCD6502).bus.ledWrites;
    expect(bcd).toHaveLength(100);
    expect(bcd.slice(8, 12)).toEqual([0x08, 0x09, 0x10, 0x11]);
    expect(bcd[99]).toBe(0x99);
    expect(MAP6502.CON).toBe(0x4000);
  });
});

describe('the 6502 computer example', () => {
  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    expect(Object.keys(ws.chips).filter((k) => k.startsWith(id))).toEqual([`${id}_mem`, `${id}_dev`, id]);
    const lost = Object.values(ws.chips).flatMap((c) => c.parts).flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) ? [p.ref.lib] : []));
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

  it('the CPU drawer finds the 6502, its ROM and its RAM (and takes it for no RISC-V)', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    expect(detect6502(ws.chips[id], ws.chips)).toEqual({ core: 'cpu', rom: 'rom', ram: 'mem.ram' });
    expect(resolveCpu(ws.chips[id], ws.chips)).toBeNull();
  });

  it('runs Fibonacci to its halt on the cycle engine, the monitor following every instruction', async () => {
    const { es, mon } = open();
    const ref = reference(FIB6502);
    expect(mon.checking).toBe(true);
    await run(es, mon, 40000);
    expect(es.engine).toBe('cycle');
    expect(mon.problem).toBeNull();
    expect(mon.halted).toBe(true);
    expect(es.halted).toBe(true); // the halt detector saw the JMP to itself
    expect(consoleText(io(es, 'console') as ConsoleState)).toBe(ref.bus.console);
    expect(mon.retired).toBe(ref.instrs);
    // every bus cycle the ISS made (the reset sequence's 7 included), to the halt
    expect(es.cycles).toBe(ref.cpu.cycles);
    expect(mon.read()).toMatchObject({ a: ref.cpu.a, x: ref.cpu.x, y: ref.cpu.y, s: ref.cpu.s, pc: ref.cpu.pc });
    expect(flags6502(mon.read()!.p)).toBe(flags6502(ref.cpu.p));
    // the zero page as the RAM (a chip down) holds it: F(n) = 10946 = $2AC2 stopped the loop
    const ram = readMem(es.sim!, mon.desc!.ram)!;
    expect(ram.slice(0, 2)).toEqual([0xc2, 0x2a]);
    expect(ram.slice(0, 8)).toEqual([...ref.bus.ram.slice(0, 8)]);
    const last = mon.log[mon.log.length - 1];
    expect(last.text).toBe(disasm([0x4c, ref.cpu.pc & 0xff, ref.cpu.pc >> 8], ref.cpu.pc));
  });

  it('logs what each instruction did: its registers, its stores, its cycles', async () => {
    const { es, mon } = open(HELLO6502);
    await run(es, mon, 2000);
    expect(mon.halted).toBe(true);
    expect(mon.retired).toBe(reference(HELLO6502).instrs);
    expect(mon.log).toHaveLength(64); // the newest
    es.reset();
    mon.sync();
    es.runCycles(60);
    expect(mon.log[0]).toMatchObject({ pc: 0xf000, text: 'LDX #$FF', effect: 'X ← FF, P Nv-bdIzc · 2 cycles' });
    expect(mon.log[1]).toMatchObject({ text: 'TXS', effect: 'S ← FF · 2 cycles' });
    expect(mon.log.find((e) => e.text.startsWith('STA'))!.effect).toBe('[$4000] ← 48 · 4 cycles');
    expect(mon.log.find((e) => e.text.startsWith('BNE'))!.effect).toBe('PC → $F006 · 3 cycles');
  });

  it('a stepped instruction is one opcode fetch to the next; Reset starts the log over', () => {
    const { es, mon } = open(HELLO6502);
    mon.stepInstr(); // the reset sequence, to the first opcode fetch
    expect(mon.pc).toBe(0xf000);
    expect(mon.current).toBe('LDX #$FF');
    mon.stepInstr();
    expect(mon.pc).toBe(0xf002);
    expect(mon.log.map((e) => e.text)).toEqual(['LDX #$FF']);
    es.reset();
    mon.sync();
    expect(mon.log).toEqual([]);
  });

  it('BCD on the LEDs, and the switches read back (echo, the switch bank flipped while it runs)', async () => {
    const b = open(BCD6502);
    await run(b.es, b.mon, 3000);
    expect(b.mon.halted).toBe(true);
    const leds = (es: EditorSim) => {
      const n = es.sim!.design.root.children!.get('dev')!.children!.get('ledr')!;
      let v = 0;
      n.ports.q.forEach((net, i) => (v |= (es.sim!.get(net) & 1) << i));
      return v;
    };
    expect(leds(b.es)).toBe(0x99);
    const e = open(ECHO6502);
    e.es.pokeLeaf(leaf(e.es, 'dev.sw'), { v: 0x5a });
    e.es.runCycles(40);
    expect(leds(e.es)).toBe(0x5a);
    e.es.pokeLeaf(leaf(e.es, 'dev.sw'), { v: 0xc3 });
    e.es.runCycles(20);
    expect(leds(e.es)).toBe(0xc3);
    expect(e.mon.halted).toBe(false);
  });
});
