// Just enough DER (X.690) and X.509 (RFC 5280) to pull an RSA public key out of a certificate: Certificate / tbsCertificate / skip version, serial,
// signature algorithm, issuer, validity, subject / subjectPublicKeyInfo (kept whole: its SHA-256 is what a pin compares) / the rsaEncryption algorithm /
// the BIT STRING holding SEQUENCE { INTEGER n, INTEGER e }. It reads no names, dates, extensions or signatures: it does NOT validate the certificate.

import type { CryptoModule } from './index';
import { MEM } from './layout';
import { STR } from './strings';

export const X509: CryptoModule = {
  name: 'x509',
  py: `# ---- der / x509 public key ----
x_tag = 0
x_hdr = 0
x_len = 0
x_nlen = 0
x_spki = 0
x_spkilen = 0

# the TLV header at p, which must fit before end: sets x_tag, x_hdr (header bytes), x_len (content bytes); 0 ok, 1 malformed (long form up to 3 length bytes)
def der_hdr(p, end):
    global x_tag, x_hdr, x_len
    if end - p < 2:
        return 1
    tag = load8(p)
    ln = load8(p + 1)
    h = 2
    if (tag & 31) == 31:
        return 1
    if ln >= 128:
        k = ln - 128
        if k == 0 or k > 3 or end - p < 2 + k:
            return 1
        ln = 0
        for i in range(k):
            ln = (ln << 8) | load8(p + 2 + i)
        h = 2 + k
    if ln > end - p - h:
        return 1
    x_tag = tag
    x_hdr = h
    x_len = ln
    return 0

# the element at p must have this tag: the address just past it, or 0 (x_hdr and x_len describe it)
def der_next(p, end, tag):
    if der_hdr(p, end) != 0 or x_tag != tag:
        return 0
    return p + x_hdr + x_len

# cert: n bytes of DER. 0 and x_nlen / x_spki / x_spkilen set, with the modulus copied (leading zero dropped) to MEM.certN, if it is an RSA key with e = 65537; else 1
def x509_key(cert, n):
    global x_nlen, x_spki, x_spkilen
    end = cert + n
    q = der_next(cert, end, 48)
    if q == 0:
        return 1
    p = cert + x_hdr
    q = der_next(p, q, 48)
    if q == 0:
        return 1
    p += x_hdr
    tend = q
    if der_hdr(p, tend) == 0 and x_tag == 160:
        p = p + x_hdr + x_len
    p = der_next(p, tend, 2)
    if p == 0:
        return 1
    for i in range(4):
        p = der_next(p, tend, 48)
        if p == 0:
            return 1
    q = der_next(p, tend, 48)
    if q == 0:
        return 1
    x_spki = p
    x_spkilen = q - p
    return x509_spki(p + x_hdr, q)

# inside subjectPublicKeyInfo: AlgorithmIdentifier { rsaEncryption, ... }, BIT STRING { 0 unused bits, RSAPublicKey }
def x509_spki(p, send):
    q = der_next(p, send, 48)
    if q == 0 or x_len < 11:
        return 1
    if mem_eq(p + x_hdr, ${STR.oidRsa.addr}, 11) == 0:
        return 1
    p = q
    q = der_next(p, send, 3)
    if q == 0 or x_len < 1 or load8(p + x_hdr) != 0:
        return 1
    p = p + x_hdr + 1
    q = der_next(p, q, 48)
    if q == 0:
        return 1
    p += x_hdr
    e = der_next(p, q, 2)
    if e == 0 or x_len < 1:
        return 1
    return x509_nume(p + x_hdr, x_len, e, q)

# the modulus INTEGER at np (nl bytes), then the exponent INTEGER at e (to q): 65537 only
def x509_nume(np, nl, e, q):
    global x_nlen
    if load8(np) == 0 and nl > 1:
        np += 1
        nl -= 1
    if nl < 16 or nl > 512 or load8(np) == 0:
        return 1
    mem_copy(${MEM.certN}, np, nl)
    x_nlen = nl
    f = der_next(e, q, 2)
    if f != q or x_len != 3:
        return 1
    if load8(e + x_hdr) != 1 or load8(e + x_hdr + 1) != 0 or load8(e + x_hdr + 2) != 1:
        return 1
    return 0
`,
};
