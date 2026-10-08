// Keyboard input for the circuit: key parts (1 while their key is held) and keyboard parts (typed
// keys queue up), both from parts.ts. Keys are read on the document while the sandbox is open,
// like the editor's own shortcuts, and only when the open chip listens. A key some key part
// listens to goes to it, and no longer to a shortcut (a Key bound to F takes F from flip while that
// chip is open); every other plain key goes to the keyboard parts while the circuit runs or while
// Type is on (the toolbar toggle: typing into a paused computer, stepping it by hand). Ctrl / Alt /
// Meta combinations, Escape and typing in a field are left alone. Letting go of the window
// releases every key. A key is released on the simulation that took it, even after a tab switch.

import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { keyCode, normalizeKey } from './parts';
import type { EditorSim } from './runtime';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

class Keys {
  /** Type mode: plain keys reach the keyboard parts even while the circuit is paused. */
  typing = false;
  private held = new Map<string, EditorSim>();
  private hadKeyboard = false;
  private readonly off: (() => void)[] = [];

  constructor(private ed: Editor) {
    const down = (e: KeyboardEvent) => this.down(e);
    const up = (e: KeyboardEvent) => this.up(e);
    const blur = () => this.releaseAll();
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    this.off.push(() => document.removeEventListener('keydown', down, true), () => document.removeEventListener('keyup', up, true),
      () => window.removeEventListener('blur', blur));
    // the Type button is greyed without a keyboard part: redraw the bar when one appears or goes
    this.off.push(ed.onSimChange(() => {
      const has = ed.sim.hasKeyboard;
      if (has !== this.hadKeyboard) { this.hadKeyboard = has; ed.renderActions(); }
    }));
  }

  private down(e: KeyboardEvent): void {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (this.typing) { this.typing = false; this.ed.renderActions(); } return; }
    const sim = this.ed.sim;
    const bind = normalizeKey(e.key);
    if (bind && sim.keyBinds.includes(bind)) {
      if (!e.repeat) { sim.setKey(bind, true); this.held.set(bind, sim); }
      e.preventDefault();
      return;
    }
    if (sim.hasKeyboard && (sim.running || this.typing)) {
      const code = keyCode(e.key);
      if (code === null) return;
      sim.typeKey(code);
      e.preventDefault();
    }
  }

  private up(e: KeyboardEvent): void {
    const bind = normalizeKey(e.key);
    const sim = bind ? this.held.get(bind) : undefined;
    if (!bind || !sim) return;
    this.held.delete(bind);
    sim.setKey(bind, false);
    e.preventDefault();
  }

  private releaseAll(): void {
    for (const [bind, sim] of this.held) sim.setKey(bind, false);
    this.held.clear();
  }

  destroy(): void {
    this.releaseAll();
    this.off.forEach((f) => f());
  }
}

const keys = new WeakMap<Editor, Keys>();

registerEditorPlugin((ed) => {
  const k = new Keys(ed);
  keys.set(ed, k);
  return () => {
    k.destroy();
    keys.delete(ed);
  };
});

registerToolbarAction({
  id: 'type', title: 'Type: plain keys go to the chip\'s Keyboard parts while it is paused too (they always do while it runs); Esc leaves', icon: 'keyboard', label: 'Type', order: 58,
  run: (ed) => {
    const k = keys.get(ed);
    if (!k) return;
    k.typing = !k.typing;
    ed.renderActions();
  },
  enabled: (ed) => ed.sim.hasKeyboard,
  active: (ed) => !!keys.get(ed)?.typing,
});
