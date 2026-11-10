// The VHDL view checked by a VHDL tool: each design's hierarchy file (sim/vhdl.ts vhdlHierarchy) analysed and elaborated by
// GHDL (VHDL-93), and the combinational ones simulated by GHDL on vectors whose expected outputs come from our own simulation
// (every input combination up to 12 bits, else 256 seeded random ones). CI only (.github/workflows/vhdl.yml; not a deploy gate):
// there is no GHDL on Windows here.
//
//   npx vite-node scripts/vhdl-check.ts [--out dir] [--dump]     --dump: only write the files
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/lib';
import { PROGRAMS } from '../src/riscv/programs';
import { assemble } from '../src/riscv/asm';
import { singleCycleCpu } from '../src/lib/cpu';
import { bigRam } from '../src/lib/bigmem';
import { registry } from '../src/lib/define';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { entityName, vhdlHierarchy, vhdlPorts } from '../src/sim/vhdl';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : '.cache/vhdl';
const dump = args.includes('--dump');

/** Combinational designs: simulated against ours. */
const COMB = ['nand', 'not', 'xor', 'mux2', 'full_adder_ha', 'full_adder', 'rca4', 'rca8', 'rca32', 'alu32', 'alu32ks', 'dec3'];
/** Sequential or large ones: analysed and elaborated only. core_plane4: ferrite cores, a primitive below the gate level (comments, no entity). */
const ELAB = ['dff', 'sr_latch', 'd_latch', 'reg8', 'reg32', 'ram8x6', 'ram8x16', 'regfile32x32', 'inv_cmos', 'core_plane4'];

const designs: [ComponentDef, boolean][] = [];
// an id that is not registered is an error, not a design quietly left out (fa, fa9 and decoder3 were, for a while)
const must = (id: string) => { const d = registry.get(id); if (!d) throw new Error(`vhdl-check: no registered part '${id}'`); return d; };
for (const id of COMB) designs.push([must(id), true]);
for (const id of ELAB) designs.push([must(id), false]);
designs.push([singleCycleCpu(assemble(PROGRAMS[0].source).words), false]);
// a behaviour leaf: an entity with its ports and a comment architecture (a generator, so built here, not looked up)
designs.push([bigRam(8, 8), false]);

const bits = (v: number, w: number) => (w === 1 ? `'${v & 1}'` : `"${(v >>> 0).toString(2).padStart(w, '0').slice(-w)}"`);
// numbers past 32 bits: BigInt
const bitsBig = (v: number, w: number) => (w <= 32 ? bits(v, w) : `"${BigInt(v).toString(2).padStart(w, '0').slice(-w)}"`);

function vectors(def: ComponentDef): number[][] {
  const ins = def.ports.filter((p) => p.dir === 'in');
  const total = ins.reduce((a, p) => a + p.width, 0);
  if (total <= 12) { const all: number[][] = []; forEachInput(def, (v) => all.push([...v])); return all; }
  let s = 0x2545f491;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  return Array.from({ length: 256 }, () => ins.map((p) => (p.width >= 32 ? rnd() : rnd() % 2 ** p.width)));
}

/** A self-checking testbench: each vector applied, 1 ns later every output compared with our simulation's. */
function testbench(def: ComponentDef): { text: string; n: number } {
  const pn = vhdlPorts(def);
  const ins = def.ports.filter((p) => p.dir === 'in'), outs = def.ports.filter((p) => p.dir === 'out');
  const sim = simulate(def);
  const vs = vectors(def);
  const ty = (w: number) => (w > 1 ? `std_logic_vector(${w - 1} downto 0)` : 'std_logic');
  const L = ['library ieee;', 'use ieee.std_logic_1164.all;', '', `entity tb_${entityName(def)} is`, `end entity tb_${entityName(def)};`, '',
    `architecture test of tb_${entityName(def)} is`];
  for (const p of [...ins, ...outs]) L.push(`  signal t_${pn.get(p.name)} : ${ty(p.width)};`);
  L.push('begin', `  dut : entity work.${entityName(def)} port map (${def.ports.map((p) => `${pn.get(p.name)} => t_${pn.get(p.name)}`).join(', ')});`, '  process', '  begin');
  let n = 0;
  for (const v of vs) {
    const want = evalOnce(sim, v);
    ins.forEach((p, i) => L.push(`    t_${pn.get(p.name)} <= ${bitsBig(v[i], p.width)};`));
    L.push('    wait for 1 ns;');
    outs.forEach((p, i) => {
      if (want[i] < 0) return;
      L.push(`    assert t_${pn.get(p.name)} = ${bitsBig(want[i], p.width)} report "vector ${n}: ${p.name} /= ${want[i]}" severity error;`);
    });
    n++;
  }
  L.push(`    report "${def.id}: ${n} vectors done";`, '    wait;', '  end process;', 'end architecture test;');
  return { text: L.join('\n') + '\n', n };
}

mkdirSync(out, { recursive: true });
const ghdl = (...a: string[]) => execFileSync('ghdl', a, { cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let failed = 0;
for (const [def, comb] of designs) {
  const top = entityName(def);
  const lib = `w_${top}`;
  const { text, entities } = vhdlHierarchy(def);
  writeFileSync(join(out, `${top}.vhd`), text);
  const tb = comb ? testbench(def) : null;
  if (tb) writeFileSync(join(out, `tb_${top}.vhd`), tb.text);
  if (dump) { console.log(`${top}.vhd: ${entities} entities${tb ? `, testbench ${tb.n} vectors` : ''}`); continue; }
  // each design in its own work directory: two files may both declare nand2
  const wd = `--workdir=${lib}`;
  mkdirSync(join(out, lib), { recursive: true });
  try {
    ghdl('-a', '--std=93', wd, `${top}.vhd`);
    ghdl('-e', '--std=93', wd, top);
    let ran = '';
    if (tb) {
      ghdl('-a', '--std=93', wd, `tb_${top}.vhd`);
      ghdl('-e', '--std=93', wd, `tb_${top}`);
      ran = ghdl('-r', '--std=93', wd, `tb_${top}`, '--assert-level=error').trim().split('\n').pop() ?? '';
    }
    console.log(`ok   ${top}: ${entities} entities${tb ? `, ${tb.n} vectors simulated (${ran})` : ', analysed and elaborated'}`);
  } catch (e) {
    failed++;
    const err = e as { stdout?: string; stderr?: string; message: string };
    console.log(`FAIL ${top}\n${(err.stderr || err.stdout || err.message).split('\n').slice(0, 20).join('\n')}`);
  }
}
if (failed) { console.log(`${failed} of ${designs.length} designs failed`); process.exit(1); }
console.log(dump ? `wrote ${designs.length} designs to ${out}` : `all ${designs.length} designs passed GHDL`);
