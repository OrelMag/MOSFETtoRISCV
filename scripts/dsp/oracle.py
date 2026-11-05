#!/usr/bin/env python3
"""The signal processing level's outside references: scipy's answers, written as JSON under tests/dsp/vectors/ and read by the tests.
Python never runs in npm test or in the page. A chapter that needs a reference adds a generator below and a line in GENERATORS.

  python scripts/dsp/oracle.py            writes the vectors
  python scripts/dsp/oracle.py --check    regenerates and compares within TOL (.github/workflows/dsp-oracle.yml)

Numbers are rounded to 12 significant digits, so a change of platform does not rewrite the files. Versions are recorded in each file."""
import json
import sys
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
        imp = np.zeros(32)
        imp[0] = 1
        rows.append({
            'name': name, 'b': r(b), 'a': r(a), 'zeros': cx(z), 'poles': cx(p),
            'gain': r(np.abs(h)), 'phase': r(np.angle(h)),
            'impulse': r(signal.lfilter(b, a, imp)), 'lfilter': r(signal.lfilter(b, a, x)),
        })
    u, v = [1, 2, 3, -1], [0.5, -0.25, 2]
    return {'fs': fs, 'x': r(x), 'filters': rows, 'convolve': {'x': u, 'h': v, 'y': r(np.convolve(u, v))}}


def multirate():
    x = noise(97, 777)
    rows = []
    for up, down, n, cut in [(1, 2, 21, 0.45), (1, 4, 33, 0.22), (3, 2, 31, 0.3), (2, 3, 25, 0.3), (5, 1, 41, 0.18)]:
        h = signal.firwin(n, cut)
        rows.append({
            'up': up, 'down': down, 'h': r(h), 'x': r(x),
            'upfirdn': r(signal.upfirdn(h, x, up, down)),
            'resample_poly': r(signal.resample_poly(x, up, down, window=h)),
        })
    return {'cases': rows}


GENERATORS = {'zplane': zplane, 'multirate': multirate}


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
