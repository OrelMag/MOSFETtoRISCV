// The applications of chapter glass, in the Python subset, run on top of the stack: a ping that prints each round trip to the console, a host that only
// answers (the stack does the work: its main loop is net_poll), and a UDP echo. The subset has no strings, so text is copied into RAM at start
// from generated store8 lines and printed from there.

import { STACK_LAYOUT as L } from './layout';

export const HOSTS = {
  A: { ip: 0x0a000001, mac: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01] },
  B: { ip: 0x0a000002, mac: [0x02, 0x00, 0x00, 0x00, 0x00, 0x02] },
} as const;

/** Python that writes each text into RAM from L.strings on, NUL terminated; returns the addresses by name. */
export function strings(texts: Record<string, string>): { py: string; at: Record<string, number> } {
  let a: number = L.strings;
  const at: Record<string, number> = {};
  const lines: string[] = [];
  for (const [k, t] of Object.entries(texts)) {
    at[k] = a;
    for (const ch of t) lines.push(`store8(${a++}, ${ch.charCodeAt(0)})`);
    lines.push(`store8(${a++}, 0)`);
  }
  return { py: lines.join('\n'), at };
}

/** The switch of lib/lan.ts keeps a frame in a 128-byte cell: 14 + 20 + 8 bytes of headers leave 86 for data. ip_send itself does not check. */
export const MAX_DATA = 86;
/** The data bytes of the chapter's ping: a ping frame is 14 + 20 + 8 + PING_DATA = 74 bytes. */
export const PING_DATA = 32;

const hx = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
const netInit = (h: { ip: number; mac: readonly number[] }) => `net_init(${hx(h.ip)}, ${h.mac.join(', ')})`;

/** Console helpers: a character, a NUL-terminated text from RAM, a decimal number. */
const CONSOLE_PY = `pow10 = [100000, 10000, 1000, 100, 10, 1]

def putc(c):
    store32(${`0x${L.console.toString(16)}`}, c)

def puts(a):
    c = load8(a)
    while c != 0:
        putc(c)
        a += 1
        c = load8(a)

def put_dec(v):
    started = 0
    for i in range(0, 6, 1):
        p = pow10[i]
        d = 0
        while v >= p:
            v -= p
            d += 1
        if d != 0 or started != 0 or i == 5:
            putc(48 + d)
            started = 1
`;

/** Computer A pings B `count` times, with `ndata` bytes of data (the console shows each reply and its round trip in clock cycles). */
export function pingApp(count = 3, ndata = PING_DATA): string {
  if (ndata > MAX_DATA) throw new Error(`ping data of ${ndata} bytes: the switch's cells hold frames of 128 bytes, ${MAX_DATA} of data at most`);
  const s = strings({ reply: '64 bytes from 10.0.0.2: seq=', time: ' time=', cycles: ' cycles\n', arp: 'arp: 10.0.0.2 is at 02:00:00:00:00:02\n', done: 'done\n' });
  return `${CONSOLE_PY}
${s.py}
${netInit(HOSTS.A)}
target = ${hx(HOSTS.B.ip)}
seq = 1
while seq <= ${count}:
    asked = 0
    while arp_find(target) < 0:
        arp_request(target)
        w = 0
        while w < 4000 and arp_find(target) < 0:
            net_poll()
            w += 1
        if asked == 0 and arp_find(target) >= 0:
            puts(${s.at.arp})
        asked = 1
    t0 = now()
    icmp_echo(target, 0x1234, seq, ${ndata})
    while icmp_seen < seq:
        net_poll()
    puts(${s.at.reply})
    put_dec(icmp_seq)
    puts(${s.at.time})
    put_dec(icmp_time - t0)
    puts(${s.at.cycles})
    seq += 1
puts(${s.at.done})
while 1:
    net_poll()
`;
}

/** A host that answers ARP and ping and does nothing else. */
export function hostApp(h: { ip: number; mac: readonly number[] } = HOSTS.B): string {
  const s = strings({ up: 'host up\n' });
  return `${CONSOLE_PY}
${s.py}
${netInit(h)}
puts(${s.at.up})
while 1:
    net_poll()
`;
}

/** UDP echo on port 7: every datagram sent back to its sender, the console counting them. */
export function udpEchoApp(h: { ip: number; mac: readonly number[] } = HOSTS.B): string {
  const s = strings({ up: 'udp echo on port 7\n', got: 'echoed ' });
  return `${CONSOLE_PY}
${s.py}
echoed = 0

def udp_rx(dport, src, sport, buf, doff, dlen):
    global echoed
    if dport != 7:
        return 0
    b = tx_buf()
    if b == 0:
        return 0
    for k in range(0, dlen, 1):
        store8(b + 42 + k, load8(buf + doff + k))
    if udp_send(src, dport, sport, b, dlen) != 0:
        echoed += 1
        puts(${s.at.got})
        put_dec(echoed)
        putc(10)
    return 1

${netInit(h)}
puts(${s.at.up})
while 1:
    net_poll()
`;
}

/** A host that sends `count` UDP datagrams (data is its sequence number repeated) to B port 7 and prints what comes back. */
export function udpClientApp(count = 3, ndata = 16): string {
  if (ndata > MAX_DATA) throw new Error(`UDP data of ${ndata} bytes: the switch's cells hold frames of 128 bytes, ${MAX_DATA} of data at most`);
  const s = strings({ got: 'echo of seq ', len: ' bytes=' , done: 'done\n' });
  return `${CONSOLE_PY}
${s.py}
got = 0

def udp_rx(dport, src, sport, buf, doff, dlen):
    global got
    got += 1
    puts(${s.at.got})
    put_dec(load8(buf + doff))
    puts(${s.at.len})
    put_dec(dlen)
    putc(10)
    return 1

${netInit(HOSTS.A)}
target = ${hx(HOSTS.B.ip)}
seq = 1
while seq <= ${count}:
    while arp_find(target) < 0:
        arp_request(target)
        w = 0
        while w < 4000 and arp_find(target) < 0:
            net_poll()
            w += 1
    b = tx_buf()
    for k in range(0, ${ndata}, 1):
        store8(b + 42 + k, seq)
    udp_send(target, 5000, 7, b, ${ndata})
    while got < seq:
        net_poll()
    seq += 1
puts(${s.at.done})
while 1:
    net_poll()
`;
}
