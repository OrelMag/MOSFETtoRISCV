// The sandbox's communication parts (editor/commparts.ts): the line and the UART resolve from their ids alone, survive
// storage, share links and remix, behave on the cycle engine (a UART talking to itself through a line), and the exports
// call the line a model.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { bitCycles, COMM_PARTS, commPartOf, lineDelayOf, lineRef, uartFlags } from '../src/editor/commparts';
import { fpgaExport } from '../src/editor/fpga';
import { UserLibrary } from '../src/editor/library';
import { emptyChip, emptyWorkspace, type ChipDoc, type PinDoc, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { decodeShare, encodeShare } from '../src/editor/share';
import { loadWorkspace, saveWorkspace, sanitizeRef, type KV } from '../src/editor/store';
import { lineDef, LINE, MAX_LINE_DELAY, isLineDef, AXI_UART_B } from '../src/lib/uart';
import { regenerable, resolveComponent } from '../src/lib/resolve';
import { structuralVerilog } from '../src/sim/verilog';
import { synthVerilog } from '../src/sim/vexport';
import type { DualSim } from '../src/sim/dualsim';
import { breathe } from './setup';
import { ethSwitch, switchId, switchOptsOf } from '../src/lib/ethswitch';
import { SANDBOX_SWITCH, switchRef } from '../src/editor/commparts';
import { LAN_SWITCH } from '../src/lib/lan';
import { isModelDef } from '../src/editor/commparts';

class MapKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const pin = (id: string, name: string, dir: PinDoc['dir'], at: [number, number], width = 1, kind?: PinDoc['kind']): PinDoc => ({ id, name, dir, width, at, ...(kind ? { kind } : {}) });

/**
 * A UART core talking to itself through a line: tx → line → rx. Pins: push, data, divWe, wval, clk in; status, rxData out.
 * (pop, ieWe and clrWe are tied low with constants.)
 */
function loopback(delay: number): ChipDoc {
  const base = emptyChip('u_loop', 'Loopback');
  const c = (id: string, value: number, width: number, at: [number, number]) => ({ id, ref: { const: { width, value } }, at });
  return {
    ...base,
    pins: [pin('p_push', 'push', 'in', [2, 4]), pin('p_data', 'data', 'in', [2, 8], 8), pin('p_divWe', 'divWe', 'in', [2, 12]), pin('p_wval', 'wval', 'in', [2, 16], 12), pin('p_pop', 'pop', 'in', [2, 20]),
      pin('p_clk', 'clk', 'in', [2, 24], 1, 'clock'), pin('p_status', 'status', 'out', [60, 4], 8), pin('p_rxData', 'rxData', 'out', [60, 10], 8), pin('p_tx', 'tx', 'out', [60, 16])],
    parts: [{ id: 'u', ref: { lib: 'uart_full' }, at: [20, 2] }, { id: 'ln', ref: lineRef(delay), at: [20, 34] }, c('z', 0, 1, [4, 30])],
    wires: [
      ...['push', 'data', 'divWe', 'pop', 'clk'].map((n, i) => ({ id: `wi${i}`, a: { pin: `p_${n}` }, b: { part: 'u', port: n }, pts: [] as [number, number][] })),
      { id: 'wv', a: { pin: 'p_wval' }, b: { part: 'u', port: 'wval' }, pts: [] },
      { id: 'wst', a: { part: 'u', port: 'status' }, b: { pin: 'p_status' }, pts: [] },
      { id: 'wrx', a: { part: 'u', port: 'rxData' }, b: { pin: 'p_rxData' }, pts: [] },
      { id: 'wtx', a: { part: 'u', port: 'tx' }, b: { part: 'ln', port: 'd' }, pts: [] },
      { id: 'wtp', a: { part: 'u', port: 'tx' }, b: { pin: 'p_tx' }, pts: [] },
      { id: 'wlq', a: { part: 'ln', port: 'q' }, b: { part: 'u', port: 'rx' }, pts: [] },
      { id: 'wlc', a: { pin: 'p_clk' }, b: { part: 'ln', port: 'clk' }, pts: [] },
      { id: 'wn', a: { part: 'z', port: 'y' }, b: { part: 'ln', port: 'noise' }, pts: [] },
      { id: 'wie', a: { part: 'z', port: 'y' }, b: { part: 'u', port: 'ieWe' }, pts: [] },
      { id: 'wcl', a: { part: 'z', port: 'y' }, b: { part: 'u', port: 'clrWe' }, pts: [] },
    ],
  };
}

describe('the line part by id', () => {
  it('resolves line<delay> from the name alone, to the one def of that delay', () => {
    for (const n of [1, 2, 7, MAX_LINE_DELAY]) {
      const d = resolveComponent(`line${n}`)!;
      expect(d).toBe(lineDef(n));
      expect(isLineDef(d)).toBe(true);
      expect(regenerable(`line${n}`)).toBe(true);
      expect(lineDelayOf({ lib: `line${n}` })).toBe(n);
    }
    expect(resolveComponent('line2')).toBe(LINE);
    for (const bad of ['line0', `line${MAX_LINE_DELAY + 1}`, 'line02', 'line', 'line2x']) {
      expect(resolveComponent(bad), bad).toBeUndefined();
      expect(lineDelayOf({ lib: bad }), bad).toBeNull();
    }
    expect(isLineDef(resolveComponent('nand'))).toBe(false);
  });

  it('the palette entries place parts that resolve, and each is owned by its entry', () => {
    expect(COMM_PARTS.map((c) => c.id)).toEqual(['line', 'uart', 'uart_bus', 'nic', 'mac_rx', 'mac_tx', 'switch', 'spi', 'spi_mem']);
    for (const c of COMM_PARTS) {
      const d = partDef(c.ref, () => undefined);
      expect('error' in d, c.id).toBe(false);
      expect(commPartOf(c.ref)?.id).toBe(c.id);
    }
    expect(commPartOf({ lib: 'nand' })).toBeUndefined();
    expect((resolveComponent('axi_uart_b'))).toBe(AXI_UART_B);
    expect(resolveComponent('axi_uart_b')!.ports.map((p) => p.name)).toEqual(expect.arrayContaining(['req', 'rsp', 'rx', 'tx', 'irq', 'clk']));
  });
});

describe('persistence', () => {
  it('saves, reloads, shares and sanitizes a chip with a line and both UARTs', async () => {
    const chip = { ...loopback(5), parts: [...loopback(5).parts, { id: 'sl', ref: { lib: 'axi_uart_b' }, at: [40, 2] as [number, number] }] };
    const ws: Workspace = { ...emptyWorkspace(), chips: { [chip.id]: chip }, open: [chip.id] };
    const kv = new MapKV();
    expect(saveWorkspace(ws, kv)).toEqual({ ok: true });
    expect(loadWorkspace(kv).chips[chip.id]).toEqual(chip);
    expect(await decodeShare(await encodeShare([chip]))).toEqual([chip]);
    expect(sanitizeRef(lineRef(9))).toEqual({ lib: 'line9' });
    // after a reload the references resolve before anything has built them
    const back = loadWorkspace(kv).chips[chip.id];
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { [back.id]: back } });
    expect(lib.compiled(back.id)!.diags).toEqual([]);
  });

  it('Open in Sandbox brings a line along as the line part', () => {
    const d = lineDef(3);
    const r = remixDef(emptyWorkspace(), d);
    // a line alone is not a drawable circuit; a circuit placing one keeps `{ lib: 'line3' }`
    expect('error' in r || r.ws).toBeTruthy();
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { u_loop: loopback(3) }, open: ['u_loop'] });
    const top = lib.compiled('u_loop')!.def;
    const r2 = remixDef({ ...emptyWorkspace() }, top);
    if ('error' in r2) throw new Error(r2.error);
    const copy = r2.ws.chips[r2.id];
    expect(copy.parts.some((p) => 'lib' in p.ref && p.ref.lib === 'line3')).toBe(true);
  });
});

describe('on the cycle engine', () => {
  it('a UART talks to itself through a line: the byte comes back, framed, at the divisor\'s rate', async () => {
    const chip = loopback(4);
    const ws: Workspace = { ...emptyWorkspace(), chips: { [chip.id]: chip }, open: [chip.id] };
    const lib = new UserLibrary(ws);
    expect(lib.compiled(chip.id)!.diags).toEqual([]);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(chip.id)!, chip.pins);
    const P = (n: string) => chip.pins.find((p) => p.name === n)!;
    const out = (n: string) => { const v = es.pinBits(n)!; return v.reduce((s: number, b: number, i: number) => s + (b === 1 ? 2 ** i : 0), 0); };
    // divisor 1: 16 cycles a bit
    es.setInput(P('wval'), 1);
    es.setInput(P('divWe'), 1);
    es.runCycles(2, () => false, 1e9);
    es.setInput(P('divWe'), 0);
    es.setInput(P('data'), 0xa5);
    es.setInput(P('push'), 1);
    es.runCycles(1, () => false, 1e9);
    es.setInput(P('push'), 0);
    let rxNotEmpty = false;
    for (let i = 0; i < 40 && !rxNotEmpty; i++) { es.runCycles(10, () => false, 1e9); rxNotEmpty = (out('status') & 1) === 1; await breathe(); }
    expect(rxNotEmpty).toBe(true);
    // a frame is ten bits of 16 cycles; the byte arrives about when its stop bit is sampled
    expect(es.cycles).toBeGreaterThan(9 * bitCycles(1));
    expect(es.cycles).toBeLessThan(11 * bitCycles(1) + 20);
    expect(out('rxData')).toBe(0xa5);
    expect(uartFlags(out('status')).filter((f) => f.on).map((f) => f.name)).not.toContain('framing error');
    expect((es.sim as DualSim).engine).toBe('cycle');
  });

  it('the line holds idle (1) at power-on and q follows d after the delay', () => {
    const chip = { ...emptyChip('u_l', 'L'), pins: [pin('d', 'd', 'in', [0, 2], 1, 'toggle'), pin('n', 'n', 'in', [0, 4]), pin('c', 'clk', 'in', [0, 6], 1, 'clock'), pin('q', 'q', 'out', [20, 2])],
      parts: [{ id: 'ln', ref: lineRef(3), at: [6, 0] as [number, number] }],
      wires: [{ id: 'a', a: { pin: 'd' }, b: { part: 'ln', port: 'd' }, pts: [] as [number, number][] }, { id: 'b', a: { pin: 'n' }, b: { part: 'ln', port: 'noise' }, pts: [] },
        { id: 'c', a: { pin: 'c' }, b: { part: 'ln', port: 'clk' }, pts: [] }, { id: 'e', a: { part: 'ln', port: 'q' }, b: { pin: 'q' }, pts: [] }] };
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { u_l: chip }, open: ['u_l'] });
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled('u_l')!, chip.pins);
    const q = () => es.pinBits('q')![0];
    expect(q()).toBe(1);
    es.setInput(chip.pins[0], 0);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { es.runCycles(1, () => false, 1e9); seen.push(q()); }
    // d = 0 from the first edge: it reaches q two edges later (delay 3: the buffer holds the last three samples)
    expect(seen).toEqual([1, 1, 0, 0, 0, 0]);
    es.setInput(chip.pins[1], 1);
    es.runCycles(1, () => false, 1e9);
    es.setInput(chip.pins[1], 0);
    es.runCycles(2, () => false, 1e9);
    expect(q()).toBe(1); // the noisy sample (0 ^ 1) arrives
  });
});

describe('exports', () => {
  it('Verilog calls a line a model of a cable, and the FPGA export lists it with its ports', () => {
    const chip = loopback(2);
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { [chip.id]: chip }, open: [chip.id] });
    const def = lib.compiled(chip.id)!.def;
    const v = synthVerilog(def).verilog;
    expect(v).toMatch(/ln: Line \(2 cycles\) \(a model of a cable[^)]*not transistors and not synthesizable/);
    expect(structuralVerilog(def)).toMatch(/model of a cable/);
    const x = fpgaExport(def, 'loop');
    expect(x.ok).toBe(true);
    const issue = x.issues.find((i) => /line part/.test(i.text))!;
    expect(issue.level).toBe('warn');
    expect(issue.text).toMatch(/ln/);
    expect(issue.text).toMatch(/x_<part>_d/);
    expect(x.files.find((f) => f.name === 'loop.v')!.text).toMatch(/x_ln_d/);
  });
});

describe('the NIC, the MACs, the switch and the SPI controller by id', () => {
  it('resolve from the name alone, to the one def, and are real circuits (not models)', () => {
    for (const id of ['nic', 'nic_b', 'eth_mac_rx', 'eth_mac_tx', 'axi_spi', 'axi_spi_b', 'spi_device', switchId(SANDBOX_SWITCH)]) {
      const d = resolveComponent(id)!;
      expect(d, id).toBeTruthy();
      expect(d.id).toBe(id);
      expect(resolveComponent(id), id).toBe(d);
      expect(regenerable(id), id).toBe(true);
      expect(isModelDef(d), id).toBe(false);
    }
    expect(resolveComponent('nic_b')!.ports.map((p) => p.name)).toEqual(expect.arrayContaining(['req', 'rsp', 'm_req', 'm_rsp', 'rxd', 'crs', 'txd', 'txen', 'irq', 'clk']));
    expect(resolveComponent('axi_spi_b')!.ports.map((p) => p.name)).toEqual(expect.arrayContaining(['req', 'rsp', 'miso', 'sclk', 'mosi', 'cs_n', 'irq', 'clk']));
    expect(resolveComponent(switchId(SANDBOX_SWITCH))).toBe(ethSwitch(SANDBOX_SWITCH));
  });

  it('the switch id carries its options both ways, and a bad id resolves to nothing', () => {
    expect(switchOptsOf('ethswitch_7_2fs_7_8')).toEqual({ cellK: 7, cells: 2, voq: false, cut: false, tableK: 7, tickLog2: 8 });
    expect(switchOptsOf(switchId({ cellK: 9, cells: 8, voq: true, cut: true, tableK: 5, tickLog2: 3 }))).toEqual({ cellK: 9, cells: 8, voq: true, cut: true, tableK: 5, tickLog2: 3 });
    for (const bad of ['ethswitch_4fs_7_4', 'ethswitch_12fs_7_4', 'ethswitch_7_3fs_7_4', 'ethswitch_7fs_8_4', 'ethswitch_7fs_7_0', 'ethswitch_07fs_7_4', 'ethswitch_7_4fs_7_4', 'ethswitch_7xs_7_4', 'ethswitch']) {
      expect(switchOptsOf(bad), bad).toBeNull();
      expect(resolveComponent(bad), bad).toBeUndefined();
    }
    expect(LAN_SWITCH).toMatchObject({ cellK: SANDBOX_SWITCH.cellK, cells: SANDBOX_SWITCH.cells });
    expect(commPartOf(switchRef({ cellK: 10, cells: 4, voq: false, cut: false, tableK: 6, tickLog2: 4 }))?.id).toBe('switch');
    expect(commPartOf({ lib: 'ethswitch_7fs' })).toBeUndefined();
  });

  it('a chip placing all of them saves, reloads, shares and compiles after a reload', async () => {
    const base = emptyChip('u_net', 'Net');
    const chip: ChipDoc = { ...base, parts: COMM_PARTS.filter((c) => !['line', 'uart', 'uart_bus'].includes(c.id)).map((c, i) => ({ id: `p${i}`, ref: c.ref, at: [4 + 40 * (i % 3), 4 + 90 * Math.floor(i / 3)] as [number, number] })) };
    const ws: Workspace = { ...emptyWorkspace(), chips: { [chip.id]: chip }, open: [chip.id] };
    const kv = new MapKV();
    expect(saveWorkspace(ws, kv)).toEqual({ ok: true });
    expect(loadWorkspace(kv).chips[chip.id]).toEqual(chip);
    expect(await decodeShare(await encodeShare([chip]))).toEqual([chip]);
    for (const p of chip.parts) expect(sanitizeRef(p.ref)).toEqual(p.ref);
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { [chip.id]: loadWorkspace(kv).chips[chip.id] }, open: [chip.id] });
    expect(lib.compiled(chip.id)!.diags.filter((d) => d.level === 'error')).toEqual([]);
  }, 60000);
});
