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
    for s0 in (512, 1280):
        sig = sig + np.where((n >= s0) & (n < s0 + 128), 0.5 * np.sin(np.pi * (n - s0) / 128) ** 2 * np.sin(2 * np.pi * 0.06 * n), 0)
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




def adaptive():
    from scipy.linalg import solve_toeplitz
    rows = []
    for r0, p0 in [([1, 0.5, 0.25], [1, 0, 0]), ([2, 0.9, 0.3, 0.1], [0.5, 0.2, -0.1, 0.05]), ([1, 0.8, 0.64, 0.512, 0.4096, 0.32768], [0.9, 0.7, 0.5, 0.3, 0.1, 0.05])]:
        rows.append({'r': r(r0), 'p': r(p0), 'w': r(solve_toeplitz(r0, p0))})
    return {'cases': rows}




def zigzag():
    """T.81 Figure A.6, built the same way as dsp/pictures.ts: diagonals of u + v, alternating direction."""
    o = []
    for s in range(15):
        cells = [v * 8 + (s - v) for v in range(8) if 0 <= s - v < 8]
        o += cells if s % 2 else cells[::-1]
    return o


def segments(data):
    """A JPEG's marker segments up to the scan: (marker, body)."""
    i, out = 2, []
    while i < len(data):
        m, n = data[i + 1], data[i + 2] * 256 + data[i + 3]
        out.append((m, data[i + 4:i + 2 + n]))
        if m == 0xDA:
            break
        i += 2 + n
    return out


def pictures():
    import io
    import PIL
    from PIL import Image, features
    from scipy import fft, ndimage
    zz = zigzag()
    # the 2-D DCT: T.81 A.3.3 is scipy's orthonormal DCT-II along both axes
    blocks = [np.reshape(np.round(np.array(noise(64, seed)) * 128), (8, 8)) for seed in (1, 2, 3)]
    blocks.append(np.full((8, 8), -128.0))
    dct = [{'x': r(b), 'S': r(fft.dctn(b, type=2, norm='ortho'))} for b in blocks]
    # libjpeg's quality scaling and the Annex K tables, as Pillow writes them
    img = Image.new('L', (16, 16))
    img.putdata([(x * 13 + y * 7) % 256 for y in range(16) for x in range(16)])
    tables = {}
    for q in (1, 10, 25, 30, 33, 50, 75, 95, 100):
        f = io.BytesIO()
        img.save(f, 'JPEG', quality=q, optimize=False)
        body = next(b for m, b in segments(f.getvalue()) if m == 0xDB)
        natural = [0] * 64
        for k in range(64):
            natural[zz[k]] = body[1 + k]
        tables[str(q)] = natural
    f = io.BytesIO()
    img.save(f, 'JPEG', quality=50, optimize=False)
    huff = {}
    for m, b in segments(f.getvalue()):
        if m == 0xC4:
            j = 0
            while j < len(b):
                bits = list(b[j + 1:j + 17])
                huff['dc' if b[j] >> 4 == 0 else 'ac'] = {'bits': bits, 'vals': list(b[j + 17:j + 17 + sum(bits)])}
                j += 17 + sum(bits)
    # 2-D filtering: correlation, the edge sample repeated (mode 'nearest')
    W, H = 16, 12
    p = np.array([[(x * 37 + y * 91 + x * y * 13) % 256 for x in range(W)] for y in range(H)], float)
    kernels = {
        'box': np.ones((3, 3)) / 9, 'blur': np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]]) / 16,
        'sharpen': np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], float), 'edges': np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], float),
    }
    filt = {k: r(ndimage.correlate(p, v, mode='nearest')) for k, v in kernels.items()}
    shrink = {}
    for m in (2, 3):
        n = 8 * m + 1
        t = np.arange(n) - (n - 1) / 2
        taps = np.where(t == 0, 1 / m, np.sin(np.pi * t / m) / (np.pi * np.where(t == 0, 1, t))) * (0.54 - 0.46 * np.cos(2 * np.pi * np.arange(n) / (n - 1)))
        taps = taps / taps.sum()
        q = ndimage.correlate1d(ndimage.correlate1d(p, taps, axis=1, mode='nearest'), taps, axis=0, mode='nearest')
        shrink[str(m)] = {'taps': r(taps), 'filtered': r(q)}
    # our own files, decoded by libjpeg through Pillow
    decoded = {}
    for q in (10, 75):
        im = Image.open(OUT / f'pictures-q{q}.jpg')
        im.load()
        decoded[str(q)] = {'mode': im.mode, 'size': list(im.size), 'px': list(im.tobytes())}
    return {
        'pillow': PIL.__version__, 'libjpeg_turbo': features.version('libjpeg_turbo'),
        'dct': dct, 'tables': tables, 'huff': huff, 'picture': {'w': W, 'h': H, 'px': r(p)}, 'filters': filt, 'shrink': shrink, 'decoded': decoded,
    }



GENERATORS = {'zplane': zplane, 'spectrum': spectrum, 'firdesign': firdesign, 'iir': iir, 'multirate': multirate, 'adaptive': adaptive, 'pictures': pictures}


def stamp(data):
    tools = {'python': sys.version.split()[0], 'numpy': np.__version__, 'scipy': scipy.__version__}
    try:
        import PIL
        tools['pillow'] = PIL.__version__
    except ImportError:
        pass
    return {'tools': tools, **data}


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
