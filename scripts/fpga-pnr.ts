// The FPGA chapter's numbers (docs/PLAN-FPGA.md stage 2): the sandbox's FPGA export of each example (editor/fpga.ts, as
// File ▸ Export Verilog for FPGA… makes it) through Yosys synth_gowin and nextpnr-himbaechel (Gowin, Apicula's chip
// database) for the Tang Nano 9K, beside our own estimates (lutMap's LUT levels, static timing in NAND delays).
//   - device use after place and route (LUT4, ALU, DFF, BSRAM against what the GW1NR-9 has)
//   - LUTs, flip-flops and block RAMs per block, by the hierarchical names Yosys keeps when it flattens
//   - post-route Fmax per clock and the design clock's critical path split into clock skew, clk-to-q, logic, routing, setup
// The board top divides 27 MHz (DIV_LOG2 = 22) as exported; nextpnr is asked for 27 MHz on every clock, which the
// memory clock's paths through the design's single-cycle logic cannot meet and need not (they have thousands of board
// cycles to settle), so --timing-allow-fail: the numbers are the measurement, not a pass / fail.
// Writes src/fpga/fpgacosts.json with --write (checked in; tests/fpgacosts.test.ts fails when an export no longer hashes the same).
// Needs yowasp-yosys and yowasp-nextpnr-himbaechel-gowin (pip; YOSYS / NEXTPNR env vars override). CI: .github/workflows/fpga.yml.
// Run: npx vite-node scripts/fpga-pnr.ts [example …] [--write]   (default: counter7 computer)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { BOARD, fpgaExport } from '../src/editor/fpga';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { flatten } from '../src/sim/flatten';
import { lutMap } from '../src/sim/lutmap';
import { analyzeTiming } from '../src/sim/timing';
import { exportHash, type FpgaCosts, type FpgaExample } from '../src/fpga/costs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const ids = args.filter((a) => !a.startsWith('--'));
const scripts = join(process.env.APPDATA ?? '', 'Python/Python313/Scripts');
const tool = (env: string, name: string) => process.env[env] ?? (existsSync(join(scripts, `${name}.exe`)) ? join(scripts, `${name}.exe`) : name);
const yosys = tool('YOSYS', 'yowasp-yosys'), nextpnr = tool('NEXTPNR', 'yowasp-nextpnr-himbaechel-gowin');
// nextpnr prints its version on stderr
const firstLine = (cmd: string, flag: string) => { const r = spawnSync(cmd, [flag], { encoding: 'utf8' }); return `${r.stdout}${r.stderr}`.trim().split('\n')[0]; };

const BSRAM = /^(SP|SPX9|DP|DPX9|DPB|DPX9B|SDP|SDPX9|SDPB|SDPX9B|pROM|pROMX9)$/;
const LUT = /^LUT\d$/;

/**
 * LUTs, flip-flops and block RAMs by the block they came from: Yosys keeps the hierarchical name of the net a cell
 * drives when it flattens (dut.cpu.rf.w15…), so a cell is counted in dut.<block> and dut.<block>.<part>; cells named
 * after the board top's own nets go to "board", ones Yosys named itself ($…) to "(unnamed)".
 */
function byBlock(netlist: { modules: Record<string, { cells: Record<string, { type: string }> }> }, board: string): FpgaExample['blocks'] {
  const cells = netlist.modules[board]?.cells ?? {};
  const acc = new Map<string, { luts: number; ffs: number; bsram: number }>();
  const add = (k: string, type: string) => {
    const a = acc.get(k) ?? { luts: 0, ffs: 0, bsram: 0 };
    if (LUT.test(type)) a.luts++;
    else if (type.startsWith('DFF')) a.ffs++;
    else if (BSRAM.test(type)) a.bsram++;
    else return;
    acc.set(k, a);
  };
  for (const [name, c] of Object.entries(cells)) {
    const p = name.split('.');
    if (p[0] === 'dut' && p.length > 2) {
      add(p[1], c.type);
      if (p.length > 3) add(`${p[1]}.${p[2]}`, c.type);
    } else add(name.startsWith('$') ? '(unnamed)' : 'board', c.type);
  }
  return [...acc].map(([name, a]) => ({ name, ...a })).filter((b) => b.luts + b.ffs + b.bsram > 0).sort((x, y) => y.luts - x.luts || x.name.localeCompare(y.name));
}

/** nextpnr's clock names in the chapter's words: the board's 27 MHz pin, the design's clock, the memories' read clock. */
const clockName = (k: string) => (k.includes('clk_27m') ? 'board' : k.includes('mem_clk') ? 'mem_clk' : k.replace(/^p_/, ''));

const examples: Record<string, FpgaExample> = {};
for (const id of ids.length ? ids : ['counter7', 'computer']) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(`no example ${id}`);
  const { ws, id: chip } = addExample(emptyWorkspace(), ex);
  const c = new UserLibrary(ws).compiled(chip)!;
  const out = fpgaExport(c.def, id);
  if (!out.ok) throw new Error(`${id}: export failed: ${out.issues.map((i) => i.text).join('; ')}`);
  const dir = join('layout', 'fpga', id);
  mkdirSync(dir, { recursive: true });
  for (const f of out.files) writeFileSync(join(dir, f.name), f.text);
  console.log(`${id}: synthesizing…`);
  execFileSync(yosys, ['-q', '-l', 'pnr-synth.log', '-p', `read_verilog ${id}.v ${id}_board.v; synth_gowin -top ${out.board} -json pnr.json`], { cwd: dir, stdio: 'inherit' });
  console.log(`${id}: placing and routing…`);
  execFileSync(nextpnr, ['--device', BOARD.device, '--vopt', `family=${BOARD.family}`, '--vopt', 'cst=tangnano9k.cst', '--json', 'pnr.json',
    '--report', 'report.json', '--freq', String(BOARD.clockMHz), '--timing-allow-fail', '--seed', '1', '-l', 'pnr.log', '-q'], { cwd: dir, stdio: 'inherit' });
  const r = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as {
    fmax: Record<string, { achieved: number }>; utilization: Record<string, { used: number; available: number }>;
    critical_paths: { from: string; to: string; path: { type: string; delay: number }[] }[];
  };
  // LUTs as synthesized (LUT1-4 cells), after packing (nextpnr's first utilisation table), after routing (its report)
  const net = JSON.parse(readFileSync(join(dir, 'pnr.json'), 'utf8')) as { modules: Record<string, { cells: Record<string, { type: string }> }> };
  const synthLuts = Object.values(net.modules[out.board].cells).filter((x) => LUT.test(x.type)).length;
  const packedLuts = Number(/LUT4:\s+(\d+)\//.exec(readFileSync(join(dir, 'pnr.log'), 'utf8'))?.[1] ?? NaN);
  const use = (k: string) => ({ used: r.utilization[k]?.used ?? 0, available: r.utilization[k]?.available ?? 0 });
  // the design clock's own path (posedge clk → posedge clk), else the slowest
  const own = r.critical_paths.find((p) => p.from === 'posedge clk' && p.to === 'posedge clk') ?? r.critical_paths[0];
  const sum = (t: string) => +own.path.filter((s) => s.type === t).reduce((a, s) => a + s.delay, 0).toFixed(3);
  // ours: LUT levels on the deepest path between registers, memories and pins; the static period in NAND delays
  const flat = flatten(c.def, { mode: 'gate' });
  const m = lutMap(flat);
  const st = analyzeTiming(flat);
  const one: FpgaExample = {
    exportHash: exportHash(out.files),
    device: { lut4: use('LUT4'), alu: use('ALU'), dff: use('DFF'), bsram: use('BSRAM') },
    lut4Stages: { synth: synthLuts, packed: packedLuts, routed: use('LUT4').used },
    blocks: byBlock(net, out.board),
    fmax: Object.fromEntries(Object.entries(r.fmax).map(([k, v]) => [clockName(k), +v.achieved.toFixed(2)])),
    critical: {
      clock: `${own.from} → ${own.to}`, ns: +own.path.reduce((a, s) => a + s.delay, 0).toFixed(3),
      skew: sum('clk-skew'), clkToQ: sum('clk-to-q'), logic: sum('logic'), routing: sum('routing'), setup: sum('setup'),
      luts: own.path.filter((s) => s.type === 'logic').length,
    },
    ours: { nands: m.nands + m.loops.length, lutMapLuts: m.luts.length, lutLevels: m.depth, period: st?.period ?? null },
  };
  examples[id] = one;
  console.log(`${id}:`, JSON.stringify(one));
}

const costs: FpgaCosts = {
  board: BOARD.name, device: BOARD.device,
  tools: { yosys: firstLine(yosys, '-V').replace(/\s*\(.*$/, '').trim(), nextpnr: (/Version\s*([^)]+)/.exec(firstLine(nextpnr, '--version'))?.[1] ?? '').trim() },
  examples,
};
if (write) {
  const f = 'src/fpga/fpgacosts.json';
  const old = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as FpgaCosts) : null;
  writeFileSync(f, `${JSON.stringify({ ...costs, examples: { ...old?.examples, ...examples } }, null, 1)}\n`);
  console.log(`wrote ${f}`);
}
