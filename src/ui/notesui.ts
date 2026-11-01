// The notes' controls on a page: the Save (bookmark) toggle, and a place's notes as yellow cards with their markers on the
// stage (ui/notes.ts is the store). Used by the chapter page; the workbench and the sandbox use bookmarkButton.

import type { NotePin } from '../view/schematic';
import type { Stage } from '../view/stage';
import { h, icon } from './dom';
import { type NoteItem, notes, type NotePin as Pin, type Place, takeOpenNote } from './notes';

const bookmarkIcon = (on: boolean) => icon(on ? 'bookmarkOn' : 'bookmark', 15);

/** A toggle for saving `place`; `title` words it for the notes page. Follows the store while it is on the page. */
export function bookmarkButton(place: Place, title: () => string, cls = 'btn sm toggle note-save'): HTMLButtonElement {
  const store = notes();
  const b = h('button', { class: cls, type: 'button' }) as HTMLButtonElement;
  const sync = () => {
    const on = store.isBookmarked(place);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Saved in My notes: click to remove' : 'Save this place in My notes';
    b.setAttribute('aria-label', on ? 'Saved: remove bookmark' : 'Bookmark this place');
    b.replaceChildren(bookmarkIcon(on), h('span', { class: 'lbl' }, on ? 'Saved' : 'Save'));
  };
  b.addEventListener('click', () => { store.toggleBookmark(place, title()); });
  const off = store.onChange(() => {
    if (!b.isConnected) return off();
    sync();
  });
  sync();
  return b;
}

const pinWords = (pin: Pin): string => {
  const where = pin.inst ? `the part ${pin.inst}` : 'this level';
  const ins = Object.entries(pin.inputs ?? {}).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ');
  return `Pinned to ${where}${pin.path.length ? ` in ${pin.path.join(' / ')}` : ''}${pin.cycle ? ` · cycle ${pin.cycle}` : ''}${ins ? ` · ${ins}` : ''}`;
};

/** A chapter step's notes: cards in the narrative, numbered markers on the stage for the ones pinned to a part. */
export class StepNotes {
  readonly el = h('section', { class: 'step-notes', 'aria-label': 'Your notes' });
  private cards = new Map<string, HTMLElement>();
  /** Our own edit is under way: do not redraw the card being typed in. */
  private typing = false;
  private off: () => void;

  constructor(private stage: Stage | null, private place: Place, private title: () => string) {
    this.off = notes().onChange(() => {
      if (this.typing) return;
      this.render();
    });
    this.render();
  }

  private items(): NoteItem[] {
    return notes().notesAt(this.place);
  }

  /** The stage's markers on the level at `path`. */
  marks = (path: string[]): NotePin[] => this.items().flatMap((it, k) => {
    const p = it.pin;
    if (!p?.inst || p.path.length !== path.length || p.path.some((x, i) => x !== path[i])) return [];
    return [{ inst: p.inst, n: k + 1, title: `Note ${k + 1}: ${it.text.slice(0, 60) || '(empty)'}`, open: () => this.focus(it.id) }];
  });

  /** A new note, pinned to the part selected on the stage (or the level opened, when it is not the top). */
  add(): void {
    const st = this.stage;
    let pin: Pin | undefined;
    if (st?.scene) {
      const sel = st.selectedInst;
      if (sel || st.path.length) pin = { path: st.path, ...(sel ? { inst: sel } : {}), ...st.sceneState };
    }
    const it = notes().add(this.place, this.title(), '', pin);
    this.focus(it.id);
  }

  focus(id: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector('textarea')?.focus();
  }

  /** A note waiting from the notes page: show its part and put the inputs back. */
  openPending(): void {
    const it = takeOpenNote(this.place);
    if (!it) return;
    if (it.pin && this.stage?.scene) this.stage.showPin(it.pin);
    this.focus(it.id);
  }

  private render(): void {
    const items = this.items();
    this.cards.clear();
    this.el.replaceChildren(...items.map((it, k) => this.card(it, k + 1)));
    this.el.hidden = !items.length;
    this.stage?.updateNoteMarks();
  }

  private card(it: NoteItem, n: number): HTMLElement {
    const store = notes();
    const id = `note-${it.id}`;
    const ta = h('textarea', { id, rows: 3, 'aria-label': `Note ${n}`, maxlength: 4000, placeholder: 'Your note' }) as HTMLTextAreaElement;
    ta.value = it.text;
    ta.addEventListener('input', () => {
      this.typing = true;
      try { store.update(it.id, { text: ta.value }); } finally { this.typing = false; }
    });
    // a note left empty goes away; a pinned one's marker too
    ta.addEventListener('blur', () => {
      if (!ta.value.trim()) store.remove(it.id);
    });
    const foot = h('div', { class: 'note-foot' });
    const cur = store.get(it.id) ?? it;
    if (cur.pin) {
      foot.append(
        h('span', { class: 'note-pin-text' }, pinWords(cur.pin)),
        ...(this.stage?.scene ? [h('button', { class: 'note-btn', type: 'button', onclick: () => this.stage!.showPin(cur.pin!) }, 'Show')] : []),
        h('button', { class: 'note-btn', type: 'button', onclick: () => store.update(it.id, { pin: null }) }, 'Unpin'),
      );
    } else if (this.stage?.scene) {
      foot.append(h('span', { class: 'note-pin-text' }, 'Not pinned to the circuit'), h('button', {
        class: 'note-btn', type: 'button', title: 'Pin to the part selected on the stage, with the inputs and cycle as they are now',
        onclick: () => {
          const st = this.stage!;
          const sel = st.selectedInst;
          store.update(it.id, { pin: { path: st.path, ...(sel ? { inst: sel } : {}), ...st.sceneState } });
        },
      }, 'Pin here'));
    }
    foot.append(h('button', { class: 'note-btn', type: 'button', onclick: () => store.remove(it.id) }, 'Delete'));
    const card = h('div', { class: 'note-card', 'data-note': it.id },
      h('label', { class: 'note-k', for: id }, h('span', { class: 'note-no' }, String(n)), 'Your note', h('small', null, ' · only on this device, in the backup file')),
      ta, foot);
    this.cards.set(it.id, card);
    return card;
  }

  destroy(): void {
    this.off();
    if (this.stage) this.stage.noteMarks = null;
  }
}
