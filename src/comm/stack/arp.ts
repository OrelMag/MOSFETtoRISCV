// RFC 826 for Ethernet and IPv4: who has this IP address, and a four-entry table of the answers. A request for our address is answered; the
// sender of any ARP packet addressed to us is learned (or refreshed). There is no timeout and no retry timer: a mapping stays until a newer one
// takes its slot (round robin), and the sender of a frame to an unknown host asks and tries again later.

import type { StackModule } from './index';

export const ARP: StackModule = {
  name: 'arp',
  py: `# ---- arp: IP address to MAC address ----
arp_ip = [0, 0, 0, 0]
arp_mac = [0] * 24
arp_next = 0

def arp_find(ip):
    for i in range(0, 4, 1):
        if arp_ip[i] == ip:
            return i
    return -1

# remember that ip is at the six bytes starting at sha
def arp_learn(ip, sha):
    global arp_next
    i = arp_find(ip)
    if i < 0:
        i = arp_next
        arp_next = (arp_next + 1) & 3
        arp_ip[i] = ip
    for k in range(0, 6, 1):
        arp_mac[(i << 2) + (i << 1) + k] = load8(sha + k)

# the packet after the Ethernet header: htype 1, ptype 0x0800, hlen 6, plen 4, op, sender and target addresses
def arp_fill(b, op, tha, tpa):
    a = b + 14
    put16(a, 1)
    put16(a + 2, 0x0800)
    store8(a + 4, 6)
    store8(a + 5, 4)
    put16(a + 6, op)
    for k in range(0, 6, 1):
        store8(a + 8 + k, mac[k])
        if tha == 0:
            store8(a + 18 + k, 0)
        else:
            store8(a + 18 + k, load8(tha + k))
    put32(a + 14, g_ip)
    put32(a + 24, tpa)

def arp_request(ip):
    b = tx_buf()
    if b == 0:
        return 0
    for k in range(0, 6, 1):
        store8(b + k, 255)
    eth_src_type(b, 0x0806)
    arp_fill(b, 1, 0, ip)
    tx_commit(42)
    return 1

def arp_input(buf, n):
    a = buf + 14
    if n < 42 or get16(a) != 1 or get16(a + 2) != 0x0800 or load8(a + 4) != 6 or load8(a + 5) != 4:
        return 0
    op = get16(a + 6)
    spa = get32(a + 14)
    tpa = get32(a + 24)
    if tpa != g_ip:
        return 0
    arp_learn(spa, a + 8)
    if op == 1:
        b = tx_buf()
        if b == 0:
            return 0
        for k in range(0, 6, 1):
            store8(b + k, load8(a + 8 + k))
        eth_src_type(b, 0x0806)
        arp_fill(b, 2, a + 8, spa)
        tx_commit(42)
    return 1
`,
};
