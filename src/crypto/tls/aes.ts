// AES-128 (FIPS 197) and AES-128-GCM (NIST SP 800-38D, McGrew and Viega's "The Galois/Counter Mode of Operation") in the Python subset.
// The S-box is computed at start-up (a multiplicative inverse by walking the powers of 3, then the affine map): 256 bytes at MEM.sbox, no table in the program.
// A key context is 192 bytes: the 11 round keys (176) and the hash subkey H = E(0) (16). GHASH multiplies bit by bit (128 steps on four words): small, not fast.

import type { CryptoModule } from './index';
import { MEM } from './layout';

const S = MEM.aesState, T = MEM.aesTmp, W = MEM.gcmWork;

export const AES: CryptoModule = {
  name: 'aes',
  py: `# ---- aes-128 and gcm ----
def aes_init():
    p = 1
    q = 1
    while 1:
        p = (p ^ (p << 1) ^ ((p >> 7) * 27)) & 255
        q = q ^ (q << 1)
        q = q ^ (q << 2)
        q = q ^ (q << 4)
        q = q & 255
        if q >= 128:
            q = q ^ 9
        x = q ^ (((q << 1) | (q >> 7)) & 255) ^ (((q << 2) | (q >> 6)) & 255) ^ (((q << 3) | (q >> 5)) & 255) ^ (((q << 4) | (q >> 4)) & 255)
        store8(${MEM.sbox} + p, x ^ 99)
        if p == 1:
            break
    store8(${MEM.sbox}, 99)
    return 0

# 11 round keys of 16 bytes at rk from the 16-byte key
def aes_expand(key, rk):
    mem_copy(rk, key, 16)
    rcon = 1
    for i in range(4, 44):
        t0 = load8(rk + 4 * i - 4)
        t1 = load8(rk + 4 * i - 3)
        t2 = load8(rk + 4 * i - 2)
        t3 = load8(rk + 4 * i - 1)
        if (i & 3) == 0:
            tmp = t0
            t0 = load8(${MEM.sbox} + t1) ^ rcon
            t1 = load8(${MEM.sbox} + t2)
            t2 = load8(${MEM.sbox} + t3)
            t3 = load8(${MEM.sbox} + tmp)
            rcon = ((rcon << 1) ^ ((rcon >> 7) * 27)) & 255
        store8(rk + 4 * i, load8(rk + 4 * i - 16) ^ t0)
        store8(rk + 4 * i + 1, load8(rk + 4 * i - 15) ^ t1)
        store8(rk + 4 * i + 2, load8(rk + 4 * i - 14) ^ t2)
        store8(rk + 4 * i + 3, load8(rk + 4 * i - 13) ^ t3)
    return 0

# MixColumns of the temporary into the state, with AddRoundKey k
def aes_mix(k):
    for c in range(4):
        a0 = load8(${T} + 4 * c)
        a1 = load8(${T} + 4 * c + 1)
        a2 = load8(${T} + 4 * c + 2)
        a3 = load8(${T} + 4 * c + 3)
        t = a0 ^ a1 ^ a2 ^ a3
        x0 = a0 ^ a1
        x1 = a1 ^ a2
        x2 = a2 ^ a3
        x3 = a3 ^ a0
        store8(${S} + 4 * c, a0 ^ t ^ ((x0 << 1) ^ ((x0 >> 7) * 27)) ^ load8(k + 4 * c))
        store8(${S} + 4 * c + 1, a1 ^ t ^ ((x1 << 1) ^ ((x1 >> 7) * 27)) ^ load8(k + 4 * c + 1))
        store8(${S} + 4 * c + 2, a2 ^ t ^ ((x2 << 1) ^ ((x2 >> 7) * 27)) ^ load8(k + 4 * c + 2))
        store8(${S} + 4 * c + 3, a3 ^ t ^ ((x3 << 1) ^ ((x3 >> 7) * 27)) ^ load8(k + 4 * c + 3))
    return 0

# one block: state s[r + 4c]; SubBytes + ShiftRows into a temporary, then MixColumns (not in the last round) and AddRoundKey
def aes_encrypt(rk, inp, out):
    for i in range(16):
        store8(${S} + i, load8(inp + i) ^ load8(rk + i))
    for rnd in range(1, 11):
        for i in range(16):
            r = i & 3
            store8(${T} + i, load8(${MEM.sbox} + load8(${S} + r + ((((i >> 2) + r) & 3) << 2))))
        k = rk + 16 * rnd
        if rnd < 10:
            aes_mix(k)
        else:
            for i in range(16):
                store8(${S} + i, load8(${T} + i) ^ load8(k + i))
    for i in range(16):
        store8(out + i, load8(${S} + i))
    return 0

# y = y * h in GF(2^128), GCM's bit order (the leftmost bit of the block is the coefficient of x^0): 128 shift-and-add steps
def ghash_mul(y, h):
    x0 = (load8(y) << 24) | (load8(y + 1) << 16) | (load8(y + 2) << 8) | load8(y + 3)
    x1 = (load8(y + 4) << 24) | (load8(y + 5) << 16) | (load8(y + 6) << 8) | load8(y + 7)
    x2 = (load8(y + 8) << 24) | (load8(y + 9) << 16) | (load8(y + 10) << 8) | load8(y + 11)
    x3 = (load8(y + 12) << 24) | (load8(y + 13) << 16) | (load8(y + 14) << 8) | load8(y + 15)
    v0 = (load8(h) << 24) | (load8(h + 1) << 16) | (load8(h + 2) << 8) | load8(h + 3)
    v1 = (load8(h + 4) << 24) | (load8(h + 5) << 16) | (load8(h + 6) << 8) | load8(h + 7)
    v2 = (load8(h + 8) << 24) | (load8(h + 9) << 16) | (load8(h + 10) << 8) | load8(h + 11)
    v3 = (load8(h + 12) << 24) | (load8(h + 13) << 16) | (load8(h + 14) << 8) | load8(h + 15)
    z0 = 0
    z1 = 0
    z2 = 0
    z3 = 0
    for i in range(128):
        if x0 < 0:
            z0 ^= v0
            z1 ^= v1
            z2 ^= v2
            z3 ^= v3
        x0 = (x0 << 1) | ((x1 >> 31) & 1)
        x1 = (x1 << 1) | ((x2 >> 31) & 1)
        x2 = (x2 << 1) | ((x3 >> 31) & 1)
        x3 = x3 << 1
        lsb = v3 & 1
        v3 = ((v3 >> 1) & 2147483647) | (v2 << 31)
        v2 = ((v2 >> 1) & 2147483647) | (v1 << 31)
        v1 = ((v1 >> 1) & 2147483647) | (v0 << 31)
        v0 = (v0 >> 1) & 2147483647
        if lsb != 0:
            v0 ^= 0xe1000000
    for i in range(4):
        store8(y + i, z0 >> (24 - 8 * i))
        store8(y + 4 + i, z1 >> (24 - 8 * i))
        store8(y + 8 + i, z2 >> (24 - 8 * i))
        store8(y + 12 + i, z3 >> (24 - 8 * i))
    return 0

def gcm_setkey(ctx, key):
    aes_expand(key, ctx)
    mem_zero(${W} + 16, 16)
    aes_encrypt(ctx, ${W} + 16, ctx + 176)
    return 0

# y ^= each zero-padded 16-byte block of the n bytes at p, times H
def ghash_data(y, p, n, h):
    while n > 0:
        k = n
        if k > 16:
            k = 16
        for i in range(k):
            store8(y + i, load8(y + i) ^ load8(p + i))
        ghash_mul(y, h)
        p += 16
        n -= 16
    return 0

# CTR keystream: block j of the message uses the counter iv | (start + j); in place is fine
def gcm_ctr(ctx, iv, start, p, n, out):
    mem_copy(${W} + 32, iv, 12)
    ctr = start
    done = 0
    while done < n:
        store8(${W} + 44, ctr >> 24)
        store8(${W} + 45, ctr >> 16)
        store8(${W} + 46, ctr >> 8)
        store8(${W} + 47, ctr)
        aes_encrypt(ctx, ${W} + 32, ${W} + 48)
        k = n - done
        if k > 16:
            k = 16
        for i in range(k):
            store8(out + done + i, load8(p + done + i) ^ load8(${W} + 48 + i))
        done += k
        ctr += 1
    return 0

# the length block: bit lengths of A and C as two 64-bit big-endian words, xored into y
def gcm_len(y, aadn, n):
    store8(y + 3, load8(y + 3) ^ ((aadn >> 29) & 7))
    store8(y + 11, load8(y + 11) ^ ((n >> 29) & 7))
    for i in range(4):
        store8(y + 4 + i, load8(y + 4 + i) ^ ((aadn << 3) >> (24 - 8 * i)))
        store8(y + 12 + i, load8(y + 12 + i) ^ ((n << 3) >> (24 - 8 * i)))
    return 0

# tag = E(J0) ^ GHASH(A, C, lengths) at tagp (16 bytes)
def gcm_tag(ctx, iv, aad, aadn, c, n, tagp):
    y = ${W} + 64
    mem_zero(y, 16)
    ghash_data(y, aad, aadn, ctx + 176)
    ghash_data(y, c, n, ctx + 176)
    gcm_len(y, aadn, n)
    ghash_mul(y, ctx + 176)
    mem_copy(${W} + 32, iv, 12)
    store8(${W} + 44, 0)
    store8(${W} + 45, 0)
    store8(${W} + 46, 0)
    store8(${W} + 47, 1)
    aes_encrypt(ctx, ${W} + 32, ${W} + 48)
    for i in range(16):
        store8(tagp + i, load8(y + i) ^ load8(${W} + 48 + i))
    return 0

# out = ciphertext (n bytes) followed by the 16-byte tag; in place (out == p) is fine; iv is 12 bytes
def gcm_seal(ctx, iv, aad, aadn, p, n, out):
    gcm_ctr(ctx, iv, 2, p, n, out)
    gcm_tag(ctx, iv, aad, aadn, out, n, out + n)
    return 0

# c holds n bytes of ciphertext then the tag: 1 and the plaintext at out if the tag verifies, else 0 and out untouched
def gcm_open(ctx, iv, aad, aadn, c, n, out):
    gcm_tag(ctx, iv, aad, aadn, c, n, ${W} + 96)
    if mem_eq(${W} + 96, c + n, 16) == 0:
        return 0
    gcm_ctr(ctx, iv, 2, c, n, out)
    return 1
`,
};
