// The Sandbox page (#/sandbox[/<chipId>]): a Digital-Logic-Sim-style editor where the learner
// builds chips from transistors and gates up. Loaded on demand (app.ts imports it dynamically),
// so the editor stays out of the main bundle.

import '../../styles/editor.css';
import { Editor } from '../../editor/editor';
import '../../editor/memui';
import type { Page } from './chapter';

export class SandboxPage implements Page {
  readonly kind = 'sandbox';
  readonly el: HTMLElement;
  readonly editor: Editor;

  constructor(chipId?: string) {
    this.editor = new Editor(chipId);
    this.el = this.editor.el;
  }

  /** The hash changed to another chip (#/sandbox/<id>). */
  open(chipId?: string): void {
    if (chipId && chipId !== this.editor.chipId) this.editor.openChip(chipId);
  }

  destroy(): void {
    this.editor.destroy();
  }
}
