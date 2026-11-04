// Layer 2 and the NIC's driver, in the Python subset: the two descriptor rings of comm/nic.ts, a frame in and out, and the dispatch on the
// EtherType. Software and NIC hand each descriptor to each other by one bit (OWN, bit 31 of word 1: set means the NIC holds it); a negative
// word is therefore "the NIC still has it". The driver polls: net_poll takes at most one frame from the receive ring.

import type { StackModule } from './index';
import { STACK_LAYOUT as L } from './layout';

const K = (n: number) => `0x${n.toString(16)}`;

export const ETH: StackModule = {
  name: 'eth',
  py: `# ---- eth: the NIC's rings and the Ethernet layer ----
mac = [0, 0, 0, 0, 0, 0]
g_ip = 0
g_mask = -256
g_gw = 0
rx_i = 0
tx_i = 0

def now():
    return load32(${K(L.mtime)})

def nic_init():
    for i in range(0, ${L.descriptors}, 1):
        r = ${K(L.rxRing)} + (i << 3)
        store32(r, ${K(L.rxBuf)} + (i << 10) + (i << 9))
        store32(r + 4, 0x80000000)
        t = ${K(L.txRing)} + (i << 3)
        store32(t, ${K(L.txBuf)} + (i << 10) + (i << 9))
        store32(t + 4, 0)
    store32(${K(L.nic + 0x0c)}, ${K(L.rxRing)})
    store32(${K(L.nic + 0x10)}, ${K(L.txRing)})
    store32(${K(L.nic + 0x14)}, mac[0] | (mac[1] << 8) | (mac[2] << 16) | (mac[3] << 24))
    store32(${K(L.nic + 0x18)}, mac[4] | (mac[5] << 8))
    store32(${K(L.nic)}, 1)

def net_init(ip, m0, m1, m2, m3, m4, m5):
    global g_ip
    g_ip = ip
    mac[0] = m0
    mac[1] = m1
    mac[2] = m2
    mac[3] = m3
    mac[4] = m4
    mac[5] = m5
    nic_init()

# the next free transmit buffer, or 0 while the NIC still holds the descriptor
def tx_buf():
    if load32(${K(L.txRing)} + (tx_i << 3) + 4) < 0:
        return 0
    return ${K(L.txBuf)} + (tx_i << 10) + (tx_i << 9)

# hand the frame of n bytes in that buffer to the NIC and ring the doorbell
def tx_commit(n):
    global tx_i
    store32(${K(L.txRing)} + (tx_i << 3) + 4, 0x80000000 | n)
    tx_i = (tx_i + 1) & 7
    store32(${K(L.nic + 0x1c)}, 1)

# source address and EtherType; the caller has written the destination
def eth_src_type(b, t):
    for k in range(0, 6, 1):
        store8(b + 6 + k, mac[k])
    store8(b + 12, t >> 8)
    store8(b + 13, t & 255)

def eth_input(buf, n):
    if n < 14:
        return 0
    t = (load8(buf + 12) << 8) | load8(buf + 13)
    if t == 0x0806:
        return arp_input(buf, n)
    if t == 0x0800:
        return ip_input(buf, 14, n - 14)
    return 0

# take one frame from the receive ring, if the NIC has finished one
def net_poll():
    global rx_i
    d = ${K(L.rxRing)} + (rx_i << 3)
    w = load32(d + 4)
    if w < 0:
        return 0
    eth_input(load32(d), w & 0x7ff)
    store32(d + 4, 0x80000000)
    rx_i = (rx_i + 1) & 7
    return 1
`,
};
