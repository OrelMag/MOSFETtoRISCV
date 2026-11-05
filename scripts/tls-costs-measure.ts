// What the TLS client costs, measured: lines of Python, RV32IM words, RAM, cycles per primitive and per handshake phase. Nothing here is typed in: scripts/tls-costs.ts
// --write puts the result in src/crypto/tls/costs.json and tests/crypto-tls-costs.test.ts re-measures it.
// Cycle model: the system CPU of the site as the golden model has it (FastISS with system and M): one cycle per instruction, 34 for a divide (the client never divides),
// a multiplier that takes one cycle (the single-cycle CPU's), memory at one cycle. So cycles = instructions retired.

import { createPrivateKey, createPublicKey, constants, randomBytes, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fullBuild } from '../src/crypto/tls/build';
import { appSource, TLS_MODULES } from '../src/crypto/tls/app';
import { tlsProgram } from '../src/crypto/tls';
import { SHA } from '../src/crypto/tls/sha';
import { AES } from '../src/crypto/tls/aes';
import { X25519 } from '../src/crypto/tls/x25519';
import { defaultOffer, rfc8448Offer } from '../src/crypto/tls/hello';
import { CMD, MEM } from '../src/crypto/tls/layout';
import { TlsMachine } from '../src/crypto/tls/machine';
import { collectTls, type TlsResult } from '../src/crypto/tls/run';
import { MockServer } from '../tests/crypto-tls-server';
import { tohex, trace, unhex } from '../tests/crypto-tls-kit';

const BIG = MEM.app;
// the same generator as tests/util.ts (not imported: that file loads vitest)
const lcg = (seed: number): ((n: number) => number) => { let s = seed >>> 0; return (n) => Math.floor(((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * n); };
const rnd = (seed: number) => { const r = lcg(seed); return (n: number) => Uint8Array.from({ length: n }, () => r(256)); };
const fx = (n: string) => readFileSync(new URL(`../tests/fixtures/tls/${n}`, import.meta.url));

export const COST_MODEL = 'cycles = instructions retired on the site\'s system CPU model (FastISS, RV32IM): 1 per instruction, a 1-cycle multiplier, 34 per divide (none used); memory 1 cycle';

function startMachine(): TlsMachine {
  const m = new TlsMachine(fullBuild().compiled.words);
  for (;;) { const r = m.runToRequest(5_000_000); if (r.kind === 'idle') return m; if (r.kind !== 'budget') throw new Error(r.kind); }
}

export interface Costs {
  model: string;
  lines: Record<string, { python: number; withComments: number }>;
  words: Record<string, number>;
  ram: { dataAndStack: number; buffers: number; handshakeBuffer: number; rsaArrays: number; fieldElements: number };
  primitives: Record<string, number>;
  handshake: Record<string, HandshakeCost>;
  /** The same sources compiled for plain RV32I (no multiply instruction: `*` calls the shift-and-add routine). RSA does not compile that way (see the note). */
  rv32i: { words: number; note: string; primitives: Record<string, number> };
}
export interface HandshakeCost { rsaBits: number; cycles: number; phases: Record<string, number>; prims: Record<string, { calls: number; cycles: number }>; clientHelloBytes: number; bytesReceived: number; bytesSent: number }

function handshakeCost(r: TlsResult, rsaBits: number): HandshakeCost {
  return {
    rsaBits, cycles: r.handshake.cycles,
    phases: Object.fromEntries(r.phases.map((p) => [p.name, p.cycles])),
    prims: Object.fromEntries(Object.entries(r.prims).map(([k, v]) => [k, { calls: v!.calls, cycles: v!.cycles }])),
    clientHelloBytes: r.sent[0].length, bytesSent: r.sent.reduce((n, b) => n + b.length, 0), bytesReceived: r.received.reduce((n, b) => n + b.length, 0),
  };
}

export async function measureCosts(): Promise<Costs> {
  const b = fullBuild();
  // ---- size ----
  const clean = (t: string) => t.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length;
  const lines: Costs['lines'] = {};
  for (const m of TLS_MODULES) lines[m.name] = { python: clean(m.py), withComments: m.py.split('\n').length - 1 };
  lines.total = { python: Object.values(lines).reduce((n, x) => n + x.python, 0), withComments: Object.values(lines).reduce((n, x) => n + x.withComments, 0) };
  const words: Record<string, number> = {};
  for (let pc = 0; pc < b.compiled.words.length * 4; pc += 4) { const k = b.moduleOfPc(pc) ?? 'frame and runtime'; words[k] = (words[k] ?? 0) + 1; }
  words.total = b.compiled.words.length;
  const ram = {
    dataAndStack: 4 * 1024, buffers: MEM.end - 0x1000, handshakeBuffer: MEM.recBuf - MEM.hsBuf, rsaArrays: MEM.rsaEm - MEM.rsaN, fieldElements: MEM.scalar - MEM.fe,
  };

  // ---- primitives ----
  const m = startMachine();
  const cycles = (cmd: number, args: number[]): number => { const c0 = m.cycles; m.call(cmd, args); return m.cycles - c0; };
  const r = rnd(1);
  const put = (at: number, x: Uint8Array) => { m.put(at, x); return at; };
  const prim: Record<string, number> = {};
  const A = BIG, B = BIG + 8192, C = BIG + 16384, D = BIG + 24576;
  put(A, r(2048));
  for (const n of [0, 55, 64, 1000]) prim[`sha256 of ${n} bytes`] = cycles(CMD.sha256, [A, n, B]);
  prim['sha256 per 64-byte block'] = Math.round((prim['sha256 of 1000 bytes'] - prim['sha256 of 0 bytes']) / 15);
  prim['hmac-sha256 (32-byte key, 32-byte message)'] = cycles(CMD.hmac, [A, 32, A + 64, 32, B]);
  prim['hkdf-extract'] = cycles(CMD.hkdfExtract, [A, 32, A + 64, 32, B]);
  prim['hkdf-expand, 32 bytes'] = cycles(CMD.hkdfExpand, [A, A + 64, 20, B, 32]);
  prim['hkdf-expand-label, 32 bytes, 32-byte context'] = cycles(CMD.hkdfLabel, [A, A + 64, 12, A + 128, 32, B, 32]);
  prim['aes-128 key expansion'] = cycles(CMD.aesExpand, [A]);
  prim['aes-128 block (key expansion included)'] = cycles(CMD.aesEncrypt, [A, A + 16, B]);
  prim['aes-128 block'] = prim['aes-128 block (key expansion included)'] - prim['aes-128 key expansion'];
  prim['ghash multiplication (one block)'] = cycles(CMD.ghashMul, [B, A + 32]);
  put(C, r(1100));
  for (const n of [0, 16, 1024]) prim[`aes-128-gcm seal ${n} bytes + 13 bytes AAD (key setup included)`] = cycles(CMD.gcmSeal, [A, A + 16, A + 32, 13, C, n, D]);
  prim['aes-128-gcm per 16-byte block'] = Math.round((prim['aes-128-gcm seal 1024 bytes + 13 bytes AAD (key setup included)'] - prim['aes-128-gcm seal 16 bytes + 13 bytes AAD (key setup included)']) / 63);
  m.call(CMD.gcmSeal, [A, A + 16, A + 32, 13, C, 1024, D]);
  prim['aes-128-gcm open 1024 bytes + 13 bytes AAD (key setup included)'] = cycles(CMD.gcmOpen, [A, A + 16, A + 32, 13, D, 1024, C + 2048]);
  put(A, unhex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')); put(A + 32, unhex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'));
  prim['x25519'] = cycles(CMD.x25519, [B, A, A + 32]);
  // RSA-PSS verify: RFC 8448's own 1024-bit CertificateVerify (message rebuilt from the trace), and a 2048-bit signature from the test fixture key
  {
    const cv = trace('construct a CertificateVerify handshake message', 'CertificateVerify');
    const cert = trace('construct a Certificate handshake message', 'Certificate');
    const x = new X509Certificate(Buffer.from(cert.subarray(11, 11 + ((cert[8] << 16) | (cert[9] << 8) | cert[10]))));
    const n = new Uint8Array(Buffer.from(x.publicKey.export({ format: 'jwk' }).n as string, 'base64url'));
    const msgs = ['construct a ClientHello handshake message|ClientHello', 'construct a ServerHello handshake message|ServerHello', 'construct an EncryptedExtensions handshake message|EncryptedExtensions', 'construct a Certificate handshake message|Certificate']
      .map((s) => { const [a, f] = s.split('|'); return trace(a, f); });
    const { createHash } = await import('node:crypto');
    const th = createHash('sha256').update(Buffer.concat(msgs)).digest();
    const content = new Uint8Array(130); content.fill(0x20, 0, 64); content.set(Uint8Array.from('TLS 1.3, server CertificateVerify', (c) => c.charCodeAt(0)), 64); content.set(th, 98);
    put(A, n); put(A + 256, cv.subarray(8)); put(A + 512, content);
    prim['rsa-pss-sha256 verify, 1024-bit key (RFC 8448)'] = cycles(CMD.rsaPss, [A, n.length, A + 256, 128, A + 512, 130]);
    if (m.word(MEM.cmd + 64) !== 1) throw new Error('RFC 8448 CertificateVerify did not verify');
    const key = createPrivateKey(fx('test-server-key.pem'));
    const jwk = createPublicKey(key).export({ format: 'jwk' });
    const n2 = new Uint8Array(Buffer.from(jwk.n as string, 'base64url'));
    const sig = new Uint8Array(sign('sha256', content, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }));
    put(A, n2); put(A + 256, sig);
    prim['rsa-pss-sha256 verify, 2048-bit key'] = cycles(CMD.rsaPss, [A, n2.length, A + 256, sig.length, A + 512, 130]);
    if (m.word(MEM.cmd + 64) !== 1) throw new Error('2048-bit signature did not verify');
  }

  // ---- handshakes ----
  const handshake: Costs['handshake'] = {};
  {
    const hello = trace('client construct a ClientHello handshake message', 'ClientHello');
    const rec = (a: string, nth = 0) => trace(`server ${a}`, 'complete record', nth);
    let q = Uint8Array.from(Buffer.concat([rec('send handshake record', 0), rec('send handshake record', 1), rec('send handshake record', 2)]));
    const { result } = await collectTls({
      config: { random: hello.subarray(6, 38), privateKey: trace('client create an ephemeral x25519 key pair', 'private key'), offer: rfc8448Offer() },
      transport: { send: () => {}, recv: (n) => { const k = Math.min(n, q.length); const o = q.slice(0, k); q = q.slice(k); return o; } },
    });
    if (!result.ok) throw new Error(`RFC 8448 handshake: ${result.error}`);
    handshake['rfc8448 (1024-bit RSA, three cipher suites offered)'] = handshakeCost(result, 1024);
  }
  {
    const cert = new X509Certificate(fx('test-server-cert.pem'));
    const rr = rnd(2);
    const server = new MockServer({ certDer: new Uint8Array(cert.raw), signKey: createPrivateKey(fx('test-server-key.pem')), ecdhPriv: rr(32), random: rr(32), fault: 'none' });
    const { result } = await collectTls({ config: { random: rr(32), privateKey: rr(32), offer: defaultOffer('localhost') }, transport: server });
    if (!result.ok) throw new Error(`2048-bit handshake: ${result.error}`);
    handshake['default offer, 2048-bit RSA (test fixture certificate)'] = handshakeCost(result, 2048);
  }
  // ---- plain RV32I: the compiler without M, for the modules that fit its register budget ----
  const b32 = tlsProgram([SHA, AES, X25519], appSource(false, false), { m: false });
  if (b32.compiled.error) throw new Error(b32.compiled.error.message);
  const m32 = new TlsMachine(b32.compiled.words);
  for (;;) { const r0 = m32.runToRequest(5_000_000); if (r0.kind === 'idle') break; }
  const c32 = (cmd: number, args: number[]): number => { const c0 = m32.cycles; m32.call(cmd, args); return m32.cycles - c0; };
  const p32: Record<string, number> = {};
  const rr = rnd(1);
  m32.put(A, rr(2048));
  p32['sha256 of 1000 bytes'] = c32(CMD.sha256, [A, 1000, B]);
  p32['hmac-sha256 (32-byte key, 32-byte message)'] = c32(CMD.hmac, [A, 32, A + 64, 32, B]);
  p32['aes-128 block (key expansion included)'] = c32(CMD.aesEncrypt, [A, A + 16, B]);
  m32.put(C, rr(1100));
  p32['aes-128-gcm seal 1024 bytes + 13 bytes AAD (key setup included)'] = c32(CMD.gcmSeal, [A, A + 16, A + 32, 13, C, 1024, D]);
  m32.put(A, unhex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')); m32.put(A + 32, unhex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'));
  p32['x25519'] = c32(CMD.x25519, [B, A, A + 32]);
  if (tohex(m32.bytes(B, 32)) !== 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552') throw new Error('RV32I x25519 differs');
  const rv32i = {
    words: b32.compiled.words.length,
    note: 'sha, aes, x25519 and the command loop (no rsa, x509, tls). The RSA verifier does not compile for plain RV32I as written: its Montgomery inner loop keeps 14 variables in registers and the compiler allows 12 in a function that calls the multiply routine.',
    primitives: p32,
  };
  void randomBytes;
  return { model: COST_MODEL, lines, words, ram, primitives: prim, handshake, rv32i };
}
