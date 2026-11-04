// Chapter 52's applications: a sender of a known stream, and a receiver that checks it and prints what it found. Each computer sets its gateway and, since
// the router's slow path is not on this bench, knows the gateway's MAC from a table (a static ARP entry) instead of asking. Clocks are the CPU's timer.

import { TCP_K } from '../../net/tcp';
import { strings } from './apps';
import { STACK_LAYOUT as L } from './layout';
import { TCP_MEM } from './tcp';

/** The bench's port. Not 5000: Wireshark gives that port to GSM's IPA, and a learner who opens a capture would see good frames called malformed. */
export const TCP_PORT = 12000;

export interface TcpHost { ip: number; mac: readonly number[]; gw: number; gwMac: readonly number[] }

/** Above the rings: a scratch page for what the applications read and write a pass. */
const SCRATCH = TCP_MEM.rcv + TCP_K.RCV;
const CHUNK = 128;
const hx = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
const CON = hx(L.console);

const COMMON = `pow10 = [1000000000, 100000000, 10000000, 1000000, 100000, 10000, 1000, 100, 10, 1]

def puts(a):
    c = load8(a)
    while c != 0:
        store32(${CON}, c)
        a += 1
        c = load8(a)

def put_dec(v):
    started = 0
    for i in range(0, 10, 1):
        p = pow10[i]
        d = 0
        while v >= p:
            v -= p
            d += 1
        if d != 0 or started != 0 or i == 9:
            store32(${CON}, 48 + d)
            started = 1

def stream(i):
    return (i + (i >> 8) * 7) & 255
`;

const hostInit = (h: TcpHost, isn?: number) => `${isn === undefined ? '' : `isn_next = ${isn | 0}\n`}g_gw = ${hx(h.gw)}
net_init(${hx(h.ip)}, ${h.mac.join(', ')})
${h.gwMac.map((b, i) => `store8(${SCRATCH + i}, ${b})`).join('\n')}
arp_learn(${hx(h.gw)}, ${SCRATCH})
`;

/** Connect, send `bytes` of the stream, close; print the clocks it took. */
export function tcpSender(h: TcpHost, to: number, bytes: number, o: { port?: number; isn?: number } = {}): string {
  const s = strings({ up: 'connected\n', done: 'sent ', c: ' bytes in ', cy: ' cycles\n', fail: 'failed\n' });
  return `${s.py}
${COMMON}${hostInit(h, o.isn)}tcp_connect(${hx(to)}, 40000, ${o.port ?? TCP_PORT})
while tcp_st != 4 and tcp_err == 0:
    net_poll()
    tcp_tick()
t0 = now()
if tcp_err == 0:
    puts(${s.at.up})
sent = 0
closed = 0
while tcp_st != 0 and tcp_st != 10 and tcp_err == 0:
    net_poll()
    tcp_tick()
    if sent < ${bytes}:
        n = min(${CHUNK}, ${bytes} - sent)
        for i in range(0, n, 1):
            store8(${SCRATCH + 16} + i, stream(sent + i))
        sent += tcp_write(${SCRATCH + 16}, n)
    elif closed == 0:
        tcp_close()
        closed = 1
if tcp_err:
    puts(${s.at.fail})
else:
    puts(${s.at.done})
    put_dec(sent)
    puts(${s.at.c})
    put_dec(now() - t0)
    puts(${s.at.cy})
while 1:
    net_poll()
    tcp_tick()
`;
}

/** Listen, read and check the stream. `readEvery` clocks between reads: a slow application, which closes the window. */
export function tcpReceiver(h: TcpHost, o: { port?: number; isn?: number; readEvery?: number } = {}): string {
  const s = strings({ got: 'received ', ok: ' bytes, all correct\n', bad: ' bytes, WRONG\n' });
  return `${s.py}
${COMMON}got = 0
wrong = 0

def take():
    global got, wrong
    n = tcp_read(${SCRATCH + 16}, ${CHUNK})
    for i in range(0, n, 1):
        if load8(${SCRATCH + 16} + i) != stream(got + i):
            wrong += 1
    got += n
    return n

${hostInit(h, o.isn)}tcp_listen(${o.port ?? TCP_PORT})
t = now()
while tcp_st != 7:
    net_poll()
    tcp_tick()
    if (now() - t) >= ${o.readEvery ?? 0}:
        t = now()
        take()
while take() > 0:
    pass
tcp_close()
puts(${s.at.got})
put_dec(got)
if wrong:
    puts(${s.at.bad})
else:
    puts(${s.at.ok})
while 1:
    net_poll()
    tcp_tick()
`;
}
