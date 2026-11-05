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



def win_kinds(n):
    from scipy.signal import windows as W
    return {'rect': W.boxcar(n, sym=False), 'hann': W.hann(n, sym=False), 'hamming': W.hamming(n, sym=False), 'blackman': W.blackman(n, sym=False),
            'blackmanharris': W.blackmanharris(n, sym=False), 'kaiser': W.kaiser(n, 8, sym=False)}


def win_figures(w):
    """The same figures src/dsp/spectrum.ts windowFigures reads off a window: enbw, and the transform on a 1/32-bin grid for the first minimum, the sidelobe and the half-bin loss."""
    n = len(w)
    t = np.abs(np.fft.fft(w, n * 32))
    t = t[: min(48, n // 2 - 1) * 32 + 1] / t[0]
    i = 1
    while i < len(t) - 1 and not (t[i] <= t[i - 1] and t[i] <= t[i + 1]):
        i += 1
    return {'coherent': float(w.sum() / n), 'enbw': float(n * (w * w).sum() / w.sum() ** 2), 'firstMin': i / 32, 'sidelobeDb': float(20 * np.log10(t[i:].max())), 'scallopDb': float(-20 * np.log10(t[16]))}


def dtmf_block(row, col, n, amp=50):
    out = []
    for k in range(n):
        v = amp * (np.cos(2 * np.pi * row * k / 8000) + np.cos(2 * np.pi * col * k / 8000))
        out.append(int(max(-128, min(127, np.floor(v + 0.5)))))
    return out


def shift_round(v, s):
    return (v + (1 << (s - 1))) >> s


def spectrum():
    N = 64
    kinds = win_kinds(N)
    f = 10.5 / N
    xt = np.cos(2 * np.pi * f * np.arange(N))
    tones = {}
    for k, w in win_kinds(N).items():
        padded = np.fft.rfft(xt * w, N * 4)
        tones[k] = r(2 * np.abs(padded) / w.sum())
    # a spectrogram of the chapter's signal
    L = 2048
    n = np.arange(L)
    sig = 0.5 * np.sin(2 * np.pi * (0.03 * n + (0.4 - 0.03) * n * n / (2 * L))) + 0.3 * np.cos(2 * np.pi * 0.25 * n)
    sig = sig + np.where(((n >= 512) & (n < 640)) | ((n >= 1280) & (n < 1408)), 0.5 * np.sin(2 * np.pi * 0.12 * n), 0)
    _, _, Z = signal.stft(sig, window='hann', nperseg=64, noverlap=32, boundary=None, padded=False, detrend=False, return_onesided=True)
    # fast convolution
    x = np.array(noise(500, 777))
    h = signal.firwin(33, 0.3)
    full = signal.oaconvolve(x, h)
    # Goertzel on a keypad block, in floating point and in integers
    freqs = [697, 770, 852, 941, 1209, 1336, 1477, 1633]
    xb = dtmf_block(770, 1477, 205)
    gz = []
    for fq in freqs:
        c = 2 * np.cos(2 * np.pi * fq / 8000)
        s = signal.lfilter([1.0], [1.0, -c, 1.0], np.array(xb, float))
        s1, s2 = s[-1], s[-2]
        w = 2 * np.pi * fq / 8000
        X = np.sum(np.array(xb) * np.exp(-1j * w * np.arange(205)))
        C = int(max(-32768, min(32767, np.floor(c * 2**14 + 0.5))))
        a1 = a2 = 0
        for v in xb:
            a1, a2 = v + shift_round(C * a1, 14) - a2, a1
        gz.append({'f': fq, 's1': float(s1), 's2': float(s2), 'power': float(abs(X) ** 2), 'C': C, 'fx1': a1, 'fx2': a2})
    return {
        'windows': {'n': N, 'values': {k: r(w) for k, w in kinds.items()}, 'figures': {k: win_figures(w) for k, w in win_kinds(128).items()}},
        'tone': {'n': N, 'bin': 10.5, 'pad': 4, 'amplitude': tones},
        'spectrogram': {'x': r(sig), 'n': 64, 'hop': 32, 'frames': Z.shape[1], 'amplitude': r(2 * np.abs(Z.T))},
        'overlapSave': {'x': r(x), 'h': r(h), 'block': 128, 'y': r(full)},
        'goertzel': {'x': xb, 'n': 205, 'bins': gz},
    }


GENERATORS = {'zplane': zplane, 'spectrum': spectrum}


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
