// RFC 791 IPv4 and RFC 1071's checksum, in the Python subset. Addresses are 32-bit ints (10.0.0.2 is 0x0a000002). Not supported, and said so:
// fragmentation (a fragment is dropped, and nothing is sent in pieces: the DF bit is set), options (a header longer than 20 bytes is read past, not
// acted on), and routing beyond one next-hop gateway.
//
// Network byte order is the stack's job: the NIC moves bytes, and get16 / put16 / get32 / put32 are the only places where a multi-byte field is
// built or taken apart.

import type { StackModule } from './index';

export const IP: StackModule = {
  name: 'ip',
  py: `# ---- ip: addressing, the header checksum, dispatch by protocol ----
ip_id = 1

def get16(a):
    return (load8(a) << 8) | load8(a + 1)

def put16(a, v):
    store8(a, (v >> 8) & 255)
    store8(a + 1, v & 255)

def get32(a):
    return (get16(a) << 16) | get16(a + 2)

def put32(a, v):
    put16(a, (v >> 16) & 0xffff)
    put16(a + 2, v & 0xffff)

# the 16-bit ones' complement sum of n bytes at a (a last odd byte is padded with a zero on the right), added to start, end-around carry folded in:
# a block that includes its own checksum field sums to 0xffff when the checksum is right; the checksum to store is ~sum & 0xffff
def ones_sum(a, n, start):
    s = start
    end = a + n - 1
    while a < end:
        s += (load8(a) << 8) | load8(a + 1)
        a += 2
    if a == end:
        s += load8(a) << 8
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return s

# buf is the frame buffer, off the header's offset, n the bytes from there to the end of the frame (padding included): the total length field,
# not n, says where the datagram ends
def ip_input(buf, off, n):
    ip = buf + off
    vihl = load8(ip)
    hl = (vihl & 15) << 2
    if (vihl >> 4) != 4 or hl < 20:
        return 0
    total = get16(ip + 2)
    if total > n or total < hl:
        return 0
    if ones_sum(ip, hl, 0) != 0xffff:
        return 0
    dst = get32(ip + 16)
    if dst != g_ip and dst != -1:
        return 0
    if get16(ip + 6) & 0x3fff:
        return 0
    proto = load8(ip + 9)
    src = get32(ip + 12)
    if proto == 1:
        icmp_input(buf, off + hl, total - hl, src)
    elif proto == 17:
        udp_input(buf, off + hl, total - hl, src)
    elif proto == 6:
        tcp_input(buf, off + hl, total - hl, src)
    return 1

# b is a transmit buffer holding the transport header and data at b + 34, tlen bytes of them; fills the IP and Ethernet headers and hands the frame
# to the NIC. Returns 0, having sent an ARP request instead, when the next hop's MAC address is not known yet
def ip_send(proto, dst, b, tlen):
    global ip_id
    hop = dst
    if (dst & g_mask) != (g_ip & g_mask) and g_gw != 0:
        hop = g_gw
    idx = arp_find(hop)
    if idx < 0:
        arp_request(hop)
        return 0
    ip = b + 14
    store8(ip, 0x45)
    store8(ip + 1, 0)
    put16(ip + 2, 20 + tlen)
    put16(ip + 4, ip_id)
    ip_id = (ip_id + 1) & 0xffff
    put16(ip + 6, 0x4000)
    store8(ip + 8, 64)
    store8(ip + 9, proto)
    put16(ip + 10, 0)
    put32(ip + 12, g_ip)
    put32(ip + 16, dst)
    put16(ip + 10, (~ones_sum(ip, 20, 0)) & 0xffff)
    for k in range(0, 6, 1):
        store8(b + k, arp_mac[(idx << 2) + (idx << 1) + k])
    eth_src_type(b, 0x0800)
    tx_commit(34 + tlen)
    return 1
`,
};
