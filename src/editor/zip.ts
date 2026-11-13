// A .zip of text files, stored (no compression): what the FPGA export downloads as one file. DOM-free; the
// files are small, so the CRC-32 table and the local / central headers are all there is to it.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { name: string; text: string }

/** The files as one stored zip (UTF-8 names and contents, a fixed 1980-01-01 date: the same input, the same bytes). */
export function zipFiles(files: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(12, 0x0021, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of all) { out.set(a, at); at += a.length; }
  return out;
}

/**
 * The files of a stored zip, as zipFiles writes them (the Digital and FPGA exports), so an export can be imported
 * back. A compressed entry is refused with a reason: there is no inflater here, and an unzipped folder imports fine.
 */
export function unzipStored(b: Uint8Array): ZipEntry[] | { error: string } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let at = 0;
  while (at + 30 <= b.length && v.getUint32(at, true) === 0x04034b50) {
    const flags = v.getUint16(at + 6, true), method = v.getUint16(at + 8, true), size = v.getUint32(at + 18, true);
    const nameLen = v.getUint16(at + 26, true), extraLen = v.getUint16(at + 28, true);
    const name = dec.decode(b.subarray(at + 30, at + 30 + nameLen)), data = at + 30 + nameLen + extraLen;
    if (method !== 0 || flags & 0x08) return { error: `${name} is compressed: unzip the file and import what is inside` };
    if (data + size > b.length) return { error: 'the zip is cut short' };
    if (!name.endsWith('/')) out.push({ name: name.split('/').pop()!, text: dec.decode(b.subarray(data, data + size)) });
    at = data + size;
  }
  return out.length ? out : { error: 'not a zip, or an empty one' };
}
