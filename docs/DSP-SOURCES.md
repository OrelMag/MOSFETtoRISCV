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

## Converters (`converters`)

- 6.02 b + 1.76 dB, the R-2R ladder, DNL and INL, flash and SAR: standard results, **unread**, from memory; each is held numerically by `tests/dsp-converters.test.ts` where the chapter gives a number.
- The jitter limit, −20 log₁₀(2π f σ): **unread**, from memory, and measured here against a sampled sine.
- The linear model of a sigma-delta loop, π^(2L) / (2L + 1) and (20 L + 10) log₁₀ OSR: **unread**, from memory, and stated in `src/dsp/converters.ts`, not derived there. The loop's measured error power and its gap from the model are ours. The statement that an analogue integrator clips sooner is general, and no part's figures are quoted.
- V = z⁻¹U + (1 − z⁻¹)²E, every effective-bit figure, the integrators' peaks and the guard bits: computed on the model, and held by the tests there (tones, a steady input and square waves); the gates equal the model every clock at 12 bits on one input shape.

## Filters that learn (`adaptive`)

- Widrow and Hoff, 1960: the names and the year are **secondary**, from comments in the Linux kernel's `drivers/misc/echo/echo.h`, seen through search results. The title "Adaptive switching circuits" and its venue, IRE WESCON Convention Record, are **unread**, from memory: the search found neither, and the paper was not opened. The chapter says only that they took the one-sample gradient seriously in 1960.
- ITU-T G.168: **secondary**, an IEEE topic page seen through search results says it specifies test methods and requirements for digital network echo cancellers. The Recommendation was not opened, and the chapter claims no compliance.
- Levinson's recursion: **ran**, against scipy's `solve_toeplitz` (`scripts/dsp/oracle.py`, `tests/dsp/vectors/adaptive.json`).
- LMS, NLMS and the step bound 2 / ‖x‖²: standard, **unread**, from memory; the bound follows from one step's error, and the divergence just above it is measured here on this far end. The far-end sound and the echo paths are generated models, not recordings or measured paths.

## Pictures (`pictures`)

- ITU-T T.81 (CCITT Rec. T.81, 1992), the copy at w3.org/Graphics/JPEG/itu-t81.pdf: **read**, these parts only:
  - A.3.1 and A.3.3: the level shift and the FDCT / IDCT formulas, and the note that accuracy is set in Part 2, not by one method of computing;
  - A.3.4–A.3.6: quantization (round to nearest), DC differences and the zig-zag text;
  - Table K.1 and its paragraph ("used with good results");
  - Table K.3;
  - sheet 1 of Table K.5's 4 sheets.
  Figure A.6 itself, sheets 2–4 of K.5, Annex B (file syntax), Annex C (codes from the lists) and F.1.2 (coding, byte stuffing, padding) were **not opened**: they are written from memory, and checked by the runs below.
- Pillow 13.0.0, which bundles libjpeg-turbo 3.2.0 behind the libjpeg 8.0 API: **ran** (`scripts/dsp/oracle.py`).
  - It wrote the quantization tables at nine qualities from 1 to 100, which are libjpeg's quality scaling, and the Huffman lists. jcparam.c was not opened.
  - Its DQT bytes are in zig-zag order, so mapping them back to K.1's layout also checks our zig-zag order.
  - Our AC codes match the 9 rows of K.5's sheet 1 that were compared, and our DC codes match K.3.
  - It decodes this chapter's own files to within one level of our reconstruction at every pixel.
- scipy 1.16.3 `fft.dctn` (type 2, orthonormal) and `ndimage.correlate` / `correlate1d` (mode 'nearest'): **ran**, the same oracle.
- The browser's decode: measured in headless Chrome by smoke and by hand, with the largest difference from our reconstruction 1 level at quality 75. Other browsers were not tried.
- BT.601's luminance weights (0.299, 0.587, 0.114) for a learner's own picture: **unread**, from memory.
- IEEE 1180: not used. There is no inverse DCT in gates, so its test does not apply.
- The DCT stage's cost and accuracy: measured from the gates and held by `tests/dsp-pictures.test.ts`. The cost of a 64-word transpose store is quoted as plain registers. That store is not built.
- Pictures: generated scenes. The public-domain photograph the plan mentions is **owed**, not added.

## Sound

- Nobody has listened to the clips, including the decimated sweeps in `multirate`. Headless Chrome confirms the buttons start and stop a buffer; it cannot tell what the sound is like. The claims in the text
  are the numbers beside each clip, and the sentences in "Wrap or saturate" and in `converters`'s "Many bits from one" (every 64th bit against the CIC) about what you will hear have not been confirmed by ear.
