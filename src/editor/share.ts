// Share links: chips packed into a URL-safe string. '1z' + base64url(deflate-raw(JSON)) where
// CompressionStream exists (browsers, Node 18+), else '1j' + base64url(UTF-8 JSON). The digit is
// the schema the payload was written with; the payload is the chips array (deps first, as from
// closure()). Decoding goes through the same sanitizer as storage and files.

import { SCHEMA, type ChipDoc } from './model';
import { sanitizeChip } from './store';

/** Decompressed payloads larger than this are refused (a link should never get near it). */
const MAX_BYTES = 8 << 20;

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Reads a byte stream to the end, refusing more than MAX_BYTES. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { void reader.cancel(); throw new Error('too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const through = (bytes: Uint8Array, t: CompressionStream | DecompressionStream) =>
  drain(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));

export async function encodeShare(chips: ChipDoc[]): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(chips));
  if (typeof CompressionStream === 'function') {
    try {
      return `${SCHEMA}z${toB64url(await through(json, new CompressionStream('deflate-raw')))}`;
    } catch {
      // an engine without 'deflate-raw': plain JSON below
    }
  }
  return `${SCHEMA}j${toB64url(json)}`;
}

export async function decodeShare(s: string): Promise<ChipDoc[] | { error: string }> {
  const t = s.trim();
  const m = t.match(/^(\d+)([zj])(.*)$/s);
  if (!m) return { error: 'not a sandbox link' };
  if (+m[1] !== SCHEMA) return { error: +m[1] > SCHEMA ? 'made by a newer version of the site' : 'not a sandbox link' };
  const bytes = fromB64url(m[3]);
  if (!bytes) return { error: 'the link is damaged' };
  let json: Uint8Array = bytes;
  if (m[2] === 'z') {
    if (typeof DecompressionStream !== 'function') return { error: 'this browser cannot read compressed links' };
    try {
      json = await through(bytes, new DecompressionStream('deflate-raw'));
    } catch {
      return { error: 'the link is damaged' };
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return { error: 'the link is damaged' };
  }
  if (!Array.isArray(raw)) return { error: 'the link holds no chips' };
  const chips = raw.map(sanitizeChip).filter((c): c is ChipDoc => !!c);
  return chips.length ? chips : { error: 'the link holds no readable chips' };
}
