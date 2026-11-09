// RFC 792, the part ping uses: echo request (type 8) answered by echo reply (type 0), data copied back unchanged, and a sender of echo
// requests that notes the reply. Other ICMP messages (unreachable, time exceeded) are dropped here; the router of chapter errors sends them.

import type { StackModule } from './index';

export const ICMP: StackModule = {
  name: 'icmp',
  py: `# ---- icmp: echo request and reply ----
icmp_seen = 0
icmp_id = 0
icmp_seq = 0
icmp_time = 0

def icmp_input(buf, off, n, src):
    global icmp_seen, icmp_id, icmp_seq, icmp_time
    a = buf + off
    if n < 8 or ones_sum(a, n, 0) != 0xffff:
        return 0
    t = load8(a)
    if t == 8 and load8(a + 1) == 0:
        b = tx_buf()
        if b == 0:
            return 0
        d = b + 34
        for k in range(0, n, 1):
            store8(d + k, load8(a + k))
        store8(d, 0)
        put16(d + 2, 0)
        put16(d + 2, (~ones_sum(d, n, 0)) & 0xffff)
        return ip_send(1, src, b, n)
    if t == 0:
        icmp_id = get16(a + 4)
        icmp_seq = get16(a + 6)
        icmp_time = now()
        icmp_seen += 1
    return 1

# an echo request with ndata bytes of data (16, 17, ...); 0 when it could not go (no free buffer, or the address not resolved yet)
def icmp_echo(dst, ident, seq, ndata):
    b = tx_buf()
    if b == 0:
        return 0
    d = b + 34
    store8(d, 8)
    store8(d + 1, 0)
    put16(d + 2, 0)
    put16(d + 4, ident)
    put16(d + 6, seq)
    for k in range(0, ndata, 1):
        store8(d + 8 + k, 16 + k)
    put16(d + 2, (~ones_sum(d, 8 + ndata, 0)) & 0xffff)
    return ip_send(1, dst, b, 8 + ndata)
`,
};
