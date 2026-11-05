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
