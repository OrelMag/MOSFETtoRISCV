import { describe, expect, it } from 'vitest';
import { cImm, whyNotC } from '../src/riscv/composec';
import { decodeC } from '../src/riscv/rvc';

// The immediate-wiring panel of the C builder must say what the decoder computes: gather the panel's wires back
// into a number and compare with decodeC / expand16 on every parcel.
function fromWires(w: ReturnType<typeof cImm>) {
  let v = 0;
  const n = w!.wires.length;
  for (const x of w!.wires) v |= x.value << x.bit;
  return n === 32 ? v : (v << (32 - n)) >> (32 - n); // sign-extend the panel's width
}

describe('C builder: immediate wiring', () => {
  it('agrees with decodeC on every parcel of every form with an immediate', () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    for (let h = 0; h < 0x10000; h++) {
      const d = decodeC(h);
      if (!d) continue;
      const c = cImm(h);
      if (!c) continue;
      seen.add(d.name);
      const sh = d.name === 'c.lui' ? 12 : 0;
      const signedForm = c.wires.some((x) => x.sign) || c.wires.length === 16;
      const got = signedForm ? fromWires(c) : c.wires.reduce((a, x) => a | (x.value << x.bit), 0);
      // ground bits are the scaling
      if (got !== d.imm >> sh || c.value !== d.imm >> sh || c.wires.some((x) => x.src === 'zero' && x.value)) bad.push(`${d.name} ${h.toString(16)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect([...seen].sort()).toEqual(['c.addi', 'c.addi16sp', 'c.addi4spn', 'c.andi', 'c.beqz', 'c.bnez', 'c.j', 'c.jal', 'c.li', 'c.lui', 'c.lw', 'c.lwsp', 'c.slli', 'c.srai', 'c.srli', 'c.sw', 'c.swsp']);
  });
  it('has no panel for forms without an immediate, and names the F forms it leaves out', () => {
    expect(cImm(0x8082)).toBeNull(); // c.jr ra
    expect(cImm(0x0001)).toBeNull(); // c.nop
    expect(whyNotC(0x6040)).toMatch(/floating/);
    expect(whyNotC(0x8082)).toBeNull();
  });
});
