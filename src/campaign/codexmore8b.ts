// The fuller codex for the Communication extension: glass, radio, wifi, cellular (codexcomm2b.ts holds the summaries). No DOM.
// Every number is the chapter's own, from phys/ and comm/ models; tests/content-codexcomm2b.test.ts pins them to the models and to the steps that print them.

import type { CodexMore } from './codexmore';

export const MORE8B: Record<string, CodexMore> = {
  dispersion: {
    idea: `Glass has a refractive index that depends on wavelength, and a modulated pulse is a band of wavelengths, so its colours drift apart along the fibre: <b>chromatic dispersion</b>, D in ps per nm of bandwidth per km. For standard single-mode fibre D crosses zero at 1310 nm and is about 17.5 ps/(nm·km) at 1550 nm. The wave-optics form is β<sub>2</sub> = −Dλ² / (2πc), −22.3 ps²/km there. A Gaussian pulse of half-width T<sub>0</sub> grows as T = T<sub>0</sub> √(1 + (|β<sub>2</sub>| L / T<sub>0</sub>²)²), with dispersion length L<sub>D</sub> = T<sub>0</sub>² / |β<sub>2</sub>|. Far past L<sub>D</sub> the width is proportional to distance and <i>inversely</i> to T<sub>0</sub>: a short pulse has a wide spectrum and spreads fastest.<br><br>So doubling the bit rate halves the pulse and doubles its spreading rate: keeping the rms width below a quarter of a bit gives L ≤ 1 / (16 B² |β<sub>2</sub>|), reach falling as <b>1 / B²</b>. A cheap source with a spectrum Δλ wide spreads by D Δλ whatever the bit rate, and its reach falls only as 1 / B. The cures came in order: work at 1310 nm where D is nearly zero and take the higher loss; add dispersion-compensating fibre of the opposite sign each span; or, since dispersion is a linear all-pass filter on the field, do it in a DSP behind a coherent receiver. Dispersion-shifted fibre (D near zero in the C band) turned out to be nearly the worst choice for many wavelengths at once: colours that stay in step beat together through the Kerr nonlinearity.`,
    example: {
      title: 'Reach of a 1550 nm link without compensation',
      body: `<pre>D = 17.5 ps/(nm·km)      β₂ = −22.3 ps²/km
clean laser:  L ≤ 1 / (16 B² |β₂|)
   10 Gb/s   28 km        40 Gb/s   1.8 km    (÷ 16 for × 4 the rate)
1 nm source:  L ≈ 1 / (4 B D Δλ)
   10 Gb/s   1.4 km       (÷ 4 for × 4 the rate)</pre>A 10 Gb/s channel across an ocean therefore needs the dispersion taken out, and 40 Gb/s took coherent receivers to go far.`,
    },
    mistakes: [
      'Treating dispersion as lost information: it multiplies each frequency of the field by a phase, which the opposite phase removes. A direct-detection receiver has thrown the phases away; a coherent one has not.',
      'Scaling reach as 1 / B: that holds for a source wider than the signal. A clean laser has reach 1 / B², sixteen times less for four times the rate.',
      'Confusing it with modal dispersion: a multimode core spreads pulses because modes travel at different speeds; a single-mode fibre has one mode and still spreads colours.',
      'Picking zero-dispersion fibre for a many-channel system: with D near zero the channels stay in step and the nonlinearity mixes them, which is why dispersion-shifted fibre lost to fibre with dispersion that is removed afterwards.',
    ],
    chapters: [
      { chapter: 'glass', step: 3, label: 'Colours at different speeds' },
      { chapter: 'glass', step: 6, label: 'A receiver that sees the field' },
    ],
  },
  wdm: {
    idea: `Light of different wavelengths hardly interacts in glass, and a prism-like device (an arrayed waveguide grating on a chip) can split them again, so a fibre carries many independent channels: <b>wavelength-division multiplexing</b>. Channels sit on the ITU grid anchored at 193.1 THz (about 1552.5 nm) at 100, 50 or finer GHz spacing. The C band, 1530 to 1565 nm, is 4.4 THz wide: 87 channels at 50 GHz, 0.4 nm apart. Adding the L band makes 229.<br><br>The bandwidth is not the limit; the receiver's SNR is. A channel needs a little more than its symbol rate in bandwidth, so a faster symbol rate needs wider spacing and the band holds about the same symbols a second: one channel of 128 GBd in 150 GHz uses the glass as four of 32 GBd in 37.5 GHz, with fewer lasers. What the multiplexing relies on is that one amplifier serves every channel (see the optical amplifier), and what it pays for is a little interaction through the Kerr effect, which is why launch power has an optimum. At a switching junction a wavelength-selective switch sends each colour down its own fibre without turning it into electricity.`,
    example: {
      title: 'What the C band carries',
      body: `<pre>4.4 THz of C band / 50 GHz = 87 channels, 0.4 nm apart  (+ L band: 229)
32 GBd, 2 polarizations, code rate 0.8:
   QPSK     2 × 32 × 2 × 0.8 = 102 Gb/s a channel
   16-QAM   2 × 32 × 4 × 0.8 = 205 Gb/s a channel
87 × 205 Gb/s = 17.8 Tb/s on one fibre, each way</pre>Whether 16-QAM closes is the amplifier chain's question, not the grid's.`,
    },
    mistakes: [
      'Thinking the channel count is set by the lasers: it is the band divided by the spacing, and the spacing must exceed the symbol rate.',
      'Expecting a higher symbol rate to raise the total: a full band holds about the same symbols a second, and the rate per channel only changes how many lasers it takes.',
      'Assuming channels never interact: at low power they do not, but the Kerr nonlinearity couples them, and past the optimum launch power it limits every channel.',
      'Putting one amplifier per wavelength: an erbium amplifier takes the whole band at once, which is why the C band is the C band.',
    ],
    chapters: [
      { chapter: 'glass', step: 4, label: 'Many colours, one fibre' },
      { chapter: 'glass', step: 5, label: 'Amplifying light' },
    ],
  },
  edfa: {
    idea: `Early links ended each span with a regenerator, a photodiode, a slicer and a new laser per wavelength. The erbium-doped fibre amplifier (1987) removed it: a few metres of fibre doped with erbium, pumped by a laser at 980 or 1480 nm, amplify all of 1530 to 1565 nm at once by stimulated emission, knowing nothing of bit rate or format. A cable laid for one modulation can then be upgraded by changing its ends.<br><br>An amplifier amplifies, it does not regenerate: it adds spontaneous emission, which is amplified with the signal. The noise figure is the penalty, 3 dB at the quantum limit and 4.5 to 6 dB in practice. Each amplifier resets the level and adds its noise again, so for N identical spans <b>OSNR = P − NF − L<sub>span</sub> − 10 log<sub>10</sub> N − hνB</b>, where hνB in the 0.1 nm reference bandwidth (12.5 GHz) is −58.0 dBm, the energy of one photon per second per hertz of that bandwidth. Loss per span enters in dB, the span count only as 10 log N: ten times the spans cost 10 dB, a span 8 dB shorter gains 8. Many short spans beat a few long ones, which is why ocean cables have a repeater every 50 to 80 km.`,
    example: {
      title: 'Whether 100 spans close',
      body: `<pre>0 dBm a channel, NF 4.5 dB, 16 dB spans, N = 100
OSNR = 0 − 4.5 − 16 − 20 + 58.0 = 17.5 dB in 12.5 GHz
at 32 GBd: SNR = 17.5 + 10 log(12.5/32) = 13.4 dB
needed at the code's threshold:  QPSK 6.3   16-QAM 12.7   64-QAM 18.4 dB
→ 16-QAM closes with 0.7 dB; 64-QAM does not
halve the spans to 8 dB, double their number: −3 dB, +8 dB → +5 dB</pre>That ignores the nonlinear noise of the last step of the chapter, which sets how much of this the launch power can buy.`,
    },
    mistakes: [
      'Calling the amplifier a repeater that cleans the signal: it adds noise at every stage, and the noise accumulates, so a chain of N amplifiers is N times as noisy in power.',
      'Spacing amplifiers to save money by lengthening spans: loss counts in dB per span against only 10 log N for the count, so a longer span costs far more than the amplifiers it saves.',
      'Quoting OSNR without its reference bandwidth: the −58.0 dBm floor is for 12.5 GHz, and the SNR at a 32 GBd symbol rate is a different number from the OSNR.',
      'Expecting more launch power to fix a shortfall: past the optimum the fibre\'s nonlinearity grows faster than the signal.',
    ],
    chapters: [
      { chapter: 'glass', step: 5, label: 'Amplifying light' },
      { chapter: 'glass', step: 7, label: 'Budgeting an ocean' },
    ],
  },
  coherent: {
    idea: `A photodiode responds to |A|², intensity, and every phase is gone: it can tell amplitude levels apart (PAM4) but a pulse spread by dispersion stays spread, since the operation cannot be inverted from |A|² alone. A <b>coherent receiver</b> mixes the incoming light with a local laser on a 90° optical hybrid and reads the result on balanced pairs of photodiodes, eight in all: I and Q in each of two polarizations. The ADCs get the optical field itself as complex samples, the modem chapter's I and Q at 193 THz brought down to baseband.<br><br>What follows is arithmetic. Dispersion multiplies each frequency by a phase, so a DSP multiplies by the opposite phase (a frequency-domain equalizer, by FFT) and the QPSK clusters return with exactly the BER the SNR predicts, Q(√SNR). A real receiver also tracks the two lasers' phase wander (raising each QPSK symbol to the fourth power removes its data and leaves four times the phase), separates the polarizations with a 2 × 2 adaptive equalizer, recovers the clock and decodes with soft-decision FEC, all in one modem chip. It is costly, so short data-centre links keep direct detection with PAM4.`,
    example: {
      title: 'Undoing six thousand kilometres',
      body: `<pre>β₂ = −22.3 ps²/km    L = 6000 km    32 GBd sampled at 64 GS/s
time-domain filter to invert it: 3 439 taps
received QPSK: smeared ring → undone → four clusters at BER Q(√SNR)
photodiodes: 2 polarizations × I, Q = 8</pre>In silicon this is an FFT, multiply, inverse FFT, the many-carriers mathematics again, not a 3 439-tap filter.`,
    },
    mistakes: [
      'Assuming a direct-detection receiver could compensate dispersion given enough DSP: it has only |A|², and the phases that carry the distortion are gone before the ADC.',
      'Thinking the local laser must be locked to the transmitter: the phase random walk between the two lasers is followed by a carrier tracker in the DSP, which is why linewidth matters.',
      'Forgetting the lasers\' phase wander: the linewidths of the two lasers turn the constellation into a ring until a carrier tracker follows it.',
      'Using coherent optics everywhere: a data-centre link is short enough to live with dispersion, so cost decides for direct detection.',
    ],
    chapters: [
      { chapter: 'glass', step: 6, label: 'A receiver that sees the field' },
      { chapter: 'glass', step: 3, label: 'Colours at different speeds' },
    ],
  },
  linkbudget: {
    idea: `Losses multiply, so radio engineers add in dB. Start at the transmitter, add the antenna gain, subtract the path and the walls, add the far antenna. The result must stand above the noise floor: <b>N = −174 dBm/Hz + 10 log B + NF</b>, where −174 dBm/Hz is kT at 290 K and NF is the receiver's own noise on top. A 20 MHz channel adds 73 dB, and a 6 dB noise figure makes −95 dBm.<br><br>Free-space path loss follows from Friis: the transmitter's power spreads over 4πd², and a receiving antenna collects its aperture Gλ² / 4π. In dB, with d in km and f in GHz, it is 20 log d + 20 log f + 92.45. Doubling the distance costs 6 dB, and so does doubling the frequency, but nothing in free space depends on frequency: it is the <i>aperture</i> that shrinks (12 cm² for a 0 dBi antenna at 2.4 GHz, 0.09 cm² at 28 GHz). A fixed-size dish gains with frequency, so a point-to-point link improves with frequency. Real paths fall faster, as 10 n log d with n from 2 to 4. Shannon turns the SNR into a ceiling; at fixed power, capacity tends to P / (N<sub>0</sub> ln 2) as the channel widens, and past that more spectrum buys nothing.`,
    example: {
      title: 'A Wi-Fi link, two ways',
      body: `<pre>2.4 GHz, 20 MHz, 50 m, two walls of 12 dB, 20 dBm, 2 dBi each end, NF 6 dB
   path 74.0 dB, walls 24 dB, received −74.0 dBm, floor −95.0 dBm
   SNR 20.9 dB → Shannon 139 Mb/s
5.5 GHz, 80 MHz, same range:
   path +7.2 dB, walls +8 dB, noise +6 dB → SNR −0.3 dB → 76 Mb/s</pre>Four times the bandwidth, and capacity fell: the SNR bought by the narrower channel was worth more.`,
    },
    mistakes: [
      'Blaming the air for higher frequencies reaching less far: free space absorbs nothing, the receiving aperture shrinks (the exception is a real absorption line, such as oxygen near 60 GHz).',
      'Widening the channel to raise capacity at low SNR: noise grows with B, so capacity tends to a limit set by power; doubling power doubles it, doubling bandwidth adds little.',
      'Using the free-space exponent indoors: walls and clutter push the exponent toward 3 to 4, and 6 dB then buys much less than a factor of 2 in range.',
      'Forgetting the noise figure: −174 dBm/Hz is the floor no receiver beats, and each adds its own on top.',
    ],
    chapters: [
      { chapter: 'radio', step: 1, label: 'Path loss' },
      { chapter: 'radio', step: 2, label: 'The link budget' },
    ],
  },
  fading: {
    idea: `A signal arrives as a series of echoes with their own delays and phases. In frequency that is a filter with notches. The rms of the delays weighted by power is the <b>delay spread</b> τ (about 50 ns indoors, a microsecond or more in a city), and its other face is the <b>coherence bandwidth</b>, about 1 / (5τ): frequencies closer than that fade together. A channel narrower than it is flat; a wider one is frequency selective, which in time is inter-symbol interference. The cures are an adaptive equalizer or many slow carriers with a guard interval, OFDM.<br><br>Moving changes the rays' phases, so the sum wanders. Each ray is Doppler-shifted by up to f<sub>d</sub> = v f / c. With many rays the sum has Gaussian real and imaginary parts: its amplitude is <b>Rayleigh</b> distributed. The channel can be treated as unchanged for a <b>coherence time</b> of about 0.42 / f<sub>d</sub>. The cost is in the error rate: without fading BPSK falls off exponentially in SNR, with it only as ½(1 − √(γ / (1 + γ))) ≈ 1 / (4γ), because errors happen mostly while the channel is in a fade. A budget holding outage to 1 % needs a fade margin of 20 dB. Speed scales the time axis and changes nothing about depth: twice the speed, twice the fades a second, each half as long.`,
    example: {
      title: 'A car on a motorway',
      body: `<pre>f_d = v f / c = 185 Hz        (100 km/h, 2 GHz)
coherence time 0.42 / f_d = 2.3 ms
delay spread 50 ns → coherence bandwidth 4 MHz;  1 µs → 200 kHz
BPSK at 10 dB:  4 × 10⁻⁶ without fading,  2 × 10⁻² with it
BER 10⁻³ needs 6.8 dB without, 24.0 dB with Rayleigh fading
fade margin for 1 % outage: 20 dB</pre>A 20 MHz channel with a 1 µs spread is 100 times wider than its coherence bandwidth, so it is frequency selective; each of 256 subcarriers is 78 kHz and sees a flat channel.`,
    },
    mistakes: [
      'Treating a fade as noise: it is a multiplicative change of the signal itself, and raising transmit power by the margin only helps at the price of the margin.',
      'Reading the BER off the mean SNR as if the channel were static: the average error rate is dominated by the moments in a fade and falls only as 1 / SNR.',
      'Expecting speed to make fades deeper: speed scales time (rate and duration), not the amplitude distribution.',
      'Using one narrow-band model for a wide channel: when the bandwidth exceeds 1 / (5τ), parts of the channel can be 20 dB down while the rest is fine.',
    ],
    chapters: [
      { chapter: 'radio', step: 5, label: 'Multipath' },
      { chapter: 'radio', step: 6, label: 'Fading' },
    ],
  },
  mimo: {
    idea: `With several antennas at each end the channel is a matrix H, and what it is used for depends on whether its rows differ. <b>Diversity</b>: if one antenna is in a fade, another half a wavelength away probably is not, so combine the branches by strength (maximal ratio combining). With L independent branches the error rate falls as 1 / SNR<sup>L</sup>, and the order L is the slope of the curve. <b>Spatial multiplexing</b>: in a scattering channel each receive antenna hears a different mix of the transmitted streams, and the receiver untangles them as simultaneous equations. The capacity (Foschini and Telatar) is Σ log<sub>2</sub>(1 + (SNR/2) λ<sub>i</sub>) over the eigenvalues of H Hᴴ: several independent pipes, so at high SNR each 3 dB buys 2 b/s/Hz rather than 1, with the same power and spectrum.<br><br>Multipath, the enemy of the single-antenna link, is what makes it possible. Correlated antennas, or a clean line of sight with nothing to scatter off, leave H nearly rank 1: one large eigenvalue, one stream, and the second antenna is worth only 3 dB of array gain. Knowing H also lets a transmitter beamform and serve several receivers at once (multi-user MIMO), at the cost of channel measurements, which cost airtime.`,
    example: {
      title: 'What antennas buy',
      body: `<pre>BPSK, BER 10⁻³ (radio chapter):
   no fading            6.8 dB
   1 receive antenna   24.0 dB   (Rayleigh)
   2, combined         11.1 dB   → 13 dB for the first extra antenna
   4, combined          4.0 dB
2 × 2 streams, uncorrelated, mean of 400 channels, at 30 dB:
   17.8 b/s/Hz against 9.2 with one antenna
   each 3 dB at high SNR: +2.0 against +1.0 b/s/Hz</pre>`,
    },
    mistakes: [
      'Counting antennas as streams: the number of streams is the rank of H, and a line-of-sight link with two antennas at each end is nearly rank 1.',
      'Placing antennas too close together and expecting independent fades: their channels correlate, and both the diversity and the rank fall.',
      'Judging diversity by 3 dB of array gain: its worth is the slope. The first extra receive antenna is worth 13 dB at a BER of 10⁻³, more than any amplifier is likely to give.',
      'Forgetting the cost of using H: measuring it takes pilots and feedback, which cost airtime on every use.',
    ],
    chapters: [
      { chapter: 'radio', step: 7, label: 'What more antennas buy' },
      { chapter: 'wifi', step: 6, label: 'More antennas, more streams' },
    ],
  },
  csmaca: {
    idea: `Ethernet stations listen while they send, so a collision shows on the cable. A radio cannot: its own transmitter, at 20 dBm, drowns the receiver on the same antenna by far more than any neighbour is heard. A Wi-Fi sender learns of a collision only afterwards, from the absence of an ACK. Listening before talking still works, so the scheme is <b>CSMA/CA</b>, carrier sense with collision <i>avoidance</i>, and its rules are the distributed coordination function. A station with a frame draws a random backoff in slots of 9 µs, waits until the medium has been idle for DIFS (34 µs), counts down one per idle slot (freezing when it goes busy), and sends at zero. The receiver answers after SIFS (16 µs) with an ACK; no ACK within 53 µs doubles the window (15 up to 1023) and tries again, seven tries in all.<br><br>There are no priorities in the frames. <b>Priority is time</b>: SIFS is shorter than DIFS (DIFS = SIFS + 2 slots), so an ACK takes the air before anyone can start. Doubling the window learns the load without counting stations: too small a window wastes the air on collisions, too large on idle slots. Bianchi's closed form, solving τ and p together, predicts the share of the air carrying payload.`,
    example: {
      title: 'Sharing 54 Mb/s',
      body: `<pre>802.11a: SIFS 16 µs   slot 9 µs   DIFS = 16 + 2 × 9 = 34 µs   ACK 28 µs
CW 15 → 31 → 63 → … → 1023, 7 tries, then the frame is dropped
1500 B at 54 Mb/s: 248 µs on air
Bianchi:   2 stations  65 % of the air for payload
          20 stations  52 %, with 48 % of tries colliding
goodput of one exchange: 30 Mb/s of the 54</pre>The decline with stations is gentle, not a cliff; the model and the chapter's station gates agree within 10 % for 2 to 20 stations.`,
    },
    mistakes: [
      'Expecting Wi-Fi to detect collisions as Ethernet does: the sender is deafened by its own signal, and a clear channel at the sender says nothing about the receiver.',
      'Reading the backoff counter as wall-clock time: it freezes while the medium is busy and resumes after the next DIFS.',
      'Thinking a faster data rate raises throughput in proportion: DIFS, backoff, SIFS and ACK are fixed times around the frame, so only the data shrinks.',
      'Assuming carrier sense prevents collisions: it prevents them near the sender; a station the sender cannot hear still collides at the receiver.',
    ],
    chapters: [
      { chapter: 'wifi', step: 0, label: 'A channel you cannot listen to' },
      { chapter: 'wifi', step: 1, label: 'The rules, in microseconds' },
      { chapter: 'wifi', step: 2, label: 'How many can share' },
    ],
  },
  hiddenterminal: {
    idea: `Carrier sense asks: is anyone talking <i>near me</i>? The collision happens <i>near the receiver</i>. If A and B are on opposite sides of an access point, in range of it and not of each other, each hears silence and sends, and the access point hears both at once and gets neither. This is the <b>hidden terminal</b>. Carrier sense, which says "clear", is no help, CW climbs, and frames are dropped after seven tries.<br><br>RTS / CTS uses the receiver's own voice. Before a long frame the sender sends a short Request To Send (28 µs); the receiver answers after SIFS with Clear To Send. Both carry the duration of the rest of the exchange, and every station that hears either sets its <b>NAV</b>, a timer of virtual carrier sense, treating the medium as busy whether or not it hears anything. B cannot hear A's RTS but can hear the access point's CTS. Two RTSs can still collide, and since A and B cannot hear each other any overlap within the 28 µs counts, but that wastes 28 µs of air, not a whole frame. Its cost is the extra frames, so it is used above a length threshold. The mirror image is the <b>exposed terminal</b>: a station holds off for a sender its own receiver could have tolerated.`,
    example: {
      title: 'Two hidden stations, 400 ms',
      body: `<pre>1000 µs frames, A and B hidden from each other, the access point hears both
without RTS / CTS:  120 frames delivered, 25 dropped
with RTS / CTS:     314 frames delivered
   (one station ahead of the other, 199 to 115: the last winner tends to win again)
RTS 28 µs wasted per collision against 1000 µs</pre>A collision doubles the loser's window and a success resets the winner's, so fairness only comes over a long run.`,
    },
    mistakes: [
      'Thinking more carrier-sense sensitivity fixes it: the stations are out of each other\'s range, so there is nothing to sense.',
      'Believing RTS / CTS removes collisions: two RTSs still collide, only cheaply.',
      'Turning RTS / CTS on for short frames: a short frame costs little more than the RTS, so it only adds overhead.',
      'Assuming the NAV reaches everyone: only stations that decode the CTS set it, and stations nearly out of range can still step on a frame.',
    ],
    chapters: [
      { chapter: 'wifi', step: 3, label: 'The station you cannot hear' },
      { chapter: 'wifi', step: 0, label: 'A channel you cannot listen to' },
    ],
  },
  rateadapt: {
    idea: `A modulation needs a minimum SNR, and the channel's SNR can move by tens of dB in a fraction of a second. 802.11a has eight rates, from BPSK ½ at 6 Mb/s (5 dB in the model) to 64-QAM ¾ at 54 Mb/s (23 dB). The transmitter cannot ask the channel; its only signal is whether an ACK comes back, so it guesses. <b>ARF</b>, Auto Rate Fallback (1997), is the simplest rule: after 10 good frames go up one rate, after 2 lost in a row come down.<br><br>The fault is built in: a missing ACK looks the same whatever caused it, so a busy channel with collisions drives ARF to low rates, where each frame holds the air longer, every station\'s turn gets longer and the collisions rise further. A related effect has no collisions in it: DCF gives each station equal chances per frame, so one slow station takes most of the airtime and holds everybody near its rate. Modern drivers (Minstrel in Linux) keep statistics per rate and probe the others, and newer standards have the receiver report its measured SNR. A fixed rate chosen too high loses nearly everything when the SNR drops; one chosen too low wastes the good moments. The 10-frame rule also lags a fast-moving channel.`,
    example: {
      title: 'What a rate step is worth',
      body: `<pre>1500 B frame        airtime     goodput (after DIFS, backoff, SIFS, ACK)
   6 Mb/s          2064 µs      5.4 Mb/s       needs 5 dB
  24 Mb/s           532 µs     17.7 Mb/s       needs 13 dB
  54 Mb/s           248 µs     30.5 Mb/s       needs 23 dB
ARF: 10 good → up, 2 lost in a row → down</pre>Top rate is 9 times the bottom, goodput 5.7 times: the fixed overheads do not shrink with the rate.`,
    },
    mistakes: [
      'Reading a lost frame as a weak channel: a collision loses it just as well, and lowering the rate then lengthens the frame and makes the next collision likelier.',
      'Always choosing the highest rate the SNR allows: the choice is by goodput, and a rate on the edge of its threshold loses frames and retries them.',
      'Thinking the SNR is available: the sender only sees ACKs, unless the standard has the receiver report back.',
      'Ignoring the slowest station: by DCF\'s equal chance per frame it takes the largest share of airtime.',
    ],
    chapters: [
      { chapter: 'wifi', step: 4, label: 'How fast to send' },
      { chapter: 'wifi', step: 5, label: 'Where the airtime goes' },
    ],
  },
  cellreuse: {
    idea: `One transmitter cannot serve a city, so use many low-power ones (Ring and Young, Bell Labs 1947) and reuse frequencies at a distance. Colour a hexagonal grid with K colours so that same-coloured cells are as far apart as geometry allows; only K = i² + ij + j² works (1, 3, 4, 7, 9, 12, …). Same-coloured cells are D = √(3K) R apart, R the cell radius. A phone at the edge hears its own mast at R and six interferers at about D, so with path-loss exponent n, <b>SIR ≈ (D/R)<sup>n</sup> / 6</b>. K = 7 with n = 4 is 18.7 dB, which FM voice (needing about 18 dB) could use, at the price of each cell getting a seventh of the band.<br><br>Rate goes as log(1 + SIR) but linearly with bandwidth, so reuse 1 wins once coding can live with low SIR. On the chapter's ideal model (n = 3.5, every cell at full load, Shannon rates) K = 1 has a median SIR of 4 dB and a bad edge yet carries 2.67 b/s/Hz a cell, K = 3 carries 1.79 and K = 7 only 1.09. Edge users are the price and are handled by scheduling and coordination. SIR depends only on D/R, so halving every radius leaves SIR unchanged and gives four times the cells a km²: cell splitting is where most of the capacity added over the decades came from.`,
    example: {
      title: 'Three reuse patterns',
      body: `<pre>K = 7, n = 4:  D/R = √21 = 4.58,  SIR ≈ 4.58⁴ / 6  = 18.7 dB
model, n = 3.5, ideal Shannon rates, full load:
          median SIR      b/s/Hz a cell
   K = 1       4 dB            2.67
   K = 3      14 dB            1.79
   K = 7      21 dB            1.09</pre>K = 1 carries 2.5 times what K = 7 does with a far worse edge: a seventh of the band costs more than the SIR gains.`,
    },
    mistakes: [
      'Judging a pattern by its SIR alone: rate is only logarithmic in SIR and linear in the bandwidth the pattern gives each cell.',
      'Believing smaller cells need a larger reuse distance: D/R is fixed by K, so SIR does not depend on absolute size.',
      'Taking the closed form as the exact edge: it is a rule for the worst point on a regular grid, and the model adds up the actual interferers.',
      'Treating reuse 1 as interference-free: edge users do badly, and the network leans on scheduling and coordination for them.',
    ],
    chapters: [{ chapter: 'cellular', step: 0, label: 'Cells and reuse' }],
  },
  handover: {
    idea: `A phone moves, and the mast it should use changes. It measures its neighbours' reference signals and reports. The LTE <b>A3 event</b>: hand over when a neighbour has been stronger than the serving cell by an offset plus a <b>hysteresis</b> for a <b>time to trigger</b>. The network then moves the connection while the call carries on over a short interruption.<br><br>With no shadowing the crossing is geometry: with 3 dB of hysteresis, n = 3.5 and masts 1 km apart, the phone switches at 549 m rather than 500, because hysteresis works by being late. But buildings add a slowly varying random difference of several dB (shadowing), and the two levels wander across each other several times near the crossing. Switch at each crossing and the network moves the phone back and forth, <b>ping-pong</b>, spending signalling and risking a drop each time. Raise hysteresis and time to trigger far enough and, with shadowing, the phone stays on its old cell until it is below usable (−110 dBm in the panel): a dropped connection. Faster users cover more road in the same trigger time, so networks shorten both for them. The values are the operator's tuning, cell by cell; the standard sets none.`,
    example: {
      title: 'Where the switch happens',
      body: `<pre>masts 1 km apart, n = 3.5, no shadowing
   hysteresis 0 dB   switch at 500 m
   hysteresis 3 dB   switch at 549 m  (49 m of the old, weaker cell)
with shadowing: levels cross several times near 500 m
   too little (0 dB, 0 ms):  ping-pong
   too much:                 clings to the old cell until below −110 dBm</pre>The chapter's trigger time of 320 ms covers more road the faster the phone goes.`,
    },
    mistakes: [
      'Setting hysteresis to zero to hand over at the midpoint: shadowing makes the levels cross repeatedly, and the network ping-pongs.',
      'Thinking hysteresis is free: it moves the switch past the midpoint, so the phone spends longer on the weaker cell, which lowers its rate and raises the chance of a drop.',
      'Using the same timers for a pedestrian and a car: the time to trigger covers more road at speed, so fast users need less.',
      'Expecting the standard to fix the values: they are operator tuning, cell by cell.',
    ],
    chapters: [{ chapter: 'cellular', step: 3, label: 'Handing over' }],
  },
  pfscheduler: {
    idea: `Wi-Fi treats a fade as a misfortune. A cell with many users picks, for each block, a user who is not in one: <b>multi-user diversity</b>. With n users of equal mean SNR in Rayleigh fading, the best of them has H<sub>n</sub> = 1 + ½ + … + 1/n times the mean (2.72 for 8 users), for nothing but a channel report. Three policies. <b>Round robin</b>: everyone in turn, ignoring the channel; fair in time and wasteful. <b>Max rate</b>: whoever can take the most bits now; highest total, and a far user starves. <b>Proportional fair</b>: whoever's rate <i>now</i>, relative to their own recent average, is highest.<br><br>Each user is compared with themselves, so every user is served near their own peaks, all get a fair share of slots, and each slot is a good one for its user. A user with a poor mean SNR who gets a good fade can be served ahead of a nearby user whose instantaneous rate is twice theirs. The chapter's model gives the scheduler every fade at once, free of delay, one user a slot over the whole band; a real scheduler needs fading <i>slower</i> than its reports, so high-speed users outrun the feedback, and so does anything with too little traffic to choose from.`,
    example: {
      title: 'Eight users at 10 dB',
      body: `<pre>mean SNR 10 dB each, 8 users, ideal reports
   round robin   2.90 b/s/Hz
   max rate      4.69 b/s/Hz
best of 8 in Rayleigh fading: H₈ = 1 + ½ + … + ⅛ = 2.72 × the mean</pre>With equal users max rate and proportional fair nearly coincide; with users apart in distance proportional fair is the one that does not starve the far ones.`,
    },
    mistakes: [
      'Picking the user with the best instantaneous rate and calling it fair: that is max rate, and a far user with a lower mean never gets a slot.',
      'Comparing rates between users instead of each against its own average: that ratio is the whole of proportional fair.',
      'Assuming the gain exists for any traffic: it needs several users with data waiting, and fading slower than the channel reports.',
      'Thinking round robin is neutral: it is fair in time and throws away all the diversity.',
    ],
    chapters: [{ chapter: 'cellular', step: 2, label: 'Who gets the next millisecond' }],
  },
  beamforming: {
    idea: `Put antennas in a line half a wavelength apart and feed each with a phase step: their fields add in one direction and cancel in others, a phased array. M elements give 10 log M dB towards one user and a beam steered with no moving parts; at 28 GHz half a wavelength is 5.4 mm, so 64 elements fit in a panel about 4 cm square, and a phone has room for a handful. With a digital chain per antenna, a base station can send different beams to different users on the same block, and with the channels H of all K users it can <b>precode</b> so that each user's stream is cancelled at every other user: <b>zero-forcing</b>. Each of K users then gets on average SNR = ρ (M − K + 1) / K, where ρ is the total power's SNR at one antenna.<br><br>Massive MIMO (Marzetta, 2010) works by a law of large numbers: as M grows two users' channels become orthogonal by chance, their overlap falling as 1 / √M, and even simple precoders work. The catch is knowing H. The base measures it from each phone's pilots, which are limited by how many orthogonal sequences fit in a coherence time; reusing them in a neighbouring cell is pilot contamination, so real systems favour time-division duplex, where uplink measurements apply to the downlink. Wi-Fi does the same per subcarrier (multi-user MIMO from 802.11ac), at the cost of measurements that take airtime.`,
    example: {
      title: 'Four users, more antennas',
      body: `<pre>SNR per user = ρ (M − K + 1) / K,  K = 4 users, ρ = 0 dB
   M = 8     5 / 4  = 1.25   →  1.0 dB
   M = 64   61 / 4  = 15.25  → 11.8 dB
M = 64, K from 4 to 8: 61/4 → 57/8, a factor of 2.14 less each,
   yet 8 users at half the SNR carry more in total</pre>`,
    },
    mistakes: [
      'Treating beamforming as gain alone: the point of zero-forcing is the nulls it puts on other users, which a single steered beam does not.',
      'Assuming the channel is free to know: pilots are limited and cost airtime, and reuse of pilots between cells contaminates the estimate.',
      'Expecting the formula on a real array: it is the ideal; mid-band arrays have 32 to 64 digital chains, and millimetre-wave ones group elements behind fewer chains for power and cost.',
      'Adding users without cost: each extra user takes a dimension and a share of the power.',
    ],
    chapters: [
      { chapter: 'cellular', step: 4, label: 'A hundred antennas' },
      { chapter: 'wifi', step: 6, label: 'More antennas, more streams' },
      { chapter: 'radio', step: 0, label: 'An antenna' },
    ],
  },
};
