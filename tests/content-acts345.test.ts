// Acts 3–5 (state and memory, the instruction set, the single-cycle core): every number the level texts, cases,
// lessons, thread clauses and the control unit's brief quote is measured here, and the content is complete (a why
// that names a cost, tips, nudges, a case, the thread's uses / clauses / pitfalls for every dependent).

import { describe, expect, it } from 'vitest';
import { caseOf } from '../src/campaign/cases';
import { BUILD5, CTL_ROWS, ctlTable } from '../src/campaign/build5';
import { corePeriod, memLeaf, MEM_DELAY } from '../src/campaign/corecheck';
import { coreTests } from '../src/campaign/coretests';
import { decodeSame, DRILLS, explain16, randomInstr16, rng } from '../src/campaign/drills';
import { dependents } from '../src/campaign/graph';
import { LESSONS } from '../src/campaign/lessons';
import { libCost } from '../src/campaign/measure';
import { NODES, nodeById } from '../src/campaign/nodes';
import { NUDGES, tipsOf } from '../src/campaign/nudges';
import { PUZZLES, puzzleUnit } from '../src/campaign/puzzles';
import { threadOf } from '../src/campaign/thread';
import { ACT_ENDS } from '../src/campaign/actends';
import { controlSpec, CTL_OUTS, rv16Core } from '../src/lib/rv16/cpu';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { decode16, encI, encJ, encSB, encSH, encU, INSTRS16, MMIO16, REG_NAMES16 } from '../src/riscv/rv16/isa16';
import { Iss16 } from '../src/riscv/rv16/iss16';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { analyzeTiming, CLK_TO_Q, SETUP } from '../src/sim/timing';
import { resolveComponent } from '../src/lib/resolve';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';

const ACTS = [3, 4, 5];
const mine = NODES.filter((n) => ACTS.includes(n.act));
const node = (id: string) => nodeById(id)!;
const par = (id: string) => node(id).par!;
const nand = (id: string) => libCost(id)!.nand;
const fmt = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const why = (id: string) => plain(node(id).why);
const lesson = (k: string) => plain(LESSONS[k]);

/** The single-cycle core's critical path on the bench (8-delay memories), as the thread test builds it. */
function benchPath(core: ComponentDef) {
  const IMEM = memLeaf('bench_imem', 'instruction memory'), DMEM = memLeaf('bench_dmem', 'data memory');
  const bench: ComponentDef = {
    id: `bench_acts345_${core.id}`, name: 'core bench', category: 'cpu', symbol: { kind: 'box' },
    ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
    netlist: () => ({
      instances: [{ name: 'core', def: core }, { name: 'imem', def: IMEM }, { name: 'dmem', def: DMEM }],
      nets: [{ ends: ['clk', 'core.clk'] }, { ends: ['rst', 'core.rst'] }, { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        { ends: ['core.daddr', 'dmem.addr'] }, { ends: ['dmem.data', 'core.drdata'] }],
    }),
  };
  const r = analyzeTiming(flatten(bench, { mode: 'gate' }))!;
  const alu = netlistOf(core)!.instances.find((i) => i.def.id === 'rv16_alu16')!.name;
  return { period: r.period, inAlu: r.path.filter((p) => p.node[0] === 'core' && p.node[1] === alu).length, through: new Set(r.path.map((p) => p.node[0])) };
}

describe('acts 3–5 are complete', () => {
  it('every level has a why of 2–4 sentences that names a number, and a case', () => {
    for (const n of mine) {
      const s = plain(n.why).split(/(?<=[.!?])\s+(?=[A-Z0-9<])/).length;
      expect(s, `${n.id}: ${s} sentences`).toBeGreaterThanOrEqual(2);
      expect(s, `${n.id}: ${s} sentences`).toBeLessThanOrEqual(4);
      expect(n.why.length, `${n.id} why is long`).toBeLessThanOrEqual(430);
      expect(/\d/.test(n.why), `${n.id}: the why names a cost`).toBe(true);
      expect(caseOf(n.id), `${n.id}: case`).toBeDefined();
    }
  });

  it('every build, core, drill and program level has a nudge and 2–4 tips', () => {
    for (const n of mine.filter((m) => m.kind !== 'lesson')) {
      expect(NUDGES[n.id], `${n.id}: nudge`).toBeTruthy();
      expect(n.tips.length, `${n.id}: tips`).toBeGreaterThanOrEqual(2);
      expect(n.tips.length, `${n.id}: tips`).toBeLessThanOrEqual(4);
      expect(tipsOf(n)[0]).toBe(NUDGES[n.id]);
    }
    // p_add's second tip is the program's shape, not the program
    expect(node('p_add').tips.join(' ')).not.toMatch(/<code>add/);
  });

  it('fills the thread: uses, pitfalls, a clause for every dependent', () => {
    for (const n of mine) {
      const t = threadOf(n.id);
      expect(t?.uses?.length || n.anatomy?.length, `${n.id} uses`).toBeTruthy();
      expect(t?.pitfalls?.length, `${n.id} pitfalls`).toBeGreaterThanOrEqual(2);
      for (const d of dependents(n.id)) expect(t?.usedFor?.[d.id], `${n.id} → ${d.id}`).toBeTruthy();
    }
  });

  it('links a chapter step from every lesson and every build / core level of the main path', () => {
    for (const n of mine.filter((m) => !m.optional && m.kind !== 'program')) expect(n.chapters?.length, n.id).toBeTruthy();
  });
});

describe('numbers in the whys', () => {
  it('act 3', () => {
    expect(why('s_sr')).toContain(`${par('s_sr').nand} NANDs`);
    expect(why('s_dlatch')).toContain(`${par('s_dlatch').nand} NANDs at par`);
    expect(CLK_TO_Q).toBe(3);
    expect(SETUP).toBe(3);
    expect(why('s_dff')).toContain(`${par('s_dff').nand} NANDs a bit`);
    expect(why('s_dff')).toContain(`${SETUP} delays each`);
    expect(why('s_reg4')).toContain(`${nand('rv16_dffe')} NANDs a bit, ${par('s_reg4').nand} for four at par`);
    expect(nand('rv16_dffe')).toBe(nand('rv16_dff') + 4);
    const r16 = par('s_reg16');
    expect(why('s_reg16')).toContain(`${r16.nand} NANDs at par, period ${r16.period} (clk-to-q ${CLK_TO_Q}, the enable mux ${r16.period! - CLK_TO_Q - SETUP}, setup ${SETUP})`);
    expect(libCost('rv16_mux16')!.depth! - 1).toBe(r16.period! - CLK_TO_Q - SETUP); // the 2:1 mux's path from q (s is settled)
    expect(why('s_cnt4')).toContain(`${par('s_cnt4').nand} NANDs at period ${par('s_cnt4').period}`);
    expect(why('s_pc')).toContain(`${par('s_pc').nand} NANDs at period ${par('s_pc').period}`);
    expect(why('s_fsm')).toContain(`${par('s_fsm').nand} NANDs at par`);
    expect(why('m_ram')).toContain(`${par('m_ram').nand} NANDs for 16 bits, about ${Math.round(par('m_ram').nand! / 16)} NANDs a bit`);
    expect(libCost('sram6t')!.transistors).toBe(6);
    expect(why('m_rf')).toContain(`${fmt(par('m_rf').nand!)} NANDs at par: nearly half of Core III`);
    const half = par('m_rf').nand! / par('c_core3').nand!;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.5);
    const ram = nand('ram64x16');
    expect(why('m_mem')).toContain(`${fmt(ram)} NANDs, over four times Core III`);
    expect(Math.floor(ram / par('c_core3').nand!)).toBe(4);
    expect(Math.round(ram / 1024)).toBe(20);
    expect(Math.round(par('m_rf').nand! / 112)).toBe(19); // "about 20 NANDs a bit"
  });

  it('act 4', () => {
    const base = INSTRS16.filter((i) => !i.ext).length;
    expect(base).toBe(23);
    expect(why('i_isa')).toContain(`RV16I's ${base} instructions`);
    expect(why('i_enc')).toContain(`in ${par('c_ctl').nand} NANDs`);
    expect(DRILLS.isa16.goal).toBe(6);
    expect(why('i_enc')).toContain('Six right answers');
    for (const id of ['p_add', 'p_loop', 'p_mem', 'p_call', 'p_mul', 'p_sort', 'p_print']) {
      expect(PUZZLES[id], id).toBeDefined();
      expect(puzzleUnit(PUZZLES[id])).toBe('instructions');
    }
    expect(why('p_add')).toContain(`${par('p_add').size} words, ${par('p_add').cycles} instructions at par`);
    expect(why('p_loop')).toContain(`in ${par('p_loop').size} words, 4 instructions an iteration, ${par('p_loop').cycles} on average at par`);
    // the reference loop: 4 instructions per iteration
    const run = (n: number) => {
      const a = assemble16(PUZZLES.p_loop.ref);
      const m = new Iss16(a.words, {}, a.data);
      m.input = [n];
      while (!m.halted) m.step();
      return m.steps;
    };
    expect(run(11) - run(10)).toBe(4);
    expect(why('p_mem')).toContain(`${par('p_mem').size} words, ${par('p_mem').cycles} instructions on average at par`);
    expect(why('p_call')).toContain(`${par('p_call').size} words at par; gcd by subtraction averages ${fmt(par('p_call').cycles!)} instructions a test`);
    expect(why('p_mul')).toContain(`28 to 134 instructions (${par('p_mul').cycles} on average at par)`);
    expect(why('p_sort')).toContain(`${par('p_sort').size} words and ${par('p_sort').cycles} instructions on average at par`);
    expect(why('p_print')).toContain(`${par('p_print').size} words, ${par('p_print').cycles} instructions on average at par`);
  });

  it('act 5', () => {
    const c1 = par('c_core1'), c2 = par('c_core2'), c3 = par('c_core3'), c4 = par('c_fast');
    const path = benchPath(rv16Core(true));
    expect(path.period).toBe(c3.period);
    expect(why('c_lesson')).toContain(`an ALU (${fmt(nand('rv16_alu16'))} NANDs), a register file (${fmt(nand('rv16_rf'))})`);
    expect(why('c_lesson')).toContain(`the ripple ALU is ${path.inAlu} of Core III's ${c3.period} delays`);
    expect(why('c_imm')).toContain(`par ${par('c_imm').nand} NANDs`);
    expect(nand('rv16_imm')).toBe(0);
    expect(why('c_ctl')).toContain(`${par('c_ctl').nand} NANDs and ${par('c_ctl').depth} delays at par`);
    expect(why('c_ctl')).toContain(`${par('c_ctl').depth} delays after the word arrives`);
    expect(why('c_br')).toContain(`Equality you built in Act 1 (${par('g_eq16').nand} NANDs), Set if less than from Act 2 (${nand('rv16_cmp16')})`);
    expect(nand('rv16_eq16')).toBe(par('g_eq16').nand);
    expect(why('c_br')).toContain(`${par('c_br').nand} NANDs at par`);
    expect(why('c_npc')).toContain(`${par('c_npc').nand} NANDs at par`);
    expect(why('c_core1')).toContain(`${fmt(c1.nand!)} NANDs and period ${c1.period} at par`);
    expect(corePeriod(rv16Core(false, false, '', true))).toBe(c1.period);
    expect(why('c_core2')).toContain(`only ${c2.nand! - c1.nand!} NANDs more, but the period goes from ${c1.period} to ${c2.period} delays`);
    expect(why('c_core3')).toContain(`${fmt(c3.nand!)} NANDs at par`);
    expect(why('c_core3')).toContain(`Its ${c3.period}-delay period, ${path.inAlu} of them in the ripple ALU`);
    const pc = par('c_computer');
    expect(why('c_computer')).toContain(`${fmt(pc.nand!)} NANDs at par, three quarters of them the RAM`);
    expect(Math.round(4 * nand('ram64x16') / pc.nand!)).toBe(3);
    expect(why('c_fast')).toContain(`period is ${c3.period} NAND delays, and ${path.inAlu} of them are the ripple ALU`);
    expect(why('c_fast')).toContain(`the same ${fmt(c4.cycles!)} cycles at period ${c4.period} (par)`);
    expect(c4.cycles).toBe(c3.cycles);
    expect(corePeriod(rv16Core(true, true))).toBe(c4.period);
  });
});

describe('lessons', () => {
  it('mem: a RAM as flip-flops, and the bench\'s memories', () => {
    const m = lesson('mem');
    expect(m).toContain(`A 64-word RAM built the same way is ${fmt(nand('ram64x16'))}`);
    expect(m).toContain(`counting ${MEM_DELAY} NAND delays each`);
  });

  it('isa: names, ranges, devices and expansions are the assembler\'s and the golden model\'s', () => {
    const t = LESSONS.isa;
    // registers
    expect(REG_NAMES16).toEqual(['zero', 'ra', 'sp', 'a0', 'a1', 'a2', 't0', 't1']);
    expect(t).toContain('<tr><th>x3–x5</th><td>a0–a2</td>');
    expect(t).toContain('a0 is x3');
    // ranges, from the encoders
    expect(() => encI(4, 1, 0, -32)).not.toThrow();
    expect(() => encI(4, 1, 0, 32)).toThrow();
    expect(() => encSB(8, 0, 0, -33)).toThrow();
    expect(() => encJ(0, -256)).not.toThrow();
    expect(() => encJ(0, 256)).toThrow();
    expect(() => encU(0, 1023)).not.toThrow();
    expect(() => encSH(0, 1, 1, 15)).not.toThrow();
    expect(() => encSH(0, 1, 1, 16)).toThrow();
    for (const row of ['<th>imm6</th><td>−32 … 31</td>', '<th>imm9</th><td>−256 … 255</td>', '<th>imm10</th><td>0 … 1023</td>', '<th>shift</th><td>0 … 15</td>']) expect(t).toContain(row);
    // devices: offset from x0, address, name
    for (const [name, addr] of Object.entries(MMIO16)) {
      const off = addr - 0x10000;
      expect(t, name).toContain(`<tr><th>−${-off}</th><td>0x${addr.toString(16).toUpperCase()}</td><td>${name}:`);
    }
    // expansions
    const size = (s: string) => assemble16(s).words.length;
    expect(size('li a0, 31')).toBe(1);
    expect(size('li a0, 128')).toBe(1);
    expect(size('li a0, 1000')).toBe(2);
    expect(size('la a0, 0x123')).toBe(2);
    expect(size('push a0')).toBe(2);
    expect(size('pop a0')).toBe(2);
    expect(size('seqz a0, a1')).toBe(3);
    expect(assemble16('push a0').words).toEqual(assemble16('addi sp, sp, -1\nsw a0, 0(sp)').words);
    expect(assemble16('pop a0').words).toEqual(assemble16('lw a0, 0(sp)\naddi sp, sp, 1').words);
    expect(assemble16('ret').words).toEqual(assemble16('jalr x0, 0(ra)').words);
    expect(assemble16('halt').words).toEqual([0x000c]);
    expect(assemble16('nop').words).toEqual([0x0004]);
    expect(t).toContain('<tr><th>halt</th><td>0x000C</td>');
    expect(t).toContain('<tr><th>nop</th><td>0x0004</td>');
    expect(t).toContain('<tr><th>seqz rd, rs</th><td>3 words</td>');
    // what is left out
    for (const op of ['andi', 'ori', 'xori', 'slti', 'sltiu', 'bltu', 'bgeu', 'lb', 'sb']) expect(INSTRS16.some((i) => i.name === op), op).toBe(false);
  });

  it('datapath: the settings table is the control unit, the costs and the critical path are measured', () => {
    const d = lesson('datapath');
    expect(d).toContain(`the register file ${fmt(nand('rv16_rf'))} NANDs, the ALU ${fmt(nand('rv16_alu16'))}, the branch comparator ${nand('rv16_branch')}, next PC ${nand('rv16_nextpc')}, control ${nand('rv16_ctl')}.`);
    expect(d).toContain(`Core III is ${fmt(par('c_core3').nand!)} NANDs`);
    const path = benchPath(rv16Core(true));
    expect(path.through.has('imem') && path.through.has('dmem'), 'the critical path is a load\'s').toBe(true);
    expect(d).toContain(`control (${par('c_ctl').depth} delays) → ALU → data memory → result mux → register file, ${path.period} NAND delays with the bench's ${MEM_DELAY}-delay memories, ${path.inAlu} of them in the ripple ALU`);
    expect(d).toContain(`Core I, with no loads, runs at ${par('c_core1').period}`);
    expect(d).toContain(`Core IV, period ${par('c_fast').period}`);
    expect(d).toContain(`Act 6's pipeline, period ${par('pi_core3').period}`);
    // the settings table against controlSpec: bimm (ALU b), isel (immediate), wb (rd ←), rwe, mwe
    const rows = [...LESSONS.datapath.matchAll(/<tr><th>([^<]+)<\/th>((?:<td>[^<]*<\/td>)+)<\/tr>/g)].map((m) => [m[1], ...[...m[2].matchAll(/<td>([^<]*)<\/td>/g)].map((c) => c[1])]);
    const word: Record<string, string> = { 'R-type': 'add a0, a1, a2', addi: 'addi a0, a1, 1', 'slli srli srai': 'slli a0, a1, 1', lui: 'lui a0, 1', lw: 'lw a0, 1(a1)', sw: 'sw a0, 1(a1)', branches: 'beq a0, a1, 1', jal: 'jal a0, 1', jalr: 'jalr a0, 1(a1)' };
    const at = (k: string) => CTL_OUTS.indexOf(k as (typeof CTL_OUTS)[number]);
    expect(rows.map((r) => r[0])).toEqual(Object.keys(word));
    for (const [label, aluB, imm, , rd, memory] of rows) {
      const { out, care } = controlSpec(assemble16(word[label]).words[0]);
      expect(aluB === '–' ? 'X' : aluB === 'imm' ? 1 : 0, `${label} ALU b`).toBe(care[at('bimm')] ? out[at('bimm')] : 'X');
      expect(imm === '–' ? 'X' : ['I', 'S/B', 'J', 'U'].indexOf(imm), `${label} immediate`).toBe(care[at('isel')] ? out[at('isel')] : 'X');
      expect(rd === 'no write' ? 0 : 1, `${label} rwe`).toBe(out[at('rwe')]);
      if (rd !== 'no write') expect(['ALU', 'memory', 'pc + 1', 'imm'].indexOf(rd), `${label} wb`).toBe(out[at('wb')]);
      expect(memory.startsWith('write') ? 1 : 0, `${label} mwe`).toBe(out[at('mwe')]);
    }
  });
});

describe('cases', () => {
  it('i_isa, i_enc and c_lesson quote measured costs', () => {
    const isa = plain(caseOf('i_isa')!.cost!);
    expect(isa).toContain(`${INSTRS16.filter((i) => !i.ext).length} instructions in 16-bit words`);
    expect(isa).toContain(`the register file is ${fmt(nand('rv16_rf'))} NANDs`);
    expect(isa).toContain(`the immediate generator ${nand('rv16_imm')} NANDs`);
    const ctl = resolveCtlDecoder();
    expect(isa).toContain(`a 4→16 decoder, ${ctl.nand} of its ${nand('rv16_ctl')} NANDs`);
    const enc = plain(caseOf('i_enc')!.cost!);
    expect(enc).toContain(`★★★ allows two mistakes`);
    expect(par('i_enc').mistakes).toBe(2);
    expect(enc).toContain(`${par('c_ctl').nand} NANDs and ${par('c_ctl').depth} delays at par, of which the 4→16 opcode decoder is ${ctl.nand} NANDs and ${ctl.depth} delays`);
    const dp = plain(caseOf('c_lesson')!.cost!);
    const parts = { rf: nand('rv16_rf'), alu: nand('rv16_alu16'), npc: nand('rv16_nextpc'), br: nand('rv16_branch'), ctl: nand('rv16_ctl') };
    const rest = stats(rv16Core(true)).nands - Object.values(parts).reduce((a, b) => a + b, 0);
    expect(dp).toContain(`${fmt(par('c_core3').nand!)} NANDs, of which the register file is ${fmt(parts.rf)}, the ALU ${fmt(parts.alu)}, next PC ${parts.npc}, the branch comparator ${parts.br} and control ${parts.ctl}; the other ${rest} are bus muxes and the PC's flip-flops`);
    const others = netlistOf(rv16Core(true))!.instances.filter((i) => !['rv16_rf', 'rv16_alu16', 'rv16_nextpc', 'rv16_branch', 'rv16_ctl'].includes(i.def.id) && stats(i.def).nands > 0);
    expect(others.every((i) => /mux|dreg/.test(i.def.id)), others.map((i) => i.def.id).join()).toBe(true);
    expect(dp).toContain(`period, ${par('c_core3').period} NAND delays, is set by a load's path, and ${benchPath(rv16Core(true)).inAlu} of those delays are the ripple ALU`);
  });
});

/** The control unit's opcode decoder: the first stage of rv16_ctl. */
function resolveCtlDecoder() {
  const dec = netlistOf(resolveComponent('rv16_ctl')!)!.instances.find((i) => i.def.id === 'dec4');
  expect(dec).toBeDefined();
  return libCost(dec!.def.id)!;
}

describe('the thread\'s numbers', () => {
  const T = (id: string) => plain(Object.values(threadOf(id)?.usedFor ?? {}).concat(threadOf(id)?.pitfalls ?? []).join(' '));
  it('pins its clauses and pitfalls', () => {
    expect(T('s_reg16')).toContain(`${nand('rv16_dreg16')} NANDs instead of ${nand('rv16_reg16')}`);
    expect(T('s_reg16')).toContain(`wastes ${nand('rv16_reg16') - nand('rv16_dreg16')} NANDs`);
    expect(T('s_pc')).toContain(`costs ${nand('rv16_reg16') - nand('rv16_dreg16')} NANDs`);
    expect(T('m_rf')).toContain(`costs ${nand('rv16_reg16')} NANDs`);
    expect(T('c_ctl')).toContain(`${par('c_ctl').depth} delays after the word arrives`);
    expect(T('c_fast')).toContain(`add ${nand('rv16_nextpc_ks') - nand('rv16_nextpc')} NANDs and leave the period at ${par('c_fast').period}`);
    expect(T('c_fast')).toContain(`${nand('rv16_alu16ks') - nand('rv16_alu16')} NANDs more than the ripple one`);
    expect(stats(rv16Core(true, true)).nands - stats(rv16Core(true)).nands).toBe(nand('rv16_alu16ks') - nand('rv16_alu16'));
    expect(T('c_fast')).toContain(`the ${par('c_fast').period}-delay cycle`);
  });

  it('keeps the act-end cards true', () => {
    expect(plain(ACT_ENDS[4].can)).not.toMatch(/stack/); // p_call's gcd is a leaf: nothing in act 4 uses the stack
  });
});

describe('the control unit\'s brief', () => {
  it('shows controlSpec, X where the check does not look', () => {
    const brief = BUILD5.c_ctl().brief;
    expect(brief).toContain(ctlTable());
    const ops = new Map<string, number[]>([['OP', [1]], ['OPX', [2]], ['ADDI', [4]], ['SHI', [5]], ['LW', [6]], ['LUI', [7, 15]], ['B', [8, 9, 10, 11]], ['JAL', [12]], ['JALR', [13]], ['SW', [14]], ['SYS, MD', [0, 3]]]);
    expect(CTL_ROWS.map((r) => r.label)).toEqual([...ops.keys()]);
    for (const r of CTL_ROWS) {
      // every opcode of the row (any f3) has the row's checked values
      for (const op of ops.get(r.label)!) for (let f3 = 0; f3 < 8; f3++) {
        const w = (f3 << 13) | op, a = controlSpec(w), b = controlSpec(r.word);
        a.care.forEach((c, i) => {
          if (CTL_OUTS[i] === 'alu') return;
          expect(c, `${r.label} op ${op} ${CTL_OUTS[i]} care`).toBe(b.care[i]);
          if (c) expect(a.out[i], `${r.label} op ${op} ${CTL_OUTS[i]}`).toBe(b.out[i]);
        });
      }
    }
    // the ALU column's texts
    const alu = (w: number) => controlSpec(w).out[CTL_OUTS.indexOf('alu')];
    for (let f3 = 0; f3 < 8; f3++) {
      expect(alu((f3 << 13) | 1)).toBe(f3);
      expect(alu((f3 << 13) | 2)).toBe(8 | f3);
      expect(alu((f3 << 13) | 5)).toBe([1, 5, 13, 13][f3 >> 1]);
    }
  });

  it('its tips\' ORs are the table\'s columns', () => {
    const tip = plain(node('c_ctl').tips.join(' '));
    const NAME: Record<string, number[]> = { OP: [1], OPX: [2], ADDI: [4], SHI: [5], LW: [6], LUI: [7, 15], B: [8, 9, 10, 11], JAL: [12], JALR: [13], SW: [14] };
    const bit = (sig: string, k: number) => (w: number) => (controlSpec(w).out[CTL_OUTS.indexOf(sig as (typeof CTL_OUTS)[number])] >> k) & 1;
    const checks: [string, (w: number) => number][] = [['rwe', bit('rwe', 0)], ['isel0', bit('isel', 0)], ['isel1', bit('isel', 1)], ['wb0', bit('wb', 0)], ['wb1', bit('wb', 1)]];
    for (const [name, f] of checks) {
      const m = tip.match(new RegExp(`${name} = ([A-Z +]+?)(?:[;.,]|$)`));
      expect(m, name).toBeTruthy();
      const listed = new Set(m![1].split('+').map((s) => s.trim()).flatMap((s) => NAME[s]));
      for (let op = 0; op < 16; op++) {
        const { care } = controlSpec(op);
        const sig = name.replace(/\d$/, '');
        if (!care[CTL_OUTS.indexOf(sig as (typeof CTL_OUTS)[number])]) continue;
        expect(listed.has(op) ? 1 : 0, `${name} op ${op}`).toBe(f(op));
      }
    }
  });
});

describe('the encode / decode drill', () => {
  it('generates every format, with negative immediates, and every question accepts its answer', () => {
    const r = rng(5), fmts = new Set<string>();
    let negative = 0;
    for (let i = 0; i < 400; i++) {
      const text = randomInstr16(r);
      const a = assemble16(text);
      expect(a.errors, text).toEqual([]);
      expect(a.words.length, text).toBe(1);
      const d = decode16(a.words[0]);
      fmts.add(d.spec!.fmt);
      if (d.imm < 0) negative++;
    }
    expect([...fmts].sort()).toEqual(['B', 'I', 'J', 'R', 'S', 'SH', 'U']);
    expect(negative).toBeGreaterThan(60);
    const q = DRILLS.isa16, rr = rng(9);
    let enc = 0, dec = 0;
    for (let i = 0; i < 200; i++) {
      const x = q.make(rr);
      expect(x.check(x.answer).ok, `${x.prompt} → ${x.answer}`).toBe(true);
      expect(x.explain).toBeTruthy();
      if (x.prompt.startsWith('Encode')) {
        enc++;
        const w = parseInt(x.answer.slice(2), 16);
        // one wrong bit is named by its field
        const bad = x.check(`0x${(w ^ 0x0010).toString(16)}`);
        expect(bad.ok).toBe(false);
        expect(bad.why).toMatch(/^wrong in (rd|imm\[2:0\])$/);
        expect(x.check(`0x${(w ^ 0x0001).toString(16)}`).why).toBe('wrong in op');
      } else {
        dec++;
        const w = parseInt(x.prompt.match(/0x([0-9A-F]{4})/)![1], 16);
        expect(decodeSame(assemble16(x.answer).words[0], w)).toBe(true);
      }
    }
    expect(enc).toBeGreaterThan(50);
    expect(dec).toBeGreaterThan(50);
  });

  it('explains both of the drafts\' examples field by field', () => {
    const b = plain(explain16(0xe1c8));
    expect(b).toContain('rs1 a0 = x3');
    expect(b).toContain('rs2 zero = x0');
    expect(b).toContain('{111, 100} = 111100 = -4');
    expect(b).toContain('beq a0, zero, -4');
    expect(assemble16('sw ra, -1(sp)').words).toEqual([0xe57e]);
    const s = plain(explain16(0xe57e));
    expect(s).toContain('no rd, its bits 6:4 are imm[2:0]');
    expect(s).toContain('= 0xE57E');
    const u = plain(explain16(assemble16('lui a0, 3').words[0]));
    expect(u).toContain('imm10 = {bits 15:7, bit 3} = 0000000011 = 3, loaded as 3 × 64');
  });

  it('names the wrong field of a decode', () => {
    const x = DRILLS.isa16;
    const r = rng(1);
    for (let i = 0; i < 300; i++) {
      const q = x.make(r);
      if (!q.prompt.startsWith('Decode')) continue;
      const d = decode16(parseInt(q.prompt.match(/0x([0-9A-F]{4})/)![1], 16));
      if (d.spec!.fmt !== 'R') continue;
      const regs = q.answer.split(' ').slice(1).join(' ').split(',').map((s) => s.trim());
      const other = REG_NAMES16[(REG_NAMES16.indexOf(regs[0]) + 1) % 8];
      expect(q.check(`${d.spec!.name} ${other}, ${regs[1]}, ${regs[2]}`).why).toBe('the right instruction, but rd differs');
      return;
    }
    throw new Error('no R-type decode question');
  });
});

describe('core tests', () => {
  it('every directed test of the single-cycle cores says what it aims at', () => {
    for (const s of [1, 2, 3] as const) {
      for (const t of coreTests(s).filter((x) => !x.name.startsWith('random'))) {
        expect(t.what, t.name).toBeTruthy();
        expect(t.src!.split('\n')[0]).toBe(`# ${t.what}`);
      }
    }
  });
});
