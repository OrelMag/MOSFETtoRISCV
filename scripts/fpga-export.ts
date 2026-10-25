// The sandbox's FPGA export (File ▸ Export Verilog for FPGA…) on its examples, through the same function the
// menu calls (editor/fpga.ts fpgaExport), then Yosys's Gowin synthesis (synth_gowin) of the design with its
// board top: what CI runs, so an export the Tang Nano flow would reject fails the deploy.
// Needs Yosys (YOSYS env var, or yowasp-yosys from pip).
// Run: npx vite-node scripts/fpga-export.ts [example …] (default: counter7 computer; ids from editor/examples.ts)
// Writes layout/fpga/<example>/ (the files the menu downloads, and synth.log). Exits 1 on an export error, a
// Yosys error, or a design Yosys reduced to nothing (an export that lost its outputs).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { fpgaExport } from '../src/editor/fpga';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['counter7', 'computer'];
const local = join(process.env.APPDATA ?? '', 'Python/Python313/Scripts/yowasp-yosys.exe');
const yosys = process.env.YOSYS ?? (existsSync(local) ? local : 'yowasp-yosys');
let failed = 0;
for (const id of ids) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(`no example ${id}: ${EXAMPLES.map((e) => e.id).join(' ')}`);
  const { ws, id: chip } = addExample(emptyWorkspace(), ex);
  const c = new UserLibrary(ws).compiled(chip)!;
  const errs = c.diags.filter((d) => d.level === 'error');
  if (errs.length) throw new Error(`${id}: the example does not compile: ${errs.map((d) => d.msg).join('; ')}`);
  const out = fpgaExport(c.def, id);
  for (const i of out.issues) console.log(`${id}: ${i.level}: ${i.text}`);
  if (!out.ok) { failed++; continue; }
  const dir = join('layout', 'fpga', id);
  mkdirSync(dir, { recursive: true });
  for (const f of out.files) writeFileSync(join(dir, f.name), f.text);
  const script = `read_verilog ${id}.v ${id}_board.v; synth_gowin -top ${out.board} -json ${id}.json; tee -o stat.txt stat`;
  try {
    execFileSync(yosys, ['-q', '-l', 'synth.log', '-p', script], { cwd: dir, stdio: 'inherit' });
  } catch {
    console.log(`${id}: Yosys failed (see ${join(dir, 'synth.log')})`);
    failed++;
    continue;
  }
  // what the board top kept: an export whose outputs reach no pin would synthesize to an empty design
  const stat = readFileSync(join(dir, 'stat.txt'), 'utf8');
  const counts = [...stat.matchAll(/^\s+(\d+)\s+(\$\w+|[A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => ({ n: Number(m[1]), type: m[2] }));
  const sum = (re: RegExp) => counts.filter((c) => re.test(c.type)).reduce((n, c) => n + c.n, 0);
  const luts = sum(/^LUT\d$/), ffs = sum(/^DFF/), cells = sum(/^(?!\$scopeinfo$|IBUF$|OBUF$|VCC$|GND$)/);
  console.log(`${id}: synth_gowin ${out.board}: ${cells} cells (${luts} LUTs, ${ffs} flip-flops), ${out.modules} modules exported`);
  if (cells < 10) { console.log(`${id}: Yosys left almost nothing: the outputs do not reach the board`); failed++; }
}
process.exit(failed ? 1 : 0);
