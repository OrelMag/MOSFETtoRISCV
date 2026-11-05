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

## Sound

- Nobody has listened to the clips. Headless Chrome confirms the buttons start and stop a buffer; it cannot tell what the sound is like. The claims in the text
  are the numbers beside each clip, and the sentence in "Wrap or saturate" about what you will hear has not been confirmed by ear.

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
