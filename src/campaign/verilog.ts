// Verilog twins (merge 5): a campaign build level written in Verilog instead of drawn. Yosys (hdl/yosys.ts, in the page)
// synthesizes the text to NANDs and flip-flops, and the level's own check grades the result; the cost is counted like a
// drawn chip's (stats of the compiled chip). A twin is not a campaign node: it is optional, recorded in the campaign
// progress under its own id (vl_<level>), and the map shows it beside its level as "also in Verilog". No DOM.
//
// Grades: ★ the level's check passes, ★★ within 1.5 × the drawn reference's NANDs, ★★★ at or under it. A latch is refused
// (Yosys says "Latch inferred" on a line), and so is a top module that is missing or has the wrong pins.

import { type BuildChallenge, type CheckResult, checkChallenge, ins, outs, type PinSpec } from '../editor/challenges';
import { newVerilogChip, resynthesize } from '../editor/hdl';
import { UserLibrary } from '../editor/library';
import { emptyWorkspace, slug, type Workspace } from '../editor/model';
import type { HdlDiag } from '../hdl/yosysjson';
import { stats } from '../sim/stats';
import { levelChallenge } from './levels';
import { nodeById } from './nodes';
import { twinKey } from './twinids';

export interface VerilogTwin {
  /** The drawn level this is the twin of (campaign node id). */
  twin: string;
  /** The top module's name: its ports are the level's pins. */
  module: string;
  /** What the body must do, in one line for the file's first comment. */
  hint: string;
  /** The text of the module's body, after the header (the starting file). */
  start: string;
  /** A Verilog solution (shown after a pass, and what the tests hold to ★★★ or its stars). */
  reference: string;
  /** The pitfall the Spec tab names, HTML. */
  note: string;
}

/** Twins: a few small, typical blocks in each of acts 1, 2, 3 and 5 (act 4 has no build level). */
export const TWINS: VerilogTwin[] = [
  {
    twin: 'g_dec', module: 'dec3', hint: 'y = en ? 1 << a : 0',
    start: '  // one output line per value of a, only while en = 1\n',
    reference: '  assign y = en ? (8\'d1 << a) : 8\'d0;\n',
    note: 'A shift of a constant by <code>a</code> is a decoder: Yosys turns it into a shifter and ABC into gates. Compare its NANDs with your drawn one.',
  },
  {
    twin: 'a_addsub16', module: 'addsub16', hint: 's = sub ? a - b : a + b; cout; v (signed overflow)',
    start: '  // a + (b xor sub) + sub: one adder serves both\n',
    reference: [
      '  wire [15:0] bb = b ^ {16{sub}};',
      '  wire [16:0] c;',
      '  assign c[0] = sub;',
      '  genvar i;',
      '  generate for (i = 0; i < 16; i = i + 1) begin : fa',
      '    assign s[i]   = a[i] ^ bb[i] ^ c[i];',
      '    assign c[i+1] = (a[i] & bb[i]) | (c[i] & (a[i] ^ bb[i]));',
      '  end endgenerate',
      '  assign cout = c[16];',
      '  assign v = c[16] ^ c[15];',
      '',
    ].join('\n'),
    note: 'Writing <code>a + bb + sub</code> hands the carry chain to Yosys. Here it costs about what a <code>generate</code> loop of full-adder equations does (282 and 281 NANDs, both depth 38): a third more than the 212 you drew.',
  },
  {
    twin: 'a_slt', module: 'slt16', hint: 'lt = a < b signed, ltu = a < b unsigned',
    start: '  // both from one subtraction a - b\n',
    reference: [
      '  wire [16:0] c;',
      '  assign c[0] = 1\'b1;',
      '  genvar i;',
      '  generate for (i = 0; i < 16; i = i + 1) begin : g',
      '    assign c[i+1] = (a[i] & ~b[i]) | (c[i] & (a[i] ^ ~b[i]));',
      '  end endgenerate',
      '  assign ltu = ~c[16];',
      '  assign lt  = (a[15] ^ b[15]) ? a[15] : ltu;',
      '',
    ].join('\n'),
    note: 'ltu is the borrow out of a - b. lt differs only when the signs differ: then a is the smaller one exactly when it is negative.',
  },
  {
    twin: 's_reg4', module: 'reg4', hint: 'q <= d at a rising clk edge while en = 1, else hold',
    start: '  // load on the rising edge while en is 1, else hold\n',
    reference: '  always @(posedge clk)\n    if (en) q <= d;\n',
    note: 'Write the clocked process, nothing else: no <code>@(en)</code>, no gated clock. An <code>always @(*)</code> that does not assign q in every branch infers a latch, which is refused.',
  },
  {
    twin: 's_cnt4', module: 'cnt4', hint: 'rst clears, else en counts up, else hold; wraps 15 to 0',
    start: '  // synchronous reset, then count while en\n',
    reference: '  always @(posedge clk)\n    q <= rst ? 4\'d0 : q + en;\n',
    note: 'The incrementer is Yosys\'s to build: a half-adder chain, the one you drew.',
  },
  {
    twin: 'c_imm', module: 'imm16', hint: 'the four immediates of an RV16 instruction word',
    start: '  // i, sb, j are sign-extended from instr; u is not (lui): see the level\n',
    reference: [
      '  assign i  = {{10{instr[15]}}, instr[15:10]};',
      '  assign sb = {{10{instr[15]}}, instr[15:13], instr[6:4]};',
      '  assign j  = {{7{instr[15]}}, instr[15:7]};',
      '  assign u  = {instr[15:7], instr[3], 6\'b000000};',
      '',
    ].join('\n'),
    note: 'Pure wiring: the cost is zero NANDs, in Verilog as in the drawing. The replication <code>{n{x}}</code> is the sign extension.',
  },
  {
    twin: 'c_br', module: 'branch16', hint: 'take = (cond[1] ? a < b signed : a == b) xor cond[0]',
    start: '  // equal, or signed less than, then optionally inverted\n',
    reference: [
      '  wire eq = (a == b);',
      '  wire lt = ($signed(a) < $signed(b));',
      '  assign take = (cond[1] ? lt : eq) ^ cond[0];',
      '',
    ].join('\n'),
    note: 'Bit 1 of <code>cond</code> picks the comparison, bit 0 inverts it: four conditions from two comparators and an XOR.',
  },
];

export const twinById = (id: string): VerilogTwin | undefined => TWINS.find((t) => twinId(t) === id);
export const twinOf = (node: string): VerilogTwin | undefined => TWINS.find((t) => t.twin === node);
export const twinId = (t: VerilogTwin): string => twinKey(t.twin);
/** The id "Open the netlist" gives the chip in the sandbox (newVerilogChip's own choice for a first one). */
export const twinChipId = (t: VerilogTwin): string => `u_${slug(t.module)}`;

/** The level's challenge (its pins, its check), with every library part allowed: the synthesizer picks the gates. */
export function twinChallenge(t: VerilogTwin): BuildChallenge {
  const node = nodeById(t.twin);
  const base = node && levelChallenge(node);
  if (!base) throw new Error(`Verilog twin of ${t.twin}: no such build level`);
  return { ...base, id: twinId(t), allowed: 'any' };
}

export const twinTitle = (t: VerilogTwin): string => nodeById(t.twin)?.title ?? t.twin;

const widthOf = (w: number) => (w > 1 ? `[${w - 1}:0] ` : '');

/** The starting file: the header from the level's pins, the hint, an empty body. */
export function twinStart(t: VerilogTwin): string {
  const ch = twinChallenge(t);
  const sequential = ch.check.kind === 'sequence';
  const port = (p: PinSpec) => `${p.dir === 'in' ? 'input ' : sequential ? 'output reg ' : 'output '}${widthOf(p.width)}${p.name}`;
  const ports = [...ins(ch.ports), ...outs(ch.ports)];
  return `// ${twinTitle(t)}: ${t.hint}\nmodule ${t.module}(\n${ports.map((p) => `  ${port(p)}`).join(',\n')}\n);\n${t.start}endmodule\n`;
}

/** The reference solution as a whole file (the header from the pins, the reference body). */
export function twinReference(t: VerilogTwin): string {
  return twinStart(t).replace(t.start, t.reference);
}

// ---- cost and grades --------------------------------------------------------------------------

/** The drawn reference's NANDs (compile and count; no simulation). */
export function drawnNands(t: VerilogTwin): number {
  const chips = twinChallenge(t).answer();
  const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
  const def = new UserLibrary(ws).compiled(chips[chips.length - 1].id)?.def;
  if (!def) throw new Error(`reference of ${t.twin} does not compile`);
  return stats(def).nands;
}

/** The drawn reference run through the level's own check (the numbers the Drawn version tab and the comparison show). */
export function drawnScore(t: VerilogTwin): CheckResult['score'] {
  const ch = twinChallenge(t);
  const chips = ch.answer();
  const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
  return checkChallenge(ch, new UserLibrary(ws).compiled(chips[chips.length - 1].id)).score;
}

/** Stars for a passing design: 1 passes, 2 within 1.5 × the reference's NANDs, 3 at or under it. */
export const starsOf = (nand: number, ref: number): 1 | 2 | 3 => (nand <= ref ? 3 : nand <= ref * 1.5 ? 2 : 1);

// ---- synthesize and check -----------------------------------------------------------------------

export interface TwinResult {
  /** Yosys's diagnostics plus ours (a latch, a missing module), with the line where there is one. */
  diags: HdlDiag[];
  /** The level's check, once there was a netlist to run it on. */
  check?: CheckResult;
  /** The synthesized workspace (the chip is `chipId`): "Open the netlist". */
  ws?: Workspace;
  chipId?: string;
  /** Library parts of the netlist, by id (the synthesis summary: "4 dffe, 12 nand"). */
  cells?: Record<string, number>;
  nand?: number;
  stars?: 0 | 1 | 2 | 3;
  /** The bar for the stars: the drawn reference's NANDs, or our Verilog answer's where synthesis cannot reach them. */
  ref: number;
  /** The drawn reference's NANDs, and our Verilog answer's once synthesized. */
  drawn: number;
  verilog?: number;
  ok: boolean;
}

const LATCH = /latch/i;

/** Yosys's "Latch inferred for signal `m.\y' from process `m.$proc$file.v:7$1'" as an error on its line. */
function latchDiag(d: HdlDiag): HdlDiag {
  if (!LATCH.test(d.msg)) return d;
  const sig = /signal `(?:[\w$]+\.)?\\?([\w$.[\]]+)'/.exec(d.msg)?.[1];
  const at = /\$proc\$([^:$]+):(\d+)\$/.exec(d.msg);
  return {
    level: 'error', ...(at ? { file: at[1], line: +at[2] } : d.line ? { file: d.file, line: d.line } : {}),
    msg: `a latch is inferred for ${sig ? `\`${sig}\`` : 'a signal'}: it is not assigned in every branch of this block. Give it a value in every branch, or clock it with posedge`,
  };
}

/** "Wire m.\q [3] is used but has no driver", once per signal, as the error it is for an output nothing drives. */
function tidyDiags(diags: HdlDiag[]): HdlDiag[] {
  const out: HdlDiag[] = [];
  for (const d of diags) {
    const m = /^Wire (?:[\w$]+\.)?\\?([\w$]+)\s*(?:\[\d+\])? is used but has no driver/.exec(d.msg);
    const w = /^wire '\\?([\w$]+)' is assigned in a block at ([^:\s]+):(\d+)/.exec(d.msg);
    const x: HdlDiag = m ? { level: 'error', msg: `\`${m[1]}\` is never driven: assign it in every bit (an output left open reads X)` }
      : w ? { level: 'warn', file: w[2], line: +w[3], msg: `\`${w[1]}\` is assigned in a block: declare it \`output reg\`, or use \`assign\`` } : d;
    if (!out.some((y) => y.msg === x.msg && y.line === x.line)) out.push(x);
  }
  return out;
}

/** Number of library parts by id in the hierarchy under a chip (a summary of what Yosys made). */
function cellCounts(ws: Workspace, id: string): Record<string, number> {
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  const walk = (cid: string) => {
    const doc = ws.chips[cid];
    if (!doc || seen.has(cid)) return;
    seen.add(cid);
    for (const p of doc.parts) {
      if ('chip' in p.ref) walk(p.ref.chip);
      else if ('lib' in p.ref) out[p.ref.lib] = (out[p.ref.lib] ?? 0) + 1;
    }
  };
  walk(id);
  return out;
}

/** Synthesize the text and grade it. Never throws: a failure is a diagnostic. */
const verilogBars = new Map<string, number>();

/** NANDs of our own Verilog answer, synthesized like a learner's (once per twin). */
export async function verilogNands(t: VerilogTwin): Promise<number> {
  let n = verilogBars.get(t.twin);
  if (n === undefined) {
    const r = await checkTwin(t, twinReference(t), undefined, true);
    if (r.nand === undefined) throw new Error(`the Verilog answer of ${t.twin} does not synthesize`);
    verilogBars.set(t.twin, (n = r.nand));
  }
  return n;
}

export async function checkTwin(t: VerilogTwin, text: string, progress?: (done: number, total: number) => void, isBar = false): Promise<TwinResult> {
  const ch = twinChallenge(t);
  const drawn = drawnNands(t);
  let verilog: number | undefined;
  if (!isBar) { try { verilog = await verilogNands(t); } catch { /* no bar from it */ } }
  const ref = Math.max(drawn, verilog ?? 0);
  const fail = (diags: HdlDiag[]): TwinResult => ({ diags, ref, drawn, verilog, ok: false });
  if (!new RegExp(`\\bmodule\\s+${t.module}\\b`).test(text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ''))) {
    return fail([{ level: 'error', msg: `the top module must be called ${t.module} (its ports are the level's pins)` }]);
  }
  const made = newVerilogChip(emptyWorkspace(), text, `${t.module}.v`, 'nand', t.module);
  let out;
  try { out = await resynthesize(made.ws, made.id, progress); } catch (e) { return fail([{ level: 'error', msg: e instanceof Error ? e.message : String(e) }]); }
  if (!out.ok) return fail(out.diags);
  const diags = tidyDiags(out.diags.filter((d) => !/x \/ z bits read as 0/.test(d.msg)).map(latchDiag));
  const lib = new UserLibrary(out.ws);
  const compiled = lib.compiled(made.id);
  const cells = cellCounts(out.ws, made.id);
  if (Object.keys(cells).some((k) => k.startsWith('d_latch')) && !diags.some((d) => LATCH.test(d.msg))) {
    diags.push({ level: 'error', msg: 'the netlist holds a latch: storage must be a flip-flop clocked by a posedge' });
  }
  if (diags.some((d) => d.level === 'error')) return { diags, ws: out.ws, chipId: made.id, cells, ref, drawn, verilog, ok: false };
  const check = checkChallenge(ch, compiled);
  const nand = check.score.nand;
  const stars = check.ok ? starsOf(nand, ref) : 0;
  return { diags, check, ws: out.ws, chipId: made.id, cells, nand, stars, ref, drawn, verilog, ok: check.ok };
}
