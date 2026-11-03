// The coherent dual-core opened in the sandbox ("Open in Sandbox"): it is a multi-core chip, but its cores wait on
// caches, so the plain multi-hart model of the shared-memory dual-core does not apply.
import { describe, expect, it } from 'vitest';
import { detectCpu } from '../src/editor/cpu';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { detectMulti } from '../src/editor/multicpu';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { coherentDualCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { COH_PROGRAMS } from '../src/riscv/cohprograms';

describe('coherent dual-core in the sandbox', { timeout: 120000 }, () => {
  it('opens and runs, and is not mistaken for the shared-memory dual-core', () => {
    const w = assemble(COH_PROGRAMS.find((p) => p.id === 'atomic')!.source).words;
    const r = remixDef(emptyWorkspace(), coherentDualCore(w));
    if ('error' in r) throw new Error(r.error);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(new UserLibrary(r.ws).compiled(r.id)!, r.ws.chips[r.id].pins);
    
    expect(detectCpu(r.ws.chips[r.id], r.ws.chips)).toBeNull();
    expect(detectMulti(r.ws.chips[r.id], r.ws.chips)).toBeNull();
  });
});
