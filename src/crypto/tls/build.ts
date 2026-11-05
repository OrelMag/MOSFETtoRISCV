// The compiled TLS computer, built once per process (compiling the Python subset takes a second or two).

import { tlsProgram, type TlsBuild } from './index';
import { appSource, PRIMITIVE_MODULES, TLS_MODULES } from './app';

let full: TlsBuild | null = null;
let prim: TlsBuild | null = null;

const checked = (b: TlsBuild): TlsBuild => {
  const e = b.compiled.error;
  if (e) throw new Error(`TLS program: ${e.message} (${JSON.stringify(b.where(e.line))})`);
  return b;
};

/** The whole client (and every primitive's command). */
export const fullBuild = (): TlsBuild => (full ??= checked(tlsProgram(TLS_MODULES, appSource(true))));
/** The primitives alone, without the TLS client, for the cost of each. */
export const primitiveBuild = (): TlsBuild => (prim ??= checked(tlsProgram(PRIMITIVE_MODULES, appSource(false))));

/** RAM address of a top-level scalar of the Python program (a global the functions share). */
export function globalAddr(b: TlsBuild, name: string): number {
  const h = b.compiled.layout?.homes.find((x) => x.scope === '' && x.name === name && x.addr !== undefined);
  if (!h) throw new Error(`no global ${name}`);
  return h.addr!;
}
