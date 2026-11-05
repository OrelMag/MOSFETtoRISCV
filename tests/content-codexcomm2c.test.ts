// Group C of the Communication extension's codex (codexcomm2c.ts, codexmore8c.ts, codexcheck10c.ts): every number the entries quote
// equal to the model, the library or the cryptography they describe, or to the chapter step that prints it.

import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CODEX_C } from '../src/campaign/codexcomm2c';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { linkFacts } from '../src/chapters/ch-comm-pcie';
import { ACK_LIMIT, ADV_NPH, ADV_PD, ADV_PH, creditOk, LINE_DELAY, REPLAY_LIMIT, REPLAY_SLOTS, TS_RX, TS_TX } from '../src/comm/pcie';
import { BIT_CLOCKS, crc5Token, DEVICE_DESCRIPTOR, MAX_PACKET, PID, tokenBytes, UsbBench, UsbDevice } from '../src/comm/usb';
import COSTS from '../src/crypto/gatecosts.json';
import TLS from '../src/crypto/tls/costs.json';
import { usbCosts } from '../src/lib/usb';
import { laneGBs, parallelGBs, parallelMHz, PCIE_GENS, pcieCosts } from '../src/widgets/pcie';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const c = (n: number) => n.toLocaleString('en-US');
/** Digit groups spelled with a comma or a space compare equal (7,452 = 7 452). */
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
/** The chapter step's prose (body and layers, tags stripped) contains the string. */
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const hexOf = (b: Buffer) => b.toString('hex');
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((x, i) => x ^ b[i]));
const popcount = (a: Buffer, b: Buffer) => a.reduce((n, x, i) => { let v = x ^ b[i]; while (v) { n += v & 1; v >>= 1; } return n; }, 0);

describe('group C codex entries: PCIe and USB', () => {
  const ids = CODEX_C.map((e) => e.id);
  it('are the ten, each complete', () => {
    expect(ids).toEqual(['pcie', 'credits', 'replay', 'linktraining', 'usbenum', 'aes', 'sha256', 'blockmode', 'keyexchange', 'tls']);
  });

  it('pcie: the bus against the lane, the packet overhead and the gates', () => {
    expect(parallelMHz(1000)).toBe(500);
    expect(parallelGBs(1000, 64)).toBeCloseTo(4, 9);
    expect(Math.round(laneGBs(PCIE_GENS[4], 16))).toBe(63);
    expect(PCIE_GENS[4].name).toBe('5.0');
    expect(2 + 12 + 4 + 2).toBe(20);
    expect(Math.round((100 * 4) / 24)).toBe(17);
    expect(Math.round((100 * 256) / 276)).toBe(93);
    expect(PCIE_GENS[0].eff).toBe(0.8);
    const k = pcieCosts();
    expect(k.port - k.buffers).toBe(18854);
    expect(k.buffers).toBe(355716);
    expect(k.link).toBe(922275);
    quotes('pcie', '500 MHz', '4 GB/s', '63 GB/s', '17 %', '93 %', c(18854), c(355716), c(922275), '20 %', '12-bit', '32-bit', '6 bytes');
    says('pcie', 0, `${16 * 4} signal pins`);
    says('pcie', 1, '6 bytes');
    says('pcie', 1, '12-bit');
    says('pcie', 1, '17 %');
    says('pcie', 1, '93 %');
    says('pcie', 6, `${c(18854).replace(/,/g, ' ')} NANDs`);
    says('pcie', 6, `${c(922275).replace(/,/g, ' ')} for the link`);
    says('pcie', 1, 'ECRC');
  });

  it('credits: the modular test and its gates', () => {
    const left = (limit: number, consumed: number, w: number) => (limit - consumed + 2 ** w) % 2 ** w;
    expect(left(2, 254, 8)).toBe(4);
    expect(creditOk(2, 254, 4, 8)).toBe(true);
    expect(creditOk(2, 254, 5, 8)).toBe(false);
    expect(creditOk(4, 2, 2, 8)).toBe(true);
    expect(creditOk(4, 2, 3, 8)).toBe(false);
    expect((2 - 258 + 512) % 256).toBe(0);
    expect((2 - 259 + 512) % 256).toBe(255);
    expect((4 - 5 + 256) % 256).toBe(255);
    expect(2 >= 254 + 4).toBe(false);
    const k = pcieCosts();
    expect(k.gate8).toBe(271);
    expect(k.gate12).toBe(407);
    expect([ADV_PH, ADV_PD, ADV_NPH]).toEqual([4, 16, 4]);
    quotes('credits', '271 NANDs', '407', '4 posted headers, 16 data credits, 4 non-posted headers', '(2 − 254) mod 256 = 4', '4 dwords', '8 bits', '12');
    says('pcie', 2, `${c(271)} NANDs at 8 bits and ${c(407)} at 12`.replace(/,/g, ' '));
    says('pcie', 2, 'one data credit is 4 dwords');
    says('pcie', 2, 'infinite completion credits');
    says('pcie', 2, `${ADV_PH} posted headers, ${ADV_PD} data credits and ${ADV_NPH} non-posted headers`);
  });

  it('replay: the timers, the buffer and the round trip', () => {
    expect([REPLAY_LIMIT, ACK_LIMIT, REPLAY_SLOTS, LINE_DELAY]).toEqual([512, 32, 8, 4]);
    expect(linkFacts().wrAck).toBe(99);
    expect(2 ** 2).toBe(4);
    expect(4 * REPLAY_LIMIT).toBe(2048);
    quotes('replay', '99 clocks', '512 clocks', '32 clocks', '2,048', '4096', '2-bit', 'at most 8 TLPs');
    says('pcie', 3, 'modulo 4096');
    says('pcie', 3, `${REPLAY_SLOTS} TLPs unacknowledged`);
    says('pcie', 3, 'the standard allows 2048');
    says('pcie', 3, `${linkFacts().wrAck} clocks later`);
    says('pcie', 3, `${ACK_LIMIT} clocks a receiver may gather Acks`);
    says('pcie', 4, `${REPLAY_LIMIT} clocks here`);
    says('pcie', 4, '2-bit counter');
    says('pcie', 4, 'four replays');
    says('pcie', 4, 'an old sequence number');
  });

  it('linktraining: the sets, the counts and the clocks', () => {
    expect([TS_TX, TS_RX]).toEqual([16, 8]);
    expect(linkFacts().train).toBe(636);
    quotes('linktraining', '636 clocks', '16 TS1s', 'K28.5', '1024 TS1s', '8 seen in a row');
    says('pcie', 5, 'K28.5');
    says('pcie', 5, '1024 TS1s');
    says('pcie', 5, `${linkFacts().train} clocks`);
    says('pcie', 5, `sent at least ${TS_TX} and seen ${TS_RX} in a row`);
    says('pcie', 5, 'InitFC1');
  });

  it('usbenum: the device, the dialogue and the token', () => {
    expect(usbCosts().total).toBe(4571);
    const b = new UsbBench(new UsbDevice());
    b.run(60000);
    expect(b.clock).toBe(12702);
    expect(BIT_CLOCKS).toBe(4);
    expect(DEVICE_DESCRIPTOR[7]).toBe(8);
    expect(MAX_PACKET).toBe(8);
    expect(DEVICE_DESCRIPTOR.length).toBe(18);
    expect(tokenBytes(PID.SETUP, 0, 0).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')).toBe('2D 00 10');
    expect(crc5Token(0, 0).toString(2).padStart(5, '0')).toBe('00010');
    expect(8 + 8 + 2).toBe(DEVICE_DESCRIPTOR.length);
    quotes('usbenum', c(4571), c(12702), '2D 00 10', '00010', '4 clocks', 'max packet 8', '12 Mb/s');
    says('pcie', 8, `${c(4571)} NANDs`.replace(/,/g, ' '));
    says('pcie', 8, `${c(12702)} clocks`.replace(/,/g, ' '));
    says('pcie', 8, `${BIT_CLOCKS} clocks a bit`);
    says('pcie', 8, 'the status stage is addressed to the <em>old</em> address, 0'.replace(/<\/?em>/g, ''));
    says('pcie', 8, 'GET_DESCRIPTOR(device, 8)');
    says('pcie', 8, 'DATA1, DATA0, DATA1');
    says('pcie', 7, '2D 00 10');
  });
});

describe('group C codex entries: secret', () => {
  const KEY = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  const ecb = (data: Buffer) => createCipheriv('aes-128-ecb', KEY, null).setAutoPadding(false).update(data);

  it('aes: the standard\'s example, the S-box and the core', () => {
    const pt = Buffer.from('3243f6a8885a308d313198a2e0370734', 'hex');
    expect(hexOf(ecb(pt))).toBe('3925841d02dc09fbdc118597196a0b32');
    const p = COSTS.parts, core = COSTS.cores;
    expect(p.aes_sbox.nands).toBe(584);
    expect(p.aes_gf256_inverse.nands).toBe(476);
    expect(p.aes_sbox.depth).toBe(74);
    expect(p.aes_mixcolumn.nands).toBe(464);
    expect(p.aes_subbytes.nands).toBe(16 * 584);
    expect(p.aes_subbytes.nands).toBe(9344);
    expect(p.aes_key_step.nands).toBe(2880);
    expect(p.aes_round.nands).toBe(12224);
    expect([core.aes_core.nands, core.aes_core.cycles, core.aes_core.period]).toEqual([20782, 11, 102]);
    quotes('aes', '3925841d', '584 NANDs', c(12224), c(9344), c(20782), '11 clocks', '476', '74', '464', c(2880), 'period 102', '0xED', '0x320B6A19_978511DC_FB09DC02_1D842539');
    says('secret', 8, `${p.aes_sbox.nands} NANDs`);
    says('secret', 8, '0xED');
    says('secret', 9, `${c(p.aes_round.nands)} NANDs`.replace(/,/g, ' '));
    says('secret', 9, `${c(core.aes_core.nands)} NANDs`.replace(/,/g, ' '));
    says('secret', 9, `${core.aes_core.cycles} clocks a block`);
    says('secret', 10, '0x320B6A19_978511DC_FB09DC02_1D842539');
    says('secret', 9, 'no gates at all');
    says('secret', 11, 'about half');
  });

  it('sha256: "abc", one bit of avalanche and the core', () => {
    const h = (s: string) => createHash('sha256').update(s).digest();
    expect(hexOf(h('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(popcount(h('abc'), h('abb'))).toBe(124);
    expect('c'.charCodeAt(0) ^ 'b'.charCodeAt(0)).toBe(1);
    const p = COSTS.parts, core = COSTS.cores;
    expect([p.sha_round.nands, p.sha_schedule.nands, p.sha_k_rom.nands]).toEqual([2848, 11104, 3337]);
    expect([core.sha_core.nands, core.sha_core.cycles, core.sha_core.period]).toEqual([28487, 65, 108]);
    expect((core.sha_core.cycles / 64).toFixed(2)).toBe('1.02');
    expect((core.aes_core.cycles / 16).toFixed(2)).toBe('0.69');
    expect(TLS.primitives['sha256 per 64-byte block']).toBe(8364);
    quotes('sha256', 'ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad', '124', '2,848', '28,487', '65 clocks', '11,104', '3,337', 'period 108', '8,364', '1.02', '0.69');
    says('secret', 14, `${c(2848)} NANDs`.replace(/,/g, ' '));
    says('secret', 14, `${c(28487)} NANDs`.replace(/,/g, ' '));
    says('secret', 14, `${core.sha_core.cycles} clocks per 64 bytes`);
    says('secret', 14, '1.02 clocks against AES\'s 0.69');
    says('secret', 15, 'ba7816bf 8f01cfea … f20015ad');
    says('secret', 13, '64 rounds');
    says('secret', 13, 'eight 32-bit registers');
  });

  it('blockmode: ECB repeats, CTR does not, a reused counter cancels', () => {
    const zeros = Buffer.alloc(32);
    const e = ecb(zeros);
    expect(hexOf(e.subarray(0, 16))).toBe(hexOf(e.subarray(16)));
    expect(hexOf(e.subarray(0, 8))).toBe('7df76b0c1ab899b3');
    const ctr = createCipheriv('aes-128-ctr', KEY, Buffer.alloc(16)).update(zeros);
    expect(hexOf(ctr.subarray(0, 4))).toBe('7df76b0c');
    expect(hexOf(ctr.subarray(16, 20))).toBe('57127d40');
    expect(hexOf(ctr.subarray(0, 16))).not.toBe(hexOf(ctr.subarray(16)));
    // the same counter and key for two messages: the ciphertexts' XOR is the plaintexts' XOR
    const p1 = Buffer.from('attack at dawn!!'), p2 = Buffer.from('retreat at noon!');
    const iv = Buffer.alloc(16, 7);
    const c1 = createCipheriv('aes-128-ctr', KEY, iv).update(p1), c2 = createCipheriv('aes-128-ctr', KEY, iv).update(p2);
    expect(hexOf(xor(c1, c2))).toBe(hexOf(xor(p1, p2)));
    quotes('blockmode', '7df76b0c', '57127d40', 'c1 ⊕ c2 = p1 ⊕ p2', 'GF(2128)');
    says('secret', 12, 'ECB');
    says('secret', 12, 'leaks every repeat');
    says('secret', 12, 'GF(2¹²⁸)');
    says('secret', 12, 'only the encrypt direction');
    says('secret', 12, 'authenticated encryption');
  });

  it('keyexchange: the toy exchange and the curve\'s cost', () => {
    const mp = (b: bigint, e: bigint, m: bigint) => { let r = 1n; b %= m; while (e) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
    const P = 23n, G = 5n, a = 6n, b = 15n;
    const A = mp(G, a, P), B = mp(G, b, P);
    expect([A, B]).toEqual([8n, 19n]);
    expect(mp(B, a, P)).toBe(2n);
    expect(mp(A, b, P)).toBe(2n);
    const x = TLS.primitives.x25519, aes = TLS.primitives['aes-128 block'];
    expect(x).toBe(34569985);
    expect(aes).toBe(8057);
    expect(Math.round(x / aes / 100) * 100).toBe(4300);
    quotes('keyexchange', '5^6 mod 23 = 8', '5^15 mod 23 = 19', '19^6 mod 23 = 2', '8^15 mod 23 = 2', c(x), c(aes), '4,300', '255-bit', '32 limbs of 8 bits');
    says('secret', 17, `${c(x)} cycles`.replace(/,/g, ' '));
    says('secret', 17, `${c(aes)} for an AES block`.replace(/,/g, ' '));
    says('secret', 17, '32 limbs of 8 bits');
    says('secret', 17, '255-bit numbers');
    says('secret', 16, 'the shared secret is never sent');
    says('secret', 16, '2³¹ − 1');
    says('secret', 16, 'Shor');
  });

  it('tls: the handshake in cycles, and the client\'s size', () => {
    const hs = TLS.handshake['rfc8448 (1024-bit RSA, three cipher suites offered)'];
    expect(hs.cycles).toBe(81277693);
    expect(hs.prims.x25519.calls).toBe(2);
    expect(hs.prims.x25519.cycles).toBe(69139884);
    expect(2 * TLS.primitives.x25519).toBeGreaterThan(hs.prims.x25519.cycles - 1e5);
    expect(Math.round((100 * hs.prims.x25519.cycles) / hs.cycles)).toBe(85);
    expect(hs.phases.client_hello).toBe(34598182);
    expect(hs.phases.key_agreement).toBe(35089754);
    expect(hs.phases.certificate_verify).toBe(10338413);
    const { client_hello, key_agreement, certificate_verify, ...rest } = hs.phases;
    expect(Object.keys(rest)).toHaveLength(5);
    expect(Object.values(rest).reduce((s, v) => s + v, 0)).toBe(1251248);
    expect(hs.cycles - client_hello - key_agreement - certificate_verify - 1251248).toBe(96);
    expect(TLS.primitives['rsa-pss-sha256 verify, 1024-bit key (RFC 8448)']).toBe(10310080);
    expect(TLS.primitives['rsa-pss-sha256 verify, 2048-bit key']).toBe(40767022);
    expect(TLS.lines.total.python).toBe(1314);
    expect(TLS.words.total).toBe(7428);
    expect([hs.clientHelloBytes, hs.bytesSent, hs.bytesReceived]).toEqual([201, 259, 774]);
    quotes('tls', c(hs.cycles), c(hs.prims.x25519.cycles), '85 %', c(34598182), c(35089754), c(10338413), c(1251248), c(10310080), c(40767022), c(1314), c(7428), '201', '259', '774', '779,480', '10,310,029', '8,364');
    expect(hs.prims.hkdf.cycles).toBe(779480);
    expect(hs.prims.rsa_pss.cycles).toBe(10310029);
    says('secret', 19, 'one round trip');
    says('secret', 19, `${c(TLS.lines.total.python)} lines of Python`.replace(/,/g, ' '));
    says('secret', 19, `${c(TLS.words.total)} words of RV32IM`.replace(/,/g, ' '));
    says('secret', 19, 'RFC 8448');
    says('secret', 19, 'CertificateVerify');
    says('secret', 18, 'forward secrecy');
    says('secret', 18, 'a pin');
    says('secret', 20, `${Math.round(hs.cycles / 1e6)} million cycles`);
  });
});
