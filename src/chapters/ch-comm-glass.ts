// Light in glass (level Communication): how bits cross an ocean. It starts where Fast serial links' reach comparison stops. All models (phys/fibre.ts), labelled as models: there are no
// gates here, and the only part with a transistor is the laser driver and the photodiode's amplifier, which the chapter leaves out. Model numbers below are computed by the models; dates, records and cable figures are typed, from public sources.

import { dbToRatio } from '../comm/limits';
import {
  acceptanceDeg, bestPower, beta2Of, BREF_GHZ, C_BAND, cdTaps, criticalDeg, cutoffUm, dispersionD, FEC_BER, FEC_RATE, gradedDelayPsKm, gridChannels, L_BAND, LAMBDA0, lossDb, maxSpans, minLoss, MMF_50, modesLarge, n2Of, naOf, osnrDb, photonFloorDbm, QAMS, reachNarrowKm, reachWideKm, requiredSnrDb, S0, SMF_G652, snrFromOsnr, spacingNm, stepDelayPsKm, vNumber,
} from '../phys/fibre';
import { amplifierWidget, coherentWidget, lossWidget, modesWidget, oceanWidget, pulseWidget, rayWidget, wdmWidget } from '../widgets/glass';
import { MMF, SMF } from '../widgets/serial';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';
import { fibre3d } from '../widgets/fibre3d';
import { withModel } from '../widgets/modelhost';

const nf = (x: number, d = 1) => x.toFixed(d);
const n0 = (x: number) => groupNum(Math.round(x));

// ---- numbers ---------------------------------------------------------------------------------------------------------------
const MIN = minLoss();
const NAS = naOf(SMF_G652.n1, n2Of(SMF_G652)), NAM = naOf(MMF_50.n1, n2Of(MMF_50));
const VS = vNumber(SMF_G652.aUm, NAS, 1.55), VM = vNumber(MMF_50.aUm, NAM, 0.85);
const D1550 = dispersionD(1550), B2 = beta2Of(D1550, 1550);
const C50 = gridChannels(50), CL50 = C50 + gridChannels(50, L_BAND);
const R16 = 2 * 32 * QAMS[1].bitsPerPolSym * FEC_RATE, R4 = 2 * 32 * QAMS[0].bitsPerPolSym * FEC_RATE;
const SPAN_KM = 60, SPAN_DB = SPAN_KM * 0.2 + 4, NFDB = 4.5;      // a span's loss with its splices and margin
const REQ = QAMS.map((q) => requiredSnrDb(q));
const REACH = REQ.map((r) => maxSpans(r, NFDB, SPAN_DB, 32) * SPAN_KM);
const OCEAN = Math.ceil(6600 / SPAN_KM), BEST = bestPower(OCEAN, NFDB, SPAN_DB, 32);

export const chGlass: Chapter = {
  id: 'glass', num: numOf('glass'), title: 'Light in glass', level: 'Communication',
  blurb: 'How bits cross an ocean: why glass, what keeps light in it, modes, chromatic dispersion, wavelength multiplexing, amplifiers, coherent detection and the Kerr limit. Models, labelled as models.',
  goals: [
    'explain the shape of the loss curve from two physical causes, and why communications settled at 1550 nm',
    'compute numerical aperture, the V number and the delay spread of a fibre, and say why long links are single mode',
    'work out how far a rate survives chromatic dispersion, for a clean laser and a wide source',
    'count the channels a band holds from its spacing and symbol rate, and what each carries',
    'budget a chain of amplifiers in OSNR, and turn that into a modulation and a reach',
    'say why launching more power stops helping, and what a coherent receiver buys that direct detection cannot',
  ],
  builds: ['serial', 'modem', 'carriers'],
  recap: {
    keep: [
      `Loss has a floor at about ${nf(MIN.um * 1000, 0)} nm: scattering falls as λ⁻⁴ from the left, infrared absorption rises from the right, and they meet at ${nf(MIN.db, 2)} dB/km in this model. That sets the distance between amplifiers.`,
      `A core keeps light by total internal reflection. Below V = 2.405 only one mode propagates, so there is no modal delay. Above it, modes arrive spread out: ${nf(stepDelayPsKm(MMF_50) / 1000, 0)} ns/km for a step core of 1 % index step.`,
      `Chromatic dispersion broadens a pulse by |β₂| L / T₀ once it is past its dispersion length, so the reach of a clean laser falls with the square of the rate: ${n0(reachNarrowKm(10, B2))} km at 10 Gb/s, ${nf(reachNarrowKm(40, B2), 1)} km at 40 Gb/s, unless something undoes it.`,
      `An amplifier adds noise as well as gain. OSNR = P − NF − span loss − 10 log N + 58 dB. So 3 dB of span loss costs what doubling the number of spans costs. Power would buy it all back, if the Kerr effect did not charge P³ for it.`,
      'A coherent receiver mixes the signal with a local laser and sees both field components, not just intensity. Everything linear (dispersion, polarization) can then be undone in a DSP, and the constellation can be as dense as the SNR pays for.',
    ],
    check: [
      {
        question: 'Why did long-haul systems move from 1310 nm to 1550 nm, when dispersion is near zero at 1310 nm?',
        options: ['Loss sets the amplifier spacing, it is lower at 1550, and erbium amplifiers work there; dispersion can be compensated or undone', 'Lasers do not work at 1310 nm', 'Dispersion is lower at 1550 nm', 'Water absorbs less at 1310 nm'],
        answer: 0,
        explain: `${nf(lossDb(1.31, 0), 2)} against ${nf(lossDb(1.55, 0), 2)} dB/km is ${nf((lossDb(1.31, 0) - lossDb(1.55, 0)) * 80, 0)} dB over an 80 km span, and the erbium amplifier's band is 1530 to 1565 nm. Dispersion became an engineering matter; loss stayed physics.`,
        why: ['', 'Lasers work well at 1310 nm; it is the first long-haul window.', `It is about ${nf(D1550, 0)} ps/(nm·km) at 1550, which is far more than at 1310.`, 'The water line is at 1383 nm, near 1310 but it is not why.'],
      },
      {
        question: 'Doubling the bit rate of an uncompensated link with a clean laser: what happens to its dispersion-limited reach?',
        options: ['It falls by four: pulses are half as long and spread twice as fast', 'It halves', 'It falls by sixteen', 'It is unchanged'],
        answer: 0,
        explain: 'The spectrum is twice as wide, so it spreads twice as fast, and a bit is half as long, so the same spread is twice as bad. Reach goes as 1 / B².',
        why: ['', 'That is the case of a source wider than the modulation.', 'That is what happens going from 10 to 40 Gb/s: four times the rate.', 'The reach depends on the rate, through the pulse\'s bandwidth.'],
      },
      {
        question: `Far past the optimum launch power, each extra dB lowers SNR by about 2 dB. Why?`,
        options: ['Nonlinear noise rises with P³ while the signal rises with P, so the ratio falls as P²', 'The amplifiers saturate', 'The fibre starts to absorb more', 'The receiver overloads'],
        answer: 0,
        explain: 'The Kerr effect makes the index depend on intensity, and in a wide WDM system the result looks like noise that goes as the cube of the power. Signal over that noise goes as P⁻².',
        why: ['', 'Amplifier saturation would hold the power down rather than make noise.', 'Loss in dB/km does not change with power at these levels.', 'A receiver has an attenuator in front of it. This is in the fibre.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'Why glass',
      body: `
        <p>The fast serial links chapter ended on a comparison: copper loses tens of dB a metre at tens of GHz, single-mode fibre about ${SMF.dbPerKm} dB a <em>kilometre</em> at 1310 nm (less at 1550 nm, as below) at any rate you could modulate. This chapter is about that fibre: what the loss is made of, how light stays in the glass, what happens to pulses over thousands of kilometres, and how a link under an ocean is budgeted. It has no gates in it. These are models, each tested against a closed form, and the prose says when it is simplifying.</p>
        <p>Purified silica has two ways to lose light. <strong>Rayleigh scattering</strong> comes from density fluctuations frozen in when the glass cooled, far smaller than a wavelength; it goes as λ⁻⁴, the reason the sky is blue. <strong>Infrared absorption</strong> is the Si–O bond vibrating, whose tail rises exponentially at long wavelengths. Between them there is a minimum at about ${nf(MIN.um * 1000, 0)} nm, ${nf(MIN.db, 2)} dB/km in this model: commercial low-loss fibre reaches about 0.15, and the record is near 0.14.</p>
        <p>Move the wavelength. At 850 nm, the first window, cheap lasers and silicon detectors work but the loss is ${nf(lossDb(0.85), 1)} dB/km of scattering alone (and a multimode core's heavier doping brings it to about ${MMF.dbPerKm}). At 1310 nm the glass alone loses ${nf(lossDb(1.31, 0), 2)} (a cabled span, with its splices and bends, the ${SMF.dbPerKm} above). At 1550 nm it is ${nf(lossDb(1.55), 2)}. Over 100 km that is the difference between ${nf(100 * 10 ** (-lossDb(1.55) * 100 / 10), 1)} % of the light left and ${nf(100 * 10 ** (-lossDb(1.31, 0) * 100 / 10), 1)} %. The bump at 1383 nm is OH⁻ left from manufacture, removed in "low water peak" fibre.</p>
        <p>History in one line: 17 dB/km was the 1970 Corning result that made fibre communication plausible (20 was the target of the day), and silica had reached 0.2 dB/km by 1979, close to this floor. The rest of the gains in this chapter came from what is done with the light.</p>`,
      widget: lossWidget,
      challenge: {
        kind: 'quiz',
        question: 'Halving the wavelength from 1.6 µm to 0.8 µm changes the scattering loss by what factor?',
        options: ['16 times more', '2 times more', '4 times more', 'Nothing: it depends on the glass only'],
        answer: 0,
        explain: 'Rayleigh scattering goes as λ⁻⁴. That is why the loss curve climbs so steeply towards the visible.',
        why: ['', 'That would be a law of λ⁻¹.', 'That would be λ⁻².', 'The glass sets the coefficient, and the wavelength sets the fourth power.'],
      },
      more: {
        numbers: `<p>Rayleigh A / λ⁴ with A = 0.75 dB/km·µm⁴, infrared 7.81 × 10¹¹ exp(−48.48 / λ) dB/km (the usual published fit), an illustrative Gaussian water line. The curve includes no bend or splice loss: real spans budget about 0.25 dB/km all in.</p>`,
      },
    },
    {
      title: 'What keeps the light in',
      body: `
        <p>A fibre is a core of slightly higher refractive index (germanium-doped) in a cladding of pure silica, 125 µm across. Light hitting the boundary from the denser side reflects totally if it meets it at more than the <strong>critical angle</strong> from the normal: sin θ<sub>c</sub> = n₂ / n₁, from Snell's law with the refracted ray at 90°. The reflection is lossless, which a metal mirror is not: light can bounce millions of times.</p>
        <p>The index step is tiny: Δ = (n₁ − n₂) / n₁ of ${nf(SMF_G652.delta * 100, 2)} % in single-mode fibre, so θ<sub>c</sub> is ${nf(criticalDeg(SMF_G652.n1, n2Of(SMF_G652)), 1)}° and only rays almost along the axis stay in. The number that says how much light a fibre accepts is its <strong>numerical aperture</strong>, NA = √(n₁² − n₂²) = ${nf(NAS, 3)}, the sine of the half-angle of the accepted cone in air: ±${nf(acceptanceDeg(NAS), 1)}°. That is why a laser, not an LED, couples into it. (Data sheets quote about 0.14 for this fibre, by a far-field definition; the Δ of 0.34 % gives the number here.)</p>
        <p>Raise the launch angle until the ray leaks. Then look at the "arrives late" number. A guided steep ray goes farther than one down the axis. That delay is the next step's trouble.</p>`,
      widget: () => withModel(rayWidget(), fibre3d()),
      challenge: {
        kind: 'quiz',
        question: 'A fibre with a larger index step accepts more light. Why is long-haul fibre made with a small one?',
        options: ['A large step means more modes and larger delay differences; a small step, with a small core, gives one mode', 'Dopant is expensive', 'A small step reduces loss by a large factor', 'A large step cannot be drawn into a fibre'],
        answer: 0,
        explain: 'NA grows with Δ, and so does V, the count of modes. Multimode systems trade reach for easy coupling; long haul wants one mode. Doping does also add some scattering, but that is the smaller effect.',
        why: ['', 'Doping costs little per kilometre. The modes are the reason.', 'It helps a little. It is not the deciding reason.', 'Multimode fibre has a step three times larger.'],
      },
    },
    {
      title: 'Modes',
      body: `
        <p>Rays are an approximation. The core is a waveguide, and only certain field patterns, <strong>modes</strong>, propagate. A mode must fit: the fields of a cylindrical guide are Bessel functions, and each mode has a cutoff at a zero of one. One number decides how many fit:</p>
        <p><code>V = 2π a NA / λ</code></p>
        <p>Below <strong>V = 2.405</strong>, the first zero of J₀, only the fundamental mode LP01 exists (in two polarizations). That is <strong>single-mode fibre</strong>: an ${nf(SMF_G652.aUm * 2, 0)} µm core with V = ${nf(VS, 2)} at 1550 nm, and a cutoff near ${nf(cutoffUm(SMF_G652.aUm, NAS) * 1000, 0)} nm below which it isn't single-mode any more. Press the presets: the same fibre at 850 nm carries several.</p>
        <p>A 50 µm core at 850 nm has V = ${nf(VM, 0)} and, with a step index, about ${n0(modesLarge(VM))} modes (V²/2; half that with the parabolic index below), which is why a cheap transmitter can couple into it. Each mode has its own speed, which in a step core gives a spread of n₁Δ/c: ${nf(stepDelayPsKm(MMF_50) / 1000, 0)} ns/km, about 10 MHz·km. The cure was a parabolic index profile, where a steep ray spends its extra distance in lower-index glass where light goes faster. In theory, with the profile tuned (α = 2 − 2Δ; a plain parabola gives Δ/2), the spread falls by Δ/8, to ${nf(gradedDelayPsKm(MMF_50), 0)} ps/km, and every 50/125 fibre in use is graded (ITU-T G.651.1): the 3D fibre starts graded, with sinusoidal rays, and its Step index switch shows the contrast. The ideal (about 7 000 MHz·km) is better than the real fibre, whose profile is never perfect: the ${MMF.modalMHzKm} MHz·km of OM4 fibre in the fast serial links chapter is the graded core as made, and by that chapter's table (bandwidth about 0.7 × the bit rate) it is about ${nf((MMF.modalMHzKm / (0.7 * 100000)) * 1000, 0)} m on one 100 Gb/s lane.</p>
        <p>Inside a data centre that is fine. Across anything longer, you pay for the harder alignment and take the single mode: no modal delay at all.</p>`,
      widget: () => withModel(modesWidget(), fibre3d()),
      challenge: {
        kind: 'quiz',
        question: `A fibre has V = 2.2 at 1550 nm. What happens at 850 nm in the same fibre?`,
        options: ['V rises to about 4, past the cutoff: it is multimode at that wavelength', 'V falls, and it guides nothing', 'It stays single-mode: V is a property of the fibre', 'It carries twice as many polarizations'],
        answer: 0,
        explain: 'V goes as 1 / λ: 2.2 × 1550 / 850 ≈ 4. Single-mode is a statement about a fibre at a wavelength.',
        why: ['', 'V rises as the wavelength falls.', 'V depends on the wavelength: that is the point of the formula.', 'Polarizations are per mode: more modes, more polarizations in total, each mode with its own.'],
      },
    },
    {
      title: 'Colours at different speeds',
      body: `
        <p>One mode still doesn't give one speed. Glass's index depends on wavelength (that is what a prism does), and a pulse holds a band of wavelengths. So its colours drift apart: <strong>chromatic dispersion</strong>, <code>D</code> in ps per nm of bandwidth per km. For standard fibre it crosses zero at ${LAMBDA0} nm and is about ${nf(D1550, 1)} ps/(nm·km) at 1550 (the G.652 fit (S₀/4)(λ − λ₀⁴/λ³) at the standard's largest slope, S₀ = ${S0}, so the top of the 16.5 to 17.5 real fibres show).</p>
        <p>Physicists write it β₂ = −Dλ²/(2πc) = ${nf(B2, 1).replace('-', '−')} ps²/km. A Gaussian pulse of half-width T₀ grows as T = T₀ √(1 + (|β₂| L / T₀²)²), where L<sub>D</sub> = T₀² / |β₂| is its <strong>dispersion length</strong>. Far past it, the width is proportional to distance and <em>inversely</em> to T₀: a short pulse has a wide spectrum and spreads fastest. So a pulse at twice the bit rate is half as long, spreads twice as fast and has half as much room: reach goes as <strong>1 / B²</strong>.</p>
        <p>The usual rule keeps the rms width below a quarter of a bit, which gives <code>L ≤ 1 / (16 B² |β₂|)</code>: ${n0(reachNarrowKm(10, B2))} km at 10 Gb/s and ${nf(reachNarrowKm(40, B2), 1)} km at 40 for a clean laser, one whose linewidth is less than its modulation. A cheap source a nanometre wide spreads by D Δλ regardless of the rate: ${nf(reachWideKm(10, D1550, 1), 1)} km at 10 Gb/s.</p>
        <p>Three cures, in order of history. Work at 1310 nm, where D ≈ 0, and take the higher loss. Build dispersion-shifted fibre (which, for many wavelengths at once, turned out to be nearly the worst thing to do: colours that stay in step beat together through the nonlinearity of the chapter's final step, <em>Budgeting an ocean</em>). Put in <strong>dispersion-compensating fibre</strong> of the opposite sign every span, the 1990s' solution. Or do it in a DSP, as now, since dispersion is linear and can be run backwards, the same mathematics in reverse.</p>`,
      widget: pulseWidget,
      challenge: {
        kind: 'quiz',
        question: 'Go from 10 Gb/s to 40 Gb/s on an uncompensated link with a clean laser. What happens to the reach?',
        options: ['It falls by sixteen', 'It falls by four', 'It stays the same, since the fibre has not changed', 'It rises, since the pulses are shorter'],
        answer: 0,
        explain: `${n0(reachNarrowKm(10, B2))} km against ${nf(reachNarrowKm(40, B2), 1)} km: reach goes as 1 / B², four times the rate, sixteen times less. That is why long-haul 40 and 100 Gb/s moved to coherent receivers to go far.`,
        why: ['', 'That is 1 / B, the case of a source wider than the signal.', 'The pulse has a wider spectrum at a higher rate, and spreads faster.', 'Shorter pulses spread faster, and have less room.'],
      },
    },
    {
      title: 'Many colours, one fibre',
      body: `
        <p>A lane of copper is one signal. A fibre carries many without them interfering, because light of different wavelengths doesn't interact (only weakly, through the Kerr effect of the final step), and a prism-like device can split them apart. That is <strong>wavelength division multiplexing</strong>.</p>
        <p>Channels sit on the ITU's grid, anchored at 193.1 THz (about 1552.5 nm), at 100, 50 or finer GHz spacing. The C band, 1530 to 1565 nm, is ${nf((299792.458 / C_BAND[0] - 299792.458 / C_BAND[1]), 1)} THz: ${C50} channels at 50 GHz, each ${nf(spacingNm(50, 1550), 1)} nm apart. Add the L band and it is ${CL50}. At 32 GBd, two polarizations and a rate-${FEC_RATE} code (forward error correction, FEC: a quarter more bits buy back a raw error rate of a few percent; <a href="#/c/errors/8">When bits go wrong</a> and <a href="#/c/codes/0">Codes near the limit</a> build such codes), QPSK is ${R4.toFixed(0)} Gb/s a channel and 16-QAM ${R16.toFixed(0)}, so 16-QAM over C alone is ${nf((C50 * R16) / 1000, 1)} Tb/s on a single fibre, each way.</p>
        <p>The bandwidth is there: the C band alone is ${nf(299792.458 / C_BAND[0] - 299792.458 / C_BAND[1], 1)} THz, more than ten times all the radio spectrum below 300 GHz. What limits a channel is not how fast you can modulate, but what the receiver's SNR will pay for. The next three steps are that budget.</p>
        <p>Change the symbol rate. A channel needs a little more than its symbol rate in bandwidth, so higher rates mean wider spacing with the same total: a modem at 128 GBd in 150 GHz is the same use of glass as four at 32 GBd in 37.5 GHz, but with fewer lasers.</p>`,
      widget: wdmWidget,
      challenge: {
        kind: 'quiz',
        question: 'What sets how many channels fit in a band?',
        options: ['The band divided by the channel spacing, and the spacing has to be a little more than the symbol rate', 'How many lasers the transmitter can power', 'The fibre\'s dispersion', 'The loss at the band\'s edges'],
        answer: 0,
        explain: 'Spacing times channels equals band. Faster symbols need wider spacing, so the band\'s capacity in symbols per second stays about the same whichever you choose.',
        why: ['', 'Lasers are a cost, not a limit on the number.', 'Dispersion stretches pulses. It does not move channels.', 'Loss varies only slightly across the band, and amplifiers flatten it.'],
      },
      more: {
        real: '<p>Multiplexers: arrayed waveguide gratings on a chip split the band with path-length differences, a prism made with interference. A wavelength-selective switch at a junction sends each channel down its own fibre without turning it into electricity first: a router made of mirrors, for traffic that keeps its own colour for a whole journey.</p>',
      },
    },
    {
      title: 'Amplifying light',
      body: `
        <p>Early links ended a span with a <em>regenerator</em>: a photodiode, a slicer and a new laser, per wavelength, in a box at the bottom of the sea. <strong>Erbium-doped fibre amplifiers</strong> (1987) removed all that: a few metres of fibre doped with erbium, pumped with a laser at 980 or 1480 nm, amplify all of 1530 to 1565 nm at once by stimulated emission, with no idea of the bit rate or format. That one device is why the C band is the C band, and why a cable laid for one modulation can be upgraded to the next by changing its ends.</p>
        <p>What amplifiers do is <em>add noise</em>: spontaneous emission, amplified along with the signal. The noise figure is the penalty, 3 dB at the quantum limit and about 4.5 to 6 in practice. Every amplifier resets the signal to the launch level, and adds its noise again. The measure is the <strong>OSNR</strong>, the optical signal-to-noise ratio, in dB:</p>
        <p><code>OSNR = P − NF − L<sub>span</sub> − 10 log₁₀ N − hνB</code></p>
        <p>where hνB in the 0.1 nm reference bandwidth (${BREF_GHZ} GHz) is ${nf(photonFloorDbm(1550), 1)} dBm: one photon's energy, per second, per hertz of that bandwidth. That is the famous "+58 dB" of the rule of thumb. Take 0 dBm per channel, ${NFDB} dB, 16 dB spans and 100 of them: OSNR = ${nf(osnrDb(0, NFDB, 16, 100), 1)} dB, an SNR of ${nf(snrFromOsnr(osnrDb(0, NFDB, 16, 100), 32), 1)} dB at 32 GBd. QPSK at the code's threshold needs ${nf(REQ[0], 1)} dB, 16-QAM ${nf(REQ[1], 1)}, 64-QAM ${nf(REQ[2], 1)}.</p>
        <p>Read the rule: a span twice as long costs what its dB say (linearly in km), but ten times the spans costs only 10 dB. So many short spans beat a few long ones, by a lot. Going from 16 dB to 8 dB spans doubles the amplifiers but gains ${nf(8 - 10 * Math.log10(2), 0)} dB. That is why cables under oceans have repeaters every 50 to 80 km, despite the cost of each.</p>`,
      widget: amplifierWidget,
      challenge: {
        kind: 'quiz',
        question: 'Keep total distance fixed and double the number of spans, halving each. What happens to OSNR, for a 16 dB span that is all fibre?',
        options: ['It rises by 5 dB: 8 dB less loss per span, 3 dB more amplifiers', 'It falls by 3 dB: twice as many amplifiers', 'It is unchanged: the same fibre, the same amplification', 'It rises by 8 dB'],
        answer: 0,
        explain: 'OSNR has −L_span − 10 log N. L_span goes down by 8 dB and N doubles, costing 3 dB: a net gain of 5.',
        why: ['', 'That counts only the amplifiers. Each now has less loss to make up.', 'Noise added depends on the gain of each amplifier, not just the sum.', 'That leaves out the 3 dB of more amplifiers.'],
      },
    },
    {
      title: 'A receiver that sees the field',
      body: `
        <p>A photodiode measures intensity. All phase information is gone: it can tell amplitude levels apart, as PAM4 does, and a pulse spread by dispersion stays spread, because the operation that made it can't be inverted from |A|² alone.</p>
        <p>A <strong>coherent receiver</strong> mixes the incoming light with a local laser on a 90° hybrid, an optical mixer, and balanced pairs of photodiodes, eight in all, read its I and Q in both polarizations. The ADCs get the optical field itself, as complex samples, the modem chapter's I and Q at 193 THz: mixing a light wave down to baseband, in effect. Everything linear that the fibre did can now be undone in a DSP.</p>
        <p>Here is QPSK at 32 GBd, simulated sample by sample. With the box unticked, 500 km of dispersion smears the symbols past recognition. <strong>Undo the dispersion</strong> by the opposite phase, frequency by frequency, and the four clusters come back with exactly the BER the SNR predicts: Q(√SNR). Dispersion was never lost information. At 6 000 km it would need ${n0(cdTaps(B2, 6000, 32))} taps at 64 GS/s; a frequency-domain equalizer does it by FFT, the many-carriers mathematics again.</p>
        <p>Add a laser's <strong>linewidth</strong>: a phase random-walk from the two lasers. Without help the constellation turns and smears into a ring; a <strong>carrier tracker</strong> that takes each symbol to the fourth power (which removes QPSK's data, leaving 4 × the phase) follows it. Real receivers do polarization separation (a 2 × 2 adaptive equalizer), clock recovery and soft-decision FEC as well, all in one modem chip at over 100 GBd.</p>
        <p>This is why 100 Gb/s and beyond are coherent across long distances, while short data-centre links stay with direct detection and PAM4: coherent optics are costly and the links are short enough that dispersion can be lived with.</p>`,
      widget: coherentWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why can a coherent receiver undo chromatic dispersion when a direct-detection one cannot?',
        options: ['It has the complex field, and dispersion is a linear all-pass filter on the field, so it inverts', 'It has more bandwidth', 'It runs at lower power', 'It uses a different fibre'],
        answer: 0,
        explain: 'Dispersion multiplies each frequency by a phase. Multiply by the opposite phase and it is gone. A photodiode\'s output, intensity, has already lost those phases.',
        why: ['', 'Bandwidth is not the difference; phase is.', 'Power cannot invert a phase operation; only knowing the phase can.', 'The fibre is the same; the receiver changes.'],
      },
    },
    {
      title: 'Budgeting an ocean',
      body: `
        <p>So why not just launch more power? Glass isn't quite linear. Its index depends slightly on intensity (the <strong>Kerr effect</strong>), and a mode only about 10 µm across makes the intensity of even a milliwatt large, so a signal shifts its own phase and its neighbours'. Across a band of channels that behaves like additional noise, growing as P³ (the Gaussian-noise model):</p>
        <p><code>SNR = P / (N·A + N·η·P³)</code></p>
        <p>where A is one span's amplifier noise and η the fibre's coefficient, here illustrative: nonlinear noise alone would leave 33 dB of SNR after a single span at 0 dBm. There is a best launch power, where nonlinear noise is half the amplifier noise. Below it you are short of signal; above it SNR falls, gently at first and then by 2 dB for each dB. No amount of power beats this: the fibre has a capacity.</p>
        <p>Take a 6 600 km ocean in 60 km spans, ${SPAN_DB} dB each with splices and margin, and ${NFDB} dB amplifiers: ${OCEAN} repeaters. Best launch is ${nf(BEST.pDbm, 1)} dBm, for ${nf(BEST.snrDb, 1)} dB of SNR. QPSK needs ${nf(REQ[0], 1)} dB and closes, with reach ${n0(REACH[0])} km; 16-QAM needs ${nf(REQ[1], 1)}, reach ${n0(REACH[1])} km; 64-QAM reach ${n0(REACH[2])} km. So the same fibre carries different rates over different distances, and modern modems choose: rate is traded for reach at the ends, without touching the wet part of the cable.</p>
        <p>Real figures to compare with: recent trans-Atlantic cables are 8 to 16 fibre pairs (MAREA 8, Dunant 12, Grace Hopper 16) at about 20 Tb/s per pair, with repeaters powered by a current of around an ampere fed at up to 10 to 15 kV down the cable's copper shell, from both ends. Each of the numbers worked here is in the design of one. At each end the light turns back into electrical lanes, of the kind in the fast serial links chapter, and joins the networks of the chapters ahead. Before that, the decoder this chapter took on trust: the next chapter builds codes from a single parity bit up.</p>`,
      widget: oceanWidget,
      challenge: {
        kind: 'quiz',
        question: 'A design closes at the optimum power with 1 dB of margin. Could you add 2 dB of launch power to add margin?',
        options: ['No: past the optimum, SNR falls; you need less loss, more spans or a lower modulation', 'Yes: more signal, more margin', 'Yes, if you also increase the amplifier gain', 'No, because the amplifier cannot produce that power'],
        answer: 0,
        explain: 'The optimum is where the marginal dB of signal is paid for exactly by nonlinear noise. Past it the slope is negative. Margin comes from the left of the formula: less loss per span or a better noise figure.',
        why: ['', 'That is true only below the optimum.', 'Gain matches span loss whichever the launch power is. It does not change the nonlinearity.', 'The amplifier could; it would just make things worse.'],
      },
      more: {
        numbers: `<p>${REQ.map((r, i) => `${QAMS[i].name}: ${nf(r, 1)} dB at a pre-FEC BER of ${FEC_BER}`).join(', ')}, a threshold standing for a strong soft-decision code of rate ${FEC_RATE}, taken as a constant. Shannon's capacity per channel at the SNR the panel shows is printed beside the rate. The η here is fit to a textbook span; a real design has its own value, with its fibre's effective area and each span's length. ${nf(dbToRatio(0), 0)} mW is 0 dBm.</p>`,
        pitfall: '<p>The model has one type of span and flat gain, no polarization effects beyond the receiver\'s, nonlinear noise adding span by span (real systems add a little faster, so its reach is slightly optimistic), and no margin for ageing. The last of these alone is several dB on a real cable, because it has to work for 25 years.</p>',
      },
    },
  ],
};
