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
