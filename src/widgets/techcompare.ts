// "One NAND, three technologies" (chapter 3): a design priced in CMOS, relays and tubes (lib/tech.ts) through the NAND
// brick, or against the native relay and tube parts of the prologue, which are measured by their own structure. The
// CPUs are counted without their program ROM (in relays or tubes the program comes off cards or tape) and clocked at
// the whole CPU's period.

import { cpu4 } from '../lib/cpu4';
import { singleCycleCpu } from '../lib/cpu';
import { FULL_ADDER, rca } from '../lib/combinational';
import { RELAY_FA, RELAY_NAND, relayAdder } from '../lib/relays';
import { withoutParts } from '../lib/tech';
import { designSteps } from '../lib/techsteps';
import { NAND } from '../lib/transistors';
import { TUBE_FA, TUBE_NAND } from '../lib/tubes';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { type TechTableOptions, techTable } from '../view/techtable';

interface Design {
  name: string;
  /** What one operation is, for the energy row. */
  op: string;
  make: () => { def: ComponentDef; steps?: ReturnType<typeof designSteps>; native?: TechTableOptions['per']; note: string };
}

const DESIGNS: Design[] = [
  {
    name: 'One NAND', op: 'switch',
    make: () => ({
      def: NAND, native: { relay: RELAY_NAND, tube: { def: TUBE_NAND, steps: 1 } },
      note: 'Through the brick a NAND is one relay: the coil its output drives, whose contacts are the inputs of the gates reading it. Drawn on its own, P1\'s relay NAND is two relays, the coils of its two inputs. P2\'s tube NAND is a triode, two diodes and a divider either way.',
    }),
  },
  {
    name: 'Full adder', op: 'add',
    make: () => ({
      def: FULL_ADDER, native: { relay: RELAY_FA, tube: { def: TUBE_FA, steps: designSteps(FULL_ADDER).steps } },
      note: 'The nine-NAND full adder against P1\'s two-relay adder, whose carry runs through contacts, and P2\'s tube adder (the same nine NANDs, each a tube NAND).',
    }),
  },
  {
    name: '32-bit adder', op: 'add',
    make: () => {
      const def = rca(32), relay = relayAdder(32);
      return {
        def, native: { relay },
        note: `The ripple-carry adder waits ${designSteps(def).steps} NAND delays for its carry. Through contacts the relay adder settles in ${designSteps(relay).steps} relay step, at any width: what a relay is good at.`,
      };
    },
  },
  {
    name: '4-bit CPU', op: 'cycle',
    make: () => {
      const full = cpu4(new Array(256).fill(0));
      return { def: withoutParts(full, ['rom']), steps: designSteps(full), note: 'The examples\' 4-bit CPU without its 256-word program ROM, at the whole CPU\'s clock period. No native version: it is NAND-mapped in every technology.' };
    },
  },
  {
    name: 'RV32I single-cycle', op: 'instruction',
    make: () => {
      const full = singleCycleCpu(assemble(PROGRAMS[0].source).words);
      return { def: withoutParts(full, ['imem']), steps: designSteps(full), note: 'Chapter 14\'s CPU without its program ROM, one instruction per clock period. No native version.' };
    },
  },
];

export function techCompareWidget(): Widget {
  let which = 0, native = false;
  const designBtns = h('span', { class: 'seg tc-seg', role: 'group', 'aria-label': 'Design' });
  const modeBtns = h('span', { class: 'seg tc-seg', role: 'group', 'aria-label': 'Mapping' });
  const body = h('div', { class: 'tc-body' });
  const note = h('p', { class: 'sub tc-note' });
  const made = new Map<number, ReturnType<Design['make']>>();
  const render = () => {
    const d = DESIGNS[which];
    let m = made.get(which);
    if (!m) made.set(which, (m = d.make()));
    const hasNative = !!m.native;
    if (!hasNative) native = false;
    designBtns.replaceChildren(...DESIGNS.map((x, i) => h('button', { class: i === which ? 'on' : '', 'aria-pressed': String(i === which), onclick: () => { which = i; render(); } }, x.name)));
    modeBtns.replaceChildren(...([['NAND-mapped', false], ['Native', true]] as const).map(([label, v]) =>
      h('button', { class: native === v ? 'on' : '', 'aria-pressed': String(native === v), disabled: v && !hasNative ? true : null,
        title: v && !hasNative ? 'No native version of this design' : null, onclick: () => { native = v; render(); } }, label)));
    body.replaceChildren(techTable(m.def, { steps: m.steps, op: d.op, per: native ? m.native : undefined, note: false }));
    note.textContent = m.note;
  };
  render();
  return { el: h('div', { class: 'widget tc' }, h('div', { class: 'tc-bar' }, designBtns, modeBtns), body, note) };
}
