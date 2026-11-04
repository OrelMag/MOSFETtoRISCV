// Chapter 50 on the gates: two computers with NICs and a switch, the stack compiled from Python. The ping and the UDP echo run to the end, every frame
// the switch received is compared with comm/netframes.ts's independent construction, the capture is a well-formed pcap, and the costs the chapter quotes
// (src/comm/stack/netcosts.json) are the ones measured now.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOCK_NS } from '../src/comm/mac';
import { arpFrame, dissect, icmpEchoFrame, ip4, udpFrame } from '../src/comm/netframes';
import { pcapFile, readPcap } from '../src/comm/pcap';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { HOSTS, hostApp, pingApp, udpClientApp, udpEchoApp } from '../src/comm/stack/apps';
import { stackProgram } from '../src/comm/stack';
import NET from '../src/comm/stack/netcosts.json';
import { lanComputers } from '../src/lib/lan';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { pack } from '../src/sim/values';
import { measureLan, nandCounts } from '../scripts/netcosts-lib';
import { tick } from './yieldtick';

/** Run until computer A's console contains `until`; returns the consoles and the frames the switch received, with their clocks. */
async function run(appA: string, appB: string, until: string, max = 90000) {
  const A = stackProgram(DEFAULT_STACK, appA), B = stackProgram(DEFAULT_STACK, appB);
  expect(A.compiled.error).toBeNull();
  expect(B.compiled.error).toBeNull();
  const sim = new DualSim(flatten(lanComputers(A.compiled.words, B.compiled.words)));
  sim.preferFast = true;
  sim.reset('zero'); sim.setInput('clk', 0); sim.settle(); sim.prepare(); sim.settle();
  const root = sim.design.root, out = (p: string) => pack(sim.getBits(root.ports[p]));
  const con = { A: '', B: '' };
  const frames: { clock: number; from: 'A' | 'B'; bytes: number[]; err: number }[] = [];
  const cur: (number[] | null)[] = [null, null];
  const first = [0, 0];
  let c = 0;
  for (; c < max && !con.A.includes(until); c++) {
    for (const S of ['A', 'B'] as const) if (out(`consoleValid${S}`) === 1) con[S] += String.fromCharCode(out(`consoleData${S}`));
    for (const p of [0, 1]) {
      if (out(`rxValid${p}`) === 1) {
        if (!cur[p]) { cur[p] = []; first[p] = c; }
        cur[p]!.push(out(`rxData${p}`));
        if (out(`rxLast${p}`) === 1) { frames.push({ clock: first[p], from: p === 0 ? 'A' : 'B', bytes: cur[p]!, err: out(`rxErr${p}`) }); cur[p] = null; }
      }
    }
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    if (c % 4000 === 0) await tick();
  }
  frames.sort((x, y) => x.clock - y.clock);
  return { con, frames, clocks: c };
}

const A = HOSTS.A, B = HOSTS.B;

describe('the ping', () => {
  it('runs to the end', async () => {
    const r = await run(pingApp(1, 32), hostApp(), 'done');
    expect(r.con.A).toMatch(/^arp: 10\.0\.0\.2 is at 02:00:00:00:00:02\n64 bytes from 10\.0\.0\.2: seq=1 time=\d+ cycles\ndone/);
    expect(r.con.B).toBe('host up\n');
    const data = Array.from({ length: 32 }, (_, i) => 16 + i);
    const want = [
      arpFrame({ op: 1, sha: A.mac, spa: A.ip, tha: [0, 0, 0, 0, 0, 0], tpa: B.ip }).bytes,
      arpFrame({ op: 2, sha: B.mac, spa: B.ip, tha: A.mac, tpa: A.ip }).bytes,
      icmpEchoFrame({ srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: 1, ident: 0x1234, seq: 1, data }).bytes,
      icmpEchoFrame({ srcMac: B.mac, dstMac: A.mac, src: B.ip, dst: A.ip, id: 1, ident: 0x1234, seq: 1, data, reply: true }).bytes,
    ];
    // the switch received four frames; each is the frame, padded to 60 bytes by the MAC when shorter
    expect(r.frames.map((f) => f.err)).toEqual([0, 0, 0, 0]);
    expect(r.frames.map((f) => f.from)).toEqual(['A', 'B', 'A', 'B']);
    r.frames.forEach((f, i) => {
      expect(f.bytes.slice(0, want[i].length), `frame ${i + 1}: ${dissect(f.bytes)}`).toEqual(want[i]);
      expect(f.bytes.length).toBe(Math.max(60, want[i].length));
    });
  }, 300000);
});

describe('costs and capture', () => {
  it('the capture is a pcap that reads back; tshark, when installed, reads it too', async () => {
    const r = await run(pingApp(1, 32), hostApp(), 'done');
    const file = pcapFile(r.frames.map((f) => ({ us: f.clock * CLOCK_NS / 1000, bytes: f.bytes })));
    const back = readPcap(file);
    expect(back.map((f) => Array.from(f.bytes))).toEqual(r.frames.map((f) => f.bytes));
    const tshark = ['C:\\Program Files\\Wireshark\\tshark.exe', '/usr/bin/tshark'].find((p) => existsSync(p));
    if (tshark) {
      const dir = mkdtempSync(join(tmpdir(), 'ping-'));
      writeFileSync(join(dir, 'ping.pcap'), file);
      const txt = execFileSync(tshark, ['-r', join(dir, 'ping.pcap'), '-V'], { encoding: 'utf8' });
      expect(txt).toContain('Echo (ping) request');
      expect(txt).not.toMatch(/Bad checksum|incorrect/i);
    }
  }, 300000);
  it('the figures of the chapter are the ones measured now', async () => {
    const m = await measureLan(1, tick);
    expect(m.windows.map((w) => ({ c: w.computer, e: w.entry, t: w.total, l: w.layers }))).toEqual((NET.windows as typeof m.windows).map((w) => ({ c: w.computer, e: w.entry, t: w.total, l: w.layers })));
    expect(m.rtt).toBe(NET.rtt);
    expect(m.wire).toEqual(NET.wire);
    expect(m.clocksToFirstReply).toBe(NET.clocksToFirstReply);
    expect(m.words).toEqual(NET.words);
    expect(m.dma).toEqual(NET.dma);
    expect(nandCounts()).toEqual(NET.nands);
  }, 300000);
});

describe('UDP echo', () => {
  it('three datagrams out and back, the frames as the independent builder makes them', async () => {
    const r = await run(udpClientApp(3, 16), udpEchoApp(), 'done', 120000);
    expect(r.con.A).toMatch(/echo of seq 1 bytes=16\necho of seq 2 bytes=16\necho of seq 3 bytes=16\ndone/);
    expect(r.con.B).toMatch(/udp echo on port 7\nechoed 1\nechoed 2\nechoed 3\n/);
    const udp = r.frames.filter((f) => f.bytes[12] === 8 && f.bytes[23] === 17);
    expect(udp.length).toBe(6);
    const d = (seq: number) => Array.from({ length: 16 }, () => seq);
    // A's datagrams carry ip ids 1, 2, 3 (its ARP request took none); B's echoes the same
    for (let k = 0; k < 3; k++) {
      const out = udpFrame({ srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: k + 1, sport: 5000, dport: 7, data: d(k + 1) }).bytes;
      const back = udpFrame({ srcMac: B.mac, dstMac: A.mac, src: B.ip, dst: A.ip, id: k + 1, sport: 7, dport: 5000, data: d(k + 1) }).bytes;
      expect(udp[2 * k].bytes.slice(0, out.length)).toEqual(out);
      expect(udp[2 * k + 1].bytes.slice(0, back.length)).toEqual(back);
    }
    void ip4;
  }, 400000);
});
