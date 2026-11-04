// Print a chapter (DOM-free): what each step contributes to the printed chapter. The page (ui/pages/print.ts) draws the figures
// and the text; this decides which steps give a figure, a note or a link, numbers the figures and the questions, and holds the
// size limits that keep a huge design from being flattened for a picture. tests/printplan.test.ts runs it over every chapter.

import { estimateInstances } from '../sim/flatten';
import { evalOnce, forEachInput, inputBits, needsSwitchLevel, simulate } from '../sim/harness';
import { hasFeedback } from '../sim/stats';
import { type ComponentDef, inPorts, netlistOf, outPorts } from '../sim/types';
import type { Scene } from '../view/stage';
import { chapterNo, type Chapter, type Quiz } from './types';

/** A scene up to this many instances (flatten's own estimate) is simulated for its figure, as the stage does: tens of ms. */
export const SIM_MAX = 20000;
/** Above it only the top level is drawn (its parts as blocks, values unknown), if the top level itself has at most this many parts. */
export const TOP_MAX_PARTS = 800;
/** A truth table is printed for a combinational scene with at most this many input bits (16 rows). */
export const TRUTH_MAX_IN = 4;

/**
 * sim: the scene simulated at its initial inputs; top: a design too large to simulate, drawn at its top level only (the caption says so);
 * link: not drawn (too large even for that, or a transistor-level engine), a line with the step's address; live: a widget, a note and the
 * address; none: the step has no scene or widget of its own.
 */
export type FigureMode = 'sim' | 'top' | 'link' | 'live' | 'none';

export interface StepPlan {
  step: number;
  mode: FigureMode;
  /** Figure number within the chapter (sim and top only). */
  figure?: number;
  /** "Figure 4.3" (sim and top only). */
  label?: string;
  /** Why a step is a link or a note. */
  reason?: string;
  /** The scene, built once (sim, top). */
  scene?: Scene;
  /** The scene is combinational with few inputs: a truth table goes under the figure. */
  truth: boolean;
}

export interface QuestionPlan {
  /** 1-based within the chapter, in reading order. */
  n: number;
  /** The step it sits in; -1: the recap. */
  step: number;
  quiz: Quiz;
}

export interface ChapterPlan {
  id: string;
  steps: StepPlan[];
  figures: number;
  questions: QuestionPlan[];
  /** The reach challenges (try them on the site), by step. */
  challenges: { step: number; goal: string }[];
}

/** "4.3" for chapter 04's third figure, "P1.2", "A.1"; a chapter shown by a word ("Start") has plain numbers. */
export function figureNo(c: Pick<Chapter, 'num' | 'appendix' | 'prologue' | 'label'>, n: number): string {
  if (c.label) return String(n);
  return `${chapterNo(c).replace(/^0+(?=\d)/, '')}.${n}`;
}

/** The kind of figure a scene gets, and why not a picture when it is a link. Nothing is flattened here. */
export function classify(scene: Scene): { mode: 'sim' | 'top' | 'link'; reason?: string } {
  const root = scene.root;
  if (scene.engine === 'nmos') return { mode: 'link', reason: 'a transistor-level chip too large to draw as a figure' };
  if (scene.noRemix) return { mode: 'link', reason: 'a computer too large to draw as a figure' };
  const nl = netlistOf(root);
  if (!nl) return { mode: 'link', reason: 'no structure to draw' };
  const sw = needsSwitchLevel(root);
  // a cycle-engine scene is a design of tens of thousands of gates and up: never simulated here
  if (scene.engine !== 'cycle') {
    const n = estimateInstances(root, sw ? 'switch' : 'gate');
    if (n <= SIM_MAX) return { mode: 'sim' };
  }
  if (sw) return { mode: 'link', reason: 'a transistor-level design too large to draw as a figure' };
  if (nl.instances.length > TOP_MAX_PARTS) return { mode: 'link', reason: `its top level alone has ${nl.instances.length} parts` };
  return { mode: 'top' };
}

/** A combinational scene with a handful of inputs: its truth table is short enough for the page. */
export function truthEligible(def: ComponentDef): boolean {
  if (!netlistOf(def) || def.ports.some((p) => p.dir === 'inout' || p.clock)) return false;
  const bits = inputBits(def);
  const outs = outPorts(def);
  if (bits < 1 || bits > TRUTH_MAX_IN || !outs.length || outs.reduce((a, p) => a + p.width, 0) > 8) return false;
  try {
    return !hasFeedback(def);
  } catch {
    return false;
  }
}

export interface TruthTable {
  head: string[];
  inCount: number;
  rows: string[][];
}

/** The rows of the scene root's truth table, from simulating its structure (X shown as X). */
export function truthTable(def: ComponentDef): TruthTable {
  const sim = simulate(def);
  const ins = inPorts(def), outs = outPorts(def);
  const fmt = (v: number, w: number) => (v < 0 ? 'X' : w === 1 ? String(v) : v.toString(2).padStart(w, '0'));
  const rows: string[][] = [];
  forEachInput(def, (iv) => {
    const ov = evalOnce(sim, iv);
    rows.push([...iv.map((v, i) => fmt(v, ins[i].width)), ...ov.map((v, i) => fmt(v, outs[i].width))]);
  });
  return { head: [...ins, ...outs].map((p) => p.name), inCount: ins.length, rows };
}

/** What each step of `c` gives the printed chapter. Cheap: no scene is flattened (scenes are built, their sizes estimated). */
export function planChapter(c: Chapter): ChapterPlan {
  const steps: StepPlan[] = [];
  const questions: QuestionPlan[] = [];
  const challenges: ChapterPlan['challenges'] = [];
  let figures = 0;
  const ask = (step: number, quiz: Quiz) => questions.push({ n: questions.length + 1, step, quiz });
  c.steps.forEach((st, i) => {
    const p: StepPlan = { step: i, mode: 'none', truth: false };
    if (st.scene) {
      try {
        const scene = st.scene();
        const k = classify(scene);
        p.mode = k.mode;
        p.reason = k.reason;
        if (k.mode !== 'link') {
          p.scene = scene;
          p.figure = ++figures;
          p.label = `Figure ${figureNo(c, figures)}`;
          p.truth = k.mode === 'sim' && truthEligible(scene.root);
        }
      } catch (e) {
        p.mode = 'link';
        p.reason = `the scene could not be built (${e instanceof Error ? e.message : String(e)})`;
      }
    } else if (st.widget) {
      p.mode = 'live';
      p.reason = 'a live explainer';
    }
    steps.push(p);
    if (st.challenge?.kind === 'quiz') ask(i, st.challenge);
    else if (st.challenge) challenges.push({ step: i, goal: st.challenge.goal });
    for (const q of st.reading?.quizzes ?? []) ask(i, q);
  });
  for (const q of c.recap?.check ?? []) ask(-1, q);
  return { id: c.id, steps, figures, questions, challenges };
}
