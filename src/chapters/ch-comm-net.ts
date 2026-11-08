import '../lib';
import NET from '../comm/stack/netcosts.json';
import { CLOCK_NS } from '../comm/mac';
import { A_ECHO_RX, A_ECHO_TX, B_BUSY_PERCENT, B_ECHO, BYTES_PERCENT, dmaTotal, MIN_FRAME_TIME, PING_DMA, PING_FRAME, PING_FRAME_TIME, PING_SERIAL, roundTrip, win, wireClocks } from '../comm/stack/netfacts';
import { NIC_COSTS, nicPollSource } from '../riscv/nicprograms';
import { checksumWidget, costWidget, frameWidget, lanApi, lanScene, nicApi, nicScene, pathWidget, ringWidget } from '../widgets/net';
import type { Chapter } from './types';
import { numOf } from './order';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(Math.round(x));
const us = (clocks: number) => (clocks * CLOCK_NS / 1000).toFixed(1);
const N = NET.nands;
const N_BUS = numOf('bus'), N_PY = numOf('python'), N_PCIE = numOf('pcie'), N_ROUTER = numOf('router');
const busLink = `<a href="#/c/bus/0">chapter ${N_BUS}</a>`, pyLink = `<a href="#/c/python/0">chapter ${N_PY}</a>`;
/** The switch bench's cell holds 128 bytes; an echo or a datagram has 14 + 20 + 8 bytes of headers. */
const CELL_BYTES = 128, UDP_HEADERS = 14 + 20 + 8;
const ARP_FRAME = wireClocks(42);
const A_ARP_TX = win('a', 0), B_ARP = win('b', 0);
const RT = roundTrip();
/** Lines of the polled driver: instructions, labels and directives, without blank or comment-only lines. */
const DRIVER_LINES = nicPollSource().split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;

export const chNetwork: Chapter = {
  id: 'network', num: numOf('network'), title: 'Computers on a network', level: 'Communication',
  blurb: 'A NIC with descriptor rings and DMA, a driver in assembly, and ARP, IPv4, ICMP and UDP written in Python and compiled live: two computers and a switch, and a ping across them on the gates.',
  goals: [
    'follow a frame from a buffer in RAM through descriptors, DMA and the MAC to the wire, and back into a buffer on the other side',
    'say who owns a descriptor at each moment, what a bad frame leaves behind, and why the NIC writes the data before the length',
    'compute the Internet checksum by hand, and build an ARP packet, an IPv4 header, an ICMP echo and a UDP datagram byte by byte',
    'write network byte order in a language with only bytes and words, and read where a layer spends its instructions',
    'measure a ping on the gates: clocks on the cable against clocks in the software, per layer',
  ],
  builds: ['pcie', 'ethernet', 'switch', 'bus', 'python'],
  recap: {
    keep: [
      `A NIC and its driver share two rings in RAM. A descriptor is two words: the buffer's address and a word with OWN in bit 31 and the length in the low 11 bits. Whoever sets OWN gives the descriptor away and leaves it alone until it returns. The NIC writes a frame's bytes first and word 1 last, so the software never reads a half-written frame; a frame whose FCS fails is simply forgotten, because its descriptor was never handed back.`,
      `The NIC is ${n0(N.nic)} NANDs, of which the two MACs of chapter ${numOf('ethernet')} are ${n0(N.macTx + N.macRx)}. Its bus master makes one transaction at a time and serves the receive engine first, because a wire cannot be stopped. A transmitted frame costs 3 + ⌈length/4⌉ reads (two descriptor words, the words of the frame, and a look at the next descriptor) and 1 write; a received one costs 2 reads and ⌈length/4⌉ + 1 writes.`,
      `The language of chapter ${N_PY} gained four built-ins, load8, store8, load32 and store32, and nothing else. Byte order is the program's job: get16 and put16 are the only places where a field is assembled, and they make the stack independent of the CPU's little-endian words.`,
      `The Internet checksum is the complement of the 16-bit ones' complement sum. It needs no multiplier and no table, any order of the words gives the same sum, and a block that includes its own checksum sums to 0xFFFF. IPv4 covers its header with it, ICMP its whole message, UDP the datagram and a pseudo-header that the packet does not carry.`,
      `ARP asks the cable who has an IP address and learns the sender of any ARP packet addressed to it; nothing above ARP learns from a packet's source. IPv4 here has no options, no fragmentation and no routing beyond one gateway; UDP accepts a zero checksum and sends a computed zero as 0xFFFF; ICMP echo copies its data back. Each is the plain form of the RFC, and the omissions are named in the code.`,
      `On the gates a ping costs ${n0(NET.rtt)} clocks (${us(NET.rtt)} µs at ${CLOCK_NS} ns), of which the cable takes ${n0(RT.cable)}: four serializations of ${n0(PING_SERIAL)}, since each of the two ${PING_FRAME}-byte frames crosses two links. The stack's work on one received echo request is ${n0(B_ECHO.total.instr)} instructions and ${n0(B_ECHO.total.clocks)} clocks, and ${BYTES_PERCENT} % of it is the byte helpers. A switch does not cross networks: that needs a router.`,
    ],
    check: [
      {
        question: 'The NIC has written 40 bytes of a received frame into its buffer when the frame turns out to have a wrong FCS. What does the driver see?',
        options: ['Nothing: the descriptor is still the NIC\'s, and the next frame overwrites the buffer', 'The descriptor with OWN clear and a length of 40, which it must check against the status register', 'The descriptor with OWN clear and an error flag in the length field', 'An interrupt, so that it can clear the buffer'],
        answer: 0,
        explain: 'The NIC writes word 1 (the length, OWN clear) only at the commit, after the verdict on the FCS. Until then the descriptor says the NIC holds it, and the driver, which looks only at OWN, cannot tell that the buffer has been written at all.',
        why: ['', 'Word 1 is written last. With a bad FCS it is never written, so nothing carries a length of 40.', 'The only flags a receive descriptor carries are OWN and the length; a bad frame is not handed back at all.', 'The interrupt follows a commit. A frame that is forgotten raises STATUS.BAD, which the driver may read, but no interrupt.'],
      },
      {
        question: 'A block of bytes includes its own 16-bit checksum field. The receiver adds all the words, folds the carries back in and gets 0xFFFF. What does that say?',
        options: ['The block is consistent with its checksum', 'The block is certainly intact', 'The checksum field was zero when the sender computed it', 'The block has an even number of words'],
        answer: 0,
        explain: 'The checksum is the complement of the sum of the rest, so the whole block sums to all ones. A single flipped bit changes the sum and is caught; two flips that cancel, or words that swap, are not.',
        why: ['', 'The sum is a 16-bit fingerprint. Some changes leave it unchanged, so passing is evidence and not proof.', 'The sender does compute with the field zeroed, but the receiver\'s 0xFFFF comes from the field being complete, not from it being zero.', 'An odd last byte is padded with a zero, so the length does not matter.'],
      },
      {
        question: `A ${PING_FRAME}-byte ping frame holds this link for ${n0(PING_FRAME_TIME)} clocks, gap included, and the CPU needs ${n0(B_ECHO.total.clocks)} clocks to receive and answer it. What follows?`,
        options: [`The CPU keeps up with a stream of them, with ${100 - B_BUSY_PERCENT} % of each frame time to spare`, 'The CPU falls further behind with every frame', 'The CPU is idle for most of each frame time, waiting for the cable', 'The two cannot be compared: one is time on a cable and the other time in a CPU'],
        answer: 0,
        explain: `${n0(B_ECHO.total.clocks)} against ${n0(PING_FRAME_TIME)} is ${B_BUSY_PERCENT} %. A frame arrives every ${n0(PING_FRAME_TIME)} clocks at the most, and the software finishes with the rest of that period left over; at ten times the link speed the period would be ${n0(PING_FRAME_TIME / 10)} clocks and the same work would no longer fit.`,
        why: ['', `At full line rate a frame arrives every ${n0(PING_FRAME_TIME)} clocks and the stack needs ${n0(B_ECHO.total.clocks)}: it finishes first, every time.`, `The stack is busy for ${B_BUSY_PERCENT} % of each frame time, and ${100 - B_BUSY_PERCENT} % is left over.`, 'Both are counted in the same clock: the CPU, the MAC and the bus all run on it.'],
      },
    ],
  },
  steps: [
    {
      title: 'How software reaches the wire',
      body: `
        <p>Chapter ${numOf('ethernet')} built a MAC: give it a frame as a stream of bytes and it puts preamble, SFD and FCS around it and sends it bit by bit; hand it bits and it gives back a verified frame. Chapter ${numOf('switch')} joined four of them to a switch. Nothing so far is a computer. A program that wants to send 32 bytes to another machine has to put them somewhere the MAC can reach, say which machine, and know when the frame is gone.</p>
        <p>The piece that does this is a <strong>network interface card</strong>. It sits on the bus of ${busLink} twice: as a <em>slave</em> with a handful of registers the CPU reads and writes, and as a <em>master</em> that moves frames between RAM and the MAC without the CPU. The software describes work in <strong>descriptors</strong> in RAM and rings a doorbell; the NIC does the moving and reports back by clearing a bit. This chapter builds that NIC in gates, writes the driver for it in assembly, and then puts the protocols of the Internet's lowest layers, ARP, IPv4, ICMP and UDP, on top, in the Python of ${pyLink}, compiled to the CPU that runs beside it.</p>
        <p>Each layer adds a header. A ping with 32 bytes of data becomes 8 bytes of ICMP, 20 of IPv4, 14 of Ethernet, a pad if the frame is short, a 4-byte FCS and 8 of preamble: ${PING_SERIAL / 32} bytes on the cable, and at one bit every 4 clocks each byte costs 32. Move the slider to see where the bytes go.</p>
        <p>A PCIe network card (chapter ${N_PCIE}) is this design with TLPs on a lane in place of the bus: the same rings, doorbell and DMA, a different wire.</p>`,
      widget: pathWidget,
      more: { numbers: `<p>The cable is the scarce resource. A 60-byte frame holds it for ${n0(MIN_FRAME_TIME)} clocks (${us(MIN_FRAME_TIME)} µs), of which 12 bytes' worth is the mandatory gap. At the single-cycle CPU's ${CLOCK_NS} ns clock the link carries 63 Mb/s, and a stream of minimum frames moves ${(60 * 8 / (MIN_FRAME_TIME * CLOCK_NS / 1000)).toFixed(0)} Mb/s of frame bytes.</p>` },
    },
    {
      title: 'Registers and rings',
      body: `
        <p>Why not hand the NIC a pointer and a length and wait? Because the CPU would wait with it, and because frames arrive when the wire says, not when the program asks. The standard answer is a <strong>ring of descriptors</strong>: a small array in RAM, each entry naming a buffer and saying who may use it. The NIC walks the ring in order; so does the software; the two chase each other round the circle.</p>
        <p>A descriptor here is two words. <strong>Word 0</strong> is the buffer's address. <strong>Word 1</strong> has <code>OWN</code> in bit 31 (1: the NIC holds it) and the frame length in bits 10:0. The receive ring starts with every descriptor owned by the NIC; the software gives one back after reading the buffer. The transmit ring starts owned by the software; it fills a buffer, writes word 1 with OWN and the length <em>last</em>, and rings the doorbell. The NIC clears OWN when the frame is out (setting bit 30 if the MAC gave up). No locks are needed because each descriptor has exactly one owner at a time and the owner is told by one bit in one word.</p>
        <p>Eight descriptors a ring, a buffer of 1536 bytes each (the longest frame is 1514), 64-byte aligned rings at 0x1800 and 0x1840, buffers from 0x1900 and 0x4900. The Python subset's own data, output and stack stay below 0x1800 (its stack starts there and grows down), so nothing the compiler places can collide with a buffer. The registers sit at 0x7000_0000: the system CPU takes every address with bit 31 set for its console and timer, which leaves few nibbles of the bus's decoder free.</p>
        <table class="net-fields"><tr><th>+</th><th>Register</th><th>Meaning</th></tr>
        <tr><td class="hex">0x00</td><td>CTRL</td><td>bit 0 enable (clear: every engine and both MACs held in reset), bit 1 promiscuous</td></tr>
        <tr><td class="hex">0x04</td><td>STATUS</td><td>bit 0 frame received, 1 frame sent, 2 miss (no descriptor), 3 bad frame; write 1 to clear</td></tr>
        <tr><td class="hex">0x08</td><td>IE</td><td>interrupt enables for bits 0 and 1 of STATUS</td></tr>
        <tr><td class="hex">0x0C 0x10</td><td>RXBASE TXBASE</td><td>ring addresses (low 6 bits ignored)</td></tr>
        <tr><td class="hex">0x14 0x18</td><td>MACL MACH</td><td>the six address bytes, the first in the low byte of MACL</td></tr>
        <tr><td class="hex">0x1C</td><td>KICK</td><td>any write: look at the transmit ring</td></tr></table>`,
      widget: ringWidget,
      challenge: {
        kind: 'quiz',
        question: 'The driver fills a transmit buffer and a descriptor, then rings the doorbell. In what order must it write the descriptor?',
        options: ['Word 0 (the address), then word 1 with OWN and the length last', 'Word 1 first, then word 0, so that the NIC sees the length early', 'Either: the NIC only looks when the doorbell rings', 'Both at once, as one 64-bit store'],
        answer: 0,
        explain: 'The doorbell is only one way the NIC finds work; a descriptor already marked OWN can be picked up on the NIC\'s next scan. If OWN were set before the buffer address and length were in place, the NIC could take a half-written descriptor. The bit that gives the descriptor away is written last.',
        why: ['', 'A length of an unwritten descriptor with OWN set would be taken at once; whatever was in word 0 would be the buffer.', 'After the first frame the NIC rescans for the next descriptor as soon as it finishes, without waiting for a bell.', 'The bus moves one word at a time here; two stores are two transactions, and the second is the one that matters.'],
      },
    },
    {
      title: 'The NIC in gates',
      get body() {
        return `
        <p>The scene is a computer with a NIC whose transmitter feeds its own receiver, running the driver of the next step. Open the NIC (one level down) and it has four boxes. <strong>regs</strong> holds the registers and the slave's handshake. <strong>dma</strong> is the master: one transaction at a time, a read or a write of a word, receive requests before transmit requests, because a wire cannot be stopped and a transmitter can wait. <strong>rx</strong> and <strong>tx</strong> are the two engines, each wrapped round the MAC of chapter ${numOf('ethernet')}. The whole is ${n0(N.nic)} NANDs, ${n0(N.macTx + N.macRx)} of them the MACs; the bus's third master port and the interconnect's third input add ${n0(N.computerNic - N.computer - N.nic)} more.</p>
        <p><strong>Receive</strong> starts at the first byte: the engine reads word 1 of the descriptor at its head (is it the NIC's?) and word 0 (where?). Bytes meanwhile gather in a 32-bit register; when four are in, or the frame ends, a write goes to the bus with the strobes for the bytes that count. The MAC reports the FCS verdict only with the <em>last</em> byte, so the frame is already in RAM when it is judged. A good frame ends with word 1 written, OWN clear, the length, and the head advanced: the <em>commit</em>. A bad frame ends with nothing at all: the descriptor still says "NIC", the head has not moved, the buffer holds garbage nobody was told about, and the next frame overwrites it. That is chapter ${numOf('ethernet')}'s "write, then commit or rewind" at the level of a descriptor, and it needs no undo.</p>
        <p>Because the verdict arrives with the last byte, the last word may have to wait for the one before it. The packing register is two words deep (the word being written and the one being filled), a timing the MAC sets: the last byte follows the one before it by a few clocks, the bus takes longer than that, so a final write can wait for the bus to be free. A byte offered while no register is free is lost and the frame is dropped, counted as a miss.</p>
        <p><strong>Transmit</strong> reads the descriptor, then the buffer a word at a time as the MAC asks for bytes: the MAC wants one every 32 clocks and a word read takes under ten, so the next word is always there. If it were not, the MAC would see no byte when it needed one and send the frame with a deliberately wrong FCS, so that no receiver trusts it: an underrun is made visible, not hidden.</p>
        <p>Every output of the gates is compared with <code>comm/nic.ts</code> on every clock, on a bench with a RAM that makes the master wait, and again with the real computer around it, instruction by instruction against the instruction-set simulator. Press Run: the frame leaves, comes back in through its own receiver and the driver sees it.</p>`;
      },
      scene: () => nicScene(false),
      tour: {
        label: 'Follow one frame',
        beats: [
          { reset: true, at: [], show: ['c'], title: 'Power on', say: 'The computer starts at the first instruction of the driver. Its RAM is empty and the NIC is held in reset: CTRL.EN is 0, so both MACs and every engine are.' },
          { at: ['c'], show: ['cpu', 'nic', 'ram'], cycles: 250, title: 'Rings and registers', say: 'About 250 clocks later the driver has written eight descriptors in each ring, the ring bases, the address and the enable bit. The NIC is a bus slave for those writes: <b>nic</b> answers on the same bus as the RAM, a third master beside the CPU and the DMA engine.' },
          { at: ['c', 'nic'], show: ['regs', 'dma', 'tx'], cycles: 400, title: 'Doorbell and transmit', expect: { txen: 1 }, say: 'The driver has built a 64-byte frame and rung the doorbell. <b>tx</b> read the descriptor, then the buffer, a word at a time, and its MAC started the preamble. <code>txen</code> is up: the cable is busy for the next ' + n0(NIC_COSTS.wireClocks) + ' clocks.' },
          { at: ['c', 'nic'], show: ['rx', 'dma', 'regs'], cycles: 2500, title: 'The frame comes back', expect: { txen: 0 }, say: 'The transmitter is done. The frame went into this NIC\'s own receiver; <b>rx</b> fetched a descriptor at the first byte, wrote the bytes as they arrived, and committed word 1 after the FCS: OWN cleared, length 64. The driver, spinning on that bit, has seen it.' },
        ],
      },
      challenge: {
        kind: 'reach',
        goal: 'Run the driver until it has the frame back in its receive buffer.',
        check: (stage) => !!nicApi(stage)?.result().done,
        answer: `Press Run. The driver programs the rings and the address, builds the frame, rings the doorbell, and the transmitter starts ${NIC_COSTS.doorbellToWire} clocks later (the MAC first waits out its interframe gap after the enable); the 76 bytes take ${n0(NIC_COSTS.wireClocks)} clocks; the CPU sees the descriptor ${n0(NIC_COSTS.pollSeen)} clocks after the doorbell.`,
        solve: (stage) => nicApi(stage)?.run(),
        hints: ['Run clocks the computer; the panel reads the driver\'s own timestamps when it has finished.', 'About three thousand clocks.'],
      },
    },
    {
      title: 'A driver in assembly',
      get body() {
        return `
        <p>The driver is ${DRIVER_LINES} lines of RV32I in the polled version (riscv/nicprograms.ts), most of them the two ring loops and the frame. It writes the eight descriptors of each ring, the ring bases and the address, sets CTRL.EN; builds a 64-byte frame addressed to itself; writes word 1 of transmit descriptor 0 with OWN and 64, rings the doorbell, and waits for the receive descriptor to lose its OWN bit. Two versions wait differently, and the gates tell how they differ.</p>
        <p><strong>Polled</strong>: <code>addi s6, s6, 1; lw t0, 4(s2); bltz t0, poll</code>, ${NIC_COSTS.pollPass} clocks a pass, ${NIC_COSTS.polls} passes. The CPU sees the frame ${NIC_COSTS.pollSeen} clocks after the doorbell (the cable holds it for ${n0(NIC_COSTS.wireClocks)}), at most ${NIC_COSTS.pollPass} clocks after the commit. It does nothing else meanwhile, and each pass is a bus transaction that the NIC's DMA has to share the bus with. <strong>By interrupt</strong>: the driver sets IE and counts in a loop; the NIC raises <code>irq</code> at the commit, and the handler's first instruction runs ${NIC_COSTS.irqEntry} clock later. The handler is ${NIC_COSTS.handler} clocks (read the length, clear STATUS, hand the buffer back); the main loop had ${(NIC_COSTS.freePermille / 10).toFixed(1)} % of the clocks. The frame is seen at ${NIC_COSTS.irqSeen}: no sooner than polling in any way that matters, and the CPU is free.</p>
        <p>So the interrupt wins on a quiet link and polling wins on a busy one: an interrupt costs its entry and its handler on every frame (a dozen clocks here), and when frames come so fast that this approaches the frame time, the CPU does nothing but enter and leave. Real drivers switch between the two (Linux's NAPI polls while the queue is busy and re-enables the interrupt when it empties). This chapter's Python stack polls, because its main loop has nothing else to do and a polling loop needs no state to save.</p>
        <p>The doorbell store itself takes ${NIC_COSTS.doorbell} clocks; the transmitter starts ${NIC_COSTS.doorbellToWire} clocks after it. That is not the NIC being slow: a MAC that has just come out of reset waits 96 bit times (384 clocks) of silence before its first frame, and most of that wait had passed while the driver set up.</p>`;
      },
      scene: () => nicScene(true),
      challenge: {
        kind: 'quiz',
        question: `Frames arrive every ${n0(MIN_FRAME_TIME)} clocks. With the interrupt, the handler runs one clock after the line rises and takes ${NIC_COSTS.handler}; a polling pass takes ${NIC_COSTS.pollPass} and never ends. Which statement is right?`,
        options: ['Both see the frame within a few clocks; only the interrupt leaves the CPU free', `The interrupt cannot keep up: a handler of ${NIC_COSTS.handler} clocks is too long for a frame every ${n0(MIN_FRAME_TIME)}`, 'Polling leaves the CPU free, because a pass is only 4 clocks', 'They are equal: the CPU does the same work in the same time either way'],
        answer: 0,
        explain: `An interrupt per frame costs about a dozen clocks of ${n0(MIN_FRAME_TIME)}, the rest is the main loop's. Polling is the CPU's whole job, however short a pass.`,
        why: ['', `A dozen clocks against a ${n0(MIN_FRAME_TIME)}-clock frame time is under half a percent; an interrupt only gets expensive when frames come every hundred clocks or so.`, 'A pass is short, but the loop never ends: the CPU is never free to do anything else.', 'The delay to notice a frame is about the same, a few clocks; the difference is what the CPU does the rest of the time.'],
      },
    },
    {
      title: 'Bytes in the subset',
      body: `
        <p>The stack is written in the Python subset of ${pyLink}: integers, lists of constants, functions, loops, no strings and no imports. A frame is bytes in RAM, and the subset had no way to reach RAM except through its own variables. It gains four built-ins: <code>load8(a)</code> (an unsigned byte), <code>load32(a)</code>, <code>store8(a, v)</code> and <code>store32(a, v)</code>, with an address that is just an integer. In the compiler they are <code>lbu</code>, <code>lw</code>, <code>sb</code> and <code>sw</code>, with a constant added to the address folded into the instruction's immediate. In the reference interpreter they act on a sparse byte map, little-endian, so a program run both ways leaves the same memory; a test compiles hundreds of random programs full of loads and stores and compares the memory.</p>
        <p><strong>Byte order.</strong> The CPU is little-endian: <code>load32</code> of the bytes <code>45 00 00 73</code> is 0x73000045. The Internet is big-endian: the first byte is the most significant. The stack never lets the two meet: <code>get16(a)</code> is <code>(load8(a) &lt;&lt; 8) | load8(a + 1)</code>, <code>get32</code> two of those, and the puts are their inverses. Every multi-byte field in every layer goes through those four functions, which is also why ${BYTES_PERCENT} % of the clocks of an echo go to them (step 10).</p>
        <p><strong>The checksum.</strong> RFC 1071: add the 16-bit words as unsigned numbers, fold the carries above bit 15 back into the sum, invert. <code>ones_sum(a, n, start)</code> returns the folded sum; a checksum field holds <code>~sum &amp; 0xFFFF</code>. The loop adds two bytes a pass and has no multiplier in it, which matters because this CPU has none. The widget runs the same sum three ways: in TypeScript, step by step, in the stack's own Python on the reference interpreter, and (in the tests) compiled on the golden model; each agrees with the examples of RFC 1071 and with a published IPv4 header whose checksum is 0xB861.</p>
        <p>One trap: <code>&gt;&gt;</code> in the subset is an arithmetic shift, as the hardware's <code>srai</code> is. A value with bit 31 set stays negative as it shifts, so every shift of an address or a 32-bit field is followed by a mask (<code>(v &gt;&gt; 8) &amp; 255</code>).</p>`,
      widget: checksumWidget,
    },
    {
      title: 'ARP: IP address to MAC address',
      body: `
        <p>The MAC of chapter ${numOf('ethernet')} delivers to 48-bit addresses; programs name machines by 32-bit IP addresses, written as four decimal bytes (10.0.0.2); how an address says which network a machine is on is chapter ${N_ROUTER}'s subject. Something has to map one to the other, and on a shared cable the cheapest way is to ask. <strong>ARP</strong> (RFC 826) broadcasts a 28-byte packet: "who has 10.0.0.2? tell 10.0.0.1". The machine that owns the address answers, directly to the asker, with its MAC address. Both learn: the asker puts the answer in a table, and the answerer notes the asker, since it is about to be sent something.</p>
        <p>The packet is fixed in shape: hardware type 1 (Ethernet), protocol type 0x0800 (IPv4), address lengths 6 and 4, an operation (1 request, 2 reply), then the sender's MAC and IP and the target's MAC and IP. In a request the target MAC is zero. The Ethernet frame is the broadcast address and EtherType 0x0806. The frame is 42 bytes; the MAC pads it to 60. The widget builds it from the same fields the code uses, with the bytes of each field.</p>
        <p>The table here is four entries, replaced round robin. There is no timeout, no retry timer and no gratuitous ARP; a stack that wants a timeout stores <code>now()</code> beside each entry, and a mapping that changes (a replaced NIC) would be learned again from the next ARP packet addressed to us. When <code>ip_send</code> finds no entry it sends the request, drops the frame it was about to send, and returns 0: the application tries again after a while. That is the real behaviour of a stack with no queue for packets awaiting resolution, and it is why the first ping of a session is slow.</p>
        <p>On the gates, sending the request is ${A_ARP_TX.total.instr} instructions and ${A_ARP_TX.total.clocks} clocks; answering a request, with the learning, ${B_ARP.total.instr} instructions and ${B_ARP.total.clocks} clocks. The frame is on the cable for ${n0(ARP_FRAME)} clocks each way.</p>`,
      widget: () => frameWidget(['arp-req', 'arp-rep']),
    },
    {
      title: 'IPv4 and UDP',
      body: `\n        <p>An <strong>IPv4 datagram</strong> (RFC 791) carries an upper-layer message from one address to another across any number of links. The header is 20 bytes: version 4 and a header length of 5 words in the first byte; a type of service; the <em>total length</em>; an identification; flags and a fragment offset; a <strong>time to live</strong> (TTL, a hop count a router decrements; at zero the datagram is dropped); the protocol of the payload (1 ICMP, <span data-ahead="tcp">6 TCP, the reliable stream of chapter ${numOf('tcp')}</span>, 17 UDP); the header checksum; the two addresses. The checksum covers the header only; each upper layer protects its own data.</p>\n        <p><strong>What IP does not promise.</strong> Delivery, order, or once-only: a datagram may be dropped (by a full queue, a failed checksum, an expired TTL), reordered, or duplicated. The address in it is 32 bits that say <em>where</em>, and nothing says the sender is who it says. This stack, said plainly: no options (a longer header is read past), no fragmentation (a fragment is dropped and nothing is sent in pieces, so the "don't fragment" DF flag is set), no reassembly, no routing but one <em>gateway</em> address (the router that takes anything not on our own network) for destinations off the local network. The receiver uses the <em>total length</em> field to find the end of the datagram, not the frame's length: Ethernet pads a short frame to 60 bytes, and the padding must not be summed into the ICMP or UDP checksum.</p>\n        <p><strong>UDP</strong> (RFC 768) is the thinnest transport: source port, destination port, length, checksum, then the data. The ports pick the application at each end. The checksum covers the datagram and a <em>pseudo-header</em> (source address, destination address, a zero byte, the protocol, the UDP length) that is not sent: a datagram that reaches the wrong address, or comes from one it did not claim, fails. A checksum field of 0 means the sender did not compute one and is accepted; a computed 0 is sent as 0xFFFF, which is the same number in ones' complement. Nothing else: no connection, no retransmission, no flow control. Chapter ${numOf('tcp')} adds all of those in TCP.</p>`,
      widget: () => frameWidget(['udp', 'echo-req']),
    },
    {
      title: 'ICMP: echo',
      body: `
        <p>IP has no way to say that something went wrong, and no way to ask "are you there?". <strong>ICMP</strong> (RFC 792) carries both, inside IP datagrams (protocol 1). Its messages begin with a type, a code and a checksum over the whole message. Type 8 is an <strong>echo request</strong> and type 0 the <strong>echo reply</strong>: both carry an identifier, a sequence number and some data, and the reply is the request with the type changed to 0, the checksum recomputed, and the addresses swapped. That is <code>ping</code>.</p>
        <p>The code is short: check the length and the checksum; for a request, take a transmit buffer, copy the message byte for byte, change the type, zero the checksum, sum the message, store the complement, and hand it to <code>ip_send</code>, which resolves the address in the ARP table, fills the IP and Ethernet headers, and rings the doorbell. The table is filled by ARP alone: <code>ip_input</code> and <code>icmp_input</code> never learn from a packet's source address. Here the requester is in it because its ARP request, addressed to us, was learned first; a request from a host not in the table would have its reply dropped and an ARP request sent in its place, and the requester's next try would find the answer. For a reply, note its identifier, sequence number and the time. The sender reads <code>now()</code>, which is the CPU's cycle counter, before and after: that difference is the round trip the console prints.</p>
        <p>The sender's 32 data bytes are 16, 17, 18 … like the Linux ping's; the receiver does not look at them. A real ping adds a timestamp and the sequence number to the data; here the time is kept in a variable.</p>
        <p>The stack's cost for one echo request received and answered, on the gates: ${B_ECHO.total.instr} instructions in ${B_ECHO.total.clocks} clocks (${B_ECHO.total.loads} loads, ${B_ECHO.total.stores} stores), and sending one ${A_ECHO_TX.total.instr} instructions in ${A_ECHO_TX.total.clocks}. Handling the reply is ${A_ECHO_RX.total.instr} instructions: it checks the checksum and does not build a frame.</p>`,
      widget: () => frameWidget(['echo-req', 'echo-rep']),
    },
    {
      title: 'Ping across the wire',
      get body() {
        return `
        <p>Two computers, each the system CPU of ${busLink} with a RAM, a DMA engine and now a NIC, joined through the four-port switch of chapter ${numOf('switch')} with a MAC pair on each switch port (the switch's ports are byte streams; the MACs turn them to bits). Computer A runs the ping program, B only <code>net_poll()</code>. Both run <em>the same compiled stack</em>: ${n0(NET.words.a)} instructions in A, ${n0(NET.words.b)} in B, from Python text you can read in <code>src/comm/stack/</code>. All of it is gates: ${n0(N.lan)} NANDs, ${n0(N.switch)} of them the switch (cells of 128 bytes, two a port; a frame longer than that would not fit its cell, so the applications keep every frame within 128 bytes: ${CELL_BYTES - UDP_HEADERS} bytes of data in an echo or a datagram).</p>
        <p>Run it. A looks for 10.0.0.2 in its ARP table, finds nothing, and sends the request: broadcast, flooded by the switch to every port, received by B. B learns A, answers; A learns B. A sends the echo request; B answers; A's console prints the round trip. Click a frame in the list to see its bytes, coloured by layer. <strong>Save capture</strong> writes what the switch saw as a <code>.pcap</code> file that Wireshark or <code>tcpdump -r</code> reads: the same bytes, a timestamp from the clock counter at ${CLOCK_NS} ns a clock.</p>
        <p>The numbers: the first reply is at clock ${n0(NET.clocksToFirstReply)} (${us(NET.clocksToFirstReply)} µs; the clock at which A's console has printed <code>time=</code>, before the number), most of it the ARP exchange and the software's patience around it; the ping itself, request to reply, is <strong>${n0(NET.rtt)} clocks</strong> (${us(NET.rtt)} µs). The cable accounts for ${n0(RT.cable)} of them: four serializations of ${n0(PING_SERIAL)} clocks, since each ${PING_FRAME}-byte frame is sent twice (computer to switch, switch to computer) and the switch is store-and-forward; the software and its polling are the other ${n0(RT.software)} (the next step takes them apart). The cycle engine runs this at a few thousand clocks a second, so the first reply arrives after ten seconds or more and all three pings after about twice that, depending on the machine, with the page staying responsive; the clock counter in the panel tells you how far it has got.</p>`;
      },
      scene: lanScene,
      challenge: {
        kind: 'reach',
        goal: 'Run until computer A\'s console prints the first reply.',
        check: (stage) => (lanApi(stage)?.consoleOf('A') ?? '').includes('time='),
        answer: `Press Run and wait for about ${n0(NET.clocksToFirstReply)} clocks. A prints the ARP result, then "64 bytes from 10.0.0.2: seq=1 time=${n0(NET.rtt)} cycles".`,
        solve: (stage) => lanApi(stage)?.run(),
        hints: ['The clock counter in the panel shows the progress; the ARP frames come first, then the echo request and reply.', 'Open the capture list to see each frame as the switch received it.'],
      },
    },
    {
      title: 'The cost of a packet',
      get body() {
        return `
        <p>Per frame, on the gates (A and B ran this once each): the table lists each piece of work from the call that starts it to the return to the polling loop, with instructions retired, clocks, and the loads and stores that crossed the bus, and the clocks of each layer. Four things stand out.</p>
        <p><strong>The software is small next to the cable.</strong> Receiving and answering an echo request is ${n0(B_ECHO.total.clocks)} clocks of work against the ${n0(PING_FRAME_TIME)} that a ${PING_FRAME}-byte frame holds the cable (the gap included): ${B_BUSY_PERCENT} % of a frame time, so at this link speed the CPU keeps up with a stream of such frames, with ${100 - B_BUSY_PERCENT} % to spare. Make the link ten times faster and it would not; that is why real NICs offload checksums and segmentation.</p>
        <p><strong>The byte helpers dominate.</strong> ${BYTES_PERCENT} % of the echo request's clocks, nearly half, are in <code>get16</code>, <code>put16</code>, <code>get32</code>, <code>put32</code> and <code>ones_sum</code>: every byte is a separate bus transaction (a load or a store of one byte, two clocks or more), and the checksum touches each one. A word-oriented checksum, or a NIC that sums as it moves the bytes, would remove most of it. The IP and ICMP logic proper is a few hundred clocks.</p>
        <p><strong>The bus is shared.</strong> The NIC's DMA makes 3 + ⌈len/4⌉ reads and 1 write to send a frame and 2 reads and ⌈len/4⌉ + 1 writes to receive one: ${dmaTotal(PING_DMA.send)} transactions to send a ${PING_FRAME}-byte frame, ${dmaTotal(PING_DMA.receive)} to receive it, against ${n0(B_ECHO.total.loads + B_ECHO.total.stores)} loads and stores by the CPU for the work of one echo. The CPU's polling loop is a load a pass.</p>
        <p><strong>Latency is mostly the cable.</strong> The ${n0(NET.rtt)}-clock round trip is ${n0(RT.cable)} clocks of frames on the cable (four serializations of ${n0(PING_SERIAL)}, without the gap, which only separates one frame from the next) and ${n0(RT.software)} of software, measured on the gates' own transmit and carrier pins: ${n0(RT.aSend)} for A from the start of <code>icmp_echo</code> to the first bit of the request on its link, ${n0(RT.bReply)} for B from the last bit of the request to the first bit of its reply (${RT.bNotice} clocks for the polling loop to notice the commit, then ${n0(RT.bWork)} clocks of work up to the doorbell), and ${n0(RT.aReceive)} for A from the last bit of the reply to the timestamp. The switch's store-and-forward turnaround adds ${RT.turnaround} clocks, half in each direction. The three windows of the table add up to ${n0(RT.tails)}, more than the software's share, because each window's tail runs while a frame is already on the cable or after the timestamp is taken; nothing in the round trip is left unexplained.</p>
        <p><strong>Where this stops.</strong> Two computers on one switch can ping each other because the switch knows each MAC address and floods what it does not. Everything here lives inside one network: a switch moves frames within it and cannot place an address on another. Chapter ${N_ROUTER} takes the next step: an address with structure, a table that holds one line for millions of machines, and a router that moves this same IPv4 packet from one network to another.</p>`;
      },
      widget: costWidget,
    },
  ],
};
