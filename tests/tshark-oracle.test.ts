// The tshark oracle's comparison, without tshark: rows written out as tshark prints them, and what must be reported. The real run is .github/workflows/tshark.yml.

import { describe, expect, it } from 'vitest';
import { icmpEchoFrame, tcpFrame, udpFrame } from '../src/comm/netframes';
import { HOSTS } from '../src/comm/stack/apps';
import { checksum } from '../src/net/ipv4';
import { FP_FRAMES } from '../src/widgets/router';
import { crc5Token, dataBytes, handshakeBytes, PID, sofBytes, tokenBytes } from '../src/comm/usb';
import { claimOf, compareCapture, compareRow, FIELDS, parseRows, TCP_LOSS_WARNINGS, tsharkArgs, USB_FIELDS, usbClaimOf, type Row } from '../scripts/tshark-lib';

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
    const a = tsharkArgs();
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
  it('a frame cut short claims what it holds, and does not throw', () => {
    expect(claimOf(ping.slice(0, 40), 0).fields['data.data']).toBeUndefined();
    expect(claimOf(ping.slice(0, 44), 0).fields['data.data']).toBe('0102');
  });
  it('a type that is neither claims only Ethernet', () => {
    const b = [...ping]; b[12] = 0x88; b[13] = 0xb5;
    expect(claimOf(b, 0).chain).toBe('eth:ethertype');
    expect(claimOf(b, 0).good).toEqual([]);
  });
});

describe('a TCP segment', () => {
  const seg = (data: number[]) => tcpFrame({ ...hdr, sport: 40000, dport: 5000, seq: 1, ack: 1, flags: 16, wnd: 512, data }).bytes;
  it('its bytes claim the payload, and a segment with none claims none', () => {
    expect(claimOf(seg([0, 1, 2, 3]), 0).fields['data.data']).toBe('00010203');
    expect(claimOf(seg([]), 0).fields['data.data']).toBeUndefined();
  });
  it('a padded ACK claims no pad: the IP total length says where it ends', () => {
    const b = seg([]);
    expect(claimOf([...b, ...new Array<number>(60 - b.length).fill(0)], 0).fields['data.data']).toBeUndefined();
  });
  it('a dissector that takes the payload, or another byte in it, is a difference', () => {
    const b = seg([0, 1, 2, 3]), r = rowOf(b);
    expect(issues(r, b)).toEqual([]);
    const { 'data.data': _gone, ...taken } = r;
    expect(issues({ ...taken, 'frame.protocols': 'eth:ethertype:ip:tcp:gsm_ipa' }, b).join()).toMatch(/data\.data: tshark has nothing/);
    expect(issues({ ...r, 'data.data': '00010203ff' }, b).join()).toMatch(/data\.data/);
  });
  it('nothing that could claim a TCP payload is turned off to make this pass: a learner opens the same capture with everything on', () => {
    expect(tsharkArgs()).not.toContain('gsm_ipa');
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
  it('a retransmission\'s bytes count under tshark\'s other name for them, and only if they are the same bytes', () => {
    const seg = tcpFrame({ ...hdr, sport: 5000, dport: 12000, seq: 1, ack: 1, flags: 0x18, wnd: 512, data: [1, 2, 3, 4] }).bytes, r = rowOf(seg);
    const hex = r['data.data']!;
    delete r['data.data'];
    expect(compareRow(claimOf(seg, 0), { ...r, 'tcp.segment_data': hex })).toEqual([]);
    expect(compareRow(claimOf(seg, 0), { ...r, 'tcp.segment_data': '09090909' }).join()).toMatch(/data\.data/);
    expect(compareRow(claimOf(seg, 0), r).join()).toMatch(/data\.data/);
  });
  it('a lossy transfer may be told so, and only that, only where the case allows it', () => {
    const r = { ...rowOf(ping), '_ws.expert.severity': 'Warn', '_ws.expert.message': 'TCP window specified by the receiver is now completely full' };
    expect(issues(r).join()).toMatch(/expert/);
    expect(compareRow(claimOf(ping, 0), r, TCP_LOSS_WARNINGS)).toEqual([]);
    const bad = { ...r, '_ws.expert.message': 'Bogus IP length' };
    expect(compareRow(claimOf(ping, 0), bad, TCP_LOSS_WARNINGS).join()).toMatch(/expert/);
  });
  it('DNS on port 53 claims its header and its place in the chain, and every record in the column', () => {
    const q = udpFrame({ ...hdr, sport: 5000, dport: 53, data: [0x4a, 0x10, 0x81, 0, 0, 1, 0, 2, 0, 0, 0, 0] }).bytes, c = claimOf(q, 0);
    expect(c.chain).toBe('eth:ethertype:ip:udp:dns');
    expect(c.fields).toMatchObject({ 'dns.id': 0x4a10, 'dns.flags.response': 1, 'dns.count.queries': 1, 'dns.count.answers': 2 });
    expect(compareRow(c, { ...rowOf(q), 'frame.protocols': 'eth:ethertype:ip:udp', 'dns.flags.response': 'True' }).join()).toMatch(/protocols/);
    expect(compareRow(c, { ...rowOf(q), 'frame.protocols': 'eth:ethertype:ip:udp:dns', 'dns.flags.response': 'True' })).toEqual([]);
    const two = { ...c, fields: { ...c.fields, 'dns.a': '10.0.0.1|10.0.0.2' } };
    expect(compareRow(two, { ...rowOf(q), 'frame.protocols': 'eth:ethertype:ip:udp:dns', 'dns.a': '10.0.0.1|10.0.0.2' })).toEqual([]);
    expect(compareRow(two, { ...rowOf(q), 'frame.protocols': 'eth:ethertype:ip:udp:dns', 'dns.a': '10.0.0.1|10.0.0.3' }).join()).toMatch(/dns\.a/);
  });
});

describe('chapter 51\'s frames', () => {
  it('hold a real UDP header: tshark calls a 4-byte payload marked UDP malformed', () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const f = FP_FRAMES[n].frame(), t = 14 + (f[14] & 15) * 4, ipLen = (f[16] << 8) | f[17];
      expect((f[t + 4] << 8) | f[t + 5]).toBe(ipLen - (t - 14));
      expect(checksum(f.slice(14, t))).toBe(0);
    }
  });
});

describe('USB captures', () => {
  const tok = tokenBytes(PID.SETUP, 5, 0), dat = dataBytes(PID.DATA0, [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00]);
  /** A packet as a healthy tshark reads it. */
  const row = (b: number[], us = 0): Row => {
    const c = usbClaimOf(b, us), r: Row = { 'frame.protocols': 'usbll' };
    for (const [k, v] of Object.entries(c.fields)) r[k] = k === 'frame.time_epoch' ? (Number(v) / 1e6).toFixed(9) : k === 'usbll.data' ? String(v) : k.startsWith('usbll.') ? hex(v) : String(v);
    for (const g of c.good) r[g] = '1';
    return r;
  };
  it('the fields of a token and of a data packet, by the spec\'s layout', () => {
    expect(usbClaimOf(tok, 7).fields).toMatchObject({ 'frame.len': 3, 'usbll.pid': 0x2d, 'usbll.device_addr': 5, 'usbll.endp': 0, 'usbll.crc5': crc5Token(5, 0) });
    expect(usbClaimOf(dat, 0).fields).toMatchObject({ 'usbll.pid': 0xc3, 'usbll.data': '8006000100004000', 'usbll.crc16': 0x94dd });
    expect(usbClaimOf(handshakeBytes(PID.ACK), 0).fields).toEqual({ 'frame.len': 1, 'frame.time_epoch': 0, 'usbll.pid': 0xd2 });
  });
  it('a healthy row agrees; a bad CRC status, a wrong field and an expert warning are reported', () => {
    for (const b of [tok, dat, handshakeBytes(PID.NAK), sofBytes(3)]) expect(compareRow(usbClaimOf(b, 0), row(b))).toEqual([]);
    expect(compareRow(usbClaimOf(tok, 0), { ...row(tok), 'usbll.crc5.status': '0' }).join()).toMatch(/usbll\.crc5\.status/);
    expect(compareRow(usbClaimOf(dat, 0), { ...row(dat), 'usbll.crc16.status': 'bad' }).join()).toMatch(/usbll\.crc16\.status/);
    expect(compareRow(usbClaimOf(tok, 0), { ...row(tok), 'usbll.device_addr': '0x6' }).join()).toMatch(/usbll\.device_addr/);
    expect(compareRow(usbClaimOf(tok, 0), { ...row(tok), '_ws.expert.severity': 'Warning', '_ws.expert.message': 'Invalid PID Sequence' }).join()).toMatch(/expert/);
  });
  it('the USB field list is its own: asking for it changes nothing in the Ethernet command line', () => {
    expect(tsharkArgs().join(' ')).not.toContain('usbll');
    const u = tsharkArgs(USB_FIELDS);
    expect(u.filter((x) => x === '-e')).toHaveLength(USB_FIELDS.length);
    expect(u).toContain('usbll.crc16.status');
    expect(parseRows(`${USB_FIELDS.map((f) => (f === 'usbll.pid' ? '0x2d' : '')).join('\t')}\n`, USB_FIELDS)).toEqual([{ 'usbll.pid': '0x2d' }]);
  });
});
