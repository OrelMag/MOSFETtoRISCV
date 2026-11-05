// The fuller codex for the Communication extension: pcie, secret (codexcomm2c.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE8C: Record<string, CodexMore> = {
  pcie: {
    idea: `A parallel bus needs every line valid at the same clock edge, and lines differ in length and load, so they arrive spread over some skew; the clock can be no faster than the receiver can find a moment when all of them have settled. Widening the bus makes the skew worse, and every line costs a pin. PCI Express keeps PCI's software model (configuration space, memory reads and writes) and drops the wires: a <b>lane</b> is one differential pair each way, point to point, with the clock recovered from the data as in a fast serial link, so there is no skew to speak of and a ×16 link is sixteen lanes the receiver deskews on its own. The cost moves from pins to logic: clock recovery, a line code, and a protocol that frames, checks and retransmits.<br><br>The protocol has three layers. The <b>transaction layer</b> owns the request, a TLP with a three-dword header (format and type, length in dwords, a tag that lets a completion find its read, byte enables, the address). The <b>data link layer</b> wraps it in a 12-bit sequence number and a 32-bit LCRC, keeps it until acknowledged, and is the only layer that sees a retry; its own packets, DLLPs, are 6 bytes and carry Acks, Naks and flow-control updates. The <b>physical layer</b> frames the packet with control symbols, scrambles, encodes and serialises it. Reads are split transactions: the request leaves and a completion comes back later, so a link never waits holding the bus.`,
    example: {
      title: 'What the bus cost and what the lane costs',
      body: `<pre>parallel bus, 1 ns of skew, half a period kept for set-up and sampling:
  f = 1 / (2 × 1 ns) = 500 MHz       64 bits: 500 MHz × 64 / 8 = 4 GB/s, one way, shared
PCIe 5.0 ×16: 32 GT/s × 128/130 × 16 lanes / 8 = 63 GB/s each way on 64 signal pins
bytes around one TLP: 2 framing + 12 header + 4 LCRC + 2 sequence = 20
  4-byte write  4 / 24 = 17 %           256-byte write  256 / 276 = 93 %
the chapter's gates, one lane: port 18,854 NANDs of logic + 355,716 for two buffers
  whole link with the completer's 1 KB memory: 922,275 NANDs</pre>The gates run one lane at a symbol a clock, a teaching rate; the multi-gigabit figures are real PCIe's. Short on-chip buses are still parallel for the same reason: on one die there is no skew to fight and no errors to retry.`,
    },
    mistakes: [
      'Thinking more width fixes a parallel bus: it adds skew and pins, so the clock falls as the bus grows; a lane sidesteps it by carrying its clock in its data.',
      'Treating the LCRC as end to end: sequence number and LCRC are per link, a switch strips them and makes new ones, so a switch that corrupts a TLP in its own memory forwards a correct LCRC. End-to-end integrity is the optional ECRC.',
      'Counting the line rate as throughput: 8b/10b spends 20 % of it, and a 4-byte write is 17 % efficient before any line code, a 256-byte one 93 %.',
      'Expecting software to see link errors: Nak, replay and retraining happen below the transaction layer, so software sees a pause, and only the correctable-error counters show a link degrading.',
    ],
    chapters: [
      { chapter: 'pcie', step: 0, label: 'From a bus to a lane' },
      { chapter: 'pcie', step: 1, label: 'A packet, byte by byte' },
      { chapter: 'pcie', step: 6, label: 'What is below, and what it costs' },
      { chapter: 'pcie', step: 9, label: 'Two answers to one question' },
    ],
  },

  credits: {
    idea: `An Ethernet switch that runs out of room drops the frame and leaves recovery to software. A memory write cannot be dropped, since nothing above PCIe would notice, so the sender may not send a TLP until the receiver has promised room for it. At link-up the receiver advertises its buffers in <b>credits</b> (InitFC DLLPs): one header credit holds a TLP header, one data credit 4 dwords of payload, in three separate pools, posted (writes), non-posted (reads, an answer owed) and completions. As it frees buffer it sends the running total in an UpdateFC DLLP.<br><br>The sender keeps two counters per pool: CREDIT_LIMIT, what the receiver has allowed since the start, and CREDITS_CONSUMED, what it has used. Both only go up and wrap, at 8 bits for headers and 12 for data, so comparing them is wrong just after one wraps. The test is a subtraction, (LIMIT − (CONSUMED + want)) mod 2<sup>w</sup> ≤ 2<sup>w−1</sup>: the buffer is smaller than half the range, so a result above half can only mean the limit lies in the past. Because UpdateFC carries a total and not a difference, a lost update is repaired by the next. Endpoints advertise infinite completion credits, since they only ask for what they have room to take; otherwise a read waiting behind a completion waiting for a read could deadlock the fabric.`,
    example: {
      title: 'A gate that survives a wrap',
      body: `<pre>8-bit header counters
limit 4, consumed 2:   (4 − (2 + 2)) mod 256 = 0     ≤ 128   room for 2, yes
                       (4 − (2 + 3)) mod 256 = 255   > 128   3, no
after a wrap: limit 2, consumed 254
  credits left = (2 − 254) mod 256 = 4
  want 4: (2 − 258) mod 256 = 0     yes      want 5: (2 − 259) mod 256 = 255   no
the plain test  2 ≥ 254 + 4  is false: it would refuse
gate: 271 NANDs at 8 bits, 407 at 12 bits; each TLP needs a yes from its header gate and its data gate
chapter's endpoint: 4 posted headers, 16 data credits, 4 non-posted headers</pre>`,
    },
    mistakes: [
      'Comparing LIMIT ≥ CONSUMED + want directly: right until one counter wraps and the other has not, then it refuses a TLP the receiver has room for (limit 2, consumed 254 has 4 credits left).',
      'Sending UpdateFC as a difference: a lost update would shrink the sender\'s view for good; the running total repairs itself on the next one.',
      'Sizing credits for the buffer and ignoring the round trip: too few and a fast link idles waiting for UpdateFC; about round trip over TLP size in headers fills the lane.',
      'Making completions wait for credits: a read stuck behind a completion that is stuck behind a read deadlocks; that is why an endpoint advertises infinite completion credits and why a posted write may pass a stuck read.',
    ],
    chapters: [
      { chapter: 'pcie', step: 2, label: 'Credits: never send what will not fit' },
      { chapter: 'pcie', step: 5, label: 'Link training' },
      { chapter: 'pcie', step: 9, label: 'Two answers to one question' },
    ],
  },

  replay: {
    idea: `A TLP has to arrive exactly once, and the data link layer is where that is made true. The transmitter writes every TLP into a <b>replay buffer</b> as it goes out and keeps it. An <b>Ack</b> carrying sequence s means everything up to s has arrived: it frees those entries and moves ACKD_SEQ, and one Ack covers many TLPs, which is why a receiver gathers them. A TLP with a bad LCRC is thrown away, the receiver's write pointer goes back to the last committed TLP, and it sends a <b>Nak</b> with the last good sequence number; the transmitter reads the rest out of its buffer in order and the write lands once. Sequence numbers are compared modulo 4096 and only half the space is valid, so old and new can be told apart.<br><br>Two more cases close the loop. If the Ack itself is hit, the <b>replay timer</b>, running while anything is unacknowledged and restarting on progress, expires and replays everything; the receiver then sees a good LCRC but an old number, drops it and Acks at once, because delivering would write twice. Every replay increments a 2-bit REPLAY_NUM, and any forward progress clears it; when it wraps, four replays have achieved nothing and the layer asks for Recovery, after which the buffer still holds the TLP and the replay is the first thing after L0.`,
    example: {
      title: 'One damaged write, and one lost Ack, in clocks',
      body: `<pre>lane delay each way 4 clocks; a receiver may gather Acks for up to 32 clocks
Write, sequence 0 → Ack back after about 99 clocks
damaged TLP: LCRC fails → dropped, Nak(last good) → replay from the buffer → delivered once
lost Ack:    replay timer (512 clocks here) expires → same TLP, good LCRC, old number
             → dropped, Ack at once ("B expects" moved by one, not two)
dead lane:   timer expires four times (a little over 4 × 512 = 2,048 clocks) → REPLAY_NUM wraps → Recovery
buffer: at most 8 TLPs unacknowledged in the chapter's port (the standard allows 2048)</pre>`,
    },
    mistakes: [
      'Delivering a duplicate because its LCRC is good: an old sequence number means the Ack was lost, and delivering would write twice; the receiver drops it and Acks again.',
      'Setting the replay timer below the longest legitimate round trip with Acks at their latest: a healthy link then replays all the time; it also has to stop while a replay is under way.',
      'Expecting a Nak for a lost Ack: the receiver noticed nothing wrong and sends none; only the sender\'s timer can notice, which is why the timer exists.',
      'Treating a Nak as data loss: nothing above the data link layer ever knew, and a retry costs a packet time and a round trip. Only repeated failure is escalated, through REPLAY_NUM, to Recovery.',
    ],
    chapters: [
      { chapter: 'pcie', step: 3, label: 'Ack, Nak and the replay buffer' },
      { chapter: 'pcie', step: 4, label: 'When the Ack is lost, or nothing gets through' },
      { chapter: 'pcie', step: 7, label: 'USB: one master, and nobody else speaks' },
    ],
  },

  linktraining: {
    idea: `Plug a card in and neither end knows if the other is there, where its symbol boundaries are, or how fast it can go. The physical layer's <b>LTSSM</b>, the link training and status state machine, finds out with <b>ordered sets</b> of 16 symbols that begin with the comma COM (K28.5), which lets the receiver find symbol and word boundaries. The chapter's subset is Detect, Polling, Configuration and L0, with Recovery beside it.<br><br>In Polling.Active a port sends <b>TS1</b>s; after at least 16 sent and 8 seen in a row from the far end it moves to Polling.Configuration and sends <b>TS2</b>s, meaning "I can hear you"; eight TS2s seen in a row mean the other end hears this one too, and requiring eight guards against a noise burst that looks like one. Configuration agrees lane order and width (skipped in the gates) and ends with idle symbols, 8 received and 16 sent. Then L0: the link is up, and only now does the data link layer start, with InitFC1 and InitFC2 DLLPs giving each side the other's buffer sizes. Recovery repeats TS1, TS2, idle; speed changes and equalization go through it, and on real parts from 8 GT/s the ends tune each other's equalizer taps by exchanging TS1s.`,
    example: {
      title: 'Bringing the chapter\'s link up',
      body: `<pre>Detect          sensing the far-end termination (not modelled)
Polling.Active   send TS1 until ≥ 16 sent and 8 in a row seen
Polling.Config   send TS2 until 8 in a row seen
Configuration    idle symbols: 8 received, 16 sent
L0               link up
InitFC1, InitFC2 each side learns the other's buffers (DL_Up)
→ both ports in L0 with flow control up after 636 clocks
the chapter notes that the standard's Polling alone asks for 1024 TS1s; we send 16</pre>An unplug resets both ports and the transaction layer with them: a hot unplug is an error for software to catch.`,
    },
    mistakes: [
      'Calling the link usable at L0: the data link layer starts only then, and no TLP may go until InitFC has told each side the other\'s buffers.',
      'Waiting for an exact TS2 forever: a noisy lane can leave a port waiting for a TS2 the far end has already finished sending, so a training timeout that restarts the sequence is needed.',
      'Trusting one ordered set: a single TS1 or TS2 can be a noise burst; requiring 8 in a row is the filter.',
      'Treating Recovery as failure: it retrains with the same three moves and the replay buffer intact, so a marginal lane can drop to a lower speed and software sees a pause rather than an error.',
    ],
    chapters: [
      { chapter: 'pcie', step: 5, label: 'Link training' },
      { chapter: 'pcie', step: 4, label: 'When the Ack is lost, or nothing gets through' },
      { chapter: 'pcie', step: 6, label: 'What is below, and what it costs' },
    ],
  },

  usbenum: {
    idea: `USB puts all the intelligence in the host: one master, and a device speaks only when spoken to. A device plugged in knows nothing and answers at address 0. The host resets the bus (SE0 held long) and walks it through the <b>control pipe</b>, endpoint 0, where each request is an 8-byte SETUP packet, a data stage, and a status stage in the opposite direction. In the chapter's textbook order (real hosts differ in the details): GET_DESCRIPTOR(device, 8) at address 0, only to learn the maximum packet size (8 here), then another reset; SET_ADDRESS(5); GET_DESCRIPTOR(device, 18) for vendor, product and class, in packets of that size, DATA1, DATA0, DATA1; GET_DESCRIPTOR(configuration), first 9 bytes for the total length and then all of it, which is how the host picks a driver; SET_CONFIGURATION(1), and the device is live.<br><br><b>The trap:</b> SET_ADDRESS is a control transfer, so it ends with a status stage, and that status stage is addressed to the old address 0. A device that moves as soon as the SETUP is acknowledged never hears the IN token of its own status stage. The chapter's device moves when the host acknowledges the status packet. Each packet is checked by CRC, so a corrupted one is ignored, the host times out and repeats, and the DATA0/DATA1 toggle lets the receiver drop a repeat it has already taken.`,
    example: {
      title: 'A whole enumeration on the gates',
      body: `<pre>token for SETUP, address 0, endpoint 0:  2D 00 10   (CRC5 00010)
GET_DESCRIPTOR(device, 8)     address 0     → max packet 8
SET_ADDRESS(5)                address 0 until the status stage ends, 5 afterwards
GET_DESCRIPTOR(device, 18)    address 5     → 8 + 8 + 2 bytes: DATA1, DATA0, DATA1
GET_DESCRIPTOR(configuration) address 5     → 9 bytes, then the full length
SET_CONFIGURATION(1)          address 5     → Configured
device: 4,571 NANDs;  the dialogue: 12,702 clocks at 4 clocks a bit (real full speed is 12 Mb/s)</pre>Left out and named in the chapter: start-of-frame timing, suspend, low and high speed, hubs, attach detection.`,
    },
    mistakes: [
      'Moving to the new address when the SETUP of SET_ADDRESS is acknowledged: the status stage still goes to address 0, the device never hears it and the host gives up on it.',
      'Asking for the whole device descriptor first: the host does not know the packet size yet, so it reads 8 bytes at address 0 to learn it.',
      'Expecting a device to interrupt: it cannot; a "USB interrupt" is the host polling on a schedule, and a device with nothing to say answers NAK.',
      'Treating a NAK as an error: it means "not now, ask again", while STALL means "no"; and if a device waits for the host\'s last ACK of SET_ADDRESS and it is lost, the two disagree on the address until the host recovers.',
    ],
    chapters: [
      { chapter: 'pcie', step: 8, label: 'Enumeration: a stranger introduces itself' },
      { chapter: 'pcie', step: 7, label: 'USB: one master, and nobody else speaks' },
      { chapter: 'pcie', step: 9, label: 'Two answers to one question' },
    ],
  },

  aes: {
    idea: `AES-128 works on 16 bytes written as four columns of four, and each of ten rounds has four steps with one job each: <b>SubBytes</b> breaks linearity a byte at a time, <b>ShiftRows</b> and <b>MixColumns</b> spread each byte across the block, <b>AddRoundKey</b> brings in the key. The key is XORed in once before round 1, because without it an attacker could undo the first round's steps with no key at all, and the last round leaves MixColumns out. Round keys come from the 128-bit key by a small schedule, one a round, using the S-box and a constant. Unlike the Enigma's wheels, the key is sixteen bytes in a register and the structure never changes.<br><br>The S-box is not a random table: it is the inverse in GF(2<sup>8</sup>), which has very low correlation between input and output, followed by an affine map that removes the fixed points at 0 and 1. In gates there is no ROM: the field is split into a tower, GF(4) inside GF(16) inside GF(256), so the inverse needs a few multiplications and one inverse in the smaller field, down to NANDs. ShiftRows costs no gates, only wires going elsewhere, so the non-linear step is where the cost goes. Within two or three rounds one flipped input bit has changed about half the state: diffusion, which a crib cannot get a grip on.`,
    example: {
      title: 'FIPS 197\'s example, and what it costs in gates',
      body: `<pre>key        2b7e1516 28aed2a6 abf71588 09cf4f3c
plaintext  3243f6a8 885a308d 313198a2 e0370734
ciphertext 3925841d 02dc09fb dc118597 196a0b32       (S-box of 0x53 is 0xED)
the core's bus prints it backwards: 0x320B6A19_978511DC_FB09DC02_1D842539
S-box 584 NANDs (inverse 476, depth 74)    MixColumn 464 (four a round)
SubBytes 16 × 584 = 9,344                  key step 2,880
round 12,224        core 20,782 NANDs, 11 clocks a block (one to load, one a round), period 102</pre>`,
    },
    mistakes: [
      'Reading the S-box as an arbitrary table: it is the GF(2<sup>8</sup>) inverse plus an affine map, which is why it can be built from a tower of smaller fields with no ROM.',
      'Leaving out the key XOR before round 1: the first round\'s SubBytes, ShiftRows and MixColumns are keyless and could be undone by an attacker.',
      'Putting MixColumns in the last round: it is left out there (set last to 1 and the round bypasses it); the chapter\'s round block does exactly that.',
      'Assuming gates and software leak alike: a table-based S-box in memory has access times that depend on what was recently read, which has leaked keys through caches; gates read no memory, though their power draw still varies with the data.',
    ],
    chapters: [
      { chapter: 'secret', step: 7, label: 'AES: four steps and a key' },
      { chapter: 'secret', step: 8, label: 'The S-box, in gates' },
      { chapter: 'secret', step: 9, label: 'A round, and the core' },
      { chapter: 'secret', step: 11, label: 'One bit changes everything' },
    ],
  },

  sha256: {
    idea: `A hash has no key. It turns any message into 256 bits so that nobody can find a message for a given digest, or two messages with the same one: a fingerprint, so publish the digest and anyone can check the file. Keys are derived with it and handshakes are bound together by it. The message is padded and cut into 64-byte blocks; each block is expanded to 64 words and stirred through 64 rounds into eight 32-bit registers. Their starting values and the round constants are fractional bits of the square and cube roots of primes, chosen so that nobody can suspect a hidden weakness in them: anyone can recompute them.<br><br>A round is two Σ functions, Ch, Maj and seven 32-bit adders. Rotations are wires, so Σ costs only its XORs. There is no S-box; the mixing is addition, whose carries cross bits where XOR does not, and the two together are hard to invert. Change one bit of the input and about half the digest bits move, for the same reason as in AES. Compared with AES per byte, SHA-256 spends about 1.02 clocks a byte on the chapter's core against 0.69.`,
    example: {
      title: '"abc", and the core that hashes it',
      body: `<pre>SHA-256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
SHA-256("abb") differs from it in 124 of the 256 bits (one input bit changed)
round 2,848 NANDs        message schedule 11,104 (16 words stored)      constants 3,337
core 28,487 NANDs, 65 clocks a block (one to load, one a round), period 108
in software on the RV32IM: 8,364 cycles per 64-byte block
per byte: 65 / 64 = 1.02 clocks      AES core 11 / 16 = 0.69</pre>The core's bus holds the digest with its first word at the low end, so it prints 0xF20015AD_…_BA7816BF.`,
    },
    mistakes: [
      'Calling a hash an encryption: it has no key and cannot be undone; anyone can compute it, so it proves integrity only if the digest itself arrives intact.',
      'Making a tag by hashing a secret and a message side by side: use HMAC, which the handshake uses for Finished, and HKDF for keys.',
      'Expecting the constants to be arbitrary: they are fractional bits of roots of primes, so anyone can recompute them, and the code here does.',
      'Judging digests of similar inputs by eye: one flipped input bit moves about half the output bits (124 of 256 for "abc" against "abb"), so nearness of inputs tells nothing.',
    ],
    chapters: [
      { chapter: 'secret', step: 13, label: 'A fingerprint: SHA-256' },
      { chapter: 'secret', step: 14, label: 'SHA-256 in gates' },
      { chapter: 'secret', step: 20, label: 'What it all costs' },
    ],
  },

  blockmode: {
    idea: `A block cipher turns 16 bytes into 16 bytes, messages are longer, and how the blocks are chained matters as much as the cipher. <b>ECB</b> enciphers every block alone with the same key, so equal blocks of input give equal blocks of output and a flat area of a picture becomes one repeated block: the outline shows through. The cipher is doing its job on each block; the mode gives the pattern away. <b>CTR</b> enciphers a counter and XORs the result into the message, which turns AES into a stream and hides repeats; it needs only the encrypt direction, so the same gates serve both ends.<br><br>CTR has one absolute rule: use a counter value twice under one key and the keystream cancels in the XOR of the two ciphertexts, with no key needed, which is the Enigma operators' reused settings again. It also has no idea whether anyone changed the message: flip a ciphertext bit and that plaintext bit flips. <b>GCM</b> adds a tag, a keyed polynomial over the ciphertext computed in GF(2<sup>128</sup>); a changed bit anywhere makes the tag fail and the message is refused. TLS 1.3 allows only authenticated encryption of this kind.`,
    example: {
      title: 'Two equal blocks under ECB and CTR',
      body: `<pre>key 2b7e1516 28aed2a6 abf71588 09cf4f3c, 32 bytes of zeros as the message
ECB   block 0 → 7df76b0c…     block 1 → 7df76b0c…     equal in, equal out
CTR   keystream E(counter 0) = 7df76b0c…     E(counter 1) = 57127d40…     different
CTR, same counter and key for two messages:   c1 ⊕ c2 = p1 ⊕ p2     no key needed
GCM   as CTR, plus a tag over the ciphertext: one flipped bit anywhere and the tag fails</pre>(With a zero message and counter the first CTR block equals ECB's; it is the second block that shows the difference.)`,
    },
    mistakes: [
      'Using ECB because the cipher is strong: it is the mode that leaks, since repeated blocks stay repeated whatever the key length.',
      'Reusing a CTR counter or nonce under one key: the keystream cancels and the XOR of two ciphertexts is the XOR of the two plaintexts.',
      'Assuming encryption means integrity: CTR flips exactly the bit you flip, and nothing notices; authentication is a separate job, which GCM\'s tag does.',
      'Reaching for the decrypt direction in CTR: it uses only encrypt on both ends, which is why a core with one direction does both jobs.',
    ],
    chapters: [
      { chapter: 'secret', step: 12, label: 'Modes: blocks are not enough' },
      { chapter: 'secret', step: 19, label: 'A TLS 1.3 handshake' },
      { chapter: 'secret', step: 3, label: 'Why it broke: the flaw in the wiring' },
    ],
  },

  keyexchange: {
    idea: `The navy's key lists had to be printed and carried to every boat, and a capture gave them away. Two strangers on a network have no list, and Diffie and Hellman showed in 1976 they do not need one. Take a public prime p and a number g. Alice keeps a secret a and sends g<sup>a</sup> mod p; Bob keeps b and sends g<sup>b</sup> mod p. Each raises what arrived to their own secret and both get g<sup>ab</sup> mod p, because exponents commute. Anyone watching has both public numbers and would need to undo an exponentiation, the <b>discrete logarithm</b>, for which no fast method is known on ordinary computers at the right sizes. The shared secret is never sent, under any cipher.<br><br>Modern TLS does this on an elliptic curve, where the same security needs far smaller numbers: instead of multiplying numbers you add points, <i>a</i> times a point is easy, and getting <i>a</i> back is the hard direction. X25519 has 255-bit numbers and is chosen so that a careful implementation is simple; the chapter's is Python built for the RV32IM, a number being 32 limbs of 8 bits, and one multiplication walks the 255 bits with the Montgomery ladder. A large quantum computer would change the hardness, since Shor's algorithm solves discrete logarithms. And key exchange alone says nothing about who is at the other end: a man in the middle runs one exchange with each side.`,
    example: {
      title: 'A toy exchange, and the real one\'s cost',
      body: `<pre>p = 23, g = 5, Alice a = 6, Bob b = 15   (public: p, g, A, B)
A = 5^6  mod 23 = 8        B = 5^15 mod 23 = 19
Alice: B^a = 19^6 mod 23 = 2        Bob: A^b = 8^15 mod 23 = 2     same secret, never sent
X25519 on the chapter's RV32IM:  34,569,985 cycles for one
AES-128 block in the same software: 8,057 cycles   (about 4,300 times less)</pre>The chapter's own Diffie–Hellman demonstration uses p = 2<sup>31</sup> − 1, a size Eve can search; X25519 works with 255-bit numbers.`,
    },
    mistakes: [
      'Calling the exchange authenticated: it proves you share a secret with someone; a man in the middle holds two such secrets, so a signature over the transcript is needed.',
      'Thinking the shared secret travels encrypted: it is never sent at all, both sides compute it.',
      'Using a group small enough to search: security rests on the size of the group, and the chapter\'s 2<sup>31</sup> − 1 is a teaching size that its Eve can search.',
      'Treating teaching code as hardened: the chapter\'s ladder runs the same operations for every key but has not been hardened against side channels, and a quantum computer would break the hardness assumption.',
    ],
    chapters: [
      { chapter: 'secret', step: 16, label: 'Sharing a secret in public' },
      { chapter: 'secret', step: 17, label: 'X25519 on our CPU' },
      { chapter: 'secret', step: 18, label: 'Who is at the other end' },
    ],
  },

  tls: {
    idea: `A TLS 1.3 handshake is one round trip. The client sends a <b>ClientHello</b> with a random number and its X25519 public key; the server answers with a <b>ServerHello</b> holding its own. From there both have the shared secret and HKDF, built from HMAC and SHA-256, stretches it into keys. Everything else the server sends is under AES-128-GCM: <b>EncryptedExtensions</b>, its <b>Certificate</b>, <b>CertificateVerify</b>, which is the signature over the hash of the conversation so far, and <b>Finished</b>, an HMAC over the whole transcript. The client checks each in turn, answers with its own Finished, and application data follows.<br><br>Who is at the other end is settled by that signature, not by the key exchange: substitute another key share and the signature no longer covers what the client saw. A certificate is someone else's signature on "this key belongs to this name", in a chain that ends at a key the browser already holds; the chapter's client checks none of that, only a pinned hash of the server's key. The session keys come only from the exchange and are thrown away, so stealing the server's signing key tomorrow does not open yesterday's recordings: <b>forward secrecy</b>. The cost is lopsided: public-key work dominates and the symmetric work that protects the data barely shows.`,
    example: {
      title: 'The chapter\'s client against RFC 8448\'s recorded server',
      body: `<pre>cycles on the RV32IM model (1 per instruction):
client_hello (X25519 share)   34,598,182     key_agreement (X25519)  35,089,754
certificate_verify (RSA-PSS)  10,338,413     the other five phases    1,251,248
total 81,277,693 (96 outside any phase), of which the two X25519 runs 69,139,884 (85 %)
one X25519 measured alone is 34,569,985: 43 more each, the command loop around that measurement
RSA verify: 10,310,080 cycles with RFC 8448's 1024-bit key, 40,767,022 with a 2048-bit key
the client: 1,314 lines of Python, 7,428 words of RV32IM
bytes: ClientHello 201, sent 259, received 774</pre>RFC 8448's 1024-bit RSA is far too short to trust today; real servers use ECDSA, Ed25519 or RSA of 2048 bits or more.`,
    },
    mistakes: [
      'Believing a completed handshake means the right server: without a certificate check (the chapter\'s client has only a pin) the channel runs to whoever answered, who may be an attacker.',
      'Counting the symmetric part as the cost: here X25519 twice and one signature check are nearly all of it; AES-GCM and HMAC barely show.',
      'Trusting a short RSA key because the handshake works: 1024 bits does for replaying the RFC, not for a server; 2048 bits costs 40,767,022 cycles against 10,310,080.',
      'Assuming a stolen server key opens old traffic: session keys come only from the exchange and are discarded, so recordings stay shut (forward secrecy), unlike a captured key list.',
    ],
    chapters: [
      { chapter: 'secret', step: 19, label: 'A TLS 1.3 handshake' },
      { chapter: 'secret', step: 18, label: 'Who is at the other end' },
      { chapter: 'secret', step: 20, label: 'What it all costs' },
    ],
  },
};
