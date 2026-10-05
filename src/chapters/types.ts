import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef } from '../sim/types';
import type { Scene, Stage, Widget } from '../view/stage';

export type Challenge =
  | {
      kind: 'reach';
      /** What to achieve, shown to the learner. */
      goal: string;
      check: (stage: Stage) => boolean;
      /** Worked answer, revealed on request. */
      answer: string;
      /** Optional: perform the answer on the live circuit. */
      solve?: (stage: Stage) => void;
    }
  | {
      kind: 'quiz';
      question: string;
      options: string[];
      answer: number;
      explain: string;
    };

export interface StepAction {
  label: string;
  run: (stage: Stage) => void;
}

export interface Step {
  title: string;
  /** HTML. Keep it short; the circuit does the explaining. */
  body: string;
  scene?: () => Scene;
  widget?: () => Widget;
  challenge?: Challenge;
  actions?: StepAction[];
}

export interface Chapter {
  id: string;
  num: number;
  title: string;
  /** One line for cards. */
  blurb: string;
  /** The abstraction level this chapter lives at. */
  level: string;
  steps: Step[];
}

/** Planned chapters, shown greyed out on the map. */
export interface FutureChapter {
  num: number;
  title: string;
  blurb: string;
  level: string;
}

const benchCache = new WeakMap<ComponentDef, ComponentDef>();

/**
 * Wrap a component in a test bench: the component appears as one closed symbol with the
 * scene's pins around it, so the learner sees it as a black box and can open it.
 */
export function bench(def: ComponentDef): ComponentDef {
  const hit = benchCache.get(def);
  if (hit) return hit;
  const g = symbolGeom(def);
  const at: [number, number] = [8, 3];
  const pins: Record<string, [number, number]> = {};
  const pinDirs: Record<string, 'left' | 'right' | 'up' | 'down'> = {};
  const nets: NetDef[] = [];
  for (const p of def.ports) {
    const pg = g.ports[p.name];
    const x = at[0] + pg.pos[0], y = at[1] + pg.pos[1];
    if (pg.exit === 'left') pins[p.name] = [x - 6, y];
    else if (pg.exit === 'right') pins[p.name] = [x + 6, y];
    else if (pg.exit === 'down') { pins[p.name] = [x, y + 5]; pinDirs[p.name] = 'up'; }
    else { pins[p.name] = [x, y - 5]; pinDirs[p.name] = 'down'; }
    nets.push({ name: p.name, ends: p.dir === 'out' ? [`u.${p.name}`, p.name] : [p.name, `u.${p.name}`] });
  }
  const b: ComponentDef = {
    id: `bench_${def.id}`, name: def.name, category: def.category, summary: def.summary,
    ports: def.ports, symbol: { kind: 'box', label: def.name },
    netlist: () => ({ pins, pinDirs, instances: [{ name: 'u', def, at, label: def.name }], nets }),
  };
  benchCache.set(def, b);
  return b;
}
