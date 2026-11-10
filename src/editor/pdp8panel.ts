// The PDP-8 front panel: a ROM that holds a program in the PDP-8 table (isa/presets.ts PDP8_PRESET) is the core of a
// PDP-8 run by its model (src/pdp8). The switch register is the instruction builder in its Switches view (set it by
// hand, or build an instruction and see its bits); lamps show PC, MA, MB, AC with L, MQ, IR and RUN / ION; the keys are
// the machine's: LOAD ADD, START, DEP, EXAM, CONT, STOP, SING STEP. Deposits change this panel's core, not the ROM's
// program; the core survives closing the panel until the page reloads. The teletype prints and takes keys.

import '../styles/pdp8.css';
import { tableCompose } from '../isa/compose';
import { PDP8_PRESET } from '../isa/presets';
import { tableOf } from '../isa/table';
import { oct4, Pdp8 } from '../pdp8/pdp8';
import { h } from '../ui/dom';
import { instrComposer } from '../widgets/composer';
import type { Editor } from './editor';
import { dialog } from './fileui';
import { romImage, type RomRef } from './memory';

/** A ROM whose program is in the PDP-8 table (the preset itself, not a copy edited into another machine). */
export const isPdp8Rom = (r: RomRef) => r.lang === 'isa' && r.isa?.id === PDP8_PRESET.id;

/** One machine per ROM part (chip / part): closing and reopening the panel keeps its core and registers. */
const machines = new Map<string, Pdp8>();

const SPEEDS: [number, string][] = [[0, 'full speed'], [100, '100 a second'], [10, '10 a second'], [2, '2 a second']];

export function openPdp8Panel(ed: Editor, partId: string): void {
  const part = ed.ws.chips[ed.chipId]?.parts.find((p) => p.id === partId);
  if (!part || !('rom' in part.ref) || !isPdp8Rom(part.ref.rom)) return;
  const rom = part.ref.rom;
  const slot = `${ed.chipId}/${partId}`;
  const words = () => romImage(rom).words;
  let m = machines.get(slot);
  if (!m) machines.set(slot, (m = new Pdp8(words())));
  const pdp = m;
  const table = tableOf(PDP8_PRESET);

  // ---- lamps
  const lampRow = (label: string, bits: number, extra?: HTMLElement) => {
    const lamps = Array.from({ length: bits }, () => h('span', { class: 'p8-lamp' }));
    const val = h('code', { class: 'p8-val' });
    const groups: HTMLElement[] = [];
    for (let g = 0; g < bits; g += 3) groups.push(h('span', { class: 'p8-grp' }, lamps.slice(g, g + 3)));
    const el = h('div', { class: 'p8-row' }, h('span', { class: 'p8-name' }, label), extra ?? h('span', { class: 'p8-l' }), h('span', { class: 'p8-lamps' }, groups), val);
    return {
      el,
      set(v: number) {
        lamps.forEach((l, i) => l.classList.toggle('on', !!((v >> (bits - 1 - i)) & 1)));
        val.textContent = bits === 3 ? String(v) : oct4(v);
      },
    };
  };
  const link = h('span', { class: 'p8-lamp p8-link', title: 'L, the link' });
  const run = h('span', { class: 'p8-lamp' }), ion = h('span', { class: 'p8-lamp' });
  const rows = {
    pc: lampRow('PC', 12), ma: lampRow('MA', 12), mb: lampRow('MB', 12),
    ac: lampRow('AC', 12, h('span', { class: 'p8-l' }, link, h('small', null, 'L'))), mq: lampRow('MQ', 12), ir: lampRow('IR', 3),
  };
  const state = h('div', { class: 'p8-state' }, h('span', null, run, 'RUN'), h('span', null, ion, 'ION'));
  const now = h('p', { class: 'p8-now', role: 'status' });
  const count = h('p', { class: 'sb-sum' });
  const tty = h('pre', { class: 'p8-tty', 'aria-label': 'Teletype printout', 'aria-live': 'polite' });

  // ---- the switch register: the instruction builder on its switches
  const sr = instrComposer({ isa: tableCompose(PDP8_PRESET), word: pdp.sr, pc: pdp.pc, view: 'switches', onChange: (w) => { pdp.sr = w; } });

  const paint = () => {
    rows.pc.set(pdp.pc); rows.ma.set(pdp.ma); rows.mb.set(pdp.mb); rows.ac.set(pdp.ac); rows.mq.set(pdp.mq); rows.ir.set(pdp.ir);
    link.classList.toggle('on', pdp.l === 1);
    run.classList.toggle('on', pdp.run);
    ion.classList.toggle('on', pdp.ie);
    now.replaceChildren('Next: ', h('code', null, oct4(pdp.pc)), ' ', h('code', null, oct4(pdp.mem[pdp.pc])), ' ', h('b', null, table.disasm(pdp.mem[pdp.pc], pdp.pc)));
    count.textContent = `${pdp.instructions.toLocaleString('en')} instructions, ${pdp.cycles.toLocaleString('en')} memory cycles since the core was loaded`;
    if (tty.textContent !== pdp.out) { tty.textContent = pdp.out; tty.scrollTop = tty.scrollHeight; }
    sr.setPc(pdp.pc);
  };

  // ---- running: a frame at a time, at a rate or flat out
  let speed = 0, raf = 0, last = 0, owed = 0;
  const tick = (t: number) => {
    raf = 0;
    if (!pdp.run || !dlg.el.isConnected) return paint();
    if (speed === 0) pdp.runFor(20_000);
    else {
      owed += last ? ((t - last) / 1000) * speed : 1;
      last = t;
      const n = Math.floor(owed);
      owed -= n;
      pdp.runFor(n);
    }
    paint();
    if (pdp.run) raf = requestAnimationFrame(tick);
  };
  const go = () => { last = 0; owed = 0; if (!raf) raf = requestAnimationFrame(tick); };
  const key = (label: string, title: string, act: () => void, primary = false) =>
    h('button', { type: 'button', class: `btn sm${primary ? ' primary' : ''} p8-key`, title, onclick: () => { act(); paint(); if (pdp.run) go(); } }, label);
  const keys = h('div', { class: 'p8-keys' },
    key('LOAD ADD', 'PC = the switches', () => pdp.loadAddress()),
    key('START', 'Clear AC, L and the flags, then run from PC', () => pdp.start(), true),
    key('DEP', 'Put the switches into core at PC, then PC + 1', () => pdp.deposit()),
    key('EXAM', 'Show core at PC in MB, then PC + 1', () => pdp.examine()),
    key('CONT', 'Run on from PC, nothing cleared', () => pdp.cont()),
    key('STOP', 'Stop after this instruction', () => pdp.stop()),
    key('SING STEP', 'One instruction', () => { pdp.stop(); pdp.step(); }));
  const speedSel = h('select', { 'aria-label': 'Speed' }, SPEEDS.map(([v, l]) => h('option', { value: String(v) }, l))) as HTMLSelectElement;
  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); last = 0; owed = 0; });
  const typed = h('input', { type: 'text', class: 'p8-type', placeholder: 'Type on the keyboard…', 'aria-label': 'Type on the teletype keyboard', spellcheck: 'false' }) as HTMLInputElement;
  typed.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    pdp.type(`${typed.value}\r`);
    typed.value = '';
    paint();
  });
  const reload = h('button', { type: 'button', class: 'btn sm', title: 'Core = the ROM\'s program again; registers and the printout cleared', onclick: () => {
    pdp.stop();
    const fresh = new Pdp8(words());
    pdp.restore({ ...fresh.save(), sr: pdp.sr });
    paint();
  } }, 'Reload core from the ROM');

  const dlg = dialog(ed, 'PDP-8 front panel', [
    h('p', { class: 'sb-sum' }, 'This ROM is the core of a PDP-8, run by a model of the machine (not by the circuit): set the switches, ',
      h('b', null, 'LOAD ADD'), ', then ', h('b', null, 'START'), '. ', h('b', null, 'DEP'), ' and ', h('b', null, 'EXAM'),
      ' write and read core a word at a time, as programs went in before there was an assembler. Deposits change this panel\'s core, not the ROM\'s program.'),
    h('div', { class: 'p8-panel' }, h('div', { class: 'p8-regs' }, Object.values(rows).map((r) => r.el), state), now),
    h('h4', { class: 'p8-h' }, 'Switch register'),
    sr.el,
    keys,
    h('div', { class: 'p8-run' }, h('label', null, 'Speed ', speedSel), reload),
    count,
    h('h4', { class: 'p8-h' }, 'Teletype'),
    tty, typed,
  ], [], 'p8-dlg');
  paint();
  if (pdp.run) go();
}
