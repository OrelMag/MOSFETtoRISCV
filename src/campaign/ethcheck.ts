// The benches of act 12's Ethernet levels (chapters carriers and serial). The far end of a link is a JavaScript model that knows the rules and names the
// first one a circuit breaks: a receiver that decodes the wire a bit at a time and checks every field of a frame, a sender of good and bad
// frames that expects the byte stream and the verdict, and a learning switch's model that knows who is where. Lanes of a BitSim run one
// scenario each. No DOM.

import type { CustomRun } from '../editor/challenges';
import type { ComponentDef } from '../sim/types';
import { crc32, fcsBytes } from '../comm/crc';
import { FCS_BYTES, frameBody, frameBytes, PREAMBLE, SFD, type FrameSpec } from '../comm/ethframe';
import { finish, hex, simOf } from './commcheck';
import { rng } from './drills';

/** A bit lasts this many clocks on the line, a byte 32; the quiet between frames is 96 bit times. */
export const MAC_BIT = 4;
export const MAC_GAP = 96 * MAC_BIT;
const BYTE_CLOCKS = 8 * MAC_BIT;

// ---- l_mac ------------------------------------------------------------------------------------------------------------------

const spec = (r: () => number, payload: number, tag = 0): FrameSpec => ({
  dst: Array.from({ length: 6 }, () => Math.floor(r() * 256)), src: [0x02, 0, 0, 0, 0, 1 + tag], type: 0x88b5,
  payload: Array.from({ length: payload }, () => Math.floor(r() * 256)),
});
/** What the byte stream carries into the MAC: destination to the last payload byte, no pad, no FCS. */
const streamOf = (f: FrameSpec): number[] => [...f.dst, ...f.src, (f.type >> 8) & 255, f.type & 255, ...Array.from(f.payload)];

export const MAC_TX_LANES: { name: string; frames: FrameSpec[] }[] = (() => {
  const r = rng(4801);
  const mk = (...n: number[]) => n.map((p, i) => spec(r, p, i));
  return [
    { name: 'a frame with no payload (padded to 60 bytes)', frames: mk(0) },
    { name: 'a frame of 1 payload byte, then one of 46 (no pad needed)', frames: mk(1, 46) },
    { name: 'a frame of 45 bytes (one pad byte), then 47', frames: mk(45, 47) },
    { name: 'two frames of 100 bytes, back to back', frames: mk(100, 100) },
    { name: 'a frame of 140 bytes', frames: mk(140) },
    { name: 'frames of 10, 60 and 30 bytes', frames: mk(10, 60, 30) },
  ];
})();

export interface Burst { start: number; bits: number[]; ragged: number }

/** The transmissions on a lane's line: from txen rising to txen falling, each bit read from its four clocks. */
export function bursts(txd: number[], txen: number[]): Burst[] {
  const out: Burst[] = [];
  for (let c = 0; c < txen.length; c++) {
    if (!txen[c] || (c > 0 && txen[c - 1])) continue;
    let e = c;
    while (e < txen.length && txen[e]) e++;
    const bits: number[] = [];
    let ragged = -1;
    for (let b = 0; b + MAC_BIT <= e - c; b += MAC_BIT) {
      const s = txd.slice(c + b, c + b + MAC_BIT);
      if (s.some((x) => x !== s[0]) && ragged < 0) ragged = c + b;
      bits.push(s[0]);
    }
    out.push({ start: c, bits, ragged: (e - c) % MAC_BIT ? c : ragged });
    c = e;
  }
  return out;
}
export const bytesOf = (bits: number[]): number[] => Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => bits.slice(8 * i, 8 * i + 8).reduce((v, b, j) => v | (b << j), 0));

function checkWire(name: string, bs: Burst[], frames: FrameSpec[], fails: string[]): void {
  const bad = (m: string) => { if (!fails.some((f) => f.startsWith(name))) fails.push(`${name}: ${m}`); };
  if (bs.length < frames.length) return bad(`${bs.length} of the ${frames.length} frames came out on the line (txen never rose again; the byte stream's valid and last go with ready)`);
  if (bs.length > frames.length) return bad(`${bs.length} transmissions for ${frames.length} frames: something sent a frame twice`);
  bs.forEach((b, i) => {
    const who = `frame ${i + 1}`;
    if (b.ragged >= 0) return bad(`${who}: txd changes inside a bit near clock ${b.ragged}: every bit lasts ${MAC_BIT} clocks, and txen rises and falls on a bit boundary`);
    if (b.bits.length % 8) return bad(`${who}: ${b.bits.length} bits on the line: a frame is a whole number of bytes`);
    const got = bytesOf(b.bits), want = [...PREAMBLE, SFD, ...frameBytes(frames[i])];
    for (let j = 0; j < Math.min(got.length, want.length); j++) {
      if (got[j] === want[j]) continue;
      if (j < PREAMBLE.length) return bad(`${who}: preamble byte ${j + 1} is ${hex(got[j])}, expected ${hex(want[j])}: seven bytes of 0x55 (alternating bits, least significant bit first) let the far end find the bit clock`);
      if (j === PREAMBLE.length) return bad(`${who}: the byte after the preamble is ${hex(got[j])}, expected the start-of-frame delimiter ${hex(SFD)}`);
      const k = j - PREAMBLE.length - 1, bodyLen = frameBody(frames[i]).length;
      if (k >= bodyLen) return bad(`${who}: FCS byte ${k - bodyLen + 1} is ${hex(got[j])}, expected ${hex(want[j])} (the FCS is the complement of the CRC-32 register over destination to pad, 0xEDB88320, least significant byte first)`);
      if (k >= streamOf(frames[i]).length) return bad(`${who}: pad byte ${k - streamOf(frames[i]).length + 1} is ${hex(got[j])}, expected 0x00: a frame is padded with zeros up to 60 bytes before the FCS`);
      return bad(`${who}: byte ${k} of the frame is ${hex(got[j])}, expected ${hex(want[j])}: the bytes of the stream go out in order, each least significant bit first`);
    }
    if (got.length !== want.length) {
      const bodyLen = frameBody(frames[i]).length;
      return bad(`${who}: ${got.length - PREAMBLE.length - 1} bytes after the SFD, expected ${want.length - PREAMBLE.length - 1} (${bodyLen} with the pad up to 60, and the ${FCS_BYTES} bytes of FCS)`);
    }
    if (i > 0) {
      const gap = b.start - (bs[i - 1].start + bs[i - 1].bits.length * MAC_BIT);
      if (gap < MAC_GAP) bad(`${who} starts ${gap} clocks after the previous frame ended: the line is quiet for at least 96 bit times (${MAC_GAP} clocks) between frames`);
    }
  });
}

/** Rx scenarios: the far end sends these wire frames (a byte list from the first preamble byte) with the quiet of 96 bit times between. */
interface RxFrame { wire: number[]; body: number[]; err: 0 | 1; what: string }

/** A payload for which the frame's last FCS byte is `end` (the previous frame's last shift register contents when the next preamble starts). */
function frameEnding(end: number, r: () => number, payload = 30): FrameSpec {
  for (let n = 0; n < 20000; n++) {
    const f = spec(r, payload);
    if (fcsBytes(crc32(frameBody(f)))[3] === end) return f;
  }
  throw new Error(`no frame ends in ${end}`);
}
const good = (f: FrameSpec, what: string, pre = PREAMBLE.length): RxFrame => ({ wire: [...Array(pre).fill(0x55), SFD, ...frameBytes(f)], body: frameBody(f), err: 0, what });
function broken(f: FrameSpec, at: number, bit: number, what: string): RxFrame {
  const bytes = frameBytes(f);
  bytes[at] ^= 1 << bit;
  return { wire: [...PREAMBLE, SFD, ...bytes], body: frameBody(f), err: 1, what };
}
function runt(r: () => number): RxFrame {
  const body = spec(r, 0).dst.concat([2, 0, 0, 0, 0, 9, 0x88, 0xb5, 1, 2, 3, 4]);
  return { wire: [...PREAMBLE, SFD, ...body, ...fcsBytes(crc32(body))], body, err: 1, what: 'a runt of 22 bytes with a good FCS' };
}

export const MAC_RX_LANES: { name: string; frames: RxFrame[] }[] = (() => {
  const r = rng(4802);
  const d = (n: number, t = 0) => spec(r, n, t);
  const aa = frameEnding(0xaa, r), ab = frameEnding(0xab, r);
  return [
    { name: 'one good frame', frames: [good(d(46), 'a good frame of 64 bytes')] },
    { name: 'good frames of different lengths', frames: [good(d(0), 'a padded frame'), good(d(100), 'a frame of 118 bytes'), good(d(47), 'a frame of 65 bytes')] },
    { name: 'a bad FCS', frames: [broken(d(46), 20, 3, 'a frame with a flipped data bit')] },
    { name: 'a flipped bit in the FCS itself', frames: [broken(d(46), 62, 5, 'a frame with a flipped FCS bit')] },
    { name: 'good, bad, good', frames: [good(d(30), 'the frame before'), broken(d(30), 14, 0, 'the damaged frame'), good(d(30), 'the frame after')] },
    { name: 'a runt', frames: [runt(r), good(d(46), 'a good frame after the runt')] },
    { name: 'a short preamble', frames: [good(d(46), 'a frame with a 4-byte preamble', 4), good(d(46), 'a frame with a 6-byte preamble', 6)] },
    { name: 'frames after one whose FCS ends in 0xAA and 0xAB', frames: [good(aa, 'a frame whose FCS ends in 0xAA'), good(d(30), 'the frame after it'), good(ab, 'a frame whose FCS ends in 0xAB'), good(d(30), 'the frame after it')] },
    { name: 'a payload full of 0xD5', frames: [good({ ...d(40), payload: Array(40).fill(0xd5) }, 'a payload of start-of-frame delimiters'), good(d(40), 'the frame after it')] },
    { name: 'a payload of 0x55 and 0xAA', frames: [good({ ...d(50), payload: Array.from({ length: 50 }, (_, i) => (i & 1 ? 0xaa : 0x55)) }, 'a payload that looks like a preamble'), broken(d(50), 30, 7, 'then a damaged frame')] },
  ];
})();

export function runMac(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the MAC is gates'], tested: 0 };
  const pins = ['clk', 'rst', 'data', 'valid', 'last', 'rxd', 'crs', 'ready', 'txd', 'txen', 'rdata', 'rvalid', 'rlast', 'rerr'];
  const fails: string[] = [];
  // ---- the sending half: the far end is a receiver that reads the wire a bit at a time
  const tx = simOf(def, pins);
  if (typeof tx === 'string') return { failures: [tx], tested: 0 };
  const lanes = MAC_TX_LANES, n = lanes.length;
  const fi = new Array<number>(n).fill(0), bi = new Array<number>(n).fill(0);
  const txd: number[][] = lanes.map(() => []), txen: number[][] = lanes.map(() => []);
  const need = Math.max(...lanes.map((l) => l.frames.reduce((s, f) => s + (PREAMBLE.length + 1 + frameBody(f).length + FCS_BYTES) * BYTE_CLOCKS + MAC_GAP, MAC_GAP)));
  tx.setInput('rxd', 0); tx.setInput('crs', 0);
  for (let c = 0; c < need + 600; c++) {
    tx.setInput('rst', c < 2 ? 1 : 0);
    const data = lanes.map((l, i) => (fi[i] < l.frames.length ? streamOf(l.frames[fi[i]])[bi[i]] : 0));
    const valid = lanes.map((l, i) => (fi[i] < l.frames.length ? 1 : 0));
    const last = lanes.map((l, i) => (fi[i] < l.frames.length && bi[i] === streamOf(l.frames[fi[i]]).length - 1 ? 1 : 0));
    tx.setInput('data', data); tx.setInput('valid', valid); tx.setInput('last', last);
    tx.settle();
    const ready = tx.get('ready', n), d = tx.get('txd', n), en = tx.get('txen', n);
    for (let i = 0; i < n; i++) {
      txd[i].push(d[i]); txen[i].push(en[i]);
      if (c >= 2 && valid[i] && ready[i]) { if (last[i]) { fi[i]++; bi[i] = 0; } else bi[i]++; }
    }
    tx.cycle();
  }
  lanes.forEach((l, i) => checkWire(`sending ${l.name}`, bursts(txd[i], txen[i]), l.frames, fails));
  // ---- the receiving half: the far end sends good and damaged frames and expects the bytes and the verdict
  const rx = simOf(def, pins);
  if (typeof rx === 'string') return { failures: [rx], tested: 0 };
  const rl = MAC_RX_LANES, m = rl.length;
  const wire: { rxd: number[]; crs: number[] }[] = rl.map((l) => {
    const rxd: number[] = [], crs: number[] = [];
    const quiet = (k: number) => { for (let j = 0; j < k; j++) { rxd.push(0); crs.push(0); } };
    quiet(MAC_GAP);
    for (const f of l.frames) {
      for (const byte of f.wire) for (let b = 0; b < 8; b++) for (let k = 0; k < MAC_BIT; k++) { rxd.push((byte >> b) & 1); crs.push(1); }
      quiet(MAC_GAP);
    }
    return { rxd, crs };
  });
  const len = Math.max(...wire.map((w) => w.rxd.length)) + 400;
  const got: { bytes: number[]; err: number }[][] = rl.map(() => []);
  const open: number[][] = rl.map(() => []);
  rx.setInput('data', 0); rx.setInput('valid', 0); rx.setInput('last', 0);
  for (let c = 0; c < len; c++) {
    rx.setInput('rst', c < 2 ? 1 : 0);
    rx.setInput('rxd', wire.map((w) => w.rxd[c] ?? 0)); rx.setInput('crs', wire.map((w) => w.crs[c] ?? 0));
    rx.settle();
    const v = rx.get('rvalid', m), dd = rx.get('rdata', m), la = rx.get('rlast', m), er = rx.get('rerr', m);
    for (let i = 0; i < m; i++) {
      if (!v[i] || c < 2) continue;
      open[i].push(dd[i]);
      if (la[i]) { got[i].push({ bytes: open[i], err: er[i] }); open[i] = []; }
    }
    rx.cycle();
  }
  rl.forEach((l, i) => {
    const name = `receiving ${l.name}`;
    const bad = (msg: string) => { if (!fails.some((f) => f.startsWith(name))) fails.push(`${name}: ${msg}`); };
    l.frames.forEach((f, k) => {
      const g = got[i][k];
      if (!g) return bad(`${f.what}${k ? ` (frame ${k + 1})` : ''} never ended: ${got[i].length} of ${l.frames.length} frames came out with last = 1. Every frame on the wire, good or bad, ends with rlast`);
      if (f.err === 0 && g.err) return bad(`${f.what}${k ? ` (frame ${k + 1})` : ''} is a good frame but rerr = 1 at its last byte${/0xA[AB]/.test(f.what) || k > 0 ? ': the receiver must start every frame clean, whatever the one before it ended with' : ': a frame is good when the CRC-32 over destination to FCS leaves 0xDEBB20E3'}`);
      if (f.err === 1 && !g.err) return bad(`${f.what}${k ? ` (frame ${k + 1})` : ''} is damaged but rerr = 0 at its last byte: a frame is good only when the CRC-32 over destination to FCS leaves 0xDEBB20E3, and a runt (under 64 bytes) is never good`);
      if (f.err === 0) {
        const j = g.bytes.findIndex((b, q) => b !== f.body[q]);
        if (j >= 0 || g.bytes.length !== f.body.length) return bad(`${f.what}: ${g.bytes.length} bytes came out, expected ${f.body.length}${j >= 0 ? `; byte ${j} is ${hex(g.bytes[j])}, expected ${hex(f.body[j])}` : ''}: the stream is the frame from the destination address to its last byte, without preamble, SFD and FCS`);
      }
    });
    if (got[i].length > l.frames.length) bad(`${got[i].length} frames came out for ${l.frames.length} sent`);
  });
  return finish(fails, n + m, def);
}

// ---- l_switch ---------------------------------------------------------------------------------------------------------------

export const SWITCH_PORTS = 4;
interface Hdr { inport: number; src: number; dst: number; bad: number }

/** The far end's idea of the switch: a four-entry table that learns the source of every good frame (a full table overwrites in turn). */
export class SwitchBrainModel {
  slots: ({ k: number; p: number } | undefined)[] = Array(4).fill(undefined);
  w = 0;
  /** The output set of a frame, then the learning. */
  frame(h: Hdr): number {
    const hit = this.slots.find((s) => s && s.k === h.dst);
    const flood = h.dst === 0xff || !hit;
    const mask = h.bad ? 0 : flood ? 15 & ~(1 << h.inport) : hit && hit.p !== h.inport ? 1 << hit.p : 0;
    if (!h.bad && h.src !== 0xff) {
      const own = this.slots.find((s) => s && s.k === h.src);
      if (own) own.p = h.inport;
      else { this.slots[this.w] = { k: h.src, p: h.inport }; this.w = (this.w + 1) & 3; }
    }
    return mask;
  }
}

const ports = (m: number): string => (m ? [0, 1, 2, 3].filter((p) => (m >> p) & 1).join(', ') : 'none');
const A = 0x10, B = 0x11, C = 0x12, D = 0x13;
const bcast = (inport: number, src: number): Hdr => ({ inport, src, dst: 0xff, bad: 0 });
const to = (inport: number, src: number, dst: number, bad = 0): Hdr => ({ inport, src, dst, bad });

export const SWITCH_LANES: { name: string; frames: (Hdr | null)[] }[] = (() => {
  const teach = [bcast(0, A), bcast(1, B), bcast(2, C), bcast(3, D)];
  const pairs: Hdr[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) pairs.push(to(i, A + i, A + j));
  const r = rng(4901);
  const random = (seed: number): (Hdr | null)[] => {
    const q = rng(seed), out: (Hdr | null)[] = [];
    for (let t = 0; t < 60; t++) {
      if (q() < 0.2) { out.push(null); continue; }
      const p = Math.floor(q() * 4), st = [A, B, C, D, 0x14, 0x15][Math.floor(q() * 6)], dt = q() < 0.1 ? 0xff : [A, B, C, D, 0x14, 0x15][Math.floor(q() * 6)];
      out.push({ inport: p, src: st, dst: dt, bad: q() < 0.12 ? 1 : 0 });
    }
    return out;
  };
  void r;
  return [
    { name: 'four hosts announce themselves, then every pair talks', frames: [...teach, ...pairs] },
    { name: 'a host talks to one nobody has heard from yet', frames: [bcast(0, A), to(0, A, B), to(0, A, C), to(1, B, A), to(0, A, B)] },
    { name: 'two hosts behind one port', frames: [bcast(1, A), bcast(1, B), to(1, A, B), to(1, B, A), bcast(3, C), to(1, A, C), to(3, C, B)] },
    { name: 'a host moves to another port', frames: [bcast(0, A), bcast(1, B), to(1, B, A), to(2, A, B), to(1, B, A), to(0, C, A)] },
    { name: 'damaged frames teach nothing and go nowhere', frames: [bcast(0, A), to(3, D, A, 1), to(1, B, D), to(1, B, A, 1), to(3, D, A), to(1, B, D), bcast(2, A, ) as Hdr] },
    { name: 'a damaged frame from a moved host does not move it', frames: [bcast(0, A), bcast(1, B), to(2, A, B, 1), to(1, B, A), to(0, A, B)] },
    { name: 'the broadcast address is never learned, and always floods', frames: [bcast(0, A), bcast(1, 0xff), to(2, C, 0xff), to(1, B, A), to(3, 0xff, A)] },
    { name: 'a fifth host overwrites the oldest entry', frames: [...teach, bcast(0, 0x14), to(1, B, A), to(1, B, 0x14), to(0, 0x14, C), to(1, B, D), bcast(2, 0x15), to(0, A, B)] },
    { name: 'a frame to the host itself', frames: [bcast(2, A), to(2, A, A), to(1, B, A), to(2, A, A)] },
    { name: 'frames on consecutive clocks, with and without gaps', frames: [bcast(0, A), bcast(1, B), to(0, A, B), to(1, B, A), null, null, to(0, A, B), bcast(2, C), to(2, C, A), to(3, D, C), to(0, A, D)] },
    { name: 'random traffic 1', frames: random(11) }, { name: 'random traffic 2', frames: random(12) },
    { name: 'random traffic 3', frames: random(13) }, { name: 'random traffic 4', frames: random(14) },
  ];
})();

export function runSwitch(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the table is gates'], tested: 0 };
  const sim = simOf(def, ['clk', 'rst', 'go', 'inport', 'src', 'dst', 'bad', 'mask', 'ovalid']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const lanes = SWITCH_LANES, n = lanes.length, fails: string[] = [];
  const models = lanes.map(() => new SwitchBrainModel());
  const len = Math.max(...lanes.map((l) => l.frames.length));
  const quiet = (i: number, m: string) => { if (!fails.some((f) => f.startsWith(lanes[i].name))) fails.push(`${lanes[i].name}: ${m}`); };
  const prior: (Hdr | null)[][] = lanes.map(() => []);
  for (let t = 0; t < len + 3; t++) {
    const h = lanes.map((l) => (t >= 1 && t <= l.frames.length ? l.frames[t - 1] : null));
    sim.setInput('rst', t === 0 ? 1 : 0);
    sim.setInput('go', h.map((x) => (x ? 1 : 0)));
    sim.setInput('inport', h.map((x) => x?.inport ?? 0)); sim.setInput('src', h.map((x) => x?.src ?? 0));
    sim.setInput('dst', h.map((x) => x?.dst ?? 0)); sim.setInput('bad', h.map((x) => x?.bad ?? 0));
    sim.cycle();
    const mask = sim.get('mask', n), ov = sim.get('ovalid', n);
    for (let i = 0; i < n; i++) {
      const x = h[i];
      if (t === 0) continue;
      if (!x) { if (ov[i] || mask[i]) quiet(i, `clock ${t}: ovalid = ${ov[i]}, mask = ${ports(mask[i])} with go = 0: nothing is decided without a go`); continue; }
      const want = models[i].frame(x);
      if (!ov[i]) { quiet(i, `clock ${t}: ovalid = 0 in the clock after go: the answer comes in the clock the frame's header is taken`); continue; }
      prior[i].push(x);
      if (mask[i] === want) continue;
      const fr = `frame ${prior[i].length} (host ${hex(x.src)} to ${x.dst === 0xff ? 'everyone' : `host ${hex(x.dst)}`}, in on port ${x.inport}${x.bad ? ', FCS bad' : ''})`;
      const flood = 15 & ~(1 << x.inport);
      let why: string;
      if (x.bad && mask[i]) why = 'a frame with a bad FCS goes nowhere (and teaches the table nothing)';
      else if ((mask[i] >> x.inport) & 1) why = `it went back out of port ${x.inport}, the one it came in on: never send a frame back where it came from`;
      else if (want === 0 && !x.bad) why = 'the destination is on the port the frame came in on: the segment behind it already has the frame, filter it';
      else if (want !== flood && want !== 0 && (mask[i] & want) === want) why = 'the destination is known: send the frame out of its port alone, not to everyone (an unnecessary flood)';
      else if (want === flood && mask[i] !== flood) why = 'the destination is unknown (a broadcast, or never heard from, or heard only in a damaged frame): flood every port but the input';
      else why = 'a host is found at the port it spoke from last; a full table of four overwrites in turn, oldest first';
      quiet(i, `${fr}: mask = ${ports(mask[i])}, expected ${ports(want)}: ${why}`);
    }
  }
  return finish(fails, n, def);
}
