// Property sections about chips as chips: for the chip being edited, packaging, who uses it and
// what it uses, and the flip-flop marking; for a selected part, looking inside it and
// inspecting it. Registered through registerPropsSection, so props.ts stays the editor of
// single objects.

import { h, icon } from '../ui/dom';
import { guessFf, relations } from './chips';
import type { Editor } from './editor';
import { inspect } from './inspect';
import { canLookInside, lookInside } from './inside';
import type { ChipDoc, PinDoc } from './model';
import { packageDialog } from './package';
import { registerPropsSection } from './props';

const btn = (label: string, title: string, f: () => void, ic?: string) =>
  h('button', { class: 'btn sm', title, onclick: f }, ic ? icon(ic, 14) : null, label);

const nothingSelected = (ed: Editor) => !ed.selCount;

/** Chip names as buttons that open them. */
function chipLinks(ed: Editor, ids: string[], go: (id: string) => void): HTMLElement {
  return h('span', { class: 'sb-rel-list' }, ids.map((id) =>
    h('button', { class: 'sb-chip-btn sb-rel', style: `--chip-h:${ed.ws.chips[id]?.hue ?? 250}`, title: `Open ${ed.ws.chips[id]?.name ?? id}`, onclick: () => go(id) },
      h('span', { class: 'sb-swatch-dot' }), ed.ws.chips[id]?.name ?? id)));
}

registerPropsSection({
  id: 'chip-pack', order: 11,
  render(ed) {
    if (!nothingSelected(ed)) return null;
    const { usedBy, uses } = relations(ed.ws, ed.chipId);
    return h('section', { class: 'sb-sec-props' }, h('h3', null, 'As a chip'),
      h('div', { class: 'sb-btns' },
        btn('Package…', 'Name, colour and notes, with a preview of the box it becomes', () => packageDialog(ed), 'chip'),
        btn('Inspect', 'Info, truth table and Verilog of this chip', () => inspect(ed), 'table')),
      h('div', { class: 'sb-rel-row' }, h('span', null, 'Used by'),
        usedBy.length ? chipLinks(ed, usedBy, (id) => ed.openChip(id)) : h('span', { class: 'sb-sum' }, 'no chip yet')),
      h('div', { class: 'sb-rel-row' }, h('span', null, 'Uses'),
        uses.length ? chipLinks(ed, uses, (id) => ed.editChip(id)) : h('span', { class: 'sb-sum' }, 'none of your chips')));
  },
});

registerPropsSection({
  id: 'chip-ff', order: 12,
  render(ed) {
    if (!nothingSelected(ed)) return null;
    const doc = ed.doc;
    const ff = doc.ff;
    const set = (next: ChipDoc['ff']) => ed.edit((d) => {
      const n = { ...d };
      if (next) n.ff = next;
      else delete n.ff;
      return n;
    });
    const box = h('input', { type: 'checkbox', checked: !!ff }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (!box.checked) return set(undefined);
      const g = guessFf(doc);
      if (!g) {
        box.checked = false;
        return void ed.toast('A flip-flop needs 1-bit d and clk inputs and a 1-bit q output', 'err');
      }
      set(g);
    });
    const out = h('section', { class: 'sb-sec-props' }, h('h3', null, 'Flip-flop'),
      h('label', { class: 'sb-check' }, box, 'This chip is an edge-triggered flip-flop'));
    if (!ff) {
      out.append(h('p', { class: 'sb-sum' }, 'Marked and confirmed by a short clocked test, it becomes a register boundary: static timing stops at it and synthesis export writes it as a process.'));
      return out;
    }
    const ins = doc.pins.filter((p) => p.dir === 'in' && p.width === 1);
    const outs = doc.pins.filter((p) => p.dir === 'out' && p.width === 1);
    const pick = (role: keyof NonNullable<ChipDoc['ff']>, pins: PinDoc[], optional = false) => {
      const cur = ff[role];
      const sel = h('select', { 'aria-label': role },
        optional ? h('option', { value: '', selected: !cur }, '(none)') : null,
        cur && !pins.some((p) => p.name === cur) ? h('option', { value: cur, selected: true }, `${cur} (missing)`) : null,
        pins.map((p) => h('option', { value: p.name, selected: p.name === cur }, p.name))) as HTMLSelectElement;
      sel.addEventListener('change', () => {
        const n = { ...ff, [role]: sel.value } as NonNullable<ChipDoc['ff']>;
        if (!sel.value) delete n.en;
        set(n);
      });
      return h('label', { class: 'sb-row' }, h('span', null, role), sel);
    };
    out.append(pick('d', ins), pick('clk', ins), pick('en', ins, true), pick('q', outs));
    const c = ed.compiled;
    const diag = c?.diags.find((d) => d.msg.startsWith('not an edge-triggered flip-flop'));
    if (c?.def.ff) {
      out.append(h('p', { class: 'sb-verdict ok' }, icon('check', 14),
        `Confirmed: q takes d at the rising edge of ${ff.clk}${ff.en ? ` while ${ff.en} = 1` : ''} and holds otherwise.`));
    } else {
      out.append(h('p', { class: 'sb-verdict err' }, diag ? diag.msg.replace(/^not an edge-triggered flip-flop: /, 'Not confirmed: ') : 'Not confirmed yet (the chip has other problems).'));
    }
    return out;
  },
});

registerPropsSection({
  id: 'part-look', order: 11,
  render(ed) {
    const s = ed.sel;
    if (ed.selCount !== 1 || s.parts?.length !== 1) return null;
    const id = s.parts[0];
    const part = ed.doc.parts.find((p) => p.id === id);
    if (!part) return null;
    const look = canLookInside(ed, id);
    return h('section', { class: 'sb-sec-props' }, h('h3', null, 'Look inside'),
      h('p', { class: 'sb-sum' }, look
        ? `Opens its schematic read-only with live values from this circuit; keep opening parts down to transistors.${'chip' in part.ref ? '' : ' (Double-click does the same.)'}`
        : 'A primitive of the simulator: it has no inside to show.'),
      h('div', { class: 'sb-btns' },
        look ? btn('Look inside', 'Its inside, live', () => lookInside(ed, [id]), 'layers') : null,
        btn('Inspect', 'Info, truth table and Verilog of this part', () => inspect(ed, id), 'table')));
  },
});
