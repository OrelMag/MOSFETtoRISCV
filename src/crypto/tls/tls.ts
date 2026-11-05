// A TLS 1.3 client (RFC 8446) in the Python subset, for TLS_AES_128_GCM_SHA256 + x25519 + rsa_pss_rsae_sha256 with an RSA certificate.
//
// What it checks: record AEAD tags; the ServerHello's version, cipher, group and extensions (a HelloRetryRequest is refused); the order of the
// handshake messages; that the certificate holds an RSA key with e = 65537; that CertificateVerify is a valid RSASSA-PSS-SHA-256 signature, by that key,
// over the transcript; the server Finished; the client sends its Finished and switches to the application keys.
// What it does NOT check: the certificate itself. There is no chain building, no signature check on the certificate, no validity dates, no host name,
// no revocation, no extensions. Trust comes from ONE thing only: a pin, the SHA-256 of the server's SubjectPublicKeyInfo, compared with the one the
// harness configures (cfg.pinOn). With no pin the handshake authenticates nothing but "whoever holds the key in the certificate they sent" (anyone).
// Not done: client authentication, HelloRetryRequest, KeyUpdate, PSK / resumption / 0-RTT, alerts sent on failure (the client just stops and refuses to
// carry application data), sequence numbers above 2^32. The sequence number is 32 bits here.
// Entropy (client random, the x25519 private key) is injected through cfg; nothing here is constant-time. Teaching code for a simulator.

import type { CryptoModule } from './index';
import { CFG, ERR, IO, MARK, MARK_END, MEM, secretAddr } from './layout';
import { STR, lab } from './strings';

const E = ERR;
const sec = secretAddr;
const m = (id: number): string => `    store32(${IO.mark}, ${id})`;
const mEnd = (id: number): string => m(id | MARK_END);
const HS_MAX = 24576;

export const TLS: CryptoModule = {
  name: 'tls',
  py: `# ---- tls 1.3 client ----
tls_st = 0
tls_err = 0
tls_alert = 0
rd_enc = 0
wr_enc = 0
rd_seq = 0
wr_seq = 0
hs_pos = 0
hs_end = 0
rec_type = 0
rec_len = 0
msg_type = 0
msg_len = 0
app_ptr = 0
app_left = 0

def be16(p):
    return (load8(p) << 8) | load8(p + 1)

def be24(p):
    return (load8(p) << 16) | (load8(p + 1) << 8) | load8(p + 2)

def put16(p, v):
    store8(p, v >> 8)
    store8(p + 1, v)
    return 0

def put24(p, v):
    store8(p, v >> 16)
    store8(p + 1, v >> 8)
    store8(p + 2, v)
    return 0

def io_send(p, n):
    store32(${IO.addr}, p)
    store32(${IO.len}, n)
    store32(${IO.send}, 1)
    return 0

# n bytes from the peer, fewer only at end of stream: the count
def io_recv(p, n):
    store32(${IO.addr}, p)
    store32(${IO.len}, n)
    store32(${MEM.ioRes}, 0)
    store32(${IO.recv}, 1)
    return load32(${MEM.ioRes})

def fail(e):
    global tls_st, tls_err
    tls_st = 3
    tls_err = e
    return e

# nonce = iv xor the 64-bit big-endian sequence number (only its low 32 bits are ever nonzero here)
def make_nonce(iv, seq):
    mem_copy(${MEM.nonce}, iv, 12)
    for i in range(4):
        store8(${MEM.nonce} + 8 + i, load8(${MEM.nonce} + 8 + i) ^ (seq >> (24 - 8 * i)))
    return 0

# one record into MEM.recBuf; rec_type and rec_len describe its content (after decryption and padding removal when keys are on). A change_cipher_spec is skipped (RFC 8446 D.4)
def rec_read():
    global rec_type, rec_len, rd_seq, tls_alert
    skips = 0
    while 1:
        if io_recv(${MEM.recBuf}, 5) != 5:
            return ${E.io}
        typ = load8(${MEM.recBuf})
        n = be16(${MEM.recBuf} + 3)
        if load8(${MEM.recBuf} + 1) != 3 or n > 16640:
            return ${E.record}
        if io_recv(${MEM.recBuf} + 5, n) != n:
            return ${E.io}
        if typ == 20 and n == 1 and load8(${MEM.recBuf} + 5) == 1 and skips < 4:
            skips += 1
            continue
        break
    if typ == 21 and rd_enc == 0:
        if n >= 2:
            tls_alert = load8(${MEM.recBuf} + 6)
        return ${E.alert}
    if rd_enc == 0:
        rec_type = typ
        rec_len = n
        return 0
    if typ != 23 or n < 17:
        return ${E.record}
    make_nonce(${MEM.rdIv}, rd_seq)
${m(MARK.pGcmOpen)}
    ok = gcm_open(${MEM.rdCtx}, ${MEM.nonce}, ${MEM.recBuf}, 5, ${MEM.recBuf} + 5, n - 16, ${MEM.recBuf} + 5)
${mEnd(MARK.pGcmOpen)}
    if ok == 0:
        return ${E.mac}
    rd_seq += 1
    n -= 16
    while n > 0 and load8(${MEM.recBuf} + 4 + n) == 0:
        n -= 1
    if n == 0:
        return ${E.record}
    rec_type = load8(${MEM.recBuf} + 4 + n)
    rec_len = n - 1
    if rec_len > 16384:
        return ${E.record}
    return 0

# a record of this type and n bytes at p (n <= 16384), sealed when the write keys are on
def rec_send(typ, p, n):
    global wr_seq
    sb = ${MEM.sendBuf}
    store8(sb, typ)
    store8(sb + 1, 3)
    if wr_enc == 0:
        store8(sb + 2, 1)
        put16(sb + 3, n)
        mem_copy(sb + 5, p, n)
        io_send(sb, n + 5)
        return 0
    store8(sb + 2, 3)
    store8(sb, 23)
    put16(sb + 3, n + 17)
    mem_copy(sb + 5, p, n)
    store8(sb + 5 + n, typ)
    make_nonce(${MEM.wrIv}, wr_seq)
${m(MARK.pGcmSeal)}
    gcm_seal(${MEM.wrCtx}, ${MEM.nonce}, sb, 5, sb + 5, n + 1, sb + 5)
${mEnd(MARK.pGcmSeal)}
    wr_seq += 1
    io_send(sb, n + 22)
    return 0

# at least need bytes of handshake data past hs_pos in MEM.hsBuf, reading handshake records (the buffer is compacted when full)
def hs_fill(need):
    global hs_pos, hs_end, tls_alert
    while hs_end - hs_pos < need:
        e = rec_read()
        if e != 0:
            return e
        if rec_type == 21:
            if rec_len >= 2:
                tls_alert = load8(${MEM.recBuf} + 6)
            return ${E.alert}
        if rec_type != 22 or rec_len == 0:
            return ${E.record}
        if hs_end + rec_len > ${HS_MAX}:
            mem_copy(${MEM.hsBuf}, ${MEM.hsBuf} + hs_pos, hs_end - hs_pos)
            hs_end -= hs_pos
            hs_pos = 0
            if hs_end + rec_len > ${HS_MAX}:
                return ${E.record}
        mem_copy(${MEM.hsBuf} + hs_end, ${MEM.recBuf} + 5, rec_len)
        hs_end += rec_len
    return 0

# the next handshake message (not consumed): msg_type, msg_len; its body is at MEM.hsBuf + hs_pos + 4
def hs_next():
    global msg_type, msg_len
    e = hs_fill(4)
    if e != 0:
        return e
    msg_type = load8(${MEM.hsBuf} + hs_pos)
    msg_len = be24(${MEM.hsBuf} + hs_pos + 1)
    if msg_len > ${HS_MAX - 4}:
        return ${E.message}
    return hs_fill(4 + msg_len)

# consume the message: it joins the transcript
def hs_done():
    global hs_pos
    sha_update(${MEM.th}, ${MEM.hsBuf} + hs_pos, 4 + msg_len)
    hs_pos += 4 + msg_len
    return 0

# the transcript hash so far, without ending it
def th_snap(out):
    mem_copy(${MEM.thTmp}, ${MEM.th}, 104)
    sha_final(${MEM.thTmp}, out)
    return 0

# HKDF-Expand-Label(secret, label, "", len) into out
def label0(secret, labp, labn, out, ln):
    hkdf_label(secret, labp, labn, ${MEM.zero32}, 0, out, ln)
    return 0

# write key / iv of a traffic secret
def traffic_keys(secret, keyp, ivp):
    label0(secret, ${lab(STR.key)}, keyp, 16)
    label0(secret, ${lab(STR.iv)}, ivp, 12)
    return 0

# the ClientHello from the injected configuration, with the key_share between its two extension blobs; returns its length
def ch_build():
    q = ${MEM.chBuf}
    c = ${MEM.cfg}
    store8(q, 1)
    store8(q + 4, 3)
    store8(q + 5, 3)
    mem_copy(q + 6, c + ${CFG.random}, 32)
    p = q + 38
    n = load32(c + ${CFG.sidLen})
    store8(p, n)
    mem_copy(p + 1, c + ${CFG.sid}, n)
    p += 1 + n
    n = load32(c + ${CFG.csLen})
    put16(p, n)
    mem_copy(p + 2, c + ${CFG.cs}, n)
    p += 2 + n
    store8(p, 1)
    store8(p + 1, 0)
    p += 4
    ext = p
    n = load32(c + ${CFG.preLen})
    mem_copy(p, c + ${CFG.pre}, n)
    p += n
    put16(p, 51)
    put16(p + 2, 38)
    put16(p + 4, 36)
    put16(p + 6, 29)
    put16(p + 8, 32)
    mem_copy(p + 10, ${sec('client_pub')}, 32)
    p += 42
    n = load32(c + ${CFG.postLen})
    mem_copy(p, c + ${CFG.post}, n)
    p += n
    put16(ext - 2, p - ext)
    put24(q + 1, p - q - 4)
    return p - q

def hs_client_hello():
${m(MARK.phClientHello)}
    mem_zero(${MEM.basePoint}, 32)
    store8(${MEM.basePoint}, 9)
${m(MARK.pX25519)}
    x25519(${sec('client_pub')}, ${MEM.cfg + CFG.priv}, ${MEM.basePoint})
${mEnd(MARK.pX25519)}
    n = ch_build()
    sha_init(${MEM.th})
    sha_update(${MEM.th}, ${MEM.chBuf}, n)
    rec_send(22, ${MEM.chBuf}, n)
    return 0

# the ServerHello's extensions: supported_versions = TLS 1.3 and an x25519 key_share, nothing else
def sh_exts(p, end):
    got = 0
    while p < end:
        t = be16(p)
        l = be16(p + 2)
        p += 4
        if p + l > end:
            return ${E.hello}
        if t == 43:
            if l != 2 or be16(p) != 772:
                return ${E.hello}
            got |= 1
        elif t == 51:
            if l != 36 or be16(p) != 29 or be16(p + 2) != 32:
                return ${E.hello}
            mem_copy(${sec('server_pub')}, p + 4, 32)
            got |= 2
        else:
            return ${E.hello}
        p += l
    if got != 3:
        return ${E.hello}
    return 0

def hs_server_hello():
${m(MARK.phServerHello)}
    e = hs_next()
    if e != 0:
        return e
    if msg_type != 2:
        return ${E.message}
    p = ${MEM.hsBuf} + hs_pos + 4
    end = p + msg_len
    if msg_len < 40 or be16(p) != 771:
        return ${E.hello}
    if mem_eq(p + 2, ${STR.hrr.addr}, 32) == 1:
        return ${E.hrr}
    p += 34
    n = load8(p)
    if n != load32(${MEM.cfg + CFG.sidLen}) or mem_eq(p + 1, ${MEM.cfg + CFG.sid}, n) == 0:
        return ${E.hello}
    p += 1 + n
    if end - p < 7 or be16(p) != 4865 or load8(p + 2) != 0:
        return ${E.hello}
    p += 3
    n = be16(p)
    p += 2
    if p + n != end:
        return ${E.hello}
    e = sh_exts(p, end)
    if e != 0:
        return e
    hs_done()
    if hs_pos != hs_end:
        return ${E.message}
    th_snap(${sec('h_hello')})
${m(MARK.sHelloHash)}
    return 0

# the key schedule up to the handshake traffic keys (RFC 8446 7.1); installs the read keys
def hs_schedule():
    global rd_enc, rd_seq
${m(MARK.phKeyAgree)}
${m(MARK.pX25519)}
    x25519(${sec('shared')}, ${MEM.cfg + CFG.priv}, ${sec('server_pub')})
${mEnd(MARK.pX25519)}
${m(MARK.sShared)}
    if mem_nonzero(${sec('shared')}, 32) == 0:
        return ${E.x25519}
${m(MARK.pHkdf)}
    sha256(${MEM.zero32}, 0, ${sec('h_empty')})
    hkdf_extract(${MEM.zero32}, 0, ${MEM.zero32}, 32, ${sec('early')})
    derive_secret(${sec('early')}, ${lab(STR.derived)}, ${sec('h_empty')}, ${sec('derived1')})
    hkdf_extract(${sec('derived1')}, 32, ${sec('shared')}, 32, ${sec('handshake')})
    derive_secret(${sec('handshake')}, ${lab(STR.cHs)}, ${sec('h_hello')}, ${sec('c_hs')})
    derive_secret(${sec('handshake')}, ${lab(STR.sHs)}, ${sec('h_hello')}, ${sec('s_hs')})
    derive_secret(${sec('handshake')}, ${lab(STR.derived)}, ${sec('h_empty')}, ${sec('derived2')})
    hkdf_extract(${sec('derived2')}, 32, ${MEM.zero32}, 32, ${sec('master')})
    traffic_keys(${sec('c_hs')}, ${sec('c_hs_key')}, ${sec('c_hs_iv')})
    traffic_keys(${sec('s_hs')}, ${sec('s_hs_key')}, ${sec('s_hs_iv')})
    label0(${sec('c_hs')}, ${lab(STR.finished)}, ${sec('c_fin_key')}, 32)
    label0(${sec('s_hs')}, ${lab(STR.finished)}, ${sec('s_fin_key')}, 32)
${mEnd(MARK.pHkdf)}
    gcm_setkey(${MEM.rdCtx}, ${sec('s_hs_key')})
    mem_copy(${MEM.rdIv}, ${sec('s_hs_iv')}, 12)
    rd_seq = 0
    rd_enc = 1
${m(MARK.sSecretsHs)}
    return 0

# Certificate: the first entry's key; the pin if one is set
def tls_cert(p, n):
    if n < 12 or load8(p) != 0 or be24(p + 1) + 4 != n:
        return ${E.cert}
    cl = be24(p + 4)
    if cl < 16 or cl + 7 > n:
        return ${E.cert}
    if x509_key(p + 7, cl) != 0:
        return ${E.cert}
    if load32(${MEM.cfg + CFG.pinOn}) != 0:
        sha256(x_spki, x_spkilen, ${MEM.scratch + 512})
        if mem_eq(${MEM.scratch + 512}, ${MEM.cfg + CFG.pin}, 32) == 0:
            return ${E.pin}
    return 0

# CertificateVerify: rsa_pss_rsae_sha256 over 64 spaces, the context string, 0, and the transcript hash up to the Certificate
def tls_certverify(p, n):
    if n < 4 or be16(p) != 2052:
        return ${E.sig}
    sl = be16(p + 2)
    if sl + 4 != n:
        return ${E.sig}
    mem_copy(${MEM.scratch}, ${STR.cvPrefix.addr}, 98)
    mem_copy(${MEM.scratch + 98}, ${sec('h_cert')}, 32)
${m(MARK.pRsa)}
    ok = rsa_pss_verify(${MEM.certN}, x_nlen, p + 4, sl, ${MEM.scratch}, 130)
${mEnd(MARK.pRsa)}
    if ok == 0:
        return ${E.sig}
    return 0

# the next message must be of this type
def expect(t):
    e = hs_next()
    if e != 0:
        return e
    if msg_type == 13:
        return ${E.unsupported}
    if msg_type != t:
        return ${E.message}
    return 0

def hs_server_flight():
${m(MARK.phEncExt)}
    e = expect(8)
    if e != 0:
        return e
    hs_done()
${m(MARK.phCert)}
    e = expect(11)
    if e != 0:
        return e
    e = tls_cert(${MEM.hsBuf} + hs_pos + 4, msg_len)
    if e != 0:
        return e
    hs_done()
    th_snap(${sec('h_cert')})
${m(MARK.sCertHash)}
${m(MARK.phCertVerify)}
    e = expect(15)
    if e != 0:
        return e
    e = tls_certverify(${MEM.hsBuf} + hs_pos + 4, msg_len)
    if e != 0:
        return e
    hs_done()
    th_snap(${sec('h_cv')})
${m(MARK.sCvHash)}
${m(MARK.phServerFinished)}
    e = expect(20)
    if e != 0:
        return e
${m(MARK.pHmac)}
    hmac(${sec('s_fin_key')}, 32, ${sec('h_cv')}, 32, ${sec('s_verify')})
${mEnd(MARK.pHmac)}
    if msg_len != 32 or mem_eq(${sec('s_verify')}, ${MEM.hsBuf} + hs_pos + 4, 32) == 0:
        return ${E.finished}
    hs_done()
    th_snap(${sec('h_fin')})
    if hs_pos != hs_end:
        return ${E.message}
${m(MARK.sFinHash)}
    return 0

# application secrets from the transcript through the server Finished; the exporter master too
def ap_schedule():
${m(MARK.pHkdf)}
    derive_secret(${sec('master')}, ${lab(STR.cAp)}, ${sec('h_fin')}, ${sec('c_ap')})
    derive_secret(${sec('master')}, ${lab(STR.sAp)}, ${sec('h_fin')}, ${sec('s_ap')})
    derive_secret(${sec('master')}, ${lab(STR.exp)}, ${sec('h_fin')}, ${sec('exp_master')})
    traffic_keys(${sec('c_ap')}, ${sec('c_ap_key')}, ${sec('c_ap_iv')})
    traffic_keys(${sec('s_ap')}, ${sec('s_ap_key')}, ${sec('s_ap_iv')})
${mEnd(MARK.pHkdf)}
${m(MARK.sSecretsAp)}
    return 0

def hs_client_finished():
    global wr_enc, wr_seq, rd_seq
${m(MARK.phClientFinished)}
    ap_schedule()
    gcm_setkey(${MEM.wrCtx}, ${sec('c_hs_key')})
    mem_copy(${MEM.wrIv}, ${sec('c_hs_iv')}, 12)
    wr_seq = 0
    wr_enc = 1
    f = ${MEM.finBuf}
    store8(f, 20)
    put24(f + 1, 32)
${m(MARK.pHmac)}
    hmac(${sec('c_fin_key')}, 32, ${sec('h_fin')}, 32, f + 4)
${mEnd(MARK.pHmac)}
    mem_copy(${sec('c_verify')}, f + 4, 32)
    sha_update(${MEM.th}, f, 36)
    th_snap(${sec('h_cfin')})
    derive_secret(${sec('master')}, ${lab(STR.res)}, ${sec('h_cfin')}, ${sec('res_master')})
    rec_send(22, f, 36)
${m(MARK.sClientFin)}
    gcm_setkey(${MEM.wrCtx}, ${sec('c_ap_key')})
    mem_copy(${MEM.wrIv}, ${sec('c_ap_iv')}, 12)
    wr_seq = 0
    gcm_setkey(${MEM.rdCtx}, ${sec('s_ap_key')})
    mem_copy(${MEM.rdIv}, ${sec('s_ap_iv')}, 12)
    rd_seq = 0
    return 0

def tls_handshake():
    global tls_st, tls_err, rd_enc, wr_enc, rd_seq, wr_seq, hs_pos, hs_end, app_left
    tls_st = 1
    tls_err = 0
    rd_enc = 0
    wr_enc = 0
    rd_seq = 0
    wr_seq = 0
    hs_pos = 0
    hs_end = 0
    app_left = 0
    e = hs_client_hello()
    if e == 0:
        e = hs_server_hello()
    if e == 0:
        e = hs_schedule()
    if e == 0:
        e = hs_server_flight()
    if e == 0:
        e = hs_client_finished()
    if e != 0:
        return fail(e)
${m(MARK.phEnd)}
    tls_st = 2
    return 0

# application data out: n bytes in records of at most 16384
def tls_send(p, n):
    if tls_st != 2:
        return 0 - ${E.state}
    done = 0
    while done < n:
        k = n - done
        if k > 16384:
            k = 16384
        rec_send(23, p + done, k)
        done += k
    return n

# post-handshake handshake messages in the current record: NewSessionTicket (4) is skipped; anything else (KeyUpdate included) stops the connection
def post_hs():
    p = ${MEM.recBuf} + 5
    end = p + rec_len
    while p < end:
        if end - p < 4 or load8(p) != 4:
            return ${E.unsupported}
        p += 4 + be24(p + 1)
    if p != end:
        return ${E.message}
    return 0

# up to max bytes of application data at p: the count; 0 when the peer closed (close_notify); negative: 0 - error code. Blocks for a record when none is pending
def tls_recv(p, mx):
    global app_ptr, app_left, tls_st, tls_alert
    if tls_st != 2 and tls_st != 5:
        if tls_st == 4:
            return 0
        return 0 - ${E.state}
    while app_left == 0:
        e = rec_read()
        if e != 0:
            return 0 - fail(e)
        if rec_type == 23:
            app_ptr = ${MEM.recBuf} + 5
            app_left = rec_len
        elif rec_type == 21:
            if rec_len == 2 and load8(${MEM.recBuf} + 6) == 0:
                tls_st = 4
                return 0
            tls_alert = load8(${MEM.recBuf} + 6)
            return 0 - fail(${E.alert})
        elif rec_type == 22:
            e = post_hs()
            if e != 0:
                return 0 - fail(e)
        else:
            return 0 - fail(${E.record})
    k = mx
    if k > app_left:
        k = app_left
    mem_copy(p, app_ptr, k)
    app_ptr += k
    app_left -= k
    return k

# close_notify out (state 5: nothing more is sent, the peer's last records can still be read; 4 is closed by the peer)
def tls_close():
    global tls_st
    if tls_st != 2:
        return 0 - ${E.state}
    store8(${MEM.scratch}, 1)
    store8(${MEM.scratch} + 1, 0)
    rec_send(21, ${MEM.scratch}, 2)
    tls_st = 5
    return 0
`,
};
