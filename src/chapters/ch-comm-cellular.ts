// Cellular (level Communication): how thousands share one mast. Models only, labelled as models (phys/cellular.ts): no gate, and no trace of a real network. Model numbers are computed; dates, standards and field figures are typed.

import { crossingM, gridMbps, harmonic, rbKhz, reachKm, reuseSweep, schedule, sirClosedDb, slotMs, zfMeanSnr } from '../phys/cellular';
import { gridWidget, handoverWidget, massiveWidget, mmwaveWidget, reuseWidget, schedulerWidget } from '../widgets/cellular';
import { numOf } from './order';
import type { Chapter } from './types';

const nf = (x: number, d = 1) => x.toFixed(d);
const S1 = reuseSweep(1, 3.5, 1500), S3 = reuseSweep(3, 3.5, 1500), S7 = reuseSweep(7, 3.5, 1500);
const EQ = (() => { const m = Array<number>(8).fill(10); return { rr: schedule('rr', m, 20000, 1).total, mx: schedule('max', m, 20000, 2).total }; })();

export const chCellular: Chapter = {
  id: 'cellular', num: numOf('cellular'), title: 'Cellular', level: 'Communication',
  blurb: 'How thousands share one mast: cells and reuse, the resource grid, schedulers that exploit fading, handover, beamforming, and what 5G changed. Models, labelled as models.',
  goals: [
    'compute a reuse pattern\'s SIR from geometry, and say why networks moved from reuse 7 to reuse 1',
    'read a resource grid and work out a carrier\'s peak rate, with what numerology does to it',
    'compare round robin, max-rate and proportional-fair schedulers, and explain multi-user diversity',
    'set hysteresis and time to trigger for handover, and name what goes wrong each way',
    'say what many antennas buy, by zero-forcing\'s formula, and what millimetre waves cost',
  ],
  builds: ['radio', 'wifi'],
  recap: {
    keep: [
      `Space is the first multiplier. A cell reuses its frequencies at a distance √(3K) R, so SIR rises with K, and each cell gets 1 / K of the band. On this model, K = 1 carries ${nf(S1.perCell / S7.perCell, 1)} times what K = 7 does, even with a far worse edge: coding and scheduling can live with low SIR.`,
      `A cell shares a grid: 12 subcarriers by 1 slot, ${rbKhz()} kHz by 1 ms at µ = 0. A scheduler in the base station hands it out every slot. There is no contention on the data channel, the reverse of Wi-Fi.`,
      `Fading is an opportunity if there are many users: serve each at its peak. The best of n Rayleigh users has H_n times the mean SNR. Proportional fair takes most of this and starves nobody.`,
      'Handover is a trade between too late (dropped calls) and too early (ping-pong), made by hysteresis and a time to trigger.',
      `Many antennas turn SNR into streams: each of K users gets ρ (M − K + 1) / K under zero-forcing. Millimetre waves have the bandwidth, and need those antennas, because the aperture of one is so small.`,
    ],
    check: [
      {
        question: 'Why did LTE go to reuse 1, when K = 7 gives 15 dB or more of SIR?',
        options: ['Rate grows only with log(SIR) but linearly with bandwidth, so sharing the whole band and coding for low SIR carries more', 'Reuse 1 has a better SIR', 'Other frequencies were not available', 'K = 7 cells are physically harder to plan'],
        answer: 0,
        explain: `In this model the median SIR at K = 1 is only ${nf(S1.medianDb, 0)} dB and at K = 7 it is ${nf(S7.medianDb, 0)} dB; but K = 7 gives each cell a seventh of the band. Log wins: ${nf(S1.perCell, 2)} against ${nf(S7.perCell, 2)} b/s/Hz. Edge users are then helped by scheduling and interference coordination.`,
        why: ['', 'Its SIR is far worse. It wins anyway.', 'It was a design choice, not a shortage.', 'Planning is a reason, a secondary one.'],
      },
      {
        question: 'Eight users all at the same mean SNR. Why does max-rate scheduling beat round robin, when all else is equal?',
        options: ['It serves each user only at its fading peaks, so the average served SNR is several times the mean', 'It has less overhead', 'It uses more power', 'It serves more users per slot'],
        answer: 0,
        explain: `The best of 8 Rayleigh users has H_8 = ${nf(harmonic(8), 2)} times the mean SNR, which in this model takes the cell from ${nf(EQ.rr, 2)} to ${nf(EQ.mx, 2)} b/s/Hz. With users at the same mean, it costs no fairness either.`,
        why: ['', 'Both have the same overhead here.', 'Same power in both.', 'One user per slot in both.'],
      },
      {
        question: 'Handover drops calls at the cell edge at high speed. Which change helps most?',
        options: ['Lower the time to trigger and hysteresis, accepting more back-and-forth', 'Raise the hysteresis', 'Raise the time to trigger', 'Remove shadowing'],
        answer: 0,
        explain: 'A fast phone covers more metres during the time to trigger, and the serving signal may fall below usable before it fires. Handing over earlier trades that for ping-pongs when moving slowly, and real networks scale these by the phone\'s measured speed.',
        why: ['', 'That delays handover further.', 'That delays handover further.', 'A network does not get to choose the buildings.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'Cells and reuse',
      body: `
        <p>A radio spectrum is scarce and a single transmitter can't serve a city's phones. The 1947 idea at Bell Labs (Ring and Young) was to use many low-power transmitters and reuse frequencies at a distance. Every number here is from a model of ideal hexagonal cells: no real network, no capture.</p>
        <p>Colour a hexagonal grid with K colours such that same-coloured cells are as far apart as possible. Geometry permits only certain K: i² + ij + j² gives 1, 3, 4, 7, 9, 12 and so on. Same-coloured cells are <strong>D = √(3K) R</strong> apart, R being the cell radius. A phone at the edge of its cell hears its own mast at distance R and six interferers at about D. With path-loss exponent n:</p>
        <p><code>SIR ≈ (D / R)ⁿ / 6</code></p>
        <p>K = 7 and n = 4 is the classic ${nf(sirClosedDb(7, 4), 1)} dB, which is why the first analog systems used it: FM voice needed about 18 dB. Each cell then gets a seventh of the band. The panel measures the same thing by adding up the actual interferers on the actual grid, with the cell's own points sampled.</p>
        <p>Now look at the last number. Rate goes as log(1 + SIR), so better SIR buys little, and it is paid for with bandwidth, which rate depends on directly. In this model, K = 1 has a median SIR of ${nf(S1.medianDb, 0)} dB and a terrible edge, and carries ${nf(S1.perCell, 2)} b/s/Hz a cell; K = 3 carries ${nf(S3.perCell, 2)} and K = 7 ${nf(S7.perCell, 2)}. That is the reason for <strong>reuse 1</strong>: digital systems with strong coding, from CDMA on, can live with low SIR, and every cell then uses everything. Edge users are the price, and they are handled by scheduling and coordination. Splitting cells, in contrast, raises capacity by the number of cells: nothing in the SIR depends on R. Almost all the capacity added since the 1970s has come from that.</p>`,
      widget: reuseWidget,
      challenge: {
        kind: 'quiz',
        question: 'A network halves the radius of every cell, keeping K and n. What happens to the SIR, and to capacity per km²?',
        options: ['SIR is unchanged; capacity is four times', 'SIR doubles; capacity is unchanged', 'SIR falls by 6 dB; capacity doubles', 'Both are unchanged'],
        answer: 0,
        explain: 'SIR depends only on D / R, a pure number, set by K. Halving R gives four times the cells per km², each with the same share. That is why networks densify.',
        why: ['', 'SIR does not depend on absolute size.', 'Interference falls along with the wanted signal.', 'There are four times as many cells.'],
      },
    },
    {
      title: 'A grid in time and frequency',
      body: `
        <p>Wi-Fi's users contend for the channel; a cell's base station is a scheduler that hands it out. LTE (2009) and 5G (2019) divide a carrier with OFDM, as the many-carrier mathematics explains, into a <strong>resource grid</strong>. A subcarrier is 15 kHz (a symbol of 66.7 µs, plus a cyclic prefix). A <strong>resource block</strong> is 12 subcarriers (${rbKhz()} kHz) for a slot. The base station assigns blocks to users every slot, in the downlink and the uplink, so the mobile sends only when told to: no carrier sense, no collisions.</p>
        <p>A 20 MHz carrier is 100 blocks. Its peak rate is simple multiplication: elements a millisecond × bits per element × streams, less control and reference signals. At 64-QAM ¾, with a quarter for overhead, that is ${nf(gridMbps(100, 4.5), 0)} Mb/s for one stream. The reference signals, scattered through the grid, are known symbols: how the phone measures the channel, each subcarrier's gain and phase, and reports back the quality.</p>
        <p><strong>5G's numerology</strong> makes the subcarrier a parameter: 15 × 2<sup>µ</sup> kHz. Doubling it halves the symbol, the cyclic prefix and the slot: ${nf(slotMs(0), 2)} ms at µ = 0, ${nf(slotMs(3), 3)} ms at µ = 3. A wide subcarrier tolerates more phase noise and Doppler, which high carriers suffer from; a long prefix tolerates more delay spread, which wide-area cells suffer from. So low bands take small µ and millimetre bands large µ. Shorter slots are also how 5G cuts latency.</p>
        <p>Everything is <strong>hybrid ARQ</strong>: each block is acknowledged after about 4 ms in LTE, and a retransmission is <em>combined</em> with what was already received instead of replacing it, so a failed try isn't wasted.</p>`,
      widget: gridWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why not always use the shortest slot, at µ = 3?',
        options: ['The cyclic prefix shrinks with it, to under a microsecond, too short for a wide-area cell\'s echoes', 'It uses more power', 'It carries fewer bits per hertz regardless of the channel', 'It needs a different FFT size in every phone, which is not possible'],
        answer: 0,
        explain: 'A delay spread longer than the prefix causes interference between symbols. Low bands and large cells keep long symbols and long prefixes. High bands have short echoes and much phase noise, so they need short symbols.',
        why: ['', 'Power is not the limit here.', 'The bits per hertz are about equal, when the prefix suffices.', 'Phones implement all of them.'],
      },
    },
    {
      title: 'Who gets the next millisecond',
      body: `
        <p>Now fading becomes useful. Wi-Fi treats a fade as a misfortune. A cell with many users picks, for each block, a user who isn't in a fade. Serving the strongest is <strong>multi-user diversity</strong>: with n users of equal mean SNR in Rayleigh fading, the best of them has H<sub>n</sub> = 1 + ½ + … + 1/n times the mean. A cell with 8 users serves at ${nf(harmonic(8), 2)} times the mean SNR, for nothing but a channel report.</p>
        <p>Three policies:</p>
        <ul>
          <li><strong>Round robin</strong>: everyone in turn, ignoring the channel. Fair in time, and wastes all that.</li>
          <li><strong>Max rate</strong>: whoever can take the most bits now. Highest total; a far user starves.</li>
          <li><strong>Proportional fair</strong>: whoever's rate <em>now</em>, relative to their own recent average, is highest. Each user is served near their own peak; all get a fair share of time and each gains.</li>
        </ul>
        <p>Set users apart in distance and compare the bars. It costs the far users nothing against round robin, and it is what's actually deployed. With equal users max rate and proportional fair coincide, at ${nf(EQ.mx, 2)} against round robin's ${nf(EQ.rr, 2)} b/s/Hz for 8 users at 10 dB, from nothing but scheduling. It works because the fading is <em>slower</em> than the scheduler and the phone can report. High-speed users outrun the feedback, and so does anything with too little traffic to choose from.</p>`,
      widget: schedulerWidget,
      challenge: {
        kind: 'quiz',
        question: 'A user with a poor mean SNR gets a good fade. Under proportional fair, why might they be served ahead of a nearby user with twice the instantaneous rate?',
        options: ['The test is rate relative to their own average: a peak for them can score higher than an ordinary moment for the near user', 'Far users have priority', 'Their rate is secretly higher', 'The near user\'s queue is empty'],
        answer: 0,
        explain: 'Each user is compared with their own recent average, so every user is served near their own peaks. Everyone gets a similar share of slots, and each slot is a good one for its user.',
        why: ['', 'There is no priority by distance.', 'The rate is what it is; the ratio decides.', 'Queues are always full in this comparison.'],
      },
    },
    {
      title: 'Handing over',
      body: `
        <p>A phone moves, and the mast it should be using changes. It measures its neighbours' reference signals and reports. The rule of an LTE <strong>A3 event</strong>: hand over when a neighbour has been stronger than the serving cell by a <strong>hysteresis</strong> for a <strong>time to trigger</strong>. Then the network moves the connection, while the call or transfer carries on over a short interruption.</p>
        <p>Without shadowing the crossing is simple geometry. With 3 dB of hysteresis, n = 3.5 and masts 1 km apart, the phone hands over at ${nf(crossingM(1000, 3.5, 3), 0)} m rather than 500. But buildings add a slowly varying random difference of several dB (<strong>shadowing</strong>), and the levels wander across each other several times around the crossing. Hand over at each crossing and you get <strong>ping-pong</strong>: the network moves you back and forth, spending signalling and risking drops each time.</p>
        <p>Set hysteresis and time to trigger to zero and watch the dashed marks multiply. Raise them far, and the phone hangs on until it's below usable, shown as metres below −110 dBm: a dropped connection. Raise the speed: the same 320 ms covers more road. That's why networks shrink both for fast users. The thresholds and timers are all part of the operator's tuning, cell by cell. Nothing in the standard tells them what values to set.</p>`,
      widget: handoverWidget,
      challenge: {
        kind: 'quiz',
        question: 'What does hysteresis cost?',
        options: ['The phone stays on a weaker cell for longer, which lowers rate and raises the risk of a drop', 'More signalling', 'More power at the mast', 'Nothing: it only removes ping-pong'],
        answer: 0,
        explain: 'It moves the crossing past the midpoint, as the formula shows: it works by being late. Too much of it and the phone gets to the far edge of a cell on the old link.',
        why: ['', 'It lowers signalling: fewer handovers.', 'It does not change the mast\'s power directly.', 'It removes ping-pong by delaying handover, which has that cost.'],
      },
    },
    {
      title: 'A hundred antennas',
      body: `
        <p>A phased array concentrates power: M antennas give 10 log M dB towards one user. With a digital chain per antenna, a base station can send different beams to different users at once on the same block: <strong>multi-user MIMO</strong>. Knowing all their channels H, it can apply a precoder that cancels each user's stream at every other user. That's <strong>zero-forcing</strong>, and its result is a clean formula. Of K users and M antennas, each with SNR</p>
        <p><code>SNR = ρ (M − K + 1) / K</code></p>
        <p>on average, where ρ is the total power's SNR at one antenna. The tests hold a simulation to it, by inverting H Hᴴ in Rayleigh channels. With 4 users at 0 dB, 8 antennas give ${nf(10 * Math.log10(zfMeanSnr(4, 8, 0)), 1)} dB each and 64 give ${nf(10 * Math.log10(zfMeanSnr(4, 64, 0)), 1)}. Spectrum and power fixed, each user can have the whole band at once. <strong>Massive MIMO</strong> (Marzetta, 2010) works by a law of large numbers: as M grows, two users' channels become orthogonal by chance, falling as 1 / √M. In the limit even simple precoders work, and fading averages out.</p>
        <p>The catch is knowing H: the receive side measures it from each phone's <strong>pilots</strong>, which are limited, by how many orthogonal sequences fit in a coherence time; reusing them in a neighbouring cell is pilot contamination. So real systems use time-division duplex so that uplink measurements apply to the downlink, and grouped beams, not 128 independent chains, for reasons of power. The formula is the ideal; these are the costs.</p>`,
      widget: massiveWidget,
      challenge: {
        kind: 'quiz',
        question: 'M = 64, K = 4. What does adding 4 more users cost each existing user under zero-forcing?',
        options: ['About half their SNR: less power each, and 4 more dimensions used up from 61', 'Nothing: the antennas separate them', 'All their rate: they must share in time', 'A quarter of their SNR'],
        answer: 0,
        explain: `ρ (M − K + 1) / K: going from K = 4 to K = 8 takes it from 61 / 4 to 57 / 8 of ρ. The power is shared more thinly, and cancelling takes a few more dimensions. But 8 users at half SNR each carry more in total, which is why you schedule as many as the channel knowledge allows.`,
        why: ['', 'Separation has a cost: each stream gets a smaller share of the power.', 'Spatial streams are simultaneous.', 'It is more than that: 61/4 → 57/8 is a factor of 2.14.'],
      },
    },
    {
      title: 'What 5G changed',
      body: `
        <p>Much of what was sold as 5G is the previous steps, turned up. Its real changes:</p>
        <ul>
          <li><strong>Numerology and slots</strong>: subcarrier spacing as a parameter, and mini-slots down to a couple of symbols, for tight latency budgets.</li>
          <li><strong>Beams everywhere</strong>: at a high band even control signals are beamed, and finding a phone is a search across beams.</li>
          <li><strong>Millimetre waves</strong> (24 GHz and up): hundreds of MHz of channel, where 4G's was 20. The table shows why: the same antenna gain at 28 GHz reaches a tenth of what it does at 2.8, because aperture falls as λ². Arrays give it back, because a small wavelength fits many elements in the same area. But walls, hands and rain do not care about your array, so millimetre waves stay short, line-of-sight links in hot spots, and most 5G runs in sub-6 GHz.</li>
          <li><strong>A core network built as software</strong>: service-based functions, and slices of one network sold apart. Nothing about the air; everything about who pays.</li>
        </ul>
        <p>Latency: a 5G radio has a slot of ${nf(slotMs(3), 3)} ms at µ = 3 and a target of milliseconds over the air. Yet a real round trip is usually longer, because of what the path chapter (chapter ${numOf('path')}) measures: queues, core network and the distance to the server.</p>
        <p>That is the wireless half of the book. Radio is the same theory as a wire (Shannon, an SNR, a code, a queue), with an adversary: the channel changes under your feet, and everybody else is in it too. Every number here came from a model, and a phone's own measurements would differ in detail; the shape is what travels. These models will not tell you what a real cell delivers. They tell you why it was built the way it is.</p>`,
      widget: mmwaveWidget,
      challenge: {
        kind: 'quiz',
        question: 'At the same antenna gain, what does moving from 3.5 GHz to 28 GHz cost in free-space path loss?',
        options: [`${nf(20 * Math.log10(28 / 3.5), 0)} dB, by 20 log f, which an array of about 64 elements gets back`, '6 dB', 'Nothing in free space', '40 dB'],
        answer: 0,
        explain: `A factor of 8 in frequency is 20 log 8 = ${nf(20 * Math.log10(8), 1)} dB, a reach of ${nf(reachKm(140, 3.5) / reachKm(140, 28), 0)} times less. An array of 64 elements gives ${nf(10 * Math.log10(64), 0)} dB at one end, in the size of a coin, and more if both ends have one.`,
        why: ['', 'That is one doubling, a factor of 2.', 'Same gain means a smaller aperture.', 'That would be a factor of 100.'],
      },
    },
  ],
};
