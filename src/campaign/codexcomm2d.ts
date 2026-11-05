// Codex entries for the Communication extension: carriers, codes, queues, datacentre. Same shape as codex.ts, gathered by codexcomm2.ts; the fuller texts are codexmore8d.ts, the questions codexcheck10d.ts,
// the numbers pinned by tests/content-codexcomm2d.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_D: CodexEntry[] = [
  // ---- many carriers
  E('fft', 'FFT and the butterfly', 'tool', 'A transform of N points splits into two of N / 2, joined by one column of <b>butterflies</b>, y0 = a + W b and y1 = a − W b: N / 2 · log<sub>2</sub> N of them against N² multiplications. In gates a twiddle of 1 or −j is wires, a 45° one is shift-and-add, and only the rest need a complex multiplier (6,884 NANDs at 10 bits). Streaming pipelines do it a sample a clock.', ['ofdm', 'shiftadd', 'arraymul']),
  E('waterfill', 'Water-filling', 'law', 'The best split of one power budget over tones of different quality: p = μ − Γ / g where that is positive, nothing elsewhere, like water poured over a floor of height Γ / g. At Γ = 0 dB it is the capacity of parallel channels. Whole bits by greedy loading come close, and on a real loop choosing the tones matters far more than moving power among them.', ['ofdm', 'shannon', 'qam']),
  // ---- codes near the limit
  E('ldpc', 'LDPC codes and belief propagation', 'tool', 'Sparse parity checks, decoded by passing beliefs along a graph: each bit tells each check what it believes, leaving out what that check told it, and each check answers with what the others imply. Exact on a graph with no cycles, and very good on long sparse ones. Density evolution computes a typical long code\'s threshold with no code at all: ε* = 0.4294 for (3, 6) on the erasure channel.', ['viterbi', 'reedsolomon', 'shannon']),
  // ---- queues and congestion
  E('littleslaw', 'Little\'s law and queueing delay', 'law', 'The mean number inside a queue is the arrival rate times the mean time inside, for any queue at all. With random arrivals and sizes the mean wait is ρ / (1 − ρ) packet times: 1 at half load, 9 at 90 %, and one packet in 100 waits 45 there. A link with idle time still queues, because idle time cannot be saved up.', ['bufferbloat', 'throughput', 'aqm']),
  E('cubic', 'CUBIC', 'tool', 'TCP\'s window as a curve in real time, not in round trips: W(t) = C (t − K)³ + W<sub>max</sub>, falling by 30 % on a loss, climbing fast, flattening near where it last lost, then probing beyond. A Reno-friendly region keeps it no slower than Reno. On 1 Gb/s across 100 ms it recovers in about 18 s, where Reno takes about 7 minutes.', ['aimd', 'tcp', 'bbr']),
  E('aqm', 'RED and CoDel', 'tool', 'Active queue management: signal before the buffer is full. <b>RED</b> drops at random, more as the averaged queue length rises. <b>CoDel</b> measures how long a packet waited: above 5 ms for a whole 100 ms it drops one, then the next 100 ms later, then 100 / √2, 100 / √3, until the wait falls. It needs no tuning and takes a 504 ms queue to about 3 ms in the model.', ['bufferbloat', 'ecn', 'fairqueue']),
  E('fairqueue', 'Fair queueing', 'trick', 'A queue per flow, served in turn. A sparse flow waits for at most one packet from each other flow, whatever they are doing, and a sender that ignores every drop only overflows its own queue. Shares are set by the scheduler and not by the senders\' rules or round trips, so it only has to run at the link that really is the bottleneck.', ['aqm', 'bufferbloat', 'bbr']),
  E('ecn', 'ECN', 'tool', 'Explicit Congestion Notification: a router sets two IP header bits to Congestion Experienced in place of dropping, the receiver echoes that in its ACKs, and the sender cuts its window as for a loss, once a round trip. No data is lost and nothing is sent again. It takes both ends and the router, which is one reason it took two decades to spread.', ['aqm', 'dctcp', 'tcp']),
  E('bbr', 'BBR', 'tool', 'A sender that models the path and ignores loss: the bottleneck rate as the largest delivery rate in ten round trips, the base RTT as the smallest in ten seconds, sending paced at their product with a window of two of them. It leaves buffers near empty and shrugs off random loss, and on a shallow tail-drop buffer it takes nearly the whole link from CUBIC.', ['cubic', 'bufferbloat', 'fairqueue']),
  // ---- inside the data centre
  E('fattree', 'Fat tree (folded Clos)', 'concept', 'A Clos network folded along its middle stage, in Ethernet: every switch the same k-port part. k³ / 4 hosts, 5k² / 4 switches and (k / 2)² paths between two pods, so 27,648 hosts on 48-port switches. With as many links up as hosts down, any host could reach any other at full rate if traffic spreads evenly over the paths.', ['ecmp', 'crossbar', 'learnsw']),
  E('ecmp', 'ECMP', 'trick', 'Equal-cost multipath: a switch hashes the five-tuple to pick an uplink. Stateless, and all of a flow\'s packets take one path, so they stay in order. It is blind to load, so it is balls in bins: with as many flows as paths, a path is idle with chance (1 − 1 / m)<sup>n</sup>, and the fabric carries about 63 % of what it could.', ['fattree', 'routing', 'tcp']),
  E('incast', 'Incast', 'concept', 'Many servers answer one request at once through one shallow port. A flow that loses the end of its burst has no later packets to raise duplicate ACKs, so it waits for a retransmission timer, historically 200 ms against a 100 µs round trip, and the next read waits for the slowest flow. Adding servers makes the read slower.', ['tcp', 'dctcp', 'tailscale']),
  E('dctcp', 'DCTCP', 'tool', 'ECN carrying a quantity. A switch marks every packet arriving with K or more queued; the sender keeps α, the running share marked, and cuts W by α / 2 once a round trip. A light marking is a small cut and all marked is a halving, so the queue stays near K with the link full. Only safe within one administration: it is far more aggressive than Reno on a mark.', ['ecn', 'incast', 'aimd']),
  E('rdma', 'RDMA', 'tool', 'The transport in the NIC: an application posts a request to the hardware with no system call, and the far NIC writes memory with no interrupt and no CPU. RoCEv2 runs it over UDP and IP. Classic RDMA retransmits by go-back-N, with goodput (1 − p) / (1 − p + W p), so a large pipe needs a network that almost never loses.', ['pfc', 'tcp', 'arq']),
  E('pfc', 'Priority flow control', 'tool', 'Lossless Ethernet (IEEE 802.1Qbb): past a threshold XOFF a switch pauses one traffic class on its input link. It needs about 2 · delay + 2 packets of headroom per port and class. A pause stops whoever is queued behind it, so congestion spreads to innocent flows, and pauses in a cycle never end: that is a deadlock.', ['rdma', 'hol', 'dctcp']),
  E('tailscale', 'The tail at scale', 'law', 'A request waiting on n servers, each slow with chance q, is slow with chance 1 − (1 − q)<sup>n</sup>. One server in 100 slow and a fan-out of 100 makes 63 % of requests slow, so what is rare on one server is normal for the service. That is why tail latency and not the average decides these designs.', ['incast', 'throughput', 'ecmp']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_D: Record<string, string> = {
  fft: 'carriers', waterfill: 'carriers',
  ldpc: 'codes',
  littleslaw: 'queues', cubic: 'queues', aqm: 'queues', fairqueue: 'queues', ecn: 'queues', bbr: 'queues',
  fattree: 'datacentre', ecmp: 'datacentre', incast: 'datacentre', dctcp: 'datacentre', rdma: 'datacentre', pfc: 'datacentre', tailscale: 'datacentre',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_D: Record<string, string[]> = {
  fft: ['FFT', 'butterfly'], waterfill: ['water-filling'],
  ldpc: ['LDPC', 'belief propagation', 'density evolution'],
  littleslaw: ['Little’s law', 'Little\'s law', 'Pollaczek-Khinchine'], aqm: ['CoDel'], fairqueue: ['fair queueing', 'FQ-CoDel'], ecn: ['ECN'], bbr: ['BBR'], cubic: ['CUBIC'],
  fattree: ['fat tree', 'leaf-spine'], ecmp: ['ECMP', 'equal-cost multipath'], incast: ['incast'], dctcp: ['DCTCP'], rdma: ['RDMA', 'RoCEv2'], pfc: ['PFC', 'priority flow control'], tailscale: ['tail at scale'],
};
