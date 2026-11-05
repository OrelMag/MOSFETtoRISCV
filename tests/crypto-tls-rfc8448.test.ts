// RFC 8448 section 3, "Simple 1-RTT Handshake", replayed against the TLS client compiled from the Python subset and run on the golden model: the client is
// given the trace's private key and random and the server's records, and every byte it sends and every secret it derives must equal the trace's.
// The vectors are extracted from the RFC's own text (scripts/tls-vectors.ts).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rfc8448Offer } from '../src/crypto/tls/hello';
import type { SecretName } from '../src/crypto/tls/layout';
import { collectTls, type Transport } from '../src/crypto/tls/run';
import { tohex, trace, unhex, V } from './crypto-tls-kit';

const client = (action: string, field: string, nth = 0) => trace(`client ${action}`, field, nth);

/** The server's records of the trace, in the order the client reads them. */
function serverRecords(): Uint8Array[] {
  const rec = (action: string, nth = 0) => trace(`server ${action}`, 'complete record', nth);
  return [rec('send handshake record', 0), rec('send handshake record', 1), rec('send handshake record', 2), rec('send application_data record'), rec('send alert record')];
}

function replay(records: Uint8Array[]): Transport & { sent: Uint8Array[] } {
  let q = new Uint8Array(0);
  records.forEach((r) => { const n = new Uint8Array(q.length + r.length); n.set(q); n.set(r, q.length); q = n; });
  const sent: Uint8Array[] = [];
  return { sent, send: (b) => { sent.push(b); }, recv: (n) => { const k = Math.min(n, q.length); const out = q.slice(0, k); q = q.slice(k); return out; } };
}

const secretsOfTrace = (): Record<SecretName, string> => {
  const t = (action: string, field: string, who = 'server', nth = 0) => tohex(trace(`${who} ${action}`, field, nth));
  return {
    client_pub: tohex(client('create an ephemeral x25519 key pair', 'public key')),
    server_pub: t('create an ephemeral x25519 key pair', 'public key'),
    shared: t('extract secret "handshake"', 'IKM'),
    early: t('extract secret "early"', 'secret'),
    h_empty: t('derive secret for handshake "tls13 derived"', 'hash'),
    derived1: t('derive secret for handshake "tls13 derived"', 'expanded'),
    handshake: t('extract secret "handshake"', 'secret'),
    c_hs: t('derive secret "tls13 c hs traffic"', 'expanded'),
    s_hs: t('derive secret "tls13 s hs traffic"', 'expanded'),
    derived2: t('derive secret for master "tls13 derived"', 'expanded'),
    master: t('extract secret "master"', 'secret'),
    h_hello: t('derive secret "tls13 c hs traffic"', 'hash'),
    s_hs_key: t('derive write traffic keys for handshake data', 'key expanded'),
    s_hs_iv: t('derive write traffic keys for handshake data', 'iv expanded'),
    c_hs_key: t('derive read traffic keys for handshake data', 'key expanded'),
    c_hs_iv: t('derive read traffic keys for handshake data', 'iv expanded'),
    s_fin_key: t('calculate finished "tls13 finished"', 'expanded'),
    s_verify: t('calculate finished "tls13 finished"', 'finished'),
    h_fin: t('derive secret "tls13 c ap traffic"', 'hash'),
    c_ap: t('derive secret "tls13 c ap traffic"', 'expanded'),
    s_ap: t('derive secret "tls13 s ap traffic"', 'expanded'),
    exp_master: t('derive secret "tls13 exp master"', 'expanded'),
    s_ap_key: t('derive write traffic keys for application data', 'key expanded'),
    s_ap_iv: t('derive write traffic keys for application data', 'iv expanded'),
    c_fin_key: t('calculate finished "tls13 finished"', 'expanded', 'client'),
    c_verify: t('calculate finished "tls13 finished"', 'finished', 'client'),
    c_ap_key: t('derive write traffic keys for application data', 'key expanded', 'client'),
    c_ap_iv: t('derive write traffic keys for application data', 'iv expanded', 'client'),
    h_cfin: t('derive secret "tls13 res master"', 'hash', 'client'),
    res_master: t('derive secret "tls13 res master"', 'expanded', 'client'),
    // the trace prints no hash for these two (its Finished is computed over an empty context label); the checks that use them pass or the run stops
    h_cert: '',
    h_cv: '',
  } as Record<SecretName, string>;
};

describe('RFC 8448 section 3 replayed through the client on the golden model', () => {
  it('sends the trace\'s bytes, derives the trace\'s secrets, and exchanges the trace\'s application data and alerts', async () => {
    const chRecord = client('send handshake record', 'complete record', 0);
    const hello = client('construct a ClientHello handshake message', 'ClientHello');
    const tr = replay(serverRecords());
    const payload = unhex(V.rfc8448.find((i) => i.who === 'client' && i.action === 'send application_data record' && i.field === 'payload')!.hex);
    expect(payload).toHaveLength(50);
    const { events, result } = await collectTls({
      config: { random: hello.subarray(6, 38), privateKey: client('create an ephemeral x25519 key pair', 'private key'), offer: rfc8448Offer() },
      transport: tr,
      app: [{ send: payload }, { recv: 50 }, { close: true }, { recvUntilClose: true }],
    });
    expect(result.error).toBe('none');
    expect(result.ok).toBe(true);

    // every byte the client emitted: ClientHello, Finished, application data, alert
    expect(tr.sent.map(tohex)).toEqual([
      tohex(chRecord), tohex(client('send handshake record', 'complete record', 1)), tohex(client('send application_data record', 'complete record')), tohex(client('send alert record', 'complete record')),
    ]);
    // every secret and hash the trace prints
    const want = secretsOfTrace();
    const got = Object.fromEntries(Object.entries(result.secrets).map(([k, v]) => [k, tohex(v!)]));
    for (const [name, hex] of Object.entries(want)) {
      if (hex === '') { expect(got[name], name).toBeDefined(); continue; }
      expect(got[name], name).toBe(hex);
    }
    // the transcript hashes the trace does not print are the SHA-256 of the trace's own messages
    const sh = trace('server construct a ServerHello handshake message', 'ServerHello');
    const ee = trace('server construct an EncryptedExtensions handshake message', 'EncryptedExtensions');
    const cert = trace('server construct a Certificate handshake message', 'Certificate');
    const cv = trace('server construct a CertificateVerify handshake message', 'CertificateVerify');
    const h = (...p: Uint8Array[]) => createHash('sha256').update(Buffer.concat(p)).digest('hex');
    expect(got.h_cert).toBe(h(hello, sh, ee, cert));
    expect(got.h_cv).toBe(h(hello, sh, ee, cert, cv));
    expect(got.h_hello).toBe(h(hello, sh));
    // application data both ways, then the server's close_notify ends the read
    expect(tohex(result.appData)).toBe(tohex(payload));
    // the events: phases in order, one send/recv per record, secrets as they were derived, the final verdict
    const phases = events.filter((e) => e.kind === 'phase').map((e) => (e as { name: string }).name);
    expect(phases).toEqual(['client_hello', 'server_hello', 'key_agreement', 'encrypted_extensions', 'certificate', 'certificate_verify', 'server_finished', 'client_finished']);
    expect(events.filter((e) => e.kind === 'secret').length).toBeGreaterThanOrEqual(30);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true, error: 'none' });
    expect(result.received.map((r) => r.length)).toEqual([95, 679, 227, 72, 24]);
    // costs were measured, not typed
    expect(result.handshake.cycles).toBeGreaterThan(1e7);
    expect(result.prims.x25519?.calls).toBe(2);
    expect(result.prims.rsa_pss?.calls).toBe(1);
    // the phases tile the handshake but for the few instructions before the first marker and after the last
    expect(result.handshake.cycles - result.phases.reduce((n, p) => n + p.cycles, 0)).toBeLessThan(500);
  }, 120_000);

  it('with the pin of the trace\'s certificate the same handshake completes; with another pin it stops at the pin, before CertificateVerify', async () => {
    const cert = trace('server construct a Certificate handshake message', 'Certificate');
    const der = cert.subarray(11, 11 + ((cert[8] << 16) | (cert[9] << 8) | cert[10]));
    const { X509Certificate } = await import('node:crypto');
    const spki = new X509Certificate(Buffer.from(der)).publicKey.export({ type: 'spki', format: 'der' });
    const hello = client('construct a ClientHello handshake message', 'ClientHello');
    const run = (pin: Uint8Array) => collectTls({
      config: { random: hello.subarray(6, 38), privateKey: client('create an ephemeral x25519 key pair', 'private key'), pin, offer: rfc8448Offer() },
      transport: replay(serverRecords()),
    });
    const good = await run(createHash('sha256').update(spki).digest());
    expect(good.result.error).toBe('none');
    const bad = await run(Uint8Array.from(createHash('sha256').update(spki).digest(), (b) => b ^ 1));
    expect(bad.result.error).toBe('pin');
    // the verification of the signature never ran
    expect(bad.result.prims.rsa_pss).toBeUndefined();
    expect(bad.events.some((e) => e.kind === 'phase' && e.name === 'certificate_verify')).toBe(false);
  }, 120_000);
});
