// The program's top level: set the constant tables up (the round constants, the S-box, the label strings), then loop on the command mailbox the harness
// writes (MEM.cmd: the command, arguments in words 1..8, the result in word 16) and tell the harness when idle. The TLS client's commands call tls.ts.

import type { CryptoModule } from './index';
import { putString } from './index';
import { CMD, IO, MEM } from './layout';
import { SHA, SHA256_K } from './sha';
import { AES } from './aes';
import { X25519 } from './x25519';
import { RSA } from './rsa';
import { STR } from './strings';

// arguments are read into p0..p6 first: seven call arguments in expression temporaries would not fit the compiler's seven
const arg = (i: number): string => `p${i}`;
const call = (name: string, n: number): string => `${name}(${Array.from({ length: n }, (_, i) => arg(i)).join(', ')})`;

/** Primitives only: the modules without the TLS client. */
export const PRIMITIVE_MODULES: readonly CryptoModule[] = [SHA, AES, X25519, RSA];

const init = (): string => `def crypto_init():
${SHA256_K.map((v, i) => `    store32(${MEM.shaK + 4 * i}, ${v})`).join('\n')}
${Object.values(STR).map((s) => putString(s.addr, s.text)).join('\n')}
    aes_init()
    return 0
`;

/** `withTls`: the handshake and the application-data commands too (tls.ts must be among the modules). */
export function appSource(withTls: boolean): string {
  const tls = withTls ? `    elif c == ${CMD.handshake}:
        store32(${MEM.cmd + 64}, tls_handshake())
    elif c == ${CMD.appSend}:
        store32(${MEM.cmd + 64}, tls_send(${arg(0)}, ${arg(1)}))
    elif c == ${CMD.appRecv}:
        store32(${MEM.cmd + 64}, tls_recv(${arg(0)}, ${arg(1)}))
    elif c == ${CMD.close}:
        store32(${MEM.cmd + 64}, tls_close())
` : '';
  return `${init()}
crypto_init()
while 1:
    c = load32(${MEM.cmd})
${Array.from({ length: 7 }, (_, i) => `    p${i} = load32(${MEM.cmd + 4 + 4 * i})`).join('\n')}
    if c == ${CMD.sha256}:
        store32(${MEM.cmd + 64}, ${call('sha256', 3)})
    elif c == ${CMD.hmac}:
        store32(${MEM.cmd + 64}, ${call('hmac', 5)})
    elif c == ${CMD.hkdfExtract}:
        store32(${MEM.cmd + 64}, ${call('hkdf_extract', 5)})
    elif c == ${CMD.hkdfExpand}:
        store32(${MEM.cmd + 64}, ${call('hkdf_expand', 5)})
    elif c == ${CMD.hkdfLabel}:
        store32(${MEM.cmd + 64}, ${call('hkdf_label', 7)})
    elif c == ${CMD.aesEncrypt}:
        aes_expand(${arg(0)}, ${MEM.gcmCtxScratch})
        aes_encrypt(${MEM.gcmCtxScratch}, ${arg(1)}, ${arg(2)})
    elif c == ${CMD.gcmSeal}:
        gcm_setkey(${MEM.gcmCtxScratch}, ${arg(0)})
        gcm_seal(${MEM.gcmCtxScratch}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})
    elif c == ${CMD.gcmOpen}:
        gcm_setkey(${MEM.gcmCtxScratch}, ${arg(0)})
        store32(${MEM.cmd + 64}, gcm_open(${MEM.gcmCtxScratch}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}))
    elif c == ${CMD.x25519}:
        x25519(${arg(0)}, ${arg(1)}, ${arg(2)})
    elif c == ${CMD.rsaPss}:
        store32(${MEM.cmd + 64}, ${call('rsa_pss_verify', 6)})
${withTls ? `    elif c == ${CMD.x509}:
        store32(${MEM.cmd + 64}, x509_key(${arg(0)}, ${arg(1)}))
` : ''}${tls}    store32(${MEM.cmd}, 0)
    store32(${IO.idle}, 1)
`;
}
