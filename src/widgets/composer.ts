// The instruction composer: one RV32 instruction edited from any side. Pick the operation, click
// registers, drag the immediate, type assembly or hex, or flip any bit of the word, and every view
// follows: the field strip, the immediate as the immediate generator rebuilds it (a wire from each
// source bit), what the decoder reads, and which units of the CPU the instruction uses (insthw.ts).
// Chapter 13's explorer and the sandbox's program editor (✎ / Ctrl+Space on a line) host it.

import '../styles/composer.css';
import { assemble } from '../riscv/asm';
import { clampTo, csrName, encodeParts, FIXED, NO_PARTS, PALETTE, parseLine, partsOf, retarget, slotsOf, textOf, type Composed, type Parts, type Slot, type SlotKey } from '../riscv/compose';
import { fieldAt, fieldRole, fieldsOf, immBits, type Field } from '../riscv/fields';
import { ABI, BY_NAME, CSRS, decode, FABI, IMM_TOP, INSTRS, OPCODES, RM_OPERANDS, type ImmFmt } from '../riscv/isa';
import { h, s } from '../ui/dom';
import { instrUse } from './insthw';

export interface ComposerOpts {
  word?: number;
  /** The instruction's address: branch targets are shown (and labels resolved) from it. */
  pc?: number;
  /** The program's labels: a target that sits on one is written by name. */
  labels?: Map<string, number>;
  /** Show the F / A / SIMT groups from the start. */
  more?: boolean;
  /** Example lines offered as buttons under the input. */
  examples?: string[];
  onChange?(word: number, c: Composed | null): void;
}

export interface Composer {
  el: HTMLElement;
  readonly word: number;
  /** The word as a line of the program (targets by label when one fits). */
  readonly text: string;
  /** Whether the word is an instruction this composer builds. */
  readonly ok: boolean;
  set(word: number): void;
  focus(): void;
}

const hex = (w: number) => '0x' + (w >>> 0).toString(16).padStart(8, '0');
const bitOf = (w: number, b: number) => (w >>> b) & 1;
const role = (f: Field) => `f-${fieldRole(f.key)}`;

/** inst[6:2] → the specification's name for that major opcode. */
const MAJOR = ['LOAD', 'LOAD-FP', 'custom-0', 'MISC-MEM', 'OP-IMM', 'AUIPC', 'OP-IMM-32', '48b', 'STORE', 'STORE-FP', 'custom-1', 'AMO', 'OP', 'LUI', 'OP-32', '64b',
  'MADD', 'MSUB', 'NMSUB', 'NMADD', 'OP-FP', 'OP-V', 'custom-2', '48b', 'BRANCH', 'JALR', 'reserved', 'JAL', 'SYSTEM', 'OP-VE', 'custom-3', '≥80b'];
const USED = new Set(INSTRS.map((i) => (i.opcode >> 2) & 31));

/** The data path sketch: blocks (x, y, w, h, label) and the unit names (insthw.ts) that light each. */
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

const SLOT_NAME: Record<SlotKey, string> = { rd: 'rd', rs1: 'rs1', rs2: 'rs2', rs3: 'rs3', imm: 'imm', csr: 'csr', zimm: 'zimm', rm: 'rm' };
const RMS = [0, 1, 2, 3, 4, 7];

export function instrComposer(opts: ComposerOpts = {}): Composer {
  let word = (opts.word ?? 0xfff50513) >>> 0;
  // Each operand as last set by an instruction that has it: picking another operation keeps those, and
  // never takes an operand from bits that meant something else (addi's immediate is not beq's rs2).
  let last: Parts = { ...NO_PARTS, rd: 10, rs1: 10, rs2: 11 };
  const remember = (c: Composed | null) => {
    if (!c) return;
    for (const sl of slotsOf(c.spec)) {
      const k = sl.key === 'zimm' ? 'rs1' : sl.key;
      last = { ...last, [k]: c.parts[k] };
    }
  };
  remember(partsOf(word));
  let regSlot: SlotKey = 'rd';
  let more = !!opts.more || !!(partsOf(word) && PALETTE.find((g) => g.more && g.names.includes(partsOf(word)!.spec.name)));
  let hot = -1;
  const pc = opts.pc, labels = opts.labels;

  const pal = h('div', { class: 'cmp-pal' });
  const input = h('input', { class: 'cmp-in', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Instruction as assembly or a hex word' }) as HTMLInputElement;
  const msg = h('div', { class: 'cmp-msg', role: 'status' });
  const strip = h('div', { class: 'cmp-strip' });
  const wires = s('svg', { class: 'cmp-wires', viewBox: '0 0 32 10', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const immRow = h('div', { class: 'cmp-strip cmp-imm' });
  const immCap = h('div', { class: 'cmp-immcap' });
  const ops = h('div', { class: 'cmp-ops' });
  const out = h('dl', { class: 'cmp-out' });
  const dp = s('svg', { class: 'cmp-dp', viewBox: '0 0 300 142', role: 'img' });
  const path = h('p', { class: 'cmp-path' });
  const chain = h('div', { class: 'cmp-chain' });
  const omap = h('div', { class: 'cmp-omap' });
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
        h('div', { class: 'cmp-scroll' }, strip, wires, immRow),
        immCap, ops, out),
      h('div', { class: 'cmp-side' },
        h('div', null, h('h4', null, 'Uses'), dp, path),
        h('div', null, h('h4', null, 'How the decoder gets there'), chain),
        h('div', null, h('h4', null, 'Major opcodes · inst[6:2]'), omap))));

  const cur = () => partsOf(word);

  const set = (w: number, from: 'text' | 'slider' | null = null) => {
    word = w >>> 0;
    const c = cur();
    remember(c);
    render(from);
    opts.onChange?.(word, c);
  };

  const pick = (name: string) => {
    const spec = BY_NAME.get(name)!;
    const p = retarget(last, spec);
    set(encodeParts(spec, p));
  };

  // ---- rendering ---------------------------------------------------------------------------

  function render(from: 'text' | 'slider' | null) {
    const c = cur();
    const d = decode(word);
    const fields = fieldsOf(word);
    renderPalette(c);
    if (from !== 'text') {
      input.value = c ? textOf(word, pc, labels) : hex(word);
      input.classList.remove('err');
      msg.className = 'cmp-msg';
      msg.textContent = c ? `${d.fmt}-type · click a bit to flip it, or type assembly / hex` : '';
    }
    if (!c) {
      msg.className = 'cmp-msg err';
      msg.textContent = d.spec
        ? `A ${d.spec.name} with bits set that the composer leaves alone (an atomic's aq / rl, a fence's ordering): shown, not built.`
        : `${hex(word)} is not an RV32 instruction here: the CPU traps with mcause 2 (illegal instruction).`;
    }
    renderStrip(fields);
    renderImm(c, fields);
    if (from !== 'slider') renderOps(c);
    renderOut(c, fields);
    renderSide(c, fields);
  }

  function renderPalette(c: Composed | null) {
    pal.replaceChildren();
    for (const g of PALETTE) {
      if (g.more && !more) continue;
      pal.append(h('div', { class: 'cmp-group' }, h('span', { class: 'gname' }, g.name),
        g.names.map((n) => h('button', {
          type: 'button', class: `cmp-chip${c?.spec.name === n ? ' on' : ''}`, title: `${n}: ${BY_NAME.get(n)!.fmt}-type`,
          onclick: () => pick(n),
        }, n))));
    }
    pal.append(h('button', { type: 'button', class: 'btn ghost sm cmp-more', onclick: () => { more = !more; renderPalette(cur()); } },
      more ? 'Fewer' : 'More: atomics, float, SIMT'));
  }

  function renderStrip(fields: Field[]) {
    const ok = !!cur();
    strip.replaceChildren();
    for (let b = 31; b >= 0; b--) strip.append(h('span', { class: 'cmp-bn' }, b));
    for (let b = 31; b >= 0; b--) {
      const f = fieldAt(fields, b), v = bitOf(word, b);
      strip.append(h('button', {
        type: 'button', class: `cmp-bit ${ok ? role(f) : 'f-bad'}${v ? ' one' : ''}${f.used ? '' : ' unused'}`, 'data-b': b,
        title: `bit ${b} of ${f.label}: click to flip`, 'aria-label': `bit ${b} = ${v}, ${f.label}`,
        onclick: () => set(word ^ (1 << b)),
        onmouseenter: () => { hot = b; lightWires(); },
        onmouseleave: () => { hot = -1; lightWires(); },
      }, v));
    }
    for (const f of fields) {
      const reg = f.key === 'rd' || f.key === 'rs1' || f.key === 'rs2' || f.key === 'rs3';
      const n = f.hi - f.lo + 1;
      const sub = !ok ? '' : reg && f.used ? f.meaning.replace(/[()]/g, '')
        : f.key === 'opcode' ? f.value.toString(2).padStart(7, '0') : fieldRole(f.key) === 'fn' && n <= 7 ? f.value.toString(2).padStart(n, '0') : '';
      strip.append(h('div', {
        class: `cmp-fl ${ok ? role(f) : 'f-bad'}${f.used ? '' : ' unused'}`, style: `grid-column:${32 - f.hi} / ${33 - f.lo}`,
        title: `${f.label} [${f.hi}:${f.lo}] = ${f.value}: ${f.meaning}`,
      }, h('b', null, f.label), h('small', null, sub.trim())));
    }
  }

  function renderImm(c: Composed | null, fields: Field[]) {
    const slot = c && slotsOf(c.spec).find((x) => x.key === 'imm');
    const ib = slot ? immBits(word) : [];
    immRow.replaceChildren();
    wires.replaceChildren();
    if (!c || !slot || !ib.length) {
      immRow.hidden = true;
      wires.style.display = 'none';
      immCap.textContent = c ? (c.spec.name in FIXED ? `${c.spec.name} has no operands: its word is fixed.` : `${c.spec.name} has no immediate.`) : '';
      return;
    }
    immRow.hidden = false;
    wires.style.display = '';
    if (slot.role === 'shamt') {
      // A shift amount is rs2's slot read as a number: no immediate generator involved.
      immRow.hidden = true;
      wires.style.display = 'none';
      immCap.textContent = `shamt = ${c.parts.imm}: bits 24:20, where rs2 would be. funct7 bit 30 picks logical or arithmetic.`;
      return;
    }
    const d = decode(word);
    for (let b = 31; b >= 0; b--) {
      const x = ib[b];
      const k = x.src === 'zero' ? 'zero' : x.sign ? 'sign' : 'wire';
      const srcF = typeof x.src === 'number' ? fieldAt(fields, x.src) : null;
      immRow.append(h('span', {
        class: `cmp-bit ${srcF ? role(srcF) : 'f-zero'}${x.value ? ' one' : ''} ${k}`, 'data-i': b,
        title: k === 'zero' ? `imm[${b}] = 0: wired to ground` : k === 'sign' ? `imm[${b}] = instr[31]: a copy of the sign` : `imm[${b}] = instr[${x.src}]`,
        onmouseenter: () => { hot = typeof x.src === 'number' ? x.src : -1; lightWires(); },
        onmouseleave: () => { hot = -1; lightWires(); },
      }, x.value));
      if (typeof x.src === 'number') {
        wires.append(s('line', { x1: 31.5 - x.src, y1: 0, x2: 31.5 - b, y2: 10, 'vector-effect': 'non-scaling-stroke', class: k, 'data-src': x.src, 'data-i': b }));
      }
    }
    const top = IMM_TOP[d.fmt as ImmFmt] ?? 11;
    const val = d.fmt === 'U' ? `0x${(d.imm >>> 0).toString(16)}` : String(d.imm);
    immCap.replaceChildren(
      h('span', null, d.fmt === 'U' ? 'The immediate generator\'s output: the upper 20 bits, the low 12 tied to ground.' : `The immediate generator's output: ${d.fmt === 'B' || d.fmt === 'J' ? 'bit 0 tied to ground, ' : ''}sign-extended from bit ${top} (dashed: copies of bit 31). Point at a bit to see where it comes from.`),
      h('b', null, `imm = ${val}`));
    lightWires();
  }

  function lightWires() {
    for (const b of strip.querySelectorAll<HTMLElement>('.cmp-bit')) b.classList.toggle('hot', Number(b.dataset.b) === hot);
    for (const l of wires.querySelectorAll('line')) l.classList.toggle('hot', Number(l.getAttribute('data-src')) === hot);
    for (const b of immRow.querySelectorAll<HTMLElement>('.cmp-bit')) {
      const i = Number(b.dataset.i);
      const line = wires.querySelector(`line[data-i="${i}"]`);
      b.classList.toggle('hot', hot >= 0 && Number(line?.getAttribute('data-src')) === hot);
    }
  }

  function renderOps(c: Composed | null) {
    ops.replaceChildren();
    if (!c) return;
    const slots = slotsOf(c.spec);
    const regs = slots.filter((x) => x.bank);
    if (regs.length) {
      if (!regs.some((x) => x.key === regSlot)) regSlot = regs[0].key;
      const active = regs.find((x) => x.key === regSlot)!;
      const names = active.bank === 'f' ? FABI : ABI;
      const card = h('div', { class: 'cmp-card' },
        h('h4', null, 'Registers'),
        h('div', { class: 'cmp-tabs', role: 'tablist' }, regs.map((x) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': x.key === regSlot ? 'true' : 'false',
          class: `${x.key === 'rd' ? 'f-rd' : 'f-rs'}${x.key === regSlot ? ' on' : ''}`,
          onclick: () => { regSlot = x.key; renderOps(cur()); },
        }, `${SLOT_NAME[x.key]} = ${(x.bank === 'f' ? FABI : ABI)[c.parts[x.key as 'rd']]}`))),
        h('div', { class: `cmp-regs ${regSlot === 'rd' ? 'f-rd' : 'f-rs'}` }, names.map((n, i) => {
          const also = regs.filter((x) => x.key !== regSlot && x.bank === active.bank && c.parts[x.key as 'rd'] === i).map((x) => x.key);
          return h('button', {
            type: 'button', class: `cmp-reg${c.parts[regSlot as 'rd'] === i ? ' on' : ''}${also.length ? ' also' : ''}`,
            title: `${active.bank}${i} (${n})${also.length ? ` · also ${also.join(', ')}` : ''}`,
            onclick: () => set(encodeParts(c.spec, { ...c.parts, [regSlot]: i })),
          }, `${active.bank}${i}`, h('small', null, n));
        })));
      if (regSlot === 'rd' && active.bank === 'x' && c.parts.rd === 0) card.append(h('p', { class: 'cmp-note' }, 'rd = x0: the result is thrown away (x0 always reads 0).'));
      ops.append(card);
    }
    for (const slot of slots) {
      if (slot.key === 'imm' || slot.key === 'zimm') ops.append(numberCard(c, slot));
      else if (slot.key === 'csr') ops.append(csrCard(c));
      else if (slot.key === 'rm') ops.append(rmCard(c));
    }
  }

  function numberCard(c: Composed, slot: Slot): HTMLElement {
    const key = slot.key === 'zimm' ? 'rs1' : 'imm';
    const v0 = c.parts[key];
    const num = h('input', { type: 'number', class: 'cmp-num', min: slot.min!, max: slot.max!, step: slot.step!, value: v0, 'aria-label': slot.key }) as HTMLInputElement;
    const range = h('input', { type: 'range', class: 'cmp-range', min: slot.min!, max: slot.max!, step: slot.step!, value: v0, 'aria-label': `${slot.key} slider` }) as HTMLInputElement;
    const note = h('p', { class: 'cmp-note' }, noteFor(c, slot));
    // While the slider is dragged its card stays (rebuilding it would drop the drag); the note follows.
    const put = (raw: string, from: 'slider' | null) => {
      const v = clampTo(slot, Number(raw));
      if (!Number.isFinite(v)) return;
      num.value = String(v);
      const next = { ...c.parts, [key]: v };
      set(encodeParts(c.spec, next), from);
      note.textContent = noteFor({ spec: c.spec, parts: next }, slot);
    };
    num.addEventListener('change', () => put(num.value, null));
    range.addEventListener('input', () => put(range.value, 'slider'));
    range.addEventListener('change', () => put(range.value, null));
    const title = slot.key === 'zimm' ? 'zimm: a 5-bit value in rs1\'s slot' : { target: 'Offset from this instruction (bytes)', upper: 'Upper 20 bits', shamt: 'Shift amount', offset: 'Offset from rs1 (bytes)', imm: 'Immediate' }[slot.role ?? 'imm'];
    return h('div', { class: 'cmp-card f-imm' }, h('h4', null, title), h('div', { class: 'cmp-numrow' }, num, range), note);
  }

  function noteFor(c: Composed, slot: Slot): string {
    const v = slot.key === 'zimm' ? c.parts.rs1 : c.parts.imm;
    switch (slot.key === 'zimm' ? 'zimm' : slot.role) {
      case 'target': {
        const where = pc === undefined ? `${v >= 0 ? '+' : '−'}${Math.abs(v)} bytes = ${v / 4} instructions` : `target 0x${((pc + v) >>> 0).toString(16)}`;
        const name = pc !== undefined && labels ? [...labels].find(([, a]) => a === pc + v)?.[0] : undefined;
        return `${where}${name ? ` (${name})` : ''}. ${c.spec.fmt === 'B' ? '±4 KiB' : '±1 MiB'}, even: bit 0 is not stored.`;
      }
      case 'upper': return `rd = 0x${((v * 4096) >>> 0).toString(16)}${c.spec.name === 'auipc' ? ' + pc' : ''}. With addi after it, any 32-bit constant.`;
      case 'shamt': return 'Five bits, in rs2\'s place.';
      case 'offset': return 'Address = rs1 + offset, 12 bits sign-extended.';
      case 'zimm': return 'Zero-extended into the CSR operation.';
      default: return c.spec.name === 'sltiu' ? '12 bits, sign-extended, then compared unsigned.' : '12 bits, sign-extended: −2048 … 2047 (andi, ori, xori too).';
    }
  }

  function csrCard(c: Composed): HTMLElement {
    const sel = h('select', { class: 'cmp-sel', 'aria-label': 'CSR' },
      Object.entries(CSRS).sort((a, b) => a[1] - b[1]).map(([n, v]) => h('option', { value: v, selected: v === c.parts.csr }, `${n} (0x${v.toString(16).padStart(3, '0')})`)),
      CSRS[csrName(c.parts.csr)] === undefined ? h('option', { value: c.parts.csr, selected: true }, csrName(c.parts.csr)) : null) as HTMLSelectElement;
    sel.addEventListener('change', () => set(encodeParts(c.spec, { ...c.parts, csr: Number(sel.value) })));
    return h('div', { class: 'cmp-card f-imm' }, h('h4', null, 'CSR (bits 31:20)'), sel,
      h('p', { class: 'cmp-note' }, 'The old value goes to rd, the new one comes from rs1 (or zimm).'));
  }

  function rmCard(c: Composed): HTMLElement {
    const sel = h('select', { class: 'cmp-sel', 'aria-label': 'Rounding mode' },
      RMS.map((r) => h('option', { value: r, selected: r === c.parts.rm }, r === 7 ? 'dyn (the mode in frm)' : RM_OPERANDS[r]))) as HTMLSelectElement;
    sel.addEventListener('change', () => set(encodeParts(c.spec, { ...c.parts, rm: Number(sel.value) })));
    return h('div', { class: 'cmp-card f-fn' }, h('h4', null, 'Rounding (rm, bits 14:12)'), sel);
  }

  function renderOut(c: Composed | null, fields: Field[]) {
    out.replaceChildren(
      h('dt', null, 'assembly'), h('dd', { class: 'big' }, c ? textOf(word, pc, labels) : h('span', { class: 'cmp-badge bad' }, 'illegal instruction')),
      h('dt', null, 'hex'), h('dd', null, hex(word)),
      h('dt', null, 'binary'), h('dd', null, fields.map((f) => h('span', { class: role(f) }, ((word >>> f.lo) & (2 ** (f.hi - f.lo + 1) - 1)).toString(2).padStart(f.hi - f.lo + 1, '0'))).flatMap((x, i) => (i ? [' ', x] : [x]))));
  }

  function renderSide(c: Composed | null, fields: Field[]) {
    const use = instrUse(word);
    const lit = new Set(c ? Object.entries(BLOCKS).filter(([, b]) => b[5].some((u) => use.units.includes(u))).map(([k]) => k) : ['pc', 'im', 'ct']);
    if (c?.spec.opcode === OPCODES.SYSTEM && (c.spec.funct3 ?? 0) === 0) lit.delete('rf');
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

    chain.replaceChildren();
    const row = (bits: string, what: string, cls = '') => chain.append(h('div', { class: cls }, h('code', null, bits), h('span', null, what)));
    const op = word & 0x7f;
    row(`[1:0] = ${(op & 3).toString(2).padStart(2, '0')}`, (op & 3) === 3 ? '32-bit instruction' : 'a 16-bit compressed instruction (no C extension here)');
    row(`[6:2] = ${((op >> 2) & 31).toString(2).padStart(5, '0')}`, MAJOR[(op >> 2) & 31], 'f-op');
    if (c) {
      for (const f of fields) {
        if (f.key === 'funct3' || f.key === 'funct7' || f.key === 'funct12' || f.key === 'fmt') {
          row(`${f.label} = ${f.value.toString(2).padStart(f.hi - f.lo + 1, '0')}`, f.meaning, 'f-fn');
        }
      }
      if (c.spec.fp?.rs2fixed !== undefined) row(`rs2 = ${c.spec.fp.rs2fixed}`, `selects ${c.spec.name}`, 'f-fn');
      row('→', c.spec.name, 'end');
    } else row('→', 'no match: illegal instruction', 'end bad');

    omap.replaceChildren(...MAJOR.map((name, i) => h('span', {
      class: `${i === ((op >> 2) & 31) ? 'cur' : USED.has(i) ? 'used' : /custom/.test(name) ? 'free' : ''}`,
      title: `inst[6:2] = ${i.toString(2).padStart(5, '0')}${i === 2 ? ': the SIMT instructions of the lane cores' : /custom/.test(name) ? ': free for your own instructions' : ''}`,
    }, name)));
  }

  // ---- text input --------------------------------------------------------------------------

  function fromText() {
    const r = parseLine(input.value, assemble, pc ?? 0, labels);
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
        ...r.words.map((w) => h('button', { type: 'button', class: 'btn sm', onclick: () => set(w) }, textOf(w))));
      return;
    }
    input.classList.remove('err');
    set(r.word, 'text');
    const c = cur();
    if (c) { msg.className = 'cmp-msg'; msg.textContent = `${decode(word).fmt}-type · ${/^(0x)?[0-9a-f]{8}$/i.test(input.value.trim()) ? 'decoded from hex' : 'assembled'}`; }
  }
  input.addEventListener('input', fromText);

  render(null);

  return {
    el,
    get word() { return word; },
    get text() { return textOf(word, pc, labels); },
    get ok() { return !!cur(); },
    set(w: number) { set(w); },
    focus() { input.focus(); input.select(); },
  };
}
