// Chapter 52's TCP in the Python subset: the rules of net/tcp.ts, function by function (tests/net-tcp-stack.test.ts compares every byte sent and every
// state variable with that model). One connection. The send and receive buffers are rings in the RAM above the NIC's frame buffers, indexed by sequence
// number; a retransmission is rebuilt from the send ring, so no copy of a segment is kept. Sequence numbers and times are compared on their difference,
// so they wrap. The segment being handled sits in globals (seg_*): a function has only so many registers.

import { TCP_K } from '../../net/tcp';
import type { StackModule } from './index';

/** The two rings, in the 0x700 bytes between the last frame buffer (0x7900) and the end of the 32 KB RAM. */
export const TCP_MEM = { snd: 0x7900, rcv: 0x7d00 } as const;
const K = TCP_K, SM = K.SND - 1, RM = K.RCV - 1;

export const TCP: StackModule = {
  name: 'tcp',
  py: `# ---- tcp: a reliable stream over datagrams that may not arrive ----
tcp_st = 0
tcp_lport = 0
tcp_rport = 0
tcp_rip = 0
tcp_passive = 0
tcp_err = 0
isn_next = 0x10000000
iss = 0
snd_una = 0
snd_nxt = 0
snd_max = 0
snd_end = 0
snd_wnd = 0
wl1 = 0
wl2 = 0
rcv_nxt = 0
rcv_read = 0
fin_in = 0
fin_want = 0
ack_pending = 0
tw_at = 0
tcp_mss = ${K.MSS}
cwnd = ${2 * K.MSS}
ssthresh = ${K.SND}
acc = 0
dupacks = 0
srtt = 0
rttvar = 0
rto = ${K.RTO_INIT}
rto_on = 0
rto_at = 0
rtt_on = 0
rtt_seq = 0
rtt_t = 0
retries = 0
seg_src = 0
seg_sport = 0
seg_dport = 0
seg_seq = 0
seg_ack = 0
seg_flags = 0
seg_wnd = 0
seg_mss = 0
seg_data = 0
seg_len = 0
seg_skip = 0

def tcp_reset():
    global snd_una, snd_nxt, snd_max, snd_end, rcv_nxt, rcv_read, tcp_mss, cwnd, ssthresh, acc, dupacks
    global srtt, rttvar, rto, rto_on, rtt_on, retries, fin_want, fin_in, ack_pending
    snd_una = 0
    snd_nxt = 0
    snd_max = 0
    snd_end = 0
    rcv_nxt = 0
    rcv_read = 0
    tcp_mss = ${K.MSS}
    cwnd = ${2 * K.MSS}
    ssthresh = ${K.SND}
    acc = 0
    dupacks = 0
    srtt = 0
    rttvar = 0
    rto = ${K.RTO_INIT}
    rto_on = 0
    rtt_on = 0
    retries = 0
    fin_want = 0
    fin_in = 0
    ack_pending = 0

def tcp_drop():
    global tcp_st
    tcp_reset()
    if tcp_passive:
        tcp_st = 1
    else:
        tcp_st = 0

def tcp_start():
    global iss, isn_next, snd_una, snd_nxt, snd_max, snd_end
    iss = isn_next
    isn_next = isn_next + 0x10000
    snd_una = iss
    snd_nxt = iss
    snd_max = iss
    snd_end = iss + 1

def tcp_listen(port):
    global tcp_lport, tcp_passive, tcp_st
    tcp_reset()
    tcp_lport = port
    tcp_passive = 1
    tcp_st = 1

def tcp_connect(ip, sport, dport):
    global tcp_passive, tcp_err, tcp_lport, tcp_rip, tcp_rport, tcp_st
    tcp_reset()
    tcp_passive = 0
    tcp_err = 0
    tcp_lport = sport
    tcp_rip = ip
    tcp_rport = dport
    tcp_start()
    tcp_st = 2
    tcp_output(now())

# bytes waiting to be read: the peer's FIN holds a sequence number but no byte
def tcp_held():
    return rcv_nxt - rcv_read - fin_in

def tcp_free():
    return ${K.RCV} - tcp_held()

# the ones' complement sum of the pseudo-header TCP's checksum also covers
def tcp_pseudo(src, dst, n):
    return ((src >> 16) & 0xffff) + (src & 0xffff) + ((dst >> 16) & 0xffff) + (dst & 0xffff) + 6 + n

# fill the header at t and send; hl is 24 with the MSS option, the data is already behind it
def tcp_finish(b, to, hl, n):
    t = b + 34
    store8(t + 12, (hl >> 2) << 4)
    put16(t + 16, 0)
    put16(t + 18, 0)
    if hl == 24:
        put16(t + 20, 0x0204)
        put16(t + 22, ${K.MSS})
    put16(t + 16, (~ones_sum(t, hl + n, tcp_pseudo(g_ip, to, hl + n))) & 0xffff)
    return ip_send(6, to, b, hl + n)

# one segment from the connection's state; 0 when no buffer is free or the next hop's address is unknown
def tcp_emit(flags, seq, n, hl):
    b = tx_buf()
    if b == 0:
        return 0
    t = b + 34
    put16(t, tcp_lport)
    put16(t + 2, tcp_rport)
    put32(t + 4, seq)
    if flags & 16:
        put32(t + 8, rcv_nxt)
    else:
        put32(t + 8, 0)
    store8(t + 13, flags)
    put16(t + 14, tcp_free())
    d = t + hl
    for i in range(0, n, 1):
        store8(d + i, load8(${TCP_MEM.snd} + ((seq + i) & ${SM})))
    return tcp_finish(b, tcp_rip, hl, n)

# one step of the data loop: returns 1 if a segment went out and there may be another
def tcp_send_one(t):
    global snd_nxt, snd_max, rtt_on, rtt_seq, rtt_t, ack_pending
    flight = snd_nxt - snd_una
    win = min(cwnd, snd_wnd)
    avail = snd_end - snd_nxt
    n = max(0, min(tcp_mss, avail, win - flight))
    # no small segment while one is out when more is waiting (the sender's side of silly window avoidance)
    if n < tcp_mss and n < avail and flight != 0:
        n = 0
    fin = 0
    if fin_want and avail >= 0 and n == avail:
        fin = 1
    if n == 0 and fin == 0:
        return 0
    end = snd_nxt + n
    flags = 16 | fin
    if n > 0 and end == snd_end:
        flags = flags | 8
    if tcp_emit(flags, snd_nxt, n, 20) == 0:
        return 0
    after = end + fin
    snd_nxt = after
    if (snd_max - after) < 0:
        snd_max = after
        if rtt_on == 0:
            rtt_on = 1
            rtt_seq = after
            rtt_t = t
    ack_pending = 0
    if fin:
        return 2
    return 1

# everything the state allows now: a SYN, as much data as both windows take, a FIN, else the ACK that is owed; then the timer's state
def tcp_output(t):
    global snd_nxt, snd_max, ack_pending, rtt_on, rtt_seq, rtt_t, rto_on, rto_at
    if tcp_st < 2:
        return 0
    if (tcp_st == 2 or tcp_st == 3) and snd_nxt == iss:
        f = 2
        if tcp_st == 3:
            f = 18
        if tcp_emit(f, iss, 0, 24):
            snd_nxt = iss + 1
            snd_max = snd_nxt
            ack_pending = 0
            if rtt_on == 0 and retries == 0:
                rtt_on = 1
                rtt_seq = snd_nxt
                rtt_t = t
    sent = 0
    if tcp_st >= 4 and tcp_st != 6 and tcp_st != 10:
        r = tcp_send_one(t)
        while r == 1:
            sent = 1
            r = tcp_send_one(t)
        if r == 2:
            sent = 1
    if ack_pending and sent == 0 and tcp_st != 2:
        if tcp_emit(16, snd_nxt, 0, 20):
            ack_pending = 0
    if snd_max != snd_una or (tcp_st >= 4 and (snd_end - snd_nxt) > 0 and snd_wnd == 0):
        if rto_on == 0:
            rto_on = 1
            rto_at = t + rto
    else:
        rto_on = 0
    return 0

def tcp_timeout():
    global rto_on, rto, snd_nxt, snd_max, retries, tcp_err, ssthresh, cwnd, acc, dupacks, rtt_on
    rto_on = 0
    if tcp_st >= 4 and snd_wnd == 0 and (snd_nxt - snd_una) <= 1 and (snd_end - snd_una) > 0:
        # the zero-window probe, the same byte each time: past the window, so its going unanswered is no loss. Nothing is cut and it never gives up
        snd_nxt = snd_una
        if tcp_emit(16, snd_nxt, 1, 20):
            snd_nxt = snd_nxt + 1
            if (snd_max - snd_nxt) < 0:
                snd_max = snd_nxt
        rto = min(rto << 1, ${K.RTO_MAX})
        return 0
    retries += 1
    if retries > ${K.RETRIES}:
        tcp_err = 1
        tcp_drop()
        return 0
    ssthresh = max((snd_max - snd_una) >> 1, tcp_mss << 1)
    cwnd = tcp_mss
    acc = 0
    dupacks = 0
    snd_nxt = snd_una
    rtt_on = 0
    rto = min(rto << 1, ${K.RTO_MAX})
    return 0

def tcp_tick():
    t = now()
    if tcp_st == 10 and (t - tw_at) >= 0:
        tcp_drop()
        return 0
    if rto_on and (t - rto_at) >= 0:
        tcp_timeout()
    if tcp_st != 0:
        tcp_output(t)
    return 0

# bytes at a into the send ring: as many as fit; returns how many
def tcp_write(a, n):
    global snd_end
    if tcp_st != 4 and tcp_st != 7:
        return 0
    n = min(${K.SND} - (snd_end - snd_una), n)
    for i in range(0, n, 1):
        store8(${TCP_MEM.snd} + ((snd_end + i) & ${SM}), load8(a + i))
    snd_end = snd_end + n
    tcp_output(now())
    return n

# up to n received bytes to a; a window that opens by a segment or more after being too small for one is announced at once
def tcp_read(a, n):
    global rcv_read, ack_pending
    before = tcp_free()
    n = min(n, tcp_held())
    for i in range(0, n, 1):
        store8(a + i, load8(${TCP_MEM.rcv} + ((rcv_read + i) & ${RM})))
    rcv_read = rcv_read + n
    if before < tcp_mss and tcp_free() >= tcp_mss and tcp_st >= 4:
        ack_pending = 1
        tcp_output(now())
    return n

def tcp_close():
    global fin_want, tcp_st, tcp_passive
    if tcp_st == 4:
        fin_want = 1
        tcp_st = 5
    elif tcp_st == 7:
        fin_want = 1
        tcp_st = 9
    elif tcp_st == 2 or tcp_st == 1:
        tcp_passive = 0
        tcp_drop()
        return 0
    tcp_output(now())
    return 0

# an answer to a segment that belongs to nothing
def tcp_rst():
    if seg_flags & 4:
        return 0
    b = tx_buf()
    if b == 0:
        return 0
    t = b + 34
    put16(t, seg_dport)
    put16(t + 2, seg_sport)
    put16(t + 14, 0)
    if seg_flags & 16:
        put32(t + 4, seg_ack)
        put32(t + 8, 0)
        store8(t + 13, 4)
    else:
        put32(t + 4, 0)
        put32(t + 8, seg_seq + seg_len + ((seg_flags >> 1) & 1) + (seg_flags & 1))
        store8(t + 13, 20)
    return tcp_finish(b, seg_src, 20, 0)

def tcp_sample(t):
    global srtt, rttvar, rto, rtt_on
    r = t - rtt_t
    if srtt == 0:
        srtt = r
        rttvar = r >> 1
    else:
        rttvar += (abs(srtt - r) - rttvar) >> 2
        srtt += (r - srtt) >> 3
    rto = min(max(srtt + (rttvar << 2), ${K.RTO_MIN}), ${K.RTO_MAX})
    rtt_on = 0

# the option the handshake carries; 536 is RFC 9293's default when it is absent
def tcp_options(t, off):
    global seg_mss
    seg_mss = 536
    i = 20
    while i + 1 < off:
        k = load8(t + i)
        if k == 0:
            return 0
        if k == 1:
            i += 1
            continue
        if k == 2 and load8(t + i + 1) == 4 and i + 3 < off:
            seg_mss = get16(t + i + 2)
        if load8(t + i + 1) < 2:
            return 0
        i += load8(t + i + 1)
    return 0

def tcp_syn_taken():
    global rcv_nxt, rcv_read, tcp_mss, snd_wnd, wl1
    rcv_nxt = seg_seq + 1
    rcv_read = rcv_nxt
    tcp_mss = min(${K.MSS}, seg_mss)
    snd_wnd = seg_wnd
    wl1 = seg_seq

def tcp_in_listen(t):
    global tcp_rip, tcp_rport, wl2, tcp_st
    if seg_flags & 4:
        return 0
    if seg_flags & 16:
        return tcp_rst()
    if (seg_flags & 2) == 0:
        return 0
    tcp_rip = seg_src
    tcp_rport = seg_sport
    tcp_start()
    tcp_syn_taken()
    wl2 = iss
    tcp_st = 3
    return tcp_output(t)

def tcp_in_syn_sent(t):
    global tcp_err, wl2, snd_una, tcp_st, ack_pending, retries, rto_on, snd_nxt, rtt_on
    good = 0
    if (seg_flags & 16) and seg_ack == snd_nxt:
        good = 1
    if (seg_flags & 16) and good == 0:
        return tcp_rst()
    if seg_flags & 4:
        if good:
            tcp_err = 1
            tcp_drop()
        return 0
    if (seg_flags & 2) == 0:
        return 0
    tcp_syn_taken()
    wl2 = seg_ack
    if good:
        snd_una = seg_ack
        tcp_st = 4
        ack_pending = 1
        retries = 0
        if rtt_on:
            tcp_sample(t)
        rto_on = 0
    else:
        tcp_st = 3
        snd_nxt = iss
        rtt_on = 0
        rto_on = 0
    return tcp_output(t)

# new data acknowledged, or the third duplicate
def tcp_ack_field(t):
    global snd_una, snd_nxt, retries, dupacks, rto_on, cwnd, acc, ssthresh, rtt_on
    if (snd_una - seg_ack) < 0:
        acked = seg_ack - snd_una
        snd_una = seg_ack
        if (snd_nxt - snd_una) < 0:
            snd_nxt = snd_una
        retries = 0
        dupacks = 0
        rto_on = 0
        if rtt_on and (rtt_seq - seg_ack) <= 0:
            tcp_sample(t)
        if cwnd < ssthresh:
            cwnd += min(acked, tcp_mss)
        else:
            acc += acked
            if acc >= cwnd:
                acc -= cwnd
                cwnd += tcp_mss
        if cwnd > ${K.SND}:
            cwnd = ${K.SND}
    elif seg_ack == snd_una and seg_len == 0 and (seg_flags & 1) == 0 and seg_wnd == snd_wnd and seg_wnd != 0 and snd_max != snd_una:
        # (with the window shut these are answers to a probe, not news of a loss)
        dupacks += 1
        if dupacks == ${K.DUPACKS}:
            # fast retransmit: halve, and go back (no out-of-order queue at the far end to save the rest)
            ssthresh = max((snd_max - snd_una) >> 1, tcp_mss << 1)
            cwnd = ssthresh
            acc = 0
            snd_nxt = snd_una
            rtt_on = 0
            rto_on = 0

# the bytes that start at rcv_nxt, and the FIN behind them
def tcp_take_data(t):
    global ack_pending, rcv_nxt, fin_in, tcp_st, tw_at
    fin = seg_flags & 1
    if seg_len > 0:
        ack_pending = 1
        if tcp_st == 4 or tcp_st == 5 or tcp_st == 6:
            k = min(seg_len, tcp_free())
            d = seg_data + seg_skip
            for i in range(0, k, 1):
                store8(${TCP_MEM.rcv} + ((rcv_nxt + i) & ${RM}), load8(d + i))
            rcv_nxt = rcv_nxt + k
            if k < seg_len:
                fin = 0
        else:
            fin = 0
    if fin:
        rcv_nxt = rcv_nxt + 1
        fin_in = 1
        ack_pending = 1
        if tcp_st == 4:
            tcp_st = 7
        elif tcp_st == 5:
            tcp_st = 8
        elif tcp_st == 6:
            tcp_st = 10
            tw_at = t + ${K.TIME_WAIT}

# a connection that has seen both SYNs (RFC 9293 section 3.10.7.4, with RFC 5961's rules for a reset and a SYN)
def tcp_in_sync(t):
    global tcp_err, ack_pending, seg_seq, seg_len, seg_skip, snd_una, tcp_st, retries, snd_wnd, wl1, wl2, rto_on, tw_at
    if seg_flags & 4:
        if seg_seq == rcv_nxt:
            tcp_err = 1
            if tcp_passive and tcp_st == 3:
                tcp_err = 0
            tcp_drop()
            return 0
        if (rcv_nxt - seg_seq) <= 0 and (seg_seq - (rcv_nxt + tcp_free())) < 0:
            ack_pending = 1
            tcp_output(t)
        return 0
    if seg_flags & 2:
        ack_pending = 1
        return tcp_output(t)
    if (seg_flags & 16) == 0:
        return 0
    # only the next byte is taken: what lies ahead is dropped, what was seen already is cut off
    d = rcv_nxt - seg_seq
    if d < 0 or (d > 0 and d >= seg_len + (seg_flags & 1)):
        ack_pending = 1
        return tcp_output(t)
    if d > 0:
        seg_skip = d
        seg_len -= d
        seg_seq = rcv_nxt
    if tcp_st == 3:
        if (iss - seg_ack) >= 0 or (snd_max - seg_ack) < 0:
            return tcp_rst()
        snd_una = iss + 1
        tcp_st = 4
        retries = 0
        snd_wnd = seg_wnd
        wl1 = seg_seq
        wl2 = seg_ack
        if rtt_on:
            tcp_sample(t)
        rto_on = 0
    if (snd_max - seg_ack) < 0:
        ack_pending = 1
        return tcp_output(t)
    tcp_ack_field(t)
    if (wl1 - seg_seq) < 0 or (wl1 == seg_seq and (wl2 - seg_ack) <= 0):
        snd_wnd = seg_wnd
        wl1 = seg_seq
        wl2 = seg_ack
    if fin_want and snd_una == snd_end + 1:
        if tcp_st == 5:
            tcp_st = 6
        elif tcp_st == 8:
            tcp_st = 10
            tw_at = t + ${K.TIME_WAIT}
        elif tcp_st == 9:
            tcp_drop()
            return 0
    tcp_take_data(t)
    return tcp_output(t)

# called by ip_input for protocol 6: off is the segment's offset in buf, n its length
def tcp_input(buf, off, n, src):
    global seg_src, seg_sport, seg_dport, seg_seq, seg_ack, seg_flags, seg_wnd, seg_data, seg_len, seg_skip
    t = buf + off
    if n < 20 or ones_sum(t, n, tcp_pseudo(src, g_ip, n)) != 0xffff:
        return 0
    h = (load8(t + 12) >> 4) << 2
    if h < 20 or h > n:
        return 0
    seg_src = src
    seg_sport = get16(t)
    seg_dport = get16(t + 2)
    seg_seq = get32(t + 4)
    seg_ack = get32(t + 8)
    seg_flags = load8(t + 13) & 63
    seg_wnd = get16(t + 14)
    seg_data = t + h
    seg_len = n - h
    seg_skip = 0
    tcp_options(t, h)
    c = now()
    if tcp_st == 0 or seg_dport != tcp_lport or (tcp_st != 1 and (src != tcp_rip or seg_sport != tcp_rport)):
        return tcp_rst()
    if tcp_st == 1:
        return tcp_in_listen(c)
    if tcp_st == 2:
        return tcp_in_syn_sent(c)
    return tcp_in_sync(c)
`,
};

