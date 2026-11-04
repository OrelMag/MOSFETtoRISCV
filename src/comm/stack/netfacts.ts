// The numbers chapter 50 quotes about its ping, derived in one place from the ping's own size (apps.ts pingApp) and the measurement of the gates
// (netcosts.json, scripts/net-costs.ts --write), so that the prose, the widgets and tests/comm-net-facts.test.ts cannot drift apart. DOM-free.

import NET from './netcosts.json';
import { PING_DATA } from './apps';

/** Bytes a frame takes on the wire and the clocks it holds the cable: preamble and SFD, the frame padded to 60 bytes, the FCS, then the 12-byte gap. */
export const wireBytes = (frameLen: number) => 8 + Math.max(60, frameLen) + 4;
export const wireClocks = (frameLen: number) => 32 * (wireBytes(frameLen) + 12);

/** DMA transactions the NIC makes for a frame: transmit reads two descriptor words, the buffer a word at a time and the next descriptor, and writes one back; receive reads two, writes the words, writes one (tests/comm-nic.test.ts counts them). */
export const dmaTx = (len: number) => ({ reads: 3 + Math.ceil(len / 4), writes: 1 });
export const dmaRx = (len: number) => ({ reads: 2, writes: Math.ceil(Math.max(60, len) / 4) + 1 });

interface Win { computer: 'a' | 'b'; entry: string; visited: string[]; start: number; end: number; total: { instr: number; clocks: number; loads: number; stores: number }; layers: Record<string, { clocks: number }> }
const WINDOWS = NET.windows as unknown as Win[];
/** The i-th window of work of a computer, in the order they happened: A: ARP request, ARP reply in, echo request out, echo reply in; B: ARP reply out, echo request in and the reply out. */
export const win = (computer: 'a' | 'b', i: number): Win => WINDOWS.filter((w) => w.computer === computer)[i];
export const A_ECHO_TX = win('a', 2), B_ECHO = win('b', 1), A_ECHO_RX = win('a', 3);

/** The ping's frame (Ethernet header, IPv4 header, ICMP header, data): 74 bytes, not padded. */
export const PING_FRAME = 14 + 20 + 8 + PING_DATA;
/** One ping frame on one link, preamble to FCS, and with the interframe gap (what a stream of them holds the cable for). */
export const PING_SERIAL = 32 * wireBytes(PING_FRAME);
export const PING_FRAME_TIME = wireClocks(PING_FRAME);
/** The shortest frame (60 bytes before the FCS): an ARP packet padded, or a short echo. */
export const MIN_FRAME_TIME = wireClocks(60);
/** What B's NIC moves for the ping frame, and what B's CPU spends on a request it receives and answers. */
export const PING_DMA = { send: dmaTx(PING_FRAME), receive: dmaRx(PING_FRAME) };
export const dmaTotal = (d: { reads: number; writes: number }) => d.reads + d.writes;
/** B's CPU time for one echo against the time between two such frames at line rate, in per cent. */
export const B_BUSY_PERCENT = Math.round(100 * B_ECHO.total.clocks / PING_FRAME_TIME);
/** The share of an echo request's clocks spent in get16 / put16 / get32 / put32 / ones_sum. */
export const BYTES_PERCENT = Math.round(100 * (B_ECHO.layers.bytes.clocks / B_ECHO.total.clocks));

/**
 * Where the first ping's round trip goes, from the edges of the transmitter and carrier pins of the gates. The ping's frames cross two links each way
 * (computer to switch, switch to computer); the switch starts a frame out only when it has all of it (store and forward), a few clocks after the last
 * byte. The software is what is left: A from the call to the first bit on its link, B from the last bit of the request (its NIC commits, the polling loop
 * notices) to the first bit of the reply, A from the last bit of the reply to the timestamp its program takes. The windows of the cost table run on past the
 * doorbell (while the frame is already on the cable) and past the timestamp, so their sum is more than the software's share here.
 */
export function roundTrip() {
  const w = NET.wire as unknown as Record<'aTx' | 'toB' | 'bTx' | 'toA', [number, number][]>;
  const [aTx, toB, bTx, toA] = [w.aTx[1], w.toB[1], w.bTx[1], w.toA[1]];
  const cable = [aTx, toB, bTx, toA].reduce((s, [up, down]) => s + (down - up), 0);
  const turnaround = (toB[0] - aTx[1]) + (toA[0] - bTx[1]);
  const aSend = aTx[0] - A_ECHO_TX.start;
  const bNotice = B_ECHO.start - toB[1], bWork = bTx[0] - B_ECHO.start;
  const bReply = bNotice + bWork;
  const aReceive = NET.rtt - aSend - cable - turnaround - bReply;
  return { cable, turnaround, aSend, bNotice, bWork, bReply, aReceive, software: aSend + bReply + aReceive, tails: A_ECHO_TX.total.clocks + B_ECHO.total.clocks + A_ECHO_RX.total.clocks };
}
