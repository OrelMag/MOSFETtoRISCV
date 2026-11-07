// Reach the far host (l_host, act 12): RV32 assembly on chapter 50's computer that pings a machine on another network, with no stack underneath it. The far end of the cable is a
// JavaScript model of a router and the host behind it: it answers ARP for the gateway, checks every field of the echo request, names the first rule broken, and sends the
// reply back through the gateway. Other traffic arrives too, and each scenario's gateway has another MAC, so nothing can be assumed. Graded on the program's size and the clocks
// to the answer. Frames for it are built by comm/netframes.ts; the checks read the bytes by fixed offsets. No DOM.

import { BusModel } from '../bus/model';
import { crc32, fcsBytes } from '../comm/crc';
import { PREAMBLE, SFD } from '../comm/ethframe';
import { arpFrame, icmpEchoFrame, ip4, ipText, macText, onesSum } from '../comm/netframes';
import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { bursts, bytesOf, MAC_BIT, MAC_GAP } from './ethcheck';
import { clocksOf, DRIVER_INIT, DRV, type NicRun } from './nicbench';
import { groupNum } from '../sim/numfmt';

export const HOST = { ip: ip4(10, 0, 1, 2), gw: ip4(10, 0, 1, 1), far: ip4(10, 0, 2, 2), mac: [...DRV.mac] } as const;
const RAM_K = 13, IMEM_K = 9, CONSOLE = 0x80000000;
const hex = (v: number, d = 2) => `0x${(v >>> 0).toString(16).padStart(d, '0')}`;
const be16 = (b: number[], i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: number[], i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const same = (a: number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface HostScenario { name: string; gwMac: number[]; noise: 'none' | 'before-arp' | 'before-reply' }
export const HOST_SCENARIOS: HostScenario[] = [
  { name: 'a quiet network', gwMac: [2, 0, 0, 0, 1, 1], noise: 'none' },
  { name: 'another gateway card, and ARP traffic for other machines before the answer', gwMac: [2, 0, 0, 0xbe, 0xef, 7], noise: 'before-arp' },
  { name: 'echo replies that are not yours arrive before the one that is', gwMac: [2, 0, 0, 0x33, 0x44, 0x55], noise: 'before-reply' },
];

export const HOST_STARTER = `${DRIVER_INIT}
# You are 10.0.1.2, 02:00:00:00:00:0a, on 10.0.1.0/24, and your gateway is 10.0.1.1. Ping 10.0.2.2:
# 1. Ask who has the gateway's address (ARP, a broadcast) and learn its MAC from the answer.
# 2. Send an ICMP echo request to 10.0.2.2, addressed to the gateway's MAC, with both checksums right.
# 3. When the reply to it arrives (not any other frame), store 'K' to the console at 0x80000000.
serve:  j    serve
`;

export const HOST_REF = `${DRIVER_INIT}
        addi s6, s2, 64         # end of the receive ring
        # ---- ARP: who has 10.0.1.1? In transmit buffer 0, a word at a time (little-endian words of bytes in order)
        lw   a0, 0(s3)
        li   t0, 0xffffffff
        sw   t0, 0(a0)          # destination: everyone
        li   t0, 0x0002ffff
        sw   t0, 4(a0)
        li   t0, 0x0a000000
        sw   t0, 8(a0)          # source: 02:00:00:00:00:0a
        li   t0, 0x01000608
        sw   t0, 12(a0)         # EtherType 0x0806; hardware type 1
        li   t0, 0x04060008
        sw   t0, 16(a0)         # protocol 0x0800, lengths 6 and 4
        li   t0, 0x00020100
        sw   t0, 20(a0)         # operation 1; sender MAC
        li   t0, 0x0a000000
        sw   t0, 24(a0)
        li   t0, 0x0201000a
        sw   t0, 28(a0)         # sender IP 10.0.1.2
        sw   zero, 32(a0)       # target MAC unknown
        li   t0, 0x000a0000
        sw   t0, 36(a0)         # target IP 10.0.1.1
        li   t0, 0x00000101
        sw   t0, 40(a0)
        li   t1, 42
        jal  ra, send
        # ---- wait for the gateway's answer: ARP, operation 2, from 10.0.1.1, to us
arp:    jal  ra, next
        lbu  t0, 12(a0)
        li   t1, 8
        bne  t0, t1, arpno
        lbu  t0, 13(a0)
        li   t1, 6
        bne  t0, t1, arpno
        lbu  t0, 21(a0)
        li   t1, 2
        bne  t0, t1, arpno
        lw   t0, 28(a0)
        li   t1, 0x0101000a
        bne  t0, t1, arpno
        # ---- the echo request in transmit buffer 1: the destination is the gateway's MAC
        lw   a1, 8(s3)
        addi t2, a0, 22
        li   t3, 0
mac:    add  t4, t2, t3
        lbu  t5, 0(t4)
        add  t4, a1, t3
        sb   t5, 0(t4)
        addi t3, t3, 1
        li   t4, 6
        blt  t3, t4, mac
        jal  ra, back
        j    build
arpno:  jal  ra, back
        j    arp
build:  mv   a0, a1
        # the IP header starts at byte 14, so whole words hold the end of one field and the start of the next
        li   t0, 0x00000002
        sh   t0, 6(a0)          # source MAC: 02:00
        sw   zero, 8(a0)        # 00:00, and 00:00 of the next two
        li   t0, 0x0a00
        sh   t0, 10(a0)         # :00:0a
        li   t0, 0x00450008
        sw   t0, 12(a0)         # EtherType 0x0800; 0x45, type of service 0
        li   t0, 0x01002400
        sw   t0, 16(a0)         # total length 36; identification 1
        li   t0, 0x01400040
        sw   t0, 20(a0)         # don't fragment; TTL 64, protocol 1 (ICMP)
        li   t0, 0x000a0000
        sw   t0, 24(a0)         # checksum 0 for now; from 10.0.
        li   t0, 0x000a0201
        sw   t0, 28(a0)         # 1.2; to 10.0.
        li   t0, 0x00080202
        sw   t0, 32(a0)         # 2.2; ICMP type 8, code 0
        li   t0, 0x34120000
        sw   t0, 36(a0)         # checksum 0 for now; identifier 0x1234
        li   t0, 0x62610100
        sw   t0, 40(a0)         # sequence 1; the data, "abcdabcd"
        li   t0, 0x64636261
        sw   t0, 44(a0)
        li   t0, 0x00006463
        sw   t0, 48(a0)
        addi a2, a0, 14
        li   a3, 10
        jal  ra, sum
        sh   a4, 24(a0)         # IP header checksum
        addi a2, a0, 34
        li   a3, 8
        jal  ra, sum
        sh   a4, 36(a0)         # ICMP checksum
        li   t1, 50
        addi s3, s3, 8
        jal  ra, send
        # ---- wait for the reply: IPv4, ICMP, type 0, from 10.0.2.2, our identifier and sequence
wait:   jal  ra, next
        lbu  t0, 12(a0)
        li   t1, 8
        bne  t0, t1, no
        lbu  t0, 13(a0)
        bne  t0, zero, no
        lbu  t0, 23(a0)
        li   t1, 1
        bne  t0, t1, no
        lhu  t0, 26(a0)
        li   t1, 0x000a
        bne  t0, t1, no
        lhu  t0, 28(a0)
        li   t1, 0x0202
        bne  t0, t1, no
        lbu  t0, 34(a0)
        bne  t0, zero, no
        lhu  t0, 38(a0)
        li   t1, 0x3412
        bne  t0, t1, no
        lhu  t0, 40(a0)
        li   t1, 0x0100
        bne  t0, t1, no
        li   t0, 75             # 'K'
        li   t1, 0x80000000
        sw   t0, 0(t1)
done:   j    done
no:     jal  ra, back
        j    wait
        # ---- hand the frame in the buffer at a0's descriptor over: t1 = its length
send:   li   t0, 0x80000000
        or   t0, t0, t1
        sw   t0, 4(s3)
        li   t0, 1
        sw   t0, 28(s1)
        ret
        # ---- the next frame: a0 = its buffer
next:   lw   t0, 4(s2)
        bltz t0, next
        lw   a0, 0(s2)
        ret
        # ---- give the buffer back, and on to the next descriptor
back:   li   t0, 0x80000000
        sw   t0, 4(s2)
        addi s2, s2, 8
        bne  s2, s6, b1
        li   s2, 0x1800
b1:     ret
        # ---- a4 = the complement of the ones' complement sum of a3 halfwords at a2: the bytes may be read in either order, if they are stored the same way
sum:    li   a4, 0
s0:     lhu  t0, 0(a2)
        add  a4, a4, t0
        addi a2, a2, 2
        addi a3, a3, -1
        bne  a3, zero, s0
        srli t0, a4, 16
        slli a4, a4, 16
        srli a4, a4, 16
        add  a4, a4, t0
        srli t0, a4, 16
        add  a4, a4, t0
        not  a4, a4
        slli a4, a4, 16
        srli a4, a4, 16
        ret
`;

const wireOf = (body: number[]): number[] => {
  const pad = body.length < 60 ? [...body, ...new Array<number>(60 - body.length).fill(0)] : body;
  return [...PREAMBLE, SFD, ...pad, ...fcsBytes(crc32(pad))];
};

interface Outcome { ok: boolean; why?: string; clocks: number }

/** Check the echo request a frame claims to be: the first rule it breaks, or null. */
function echoProblem(f: number[], gwMac: readonly number[]): string | null {
  const bad = (w: string, v: number | string, want: string, rule: string) => `the echo request: ${w} is ${typeof v === 'number' ? hex(v) : v}, expected ${want}: ${rule}`;
  const dm = f.slice(0, 6);
  if (!same(dm, gwMac)) return bad('the destination MAC', macText(dm), macText(gwMac), `10.0.2.2 is on another network, so the frame goes to the gateway; the IP address names the far host, the MAC only the next hop. Use the MAC in the gateway's ARP answer`);
  if (!same(f.slice(6, 12), HOST.mac)) return bad('the source MAC', macText(f.slice(6, 12)), macText(HOST.mac), 'this NIC\'s own address');
  if (f[14] !== 0x45) return bad('byte 14', f[14], '0x45', 'version 4, a header of 5 words');
  const total = be16(f, 16);
  if (14 + total > f.length) return `the echo request: the IP total length says ${total} bytes, but the frame holds ${f.length - 14} after its Ethernet header`;
  if (total < 28) return `the echo request: the IP total length is ${total}, less than the 20 of the header and the 8 of ICMP`;
  if (onesSum(f.slice(14, 34)) !== 0xffff) return `the echo request: the IP header checksum is wrong: its 20 bytes sum to ${hex(onesSum(f.slice(14, 34)), 4)}, not 0xffff. The router drops it, and says nothing`;
  if (f[22] < 2) return bad('the TTL', f[22], 'at least 2', 'the router lowers it by one and a packet that reaches 0 goes no further, so a TTL of 1 dies at the first hop');
  if (f[23] !== 1) return bad('the IP protocol', f[23], '1', '1 is ICMP');
  if (be32(f, 26) !== HOST.ip) return `the echo request: the source address is ${ipText(be32(f, 26))}, expected ${ipText(HOST.ip)}: the reply goes back to it`;
  if (be32(f, 30) !== HOST.far) return `the echo request: the destination address is ${ipText(be32(f, 30))}, expected ${ipText(HOST.far)}: the IP address names the far host, end to end`;
  if (f[34] !== 8 || f[35] !== 0) return bad('the ICMP type and code', `${f[34]}, ${f[35]}`, '8, 0', 'an echo request');
  const icmp = f.slice(34, 14 + total);
  if (onesSum(icmp) !== 0xffff) return `the echo request: the ICMP checksum is wrong: the ${icmp.length} bytes from its type on sum to ${hex(onesSum(icmp), 4)}, not 0xffff. The far host drops it`;
  return null;
}

function runScenario(words: number[], s: HostScenario): Outcome {
  const wire: { rxd: number; crs: number }[] = [];
  const bus = new BusModel(RAM_K, [], 4096, { nic: { line: (e) => wire[e] ?? { rxd: 0, crs: 0 } } });
  const dev = bus.nic!;
  dev.trace = [];
  const iss = new ISS(words, { system: true, imemWords: 2 ** IMEM_K, bus });
  let clk = 0, steps = 0, scanned = 1, sentFrames = 0, arpDone = -1, replyEnd = -1, kAt = -1, kicks = 0;
  let why: string | undefined;
  const wr0 = bus.write.bind(bus);
  bus.write = (a, v, st) => { if ((a >>> 28) === 7 && ((a >>> 2) & 7) === 7) kicks++; return wr0(a, v, st); };
  /** A frame on the wire, after the gap. */
  const send = (body: number[]) => {
    const at = Math.max(wire.length + MAC_GAP, clk + 400);
    while (wire.length < at) wire.push({ rxd: 0, crs: 0 });
    for (const byte of wireOf(body)) for (let b = 0; b < 8; b++) for (let c = 0; c < MAC_BIT; c++) wire.push({ rxd: (byte >> b) & 1, crs: 1 });
    return wire.length;
  };
  const other = [2, 0, 0, 0, 9, 9];
  const reply = (req: number[], ident: number, seq: number, src = HOST.far) => {
    const total = be16(req, 16), data = req.slice(42, 14 + total);
    return icmpEchoFrame({ srcMac: s.gwMac, dstMac: HOST.mac, src, dst: HOST.ip, id: 77, ttl: 62, reply: true, ident, seq, data }).bytes;
  };
  const readFrames = (): number[][] => {
    const t = dev.trace!;
    const bs = bursts(t.map((x) => x.txd), t.map((x) => x.txen));
    return bs.map((b) => { const g = bytesOf(b.bits).slice(PREAMBLE.length + 1); return g.slice(0, Math.max(0, g.length - 4)); });
  };
  while (steps < 3_000_000 && !why) {
    dev.advanceTo(clk);
    const t = dev.trace!;
    let ended = false;
    for (; scanned < t.length; scanned++) if (t[scanned - 1].txen && !t[scanned].txen) ended = true;
    if (ended) {
      const fs = readFrames();
      for (; sentFrames < fs.length && !why; sentFrames++) {
        const f = fs[sentFrames], type = be16(f, 12);
        if (type === 0x0806) {
          const op = be16(f, 20), tpa = be32(f, 38);
          if (arpDone >= 0) continue; // asking again is allowed
          if (op !== 1) { why = `an ARP packet of operation ${op}: asking is operation 1`; break; }
          if (!same(f.slice(0, 6), [255, 255, 255, 255, 255, 255])) { why = `the ARP request went to ${macText(f.slice(0, 6))}: you do not know who has the address yet, so it goes to everyone, ff:ff:ff:ff:ff:ff`; break; }
          if (tpa === HOST.far) { why = `the ARP request asks for ${ipText(HOST.far)}: ARP works only on your own network, and that host is on another. Ask for the gateway, ${ipText(HOST.gw)}`; break; }
          if (tpa !== HOST.gw) { why = `the ARP request asks for ${ipText(tpa)}: ask for the gateway, ${ipText(HOST.gw)}`; break; }
          if (be32(f, 28) !== HOST.ip || !same(f.slice(22, 28), HOST.mac)) { why = `the ARP request gives the sender as ${macText(f.slice(22, 28))}, ${ipText(be32(f, 28))}: the answer goes to those, ${macText(HOST.mac)}, ${ipText(HOST.ip)}`; break; }
          if (s.noise === 'before-arp') {
            send(arpFrame({ op: 1, sha: other, spa: ip4(10, 0, 1, 77), tha: [0, 0, 0, 0, 0, 0], tpa: ip4(10, 0, 1, 99) }).bytes);
            send(arpFrame({ op: 2, sha: other, spa: ip4(10, 0, 1, 78), tha: HOST.mac as unknown as number[], tpa: HOST.ip }).bytes);
          }
          arpDone = send(arpFrame({ op: 2, sha: s.gwMac, spa: HOST.gw, tha: HOST.mac as unknown as number[], tpa: HOST.ip }).bytes);
        } else if (type === 0x0800) {
          if (arpDone < 0) { why = 'an IP frame before any ARP request: nothing yet says what the gateway\'s MAC is; it is another card in each scenario'; break; }
          const p = echoProblem(f, s.gwMac);
          if (p) { why = p; break; }
          const ident = be16(f, 38), seq = be16(f, 40);
          if (replyEnd >= 0) continue;
          if (s.noise === 'before-reply') {
            send(reply(f, (ident ^ 0x5a5a) & 0xffff, seq));
            send(reply(f, ident, (seq + 7) & 0xffff));
            send(reply(f, ident, seq, ip4(10, 0, 2, 3)));
            send(arpFrame({ op: 1, sha: other, spa: ip4(10, 0, 1, 77), tha: [0, 0, 0, 0, 0, 0], tpa: HOST.ip }).bytes);
          }
          replyEnd = send(reply(f, ident, seq));
        } else why = `a frame of EtherType ${hex(type, 4)}: ARP is 0x0806 and IPv4 is 0x0800, high byte first on the wire`;
      }
    }
    if (why) break;
    if (kAt >= 0 && clk > kAt + 200) break;
    if (clk > 400_000) break;
    if (iss.halted) break;
    bus.now = clk;
    iss.mtime = clk;
    const was = iss.console.length, info = iss.step();
    if (iss.console.length > was && kAt < 0) {
      kAt = clk;
      if (iss.console.slice(was) !== 'K') { why = `the console got ${JSON.stringify(iss.console.slice(was))}: the task is one 'K'`; break; }
      if (replyEnd < 0 || clk < replyEnd) { why = `'K' at clock ${clk}, ${replyEnd < 0 ? 'before the far end had replied at all' : `before the true reply had finished arriving at ${replyEnd}`}: check the frame is the reply to your request: IPv4, ICMP type 0, from ${ipText(HOST.far)}, your identifier and sequence`; break; }
    }
    clk += clocksOf(info.text);
    steps++;
  }
  if (why) return { ok: false, why, clocks: 0 };
  if (kAt >= 0) return { ok: true, clocks: kAt };
  if (dev.core.sMiss) return { ok: false, why: 'no \'K\': the NIC found no receive descriptor it owned (STATUS.MISS): hand each buffer back with OWN set, including the ones you ignore', clocks: 0 };
  if (kicks === 0) return { ok: false, why: 'nothing left the NIC: the doorbell (KICK, its register at +28) was rung 0 times', clocks: 0 };
  if (sentFrames === 0) return { ok: false, why: 'nothing left the NIC: word 1 of a transmit descriptor must hold OWN | length, with the buffer\'s address in word 0', clocks: 0 };
  if (arpDone < 0) return { ok: false, why: 'no ARP request came: the gateway\'s MAC must come from asking for it', clocks: 0 };
  if (replyEnd < 0) return { ok: false, why: `the gateway answered ARP, and no echo request followed within ${n0(400_000)} clocks: read the answer's sender MAC, then send`, clocks: 0 };
  return { ok: false, why: `the far host replied at clock ${replyEnd}, and no 'K' came to the console at ${hex(CONSOLE, 8)}: receive it, and check it is the reply to your request`, clocks: 0 };
}
const n0 = (x: number) => groupNum(Math.round(x));

/** Every scenario on a source: the size in words and the mean clocks from reset to the answer. Never throws. */
export function runHostPuzzle(src: string): NicRun {
  const a = assemble(src);
  const size = a.words.length;
  if (a.errors.length) return { ok: false, errors: a.errors, results: [], size, cycles: 0 };
  if (size > 2 ** IMEM_K) return { ok: false, errors: [{ line: 1, message: `${size} words: the instruction memory holds ${2 ** IMEM_K}` }], results: [], size, cycles: 0 };
  const results = HOST_SCENARIOS.map((s) => {
    try {
      const r = runScenario(a.words, s);
      return { name: s.name, ok: r.ok, ...(r.why ? { why: r.why } : {}), steps: r.clocks };
    } catch (e) {
      return { name: s.name, ok: false, why: `the simulation stopped: ${(e as Error).message}`, steps: 0 };
    }
  });
  return { ok: results.every((r) => r.ok), errors: [], results, size, cycles: Math.ceil(results.reduce((x, r) => x + r.steps, 0) / results.length) };
}
