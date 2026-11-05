// What the client offers, as data the harness injects (the CPU assembles the ClientHello from it and fills in the random and the key_share): the cipher
// list and two extension blobs, one before the key_share and one after it (the extension order is the list's order).

export interface HelloOffer {
  sessionId: Uint8Array;
  cipherSuites: number[];
  /** Extensions that precede key_share (type, length, body each). */
  pre: Uint8Array;
  /** Extensions that follow it. */
  post: Uint8Array;
}

const hex = (s: string): Uint8Array => Uint8Array.from(s.replace(/\s+/g, '').match(/../g) ?? [], (h) => parseInt(h, 16));
const cat = (...a: Uint8Array[]): Uint8Array => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

/** server_name (RFC 6066) for one host name. */
export function serverName(host: string): Uint8Array {
  const h = Uint8Array.from([...host], (c) => c.charCodeAt(0));
  const list = cat(Uint8Array.of(0, h.length >> 8, h.length & 255), h);
  const body = cat(Uint8Array.of(list.length >> 8, list.length & 255), list);
  return cat(Uint8Array.of(0, 0, body.length >> 8, body.length & 255), body);
}

/** TLS_AES_128_GCM_SHA256 only, x25519 only, rsa_pss_rsae_sha256 only, TLS 1.3 only. */
export function defaultOffer(host?: string): HelloOffer {
  return {
    sessionId: new Uint8Array(0),
    cipherSuites: [0x1301],
    pre: cat(host ? serverName(host) : new Uint8Array(0), hex('000a 0004 0002 001d')),
    post: hex('002b 0003 02 0304  000d 0004 0002 0804'),
  };
}

/** The ClientHello of RFC 8448 section 3, extension by extension: three cipher suites, an empty session id, server_name "server", renegotiation_info,
 * ten groups, an empty session_ticket, then (after the key_share) supported_versions, the signature_algorithms list, psk_key_exchange_modes and record_size_limit. */
export function rfc8448Offer(): HelloOffer {
  return {
    sessionId: new Uint8Array(0),
    cipherSuites: [0x1301, 0x1303, 0x1302],
    pre: hex(`0000 000b 0009 00 0006 736572766572  ff01 0001 00  000a 0014 0012 001d 0017 0018 0019 0100 0101 0102 0103 0104  0023 0000`),
    post: hex(`002b 0003 02 0304  000d 0020 001e 0403 0503 0603 0203 0804 0805 0806 0401 0501 0601 0201 0402 0502 0602 0202  002d 0002 0101  001c 0002 4001`),
  };
}
