// What the riscv-tests builds share (scripts/riscv-tests/build.mjs, scripts/rvv-tests/build.mjs): an ELF's loadable bytes
// split into code (from address 0) and data (from DATA_BASE, where link.ld puts tohost first), with the symbols the
// harness reports; and a small job pool for the compiler runs.

/** The loadable bytes of an ELF32 or ELF64 little-endian file: code from address 0, data from DATA_BASE. */
export function loadElf(buf, DATA_BASE) {
  if (buf.readUInt32BE(0) !== 0x7f454c46 || (buf[4] !== 1 && buf[4] !== 2) || buf[5] !== 1) throw new Error('not a little-endian ELF');
  const is64 = buf[4] === 2;
  // the fields that differ between the classes: an address or offset is 4 or 8 bytes, and moves the rest
  const addr = (o) => (is64 ? Number(buf.readBigUInt64LE(o)) : buf.readUInt32LE(o));
  const E = is64 ? { phoff: 32, shoff: 40, phentsize: 54, phnum: 56, shentsize: 58, shnum: 60 } : { phoff: 28, shoff: 32, phentsize: 42, phnum: 44, shentsize: 46, shnum: 48 };
  const P = is64 ? { off: 8, vaddr: 16, filesz: 32, memsz: 40 } : { off: 4, vaddr: 8, filesz: 16, memsz: 20 };
  const S = is64 ? { off: 24, size: 32, link: 40 } : { off: 16, size: 20, link: 24 };
  const SYM = is64 ? { size: 24, value: 8 } : { size: 16, value: 4 };
  const phoff = addr(E.phoff), phentsize = buf.readUInt16LE(E.phentsize), phnum = buf.readUInt16LE(E.phnum);
  const shoff = addr(E.shoff), shentsize = buf.readUInt16LE(E.shentsize), shnum = buf.readUInt16LE(E.shnum);
  const text = [], data = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (buf.readUInt32LE(o) !== 1) continue; // PT_LOAD
    const off = addr(o + P.off), vaddr = addr(o + P.vaddr), filesz = addr(o + P.filesz), memsz = addr(o + P.memsz);
    const bytes = Buffer.alloc(memsz);
    buf.copy(bytes, 0, off, off + filesz);
    (vaddr >= DATA_BASE ? data : text).push({ vaddr, bytes });
  }
  const flat = (segs, base) => {
    const end = Math.max(base, ...segs.map((s) => s.vaddr + s.bytes.length));
    const out = Buffer.alloc((end - base + 3) & ~3);
    for (const s of segs) s.bytes.copy(out, s.vaddr - base);
    return out;
  };
  // symbols, for the failure messages: test_<n> labels and tohost
  const syms = {};
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (buf.readUInt32LE(o + 4) !== 2) continue; // SHT_SYMTAB
    const so = addr(o + S.off), size = addr(o + S.size), link = buf.readUInt32LE(o + S.link);
    const stro = addr(shoff + link * shentsize + S.off);
    for (let s = so; s < so + size; s += SYM.size) {
      const n = buf.readUInt32LE(s);
      let e = stro + n;
      while (buf[e]) e++;
      const name = buf.toString('latin1', stro + n, e);
      if (name === 'tohost' || name === 'fail' || name === 'pass' || name === 'data') syms[name] = addr(s + SYM.value);
    }
  }
  if (text.length === 0 || text[0].vaddr !== 0) throw new Error('code must start at address 0');
  if (syms.tohost !== DATA_BASE) throw new Error(`tohost at 0x${(syms.tohost ?? 0).toString(16)}, expected 0x${DATA_BASE.toString(16)}`);
  return { text: flat(text, 0), data: flat(data, DATA_BASE), syms };
}

export async function pool(jobs, n) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < jobs.length) { const j = next++; out[j] = await jobs[j](); } }));
  return out;
}

