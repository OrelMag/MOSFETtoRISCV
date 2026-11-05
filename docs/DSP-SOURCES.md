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
- The linear model of a sigma-delta loop, π^(2L) / (2L + 1) and (20 L + 10) log₁₀ OSR: **unread**, from memory, and derived in `src/dsp/converters.ts`. The loop's measured error power and its gap from the model are ours. The statement that an analogue integrator clips sooner is general, and no part's figures are quoted.
- V = z⁻¹U + (1 − z⁻¹)²E, every effective-bit figure, the integrators' peaks and the guard bits: computed, and held by the tests against the gates every clock.

## Filters that learn (`adaptive`)

- B. Widrow, M. E. Hoff, "Adaptive switching circuits", IRE WESCON Convention Record, 1960: **secondary**. The year and the names are from comments in the Linux kernel's `drivers/misc/echo/echo.h`, seen through search results; the paper was not opened. The chapter says only that they took the one-sample gradient seriously in 1960.
- ITU-T G.168: **secondary**, an IEEE topic page seen through search results says it specifies test methods and requirements for digital network echo cancellers. The Recommendation was not opened, and the chapter claims no compliance.
- Levinson's recursion: **ran**, against scipy's `solve_toeplitz` (`scripts/dsp/oracle.py`, `tests/dsp/vectors/adaptive.json`).
- LMS, NLMS and the step bound 2 / ‖x‖²: standard, **unread**, from memory; the bound follows from one step's error, and the divergence just above it is measured here on this far end. The far-end sound and the echo paths are generated models, not recordings or measured paths.

## Sound

- Nobody has listened to the clips, including the decimated sweeps in `multirate`. Headless Chrome confirms the buttons start and stop a buffer; it cannot tell what the sound is like. The claims in the text
  are the numbers beside each clip, and the sentence in "Wrap or saturate" about what you will hear has not been confirmed by ear.
