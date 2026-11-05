#!/usr/bin/env python3
"""The signal processing level's outside references: scipy's answers, written as JSON under tests/dsp/vectors/ and read by the tests.
Python never runs in npm test or in the page. A chapter that needs a reference adds a generator below and a line in GENERATORS.

  python scripts/dsp/oracle.py            writes the vectors
  python scripts/dsp/oracle.py --check    regenerates and compares within TOL (.github/workflows/dsp-oracle.yml)

Numbers are rounded to 12 significant digits, so a change of platform does not rewrite the files. Versions are recorded in each file."""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import scipy
from scipy import signal

OUT = Path(__file__).resolve().parents[2] / 'tests' / 'dsp' / 'vectors'
TOL = 1e-9


def r(x):
    """Plain JSON from numpy, 12 significant digits."""
    a = np.asarray(x, dtype=float)
    return [float(f'{v:.12g}') for v in a.ravel()] if a.ndim else float(f'{float(a):.12g}')


def cx(z):
    """Complex values as [re, im] pairs, sorted so that any root finder's order compares."""
    z = sorted(np.atleast_1d(z), key=lambda c: (round(c.real, 6), round(c.imag, 6)))
    return [[float(f'{c.real:.12g}'), float(f'{c.imag:.12g}')] for c in z]


def noise(n, seed):
    """A fixed input both sides can generate: the same LCG as the tests', in [-1, 1)."""
    s, out = seed, []
    for _ in range(n):
        s = (s * 1664525 + 1013904223) % 2**32
        out.append(s / 2**31 - 1)
    return out


def zplane():
    cases = [
        ('fir5', [1, 4, 6, 4, 1], [1]),
        ('moving average 8', [0.125] * 8, [1]),
        ('one pole', [0.1], [1, -0.9]),
        ('resonator', [1, 2, 1], [1, -2 * 0.97 * np.cos(0.25), 0.97**2]),
        ('notch', [1, -2 * np.cos(0.8), 1], [1, -2 * 0.95 * np.cos(0.8), 0.95**2]),
        ('elliptic 4', *signal.ellip(4, 0.5, 40, 0.3)),
        ('butterworth 5', *signal.butter(5, 0.2)),
        ('unstable', [1], [1, -1.1]),
    ]
    x = noise(64, 12345)
    fs = [0, 0.03, 0.1, 0.17, 0.25, 0.31, 0.4, 0.47]
    rows = []
    for name, b, a in cases:
        b, a = np.asarray(b, float), np.asarray(a, float)
        z, p, _ = signal.tf2zpk(b, a)
        _, h = signal.freqz(b, a, worN=np.array(fs), fs=1)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')  # singular at a zero on the circle: such a point has no delay, and the test skips it
            _, gd = signal.group_delay((b, a), w=np.array(fs), fs=1)
        imp = np.zeros(32)
        imp[0] = 1
        rows.append({
            'name': name, 'b': r(b), 'a': r(a), 'zeros': cx(z), 'poles': cx(p),
            'gain': r(np.abs(h)), 'phase': r(np.angle(h)), 'delay': r(gd),
            'impulse': r(signal.lfilter(b, a, imp)), 'lfilter': r(signal.lfilter(b, a, x)),
        })
    u, v = [1, 2, 3, -1], [0.5, -0.25, 2]
    return {'fs': fs, 'x': r(x), 'filters': rows, 'convolve': {'x': u, 'h': v, 'y': r(np.convolve(u, v))}}


def stable_exact(a):
    """Exact stability of a polynomial in z^-1 with integer coefficients, a[0] > 0 (Schur-Cohn without a division): the same steps as dsp/iir.ts stableExact.
    No root finder, so a double root on the circle or a cluster of near-equal poles cannot fool it."""
    a = [int(v) for v in a]
    while len(a) > 1:
        m = len(a) - 1
        if a[0] <= 0 or abs(a[m]) >= a[0]:
            return False
        a = [a[0] * a[i] - a[m] * a[m - i] for i in range(m)]
    return a[0] > 0


def rnd(v):
    """Round half up, the way the hardware and dsp/fixed.ts do (Python's round() sends ties to even)."""
    return int(np.floor(v + 0.5))


def quant_direct(coef, bits):
    """Direct form: every coefficient after a0 in one word of `bits` bits whose integer part (sign included) is just big enough for the largest. Returns (ints, fractional bits)."""
    mx = max(abs(v) for v in coef)
    ib = max(2, int(np.floor(np.log2(mx))) + 2)
    f = bits - ib
    return [rnd(v * 2.0**f) for v in coef], f


def iir():
    wp, ws, rp, rs = 0.2, 0.25, 0.1, 60  # scipy's units: fractions of Nyquist. In cycles a sample the mask is 0.1 and 0.125.
    des = {}
    for name, ordf, design in [
        ('butter', signal.buttord, lambda n, wn: signal.butter(n, wn, output='zpk')),
        ('cheby1', signal.cheb1ord, lambda n, wn: signal.cheby1(n, rp, wn, output='zpk')),
        ('ellip', signal.ellipord, lambda n, wn: signal.ellip(n, rp, rs, wn, output='zpk')),
    ]:
        n, wn = ordf(wp, ws, rp, rs)
        z, p, k = design(n, wn)
        sos = signal.zpk2sos(z, p, k)
        des[name] = {'order': int(n), 'wn': float(f'{wn:.12g}'), 'z': cx(z), 'p': cx(p), 'k': float(f'{k:.12g}'), 'sos': r(sos),
                     'sections': int(sos.shape[0]), 'gain': r(np.abs(signal.sosfreqz(sos, worN=np.array(FS), fs=1)[1]))}
    # a few more designs, odd and even, to test the prototypes and the transform on their own
    extra = []
    for name, n, args in [('butter', 5, ()), ('butter', 4, ()), ('cheby1', 4, (1,)), ('cheby1', 5, (0.5,)), ('ellip', 5, (0.5, 40)), ('ellip', 6, (0.1, 60)), ('ellip', 4, (1, 50))]:
        wn = 0.35
        z, p, k = getattr(signal, name)(n, *args, wn, output='zpk')
        _, h = signal.freqz(*signal.zpk2tf(z, p, k), worN=np.array(FS), fs=1)
        extra.append({'kind': name, 'order': n, 'args': list(args), 'f': wn / 2, 'z': cx(z), 'p': cx(p), 'k': float(f'{k:.12g}'), 'gain': r(np.abs(h))})
    ap = []
    for name, n, args in [('buttap', 5, ()), ('cheb1ap', 4, (1,)), ('ellipap', 5, (0.5, 40)), ('ellipap', 6, (0.1, 60))]:
        z, p, k = getattr(signal, name)(n, *args)
        ap.append({'kind': name, 'order': n, 'args': list(args), 'z': cx(z), 'p': cx(p), 'k': float(f'{k:.12g}')})
    # the bilinear transform on its own: an analog zpk at one sample a second
    za, pa, ka = signal.ellipap(4, 1, 50)
    zb, pb, kb = signal.bilinear_zpk(0.9 * za, 0.9 * pa, ka * 0.9**0, 1.0)
    # the mask: how many taps the FIR designs need
    # 0.1 dB of ripple is peak to peak, the way scipy's cheby1 / ellip rp is: for an FIR the gain stays within 1 +- dp with (1 + dp) / (1 - dp) = 10^(rp/20)
    g = 10 ** (rp / 20)
    dp, ds = (g - 1) / (g + 1), 10 ** (-rs / 20)
    kaiser = int(signal.kaiserord(rs, (ws - wp) / 1.0 * 1.0 / 1.0)[0])
    pm = pm_odd = None
    for n in range(40, 300):
        h = signal.remez(n, [0, wp / 2, ws / 2, 0.5], [1, 0], weight=[1 / dp, 1 / ds], fs=1, maxiter=200, grid_density=32)
        w, hh = signal.freqz(h, worN=8192, fs=1)
        a = np.abs(hh)
        if np.max(np.abs(a[w <= wp / 2] - 1)) <= dp and np.max(a[w >= ws / 2]) <= ds:
            pm = pm or n
            if n % 2 == 1:
                pm_odd = n
                break
    # the narrow elliptic low-pass of the sensitivity step: edge 0.04 cycles a sample, order 6, 0.1 dB, 60 dB
    zn, pn, kn = signal.ellip(6, 0.1, 60, 0.08, output='zpk')
    sosn = signal.zpk2sos(zn, pn, kn)
    bn, an = signal.zpk2tf(zn, pn, kn)
    sens = []
    for bits in range(8, 33):
        qa, f = quant_direct(list(an[1:]), bits)
        df = stable_exact([2**f] + qa)
        S, hi = 2 ** (bits - 2), 2 ** (bits - 1) - 1
        sec = [stable_exact([S, int(np.clip(rnd(s[4] * S), -hi - 1, hi)), int(np.clip(rnd(s[5] * S), -hi - 1, hi))]) for s in sosn]
        rad = float(max(abs(np.roots([1.0] + [v / 2.0**f for v in qa]))))
        sens.append({'bits': bits, 'direct': bool(df), 'sections': [bool(v) for v in sec], 'radius': float(f'{rad:.12g}')})
    x = noise(256, 777)
    sx, sy = signal.sosfilt(sosn, x), signal.lfilter(bn, an, x)
    return {
        'fs': FS, 'mask': {'wp': wp, 'ws': ws, 'rp': rp, 'rs': rs}, 'designs': des, 'extra': extra, 'analog': ap,
        'bilinear': {'z': cx(zb), 'p': cx(pb), 'k': float(f'{kb:.12g}'), 'in': {'z': cx(0.9 * za), 'p': cx(0.9 * pa), 'k': float(f'{ka:.12g}')}},
        'fir': {'kaiser': kaiser, 'pm': pm, 'pm_odd': pm_odd, 'dp': float(f'{dp:.12g}'), 'ds': float(f'{ds:.12g}')},
        'narrow': {'z': cx(zn), 'p': cx(pn), 'k': float(f'{kn:.12g}'), 'sos': r(sosn), 'b': r(bn), 'a': r(an), 'sens': sens,
                   'rule': 'direct form: every a[k], k >= 1, one word of `bits` bits, integer part (with sign) = floor(log2 max|a|) + 2, rounded half up; sections: a1, a2 in Q2.(bits-2), rounded half up, clamped',
                   'x': r(x), 'sosfilt': r(sx), 'lfilter': r(sy)},
    }


FS = [0, 0.01, 0.03, 0.05, 0.08, 0.1, 0.11, 0.125, 0.15, 0.2, 0.3, 0.4, 0.47]


GENERATORS = {'zplane': zplane, 'iir': iir}


def stamp(data):
    return {'tools': {'python': sys.version.split()[0], 'numpy': np.__version__, 'scipy': scipy.__version__}, **data}


def close(a, b, path=''):
    if isinstance(a, dict):
        return all(close(a[k], b[k], f'{path}/{k}') for k in a if k != 'tools')
    if isinstance(a, list):
        if len(a) != len(b):
            print('length differs at', path)
            return False
        return all(close(x, y, f'{path}[{i}]') for i, (x, y) in enumerate(zip(a, b)))
    if isinstance(a, float) or isinstance(b, float):
        ok = abs(a - b) <= TOL * max(1, abs(a))
        if not ok:
            print('differs at', path, a, b)
        return ok
    return a == b


def main():
    check = '--check' in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    bad = 0
    for name, gen in GENERATORS.items():
        f = OUT / f'{name}.json'
        fresh = stamp(gen())
        if check:
            if not close(fresh, json.loads(f.read_text(encoding='utf-8'))):
                bad += 1
                print('STALE', f)
        else:
            f.write_text(json.dumps(fresh, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
            print('wrote', f)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
