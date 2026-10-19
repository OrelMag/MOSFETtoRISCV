// Shared by the HDL import tests: Yosys from the npm package (Node needs WebAssembly exception references switched
// on before the wasm is compiled), imported chips put in a workspace and compiled like the sandbox does.

import { setFlagsFromString } from 'node:v8';
import { UserLibrary } from '../src/editor/library';
import { SCHEMA, type Workspace } from '../src/editor/model';
import { setUserResolver } from '../src/lib/resolve';
import { type RunYosys, setYosysLoader, synthesize, type SynthOptions } from '../src/hdl/yosys';
import { type HdlImport, importYosysJson } from '../src/hdl/yosysjson';
import type { ComponentDef } from '../src/sim/types';

setFlagsFromString('--experimental-wasm-exnref');
setYosysLoader(async () => (await import('@yowasp/yosys')).runYosys as unknown as RunYosys);

/** Verilog → imported chips (throws on a Yosys or import error). */
export async function importVerilog(src: string, o: SynthOptions = {}): Promise<HdlImport> {
  const r = await synthesize({ 'top.v': src }, o);
  if (!r.json) throw new Error(`yosys: ${r.diags.map((d) => d.msg).join('; ')}`);
  const imp = importYosysJson(r.json, { top: o.top });
  if ('error' in imp) throw new Error(imp.error);
  return imp;
}

/** The imported chips compiled in a workspace of their own: the top chip's def (user chips resolvable). */
export function compiledTop(imp: HdlImport): { def: ComponentDef; lib: UserLibrary } {
  const ws: Workspace = { schema: SCHEMA, chips: Object.fromEntries(imp.chips.map((c) => [c.id, c])), open: [imp.top] };
  const lib = new UserLibrary(ws);
  setUserResolver(lib.resolver());
  for (const c of imp.chips) {
    const errs = lib.compiled(c.id)!.diags.filter((d) => d.level === 'error');
    if (errs.length) throw new Error(`${c.id}: ${errs.map((d) => d.msg).join('; ')}`);
  }
  return { def: lib.defOf(imp.top)!, lib };
}
