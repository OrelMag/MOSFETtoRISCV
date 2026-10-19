// Yosys in the page: the YoWASP WebAssembly build (@yowasp/yosys), served beside the site as yosys/bundle.js and
// its wasm (vite.config.ts copies them), fetched only when a Verilog chip is first synthesized. Verilog → Yosys's
// fine-grained cells (`synth`, then ABC onto the chosen gates) → write_json → yosysjson.ts. Nothing leaves the page.

import type { HdlDiag } from './yosysjson';

/** Which gates ABC may map the logic onto (flip-flops are mapped by synth either way). */
export type GateSet = 'nand' | 'std' | 'aoi';

export const GATE_SETS: Record<GateSet, { label: string; title: string; abc: string }> = {
  nand: { label: 'NAND', title: 'NAND gates only (and inverters)', abc: 'NAND' },
  std: { label: '+XOR MUX', title: 'AND, NAND, OR, NOR, XOR, XNOR and 2-to-1 multiplexers', abc: 'AND,NAND,OR,NOR,XOR,XNOR,MUX' },
  aoi: { label: 'AND OR', title: 'AND, OR and NOT', abc: 'AND,OR' },
};

export const YOSYS_VERSION = '0.68.1207';
/** Bytes fetched the first time (the wasm and its share/ files), for the progress bar's label. */
export const YOSYS_BYTES = 77_829_808;

type Tree = { [name: string]: Tree | string | Uint8Array };
export type RunYosys = (args: string[], files: Tree, options: {
  stdout?: (b: Uint8Array | null) => void; stderr?: (b: Uint8Array | null) => void; decodeASCII?: boolean;
  fetchProgress?: (e: { totalLength: number; doneLength: number }) => void;
}) => Promise<Tree> | Tree | undefined;

let loader: () => Promise<RunYosys> = async () => {
  // The site's own copy, else the same version from a CDN (a dev server or a host without the files).
  const local = new URL('yosys/bundle.js', document.baseURI).href;
  const cdn = `https://cdn.jsdelivr.net/npm/@yowasp/yosys@${YOSYS_VERSION}/gen/bundle.js`;
  for (const url of [local, cdn]) {
    try {
      const m = await import(/* @vite-ignore */ url) as { runYosys: RunYosys };
      return m.runYosys;
    } catch { /* next */ }
  }
  throw new Error('Yosys could not be loaded (yosys/bundle.js)');
};
let loaded: Promise<RunYosys> | null = null;

/** Tests (Node): run the package directly. */
export function setYosysLoader(f: () => Promise<RunYosys>): void {
  loader = f;
  loaded = null;
}

export function loadYosys(): Promise<RunYosys> {
  if (!loaded) loaded = loader().catch((e) => { loaded = null; throw e; });
  return loaded;
}

/** Has Yosys been fetched in this page (so a synthesis starts at once)? */
let ready = false;
export const yosysReady = () => ready;

export interface SynthResult {
  /** write_json's netlist, when Yosys got that far. */
  json?: unknown;
  diags: HdlDiag[];
  log: string;
}

export interface SynthOptions {
  top?: string;
  gates?: GateSet;
  /** Bytes fetched so far (first use only). */
  progress?: (done: number, total: number) => void;
}

/** The script: hierarchy kept (every module a chip), logic onto the gate set, buffers and dangling wires cleaned. */
export function synthScript(files: string[], o: SynthOptions = {}): string {
  const top = o.top ? `-top ${o.top}` : '-auto-top';
  return [
    `read_verilog -sv ${files.join(' ')}`,
    `hierarchy -check ${top}`,
    `synth ${o.top ? `-top ${o.top}` : '-auto-top'}`,
    `abc -g ${GATE_SETS[o.gates ?? 'std'].abc}`,
    'opt_clean',
    'write_json out.json',
  ].join('; ');
}

/** Run Yosys on Verilog sources (file name → text). */
export async function synthesize(files: Record<string, string>, o: SynthOptions = {}): Promise<SynthResult> {
  const run = await loadYosys();
  let log = '';
  const dec = new TextDecoder();
  const sink = (b: Uint8Array | null) => { if (b) log += dec.decode(b, { stream: true }); };
  const names = Object.keys(files);
  try {
    const out = await run(['-q', '-p', synthScript(names, o)], { ...files }, {
      stdout: sink, stderr: sink, decodeASCII: true,
      fetchProgress: (e) => o.progress?.(e.doneLength, e.totalLength), // (without one, YoWASP logs to the console)
    });
    ready = true;
    const text = out?.['out.json'];
    const json = typeof text === 'string' ? JSON.parse(text) : text instanceof Uint8Array ? JSON.parse(dec.decode(text)) : undefined;
    return { json, diags: parseYosysLog(log), log };
  } catch (e) {
    ready = true;
    const diags = parseYosysLog(log);
    if (!diags.some((d) => d.level === 'error')) diags.push({ level: 'error', msg: e instanceof Error ? e.message : String(e) });
    return { diags, log };
  }
}

/** Yosys's messages as diagnostics: `top.v:3: ERROR: …`, `top.v:2: Warning: …`, `ERROR: …`. */
export function parseYosysLog(log: string): HdlDiag[] {
  const out: HdlDiag[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const m = /^(?:([^\s:]+):(\d+)(?:\.\d+(?:-\d+\.\d+)?)?:\s*)?(ERROR|Warning):\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const msg = tidy(m[4]);
    if (out.some((d) => d.msg === msg && d.line === (m[2] ? +m[2] : undefined))) continue;
    out.push({ level: m[3] === 'ERROR' ? 'error' : 'warn', msg, ...(m[1] ? { file: m[1], line: +m[2] } : {}) });
  }
  return out;
}

/** Yosys's internal spellings made readable: `\b' → `b', TOK_ENDMODULE → endmodule. */
function tidy(s: string): string {
  return s.replace(/`\\([^']*)'/g, '`$1\'').replace(/\bTOK_([A-Z_]+)/g, (_, t: string) => t.toLowerCase()).replace(/\s+$/, '');
}
