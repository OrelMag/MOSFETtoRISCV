// The library parts that are drawn as state machines too: library id → its spec (lib/fsm.ts). The
// codex draws the diagram for an entry whose figure is one of these; tests/fsm.test.ts reads every one
// back from its circuit.

import type { FsmSpec } from './fsm';
import { MC_FSM_SPEC } from './multicycle';
import { DET101_FSM } from './rv16/logic';

export const FSMS: Record<string, FsmSpec> = {
  mc_fsm: MC_FSM_SPEC,
  mc_micro: MC_FSM_SPEC,
  rv16_det101: DET101_FSM,
};

export const fsmOf = (libId: string | undefined): FsmSpec | undefined => (libId ? FSMS[libId] : undefined);
