// The packet driver level (l_driver, act 12): a program in RV32 assembly for the computer of chapter 50 (a system CPU, RAM and a NIC at
// 0x7000_0000 with a ring of eight receive descriptors and one of eight transmit descriptors). The far end of the cable is a JavaScript
// model that sends frames to the NIC and reads what the NIC sends back; it names the first rule the driver breaks. Graded on the program's
// size and on the clocks from the end of a request on the wire to the start of its reply. No DOM.

import { BusModel } from '../bus/model';
import { crc32, fcsBytes } from '../comm/crc';
import { frameBody, frameBytes, PREAMBLE, SFD, type FrameSpec } from '../comm/ethframe';
import { NIC_REG } from '../comm/nic';
import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { rng } from './drills';
import { bursts, bytesOf, MAC_BIT, MAC_GAP } from './ethcheck';

/** Where things sit: the rings 64 bytes each at 0x1800 and 0x1880 (nothing between them is a descriptor), the buffers 1536 bytes each. */
export const DRV = { rxRing: 0x1800, txRing: 0x1880, rxBuf: 0x1900, txBuf: 0x4900, bufSize: 0x600, nic: 0x70000000, mac: [0x02, 0, 0, 0, 0, 0x0a] } as const;
const RAM_K = 13, IMEM_K = 8;
const hex = (v: number, d = 2) => `0x${(v >>> 0).toString(16).padStart(d, '0')}`;

/** Clocks of an instruction on the system CPU: one, two for a load or a store (a bus access). */
const clocksOf = (text: string): number => (/^(lw|lh|lb|lhu|lbu|sw|sh|sb)\b/.test(text) ? 2 : 1);

interface Request { spec: FrameSpec; body: number[] }
export interface DriverScenario { name: string; sizes: number[]; mode: 'one' | 'burst' }

export const DRIVER_SCENARIOS: DriverScenario[] = [
  { name: 'ten frames, one at a time (the ring wraps)', sizes: [46, 100, 46, 200, 64, 150, 46, 80, 120, 46], mode: 'one' },
  { name: 'four frames back to back', sizes: [46, 90, 46, 120], mode: 'burst' },
  { name: 'one long frame', sizes: [600], mode: 'one' },
];

const requestsOf = (s: DriverScenario, seed: number): Request[] => {
  const r = rng(seed);
  return s.sizes.map((n, k) => {
    const spec: FrameSpec = { dst: [...DRV.mac], src: [0x02, 0, 0, 0, 0, 0x20 + k], type: 0x88b5, payload: Array.from({ length: n }, () => Math.floor(r() * 256)) };
    return { spec, body: frameBody(spec) };
  });
};
/** The reply the driver owes: the same frame with the two addresses swapped. */
const replyOf = (q: number[]): number[] => [...q.slice(6, 12), ...q.slice(0, 6), ...q.slice(12)];

export const DRIVER_INIT = `# The rings: eight descriptors of two words each (buffer address, OWN | length). Receive buffers start owned by the NIC.
        li   s1, 0x70000000     # the NIC: CTRL +0, STATUS +4, IE +8, RXBASE +12, TXBASE +16, MACL +20, MACH +24, KICK +28
        li   s2, 0x1800         # receive ring
        li   s3, 0x1880         # transmit ring
        li   t0, 0
init:   slli t1, t0, 3          # 8 bytes a descriptor
        slli t3, t0, 9
        slli t4, t0, 10
        add  t3, t3, t4         # 1536 * i
        add  t2, s2, t1
        li   t4, 0x1900
        add  t4, t4, t3
        sw   t4, 0(t2)          # receive buffer i
        li   t5, 0x80000000
        sw   t5, 4(t2)          # OWN: the NIC may fill it
        add  t2, s3, t1
        li   t4, 0x4900
        add  t4, t4, t3
        sw   t4, 0(t2)          # transmit buffer i
        sw   zero, 4(t2)        # ours until we hand it over
        addi t0, t0, 1
        li   t6, 8
        blt  t0, t6, init
        sw   s2, 12(s1)         # RXBASE
        sw   s3, 16(s1)         # TXBASE
        li   t0, 0x00000002
        sw   t0, 20(s1)         # MACL: 02:00:00:00
        li   t0, 0x00000a00
        sw   t0, 24(s1)         # MACH: 00:0a
        li   t0, 1
        sw   t0, 0(s1)          # CTRL: enable`;

export const DRIVER_STARTER = `${DRIVER_INIT}
# Now serve the rings forever. s2 is the next receive descriptor, s3 the next transmit descriptor.
# For every frame the NIC has filled: send it back with the two addresses swapped (destination and source, 6 bytes each),
# hand the receive buffer back, and ring the doorbell. After descriptor 7 comes descriptor 0.
serve:  j    serve
`;

export const DRIVER_REF = `${DRIVER_INIT}
        addi s6, s2, 64         # end of the receive ring
        addi s7, s3, 64         # end of the transmit ring
poll:   lw   t0, 4(s2)          # receive descriptor, word 1
        bltz t0, poll           # OWN still set: the NIC is not done with it
        andi t2, t0, 0x7ff      # the length
        lw   t1, 0(s2)          # receive buffer
        lw   t3, 0(s3)          # transmit buffer
        lw   a0, 0(t1)          # the first 12 bytes, three words: destination and source
        lw   a1, 4(t1)
        lw   a2, 8(t1)
        srli t4, a1, 16
        slli t5, a2, 16
        or   t4, t4, t5
        sw   t4, 0(t3)
        srli t4, a2, 16
        slli t5, a0, 16
        or   t4, t4, t5
        sw   t4, 4(t3)
        srli t4, a0, 16
        slli t5, a1, 16
        or   t4, t4, t5
        sw   t4, 8(t3)
        addi t4, t2, 3
        srli t4, t4, 2
        slli t4, t4, 2
        add  t4, t1, t4         # end of the frame in the receive buffer
        addi a4, t1, 12
        addi a5, t3, 12
copy:   lw   a6, 0(a4)
        sw   a6, 0(a5)
        addi a4, a4, 4
        addi a5, a5, 4
        blt  a4, t4, copy
        li   t4, 0x80000000
        or   t4, t4, t2
        sw   t4, 4(s3)          # transmit descriptor: OWN | length
        li   t5, 1
        sw   t5, 28(s1)         # the doorbell
        li   t4, 0x80000000
        sw   t4, 4(s2)          # the receive buffer goes back to the NIC
        addi s2, s2, 8
        bne  s2, s6, rxok
        li   s2, 0x1800         # after the last descriptor, the first
rxok:   addi s3, s3, 8
        bne  s3, s7, poll
        li   s3, 0x1880
        j    poll
`;

interface RunResult { ok: boolean; why?: string; latency: number }

/** One scenario: the program on the system CPU, the NIC stepped beside it, the far end sending and listening. */
function runScenario(words: number[], s: DriverScenario, seed: number): RunResult {
  const reqs = requestsOf(s, seed);
  const wire: { rxd: number; crs: number }[] = [];
  const bus = new BusModel(RAM_K, [], 4096, { nic: { line: (e) => wire[e] ?? { rxd: 0, crs: 0 } } });
  const dev = bus.nic!;
  dev.trace = [];
  const iss = new ISS(words, { system: true, imemWords: 2 ** IMEM_K, bus });
  // what the driver did on the bus
  const kicks: number[] = [], pastRx: number[] = [], handed = new Array<number>(8).fill(0);
  let clk = 0;
  const rd0 = bus.read.bind(bus), wr0 = bus.write.bind(bus);
  bus.read = (a) => { if ((a >>> 0) >= DRV.rxRing + 64 && (a >>> 0) < DRV.txRing) pastRx.push(a >>> 0); return rd0(a); };
  bus.write = (a, v, st) => {
    if ((a >>> 28) === 7 && ((a >>> 2) & 7) === NIC_REG.KICK / 4) kicks.push(clk);
    if ((a >>> 0) >= DRV.rxRing + 64 && (a >>> 0) < DRV.txRing) pastRx.push(a >>> 0);
    const d = ((a >>> 0) - DRV.rxRing - 4) / 8;
    if (Number.isInteger(d) && d >= 0 && d < 8 && (v >>> 31) === 1) handed[d]++;
    return wr0(a, v, st);
  };
  const ends: number[] = [];
  const send = (k: number, at: number): number => {
    const bytes = [...PREAMBLE, SFD, ...frameBytes(reqs[k].spec)];
    while (wire.length < at) wire.push({ rxd: 0, crs: 0 });
    for (const byte of bytes) for (let b = 0; b < 8; b++) for (let c = 0; c < MAC_BIT; c++) wire.push({ rxd: (byte >> b) & 1, crs: 1 });
    ends[k] = wire.length;
    return wire.length;
  };
  const firstAt = 3000;
  let next = 0, done = 0, scanned = 1, lastEnd = 0, steps = 0, err: string | undefined;
  if (s.mode === 'burst') { let at = firstAt; reqs.forEach((_, k) => { at = send(k, at) + MAC_GAP; }); next = reqs.length; } else { send(0, firstAt); next = 1; }
  lastEnd = Math.max(...ends.filter((x) => x !== undefined));
  while (steps < 3_000_000) {
    dev.advanceTo(clk);
    const t = dev.trace!;
    for (; scanned < t.length; scanned++) if (t[scanned - 1].txen && !t[scanned].txen) done++;
    if (s.mode === 'one' && next < reqs.length && done >= next) { send(next, clk + 600); next++; lastEnd = wire.length; }
    if (done >= reqs.length && next === reqs.length && clk > lastEnd + 3000) break;
    if (clk > lastEnd + 100_000 && (next === reqs.length || done < next)) break;
    if (iss.halted) { err = `the program stopped at ${hex(iss.pc, 4)} (it must serve the rings forever)`; break; }
    bus.now = clk;
    const info = iss.step();
    clk += clocksOf(info.text);
    steps++;
  }
  dev.advanceTo(clk);
  // ---- judge the trace
  const t = dev.trace!;
  const bs = bursts(t.map((x) => x.txd), t.map((x) => x.txen));
  // rules that explain a failure better than the symptom does, in order
  let hint: string | undefined;
  if (!err) {
    const nd = (d: number) => reqs.filter((_, k) => k % 8 === d).length;
    const early = kicks.findIndex((c, i) => ends[i] === undefined || c < ends[i]);
    if (pastRx.length) hint = `the driver touched ${hex(pastRx[0], 4)}, past the end of the receive ring (8 descriptors of 8 bytes from ${hex(DRV.rxRing, 4)}): after descriptor 7 comes descriptor 0`;
    else if (handed.some((n, d) => n < 1 + nd(d))) hint = `receive descriptor ${handed.findIndex((n, d) => n < 1 + nd(d))} was never handed back after its frame: set OWN (bit 31 of word 1) again when you are done with the buffer, or the NIC finds nothing it owns and the ring runs dry`;
    else if (early >= 0) hint = `the doorbell was rung for frame ${early + 1} at clock ${kicks[early]}, ${ends[early] === undefined ? 'before it was sent' : `before it had finished arriving (clock ${ends[early]})`}: the NIC clears OWN in the receive descriptor when the whole frame is in, and the driver reads the frame only then`;
  }
  if (hint) return { ok: false, why: hint, latency: 0 };
  let latency = 0;
  for (let k = 0; k < reqs.length; k++) {
    const who = `frame ${k + 1} of ${reqs.length} (${reqs[k].body.length} bytes)`;
    const b = bs[k];
    if (!b) {
      if (err) return { ok: false, why: `no reply to ${who}: ${err}`, latency: 0 };
      if (ends[k] === undefined) return { ok: false, why: `${who} was never sent: the replies before it did not finish`, latency: 0 };
      const t0 = ends[k];
      if (pastRx.length) return { ok: false, why: `no reply to ${who}: the driver read or wrote at ${hex(pastRx[0], 4)}, past the end of the receive ring (8 descriptors of 8 bytes from ${hex(DRV.rxRing, 4)}): after descriptor 7 comes descriptor 0`, latency: 0 };
      if (dev.core.sMiss) return { ok: false, why: `no reply to ${who}: the NIC found no receive descriptor it owned (STATUS.MISS): hand each receive buffer back with OWN set (word 1 = 0x80000000) once its frame is sent`, latency: 0 };
      const kicked = kicks.filter((c) => c >= t0 - 20_000).length;
      if (kicks.length < k + 1) return { ok: false, why: `no reply to ${who}: the doorbell (KICK, the NIC's register at +28) was rung ${kicks.length} time${kicks.length === 1 ? '' : 's'}; the NIC sends nothing until it is told there is a descriptor`, latency: 0 };
      void kicked;
      return { ok: false, why: `no reply to ${who} within ${120_000} clocks of the last request: the transmit descriptor must hold OWN | length (word 1) and the buffer address (word 0) before the doorbell`, latency: 0 };
    }
    const end = b.start + b.bits.length * MAC_BIT;
    if (b.start < ends[k]) return { ok: false, why: `the reply to ${who} began at clock ${b.start}, before the frame had finished arriving at ${ends[k]}: the NIC clears OWN in the receive descriptor when the whole frame is in, and a driver reads the frame only then`, latency: 0 };
    const got = bytesOf(b.bits), want = [...PREAMBLE, SFD, ...replyOf(reqs[k].body)];
    want.push(...fcsBytes(crc32(replyOf(reqs[k].body))));
    if (got.length !== want.length) return { ok: false, why: `the reply to ${who} is ${got.length - 8 - 4} bytes, expected ${reqs[k].body.length}: the transmit descriptor's length is the frame's length (OWN | length in word 1)`, latency: 0 };
    for (let j = 8; j < got.length; j++) {
      if (got[j] === want[j]) continue;
      const i = j - 8;
      const field = i < 6 ? 'destination address (the requester\'s source address)' : i < 12 ? 'source address (this NIC\'s)' : i < got.length - 12 ? `payload byte ${i - 14}` : 'FCS';
      return { ok: false, why: `the reply to ${who}: byte ${i} (${field}) is ${hex(got[j])}, expected ${hex(want[j])}: the reply is the request with its two addresses swapped`, latency: 0 };
    }
    void end;
    latency += b.start - ends[k];
  }
  if (bs.length > reqs.length) return { ok: false, why: `${bs.length} frames came back for ${reqs.length} requests: each descriptor is handed over once`, latency: 0 };
  return { ok: true, latency: Math.round(latency / reqs.length) };
}

export interface NicRun { ok: boolean; errors: { line: number; message: string }[]; results: { name: string; ok: boolean; why?: string; steps: number }[]; size: number; cycles: number }

/** Every scenario on a source: the size in words and the mean clocks from a request's end to its reply's start. Never throws. */
export function runNicPuzzle(src: string): NicRun {
  const a = assemble(src);
  const size = a.words.length;
  if (a.errors.length) return { ok: false, errors: a.errors, results: [], size, cycles: 0 };
  if (size > 2 ** IMEM_K) return { ok: false, errors: [{ line: 1, message: `${size} words: the instruction memory holds ${2 ** IMEM_K}` }], results: [], size, cycles: 0 };
  const results = DRIVER_SCENARIOS.map((s, i) => {
    try {
      const r = runScenario(a.words, s, 5100 + i);
      return { name: s.name, ok: r.ok, ...(r.why ? { why: r.why } : {}), steps: r.latency };
    } catch (e) {
      return { name: s.name, ok: false, why: `the simulation stopped: ${(e as Error).message}`, steps: 0 };
    }
  });
  const ok = results.every((r) => r.ok);
  return { ok, errors: [], results, size, cycles: Math.ceil(results.reduce((x, r) => x + r.steps, 0) / results.length) };
}
