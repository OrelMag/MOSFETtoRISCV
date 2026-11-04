// The protocol stack as text in chapter 15's Python subset (no imports: the modules are concatenated and compiled once). Each file of this
// folder exports one StackModule; stackProgram joins the modules in order, then the application, and compiles the result for the RV32I CPU.
// Line numbers map back to the module and the line in it, so the CPU panel can show which layer an instruction belongs to.

import { compilePy, type Compiled } from '../../lang/compile';
import { STACK_LAYOUT } from './layout';

export interface StackModule {
  /** The layer's name (eth, arp, ip, icmp, udp, tcp). */
  name: string;
  /** Python subset source. Top-level statements only define functions and set globals: nothing is called until the application starts. */
  py: string;
}

export interface ModuleRange { name: string; /** First and last line of the module in the joined source (1-based). */ first: number; last: number }

export interface StackBuild {
  source: string;
  compiled: Compiled;
  /** The modules in order, then the application as 'app'. */
  ranges: ModuleRange[];
  /** The layer and the line within its text that a line of the joined source came from. */
  where(line: number): { name: string; line: number } | null;
  /** The layer of an instruction address (null: the frame or a runtime routine). */
  layerOfPc(pc: number): string | null;
}

const NO_TCP = `def tcp_input(buf, off, n, src):
    return 0
`;
const NO_UDP_APP = `def udp_rx(dport, src, sport, buf, doff, dlen):
    return 0
`;

/** Concatenate the modules and the application and compile once. A stub stands in for what is missing: tcp_input when no module defines it, udp_rx when the application does not. */
export function stackProgram(modules: readonly StackModule[], appSource: string, opts: { dmemWords?: number } = {}): StackBuild {
  const defs = (name: string) => modules.some((m) => m.py.split('\n').some((line) => line.startsWith(`def ${name}(`)));
  const parts: { name: string; text: string }[] = modules.map((m) => ({ name: m.name, text: m.py }));
  if (!defs('tcp_input')) parts.push({ name: 'stub', text: NO_TCP });
  if (!/^def udp_rx\(/m.test(appSource)) parts.push({ name: 'stub', text: NO_UDP_APP });
  parts.push({ name: 'app', text: appSource });
  const ranges: ModuleRange[] = [];
  let line = 1;
  const texts: string[] = [];
  for (const p of parts) {
    const t = p.text.endsWith('\n') ? p.text : `${p.text}\n`;
    const n = t.split('\n').length - 1;
    ranges.push({ name: p.name, first: line, last: line + n - 1 });
    texts.push(t);
    line += n;
  }
  const source = texts.join('');
  const compiled = compilePy(source, { dmemWords: opts.dmemWords ?? STACK_LAYOUT.dmemWords });
  const where = (l: number) => {
    const r = ranges.find((x) => l >= x.first && l <= x.last);
    return r ? { name: r.name, line: l - r.first + 1 } : null;
  };
  return { source, compiled, ranges, where, layerOfPc: (pc) => { const l = compiled.pyOfPc(pc); return l === null ? null : where(l)?.name ?? null; } };
}
