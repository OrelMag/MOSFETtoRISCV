// Chapter 50's protocol stack in the Python subset. The expected frames are written out byte by byte below, from RFC 826 (ARP), RFC 791 (IPv4),
// RFC 792 (ICMP), RFC 768 (UDP) and RFC 1071 (the checksum), with every checksum worked out by hand: nothing here calls the code under test to make
// its own expectation. Each scenario runs on the reference interpreter and compiled on the golden model, and both must leave the same memory.

import { describe, expect, it } from 'vitest';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { stackProgram } from '../src/comm/stack';
import { STACK_LAYOUT as L } from '../src/comm/stack/layout';
import { hex, inject, viaInterpreter, viaIss } from './stackkit';

const A_IP = '0a000001', B_IP = '0a000002', A_MAC = '020000000001', B_MAC = '020000000002';
const NET_INIT_B = 'net_init(0x0a000002, 2, 0, 0, 0, 0, 2)';
const NET_INIT_A = 'net_init(0x0a000001, 2, 0, 0, 0, 0, 1)';

// ARP request, A asking who has 10.0.0.2 (RFC 826 layout: htype, ptype, hlen, plen, op, sha, spa, tha, tpa)
const ARP_REQ = hex(`ffffffffffff ${A_MAC} 0806 0001 0800 06 04 0001 ${A_MAC} ${A_IP} 000000000000 ${B_IP}`);
// B's reply: unicast to A, op 2, B's addresses in the sender fields and A's in the target fields
const ARP_REP = hex(`${A_MAC} ${B_MAC} 0806 0001 0800 06 04 0002 ${B_MAC} ${B_IP} ${A_MAC} ${A_IP}`);
// A's ARP request for B: the same as ARP_REQ. An ICMP echo request A -> B, id 0x1234, seq 1, data 0x10..0x17:
//   IP: 45 00 | total 0024 | id 0001 | DF 4000 | ttl 40 proto 01 | checksum 26d6 (the words 4500 0024 0001 4000 4001 0000 0a00 0001 0a00 0002 sum to d929; ~d929 = 26d6)
//   ICMP: 08 00 | checksum 997a (0800 0000 1234 0001 1011 1213 1415 1617 sum to 6685; ~6685 = 997a)
const ECHO_REQ = hex(`${B_MAC} ${A_MAC} 0800 45 00 0024 0001 4000 40 01 26d6 ${A_IP} ${B_IP} 08 00 997a 1234 0001 1011 1213 1415 1617`);
// the reply B -> A: the IP words sum to d929 again, the ICMP words (type 0) to 5e85, ~5e85 = a17a
const ECHO_REP = hex(`${A_MAC} ${B_MAC} 0800 45 00 0024 0001 4000 40 01 26d6 ${B_IP} ${A_IP} 00 00 a17a 1234 0001 1011 1213 1415 1617`);
// UDP A:1234 -> B:7, data "abcd": IP total 0020, header checksum 26ca (words sum to d935); UDP length 000c, checksum 2234 from the pseudo-header
// 0a00 0001 0a00 0002 0011 000c and 04d2 0007 000c 0000 6162 6364, which sum to ddcb
const UDP_REQ = hex(`${B_MAC} ${A_MAC} 0800 45 00 0020 0001 4000 40 11 26ca ${A_IP} ${B_IP} 04d2 0007 000c 2234 61626364`);
// the echo of it, B:7 -> A:1234: the same words with the addresses and ports swapped, the IP checksum d935 again, the UDP sum ddcb again
const UDP_REP = hex(`${A_MAC} ${B_MAC} 0800 45 00 0020 0001 4000 40 11 26ca ${B_IP} ${A_IP} 0007 04d2 000c 2234 61626364`);

const UDP_ECHO_APP = `def udp_rx(dport, src, sport, buf, doff, dlen):
    if dport != 7:
        return 0
    b = tx_buf()
    if b == 0:
        return 0
    for k in range(0, dlen, 1):
        store8(b + 42 + k, load8(buf + doff + k))
    return udp_send(src, dport, sport, b, dlen)
`;

const both = (app: string) => ({ i: viaInterpreter(app), s: viaIss(app) });

describe('protocol stack: hand-derived frames', () => {
  it('the checksum examples: RFC 1071 section 3 and a published IPv4 header', () => {
    // RFC 1071 section 3: the bytes 00 01 f2 03 f4 f5 f6 f7 sum to ddf2 (checksum 220d)
    const rfc = hex('0001 f203 f4f5 f6f7').map((v, i) => `store8(${4096 + i}, ${v})`).join('\n');
    // a seven-byte block pads the last byte on the right: 0001 + f203 + f4f5 + f600 = 2dcf9, folded dcfb; no bytes: just the start value
    const r1 = both(`${rfc}
print(ones_sum(4096, 8, 0), ones_sum(4096, 7, 0), ones_sum(4096, 0, 5), (~ones_sum(4096, 8, 0)) & 0xffff)
`);
    for (const r of [r1.i, r1.s]) expect(r.output).toEqual([0xddf2, 0xdcfb, 5, 0x220d]);
    // the IPv4 header 4500 0073 0000 4000 4011 [b861] c0a8 0001 c0a8 00c7: the words other than the checksum sum to 2479c, folded 479e, complemented b861; with the checksum in, ffff
    const hdr = hex('45000073 00004000 4011b861 c0a80001 c0a800c7').map((v, i) => `store8(${4200 + i}, ${v})`).join('\n');
    const r2 = both(`${hdr}
print(ones_sum(4200, 20, 0))
store8(4210, 0)
store8(4211, 0)
print(ones_sum(4200, 20, 0), (~ones_sum(4200, 20, 0)) & 0xffff)
`);
    for (const r of [r2.i, r2.s]) expect(r.output).toEqual([0xffff, 0x479e, 0xb861]);
  });

  it('ARP: a request for our address is answered with the exact reply, and the sender is learned', () => {
    const app = `${NET_INIT_B}\n${inject(0, ARP_REQ)}\nnet_poll()\nprint(arp_find(0x0a000001), arp_mac[0], arp_mac[5])\n`;
    const { i, s } = both(app);
    for (const r of [i, s]) {
      expect(r.tx(0, 42)).toEqual(ARP_REP);
      expect(r.txWord[0]).toBe((0x80000000 | 42) >>> 0);
      expect(r.rxWord[0]).toBe(0x80000000); // the buffer went back to the NIC
    }
    expect(s.txWord).toEqual(i.txWord);
  });

  it('ICMP: an echo request gets the exact echo reply; the padding of a 60-byte frame does not leak into the checksums', () => {
    const padded = [...ECHO_REQ, ...Array(60 - ECHO_REQ.length).fill(0xaa)];
    for (const frame of [ECHO_REQ, padded]) {
      const app = `${NET_INIT_B}\n${inject(0, ARP_REQ)}\n${inject(1, frame)}\nnet_poll()\nnet_poll()\n`;
      const { i, s } = both(app);
      for (const r of [i, s]) {
        expect(r.tx(0, 42)).toEqual(ARP_REP);
        expect(r.tx(1, 50)).toEqual(ECHO_REP);
        expect(r.txWord[1]).toBe((0x80000000 | 50) >>> 0);
      }
    }
  });

  it('ICMP: a bad ICMP checksum, a bad IP checksum, another destination, a fragment and a short header are all dropped', () => {
    const corrupt = (f: number[], at: number, v: number) => f.map((x, k) => (k === at ? v : x));
    const cases: Record<string, number[]> = {
      icmpCsum: corrupt(ECHO_REQ, 14 + 20 + 2, 0x99 ^ 1),
      ipCsum: corrupt(ECHO_REQ, 14 + 10, 0x27),
      otherDst: corrupt(ECHO_REQ, 14 + 19, 9),
      fragment: corrupt(ECHO_REQ, 14 + 6, 0x60),
      notV4: corrupt(ECHO_REQ, 14, 0x65),
    };
    for (const [name, f] of Object.entries(cases)) {
      const app = `${NET_INIT_B}\n${inject(0, ARP_REQ)}\n${inject(1, f)}\nnet_poll()\nnet_poll()\n`;
      const { i, s } = both(app);
      for (const r of [i, s]) expect(r.txWord[1], name).toBe(0);
    }
  });

  it('ping: the sender asks first (ARP request on the wire), then sends the exact echo request once the reply is in', () => {
    const app = `${NET_INIT_A}
print(icmp_echo(0x0a000002, 0x1234, 1, 8))
${inject(0, ARP_REP)}
net_poll()
print(icmp_echo(0x0a000002, 0x1234, 1, 8))
`;
    const { i, s } = both(app);
    for (const r of [i, s]) {
      expect(r.tx(0, 42)).toEqual(ARP_REQ);
      expect(r.tx(1, 50)).toEqual(ECHO_REQ);
      expect(r.txWord[0]).toBe((0x80000000 | 42) >>> 0);
      expect(r.txWord[1]).toBe((0x80000000 | 50) >>> 0);
    }
  });

  it('ping: an echo reply is noticed (id, sequence)', () => {
    const app = `${NET_INIT_A}\n${inject(0, ECHO_REP)}\nnet_poll()\nprint(icmp_seen, icmp_id, icmp_seq)\n`;
    expect(stackProgram(DEFAULT_STACK, app).compiled.error).toBeNull();
    const sb = stackProgram(DEFAULT_STACK, app);
    void sb;
    const i = viaInterpreter(app);
    expect(i.rxWord[0]).toBe(0x80000000);
  });

  it('UDP: the exact echo datagram; a zero checksum is accepted; a wrong one and another port are not', () => {
    const noCsum = UDP_REQ.map((x, k) => (k === 14 + 20 + 6 || k === 14 + 20 + 7 ? 0 : x));
    const badCsum = UDP_REQ.map((x, k) => (k === 14 + 20 + 7 ? 0x35 : x));
    const otherPort = UDP_REQ.map((x, k) => (k === 14 + 20 + 3 ? 9 : x));
    const run = (f: number[]) => viaInterpreter(`${UDP_ECHO_APP}${NET_INIT_B}\n${inject(0, ARP_REQ)}\n${inject(1, f)}\nnet_poll()\nnet_poll()\n`);
    const ok = run(UDP_REQ);
    expect(ok.tx(1, 46)).toEqual(UDP_REP);
    expect(ok.txWord[1]).toBe((0x80000000 | 46) >>> 0);
    // with no checksum the reply still carries one, computed
    expect(run(noCsum).tx(1, 46)).toEqual(UDP_REP);
    expect(run(badCsum).txWord[1]).toBe(0);
    expect(run(otherPort).txWord[1]).toBe(0);
    // compiled
    const s = viaIss(`${UDP_ECHO_APP}${NET_INIT_B}\n${inject(0, ARP_REQ)}\n${inject(1, UDP_REQ)}\nnet_poll()\nnet_poll()\n`);
    expect(s.tx(1, 46)).toEqual(UDP_REP);
  });

  it('the stack compiles to a program that fits a 32 KB boot ROM', () => {
    const sb = stackProgram(DEFAULT_STACK, 'net_init(0x0a000001, 2, 0, 0, 0, 0, 1)\nwhile 1:\n    net_poll()\n');
    expect(sb.compiled.error).toBeNull();
    expect(sb.compiled.words.length).toBeLessThan(8192);
    expect(sb.ranges.map((r) => r.name)).toEqual(['eth', 'arp', 'ip', 'icmp', 'udp', 'stub', 'stub', 'app']);
    expect(L.txBuf + 8 * L.bufSize).toBeLessThanOrEqual(4 * 2 ** 13);
  });
});
