# Signal processing level: sources

What each chapter's facts rest on. **Read** means someone working on the chapter opened it. **Ran** means a tool's output is checked in or was
compared. **Secondary** means seen only through someone else's summary. **Unread** means written from memory and not yet checked: fix or confirm these
before relying on them. Add to this as chapters land.

## Tools (ran)

- scipy 1.16.3, numpy 2.2.3: `scripts/dsp/oracle.py`, vectors in `tests/dsp/vectors/`, each stamped with its versions. `.github/workflows/dsp-oracle.yml`
  regenerates them at the versions in `scripts/dsp/requirements.txt`, on Python 3.12 (written locally on 3.13). Used for: `lfilter`, `freqz`, `tf2zpk`,
  `convolve`, `butter`, `ellip`.

## Numbers that fit (`fixed`)

- Arithmetic: checked exhaustively against exact integers and BigInt (`tests/dsp-fixed.test.ts`). No outside source is needed.
- 16-bit DSPs with 40-bit accumulators and 8 guard bits: **secondary**. The TI TMS320C54x has two 40-bit accumulators with guard bits 39–32, per course notes
  and copies of TI's SPRU307A seen through search results. TI's own document was not opened.
- A saturation mode bit in a DSP's status register being common: **unread**, from memory. (Search results for the C54x mention status register ST1 for another
  mode, which does not confirm this.)
- RISC-V vector extension has saturating add (`vsadd`) with the `vxsat` flag: **secondary**. Draft specifications 0.7.1 and 0.8 and GCC / LLVM patches list
  them. The ratified specification was not opened.
- Rounding noise q² / 12, and 6.02 b + 1.76 dB: derived in the chapter on signals; the discrete form (q² − 1) / 12 is checked by test here.

## The z-plane (`zplane`)

- Everything numeric: scipy's vectors above, and closed forms in `tests/dsp-zplane-chapter.test.ts`.
- Minimum phase, linear phase, BIBO stability: standard results, stated from memory and checked numerically where the chapter gives numbers. No textbook was
  opened.

## Measuring a spectrum (`spectrum`)

- Windows: `scipy.signal.windows` (boxcar, hann, hamming, blackman, blackmanharris, kaiser β = 8, all `sym=False`) against `src/dsp/spectrum.ts`, to 1e-9
  (`tests/dsp/vectors/spectrum.json`, ran). The figures read off a window (noise bandwidth, first minimum, highest sidelobe, loss at half a bin) are computed by the
  same recipe in numpy and in TypeScript, so that test shows the two implementations agree, not that the recipe is right. Outside the recipe: **ran** closed forms in
  `tests/dsp-spectrum.test.ts` (noise bandwidth of a cosine window, rectangle −13.26 dB and 3.92 dB at half a bin, Hann −31.5 dB, 4 bins, 1.42 dB). Those textbook
  values were not read from a book; the test computes them from the definitions.
- Spectrogram: `scipy.signal.stft` (Hann, no padding, no detrend), ran. Overlap-save: `scipy.signal.oaconvolve` and a direct convolution, ran. Goertzel: `scipy.signal.lfilter`
  of the resonator and a direct DFT sum, with an integer recursion written separately in Python, ran.
- Resolution (a 3 dB dip between two equal tones) and "a weak tone is seen" (it stands 6 dB above the skirt envelope, the top of the skirt's lobes, at its frequency) are definitions of ours, stated in the chapter. Phases are set
  so the tones add in phase at the middle of the block; with other phases the dip moves.
- Fast convolution cost: 4 real multiplications per complex one, no real-input savings, is a counting rule of ours. The break-even of 44 taps follows from it and is not a
  published figure.
- DTMF frequencies (697, 770, 852, 941 and 1209, 1336, 1477, 1633 Hz) and the keypad layout: **secondary**. Read from Wikipedia's "Dual-tone multi-frequency signaling"
  (fetched while writing the chapter), which attributes them to ITU-T Q.23. **Q.23 itself was not opened.** The decoding rule in the chapter (4 times the runner-up, a minimum
  amplitude of 10) is ours, not a standard's. That decoders "typically use Goertzel" is also from that page. The block of 205 samples is found by search (the best of 64 to 256 for
  these eight tones at 8 kHz), and nothing here says what other decoders use.
- Gate counts are `stats()` of the designs; the FFT-based filter's total is a sum of parts and was never built.
- Sound: the keypad clip and the spectrogram's signal come from the model; nobody has listened to them.

## FIR design (`firdesign`)

- scipy 1.16.3 (**ran**): `remez`, `firwin`, `kaiserord`, `freqz`, `lfilter` in `scripts/dsp/oracle.py` (generator `firdesign`, vectors in `tests/dsp/vectors/firdesign.json`).
  Our Parks–McClellan matches `remez` to better than 1e-9 of the largest tap on five cases (types I and II, low-pass, band-pass); windows match `firwin` to 1e-11.
- The mask (pass to 0.10, stop from 0.125 cycles a sample, 0.1 dB **peak to peak**, 60 dB) and its fewest lengths were searched, not quoted: Parks–McClellan 114
  (113 misses), Kaiser 147 from `kaiserord` (146 found by search, even length), Hamming 489 and Hann 269 by our search. The mockup's 115 is the fewest *odd*
  length. A ±0.1 dB reading of the ripple gives 105 instead, which is why the definition is stated in the text and pinned.
- Rounding the 114-tap design to 16-bit words (17 bits after the point) misses the mask by 0.22 dB; 115 taps meet it. Found by our test, confirmed by scipy's `freqz`.
- The Remez exchange (Parks and McClellan 1972; McClellan, Parks and Rabiner's program): **unread**. The implementation is written from the alternation theorem and
  checked by scipy's output and by each result against its mask. The grid rule copies scipy's `remez` behaviour as observed in its results, not its source.
- Kaiser's length estimate and β formulas: `kaiserord` implements them (**ran**); Kaiser's papers are **unread**.
- Canonical signed digits: exhaustive check on every integer from −2000 to 2000 (digits sum to the value, none adjacent, never more than binary). No textbook opened.
- Linear phase, type I / II zero at z = −1, folding, transposed form: standard results stated from memory, and checked by test: exact equality of the three structures' outputs
  on integers against `lfilter`.
- Costs are counted from our gates with `stats()`; no outside area figure is used. No clip in this chapter has been listened to.
- Audit fixes: the passband verdict is the deviation from 1 against the mask's ±δp (0.1 dB peak to peak, centred on 1). Even and odd lengths are labelled: Kaiser 146 even / 147 odd,
  Hann 268 / 269, Hamming 488 / 489 (our search); meeting the mask is not monotone in length (Kaiser misses from 149 to 153 after meeting at 146 to 148).
- Fastest clocks: the one-multiplier filter by `analyzeTiming` of its flattened gates; the parallel builds by a sum of parts from `logicDepth` of the multiplier, adder and constant-multiplier
  gates with the adder tree's levels counted in series (a conservative bound, ripple carries overlap), at the site's illustrative 25 ps a NAND delay. The parallel builds are not drawn or timed whole.

## IIR and stability (`iir`)

- Design: scipy 1.16.3 (`buttord`, `cheb1ord`, `ellipord`, `butter`, `cheby1`, `ellip`, `buttap`, `cheb1ap`, `ellipap`, `bilinear_zpk`, `zpk2sos`, `sosfilt`, `lfilter`,
  `kaiserord`, `remez`), vectors in `tests/dsp/vectors/iir.json` (**ran**). `dsp/iir.ts` designs the same filters itself (the elliptic one from elliptic functions) and the
  tests compare poles, zeros, gain at 13 frequencies and the filtered output. Orders for the mask: 37 / 14 / 8 (the mockup's figures reproduced). The mask's 0.1 dB of ripple is read **peak to peak**, as scipy's `rp` is for cheby1 / ellip: an FIR filter's gain within 1 +- dp, centred, dp = (g - 1) / (g + 1) with g = 10^(0.1/20) = 0.00576 (the
  firdesign chapter's reading too; not imported, computed in the oracle). The Parks-McClellan length: the smallest meeting the mask on an 8 192-point response with weights 1 / delta is **114** (even); the
  smallest odd is **115** (the chapter's, folded to 58); Kaiser 147 (**ran**, `kaiserord`).
- Butterworth poles on a circle and Chebyshev poles on an ellipse: closed forms, tested (**read** from the formulas, no textbook opened).
- The bilinear transform and frequency warping f = atan(w / 2) / pi: derived, checked numerically (**ran**).
- Exact stability by Schur-Cohn without a division, in BigInt (TS) and Python integers: the same algorithm in both, **ran** against the triangle |a2| < 1, |a1| < 1 + a2.
  numpy's root radius per width is in the JSON but is informative only (clustered poles make np.roots rough).
- The narrow elliptic low-pass (order 6, edge 0.04 cycles a sample, 0.1 dB, 60 dB) and the coefficient rounding rule are our choices, stated in the JSON. The direct form is
  unstable from 8 to 19 bits and stable from 20; sections stable at every width from 8 (the mockup said down to 10 and 20 for the direct form with other parameters).
- Limit cycles and the dead band 1/2 / (1 - a2): derived here **for a1 = 0 only** (y[n] = round(-a2 y[n-2]): |y| a2 rounds back to |y| while |y| <= 1/2 / (1 - a2)); the textbook bound for a general
  second-order section is **unread** and the formula does NOT carry over (radius 0.95 at 0.005 cycles a sample cycles at 116 LSB against 5.13; pinned in tests). The chapter pins the cycle's peak for the one case on the gates.
- Rounding toward zero: a proof for a1 = 0 (|y[n]| < |y[n-2]|, tested); for a1 != 0 only the sweeps (**ran**): 176 cases, radius 0.90 / 0.93 / 0.95 / 0.97: none cycle; a finer sweep (radius 0.90 ... 0.995 in nine values,
  49 angles, inputs 1 000 / 8 000 / 30 000, bursts 1 and 3, 4 000 clocks, 294 runs a radius): none to 0.975, then 2 at 0.98, 0 at 0.985, 1 at 0.99, 1 at 0.995. Rare and position-dependent: no threshold is claimed. Sweeps of the model (176 runs) are **ran**; one larger random sweep (6 000 pole positions)
  found rounding toward zero sustaining a cycle in 1 case (radius 0.9983), and that case is pinned. Nothing here proves other positions are free of one.
- The rule of thumb "poles nearest the circle last" for the order of sections: **unsourced** (no text opened). On the one filter here it ranks 21st of 24 once scaled and is the best order unscaled; the chapter says so and
  claims nothing more. "Cascades of second-order sections are a common way to build a high-order IIR filter": common practice, **unsourced**; lattice and wave-digital structures exist and are not covered.
- Section ordering and L-infinity scaling: standard practice, the noise formula (own rounding through 1 / A, then the later sections) is derived here and checked against the
  biquad model on a sine (predicted and measured, at the same amplitude, within 2 dB on every one of the 24 orders, scaled or not: pinned). Jackson / Oppenheim-Schafer texts were not opened (**unread**).
- Sound: nobody has listened. The limit-cycle button plays the cycle alone, scaled to the player's level; the level in dBFS is shown beside it.
  are the numbers beside each clip, and the sentences in "Wrap or saturate" and in `converters`'s "Many bits from one" (every 64th bit against the CIC) about what you will hear have not been confirmed by ear.

## Changing the rate (`multirate`)

- E. B. Hogenauer, "An Economical Class of Digital Filters for Decimation and Interpolation", IEEE Trans. ASSP-29 no. 2, April 1981, pp. 155-162: **read**, pages 1, 3 and 4 of
  a scan. Equations (10b) G = (RM)^N and (11) for the top bit; that every stage needs that bit; modulo arithmetic and two's complement; that later stages may drop low bits; and
  CIC at high rates with a conventional filter at low ones. Its Tables I and II are checked against the model in `tests/dsp-multirate.test.ts`. His truncation and rounding analysis
  was not studied, since this design holds every bit.
- Growth is also measured: the narrowest word that gets the worst input right equals the formula, on the model and the gates' word.
- `resample_poly`, `upfirdn`, `firwin`: scipy, **ran** (`tests/dsp/vectors/multirate.json`).
- Polyphase: derived in the chapter, and the same products compared. Half-band zeros: from the sinc, and checked by test. No textbook was opened.

## Turning by shifting (`cordic`)

- J. E. Volder, "The CORDIC Trigonometric Computing Technique", IRE Trans. Electronic Computers EC-8 no. 3, Sept. 1959, pp. 330-334: **secondary**. The citation and
  "real-time airborne computation" are from IEEE's record, seen through search results. The paper itself was not opened.
- That it was prompted by the B-58's navigation computer: **secondary**, from search results quoting his "The Birth of CORDIC" (J. VLSI Signal Processing, 2000), not opened.
  The chapter says only "real-time airborne computing".
- 0.607253, the angles' sum and every error figure: computed, and held by `tests/dsp-cordic.test.ts` against Math at every angle a word holds.
- ROM and CORDIC costs: measured from the gates. That a quarter-wave table saves about a factor of four, and that interpolation does better: **unread**, from memory, and not measured here.

## A MAC on the RV32 (`mac`)

- Our own design; there is no outside definition to read. RISC-V's draft P extension (packed SIMD, including 16-bit multiply-accumulates) was **not read** and is not claimed to match: the four instructions are ours, on custom-2, and say so.
- RISC-V's custom opcode space (custom-0 to custom-3, opcode[6:2] 0b00010, 0b01010, 0b10110, 0b11110) is the repo's own `riscv/custom.ts` table; the unprivileged ISA manual's chapter on opcode-space allocation was **unread** here.
- Spike cannot execute custom-2, so the MAC has no outside model. It is checked against our golden model in lock step, instruction by instruction, on the gates: the benchmarks, 60 seeded random programs that mix the MAC with RV32I (including words on custom-2 that are none of the four), and the directed program of `tests/dsp-mac-mutants.test.ts`. That test runs 14 deliberately faulty golden models (a dropped high product, truncating instead of rounding, a tie rounded down or away from zero, clamps at 16 / 31 bits or none, a 5-bit shift, accumulator widths 32 and 48, an unsigned low half, a clracc that does nothing, a logical shift) and fails unless the comparison reports each one; it first requires each mutant to differ from the real model on the program. It shows these 14 are caught. It is not a proof that no fault is.
- Rounding and clamping are chapter `fixed`'s rules (round half up, one clamp), and `comm/fftfix.ts`'s "keep every bit, round once". The exact reference is Python integers in `scripts/dsp/oracle.py` (`mac`), written to `tests/dsp/vectors/mac.json` with the versions used.
- scipy 1.16.3 `signal.lfilter` (FIR, float64: exact on these integers, asserted), `signal.sosfilt` with the quantized coefficients (the biquad cascade is within 1.5 LSB of it) and `signal.butter(8, 0.2, output='sos')` (the coefficients): **ran**. numpy `dot` on int64 equals the dot product's exact sum: **ran**. The Butterworth sections are redistributed to unit gain at DC each (scipy puts the gain in section 1, where Q13 rounds it to 0); the exact integers are ours.
- The benchmark figures are measured on gates (BitSim, 32 lanes), the data setup subtracted by running each program's setup alone; the cycles equal the golden model's instruction counts on every lane. The software-multiply machine's three long kernels are re-counted on the golden model, not on gates, in the test that pins them (the script that wrote the figures ran them on gates, four minutes).
- RV32IM is chapter `widths`'s `xlenCpu` at 32 bits: the single-cycle core has no M option. Its adders are Kogge–Stone and its memory banked by byte, so its NANDs and period are on another basis from the rest and the chapter says so.
- The estimates the plan carried were low for software (about 70 clocks a product against about 106 measured) and about right for the MAC loops (6 / 3 / 1.9 against 6.15 / 3.17 / 2.04 on the 64-tap filter). The unit's 10 063 NANDs (10 081 with the clamp of `firmac`) replace the 10 047 sum of parts.
- Not covered: the pipelined RV32 (decision 4), the sandbox's ROM program editor beyond the assembler and listing (MAC names are known in a ROM marked `mac`, set by Open in Sandbox on the chapter's core), and FPGA export of the MAC core (its register is an ordinary register; not tried).

## Converters (`converters`)

- 6.02 b + 1.76 dB, the R-2R ladder, DNL and INL, flash and SAR: standard results, **unread**, from memory; each is held numerically by `tests/dsp-converters.test.ts` where the chapter gives a number.
- The jitter limit, −20 log₁₀(2π f σ): **unread**, from memory, and measured here against a sampled sine.
- The linear model of a sigma-delta loop, π^(2L) / (2L + 1) and (20 L + 10) log₁₀ OSR: **unread**, from memory, and stated in `src/dsp/converters.ts`, not derived there. The loop's measured error power and its gap from the model are ours. The statement that an analogue integrator clips sooner is general, and no part's figures are quoted.
- V = z⁻¹U + (1 − z⁻¹)²E, every effective-bit figure, the integrators' peaks and the guard bits: computed on the model, and held by the tests there (tones, a steady input and square waves); the gates equal the model every clock at 12 bits on one input shape.

## Filters that learn (`adaptive`)

- Widrow and Hoff, 1960: the names and the year are **secondary**, from comments in the Linux kernel's `drivers/misc/echo/echo.h`, seen through search results. The title "Adaptive switching circuits" and its venue, IRE WESCON Convention Record, are **unread**, from memory: the search found neither, and the paper was not opened. The chapter says only that they took the one-sample gradient seriously in 1960.
- ITU-T G.168: **secondary**, an IEEE topic page seen through search results says it specifies test methods and requirements for digital network echo cancellers. The Recommendation was not opened, and the chapter claims no compliance.
- Levinson's recursion: **ran**, against scipy's `solve_toeplitz` (`scripts/dsp/oracle.py`, `tests/dsp/vectors/adaptive.json`).
- LMS, NLMS and the step bound 2 / ‖x‖²: standard, **unread**, from memory; the bound follows from one step's error, and where it really breaks is measured here on this far end: still converging at 1.3 times it, diverged at 1.4 times (`tests/dsp-echofigs.test.ts`). The far end is a public-domain recording, **read**: LibriVox's "The Gettysburg Address" read by Shurtagal (https://librivox.org/the-gettysburg-address-by-abraham-lincoln/; the footer: "LibriVox recordings are Public Domain in the USA. If you are not in the USA, please verify the copyright status of these works in your own country before downloading"; archive.org item gettysburg_shurtagal_librivox, licenseurl creativecommons.org/licenses/publicdomain), as public/dsp/voice-8k.wav: its first 4 s are the far end, and 0.875 s from 4 s in are the near-end talker. The file: https://archive.org/download/gettysburg_shurtagal_librivox/Gettysburg_Address_Lincoln_64kb.mp3 (its sha1 matches archive.org's), decoded in headless Chrome at 44.1 kHz, 6 s cut from 0:25, resampled 80/441 by the site's windowed sinc, its DC offset of −0.125 of full scale removed, peak at −1 dBFS, 16-bit. The echo paths and the room noise (0.003 of full scale, about −50 dB) are models, not measured paths.

## Speech (`speech`)

- ITU-T G.711 (1988), the ITU's free PDF: **read**, Tables 2a and 2b (μ-law, both signs), §§ 1–5 and their notes.
  - § 3.2's all-zero suppression is mentioned in its text, and not implemented here.
  - § 3.6 leaves the encoding of a sample exactly on a decision value to the equipment. Ours takes the interval above it, as Python's audioop does.
  - The tests check the table's printed decision and output values at every segment end, and every interior sample.
- Python 3.12's `audioop` (the C module, removed in 3.13; CI pins 3.12): **ran** (`scripts/dsp/oracle.py`).
  - `lin2ulaw` and `ulaw2lin` on all 16 384 samples and 256 codes.
  - `lin2adpcm` and `adpcm2lin` on the first 4 000 samples of the voice, in two halves with the state carried, and on a full-scale square wave. LPC against `solve_toeplitz` on 4 frames of it.
  - Our nibble order is audioop's (first sample in the high half). Microsoft's IMA ADPCM WAV format differs, **unread**, from memory.
- IMA's ADPCM recommendation (1992): **unread**, not freely available. The step and index tables are written from memory and checked against audioop above.
- LPC: the autocorrelation method and Levinson–Durbin, standard. Checked against scipy's `solve_toeplitz` on the voice's frames.
  - Pre-emphasis 0.9375, log-area ratios, centre clipping for pitch (Sondhi): **unread**, from memory.
  - FS-1015 / LPC-10 (54 bits every 22.5 ms, 2.4 kb/s, 1984): **unread**, from memory. The vocoder is ours and only laid out like it.
- The voice: LibriVox, "The Gettysburg Address" (Abraham Lincoln), read by Shurtagal. **read**:
  - catalog page https://librivox.org/the-gettysburg-address-by-abraham-lincoln/, whose footer says "LibriVox recordings are Public Domain in the USA. If you are not in the USA, please verify the copyright status of these works in your own country";
  - LibriVox's page https://librivox.org/pages/public-domain/: "all our recordings are public domain";
  - archive.org item `gettysburg_shurtagal_librivox`, `licenseurl` http://creativecommons.org/licenses/publicdomain/.
  - File: https://archive.org/download/gettysburg_shurtagal_librivox/Gettysburg_Address_Lincoln_64kb.mp3, 803 444 bytes. Its sha1 ed8e8827… matches archive.org's metadata; sha256 d9f40f96….
  - Processing:
    1. Decoded in headless Chrome 156 (`decodeAudioData`, 44.1 kHz mono).
    2. Cut at 0:25–0:31.
    3. Resampled 80/441 by this site's windowed sinc (`comm/signals.ts windowedSinc`, the polyphase sum checked equal to `dsp/multirate.ts upfirdn`).
    4. The recording's DC offset of −0.125 of full scale removed (mean, then a 6 Hz DC blocker).
    5. Peak at −1 dBFS, 10 ms fades, 16-bit.
  - `public/dsp/voice-8k.wav`, 96 044 bytes. Nobody has listened to it to check the excerpt's words.

## Music (`music`)

- The MDCT and TDAC (Princen–Bradley, 1986): standard, **unread**, from memory. Checked numerically: the MDCT equals scipy's DCT-IV of the folded frame (`oracle.py`), and the overlap-add reconstruction is within 10⁻¹².
- The masking model is **simplified and ours**: one-Bark bands, a 25 / 10 dB a Bark spreading triangle and a 14 dB offset.
  - Zwicker's Bark formula and Terhardt's threshold in quiet: **unread**, from memory.
  - The chapter and the widget both say this. No psychoacoustic standard (MPEG-1 Layer III's models, for instance) was read or followed.
- The codec is ours. It claims no format and no compatibility. Its figures are on this recording and by this model, pinned in `src/dsp/soundfigs.ts`.
- The music: Musopen, "The Complete Chopin Collection", Chopin's Nocturne in E minor, Op. 72 No. 1. **read**:
  - archive.org item https://archive.org/details/musopen-chopin, `licenseurl` http://creativecommons.org/publicdomain/zero/1.0/ (CC0 1.0), creator Aaron Dunn, uploader aaron@musopen.org.
  - The pianist is not named there, and musopen.org's own page could not be read (403).
  - File: https://archive.org/download/musopen-chopin/NocturneOp.72No.1InEMinor.m4a, Apple Lossless, 13 733 639 bytes. Its sha1 5f595333… matches archive.org's; sha256 c7cffd88….
  - Processing:
    1. Decoded losslessly with PyAV 19.0.2 (FFmpeg libavcodec 63; Chrome cannot decode ALAC).
    2. Mixed to mono and cut at 0:05–0:15.
    3. Resampled 160/441 by the same windowed sinc.
    4. Peak at −1 dBFS, 16-bit.
  - `public/dsp/nocturne-16k.wav`, 320 044 bytes.

## Pictures (`pictures`)

- ITU-T T.81 (CCITT Rec. T.81, 1992), the copy at w3.org/Graphics/JPEG/itu-t81.pdf: **read**, these parts only:
  - A.3.1 and A.3.3: the level shift and the FDCT / IDCT formulas, and the note that accuracy is set in Part 2, not by one method of computing;
  - A.3.4–A.3.6: quantization (round to nearest), DC differences and the zig-zag text;
  - Table K.1 and its paragraph ("used with good results");
  - Table K.3;
  - sheet 1 of Table K.5's 4 sheets.
  Figure A.6 itself, sheets 2–4 of K.5, Annex B (file syntax), Annex C (codes from the lists) and F.1.2 (coding, byte stuffing, padding) were **not opened**: they are written from memory, and checked by the runs below.
- Pillow 13.0.0, which bundles libjpeg-turbo 3.2.0 and reports libjpeg version 8.0 (`features.version('jpg')`): **ran** (`scripts/dsp/oracle.py`).
  - It wrote the quantization tables at nine qualities from 1 to 100, which are libjpeg's quality scaling, and the Huffman lists. jcparam.c was not opened.
  - Its DQT bytes are in zig-zag order, so mapping them back to K.1's layout also checks our zig-zag order.
  - Our AC codes match the 9 rows of K.5's sheet 1 compared here, and our DC codes match K.3. A review of the chapter then read all four sheets of K.5 and K.3.3.1–2 as text, and found all 162 AC codes and both lists equal.
  - It decodes our files to within one level of our reconstruction at every pixel. The checked-in ones are the scene at 96 × 96, qualities 10 and 75; the review also wrote 45 more (sizes not a multiple of 8, flat, sparse, noise, qualities 1–100) and found the same.
- scipy 1.16.3 `fft.dctn` (type 2, orthonormal) and `ndimage.correlate` / `correlate1d` (mode 'nearest'): **ran**, the same oracle.
- The browser's decode: measured by hand in headless Chrome, and again by the review: the largest difference from our reconstruction is 1 level at quality 75. Smoke only loads the step. Other browsers were not tried.
- BT.601's luminance weights (0.299, 0.587, 0.114) for a learner's own picture: **unread**, from memory.
- IEEE 1180: not used. There is no inverse DCT in gates, so its test does not apply.
- The DCT stage's cost and accuracy: measured from the gates and held by `tests/dsp-pictures.test.ts`. The cost of a 64-word transpose store is quoted as plain registers. That store is not built.
- Pictures: generated scenes, and one photograph, **read**: NASA's AS11-40-5903, Buzz Aldrin on the Moon, Apollo 11, 21 July 1969, photographed by Neil Armstrong.
  - Source: Wikimedia Commons, https://commons.wikimedia.org/wiki/File:Aldrin_Apollo_11_original.jpg, licence template {{PD-USGov-NASA}}: "This file is in the public domain in the United States because it was solely created by NASA."
  - Commons' metadata: LicenseShortName "Public domain", Copyrighted False; credited to the NASA Image and Video Library.
  - File: Commons' 960 px rendition (https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/Aldrin_Apollo_11_original.jpg/960px-Aldrin_Apollo_11_original.jpg), 280 403 bytes, sha256 7ea66a1e….
  - Processing: Pillow 13.0.0 converted it to grey ('L', ITU-R 601-2 luma), cropped a centred square, and resampled it to 192 × 192 with Lanczos. It is stored as public/dsp/aldrin-192.pgm, 36 879 bytes.
  - Commons warns that NASA's logos and insignia are restricted. None appears in this crop.

## A software radio (`sdr`)

- The band is synthesized (`src/dsp/sdr.ts`: four FM stations, complex baseband, 960 kHz, seeded Gaussian noise). No recording is used, so there is nothing to license and nothing outside to compare it with.
- Mixer and CIC: **the gates equal our integer model on every clock** (`tests/dsp-sdr.test.ts`: the mixer at three table sizes and tunings, the front end's I, Q and strobe, the typed-array model equal to the clock-by-clock one). The CIC's growth and wrap are Hogenauer's, already checked under `multirate`.
- The clip: the first 15 360 clocks of the band through the gates in a BitSim, then the same floating-point filters as the model. The test compares every word leaving the CIC and every audio sample. The browser renders it on a click (about 10 s measured in headless Chrome).
- Carson's rule, 2 (Δf + f<sub>m</sub>): **unread**, from memory. The chapter does not rest on it: the occupied band is measured from an FFT of one station (98 % of the power, `occupied()`), and `tests/dsp-sdr.test.ts` holds the rule to that within 10 % for modulation indices above 1 (102.0 against 102.0 kHz at 50 kHz and 1 kHz; 120.0 against 130 at 15 kHz). The measured 98 % bands against Carson's at a 15 kHz tone are 30 vs 40 kHz at β = 0.33, 60 vs 60 at β = 1, 90 vs 90 at β = 2 and 120 vs 130 at β = 3.3; the 99.9 % band at β = 3.3 is 150 kHz. So the rule is a convenient figure, not a bound either way. Each station's own highest audio frequency comes from its programme's parameters.
- 75 µs pre-emphasis time constant (North American broadcast) and FM's threshold "near 10 dB carrier to noise": **unread**, from memory. ITU-R BS.450 is not cited. The pre-emphasis here is a first-order digital filter and its exact inverse; it is not the analogue network's response. The threshold sentence is attributed to textbooks, and the weak station's measured keying ratio is shown beside the carrier-to-noise figure it comes with.
- The table-size findings are measured here (`mixerSfdr`, `keyingRatio`, `toneSnrOff`, `interferenceDb`; `tests/dsp-sdr.test.ts`), not quoted. Spur-free range rises 6 dB a bit. The weak station's keying shows a capture cliff (lost at 3 and 4 bits, then 15.7 dB at 5 and 36.7 at 6) and then saturates near 49 to 50 dB. That floor is the noise, not the table or the neighbours: at 12 bits and −40 dB of noise it is 49.7 dB with all four stations and 50.5 dB with the weak one alone; with the noise off it is 56.2 dB with all four and 66.3 dB alone, and that gap is the CIC's alias of the neighbours (a 12-bit table leaves them at −14.3 dB in the weak station's channel, the sweep's alias alone −14.5). The test tone does **not** show the table at all on its own frequency, and that is a property of its tuning word (45056 ends in 12 zero bits, so its phase lands on table points); tuned 100 Hz off it is 45.1 / 45.7 / 50.4 / 56.5 / 79.0 dB at 3 / 4 / 5 / 6 / 8 bits. An earlier version of the chapter said FM audio was immune; that was wrong, and is withdrawn.
- Test-tone SNR: a sine and cosine at 1 kHz fitted by least squares and subtracted from the audio; the rest is everything else. Measured at 80.6 dB with the noise at −40 dB, and 82.8 dB at −60 dB (the floor of this model's own arithmetic). The chapter prints the figures it computes; none is quoted.
- The channel filter, the discriminator, the audio filter and the de-emphasis are floating point in the model. Their DSP-core version is **not built**: it is listed in `Chapter.soon`.
- Nobody has listened to these clips either.

## Sound

- Nobody has listened to the clips, including the decimated sweeps in `multirate`. Headless Chrome confirms the buttons start and stop a buffer; it cannot tell what the sound is like. The claims in the text
  are the numbers beside each clip, and the sentence in "Wrap or saturate" about what you will hear has not been confirmed by ear.


## A DSP core

- The ISA (DSP24), its assembler, golden model, gates and benchmarks are our own, not a real DSP's. No vendor manual was read to design them. The ideas named (X and Y memories read in one clock, post-modify addressing, circular and bit-reversed modes, zero-overhead loops, a pipelined clock with delay slots in a real DSP) are textbook DSP-architecture general knowledge, **unread** here as sources: from memory, and the chapter attributes no figure to any product.
- The benchmark answers: scipy `signal.firwin`, `butter(output='sos')`, `lfilter`, `sosfilt` and `numpy.fft.fft`, **ran** (`scripts/dsp/oracle.py`, `tests/dsp/vectors/dspcore.json`). The exact integer answers are computed in the generator with the core's own rounding rule and held bit for bit by the gates; scipy's floating-point answers agree within 1 LSB (FIRs), 16 LSB (the biquad cascade, rounding noise of a recursive filter, tolerance 24) and 3 LSB (the FFT, tolerance 8).
- The gates equal the golden model at every clock on the five benchmarks, on random programs (valid and raw words) and a hand-made ALU corner program; eleven deliberately wrong models are each reported as a mismatch. This is verification against our own model, not against an independent implementation of DSP24.
- The cost figures are measured from the gates (`scripts/dsp/dspcore-bench.ts`); the cycle figures come from the model the gates equal. The RV32 columns are `src/dsp/macbench.json`, the MAC chapter's.
- Comparison caveats: the DSP core's clocks per product include its loop set-up, rounding and output instructions; the RV32 kernels exclude set-up. Block lengths differ, hence per product. The FFT has no RV32 counterpart.
- Not listened to, not read: nothing of sound. Secondary: none.
