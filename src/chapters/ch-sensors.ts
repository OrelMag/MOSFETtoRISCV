// Image sensors (level Signal processing): where a picture comes from. Light into charge in silicon (phys/imagesensor.ts), the CCD's
// clocked transfer (e2v CCD42-40, three-phase; Sony ICX285 for the four-phase interline kind), the 4T CMOS pixel with correlated double
// sampling at switch level (lib/sensor.ts PIXEL_4T), a row of single-slope column ADCs with digital CDS in gates (columnAdcRow), rolling
// against global shutter (Sony IMX183's row time), the Bayer mosaic, and the noise that limits a pixel. Placed before Pictures.

import {
  absorptionDepth, CCD42_40, ccdReadTime, ccdRetained, C_FD_FF, CG_4T, darkCurrent, dynamicRangeDb, ICX285, IMX183, ktcNoise, qe, rowTime,
  SI_CUTOFF_NM, singleSlopeTime, STACK_BSI, STACK_FSI,
} from '../phys/imagesensor';
import { groupNum } from '../sim/numfmt';
import { adcApi, adcScene, ccdWidget, colourWidget, lightWidget, noiseWidget, pixelApi, pixelScene, pixelWidget, shutterWidget } from '../widgets/sensors';
import { ccd3d } from '../widgets/ccd3d';
import { withModel } from '../widgets/modelhost';
import { pixel4t3d } from '../widgets/pixel4t3d';
import { numOf } from './order';
import type { Chapter } from './types';

const g = (x: number) => groupNum(Math.round(x));
const n1 = (x: number, d = 1) => x.toFixed(d);

export const chSensors: Chapter = {
  id: 'sensors', num: numOf('sensors'), title: 'Image sensors', level: 'Signal processing',
  blurb: 'Where a picture comes from: light into charge in silicon, the CCD\'s bucket brigade, the CMOS pixel and its correlated double sampling, column ADCs, rolling shutters, the Bayer mosaic, and the noise that limits a pixel.',
  goals: [
    'say how many electrons a photon of a given colour makes in silicon, and how deep it goes first',
    'clock charge through a CCD and say what a transfer efficiency of five nines costs across a large array',
    'read a 4T CMOS pixel with correlated double sampling, and convert a whole row at once with column ADCs',
    'tell shot noise, read noise and dark current apart, and find which one limits a pixel at a given light',
  ],
  builds: ['mosfet', 'dram', 'noise', 'converters'],
  recap: {
    keep: [
      `Silicon turns each photon above 1.12 eV (below ${g(SI_CUTOFF_NM)} nm) into at most one electron. Blue is absorbed in the first tenth of a micrometre, red in a few, near infrared tens deep: QE is how much of the light is absorbed where the diode collects it.`,
      'A CCD moves each pixel\'s charge, intact, from gate to gate under clocked phases to one output amplifier. Its weakness is the trip: every transfer leaves a little behind, and a large array needs thousands of transfers.',
      'A CMOS pixel converts its own charge to a voltage: the pinned photodiode empties onto a floating diffusion through TX, a source follower drives the column, and the column samples the reset level and the signal level. The difference cancels the reset\'s kTC noise.',
      'A rolling shutter starts each row one row time after the last, so fast motion bends and a short flash lights a band. A global shutter exposes every pixel at once and pays in area and noise.',
      'In the dark a pixel is limited by its read noise, in bright light by the photons\' own shot noise (SNR = √N), and at the top by its full well. Dynamic range is full well over read noise.',
    ],
    check: [
      {
        question: 'A blue photon (450 nm) and a red one (650 nm) are both absorbed by the same pixel. How many electrons does each make?',
        options: ['One each', 'More for the blue one, which has more energy', 'More for the red one, which goes deeper', 'Neither, below the band gap'],
        answer: 0,
        explain: 'Each photon above the band gap frees one electron–hole pair; the extra energy of the blue one ends as heat. Colour changes where it is absorbed, not how much charge it makes.',
        why: ['', 'The surplus energy is lost as heat, not as more electrons (until far ultraviolet).', 'Depth changes the chance of being collected, not the count.', 'Both are well above 1.12 eV.'],
      },
      {
        question: 'Why does correlated double sampling remove kTC noise?',
        options: ['Both samples see the same reset, so its error cancels in the difference', 'It averages two independent resets', 'It filters out high frequencies on the column', 'It doubles the signal and halves the noise'],
        answer: 0,
        explain: 'The reset freezes a random error on the floating diffusion. The reset sample and the signal sample both carry it, and the subtraction leaves only the charge that TX moved.',
        why: ['', 'Two independent resets would add their noise, not cancel it.', 'kTC noise is a constant offset for the whole readout, not a high frequency.', 'The signal is counted once; only the error cancels.'],
      },
      {
        question: 'A pixel has a full well of 15 000 e⁻ and 3 e⁻ of read noise. In bright light it collects 10 000 e⁻. What limits its SNR?',
        options: ['Shot noise: √10 000 = 100, far above 3', 'Read noise, always the largest in a CMOS pixel', 'Dark current, which grows with light', 'The full well, which it has reached'],
        answer: 0,
        explain: 'Shot noise is √N, 100 e⁻ here, against 3 e⁻ of read noise: SNR ≈ 100. Only in the dark, below about 10 e⁻, does the read noise matter.',
        why: ['', 'Read noise rules only when the signal is a few electrons.', 'Dark current depends on time and temperature, not on light.', '10 000 is below 15 000: the well is not full.'],
      },
    ],
  },
  steps: [
    {
      title: 'Light into charge',
      get body() {
        return `
        <p>A camera is a grid of buckets for electrons. Light enters silicon, and a photon with more energy than silicon's band gap (1.12 eV, so wavelengths below ${g(SI_CUTOFF_NM)} nm) lifts one electron into the conduction band, leaving a hole. A junction's field sweeps the electron into a well, and the well's count after the exposure is the pixel's value. One photon makes at most one electron: a blue photon's extra energy is lost as heat.</p>
        <p>How deep it goes first depends on its colour. Silicon absorbs blue in about ${n1(absorptionDepth(450), 2)} µm, green in ${n1(absorptionDepth(550), 1)}, red in ${n1(absorptionDepth(650), 1)}, and near infrared at 900 nm only after ${g(absorptionDepth(900))} µm (M. A. Green's table, 2008). A diode a few micrometres deep catches visible light well and lets most infrared go through.</p>
        <p>The share of photons that become counted electrons is the <strong>quantum efficiency</strong> (QE). It loses light above the silicon (microlens, colour filter, metal wiring) and light absorbed where nothing collects it. A front-illuminated pixel is lit through its own metal layers. A back-illuminated one is thinned and turned over, so light reaches the diode first: the Sony IMX183 reaches 79 % at 525 nm (FLIR's EMVA 1288 measurement). The curves are a one-dimensional absorption model fitted to such points, not a simulation of the device.</p>
        <div class="try">Move the wavelength from 400 to 1000 nm and watch the depth where the light is used up pass the back-illuminated diode's 3 µm.</div>`;
      },
      widget: () => lightWidget(),
      challenge: {
        kind: 'quiz', question: `Why does a ${n1(STACK_BSI.collect, 0)} µm deep photodiode see little light at 1000 nm?`,
        options: ['At 1000 nm silicon absorbs over about 150 µm, so most photons pass through', 'Photons at 1000 nm have too little energy to free an electron', 'The colour filter blocks it', 'The microlens cannot focus infrared'],
        answer: 0,
        explain: `α is about 64 cm⁻¹ there: the 1/e depth is ${g(absorptionDepth(1000))} µm, so a few micrometres absorb only a few percent. The photon has 1.24 eV, above the gap.`,
        why: ['', '1.24 eV is above the 1.12 eV gap; past 1107 nm that would be true.', 'A mono sensor has no colour filter and still loses it.', 'Focus does not change how deep silicon absorbs.'],
      },
    },
    {
      title: 'The CCD bucket brigade',
      get body() {
        return `
        <p>A charge-coupled device keeps each pixel's electrons in a potential well under a gate and moves them all to one amplifier. Three gates per pixel, clocked in phases: the packet sits under the gate held high; raise the next one, lower the first, and the packet slides over. Six steps of the three clocks move every packet in the array one pixel at once, like a bucket brigade (Boyle and Smith, Bell Labs, 1969).</p>
        <p>The numbers here are the Teledyne e2v CCD42-40, a scientific full-frame sensor: ${g(CCD42_40.cols)} × ${g(CCD42_40.rows)} pixels of ${CCD42_40.pitch} µm, three-phase image and register clocks, ${g(CCD42_40.fullWell)} e⁻ per pixel, ${CCD42_40.cg} µV per electron at the output. The rows shift down into a serial register, which shifts along to the output amplifier, the only place a charge becomes a voltage. Each gate is about ${n1(CCD42_40.gateLength, 1)} µm long: that is the pixel over three, as the datasheet gives no gate length.</p>
        <p>Every transfer leaves a little behind. The charge-transfer efficiency (CTE) is 99.9999 % per transfer in the image area and 99.9993 % in the register, and the far corner's charge makes ${g(4096)} transfers: ${n1(ccdRetained(2047, 2047) * 100, 1)} % of it arrives. At 99 % it would be gone. Reading the frame through one amplifier takes ${n1(ccdReadTime(3e6), 1)} s at 3 MHz, or ${n1(ccdReadTime(20e3) / 60, 1)} minutes at the 20 kHz where the noise is lowest (${CCD42_40.readNoise} e⁻). Consumer interline CCDs such as the Sony ICX285 (${ICX285.pitch} µm) clock their vertical registers in four phases instead, two gates high at a time: try both.</p>`;
      },
      widget: () => withModel(ccdWidget(), ccd3d()),
      challenge: {
        kind: 'quiz', question: 'A CCD with 99.99 % CTE moves a corner pixel through 4000 transfers. About how much of its charge reaches the amplifier?',
        options: ['67 %', '99.99 %', '96 %', '40 %'],
        answer: 0,
        explain: '0.9999^4000 = e^(−0.4) ≈ 0.67: a third is smeared into the pixels behind. That is why scientific CCDs need six nines.',
        why: ['', 'That is one transfer, not 4000.', 'That would need 99.999 %.', 'That would be about 99.98 %.'],
      },
    },
    {
      title: 'The CMOS active pixel',
      get body() {
        return `
        <p>A CMOS sensor gives every pixel its own amplifier, so nothing has to cross the array as charge. The usual pixel has four transistors (4T). A <strong>pinned photodiode</strong> collects the electrons; a transfer gate TX empties it onto a small node, the floating diffusion FD; a reset transistor RST sets FD to the supply; a source follower SF copies FD's voltage, and a select switch SEL puts it on the column line that every pixel in the column shares.</p>
        <p>FD's capacitance sets the gain: an electron moves it by q / C. At ${CG_4T} µV per electron FD is ${n1(C_FD_FF, 2)} fF. Sony does not publish the IMX183's conversion gain, so ${CG_4T} µV/e⁻ is an illustrative value for a ${IMX183.pitch} µm pixel; its full well of ${g(IMX183.fullWell)} e⁻ then moves FD ${g(IMX183.fullWell * CG_4T / 1000)} mV.</p>
        <p>One readout of a row: RST pulses, the column samples FD's reset level (SHR); TX pulses and the photodiode's electrons pull FD down; the column samples again (SHS). The reset leaves FD randomly off its nominal level, √(kTC)/q = ${n1(ktcNoise(C_FD_FF), 1)} e⁻ rms here, and the error stays until the next reset. Both samples carry it, so their difference does not. This is <strong>correlated double sampling</strong> (CDS). The pinned photodiode is what makes it possible: it empties completely through TX, so the reset happens before the charge arrives (Fossum and Hondongwa, 2014).</p>
        <div class="try">Press "Another reset" a few times: the signal sample alone wanders by tens of electrons, the CDS result stays put.</div>`;
      },
      widget: () => withModel(pixelWidget(), pixel4t3d()),
      challenge: {
        kind: 'quiz', question: 'Why must the reset level be sampled before TX, not after?',
        options: ['After TX the charge is on FD, and a new reset would wipe it, with a new kTC error', 'TX would discharge the column line', 'The source follower needs time to warm up', 'Sampling after TX doubles the signal'],
        answer: 0,
        explain: 'Correlated means the same reset: sample it, then add the charge, then sample again. A reset after the charge would destroy the signal and bring its own, uncorrelated, error.',
        why: ['', 'TX connects the photodiode to FD, not the column.', 'The follower has no warm-up; it is a transistor.', 'The signal is counted once either way.'],
      },
    },
    {
      title: 'The pixel, switch by switch',
      body: `
        <p>Here is the pixel in transistors, solved at switch level. The photodiode and the floating diffusion are nodes that keep their charge; when TX joins them they share it, ΣCV / ΣC. Reset, expose and read it: a dark pixel leaves FD high, the follower conducts and the column reads H, a threshold below the supply, as a real follower's output sits. A bright one pulls FD below the threshold, the follower turns off and the column's load pulls it to 0.</p>
        <p>The switch-level solver knows 0, 1, weak levels and shared charge, not a follower's analog output, so the voltages in between are the previous step's. A real pinned photodiode empties completely into FD rather than sharing; full light against none reads the same either way.</p>
        <div class="try">Reset, then Light, then Read. Then Reset, Dark, Read, and compare the columns.</div>`,
      scene: pixelScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Read a bright pixel: the column H at the reset sample and 0 at the signal sample.',
        check: (st) => !!pixelApi.get(st)?.bright(),
        hints: ['The panel\'s buttons run each phase in order: Reset, then an exposure, then Read.', 'Expose with Light, not Dark.'],
        answer: 'Reset empties the photodiode; Light fills it; Read pulses RST (the column reads H), then TX: the photodiode\'s charge pulls FD down and the column drops to 0.',
        solve: (st) => { pixelApi.get(st)?.demo(); },
      },
    },
    {
      title: 'Column ADCs and CDS',
      get body() {
        return `
        <p>A CMOS sensor reads a row at a time, and converts every column of it at once. Each column has a comparator and a counter; one ramp, shared by all, rises a step a clock. A column's counter runs until the ramp passes its sample. That is a <strong>single-slope ADC</strong>, slow alone (2<sup>12</sup> clocks for 12 bits, ${n1(singleSlopeTime(12, 400e6) * 1e6, 2)} µs at 400 MHz) and fast in parallel: the IMX183 converts its ${g(IMX183.cols)} columns together.</p>
        <p>The counter can do the CDS subtraction itself. Count <em>down</em> while the ramp is below the reset level, then <em>up</em> while it is below the signal level: what is left is signal − reset (Nitta et al., ISSCC 2006). The circuit here is that, in gates: a ${5}-bit ramp counter, a comparator and an up/down counter per column, four columns. The ramp is a counter's value, where silicon has an analog ramp and an analog comparator per column; the arithmetic is the same.</p>
        <div class="try">Convert the row, then draw other offsets and convert again: each column's reset differs, the counts do not.</div>`;
      },
      scene: adcScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Convert a row, with every column\'s count equal to signal − reset.',
        check: (st) => !!adcApi.get(st)?.agrees(),
        hints: ['The panel beside the circuit has the button.'],
        answer: 'Each column counted down through the reset ramp and up through the signal ramp, so its offset cancelled.',
        solve: (st) => { adcApi.get(st)?.run(); },
      },
    },
    {
      title: 'Rolling against global shutter',
      get body() {
        return `
        <p>Reading a row at a time means rows are exposed at different times. A <strong>rolling shutter</strong> starts each row's exposure one row time after the row above, and reads it one exposure later. The IMX183 reads ${g(IMX183.rows)} rows at ${IMX183.fps} frames a second: ${n1(rowTime() * 1e6, 1)} µs a row (the frame time over the rows, blanking ignored), ${n1(1000 / IMX183.fps, 1)} ms from top to bottom.</p>
        <p>Anything that moves in those milliseconds is drawn bent: a propeller's blades curve, a passing car leans. A flash shorter than the readout lights only the rows exposing at that moment. A <strong>global shutter</strong> ends every pixel's exposure at once by moving its charge into a storage node inside the pixel, then reads the stored rows at leisure. The storage node costs area that the photodiode no longer has, and it collects its own stray light and leakage while it waits.</p>
        <div class="try">Spin the propeller at 10 rev/s with a rolling shutter, then switch to global. Turn on the flash and shorten the readout.</div>`;
      },
      widget: () => shutterWidget(),
      challenge: {
        kind: 'quiz', question: `With a ${n1(1000 / IMX183.fps, 0)} ms readout, an edge crosses the frame at 1000 pixels a second. How far is the bottom of a vertical edge from its top?`,
        options: [`About ${n1(1000 / IMX183.fps, 0)} pixels`, 'None: each row is exposed for the same time', 'About 1000 pixels', 'One pixel per row'],
        answer: 0,
        explain: `The bottom row is read ${n1(1000 / IMX183.fps, 1)} ms after the top, and the edge moves 1000 px/s × 0.0455 s ≈ ${n1(1000 / IMX183.fps, 0)} pixels in that time.`,
        why: ['', 'Same length, different start: that is the point.', 'That would be a full second of readout.', 'It moves 1000 px/s, not one per row time.'],
      },
    },
    {
      title: 'Colour',
      body: `
        <p>A pixel counts electrons, not colours. A colour sensor puts a filter over each pixel in the <strong>Bayer</strong> pattern (Bryce Bayer, Kodak, 1976): a 2 × 2 tile of red, green, green, blue, half the pixels green because the eye resolves detail mostly in the green. The IMX183's colour version measures 63 % at 470 nm through its blue filters, 69 % at 525 nm through the green and 43 % at 640 nm through the red (FLIR's EMVA report): the filters cost light.</p>
        <p>Every pixel then has one colour of three, and <strong>demosaicing</strong> estimates the other two from its neighbours. Bilinear demosaicing, here, averages the nearest pixels that have the colour. It is exact on smooth areas and wrong where the scene changes from one pixel to the next: fine stripes and sharp edges grow colour fringes. Cameras use cleverer guesses, and the result goes on to <a href="#/c/pictures/0">the next chapter</a>, where a JPEG encoder compresses it.</p>
        <div class="try">Look at the stripes through the mosaic, then demosaiced: the black-and-white stripes come back coloured.</div>`,
      widget: () => colourWidget(),
      challenge: {
        kind: 'quiz', question: 'Why are half the pixels of a Bayer pattern green?',
        options: ['The eye takes most of its sense of detail from green', 'Green light carries the most energy', 'Silicon is most sensitive to green', 'Two greens make the demosaicing exact'],
        answer: 0,
        explain: 'Brightness detail comes mostly from the middle of the spectrum, so the pattern spends the most samples there.',
        why: ['', 'Blue photons carry more energy, and it does not matter for the count.', 'Silicon\'s QE is broad; the filter choice follows the eye.', 'No pattern makes demosaicing exact at sharp edges.'],
      },
    },
    {
      title: 'What limits a pixel',
      get body() {
        return `
        <p>Three noises decide what a pixel can see. <strong>Shot noise</strong>: photons arrive at random, so N electrons vary by √N, and the SNR can never beat √N. <strong>Read noise</strong>: the amplifier and the ADC add a few electrons whatever the light, ${IMX183.readNoise} e⁻ for the IMX183 and ${CCD42_40.readNoise} e⁻ for the CCD42-40 read slowly. <strong>Dark current</strong>: heat lifts electrons too, ${g(CCD42_40.darkAt293)} e⁻ a pixel a second in the CCD42-40 at 20 °C, halving about every 6 K as it cools (its datasheet's law): ${n1(darkCurrent(173) * 3600, 1)} e⁻ an hour at −100 °C, which is why astronomers cool their cameras.</p>
        <p>In the dark the read noise rules; above a few tens of electrons the photons' own randomness does; at the top the <strong>full well</strong> stops the count. Full well over read noise is the dynamic range: ${n1(dynamicRangeDb(IMX183), 1)} dB for the IMX183 (${g(IMX183.fullWell)} e⁻ over ${IMX183.readNoise}), ${n1(dynamicRangeDb(CCD42_40), 1)} dB for the CCD42-40, whose ${CCD42_40.pitch} µm pixels hold ten times the charge. Smaller pixels hold less charge and catch less light, which is why phone sensors combine several pixels in the dark.</p>
        <p>QE at 525 nm is ${Math.round(qe(525, STACK_BSI) * 100)} % back-illuminated against about ${Math.round(qe(525, STACK_FSI) * 100)} % front-illuminated in the model: the one number a design can still raise when the noise is down to the photons.</p>`;
      },
      widget: () => noiseWidget(),
      challenge: {
        kind: 'quiz', question: 'A pixel collects 25 e⁻ with 3.3 e⁻ of read noise and no dark current. What is its SNR?',
        options: ['About 4.4', '25', '5', '7.6'],
        answer: 0,
        explain: '25 / √(25 + 3.3²) = 25 / 5.7 ≈ 4.4. Shot noise alone would allow 5.',
        why: ['', 'That forgets the noise entirely.', 'That is the shot-noise limit alone, √25.', 'That is 25 over the read noise alone.'],
      },
    },
  ],
};
