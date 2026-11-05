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


def firdesign():
    """FIR design: scipy's remez / firwin / kaiserord / freqz / lfilter on the chapter's mask (pass to 0.10 cycles a sample with 0.1 dB peak to peak,
    stop from 0.125 with 60 dB) and on small cases. The grid for every mask check is freqz(worN=8192, fs=1), the same as the TypeScript's."""
    fp, fst = 0.10, 0.125
    g = 10 ** (0.1 / 20)
    dp, ds = (g - 1) / (g + 1), 1e-3

    def check(h):
        w, H = signal.freqz(h, worN=8192, fs=1)
        a = np.abs(H)
        return {'passDev': float(np.max(np.abs(a[w <= fp] - 1))), 'stopPeak': float(np.max(a[w >= fst]))}

    def ok(h):
        c = check(h)
        return c['passDev'] <= dp and c['stopPeak'] <= ds

    def pm(n):
        return signal.remez(n, [0, fp, fst, 0.5], [1, 0], weight=[1 / dp, 1 / ds], fs=1, maxiter=200)

    cases = [
        ('type I low-pass, 21 taps', 21, [0, 0.1, 0.2, 0.5], [1, 0], [1, 10]),
        ('type II low-pass, 24 taps', 24, [0, 0.1, 0.2, 0.5], [1, 0], [1, 10]),
        ('type I band-pass, 41 taps', 41, [0, 0.05, 0.1, 0.2, 0.25, 0.5], [0, 1, 0], [10, 1, 10]),
        ('type II band-pass, 32 taps', 32, [0, 0.08, 0.13, 0.3, 0.36, 0.5], [0, 1, 0], [1, 1, 1]),
        ('type I low-pass, 63 taps, narrow', 63, [0, 0.12, 0.14, 0.5], [1, 0], [1, 1]),
    ]
    remez_rows = []
    for name, n, edges, des, wt in cases:
        h = signal.remez(n, edges, des, weight=wt, fs=1, maxiter=200)
        remez_rows.append({'name': name, 'numtaps': n, 'edges': edges, 'desired': des, 'weight': wt, 'taps': r(h)})
    fewest_pm = next(n for n in range(60, 200) if ok(pm(n)))
    nt, beta = signal.kaiserord(60, (fst - fp) / 0.5)
    fewest_k = next(n for n in range(60, 300, 1) if ok(signal.firwin(n, (fp + fst) / 2, window=('kaiser', beta), fs=1)))
    kai = signal.firwin(nt, (fp + fst) / 2, window=('kaiser', beta), fs=1)
    wins = []
    for nm, win in (('rectangular', 'boxcar'), ('hann', 'hann'), ('hamming', 'hamming'), ('blackman', 'blackman'), ('kaiser', ('kaiser', 6.0))):
        wins.append({'kind': nm, 'beta': 6.0, 'taps': r(signal.firwin(31, 0.2, window=win, fs=1))})
    h115, h114 = pm(115), pm(114)
    fs_pts = [0, 0.03, 0.08, 0.1, 0.11, 0.125, 0.2, 0.3, 0.45]
    _, G = signal.freqz(h115, worN=np.array(fs_pts), fs=1)
    q = {}
    for frac in (15, 16, 17, 18):
        hq = np.floor(h115 * 2**frac + 0.5) / 2**frac
        q[str(frac)] = check(hq)
    fewest_frac = next(f for f in range(4, 31) if ok(np.floor(h115 * 2**f + 0.5) / 2**f))
    ints = np.floor(h115 * 2**17 + 0.5)
    x = [int(np.floor(v * 2**15)) for v in noise(200, 777)]
    y = signal.lfilter(ints, [1.0], np.array(x, dtype=float))
    return {
        'mask': {'pass': fp, 'stop': fst, 'rippleDb': 0.1, 'stopDb': 60, 'deltaPass': dp, 'deltaStop': ds},
        'remez': remez_rows,
        'fewest': {'remez': fewest_pm, 'remezOneFewer': check(pm(fewest_pm - 1)), 'kaiser': fewest_k, 'kaiserord': nt, 'beta': beta, 'fewestFrac': fewest_frac},
        'mask114': {'taps': r(h114), **check(h114)}, 'mask115': {'taps': r(h115), **check(h115)},
        'kaiser': {'taps': r(kai), **check(kai)}, 'windows': wins,
        'freqz': {'f': fs_pts, 'gain115': r(np.abs(G))}, 'quantized115': q,
        'lfilter': {'taps': r(ints), 'x': x, 'y': r(y)},
    }


GENERATORS = {'zplane': zplane, 'firdesign': firdesign}


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
