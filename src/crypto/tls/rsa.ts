// RSASSA-PSS verification with SHA-256 (RFC 8017 sections 8.1.2, 9.1.2, B.2.1) for e = 65537, in the Python subset: what TLS 1.3's rsa_pss_rsae_sha256
// signature scheme needs from a client (the salt is as long as the hash, 32 bytes, as RFC 8446 section 4.2.3 requires).
// Bignums are arrays of 8-bit limbs, least significant first, one limb per RAM word (a limb product is below 2^16, a row of them below 2^31). The modular
// product is Montgomery's (CIOS, the two inner loops fused): s^65537 is 16 squarings and one multiplication, in the Montgomery domain. Entering it needs
// s * 256^k mod n, which is k * 8 doublings with a trial subtraction (no division anywhere).

import type { CryptoModule } from './index';
import { MEM } from './layout';

export const RSA: CryptoModule = {
  name: 'rsa',
  py: `# ---- rsa-pss verify ----
rsa_n0 = 0

# big-endian bytes -> n limbs, least significant first
def rsa_load(dst, src, n):
    for j in range(n):
        store32(dst + 4 * j, load8(src + n - 1 - j))
    return 0

# 1 if the s-limb number at x is >= n
def rsa_ge(x, s):
    j = s - 1
    while j >= 0:
        a = load32(x + 4 * j)
        b = load32(${MEM.rsaN} + 4 * j)
        if a != b:
            if a > b:
                return 1
            return 0
        j -= 1
    return 1

# x = 2x mod n for x < n: the doubled limbs and the trial difference in one pass, then the one that fits
def rsa_dbl(x, s):
    c = 0
    b = 0
    for j in range(s):
        v = (load32(x + 4 * j) << 1) + c
        lo = v & 255
        c = v >> 8
        w = lo - load32(${MEM.rsaN} + 4 * j) - b
        store32(${MEM.rsaT} + 4 * j, lo)
        store32(${MEM.rsaU} + 4 * j, w & 255)
        b = (w >> 8) & 1
    src = ${MEM.rsaT}
    if c != 0 or b == 0:
        src = ${MEM.rsaU}
    for j in range(s):
        store32(x + 4 * j, load32(src + 4 * j))
    return 0

# r = a * b / 256^s mod n (Montgomery, n0 = -1/n mod 256). T has s + 1 limbs and stays below 2n; one trial subtraction at the end. r may be a or b.
# While loops with pointers: the compiler keeps a function's variables in registers, 20 at most in a leaf, and a for loop costs two of them
def mont_mul(r, a, b, s):
    i = 0
    while i <= s:
        store32(${MEM.rsaT} + 4 * i, 0)
        i += 1
    np0 = load32(${MEM.rsaN})
    i = 0
    while i < s:
        bi = load32(b + 4 * i)
        v = load32(${MEM.rsaT}) + load32(a) * bi
        m = ((v & 255) * rsa_n0) & 255
        c = (v + m * np0) >> 8
        pt = ${MEM.rsaT} + 4
        pa = a + 4
        pn = ${MEM.rsaN} + 4
        pe = ${MEM.rsaT} + 4 * s
        while pt < pe:
            v = load32(pt) + load32(pa) * bi + load32(pn) * m + c
            store32(pt - 4, v & 255)
            c = v >> 8
            pt += 4
            pa += 4
            pn += 4
        v = load32(pe) + c
        store32(pe - 4, v & 255)
        store32(pe, v >> 8)
        i += 1
    m = load32(${MEM.rsaT} + 4 * s)
    if m == 0:
        i = s - 1
        while i >= 0:
            v = load32(${MEM.rsaT} + 4 * i)
            c = load32(${MEM.rsaN} + 4 * i)
            if v != c:
                if v > c:
                    m = 1
                break
            i -= 1
        if i < 0:
            m = 1
    i = 0
    c = 0
    if m != 0:
        while i < s:
            v = load32(${MEM.rsaT} + 4 * i) - load32(${MEM.rsaN} + 4 * i) - c
            store32(r + 4 * i, v & 255)
            c = (v >> 8) & 1
            i += 1
    else:
        while i < s:
            store32(r + 4 * i, load32(${MEM.rsaT} + 4 * i))
            i += 1
    return 0

# x = x * 256^s mod n: 8s doublings
def rsa_to_mont(x, s):
    k = 8 * s
    while k > 0:
        rsa_dbl(x, s)
        k -= 1
    return 0

def rsa_copy(dst, src, s):
    for j in range(s):
        store32(dst + 4 * j, load32(src + 4 * j))
    return 0

# y = y^(2^16) * x (65537 = 2^16 + 1), then out of the Montgomery domain: y * 1 / 256^s
def rsa_exp(y, x, s):
    k = 16
    while k > 0:
        mont_mul(y, y, y, s)
        k -= 1
    mont_mul(y, y, x, s)
    store32(${MEM.rsaM}, 1)
    for j in range(1, s):
        store32(${MEM.rsaM} + 4 * j, 0)
    mont_mul(y, y, ${MEM.rsaM}, s)
    return 0

# out = sig^65537 mod n as nn big-endian bytes. n (nn bytes, top byte nonzero, odd) and sig (nn bytes) are big-endian. 0 if sig >= n or n is unusable
def rsa_pub(sigp, sn, np, nn, out):
    global rsa_n0
    if nn < 16 or nn > 512 or sn != nn:
        return 0
    if load8(np) == 0 or (load8(np + nn - 1) & 1) == 0:
        return 0
    rsa_load(${MEM.rsaN}, np, nn)
    rsa_load(${MEM.rsaX}, sigp, nn)
    if rsa_ge(${MEM.rsaX}, nn) == 1:
        return 0
    n0 = load8(np + nn - 1)
    inv = n0
    for i in range(4):
        inv = (inv * (2 - n0 * inv)) & 255
    rsa_n0 = (0 - inv) & 255
    rsa_to_mont(${MEM.rsaX}, nn)
    rsa_copy(${MEM.rsaY}, ${MEM.rsaX}, nn)
    rsa_exp(${MEM.rsaY}, ${MEM.rsaX}, nn)
    for j in range(nn):
        store8(out + nn - 1 - j, load32(${MEM.rsaY} + 4 * j))
    return 1

# MGF1 with SHA-256 (RFC 8017 B.2.1): masklen bytes at out from a seed of seedlen (<= 60) bytes
def mgf1(seed, seedlen, out, masklen):
    b = ${MEM.pssBuf}
    done = 0
    ctr = 0
    while done < masklen:
        mem_copy(b, seed, seedlen)
        store8(b + seedlen, ctr >> 24)
        store8(b + seedlen + 1, ctr >> 16)
        store8(b + seedlen + 2, ctr >> 8)
        store8(b + seedlen + 3, ctr)
        sha256(b, seedlen + 4, b + 64)
        k = masklen - done
        if k > 32:
            k = 32
        mem_copy(out + done, b + 64, k)
        done += k
        ctr += 1
    return 0

def mem_xor(dst, src, n):
    for i in range(n):
        store8(dst + i, load8(dst + i) ^ load8(src + i))
    return 0

# 1 if any of the n bytes is nonzero
def mem_nonzero(p, n):
    for i in range(n):
        if load8(p + i) != 0:
            return 1
    return 0

# the checks on DB = maskedDB xor MGF1(H): its top bits clear, zero padding, a 0x01, then the salt; 1 if they hold
def pss_db(em, emlen, embits):
    dblen = emlen - 33
    top = 8 * emlen - embits
    if top > 0 and (load8(em) >> (8 - top)) != 0:
        return 0
    mgf1(em + dblen, 32, ${MEM.rsaDb}, dblen)
    mem_xor(${MEM.rsaDb}, em, dblen)
    if top > 0:
        store8(${MEM.rsaDb}, load8(${MEM.rsaDb}) & (255 >> top))
    ps = emlen - 66
    if mem_nonzero(${MEM.rsaDb}, ps) != 0:
        return 0
    if load8(${MEM.rsaDb} + ps) != 1:
        return 0
    return 1

# EMSA-PSS-VERIFY (RFC 8017 9.1.2), SHA-256, salt length 32: em is emlen bytes, embits = modBits - 1
def pss_verify(mhash, em, emlen, embits):
    if emlen < 66:
        return 0
    if load8(em + emlen - 1) != 188:
        return 0
    if pss_db(em, emlen, embits) == 0:
        return 0
    b = ${MEM.pssBuf} + 128
    mem_zero(b, 8)
    mem_copy(b + 8, mhash, 32)
    mem_copy(b + 40, ${MEM.rsaDb} + emlen - 33 - 32, 32)
    sha256(b, 72, b + 80)
    return mem_eq(b + 80, em + emlen - 33, 32)

def bitlen8(b):
    n = 0
    while b > 0:
        n += 1
        b = b >> 1
    return n

# RSASSA-PSS-VERIFY with SHA-256 over the message at msgp: n and sig big-endian, 1 if valid
def rsa_pss_verify(np, nn, sigp, sn, msgp, msgn):
    sha256(msgp, msgn, ${MEM.pssBuf} + 224)
    if rsa_pub(sigp, sn, np, nn, ${MEM.rsaEm}) == 0:
        return 0
    embits = 8 * nn - 9 + bitlen8(load8(np))
    emlen = (embits + 7) >> 3
    if mem_nonzero(${MEM.rsaEm}, nn - emlen) != 0:
        return 0
    return pss_verify(${MEM.pssBuf} + 224, ${MEM.rsaEm} + nn - emlen, emlen, embits)
`,
};
