// X25519 (RFC 7748 section 5) in the Python subset. A field element mod p = 2^255 - 19 is 32 limbs of radix 2^8, one limb per RAM word (as in NaCl's
// curve25519 "ref"): a limb product is below 2^20 and a product-sum of 32 terms with the folded-over 38 factor stays below 2^31, so the 32-bit signed
// arithmetic of the subset never wraps and its arithmetic right shift is a floor. Add and subtract do not reduce; every multiplication does, and the
// ladder (Montgomery, constant sequence of operations, cswap by mask) follows RFC 7748's pseudocode. The bounds are argued next to each routine.

import type { CryptoModule } from './index';
import { MEM } from './layout';

/** Element i of the work area: 24 elements of 32 words. */
export const FE = (i: number): number => MEM.fe + 128 * i;
const [X1, X2, Z2, X3, Z3, A, AA, B, BB, E, C, D, DA, CB, T1, T2, I0, I1, I2, I3] = Array.from({ length: 20 }, (_, i) => FE(i));

export const X25519: CryptoModule = {
  name: 'x25519',
  py: `# ---- x25519 ----
def fe_set(o, v):
    store32(o, v)
    for j in range(1, 32):
        store32(o + 4 * j, 0)
    return 0

def fe_copy(o, a):
    for j in range(32):
        store32(o + 4 * j, load32(a + 4 * j))
    return 0

def fe_add(o, a, b):
    for j in range(32):
        store32(o + 4 * j, load32(a + 4 * j) + load32(b + 4 * j))
    return 0

# a - b + 2p, with 2p written as limbs 474, 510 x 30, 254 (a borrow from each limb to the one above): every limb of the result is >= 0 while b's limbs stay <= 254
def fe_sub(o, a, b):
    store32(o, load32(a) + 474 - load32(b))
    for j in range(1, 31):
        store32(o + 4 * j, load32(a + 4 * j) + 510 - load32(b + 4 * j))
    store32(o + 124, load32(a + 124) + 254 - load32(b + 124))
    return 0

# two passes of carries: limb 31 keeps 7 bits and the rest, times 19 (2^255 = 19 mod p), goes back into limb 0. Floor shifts make it right for any nonnegative limbs
def fe_carry(a):
    c = 0
    for j in range(31):
        v = load32(a + 4 * j) + c
        store32(a + 4 * j, v & 255)
        c = v >> 8
    v = load32(a + 124) + c
    store32(a + 124, v & 127)
    c = 19 * (v >> 7)
    for j in range(31):
        v = load32(a + 4 * j) + c
        store32(a + 4 * j, v & 255)
        c = v >> 8
    store32(a + 124, load32(a + 124) + c)
    return 0

# a * b into MEM.feTmp (no reduction): out[i] = sum a[j] b[i-j] + 38 sum a[j] b[i+32-j]. Limbs up to 765 x 765 x (32 + 38 * 31) stay below 2^31
def fe_mul_raw(a, b):
    for i in range(32):
        u = 0
        pa = a
        pb = b + 4 * i
        for j in range(i + 1):
            u += load32(pa) * load32(pb)
            pa += 4
            pb -= 4
        w = 0
        pa = a + 4 * i + 4
        pb = b + 124
        for j in range(i + 1, 32):
            w += load32(pa) * load32(pb)
            pa += 4
            pb -= 4
        store32(${MEM.feTmp} + 4 * i, u + 38 * w)
    return 0

def fe_mul(o, a, b):
    fe_mul_raw(a, b)
    fe_copy(o, ${MEM.feTmp})
    fe_carry(o)
    return 0

# o = a * 121665 (a24 of RFC 7748), unreduced: limbs up to 765 * 121665 < 2^27
def fe_mul121665(o, a):
    for j in range(32):
        store32(o + 4 * j, load32(a + 4 * j) * 121665)
    return 0

# swap the two elements when s is 1, by mask (no branch on the secret)
def fe_cswap(s, a, b):
    m = 0 - s
    for j in range(32):
        x = load32(a + 4 * j)
        y = load32(b + 4 * j)
        t = m & (x ^ y)
        store32(a + 4 * j, x ^ t)
        store32(b + 4 * j, y ^ t)
    return 0

# o = a^(2^n)
def fe_sqn(o, a, n):
    fe_mul(o, a, a)
    for i in range(1, n):
        fe_mul(o, o, o)
    return 0

# o = z^(p-2) = z^(2^255 - 21): the standard chain, 254 squarings and 11 multiplications
def fe_inv(o, z):
    fe_sqn(${I0}, z, 1)
    fe_sqn(${I1}, ${I0}, 2)
    fe_mul(${I1}, z, ${I1})
    fe_mul(${I0}, ${I0}, ${I1})
    fe_sqn(${I2}, ${I0}, 1)
    fe_mul(${I1}, ${I1}, ${I2})
    fe_sqn(${I2}, ${I1}, 5)
    fe_mul(${I1}, ${I2}, ${I1})
    fe_sqn(${I2}, ${I1}, 10)
    fe_mul(${I2}, ${I2}, ${I1})
    fe_sqn(${I3}, ${I2}, 20)
    fe_mul(${I2}, ${I3}, ${I2})
    fe_sqn(${I2}, ${I2}, 10)
    fe_mul(${I1}, ${I2}, ${I1})
    fe_sqn(${I2}, ${I1}, 50)
    fe_mul(${I2}, ${I2}, ${I1})
    fe_sqn(${I3}, ${I2}, 100)
    fe_mul(${I2}, ${I3}, ${I2})
    fe_sqn(${I2}, ${I2}, 50)
    fe_mul(${I1}, ${I2}, ${I1})
    fe_sqn(${I1}, ${I1}, 5)
    fe_mul(o, ${I1}, ${I0})
    return 0

# the canonical representative in [0, p): carry, then subtract p once if a + 19 reaches 2^255
def fe_freeze(a):
    fe_carry(a)
    fe_carry(a)
    c = 19
    for j in range(31):
        v = load32(a + 4 * j) + c
        store32(${MEM.feTmp} + 4 * j, v & 255)
        c = v >> 8
    v = load32(a + 124) + c
    if v >= 128:
        for j in range(31):
            store32(a + 4 * j, load32(${MEM.feTmp} + 4 * j))
        store32(a + 124, v & 127)
    return 0

# out = X25519(k, u): 32 little-endian bytes each. The scalar is clamped, bit 255 of u ignored (RFC 7748 section 5)
def x25519(out, k, u):
    mem_copy(${MEM.scalar}, k, 32)
    store8(${MEM.scalar}, load8(${MEM.scalar}) & 248)
    store8(${MEM.scalar} + 31, (load8(${MEM.scalar} + 31) & 127) | 64)
    for i in range(32):
        store32(${X1} + 4 * i, load8(u + i))
    store32(${X1} + 124, load32(${X1} + 124) & 127)
    fe_set(${X2}, 1)
    fe_set(${Z2}, 0)
    fe_copy(${X3}, ${X1})
    fe_set(${Z3}, 1)
    swap = 0
    for t in range(254, -1, -1):
        kt = (load8(${MEM.scalar} + (t >> 3)) >> (t & 7)) & 1
        swap ^= kt
        fe_cswap(swap, ${X2}, ${X3})
        fe_cswap(swap, ${Z2}, ${Z3})
        swap = kt
        fe_add(${A}, ${X2}, ${Z2})
        fe_mul(${AA}, ${A}, ${A})
        fe_sub(${B}, ${X2}, ${Z2})
        fe_mul(${BB}, ${B}, ${B})
        fe_sub(${E}, ${AA}, ${BB})
        fe_add(${C}, ${X3}, ${Z3})
        fe_sub(${D}, ${X3}, ${Z3})
        fe_mul(${DA}, ${D}, ${A})
        fe_mul(${CB}, ${C}, ${B})
        fe_add(${T1}, ${DA}, ${CB})
        fe_mul(${X3}, ${T1}, ${T1})
        fe_sub(${T2}, ${DA}, ${CB})
        fe_mul(${T2}, ${T2}, ${T2})
        fe_mul(${Z3}, ${X1}, ${T2})
        fe_mul(${X2}, ${AA}, ${BB})
        fe_mul121665(${T1}, ${E})
        fe_add(${T1}, ${T1}, ${AA})
        fe_carry(${T1})
        fe_mul(${Z2}, ${E}, ${T1})
    fe_cswap(swap, ${X2}, ${X3})
    fe_cswap(swap, ${Z2}, ${Z3})
    fe_inv(${T1}, ${Z2})
    fe_mul(${X2}, ${X2}, ${T1})
    fe_freeze(${X2})
    for i in range(32):
        store8(out + i, load32(${X2} + 4 * i))
    return 0
`,
};
