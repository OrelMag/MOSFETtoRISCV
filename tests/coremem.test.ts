import { describe, expect, it } from 'vitest';
import { CORE, CORE_PLANE, CORE_STORE, CORE_WORDS, type CoreInputs, CoreModel, coreDrive, coreNext, coreSwitching } from '../src/lib/coremem';
import { BitSim } from '../src/sim/bitsim';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stats } from '../src/sim/stats';
import { pack } from '../src/sim/values';

const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8);

describe('a ferrite core', () => {
  it('switches only on a full current, and holds under a half', () => {
    // x, y: a line's two wires packed (bit 0 read, bit 1 write); write halves +1, read halves and inhibit -1
    const R = 1, W = 2;
    expect(coreDrive(W, W, 0)).toEqual({ lo: 2, hi: 2 });
    expect(coreDrive(W, W, 1)).toEqual({ lo: 1, hi: 1 }); // inhibited: stays 0
    expect(coreDrive(R, R, 0)).toEqual({ lo: -2, hi: -2 });
    expect(coreDrive(W, 0, 0)).toEqual({ lo: 1, hi: 1 }); // half-selected
    expect(coreDrive(W, -1, 0)).toEqual({ lo: 0, hi: 2 }); // an unknown Y line: read, write, both or neither
    expect(coreDrive(R | W, 0, 0)).toEqual({ lo: 0, hi: 0 }); // both drivers of one line cancel
    for (const b of [0, 1]) {
      expect(coreNext(b, 1, 1, true)).toBe(b);
      expect(coreNext(b, -1, -1, true)).toBe(b);
      expect(coreNext(b, 2, 2, true)).toBe(1);
      expect(coreNext(b, -2, -2, true)).toBe(0);
    }
    expect(coreNext(0, 1, 2, true)).toBe(-1);
    expect(coreNext(1, 1, 2, true)).toBe(1); // a 1 that might be written 1 is still 1
    expect(coreNext(0, 2, 2, false)).toBe(-1); // an unclean edge
    // the sense pulse: reading a 1, writing into a 0
    expect([coreSwitching(1, -2, -2), coreSwitching(0, -2, -2), coreSwitching(0, 2, 2), coreSwitching(1, 2, 2), coreSwitching(-1, -2, -2)]).toEqual([1, 0, 1, 0, -1]);
  });

  it('costs a core and no transistor; the store has 64', () => {
    expect(stats(CORE).cores).toBe(1);
    expect(stats(CORE).transistors ?? 0).toBe(0);
    expect(stats(CORE_PLANE).cores).toBe(16);
    expect(stats(CORE_STORE).cores).toBe(CORE_WORDS * 4);
  });
});

interface Engine { set(p: string, v: number): void; settle(): void; out(p: string): number }

const engines: [string, () => Engine][] = [
  ['GateSim', () => {
    const s = new GateSim(flatten(CORE_STORE));
    s.reset('zero');
    return { set: (p, v) => s.setInput(p, v), settle: () => s.settle(), out: (p) => pack(s.getBits(s.design.root.ports[p])) };
  }],
  ['the cycle engine', () => {
    const s = new DualSim(flatten(CORE_STORE));
    s.preferFast = true;
    s.reset('zero'); s.settle(); s.prepare();
    expect(s.whyNot, 'the cycle engine takes it').toBe('');
    return {
      set: (p, v) => s.setInput(p, v),
      settle: () => { s.settle(); expect(s.engine).toBe('cycle'); },
      out: (p) => pack(s.getBits(s.design.root.ports[p])),
    };
  }],
  ['BitSim', () => {
    const s = new BitSim(flatten(CORE_STORE));
    // two-valued, no power-on: the flip-flops settle wherever the sweep leaves them (the drain below empties the phase)
    return { set: (p, v) => s.setInput(p, v), settle: () => s.settle(), out: (p) => s.get(p, 1)[0] };
  }],
];

/** Random inputs for a clock; now and then the inhibit drivers are off (inhOn = 0). */
const randomInputs = (r: () => number): Required<CoreInputs> =>
  ({ addr: r() % CORE_WORDS, din: r() % 16, we: r() % 3 === 0 ? 1 : 0, go: r() % 4 ? 1 : 0, inhOn: r() % 10 ? 1 : 0 });

/** One clock on an engine and on the model with the same inputs. */
function clock(sim: Engine, m: CoreModel, i: Required<CoreInputs>): void {
  for (const [p, v] of Object.entries(i)) sim.set(p, v);
  sim.set('clk', 0);
  sim.settle();
  m.edge(i);
  sim.set('clk', 1);
  sim.settle();
}

describe('the 16 x 4 core store', () => {
  it.each(engines)('%s: every output every clock equals the model', (_, make) => {
    const sim = make(), m = new CoreModel(), r = lcg(3);
    const quiet = (addr = 0, go = 0) => clock(sim, m, { addr, din: 0, we: 0, go, inhOn: 1 });
    // two edges without go leave any engine idle; the model takes the buffer it powered up with
    quiet(); quiet();
    expect(sim.out('phase')).toBe(0);
    m.buf = sim.out('dout');
    let unInhibited = 0;
    for (let cyc = 0; cyc < 600; cyc++) {
      const i = randomInputs(r);
      if (m.wr && !i.inhOn) unInhibited++;
      clock(sim, m, i);
      expect(sim.out('phase'), `cycle ${cyc} phase`).toBe(m.out.phase);
      expect(sim.out('dout'), `cycle ${cyc} dout`).toBe(m.out.dout);
    }
    expect(unInhibited, 'some writes ran with the inhibit off').toBeGreaterThan(3);
    // the words read back are the ones last written (a read restores what it destroyed)
    const seen = new Set<number>();
    quiet(); quiet();
    for (let a = 0; a < CORE_WORDS; a++) {
      quiet(a, 1); quiet(a); quiet(a);
      expect(sim.out('dout'), `word ${a}`).toBe(m.words[a]);
      seen.add(m.words[a]);
    }
    expect(seen.size, 'the run left varied words').toBeGreaterThan(4);
  });

  it('without the inhibit, writing 0101 leaves 1111', () => {
    const sim = engines[0][1](), m = new CoreModel();
    const go = (addr: number, din: number, we: number, inhOn: number) => {
      clock(sim, m, { addr, din, we, go: 1, inhOn });
      clock(sim, m, { addr, din, we, go: 0, inhOn });
      clock(sim, m, { addr, din, we, go: 0, inhOn });
    };
    go(6, 0b0101, 1, 0);
    go(6, 0, 0, 1);
    expect(sim.out('dout')).toBe(0b1111);
    go(6, 0b0101, 1, 1);
    go(6, 0, 0, 1);
    expect(sim.out('dout')).toBe(0b0101);
  });
});

describe('the core store in Verilog', () => {
  it('exports, synthesizes with Yosys and runs as the model says', async () => {
    const { importVerilog, compiledTop } = await import('./hdlkit');
    const { synthVerilog } = await import('../src/sim/vexport');
    const ex = synthVerilog(CORE_STORE, 'core_store', { powerOnZero: true });
    expect(ex.verilog).toMatch(/always @\(posedge clk\) if \(set\)/);
    const { def } = compiledTop(await importVerilog(ex.verilog, { top: ex.top }));
    const s = new GateSim(flatten(def));
    s.reset('zero');
    const sim: Engine = { set: (p, v) => s.setInput(p, v), settle: () => s.settle(), out: (p) => pack(s.getBits(s.design.root.ports[p])) };
    const m = new CoreModel(), r = lcg(9);
    for (let cyc = 0; cyc < 300; cyc++) {
      clock(sim, m, randomInputs(r));
      expect([sim.out('phase'), sim.out('dout')], `cycle ${cyc}`).toEqual([m.out.phase, m.out.dout]);
    }
  }, 120_000);
});

describe('the core store as structural SystemVerilog', () => {
  it('writes the core as a module of its own and Yosys reads the whole file', async () => {
    await import('./hdlkit'); // Yosys in Node
    const { exportHdl } = await import('../src/sim/svexport');
    const { synthesize } = await import('../src/hdl/yosys');
    const f = exportHdl(CORE_STORE, 'structure', false);
    expect(f.text).toMatch(/module core \(\n {2}input  logic \[1:0\] x,/);
    const r = await synthesize({ 'top.sv': f.text }, { top: f.top });
    expect(r.diags.filter((d) => d.level === 'error')).toEqual([]);
  }, 120_000);
});

describe('a store built with contents', () => {
  it('powers on holding its words, and reads them back on every engine', async () => {
    const { coreStore } = await import('../src/lib/coremem');
    const words = Array.from({ length: CORE_WORDS }, (_, k) => (k * 7 + 3) & 15);
    const def = coreStore(words);
    expect(coreStore(words)).toBe(def);
    expect(def.id).not.toBe(CORE_STORE.id);
    for (const sim of [new GateSim(flatten(def)), new DualSim(flatten(def))]) {
      sim.reset('zero');
      const eng: Engine = { set: (p, v) => sim.setInput(p, v), settle: () => sim.settle(), out: (p) => pack(sim.getBits(sim.design.root.ports[p])) };
      const m = new CoreModel(words);
      for (let a = 0; a < CORE_WORDS; a++) {
        for (const go of [1, 0, 0]) clock(eng, m, { addr: a, din: 0, we: 0, go, inhOn: 1 });
        expect(eng.out('dout'), `word ${a}`).toBe(words[a]);
      }
    }
  });
});

describe('Open in Sandbox', () => {
  it('the step\'s store comes over as chips that compile and still hold their words', async () => {
    const { coreStore } = await import('../src/lib/coremem');
    const { CORE_SAMPLE } = await import('../src/widgets/coremem');
    const { remixDef } = await import('../src/editor/remix');
    const { UserLibrary } = await import('../src/editor/library');
    const { emptyWorkspace } = await import('../src/editor/model');
    const r = remixDef(emptyWorkspace(), coreStore(CORE_SAMPLE));
    if ('error' in r) throw new Error(r.error);
    const lib = new UserLibrary({ ...r.ws, open: [r.id] });
    for (const id of Object.keys(r.ws.chips)) expect(lib.compiled(id)!.diags.filter((d) => d.level === 'error'), id).toEqual([]);
    const def = lib.compiled(r.id)!.def;
    const s = new GateSim(flatten(def));
    s.reset('zero');
    const eng: Engine = { set: (p, v) => s.setInput(p, v), settle: () => s.settle(), out: (p) => pack(s.getBits(s.design.root.ports[p])) };
    const m = new CoreModel(CORE_SAMPLE);
    for (const go of [1, 0, 0]) clock(eng, m, { addr: 6, din: 0, we: 0, go, inhOn: 1 });
    expect(eng.out('dout')).toBe(CORE_SAMPLE[6]);
  });
});

describe('the loop a core opens onto', () => {
  it('a 0 runs out to +2 and switches up there; a 1 back to -2 and switches down', async () => {
    const { LOOP_PATH, loopX, loopY } = await import('../src/widgets/coreloop');
    expect(LOOP_PATH).toBe(`M${loopX(-3)},${loopY(0)} H${loopX(2)} V${loopY(1)} M${loopX(3)},${loopY(1)} H${loopX(-2)} V${loopY(0)}`);
    // and that is the rule the leaf follows
    expect(coreNext(0, 1, 1, true)).toBe(0);
    expect(coreNext(0, 2, 2, true)).toBe(1);
    expect(coreNext(1, -1, -1, true)).toBe(1);
    expect(coreNext(1, -2, -2, true)).toBe(0);
  });
});

describe('one rule, two views', () => {
  it('the 3D plane flips a core exactly where the circuit\'s core switches, for every drive', async () => {
    const { applyDrive, HALF, idle } = await import('../src/widgets/core3dparts');
    // the 3D model counts in amperes with Whirlwind's half select; the circuit in half-selects
    for (const b of [0, 1]) for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const inh of [-1, 0, 1]) {
      const d = idle();
      d.x[0] = x; d.y[0] = y; d.inh = inh;
      const bits = Array(16).fill(1 - b);
      bits[0] = b;
      const after = applyDrive(bits, d, HALF).after[0];
      const units = x + y + inh;
      expect(after, `bit ${b}, x ${x}, y ${y}, inh ${inh}`).toBe(coreNext(b, units, units, true));
    }
  });
});

describe('the codex entry quotes the circuit', () => {
  it('cores, the read of word 6, the half-select current', async () => {
    const { codexById } = await import('../src/campaign/codex');
    const { moreOf } = await import('../src/campaign/codexmore');
    const { CHECK4 } = await import('../src/campaign/codexcheck4');
    const { CORE_SAMPLE } = await import('../src/widgets/coremem');
    const { HALF } = await import('../src/widgets/core3dparts');
    const e = codexById('coremem')!, m = moreOf('coremem')!;
    expect(e.body).toContain(`${stats(CORE_STORE).cores} cores, not a transistor among them, and ${stats(CORE_STORE).nands} NANDs`);
    expect(stats(CORE).transistors ?? 0).toBe(0);
    const w6 = CORE_SAMPLE[6].toString(2).padStart(4, '0');
    expect(m.example!.title).toContain(`which holds ${w6}`);
    expect(m.example!.body).toContain(`buffer := ${w6}`);
    // the planes that pulse are the 1 bits, the inhibited one the 0 bit
    const ones = [0, 1, 2, 3].filter((p) => CORE_SAMPLE[6] >> p & 1), zeros = [0, 1, 2, 3].filter((p) => !(CORE_SAMPLE[6] >> p & 1));
    expect(m.example!.body).toContain(`sense wires of planes ${ones.join(', ')} pulse`);
    expect(m.example!.body).toContain(`plane ${zeros[0]}'s buffer bit is 0`);
    expect(m.example!.body).toContain('the other 6 cores');
    expect(m.idea).toContain(`${HALF.toFixed(2)} A on each selected X and Y line`);
    expect(CHECK4.coremem).toHaveLength(2);
  });
});

describe('the read-cycle figure', () => {
  it('draws R-221\'s numbers, with the strobe inside the read current', async () => {
    const { R221, readCycleFigure, whirlwindStrip } = await import('../src/widgets/corefig');
    // the strobe, 0.5 µs into the sense pulse (which starts with the read current), ends before the read does
    expect(R221.strobeAtUs + R221.strobeUs).toBeLessThan(R221.readUs);
    expect(R221.readA).toBe((await import('../src/widgets/core3dparts')).HALF);
    const w = whirlwindStrip();
    for (const s of [`${R221.readUs} µs, ${R221.readA} A`, `≈ ${R221.senseV} V, ≈ ${R221.senseUs} µs`, `${R221.strobeUs} µs, inside the read`, `≈ ${R221.cycleUs} µs cycle`]) expect(w).toContain(s);
    const f = readCycleFigure();
    expect(f.match(/<svg/g)).toHaveLength(2);
    expect(f).not.toMatch(/STROBE/); // two phases a cycle: the strobe is the edge that ends READ
    expect(f).not.toMatch(/#[0-9a-f]{3,6}\b/i); // colours from the theme only
  });
});
