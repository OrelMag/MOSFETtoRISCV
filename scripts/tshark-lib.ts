// What a capture claims, frame by frame, and how to hold tshark's reading to it (scripts/tshark-oracle.ts; tests/tshark-oracle.test.ts). The claims are
// read off the bytes by fixed offsets, written apart from comm/netframes.ts's dissector. A row is tshark's -T fields output for FIELDS.

export const FIELDS = [
  'frame.number', 'frame.len', 'frame.time_epoch', 'frame.encap_type', 'frame.protocols', '_ws.malformed', '_ws.expert.severity', '_ws.expert.message',
  'eth.dst', 'eth.src', 'eth.type',
  'arp.opcode', 'arp.src.hw_mac', 'arp.src.proto_ipv4', 'arp.dst.hw_mac', 'arp.dst.proto_ipv4',
  'ip.version', 'ip.hdr_len', 'ip.len', 'ip.id', 'ip.flags.df', 'ip.ttl', 'ip.proto', 'ip.checksum', 'ip.checksum.status', 'ip.src', 'ip.dst',
  'icmp.type', 'icmp.code', 'icmp.checksum', 'icmp.checksum.status', 'icmp.ident', 'icmp.seq',
  'udp.srcport', 'udp.dstport', 'udp.length', 'udp.checksum', 'udp.checksum.status',
  'tcp.srcport', 'tcp.dstport', 'tcp.seq_raw', 'tcp.ack_raw', 'tcp.flags', 'tcp.window_size_value', 'tcp.checksum', 'tcp.checksum.status',
  'data.data',
] as const;
export type Field = typeof FIELDS[number];

/** tshark's options: verify every checksum it is able to; by default it trusts some of them. */
export const TSHARK_PREFS = ['-o', 'ip.check_checksum:TRUE', '-o', 'udp.check_checksum:TRUE', '-o', 'tcp.check_checksum:TRUE'];
/** The file goes in on a pipe: Ubuntu's tshark refuses a path in the runner's work directory ("You don't have permission"), and refuses Node's stdin too, a socket. */
export const tsharkArgs = (): string[] => ['-r', '-', '-n', ...TSHARK_PREFS, '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=a', '-E', 'aggregator=|', ...FIELDS.flatMap((f) => ['-e', f])];

export type Row = Partial<Record<Field, string>>;

export function parseRows(text: string): Row[] {
  return text.split('\n').filter((l) => l.length > 0).map((l) => {
    const cols = l.replace(/\r$/, '').split('\t'), r: Row = {};
    FIELDS.forEach((f, i) => { if (cols[i]) r[f] = cols[i]; });
    return r;
  });
}

const be = (a: ArrayLike<number>, i: number, n: number): number => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + a[i + k]; return v; };
const macAt = (a: ArrayLike<number>, i: number) => Array.from({ length: 6 }, (_, k) => a[i + k].toString(16).padStart(2, '0')).join(':');
const ipAt = (a: ArrayLike<number>, i: number) => [a[i], a[i + 1], a[i + 2], a[i + 3]].join('.');
const hexOf = (a: ArrayLike<number>, from: number, to: number) => Array.from({ length: Math.max(0, Math.min(to, a.length) - from) }, (_, k) => a[from + k].toString(16).padStart(2, '0')).join('');

export interface Claim { fields: Partial<Record<Field, string | number>>; chain: string; /** Checksums that must read good. */ good: Field[] }

/** What these bytes say they are. Every frame says something by its EtherType, and is held to it: tshark believes that field, and so does a reader. */
export function claimOf(b: ArrayLike<number>, us: number): Claim {
  const type = be(b, 12, 2);
  const fields: Claim['fields'] = { 'frame.len': b.length, 'frame.time_epoch': us, 'frame.encap_type': 1, 'eth.dst': macAt(b, 0), 'eth.src': macAt(b, 6), 'eth.type': type };
  const good: Field[] = [];
  let chain = 'eth:ethertype';
  if (type === 0x0806) {
    chain += ':arp';
    Object.assign(fields, { 'arp.opcode': be(b, 20, 2), 'arp.src.hw_mac': macAt(b, 22), 'arp.src.proto_ipv4': ipAt(b, 28), 'arp.dst.hw_mac': macAt(b, 32), 'arp.dst.proto_ipv4': ipAt(b, 38) });
  } else if (type === 0x0800) {
    chain += ':ip';
    const hl = (b[14] & 15) * 4, len = be(b, 16, 2), t = 14 + hl, end = 14 + len, proto = b[23];
    Object.assign(fields, { 'ip.version': b[14] >> 4, 'ip.hdr_len': hl, 'ip.len': len, 'ip.id': be(b, 18, 2), 'ip.ttl': b[22], 'ip.proto': proto, 'ip.checksum': be(b, 24, 2), 'ip.src': ipAt(b, 26), 'ip.dst': ipAt(b, 30) });
    good.push('ip.checksum.status');
    if (proto === 1) {
      chain += ':icmp';
      Object.assign(fields, { 'icmp.type': b[t], 'icmp.code': b[t + 1], 'icmp.checksum': be(b, t + 2, 2) });
      good.push('icmp.checksum.status');
      if (b[t] === 0 || b[t] === 8) {
        Object.assign(fields, { 'icmp.ident': be(b, t + 4, 2), 'icmp.seq': be(b, t + 6, 2) });
        const data = hexOf(b, t + 8, end);
        if (data) fields['data.data'] = data;
      }
    } else if (proto === 17) {
      chain += ':udp';
      Object.assign(fields, { 'udp.srcport': be(b, t, 2), 'udp.dstport': be(b, t + 2, 2), 'udp.length': be(b, t + 4, 2), 'udp.checksum': be(b, t + 6, 2) });
      good.push('udp.checksum.status');
    } else if (proto === 6) {
      chain += ':tcp';
      Object.assign(fields, { 'tcp.srcport': be(b, t, 2), 'tcp.dstport': be(b, t + 2, 2), 'tcp.seq_raw': be(b, t + 4, 4), 'tcp.ack_raw': be(b, t + 8, 4), 'tcp.flags': b[t + 13] & 0x3f, 'tcp.window_size_value': be(b, t + 14, 2), 'tcp.checksum': be(b, t + 16, 2) });
      good.push('tcp.checksum.status');
    }
  }
  return { fields, chain, good };
}

/** The outermost value: an ICMP error holds a second IP header, whose fields follow the first's in an aggregated column. */
const first = (s: string | undefined): string | undefined => s?.split('|')[0];

function same(field: Field, want: string | number, got: string | undefined): boolean {
  if (got === undefined) return false;
  if (field === 'frame.time_epoch') return Math.round(Number(got) * 1e6) === want;
  if (field === 'data.data') return got.replace(/[:|]/g, '').toLowerCase() === want;
  if (typeof want === 'number') return Number(got) === want;
  return got.toLowerCase() === want;
}

// expert severities: the numbers on some versions, the names on others
const SEVERE = /^(warn|error|warning|6291456|8388608|0x00600000|0x00800000)$/i;
const BAD_STATUS = new Set(['0', '4', 'bad', 'illegal']);
const GOOD_STATUS = new Set(['1', 'good']);

/** Every way tshark's reading of one frame departs from what its bytes claim: empty when they agree. */
export function compareRow(c: Claim, r: Row): string[] {
  const out: string[] = [];
  for (const [k, want] of Object.entries(c.fields) as [Field, string | number][]) {
    const got = k === 'data.data' ? r[k] : first(r[k]);
    if (!same(k, want, got)) out.push(`${k}: tshark ${got ?? 'has nothing'}, the bytes say ${want}`);
  }
  const protos = r['frame.protocols'] ?? '';
  if (!(protos === c.chain || protos.startsWith(`${c.chain}:`))) out.push(`protocols: tshark ${protos || 'has none'}, the bytes say ${c.chain}`);
  if (r['_ws.malformed'] !== undefined || protos.includes('malformed')) out.push(`malformed: ${r['_ws.expert.message'] ?? protos}`);
  for (const f of c.good) { const s = first(r[f])?.toLowerCase(); if (!s || !GOOD_STATUS.has(s)) out.push(`${f}: ${s ?? 'not verified'}, not good`); }
  for (const f of ['ip.checksum.status', 'icmp.checksum.status', 'udp.checksum.status', 'tcp.checksum.status'] as const) {
    if ((r[f] ?? '').split('|').some((x) => BAD_STATUS.has(x.toLowerCase()))) out.push(`${f}: a bad checksum (${r[f]})`);
  }
  const sev = (r['_ws.expert.severity'] ?? '').split('|'), msg = (r['_ws.expert.message'] ?? '').split('|');
  sev.forEach((x, i) => { if (SEVERE.test(x)) out.push(`expert ${x}: ${msg[i] ?? ''}`); });
  return out;
}

export interface Captured2 { us: number; bytes: ArrayLike<number> }

/** A whole capture against tshark's rows. */
export function compareCapture(frames: readonly Captured2[], rows: readonly Row[], claims: Claim[] = frames.map((f) => claimOf(f.bytes, Math.max(0, Math.round(f.us))))): string[] {
  const out: string[] = [];
  if (rows.length !== frames.length) out.push(`tshark read ${rows.length} frames of ${frames.length}`);
  rows.forEach((r, i) => { if (claims[i]) for (const p of compareRow(claims[i], r)) out.push(`frame ${i + 1}: ${p}`); });
  return out;
}
