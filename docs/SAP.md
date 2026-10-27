# Appendix C: the breadboard computer (SAP-1)

Ben Eater's 8-bit breadboard computer (his video series, 2016–2017), itself SAP-1 from Malvino and Brown, *Digital
Computer Electronics*. Credit both in the chapter; no use of his branding. Approved 2026-10-27, with the breadboard
view mockup (https://claude.ai/artifact/S6UqobtefnYREYgfMBh87t: Main = the whole computer on breadboards, Drill = a
74LS173 opened).

## Decisions

- **Appendix C**, after the 6502 (A) and Doom (B): `src/chapters/ch-sap.ts`, `id: 'appendix-sap'`, `appendix: 'C'`.
- **Every module is built from 74xx chips** (`src/lib/ttl.ts`), and every chip from our gates, so the drill goes
  computer → module board → 74LS173 → DFFE_R → NAND → MOSFET.
- **The bus at gate level is a wired OR**: every 3-state driver (74LS245, the 173's M / N outputs) is modelled as
  `value AND enable`, a disabled output reads 0 (the bus has pull-downs), and the bus is the OR of the drivers.
  `sap_bus` also outputs `clash` (two or more drivers enabled). One chapter step shows the real thing at switch level:
  three TRIBUFs on one line, contention drawn as a named short (`switchsim` shorts).
- **Control lines are active high in the microcode.** Where a chip pin is active low (173 G1 / G2, 245 OE, 161 LOAD,
  189 WE) the module has the inverter. Ben's own EEPROM stores some lines inverted; the chapter says so once.
- **Timing, as Ben's**: registers, the PC and RAM writes take effect at the rising edge of the gated clock; the step
  counter (a 74LS161) is clocked by the inverted clock, so the control word changes on the falling edge. HLT gates
  the clock (`clk AND NOT hlt`). So the computer runs on GateSim, not the cycle engine (a gated clock): fine at this
  size. RAM writes are synchronous at the rising edge with RI (Ben's 74LS189 writes while WE is low, from an RC pulse):
  said once.
- **Display**: OUT is a 74LS273 clocked by `clk AND OI` (as Ben's). Ben multiplexes one 28C16 over four digits with a
  555 and a 74LS76; we draw that, but simulate three static copies of the decoder table (no second clock). Said once.
- **The 555s are drawn, not simulated**: the stage's clock stands in for the clock module's astable. Said once.
- The TTL-vs-CMOS note (the real chips are bipolar TTL; we build their logic from our CMOS NANDs) is said once, the
  first time a 74xx chip is opened.

## The ISA (Ben's, with the flags)

16 bytes of RAM, 8-bit words: opcode in the high nibble, operand (address or immediate) in the low nibble.

| op | mnemonic | T2 | T3 | T4 |
|---|---|---|---|---|
| 0 | NOP | | | |
| 1 | LDA a | IO MI | RO AI | |
| 2 | ADD a | IO MI | RO BI | ΣO AI FI |
| 3 | SUB a | IO MI | RO BI | ΣO AI SU FI |
| 4 | STA a | IO MI | AO RI | |
| 5 | LDI n | IO AI | | |
| 6 | JMP a | IO J | | |
| 7 | JC a | IO J (if CF) | | |
| 8 | JZ a | IO J (if ZF) | | |
| 9–D | (NOP) | | | |
| E | OUT | AO OI | | |
| F | HLT | HLT | | |

Fetch, every instruction: T0 `CO MI`, T1 `RO II CE`. Every instruction takes five steps (T0–T4); the step counter
wraps after T4. Control word bits, high to low (Ben's order): `HLT MI RI RO IO II AI AO ΣO SU BI OI CE CO J FI`
(`SAP_CTRL` in `src/sap/isa.ts`). EEPROM address: `[flags ZF CF][opcode 4][step 3]` (9 bits used of the 28C16's 11);
two EEPROMs, high byte and low byte of the control word. CF = carry out of the 8-bit adder (for SUB: no borrow),
ZF = sum = 0; both loaded by FI.

## Files

- `src/sap/isa.ts`: opcodes, `SAP_CTRL`, `microcode(op, step, cf, zf)` (the control word), `SAP_ROM_HI / LO` (the two
  EEPROM images), `disasm`.
- `src/sap/asm.ts`: two-pass assembler (labels, decimal / 0x / 0b numbers, `.byte`, `org`-less: address = line order),
  ≤ 16 bytes, errors with lines.
- `src/sap/iss.ts`: `SapISS`: the golden model, cycle exact. State pc, mar, ir, a, b, out, cf, zf, step, ram[16],
  halted, and the last cycle's bus and control word. `cycle()` = one clock period (the control word of the current
  step, the bus, the rising edge, then the falling edge's step advance). `save()` / `restore()`.
- `src/sap/programs.ts`: samples with their expected OUT sequence: count up, add two numbers, Fibonacci, multiply
  (Ben's, with JC), count down to zero with JZ.
- `src/lib/ttl.ts`: the 74xx chips as library parts (`define`, category `ttl`), each with `spec` or a behaviour test,
  and `TTL_PINS[id]`: DIP pin number → port bit (for the breadboard view and the chip's pin card). At least: 74LS00,
  04, 08, 32, 86, 138, 139, 157, 161, 173, 189, 245, 273, 283, 76; 28C16 (`eeprom2k(image)`: memoized by content,
  `preferBehavior` lookup over a ROM tree); NE555 (drawn only: no ports that simulate; a part the breadboard draws).
- `src/lib/sap.ts`: the modules and the computer. Instance names are a contract (the breadboard layout, the chapter
  and the monitor use them):

| top instance | def | chips inside (instance names) | outputs of note |
|---|---|---|---|
| `clock` | `SAP_CLOCK` | `inv` 04, `and` 08 | `clk` (gated), `nclk` |
| `pc` | `SAP_PC` | `cnt` 161, `drv` 245 | `pc` (4), `drv` (8) |
| `mar` | `SAP_MAR` | `reg` 173, `sel` 157 | `addr` (4) |
| `ram` | `SAP_RAM` | `lo` 189, `hi` 189, `ilo` 04, `ihi` 04, `dlo` 157, `dhi` 157, `drv` 245 | `q` (8), `drv` (8) |
| `ir` | `SAP_IR` | `hi` 173, `lo` 173, `drv` 245 (low nibble) | `op` (4), `ir` (8), `drv` (8) |
| `ctl` | `SAP_CONTROL` | `step` 161, `dec` 138, `inv` 04, `romhi` 28C16, `romlo` 28C16 | the 16 lines by name (`hlt`, `mi`, … `fi`), `t` (3) |
| `a` | `SAP_AREG` | `hi` 173, `lo` 173, `drv` 245 | `q` (8), `drv` (8) |
| `alu` | `SAP_ALU` | `add0` 283, `add1` 283, `x0` 86, `x1` 86, `drv` 245 | `sum` (8), `drv` (8), `cout`, `zero` |
| `flags` | `SAP_FLAGS` | `reg` 173, zero detect (`nor` 02 / `and` 08) | `cf`, `zf` |
| `b` | `SAP_BREG` | `hi` 173, `lo` 173 | `q` (8) |
| `out` | `SAP_OUT` | `reg` 273, `clk` 08 | `q` (8) |
| `disp` | `SAP_DISPLAY` | `rom0` `rom1` `rom2` 28C16 | `d0` `d1` `d2` (8 segments each) |
| `bus` | `SAP_BUS` | OR per bit | `bus` (8), `clash` |

`sapComputer(bytes)` (memoized by content): the RAM's power-on contents from `bytes` (dotted `powerOn` hints, as
`editor/memory.ts ramWithInit`). Ports: in `clk` (clock), `prog` (programming mode), `addrSw` (4), `dataSw` (8),
`write`; out `bus` (8), `out` (8), `d0` `d1` `d2`, `halt`, `clash`. Hand-placed top level (two columns of modules
with the bus between them, as the breadboards), net labels for the 16 control lines.

- `src/view/breadboard.ts` (+ `src/styles/breadboard.css`): the breadboard view, `Scene.breadboard`: a layout (boards
  at grid positions, each naming its module instance and listing its chips by instance path, LEDs by net path + bit
  and colour, DIP switches by input pin, 7-segment digits by output, the bus strip) drawn over the same simulation as
  the schematic; the stage toolbar gets a Schematic | Breadboard toggle. A chip's hover card (part, role, inside,
  cost); double-click opens the chip's own drill (the schematic of that instance, with its DIP pin card live).
  Both themes; phone width.
- `src/widgets/sap.ts`: the SAP panel (control word LEDs by name, the microcode row of this step, the program listing
  with the PC, RAM contents, the golden model in lock step at every rising edge), `sapScene(program, opts)`.
- `src/editor/examplesap.ts`: Examples ▸ SAP-1 breadboard computer (the modules as user chips, DIP switches, the
  display, a halt part).
- Tests: `tests/sap-iss.test.ts` (assembler, ISS on every sample), `tests/sap.test.ts` (every ttl part's spec, every
  module, the computer in lock step with the ISS every cycle on every sample program), the registry-wide layout /
  route tests cover the new defs.

## Chapter outline (his video order)

1. The machine and its bus (the whole computer; what SAP-1 is; the cost line: chips and NANDs).
2. Clock (gated by HLT; manual step vs astable; the 555 is drawn, not simulated).
3. Registers and the bus (A register: 173 + 245; the wired-OR stand-in; the switch-level tri-state step with a short).
4. The ALU (283 ×2, XOR for SUB, the 245; flags).
5. RAM and the memory address register (189's inverted outputs, programming mode with DIP switches).
6. Program counter (161, CE, CO, J).
7. Output (273 clocked by CLK·OI, the EEPROM decoder, multiplexing explained).
8. Microcode (step counter, 138, two 28C16; the control word table; T0–T1 fetch).
9. Flags and conditional jumps (JC, JZ; the EEPROM address gains the flags).
10. Programs (Fibonacci, multiply): run them; cost against our RV32I.
Recap: keep, three checks, practise.
