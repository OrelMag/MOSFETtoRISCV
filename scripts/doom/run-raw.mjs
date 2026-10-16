// Dev tool: a plain RV32IM + Zicsr interpreter for the Doom computer, independent of the site's
// code, for checking public/doom/doom.img (ports/doom/README.md describes the machine). Strict:
// it reports misaligned accesses, illegal instructions, stores into the WAD and accesses outside
// every device, and stops at the first one. Node built-ins only.
//
//   node scripts/doom/run-raw.mjs [--img public/doom/doom.img] [--wad .cache/doom/freedoom1.wad]
//        [--flips 10] [--png out.png] [--png-at 5] [--max 3e9] [--keys "flip:key:down,..."]
//
// --keys queues key events: at FLIP n, push key code k pressed (down) or released (up).

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const RAM_BYTES = 8 << 20, WAD_BASE = 0x1000_0000, FB_BASE = 0xc000_0000, FB_BYTES = 320 * 200, PAL_BASE = 0xc001_0000;

function opts() {
  const o = { img: 'public/doom/doom.img', wad: '.cache/doom/freedoom1.wad', syms: 'public/doom/doom.syms.json', flips: 10, png: '', pngAt: 5, max: 3e9, keys: '' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (!(k in o)) throw new Error(`unknown option ${a[i]}`);
    o[k] = typeof o[k] === 'number' ? Number(a[++i]) : a[++i];
  }
  return o;
}

export function parseImage(buf) {
  const w = new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [magic, version, entry, textBase, textWords, dataBase, dataWords, bssEnd] = w;
  if (magic !== 0x4d495652 || version !== 1) throw new Error('not a version 1 RVIM image');
  return { entry, textBase, bssEnd, dataBase, text: new Int32Array(w.buffer, 32, textWords), data: new Uint32Array(w.buffer, 32 + 4 * textWords, dataWords) };
}

class Stop extends Error {}

export class Machine {
  constructor(image, wad) {
    this.image = image;
    this.ram = new ArrayBuffer(RAM_BYTES);
    this.r8 = new Uint8Array(this.ram);
    this.r16 = new Uint16Array(this.ram);
    this.r32 = new Int32Array(this.ram);
    new Uint32Array(this.ram, image.dataBase, image.data.length).set(image.data);
    const wbuf = new ArrayBuffer((wad.length + 3) & ~3);
    new Uint8Array(wbuf).set(wad);
    this.wadLen = wad.length;
    this.w8 = new Uint8Array(wbuf);
    this.w16 = new Uint16Array(wbuf);
    this.w32 = new Int32Array(wbuf);
    const fb = new ArrayBuffer(FB_BYTES);
    this.f8 = new Uint8Array(fb);
    this.f16 = new Uint16Array(fb);
    this.f32 = new Int32Array(fb);
    this.palette = new Uint32Array(256);
    this.x = new Int32Array(32);
    this.pc = image.entry;
    this.cycles = 0; // MTIME, unbounded here; the device register is its low 32 bits
    this.retired = 0;
    this.csr = { mstatus: 0x1800, mtvec: 0, mscratch: 0, mepc: 0, mcause: 0, mtval: 0, mie: 0 };
    this.console = '';
    this.keys = [];
    this.flips = 0;
    this.onFlip = null;
    this.halted = false;
    this.fault = '';
    this.wrapWarned = false;
  }

  // ---- data space ----
  slowLoad(a, size, signed) {
    a >>>= 0;
    if (a >= 0x8000_0000 && a < 0xc000_0000) {
      if (size !== 4) this.stop(`${size}-byte device read at 0x${a.toString(16)}`);
      switch ((a >>> 2) & 7) {
        case 1: case 2: case 5: return 0;
        case 3: return this.wadLen | 0;
        case 4: return this.cycles | 0;
        case 6: return this.keys.length ? this.keys.shift() : 0;
        default: return 0;
      }
    }
    let v8, v16, v32, i;
    if (a >= FB_BASE && a < FB_BASE + FB_BYTES) { i = a - FB_BASE; v8 = this.f8; v16 = this.f16; v32 = this.f32; }
    else if (a >= PAL_BASE && a < PAL_BASE + 1024 && size === 4) return this.palette[(a - PAL_BASE) >>> 2] | 0;
    else if (a >= WAD_BASE && a < WAD_BASE + this.w8.length) { i = a - WAD_BASE; v8 = this.w8; v16 = this.w16; v32 = this.w32; }
    else if (a < 0x8000_0000) {
      if (!this.wrapWarned) { this.wrapWarned = true; console.error(`[run-raw] note: read at 0x${a.toString(16)} wraps into RAM (pc 0x${this.pc.toString(16)})`); }
      i = a & (RAM_BYTES - 1); v8 = this.r8; v16 = this.r16; v32 = this.r32;
    } else this.stop(`read at 0x${a.toString(16)}: no device there`);
    if (size === 4) return v32[i >>> 2];
    if (size === 2) return signed ? (v16[i >>> 1] << 16) >> 16 : v16[i >>> 1];
    return signed ? (v8[i] << 24) >> 24 : v8[i];
  }

  slowStore(a, size, v) {
    a >>>= 0;
    if (a >= 0x8000_0000 && a < 0xc000_0000) {
      if (size !== 4) this.stop(`${size}-byte device write at 0x${a.toString(16)}`);
      switch ((a >>> 2) & 7) {
        case 0: this.console += String.fromCharCode(v & 0xff); if ((v & 0xff) === 10 && this.echo) process.stdout.write(this.console.slice(this.console.lastIndexOf('\n', this.console.length - 2) + 1)); break;
        case 7: this.flips++; if (this.onFlip) this.onFlip(this); break;
        default: break;
      }
      return;
    }
    let v8, v16, v32, i;
    if (a >= FB_BASE && a < FB_BASE + FB_BYTES) { i = a - FB_BASE; v8 = this.f8; v16 = this.f16; v32 = this.f32; }
    else if (a >= PAL_BASE && a < PAL_BASE + 1024 && size === 4) { this.palette[(a - PAL_BASE) >>> 2] = v; return; }
    else if (a >= WAD_BASE && a < WAD_BASE + this.w8.length) this.stop(`store into the read-only WAD at 0x${a.toString(16)}`);
    else if (a < 0x8000_0000) {
      if (!this.wrapWarned) { this.wrapWarned = true; console.error(`[run-raw] note: write at 0x${a.toString(16)} wraps into RAM (pc 0x${this.pc.toString(16)})`); }
      i = a & (RAM_BYTES - 1); v8 = this.r8; v16 = this.r16; v32 = this.r32;
    } else this.stop(`write at 0x${a.toString(16)}: no device there`);
    if (size === 4) v32[i >>> 2] = v;
    else if (size === 2) v16[i >>> 1] = v;
    else v8[i] = v;
  }

  stop(msg) {
    this.fault = msg;
    throw new Stop(msg);
  }

  csrRead(n) {
    const c = this.csr;
    switch (n) {
      case 0x300: return c.mstatus;
      case 0x301: return 0x40001100;
      case 0x304: return c.mie;
      case 0x305: return c.mtvec;
      case 0x340: return c.mscratch;
      case 0x341: return c.mepc;
      case 0x342: return c.mcause;
      case 0x343: return c.mtval;
      case 0x344: return 0;
      case 0xb00: case 0xc00: return this.cycles | 0;
      case 0xf11: case 0xf12: case 0xf13: case 0xf14: return 0;
      default: return null;
    }
  }

  csrWrite(n, v) {
    const c = this.csr;
    switch (n) {
      case 0x300: c.mstatus = (v & 0x88) | 0x1800; break;
      case 0x304: c.mie = v & 0x880; break;
      case 0x305: c.mtvec = v & ~3; break;
      case 0x340: c.mscratch = v; break;
      case 0x341: c.mepc = v & ~3; break;
      case 0x342: c.mcause = v; break;
      case 0x343: c.mtval = v; break;
      default: break;
    }
  }

  trap(cause, tval, why) {
    console.error(`[run-raw] trap: ${why} at pc 0x${(this.pc >>> 0).toString(16)}${this.where ? ` (${this.where(this.pc)})` : ''}, tval 0x${(tval >>> 0).toString(16)}`);
    this.csr.mepc = this.pc;
    this.csr.mcause = cause;
    this.csr.mtval = tval;
    const ie = this.csr.mstatus & 8;
    this.csr.mstatus = (this.csr.mstatus & ~0x88) | (ie << 4) | 0x1800;
    this.pc = this.csr.mtvec;
    this.traps = (this.traps || 0) + 1;
    if (this.traps > 1) this.stop('second trap');
  }

  /** Run up to n instructions; false once halted or stopped. */
  run(n) {
    const x = this.x, text = this.text ?? (this.text = this.image.text), r8 = this.r8, r16 = this.r16, r32 = this.r32;
    const nText = text.length;
    let pc = this.pc, cycles = this.cycles, retired = this.retired;
    try {
      while (n-- > 0) {
        const idx = pc >>> 2;
        if (idx >= nText) { this.pc = pc; this.stop(`fetch outside the ROM at 0x${(pc >>> 0).toString(16)}`); }
        const ins = text[idx];
        const op = ins & 0x7f, rd = (ins >> 7) & 31, f3 = (ins >> 12) & 7, rs1 = (ins >> 15) & 31, rs2 = (ins >> 20) & 31;
        let next = pc + 4;
        let trapCause = -1, trapVal = 0, why = '';
        switch (op) {
          case 0x37: if (rd) x[rd] = ins & 0xfffff000; break;
          case 0x17: if (rd) x[rd] = pc + (ins & 0xfffff000); break;
          case 0x6f: {
            const imm = (((ins >> 31) << 20) | (((ins >> 12) & 0xff) << 12) | (((ins >> 20) & 1) << 11) | (((ins >> 21) & 0x3ff) << 1));
            next = (pc + imm) >>> 0;
            if (rd) x[rd] = pc + 4;
            break;
          }
          case 0x67: {
            const t = ((x[rs1] + (ins >> 20)) & ~1) >>> 0;
            if (t & 3) { trapCause = 0; trapVal = t; why = 'misaligned jump target'; break; }
            if (rd) x[rd] = pc + 4;
            next = t;
            break;
          }
          case 0x63: {
            const a = x[rs1], b = x[rs2];
            let take;
            switch (f3) {
              case 0: take = a === b; break;
              case 1: take = a !== b; break;
              case 4: take = a < b; break;
              case 5: take = a >= b; break;
              case 6: take = (a >>> 0) < (b >>> 0); break;
              case 7: take = (a >>> 0) >= (b >>> 0); break;
              default: trapCause = 2; trapVal = ins; why = 'illegal branch';
            }
            if (take) {
              const imm = (((ins >> 31) << 12) | (((ins >> 7) & 1) << 11) | (((ins >> 25) & 0x3f) << 5) | (((ins >> 8) & 0xf) << 1));
              const t = (pc + imm) >>> 0;
              if (t & 3) { trapCause = 0; trapVal = t; why = 'misaligned branch target'; } else next = t;
            }
            break;
          }
          case 0x03: {
            const a = (x[rs1] + (ins >> 20)) >>> 0;
            let v;
            if ((f3 & 3) === 1 ? a & 1 : (f3 & 3) === 2 ? a & 3 : 0) { trapCause = 4; trapVal = a; why = 'misaligned load'; break; }
            if (a < RAM_BYTES) {
              switch (f3) {
                case 0: v = (r8[a] << 24) >> 24; break;
                case 1: v = (r16[a >>> 1] << 16) >> 16; break;
                case 2: v = r32[a >>> 2]; break;
                case 4: v = r8[a]; break;
                case 5: v = r16[a >>> 1]; break;
                default: trapCause = 2; trapVal = ins; why = 'illegal load';
              }
            } else {
              if (f3 === 3 || f3 > 5) { trapCause = 2; trapVal = ins; why = 'illegal load'; break; }
              this.pc = pc; this.cycles = cycles; this.retired = retired;
              v = this.slowLoad(a, 1 << (f3 & 3), f3 < 4);
            }
            if (rd && trapCause < 0) x[rd] = v;
            break;
          }
          case 0x23: {
            const a = (x[rs1] + (((ins >> 25) << 5) | ((ins >> 7) & 31))) >>> 0, v = x[rs2];
            if (f3 > 2) { trapCause = 2; trapVal = ins; why = 'illegal store'; break; }
            if (f3 === 1 ? a & 1 : f3 === 2 ? a & 3 : 0) { trapCause = 6; trapVal = a; why = 'misaligned store'; break; }
            if (a >= 0x1000 && a < RAM_BYTES) {
              if (f3 === 0) r8[a] = v; else if (f3 === 1) r16[a >>> 1] = v; else r32[a >>> 2] = v;
            } else if (a < 0x1000) {
              this.pc = pc;
              this.stop(`store to the NULL page at 0x${a.toString(16)}`);
            } else {
              this.pc = pc; this.cycles = cycles; this.retired = retired;
              this.slowStore(a, 1 << f3, v);
            }
            break;
          }
          case 0x13: {
            const imm = ins >> 20, a = x[rs1];
            let v;
            switch (f3) {
              case 0: v = a + imm; break;
              case 1: if (ins >>> 25) { trapCause = 2; why = 'illegal slli'; } v = a << rs2; break;
              case 2: v = a < imm ? 1 : 0; break;
              case 3: v = (a >>> 0) < (imm >>> 0) ? 1 : 0; break;
              case 4: v = a ^ imm; break;
              case 5: { const f7 = ins >>> 25; if (f7 !== 0 && f7 !== 0x20) { trapCause = 2; why = 'illegal shift'; } v = f7 ? a >> rs2 : a >>> rs2; break; }
              case 6: v = a | imm; break;
              default: v = a & imm;
            }
            if (trapCause >= 0) trapVal = ins;
            else if (rd) x[rd] = v;
            break;
          }
          case 0x33: {
            const a = x[rs1], b = x[rs2], f7 = ins >>> 25;
            let v;
            if (f7 === 1) {
              switch (f3) {
                case 0: v = Math.imul(a, b); break;
                case 1: v = mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0); break;
                case 2: v = mulhu(a, b) - (a < 0 ? b : 0); break;
                case 3: v = mulhu(a, b); break;
                case 4: v = b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : (a / b) | 0; break;
                case 5: v = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) >>> 0; break;
                case 6: v = b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : a % b; break;
                default: v = b === 0 ? a : (a >>> 0) % (b >>> 0);
              }
              if (f3 >= 4) cycles += 33; // an iterative divide: 34 cycles in all
            } else if (f7 === 0 || (f7 === 0x20 && (f3 === 0 || f3 === 5))) {
              switch (f3) {
                case 0: v = f7 ? a - b : a + b; break;
                case 1: v = a << (b & 31); break;
                case 2: v = a < b ? 1 : 0; break;
                case 3: v = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
                case 4: v = a ^ b; break;
                case 5: v = f7 ? a >> (b & 31) : a >>> (b & 31); break;
                case 6: v = a | b; break;
                default: v = a & b;
              }
            } else { trapCause = 2; trapVal = ins; why = 'illegal OP'; break; }
            if (rd) x[rd] = v;
            break;
          }
          case 0x0f: break; // fence: nothing to order on this machine
          case 0x73: {
            const csr = ins >>> 20;
            if (f3 === 0) {
              if (ins === 0x30200073) next = this.csr.mepc;
              else if (ins === 0x10500073) { /* wfi: a no-op */ }
              else if (ins === 0x00000073) { trapCause = 11; why = 'ecall'; }
              else if (ins === 0x00100073) { trapCause = 3; why = 'ebreak'; }
              else { trapCause = 2; trapVal = ins; why = 'illegal SYSTEM'; }
              if (ins === 0x30200073) { const p = (this.csr.mstatus >> 4) & 8; this.csr.mstatus = (this.csr.mstatus & ~8) | p | 0x80; }
              break;
            }
            this.cycles = cycles;
            const old = this.csrRead(csr);
            if (old === null || f3 === 4) { trapCause = 2; trapVal = ins; why = `illegal CSR 0x${csr.toString(16)}`; break; }
            const src = f3 & 4 ? rs1 : x[rs1], k = f3 & 3;
            if (k === 1 || rs1 !== 0) this.csrWrite(csr, k === 1 ? src : k === 2 ? old | src : old & ~src);
            if (rd) x[rd] = old;
            break;
          }
          default: trapCause = 2; trapVal = ins; why = `illegal opcode 0x${op.toString(16)}`;
        }
        if (trapCause >= 0) {
          this.pc = pc; this.cycles = cycles; this.retired = retired;
          this.trap(trapCause, trapVal, why);
          pc = this.pc;
          cycles++;
          continue;
        }
        cycles++;
        retired++;
        if (next === pc) { this.halted = true; pc = next; break; }
        pc = next;
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      this.halted = true;
    } finally {
      this.pc = pc; this.cycles = cycles; this.retired = retired;
    }
    return !this.halted;
  }
}

/** High word of the unsigned 64-bit product (exact, no BigInt). */
function mulhu(a, b) {
  a >>>= 0; b >>>= 0;
  const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
  const lh = al * bh, hl = ah * bl;
  const mid = ((al * bl) >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (ah * bh + (lh >>> 16) + (hl >>> 16) + Math.floor(mid / 65536)) | 0;
}

// ---- PNG ----
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function framePng(m) {
  const rgb = Buffer.alloc(FB_BYTES * 3);
  for (let i = 0; i < FB_BYTES; i++) { const c = m.palette[m.f8[i]]; rgb[3 * i] = c >>> 16; rgb[3 * i + 1] = c >>> 8; rgb[3 * i + 2] = c; }
  return png(320, 200, rgb);
}

function symbolizer(path) {
  let syms = [];
  try { syms = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  return (pc) => {
    let lo = 0, hi = syms.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (syms[mid][0] <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best < 0 ? '?' : `${syms[best][2]}+0x${(pc - syms[best][0]).toString(16)}`;
  };
}

function main() {
  const o = opts();
  const image = parseImage(readFileSync(o.img));
  const m = new Machine(image, new Uint8Array(readFileSync(o.wad)));
  m.echo = true;
  m.where = symbolizer(o.syms);
  const keys = o.keys ? o.keys.split(',').map((s) => s.split(':')) : [];
  const marks = [];
  m.onFlip = () => {
    marks.push(m.retired);
    if (o.png && m.flips === o.pngAt) writeFileSync(o.png, framePng(m));
    for (const [f, k, d] of keys) if (Number(f) === m.flips) m.keys.push((d === 'up' ? 0 : 0x100) | Number(k));
  };
  const t0 = performance.now();
  while (!m.halted && m.flips < o.flips && m.retired < o.max) m.run(1_000_000);
  const s = (performance.now() - t0) / 1000;
  if (!m.console.endsWith('\n')) process.stdout.write(m.console.slice(m.console.lastIndexOf('\n') + 1) + '\n');
  if (m.fault) console.log(`[run-raw] STOPPED: ${m.fault} at pc 0x${(m.pc >>> 0).toString(16)} (${m.where ? m.where(m.pc) : ''})`);
  else if (m.halted) console.log(`[run-raw] halted at pc 0x${(m.pc >>> 0).toString(16)} (${m.where ? m.where(m.pc) : ''})`);
  console.log(`[run-raw] ${m.retired.toLocaleString('en')} instructions, ${m.cycles.toLocaleString('en')} cycles in ${s.toFixed(1)} s (${(m.retired / s / 1e6).toFixed(1)} MIPS); ${m.flips} flips`);
  if (marks.length) {
    console.log(`[run-raw] first FLIP after ${marks[0].toLocaleString('en')} instructions`);
    console.log(`[run-raw] instructions per frame: ${marks.slice(1).map((v, i) => (v - marks[i]).toLocaleString('en')).join(', ')}`);
  }
  console.log(`[run-raw] sp 0x${(m.x[2] >>> 0).toString(16)}`);
  if (o.png) console.log(`[run-raw] frame ${o.pngAt} written to ${o.png}`);
  process.exitCode = m.fault ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^.*\//, ''))) main();
