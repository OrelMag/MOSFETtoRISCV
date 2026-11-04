// Numbers and claims chapter 44 types into its text, pinned to the models and circuits.
import { describe, expect, it } from 'vitest';
import { arbitrate, I2C_BYTE_CLOCKS, MODE_HI_RISE, SPI_BYTE_CLOCKS, chSpi } from '../src/chapters/ch-comm-spi';
import { feasible, fastestMode, I2C_MODES, I2cController, I2cTarget, RISE_30_70, rpMax, rpMin, runBus, START, WRITE } from '../src/comm/i2c';
import { edgeKind, modeNumber, SPI_MODES } from '../src/comm/spi';
import { I2C_PAD } from '../src/lib/i2c';
import { stats } from '../src/sim/stats';

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

describe('chapter 44 content', () => {
  it('modes 0 and 3 sample on the rising edge, 1 and 2 on the falling edge; 8 edges sample and 8 change', () => {
    for (const m of SPI_MODES) {
      const first = edgeKind(m, m.cpha === 0 ? 0 : 1);
      expect(first.sample).toBe(true);
      expect(first.rising, `mode ${modeNumber(m)}`).toBe(m.cpol === m.cpha);
      expect(Array.from({ length: 16 }, (_, e) => edgeKind(m, e).sample).filter(Boolean)).toHaveLength(8);
    }
    expect(modeNumber(MODE_HI_RISE)).toBe(3);
  });

  it('a byte is 16 SCLK edges, one every second clock, and takes the clocks the text quotes', () => {
    expect(SPI_BYTE_CLOCKS).toBe(34); // 17 ticks of 2 clocks: 16 edges and the tail
  });

  it('an I²C byte is 9 bit cells of 4 phases of 2 clocks, plus the clock the command is accepted in', () => {
    expect(I2C_BYTE_CLOCKS).toBe(9 * 4 * 2 + 1);
  });

  it('the open-drain pad is an NMOS and a two-inverter buffer: 5 transistors', () => {
    expect(stats(I2C_PAD).transistors).toBe(5);
  });

  it('the 30 to 70 % factor is 0.8473, and the modes carry the specification\'s limits', () => {
    expect(RISE_30_70.toFixed(4)).toBe('0.8473');
    expect(I2C_MODES.map((m) => [m.fscl, m.trMax, m.cbMax, m.iol])).toEqual([[100e3, 1000e-9, 400e-12, 3e-3], [400e3, 300e-9, 400e-12, 3e-3], [1e6, 120e-9, 550e-12, 20e-3]]);
  });

  it('at 3.3 V and 400 pF Fast-mode has no legal pull-up and Fast-mode Plus has one; at 200 pF Fast-mode has a window', () => {
    expect(feasible(I2C_MODES[1], 400e-12, 3.3)).toBe(false);
    expect(feasible(I2C_MODES[2], 400e-12, 3.3)).toBe(true);
    expect(fastestMode(400e-12, 3.3)!.name).toBe('Fast-mode Plus');
    expect(rpMin(I2C_MODES[1], 3.3)).toBeLessThan(rpMax(I2C_MODES[1], 200e-12));
    // the capacitance where the Fast-mode window closes at 3.3 V
    const closes = I2C_MODES[1].trMax / RISE_30_70 / rpMin(I2C_MODES[1], 3.3);
    expect(feasible(I2C_MODES[1], closes * 0.99, 3.3)).toBe(true);
    expect(feasible(I2C_MODES[1], closes * 1.01, 3.3)).toBe(false);
  });

  it('A = 0x50 and B = 0x52 first differ at A1, and B (which sends the 1) loses there on the bus', () => {
    expect(arbitrate(0x50, 0x52)).toEqual({ bit: 5, loser: 'B' });
    const ctl = [new I2cController(), new I2cController()], t = new I2cTarget();
    const scripts: [number, number][][] = [0x50, 0x52].map((ad) => [[START, 0], [WRITE, ad << 1], [WRITE, 0], [WRITE, 0x3c]]);
    const idx = [0, 0];
    let c = 0;
    const agents = [
      ...ctl.map((m, k) => ({ step: (sda: number, scl: number) => {
        const rst = c === 0 ? 1 : 0;
        let go = 0, cmd = 0, din = 0;
        if (!rst && m.out.ready && idx[k] < scripts[k].length && !(m.lost && scripts[k][idx[k]][0] !== START)) { go = 1; [cmd, din] = scripts[k][idx[k]++]; }
        m.step({ rst, go, cmd, din, sda_i: sda, scl_i: scl });
        return m.out;
      } })),
      { step: (sda: number, scl: number) => { t.step({ rst: c === 0 ? 1 : 0, sda_i: sda, scl_i: scl, adr: 0x50, stretch: 0 }); c++; return t.out; } },
    ];
    runBus(agents, 400);
    expect(ctl.map((m) => m.lost)).toEqual([0, 1]);
    expect(t.mem[0]).toBe(0x3c);
  });

  it('the typed claims about the text stay true', () => {
    const body = plain(chSpi.steps.map((s) => (typeof s.body === 'string' ? s.body : '')).join(' '));
    expect(body).toContain('2 of 10 bits in 8N1');
    expect(chSpi.steps).toHaveLength(9);
    expect(stats(I2C_PAD).transistors).toBe(5);
  });
});
