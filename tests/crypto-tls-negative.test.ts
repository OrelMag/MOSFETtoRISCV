// Fail closed: every check of the TLS client stops the handshake with its own error code, nothing is sent after the fault (no Finished, no application data),
// and no application data is accepted. The server here is tests/crypto-tls-server.ts, a node:crypto model that can break exactly one thing; the other half of
// the tampering is the harness's, which flips a bit of a chosen server record on its way to the client.

import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultOffer } from '../src/crypto/tls/hello';
import { collectTls, type AppStep, type Tamper } from '../src/crypto/tls/run';
import { MockServer, type Fault } from './crypto-tls-server';
import { tohex } from './crypto-tls-kit';

const fx = (n: string) => readFileSync(new URL(`./fixtures/tls/${n}`, import.meta.url));
const LEGIT = { key: createPrivateKey(fx('test-server-key.pem')), cert: new X509Certificate(fx('test-server-cert.pem')) };
const ATTACKER = { key: createPrivateKey(fx('test-mitm-key.pem')), cert: new X509Certificate(fx('test-mitm-cert.pem')) };
const pinOf = (c: X509Certificate) => new Uint8Array(createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest());
const WORLD = new TextEncoder().encode('world');

interface Case { fault?: Fault; tamper?: Tamper; mitm?: boolean; pin?: boolean; app?: AppStep[]; offer?: ReturnType<typeof defaultOffer> }
async function run(c: Case = {}) {
  const who = c.mitm ? ATTACKER : LEGIT;
  const server = new MockServer({
    certDer: new Uint8Array(who.cert.raw), signKey: who.key, otherKey: ATTACKER.key, fault: c.fault ?? 'none', ecdhPriv: randomBytes(32), random: randomBytes(32), appRecords: [WORLD],
  });
  const out = await collectTls({
    config: { random: randomBytes(32), privateKey: randomBytes(32), pin: c.pin === false ? undefined : pinOf(LEGIT.cert), offer: c.offer ?? defaultOffer('localhost') },
    transport: server, tamper: c.tamper, app: c.app ?? [{ send: new TextEncoder().encode('hello') }, { recv: 5 }],
  });
  return { ...out, server };
}

/** After a handshake failure: only the ClientHello left the client, and the verdict names the check. */
const stoppedBeforeFinished = (r: Awaited<ReturnType<typeof run>>, error: string) => {
  expect(r.result.ok).toBe(false);
  expect(r.result.error).toBe(error);
  expect(r.result.sent).toHaveLength(1);
  expect(r.server.clientFinishedOk).toBeNull();
  expect(r.result.appData).toHaveLength(0);
  expect(r.events.some((e) => e.kind === 'app')).toBe(false);
};

describe('the honest model server', () => {
  it('completes, accepts our Finished (checked by an independent implementation) and the data comes through', async () => {
    const r = await run();
    expect(r.result.error).toBe('none');
    expect(r.server.clientFinishedOk).toBe(true);
    expect(tohex(r.result.appData)).toBe(tohex(WORLD));
  }, 60_000);
});

describe('tampering with the wire', () => {
  // the mock sends: 0 ServerHello, 1 EncryptedExtensions, 2 Certificate, 3 CertificateVerify, 4 Finished, 5 application data
  it.each([[1, 20], [2, 6], [3, 6], [4, 6], [4, 'tag']] as const)('one bit flipped in encrypted record %i (byte %s) is caught by the AEAD tag', async (record, at) => {
    const probe = await run({ tamper: undefined });
    const len = probe.result.received[record].length;
    const r = await run({ tamper: { flip: { record, byte: at === 'tag' ? len - 1 : at } } });
    stoppedBeforeFinished(r, 'mac');
    // and nothing past the record was processed: no signature check unless the flip was after it
    if (record < 3) expect(r.result.prims.rsa_pss).toBeUndefined();
  }, 60_000);
  it('a flipped bit in the plaintext ServerHello changes the transcript, so the first encrypted record fails its tag', async () => {
    stoppedBeforeFinished(await run({ tamper: { flip: { record: 0, byte: 20 } } }), 'mac');
    stoppedBeforeFinished(await run({ tamper: { flip: { record: 0, byte: 5 + 4 + 2 + 32 + 1 + 2 + 1 + 2 + 2 + 2 + 2 + 2 + 4 + 8 } } }), 'mac'); // inside the key share
  }, 60_000);
  it('a flipped record type is refused as a record error', async () => {
    stoppedBeforeFinished(await run({ tamper: { flip: { record: 1, byte: 0 } } }), 'record');
  }, 60_000);
  it('a flipped bit in application data fails its tag: the handshake stands, the data is never delivered', async () => {
    const r = await run({ tamper: { flip: { record: 5, byte: 6 } } });
    expect(r.result.error).toBe('mac');
    expect(r.result.ok).toBe(false);
    expect(r.result.appData).toHaveLength(0);
    expect(r.result.handshake.cycles).toBeGreaterThan(1e8);
  }, 60_000);
});

describe('a server that breaks one check', () => {
  it.each([
    ['badSignature', 'sig'], ['wrongSigner', 'sig'], ['badFinished', 'finished'], ['swapCertAndVerify', 'message'], ['hrr', 'hrr'], ['wrongCipher', 'hello'], ['wrongGroup', 'hello'],
    ['tls12', 'hello'], ['extraExtension', 'hello'], ['badSessionId', 'hello'], ['lowOrderShare', 'x25519'], ['clientAuth', 'unsupported'],
  ] as [Fault, string][])('%s is stopped by the %s check', async (fault, error) => {
    const r = await run({ fault });
    stoppedBeforeFinished(r, error);
    if (fault === 'badFinished') expect(r.result.prims.rsa_pss?.calls).toBe(1); // the signature was fine, the Finished was not
    if (fault === 'badSignature' || fault === 'wrongSigner') expect(r.result.phases.some((p) => p.name === 'server_finished')).toBe(false);
  }, 60_000);

  it('a fatal alert before the ServerHello is reported with its description', async () => {
    const r = await run({ fault: 'alert' });
    stoppedBeforeFinished(r, 'alert');
    expect(r.result.alert).toBe(40);
  }, 60_000);

  it('a flight that stops before the Finished ends the run as an I/O error, with nothing sent after the ClientHello', async () => {
    stoppedBeforeFinished(await run({ fault: 'noFinished' }), 'io');
  }, 60_000);

  it('a KeyUpdate after the handshake is refused (not implemented, so not guessed at)', async () => {
    const r = await run({ fault: 'keyUpdate', app: [{ recv: 1 }] });
    expect(r.result.error).toBe('unsupported');
    expect(r.result.appData).toHaveLength(0);
  }, 60_000);
});

describe('the man in the middle', () => {
  it('with his own key and certificate, and a perfectly valid handshake, he is stopped by the pin before any signature is checked', async () => {
    const r = await run({ mitm: true });
    stoppedBeforeFinished(r, 'pin');
    expect(r.result.prims.rsa_pss).toBeUndefined();
  }, 60_000);
  it('keeping the real certificate but signing with his own key, he is stopped by CertificateVerify', async () => {
    stoppedBeforeFinished(await run({ fault: 'wrongSigner' }), 'sig');
  }, 60_000);
  it('without a pin the client has nothing to compare: the same man in the middle is accepted (this client validates no certificate chain)', async () => {
    const r = await run({ mitm: true, pin: false });
    expect(r.result.error).toBe('none');
    expect(tohex(r.result.appData)).toBe(tohex(WORLD));
  }, 60_000);
});

describe('the harness reports which check caught a tamper', () => {
  const state = async (c: Case) => (await run(c)).result;
  it('names the check, and the ones before it as passed, the ones after it as never reached', async () => {
    const sig = await state({ fault: 'badSignature' });
    expect(sig.checks).toEqual({ record_tags: 'pass', pin: 'pass', certificate_verify: 'fail', server_finished: 'not_reached' });
    const fin = await state({ fault: 'badFinished' });
    expect(fin.checks).toEqual({ record_tags: 'pass', pin: 'pass', certificate_verify: 'pass', server_finished: 'fail' });
    const pin = await state({ mitm: true });
    expect(pin.checks).toEqual({ record_tags: 'pass', pin: 'fail', certificate_verify: 'not_reached', server_finished: 'not_reached' });
    const tag = await state({ tamper: { flip: { record: 2, byte: 6 } } });
    expect(tag.checks).toEqual({ record_tags: 'fail', pin: 'not_reached', certificate_verify: 'not_reached', server_finished: 'not_reached' });
    expect(tag.caughtBy).toBe('mac');
    const ok = await state({});
    expect(ok.checks).toEqual({ record_tags: 'pass', pin: 'pass', certificate_verify: 'pass', server_finished: 'pass' });
    expect(ok.caughtBy).toBeNull();
    expect((await state({ pin: false })).checks.pin).toBe('not_configured');
  }, 120_000);
  it('tamper.mitm swaps the server for the attacker: the real server never hears from the client, and the pin catches him', async () => {
    const legit = new MockServer({ certDer: new Uint8Array(LEGIT.cert.raw), signKey: LEGIT.key, ecdhPriv: randomBytes(32), random: randomBytes(32) });
    const attacker = new MockServer({ certDer: new Uint8Array(ATTACKER.cert.raw), signKey: ATTACKER.key, ecdhPriv: randomBytes(32), random: randomBytes(32) });
    const { result } = await collectTls({
      config: { random: randomBytes(32), privateKey: randomBytes(32), pin: pinOf(LEGIT.cert), offer: defaultOffer('localhost') }, transport: legit, tamper: { mitm: attacker },
    });
    expect(result.caughtBy).toBe('pin');
    expect(legit.clientRecords).toHaveLength(0);
    expect(attacker.clientRecords).toHaveLength(1);
  }, 60_000);
});
