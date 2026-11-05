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
