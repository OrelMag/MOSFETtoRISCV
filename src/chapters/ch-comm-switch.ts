import { binomialTail, HOL_LIMIT, HOL_N4, holSaturation, sharedCapacity, singleFrame } from '../comm/ethswitch';
import { arbiterN, cam, registry } from '../lib';
import { crossbar, ethSwitch, inputBuffer, macTable, outputPort, tablePort } from '../lib/ethswitch';
import { stats } from '../sim/stats';
import { BENCH_OPTS, benchScene, crossbarScene, learnScene, rigOf } from '../widgets/ethswitch';
import { duplexWidget, holWidget, latencyWidget, muxWidget, sharedEfficiency, tableWidget } from '../widgets/ethswitchtools';
import type { Chapter } from './types';

const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)} %`;

const CAM4 = nands(cam(4, 48)), TAB4 = nands(macTable(4, 4)), TAB7 = nands(macTable(7, 4)), CAM7 = nands(cam(7, 48));
const ARB = nands(arbiterN(4)), XB = nands(crossbar()), OUT = nands(outputPort()), TP = nands(tablePort());
const IN7 = nands(inputBuffer({ cellK: 7 })), IN11 = nands(inputBuffer({ cellK: 11 }));
const BENCH = nands(ethSwitch(BENCH_OPTS)), BENCH11 = nands(ethSwitch({ ...BENCH_OPTS, cellK: 11 }));
const RAM4 = nands(registry.get('mac_table4_4_ram')!), CAM4W = nands(cam(4, 59));
const VOQ_DELTA = [4, 8, 16].map((cells) => nands(inputBuffer({ cellK: 7, cells, voq: true })) - nands(inputBuffer({ cellK: 7, cells })));
const sgn = (x: number) => `${x < 0 ? '−' : '+'}${n0(Math.abs(x))}`;
const SAF = singleFrame({ cellK: 7 }, 64), CT = singleFrame({ cellK: 7, cut: true }, 64);
const SHARE = sharedCapacity(20, 0.1, 1e-6);
const TAIL = binomialTail(20, 0.1, SHARE);
const HOL4 = holSaturation(4, false, 400000, 3), HOL4_NOSELF = holSaturation(4, false, 400000, 3, false), HOLBIG = holSaturation(64, false, 20000, 3);
const EFF64 = sharedEfficiency(4, (64 + 8 + 12) * 8), EFF1518 = sharedEfficiency(4, (1518 + 8 + 12) * 8);

export const chSwitch: Chapter = {
  id: 'switch', num: 49, title: 'A switch', level: 'Communication',
  blurb: 'Can everyone talk at once: address learning, a crossbar and its arbiter, store-and-forward against cut-through, and head-of-line blocking.',
  goals: [
    'say what statistical multiplexing buys over a reserved circuit and what it costs in queues',
    'trace address learning, flooding and filtering on a table hashed in RAM, and say what a collision costs',
    'follow a frame through the buffer, the table, an arbiter and the crossbar of a four-port switch, cycle by cycle',
    'compute the latency of store-and-forward and of cut-through from frame length and link rate, and say what cut-through gives up',
    'explain head-of-line blocking, measure it, and say what virtual output queues need to remove it',
  ],
  builds: ['ethernet', 'exchange', 'multicore'],
  recap: {
    keep: [
      `Circuit switching reserves the peak of every conversation; packet switching shares one link and queues the excess. Twenty sources each active 10 % of the time need 20 units reserved, and a shared link of ${SHARE} units overflows less than once in a million observations. The price is a queue, and delay or loss when the sources coincide.`,
      `A switch learns by listening. Each frame's source address goes into a table with the port it arrived on; each destination is looked up. A hit goes to one port, a miss or a group address (the first byte's low bit) is flooded to every port but the source, and a frame whose destination is on its own port is filtered. Entries age out.`,
      `The table is hashed in RAM: the 48-bit address is XOR-folded to t bits, one slot read for the destination and one for the source, one cycle per frame. Two addresses that hash alike evict each other, and the evicted one floods until it speaks again. At 16 entries the whole table (RAM, hash, compare, ageing, counters) is ${n0(TAB4)} NANDs; its two RAM blocks alone are ${n0(RAM4)}, against ${n0(CAM4W)} for a 59-bit-wide library CAM and ${n0(CAM4)} for the 48-bit key store. In this accounting neither is clearly cheaper.`,
      `The crossbar is a 4:1 multiplexer per output (${n0(XB)} NANDs). An output port holds a round-robin arbiter (${n0(ARB)} NANDs), a busy flag and the source register. An input asks for the lowest idle output it has a frame for; each output grants one asker per cycle. A transfer reads the cell one byte a cycle while the output's ready is 1.`,
      `Store-and-forward sends a frame after its last byte has arrived and adds one frame time; the model (which the gates equal cycle for cycle in the tests) sends a 64-byte frame at cycle ${SAF.firstOut}. Cut-through starts when the table has answered (cycle ${CT.firstOut}) and adds only the header time. It has sent most of a frame before the FCS can be checked, so a bad frame goes out; a real switch passes the received FCS through or stamps a bad one so the next receiver drops it.`,
      `With one FIFO per input only the oldest frame competes, so a frame for a busy output holds up frames behind it that are bound for idle ones. Saturation is ${HOL4.toFixed(3)} for N = 4 uniform traffic (published ${HOL_N4}, and ${HOL_LIMIT.toFixed(4)} as N grows). The switch model measures 0.68 on 64-byte frames. One queue per output, with enough cells to look past a blocked frame, reaches about 0.80 with 4 cells, 0.88 with 8 and 0.92 with 16.`,
      `Full duplex gave each port a wire per direction, so a switch port never sees a collision and CSMA/CD has nothing to do. What a switch still shares is the table, the buffers and the crossbar. It forwards by address inside one network and floods what it cannot place; crossing networks takes a router.`,
    ],
    check: [
      {
        question: 'A frame arrives at a switch with an empty table. Its destination address is a unicast address. What does the switch do with it, and what does it learn?',
        options: ['It floods the frame to every port but the arrival port, and learns the source address on the arrival port', 'It drops the frame, because it cannot place the destination', 'It sends the frame back out of the arrival port to find the destination', 'It floods the frame and learns the destination address on every port'],
        answer: 0,
        explain: 'A miss is flooded to every port except the source, so the destination host (wherever it is) gets the frame. The source address on the frame tells the switch where the sender is, which is the only thing a frame teaches it.',
        why: ['', 'Dropping would leave a new host unreachable until it spoke first; a switch floods what it cannot place.', 'A frame is never returned to its source port: the sender is on that wire and would see its own frame.', 'The destination address says nothing about where that host is. Only the source address of a frame arriving on a port reveals what sits behind it.'],
      },
      {
        question: 'Four inputs each keep one FIFO. The oldest frame of input 0 waits for a busy output while input 0 has a younger frame for an idle output. Which statement is true?',
        options: ['The younger frame waits too: only the head of each FIFO competes, which is head-of-line blocking', 'The younger frame is sent at once because the crossbar is non-blocking', 'The switch reorders the two frames, since frames may be reordered freely', 'The younger frame is dropped to make room'],
        answer: 0,
        explain: 'With a single queue per input only the head can be offered to an output. The crossbar could carry the younger frame, but the queue does not show it. A queue per output removes the effect, given cells enough to look past the blocked frame.',
        why: ['', 'The crossbar is non-blocking, which is exactly why the loss is in the queue and not in the fabric.', 'A switch keeps the frames of one flow in order, and these may well belong to one flow.', 'Nothing is dropped while a cell is free; the buffer holds both frames.'],
      },
      {
        question: 'A 1518-byte frame crosses one hop at 100 Mb/s. About how much latency does cut-through save against store-and-forward?',
        options: ['About 120 µs: the frame time of 1526 bytes less the header time', 'Nothing: the last byte leaves at the same time either way', 'About 1 µs, the interframe gap', 'About 12 ns, the lookup time'],
        answer: 0,
        explain: 'Store-and-forward waits for the whole frame: (1518 + 8) bytes at 100 Mb/s is 122 µs. Cut-through waits for the preamble and the header, about 2 µs. With cut-through the first byte leaves some 120 µs sooner, and so does the last when the output is free.',
        why: ['', 'The whole frame starts sooner with cut-through, so its last byte leaves sooner too, by about the same 120 µs.', 'The interframe gap is 12 byte times (0.96 µs at 100 Mb/s) and is spent on the wire in both designs.', 'A lookup takes a few clock cycles, far less than a frame time, and it is not what separates the two designs.'],
      },
    ],
  },
  steps: [
    {
      title: 'Everyone at once',
      body: `
        <p>Chapter 40's exchange gave every call a path of its own: a pair of contacts at each stage, reserved while the call lasted and idle when nobody spoke. That suits a conversation that fills its channel. Data does not. A host sends a burst, then nothing, then another burst, and a reserved path spends most of its life carrying silence.
        The alternative is to put the data in <strong>packets</strong>, each carrying its destination, and to let all the sources share the capacity: whoever has a packet uses the wire now. Paul Baran and Donald Davies arrived at the idea independently in the 1960s, and Davies named the unit.</p>
        <p>The gain is statistical. If n sources each send with probability p, the number sending at once is binomial. A circuit must reserve n peaks. A shared link needs only enough for the tail of the distribution, and a queue absorbs what the tail leaves.
        With n = 20 and p = 10 % the mean demand is 2 units; keeping the overflow below one in a million takes ${SHARE} units on a shared link against 20 reserved, a gain of ${(20 / SHARE).toFixed(1)}. The widget lets you move n, p and the target.</p>
        <p>The price comes in two parts. A packet link must <strong>queue</strong> when several packets want the same output, so latency now varies with load, and when the queue is full it must <strong>drop</strong>: where chapter 40's Erlang B counted blocked calls, a packet switch counts delayed and lost packets. And each packet carries its own address, which the switch must read and look up at wire speed.
        This chapter builds that switch from the Ethernet frames of <a href="#/c/ethernet/0">chapter 48</a>: four ports, a table that learns where hosts are, a crossbar that moves bytes between ports, and the buffers and arbiters that decide who goes first.</p>`,
      widget: muxWidget,
      more: { numbers: `<p>The tail is exact: for X ~ Binomial(20, 0.1), P(X &gt; ${SHARE}) = ${TAIL.toExponential(1)}. Real traffic is burstier than independent sources, which is why real links keep more headroom and larger buffers than this model asks for.</p>` },
      challenge: {
        kind: 'quiz',
        question: 'Fifty sources each send at a peak of 1 unit, 5 % of the time. What does a circuit-switched design reserve, and roughly what does a shared packet link need for a low overflow?',
        options: ['50 units reserved; a shared link needs a small fraction of that, a handful of units, plus a queue', '50 units for both, since every source may transmit', '2.5 units for both, the mean demand', '5 units reserved, 5 % of the peak sum'],
        answer: 0,
        explain: 'The circuit must hold each source\'s peak whether or not it sends. The shared link needs the tail of the binomial: with a mean of 2.5, more than about ten sending at once is already very unlikely. The mean alone is not enough, because the link would overflow in a large share of the observations.',
        why: ['', 'Reserving 50 is what the circuit does; the shared link exists because the sources rarely coincide.', 'Provisioning for the mean makes the link overflow whenever demand exceeds it, which is a large share of the time.', 'A circuit reserves a full peak for each conversation; it has no way to share one reservation among sources.'],
      },
    },
    {
      title: 'Learning',
      body: `
        <p>A switch starts knowing nothing about the hosts behind its ports. Every Ethernet frame carries both addresses, and that is enough. When a frame arrives on port 2 with source address S, S is behind port 2: the switch writes the pair into its <span data-show="tb">address table</span>. To forward a frame it looks up the
        <em>destination</em> address D. A <strong>hit</strong> gives one port and the frame goes there alone. A <strong>miss</strong> means D has not spoken yet, so the frame is <strong>flooded</strong> to every port except the one it came in on (never back to the source, which would see its own frame). Hosts reply, replies teach the table, and floods stop.</p>
        <p>Three more rules complete the behaviour. A <em>group</em> address, with the low bit of the first byte set (the broadcast address ff:ff:ff:ff:ff:ff is the all-ones case), is always flooded and is never learned as a source. A frame whose destination sits on the port it came from is
        <strong>filtered</strong>: both hosts are on that wire already. And entries <strong>age</strong>: an entry not refreshed for a while is forgotten, so a host that moved, or went quiet, is not remembered wrongly for ever. A host that moves to another port is relearned from its first frame, which overwrites the old entry.</p>
        <p>The gate-level switch does the table work once a frame, as soon as the twelfth byte has arrived (the destination is bytes 0 to 5, the source 6 to 11). The <span data-show="tp">table port</span> serves one lookup a cycle for all four ports, round robin. Four hosts hang on the ports below. Press <em>Teach the table</em>, or send
        frames by hand, and watch the table fill and the log mark floods and unicasts.</p>
        <div class="try">Send A to B while the table is empty: the frame is flooded to the other three ports and A is learned.</div>
        <div class="try">Now send B to A: the frame goes out of port 0 alone and B is learned.</div>`,
      scene: learnScene,
      tries: [
        (st) => (rigOf(st)?.seen ?? []).some((f) => f.kind === 'flood' && f.src[5] === 1 && f.dst[5] === 2),
        (st) => (rigOf(st)?.seen ?? []).some((f) => f.kind === 'unicast' && f.port === 0 && f.src[5] === 2 && f.dst[5] === 1),
      ],
      challenge: {
        kind: 'reach',
        goal: 'Make the switch learn all four hosts, then send one frame that goes out of exactly one port.',
        check: (st) => { const r = rigOf(st); return !!r && r.model.table.learned >= 4 && r.seen.some((f) => f.kind === 'unicast' && !(f.dst[0] & 1)); },
        answer: 'Press Teach the table (each host sends one frame to everyone, which floods and teaches), let it finish, then send A to B: the log shows a unicast on port 1 and the table lists four hosts.',
        hints: ['A frame teaches the switch only its source address.', 'The Teach button has every host speak once.'],
        solve: (st) => { const r = rigOf(st); if (!r) return; r.teach(); r.send(0, [2, 0, 0, 0, 0, 2], 64, { delay: 400 }); st.runCycles(900, undefined, 0, true); st.refresh(); },
      },
    },
    {
      title: 'The table\'s price',
      body: `
        <p>A table of 2<sup>t</sup> entries has to be read at wire speed, twice a frame (the destination to decide, the source to learn). Two designs are natural. A <strong>CAM</strong> (the library's <code>cam(k, w)</code> from the memory chapters) compares the key with every entry at once and answers in one step; it holds exactly what was written until it is full. A table <strong>hashed in RAM</strong> turns the 48-bit address into a t-bit
        slot number and reads that one slot; the address stored there is compared with the key. Hashing needs a function that spreads the addresses and is cheap: this one is an <strong>XOR-fold</strong>. Hash bit i is the XOR of address bits i, i + t, i + 2t and so on, which takes 48 − t two-input XORs. Every address bit changes exactly one hash bit, so
        addresses that differ only within the low t bits (a run of up to 2<sup>t</sup> consecutive network cards from one maker, the common case) always land in different slots. Addresses that differ in higher bits can collide: with t = 4, 0x7F and 0x80 share a slot. Two random addresses collide with probability 2<sup>−t</sup>.</p>
        <p>A slot holds the key (48 bits), a valid bit, the port (2 bits) and a stamp of the age (8 bits): 59 bits, in two port RAMs because a RAM word here is at most 32 bits. The destination's slot is read on port 0, the source's on port 1, and the source's entry is written back on port 1 at the end of the same cycle, so the lookup sees the old contents.
        <strong>Ageing</strong> uses the stamp: a free-running tick (every 2<sup>4</sup> cycles in the cost figures here, longer in the scenes) is copied into the entry when its host speaks, and an entry is live while the tick is less than 64 ahead of its stamp. A sweeper visits one slot a tick when the table is idle and clears the stale ones, so a stamp can never wrap around into looking young.</p>
        <p>A <strong>collision</strong> has a plain cost. Two live hosts that share a slot keep evicting each other: each time one speaks it overwrites the other, so the other's next frame is a miss and is flooded to three ports. The table counts evictions. The widget measures the effect: the hashed table's hit rate falls as the hosts approach the size of the table, while the CAM stays exact until it is full and then falls as 2<sup>t</sup> / hosts.</p>
        <p>What does each cost in our units? Compare like with like. The 16-entry table as built is ${n0(TAB4)} NANDs, but that includes the hash, the comparators, the ageing logic and four counters. Its two RAM blocks alone, the storage of the 59-bit entries with two ports, are ${n0(RAM4)}. A library CAM of 16 entries of 59 bits (comparing all 59, more than the lookup needs) is ${n0(CAM4W)}, and the 48-bit key store alone ${n0(CAM4)}, with no port or age attached. At 128 entries the whole table is ${n0(TAB7)} and the 48-bit CAM ${n0(CAM7)}. The numbers support no winner: in this accounting every bit is a latch and a RAM port costs a decoder and a read tree. The difference that matters in silicon lies outside it: an SRAM cell is six transistors and a binary CAM cell about ten, with a match line that every search
        charges, which is why large tables are hashed RAM and CAMs stay small.</p>`,
      widget: tableWidget,
      more: { real: '<p>Production switches use tables of thousands to hundreds of thousands of entries, usually hashed (often by CRC rather than XOR-fold, with several slots per bucket to soften collisions), and some keep a small CAM for the entries that collide. Ageing defaults to minutes. These figures are from memory and vary by product.</p>', pitfall: '<p>A table that is too small does not fail loudly. Hosts that collide still work: every frame between them is flooded, so traffic multiplies by the number of ports minus one, and the evictions counter is the only sign.</p>' },
      challenge: {
        kind: 'quiz',
        question: 'Two active hosts hash to the same slot of a hashed table. What happens to their traffic?',
        options: ['Each frame one of them sends overwrites the other\'s entry, so frames to the other host are flooded until it speaks again', 'The switch stores both in the same slot and tells them apart by port', 'Both hosts lose connectivity until the table is cleared', 'The later host is refused an entry and is always flooded'],
        answer: 0,
        explain: 'A slot holds one address. The newer source evicts the older, whose next frame to arrive is a miss: it is flooded to every port, and the eviction counter ticks. Connectivity survives; bandwidth does not.',
        why: ['', 'The slot has room for one key; the port is data of the entry, not part of the key.', 'Flooding delivers the frames, so nothing breaks; it only wastes bandwidth on the other ports.', 'The newer entry wins in this design, so the older host is the one that is flooded.'],
      },
    },
    {
      title: 'The crossbar and its arbiter',
      body: `
        <p>Once the table has said which output a frame needs, the bytes must get there. The most direct fabric is the <strong>crossbar</strong>: every input can reach every output, with a multiplexer in front of each output choosing the input that drives it. For four ports that is four 4:1 multiplexers, ten bits wide each (the byte, <code>last</code> and <code>valid</code>): ${n0(XB)} NANDs including the return path of
        ready. It has no internal blocking: any set of inputs addressed to different outputs moves at once. N inputs and N outputs cost N² crosspoints, which is chapter 40's crossbar again, now carrying bytes through gates where it carried calls through contacts.</p>
        <p>What a crossbar cannot decide is what happens when two inputs want the <em>same</em> output. Each output owns that decision: an <span data-show="out0">output port</span> holds a <strong>round-robin arbiter</strong> (${n0(ARB)} NANDs, the one built in <a href="#/c/multicore/2">chapter 27</a>), a busy flag that holds the output for the length of a frame, and the register that says which input drives it. Every cycle each idle input that has a frame
        waiting offers itself to the <em>lowest-numbered idle output</em> it has a frame for; each idle output grants one of the inputs that chose it, in rotating priority, so nobody starves. An input that is not granted offers itself again next cycle, by which time another output may have freed. One round of request and grant per cycle, with no iteration, is what keeps the arbiter small; what it loses is quantified two steps on.</p>
        <p>A granted frame is read from the input's buffer one byte a cycle, through the crossbar, for as long as the output's <code>ready</code> is 1. A MAC that takes bytes at a wire's pace holds ready low most of the time, and the input simply waits: the reader advances only when the byte moves. Press <em>Three hosts to D at once</em>: the three frames queue for output 3 and the timeline shows the arbiter handing it to one input after another.</p>`,
      scene: crossbarScene,
      tour: {
        label: 'Walk me through the switch',
        beats: [
          { title: 'Four ports', say: 'Four <strong>input buffers</strong> on the left, one per port, each holding up to four frames in cells of RAM. Bytes arrive here first.', at: [], show: ['in0', 'in1', 'in2', 'in3'] },
          { title: 'The table', say: 'After the twelfth byte of a frame the input asks the <strong>table port</strong>, which serves one input a cycle, and the <strong>MAC table</strong> answers with a mask of outputs.', at: [], show: ['tp', 'tb'] },
          { title: 'Who may go', say: 'Each <strong>output port</strong> holds an arbiter, a busy flag and a source register. Inputs request, each output grants one.', at: [], show: ['out0', 'out1', 'out2', 'out3'] },
          { title: 'The bytes', say: 'The <strong>crossbar</strong> is a 4:1 multiplexer per output, selected by the output\'s source register. Opened, it is multiplexers and a few ANDs.', at: [], show: ['xb'] },
        ],
      },
      challenge: {
        kind: 'reach',
        goal: 'Make three hosts send to host D at once, and see D\'s output serve the three frames one after another.',
        check: (st) => { const r = rigOf(st); return !!r && new Set(r.seen.filter((f) => f.port === 3 && f.kind === 'unicast').map((f) => f.src.join('.'))).size >= 3; },
        answer: 'Press Three hosts to D at once. The first press also teaches the table, so wait for the run to finish: output 3 shows three frames, one per source, and the timeline shows output 3 busy in three consecutive blocks.',
        hints: ['The table must know where D is before the frames are unicast.', 'The button teaches the table first if it is empty.'],
        solve: (st) => { const r = rigOf(st); if (!r) return; if (!r.taught) r.teach(); for (let p = 0; p < 3; p++) r.send(p, [2, 0, 0, 0, 0, 4], 64, { delay: 350 }); st.runCycles(1200, undefined, 0, true); st.refresh(); },
      },
      more: { numbers: `<p>The per-block costs: crossbar ${n0(XB)} NANDs, an output port ${n0(OUT)} (arbiter ${n0(ARB)}, a frame counter, busy and source registers), the table port ${n0(TP)} (its own arbiter and two 4:1 multiplexers of 48 bits). The buffers dominate: one input is ${n0(IN7)} NANDs with 128-byte cells and ${n0(IN11)} with the 2048-byte cells that hold any legal frame, almost all of it RAM.</p>` },
    },
    {
      title: 'Store-and-forward and cut-through',
      body: `
        <p>When may an output start sending a frame that is still arriving? A <strong>store-and-forward</strong> switch waits for the last byte. It has seen the whole frame, so it knows its length, and the receiving MAC has checked the FCS: a frame with a bad checksum is simply never queued. The cost is one frame time of latency per hop. On the model the gates are checked against, moving one byte a cycle, a 64-byte frame goes out at cycle ${SAF.firstOut} (the last byte went in at ${SAF.lastIn}).</p>
        <p>A <strong>cut-through</strong> switch starts as soon as it knows <em>where</em>. The rule is the first-bytes-known rule: the destination address is the first six bytes, so the lookup can run once they are in and the earliest an output can start is a few byte times after the preamble. This switch looks up after the twelfth byte (it learns the source in the same operation) and starts at cycle ${CT.firstOut}, the same for a 64-byte frame and a 1500-byte one. The reader runs behind the writer in the same cell, on the second port of the RAM, and it
        stalls if it catches the writer, which is why the buffer here is a two-port RAM.</p>
        <p>What cut-through gives up is the check. The FCS is the last four bytes, and by then the first bytes have gone. The widget shows it: tick <em>bad FCS</em> and the store-and-forward switch counts the bad frame and sends nothing, while the cut-through switch has already forwarded it. A real cut-through switch cannot take the frame back. It passes the received FCS through, so the next receiver finds it bad, or aborts the frame and stamps a known-bad FCS. This bench cannot: the stream carries no FCS, the MAC checked it and raised <code>err</code>, the switch only counts <code>bad</code>, and an egress MAC would add a fresh, valid FCS to the corrupted bytes. It cannot filter runts either, and it cannot cross a speed change: a frame arriving at 10 Mb/s and leaving at 100 Mb/s would run out of bytes mid-frame. Real switches use cut-through at equal speeds
        where latency matters and store-and-forward elsewhere. The arbitration and the buffering are the same, which is why this design builds both from one parameter.</p>`,
      widget: latencyWidget,
      challenge: {
        kind: 'quiz',
        question: 'A cut-through switch has forwarded most of a 1500-byte frame when its FCS turns out to be bad. What can it still do about the frame?',
        options: ['Nothing about the bytes already sent; it can count the error and, by passing the bad FCS through or stamping one, let the next receiver drop the frame', 'Recall the bytes it has sent, since they are still in its buffer', 'Nothing at all: a bad FCS is only advisory', 'Ask the table to forget the source, which stops the frame'],
        answer: 0,
        explain: 'The FCS comes after the data, so the switch learns of the error when the frame is almost over and has already sent most of it. If it forwards the FCS it received, or stamps a bad one on the frame it aborts, the next receiver discards the frame. Store-and-forward would have dropped the frame at the switch and saved the bandwidth of the wasted copy. (The bench here only counts the error: its MAC would compute a fresh FCS.)',
        why: ['', 'Bytes already on the wire cannot be recalled; the buffer holds a copy but the receiver has seen the original.', 'Every Ethernet receiver discards a frame with a bad FCS; the check is mandatory, and that is how the error is eventually caught.', 'The table is consulted with the addresses, which were fine; it never sees the FCS.'],
      },
    },
    {
      title: 'Queues and head-of-line blocking',
      body: `
        <p>When two inputs want the same output, one waits. The question is where, and in what order. With <strong>one FIFO per input</strong> a frame waits at the head of its input queue, and everything behind it waits too, including frames bound for idle outputs. That is <strong>head-of-line blocking</strong>. Karol, Hluchyj and Morgan analysed it in 1987 for a saturated N × N switch with uniform destinations: the throughput is ${HOL_N4} for N = 4 and approaches 2 − √2 = ${HOL_LIMIT.toFixed(4)} as N grows. About a third of the fabric is idle with every input busy.</p>
        <p>The switch of this chapter measures it. The abstract cell model, run here for four ports, gives ${HOL4.toFixed(3)} (the published ${HOL_N4}) and ${HOLBIG.toFixed(3)} for 64 ports. The switch model, which the gates equal cycle for cycle in the tests, measures 0.68 on 64-byte frames at full offered load. Two things move it away from ${HOL_N4}. A host never sends to its own port here, so each input has three possible destinations instead of four, which raises the abstract figure to ${HOL4_NOSELF.toFixed(3)}. And a frame takes 65 cycles to move 64 bytes (one cycle of arbitration), which lowers it by 64/65, to ${(HOL4_NOSELF * 64 / 65).toFixed(3)}. The measured switch and the abstract analysis agree.</p>
        <p>The cure is <strong>virtual output queues</strong>: one queue per output in every input, so a frame for an idle output is never behind a frame for a busy one. In this design it is a parameter (a queue of cell numbers per output instead of one). Against the 140 000 to 570 000 NANDs of an input the difference is small and not even monotonic: ${sgn(VOQ_DELTA[0])} NANDs at 4 cells, ${sgn(VOQ_DELTA[1])} at 8 and ${sgn(VOQ_DELTA[2])} at 16. The gain depends on how many frames an input can look past: with four cells and a saturated source the buffer is mostly full of frames for the same busy output, and the throughput reaches only about 0.80. With 8 cells it is about 0.88 and with 16, about 0.92. The single round of request and grant leaves the rest; schemes such as iSLIP iterate to approach 100 %. The widget measures all four lines on the model.</p>`,
      widget: holWidget,
      more: { pitfall: '<p>The buffer you can afford decides the benefit. Virtual output queues do nothing for an input that holds one frame; they matter when there is a backlog to reorder. Under a hot spot (half the traffic for one host) no queueing discipline can deliver more than that output\'s line rate: look at the per-output figures, not only the total.</p>' },
      challenge: {
        kind: 'quiz',
        question: 'Input 0 holds frames for outputs 2, 1 and 3 in that order. Output 2 is busy; outputs 1 and 3 are idle. With one FIFO per input, what moves?',
        options: ['Nothing from input 0 until output 2 is free: the head is blocked', 'The frame for output 1, because it is idle', 'All three, because the crossbar allows it', 'The frame for output 3, the last arrival'],
        answer: 0,
        explain: 'A single queue offers only its head to the outputs. The crossbar could carry the frames behind it, but they are not visible. With a queue per output the frames for outputs 1 and 3 would go at once.',
        why: ['', 'It sits behind the frame for output 2 and cannot be offered until that frame has gone.', 'The crossbar is not the limit; the queue is.', 'Service within a FIFO is in arrival order; the last arrival is furthest from the head.'],
      },
    },
    {
      title: 'A switch on a bench',
      body: `
        <p>This is the whole switch at gate level: ${n0(BENCH)} NANDs for this build, with 128-byte cells (a bench build that holds any frame up to 128 bytes), eight cells per input and one queue per output; the same switch with the 2048-byte cells that hold any legal frame is ${n0(BENCH11)}, nearly all of it packet buffer, which a real switch builds as SRAM. It runs on the cycle engine at thousands of cycles a second, and the golden model of <code>comm/ethswitch.ts</code>
        runs beside it, comparing every output at every edge: the line under the counters says how many cycles agreed. </p>
        <p>Four hosts send frames at the offered load you set, to destinations chosen by the pattern: <strong>uniform</strong> (any other host), <strong>permutation</strong> (A to B, B to C, C to D, D to A, so no output is contested and the switch should carry nearly the full rate) or <strong>hot spot</strong> (half of everything for host A, whose output saturates; its queues then fill and frames drop). The counters show frames out per port, frames dropped for want of a free cell, and the table's learned, flooded, filtered and evicted counts.</p>
        <p>The sources start by teaching the table, then send. <em>Save capture</em> writes a <code>.pcap</code> for a port: every frame that came in or went out on it, in time order, without FCS, timestamped at the first byte (3.95 ns a cycle, rounded to microseconds). Open it in Wireshark or tcpdump and the frames are what chapter 48 builds: real Ethernet II headers, with the payload bytes the hosts chose.
        Stop the sources, let the queues drain, and the frames-out counters add up to the frames sent, less the frames dropped and the frames filtered, plus two extra copies for every frame that was flooded (it leaves on three ports). The capture of a port leaves out the frames that port dropped for want of a cell.</p>`,
      scene: benchScene,
      challenge: {
        kind: 'quiz',
        question: 'You run the permutation pattern at full load and see every port nearly saturated, then the hot-spot pattern and see host A\'s output saturated and the others under half. Why does the switch behave so differently?',
        options: ['In a permutation no output is contested, so every transfer runs at once; in the hot spot half of all frames want one output, whose line rate caps the total', 'The hot-spot pattern fills the table and forces floods', 'The arbiter favours host A', 'The permutation uses cut-through'],
        answer: 0,
        explain: 'With one source per destination there is nothing to arbitrate, so each port runs at the line rate less one cycle of arbitration per frame. In a hot spot a single output cannot deliver more than one byte a cycle, so the rest of the demand queues, then drops.',
        why: ['', 'The table holds four hosts either way; floods only happen for unknown destinations.', 'The arbiter is round robin and favours nobody; the output wire is what limits A.', 'The bench uses store-and-forward in both runs.'],
      },
    },
    {
      title: 'What full duplex changed',
      body: `
        <p>The first Ethernet was one coaxial cable that every station tapped. A station listened before it sent (carrier sense) and, if two began together, both heard the collision, stopped and waited a random time (CSMA/CD with binary exponential backoff, chapter 48). Throughput on such a wire is shared and degrades with load: in the idealised slotted model of the widget below, four always-busy stations get ${pct(EFF64, 0)} of the link with 64-byte frames and ${pct(EFF1518, 0)} with 1518-byte frames.</p>
        <p>Twisted pair (10BASE-T, 1990) put each station on its own cable to a hub, and a hub is still one collision domain: it repeats everything everywhere. A <strong>switch</strong> replaces the repeater with the machinery of this chapter. Each port is then a point-to-point link with a pair of wires for each direction, so there is nothing to collide with and a port can send and receive at once. The standard added full-duplex operation in 1997 (IEEE 802.3x), and
        10 Gb/s Ethernet (2002) dropped half duplex altogether. CSMA/CD survives as a negotiated fallback to older equipment.</p>
        <p>The cost moved. The wire no longer limits throughput; the switch's <em>fabric</em>, <em>buffers</em> and <em>table</em> do, so the head-of-line figure, the cell count and the table size are now the numbers to design. A real switch differs from this one in scale and in broad shape, not in kind: ports at 1 to 100 Gb/s, buffers of megabytes in SRAM or DRAM, tables of tens of thousands of addresses or more, fabric and lookups in an ASIC, and queueing disciplines well beyond a round-robin arbiter (priorities, per-class queues, shaping). Specific figures vary by product and are not claimed here.</p>
        <p>What a switch does <em>not</em> do is cross networks. It floods what it cannot place, and a flood reaches every host on the network: a broadcast must reach everyone, so the size of one switched network is bounded by how much broadcast its hosts can stand and by how many addresses a table can hold. Hosts on other networks are reached by a <em>router</em>, which looks inside the frame at an address that has structure; chapter 51 builds one. Before that, chapter 50 puts computers on the other end of these ports.</p>`,
      widget: duplexWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does a full-duplex switched Ethernet port need no collision detection?',
        options: ['Each port is a point-to-point link with a separate wire for each direction, so no two transmitters ever share a wire', 'The switch schedules all transmissions so collisions never occur', 'Frames are short enough that collisions cannot happen', 'The FCS corrects collided frames'],
        answer: 0,
        explain: 'A collision needs two transmitters on one wire at once. A switch port has one transmitter on each wire, the host\'s and the switch\'s, each on its own pair. Congestion is handled by buffering in the switch, not by collisions on the wire.',
        why: ['', 'The switch does not schedule the hosts; it buffers frames when they coincide.', 'Frame length has nothing to do with it; the half-duplex rules needed a minimum length exactly because collisions are possible on a shared wire.', 'The FCS detects damage; it does not correct anything.'],
      },
    },
  ],
};
