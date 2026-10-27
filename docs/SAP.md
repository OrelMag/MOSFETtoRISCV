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
| `ctl` | `SAP_CONTROL` | `step` 161, `dec` 138, `inv` 04, `clr` 08, `romhi` 28C16, `romlo` 28C16 | the 16 lines by name (`hlt`, `mi`, … `fi`), `t` (3) |
| `a` | `SAP_AREG` | `hi` 173, `lo` 173, `drv` 245 | `q` (8), `drv` (8) |
| `alu` | `SAP_ALU` | `add0` 283, `add1` 283, `x0` 86, `x1` 86, `drv` 245 | `sum` (8), `drv` (8), `cout`, `zero` |
| `flags` | `SAP_FLAGS` | `reg` 173, zero detect (`nor` 02 / `and` 08) | `cf`, `zf` |
| `b` | `SAP_BREG` | `hi` 173, `lo` 173 | `q` (8) |
| `out` | `SAP_OUT` | `reg` 273, `clk` 08 | `q` (8) |
| `disp` | `SAP_DISPLAY` | `rom0` `rom1` `rom2` 28C16 | `d0` `d1` `d2` (8 segments each) |
| `bus` | `SAP_BUS` | OR per bit | `bus` (8), `clash` |

`sapComputer(bytes)` (memoized by content): the RAM's power-on contents from `bytes` (dotted `powerOn` hints, as
`editor/memory.ts ramWithInit`). Ports: in `clk` (clock), `prog` (programming mode), `addrSw` (4), `dataSw` (8),
`write`, `rst` (RESET); out `bus` (8), `out` (8), `d0` `d1` `d2`, `halt`, `clash`. Hand-placed top level (two columns of modules
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

## As built (src/sap, src/lib/ttl.ts, src/lib/sap.ts): ids, paths and changes to the contract

**Chip ids** (`TTL_PINS` keys; `ttlKind(def)` maps a def to its key, `TTL_PART[key]` the printed part number,
`TTL_ACTIVE_LOW[key]` the pins drawn with an overbar): `ls00 ls02 ls04 ls08 ls32 ls86 ls138 ls139 ls157 ls161 ls173
ls189 ls245 ls273 ls283 ls76 ne555`, and `at28c16` for every `eeprom2k(image)` (id `at28c16_<hash>`). `TTL_PINS[key]`
is an array: `pins[n - 1]` is DIP pin n, `{ name, port?, bit? }` (VCC / GND / the 555's pins have no port). Ports group
pins into buses (`ls173`: `m n g1_n g2_n clr clk d[4] → q[4]`; `ls245`: `dir oe_n a[8] → b[8]`; `ls161`: `clr_n clk d[4]
enp ent load_n → q[4] rco`; `ls189`: `a[4] cs_n we_n d[4] → q_n[4]`; `ls157`: `a[4] b[4] s g_n → y[4]`; `ls138`: `a[3] g1
g2a_n g2b_n → y_n[8]`; `ls283`: `a[4] b[4] c0 → s[4] c4`; `ls273`: `clr_n clk d[8] → q[8]`; quad gates `a[4] b[4] →
y[4]`, `ls04`: `a[6] → y[6]`; `at28c16`: `addr[11] ce_n oe_n we_n → data[8]`). Helper parts: `dffe_r` (DFF_R + a mux:
the 173's flip-flop), `latch4` and `ram16x4l` (the 189's store: level-sensitive D latches), `d_latch_sr` and `jkff_n`
(the 76's falling-edge JK).

**Modules** (`sapChips(def)` lists every chip with its path and key; `sapCost(def)` chips, NANDs, and NANDs without the
EEPROMs' ROM trees; `SAP_STATE` where a register is read: `[instance path, port]`, e.g. A = `a.hi.q`:`a.lo.q`, flags
= `flags.reg.q` bit 0 CF, bit 1 ZF):

| module | ports (in → out) |
|---|---|
| `SAP_CLOCK` | `osc` (clock), `hlt` → `clk`, `nclk` |
| `SAP_PC` | `clk ce co j bus[8] rst` → `pc[4] drv[8]` |
| `SAP_MAR` | `clk mi prog bus[8] addrSw[4]` → `addr[4]` |
| `SAP_RAM` | `clk addr[4] bus[8] dataSw[8] prog write ri ro` → `q[8] drv[8]` |
| `SAP_IR` | `clk ii io bus[8] rst` → `op[4] ir[8] drv[8]` |
| `SAP_CONTROL` | `nclk op[4] cf zf rst` → the 16 lines (`hlt mi ri ro io ii ai ao eo su bi oi ce co j fi`; ΣO is `eo`), `t[3]`, `ts[5]` |
| `SAP_AREG` | `clk ai ao bus[8] rst` → `q[8] drv[8]` |
| `SAP_ALU` | `a[8] b[8] su eo` → `sum[8] drv[8] cout` |
| `SAP_FLAGS` | `clk fi sum[8] cout rst` → `cf zf` |
| `SAP_BREG` | `clk bi bus[8] rst` → `q[8]` |
| `SAP_OUT` | `clk oi bus[8]` → `q[8]` |
| `SAP_DISPLAY` | `v[8]` → `d0[8] d1[8] d2[8]` |
| `SAP_BUS` | `pc ram ir a alu` (8 each), `co ro io ao eo` → `bus[8] clash` |

`SAP_COMPUTER` (id `sap1`, empty RAM) is registered, so the registry-wide layout / route / sandbox round-trip tests cover
it; `sapComputer(bytes)` returns it for an all-zero RAM, else an unregistered copy (id `sap1_<the 16 bytes in hex>`) whose
`powerOn` hints (`ls189Init`) put the bytes into the 189s' latches (`ram.lo.mem.w<i>.l<j>.sr.q`): like
`editor/memory.ts ramWithInit`, because a sandbox document cannot hold hints that reach into sub-chips. Top-level net labels: `CLK`, `NCLK`, `BUS`, `A`, `B`, `Σ`, `OUT`, `CF`, `ZF`, `opcode`, and the
control lines in capitals (`ΣO`).

**Changes to the contract, and why**

- The clock module's input is `osc` (its output is `clk`, and a part cannot have two ports of one name).
- Modules carry the inverters the active-high rule needs, as extra 74LS04s named `inv`: `pc` (J → LOAD, CO → G), `mar`
  (MI), `ir` (II, IO), `a` (AI, AO), `b` (BI), `alu` (ΣO), `flags` (FI). The RAM's come from the spare gates of `ilo`.
- RAM writes: `ram.w` (74LS08) makes RI · CLK and `ram.wsel` (74LS157) picks it or the write button (programming mode);
  `ilo`'s spare inverters give the 189s' WE and the 245's G. The 189 writes while WE is low, so the write happens
  while the clock is high: at the rising edge in effect (nothing on the bus changes during an `AO RI` step), which is
  the golden model's rising-edge write.
- The zero test lives in `flags` (`nor`, `and`, as the table says), so `alu` has no `zero` output. Flags register:
  bit 0 CF, bit 1 ZF.
- `ctl` has one more output, `ts[5]`: the step LEDs (T0–T4 one-hot) from `ctl.inv`. The step counter wraps by the 138's
  Y5 on the 161's (asynchronous) CLR, as Ben wires it.
- The 245 is modelled A → B only (DIR tied high on every board); the 28C16's WE is drawn, not simulated.
- 7-segment bits follow the site's display part: bit 0 = segment a … bit 6 = g (not Ben's wiring order). The display
  EEPROM is addressed `[signed A10][digit A9–A8][value A7–A0]`, Ben's layout; `disp.romK` has digit K tied.
- `NE555` has no ports (drawn only).
- "Count up" counts by 15 and stops when the adder carries (a program that never halts cannot be checked to its end).
- `SapISS.halted` is a getter: the current control word has HLT (the hardware's `halt` output at the same moment);
  `drive()` gives the bus and how many drive it, `control()` the current control word, `run()` OUT's values.
- Cost: five EEPROMs as ROM trees are 65 524 NANDs each; `sapCost(...).logicNands` (3 314) is the rest.
- **RESET** (`rst`, active high, Ben's reset button): the CLRs of the PC's 161 (through `pc.inv`), the step counter's 161
  (`ctl.clr`, a 74LS08: Y5 AND NOT RST, NOT RST from `ctl.inv`'s sixth gate), and the 173s of A, B, the IR and the flags.
  The MAR, OUT and the RAM keep their contents (their CLRs stay inactive), so a program keyed in by the switches survives
  it: PROG on, key in, PROG off, RESET, run, at any time. `SapISS.reset()` clears the same; `cycle(true)` is a period with
  RESET held (only the MAR moves: T0 of NOP is CO MI). The monitors (widgets/sapmon.ts, editor/sapmon.ts) follow RESET
  held through an edge with `cycle(true)`, and one pressed between edges by taking `reset()` when the hardware holds what
  a reset leaves (PC, step, IR, A, B, flags all 0) and the model does not. The clock board has a RESET switch; the
  sandbox example a RESET key (E). Cost: one more chip (49) and 8 NANDs.
