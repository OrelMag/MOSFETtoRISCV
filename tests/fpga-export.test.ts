// The sandbox's FPGA export (editor/fpga.ts): a user chip ticked as a flip-flop becomes a clocked process with no
// NAND loop left, a latch still drawn as NANDs is reported by name, sandbox I/O parts become top-level ports, and
// the board top and the Tang Nano 9K constraints account for every pin. Yosys's synth_gowin on the examples is
// scripts/fpga-export.ts (CI's fpga job).

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BOARD, boardPlan, fpgaExport, latchLoops } from '../src/editor/fpga';
import { UserLibrary } from '../src/editor/library';
import type { PartRef, Vec } from '../src/editor/model';
import { crc32, zipFiles } from '../src/editor/zip';
import type { TopPort } from '../src/sim/vexport';
import { chip, fan, part, pin, wire, workspace } from './editorkit';

const L = (lib: string): PartRef => ({ lib });
const C = (id: string): PartRef => ({ chip: id });
const clk = (at: Vec) => ({ ...pin('clk', 'in', at), kind: 'clock' as const });

const sr = chip('u_sr', 'SR latch', {
  pins: [pin('s_n', 'in', [0, 2]), pin('r_n', 'in', [0, 12]), pin('q', 'out', [18, 3]), pin('q_n', 'out', [18, 11])],
  parts: [part('g1', L('nand'), [6, 1]), part('g2', L('nand'), [6, 9])],
  wires: [
    wire('s', 'pin:s_n', 'g1.a'), wire('r', 'pin:r_n', 'g2.b'),
    wire('q', 'g1.y', 'pin:q', [], { name: 'q', init: 0 }), wire('qf', 'g1.y', 'g2.a', [[14, 3], [14, 6], [4, 6], [4, 10]]),
    wire('qn', 'g2.y', 'pin:q_n', [], { name: 'q_n', init: 1 }), wire('qnf', 'g2.y', 'g1.b', [[15, 11], [15, 8], [3, 8], [3, 4]]),
  ],
});
const dlatch = chip('u_dlatch', 'D latch', {
  pins: [pin('d', 'in', [0, 3]), pin('e', 'in', [0, 8]), pin('q', 'out', [34, 4]), pin('q_n', 'out', [34, 6])],
  parts: [part('inv', L('not'), [2, 10]), part('g1', L('nand'), [10, 2]), part('g2', L('nand'), [10, 10]), part('sr', C('u_sr'), [18, 2])],
  wires: [
    ...fan('d', 'pin:d', 'g1.a', 'inv.a'), ...fan('e', 'pin:e', 'g1.b', 'g2.b'), wire('dn', 'inv.y', 'g2.a'),
    wire('s', 'g1.y', 'sr.s_n'), wire('r', 'g2.y', 'sr.r_n'), wire('q', 'sr.q', 'pin:q'), wire('qn', 'sr.q_n', 'pin:q_n'),
  ],
});
// master–slave, ticked "this chip is a flip-flop"
const dff = chip('u_dff', 'D flip-flop', {
  ff: { d: 'd', q: 'q', clk: 'clk' },
  pins: [pin('d', 'in', [0, 3]), clk([0, 10]), pin('q', 'out', [40, 3])],
  parts: [part('inv', L('not'), [3, 9]), part('master', C('u_dlatch'), [9, 1]), part('slave', C('u_dlatch'), [24, 1])],
  wires: [wire('d', 'pin:d', 'master.d'), ...fan('clk', 'pin:clk', 'inv.a', 'slave.e'), wire('cn', 'inv.y', 'master.e'), wire('m', 'master.q', 'slave.d'), wire('q', 'slave.q', 'pin:q')],
});
// a toggle flip-flop on an LED, a reset pin, and a bank of switches straight to an output
const top = chip('u_top', 'Blinker', {
  pins: [clk([0, 10]), pin('rst', 'in', [0, 14]), pin('q', 'out', [40, 3]), pin('sw', 'out', [40, 12], 2)],
  parts: [
    part('f', C('u_dff'), [10, 1]), part('n', L('not'), [10, 8]), part('led', { display: 'led', width: 1 }, [30, 6]),
    part('bank', { switches: 2 }, [20, 12]),
  ],
  wires: [
    wire('c', 'pin:clk', 'f.clk'), ...fan('q', 'f.q', 'pin:q', 'n.a', 'led.a'), wire('nq', 'n.y', 'f.d'), wire('s', 'bank.q', 'pin:sw'),
  ],
});
const lib = new UserLibrary(workspace(sr, dlatch, dff, top));
const def = (id: string) => {
  const c = lib.compiled(id)!;
  expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
  return c.def;
};

describe('FPGA export', () => {
  it('writes a user flip-flop chip as a process, with no latch loop left', () => {
    const out = fpgaExport(def('u_top'), 'blinker');
    expect(out.ok).toBe(true);
    expect(out.issues.filter((i) => i.level !== 'info')).toEqual([]);
    const v = out.files.find((f) => f.name === 'blinker.v')!.text;
    expect(v).toContain('always @(posedge clk) q <= d;');
    expect(v).toContain('initial q = 0;'); // the FPGA's flip-flops start where the sandbox's do
    expect(v).not.toMatch(/module u_dlatch|module u_sr/);
    expect(latchLoops(def('u_top'))).toEqual([]);
    expect(out.files.map((f) => f.name)).toEqual(['blinker.v', 'blinker_board.v', 'tangnano9k.cst', 'README.txt']);
  });

  it('punches the I/O parts out as ports of the top module', () => {
    const out = fpgaExport(def('u_top'), 'blinker');
    const v = out.files[0].text;
    expect(v).toMatch(/module u_top \(clk, rst, q, sw, x_led_a, x_bank_q\);/);
    expect(v).toContain('assign x_led_a = q;'); // the LED shows the net it is on
    expect(v).toMatch(/assign sw = x_bank_q;|assign \w+ = x_bank_q;/);
    expect(out.plan!.bits.find((m) => m.port === 'x_led_a')?.res.kind).toBe('led');
    expect(out.plan!.bits.filter((m) => m.port === 'x_bank_q').map((m) => m.res.kind)).toEqual(['button', 'gpio_in']);
  });

  it('reports a latch still drawn as a NAND loop, naming its parts', () => {
    expect(latchLoops(def('u_dlatch'))).toEqual([{ where: 'sr', part: 'SR latch', parts: ['g1', 'g2'], nands: 2 }]);
    // drawn on the chip itself: named by the parts as placed
    expect(latchLoops(def('u_sr'))).toEqual([{ where: '', part: 'SR latch', parts: ['g1', 'g2'], nands: 2 }]);
    const out = fpgaExport(def('u_dlatch'), 'latch');
    expect(out.ok).toBe(true);
    const warn = out.issues.filter((i) => i.level === 'warn').map((i) => i.text);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatch(/latch drawn as a NAND loop is left in sr \(SR latch\): g1, g2 \(2 NANDs\)/);
    expect(out.files.find((f) => f.name === 'README.txt')!.text).toContain(warn[0]);
  });

  it('the board top and the constraints account for every pin', () => {
    const out = fpgaExport(def('u_top'), 'blinker');
    const board = out.files.find((f) => f.name === 'blinker_board.v')!.text;
    const cst = out.files.find((f) => f.name === 'tangnano9k.cst')!.text;
    const plan = out.plan!;
    expect(plan.clocks).toEqual(['clk']);
    expect(plan.reset).toEqual({ port: 'rst', activeLow: false });
    for (const p of ['clk', 'rst', 'q', 'sw', 'x_led_a', 'x_bank_q']) {
      expect(board).toContain(`.${p}(p_${p})`);
      expect(board).toMatch(new RegExp(`assign (p_${p}\\b|\\w+(\\[\\d+\\])? = !?p_${p}\\b)`));
    }
    // every bit has a pin or is said to have none; every pin the board top uses is constrained
    const bits = (w: number, n: string) => (w > 1 ? Array.from({ length: w }, (_, i) => `${n}[${i}]`) : [n]);
    for (const [n, w] of [['q', 1], ['sw', 2], ['x_led_a', 1], ['x_bank_q', 2]] as const) for (const b of bits(w, n)) expect(cst).toContain(` ${b}`);
    expect(cst).toContain('S1: reset (rst)');
    expect(cst).toMatch(/AN EXAMPLE/);
    for (const m of board.matchAll(/\b(led_n|btn_n|gpio_in|gpio_out)\[(\d+)\]/g)) expect(cst).toContain(`IO_LOC "${m[1]}[${m[2]}]"`);
    expect(cst).toContain(`IO_LOC "clk_27m" ${BOARD.clock};`);
  });

  it('places what fits and lists the rest', () => {
    const ports: TopPort[] = [
      { name: 'clock', dir: 'in', width: 1, clock: false }, { name: 'resetn', dir: 'in', width: 1, clock: false },
      { name: 'a', dir: 'in', width: 3, clock: false }, { name: 'y', dir: 'out', width: 32, clock: false },
      { name: 'bus', dir: 'inout', width: 8, clock: false },
    ];
    const plan = boardPlan(ports);
    expect(plan.clocks).toEqual(['clock']);
    expect(plan.reset).toEqual({ port: 'resetn', activeLow: true });
    expect(plan.bits.filter((m) => m.port === 'a').map((m) => m.res.kind)).toEqual(['button', 'gpio_in', 'gpio_in']);
    const y = plan.bits.filter((m) => m.port === 'y');
    expect(y.filter((m) => m.res.kind === 'led')).toHaveLength(6);
    expect(y.length).toBe(6 + BOARD.gpio.length - 2);
    expect(plan.unplaced).toEqual([{ port: 'y', dir: 'out', bits: 32 - y.length }, { port: 'bus', dir: 'inout', bits: 8 }]);
  });

  it('refuses a transistor-level chip', () => {
    const inv = chip('u_inv', 'CMOS inverter', {
      pins: [pin('a', 'in', [0, 8]), pin('y', 'out', [14, 8])],
      parts: [part('vdd', L('vdd'), [7, 0]), part('p1', L('pmos'), [5, 3]), part('n1', L('nmos'), [5, 9]), part('gnd', L('gnd'), [7, 14])],
      wires: [...fan('a', 'pin:a', 'p1.g', 'n1.g'), wire('up', 'vdd.p', 'p1.s'), wire('mid', 'p1.d', 'n1.d'), wire('y', 'n1.d', 'pin:y'), wire('dn', 'gnd.p', 'n1.s')],
    });
    const out = fpgaExport(new UserLibrary(workspace(inv)).compiled('u_inv')!.def, 'inv');
    expect(out.ok).toBe(false);
    expect(out.files).toEqual([]);
    expect(out.issues[0].text).toMatch(/not synthesizable/);
  });

  it('zips the files (stored, CRC-32)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = zipFiles([{ name: 'a.txt', text: 'hello' }, { name: 'b.v', text: 'module m; endmodule\n' }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    expect(new TextDecoder().decode(z.subarray(30 + 5, 30 + 5 + 5))).toBe('hello');
  });
});
