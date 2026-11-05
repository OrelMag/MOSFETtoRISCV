// What src/crypto/tls/rfc8448.json holds: what the chapter's handshake needs in the browser, taken from the RFC's own text (tests/fixtures/tls/vectors.json): the client's
// entropy, the server's records, what the client must answer, and the pin of the trace's certificate. tests/crypto-tls-flight.test.ts checks it is current.
//   vite-node scripts/tls-flight-write.ts

import { createHash, X509Certificate } from 'node:crypto';
import { tohex, trace, V } from '../tests/crypto-tls-kit';

export function flight(): Record<string, unknown> {
  const client = (a: string, f: string) => trace(`client ${a}`, f), server = (a: string, n = 0) => tohex(trace(`server ${a}`, 'complete record', n));
  const cert = trace('server construct a Certificate handshake message', 'Certificate'), der = cert.subarray(11, 11 + ((cert[8] << 16) | (cert[9] << 8) | cert[10]));
  const spki = new X509Certificate(Buffer.from(der)).publicKey.export({ type: 'spki', format: 'der' });
  const hello = client('construct a ClientHello handshake message', 'ClientHello');
  return {
    source: 'RFC 8448 section 3, Simple 1-RTT Handshake',
    random: tohex(hello.subarray(6, 38)),
    privateKey: tohex(client('create an ephemeral x25519 key pair', 'private key')),
    pin: createHash('sha256').update(spki).digest('hex'),
    server: [server('send handshake record', 0), server('send handshake record', 1), server('send handshake record', 2)],
    clientHello: tohex(trace('client send handshake record', 'complete record', 0)),
    clientFinished: tohex(trace('client send handshake record', 'complete record', 1)),
    dh: V.x25519.dh,
  };
}
