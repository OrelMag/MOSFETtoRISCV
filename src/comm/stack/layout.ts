// Where things sit in a networked computer's RAM (chapter glass). The Python subset's data (globals and lists from 0, the output after them, the
// stack down from the top of its region) lives in the first dmemWords words; the NIC's two rings and its sixteen frame buffers sit above it, where
// neither the compiler's stack nor its output can reach them. lib/soc.ts gives the computer a RAM of 2^13 words (32 KB).

export const STACK_LAYOUT = {
  /** Words the compiler is told it has: Python data, output and stack (the stack starts at 4 · dmemWords). */
  dmemWords: 1536,
  /** Descriptor rings: 8 descriptors of 2 words (buffer address, OWN | length). */
  rxRing: 0x1800,
  txRing: 0x1840,
  descriptors: 8,
  /** Frame buffers: 1536 bytes each, one a descriptor. */
  rxBuf: 0x1900,
  txBuf: 0x4900,
  bufSize: 0x600,
  /** Where the NIC's registers are (lib/soc.ts nic option: MAP.nic) and the system CPU's free-running counter (riscv/iss.ts IO.MTIME). */
  nic: 0x70000000,
  mtime: 0x80000010,
  console: 0x80000000,
  /** Text the apps print, copied here at start (the subset has no strings). */
  strings: 0x1000,
} as const;

/** RAM words of a computer that runs the stack. */
export const STACK_RAM_K = 13;
/** The longest frame a transmit buffer holds, and the frame size the switch cell of lib/lan.ts keeps (a ping is 74 bytes). */
export const MAX_TX_FRAME = 1514;
