// Chapter 43's typed numbers (the computed ones come from the code and need no pin), and its shape.
import { numOf } from '../src/chapters/order';
import { describe, expect, it } from 'vitest';
import { tolerance, UART_8N1 } from '../src/comm/startstop';
import { bytesPerSecond, divisorFor, fifoBudget } from '../src/comm/uart';
import { chUart } from '../src/chapters/ch-comm-uart';

describe('chapter 43 typed numbers', () => {
  it('follows the clocks chapter, eight steps, building on the chapters before it', () => {
    expect(chUart.num).toBe(numOf('clocks') + 1);
    expect(chUart.steps.length).toBe(8);
    expect(chUart.builds).toEqual(expect.arrayContaining(['clocks', 'bus']));
    expect(chUart.recap!.check!.length).toBe(3);
  });
  it('step 2: a frame at divisor 3 is 10 bits · 16 ticks · 3 cycles = 480', () => {
    expect(10 * 16 * 3).toBe(480);
  });
  it('step 3: 50 MHz and divisor 27 is clock / 27 = 1 851 852 per second as ticks; 115 741 baud, 0.47 % high', () => {
    expect(Math.round(50e6 / 27)).toBe(1851852);
    const d = divisorFor(50e6, 115200);
    expect(d.div).toBe(27);
    expect(Math.round(d.actual)).toBe(115741);
    expect(d.error).toBeCloseTo(0.0047, 4);
  });
  it('step 4: 3 % of 9.5 bit times is 0.285 bit, inside the half bit; the limit is about 5 %', () => {
    expect(0.03 * 9.5).toBeCloseTo(0.285, 3);
    const t = tolerance(UART_8N1, { ticks: 16, pos: 0.5 }, 5e-4);
    expect(t.slow).toBeGreaterThan(0.045);
    expect(t.slow).toBeLessThan(0.05);
    expect(t.fast).toBeGreaterThan(0.05);
  });
  it('step 6: eight byte times are 694 µs at 115 200 baud and 87 µs at 921 600', () => {
    expect(Math.round(fifoBudget(115200, 16, 8).slackUs)).toBe(694);
    expect(Math.round(fifoBudget(921600, 16, 8).slackUs)).toBe(87);
    expect(bytesPerSecond(115200)).toBe(11520);
  });
});
