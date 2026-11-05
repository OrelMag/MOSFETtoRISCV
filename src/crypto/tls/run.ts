// The harness: runs the compiled TLS client on the golden model (FastISS as the RV32IM system CPU) and shuttles its bytes. DOM-free, and no node: imports,
// so a widget can drive it in the browser. runTlsClient is an async generator of events (every record sent and received, each derived secret and transcript
// hash, the phase boundaries, the primitives' cycles) that returns the result; a transport is two functions, so the server can be a canned flight, a model, a
// man in the middle or a socket. The CPU is given its randomness and private key (cfg) and nothing else: the run is deterministic and replayable.

import { fullBuild, globalAddr } from './build';
import type { HelloOffer } from './hello';
import { CFG, CMD, ERR, errName, MARK, MARK_END, MEM, SECRET_SLOTS, secretAddr, type ErrName, type SecretName } from './layout';
import { TlsMachine, type Mark } from './machine';

export interface Transport {
  /** The client wrote these bytes (one record per call). */
  send(b: Uint8Array): void | Promise<void>;
  /** At most n bytes (at least 1) from the server; an empty array is the end of the stream. */
  recv(n: number): Uint8Array | Promise<Uint8Array>;
}

export interface TlsConfig {
  /** ClientHello.random (32 bytes) and the x25519 private key (32 bytes): the client's entropy, injected. */
  random: Uint8Array;
  privateKey: Uint8Array;
  /** SHA-256 of the server's SubjectPublicKeyInfo DER. Without it no certificate is trusted or distrusted: any key is accepted. */
  pin?: Uint8Array;
  offer: HelloOffer;
}

/** What the client does once the handshake is through. */
export type AppStep = { send: Uint8Array } | { recv: number } | { recvUntilClose: true } | { close: true };

export interface Tamper {
  /** Flip bits of byte `byte` (of the whole record, header included; 5 is the first body byte) of the server's record number `record` (0 is the first record the server sent). */
  flip?: { record: number; byte: number; mask?: number };
}

export interface RunOptions {
  config: TlsConfig;
  transport: Transport;
  app?: readonly AppStep[];
  tamper?: Tamper;
  /** Instructions per slice before the harness gives the event loop a turn. */
  slice?: number;
  /** Stop after this many instructions in one command (a runaway guard). */
  budget?: number;
}

export const PHASES = ['client_hello', 'server_hello', 'key_agreement', 'encrypted_extensions', 'certificate', 'certificate_verify', 'server_finished', 'client_finished'] as const;
export type PhaseName = (typeof PHASES)[number];
export const PRIMS = { [MARK.pX25519]: 'x25519', [MARK.pRsa]: 'rsa_pss', [MARK.pGcmOpen]: 'gcm_open', [MARK.pGcmSeal]: 'gcm_seal', [MARK.pHkdf]: 'hkdf', [MARK.pSha]: 'sha256', [MARK.pHmac]: 'hmac' } as Record<number, string>;
export type PrimName = 'x25519' | 'rsa_pss' | 'gcm_open' | 'gcm_seal' | 'hkdf' | 'sha256' | 'hmac';

export type TlsEvent =
  | { kind: 'phase'; name: PhaseName; cycles: number; instrs: number }
  | { kind: 'send' | 'recv'; bytes: Uint8Array; cycles: number; phase: PhaseName | 'app' }
  | { kind: 'secret'; name: SecretName; value: Uint8Array; cycles: number }
  | { kind: 'prim'; name: PrimName; start: number; cycles: number; phase: PhaseName | 'app' }
  | { kind: 'app'; step: AppStep; data?: Uint8Array; cycles: number }
  | { kind: 'done'; ok: boolean; error: ErrName | `unknown(${number})`; code: number; alert: number; cycles: number };

export interface TlsResult {
  ok: boolean;
  error: ErrName | `unknown(${number})`;
  code: number;
  /** The alert description the server sent, when `error` is alert. */
  alert: number;
  /** Cycles and instructions of the whole handshake and of each phase (the system CPU's mtime: one per instruction, 34 per divide). */
  handshake: { cycles: number; instrs: number };
  phases: { name: PhaseName; cycles: number; instrs: number }[];
  /** Per primitive, nested inside phases: calls and cycles (not additive: HKDF contains HMAC contains SHA). */
  prims: Partial<Record<PrimName, { calls: number; cycles: number }>>;
  secrets: Partial<Record<SecretName, Uint8Array>>;
  sent: Uint8Array[];
  received: Uint8Array[];
  /** Application data received, in order. */
  appData: Uint8Array;
  /** Instructions per cycle accounting for the application phase. */
  totalCycles: number;
  totalInstrs: number;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const cat = (a: Uint8Array[]): Uint8Array => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

/** Which secrets become readable at each marker. */
const AT: Record<number, SecretName[]> = {
  [MARK.sShared]: ['client_pub', 'server_pub', 'shared'],
  [MARK.sHelloHash]: ['h_hello'],
  [MARK.sSecretsHs]: ['h_empty', 'early', 'derived1', 'handshake', 'c_hs', 's_hs', 'derived2', 'master', 'c_hs_key', 'c_hs_iv', 's_hs_key', 's_hs_iv', 'c_fin_key', 's_fin_key'],
  [MARK.sCertHash]: ['h_cert'],
  [MARK.sCvHash]: ['h_cv'],
  [MARK.sFinHash]: ['s_verify', 'h_fin'],
  [MARK.sSecretsAp]: ['c_ap', 's_ap', 'exp_master', 'c_ap_key', 'c_ap_iv', 's_ap_key', 's_ap_iv'],
  [MARK.sClientFin]: ['c_verify', 'h_cfin', 'res_master'],
};
const SLOT_LEN: Partial<Record<SecretName, number>> = { c_hs_iv: 12, s_hs_iv: 12, c_ap_iv: 12, s_ap_iv: 12, c_hs_key: 16, s_hs_key: 16, c_ap_key: 16, s_ap_key: 16 };

/** The server's byte stream with the tamper applied as bytes arrive, so the CPU reads exactly what a modified wire would carry. */
class Wire {
  private buf: Uint8Array[] = [];
  private have = 0;
  eof = false;
  private rec = 0; private off = 0; private hdr: number[] = [0, 0, 0, 0, 0]; private left = 0;
  constructor(private readonly t: Transport, private readonly tamper?: Tamper) {}
  private frame(b: Uint8Array): void {
    const f = this.tamper?.flip;
    for (let i = 0; i < b.length; i++) {
      const orig = b[i];
      if (f && this.rec === f.record && this.off === f.byte) b[i] ^= f.mask ?? 1;
      if (this.off < 5) this.hdr[this.off] = orig;
      this.off++;
      if (this.off === 5) this.left = (this.hdr[3] << 8) | this.hdr[4];
      if ((this.off === 5 && this.left === 0) || (this.off > 5 && --this.left === 0)) { this.rec++; this.off = 0; }
    }
  }
  /** Exactly n bytes, or fewer at the end of the stream. */
  async take(n: number): Promise<Uint8Array> {
    while (this.have < n && !this.eof) {
      const b = await this.t.recv(n - this.have);
      if (b.length === 0) { this.eof = true; break; }
      const c = b.slice();
      this.frame(c);
      this.buf.push(c);
      this.have += c.length;
    }
    const all = cat(this.buf);
    const k = Math.min(n, all.length);
    this.buf = k < all.length ? [all.subarray(k)] : [];
    this.have = all.length - k;
    return all.slice(0, k);
  }
}

export async function* runTlsClient(o: RunOptions): AsyncGenerator<TlsEvent, TlsResult> {
  const b = fullBuild();
  const m = new TlsMachine(b.compiled.words);
  const slice = o.slice ?? 4_000_000, budget = o.budget ?? 4_000_000_000;
  const wire = new Wire(o.transport, o.tamper);
  const alertAt = globalAddr(b, 'tls_alert');
  const phaseOf = (id: number): PhaseName | null => (id >= MARK.phClientHello && id <= MARK.phClientFinished ? PHASES[id - 1] : null);

  // the program's start-up, to its first idle
  for (;;) {
    const r = m.runToRequest(slice);
    if (r.kind === 'idle') break;
    if (r.kind !== 'budget') throw new Error('the TLS program asked for I/O before it was told to start');
    await tick();
  }
  const c = o.config;
  m.put(MEM.cfg + CFG.random, c.random);
  m.put(MEM.cfg + CFG.priv, c.privateKey);
  m.setWord(MEM.cfg + CFG.pinOn, c.pin ? 1 : 0);
  if (c.pin) m.put(MEM.cfg + CFG.pin, c.pin);
  const of = c.offer;
  if (of.pre.length > CFG.extMax || of.post.length > CFG.extMax || of.sessionId.length > 32 || of.cipherSuites.length > 8) throw new Error('the offer does not fit the configuration block');
  m.setWord(MEM.cfg + CFG.sidLen, of.sessionId.length);
  m.put(MEM.cfg + CFG.sid, of.sessionId);
  m.setWord(MEM.cfg + CFG.csLen, 2 * of.cipherSuites.length);
  m.put(MEM.cfg + CFG.cs, of.cipherSuites.flatMap((s) => [s >> 8, s & 255]));
  m.setWord(MEM.cfg + CFG.preLen, of.pre.length);
  m.put(MEM.cfg + CFG.pre, of.pre);
  m.setWord(MEM.cfg + CFG.postLen, of.post.length);
  m.put(MEM.cfg + CFG.post, of.post);

  const starts: { name: PhaseName; cycles: number; instrs: number }[] = [];
  const prims: TlsResult['prims'] = {};
  const secrets: TlsResult['secrets'] = {};
  const sent: Uint8Array[] = [], received: Uint8Array[] = [];
  const appChunks: Uint8Array[] = [];
  let phase: PhaseName | 'app' = 'client_hello';
  let open: Map<number, Mark> = new Map();
  let hsStart = 0, hsInstrs = 0;
  let endMark: Mark | null = null;
  let lastHdr: Uint8Array | null = null, inBody = false;

  // handle the markers the machine has written: phases, primitive spans, secrets
  const flush = function* (): Generator<TlsEvent> {
    const ms = m.marks; m.marks = [];
    for (const k of ms) {
      const ph = phaseOf(k.id);
      if (ph) { phase = ph; starts.push({ name: ph, cycles: k.cycles, instrs: k.instrs }); yield { kind: 'phase', name: ph, cycles: k.cycles, instrs: k.instrs }; continue; }
      if (k.id === MARK.phEnd) { phase = 'app'; endMark = k; continue; }
      const base = k.id & ~MARK_END;
      if ((k.id & MARK_END) && PRIMS[base]) {
        const s = open.get(base);
        open.delete(base);
        if (s) {
          const name = PRIMS[base] as PrimName;
          const e = prims[name] ?? (prims[name] = { calls: 0, cycles: 0 });
          e.calls++; e.cycles += k.cycles - s.cycles;
          yield { kind: 'prim', name, start: s.cycles, cycles: k.cycles - s.cycles, phase };
        }
        continue;
      }
      if (PRIMS[k.id]) { open.set(k.id, k); continue; }
      for (const n of AT[k.id] ?? []) {
        const v = m.bytes(secretAddr(n), SLOT_LEN[n] ?? 32);
        secrets[n] = v;
        yield { kind: 'secret', name: n, value: v, cycles: k.cycles };
      }
    }
  };

  // one command of the mailbox, serving the program's I/O
  const command = async function* (cmd: number, args: number[]): AsyncGenerator<TlsEvent, number> {
    args.forEach((a, i) => m.setWord(MEM.cmd + 4 + 4 * i, a));
    m.setWord(MEM.cmd, cmd);
    let left = budget;
    for (;;) {
      const t0 = m.retired;
      const r = m.runToRequest(Math.min(slice, left));
      left -= m.retired - t0;
      yield* flush();
      if (r.kind === 'budget') { if (left <= 0) throw new Error('TLS command ran out of budget'); await tick(); continue; }
      if (r.kind === 'idle') { if (m.word(MEM.cmd) === 0) return m.word(MEM.cmd + 64); continue; }
      if (r.kind === 'send') {
        const bytes = m.bytes(r.addr, r.len);
        sent.push(bytes);
        yield { kind: 'send', bytes, cycles: m.cycles, phase };
        await o.transport.send(bytes);
      } else if (r.kind === 'recv') {
        const got = await wire.take(r.len);
        m.put(r.addr, got);
        m.setWord(MEM.ioRes, got.length);
        if (!inBody && got.length === 5) { lastHdr = got; inBody = true; }
        else { const bytes = lastHdr ? cat([lastHdr, got]) : got; lastHdr = null; inBody = false; received.push(bytes); yield { kind: 'recv', bytes, cycles: m.cycles, phase }; }
      }
    }
  };

  const runCmd = async function* (cmd: number, args: number[]): AsyncGenerator<TlsEvent, number> { return yield* command(cmd, args); };

  const t0 = m.cycles, i0 = m.retiredNow;
  hsStart = t0; hsInstrs = i0;
  const code = yield* runCmd(CMD.handshake, []);
  const hs = { cycles: m.cycles - hsStart, instrs: m.retiredNow - hsInstrs };
  const alert = m.word(alertAt);
  const stop = endMark ?? { cycles: m.cycles, instrs: m.retiredNow };
  const phases = starts.map((p, i) => { const n = starts[i + 1] ?? stop; return { name: p.name, cycles: n.cycles - p.cycles, instrs: n.instrs - p.instrs }; });
  let ok = code === 0;
  let errCode = code;

  if (ok) {
    for (const step of o.app ?? []) {
      if ('send' in step) {
        m.put(MEM.app, step.send);
        const r = yield* runCmd(CMD.appSend, [MEM.app, step.send.length]);
        if (r < 0) { errCode = -r; ok = false; break; }
        yield { kind: 'app', step, cycles: m.cycles };
      } else if ('recv' in step || 'recvUntilClose' in step) {
        let need = 'recv' in step ? step.recv : Infinity;
        const got: Uint8Array[] = [];
        while (need > 0) {
          const r = yield* runCmd(CMD.appRecv, [MEM.app + 32768, 16384]);
          if (r < 0) { errCode = -r; ok = false; break; }
          if (r === 0) break; // the server closed
          got.push(m.bytes(MEM.app + 32768, r));
          need -= r;
        }
        const data = cat(got);
        appChunks.push(data);
        yield { kind: 'app', step, data, cycles: m.cycles };
        if (!ok) break;
      } else {
        const r = yield* runCmd(CMD.close, []);
        if (r < 0) { errCode = -r; ok = false; break; }
        yield { kind: 'app', step, cycles: m.cycles };
      }
    }
  }
  const res: TlsResult = {
    ok, error: errName(errCode), code: errCode, alert: errCode === ERR.alert ? alert : 0,
    handshake: hs, phases, prims, secrets, sent, received, appData: cat(appChunks), totalCycles: m.cycles, totalInstrs: m.retiredNow,
  };
  yield { kind: 'done', ok, error: res.error, code: errCode, alert: res.alert, cycles: m.cycles };
  return res;
}

/** Drain a run: every event, and the result. */
export async function collectTls(o: RunOptions): Promise<{ events: TlsEvent[]; result: TlsResult }> {
  const events: TlsEvent[] = [];
  const g = runTlsClient(o);
  for (;;) {
    const r = await g.next();
    if (r.done) return { events, result: r.value };
    events.push(r.value);
  }
}

export { SECRET_SLOTS };
