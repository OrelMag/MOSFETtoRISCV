// The model-speed bench: chapter 50's ping against what the gates measured, then TCP between two computers across a router with a queue.

import { describe, expect, it } from 'vitest';
import { ip4 } from '../src/comm/netframes';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { hostApp, pingApp } from '../src/comm/stack/apps';
import { stackProgram } from '../src/comm/stack';
import NET from '../src/comm/stack/netcosts.json';
import { TCP } from '../src/comm/stack/tcp';
import { tcpReceiver, tcpSender } from '../src/comm/stack/tcpapps';
import { Host, LanBench, RouterMiddle, SwitchMiddle } from '../src/net/lanbench';
import { tick } from './yieldtick';

const compile = (app: string) => {
  const b = stackProgram([...DEFAULT_STACK, TCP], app);
  if (b.compiled.error) throw new Error(`${b.compiled.error.message} (${JSON.stringify(b.where(b.compiled.error.line))})`);
  return b;
};

const A = { ip: ip4(10, 0, 1, 2), mac: [2, 0, 0, 0, 1, 2], gw: ip4(10, 0, 1, 1), gwMac: [2, 0, 0, 0, 1, 1] };
const B = { ip: ip4(10, 0, 2, 2), mac: [2, 0, 0, 0, 2, 2], gw: ip4(10, 0, 2, 1), gwMac: [2, 0, 0, 0, 2, 1] };

function tcpBench(bytes: number, o: { queue?: number; slow?: number; delay?: number; lose?: (from: number, f: number[]) => boolean; readEvery?: number } = {}) {
  const a = compile(tcpSender(A, B.ip, bytes)), b = compile(tcpReceiver(B, { readEvery: o.readEvery }));
  const k = Math.max(12, Math.ceil(Math.log2(Math.max(a.compiled.words.length, b.compiled.words.length) + 1)));
  const router = new RouterMiddle({ ports: [{ host: A.mac, mac: A.gwMac }, { host: B.mac, mac: B.gwMac }], queue: o.queue ?? 8, byteClocks: [32, o.slow ?? 32], delay: o.delay ?? 2000, lose: o.lose });
  router.log = [];
  const bench = new LanBench([new Host(a.compiled.words, k), new Host(b.compiled.words, k)], router);
  return { bench, router, a, b };
}

describe('the bench against the gates', () => {
  it("chapter 50's ping: the same console, the round trip within 5 clocks of the gates'", () => {
    const a = stackProgram(DEFAULT_STACK, pingApp(1, 32)), b = stackProgram(DEFAULT_STACK, hostApp());
    const bench = new LanBench([new Host(a.compiled.words, 12), new Host(b.compiled.words, 12)], new SwitchMiddle());
    while (bench.c < 60000 && !bench.hosts[0].iss.console.includes('done')) bench.clock();
    const con = bench.hosts[0].iss.console;
    const rtt = Number(/time=(\d+) cycles/.exec(con)![1]);
    expect(con.replace(/time=\d+/, 'time=N')).toBe(NET.console.a.replace(/time=\d+/, 'time=N'));
    expect(Math.abs(rtt - NET.rtt)).toBeLessThanOrEqual(5);
    expect(Math.abs(bench.c - NET.clocksToFirstReply) / NET.clocksToFirstReply).toBeLessThan(0.02);
  }, 60000);
});

describe('TCP across a router', () => {
  it('a clean transfer: every byte, in order, and what it costs', async () => {
    const t = tcpBench(1000);
    const [ha, hb] = t.bench.hosts;
    while (t.bench.c < 3_000_000 && !hb.iss.console.endsWith('
')) { t.bench.clock(); if (t.bench.c % 200000 === 0) await tick(); }
    expect(hb.iss.console).toBe('received 1000 bytes, all correct\n');
    expect(ha.iss.console).toMatch(/^connected\n/);
  }, 120000);
});
