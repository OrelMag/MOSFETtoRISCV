// Live interop: the TLS client compiled from the Python subset, running on the golden model, against Node's own `tls` server (OpenSSL), over a loopback
// socket on an ephemeral port. TLS 1.3 only, TLS_AES_128_GCM_SHA256, X25519, rsa_pss_rsae_sha256; the certificate is a throw-away RSA-2048 test fixture
// (tests/fixtures/tls/, key published on purpose). The server reports what it negotiated, and application data must arrive intact both ways.

import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultOffer } from '../src/crypto/tls/hello';
import { collectTls, type AppStep, type Transport } from '../src/crypto/tls/run';
import { lcg } from './util';

const fx = (n: string) => readFileSync(new URL(`./fixtures/tls/${n}`, import.meta.url));
const SERVER = { key: fx('test-server-key.pem'), cert: fx('test-server-cert.pem') };
const MITM = { key: fx('test-mitm-key.pem'), cert: fx('test-mitm-cert.pem') };
const spkiHash = (cert: Buffer): Uint8Array => createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest();

interface Seen { protocol: string | null; cipher: string; received: Buffer[]; alpn?: string; closed: Promise<void> }
const open: { server?: Server; sock?: Socket }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.sock?.destroy(); o.server?.close(); } });

/** An echo server (it answers each chunk with "echo:" + the chunk) on an ephemeral port. */
async function echoServer(pair: { key: Buffer; cert: Buffer }): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer({ ...pair, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256', ecdhCurve: 'X25519', sigalgs: 'rsa_pss_rsae_sha256' } as never, (s: TLSSocket) => {
    let done!: () => void;
    const rec: Seen = { protocol: s.getProtocol(), cipher: s.getCipher().name, received: [], closed: new Promise((r) => { done = r; }) };
    seen.push(rec);
    s.on('data', (d) => { rec.received.push(d); s.write(Buffer.concat([Buffer.from('echo:'), d])); });
    s.on('end', () => s.end());
    s.on('close', done);
    s.on('error', () => done());
  });
  open.push({ server });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, seen };
}

/** A transport over a socket: bytes buffered as they arrive, recv(n) gives up to n of them (waiting for at least one). */
async function socketTransport(port: number): Promise<Transport & { destroy(): void }> {
  const sock = connect(port, '127.0.0.1');
  open.push({ sock });
  await new Promise<void>((r, j) => { sock.once('connect', r); sock.once('error', j); });
  let buf = Buffer.alloc(0), ended = false, wake: (() => void) | null = null;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
  sock.on('end', () => { ended = true; wake?.(); });
  sock.on('error', () => { ended = true; wake?.(); });
  return {
    destroy: () => sock.destroy(),
    send: (b) => { sock.write(b); },
    recv: async (n) => {
      while (buf.length === 0 && !ended) await new Promise<void>((r) => { wake = r; });
      wake = null;
      const k = Math.min(n, buf.length);
      const out = new Uint8Array(buf.subarray(0, k));
      buf = buf.subarray(k);
      return out;
    },
  };
}

const bytes = (n: number, seed: number): Uint8Array => { const r = lcg(seed); return Uint8Array.from({ length: n }, () => r(256)); };
const text = (s: string) => new TextEncoder().encode(s);

describe('against Node\'s TLS 1.3 server (OpenSSL)', () => {
  it('completes with a pinned key; the server negotiated TLS 1.3 and TLS_AES_128_GCM_SHA256; data both ways, including a 40 000-byte message in three records', async () => {
    const { port, seen } = await echoServer(SERVER);
    const big = bytes(40000, 11);
    const steps: AppStep[] = [{ send: text('hello server') }, { recv: 17 }, { send: big }, { recv: 40005 }, { close: true }, { recvUntilClose: true }];
    const tr = await socketTransport(port);
    const { result } = await collectTls({
      config: { random: randomBytes(32), privateKey: randomBytes(32), pin: spkiHash(SERVER.cert), offer: defaultOffer('localhost') },
      transport: tr, app: steps,
    });
    tr.destroy();
    expect(result.error).toBe('none');
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].protocol).toBe('TLSv1.3');
    expect(seen[0].cipher).toBe('TLS_AES_128_GCM_SHA256');
    // (a server socket does not report its key exchange; the client offers only x25519 and the ServerHello must name it, so that is what ran)
    await Promise.race([seen[0].closed, new Promise((r) => setTimeout(r, 5000))]);
    // what the server read is what the client sent, and what the client read is "echo:" + that
    expect(Buffer.concat(seen[0].received).toString('latin1')).toBe(Buffer.concat([Buffer.from('hello server'), Buffer.from(big)]).toString('latin1'));
    // the server echoed each chunk it read as "echo:" + chunk, in order
    expect(Buffer.from(result.appData).toString('latin1')).toBe(Buffer.concat(seen[0].received.map((c) => Buffer.concat([Buffer.from('echo:'), c]))).toString('latin1'));
    expect(result.prims.rsa_pss?.calls).toBe(1);
    expect(result.handshake.cycles).toBeGreaterThan(1e8);
  }, 120_000);

  it('without a pin it also completes: the key in the certificate proves possession of that key, to anyone (no trust is established)', async () => {
    const { port, seen } = await echoServer(MITM);
    const { result } = await collectTls({
      config: { random: randomBytes(32), privateKey: randomBytes(32), offer: defaultOffer() }, transport: await socketTransport(port),
      app: [{ send: text('ping') }, { recv: 9 }, { close: true }, { recvUntilClose: true }],
    });
    expect(result.error).toBe('none');
    expect(Buffer.from(result.appData).toString()).toBe('echo:ping');
    expect(seen[0].protocol).toBe('TLSv1.3');
  }, 120_000);

  it('a server with a different key than the pin is refused at the pin, and gets no application data', async () => {
    const { port, seen } = await echoServer(MITM);
    const { events, result } = await collectTls({
      config: { random: randomBytes(32), privateKey: randomBytes(32), pin: spkiHash(SERVER.cert), offer: defaultOffer('localhost') },
      transport: await socketTransport(port), app: [{ send: text('secret') }, { recv: 11 }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('pin');
    expect(result.prims.rsa_pss).toBeUndefined();
    expect(events.some((e) => e.kind === 'app')).toBe(false);
    expect(seen.flatMap((s) => s.received)).toEqual([]);
  }, 120_000);

  it('a connection closed at once, or a server that answers with garbage, ends the run with an error and no data', async () => {
    const closed = await collectTls({ config: { random: randomBytes(32), privateKey: randomBytes(32), offer: defaultOffer() }, transport: { send: () => {}, recv: () => new Uint8Array(0) }, app: [{ send: text('x') }] });
    expect(closed.result.error).toBe('io');
    expect(closed.result.appData).toHaveLength(0);
    // a plain TCP server that answers the ClientHello with bytes that are not TLS
    const { createServer: net } = await import('node:net');
    const srv = net((s) => { s.once('data', () => { s.write(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')); s.end(); }); });
    open.push({ server: srv as unknown as Server });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { result } = await collectTls({
      config: { random: randomBytes(32), privateKey: randomBytes(32), offer: defaultOffer() },
      transport: await socketTransport((srv.address() as { port: number }).port), app: [{ send: text('x') }],
    });
    expect(result.ok).toBe(false);
    expect(['record', 'io', 'hello', 'message']).toContain(result.error);
  }, 60_000);
});
