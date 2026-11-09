// Check yourself questions for the entries of codexmore6.ts (see codexcheck.ts), group 8: Communication, chapters carriers-glass. Answers
// first: the quiz shuffles the options (ui/quiz.ts shuffleOrder). Numbers pinned by tests/content-codexcomm.test.ts. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK8: Record<string, Quiz[]> = {
  ethframe: [
    {
      question: 'A frame carries 20 bytes of payload. How many bytes does the transmitter put on the wire between the start of the destination address and the FCS?',
      options: ['60: 14 of header, 20 of payload and 26 of zero pad', '34: the transmitter adds nothing', '46: the minimum payload alone', '64: the minimum frame including the FCS'],
      answer: 0,
      explain: 'The minimum frame is 64 bytes with its 4-byte FCS, so 60 before it: 14 + 20 + 26 = 60. The FCS covers the pad, and no field in Ethernet II says where the real payload ends, so the layer above has to know (IP\'s total length).',
      why: ['', 'A 34-byte frame would be a runt, and receivers drop it.', '46 is the payload minimum; the header is on top of it.', '64 includes the FCS, which follows these 60 bytes.'],
    },
    {
      question: 'The 2-byte field after the addresses holds 0x0800. What is it?',
      options: ['An EtherType: IPv4', 'A payload length of 2048 bytes', 'A payload length, since all Ethernet frames carry one', 'The FCS length'],
      answer: 0,
      explain: 'A value of 1536 (0x0600) or more is a type; 1500 or less is a length (802.3). 0x0800 = 2048 is above 1500 and no frame is that long, so it can only be the type of an Ethernet II frame: IPv4. 0x0806 is ARP.',
      why: ['', 'The longest frame carries 1500 bytes of payload, so a length of 2048 cannot occur.', 'Ethernet II carries a type and no length; only 802.3 frames announce theirs, with values up to 1500.', 'The FCS is always 4 bytes and sits at the end, not in this field.'],
    },
  ],
  csmacd: [
    {
      question: 'A station has collided three times with the same frame. What is the range of its next backoff, and its mean wait?',
      options: ['0 to 7 slots, 3.5 on average', '0 to 3 slots, 1.5 on average', '0 to 15 slots, 7.5 on average', 'Exactly 8 slots'],
      answer: 0,
      explain: 'After the n-th collision r is drawn uniformly from 0 to 2^min(n, 10) − 1: 0 to 7 after the third, a mean of 3.5 slots of 512 bit times. The range doubles each time, so a crowd thins itself without anyone counting it.',
      why: ['', 'That is the range after the second collision.', 'That is the range after the fourth collision.', 'A fixed count would send both stations back at the same instant, to collide again forever.'],
    },
    {
      question: 'Why must a frame last at least the round trip of the cable?',
      options: ['The sender must still be sending when the news of a collision returns, or it never learns its frame was destroyed', 'The receiver needs the time to compute the FCS', 'The preamble needs 512 bit times to align the receiver', 'To keep the gap between frames at 96 bit times'],
      answer: 0,
      explain: 'Worst case, the other station starts just before the first bit reaches it, and its signal needs another d to return: 2d after the start. A frame over by then ends unnoticed, and nothing is repeated. The 512-bit slot (64 bytes) fixes the allowance.',
      why: ['', 'The FCS is computed as the bytes go by and is ready when the last one is out; it sets no minimum.', 'The preamble is 7 bytes; the slot time is a bound on the cable, not on alignment.', 'The gap is a separate rule, kept after every frame whatever its length.'],
    },
  ],
  ethmac: [
    {
      question: 'The receiver cannot know a frame is good until its last byte, yet the consumer has been handed the bytes as they came. What keeps a bad frame from being seen?',
      options: ['The buffer writes each byte and moves the write pointer back to the commit pointer on err; only a good frame moves the commit pointer up', 'The MAC holds the whole frame until the FCS is known', 'The consumer checks every byte against the FCS', 'The MAC retransmits the frame'],
      answer: 0,
      explain: 'Write, then commit or rewind: the frame becomes visible only when the commit pointer reaches it. Holding the frame in the MAC would need 1518 bytes of RAM in every MAC and add a frame time to every frame.',
      why: ['', 'That is the alternative this design declines: a frame of memory and a frame of latency.', 'The FCS is a property of the whole frame; no byte can be checked alone.', 'A receiver cannot retransmit; recovery belongs to the layers above.'],
    },
    {
      question: 'The source stops asserting valid in the middle of a frame. What does the transmitting MAC do?',
      options: ['It ends the frame there, pads it if short and complements the FCS on purpose, so every receiver rejects it', 'It waits until valid returns and continues', 'It sends a jam and backs off', 'It sends the frame as it is with a correct FCS'],
      answer: 0,
      explain: 'The wire cannot wait. An underrun is made visible, not hidden: the frame ends with a wrong FCS and receivers drop it. A source should therefore start a frame only when it is wholly in its buffer.',
      why: ['', 'The line is already carrying bits; a pause would put a gap into the frame.', 'A jam is the answer to a collision, which this is not.', 'A correct FCS over a truncated frame would make receivers believe it.'],
    },
  ],
  learnsw: [
    {
      question: 'A frame from S arrives on port 2 at a switch with an empty table. Its destination D is a unicast address. What are the table and the frame\'s fate afterwards?',
      options: ['The table holds S → port 2; the frame was flooded to every port but 2', 'The table holds D → port 2; the frame was dropped', 'The table holds S → port 2; the frame was dropped', 'The table is still empty; the frame went to every port including 2'],
      answer: 0,
      explain: 'A frame teaches the switch only its source: S sits behind port 2. D is a miss, so the frame is flooded to every other port; the sender, on port 2, is never sent its own frame back.',
      why: ['', 'The destination address says nothing about where that host is.', 'Dropping would leave a new host unreachable until it spoke first.', 'Every frame\'s source is learned, and flooding excludes the arrival port.'],
    },
    {
      question: 'A frame arrives on port 1 with a destination the table lists behind port 1. What does the switch do?',
      options: ['Filters it: both hosts are on that wire already', 'Sends it out of port 1 again', 'Floods it to the other ports to be safe', 'Forgets the entry and relearns it'],
      answer: 0,
      explain: 'Hit, and the port equals the arrival port: the destination has the frame already. Sending it again would repeat it on the wire it came from; flooding would waste the other ports\' bandwidth.',
      why: ['', 'The destination heard the frame the first time; a copy would be a duplicate.', 'Flooding is for a miss or a group address, not for a known destination.', 'The entry is correct; only an entry that ages out, or a host seen on another port, is replaced.'],
    },
  ],
  crossbar: [
    {
      question: 'In one cycle, inputs 0 and 1 each have a frame for output 3 and input 2 has a frame for output 1. All outputs are idle. What starts?',
      options: ['Input 2 to output 1 and one of inputs 0 and 1 to output 3; the other waits', 'Nothing until the table port has served all three', 'Both inputs to output 3, interleaved byte by byte', 'Only one transfer, as a crossbar is one shared bus'],
      answer: 0,
      explain: 'The crossbar has no internal blocking, so frames to different outputs move at once. Each output grants one asker, in rotating priority; the loser asks again next cycle and is served after the winner\'s frame.',
      why: ['', 'The table port decides the output once per frame, early; it is not a barrier for the data.', 'An output holds its grant for a whole frame; two sources would corrupt each other.', 'A crossbar is a multiplexer per output: one transfer per output, all at once.'],
    },
    {
      question: 'A 64-byte frame crosses an idle switch a byte a cycle. When does its first byte leave under store-and-forward and under cut-through?',
      options: ['At cycle 65 and at cycle 14', 'At cycle 64 for both', 'At cycle 14 and at cycle 65', 'At cycle 128 and at cycle 65'],
      answer: 0,
      explain: 'Store-and-forward waits for the last byte (in at 63), so the output starts at 65 and the last byte leaves at 128. Cut-through starts when the table has answered, after the twelfth byte, at cycle 14, whatever the frame\'s length.',
      why: ['', 'Cut-through does not wait for the end of the frame; the two differ by a frame time.', 'The two are the wrong way round: cut-through is the early one.', '128 is when the last byte leaves under store-and-forward, not the first.'],
    },
  ],
  hol: [
    {
      question: 'A saturated 4 × 4 switch with one FIFO per input and uniform destinations carries about what fraction of its capacity?',
      options: ['0.655, about two thirds', '1.0: the crossbar is non-blocking', '0.5', '0.9'],
      answer: 0,
      explain: 'Karol, Hluchyj and Morgan\'s result for N = 4 is 0.6553, falling to 2 − √2 = 0.5858 as N grows. The fabric is non-blocking, but only the head of each queue competes, so a head waiting for a busy output idles the other outputs.',
      why: ['', 'Non-blocking describes the fabric; the loss is in the queues, which show it only their head.', 'That is not the figure for N = 4; it is below even the limit of 0.5858 as N grows to infinity.', 'That would need the frames behind a blocked head to be visible, which is the virtual output queues\' job.'],
    },
    {
      question: 'What does a virtual output queue change?',
      options: ['A frame for an idle output is never queued behind a frame for a busy one', 'The crossbar becomes faster', 'The arbiter grants several outputs to one input at once', 'Frames are no longer buffered'],
      answer: 0,
      explain: 'One queue per output in every input lets the input offer a frame for any idle output. The gain depends on how many frames it can look past: about 0.80 with 4 cells, 0.88 with 8, 0.92 with 16, for a few thousand NANDs on an input of 142 221.',
      why: ['', 'The fabric is unchanged; the same multiplexers carry the bytes.', 'Each output still grants one asker per cycle; the input has more to offer.', 'Buffering is the point: a queue per output needs cells to look past.'],
    },
  ],
  nicring: [
    {
      question: 'The NIC has committed a received frame to a descriptor. What does the descriptor say, and who owns it?',
      options: ['OWN clear and the frame length: the software owns it and may read the buffer', 'OWN set and the length: the NIC still owns it', 'OWN clear and an error flag: the frame was bad', 'The descriptor is unchanged; only STATUS says a frame arrived'],
      answer: 0,
      explain: 'The commit is the write of word 1 with OWN clear and the length. Whoever clears OWN has given the descriptor away and leaves it alone; the driver, which looks only at OWN, now owns the descriptor and the buffer.',
      why: ['', 'OWN set means the NIC holds it; a committed frame has been handed back.', 'A receive descriptor carries only OWN and the length; a bad frame is never handed back at all.', 'STATUS reports events; the descriptor\'s OWN bit is what hands the buffer over.'],
    },
    {
      question: 'Why does the NIC write the frame\'s bytes first and word 1 last?',
      options: ['So software that sees OWN clear finds every byte in place, and a bad FCS leaves the descriptor with the NIC, with nothing to undo', 'Because word 1 holds the FCS, which arrives last', 'Because the bus can only write the last word of a burst', 'To save a bus transaction'],
      answer: 0,
      explain: 'The MAC reports the FCS verdict only with the last byte, so the frame is already in RAM when it is judged. Writing word 1 last makes the verdict the commit: a good frame hands the descriptor back, a bad one never does.',
      why: ['', 'Word 1 holds OWN and the length; the FCS is not stored in the descriptor.', 'The bus writes any word in any order; the order is chosen for the software\'s sake.', 'The order costs no transaction either way: 2 reads and 20 writes for a 74-byte frame.'],
    },
  ],
  inetcksum: [
    {
      question: 'The words 0001, f203, f4f5, f6f7 sum to 0x2DDF0. What is the Internet checksum of the block?',
      options: ['0x220D: fold to 0xDDF2, then invert', '0xDDF2: the folded sum', '0x2DDF0: the sum as it stands', '0x0000'],
      answer: 0,
      explain: 'The carry above bit 15 is added back: 0xDDF0 + 2 = 0xDDF2. The field holds the complement, ~0xDDF2 = 0x220D, and a block that includes it sums to 0xFFFF.',
      why: ['', 'That is the folded sum; the field holds its complement.', 'It has 18 bits; the carry must be folded back into 16, and then inverted.', 'Zero would be the checksum of a block summing to 0xFFFF, such as one that already holds its own checksum.'],
    },
    {
      question: 'Which of these corruptions does the Internet checksum miss and a CRC-32 catch?',
      options: ['Two words of the block swapped', 'One word changed from 0x1234 to 0x1235', 'A single bit flipped', 'A byte changed by one'],
      answer: 0,
      explain: 'The sum does not depend on the order of the words, so a swap leaves it unchanged; the CRC treats the message as a polynomial and the position of every bit matters. Any change of a single word\'s value changes the sum and is caught.',
      why: ['', 'The sum changes by 1 and the checksum fails.', 'A flipped bit changes the sum by a power of two and is caught.', 'The sum changes and the check fails.'],
    },
  ],
  arp: [
    {
      question: 'Why does the first ping of a session take longer than the ones that follow?',
      options: ['There is no ARP entry yet: the stack sends a request, drops the frame it had and the application tries again', 'The switch has to learn the address', 'The first frame is padded to 60 bytes', 'The CPU caches the checksum'],
      answer: 0,
      explain: 'ip_send finds no MAC for the destination, sends an ARP request and returns 0; a stack with no queue of packets awaiting resolution drops the frame. The reply fills the table, and the next try finds it.',
      why: ['', 'The switch learns from the same frames, but that does not cost the host a retry.', 'Every ping is 74 bytes, above the minimum; padding concerns only short frames.', 'There is no such cache; the checksum is recomputed for every packet.'],
    },
    {
      question: 'What addresses does an ARP request carry?',
      options: ['Ethernet destination ff:ff:ff:ff:ff:ff, and a target MAC field of zeros', 'Ethernet destination 02:00:00:00:00:02, and the target MAC filled in', 'Ethernet destination ff:ff:ff:ff:ff:ff, and the target MAC filled in', 'No Ethernet destination: ARP is not carried in a frame'],
      answer: 0,
      explain: 'The asker does not know the MAC, so the request is a broadcast and its target hardware address is zero; the target IP says whom it is for. The reply goes to the asker directly with the target MAC filled in.',
      why: ['', 'If the asker knew the MAC it would not be asking.', 'The target MAC is what the request asks for, so it is zero in the packet.', 'ARP is carried directly in an Ethernet frame, with EtherType 0x0806.'],
    },
  ],
  ipv4: [
    {
      question: 'A 20-byte UDP message is padded to 60 bytes in its Ethernet frame. How does the receiver find the end of the datagram?',
      options: ['From the total length field in the IPv4 header', 'From the frame\'s length', 'From the FCS', 'From the UDP checksum'],
      answer: 0,
      explain: 'Ethernet II carries no length and pads short frames to 60 bytes, so the pad is not part of the datagram. IP\'s total length says where it ends, and the ICMP or UDP checksum must stop there.',
      why: ['', 'The frame\'s length includes the pad.', 'The FCS follows the pad and covers it; it does not locate the datagram.', 'The checksum covers the datagram, and needs its length first.'],
    },
    {
      question: 'On the gates, a ping takes 14 689 clocks, of which the cable accounts for 11 008. What share is that, and why?',
      options: ['About three quarters: four serializations of a 74-byte frame, 2752 clocks each', 'About a quarter: most of the time is software', 'Under 10 %: the cable is fast', 'About half: two frames, each on one link'],
      answer: 0,
      explain: 'Each 74-byte frame, with its preamble and FCS, is 86 bytes at 32 clocks a byte: 2752 clocks. It is sent twice (computer to switch, switch to computer), and so is the reply, since the switch stores and forwards: 4 × 2752 = 11 008 of 14 689.',
      why: ['', 'The software is 3673 clocks; the rest is the wire.', 'At 4 clocks a bit the cable is the scarce resource in this book.', 'Each frame crosses two links, not one, because the switch stores the whole frame before forwarding.'],
    },
  ],
};
