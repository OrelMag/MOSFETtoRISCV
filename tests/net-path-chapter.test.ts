// Chapter 53's typed numbers, pinned to what they describe; the computed ones come from the code.

import { describe, expect, it } from 'vitest';
import { chPath, VIA_KESTREL, VIA_ORCHARD } from '../src/chapters/ch-comm-path';
import { CLOCK_NS } from '../src/dram/timing';
import { Internet, HOSTS, LINKS, linkBetween, R, ROUTERS, RELATIONS, ASES, neighboursOf } from '../src/net/internet';
import { INIT_WINDOW, propMs, queueMs, serMs, CROSS_BYTES, WIRE_EXTRA, FIBRE_KM_PER_S } from '../src/net/internetdelay';
import { TTL_A, TTL_ROOT, TTL_TLD } from '../src/net/internetdns';
import { hostId, hostIp, traceroute } from '../src/net/internet';
import { parseIp } from '../src/net/ipv4';
import { pcapFile, readPcap } from '../src/comm/pcap';
import { traceCapture } from '../src/widgets/internet';

const text = chPath.steps.map((s) => s.body).join(' ');

describe('chapter 53 typed numbers', () => {
  it('has eight steps', () => { expect(chPath.steps.length).toBe(8); });
  it('the map the prose describes', () => {
    expect(ASES.length).toBe(8);
    expect(ROUTERS.length).toBe(16);
    expect(HOSTS.length).toBeGreaterThan(0);
    expect(RELATIONS.filter((r) => r.kind === 'peer').length).toBe(2);
    expect(Math.max(...ROUTERS.map((_, r) => new Set(neighboursOf(r).map((n) => n.port)).size))).toBe(3);
  });
  it('the detour is 1 590 km, in the prose as computed', () => {
    expect(VIA_KESTREL - VIA_ORCHARD).toBe(1590);
    expect(text).toContain('1 590 km');
  });
  it('the slider\'s size is the IP packet: 1500 bytes is a 1514-byte frame', () => { expect(text).toContain('1514-byte frame'); });
  it('5 µs a kilometre in fibre', () => { expect(1e6 / FIBRE_KM_PER_S).toBe(5); });
  it('the delegations last two days', () => { expect(TTL_ROOT).toBe(2 * 86_400); expect(TTL_TLD).toBe(2 * 86_400); expect(text).toContain('two days'); expect(TTL_A).toBeLessThan(TTL_TLD); });
  it('the backbone is five thousand times the access line', () => {
    expect(LINKS[linkBetween(R.t1, R.t2)].mbps / LINKS[linkBetween(R.f1, R.f2)].mbps).toBe(5000);
    expect(chPath.steps[5].challenge && JSON.stringify(chPath.steps[5].challenge)).toContain('five thousand');
  });
  it('at 95 % a queue is nineteen service times, one at half load', () => {
    const l = LINKS[linkBetween(R.f1, R.f2)], s = serMs(l, CROSS_BYTES - WIRE_EXTRA);
    expect(queueMs(l, 0.95) / s).toBeCloseTo(19, 9);
    expect(queueMs(l, 0.5) / s).toBeCloseTo(1, 9);
    expect(text).toContain('nineteen');
  });
  it('a byte a cycle is about 2 Gb/s', () => { expect(8 / CLOCK_NS).toBeCloseTo(2, 0); });
  it('slow start from ten segments', () => { expect(INIT_WINDOW).toBe(10); });
  it('light dominates: the ocean is the longest link by far', () => {
    expect(propMs(LINKS[linkBetween(R.t1, R.t2)])).toBeGreaterThan(5 * Math.max(...LINKS.filter((l) => l.km < 6400).map(propMs)));
  });
  it('nothing in the chapter claims a real traceroute: the model is named', () => {
    expect(text).toContain('never touches your network');
    expect(new Internet().bgp.rounds).toBeGreaterThan(0);
  });
});

describe('Save capture', () => {
  it('writes every probe and reply, readable back, each header valid, in time order', () => {
    const rows = traceroute(new Internet(), hostId('laptop'), hostIp(hostId('www')));
    const back = readPcap(pcapFile(traceCapture(rows)));
    expect(back.length).toBe(rows.length * 2);
    let last = -1;
    for (const f of back) {
      expect(parseIp(Array.from(f.bytes).slice(14)).checkOk).toBe(true);
      expect(f.us).toBeGreaterThanOrEqual(last);
      last = f.us;
    }
  });
  it('writes its Try boxes as blocks: an inline one draws its border through the lines around it', () => {
    for (const step of chPath.steps) {
      const body = String(step.body);
      expect(body).not.toMatch(/<span class="try">/);
      expect(body).not.toMatch(/<p>\s*<div class="try">/);
    }
  });
});
