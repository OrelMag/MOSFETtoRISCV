// Codex entries for the Communication extension: pcie, secret. Same shape as codex.ts, gathered by codexcomm2.ts; the fuller texts are codexmore8c.ts, the questions codexcheck10c.ts,
// the numbers pinned by tests/content-codexcomm2c.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_C: CodexEntry[] = [
  E('pcie', 'PCI Express', 'component', 'PCI Express replaces a shared parallel bus with point-to-point lanes, a differential pair each way with the clock recovered from the data, so skew between wires stops mattering (1 ns of it caps a 64-bit bus at 500 MHz and 4 GB/s). The price is a three-layer packet protocol: a TLP from the transaction layer, a 12-bit sequence number and a 32-bit LCRC from the data link layer, framing and line code below. In the chapter\'s gates one port is 18,854 NANDs of logic plus 355,716 for its two buffers.', ['crc', 'linecode', 'arq', 'cdr', 'rdma']),
  E('credits', 'Credit-based flow control', 'trick', 'The receiver tells the sender its buffer sizes when the link comes up, in credits (a header credit is one TLP header, a data credit 4 dwords), and nothing is sent that the credits do not cover: overrun is prevented, not repaired. The sender keeps CREDIT_LIMIT and CREDITS_CONSUMED as free-running counters, 8 bits for headers and 12 for data, and tests (LIMIT − (CONSUMED + want)) mod 2<sup>w</sup> ≤ 2<sup>w−1</sup>, which stays right across a wrap. That gate is 271 NANDs at 8 bits and 407 at 12.', ['pcie', 'replay', 'tcp', 'pfc']),
  E('replay', 'Ack, Nak and the replay buffer', 'tool', 'The data link layer keeps every TLP it sends until it is acknowledged. An Ack for sequence s frees everything up to s, so a receiver gathers them (32 clocks here); a bad LCRC is dropped and Nak\'d with the last good number, and the sender replays the rest in order. A lost Ack is cured by the replay timer (512 clocks here), a duplicate is dropped and acknowledged again, and four replays without progress send the link to Recovery.', ['pcie', 'arq', 'crc', 'credits']),
  E('linktraining', 'Link training', 'concept', 'Neither end of a new link knows if the other is there, where its symbols start or how fast it runs. The LTSSM finds out with ordered sets: Detect, then Polling (TS1s to find boundaries, TS2s for "I hear you"), Configuration, and L0, after which the data link layer exchanges InitFC DLLPs. In the chapter\'s gates that takes 636 clocks, with at least 16 TS1s sent and 8 seen in a row before Polling moves on; Recovery repeats the same moves without losing the replay buffer.', ['pcie', 'cdr', 'equalization', 'handshake']),
  E('usbenum', 'USB enumeration', 'concept', 'A device plugged in has address 0 and knows nothing; the host resets the bus and walks it through control transfers on endpoint 0: read 8 bytes of the device descriptor for the packet size, SET_ADDRESS, the full descriptor, the configuration descriptor, SET_CONFIGURATION. The trap is that SET_ADDRESS ends with a status stage still addressed to the old address 0, so the device must change only after it. The chapter\'s gate-level device is 4,571 NANDs and enumerates in 12,702 clocks.', ['pcie', 'arq', 'crc', 'linecode']),
  E('aes', 'AES', 'component', 'AES-128 works on a 16-byte state: a key XOR, then ten rounds of SubBytes, ShiftRows, MixColumns and AddRoundKey, the last without MixColumns. The S-box is the inverse in GF(2<sup>8</sup>) plus an affine map, built here as a tower of smaller fields in 584 NANDs; a round is 12,224 NANDs, 9,344 of them S-boxes. The core is 20,782 NANDs and 11 clocks a block, the key a register rather than part of the wiring.', ['blockmode', 'sha256', 'keyexchange', 'tls', 'reedsolomon']),
  E('sha256', 'SHA-256', 'component', 'A keyless hash: any message is padded, cut into 64-byte blocks and each block stirred through 64 rounds into eight 32-bit registers, giving 256 bits for which nobody can find a message or a collision. Rotations are wires, so a round is adders and logic only: 2,848 NANDs, a core of 28,487 and 65 clocks per block. Changing one letter of "abc" flips 124 of the 256 digest bits.', ['aes', 'tls', 'crc', 'keyexchange']),
  E('blockmode', 'Block cipher modes', 'concept', 'A block cipher maps 16 bytes to 16 bytes under a key; a mode says how longer messages are chained. ECB enciphers each block alone, so equal blocks stay equal and a picture\'s outline shows through. CTR enciphers a counter and XORs it in, hiding repeats but dying if a counter is reused under one key, and it cannot notice a flipped bit; GCM adds a tag over the ciphertext so a changed message is refused, and TLS 1.3 allows only authenticated modes.', ['aes', 'tls', 'crc']),
  E('keyexchange', 'Key exchange (X25519)', 'tool', 'Two strangers get a shared secret from public messages: each keeps a private number, sends a public value computed from it, and raises what arrives to their own secret. The shared secret is never sent; recovering a private number from a public one is a discrete logarithm. X25519 does this on a curve with 255-bit numbers, and the chapter\'s Python on the RV32 takes 34,569,985 cycles for one, against 8,057 for an AES block. It says nothing about who is at the other end.', ['tls', 'aes', 'sha256', 'handshake']),
  E('tls', 'TLS 1.3', 'tool', 'A handshake of one round trip: ClientHello and ServerHello carry X25519 shares in the clear, HKDF turns the shared secret into keys, and everything after is AES-128-GCM: server certificate, a signature over the transcript, and a Finished HMAC on both sides. The session keys come only from the exchange, so a stolen long-term key does not open old recordings. On the chapter\'s RV32 client it is 81,277,693 cycles, 85 % of them in the two X25519 runs.', ['keyexchange', 'aes', 'sha256', 'tcp', 'handshake']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_C: Record<string, string> = {
  pcie: 'pcie',
  credits: 'pcie',
  replay: 'pcie',
  linktraining: 'pcie',
  usbenum: 'pcie',
  aes: 'secret',
  sha256: 'secret',
  blockmode: 'secret',
  keyexchange: 'secret',
  tls: 'secret',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_C: Record<string, string[]> = {
  credits: ['credit flow control'],
  replay: ['replay buffer'],
  linktraining: ['LTSSM'],
  aes: ['AES-128'],
  keyexchange: ['Diffie-Hellman'],
};
