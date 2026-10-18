// A minimal ELF32 RISC-V executable, for running our programs on Spike without a toolchain: loadable segments,
// an entry point and a symbol table (Spike's HTIF finds tohost / fromhost by name). Nothing else: no sections
// but the symbol table's, no relocations.

export interface ElfSegment { vaddr: number; bytes: Uint8Array }

const EM_RISCV = 243, ET_EXEC = 2, PT_LOAD = 1, SHT_SYMTAB = 2, SHT_STRTAB = 3, SHN_ABS = 0xfff1;
const PF_RWX = 7;

export function writeElf32(entry: number, segments: ElfSegment[], symbols: Record<string, number>): Uint8Array {
  const strs = (names: string[]) => {
    const offs: number[] = [];
    let text = '\0';
    for (const n of names) { offs.push(text.length); text += `${n}\0`; }
    return { bytes: new TextEncoder().encode(text), offs };
  };
  const names = Object.keys(symbols);
  const strtab = strs(names);
  const shstr = strs(['.symtab', '.strtab', '.shstrtab']);
  const align = (n: number) => (n + 3) & ~3;

  // layout: header, program headers, segment bytes, symtab, strtab, shstrtab, section headers
  const EH = 52, PH = 32, SH = 40, SYM = 16;
  let off = EH + PH * segments.length;
  const segOffs = segments.map((s) => { const o = off; off = align(off + s.bytes.length); return o; });
  const symOff = off; off += SYM * (names.length + 1);
  const strOff = off; off = align(off + strtab.bytes.length);
  const shstrOff = off; off = align(off + shstr.bytes.length);
  const shOff = off; off += SH * 4;

  const buf = new Uint8Array(off);
  const dv = new DataView(buf.buffer);
  const u8 = (o: number, v: number) => dv.setUint8(o, v), u16 = (o: number, v: number) => dv.setUint16(o, v, true);
  const u32 = (o: number, v: number) => dv.setUint32(o, v >>> 0, true);

  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // magic, ELFCLASS32, little-endian, version 1
  u16(16, ET_EXEC); u16(18, EM_RISCV); u32(20, 1); u32(24, entry); u32(28, EH); u32(32, shOff); u32(36, 0);
  u16(40, EH); u16(42, PH); u16(44, segments.length); u16(46, SH); u16(48, 4); u16(50, 3);

  segments.forEach((s, i) => {
    const o = EH + PH * i;
    u32(o, PT_LOAD); u32(o + 4, segOffs[i]); u32(o + 8, s.vaddr); u32(o + 12, s.vaddr);
    u32(o + 16, s.bytes.length); u32(o + 20, s.bytes.length); u32(o + 24, PF_RWX); u32(o + 28, 4);
    buf.set(s.bytes, segOffs[i]);
  });
  names.forEach((n, i) => {
    const o = symOff + SYM * (i + 1); // entry 0 is the null symbol
    u32(o, strtab.offs[i]); u32(o + 4, symbols[n]); u32(o + 8, 8); u8(o + 12, 0x11); /* global object */ u16(o + 14, SHN_ABS);
  });
  buf.set(strtab.bytes, strOff);
  buf.set(shstr.bytes, shstrOff);
  // section headers: null, .symtab (link → .strtab, info = first global), .strtab, .shstrtab
  const sh = (i: number, name: number, type: number, o: number, size: number, link = 0, info = 0, entsize = 0) => {
    const b = shOff + SH * i;
    u32(b, name); u32(b + 4, type); u32(b + 16, o); u32(b + 20, size); u32(b + 24, link); u32(b + 28, info);
    u32(b + 32, 4); u32(b + 36, entsize);
  };
  sh(1, shstr.offs[0], SHT_SYMTAB, symOff, SYM * (names.length + 1), 2, 1, SYM);
  sh(2, shstr.offs[1], SHT_STRTAB, strOff, strtab.bytes.length);
  sh(3, shstr.offs[2], SHT_STRTAB, shstrOff, shstr.bytes.length);
  return buf;
}

/** Words as little-endian bytes. */
export function wordBytes(words: number[]): Uint8Array {
  const b = new Uint8Array(4 * words.length);
  const dv = new DataView(b.buffer);
  words.forEach((w, i) => dv.setUint32(4 * i, w >>> 0, true));
  return b;
}
