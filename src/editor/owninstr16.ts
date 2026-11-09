// "Custom instructions…" on an RV16 core (the reference single-cycle core rv16_cpu or the pipeline rv16_pipe_111, as
// Examples ▸ RV16: Pong places): the RV32 dialog (owninstr.ts) with what RV16 cannot have hidden. RV16's opcode is full,
// so a row lives in one of OPX's free funct3 values and is R-type: rd ← f(rs1, rs2), an ALU operation or a load from
// the address it makes (riscv/rv16/custom16.ts). Apply (one undo step) turns the core into { core16 } and gives the
// program ROM a copy of the rows, so the program assembles and the CPU drawer's golden model runs them.

import '../styles/owninstr.css';
import { control16, CTL16 } from '../lib/rv16/cpu';
import type { CustomRow } from '../riscv/custom';
import { DIRECTIVES16, PSEUDO16 } from '../riscv/rv16/asm16';
import { buildable16, CUSTOM16_PRESETS, F3_OP, FREE_F3, MAX_ROWS16, meaning16, problems16, signals16, type Custom16Row, type Free16 } from '../riscv/rv16/custom16';
import { BY_NAME16 } from '../riscv/rv16/isa16';
import { stats } from '../sim/stats';
import { h, icon, undoKey } from '../ui/dom';
import { dataPath } from '../widgets/ownrow';
import type { Rv16Desc } from './cpu16';
import type { Editor } from './editor';
import { type ChipDoc, type PartRef, rv16CoreOf, rv16CoreRef } from './model';
import { setRef } from './ops';

const TAKEN = new Set([...BY_NAME16.keys(), ...PSEUDO16, ...DIRECTIVES16]);
const f3s = (v: number) => v.toString(2).padStart(3, '0');

/** Why RV16 rows have no immediate: said in the dialog, plainly. */
export const WHY_NO_IMM16 = 'RV16\'s 4-bit opcode is full: 0 to 14 are taken and 15 is lui\'s (its op[3] is an immediate bit). A row borrows one of '
  + 'OPX\'s free funct3 values (OPX uses 0 for sub and 5 for sra), and funct3 sits where an I-type immediate\'s top bits would be, so a row has '
  + 'no immediate: it is rd ← f(rs1, rs2). Branches, jumps and stores would need fields the word does not have.';

/** The RV32 data path sketch's row for an RV16 row (the same blocks light: registers, ALU, memory for a load, result). */
const sketchRow = (r: Custom16Row): CustomRow => ({
  name: r.name, slot: 1, fmt: 'R', funct3: r.f3, regWrite: true, srcA: 'rs1', srcB: 'rs2', alu: r.alu === 'f3' ? 'funct3' : r.alu, memWrite: false, result: r.result, next: 'pc4',
});

/** The golden model's code for a row, as generated (shown, not run: iss16.ts runs the row itself). */
export function issCode16(r: Custom16Row): string {
  const y = r.alu === 'add' ? 'x[rs1] + x[rs2]' : r.alu === 'sub' ? 'x[rs1] - x[rs2]' : `${F3_OP[r.f3]}(x[rs1], x[rs2])`;
  return [`// ${r.name}: R-type, opcode OPX (0010), funct3 ${f3s(r.f3)}`, `const y = ${y};`, `if (rd) x[rd] = ${r.result === 'mem' ? 'load16(y)' : 'y'};`, 'pc += 1;'].join('\n');
}

let open: HTMLElement | null = null;

/** Open the dialog on the chip's RV16 core; after: called once applied (e.g. to reopen the program editor). */
export function openCustom16(ed: Editor, desc: Rv16Desc, after?: () => void): void {
  const core = ed.doc.parts.find((p) => p.id === desc.core);
  const kind = core ? rv16CoreOf(core.ref) : null;
  if (!core || !kind) {
    return void ed.toast('Custom instructions on RV16 need the reference core (rv16_cpu, as in Examples ▸ RV16: Pong) or its five-stage pipeline (rv16_pipe_111). The trap cores would take a row for an illegal instruction.', 'err');
  }
  open?.remove();
  let rows: Custom16Row[] = structuredClone(kind.custom);
  let sel = 0;
  const left = h('div', { class: 'oi-left' });
  const right = h('div', { class: 'oi-right' });
  const status = h('div', { class: 'sb-rom-dlg-status', role: 'status' });
  const applyBtn = h('button', { class: 'btn sm primary', title: 'Apply: one undo step; the core is rebuilt and the golden model follows' }, 'Apply') as HTMLButtonElement;

  const close = () => { ov.remove(); open = null; ed.view.svg.focus?.(); };
  const taken = (r: Custom16Row) => new Set([...TAKEN, ...rows.filter((x) => x !== r).map((x) => x.name)]);
  const freeF3 = (r?: Custom16Row) => FREE_F3.filter((n) => !rows.some((x) => x !== r && x.f3 === n));

  const render = () => {
    left.replaceChildren(
      h('div', { class: 'oi-sec' }, 'Your instructions'),
      ...rows.map((r, i) => h('button', { type: 'button', class: `oi-item${i === sel ? ' on' : ''}${buildable16(r, taken(r)) ? '' : ' bad'}`, onclick: () => { sel = i; render(); } },
        h('b', null, r.name || '(unnamed)'), h('small', null, `OPX · funct3 ${f3s(r.f3)} · R-type`))),
      rows.length < MAX_ROWS16 ? h('div', { class: 'oi-sec' }, 'Add one, starting from') : '',
      ...(rows.length < MAX_ROWS16 ? CUSTOM16_PRESETS.map((p) => {
        const f3 = p.alu === 'f3' && freeF3().includes(6) ? 6 : freeF3()[0]!;
        const row0: Custom16Row = { ...p, f3 };
        return h('button', {
          type: 'button', class: 'btn sm ghost oi-preset', title: meaning16(row0).join('; '),
          onclick: () => {
            let name = p.name;
            for (let k = 2; TAKEN.has(name) || rows.some((x) => x.name === name); k++) name = `${p.name}${k}`;
            rows = [...rows, { ...row0, name }];
            sel = rows.length - 1;
            render();
          },
        }, `${p.name}: ${meaning16(row0)[0]}`);
      }) : []),
      h('p', { class: 'sb-sum oi-why' }, WHY_NO_IMM16));

    const r = rows[sel];
    if (!r) {
      right.replaceChildren(h('p', { class: 'sb-sum' }, 'No custom instructions: the core is plain RV16I. Add one on the left.'));
    } else {
      const set = (patch: Partial<Custom16Row>) => { rows = rows.map((x, i) => (i === sel ? { ...x, ...patch } : x)); render(); };
      const name = h('input', { class: 'oi-name', value: r.name, spellcheck: 'false', 'aria-label': 'Mnemonic' }) as HTMLInputElement;
      name.addEventListener('change', () => set({ name: name.value.trim().toLowerCase() }));
      const f3 = h('select', { 'aria-label': 'funct3' }, freeF3(r).map((v) => h('option', { value: v, selected: v === r.f3 }, `${f3s(v)} (${v})`))) as HTMLSelectElement;
      f3.addEventListener('change', () => set({ f3: Number(f3.value) as Free16 }));
      const seg = (label: string, key: 'alu' | 'result', opts: [string, string][]) => h('div', { class: 'oi-line' }, h('span', null, label),
        h('span', { class: 'oi-seg', role: 'group', 'aria-label': label }, opts.map(([v, t]) => h('button', {
          type: 'button', class: r[key] === v ? 'on' : '', 'aria-pressed': String(r[key] === v), onclick: () => set({ [key]: v } as Partial<Custom16Row>),
        }, t))));
      const probs = problems16(r, taken(r));
      const ok = !probs.some((p) => p.level === 'bad');
      right.replaceChildren(
        h('div', { class: 'oi-enc' },
          h('label', null, 'Mnemonic', name), h('label', null, 'Format', h('span', { class: 'oi-fixed' }, 'R: rd, rs1, rs2')), h('label', null, 'funct3 (OPX)', f3),
          h('button', { type: 'button', class: 'btn sm ghost', title: 'Remove this instruction', onclick: () => { rows = rows.filter((_, i) => i !== sel); sel = Math.max(0, sel - 1); render(); } }, icon('close', 13), 'Remove')),
        h('div', { class: 'oi-cols' },
          h('div', { class: 'oi-ctl' },
            seg('ALU op', 'alu', [['add', 'add'], ['sub', 'subtract'], ['f3', `funct3 picks (${F3_OP[r.f3]})`]]),
            seg('result', 'result', [['alu', 'ALU'], ['mem', 'memory']]),
            h('div', { class: 'oi-sem' }, ...meaning16(r).map((m) => h('div', null, m))),
            h('div', { class: 'oi-probs' }, ok ? h('div', { class: 'ok' }, 'The data path already does this in one cycle: only the control unit changes.') : '',
              ...probs.map((p) => h('div', { class: p.level }, p.text)))),
          h('div', { class: 'oi-side' }, h('h4', null, 'Data path'), dataPath(sketchRow(r)),
            h('h4', null, 'Signals it asserts'), h('p', { class: 'oi-sigs' }, signals16(r).map((x) => h('code', null, x))),
            h('h4', null, 'Golden model (generated from the row)'), h('pre', { class: 'oi-code' }, issCode16(r)))));
    }

    const allOk = rows.every((r) => buildable16(r, taken(r)));
    applyBtn.disabled = !allOk;
    if (!allOk) {
      status.className = 'sb-rom-dlg-status err';
      status.textContent = 'Fix the instructions marked red first.';
    } else {
      const base = stats(CTL16).nands, now = rows.length ? stats(control16(rows)).nands : base;
      status.className = 'sb-rom-dlg-status';
      status.textContent = rows.length ? `Control unit: ${base} → ${now} NANDs (+${now - base}); the data path does not change.` : 'Plain RV16I: Apply removes the custom instructions.';
    }
  };

  const apply = () => {
    const rom = ed.doc.parts.find((p) => p.id === desc.rom);
    if (!rom || !('rom' in rom.ref)) return void ed.toast('The program ROM is gone', 'err');
    const coreRef: PartRef = rv16CoreRef({ pipe: kind.pipe, custom: rows });
    const { custom16: _old, ...romRest } = rom.ref.rom;
    const romRef: PartRef = { rom: { ...romRest, ...(rows.length ? { custom16: rows } : {}) } };
    let err = '';
    ed.editWs((ws) => {
      const chips: Record<string, ChipDoc> = { ...ws.chips };
      const r1 = setRef(chips[ed.chipId], core.id, coreRef, ed.defOf);
      if (r1.reason) { err = r1.reason; return ws; }
      const r2 = setRef(r1.doc, rom.id, romRef, ed.defOf);
      if (r2.reason) { err = r2.reason; return ws; }
      chips[ed.chipId] = r2.doc;
      return { ...ws, chips };
    });
    if (err) return void ed.toast(err, 'err');
    close();
    ed.toast(rows.length ? `The core now runs ${rows.map((r) => r.name).join(', ')} (${undoKey()} undoes)` : `Custom instructions removed (${undoKey()} undoes)`);
    after?.();
  };
  applyBtn.addEventListener('click', apply);

  const ov = h('div', { class: 'sb-help sb-rom-dlg oi-dlg', role: 'dialog', 'aria-label': 'Custom instructions' },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, icon('code', 16), 'Custom instructions', h('small', null, `${core.id} · ${kind.pipe ? 'pipelined' : 'single-cycle'} RV16 · up to six, in OPX's free funct3 values`)),
        h('button', { class: 'btn ghost icon-only', 'aria-label': 'Cancel', title: 'Cancel (Esc)', onclick: close }, icon('close', 16))),
      h('div', { class: 'oi-body' }, left, right),
      h('div', { class: 'sb-rom-dlg-foot' }, status, h('button', { class: 'btn sm', onclick: close }, 'Cancel'), applyBtn)));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !(e.target as HTMLElement).matches('input, select')) close();
  });
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  open = ov;
  ed.el.append(ov);
  render();
}
