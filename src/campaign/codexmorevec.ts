// The fuller codex for the Vectors chapter (codexvec.ts holds the summaries; numbers pinned by tests/content-codexvec.test.ts). No DOM.

import type { CodexMore } from './codexmore';

export const MOREVEC: Record<string, CodexMore> = {
  vlen: {
    idea: `A fixed-width SIMD instruction set (SSE, AVX, NEON) puts the width in the opcode: an AVX-512 add works on 16 floats, and a machine with wider registers needs new instructions and
      recompiled programs. RISC-V's vector extension keeps the width out of the instruction. Each implementation picks VLEN, the bits in a vector register, and a program asks how much it may do:
      <code>vsetvli rd, rs1, e32, m1</code> gives rs1 as the number of elements left, SEW (here 32) as their width and LMUL (here 1) as the grouping, and gets back vl = min(rs1, VLMAX) with
      VLMAX = LMUL · VLEN / SEW. Every following vector instruction works on elements 0 to vl − 1 and leaves the rest of the register alone. The same instruction sets <code>vtype</code>
      (SEW, LMUL, the tail and mask policies), which the decoder checks each vector instruction against.`,
    example: {
      title: 'VLMAX at e32',
      body: `<pre>VLEN   m1   m2   m4   m8
128     4    8   16   32     our unit
256     8   16   32   64
512    16   32   64  128</pre><code>vsetvli t0, a0, e32, m4</code> with a0 = 37 on our unit: t0 = vl = 16. With a0 = 5: vl = 5, and elements 5 to 15 are the tail.`,
    },
    mistakes: [
      'Reading VLEN as a number of elements. It is bits per register; at e32 a 128-bit register is four elements.',
      'Hard-coding the element count in a loop. The answer of <code>vsetvli</code> is the only portable count; it differs between machines.',
      'Forgetting that vl is state: every vector instruction after a <code>vsetvli</code> uses it, until the next one.',
    ],
    lib: 'vsetvl',
    chapters: [{ chapter: 'vectors', step: 2, label: 'The length in a register' }, { chapter: 'vectors', step: 3, label: 'Thirty-two registers, regrouped' }],
  },
  stripmine: {
    idea: `Cutting a long loop into pieces the hardware can take in one go is called strip-mining. On a fixed-width machine the piece is the register width, and the leftover elements need a
      scalar tail loop (or a masked last pass). With a vector length register the hardware gives the size of each piece: the loop asks for n, gets vl, does vl elements, moves its pointers
      on by vl elements and asks again with n − vl. The last answer is simply smaller. The loop has one body and no tail, and VLEN appears nowhere in it, so the same binary runs on a narrow
      embedded core and on a wide one, taking fewer passes on the wide one.`,
    example: {
      title: 'y = 3·x + y, n = 37, at m1',
      body: `<pre>VLEN   vl a pass              passes   instructions
128    4 4 4 4 4 4 4 4 4 1       10       124
256    8 8 8 8 5                 5        64
512    16 16 5                   3        40</pre>At m8 on VLEN 128, n = 100 is four passes: 32, 32, 32 and 4.`,
    },
    mistakes: [
      'Moving the pointers by VLEN / 32 instead of by the vl just returned: the last pass then overruns the arrays.',
      'Writing a scalar tail loop anyway. The last <code>vsetvli</code> already returns the short count.',
      'Asking for vl once, outside the loop. Each pass must ask again with what is left.',
    ],
    chapters: [{ chapter: 'vectors', step: 2, label: 'The length in a register' }, { chapter: 'vectors', step: 1, label: 'Fixed width and its tail' }],
  },
  lmul: {
    idea: `With 32 registers of VLEN bits, a short VLEN means many instructions for a long vector. LMUL lets one instruction name a group of 2, 4 or 8 neighbouring registers as one: at m4,
      <code>v8</code> means v8 to v11. VLMAX grows by the same factor, so the loop takes fewer passes and fewer instructions, and each instruction does more work. The price is names: only
      32 / LMUL groups exist, and a group must start at a multiple of LMUL (v10 is refused at m4). How long an instruction takes depends on the machine; ours has four lanes and takes one beat
      per register of the group, so an m8 instruction is eight beats.`,
    example: {
      title: 'The 16-element kernel by LMUL, on our unit',
      body: `<pre>LMUL   instructions   cycles
m1          59           74
m2          35           62
m4          23           56
m8          23           80</pre>m8 is slower than m4: sixteen elements fill only half of an eight-register group, and our unit runs every beat of a group whether its elements are inside vl or not.`,
    },
    mistakes: [
      'Naming a group at an odd register: at m2, <code>v3</code> is illegal: a full system traps, and the user-mode CPU does nothing.',
      'Assuming a larger LMUL is always faster. With few elements, or a unit that steps through the whole group, it can be slower.',
      'Forgetting that v0 is the mask: a group starting at v0 overlaps the mask register.',
    ],
    lib: 'vgroup',
    chapters: [{ chapter: 'vectors', step: 3, label: 'Thirty-two registers, regrouped' }, { chapter: 'vectors', step: 9, label: 'Vectors, lanes, cores' }],
  },
  vmask: {
    idea: `An if inside a loop over elements cannot be a branch: the elements share one instruction stream. Instead a compare writes a bit per element into v0, and instructions written with
      <code>v0.t</code> change only the elements whose bit is 1 (the others keep their value: <i>mask undisturbed</i>). <code>vmerge</code> chooses between two sources by the mask, which turns
      a clamp, an absolute value or a select into straight-line code. The mask is explicit: the program computes it and names it. The SIMT lanes of the following chapters keep a mask too, but
      set it from branches, without the program naming it.`,
    example: {
      title: 'Clamp at 6 without a branch',
      body: `<pre>vid.v      v8                v8 = 0 1 2 3 4 5 6 7
vmsgt.vx   v0, v8, a2        a2 = 6: v0 = 0x80, only bit 7 set
vmerge.vxm v24, v8, a2, v0   v24 = 0 1 2 3 4 5 6 6</pre>In the gates a masked-off element is a write enable left low: the lane computes and does not write.`,
    },
    mistakes: [
      'Expecting a masked instruction to be faster: in our unit, and in most, a masked-off element still takes its place in its beat.',
      'Using v0 as a data register in a loop that also needs it as the mask.',
      'Confusing mask-undisturbed with mask-agnostic: with <code>ma</code> the hardware may overwrite masked-off elements with all 1s instead of leaving them.',
    ],
    lib: 'vmasknib',
    chapters: [{ chapter: 'vectors', step: 6, label: 'A mask you can see' }, { chapter: 'vectors', step: 7, label: 'Adding up a vector' }],
  },
  chaining: {
    idea: `A vector instruction produces its result one element group at a time. If the next instruction needs that result, it need not wait for the whole vector: it can start on group 0
      as soon as group 0 is written, one step behind its producer. This is chaining, the vector form of the pipeline's forwarding. It needs separate functional units (so the producer and
      the consumer can run at the same time), a ready bit per register group, a path from each unit's result to the next unit's input in every lane, and an instruction queue so the scalar
      core runs ahead. The Cray-1 (1976) chained its load, multiply and add units; modern vector units do it as a matter of course. Our unit in gates runs one instruction at a time.`,
    example: {
      title: 'The loop body of y = 3·x + y, cycles by LMUL',
      body: `<pre>groups   one at a time   separate units   chained
1               6               6             6
2              12              11             9
4              24              21            15
8              48              41            27</pre>vle32 x, vle32 y, vsll x·2, vadd 3x, vadd 3x + y, vse32 y: one cycle per group in each unit.`,
    },
    mistakes: [
      'Expecting chaining to help a single element group: with one group there is nothing to overlap.',
      'Chaining through one shared unit: two instructions cannot use the same adder in the same cycle, so the second waits for the first.',
      'Thinking chaining reorders instructions. Each one still starts in program order; it only starts sooner.',
    ],
    chapters: [{ chapter: 'vectors', step: 8, label: 'Chaining' }],
  },
};
