// The instruction builder: one instruction edited from any side, in any instruction set the site has
// (RV32, RV16, the 4-bit CPU, Custom ISA tables: isa/composekit.ts adapters). Pick the operation,
// click registers, drag the immediate, type assembly or hex, or flip any bit of the word, and every
// view follows: the field strip, the immediate as the hardware gathers it (a band per run of wired
// bits, one bracket for the sign copies), what the decoder reads, the instructions one bit away, and
// for RV32 the units of the CPU it uses (insthw.ts). Chapter 13 and the program editor host it.

import '../styles/composer.css';
import type { CField, CImm, CInstr, ComposeIsa, CSlot, Parts } from '../isa/composekit';
import { carryParts, clampSlot, rememberParts } from '../isa/composekit';
import { RV32_COMPOSE } from '../riscv/compose';
import { decode, INSTRS } from '../riscv/isa';
import { h, s } from '../ui/dom';
import { instrUse } from './insthw';

export interface ComposerOpts {
  /** The instruction set (RV32 when absent). */
  isa?: ComposeIsa;
  word?: number;
  /** The instruction's address (the ISA's unit): targets are shown, and labels resolved, from it. */
  pc?: number;
  /** The program's labels: a target that sits on one is written by name. */
  labels?: Map<string, number>;
  /** Show the groups behind "More" from the start. */
  more?: boolean;
  /** Example lines offered as buttons under the input. */
  examples?: string[];
  onChange?(word: number, ok: boolean): void;
  /** The front panel's Deposit button (Switches view): what it does with the word. */
  deposit?: { label: string; run(word: number): void };
}

/** Fields or switches: the last view picked, for the next builder opened. */
let lastView: 'fields' | 'switches' = 'fields';

export interface Composer {
  el: HTMLElement;
  readonly word: number;
  /** The word as a line of the program (targets by label when one fits). */
  readonly text: string;
  /** Whether the word is an instruction this builder builds. */
  readonly ok: boolean;
  set(word: number): void;
  focus(): void;
}

const role = (f: CField) => `f-${f.role}`;

/** RV32: inst[6:2] → the specification's name for that major opcode. */
const MAJOR = ['LOAD', 'LOAD-FP', 'custom-0', 'MISC-MEM', 'OP-IMM', 'AUIPC', 'OP-IMM-32', '48b', 'STORE', 'STORE-FP', 'custom-1', 'AMO', 'OP', 'LUI', 'OP-32', '64b',
  'MADD', 'MSUB', 'NMSUB', 'NMADD', 'OP-FP', 'OP-V', 'custom-2', '48b', 'BRANCH', 'JALR', 'reserved', 'JAL', 'SYSTEM', 'OP-VE', 'custom-3', '≥80b'];
const USED = new Set(INSTRS.map((i) => (i.opcode >> 2) & 31));

/** RV32's data path sketch: blocks (x, y, w, h, label) and the unit names (insthw.ts) that light each. */
const BLOCKS: Record<string, [number, number, number, number, string, string[]]> = {
  pc: [6, 54, 32, 28, 'PC', ['pc']],
  im: [46, 54, 40, 28, 'IMEM', ['imem']],
  rf: [96, 14, 46, 30, 'Regs', ['rf', 'frf']],
  ig: [96, 52, 46, 24, 'ImmGen', ['imm', 'imm12']],
  ct: [96, 84, 46, 22, 'Control', ['ctl']],
  cs: [96, 114, 46, 22, 'CSR · trap', ['csr', 'sys', 'trap']],
  alu: [152, 14, 40, 38, 'ALU', ['alu']],
  md: [152, 58, 40, 22, 'Mul/Div', ['md']],
  fpu: [152, 86, 40, 22, 'FPU', ['fpu']],
  dm: [202, 14, 42, 38, 'DMEM', ['dm']],
  np: [202, 66, 42, 24, 'Next PC', ['npc', 'target', 'jtgt']],
  res: [254, 14, 40, 38, 'Result', ['res']],
};
const LINKS: [string, string][] = [['pc', 'im'], ['im', 'rf'], ['im', 'ig'], ['im', 'ct'], ['rf', 'alu'], ['ig', 'alu'], ['rf', 'md'], ['rf', 'fpu'], ['alu', 'dm'], ['dm', 'res'], ['alu', 'res'], ['md', 'res'], ['ig', 'np'], ['rf', 'cs'], ['cs', 'res']];

export function instrComposer(opts: ComposerOpts = {}): Composer {
  const isa = opts.isa ?? RV32_COMPOSE;
  const W = isa.wordBits;
  const mask = W === 32 ? 0xffffffff : 2 ** W - 1;
  const hex = (w: number) => '0x' + (w >>> 0).toString(16).padStart(W / 4, '0');
  const bitOf = (w: number, b: number) => (w >>> b) & 1;
  const pc = opts.pc, labels = opts.labels;

  let word = ((opts.word ?? isa.start) & mask) >>> 0;
  // Each operand as last set by an instruction that has it: picking another operation keeps those, and
  // never takes an operand from bits that meant something else (addi's immediate is not beq's rs2).
  let mem: Parts = { rd: 10, rs1: 10, rs2: 11 };
  const first = isa.decode(word);
  if (first) mem = rememberParts(mem, isa.instr(first.id), first.parts);
  let regSlot = '';
  let more = !!opts.more || !!(first && isa.groups.some((g) => g.more && g.ids.includes(first.id)));
  let hot = -1;
  /** Instruction bit feeding each immediate bit (this word's). */
  let srcOf: (number | 'zero')[] = [];
  let view = lastView;

  const pal = h('div', { class: 'cmp-pal' });
  const input = h('input', { class: 'cmp-in', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Instruction as assembly or a hex word' }) as HTMLInputElement;
  const msg = h('div', { class: 'cmp-msg', role: 'status' });
  const strip = h('div', { class: 'cmp-strip', style: `--n:${W}` });
  const bands = s('svg', { viewBox: `0 0 ${W} 10`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const wires = h('div', { class: 'cmp-wires', style: `--n:${W}` }, bands);
  const immRow = h('div', { class: 'cmp-strip cmp-imm', style: `--n:${W}` });
  const immCap = h('div', { class: 'cmp-immcap' });
  const ops = h('div', { class: 'cmp-ops' });
  const out = h('dl', { class: 'cmp-out' });
  const chain = h('div', { class: 'cmp-chain' });
  const near = h('div', { class: 'cmp-near' });
  const dp = isa.rv32 ? s('svg', { class: 'cmp-dp', viewBox: '0 0 300 142', role: 'img' }) : null;
  const path = isa.rv32 ? h('p', { class: 'cmp-path' }) : null;
  const omap = isa.rv32 ? h('div', { class: 'cmp-omap' }) : null;
  // The front panel: the same word on toggle switches with a lamp each, grouped by field (Altair, PDP-8).
  const panel = h('div', { class: 'cmp-panel', style: `--n:${W}` });
  const scroll = h('div', { class: 'cmp-scroll' }, strip, wires, immRow);
  const viewBtn = (v: 'fields' | 'switches', label: string) => h('button', {
    type: 'button', class: view === v ? 'on' : '', 'aria-pressed': String(view === v),
    onclick: () => { view = lastView = v; render(null); },
  }, label);
  const viewBar = h('div', { class: 'cmp-viewbar' });
  const examples = opts.examples?.length
    ? h('div', { class: 'cmp-ex' }, opts.examples.map((e) => h('button', { class: 'btn sm', type: 'button', onclick: () => { input.value = e; fromText(); } }, e)))
    : null;

  const el = h('div', { class: 'cmp' },
    pal,
    h('div', { class: 'cmp-inrow' }, input),
    examples,
    msg,
    h('div', { class: 'cmp-grid' },
      h('div', { class: 'cmp-main' },
        viewBar, scroll, panel,
        immCap, ops, out),
      h('div', { class: 'cmp-side' },
        dp ? h('div', null, h('h4', null, 'Uses'), dp, path) : null,
        h('div', null, h('h4', null, 'How the decoder gets there'), chain),
        h('div', null, h('h4', null, 'One bit away'), near),
        omap ? h('div', null, h('h4', null, 'Major opcodes · inst[6:2]'), omap) : null)));

  const cur = () => isa.decode(word);

  const set = (w: number, from: 'text' | 'slider' | null = null) => {
    word = (w & mask) >>> 0;
    const c = cur();
    if (c) mem = rememberParts(mem, isa.instr(c.id), c.parts);
    render(from);
    opts.onChange?.(word, !!c);
  };

  const pick = (id: string) => {
    const ins = isa.instr(id)!;
    set(isa.encode(id, carryParts(mem, mem, ins)));
  };

  const kindOf = (c: { id: string } | null) => {
    if (!c) return '';
    if (isa.rv32) return `${decode(word).fmt}-type`;
    return isa.instr(c.id)?.summary ?? isa.name;
  };

  // ---- rendering ---------------------------------------------------------------------------

  function render(from: 'text' | 'slider' | null) {
    const c = cur();
    const fields = isa.fields(word);
    renderPalette(c?.id ?? null);
    if (from !== 'text') {
      input.value = c ? isa.text(word, pc, labels) : hex(word);
      input.classList.remove('err');
      msg.className = 'cmp-msg';
      msg.textContent = c ? `${kindOf(c)} · click a bit to flip it, or type assembly / hex` : '';
    }
    if (!c) {
      msg.className = 'cmp-msg err';
      const name = isa.rv32 ? decode(word).spec?.name : undefined;
      msg.textContent = name
        ? `A ${name} with bits set that the builder leaves alone (an atomic's aq / rl, a fence's ordering): shown, not built.`
        : isa.rv32 ? `${hex(word)} is not an RV32 instruction here: the CPU traps with mcause 2 (illegal instruction).`
          : `${hex(word)} is not an instruction of ${isa.name}${fields[0]?.label === '.word' ? '' : ', or has bits set the builder leaves alone'}.`;
    }
    viewBar.replaceChildren(h('span', { class: 'cmp-seg' }, viewBtn('fields', 'Fields'), viewBtn('switches', 'Switches')),
      view === 'switches' && opts.deposit ? h('button', { type: 'button', class: 'btn sm primary', disabled: !c, title: c ? '' : 'Not an instruction', onclick: () => opts.deposit!.run(word) }, opts.deposit.label) : '');
    scroll.hidden = view !== 'fields';
    panel.hidden = view !== 'switches';
    if (view === 'switches') renderPanel(fields, !!c);
    else renderStrip(fields, !!c);
    renderImm(view === 'fields' && c ? isa.imm(word) : null, view === 'fields' && c ? isa.instr(c.id) : undefined, fields);
    if (from !== 'slider') renderOps(c);
    renderOut(c, fields);
    renderSide(c, fields);
  }

  function renderPalette(id: string | null) {
    pal.replaceChildren();
    for (const g of isa.groups) {
      if (g.more && !more) continue;
      pal.append(h('div', { class: 'cmp-group' }, isa.groups.length > 1 ? h('span', { class: 'gname' }, g.name) : null,
        g.ids.map((i) => {
          const ins = isa.instr(i)!;
          return h('button', {
            type: 'button', class: `cmp-chip${id === i ? ' on' : ''}`, title: ins.summary ?? ins.name,
            onclick: () => pick(i),
          }, ins.name);
        })));
    }
    if (isa.groups.some((g) => g.more)) {
      const names = isa.groups.filter((g) => g.more).map((g) => g.name.toLowerCase()).join(', ');
      pal.append(h('button', { type: 'button', class: 'btn ghost sm cmp-more', onclick: () => { more = !more; renderPalette(cur()?.id ?? null); } }, more ? 'Fewer' : `More: ${names}`));
    }
  }

  function renderStrip(fields: CField[], ok: boolean) {
    strip.replaceChildren();
    const at = (b: number) => fields.find((f) => f.lo <= b && b <= f.hi)!;
    for (let b = W - 1; b >= 0; b--) strip.append(h('span', { class: 'cmp-bn' }, b));
    for (let b = W - 1; b >= 0; b--) {
      const f = at(b), v = bitOf(word, b);
      strip.append(h('button', {
        type: 'button', class: `cmp-bit ${ok ? role(f) : 'f-bad'}${v ? ' one' : ''}${f.used ? '' : ' unused'}`, 'data-b': b,
        title: `bit ${b} of ${f.label}: click to flip`, 'aria-label': `bit ${b} = ${v}, ${f.label}`,
        onclick: () => set(word ^ 2 ** b),
        onmouseenter: () => { hot = b; lightWires(); },
        onmouseleave: () => { hot = -1; lightWires(); },
      }, v));
    }
    for (const f of fields) {
      const n = f.hi - f.lo + 1;
      const sub = !ok || !f.used ? '' : f.role === 'rd' || f.role === 'rs' ? f.meaning.replace(/[()]/g, '')
        : f.role === 'op' || (f.role === 'fn' && n <= 7) ? f.value.toString(2).padStart(n, '0') : '';
      strip.append(h('div', {
        class: `cmp-fl ${ok ? role(f) : 'f-bad'}${f.used ? '' : ' unused'}`, style: `grid-column:${W - f.hi} / ${W + 1 - f.lo}`,
        title: `${f.label} [${f.hi}:${f.lo}] = ${f.value}: ${f.meaning}`,
      }, h('b', null, f.label), h('small', null, sub.trim())));
    }
  }

  function renderPanel(fields: CField[], ok: boolean) {
    panel.replaceChildren(...fields.map((f) => h('div', { class: `cmp-pg ${ok ? role(f) : 'f-bad'}` },
      h('div', { class: 'cmp-pl', title: `${f.label}: ${f.meaning}` }, f.label.replace(/\[.*\]$/, '')),
      h('div', { class: 'cmp-sws' }, Array.from({ length: f.hi - f.lo + 1 }, (_, i) => {
        const b = f.hi - i, v = bitOf(word, b);
        return h('div', { class: 'cmp-sw' },
          h('span', { class: `cmp-led${v ? ' on' : ''}` }),
          h('button', { type: 'button', class: `cmp-tog${v ? ' up' : ''}`, 'aria-label': `switch ${b}: ${v ? 'up' : 'down'}`, 'aria-pressed': String(!!v), onclick: () => set(word ^ 2 ** b) }),
          h('span', { class: 'cmp-swn' }, b));
      })))));
  }

  function renderImm(imm: CImm | null, ins: CInstr | undefined, fields: CField[]) {
    immRow.replaceChildren();
    bands.replaceChildren();
    wires.querySelector('.cmp-sign')?.remove();
    srcOf = imm ? imm.wires.map((x) => x.src) : [];
    if (!imm || !ins) {
      immRow.hidden = true;
      wires.style.display = 'none';
      const shamt = ins?.slots.find((x) => x.role === 'shamt');
      immCap.textContent = !ins ? '' : shamt ? `A shift amount: ${shamt.max + 1} values in the bits where a register would be.`
        : ins.slots.some((x) => x.kind === 'num') ? 'Its number sits in one field, in order: nothing to gather or extend.'
          : ins.slots.length ? `${ins.name} has no immediate.` : `${ins.name} has no operands: its word is fixed.`;
      return;
    }
    immRow.hidden = false;
    wires.style.display = '';
    const at = (b: number) => fields.find((f) => f.lo <= b && b <= f.hi)!;
    const width = imm.wires.length;
    for (let b = W - 1; b >= 0; b--) {
      if (b >= width) { immRow.append(h('span', { class: 'cmp-gap' })); continue; }
      const x = imm.wires[b];
      const k = x.src === 'zero' ? 'zero' : x.sign ? 'sign' : 'wire';
      immRow.append(h('span', {
        class: `cmp-bit ${typeof x.src === 'number' ? role(at(x.src)) : 'f-zero'}${x.value ? ' one' : ''} ${k}`, 'data-i': b,
        title: k === 'zero' ? `imm[${b}] = 0: wired to ground` : k === 'sign' ? `imm[${b}] = instr[${x.src}]: a copy of the sign` : `imm[${b}] = instr[${x.src}]`,
        onmouseenter: () => { hot = typeof x.src === 'number' ? x.src : -1; lightWires(); },
        onmouseleave: () => { hot = -1; lightWires(); },
      }, x.value));
    }
    // Runs of immediate bits wired from consecutive instruction bits, high to low; the sign copies are one run.
    const runs: { hi: number; lo: number; src: number; sign: boolean }[] = [];
    for (let b = width - 1; b >= 0; b--) {
      const x = imm.wires[b];
      if (x.src === 'zero') continue;
      const last = runs[runs.length - 1];
      if (last && last.lo === b + 1 && last.sign === x.sign && (x.sign || last.src - (last.hi - b) === x.src)) last.lo = b;
      else runs.push({ hi: b, lo: b, src: x.src, sign: x.sign });
    }
    const g = 0.1;
    for (const r of runs) {
      const srcLo = r.sign ? r.src : r.src - (r.hi - r.lo);
      const pts = `${W - 1 - r.src + g},0 ${W - srcLo - g},0 ${W - r.lo - g},10 ${W - 1 - r.hi + g},10`;
      bands.append(s('polygon', { points: pts, class: `${role(at(r.src))}${r.sign ? ' sign' : ''}`, 'data-hi': r.src, 'data-lo': srcLo }));
    }
    const sign = runs.find((r) => r.sign);
    if (sign) wires.append(h('span', { class: 'cmp-sign', style: `left:${((W - 1 - sign.hi + W - sign.lo) / 2 / W) * 100}%` }, `bit ${sign.src} copied × ${sign.hi - sign.lo + 1}`));
    immCap.replaceChildren(
      h('span', null, `Top: the instruction. Bottom: the immediate the hardware gathers from it, ${imm.note}. Each band is wires from instruction bits to immediate bits; point at a bit to follow it.`),
      h('b', null, `imm = ${imm.text}`));
    lightWires();
  }

  function lightWires() {
    for (const b of strip.querySelectorAll<HTMLElement>('.cmp-bit')) b.classList.toggle('hot', Number(b.dataset.b) === hot);
    for (const p of bands.querySelectorAll('polygon')) p.classList.toggle('hot', hot >= Number(p.dataset.lo) && hot <= Number(p.dataset.hi));
    for (const b of immRow.querySelectorAll<HTMLElement>('.cmp-bit')) b.classList.toggle('hot', hot >= 0 && srcOf[Number(b.dataset.i)] === hot);
    // the exact wire of the bit pointed at (not a sign fan: its bracket lights instead)
    bands.querySelectorAll('line').forEach((l) => l.remove());
    if (hot < 0) return;
    const signTop = srcOf.findIndex((x, i) => i > 0 && x === srcOf[i - 1] && x !== 'zero');
    srcOf.forEach((src, i) => {
      if (src === hot && (signTop < 0 || i < signTop)) bands.append(s('line', { x1: W - 0.5 - hot, y1: 0, x2: W - 0.5 - i, y2: 10, 'vector-effect': 'non-scaling-stroke' }));
    });
  }

  function renderOps(c: { id: string; parts: Parts } | null) {
    ops.replaceChildren();
    if (!c) return;
    const ins = isa.instr(c.id)!;
    const regs = ins.slots.filter((x) => x.kind === 'reg');
    if (regs.length) {
      if (!regs.some((x) => x.key === regSlot)) regSlot = regs[0].key;
      const active = regs.find((x) => x.key === regSlot)!;
      const names = active.names ?? [];
      const card = h('div', { class: 'cmp-card' },
        h('h4', null, regs.length > 1 ? 'Registers' : 'Register'),
        h('div', { class: 'cmp-tabs', role: 'tablist' }, regs.map((x) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': x.key === regSlot ? 'true' : 'false',
          class: `${x.dest ? 'f-rd' : 'f-rs'}${x.key === regSlot ? ' on' : ''}`,
          onclick: () => { regSlot = x.key; renderOps(cur()); },
        }, `${x.label} = ${x.names?.[c.parts[x.key]] ?? c.parts[x.key]}`))),
        h('div', { class: `cmp-regs ${active.dest ? 'f-rd' : 'f-rs'}`, style: `--cols:${names.length > 16 ? 8 : names.length > 8 ? 8 : Math.max(names.length, 4)}` }, names.slice(0, active.max + 1).map((n, i) => {
          const also = regs.filter((x) => x.key !== regSlot && x.names === active.names && c.parts[x.key] === i).map((x) => x.label);
          // RV32 / RV16: the number big, the ABI name under it; a table's own names big, the number under
          const pre = isa.rv32 ? (active.names?.[0] === 'ft0' ? 'f' : 'x') : isa.id === 'rv16' ? 'x' : '';
          return h('button', {
            type: 'button', class: `cmp-reg${c.parts[regSlot] === i ? ' on' : ''}${also.length ? ' also' : ''}`,
            title: `${n} (${i})${also.length ? ` · also ${also.join(', ')}` : ''}`,
            onclick: () => set(isa.encode(c.id, { ...c.parts, [regSlot]: i })),
          }, pre ? [`${pre}${i}`, h('small', null, n)] : [n, h('small', null, String(i))]);
        })));
      if (isa.rv32 && regSlot === 'rd' && c.parts.rd === 0 && active.names?.[0] === 'zero') card.append(h('p', { class: 'cmp-note' }, 'rd = x0: the result is thrown away (x0 always reads 0).'));
      ops.append(card);
    }
    for (const slot of ins.slots) {
      if (slot.kind === 'num') ops.append(numberCard(c, ins, slot));
      else if (slot.kind === 'enum') ops.append(enumCard(c, slot));
    }
  }

  function numberCard(c: { id: string; parts: Parts }, ins: CInstr, slot: CSlot): HTMLElement {
    const v0 = c.parts[slot.key];
    const num = h('input', { type: 'number', class: 'cmp-num', min: slot.min, max: slot.max, step: slot.step, value: v0, 'aria-label': slot.label }) as HTMLInputElement;
    const range = h('input', { type: 'range', class: 'cmp-range', min: slot.min, max: slot.max, step: slot.step, value: v0, 'aria-label': `${slot.label} slider` }) as HTMLInputElement;
    const note = h('p', { class: 'cmp-note' }, noteFor(ins, slot, c.parts));
    // While the slider is dragged its card stays (rebuilding it would drop the drag); the note follows.
    const put = (raw: string, from: 'slider' | null) => {
      const v = clampSlot(slot, Number(raw));
      num.value = String(v);
      const next = { ...c.parts, [slot.key]: v };
      set(isa.encode(c.id, next), from);
      note.textContent = noteFor(ins, slot, next);
    };
    num.addEventListener('change', () => put(num.value, null));
    range.addEventListener('input', () => put(range.value, 'slider'));
    range.addEventListener('change', () => put(range.value, null));
    const picks = slot.options?.length
      ? h('select', { class: 'cmp-sel', 'aria-label': `${slot.label}: a named value`, onchange: (e: Event) => put((e.target as HTMLSelectElement).value, null) },
        h('option', { value: '', selected: !slot.options.some((o) => o.value === v0) }, 'named values…'),
        slot.options.map((o) => h('option', { value: o.value, selected: o.value === v0 }, `${o.name} (${slot.hex ? `0x${o.value.toString(16)}` : o.value})`)))
      : null;
    const title = { target: `Target: offset from this instruction (${isa.step === 4 ? 'bytes' : 'words'})`, upper: 'Upper bits', shamt: 'Shift amount', offset: 'Offset from the base register', address: 'Address', imm: 'Immediate' }[slot.role ?? 'imm'];
    return h('div', { class: 'cmp-card f-imm' }, h('h4', null, `${title} · ${slot.label}`), h('div', { class: 'cmp-numrow' }, num, range), picks, note);
  }

  function noteFor(ins: CInstr, slot: CSlot, parts: Parts): string {
    const v = parts[slot.key];
    const span = `${slot.min} … ${slot.max}${slot.step > 1 ? `, in steps of ${slot.step}` : ''}`;
    switch (slot.role) {
      case 'target': {
        const where = pc === undefined ? `${v >= 0 ? '+' : '−'}${Math.abs(v)} ${isa.step === 4 ? 'bytes' : 'words'}` : `target 0x${((pc + v) >>> 0).toString(16)}`;
        const name = pc !== undefined && labels ? [...labels].find(([, a]) => a === pc + v)?.[0] : undefined;
        return `${where}${name ? ` (${name})` : ''}. Reach: ${span}.`;
      }
      case 'upper': {
        const val = isa.imm(isa.encode(ins.id, parts))?.text;
        return `Loads ${val ?? v}; with an addi after it, any constant.`;
      }
      case 'shamt': return `Shift by ${span}.`;
      case 'offset': return `Address = base register + offset (${span}).`;
      case 'address': return `An absolute address: 0x${v.toString(16)}.`;
      default:
        if (isa.rv32 && ins.name === 'sltiu') return '12 bits, sign-extended, then compared unsigned.';
        if (isa.rv32 && slot.key === 'imm') return '12 bits, sign-extended: −2048 … 2047 (andi, ori, xori too).';
        return `${span}${slot.hex ? ` (0x${(v >>> 0).toString(16)})` : ''}.`;
    }
  }

  function enumCard(c: { id: string; parts: Parts }, slot: CSlot): HTMLElement {
    const sel = h('select', { class: 'cmp-sel', 'aria-label': slot.label },
      (slot.options ?? []).map((o) => h('option', { value: o.value, selected: o.value === c.parts[slot.key] }, o.name))) as HTMLSelectElement;
    sel.addEventListener('change', () => set(isa.encode(c.id, { ...c.parts, [slot.key]: Number(sel.value) })));
    return h('div', { class: 'cmp-card f-fn' }, h('h4', null, slot.label), sel);
  }

  function renderOut(c: { id: string } | null, fields: CField[]) {
    out.replaceChildren(
      h('dt', null, 'assembly'), h('dd', { class: 'big' }, c ? isa.text(word, pc, labels) : h('span', { class: 'cmp-badge bad' }, 'not an instruction')),
      h('dt', null, 'hex'), h('dd', null, hex(word)),
      h('dt', null, 'binary'), h('dd', null, fields.map((f) => h('span', { class: role(f) }, (Math.floor(word / 2 ** f.lo) % 2 ** (f.hi - f.lo + 1)).toString(2).padStart(f.hi - f.lo + 1, '0'))).flatMap((x, i) => (i ? [' ', x] : [x]))));
  }

  function renderSide(c: { id: string } | null, fields: CField[]) {
    // the decoder: the opcode-like fields, then the instruction they name
    chain.replaceChildren();
    const row = (bits: string, what: string, cls = '') => chain.append(h('div', { class: cls }, h('code', null, bits), h('span', null, what)));
    if (isa.rv32) {
      const op = word & 0x7f;
      row(`[1:0] = ${(op & 3).toString(2).padStart(2, '0')}`, (op & 3) === 3 ? '32-bit instruction' : 'a 16-bit compressed instruction (no C extension here)');
      row(`[6:2] = ${((op >> 2) & 31).toString(2).padStart(5, '0')}`, MAJOR[(op >> 2) & 31], 'f-op');
    }
    if (c) {
      for (const f of fields) {
        if (isa.rv32 && f.key === 'opcode') continue;
        // RV32 names its fields (funct3); elsewhere a fixed run is "opcode" more than once: say which bits
        const name = isa.rv32 ? f.label : f.hi === f.lo ? `[${f.hi}]` : `[${f.hi}:${f.lo}]`;
        if (f.role === 'op' || (f.role === 'fn' && f.used)) row(`${name} = ${f.value.toString(2).padStart(f.hi - f.lo + 1, '0')}`, f.meaning, f.role === 'op' ? 'f-op' : 'f-fn');
      }
      row('→', isa.instr(c.id)!.name, 'end');
    } else row('→', 'no match', 'end bad');

    // one bit away: what flipping a single bit of an opcode-like field makes of it
    near.replaceChildren();
    const seen = new Set<string>();
    if (c) {
      const self = isa.instr(c.id)!.name;
      for (const f of fields) {
        if (f.role !== 'op' && f.role !== 'fn') continue;
        for (let b = f.hi; b >= f.lo; b--) {
          // loose: the flipped word may carry bits the other instruction ignores; a click builds it clean
          const d = isa.loose((word ^ 2 ** b) >>> 0);
          const name = d && isa.instr(d.id)!.name;
          if (!d || !name || name === self || seen.has(name)) continue;
          seen.add(name);
          near.append(h('button', { type: 'button', class: 'cmp-chip', title: `flip bit ${b}`, onclick: () => set(isa.encode(d.id, d.parts)) }, h('small', null, `bit ${b} → `), name));
        }
      }
    }
    if (!near.childElementCount) near.append(h('span', { class: 'cmp-note' }, c ? 'No single flipped bit of its opcode makes another instruction of this word.' : '—'));

    if (!dp || !path || !omap) return;
    const use = instrUse(word);
    const lit = new Set(c ? Object.entries(BLOCKS).filter(([, b]) => b[5].some((u) => use.units.includes(u))).map(([k]) => k) : ['pc', 'im', 'ct']);
    if (c && /^(ecall|ebreak|mret|wfi|fence)$/.test(c.id)) lit.delete('rf');
    dp.replaceChildren(
      ...LINKS.map(([a, b]) => {
        const A = BLOCKS[a], B = BLOCKS[b];
        const x1 = A[0] + A[2], y1 = A[1] + A[3] / 2, x2 = B[0], y2 = B[1] + B[3] / 2, mx = (x1 + x2) / 2;
        return s('path', { class: lit.has(a) && lit.has(b) ? 'lit' : '', d: `M${x1} ${y1}H${mx}V${y2}H${x2}` });
      }),
      ...Object.entries(BLOCKS).map(([k, [x, y, w, hh, name]]) => s('g', { class: lit.has(k) ? 'lit' : '' },
        s('rect', { x, y, width: w, height: hh, rx: 4 }), s('text', { x: x + w / 2, y: y + hh / 2 }, name))));
    dp.setAttribute('aria-label', c ? `Uses: ${[...lit].map((k) => BLOCKS[k][4]).join(', ')}` : 'Control finds no instruction: a trap');
    path.textContent = c ? use.path : 'Control finds no instruction here: the trap unit takes over (mcause 2).';
    const op = word & 0x7f;
    omap.replaceChildren(...MAJOR.map((name, i) => h('span', {
      class: `${i === ((op >> 2) & 31) ? 'cur' : USED.has(i) ? 'used' : /custom/.test(name) ? 'free' : ''}`,
      title: `inst[6:2] = ${i.toString(2).padStart(5, '0')}${i === 2 ? ': the SIMT instructions of the lane cores' : /custom/.test(name) ? ': free for your own instructions' : ''}`,
    }, name)));
  }

  // ---- text input --------------------------------------------------------------------------

  function fromText() {
    const r = isa.parse(input.value, pc ?? 0, labels);
    if ('error' in r) {
      input.classList.add('err');
      msg.className = 'cmp-msg err';
      msg.textContent = r.error;
      return;
    }
    if ('words' in r) {
      input.classList.remove('err');
      msg.className = 'cmp-msg';
      msg.replaceChildren(`A pseudo-instruction: ${r.words.length} instructions. Build one: `,
        ...r.words.map((w) => h('button', { type: 'button', class: 'btn sm', onclick: () => set(w) }, isa.text(w))));
      return;
    }
    input.classList.remove('err');
    set(r.word, 'text');
    const c = cur();
    if (c) { msg.className = 'cmp-msg'; msg.textContent = `${kindOf(c)} · ${/^(0x)?[0-9a-f]+$/i.test(input.value.trim()) ? 'decoded from hex' : 'assembled'}`; }
  }
  input.addEventListener('input', fromText);

  render(null);

  return {
    el,
    get word() { return word; },
    get text() { return isa.text(word, pc, labels); },
    get ok() { return !!cur(); },
    set(w: number) { set(w); },
    focus() { input.focus(); input.select(); },
  };
}
