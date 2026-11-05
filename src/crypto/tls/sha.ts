// SHA-256 (FIPS 180-4), HMAC (RFC 2104 / 4231) and HKDF (RFC 5869) with HKDF-Expand-Label (RFC 8446 section 7.1) in the Python subset.
// A hash context is 104 bytes of RAM: eight state words, the byte count so far, a 64-byte block buffer. The message schedule is 64 words at MEM.shaW.
// `>>` is an arithmetic shift in the subset, so a rotate masks the bits the shift dragged in.

import type { CryptoModule } from './index';
import { MEM } from './layout';

/** FIPS 180-4 section 4.2.2: the 64 round constants. */
export const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
/** FIPS 180-4 section 5.3.3: the initial hash value. */
export const SHA256_H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (v: string, n: number): string => `(((${v} >> ${n}) & ${2 ** (32 - n) - 1}) | (${v} << ${32 - n}))`;
const shr = (v: string, n: number): string => `((${v} >> ${n}) & ${2 ** (32 - n) - 1})`;

export const SHA: CryptoModule = {
  name: 'sha',
  py: `# ---- sha-256, hmac, hkdf ----
def sha_init(c):
${SHA256_H0.map((v, i) => `    store32(c + ${4 * i}, ${v})`).join('\n')}
    store32(c + 32, 0)
    return 0

# W[0..15] from the block's bytes (big-endian), W[16..63] by the schedule
def sha_sched(p):
    for i in range(16):
        j = p + 4 * i
        store32(${MEM.shaW} + 4 * i, (load8(j) << 24) | (load8(j + 1) << 16) | (load8(j + 2) << 8) | load8(j + 3))
    for i in range(16, 64):
        x = load32(${MEM.shaW} + 4 * i - 60)
        y = load32(${MEM.shaW} + 4 * i - 8)
        s0 = ${rotr('x', 7)} ^ ${rotr('x', 18)} ^ ${shr('x', 3)}
        s1 = ${rotr('y', 17)} ^ ${rotr('y', 19)} ^ ${shr('y', 10)}
        store32(${MEM.shaW} + 4 * i, load32(${MEM.shaW} + 4 * i - 64) + s0 + load32(${MEM.shaW} + 4 * i - 28) + s1)
    return 0

def sha_rounds(c):
    a = load32(c)
    b = load32(c + 4)
    cc = load32(c + 8)
    d = load32(c + 12)
    e = load32(c + 16)
    f = load32(c + 20)
    g = load32(c + 24)
    h = load32(c + 28)
    for i in range(64):
        s1 = ${rotr('e', 6)} ^ ${rotr('e', 11)} ^ ${rotr('e', 25)}
        ch = (e & f) ^ (~e & g)
        t1 = h + s1 + ch + load32(${MEM.shaK} + 4 * i) + load32(${MEM.shaW} + 4 * i)
        s0 = ${rotr('a', 2)} ^ ${rotr('a', 13)} ^ ${rotr('a', 22)}
        mj = (a & b) ^ (a & cc) ^ (b & cc)
        h = g
        g = f
        f = e
        e = d + t1
        d = cc
        cc = b
        b = a
        a = t1 + s0 + mj
    store32(c, load32(c) + a)
    store32(c + 4, load32(c + 4) + b)
    store32(c + 8, load32(c + 8) + cc)
    store32(c + 12, load32(c + 12) + d)
    store32(c + 16, load32(c + 16) + e)
    store32(c + 20, load32(c + 20) + f)
    store32(c + 24, load32(c + 24) + g)
    store32(c + 28, load32(c + 28) + h)
    return 0

def sha_block(c, p):
    sha_sched(p)
    sha_rounds(c)
    return 0

# feed n bytes at p; the context keeps the partial block at c + 40
def sha_update(c, p, n):
    ln = load32(c + 32)
    store32(c + 32, ln + n)
    r = ln & 63
    if r != 0:
        k = 64 - r
        if n < k:
            k = n
        for i in range(k):
            store8(c + 40 + r + i, load8(p + i))
        p += k
        n -= k
        if r + k < 64:
            return 0
        sha_block(c, c + 40)
    while n >= 64:
        sha_block(c, p)
        p += 64
        n -= 64
    for i in range(n):
        store8(c + 40 + i, load8(p + i))
    return 0

# pad, finish, write the 32-byte digest at out (the context is spent)
def sha_final(c, out):
    ln = load32(c + 32)
    r = ln & 63
    store8(c + 40 + r, 128)
    r += 1
    if r > 56:
        for i in range(r, 64):
            store8(c + 40 + i, 0)
        sha_block(c, c + 40)
        r = 0
    for i in range(r, 56):
        store8(c + 40 + i, 0)
    hi = (ln >> 29) & 7
    lo = ln << 3
    for i in range(4):
        store8(c + 96 + i, hi >> (24 - 8 * i))
        store8(c + 100 + i, lo >> (24 - 8 * i))
    sha_block(c, c + 40)
    for i in range(8):
        w = load32(c + 4 * i)
        store8(out + 4 * i, w >> 24)
        store8(out + 4 * i + 1, w >> 16)
        store8(out + 4 * i + 2, w >> 8)
        store8(out + 4 * i + 3, w)
    return 0

def sha256(p, n, out):
    sha_init(${MEM.shaCtx})
    sha_update(${MEM.shaCtx}, p, n)
    sha_final(${MEM.shaCtx}, out)
    return 0

def mem_copy(dst, src, n):
    for i in range(n):
        store8(dst + i, load8(src + i))
    return 0

def mem_zero(dst, n):
    for i in range(n):
        store8(dst + i, 0)
    return 0

# 1 if the n bytes are equal, 0 if not (reads all of them: no early exit)
def mem_eq(a, b, n):
    d = 0
    for i in range(n):
        d |= load8(a + i) ^ load8(b + i)
    return 1 if d == 0 else 0

# HMAC-SHA-256: a key over 64 bytes is hashed first; K xor ipad, the message, then K xor opad over the inner digest
def hmac(kp, kn, mp, mn, out):
    if kn > 64:
        sha256(kp, kn, ${MEM.hmacKey})
        kn = 32
        kp = ${MEM.hmacKey}
    for i in range(64):
        k = 0
        if i < kn:
            k = load8(kp + i)
        store8(${MEM.hmacKey} + i, k)
    for i in range(64):
        store8(${MEM.hmacInner} + i, load8(${MEM.hmacKey} + i) ^ 54)
    sha_init(${MEM.hmacCtx})
    sha_update(${MEM.hmacCtx}, ${MEM.hmacInner}, 64)
    sha_update(${MEM.hmacCtx}, mp, mn)
    sha_final(${MEM.hmacCtx}, ${MEM.hkdfT + 32})
    for i in range(64):
        store8(${MEM.hmacInner} + i, load8(${MEM.hmacKey} + i) ^ 92)
    sha_init(${MEM.hmacCtx})
    sha_update(${MEM.hmacCtx}, ${MEM.hmacInner}, 64)
    sha_update(${MEM.hmacCtx}, ${MEM.hkdfT + 32}, 32)
    sha_final(${MEM.hmacCtx}, out)
    return 0

# RFC 5869 2.2: PRK = HMAC(salt, IKM); no salt is HashLen zero bytes
def hkdf_extract(sp, sn, ip, inn, out):
    if sn == 0:
        mem_zero(${MEM.zero32}, 32)
        sp = ${MEM.zero32}
        sn = 32
    hmac(sp, sn, ip, inn, out)
    return 0

# RFC 5869 2.3: T(i) = HMAC(PRK, T(i-1) | info | i); L bytes at out (L up to 255 * 32; out needs room for L rounded up to a multiple of 32 only if L is)
def hkdf_expand(prk, ip, inn, out, ln):
    tn = 0
    done = 0
    i = 1
    while done < ln:
        m = ${MEM.hmacMsg}
        mem_copy(m, ${MEM.hkdfT}, tn)
        mem_copy(m + tn, ip, inn)
        store8(m + tn + inn, i)
        hmac(prk, 32, m, tn + inn + 1, ${MEM.hkdfT})
        tn = 32
        k = ln - done
        if k > 32:
            k = 32
        mem_copy(out + done, ${MEM.hkdfT}, k)
        done += k
        i += 1
    return 0

# RFC 8446 7.1: HkdfLabel = uint16 length | opaque label<7..255> = "tls13 " + Label | opaque context<0..255>
def hkdf_label(secret, labp, labn, ctxp, ctxn, out, ln):
    q = ${MEM.hkdfInfo}
    store8(q, ln >> 8)
    store8(q + 1, ln)
    store8(q + 2, labn + 6)
    store8(q + 3, 116)
    store8(q + 4, 108)
    store8(q + 5, 115)
    store8(q + 6, 49)
    store8(q + 7, 51)
    store8(q + 8, 32)
    mem_copy(q + 9, labp, labn)
    store8(q + 9 + labn, ctxn)
    mem_copy(q + 10 + labn, ctxp, ctxn)
    hkdf_expand(secret, q, 10 + labn + ctxn, out, ln)
    return 0

# Derive-Secret(secret, label, transcript hash) = HKDF-Expand-Label(secret, label, hash, 32)
def derive_secret(secret, labp, labn, hashp, out):
    hkdf_label(secret, labp, labn, hashp, 32, out, 32)
    return 0
`,
};
