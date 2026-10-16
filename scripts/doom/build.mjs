// Builds Doom (ports/doom: doomgeneric + the platform layer) for the Doom computer and writes
// public/doom/doom.img (instruction ROM + initial RAM) and public/doom/doom.syms.json (every
// function's address, size and name). Node built-ins only.
//
//   node scripts/doom/build.mjs [--cc <path to riscv-none-elf-gcc>] [-j <jobs>] [--opt <O2 | Os | O3>]
//
// The compiler: --cc, else $DOOM_CC, else the pinned xPack release under E:/toolchains if it is
// there, else riscv-none-elf-gcc on PATH. The image is reproducible for one compiler version.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pinned toolchain: xPack GNU RISC-V Embedded GCC (multilib rv32im/ilp32, newlib-nano). */
export const GCC_VERSION = '15.2.0-1';
const PINNED_CC = `E:/toolchains/xpack-riscv-none-elf-gcc-${GCC_VERSION}/bin/riscv-none-elf-gcc${process.platform === 'win32' ? '.exe' : ''}`;

/** Doom's zone (I_ZoneBase), in MiB: passed as -mb (see ports/doom/README.md for the budget). */
export const ZONE_MB = 6;
const STACK_TOP = 0x0080_0000, STACK_RESERVE = 256 * 1024;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = join(root, 'ports/doom');
const out = join(port, 'build');

// The engine: upstream's Makefile list without its X11 front end (doomgeneric_xlib.o).
const ENGINE = `dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale
  f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv
  m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter
  p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user
  r_bsp r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables
  v_video wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric`.split(/\s+/);
const PLATFORM = ['crt0.S', 'syscalls.c', 'doomgeneric_mosfet.c', 'w_file_mosfet.c'];

const ARCH = ['-march=rv32im', '-mabi=ilp32'];
const CFLAGS = [
  ...ARCH, '-std=gnu99', '-fpermissive', '-ffunction-sections', '-fdata-sections', '-fno-common',
  '-DMOSFET_RISCV', '-DDOOMGENERIC_RESX=320', '-DDOOMGENERIC_RESY=200', `-DDOOM_ZONE_MB="${ZONE_MB}"`,
  '-Iplatform', '-Idoomgeneric', '-w',
];
const LDFLAGS = [
  ...ARCH, '--specs=nano.specs', '-nostartfiles', '-Tplatform/link.ld',
  '-Wl,--gc-sections', '-Wl,--no-check-sections', '-Wl,-Map=build/doom.map', '-Wl,--no-warn-rwx-segments',
];

function args() {
  const a = process.argv.slice(2), o = { cc: process.env.DOOM_CC || '', jobs: cpus().length, opt: 'O2' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--cc') o.cc = a[++i];
    else if (a[i] === '-j') o.jobs = Number(a[++i]);
    else if (a[i] === '--opt') o.opt = a[++i].replace(/^-/, '');
    else throw new Error(`unknown argument ${a[i]}`);
  }
  if (!o.cc) o.cc = existsSync(PINNED_CC) ? PINNED_CC : 'riscv-none-elf-gcc';
  return o;
}

function run(cmd, argv, cwd) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(text) : fail(new Error(`${cmd} ${argv.join(' ')}\n${text}`))));
  });
}

async function pool(items, n, f) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}

// ---- ELF32 (little-endian RISC-V) ----

const SHT_SYMTAB = 2, SHT_NOBITS = 8, SHF_WRITE = 1, SHF_ALLOC = 2, SHF_EXECINSTR = 4, STT_FUNC = 2;

export function readElf(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x7f454c46 || buf[4] !== 1 || buf[5] !== 1) throw new Error('not a little-endian ELF32 file');
  if (dv.getUint16(18, true) !== 243) throw new Error('not a RISC-V ELF');
  const entry = dv.getUint32(24, true), shoff = dv.getUint32(32, true);
  const shentsize = dv.getUint16(46, true), shnum = dv.getUint16(48, true), shstrndx = dv.getUint16(50, true);
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({
      nameOff: dv.getUint32(o, true), type: dv.getUint32(o + 4, true), flags: dv.getUint32(o + 8, true),
      addr: dv.getUint32(o + 12, true), offset: dv.getUint32(o + 16, true), size: dv.getUint32(o + 20, true),
      link: dv.getUint32(o + 24, true), entsize: dv.getUint32(o + 36, true),
    });
  }
  const str = (sec, off) => {
    let e = sec.offset + off;
    while (buf[e]) e++;
    return buf.toString('latin1', sec.offset + off, e);
  };
  for (const s of sections) s.name = str(sections[shstrndx], s.nameOff);
  const symbols = [];
  for (const s of sections.filter((x) => x.type === SHT_SYMTAB)) {
    const strs = sections[s.link];
    for (let o = s.offset; o < s.offset + s.size; o += s.entsize) {
      symbols.push({
        name: str(strs, dv.getUint32(o, true)), value: dv.getUint32(o + 4, true), size: dv.getUint32(o + 8, true),
        type: buf[o + 12] & 15, bind: buf[o + 12] >> 4, shndx: dv.getUint16(o + 14, true),
      });
    }
  }
  return { entry, sections, symbols };
}

/** The image: header words, then the instruction ROM, then the initial RAM from dataBase. */
export function makeImage(buf, elf) {
  const alloc = elf.sections.filter((s) => s.flags & SHF_ALLOC && s.size > 0);
  const text = alloc.filter((s) => s.flags & SHF_EXECINSTR);
  const data = alloc.filter((s) => !(s.flags & SHF_EXECINSTR));
  const sym = (n) => {
    const s = elf.symbols.find((x) => x.name === n);
    if (!s) throw new Error(`symbol ${n} missing`);
    return s.value;
  };
  // Harvard: the ROM holds instructions only. Anything else allocated must be RAM data, above
  // the NULL page and outside the ROM's own section.
  if (text.length !== 1 || text[0].name !== '.text') throw new Error(`expected exactly one executable section, got ${text.map((s) => s.name)}`);
  const t = text[0];
  for (const s of data) {
    if (s.addr < 0x1000 || s.addr + s.size > STACK_TOP) throw new Error(`${s.name} at 0x${s.addr.toString(16)} is outside RAM`);
    if (!(s.flags & SHF_WRITE) && !/^\.(s?rodata|init_array|fini_array|preinit_array|sdata)/.test(s.name)) throw new Error(`unexpected section ${s.name}`);
  }
  if (t.addr !== 0 || t.size % 4) throw new Error('.text must start at 0 and hold whole words');
  const loaded = data.filter((s) => s.type !== SHT_NOBITS), zero = data.filter((s) => s.type === SHT_NOBITS);
  const dataBase = Math.min(...data.map((s) => s.addr));
  const dataEnd = Math.max(...loaded.map((s) => s.addr + s.size));
  const bssEnd = sym('__bss_end');
  for (const s of zero) if (s.addr < dataEnd) throw new Error(`${s.name} overlaps initialized data`);
  if (sym('_end') !== bssEnd) throw new Error('_end must be __bss_end');
  const textWords = t.size / 4, dataWords = Math.ceil((dataEnd - dataBase) / 4);
  const img = Buffer.alloc(4 * (8 + textWords + dataWords));
  const head = [0x4d495652, 1, elf.entry, t.addr, textWords, dataBase, dataWords, bssEnd];
  head.forEach((w, i) => img.writeUInt32LE(w >>> 0, 4 * i));
  buf.copy(img, 32, t.offset, t.offset + t.size);
  const d0 = 32 + 4 * textWords;
  for (const s of loaded) buf.copy(img, d0 + s.addr - dataBase, s.offset, s.offset + s.size);
  return {
    img, entry: elf.entry, textBytes: t.size, dataBase, dataBytes: dataEnd - dataBase, bssEnd,
    bssBytes: bssEnd - dataEnd, heapRoom: STACK_TOP - STACK_RESERVE - bssEnd,
  };
}

export function functionSymbols(elf) {
  const seen = new Set(), out = [];
  for (const s of elf.symbols) {
    if (s.type !== STT_FUNC || !s.name || s.shndx === 0) continue;
    const k = `${s.value}:${s.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([s.value, s.size, s.name]);
  }
  return out.sort((a, b) => a[0] - b[0] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

async function main() {
  const o = args();
  console.log(`compiler: ${o.cc}`);
  console.log((await run(o.cc, ['--version'], port)).split('\n')[0]);
  mkdirSync(join(out, 'obj'), { recursive: true });
  const units = [...ENGINE.map((n) => `doomgeneric/${n}.c`), ...PLATFORM.map((n) => `platform/${n}`)];
  const objs = units.map((u) => `build/obj/${u.replace(/^.*\//, '').replace(/\.[cS]$/, '.o')}`);
  await pool(units.map((u, i) => [u, objs[i]]), o.jobs, ([src, obj]) => run(o.cc, [`-${o.opt}`, ...CFLAGS, ...(src.endsWith('.S') ? ['-march=rv32im_zicsr'] : []), '-c', src, '-o', obj], port));
  await run(o.cc, [...LDFLAGS, ...objs, '-o', 'build/doom.elf', '-lc', '-lm', '-lgcc'], port);

  const buf = readFileSync(join(out, 'doom.elf'));
  const elf = readElf(buf);
  const im = makeImage(buf, elf);
  const zone = ZONE_MB << 20;
  if (zone > im.heapRoom) throw new Error(`the zone (${ZONE_MB} MiB) does not fit the heap (${im.heapRoom} bytes)`);
  const syms = functionSymbols(elf);
  mkdirSync(join(root, 'public/doom'), { recursive: true });
  writeFileSync(join(root, 'public/doom/doom.img'), im.img);
  writeFileSync(join(root, 'public/doom/doom.syms.json'), '[\n' + syms.map((s) => JSON.stringify(s)).join(',\n') + '\n]\n');
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
  console.log(`text  ${im.textBytes} bytes (${kib(im.textBytes)}) at 0x0, entry 0x${im.entry.toString(16)}`);
  console.log(`data  ${im.dataBytes} bytes (${kib(im.dataBytes)}) at 0x${im.dataBase.toString(16)} (.rodata + .data + .sdata)`);
  console.log(`bss   ${im.bssBytes} bytes (${kib(im.bssBytes)}), ends at 0x${im.bssEnd.toString(16)}`);
  console.log(`heap  ${im.heapRoom} bytes (${kib(im.heapRoom)}) up to the stack's ${kib(STACK_RESERVE)}; zone ${ZONE_MB} MiB, ${kib(im.heapRoom - zone)} left for malloc`);
  console.log(`wrote public/doom/doom.img (${im.img.length} bytes) and public/doom/doom.syms.json (${syms.length} functions)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
