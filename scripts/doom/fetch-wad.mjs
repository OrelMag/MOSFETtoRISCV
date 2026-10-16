// Fetches the game data for Doom on the Doom computer: Freedoom: Phase 1 (BSD licence), never
// checked in. Downloads the pinned release zip, checks its sha256, and extracts freedoom1.wad and
// COPYING.txt into .cache/doom/ at the repo root. Node built-ins only (the zip is read here).
//
//   node scripts/doom/fetch-wad.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const FREEDOOM = {
  url: 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip',
  sha256: '3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59',
  wad: { name: 'freedoom1.wad', bytes: 28795076, sha256: '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d' },
  license: 'COPYING.txt',
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cache = join(root, '.cache/doom');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The entries of a zip file (no zip64, no encryption): name → () => contents. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10), dirOff = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0, p = dirOff; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    entries.set(name, () => {
      if (flags & 1) throw new Error(`${name} is encrypted`);
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local header`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
      if (!data) throw new Error(`${name}: compression method ${method} not supported`);
      if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: size or CRC mismatch`);
      return data;
    });
  }
  return entries;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function main() {
  const wadPath = join(cache, FREEDOOM.wad.name);
  if (existsSync(wadPath) && sha256(readFileSync(wadPath)) === FREEDOOM.wad.sha256 && existsSync(join(cache, FREEDOOM.license))) {
    console.log(`${wadPath} is already there`);
    return;
  }
  mkdirSync(cache, { recursive: true });
  const zipPath = join(cache, FREEDOOM.url.replace(/^.*\//, ''));
  let zip = existsSync(zipPath) ? readFileSync(zipPath) : null;
  if (!zip || sha256(zip) !== FREEDOOM.sha256) {
    console.log(`downloading ${FREEDOOM.url}`);
    const res = await fetch(FREEDOOM.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
    const got = sha256(zip);
    if (got !== FREEDOOM.sha256) throw new Error(`sha256 mismatch: got ${got}, expected ${FREEDOOM.sha256}`);
    writeFileSync(zipPath, zip);
  }
  const entries = readZip(zip);
  const pick = (base) => {
    const name = [...entries.keys()].find((n) => n.replace(/^.*\//, '') === base);
    if (!name) throw new Error(`${base} is not in the zip`);
    return entries.get(name)();
  };
  const wad = pick(FREEDOOM.wad.name);
  if (wad.length !== FREEDOOM.wad.bytes || sha256(wad) !== FREEDOOM.wad.sha256) throw new Error(`${FREEDOOM.wad.name}: unexpected contents`);
  writeFileSync(wadPath, wad);
  writeFileSync(join(cache, FREEDOOM.license), pick(FREEDOOM.license));
  console.log(`wrote ${wadPath} (${wad.length} bytes, sha256 ${FREEDOOM.wad.sha256}) and ${FREEDOOM.license}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
