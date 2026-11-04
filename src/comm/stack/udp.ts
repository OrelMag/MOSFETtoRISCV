// RFC 768. A datagram is ports, a length and a checksum over the data and a pseudo-header (source and destination address, protocol, length) that
// the datagram itself does not carry, so that a datagram delivered to the wrong address fails. A checksum field of 0 means "none computed" and is
// accepted; a computed 0 is sent as 0xffff. The application defines udp_rx(dport, src, sport, buf, doff, dlen), called for each datagram that passes.
// A datagram addressed to the broadcast address is checked against our own address in the pseudo-header, so a broadcast with a checksum is dropped.

import type { StackModule } from './index';

export const UDP: StackModule = {
  name: 'udp',
  py: `# ---- udp: ports ----
def udp_pseudo(src, dst, ulen):
    return ((src >> 16) & 0xffff) + (src & 0xffff) + ((dst >> 16) & 0xffff) + (dst & 0xffff) + 17 + ulen

def udp_input(buf, off, n, src):
    u = buf + off
    ulen = get16(u + 4)
    if n < 8 or ulen < 8 or ulen > n:
        return 0
    if get16(u + 6) != 0 and ones_sum(u, ulen, udp_pseudo(src, g_ip, ulen)) != 0xffff:
        return 0
    udp_rx(get16(u + 2), src, get16(u), buf, off + 8, ulen - 8)
    return 1

# the data is already at b + 42, n bytes of it
def udp_send(dst, sport, dport, b, n):
    u = b + 34
    put16(u, sport)
    put16(u + 2, dport)
    put16(u + 4, 8 + n)
    put16(u + 6, 0)
    c = (~ones_sum(u, 8 + n, udp_pseudo(g_ip, dst, 8 + n))) & 0xffff
    if c == 0:
        c = 0xffff
    put16(u + 6, c)
    return ip_send(17, dst, b, 8 + n)
`,
};
