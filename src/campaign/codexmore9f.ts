// The fuller codex for the Signal processing level, group F: image sensors (codexdspf.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE9F: Record<string, CodexMore> = {
  qe: {
    idea: `A photon either frees one electron in the silicon or it does not; colour decides where. The absorption coefficient α falls by four orders of magnitude from blue to the band edge, so the light a pixel uses is the light absorbed between its dead surface layer and the depth its junction still collects from. Optics above the silicon take their share first. QE is the product, measured per wavelength.`,
    example: {
      title: 'Where the light goes',
      body: `<pre>wavelength   α (cm⁻¹)    1/e depth
450 nm       25 500      0.39 µm
550 nm        6390      1.56 µm
650 nm        2810      3.6 µm
900 nm          306      33 µm
1000 nm          64      156 µm     (Green 2008)
IMX183, back-illuminated: 79 % at 525 nm (EMVA 1288)</pre>A 3 µm diode keeps most of the visible light and loses most of the infrared through its back.`,
    },
    mistakes: [
      'Thinking a blue photon makes more electrons than a red one. Each makes one; the surplus energy is heat.',
      'Quoting QE without a wavelength. A sensor\'s QE is a curve, and its peak hides the ends.',
      'Comparing a colour sensor\'s QE with a mono one\'s: the colour filter takes a third or more.',
    ],
    chapters: [{ chapter: 'sensors', step: 0, label: 'Light into charge' }, { chapter: 'sensors', step: 7, label: 'What limits a pixel' }],
  },
  ccd: {
    idea: `A CCD is a shift register for charge. Gates over thin oxide make wells; holding one gate high and the next low keeps a packet in place, and walking the high gate along drags it. Three phases are the fewest that move charge one way; consumer interline parts such as the Sony ICX285 clock their vertical registers in four, two gates high at a time. All the conversion happens in one amplifier at the end, which is why a CCD can be very quiet and why it is slow.`,
    example: {
      title: 'The CCD42-40 frame',
      body: `<pre>2048 × 2048 pixels, 13.5 µm, three phases
transfers for the far corner:   2048 + 2048 = 4096
kept: 0.999999^2048 × 0.999993^2048 = 98.4 %
read time, one output:  4 194 304 px / 3 MHz  = 1.4 s
                        4 194 304 px / 20 kHz = 3.5 min
full well 150 000 e⁻ × 4.5 µV/e⁻ = 675 mV at the output</pre>`,
    },
    mistakes: [
      'Thinking each pixel has an amplifier. In a CCD only the output node converts charge to voltage.',
      'Ignoring CTE. 99.99 % sounds perfect, and after 4000 transfers it keeps 67 %.',
      'Reading a CCD fast and expecting its datasheet noise: the quoted few electrons are at slow pixel rates.',
    ],
    chapters: [{ chapter: 'sensors', step: 1, label: 'The CCD bucket brigade' }],
  },
  aps: {
    idea: `In an active pixel every pixel carries its own amplifier, a source follower, and a switch onto its column. The four-transistor form adds a transfer gate between a pinned photodiode and a small floating diffusion, which separates collecting charge from converting it: the photodiode can be large and the diffusion small, and the reset can happen before the charge arrives, which CDS needs.`,
    example: {
      title: 'Gain from capacitance',
      body: `<pre>conversion gain = q / C_FD
C_FD = 2.67 fF   →  60 µV per electron
14 837 e⁻ (IMX183 full well) → 0.89 V swing on FD
kTC noise: √(kTC)/q = 20.8 e⁻ rms at 300 K</pre>The IMX183 does not publish its gain; 60 µV/e⁻ is illustrative for a 2.4 µm pixel.`,
    },
    mistakes: [
      'Expecting the column to follow FD exactly. A source follower has a gain below one and sits a threshold below its gate.',
      'Calling any CMOS pixel "4T". Global-shutter and high-dynamic-range pixels add storage nodes and switches.',
      'Forgetting that a row is read at a time: that is where the rolling shutter comes from.',
    ],
    lib: 'pixel4t',
    chapters: [{ chapter: 'sensors', step: 2, label: 'The CMOS active pixel' }, { chapter: 'sensors', step: 3, label: 'The pixel, switch by switch' }],
  },
  cds: {
    idea: `Opening a switch onto a capacitor freezes a random voltage on it, √(kT/C): kTC noise. It is the same for as long as the node is not reset again. Correlated double sampling samples the node right after the reset and again after the signal is added, and subtracts. The frozen error is in both samples and leaves; so do fixed offsets of the follower and column. What the subtraction cannot remove is noise that changes between the two samples.`,
    example: {
      title: 'Down, then up',
      body: `<pre>column ADC with an up/down counter (Nitta et al., ISSCC 2006):
reset level 3 counts:   count down while ramp < 3   →  −3
signal level 21 counts: count up   while ramp < 21  →  +18
left in the counter: 21 − 3 = 18 = signal − reset</pre>Every column's offset cancels without an analog subtraction.`,
    },
    mistakes: [
      'Sampling the reset after the signal: a second reset brings a new, uncorrelated error.',
      'Expecting CDS to remove shot noise or dark current. Those arrive with the signal.',
      'Thinking CDS halves the noise. It removes the correlated part and adds the two samples\' uncorrelated noise.',
    ],
    chapters: [{ chapter: 'sensors', step: 2, label: 'The CMOS active pixel' }, { chapter: 'sensors', step: 4, label: 'Column ADCs and CDS' }],
  },
  rollingshutter: {
    idea: `A sensor that reads a row at a time can either expose the rows one after the other, each for the same length of time but starting a row time apart, or expose them all at once and store the result in the pixels. The first is simple and cheap; the second freezes motion but needs a storage node in every pixel.`,
    example: {
      title: 'The IMX183\'s timing',
      body: `<pre>3694 rows, 21.98 frames a second
row time = 1 / (21.98 × 3694) = 12.3 µs   (blanking ignored)
top to bottom = 45.5 ms
an edge at 1000 px/s leans 1000 × 0.0455 = 45 pixels</pre>`,
    },
    mistakes: [
      'Thinking a short exposure removes the skew. It shortens each row\'s exposure but not the delay between rows.',
      'Expecting a flash to light the whole frame: only the rows exposing during it see it.',
      'Calling a global-shutter sensor free of motion blur. It freezes the timing across rows; each pixel still blurs over its own exposure.',
    ],
    chapters: [{ chapter: 'sensors', step: 5, label: 'Rolling against global shutter' }],
  },
  bayer: {
    idea: `The colour filter array makes each pixel measure one band; the picture's three colours a pixel are reconstructed. Bayer's 2 × 2 tile gives green twice the samples of red or blue, matching the eye's sensitivity to detail. Demosaicing interpolates; at edges and fine detail the interpolations of the three colours disagree and draw colours that were not there.`,
    example: {
      title: 'One tile',
      body: `<pre>R G
G B      a pixel at (x, y): R if x and y even, B if both odd, else G
bilinear: G at an R pixel = the mean of its four edge neighbours
          R at a B pixel  = the mean of its four corner neighbours</pre>`,
    },
    mistakes: [
      'Counting a 20 MP colour sensor as 20 million full-colour samples: it has 10 million green, 5 million red, 5 million blue.',
      'Blaming the lens for colour fringes on fine stripes: demosaicing makes them.',
      'Assuming the filters pass one wavelength each. They pass broad, overlapping bands, and the camera\'s colour matrix untangles them.',
    ],
    chapters: [{ chapter: 'sensors', step: 6, label: 'Colour' }, { chapter: 'pictures', step: 0, label: 'A picture is a signal' }],
  },
  fullwell: {
    idea: `A pixel's response is linear up to its full well and flat above it. With the read noise it fixes the range a single exposure can hold. In between, the noise is the photons' own, √N, so a pixel's SNR in good light is set by how many electrons it can collect: a bigger well, larger pixels and higher QE all help, and nothing else does.`,
    example: {
      title: 'Two sensors',
      body: `<pre>             full well   read noise   range
IMX183       14 837 e⁻   3.3 e⁻       73.1 dB   (2.4 µm)
CCD42-40    150 000 e⁻   3 e⁻         94.0 dB   (13.5 µm)
SNR at 10 000 e⁻: 10 000 / √(10 000 + 3.3²) = 99.9</pre>`,
    },
    mistakes: [
      'Quoting dynamic range from the ADC\'s bits. A 14-bit ADC on a 73 dB pixel still delivers 73 dB.',
      'Expecting more read-noise reduction to help in daylight: there the shot noise is already far larger.',
      'Exposing past the full well and expecting the highlights back later: above it the count is clipped and the detail is gone.',
    ],
    chapters: [{ chapter: 'sensors', step: 7, label: 'What limits a pixel' }],
  },
};
