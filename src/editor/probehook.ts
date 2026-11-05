// The right-click menu's probe row, reached without importing analysis.ts: that plugin registers toolbar actions when it
// loads, and editor.ts imports look inside (inside.ts) before it can take them. analysis.ts sets the hook when it loads.

import type { Editor } from './editor';
import type { ProbeTarget } from './probes';

export type ProbeRow = { label: string; run(): void } | string;

let hook: ((ed: Editor, t: ProbeTarget) => ProbeRow) | null = null;

export function setProbeRow(f: (ed: Editor, t: ProbeTarget) => ProbeRow): void {
  hook = f;
}

/** Add or remove a probe of this target, or why not here. */
export const probeRow = (ed: Editor, t: ProbeTarget): ProbeRow => hook?.(ed, t) ?? 'The Timing panel is not available here.';
