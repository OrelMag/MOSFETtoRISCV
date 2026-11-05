// A small TLS 1.3 server model for the negative tests, written with node:crypto (independent of the Python client and of its helpers): it answers a
// ClientHello with a ServerHello and the encrypted flight (EncryptedExtensions, Certificate, CertificateVerify, Finished), checks the client's Finished,
// and can break exactly one thing on request. Test code only.

import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, constants, diffieHellman, sign, type KeyObject } from 'node:crypto';
import type { Transport } from '../src/crypto/tls/run';
import { V } from './crypto-tls-kit';

export type Fault =
  | 'none'
  | 'badSignature'      // CertificateVerify with one bit of the signature changed (the record's tag is valid)
  | 'wrongSigner'       // CertificateVerify signed by another key than the certificate's
  | 'badFinished'       // Finished verify_data with one bit changed
  | 'swapCertAndVerify' // CertificateVerify before Certificate
  | 'noFinished'        // the flight ends after CertificateVerify, then the server goes quiet
  | 'hrr'               // a HelloRetryRequest
  | 'wrongCipher'       // TLS_AES_256_GCM_SHA384 selected
  | 'wrongGroup'        // secp256r1 in the key_share
  | 'tls12'             // supported_versions says TLS 1.2
  | 'lowOrderShare'     // an all-zero x25519 key share
  | 'extraExtension'    // an extension the client never offered, in ServerHello
  | 'alert'             // a plaintext fatal alert instead of the ServerHello
  | 'badSessionId'      // legacy_session_id_echo different from the client's
  | 'clientAuth'        // a CertificateRequest after EncryptedExtensions
  | 'keyUpdate';        // a KeyUpdate after the handshake

export interface ServerSetup {
  /** The certificate sent (DER) and the key it is signed with. */
  certDer: Uint8Array;
  signKey: KeyObject;
  /** The key that makes the CertificateVerify signature in 'wrongSigner'. */
  otherKey?: KeyObject;
  fault?: Fault;
  /** The x25519 private key (32 bytes) and the ServerHello random. */
  ecdhPriv: Uint8Array;
  random: Uint8Array;
  /** Application data the server sends once its Finished is out (under the application keys), as separate records. */
  appRecords?: Uint8Array[];
}

const cat = (...a: ArrayLike<number>[]): Uint8Array => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x as ArrayLike<number>, p); p += x.length; } return o; };
const u16 = (n: number) => Uint8Array.of(n >> 8, n & 255);
const u24 = (n: number) => Uint8Array.of(n >> 16, (n >> 8) & 255, n & 255);
const sha = (...a: Uint8Array[]) => new Uint8Array(createHash('sha256').update(cat(...a)).digest());
const hmac = (k: Uint8Array, d: Uint8Array) => new Uint8Array(createHmac('sha256', k).update(d).digest());
const extract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt.length ? salt : new Uint8Array(32), ikm);
const expandLabel = (secret: Uint8Array, label: string, ctx: Uint8Array, len: number): Uint8Array => {
  const lab = Uint8Array.from(`tls13 ${label}`, (c) => c.charCodeAt(0));
  return hmac(secret, cat(u16(len), Uint8Array.of(lab.length), lab, Uint8Array.of(ctx.length), ctx, Uint8Array.of(1))).subarray(0, len);
};
const deriveSecret = (s: Uint8Array, label: string, th: Uint8Array) => expandLabel(s, label, th, 32);
const hs = (type: number, body: Uint8Array) => cat(Uint8Array.of(type), u24(body.length), body);
const rec = (type: number, body: Uint8Array) => cat(Uint8Array.of(type, 3, 3), u16(body.length), body);

class Protect {
  seq = 0;
  readonly key: Uint8Array; readonly iv: Uint8Array;
  constructor(secret: Uint8Array) { this.key = expandLabel(secret, 'key', new Uint8Array(0), 16); this.iv = expandLabel(secret, 'iv', new Uint8Array(0), 12); }
  private nonce(): Uint8Array { const n = this.iv.slice(); for (let i = 0; i < 4; i++) n[8 + i] ^= (this.seq >>> (24 - 8 * i)) & 255; this.seq++; return n; }
  seal(type: number, content: Uint8Array): Uint8Array {
    const inner = cat(content, Uint8Array.of(type));
    const header = Uint8Array.of(23, 3, 3, ...u16(inner.length + 16));
    const c = createCipheriv('aes-128-gcm', this.key, this.nonce());
    c.setAAD(header);
    return cat(header, c.update(inner), c.final(), c.getAuthTag());
  }
  open(record: Uint8Array): { type: number; content: Uint8Array } | null {
    const header = record.subarray(0, 5), body = record.subarray(5);
    try {
      const d = createDecipheriv('aes-128-gcm', this.key, this.nonce());
      d.setAAD(header); d.setAuthTag(Buffer.from(body.subarray(body.length - 16)));
      const inner = cat(d.update(body.subarray(0, body.length - 16)), d.final());
      let n = inner.length;
      while (n > 0 && inner[n - 1] === 0) n--;
      return { type: inner[n - 1], content: inner.subarray(0, n - 1) };
    } catch { return null; }
  }
}

const x25519Private = (raw: Uint8Array) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
const x25519Public = (raw: Uint8Array) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' });

/** x25519 public key of a private one, through node. */
export function x25519Pub(priv: Uint8Array): Uint8Array {
  const der = createPublicKey(x25519Private(priv)).export({ type: 'spki', format: 'der' });
  return new Uint8Array(der.subarray(der.length - 32));
}

export class MockServer implements Transport {
  /** What the client sent, record by record. */
  readonly clientRecords: Uint8Array[] = [];
  /** Whether the client's Finished verified (null: never got that far). */
  clientFinishedOk: boolean | null = null;
  private out: Uint8Array = new Uint8Array(0);
  private started = false;
  private cHs: Protect | null = null;
  private finKey: Uint8Array | null = null;
  private thThroughServerFinished: Uint8Array = new Uint8Array(0);
  private cFinished = false;

  constructor(private readonly s: ServerSetup) {}

  send(b: Uint8Array): void {
    this.clientRecords.push(b);
    if (!this.started) { this.started = true; this.flight(b.subarray(5)); return; }
    if (this.cHs && !this.cFinished) {
      const o = this.cHs.open(b);
      if (o && o.type === 22 && o.content[0] === 20) {
        this.cFinished = true;
        this.clientFinishedOk = Buffer.from(o.content.subarray(4)).equals(Buffer.from(hmac(this.finKey!, sha(this.thThroughServerFinished))));
        this.afterClientFinished();
      } else this.clientFinishedOk = false;
    }
  }

  recv(n: number): Uint8Array {
    const k = Math.min(n, this.out.length);
    const r = this.out.slice(0, k);
    this.out = this.out.slice(k);
    return r;
  }

  private push(...b: Uint8Array[]): void { this.out = cat(this.out, ...b); }
  private apRecords: Uint8Array[] = [];
  private sAp: Protect | null = null;
  private afterClientFinished(): void {
    if (!this.sAp) return;
    // released when the client's Finished has been read, as a real server would
    if (this.s.fault === 'keyUpdate') this.push(this.sAp.seal(22, hs(24, Uint8Array.of(0))));
    else for (const r of this.apRecords) this.push(this.sAp.seal(23, r));
  }

  private flight(ch: Uint8Array): void {
    const s = this.s, fault = s.fault ?? 'none';
    if (fault === 'alert') { this.push(Uint8Array.of(21, 3, 3, 0, 2, 2, 40)); return; }
    // the client's key share and session id
    let p = 4 + 2 + 32;
    const sid = ch.subarray(p + 1, p + 1 + ch[p]);
    p += 1 + ch[p];
    p += 2 + ((ch[p] << 8) | ch[p + 1]);
    p += 1 + ch[p];
    const extEnd = p + 2 + ((ch[p] << 8) | ch[p + 1]);
    p += 2;
    let share: Uint8Array | null = null;
    while (p < extEnd) {
      const t = (ch[p] << 8) | ch[p + 1], l = (ch[p + 2] << 8) | ch[p + 3];
      if (t === 0x33) share = ch.subarray(p + 4 + 6, p + 4 + 6 + 32);
      p += 4 + l;
    }
    if (!share) throw new Error('mock server: no key_share');
    const pub = fault === 'lowOrderShare' ? new Uint8Array(32) : x25519Pub(s.ecdhPriv);
    const shared = new Uint8Array(diffieHellman({ privateKey: x25519Private(s.ecdhPriv), publicKey: x25519Public(share) }));
    const random = fault === 'hrr' ? Uint8Array.from(Buffer.from(V.hrrRandom, 'hex')) : s.random;
    const exts = cat(
      Uint8Array.of(0, 0x2b, 0, 2, 3, fault === 'tls12' ? 3 : 4),
      fault === 'wrongGroup' ? cat(u16(0x33), u16(36), u16(23), u16(32), pub) : cat(u16(0x33), u16(36), u16(29), u16(32), pub),
      fault === 'extraExtension' ? Uint8Array.of(0, 0x10, 0, 0) : new Uint8Array(0),
    );
    const sidEcho = fault === 'badSessionId' ? Uint8Array.of(1, 2, 3) : sid;
    const sh = hs(2, cat(Uint8Array.of(3, 3), random, Uint8Array.of(sidEcho.length), sidEcho, fault === 'wrongCipher' ? u16(0x1302) : u16(0x1301), Uint8Array.of(0), u16(exts.length), exts));
    this.push(rec(22, sh));
    let th = cat(ch, sh);
    const early = extract(new Uint8Array(32), new Uint8Array(32));
    const hsSecret = extract(deriveSecret(early, 'derived', sha()), shared);
    const cHsS = deriveSecret(hsSecret, 'c hs traffic', sha(th)), sHsS = deriveSecret(hsSecret, 's hs traffic', sha(th));
    const master = extract(deriveSecret(hsSecret, 'derived', sha()), new Uint8Array(32));
    const sProt = new Protect(sHsS);
    this.cHs = new Protect(cHsS);
    this.finKey = expandLabel(cHsS, 'finished', new Uint8Array(0), 32);
    const sFinKey = expandLabel(sHsS, 'finished', new Uint8Array(0), 32);
    const ee = hs(8, u16(0));
    const cert = hs(11, cat(Uint8Array.of(0), u24(s.certDer.length + 5), u24(s.certDer.length), s.certDer, u16(0)));
    th = cat(th, ee, cert);
    const tosign = cat(new Uint8Array(64).fill(0x20), Uint8Array.from('TLS 1.3, server CertificateVerify\0', (c) => c.charCodeAt(0)), sha(th));
    const signer = fault === 'wrongSigner' ? s.otherKey! : s.signKey;
    const sig = new Uint8Array(sign('sha256', tosign, { key: signer, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }));
    if (fault === 'badSignature') sig[sig.length - 1] ^= 1;
    const cv = hs(15, cat(u16(0x0804), u16(sig.length), sig));
    th = cat(th, cv);
    const verify = hmac(sFinKey, sha(th));
    if (fault === 'badFinished') verify[0] ^= 1;
    const fin = hs(20, verify);
    this.thThroughServerFinished = cat(th, fin);
    const flight: Uint8Array[] = [];
    if (fault === 'clientAuth') flight.push(ee, hs(13, cat(Uint8Array.of(0), u16(0))), cert, cv, fin);
    else if (fault === 'swapCertAndVerify') flight.push(ee, cv, cert, fin);
    else if (fault === 'noFinished') flight.push(ee, cert, cv);
    else flight.push(ee, cert, cv, fin);
    // each message in a record of its own (the client must cope with the other layouts too: RFC 8448 and OpenSSL coalesce)
    for (const m of flight) this.push(sProt.seal(22, m));
    if (fault === 'noFinished') return;
    const sApS = deriveSecret(master, 's ap traffic', sha(this.thThroughServerFinished));
    this.sAp = new Protect(sApS);
    this.apRecords = s.appRecords ?? [];
  }
}
