// The tshark oracle's comparison, without tshark: rows written out as tshark prints them, and what must be reported. The real run is .github/workflows/tshark.yml.

import { describe, expect, it } from 'vitest';
import { icmpEchoFrame, udpFrame } from '../src/comm/netframes';
import { HOSTS } from '../src/comm/stack/apps';
import { claimOf, compareCapture, compareRow, FIELDS, parseRows, tsharkArgs, type Row } from '../scripts/tshark-lib';

const A = HOSTS.A, B = HOSTS.B, hdr = { srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: 9 };
const ping = icmpEchoFrame({ ...hdr, ident: 0x1234, seq: 1, data: [1, 2, 3, 4] }).bytes;
const hex = (v: unknown) => `0x${Number(v).toString(16)}`;

/** A frame as a healthy tshark reads it. */
function rowOf(b: number[], us = 0): Row {
  const c = claimOf(b, us), r: Row = { 'frame.protocols': `${c.chain}:data` };
  for (const [k, v] of Object.entries(c.fields)) r[k as keyof Row] = k === 'frame.time_epoch' ? (Number(v) / 1e6).toFixed(9) : k === 'eth.type' || k.endsWith('checksum') ? hex(v) : String(v);
  for (const g of c.good) r[g] = '1';
  return r;
}
const issues = (r: Row, b = ping) => compareRow(claimOf(b, 0), r);

describe('reading tshark', () => {
  it('rows parse by the field list, empty columns absent', () => {
    const cols = FIELDS.map((f) => (f === 'ip.ttl' ? '64' : f === 'frame.number' ? '1' : ''));
    const [r] = parseRows(`${cols.join('\t')}\r\n`);
    expect(r).toEqual({ 'frame.number': '1', 'ip.ttl': '64' });
    expect(parseRows('')).toEqual([]);
  });
  it('asks for every checksum and one column per field', () => {
    const a = tsharkArgs('x.pcap');
    for (const p of ['ip.check_checksum:TRUE', 'udp.check_checksum:TRUE', 'tcp.check_checksum:TRUE']) expect(a).toContain(p);
    expect(a.filter((x) => x === '-e').length).toBe(FIELDS.length);
  });
});

describe('what the bytes claim', () => {
  it('ICMP echo, by hand', () => {
    const c = claimOf(ping, 5);
    expect(c.chain).toBe('eth:ethertype:ip:icmp');
    expect(c.fields).toMatchObject({ 'eth.type': 0x800, 'ip.src': '10.0.0.1', 'ip.dst': '10.0.0.2', 'ip.proto': 1, 'icmp.type': 8, 'icmp.ident': 0x1234, 'icmp.seq': 1, 'data.data': '01020304', 'frame.time_epoch': 5 });
  });
  it('a type that is neither claims only Ethernet', () => {
    const b = [...ping]; b[12] = 0x88; b[13] = 0xb5;
    expect(claimOf(b, 0).chain).toBe('eth:ethertype');
    expect(claimOf(b, 0).good).toEqual([]);
  });
});

describe('the comparison', () => {
  it('a healthy reading passes, however the numbers are printed', () => {
    expect(issues(rowOf(ping))).toEqual([]);
    const u = udpFrame({ ...hdr, sport: 5000, dport: 7, data: [9] }).bytes;
    expect(issues(rowOf(u), u)).toEqual([]);
  });
  it('a different field, a missing one, the wrong protocols', () => {
    expect(issues({ ...rowOf(ping), 'ip.src': '10.0.0.9' })[0]).toMatch(/ip\.src/);
    const { 'icmp.seq': _gone, ...rest } = rowOf(ping);
    expect(issues(rest)[0]).toMatch(/icmp\.seq: tshark has nothing/);
    expect(issues({ ...rowOf(ping), 'frame.protocols': 'eth:ethertype:ipv6' }).join()).toMatch(/protocols/);
  });
  it('malformed and a warning are problems; a note is not', () => {
    expect(issues({ ...rowOf(ping), 'frame.protocols': 'eth:ethertype:ip:icmp:_ws.malformed' }).join()).toMatch(/malformed/);
    expect(issues({ ...rowOf(ping), '_ws.malformed': 'Malformed Packet' }).join()).toMatch(/malformed/);
    expect(issues({ ...rowOf(ping), '_ws.expert.severity': '6291456', '_ws.expert.message': 'Bogus' }).join()).toMatch(/expert.*Bogus/);
    expect(issues({ ...rowOf(ping), '_ws.expert.severity': '4194304|8388608', '_ws.expert.message': 'fine|broken' }).join()).toMatch(/broken/);
    expect(issues({ ...rowOf(ping), '_ws.expert.severity': '4194304', '_ws.expert.message': 'a note' })).toEqual([]);
  });
  it('a checksum must be verified good, not merely not bad', () => {
    expect(issues({ ...rowOf(ping), 'ip.checksum.status': '0' }).join()).toMatch(/ip\.checksum\.status/);
    expect(issues({ ...rowOf(ping), 'icmp.checksum.status': '2' }).join()).toMatch(/not good/);
    const { 'ip.checksum.status': _no, ...rest } = rowOf(ping);
    expect(issues(rest).join()).toMatch(/not verified/);
  });
  it('an ICMP error\'s inner header does not stand for the outer, but its bad checksum still counts', () => {
    const r = { ...rowOf(ping), 'ip.src': '10.0.0.1|10.0.0.9' };
    expect(issues(r)).toEqual([]);
    expect(issues({ ...rowOf(ping), 'ip.checksum.status': '1|0' }).join()).toMatch(/a bad checksum/);
  });
  it('the time to the microsecond', () => {
    expect(issues({ ...rowOf(ping), 'frame.time_epoch': '0.000001000' }).join()).toMatch(/time_epoch/);
  });
  it('a capture with a frame missing', () => {
    expect(compareCapture([{ us: 0, bytes: ping }, { us: 1, bytes: ping }], [rowOf(ping)])[0]).toMatch(/read 1 frames of 2/);
  });
});
