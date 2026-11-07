// Chapter "Keeping it secret", key exchange and TLS: Diffie-Hellman with readable numbers, X25519 and a whole TLS 1.3 handshake run for real by the compiled client
// (crypto/tls) on the golden model in this page, against RFC 8448's recorded server. Nothing here is drawn from a script: tampering changes what the CPU reads.

import '../styles/secret.css';
import COSTS from '../crypto/tls/costs.json';
import GATES from '../crypto/gatecosts.json';
import FLIGHT from '../crypto/tls/rfc8448.json';
import { DH_G, DH_P, dh, eveSearch } from '../crypto/dhtoy';
import { fullBuild } from '../crypto/tls/build';
import { rfc8448Offer } from '../crypto/tls/hello';
import { CMD, MEM, type SecretName } from '../crypto/tls/layout';
import { TlsMachine } from '../crypto/tls/machine';
import { runTlsClient, type PhaseName, type Tamper, type TlsResult, type Transport } from '../crypto/tls/run';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const n0 = (x: number | bigint) => x.toLocaleString('en-US').replace(/,/g, ' ');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const hexOf = (b: ArrayLike<number>) => Array.from(b as ArrayLike<number> & Iterable<number>, (x) => x.toString(16).padStart(2, '0')).join('');
const short = (s: string) => (s.length > 24 ? `${s.slice(0, 16)}…${s.slice(-8)}` : s);
const mega = (c: number) => `${(c / 1e6).toFixed(c < 1e7 ? 2 : 1)} M`;
const later = (f: () => void) => { setTimeout(f, 30); };

/** The two sides and an eavesdropper, on numbers you can read. */
export function dhWidget(): Widget {
  let a = 1234567n, b = 7654321n, raf = 0;
  const slider = (label: string, v: bigint, on: (x: bigint) => void) => {
    const i = h('input', { type: 'range', min: 2, max: 9999999, step: 1, value: Number(v), 'aria-label': label }) as HTMLInputElement;
    i.addEventListener('input', () => on(BigInt(i.value)));
    sliders.push(i);
    return i;
  };
  const out = h('div', { class: 'se-dh' }), eve = h('p', { class: 'se-read', 'aria-live': 'polite' }), sliders: HTMLInputElement[] = [];
  function draw(): void {
    const r = dh(a, b), row = (who: string, t: string, v: bigint) => [h('span', { class: 'se-label' }, who), h('span', null, t), h('code', null, n0(v))];
    out.replaceChildren(
      ...row('Alice keeps', 'a', r.a), ...row('Bob keeps', 'b', r.b),
      ...row('Sent in public', `A = ${DH_G}ᵃ mod p`, r.A), ...row('Sent in public', `B = ${DH_G}ᵇ mod p`, r.B),
      ...row('Alice computes', 'Bᵃ mod p', r.sharedA), ...row('Bob computes', 'Aᵇ mod p', r.sharedB));
    eve.textContent = r.sharedA === r.sharedB ? 'The same number on both sides, and it was never sent.' : 'They differ: this should never happen.';
  }
  const go = h('button', { type: 'button', class: 'btn sm' }, 'Eve searches from A') as HTMLButtonElement;
  go.addEventListener('click', () => {
    const r = dh(a, b), e = eveSearch(r.A), t0 = performance.now(), had = document.activeElement === go;
    // The sliders wait: the result names the secret on screen.
    go.disabled = true; sliders.forEach((x) => { x.disabled = true; });
    const frame = () => {
      const t1 = performance.now();
      let found: bigint | null = null;
      while (performance.now() - t1 < 12 && found === null) found = e.step(4000);
      if (found === null) { eve.textContent = `Eve has tried ${n0(e.tried())} exponents…`; raf = requestAnimationFrame(frame); return; }
      go.disabled = false; sliders.forEach((x) => { x.disabled = false; });
      if (had) go.focus({ preventScroll: true });
      eve.textContent = `Eve found Alice's secret in ${n0(e.tried())} tries and ${n0(Math.round(performance.now() - t0))} ms, by multiplying by ${DH_G} until A came up. That works here because the secret is below 10 million. Each extra bit of the secret doubles the work, so 255 bits are out of reach of this method.`;
    };
    raf = requestAnimationFrame(frame);
  });
  draw();
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, `Diffie–Hellman, p = 2³¹ − 1 = ${n0(DH_P)}`),
      h('label', { class: 'se-slide' }, h('span', null, 'a'), slider('Alice’s secret', a, (x) => { a = x; draw(); })),
      h('label', { class: 'se-slide' }, h('span', null, 'b'), slider('Bob’s secret', b, (x) => { b = x; draw(); })),
      out, h('div', { class: 'se-row' }, go), eve),
    destroy() { cancelAnimationFrame(raf); },
  };
}

/** With and without someone in the middle, on the toy's numbers: the exchange succeeds either way, and only a signature can tell. */
export function mitmWidget(): Widget {
  const a = 1234567n, b = 7654321n, m1 = 1111111n, m2 = 2222222n;
  let mallory = false, signed = false;
  const out = h('div', { class: 'se-dh' }), verdict = h('p', { class: 'se-read', 'aria-live': 'polite' });
  const toggle = (label: string, on: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox' }) as HTMLInputElement;
    i.addEventListener('change', () => { on(i.checked); draw(); });
    return h('label', { class: 'se-check' }, i, h('span', null, label));
  };
  const row = (who: string, t: string, v: bigint) => [h('span', { class: 'se-label' }, who), h('span', null, t), h('code', null, n0(v))];
  function draw(): void {
    if (!mallory) {
      const r = dh(a, b);
      out.replaceChildren(...row('Alice gets', 'key with Bob', r.sharedA), ...row('Bob gets', 'key with Alice', r.sharedB));
      verdict.textContent = 'One exchange, one key, and nobody in between.';
      return;
    }
    const left = dh(a, m1), right = dh(m2, b);
    out.replaceChildren(...row('Alice gets', 'key Alice takes for Bob’s', left.sharedA), ...row('Mallory holds', 'the same key', left.sharedB), ...row('Bob gets', 'key Bob takes for Alice’s', right.sharedB), ...row('Mallory holds', 'that one too', right.sharedA));
    verdict.replaceChildren(signed
      ? h('span', { class: 'se-okt' }, 'Refused. Bob signs the transcript as Bob saw it, and it contains Mallory’s number, not Alice’s. Mallory cannot sign what Alice saw without Bob’s private key.')
      : h('span', { class: 'se-badt' }, 'Both exchanges succeed. Alice and Bob each hold a good key, and Mallory reads and rewrites everything between them. Nothing about the encryption can reveal it.'));
  }
  draw();
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, 'A man in the middle'),
      h('div', { class: 'se-row' }, toggle('Mallory is on the line', (v) => { mallory = v; }), toggle('Bob signs the transcript', (v) => { signed = v; })),
      out, verdict),
  };
}

/** A machine with the compiled client, at its first idle. */
function bootMachine(): TlsMachine {
  const m = new TlsMachine(fullBuild().compiled.words);
  for (;;) {
    const r = m.runToRequest(5_000_000);
    if (r.kind === 'idle') return m;
    if (r.kind !== 'budget') throw new Error(`start-up asked for ${r.kind}`);
  }
}

/** RFC 7748's two parties, computed by the program on our CPU. */
export function curveWidget(): Widget {
  const d = FLIGHT.dh, BASE = unhex(`09${'00'.repeat(31)}`);
  const rows = h('div', { class: 'se-dh' }), read = h('p', { class: 'se-read', 'aria-live': 'polite' }, 'Press Run: the compiled Python runs on the golden model, in this page.');
  const go = h('button', { type: 'button', class: 'btn sm' }, 'Run the four scalar multiplications') as HTMLButtonElement;
  const row = (who: string, what: string, v: string, ok: boolean) => [h('span', { class: 'se-label' }, who), h('span', null, what), h('code', { class: ok ? 'se-okc' : 'se-badc' }, short(v))];
  let dead = false;
  const pause = () => new Promise<void>((r) => { setTimeout(r, 20); });
  go.addEventListener('click', () => {
    const had = document.activeElement === go;
    go.disabled = true; read.textContent = 'Running…';
    void (async () => {
      await pause();
      const t0 = performance.now(), m = bootMachine(), x = async (k: Uint8Array, u: Uint8Array, n: number): Promise<{ out: string; cycles: number }> => {
        if (dead) throw new Error('gone');
        read.textContent = `Running multiplication ${n} of 4…`;
        await pause();
        const o = MEM.scratch + 256, kp = MEM.scratch, up = MEM.scratch + 64;
        m.put(kp, k); m.put(up, u);
        const c0 = m.cycles;
        m.call(CMD.x25519, [o, kp, up]);
        return { out: hexOf(m.bytes(o, 32)), cycles: m.cycles - c0 };
      };
      const A = await x(unhex(d.alicePriv), BASE, 1), B = await x(unhex(d.bobPriv), BASE, 2), sa = await x(unhex(d.alicePriv), unhex(B.out), 3), sb = await x(unhex(d.bobPriv), unhex(A.out), 4);
      rows.replaceChildren(
        ...row('Alice sends', 'Alice’s key × base point', A.out, A.out === d.alicePub),
        ...row('Bob sends', 'Bob’s key × base point', B.out, B.out === d.bobPub),
        ...row('Alice computes', 'Alice’s key × B', sa.out, sa.out === d.shared),
        ...row('Bob computes', 'Bob’s key × A', sb.out, sb.out === d.shared));
      const fine = A.out === d.alicePub && B.out === d.bobPub && sa.out === d.shared && sb.out === d.shared;
      read.textContent = `${fine ? 'All four equal RFC 7748’s values.' : 'A value differs from RFC 7748.'} One multiplication took ${n0(A.cycles)} cycles on our CPU, ${n0(Math.round(performance.now() - t0))} ms for all four in this browser.`;
      go.disabled = false;
      if (had) go.focus({ preventScroll: true });
    })().catch((e: unknown) => { if (!dead) throw e; });
  });
  return { el: h('div', { class: 'panel se' }, h('h3', { class: 'm3-title' }, 'X25519, run by our CPU on RFC 7748’s keys'), h('div', { class: 'se-row' }, go), rows, read), destroy() { dead = true; } };
}

/** RFC 8448's recorded server: what it sends, whatever the client does. */
function recordedServer(): Transport {
  let q = unhex(FLIGHT.server.join(''));
  return {
    send: () => undefined,
    recv: (n) => { const k = Math.min(n, q.length), o = q.slice(0, k); q = q.slice(k); return o; },
  };
}

export interface Handshake { result: TlsResult; ms: number }
export async function runHandshake(pin: Uint8Array | undefined, tamper?: Tamper): Promise<Handshake> {
  const t0 = performance.now(), g = runTlsClient({
    config: { random: unhex(FLIGHT.random), privateKey: unhex(FLIGHT.privateKey), pin, offer: rfc8448Offer() },
    transport: recordedServer(), tamper,
  });
  let n = await g.next();
  while (!n.done) n = await g.next();
  return { result: n.value, ms: performance.now() - t0 };
}

const CHECK_NAMES: Record<string, string> = { record_tags: 'GCM tag on each record', pin: 'The key is the one you trust', certificate_verify: 'Signature over the transcript', server_finished: 'Server Finished' };
const STATE: Record<string, string> = { pass: 'passed', fail: 'FAILED: handshake stopped', not_reached: 'not reached', not_configured: 'not configured: nothing to compare with' };
const ERRORS: Record<string, string> = { mac: 'a GCM tag did not match', pin: 'the server’s key is not the pinned one', sig: 'the signature did not verify', finished: 'the Finished did not match' };

/** What each phase does, in the order the CPU reaches it. */
const PHASE_WORDS: Record<PhaseName, string> = {
  client_hello: 'ClientHello: make a key pair (X25519), send the public half',
  server_hello: 'ServerHello: read the server’s public half',
  key_agreement: 'X25519 again, then HKDF: the handshake keys',
  encrypted_extensions: 'Decrypt the rest; EncryptedExtensions',
  certificate: 'Certificate: find the server’s public key',
  certificate_verify: 'CertificateVerify: check its signature over everything so far',
  server_finished: 'Server Finished: an HMAC over everything so far',
  client_finished: 'Client Finished, and the application keys',
};
const SHOW_SECRETS: [SecretName, string][] = [['shared', 'X25519 shared secret'], ['handshake', 'Handshake secret'], ['s_hs_key', 'Server handshake key'], ['master', 'Master secret'], ['c_ap_key', 'Client application key']];

/** The whole handshake, with a choice of what goes wrong. */
export function handshakeWidget(): Widget {
  const pinOk = unhex(FLIGHT.pin), pinOther = pinOk.map((b) => b ^ 0x5a);
  const CASES: { label: string; pin?: Uint8Array; tamper?: Tamper; say: string }[] = [
    { label: 'As recorded', pin: pinOk, say: 'RFC 8448’s server, unchanged, with the client trusting its key.' },
    { label: 'Flip a bit of the encrypted flight', pin: pinOk, tamper: { flip: { record: 1, byte: 20, mask: 1 } }, say: 'One bit changed on the way. One GCM tag covers EncryptedExtensions, Certificate, CertificateVerify and Finished together, so none of them is used.' },
    { label: 'Flip a bit of ServerHello', pin: pinOk, tamper: { flip: { record: 0, byte: 20, mask: 1 } }, say: 'The server’s hello is sent in the clear. A changed bit there is not noticed at once, and changes the keys, so the next tag fails.' },
    { label: 'A key you do not trust', pin: pinOther, say: 'The client holds the pin of some other key, as if a stranger had answered. The signature would verify: the stranger signed with their own key.' },
    { label: 'Trust no one', say: 'No pin. The handshake completes and the channel is encrypted, to whoever answered. This is what certificates exist to prevent.' },
  ];
  let dead = false;
  const go = (c: (typeof CASES)[number], b: HTMLButtonElement) => {
    const had = document.activeElement === b;
    btns.forEach((x) => { x.disabled = true; x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    say.textContent = c.say; verdict.textContent = 'Running the client…';
    later(() => { if (dead) return; void runHandshake(c.pin, c.tamper).then(({ result: r, ms }) => {
      if (dead) return;
      btns.forEach((x) => { x.disabled = false; });
      if (had) b.focus({ preventScroll: true });
      show(r, ms, !c.tamper && !!c.pin && c.pin === pinOk);
    }); });
  };
  const say = h('p', { class: 'se-read' }), verdict = h('p', { class: 'se-read', 'aria-live': 'polite' }), body = h('div');
  const btns = CASES.map((c) => { const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, c.label) as HTMLButtonElement; b.addEventListener('click', () => go(c, b)); return b; });
  function show(r: TlsResult, ms: number, expectTrace: boolean): void {
    const fin = r.sent[r.sent.length - 1], same = expectTrace && !!fin && hexOf(fin) === FLIGHT.clientFinished;
    verdict.replaceChildren(
      h('b', { class: r.ok ? 'se-okt' : 'se-badt' }, r.ok ? 'Handshake complete. ' : `Refused: ${ERRORS[r.error] ?? r.error}. `),
      `${n0(r.handshake.cycles)} cycles, ${n0(Math.round(ms))} ms in this browser.`,
      same ? ' The client’s Finished equals RFC 8448’s, byte for byte.' : '');
    const max = Math.max(...r.phases.map((p) => p.cycles), 1);
    const rows = r.phases.map((p) => h('tr', null,
      h('td', null, PHASE_WORDS[p.name]),
      h('td', { class: 'se-num' }, mega(p.cycles)),
      h('td', { class: 'se-cell-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${(p.cycles / max) * 100}%` }))));
    body.replaceChildren(
      h('div', { class: 'se-scroll' }, h('table', { class: 'se-table' }, h('thead', null, h('tr', null, h('th', null, 'What the CPU did'), h('th', null, 'Cycles'), h('th', null, ''))), h('tbody', null, ...rows))),
      h('h4', { class: 'se-sub' }, 'The checks'),
      h('div', { class: 'se-dh two' }, ...Object.entries(r.checks).flatMap(([k, v]) => [h('span', null, CHECK_NAMES[k] ?? k), h('span', { class: v === 'fail' ? 'se-badt' : v === 'pass' ? 'se-okt' : '' }, STATE[v] ?? v)])),
      h('h4', { class: 'se-sub' }, 'What it derived'),
      h('div', { class: 'se-dh two' }, ...SHOW_SECRETS.flatMap(([k, label]) => { const v = r.secrets[k]; return [h('span', null, label), h('code', null, v ? short(hexOf(v)) : 'not reached')]; })));
  }
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, 'A TLS 1.3 handshake, run by our CPU against RFC 8448’s server'),
      h('div', { class: 'se-row' }, ...btns), say, verdict, body),
    destroy() { dead = true; },
  };
}

/** The sums the chapter ends on, all measured. */
export function costsWidget(): Widget {
  const p = COSTS.primitives as Record<string, number>, aesCy = p['aes-128 block'], shaCy = p['sha256 per 64-byte block'], x = p.x25519, rsa = p['rsa-pss-sha256 verify, 1024-bit key (RFC 8448)'];
  const c = GATES.cores, row = (a: string, b: string, d: string) => h('tr', null, h('td', null, a), h('td', { class: 'se-num' }, b), h('td', { class: 'se-num' }, d));
  return {
    el: h('div', { class: 'panel se' },
      h('h3', { class: 'm3-title' }, 'What each thing costs, measured here'),
      h('div', { class: 'se-scroll' }, h('table', { class: 'se-table' },
        h('thead', null, h('tr', null, h('th', null, 'Job'), h('th', null, 'Software on the RV32IM'), h('th', null, 'Gates in this chapter'))),
        h('tbody', null,
          row('AES-128, one 16-byte block', `${n0(aesCy)} cycles`, `${c.aes_core.cycles} clocks, ${n0(c.aes_core.nands)} NANDs`),
          row('SHA-256, one 64-byte block', `${n0(shaCy)} cycles`, `${c.sha_core.cycles} clocks, ${n0(c.sha_core.nands)} NANDs`),
          row('X25519, one multiplication', `${n0(x)} cycles`, 'not built'),
          row('RSA-1024 signature check', `${n0(rsa)} cycles`, 'not built'),
          row('The whole handshake (RFC 8448)', `${n0(COSTS.handshake['rfc8448 (1024-bit RSA, three cipher suites offered)'].cycles)} cycles`, '')))),
      h('p', { class: 'se-read' }, `One X25519 costs as many cycles as ${n0(Math.round(x / aesCy))} AES blocks in the same software, which is ${n0(Math.round((x / aesCy) * 16 / 1024))} KB of data. So a session does the expensive public-key work once, and everything after it runs on AES.`),
      h('p', { class: 'se-read' }, `And the client is small: ${n0(COSTS.lines.total.python)} lines of Python and ${n0(COSTS.words.total)} words of code, ${n0(COSTS.words.app)} of them start-up tables and the command loop.`)),
  };
}

