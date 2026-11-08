// Check yourself for the Signal processing level, group F: image sensors. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK11F: Record<string, Quiz[]> = {
  qe: [
    {
      question: 'Light at 900 nm reaches a back-illuminated pixel whose diode collects from the top 3 µm. Why is its QE low there?',
      options: ['Silicon absorbs 900 nm over about 33 µm, so most photons pass the diode', 'A 900 nm photon has too little energy to free an electron', 'Each 900 nm photon frees only half an electron', 'The microlens reflects infrared'],
      answer: 0,
      explain: 'The 1/e depth at 900 nm is about 33 µm (α ≈ 306 cm⁻¹), so 3 µm absorbs under a tenth of the light. The photon has 1.38 eV, above the gap.',
      why: ['', 'Silicon\'s gap is 1.12 eV; 900 nm is 1.38 eV.', 'A photon frees one electron or none; there are no halves.', 'The loss is in the silicon, not above it.'],
    },
    {
      question: 'Why does a back-illuminated pixel usually have a higher QE than a front-illuminated one of the same size?',
      options: ['Light reaches the diode without passing the metal wiring', 'Its silicon has a smaller band gap', 'It makes two electrons per photon', 'It has a larger full well'],
      answer: 0,
      explain: 'Front illumination sends light through the metal layers, which block and scatter part of it before it reaches silicon. Turned over, the diode faces the light.',
      why: ['', 'It is the same silicon.', 'Still one per photon.', 'The well holds charge; it does not collect light.'],
    },
  ],
  ccd: [
    {
      question: 'In a three-phase CCD, how does a charge packet move one gate along?',
      options: ['The next gate goes high, then the one it sits under goes low', 'The gate under it is pulsed negative to push it', 'The output amplifier pulls it along the register', 'It diffuses on its own between clock edges'],
      answer: 0,
      explain: 'Raising the next gate widens the well over both; lowering the first squeezes the charge into the second. Six such steps of three clocks move it one pixel.',
      why: ['', 'Charge flows to where the potential is highest, not away from a negative pulse alone.', 'The amplifier only senses what arrives at the end.', 'Diffusion is slow and has no direction.'],
    },
    {
      question: 'A 2048 × 2048 CCD has a CTE of 99.9999 % in the image and 99.9993 % in the register. What share of the far corner\'s charge reaches the output?',
      options: ['About 98.4 %', 'About 99.9999 %', 'About 50 %', 'All of it'],
      answer: 0,
      explain: '2048 parallel and 2048 serial transfers: 0.999999^2048 × 0.999993^2048 ≈ 0.998 × 0.986 = 0.984.',
      why: ['', 'That is one transfer.', 'That would need a CTE near 99.98 %.', 'Every transfer leaves a little behind.'],
    },
  ],
  aps: [
    {
      question: 'A floating diffusion has 2.67 fF. By how much does one electron move its voltage?',
      options: ['About 60 µV', 'About 1.6 µV', 'About 2.67 mV', '1 V'],
      answer: 0,
      explain: 'ΔV = q / C = 1.6 × 10⁻¹⁹ / 2.67 × 10⁻¹⁵ = 60 µV.',
      why: ['', 'That divides by a capacitance a hundred times too large.', 'That is C in fF read as mV.', 'One electron moves nothing by a volt.'],
    },
    {
      question: 'What does the transfer gate TX add to a 3T pixel?',
      options: ['It separates the photodiode from the node that is reset and read, so the reset can be sampled before the charge arrives', 'A second amplifier for each pixel', 'A storage node for a global shutter', 'A path for the column\'s current'],
      answer: 0,
      explain: 'In a 3T pixel the photodiode is the sense node, so its reset and its signal are in different readouts. With TX the reset is sampled, then the charge is transferred and sampled: correlated double sampling.',
      why: ['', 'The amplifier is still the one source follower.', 'A global shutter needs more than TX.', 'The column current flows through SF and SEL.'],
    },
  ],
  cds: [
    {
      question: 'Which noise does correlated double sampling remove?',
      options: ['The kTC noise frozen on FD by the reset', 'Photon shot noise', 'Dark current collected during the exposure', 'All noise between the two samples'],
      answer: 0,
      explain: 'The reset\'s error is the same in both samples and cancels. Shot noise and dark charge arrive with the signal and stay.',
      why: ['', 'Shot noise is in the signal itself.', 'Dark charge is added to the signal before the second sample.', 'Noise that changes between the samples does not cancel.'],
    },
    {
      question: 'A column ADC counts down while the ramp is below the reset level (5 counts) and up while it is below the signal level (23). What is left?',
      options: ['18', '28', '23', '−5'],
      answer: 0,
      explain: 'Down 5, then up 23: 23 − 5 = 18, the signal minus the reset.',
      why: ['', 'That adds the two instead of subtracting.', 'That forgets the down count.', 'That stops after the reset conversion.'],
    },
  ],
  rollingshutter: [
    {
      question: 'Why does a propeller look bent in a phone video?',
      options: ['Each row is exposed a little later than the one above, and the blade moves in between', 'The lens distorts fast-moving objects', 'The demosaicing smears moving edges', 'The exposure is too long'],
      answer: 0,
      explain: 'With a rolling shutter the bottom row is captured tens of milliseconds after the top, and each row sees the blade where it is at that moment.',
      why: ['', 'A lens does not know what moves.', 'Demosaicing works within a frame on neighbouring pixels, not over time.', 'A short exposure blurs less but bends just as much.'],
    },
    {
      question: 'What does a global shutter cost?',
      options: ['A storage node in every pixel: less area for the photodiode, and leakage while the charge waits', 'A slower ADC', 'A mechanical shutter', 'Nothing; it is simply better'],
      answer: 0,
      explain: 'Every pixel must hold its charge after the exposure ends until its row is read, so it needs a shielded storage node beside the photodiode.',
      why: ['', 'The ADCs are the same.', 'An electronic global shutter needs no moving parts.', 'The storage node takes area and adds noise.'],
    },
  ],
  bayer: [
    {
      question: 'In a Bayer RGGB tile, what share of the pixels measure green?',
      options: ['Half', 'A third', 'A quarter', 'All of them, with red and blue on top'],
      answer: 0,
      explain: 'Two of the four pixels in the tile are green, one red and one blue.',
      why: ['', 'That would be an RGB stripe pattern.', 'That is red, or blue.', 'Each pixel has one filter.'],
    },
    {
      question: 'Black-and-white stripes one pixel wide come out with colour fringes. Where do they come from?',
      options: ['Demosaicing guesses each pixel\'s missing colours from neighbours that saw different stripes', 'The colour filters leak', 'The lens disperses colour', 'Shot noise'],
      answer: 0,
      explain: 'At a pixel under a red filter on a white stripe, the green and blue estimates come from neighbours on black stripes: the guesses disagree, and the pixel turns coloured.',
      why: ['', 'Leaky filters would desaturate, not add fringes.', 'Lens dispersion exists but does not follow the pixel grid.', 'Noise is random, not patterned.'],
    },
  ],
  fullwell: [
    {
      question: 'A pixel holds 14 837 e⁻ and has 3.3 e⁻ of read noise. What is its dynamic range?',
      options: ['About 73 dB', 'About 14 dB', 'About 37 dB', 'About 87 dB'],
      answer: 0,
      explain: '20 log₁₀(14 837 / 3.3) = 20 log₁₀(4496) ≈ 73.1 dB.',
      why: ['', 'That forgets the factor 20 log.', 'That uses 10 log, as for power.', 'That would need under 0.7 e⁻ of read noise.'],
    },
    {
      question: 'In bright light a pixel collects 10 000 e⁻. Lowering its read noise from 3 e⁻ to 1 e⁻ changes its SNR by about how much?',
      options: ['Almost nothing: shot noise is 100 e⁻', 'It triples', 'It doubles', 'By 10 dB'],
      answer: 0,
      explain: 'SNR = 10 000 / √(10 000 + r²): 99.96 at 3 e⁻, 99.995 at 1 e⁻.',
      why: ['', 'Only in the dark does read noise dominate.', 'Same: shot noise is far larger here.', 'A 10 dB change would need the noise to fall by a factor of 3.'],
    },
  ],
};
