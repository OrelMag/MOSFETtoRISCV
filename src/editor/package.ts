// "Package as chip…": the Digital-Logic-Sim moment. Every circuit in the sandbox already is a
// chip (its pins are its ports); packaging names it, gives it a colour and notes, and shows the
// box it will be when placed, with its pins in order. "Save & new circuit" then starts the next
// one, the packaged chip waiting in the palette under My chips.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { h, icon, s } from '../ui/dom';
import { drawSymbol } from '../view/symbols';
import { pinOrder, relations } from './chips';
import { type Editor, registerToolbarAction } from './editor';
import type { ChipDoc, PinDoc } from './model';

/** Hues offered as swatches (any other is a slider away). */
const HUES = [250, 210, 180, 150, 100, 45, 20, 330];

/** The compiled def as it will look with this name and hue (the preview only). */
function previewDef(def: ComponentDef, name: string, hue: number): ComponentDef {
  return { ...def, name, symbol: { ...def.symbol, label: name, color: hue } };
}

/** The packaged symbol, with a short stub at each port, sized to fit. */
export function symbolPreview(def: ComponentDef): SVGSVGElement {
  const g = symbolGeom(def);
  const svg = s('svg', { class: 'schematic sb-pack-svg', viewBox: `${-3} ${-1.5} ${g.w + 6} ${g.h + 3}`, role: 'img', 'aria-label': `${def.name} symbol` });
  for (const [, p] of Object.entries(g.ports)) {
    const [x, y] = p.pos;
    const d = p.exit === 'left' ? [-1.6, 0] : p.exit === 'right' ? [1.6, 0] : p.exit === 'up' ? [0, -1.2] : [0, 1.2];
    svg.append(s('path', { d: `M${x},${y} l${d[0]},${d[1]}`, class: 'wire sb-pack-stub' }));
  }
  svg.append(drawSymbol(def));
  return svg;
}

export function packageDialog(ed: Editor): void {
  ed.el.querySelector('.sb-pack')?.remove();
  const doc = ed.doc;
  const def = ed.compiled.def;
  let hue = doc.hue ?? 250;
  const name = h('input', { type: 'text', value: doc.name, spellcheck: 'false', 'aria-label': 'Chip name', maxlength: '40' }) as HTMLInputElement;
  const notes = h('textarea', { rows: '3', placeholder: 'What it does, how to use it…', 'aria-label': 'Notes' }, doc.notes ?? '') as HTMLTextAreaElement;
  const range = h('input', { type: 'range', min: '0', max: '359', value: String(hue), 'aria-label': 'Colour (hue)' }) as HTMLInputElement;
  const swatches = h('div', { class: 'sb-swatches', role: 'radiogroup', 'aria-label': 'Colour' });
  const preview = h('div', { class: 'sb-pack-preview' });
  const warn = h('div', { class: 'sb-pack-warn' });

  const paint = () => {
    const nm = name.value.trim() || doc.name;
    preview.replaceChildren(symbolPreview(previewDef(def, nm, hue)));
    for (const b of swatches.children) b.classList.toggle('on', Number((b as HTMLElement).dataset.hue) === hue);
    const w: string[] = [];
    if (!doc.pins.length) w.push('No pins yet: a chip talks to its parent only through its input and output pins.');
    const errs = ed.diags.filter((d) => d.level === 'error').length;
    if (errs) w.push(`${errs} problem${errs > 1 ? 's' : ''} in this circuit: chips that place it will show ${errs > 1 ? 'them' : 'it'} too.`);
    if (Object.values(ed.ws.chips).some((c) => c.id !== doc.id && c.name === nm)) w.push(`Another chip is already called “${nm}”.`);
    warn.replaceChildren(...w.map((t) => h('p', null, t)));
  };
  for (const v of HUES) {
    swatches.append(h('button', { class: 'sb-swatch', style: `--chip-h:${v}`, 'data-hue': String(v), role: 'radio', title: `Hue ${v}`, 'aria-label': `Hue ${v}`,
      onclick: () => { hue = v; range.value = String(v); paint(); } }));
  }
  range.addEventListener('input', () => { hue = Number(range.value); paint(); });
  name.addEventListener('input', paint);

  const { left, right } = pinOrder(doc);
  const pinList = (title: string, ps: PinDoc[]) => h('div', { class: 'sb-pack-col' }, h('b', null, title),
    ps.length ? h('ol', null, ps.map((p) => h('li', null, h('span', { class: `sb-dir ${p.dir}` }, p.dir), ` ${p.name}`, p.width > 1 ? h('small', null, ` [${p.width - 1}:0]`) : null)))
      : h('p', { class: 'sb-sum' }, 'none'));
  const { usedBy } = relations(ed.ws, doc.id);

  const commit = (): boolean => {
    const nm = name.value.trim();
    if (!nm) {
      name.focus();
      return false;
    }
    const nt = notes.value.trim();
    ed.edit((d): ChipDoc => {
      if (d.name === nm && d.hue === hue && (d.notes ?? '') === nt) return d;
      const n: ChipDoc = { ...d, name: nm, hue };
      if (nt) n.notes = nt;
      else delete n.notes;
      return n;
    });
    return true;
  };
  const close = () => {
    ov.remove();
    ed.view.svg.focus({ preventScroll: true });
  };
  const save = (fresh: boolean) => {
    if (!commit()) return;
    const nm = ed.doc.name;
    close();
    if (fresh) {
      ed.newChip();
      ed.toast(`“${nm}” is under My chips: drag it in`);
    } else ed.toast(`Packaged “${nm}”${usedBy.length ? `: ${usedBy.length} chip${usedBy.length > 1 ? 's' : ''} using it follow` : ': find it under My chips'}`);
  };

  const ov = h('div', { class: 'sb-help sb-pack', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Package as chip', onclick: (e: Event) => { if (e.target === ov) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, 'Package as chip'), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
      h('p', { class: 'sb-sum' }, 'Placed in another chip, this circuit becomes the box below: only its pins show. It stays editable: change the inside later and every chip that uses it follows.'),
      h('div', { class: 'sb-pack-grid' },
        h('div', { class: 'sb-pack-form' },
          h('label', { class: 'sb-row' }, h('span', null, 'Name'), name),
          h('div', { class: 'sb-row' }, h('span', null, 'Colour'), h('div', null, swatches, range)),
          h('label', { class: 'sb-row' }, h('span', null, 'Notes'), notes)),
        h('div', { class: 'sb-pack-side' }, preview,
          h('div', { class: 'sb-pack-pins' }, pinList('Left (inputs)', left), pinList('Right (outputs)', right)),
          h('p', { class: 'sb-sum' }, 'Pins keep their order from top to bottom in the circuit: move a pin up or down to reorder it on the box.'))),
      warn,
      h('div', { class: 'sb-btns sb-pack-btns' },
        h('button', { class: 'btn sm ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'btn sm', title: 'Save and keep editing it', onclick: () => save(false) }, icon('check', 14), 'Save'),
        h('button', { class: 'btn sm primary', title: 'Save, then start a new empty circuit (the packaged chip is in the palette)', onclick: () => save(true) }, icon('plus', 14), 'Save & new circuit'))));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') save(false);
  });
  ed.el.append(ov);
  paint();
  name.focus();
  name.select();
}

registerToolbarAction({
  id: 'package', title: 'Package as chip… (name, colour, pins)', icon: 'chip', label: 'Package', order: 60,
  run: (ed) => packageDialog(ed),
});
