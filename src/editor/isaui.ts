// The ISA editor (File ▸ Instruction sets…, or a ROM's Language): custom instruction sets as tables
// of mnemonics, operand letters and bit patterns (isa/table.ts). The list holds the presets (read
// only: copy one to start) and the workspace's tables; the selected one is edited in three tabs:
// Instructions (rows with their encoding drawn bit by bit), Operands (what each letter is) and Check
// (the table's problems, how many words decode, and a line tried live). Every committed change is
// one undo step and reaches every ROM that holds the table (isaops.putIsa).

import '../styles/isa.css';
import { ISA_PRESETS } from '../isa/presets';
import { type InstrDef, type IsaDoc, type OperandDef, sanitizeIsa, tableOf } from '../isa/table';
import { h, icon } from '../ui/dom';
import { saveFile } from '../view/image';
import type { Editor } from './editor';
import { designPane, type DesignState } from './isadesign';
import { copyIsa, deleteIsa, isaById, isaList, isaUses, putIsa } from './isaops';
import { slug } from './model';

type Tab = 'instrs' | 'design' | 'operands' | 'check';
const FORMAT = 'mosfet2riscv-isa';

/** The colour role of an operand letter (the CPU drawer's field colours). */
function role(doc: IsaDoc, ch: string): string {
  if (ch === '0' || ch === '1') return 'k';
  if (ch === '-') return 'x';
  const d = doc.operands[ch];
  return !d ? 'bad' : d.kind === 'reg' ? 'reg' : d.kind === 'enum' ? 'cond' : 'imm';
}

/** A pattern drawn bit by bit (a gap every 4 bits), coloured by what each bit is. */
export function patternBits(doc: IsaDoc, pattern: string): HTMLElement {
  const p = pattern.replace(/\s+/g, '');
  return h('span', { class: 'isa-bits', 'aria-hidden': 'true' }, [...p].map((ch, i) =>
    h('i', { class: `${role(doc, ch)}${i && (p.length - i) % 4 === 0 ? ' gap' : ''}` }, ch)));
}

/** A word's bits, coloured by the fields of the instruction it is. */
function wordBits(doc: IsaDoc, w: number): HTMLElement {
  const t = tableOf(doc), c = t.match(w);
  const p = c ? c.def.pattern.replace(/\s+/g, '') : '-'.repeat(doc.wordBits);
  return h('span', { class: 'isa-bits' }, [...p].map((ch, i) =>
    h('i', { class: `${role(doc, ch)}${i && (p.length - i) % 4 === 0 ? ' gap' : ''}` }, String((w >>> (doc.wordBits - 1 - i)) & 1))));
}

/** Register names as typed: "R0, R1, …" or a range "R0–R15" (also R0-R15). */
function parseNames(text: string): string[] {
  const m = text.trim().match(/^([A-Za-z_.]*)(\d+)\s*[-–]\s*\1(\d+)$/);
  if (m) {
    const a = Number(m[2]), b = Number(m[3]);
    if (b >= a && b - a < 256) return Array.from({ length: b - a + 1 }, (_, i) => `${m[1]}${a + i}`);
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}
function showNames(names: string[]): string {
  const m = names[0]?.match(/^([A-Za-z_.]*)(\d+)$/);
  if (m && names.length > 2 && names.every((n, i) => n === `${m[1]}${Number(m[2]) + i}`)) return `${names[0]}–${names[names.length - 1]}`;
  return names.join(', ');
}
const parseEnum = (text: string): Record<string, number> => Object.fromEntries(text.split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
  const m = s.match(/^([A-Za-z_.][\w.]*)\s*=\s*(\S+)$/);
  const v = m ? Number(m[2]) : NaN;
  return m && Number.isInteger(v) && v >= 0 ? [[m[1], v]] : [];
}));
const showEnum = (names: Record<string, number>) => Object.entries(names).map(([k, v]) => `${k}=${v}`).join(', ');

let open: HTMLElement | null = null;

/** Open the ISA editor on the table `id` (else the first one). */
export function openIsaEditor(ed: Editor, id?: string): void {
  open?.remove();
  let sel = id ?? isaList(ed.ws)[0]?.id ?? Object.keys(ISA_PRESETS)[0];
  let tab: Tab = 'instrs';
  let tryText = '';
  const design: DesignState = { row: 0, brush: '1' };

  const list = h('div', { class: 'isa-side' });
  const main = h('div', { class: 'isa-main' });
  const close = () => {
    ov.remove();
    open = null;
    ed.view.svg.focus?.();
  };
  /** The table's decoder in gates as a new chip (one undo step), opened; the dialog closes. */
  const openDecoder = (doc: IsaDoc) => void Promise.all([import('../lib/isadecoder'), import('./remix')]).then(([{ isaDecoder }, { remixDef }]) => {
    let err = '';
    ed.editWs((ws) => {
      const r = remixDef(ws, isaDecoder(doc));
      if ('error' in r) { err = r.error; return ws; }
      return r.ws;
    });
    if (err) return void ed.toast(`The decoder could not be built: ${err}`, 'err');
    close();
    ed.toast(`Opened the ${doc.name} decoder: a match line per instruction (Ctrl+Z removes it)`);
  });
  const ov = h('div', { class: 'sb-help isa-dlg', role: 'dialog', 'aria-label': 'Instruction sets' },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, icon('code', 16), 'Instruction sets'),
        h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close', 16))),
      h('div', { class: 'isa-body' }, list, main)));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !(e.target as HTMLElement).matches('input, select, textarea')) close();
  });
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });

  const current = (): { doc: IsaDoc; preset: boolean } | null => {
    const preset = ISA_PRESETS[sel];
    if (preset) return { doc: preset, preset: true };
    const doc = isaById(ed.ws, sel);
    return doc ? { doc, preset: false } : null;
  };
  /** Commit an edited table (one undo step), then redraw. */
  const commit = (doc: IsaDoc) => {
    ed.editWs((ws) => putIsa(ws, doc));
    render();
  };
  const copyOf = (from: IsaDoc, name?: string) => {
    let made = '';
    ed.editWs((ws) => {
      const c = copyIsa(ws, from, name);
      made = c.id;
      return c.ws;
    });
    sel = made;
    render();
  };

  const renderList = () => {
    const mine = isaList(ed.ws);
    const item = (d: IsaDoc, preset: boolean) => h('button', {
      class: `isa-item${d.id === sel ? ' on' : ''}`, onclick: () => { sel = d.id; tryText = ''; design.row = 0; render(); },
    }, h('span', null, d.name), h('small', null, `${preset ? 'preset · read-only · ' : ''}${d.wordBits}-bit words · ${d.instrs.length} instructions`));
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files?.[0];
      if (!f) return;
      let raw: unknown;
      try { raw = JSON.parse(await f.text()); } catch { return void ed.toast('Not a JSON file', 'err'); }
      const doc = sanitizeIsa((raw as { isa?: unknown })?.isa ?? raw);
      if (!doc) return void ed.toast('No instruction set in that file', 'err');
      copyOf(doc, doc.name);
      ed.toast(`Imported ${doc.name}`);
    });
    list.replaceChildren(
      h('div', { class: 'isa-group' }, 'Presets'), ...Object.values(ISA_PRESETS).map((d) => item(d, true)),
      h('div', { class: 'isa-group' }, 'This sandbox'),
      ...(mine.length ? mine.map((d) => item(d, false)) : [h('p', { class: 'sb-sum' }, 'None yet: copy a preset, or start a new one.')]),
      h('div', { class: 'isa-side-btns' },
        h('button', { class: 'btn sm', title: 'A copy of the 4-bit preset, to change', onclick: () => copyOf(Object.values(ISA_PRESETS)[0], 'My instruction set') }, icon('plus', 13), 'New'),
        h('button', { class: 'btn sm', title: 'Import an instruction set from a .json file', onclick: () => fileIn.click() }, 'Import…'),
        fileIn));
  };

  const renderMain = () => {
    const cur = current();
    if (!cur) return void main.replaceChildren(h('p', { class: 'sb-sum' }, 'Pick an instruction set on the left.'));
    const { doc, preset } = cur;
    const t = tableOf(doc);
    const uses = preset ? [] : isaUses(ed.ws, doc.id);
    const ro = preset ? { disabled: true } : {};
    const name = h('input', { class: 'isa-name', value: doc.name, 'aria-label': 'Name', ...ro }) as HTMLInputElement;
    name.addEventListener('change', () => name.value.trim() && commit({ ...doc, name: name.value.trim() }));
    const width = h('select', { 'aria-label': 'Word width', ...ro }, [8, 16, 32].map((w) => h('option', { value: String(w), selected: doc.wordBits === w }, `${w}-bit words`))) as HTMLSelectElement;
    width.addEventListener('change', () => commit({ ...doc, wordBits: Number(width.value) as 8 | 16 | 32 }));
    const head = h('div', { class: 'isa-head' }, name, width,
      h('span', { class: 'sb-sum' }, preset ? 'A preset: copy it to make changes.' : uses.length ? `used by ${uses.length} ROM${uses.length > 1 ? 's' : ''} (${uses.map((u) => u.part).join(', ')})` : 'not used by a ROM yet'),
      h('span', { class: 'isa-head-btns' },
        h('button', { class: 'btn sm', onclick: () => copyOf(doc) }, preset ? 'Copy to edit' : 'Duplicate'),
        h('button', { class: 'btn sm', title: 'Save as a .json file', onclick: () => saveFile(`${slug(doc.name)}.isa.json`, JSON.stringify({ format: FORMAT, isa: doc }, null, 2)) }, 'Export'),
        preset ? null : h('button', {
          class: 'btn sm', title: uses.length ? 'Remove it from the list (the ROMs that use it keep their copy)' : 'Delete it',
          onclick: () => { ed.editWs((ws) => deleteIsa(ws, doc.id)); sel = isaList(ed.ws)[0]?.id ?? Object.keys(ISA_PRESETS)[0]; render(); },
        }, 'Delete')));
    const probs = t.problems;
    const tabs = h('div', { class: 'isa-tabs', role: 'tablist' }, ([['instrs', `Instructions (${doc.instrs.length})`], ['design', 'Design'], ['operands', `Operands (${Object.keys(doc.operands).length})`], ['check', probs.length ? `Check (${probs.length})` : 'Check ✓']] as [Tab, string][])
      .map(([k, label]) => h('button', { role: 'tab', class: `${tab === k ? 'on' : ''}${k === 'check' && probs.length ? ' warn' : ''}`, 'aria-selected': String(tab === k), onclick: () => { tab = k; render(); } }, label)));
    main.replaceChildren(head, tabs, tab === 'instrs' ? instrsTab(doc, preset) : tab === 'design' ? designPane(doc, preset, design, commit, render, patternBits, () => openDecoder(doc)) : tab === 'operands' ? operandsTab(doc, preset) : checkTab(doc));
  };

  const instrsTab = (doc: IsaDoc, preset: boolean): HTMLElement => {
    const t = tableOf(doc);
    const rowProblems = (i: number) => t.problems.filter((p) => p.instr === i).map((p) => p.message);
    const setRow = (i: number, patch: Partial<InstrDef>) => commit({ ...doc, instrs: doc.instrs.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
    const ro = preset ? { disabled: true } : {};
    const rows = doc.instrs.map((r, i) => {
      const mn = h('input', { class: 'mn', value: r.mnemonic, 'aria-label': `Mnemonic ${i + 1}`, ...ro }) as HTMLInputElement;
      mn.addEventListener('change', () => setRow(i, { mnemonic: mn.value.trim() }));
      const ops = h('input', { class: 'ops', value: r.operands.join(', '), placeholder: '—', 'aria-label': `Operands of ${r.mnemonic}`, ...ro }) as HTMLInputElement;
      ops.addEventListener('change', () => setRow(i, { operands: ops.value.split(',').map((s) => s.trim()).filter(Boolean) }));
      const pat = h('input', { class: 'pat', value: r.pattern, spellcheck: false, 'aria-label': `Encoding of ${r.mnemonic}`, ...ro }) as HTMLInputElement;
      pat.addEventListener('change', () => setRow(i, { pattern: pat.value }));
      const sum = h('input', { class: 'sum', value: r.summary ?? '', placeholder: 'what it does', 'aria-label': `Summary of ${r.mnemonic}`, ...ro }) as HTMLInputElement;
      sum.addEventListener('change', () => setRow(i, { summary: sum.value.trim() || undefined }));
      const bad = rowProblems(i);
      return h('tr', { class: bad.length ? 'bad' : '' },
        h('td', null, mn), h('td', null, ops),
        h('td', null, preset ? null : pat, patternBits(doc, r.pattern), ...bad.map((m) => h('div', { class: 'isa-prob' }, m))),
        h('td', null, sum),
        h('td', null, preset ? null : h('button', { class: 'btn ghost icon-only sm', title: 'Delete this instruction', 'aria-label': `Delete ${r.mnemonic}`, onclick: () => commit({ ...doc, instrs: doc.instrs.filter((_, k) => k !== i) }) }, icon('close', 13))));
    });
    return h('div', { class: 'isa-pane' },
      h('p', { class: 'sb-sum' }, 'Encoding, bit ', String(doc.wordBits - 1), ' first: ', h('code', null, '0'), ' / ', h('code', null, '1'), ' fixed bits, ', h('code', null, '-'),
        ' ignored (assembled as 0), a letter: that operand’s bits, most significant first (it may be split). The most specific pattern wins when several match.'),
      h('div', { class: 'tablewrap isa-table' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Mnemonic'), h('th', null, 'Operands'), h('th', null, 'Encoding'), h('th', null, 'Summary'), h('th', null, ''))),
        h('tbody', null, rows))),
      preset ? null : h('div', { class: 'sb-btns' }, h('button', {
        class: 'btn sm', onclick: () => commit({ ...doc, instrs: [...doc.instrs, { mnemonic: 'NEW', operands: [], pattern: '-'.repeat(doc.wordBits) }] }),
      }, icon('plus', 13), 'Add an instruction')));
  };

  const operandsTab = (doc: IsaDoc, preset: boolean): HTMLElement => {
    const ro = preset ? { disabled: true } : {};
    const setOp = (l: string, d: OperandDef) => commit({ ...doc, operands: { ...doc.operands, [l]: d } });
    const cards = Object.entries(doc.operands).sort(([a], [b]) => a.localeCompare(b)).map(([l, d]) => {
      const kind = h('select', { 'aria-label': `Kind of ${l}`, ...ro }, [['reg', 'register'], ['enum', 'name or number'], ['imm', 'immediate'], ['addr', 'address (label)']]
        .map(([k, label]) => h('option', { value: k, selected: d.kind === k }, label))) as HTMLSelectElement;
      kind.addEventListener('change', () => setOp(l, kind.value === 'reg' ? { kind: 'reg', names: ['R0', 'R1', 'R2', 'R3'] } : kind.value === 'enum' ? { kind: 'enum', names: {}, number: true } : kind.value === 'imm' ? { kind: 'imm' } : { kind: 'addr' }));
      const check = (label: string, on: boolean, f: (v: boolean) => void, title?: string) => {
        const c = h('input', { type: 'checkbox', checked: on, ...ro }) as HTMLInputElement;
        c.addEventListener('change', () => f(c.checked));
        return h('label', { class: 'isa-check', title }, c, label);
      };
      let body: (HTMLElement | null)[] = [];
      if (d.kind === 'reg') {
        const names = h('input', { value: showNames(d.names), 'aria-label': `Register names of ${l}`, ...ro }) as HTMLInputElement;
        names.addEventListener('change', () => { const n = parseNames(names.value); if (n.length) setOp(l, { kind: 'reg', names: n }); });
        body = [names, h('small', null, `${d.names.length} names, encoded 0–${d.names.length - 1}: “R0, R1, …” or a range “R0–R15”`)];
      } else if (d.kind === 'enum') {
        const names = h('input', { value: showEnum(d.names), placeholder: 'NAME=value, …', 'aria-label': `Names of ${l}`, ...ro }) as HTMLInputElement;
        names.addEventListener('change', () => setOp(l, { ...d, names: parseEnum(names.value) }));
        body = [names, check('a plain number too', !!d.number, (v) => setOp(l, { ...d, number: v || undefined }))];
      } else if (d.kind === 'imm') {
        body = [h('div', { class: 'isa-checks' }, check('signed', !!d.signed, (v) => setOp(l, { ...d, signed: v || undefined }), 'two’s complement: the range is symmetric around 0'),
          check('shown in hex', !!d.hex, (v) => setOp(l, { ...d, hex: v || undefined })))];
      } else {
        const scale = h('input', { type: 'number', min: '1', max: '16', value: String(d.scale ?? 1), class: 'isa-scale', 'aria-label': `Scale of ${l}`, ...ro }) as HTMLInputElement;
        scale.addEventListener('change', () => { const s = Number(scale.value); if (Number.isInteger(s) && s >= 1 && s <= 16) setOp(l, { ...d, scale: s === 1 ? undefined : s }); });
        body = [h('div', { class: 'isa-checks' }, check('relative to the instruction', !!d.rel, (v) => setOp(l, { ...d, rel: v || undefined }), 'encoded as target − address, signed'),
          d.rel ? h('label', { class: 'isa-check' }, 'in units of ', scale) : null)];
      }
      const used = doc.instrs.filter((r) => r.operands.includes(l)).length;
      return h('div', { class: 'isa-op' },
        h('div', { class: 'isa-op-head' }, h('span', { class: `isa-letter ${role(doc, l)}` }, l), kind,
          h('small', null, `in ${used} instruction${used === 1 ? '' : 's'}`),
          preset ? null : h('button', { class: 'btn ghost icon-only sm', title: used ? 'Used by instructions: remove it there first' : 'Delete this operand', disabled: used > 0, 'aria-label': `Delete operand ${l}`, onclick: () => { const { [l]: _x, ...rest } = doc.operands; commit({ ...doc, operands: rest }); } }, icon('close', 13))),
        ...body);
    });
    const free = 'abcdefghijklmnopqrstuvwxyz'.split('').find((c) => !doc.operands[c]);
    return h('div', { class: 'isa-pane' },
      h('p', { class: 'sb-sum' }, 'Each letter of an encoding is one operand. Its kind says how it is written and checked: a register name, a name from a list (or a number), an immediate (its range from the number of bits), or an address (a label or a number; relative: the distance from the instruction).'),
      h('div', { class: 'isa-ops' }, cards),
      preset || !free ? null : h('div', { class: 'sb-btns' }, h('button', { class: 'btn sm', onclick: () => setOp(free, { kind: 'imm' }) }, icon('plus', 13), `Add operand ${free}`)));
  };

  const checkTab = (doc: IsaDoc): HTMLElement => {
    const t = tableOf(doc);
    const W = doc.wordBits;
    let coverage: string;
    if (W <= 16) {
      let n = 0;
      for (let w = 0; w < 2 ** W; w++) if (t.match(w)) n++;
      coverage = `${n.toLocaleString('en')} of ${(2 ** W).toLocaleString('en')} words are instructions; the rest disassemble as .word.`;
    } else coverage = `${W}-bit words: too many to count here.`;
    const out = h('div', { class: 'isa-try-out' });
    const input = h('input', { class: 'isa-try', value: tryText, placeholder: doc.instrs[0] ? `${doc.instrs[0].mnemonic} …` : 'an instruction', spellcheck: false, 'aria-label': 'Try a line' }) as HTMLInputElement;
    const run = () => {
      tryText = input.value;
      if (!tryText.trim()) return void out.replaceChildren();
      // Labels the line names are taken as address 0, so a jump can be tried alone.
      const real = t.assemble(tryText);
      const names = tryText.match(/[A-Za-z_.$][\w.$]*/g) ?? [];
      const res = real.errors.some((e) => /unknown label/.test(e.message)) ? t.assemble(`${names.map((w) => `${w}:`).join(' ')}\n${tryText}`) : real;
      if (res.errors.length || res.words[0] === undefined) return void out.replaceChildren(h('span', { class: 'isa-prob' }, res.errors[0]?.message ?? 'nothing to assemble'));
      const w = res.words[0];
      out.replaceChildren(wordBits(doc, w), h('code', null, `0x${(w >>> 0).toString(16).toUpperCase().padStart(W / 4, '0')}`), h('span', { class: 'sb-sum' }, `→ ${t.disasm(w)}`));
    };
    input.addEventListener('input', run);
    run();
    return h('div', { class: 'isa-pane' },
      t.problems.length ? h('div', { class: 'isa-probs' }, h('b', null, `${t.problems.length} problem${t.problems.length > 1 ? 's' : ''}`), t.problems.map((p) => h('div', { class: 'isa-prob' }, p.message)))
        : h('p', { class: 'isa-ok' }, '✓ Every pattern is complete and every word decodes to at most one instruction.'),
      h('p', { class: 'sb-sum' }, coverage),
      h('div', { class: 'isa-tryline' }, h('span', null, 'Try a line'), input, out));
  };

  const render = () => {
    if (!current()) sel = isaList(ed.ws)[0]?.id ?? Object.keys(ISA_PRESETS)[0];
    renderList();
    renderMain();
  };
  open = ov;
  ed.el.append(ov);
  render();
}
