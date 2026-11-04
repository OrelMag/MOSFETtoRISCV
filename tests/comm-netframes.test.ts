// comm/netframes.ts is written independently of the Python stack: the frames it builds are the hand-derived ones of tests/comm-stack.test.ts, and
// the stack running on the golden model produces the very same bytes for a spread of addresses, identifiers, lengths and ports.

import { describe, expect, it } from 'vitest';
import { arpFrame, checksum, dissect, icmpEchoFrame, ip4, onesSum, udpFrame, onWire } from '../src/comm/netframes';
import { lcg } from './util';
import { hex, inject, viaInterpreter, viaIss } from './stackkit';

const A_MAC = [2, 0, 0, 0, 0, 1], B_MAC = [2, 0, 0, 0, 0, 2];
const A_IP = ip4(10, 0, 0, 1), B_IP = ip4(10, 0, 0, 2);

describe('netframes against the hand-derived frames', () => {
  it('ARP, ICMP echo and UDP', () => {
    const A = `${'020000000001'}`, B = '020000000002';
    expect(arpFrame({ op: 1, sha: A_MAC, spa: A_IP, tha: [0, 0, 0, 0, 0, 0], tpa: B_IP }).bytes).toEqual(hex(`ffffffffffff ${A} 0806 0001 0800 06 04 0001 ${A} 0a000001 000000000000 0a000002`));
    expect(arpFrame({ op: 2, sha: B_MAC, spa: B_IP, tha: A_MAC, tpa: A_IP }).bytes).toEqual(hex(`${A} ${B} 0806 0001 0800 06 04 0002 ${B} 0a000002 ${A} 0a000001`));
    const data = hex('1011 1213 1415 1617');
    expect(icmpEchoFrame({ srcMac: A_MAC, dstMac: B_MAC, src: A_IP, dst: B_IP, id: 1, ident: 0x1234, seq: 1, data }).bytes)
      .toEqual(hex(`${B} ${A} 0800 45 00 0024 0001 4000 40 01 26d6 0a000001 0a000002 08 00 997a 1234 0001 1011 1213 1415 1617`));
    expect(icmpEchoFrame({ srcMac: B_MAC, dstMac: A_MAC, src: B_IP, dst: A_IP, id: 1, ident: 0x1234, seq: 1, data, reply: true }).bytes)
      .toEqual(hex(`${A} ${B} 0800 45 00 0024 0001 4000 40 01 26d6 0a000002 0a000001 00 00 a17a 1234 0001 1011 1213 1415 1617`));
    expect(udpFrame({ srcMac: A_MAC, dstMac: B_MAC, src: A_IP, dst: B_IP, id: 1, sport: 1234, dport: 7, data: [0x61, 0x62, 0x63, 0x64] }).bytes)
      .toEqual(hex(`${B} ${A} 0800 45 00 0020 0001 4000 40 11 26ca 0a000001 0a000002 04d2 0007 000c 2234 61626364`));
  });
  it('the checksum of RFC 1071 and of a published header', () => {
    expect(onesSum(hex('0001 f203 f4f5 f6f7'))).toBe(0xddf2);
    expect(checksum(hex('0001 f203 f4f5 f6f7'))).toBe(0x220d);
    expect(checksum(hex('4500 0073 0000 4000 4011 0000 c0a8 0001 c0a8 00c7'))).toBe(0xb861);
  });
  it('a computed UDP checksum of zero goes out as ffff', () => {
    // find a payload whose checksum is 0: the datagram's words (with the pseudo-header) sum to ffff
    for (let v = 0; v < 65536; v++) {
      const f = udpFrame({ srcMac: A_MAC, dstMac: B_MAC, src: A_IP, dst: B_IP, id: 1, sport: 1, dport: 2, data: [v >> 8, v & 255] });
      const ck = (f.bytes[40] << 8) | f.bytes[41];
      expect(ck).not.toBe(0);
      if (ck === 0xffff) {
        // the sum without the checksum field is 0xffff here, so the plain complement would have been 0
        expect(onesSum([...f.bytes.slice(34, 40), 0, 0, ...f.bytes.slice(42)], onesSum([10, 0, 0, 1, 10, 0, 0, 2, 0, 17, 0, 10]))).toBe(0xffff);
        return;
      }
    }
    throw new Error('no payload found');
  });
  it('dissects what it builds', () => {
    expect(dissect(arpFrame({ op: 1, sha: A_MAC, spa: A_IP, tha: [0, 0, 0, 0, 0, 0], tpa: B_IP }).bytes)).toBe('ARP who has 10.0.0.2? tell 10.0.0.1');
    expect(dissect(icmpEchoFrame({ srcMac: A_MAC, dstMac: B_MAC, src: A_IP, dst: B_IP, id: 1, ident: 0x1234, seq: 3, data: [] }).bytes)).toBe('ICMP echo request 10.0.0.1 > 10.0.0.2 id 0x1234 seq 3');
    expect(onWire(arpFrame({ op: 1, sha: A_MAC, spa: A_IP, tha: [0, 0, 0, 0, 0, 0], tpa: B_IP })).length).toBe(60);
  });
});

describe('the compiled stack builds the same bytes', () => {
  const rnd = lcg(99);
  it('ICMP echo requests and UDP datagrams over a spread of parameters', () => {
    for (let k = 0; k < 8; k++) {
      const src = ip4(10 + rnd(200), rnd(256), rnd(256), 1 + rnd(250)), dst = ip4(10 + rnd(200), rnd(256), rnd(256), 1 + rnd(250));
      const sm = Array.from({ length: 6 }, () => rnd(256)), dm = Array.from({ length: 6 }, () => rnd(256));
      sm[0] &= 0xfe; dm[0] &= 0xfe;
      const ident = rnd(65536), seq = rnd(65536), n = rnd(40), data = Array.from({ length: n }, (_, i) => 16 + i);
      // same /24? then the destination is the next hop; otherwise the sender needs a gateway: keep both in one network by building dst from src
      const dstIp = (src & 0xffffff00) | (1 + rnd(250)), dstMac = dm;
      const reply = arpFrame({ op: 2, sha: dstMac, spa: dstIp >>> 0, tha: sm, tpa: src });
      const hexs = (n2: number) => `0x${(n2 >>> 0).toString(16)}`;
      const app = `net_init(${hexs(src)}, ${sm.join(', ')})\n${inject(0, reply.bytes)}\nnet_poll()\nicmp_echo(${hexs(dstIp)}, ${ident}, ${seq}, ${n})\n`;
      const want = icmpEchoFrame({ srcMac: sm, dstMac, src, dst: dstIp >>> 0, id: 1, ident, seq, data }).bytes;
      const r = viaIss(app);
      expect(r.tx(0, want.length), `echo ${k}`).toEqual(want);
      expect(r.txWord[0] >>> 0).toBe((0x80000000 | want.length) >>> 0);
      void dst;
      // UDP
      const sport = rnd(65536), dport = rnd(65536), m = 1 + rnd(30), payload = Array.from({ length: m }, () => rnd(256));
      const udpApp = `net_init(${hexs(src)}, ${sm.join(', ')})\n${inject(0, reply.bytes)}\nnet_poll()\nb = tx_buf()\n${payload.map((v, i) => `store8(b + ${42 + i}, ${v})`).join('\n')}\nudp_send(${hexs(dstIp)}, ${sport}, ${dport}, b, ${m})\n`;
      const uw = udpFrame({ srcMac: sm, dstMac, src, dst: dstIp >>> 0, id: 1, sport, dport, data: payload }).bytes;
      expect(viaIss(udpApp).tx(0, uw.length), `udp ${k}`).toEqual(uw);
      expect(viaInterpreter(udpApp).tx(0, uw.length), `udp (interpreter) ${k}`).toEqual(uw);
    }
  }, 120000);
});
