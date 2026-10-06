// The Sandbox page (#/sandbox[/<chipId>], #/sandbox/s/<payload> for a share link): a
// Digital-Logic-Sim-style editor where the learner builds chips from transistors and gates up.
// Loaded on demand (app.ts imports it dynamically), so the editor stays out of the main bundle.

import '../../styles/editor.css';
import { Editor } from '../../editor/editor';
import { SHARE_SEG, shareRoute } from '../../editor/files';
import { installFiles, type FilesUi } from '../../editor/fileui';
import type { Page } from './chapter';

export class SandboxPage implements Page {
  readonly kind = 'sandbox';
  readonly el: HTMLElement;
  readonly editor: Editor;
  private files: FilesUi;

  constructor(chipId?: string) {
    const share = chipId === SHARE_SEG;
    this.editor = new Editor(share ? undefined : chipId);
    this.el = this.editor.el;
    this.files = installFiles(this.editor);
    if (share) this.files.openShare(shareRoute(location.hash));
  }

  /** The hash changed to another chip (#/sandbox/<id>) or to a share link. */
  open(chipId?: string): void {
    if (chipId === SHARE_SEG) return this.files.openShare(shareRoute(location.hash));
    if (chipId && chipId !== this.editor.chipId) this.editor.openChip(chipId);
  }

  destroy(): void {
    this.files.destroy();
    this.editor.destroy();
  }
}
