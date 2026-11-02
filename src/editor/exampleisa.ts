// Examples ▸ RV32C and RV64: the chapter-25 widths in the sandbox. The C computer is the memory-port core with the C
// extension (rv32ic_core: the C expander inside, PC + 2 after a 16-bit instruction) over a ROM that answers at any
// even address (the ROM part with its C box ticked), a 64-word RAM and a console. The RV64 computer is the 64-bit core
// (rv64im_core: 64-bit registers, ALU and PC, its data memory inside) under a plain program ROM and a console.
// Both end on `j .`, which the halt part watches for; the CPU drawer follows them in lock step.

import type { ChipDoc } from './model';
import { Sheet } from './example6502';

export const C_RAM_K = 6;

/** The C program: compressed and full-size instructions mixed, so 32-bit ones straddle words. */
export const RVC_SOURCE = `# RV32IC: .option rvc packs every instruction that has a 16-bit form
        .option rvc
        li   t0, 0x80000000     # console (lui: no 16-bit form for this value)
        li   a0, 48             # '0'  (c.li)
        li   a1, 58             # past '9'
        c.li a2, 0              # a running sum, by hand with a c.* mnemonic
digit:  sw   a0, 0(t0)          # c.sw cannot reach t0: stays 32 bits
        add  a2, a2, a0         # c.add
        addi a0, a0, 1          # c.addi
        bne  a0, a1, digit      # 32 bits: too far for c.bnez, and two registers
        li   a0, 10
        sw   a0, 0(t0)
        mv   a3, a2             # c.mv
        c.slli a3, 1            # c.slli
        j    done               # c.j
        nop
done:   j    done`;

/** What it prints, and the registers it ends with (the sum of '0'..'9' = 525). */
export const RVC_TEXT = '0123456789\n';

export const NOTES_RVC = 'The C extension on a sandbox core. The program ROM (select it: C extension is ticked) answers at any even address with the 32 bits starting there; '
  + 'rv32ic_core expands a 16-bit parcel (bits 1:0 not 11) into the instruction it stands for and adds 2 to the PC instead of 4 (open the core to see the expander). '
  + 'Edit the program: `.option rvc` compresses every instruction that has a 16-bit form, or write c.* mnemonics yourself. '
  + 'RAM 64 words at 0 (word accesses), console at 0x8000_0000. The CPU drawer runs the golden model with C in lock step; the halt part stops Run at `j .`.';

/** The sandbox's RV32C computer: the C core, a halfword-reading ROM, a RAM and a console. */
export function rvcChip(id: string, name: string, src = RVC_SOURCE): ChipDoc {
  const s = new Sheet();
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  s.tap('pin:clk', 'clk');
  s.part('imem', { rom: { k: 6, w: 32, addr: 'rv32', lang: 'asm', src, c: true } }, [6, 5], { label: 'program (C)' });
  s.tap('imem.addr', 'pc'); s.tap('imem.data', 'window');
  s.part('cpu', { lib: 'rv32ic_core' }, [30, 6], { label: 'RV32IC core' });
  s.part('hart', { const: { width: 32, value: 0 } }, [24, 14]);
  s.part('grant', { const: { width: 1, value: 1 } }, [20, 18]);
  s.tap('cpu.clk', 'clk'); s.tap('cpu.instr', 'window'); s.tap('cpu.memRData', 'rdata'); s.tap('cpu.pcOut', 'pc');
  s.wire('hart.y', 'cpu.hartid'); s.wire('grant.y', 'cpu.grant');
  s.tap('cpu.memAddr', 'addr'); s.tap('cpu.memWData', 'wdata'); s.tap('cpu.memWE', 'we'); s.tap('cpu.instrOut', 'instr');
  // the halt detector: the instruction the core runs is `j .` (jal x0, 0), whether it was spelled c.j or jal
  s.part('hj', { const: { width: 32, value: 0x6f } }, [2, 20], { label: 'j .' });
  s.part('eq', { lib: 'eq32' }, [10, 19]);
  s.part('halt', { display: 'halt', width: 1 }, [16, 21]);
  s.wire('hj.y', 'eq.a'); s.tap('eq.b', 'instr'); s.wire('eq.eq', 'halt.a');
  // memory map: a31 = 0 the RAM, 1 the console
  s.part('as', { split: [2, C_RAM_K, 31 - 2 - C_RAM_K, 1] }, [60, 4]);
  s.tap('as.in', 'addr'); s.tap('as.o1', 'aw'); s.tap('as.o3', 'a31');
  s.part('bs', { split: [8, 24] }, [60, 14]);
  s.tap('bs.in', 'wdata'); s.tap('bs.o0', 'byte');
  s.part('n31', { lib: 'not' }, [72, 4]);
  s.part('ramst', { lib: 'and' }, [78, 4], { label: 'RAM store' });
  s.tap('n31.a', 'a31'); s.wire('n31.y', 'ramst.a'); s.tap('ramst.b', 'we'); s.tap('ramst.y', 'ramWe');
  s.part('cwe', { lib: 'and' }, [78, 12], { label: 'console store' });
  s.tap('cwe.a', 'a31'); s.tap('cwe.b', 'we'); s.tap('cwe.y', 'conWe');
  s.part('ram', { ram: { k: C_RAM_K, w: 32 } }, [92, 2], { label: `RAM ${2 ** C_RAM_K} × 32` });
  s.tap('ram.addr', 'aw'); s.tap('ram.din', 'wdata'); s.tap('ram.we', 'ramWe'); s.tap('ram.clk', 'clk'); s.tap('ram.dout', 'rdata');
  s.part('con', { console: { cols: 32, rows: 8 } }, [92, 16], { label: 'console' });
  s.tap('con.data', 'byte'); s.tap('con.we', 'conWe'); s.tap('con.clk', 'clk');
  return s.doc(id, name, { notes: NOTES_RVC });
}
