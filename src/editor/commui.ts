// The communication parts' palette group and property sections (commparts.ts): the line (its delay, its live levels, what
// it stands for) and the UART core / slave (divisor and bit time, the status flags, the pins, read live from the simulation).
// More parts (the NIC, the switch) are added to COMM_PARTS; nothing here changes for them but a section if they have one.

import { MAX_LINE_DELAY } from '../lib/uart';
import type { HierNode } from '../sim/flatten';
import { formatBits, pack } from '../sim/values';
import { h } from '../ui/dom';
import { bitCycles, COMM_PARTS, commPartOf, lineDelayOf, lineRef, lineStateOf, uartFlags } from './commparts';
import type { Editor } from './editor';
import type { PartDoc, PartRef } from './model';
import { setRef } from './ops';
import { registerPaletteGroup } from './palette';
import { registerPropsSection } from './props';

registerPaletteGroup({
  id: 'comm', title: 'Communication', order: 57, collapsed: true,
  items: () => COMM_PARTS.map((c) => ({ id: c.id, name: c.name, tag: c.tag, title: c.title, place: { part: c.ref } })),
});

/** Run `f` once per frame while `el` is on the page (it starts detached: give it a moment). */
function live(el: HTMLElement, f: () => void): void {
  let seen = false, waited = 0;
  const tick = () => {
    if (el.isConnected) {
      seen = true;
      f();
    } else if (seen || ++waited > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const row = (label: string, ctl: Node, hint?: string) => h('label', { class: 'sb-row', title: hint ?? null }, h('span', null, label), ctl);
const set = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };

function selectedPart(ed: Editor): PartDoc | null {
  if (ed.selCount !== 1 || !ed.sel.parts?.length) return null;
  return ed.doc.parts.find((p) => p.id === ed.sel.parts![0]) ?? null;
}

function setPartRef(ed: Editor, id: string, ref: PartRef): void {
  const r = setRef(ed.doc, id, ref, ed.defOf);
  if (r.reason) return void ed.toast(r.reason, 'err');
  ed.edit(() => r.doc);
}

const nodeOf = (ed: Editor, id: string): HierNode | null => ed.sim.sim?.design.root.children?.get(id) ?? null;

/** The UART core at or below a node (the slave holds it one level down). */
function coreIn(n: HierNode, depth = 0): HierNode | null {
  if (n.def.id === 'uart_full') return n;
  if (depth > 3) return null;
  for (const c of n.children?.values() ?? []) {
    const r = coreIn(c, depth + 1);
    if (r) return r;
  }
  return null;
}

registerPropsSection({
  id: 'comm', order: 22,
  render(ed) {
    const p = selectedPart(ed);
    if (!p) return null;
    const part = commPartOf(p.ref);
    if (!part) return null;
    return part.id === 'line' ? lineProps(ed, p) : part.id === 'uart' || part.id === 'uart_bus' ? uartProps(ed, p, part.id === 'uart') : null;
  },
});

function lineProps(ed: Editor, p: PartDoc): HTMLElement {
  const delay = lineDelayOf(p.ref)!;
  const input = h('input', { type: 'number', value: String(delay), min: '1', max: String(MAX_LINE_DELAY), step: '1', 'aria-label': 'Line delay in clock cycles' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isInteger(v) && v >= 1 && v <= MAX_LINE_DELAY) setPartRef(ed, p.id, lineRef(v));
    else input.value = String(delay);
  });
  const d = h('code'), noise = h('code'), q = h('code'), inflight = h('code');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, 'Line'),
    row('Delay', input, `1–${MAX_LINE_DELAY} cycles of the sender's clock (wire clk to the sender's clock)`),
    row('d (sent)', d), row('noise', noise, 'Held at 1 over a clock edge it flips the level that edge samples'), row('q (arrives)', q),
    row('In flight', inflight, 'The levels sampled at the last edges, oldest first (q shows the first next)'),
    h('p', { class: 'sb-sum' }, 'q is d as it was delay − 1 sender edges ago; idle is 1 (a pulled-up line), and a reset puts idle back on the whole wire.'),
    h('p', { class: 'sb-sum' }, 'This box is a model, not a circuit: a transmission line is chapter 41\'s physics (double-click for its panel), not transistors. It costs nothing. Verilog leaves a comment; the FPGA export turns d into an output and q into an input of the top module, to be joined with a wire on the board. The delay and the noise input belong to the model and are not exported.'));
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim;
    if (!node || !sim) { for (const e of [d, noise, q, inflight]) set(e, '–'); return; }
    set(d, formatBits(sim.getBits(node.ports.d), ed.view.radix));
    set(noise, formatBits(sim.getBits(node.ports.noise), ed.view.radix));
    set(q, formatBits(sim.getBits(node.ports.q), ed.view.radix));
    const st = node.leafIndex !== undefined ? lineStateOf(sim.leafState(node.leafIndex)) : null;
    set(inflight, st ? st.buf.join(' ') : '–');
  });
  return out;
}

function uartProps(ed: Editor, p: PartDoc, isCore: boolean): HTMLElement {
  const flags = h('div', { class: 'sb-btns' });
  const div = h('code'), bit = h('code'), tx = h('code'), rx = h('code'), irq = h('code'), ie = h('code');
  const out = h('section', { class: 'sb-sec-props sb-io-props' }, h('h3', null, isCore ? 'UART core' : 'UART slave'),
    row('Divisor', div, 'The register at +8 (core: wval with divWe). A baud tick every divisor clock cycles; a bit is 16 ticks'),
    row('A bit lasts', bit, 'Clock cycles per bit = 16 · max(1, divisor); a frame (start, 8 data, stop) is ten bits'),
    row('Interrupt enables', ie, 'bit 0 receive FIFO not empty, bit 1 transmit FIFO empty'),
    row('tx', tx, 'The line this UART drives (idle 1)'), row('rx', rx, 'The line it listens to, through a 2-flop synchronizer'), row('irq', irq),
    h('p', { class: 'sb-sum' }, 'Status flags (live):'), flags,
    h('p', { class: 'sb-sum' }, isCore
      ? 'Reset is all zeros: the divisor starts at 0, a tick every cycle until it is written. A framing error or an overrun stays set until a write of 1 to its bit (clrWe).'
      : 'Registers: +0 data (store: send; load: the oldest received byte), +4 status (write 1 to bit 3 or 4 to clear it), +8 divisor, +12 interrupt enables. Open it to see the core: its FIFOs, the baud generator, the transmitter and the receiver, down to NAND gates.'));
  live(out, () => {
    const node = nodeOf(ed, p.id), sim = ed.sim.sim, core = node ? coreIn(node) : null;
    if (!node || !sim || !core) { for (const e of [div, bit, tx, rx, irq, ie]) set(e, '–'); flags.replaceChildren(); delete flags.dataset.st; return; }
    const dv = pack(sim.getBits(core.ports.div)), st = pack(sim.getBits(core.ports.status)), iev = pack(sim.getBits(core.ports.ie));
    set(div, dv < 0 ? 'X' : String(dv));
    set(bit, dv < 0 ? '–' : `${bitCycles(dv)} cycles${dv < 2 ? ' (divisor 0 or 1)' : ''}`);
    set(ie, iev < 0 ? 'X' : iev.toString(2).padStart(2, '0'));
    set(tx, formatBits(sim.getBits(core.ports.tx), ed.view.radix));
    set(rx, formatBits(sim.getBits(core.ports.rx), ed.view.radix));
    set(irq, formatBits(sim.getBits(core.ports.irq), ed.view.radix));
    const key = String(st);
    if (flags.dataset.st !== key) {
      flags.dataset.st = key;
      flags.replaceChildren(...(st < 0 ? [h('span', null, 'status unknown (X)')] : uartFlags(st).map((f) => h('span', { class: f.on ? 'btn sm on' : 'btn sm', 'aria-pressed': String(f.on), style: 'pointer-events:none' }, f.name))));
    }
  });
  return out;
}
