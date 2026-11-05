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


def wav16(path):
    """A mono 16-bit WAV's samples, as ints: the plain 44-byte header the site's clips have."""
    import struct
    b = path.read_bytes()
    assert b[:4] == b'RIFF' and b[8:12] == b'WAVE' and b[36:40] == b'data'
    rate = struct.unpack('<I', b[24:28])[0]
    return rate, list(struct.unpack(f'<{(len(b) - 44) // 2}h', b[44:]))


def speech():
    """G.711 mu-law and IMA ADPCM through audioop (Python 3.12: it is gone from 3.13), and LPC on the voice through solve_toeplitz."""
    import struct
    import warnings
    from scipy.linalg import solve_toeplitz
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        import audioop
    # every 14-bit sample, as audioop's 16-bit input (times 4), and every code back
    lin = struct.pack(f'<{16384}h', *[4 * x for x in range(-8192, 8192)])
    ulaw = list(audioop.lin2ulaw(lin, 2))
    back = [v // 4 for v in struct.unpack('<256h', audioop.ulaw2lin(bytes(range(256)), 2))]
    # ADPCM on the voice in two halves, the state carried across, then decoded in two halves
    rate, voice = wav16(Path(__file__).resolve().parents[2] / 'public' / 'dsp' / 'voice-8k.wav')
    x = voice[:4000]
    pcm = struct.pack(f'<{len(x)}h', *x)
    a, st = audioop.lin2adpcm(pcm[:4000], 2, None)
    b, st2 = audioop.lin2adpcm(pcm[4000:], 2, st)
    d1, dst = audioop.adpcm2lin(a + b, 2, None)
    # a loud square wave: clipping of the prediction and the index's ceiling
    sq = [32767 if (i // 37) % 2 else -32768 for i in range(600)]
    c, cst = audioop.lin2adpcm(struct.pack(f'<{len(sq)}h', *sq), 2, None)
    dq, _ = audioop.adpcm2lin(c, 2, None)
    # LPC of order 10 on Hamming-windowed frames of the voice
    frames = []
    w = np.hamming(240)
    for start in (2000, 9000, 17000, 30000):
        f = np.array(voice[start:start + 240], float) * w
        rr = np.array([np.dot(f[k:], f[:len(f) - k]) for k in range(11)])
        frames.append({'start': start, 'r': r(rr), 'a': r(solve_toeplitz(rr[:10], rr[1:11]))})
    return {
        'rate': rate, 'ulaw': ulaw, 'ulaw2lin': back,
        'adpcm': {'x': x, 'bytes': list(a + b), 'state_mid': list(st), 'state_end': list(st2), 'decoded': list(struct.unpack(f'<{len(x)}h', d1)), 'decoder_state': list(dst)},
        'square': {'x': sq, 'bytes': list(c), 'state': list(cst), 'decoded': list(struct.unpack(f'<{len(sq)}h', dq))},
        'lpc': frames,
    }


GENERATORS = {'zplane': zplane, 'multirate': multirate, 'adaptive': adaptive, 'pictures': pictures, 'speech': speech}


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
