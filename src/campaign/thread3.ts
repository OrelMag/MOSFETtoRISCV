// The thread (thread.ts), acts 9–10 (the GPU, memory): filled per act (see thread0.ts for the shape). Every level
// here is optional, so every dependent gets a clause. A lane part names the CPU block it replicates; the
// rasterizer's parts name none (nothing in the CPU is like them); act 10's parts name the block they stand behind.
// Numbers are measured and pinned by tests/content-acts910.test.ts. No DOM.

import type { NodeThread } from './thread';

export const THREAD3: Record<string, NodeThread> = {
  // ---- Act 9: lanes -------------------------------------------------------------------------
  k_lesson: {
    usedFor: {
      k_lanes: 'the datapath replicated: four ALUs on one control unit',
      k_vrf: 'the registers replicated: what a lane costs',
      k_mask: 'the lanes that have no work switched off',
      k_edge: 'the first piece of the fixed-function rasterizer that sits beside the lanes',
    },
    pitfalls: [
      'Lanes are not cores: one PC, one fetch, one decode. Four lanes run one program, never four.',
      'A masked lane still computes and drives its address; it only writes nothing.',
      'Throughput is lanes × utilization: four lanes with half of them masked do the work of two.',
    ],
  },
  k_lanes: {
    uses: ['alu'],
    usedFor: { k_simd: 'its execute step: the four lanes take the decoded alu, bimm and immediate from the one control unit' },
    pitfalls: [
      'Decoding per lane: alu, bimm and imm are the same for every lane, so they are wires fanned out, not four decoders.',
      'nz tests rs1 (the a operand), not the ALU result: split asks whether a register is zero.',
      'Taking nz from the ALU\'s zero flag: it tests the result, and it is the ALU\'s deepest output.',
    ],
  },
  k_vrf: {
    uses: ['rf'],
    usedFor: { k_simd: 'the lanes\' registers: ra1, ra2 and wa from the one instruction, a write enable and a data word per lane' },
    pitfalls: [
      'One shared write-data input: every lane then stores lane 0\'s result. Each lane writes its own wd<sub>i</sub>.',
      'One write enable for all four: the mask has nothing to switch off. Split we into a bit per lane.',
      'x0 must read 0 in every lane, not only lane 0.',
    ],
  },
  k_mask: {
    uses: ['ctl'],
    usedFor: { k_simd: 'gates the register and memory write enables; the leader steers the branch operands' },
    pitfalls: [
      'Reset must load 1111: a mask that powers up 0000 runs a program in which nothing ever writes.',
      'The leader is the lowest active lane, not lane 0: with lane 0 masked the warp\'s branches follow lane 1.',
      'Gating only the register write: a masked lane must not store either, so dwe needs the mask too.',
    ],
  },
  k_simd: {
    usedFor: {
      k_stack: 'the core whose branches the stack corrects: it follows the leader',
      k_simt: 'the starting point: the stack, a PC mux and a mask mux are added to it',
      p_saxpy: 'the machine saxpy is written for: four lanes, one stream, no divergence',
      k_coal: 'its four memory ports are what the coalescer would merge into one',
    },
    pitfalls: [
      'Branching on lane 0\'s registers instead of the leader\'s: once tmc masks lane 0 the warp follows a lane that is off.',
      'Per-lane next-PC logic: there is one PC; only the operands that steer it come from the leader.',
      'pc + 1 and the immediate are the same for every lane: one copy of each, fanned out to the result muxes.',
      'tid written as one number: each lane must get its own, 0 … 3.',
    ],
  },
  k_stack: {
    uses: ['npc'],
    usedFor: { k_simt: 'split pushes an entry, join reads the top to jump to the else lanes or restore and pop' },
    pitfalls: [
      'Pending is set only when both sides have lanes: an if every lane agrees on must not jump back.',
      'A split whose lanes disagree is joined twice: the first join runs the else lanes, the second restores and pops.',
      'The saved mask is the one before the split, not the then lanes: restoring the then lanes leaves the else lanes off after the if.',
      'A push shifts every entry down; a fifth nested split drops the bottom one.',
    ],
  },
  k_simt: {
    usedFor: {
      p_reduce: 'the mask (tmc, or split / join) that lets the spare lanes sit out the combine',
      k_warps: 'the starting point: its state is duplicated, its front end and lanes stay shared',
    },
    pitfalls: [
      'Mask priority: when tmc runs it wins over the stack\'s value.',
      'The PC mux to jpc goes after the next-PC choice, so a join\'s jump overrides pc + 1 and any branch.',
      'split\'s predicate is each lane\'s nz (rs1 ≠ 0), not the leader\'s: the leader only steers branches.',
    ],
  },
  p_saxpy: {
    pitfalls: [
      'Forgetting tid: every lane walks the same elements, and three quarters of the array is never written.',
      'Stepping by 1 instead of 4: the lanes trample each other\'s elements.',
      'Branching on data that differs per lane: on the SIMD core the leader decides for everyone. Only a, the same in every lane, may steer the loop.',
    ],
  },
  p_reduce: {
    pitfalls: [
      'Combining in registers: a lane cannot read another lane\'s registers, so the partial sums go through memory.',
      'Every lane repeating the combine: correct and a cycle faster, but three of four lanes add up a sum nobody needs, and lane-ops are graded.',
      'A tree is not free here: each round is a store, a load and an add through memory, and on four lanes it is a cycle longer than lane 0 adding three words.',
    ],
  },

  // ---- Act 9: warps -------------------------------------------------------------------------
  k_coal: {
    uses: ['dmem'],
    usedFor: { k_warps: 'required before it, but not placed: the two-warp core keeps a memory port per lane' },
    pitfalls: [
      'Comparing whole addresses: lanes share a line when bits 15 … 2 match, not the full word address.',
      'An inactive lane must never be served: AND every comparison with its mask bit.',
      'Lane 0 needs no comparator: when it is active it is the leader and always served.',
    ],
  },
  k_warps: {
    usedFor: {
      p_hist: 'two warps and bar: the machine the histogram is written for',
      k_frame: 'the starting point: the rasterizer is added as a device on lane 0\'s port',
    },
    pitfalls: [
      'Writing a returning load into the issuing warp\'s registers: the word belongs to the other warp, the one that asked a cycle ago.',
      'Two writers to one register file in a cycle: its own warp\'s results and the returning load must never both write it.',
      'A PC that moves when its warp did not go (held at bar, or no lanes): that warp skips an instruction.',
      'bar with one warp ended: a warp with no lanes must count as arrived, or the other waits forever.',
    ],
  },
  p_hist: {
    pitfalls: [
      'Shared counters: two threads that load, add 1 and store one word lose a count. Give every thread its own.',
      'No bar between counting and summing: right while the warps take turns, wrong when warp 1 runs ahead.',
      'Thread-major counters (16·t + b): a bin\'s eight counters are then 16 words apart, beyond the reach of lw\'s 6-bit offset.',
    ],
  },

  // ---- Act 9: pixels ------------------------------------------------------------------------
  k_edge: {
    usedFor: { k_tile: 'the walk turns each position into one of the stepper\'s commands' },
    pitfalls: [
      'Forgetting R: a new band must start from where the last one started, not from where the serpentine ended.',
      'Subtracting for every command: only up moves against B; the others add.',
      'inside is E ≥ 0, so it is NOT of the sign bit, not the sign bit.',
    ],
  },
  k_tile: {
    usedFor: { k_raster: 'its commands drive the three steppers; its TEST cycle reads their tile tests' },
    pitfalls: [
      'The serpentine reverses in odd columns: without the XOR the walk jumps back three pixels, and a stepper only moves one.',
      'Commands while idle: every output must be 0 when busy is 0, or the steppers drift between triangles.',
      'A tile is done on a failed TEST or after k = 15, not only after k = 15.',
    ],
  },
  k_raster: {
    usedFor: { k_frame: 'the device the frame core feeds through six vertex registers and a colour' },
    pitfalls: [
      'The sign bit of Δx weighs −128: the first shift-and-add step subtracts, the other seven add.',
      'The top-left bias: without it two triangles sharing an edge both draw it.',
      'The tile test uses the edge at the tile\'s best corner, E + 12·(A⁺ + B⁺): testing the top-left pixel alone rejects tiles that are partly inside.',
    ],
  },
  k_frame: {
    uses: ['mmio'],
    usedFor: { p_spin: 'the machine Spin draws on: lanes, two warps and the rasterizer behind lane 0\'s port' },
    pitfalls: [
      'Holding with the gated write enables: they depend on go, which the hold drives. Use the instruction\'s own signals.',
      'A load from the screen while the rasterizer draws reads a half-drawn picture: hold it.',
      'go straight from the colour store: the colour register holds the new value only after the edge, so go comes from a flip-flop, a cycle later.',
    ],
  },
  p_spin: {
    pitfalls: [
      'Clearing with one thread: the clear is most of the frame, so give all eight a share.',
      'Missing the second bar: warp 1 clears the next frame before lane 0 has drawn this one.',
      'Turning a corner with the old x in the second line: Minsky\'s rule uses the new x, which keeps the square from spiralling outward.',
    ],
  },

  // ---- Act 10: DRAM -------------------------------------------------------------------------
  m_lesson: {
    usedFor: {
      m_sense: 'the bit line and the sense amplifier, at switch level',
      m_bus: 'the other masters that want the same memory',
      m_flash: 'the memory that keeps the program at power-off',
    },
    pitfalls: [
      'A DRAM read is destructive: the cell shares its charge with the bit line, and the amplifier has to write it back.',
      'Refresh is the controller\'s job, in cycles taken from the requests: nothing in the processor does it.',
      'Behind a cache, latency is paid on misses only: the cache sets how often, the controller how long.',
    ],
  },
  m_sense: {
    uses: ['dmem'],
    usedFor: { m_bank: 'a row of these amplifiers is the bank\'s row buffer' },
    pitfalls: [
      'A reference line with no capacitance: once pre falls it has no level to keep, and the amplifier compares against nothing.',
      'Precharging the reference line on its own: the equalizer between the lines gives it VDD/2 through the bit line.',
      'Anything but the amplifier and the write driver on the reference line unbalances it.',
    ],
  },
  m_bank: {
    uses: ['dmem'],
    usedFor: { m_ctrl: 'the same requests, with refresh and the row buffers moved into the chip and its timings kept instead' },
    pitfalls: [
      'Refreshing only when nobody asks: under a steady stream of requests a row leaks away. A due refresh goes ahead of any request.',
      'Closing the row after every access: the next request to it pays an ACT it did not need.',
      'Leaving the refreshed row closed: the next request may want it, so leave it open.',
    ],
  },
  m_ctrl: {
    uses: ['dmem'],
    usedFor: { o_cache: 'what the cache saves the core from: 4 cycles on an open row, 12 on another' },
    pitfalls: [
      'Counting from the wrong event: tRCD and tRAS count from the ACT, tRP from the PRE.',
      'Waiting 4 after a REF: the next ACT may come only tRFC = 12 cycles later.',
      'Refresh with a bank open: REF needs every bank closed, so PREA first, once tRAS allows.',
    ],
  },
  o_cache: {
    uses: ['dmem'],
    pitfalls: [
      'Valid bits that power up as anything: a stale line would hit. Every valid bit starts at 0.',
      'Comparing the index instead of the tag: the index picks the line, the tag (addr[7:3]) says whose it is.',
      'Not filling on a read miss: the next read of the same word misses again.',
    ],
  },

  // ---- Act 10: bus, DMA, flash --------------------------------------------------------------
  m_bus: {
    uses: ['dmem', 'mmio'],
    usedFor: { m_dma: 'the engine is its second master: a read and a write transfer per word' },
    pitfalls: [
      'Re-arbitrating mid-transfer: while a slow slave holds ready low the grant must stay with its owner.',
      'Raising every master\'s ready: only the granted one sees its transfer finish.',
      'Plain priority: a master that always asks starves the other. Round robin gives the turn to whoever was not served last.',
    ],
  },
  m_dma: {
    uses: ['mmio'],
    usedFor: { p_boot: 'copies the table out of flash while the program runs; its interrupt says when' },
    pitfalls: [
      'A count compared against len: loading NOT len and counting up gives done as the incrementer\'s carry, with no comparator, len = 0 included.',
      'Changing the address while ready is 0: the slave may still be reading it.',
      'Stepping src and dst on the read: they step after the write, once the word has landed.',
    ],
  },
  m_flash: {
    uses: ['mmio'],
    usedFor: { p_boot: 'the memory the table waits in: every load from it stalls 8 cycles' },
    pitfalls: [
      'Programming a page twice: flash only turns 1s into 0s; a page is written once per erase.',
      'Erasing a block whose pages are still live: copy each page the table still points at before the erase.',
      'Updating the table when the program finishes: fq shows the read page only until the next command, so update when you issue it.',
    ],
  },
  p_boot: {
    pitfalls: [
      'Loading the table straight from flash: correct, 8 stall cycles a word.',
      'Waiting for the whole copy before summing: correct, but the processor idles while the engine works.',
      'Summing a word before it has landed: read the count first, and only sum what has been copied.',
    ],
  },
};
