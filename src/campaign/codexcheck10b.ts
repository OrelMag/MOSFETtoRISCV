// Check yourself for the Communication extension: glass, radio, wifi, cellular. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.
// The numbers are pinned by tests/content-codexcomm2b.test.ts.

import type { Quiz } from '../chapters/types';

export const CHECK10B: Record<string, Quiz[]> = {
  dispersion: [
    {
      question: 'A link with a clean laser at 1550 nm reaches 28 km at 10 Gb/s before dispersion closes the eye. What does it reach at 20 Gb/s?',
      options: ['About 7 km, a quarter', 'About 14 km, a half', 'About 28 km, unchanged', 'About 56 km, doubled'],
      answer: 0,
      explain: 'A pulse at twice the rate is half as long, has twice the spectrum and spreads twice as fast, with half the room: reach goes as 1 / B², 28.1 km divided by 4 is 7.0 km.',
      why: ['', 'Half is the 1 / B law of a source wider than the signal, not of a clean laser.', 'A higher rate widens the spectrum, and a wider spectrum spreads faster; the fibre alone does not fix the reach.', 'Shorter pulses spread faster, so the reach falls instead of rising.'],
    },
    {
      question: 'A cheap source one nanometre wide runs at 10 Gb/s. The rate goes to 40 Gb/s. What happens to the reach?',
      options: ['It falls about fourfold, the spread being set by the source', 'It falls sixteenfold, as for a clean laser', 'It is unchanged, since D Δλ has no rate in it', 'It rises, since the pulses are shorter'],
      answer: 0,
      explain: 'The spread is D Δλ whatever the rate, so the reach is limited by how many bit slots it takes up and falls as 1 / B: 1.4 km at 10 Gb/s, a quarter of that at 40.',
      why: ['', 'Sixteen is the law for a clean laser, whose spectrum is set by the modulation; here the source sets it.', 'The spread is unchanged, but the bit slot is four times shorter, so the reach shrinks.', 'A shorter slot gives the same spread less room.'],
    },
  ],
  wdm: [
    {
      question: 'The C band is 4.4 THz wide. How many channels does the 50 GHz grid hold in it, and how far apart are they in wavelength?',
      options: ['87, about 0.4 nm apart', '44, about 0.8 nm apart', '87, about 0.8 nm apart', '175, about 0.2 nm apart'],
      answer: 0,
      explain: '4.4 THz / 50 GHz is 87. At 1550 nm a spacing of Δf is λ²Δf / c, 0.40 nm for 50 GHz.',
      why: ['', 'That is the 100 GHz grid: double the spacing, half the channels.', 'The count is right and the spacing is that of the 100 GHz grid; 50 GHz is 0.4 nm.', 'That would be a 25 GHz grid, which is not the one the question asks about.'],
    },
    {
      question: 'A channel carries 16-QAM at 32 GBd in two polarizations behind a rate-0.8 code. What does it carry?',
      options: ['205 Gb/s', '128 Gb/s', '256 Gb/s', '102 Gb/s'],
      answer: 0,
      explain: '2 polarizations × 32 GBd × 4 bits × 0.8 = 204.8 Gb/s, and 87 of them are 17.8 Tb/s on one fibre each way.',
      why: ['', 'That is one polarization with no code overhead; the second polarization doubles it.', 'That counts every bit as payload; the rate-0.8 code leaves 80 % of it.', 'That is QPSK, two bits a polarization symbol.'],
    },
  ],
  edfa: [
    {
      question: 'Everything else equal, a chain has ten times as many amplifier spans. How does the OSNR change?',
      options: ['It falls by 10 dB', 'It falls by 3 dB', 'It falls by 20 dB', 'It is unchanged'],
      answer: 0,
      explain: 'Each amplifier adds its own noise, and powers add, so N spans cost 10 log<sub>10</sub> N dB: ten times the spans cost 10 dB. That is why many short spans beat a few long ones.',
      why: ['', 'That is the cost of doubling the spans, 10 log 2.', 'That would be 20 log N, for noise amplitudes adding; noise powers add.', 'Every amplifier adds noise, and the sum grows with their number.'],
    },
    {
      question: 'Why does one erbium amplifier serve all 87 channels, whatever their rate or format?',
      options: ['It amplifies the whole band by stimulated emission, knowing nothing of the data', 'It detects each channel and sends it on in turn', 'It sits after the demultiplexer, one for each colour', 'It cancels the noise each channel has picked up'],
      answer: 0,
      explain: 'Pumped erbium-doped fibre has gain across 1530 to 1565 nm at once. The regenerator it replaced was a photodiode, slicer and laser for every wavelength, and tied to a bit rate.',
      why: ['', 'That describes the regenerator, which the amplifier made unnecessary.', 'It sits on the line, in front of any demultiplexer, and serves every colour together.', 'It adds noise (spontaneous emission) rather than removing it; the noise figure is the penalty.'],
    },
  ],
  coherent: [
    {
      question: 'Why do the linewidths of the two lasers matter to a coherent receiver?',
      options: ['Their phase random walk turns the constellation into a ring until a tracker follows it', 'They set how many polarizations the fibre carries', 'They set the sample rate the ADCs need', 'A wider line needs more photodiode bandwidth to pass it'],
      answer: 0,
      explain: 'The transmit and local lasers wander in phase relative to each other. Raising each QPSK symbol to the fourth power removes its data and leaves four times the phase, which the tracker follows.',
      why: ['', 'There are two polarizations whatever the laser; the receiver reads I and Q in both.', 'The sample rate follows the symbol rate (64 GS/s for 32 GBd), not the linewidth.', 'Linewidths of MHz are tiny beside the GHz a photodiode passes; the harm is to the phase.'],
    },
    {
      question: 'How many photodiodes read the I and Q of both polarizations in the chapter\'s coherent receiver?',
      options: ['Eight, in four balanced pairs', 'Two, one for each polarization', 'Four, one for each I or Q', 'Sixteen, two for each pair'],
      answer: 0,
      explain: 'A 90° hybrid gives I and Q for each polarization, and each is read by a balanced pair, so four pairs, eight photodiodes.',
      why: ['', 'That is direct detection\'s count: it sees intensity and loses the phase.', 'That counts one per component and misses that each is a balanced pair.', 'That doubles the count again; the receiver in the chapter has eight.'],
    },
  ],
  linkbudget: [
    {
      question: 'What noise floor does a 20 MHz channel with a 6 dB noise figure have?',
      options: ['−95 dBm', '−174 dBm', '−101 dBm', '−89 dBm'],
      answer: 0,
      explain: '−174 dBm/Hz + 10 log(20 MHz) = −174 + 73 = −101 dBm, and the receiver\'s own 6 dB makes −95 dBm.',
      why: ['', 'That is the density per hertz; the channel\'s bandwidth adds 10 log B.', 'That leaves out the noise figure: the receiver adds its own noise on top.', 'That is the floor of an 80 MHz channel with the same noise figure.'],
    },
    {
      question: 'Free-space loss grows 6 dB when the frequency doubles, at the same antenna gains. Why?',
      options: ['The receiving aperture shrinks as λ², and the air absorbs nothing', 'The air absorbs more at higher frequencies', 'Waves travel more slowly at higher frequencies', 'Thermal noise per hertz rises with frequency'],
      answer: 0,
      explain: 'A given gain at half the wavelength has a quarter of the aperture, Gλ² / 4π. A fixed-size dish instead gains with frequency, so a point-to-point link improves.',
      why: ['', 'Below tens of GHz air absorbs almost nothing; the exception is a narrow line such as oxygen near 60 GHz.', 'In free space every frequency travels at c.', 'Thermal noise density is the same at both frequencies.'],
    },
  ],
  fading: [
    {
      question: 'A car doubles its speed. What happens to the channel\'s coherence time, about 0.42 / f<sub>d</sub>?',
      options: ['It halves', 'It doubles', 'It is unchanged', 'It falls to a quarter'],
      answer: 0,
      explain: 'Doppler f<sub>d</sub> = v f / c doubles, so the time over which the channel can be treated as unchanged halves: 2.3 ms at 100 km/h and 2 GHz becomes 1.1 ms at 200.',
      why: ['', 'The channel changes faster at speed, so it stays unchanged for less time.', 'Speed scales the time axis of the fading pattern, so the coherence time moves.', 'The Doppler shift is linear in speed, so the time falls by two, not four.'],
    },
    {
      question: 'A 20 MHz channel sees a delay spread of 1 µs. What kind of channel is it?',
      options: ['Frequency selective, the coherence bandwidth being about 200 kHz', 'Flat, since a 1 µs echo is short beside a millisecond', 'Flat, since 20 MHz is far above the coherence bandwidth', 'Frequency selective only while the receiver moves'],
      answer: 0,
      explain: 'Coherence bandwidth is about 1 / (5τ) = 200 kHz, a hundredth of the channel, so parts of it fade apart. Split into 256 subcarriers of 78 kHz each sees a nearly flat channel.',
      why: ['', 'A millisecond is a coherence time, a different quantity; the echo is long beside a fast symbol.', 'A channel wider than the coherence bandwidth is the selective case, not the flat one.', 'The notches come from the echoes and exist for a static receiver; motion adds change over time.'],
    },
  ],
  mimo: [
    {
      question: 'At high SNR each 3 dB buys 2 b/s/Hz on a 2 × 2 link and 1 on a single-antenna one. What does that slope count?',
      options: ['The independent streams the channel supports', 'The antennas at each end', 'The diversity order of the combining', 'The array gain in dB'],
      answer: 0,
      explain: 'Capacity is a sum of log terms over the eigenvalues of H Hᴴ, one per usable stream. Antennas only bound the streams; the rank of H decides how many there are.',
      why: ['', 'Two antennas in a line-of-sight link still give one stream, since H is nearly rank 1.', 'Diversity order is the slope of the BER curve, a different plot.', 'Array gain is a one-off shift of the curve, not a slope.'],
    },
    {
      question: 'Two receive antennas with maximal-ratio combining need 11.1 dB for a BER of 10⁻³ in Rayleigh fading, one needs 24.0 dB. What changed?',
      options: ['The slope: an error now needs both branches in a fade together', 'The noise floor fell by 13 dB, the second antenna cancelling noise', 'The array gain of two antennas, which collect twice the energy', 'The fading was averaged away, leaving a channel with no fades'],
      answer: 0,
      explain: 'With L independent branches the BER falls as 1 / SNR<sup>L</sup>, so the curve is steeper and the first extra antenna is worth 13 dB, more than an amplifier you could afford.',
      why: ['', 'Noise is the same at each antenna; combining changes how the fades add up.', 'Array gain is only 3 dB; the diversity gain is the slope, and it is far larger.', 'Each branch still fades; they are just unlikely to fade together.'],
    },
  ],
  csmaca: [
    {
      question: 'SIFS is 16 µs and DIFS 34 µs. Why is SIFS shorter?',
      options: ['An ACK takes the air before anyone can start a frame', 'It makes the ACK faster at low data rates', 'A receiver decodes an ACK more quickly than a data frame', 'It lets the random backoff finish first'],
      answer: 0,
      explain: 'Wi-Fi frames carry no priorities; priority is time. DIFS = SIFS + 2 slots, so a station waiting for DIFS always loses to the ACK a receiver sends after SIFS.',
      why: ['', 'The ACK lasts as long as it lasts at its rate; SIFS is a gap before it.', 'The gap comes before the ACK and is the same for any frame; it sets priority.', 'The backoff counts down after DIFS, so it follows the gap rather than precedes it.'],
    },
    {
      question: 'Why does a Wi-Fi sender learn about a collision only from a missing ACK?',
      options: ['Its own transmission swamps its receiver', 'The standard forbids listening while sending', 'The collision ends before carrier sense can run', 'The access point jams the channel on a collision'],
      answer: 0,
      explain: 'At 20 dBm its own signal is far above anything arriving; a neighbour 20 m away at 5.5 GHz is some 73 dB lower in free space. The ACK is the only feedback.',
      why: ['', 'Nothing forbids it; full-duplex radio is researched, and hard.', 'The sender cannot hear anything while it sends, whatever the timing.', 'Nothing jams; no ACK arrives, and that absence is the signal.'],
    },
  ],
  hiddenterminal: [
    {
      question: 'With RTS / CTS on, two hidden stations still collide sometimes. What does such a collision cost?',
      options: ['The 28 µs of an RTS, not a 1000 µs frame', 'Nothing, as RTS / CTS prevents every collision', 'Half a frame, since the access point stops it', 'The whole 1000 µs, plus the RTS'],
      answer: 0,
      explain: 'Two RTSs from stations that cannot hear each other overlap and are lost, but the data frame is never sent. The model delivers 314 frames in 400 ms against 120 without it.',
      why: ['', 'Two RTSs can still overlap; only the cost of the collision shrinks.', 'The access point hears nothing it can decode when two RTSs overlap, and sends no CTS.', 'The data frame follows only a successful RTS and CTS, so a failed RTS wastes only itself.'],
    },
    {
      question: 'How does a hidden station learn that an exchange is under way, so that it can set its NAV?',
      options: ['From the access point\'s CTS', 'From the sender\'s RTS', 'From a beacon the access point sends to every station', 'From carrier sense on the sender\'s frame'],
      answer: 0,
      explain: 'The hidden station cannot hear the sender\'s RTS, but both stations are in range of the access point, so it decodes the CTS, whose duration field covers the exchange.',
      why: ['', 'The hidden station is by definition out of the sender\'s range, so the RTS does not reach it.', 'Beacons announce the network, not each exchange.', 'Carrier sense cannot hear the sender: that is what hidden means.'],
    },
  ],
  rateadapt: [
    {
      question: 'A 1500-byte frame lasts 2064 µs at 6 Mb/s and 248 µs at 54 Mb/s. Why is the goodput only 5.7 times higher, not 9?',
      options: ['DIFS, backoff, SIFS and the ACK take fixed times a faster rate does not shrink', 'The 54 Mb/s rate loses most of its frames', 'The preamble is longer at the higher rate', 'Aggregation is off at the lower rate'],
      answer: 0,
      explain: 'Around the data come fixed times: DIFS 34, a mean backoff of 68, SIFS 16 and an ACK of 28 µs. The goodput is 30.5 Mb/s of 54 and 5.4 of 6.',
      why: ['', 'This is the loss-free exchange; errors are a separate question.', 'The preamble is 20 µs at any rate in the standard\'s formula.', 'Neither case uses aggregation here; it is a different remedy.'],
    },
    {
      question: 'A busy channel has many collisions, and a transmitter uses ARF. What does it do?',
      options: ['It drops to low rates, which lengthen frames and add collisions', 'It climbs after every tenth frame to clear the queue', 'It holds its rate, as lost frames say nothing about it', 'It reads the SNR from the preamble and holds'],
      answer: 0,
      explain: 'A missing ACK looks the same whatever caused it. After 2 lost in a row ARF steps down, each frame holds the air longer and the next collision is likelier.',
      why: ['', 'It climbs only after ten good frames, and collisions produce lost ones.', 'Lost frames are exactly the pattern it reacts to, whatever their cause.', 'Simple schemes have no SNR at all, only the ACKs.'],
    },
  ],
  cellreuse: [
    {
      question: 'In the closed form SIR ≈ (D/R)<sup>n</sup> / 6, what is the edge SIR for K = 7 and n = 4?',
      options: ['18.7 dB', '26.4 dB', '11.3 dB', '5.4 dB'],
      answer: 0,
      explain: 'D/R = √(3K) = √21 = 4.58, 4.58⁴ = 441, and divided by the six interferers 73.5, which is 18.7 dB.',
      why: ['', 'That counts one interferer; there are six at about D.', 'That is the value for K = 3.', 'That uses the free-space exponent 2 instead of 4.'],
    },
    {
      question: 'On the chapter\'s model reuse 1 carries 2.67 b/s/Hz a cell and K = 7 only 1.09, though their median SIR is 4 dB against 21. What explains it?',
      options: ['K = 7 gives each cell a seventh of the band, and rate is only logarithmic in SIR', 'Reuse 1 gives each user a larger share of the cell\'s time', 'The model leaves bandwidth out of the rate', 'Seven cells share one cell\'s transmit power'],
      answer: 0,
      explain: 'Rate is bandwidth times log(1 + SIR). A seventh of the band costs more than the extra SIR gains, and strong coding lives with low SIR; edge users are then helped by scheduling.',
      why: ['', 'Time is shared alike in both; the difference is the band.', 'Bandwidth is the point: each cell gets 1 / K of the band in the model.', 'Power is per transmitter and unrelated to the pattern.'],
    },
  ],
  handover: [
    {
      question: 'Hysteresis is set to zero and the signals shadow. What happens near the midpoint between masts?',
      options: ['The levels cross several times, so the phone ping-pongs', 'The phone hands over once, exactly at the midpoint', 'The call drops at once', 'The phone hands over later than at 500 m'],
      answer: 0,
      explain: 'Shadowing adds a slowly varying random difference of several dB, so the two levels wander across each other. Each crossing triggers a handover, with its signalling and risk of a drop.',
      why: ['', 'Without shadowing, yes; with it the levels do not cross just once.', 'Nothing drops by itself; it is a cost per switch, not a failure at the first.', 'With zero hysteresis it is not late: it switches at the first crossing.'],
    },
    {
      question: 'The time to trigger is fixed at 320 ms and the phone goes faster. What changes?',
      options: ['It covers more road before the trigger fires', 'It covers the same road, since the trigger counts time', 'It covers less road, since the signal changes faster', 'Nothing: the trigger affects the rate only'],
      answer: 0,
      explain: 'A distance is a time times a speed: the same 320 ms is twice the road at twice the speed, so the phone sits longer on a cell that is getting weaker. Networks shrink both timers for fast users.',
      why: ['', 'The time is the same and the road it covers is not.', 'The signal\'s change per metre is the same; the phone simply moves further in the time.', 'The trigger decides when to hand over, which decides the cell the phone is on.'],
    },
  ],
  pfscheduler: [
    {
      question: 'Eight users with equal mean SNR in Rayleigh fading are served by the best at each instant. What SNR does the best have, relative to the mean?',
      options: ['2.72 times, H₈ = 1 + ½ + … + ⅛', '8 times, one for each user', '3 times, log₂ of 8', 'The same, as fading averages out'],
      answer: 0,
      explain: 'The expected maximum of n unit-mean exponentials is the harmonic number H<sub>n</sub>, 2.72 for n = 8. The scheduler gets it for nothing but a channel report.',
      why: ['', 'The maximum grows only like the harmonic sum, far slower than the count.', 'The harmonic number is close to ln n plus 0.58, not log₂ n.', 'The best of several is by definition above the mean; averaging happens only if the users are not chosen.'],
    },
    {
      question: 'Which policy gives the highest total throughput but lets a far user starve?',
      options: ['Max rate', 'Round robin', 'Proportional fair', 'None: all share by time'],
      answer: 0,
      explain: 'Max rate serves whoever can take the most now, 4.69 b/s/Hz against round robin\'s 2.90 for eight users at 10 dB, and a user with a low mean is never the maximum.',
      why: ['', 'Round robin serves everyone in turn, whatever the channel, so no one starves.', 'It compares each user with its own average, so every user is served near its own peaks.', 'Only round robin shares strictly by time; max rate shares by channel.'],
    },
  ],
  beamforming: [
    {
      question: 'Four users at 0 dB get 11.8 dB each from 64 antennas under zero-forcing. What does each get from 8 antennas?',
      options: ['1.0 dB', '9.0 dB', '7.0 dB', '0.0 dB'],
      answer: 0,
      explain: 'SNR = ρ (M − K + 1) / K = 5 / 4 = 1.25, which is 1.0 dB: the power is shared among four users and the nulls use up dimensions.',
      why: ['', 'That is 10 log 8, the array gain toward one user; with four users the power is shared and nulls take dimensions.', 'That is 10 log 5, counting M − K + 1 and forgetting the division by K users.', 'Eight antennas do help: the formula gives 1.25 times ρ, not ρ.'],
    },
    {
      question: 'Why do real massive-MIMO systems favour time-division duplex?',
      options: ['Uplink pilots measure H, which then also serves the downlink', 'Pilots cannot be sent on a separate frequency', 'It gives the base station more bandwidth', 'It removes the need for a precoder'],
      answer: 0,
      explain: 'Precoding needs H, which the base station measures from each phone\'s pilots. With one frequency for both directions the same measurement applies to the downlink.',
      why: ['', 'A pilot can go on any frequency; the point is that the measurement is reused in the other direction.', 'Duplexing changes how the band is shared in time, not how much there is.', 'The precoder is the whole of zero-forcing; duplexing only makes its input available.'],
    },
  ],
};
