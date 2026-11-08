// Check yourself for the Communication extension: pcie, secret. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK10C: Record<string, Quiz[]> = {
  pcie: [
    {
      question: 'Why does widening a parallel bus stop paying off?',
      options: ['Every line must be valid at one clock edge, so more lines spread over more skew and the clock falls', 'Software cannot issue transfers wider than the processor\'s register, so extra lines idle', 'Wide buses draw so much power that the clock must be throttled to stay cool', 'Address and data lines must be the same width, so a wide bus needs a wide address'],
      answer: 0,
      explain: 'The receiver can only sample where every line has settled, and a wider bus has more traces to match over a bigger board. With 1 ns of skew and half a period kept for set-up, the clock stops at 500 MHz; a lane carries its clock in its data and has no such limit.',
      why: ['', 'Software copies whatever the hardware moves; the limit is in the wires, not the registers.', 'Power is a cost, but the limit the chapter computes is timing: skew against the clock period.', 'Address width and data width are separate things; neither forces the other.'],
    },
    {
      question: 'A switch corrupts a TLP in its own memory and forwards it. What does the next receiver see?',
      options: ['A good LCRC, made fresh for that link; only an end-to-end ECRC would show the damage', 'A bad LCRC, so it sends a Nak and the switch replays the original TLP', 'A bad sequence number, so it asks the switch to retrain the link', 'Nothing at all: the damaged packet is never forwarded to the next link'],
      answer: 0,
      explain: 'Sequence number and LCRC belong to one link: a switch strips them on the way in and makes new ones on the way out, so integrity is checked per hop. The optional ECRC travels with the TLP end to end and is what would catch it.',
      why: ['', 'The switch computed the LCRC over the already damaged TLP, so it matches.', 'The sequence number is assigned by the switch\'s own data link layer and is correct.', 'The switch has no way to know its memory flipped a bit, so it forwards the packet.'],
    },
  ],
  credits: [
    {
      question: 'With 8-bit header counters, CREDIT_LIMIT is 2 and CREDITS_CONSUMED is 254. How many header credits remain?',
      options: ['4', '0', '252', '256'],
      answer: 0,
      explain: 'Both counters wrap, so only the difference modulo 256 means anything: (2 − 254) mod 256 = 4. The plain comparison 2 ≥ 254 would wrongly say none are left.',
      why: ['', 'That is what comparing 2 with 254 as plain numbers would suggest, but the limit has wrapped past it.', 'That would be 254 − 2, the distance in the wrong direction.', 'The full range of the counter; a receiver never grants more than half of it at once.'],
    },
    {
      question: 'Why does an endpoint advertise infinite completion credits?',
      options: ['It only asks for answers it has room for, and a completion that had to wait could deadlock reads behind it', 'Completions are small enough that a buffer for them is never needed, so none is counted', 'A full receiver drops completions, so counting credits for them would be pointless', 'Completion data is not covered by the link\'s CRC, so it needs no flow control'],
      answer: 0,
      explain: 'Every completion answers a read the endpoint issued when it had room for the reply, so the space is already reserved. If completions waited for credits, a read waiting behind a completion that waits for a read could stall the fabric forever.',
      why: ['', 'Completions carry data and need real buffers; the room is reserved when the read is issued.', 'Nothing is dropped on PCIe: that is the point of credits.', 'Completions are TLPs like the rest, with the same LCRC.'],
    },
  ],
  replay: [
    {
      question: 'An Ack is lost on the wire. Who notices, and how?',
      options: ['The sender, when its replay timer expires with TLPs still unacknowledged', 'The receiver, which sees a gap and sends a Nak for the missing Ack', 'The transaction layer, which times out the request and retries it itself', 'The physical layer, which sees the missing symbols and retrains the lane'],
      answer: 0,
      explain: 'A Nak needs a receiver that noticed something wrong, and here it noticed nothing. The sender\'s timer runs while anything is unacknowledged and restarts on progress; when it runs out, everything unacknowledged is replayed, and the duplicate is dropped and acknowledged again.',
      why: ['', 'The receiver delivered the TLP and sent its Ack; it has no way to know the Ack was hit.', 'Retries are the data link layer\'s job; nothing above it ever learns of one.', 'Only the Ack\'s CRC failed; the lane\'s symbols were fine.'],
    },
    {
      question: 'What does REPLAY_NUM wrapping mean?',
      options: ['Four replays achieved nothing, so the link is sent through Recovery', 'The 12-bit sequence number has wrapped, so the buffer is full and must be flushed', 'Four TLPs in a row were Nak\'d, so they are now discarded for good', 'The replay timer expired once, so the TLP is given up and reported to software'],
      answer: 0,
      explain: 'Every replay, by Nak or by timer, increments the 2-bit counter and any forward progress clears it. A wrap means four tries without progress, so the link itself is suspect; the replay buffer still holds the TLP through Recovery.',
      why: ['', 'Sequence numbers wrap as a matter of course, modulo 4096, and have their own rules.', 'Nothing is discarded: the buffer keeps the TLP until it is acknowledged.', 'One expiry is just a replay; REPLAY_NUM counts them and a single one does not wrap it.'],
    },
  ],
  linktraining: [
    {
      question: 'Why must a port see eight TS1s or TS2s in a row, not just one?',
      options: ['A single one could be a noise burst that happens to look like an ordered set', 'The receiver needs eight symbols in a row to recover the lane\'s clock', 'Each ordered set carries only one bit of the lane number, so eight are needed', 'Eight sets let the ports average out the skew between lanes'],
      answer: 0,
      explain: 'Requiring a run of them is the filter: a noise burst is unlikely to repeat as eight valid ordered sets. Clock and symbol boundaries come from the line code and the comma, not from this count.',
      why: ['', 'Clock recovery works from the data\'s edges, as in a SerDes, long before this count.', 'Ordered sets are 16 symbols with fixed fields; the count is a confidence test, not a way to send a number.', 'Deskew uses the markers within a set; the eight is a guard against noise.'],
    },
    {
      question: 'Both ports have reached L0. What has not happened yet?',
      options: ['The data link layer has not exchanged InitFC, so no TLP may be sent', 'The lanes have not yet found their symbol boundaries or settled on a width', 'The two ends have not yet detected that anything is plugged in', 'Neither port has yet sent a TS1 or a TS2 to the other'],
      answer: 0,
      explain: 'Training belongs to the physical layer. Only once the link is up does the data link layer begin, with InitFC1 and InitFC2 DLLPs telling each side the other\'s buffer sizes; the first TLP may go after that.',
      why: ['', 'Boundaries come from the comma in Polling, which is long finished.', 'Detect is the first state; L0 comes after it.', 'The TS1s and TS2s are exactly what carried the ports to L0.'],
    },
  ],
  usbenum: [
    {
      question: 'Why does the host read only 8 bytes of the device descriptor first?',
      options: ['It does not know the packet size yet, and the first 8 bytes carry it', 'A device at address 0 can send no more than 8 bytes at a time', 'Those 8 bytes are all it needs to give the device an address', 'Eight bytes is the most the packet\'s CRC can protect'],
      answer: 0,
      explain: 'Packet size is a property of the device, so the host asks for the one thing it needs, the maximum packet size, at address 0, resets, and asks for the full 18 bytes after SET_ADDRESS in packets of that size.',
      why: ['', 'It is the device\'s own maximum packet size that limits it, and the host does not yet know it.', 'It gives an address whatever it read; what it needs here is the packet size. The whole descriptor is 18 bytes.', 'CRC16 on data packets is not what limits this.'],
    },
    {
      question: 'A device moves to its new address only on seeing the host\'s last ACK of SET_ADDRESS, as the chapter\'s does, and that ACK is lost. What follows?',
      options: ['They disagree on the address, and the next transaction goes unanswered', 'The device keeps answering to both addresses until the host picks one', 'The host repeats the ACK until the device answers to the new address', 'The device moves to the new address anyway once a timeout passes'],
      answer: 0,
      explain: 'The device moves only when the host acknowledges the status packet. If that ACK is lost the host believes the address changed and the device has not. A real host recovers with a reset.',
      why: ['', 'A device answers to one address at a time.', 'An ACK is a handshake in answer to a packet; the host cannot send one on its own.', 'The device\'s state changes on that acknowledgement, not on a timer.'],
    },
  ],
  aes: [
    {
      question: 'What would an attacker gain if the key were not XORed in before round 1?',
      options: ['The first round\'s steps are keyless, so they could be undone without the key', 'The first round would run with the last round key, so the order could be reversed', 'Only the last round key would then count, so a shorter search would find it', 'The key schedule would start a round late, so the round keys would be related'],
      answer: 0,
      explain: 'SubBytes, ShiftRows and MixColumns use no key. Without an initial AddRoundKey, an attacker who knew the output of round 1 could simply run those steps backwards and the round would add no strength.',
      why: ['', 'Round keys come from the schedule in order; nothing swaps them.', 'Every later round key is still used; what is lost is the protection of the first steps.', 'The schedule runs the same either way; the weakness is the keyless steps.'],
    },
    {
      question: 'Why does the S-box in the chapter\'s gates need no ROM?',
      options: ['It is the inverse in GF(2⁸) plus an affine map, built as a tower of smaller fields', 'Its 256 entries are produced by a counter feeding a tree of XOR gates', 'ShiftRows already contains the substitution, so SubBytes is only wires', 'It is a linear map over GF(2), which XOR gates alone can compute'],
      answer: 0,
      explain: 'The S-box is not arbitrary: splitting GF(256) into GF(16) and GF(4) turns the inverse into a few multiplications and an inverse in a smaller field, down to NANDs. The whole S-box is 584 NANDs and reads no memory.',
      why: ['', 'There is no counter; the output is computed from the input byte.', 'ShiftRows is wires only and moves bytes; it substitutes nothing.', 'A linear S-box would make the whole cipher linear and easy to solve; the inverse is what breaks that.'],
    },
  ],
  sha256: [
    {
      question: 'Why can anyone recompute SHA-256\'s starting values and round constants?',
      options: ['They are fractional bits of square and cube roots of primes, so nothing is hidden', 'They are derived from the digest of the message being hashed, so each run has its own', 'They are random bits that the standard publishes and nobody can check', 'They come from a fixed seed in a random generator the standard names'],
      answer: 0,
      explain: 'Constants taken from roots of primes leave no room for a designer to hide a weakness in them, which is what nothing-up-my-sleeve means. A hash has no key, and the constants are the same for every message.',
      why: ['', 'They are fixed in the standard; they do not depend on the input.', 'Because they are derived, anyone can check them, and the chapter\'s code does.', 'No generator is involved: they are roots of primes, which is the point of the choice.'],
    },
    {
      question: 'One bit of the input is flipped. About how many of the 256 digest bits change?',
      options: ['About 128, as many as differ between two unrelated digests', 'Exactly one, the digest bit that corresponds to the flipped input bit', 'About 32, a few bits in each of the eight state words', 'All 256, since any change flips the whole digest'],
      answer: 0,
      explain: 'Addition carries and the mixing rounds spread a change over the whole state, so about half the bits move. "abc" against "abb" differs in 124 of 256, and nearness of the inputs tells nothing about the digests.',
      why: ['', 'That would make a digest predictable from the input and a search for collisions easy.', 'After 64 rounds of mixing each digest bit flips with chance one half, so half of the 256.', 'A digest flipped entirely would be the old one\'s complement, as predictable as no change.'],
    },
  ],
  blockmode: [
    {
      question: 'Two 16-byte blocks of a message are equal. Under which mode are their ciphertext blocks equal too?',
      options: ['ECB, which enciphers each block alone under the same key', 'CTR, because the same key is used for every block', 'GCM, because its tag covers all blocks alike', 'None of them: AES never outputs the same block twice'],
      answer: 0,
      explain: 'ECB has nothing between blocks, so equal input blocks give equal output blocks and a flat area of a picture shows through. CTR XORs in a different counter block each time.',
      why: ['', 'CTR enciphers the counter, which changes every block, then XORs it in.', 'GCM is built on a counter mode, so its blocks differ too; the tag is separate.', 'AES is a permutation: the same input and key always give the same output.'],
    },
    {
      question: 'Two messages are enciphered in CTR under one key with the same counter values. What can an eavesdropper compute without the key?',
      options: ['The XOR of the two plaintexts, from the XOR of the ciphertexts', 'The key itself, from comparing the two ciphertexts block by block', 'Nothing: each message has its own keystream under one key', 'Only the first block of each message, since later counters differ'],
      answer: 0,
      explain: 'Both ciphertexts are the plaintext XOR the same keystream, so XORing them cancels it and leaves the XOR of the plaintexts. That is the Enigma operators\' reused settings again.',
      why: ['', 'The keystream cancels, but AES still hides the key.', 'The keystream depends only on key and counter; same counters, same keystream.', 'If every counter value repeats, every block is exposed, not just the first.'],
    },
  ],
  enigma: [
    {
      question: 'Why can the Enigma never light the lamp of the key that was pressed?',
      options: ['The pressed key has cut off its own lamp, and the reflector forces the same: a position is a set of swaps with no fixed point', 'The plugboard swaps every letter with another one before the wheels see it', 'The wheels step before the contact closes, so the letter has always moved on', 'The ring settings are chosen each day so that no letter maps to itself'],
      answer: 0,
      explain: 'Each key is a changeover switch whose rest contact goes to its own lamp; pressed, it goes to the battery. The reflector is 13 swaps, and a swap seen through any permutation is a swap, so one position is its own inverse and moves every letter.',
      why: ['', 'Only the cables actually plugged swap; most letters pass straight through, and the property holds with none.', 'Stepping changes which permutation is used, not whether it has a fixed point; every position has none.', 'A ring setting moves a notch and does not touch the property, which holds for every key.'],
    },
    {
      question: 'Why does the same key at the far end turn the ciphertext back into the plaintext?',
      options: ['At every position the permutation is its own inverse, and both machines step the same way', 'The receiving machine runs the wheels backwards through the same letters', 'The ciphertext is enciphered a second time with the plugboard removed', 'The lamp board is wired to the keys in reverse order'],
      answer: 0,
      explain: 'One position is P⁻¹ W⁻¹ U W P with the reflector U in the middle; U is 13 swaps, so the whole is a set of swaps. Pressing the cipher letter at the same position gives the plain letter back, and the same start gives the same positions.',
      why: ['', 'Nothing runs backwards at the far end: the current already goes out and back through the wheels once.', 'The plugboard stays in the path; the property comes from the reflector, not from removing a part.', 'The lamps are not reordered; the symmetry is in the permutation, not in the keyboard.'],
    },
  ],
  bombe: [
    {
      question: 'What does a contradiction, for every guess, at one wheel position show the Bombe?',
      options: ['That position is wrong for every plugboard, not just the one guessed', 'Only that the first guessed plug is wrong, so the next position is tried', 'That the crib is wrong and the whole run must start again', 'That the plugboard has more than ten cables'],
      answer: 0,
      explain: 'Each edge of the menu turns a plug guess into another through the scrambler, whose wiring is known at that position. If every guess ends with a letter plugged to more than one letter, no plugboard is consistent there, whichever way the other cables go.',
      why: ['', 'One failed guess removes only that guess; the position is out when every guess fails, and then it holds for all plugboards.', 'The crib is assumed; a wrong crib shows as no position surviving, not as contradictions at one.', 'The number of cables is not tested; the search never counts plugboards.'],
    },
    {
      question: 'Welchman\'s diagonal board added what fact to the menu\'s reasoning?',
      options: ['A plug is a swap: if a goes to u then u goes to a', 'The plugboard always has exactly ten cables', 'The middle wheel steps only when the right wheel is at its notch', 'Every message begins with the same crib'],
      answer: 0,
      explain: 'With the swap property each plug hypothesis gives two facts, so the consequences of a guess reach more of the menu and contradictions come sooner.',
      why: ['', 'The cable count is not used; the argument never counts plugboards.', 'Stepping is part of the scrambler at each position, not of the diagonal board.', 'A crib is a guess for each message; the board does not depend on it.'],
    },
  ],
  kerckhoffs: [
    {
      question: 'According to Kerckhoffs\'s principle, what should a cipher rely on keeping secret?',
      options: ['Only the key; the design may be public', 'The wiring of the machine and the procedure for using it', 'The key and the algorithm together, for extra safety', 'The test vectors, so that nobody can check an implementation'],
      answer: 0,
      explain: 'The Enigma\'s wheels and procedure were kept secret and were captured or worked out. AES publishes its design and its test vectors, and anyone can check an implementation against them.',
      why: ['', 'That is what the Enigma\'s users tried; it was captured or worked out.', 'A secret design adds nothing that lasts, since every machine and operator holds it.', 'Public test vectors are the point: they let anyone check an implementation.'],
    },
    {
      question: 'On the chapter\'s gate-level Enigma a different key means a different circuit. What does a modern cipher do instead?',
      options: ['Keeps the key in a register, apart from the public logic', 'Wires each key into its own set of gates, as the Enigma did', 'Hides the logic, so that the key need not be long', 'Stores the key in the S-box, next to the design'],
      answer: 0,
      explain: 'With the key a register, the design can be published and one circuit serves every key. The M4\'s wheel-and-ring settings alone, 4.15 × 10¹¹, fall in under 7 minutes at one key a clock; AES-128 has 2¹²⁸ keys.',
      why: ['', 'That is the problem: a new key would mean a new circuit.', 'Hiding the logic is what the principle says not to rely on.', 'The S-box is a fixed table of the public design; the key is separate data.'],
    },
  ],
  keyexchange: [
    {
      question: 'In a Diffie–Hellman exchange, what travels over the network?',
      options: ['Only the two public values; the shared secret is never sent', 'The shared secret, enciphered under the two public values', 'Both private numbers, hashed so that the watcher cannot read them', 'The shared secret, split across the two messages'],
      answer: 0,
      explain: 'Each side computes the secret from its own private number and the other\'s public value. A watcher has both public values and would have to undo an exponentiation, the discrete logarithm.',
      why: ['', 'There is no cipher to encipher it with yet; the secret is what the exchange creates.', 'Private numbers never leave their owner.', 'Nothing is sent in pieces; both sides compute the same number.'],
    },
    {
      question: 'What does using an elliptic curve change about Diffie–Hellman?',
      options: ['Points are added in place of numbers multiplied, and far smaller numbers give the same security', 'It removes the private number, so each side needs only a public one', 'It makes the shared secret authenticated, so a man in the middle is excluded', 'It makes the exchange safe against a large quantum computer'],
      answer: 0,
      explain: 'On a curve, a times a point is easy and recovering a from the result is the hard direction. X25519 works with 255-bit numbers. The exchange still says nothing about who is at the other end.',
      why: ['', 'The private number is still what each side keeps secret.', 'Authentication is a separate job done by the signature over the transcript.', 'A large quantum computer would change the hardness, since Shor\'s algorithm solves discrete logarithms.'],
    },
  ],
  tls: [
    {
      question: 'Where do almost all of the chapter\'s client\'s 81 277 693 handshake cycles go?',
      options: ['Two X25519 runs and one RSA signature check; AES and HMAC barely show', 'Encrypting the application data under AES-128-GCM, a block at a time', 'HKDF stretching the shared secret into the traffic keys', 'Hashing the transcript with SHA-256 after every message'],
      answer: 0,
      explain: 'The two X25519 runs are 69 139 884 cycles, 85 % of the total, and the 1024-bit RSA verification adds 10 310 029 more. The symmetric work that protects the data is a small fraction.',
      why: ['', 'Symmetric work is thousands of times cheaper than public-key work here.', 'The two HKDF calls take 779 480 cycles in all.', 'Hashing is cheap next to a point multiplication; SHA-256 takes 8364 cycles per 64-byte block.'],
    },
    {
      question: 'A year later the server\'s long-term signing key is stolen. What does that open?',
      options: ['Nothing recorded earlier, since the session keys came only from the exchange and were discarded', 'Every recorded session, because the key signed the handshake of each', 'Only the sessions that used the same certificate as the stolen key', 'The certificates of earlier sessions, the one thing encrypted under it'],
      answer: 0,
      explain: 'The signing key proves who the server is; it never derives a session key. With fresh keys per session this is forward secrecy, unlike a captured key list that opened everything sent under it.',
      why: ['', 'A signature authenticates; it is not a key that decrypts the traffic.', 'The certificate only names the key; the traffic was not encrypted under it.', 'Certificates go under keys from the exchange; a signing key encrypts nothing.'],
    },
  ],
};
