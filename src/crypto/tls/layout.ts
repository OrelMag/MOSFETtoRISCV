// Where everything sits in the TLS computer's RAM. The Python subset keeps its scalars in the first 2 KB (a global is `sw r, addr(zero)`: the compiler
// refuses more than 2040 bytes of globals and lists), so every buffer is a fixed address in the RAM above, reached with load8 / store8 / load32 / store32.
// The compiler is told the RAM is TLS_DMEM_WORDS (its stack starts at 4 × that: below every buffer); the simulated machine has TLS_RAM_WORDS.

/** What the compiler is told: Python data (≤ 2 KB), the output and the stack live below 0x1000. */
export const TLS_DMEM_WORDS = 1024;
/** What the machine has: 2^17 words = 512 KB (the biggest buffers are the 24 KB handshake reassembly and the 16 KB records). */
export const TLS_RAM_WORDS = 1 << 17;

let top = 0x1000;
const take = (n: number, align = 16): number => {
  top = (top + align - 1) & ~(align - 1);
  const a = top;
  top += n;
  return a;
};

/** Memory-mapped registers (the harness is the device): a store to send / recv / mark yields or records, a load reads a plain word. */
export const IO = {
  base: 0x90000000,
  addr: 0x90000000,
  len: 0x90000004,
  /** Writing 1: send `len` bytes at `addr` to the peer. */
  send: 0x90000008,
  /** Writing 1: fill `len` bytes at `addr` from the peer; the harness stores the count it delivered (< len only at end of stream) in mem.ioRes. */
  recv: 0x9000000c,
  /** Writing an id: the harness records (id, cycles, instructions) without stopping the machine. */
  mark: 0x90000010,
  /** Writing 1: the machine is idle (the command mailbox is empty): run() returns. */
  idle: 0x90000014,
} as const;

/** Phase and primitive markers: a start id P, its end P | MARK_END. */
export const MARK_END = 0x100;
export const MARK = {
  // phases of the handshake (each ends where the next begins; PH_END closes the last)
  phClientHello: 1, phServerHello: 2, phKeyAgree: 3, phEncExt: 4, phCert: 5, phCertVerify: 6, phServerFinished: 7, phClientFinished: 8, phEnd: 9,
  // primitives, nested inside phases (start id, MARK_END | id for the end)
  pX25519: 0x20, pRsa: 0x21, pGcmOpen: 0x22, pGcmSeal: 0x23, pHkdf: 0x24, pSha: 0x25, pHmac: 0x26,
  // "the secret / hash slots of this stage are written": the harness reads them then
  sSecretsHs: 0x40, sSecretsAp: 0x41, sHelloHash: 0x42, sCertHash: 0x43, sCvHash: 0x44, sFinHash: 0x45, sClientFin: 0x46, sShared: 0x47, sClientHello: 0x48,
} as const;

/** The command mailbox: word 0 is the command (0: none), words 1..8 the arguments, word 16 the result. */
export const MEM = {
  cmd: take(256),
  ioRes: take(16),
  // hash, MAC, KDF
  shaK: take(256),
  shaW: take(256),
  shaCtx: take(112),
  hmacCtx: take(112),
  hmacKey: take(64),
  hmacInner: take(64),
  hmacMsg: take(1024),
  hkdfT: take(64),
  hkdfInfo: take(512),
  zero32: take(64),
  // AES / GCM
  sbox: take(256),
  aesState: take(16),
  aesTmp: take(16),
  gcmCtxScratch: take(192),
  gcmWork: take(128),
  // X25519: 24 field elements of 32 words
  fe: take(24 * 128),
  feTmp: take(128),
  scalar: take(32),
  // RSA: limb arrays of up to 512 limbs, one per word
  rsaN: take(2048),
  rsaX: take(2048),
  rsaT: take(2080),
  rsaU: take(2048),
  rsaM: take(2048),
  rsaY: take(2048),
  rsaEm: take(520),
  rsaDb: take(520),
  pssBuf: take(256),
  // fixed strings (labels, the CertificateVerify prefix), written by init
  strings: take(1024),
  // TLS client
  cfg: take(2048),
  secrets: take(1024),
  th: take(112),
  thTmp: take(112),
  hsBuf: take(24576),
  recBuf: take(16640 + 16),
  sendBuf: take(16640 + 16),
  chBuf: take(1536),
  certN: take(520),
  nonce: take(16),
  basePoint: take(32),
  finBuf: take(64),
  wrCtx: take(192),
  rdCtx: take(192),
  wrIv: take(16),
  rdIv: take(16),
  scratch: take(2048),
  app: take(65536),
  end: 0,
};
MEM.end = top;

/** Injected configuration: offsets inside MEM.cfg. */
export const CFG = {
  random: 0,
  priv: 32,
  pinOn: 64,
  pin: 68,
  sidLen: 100,
  sid: 104,
  csLen: 136,
  cs: 140,
  preLen: 180,
  pre: 184,
  postLen: 700,
  post: 704,
  /** Largest pre / post extension blob. */
  extMax: 512,
} as const;

/** Offsets of the derived values inside MEM.secrets (32 bytes each unless noted). */
export const SECRET_SLOTS = [
  'shared', 'early', 'derived1', 'handshake', 'c_hs', 's_hs', 'derived2', 'master', 'c_ap', 's_ap', 'exp_master', 'res_master',
  'c_hs_key', 'c_hs_iv', 's_hs_key', 's_hs_iv', 'c_ap_key', 'c_ap_iv', 's_ap_key', 's_ap_iv', 'c_fin_key', 's_fin_key',
  'h_hello', 'h_cert', 'h_cv', 'h_fin', 'h_cfin', 'client_pub', 'server_pub', 'c_verify', 's_verify', 'h_empty',
] as const;
export type SecretName = (typeof SECRET_SLOTS)[number];
export const secretAddr = (n: SecretName): number => MEM.secrets + 32 * SECRET_SLOTS.indexOf(n);

/** Error codes the client returns (0: none): one per check that can stop the handshake. */
export const ERR = {
  none: 0, io: 1, record: 2, alert: 3, hello: 4, hrr: 5, message: 6, mac: 7, x25519: 8, cert: 9, pin: 10, sig: 11, finished: 12, unsupported: 13, closed: 14, state: 15,
} as const;
export type ErrName = keyof typeof ERR;
export const errName = (code: number): ErrName | `unknown(${number})` => ((Object.keys(ERR) as ErrName[]).find((k) => ERR[k] === code) ?? `unknown(${code})`);

/** Commands of the mailbox. */
export const CMD = {
  sha256: 1, hmac: 2, hkdfExtract: 3, hkdfExpand: 4, hkdfLabel: 5, aesEncrypt: 6, gcmSeal: 7, gcmOpen: 8, x25519: 9, rsaPss: 10, x509: 11,
  handshake: 12, appSend: 13, appRecv: 14, close: 15, aesExpand: 16, ghashMul: 17,
} as const;
