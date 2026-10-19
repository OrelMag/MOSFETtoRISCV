// The part opened on a stage, kept in the hash after the route's own segments (#/workbench/<id>/fa0/g3,
// #/c/<chapter>/<step>/dp/alu), so every level a learner opens is a history entry: Back goes up one, Forward down
// again, a reload or a shared link reopens it. Without segments a scene opens where it always did (Scene.path).
//
// Going back to a level whose entry sits just behind (Up, Esc, a breadcrumb, a text link back to the opening view)
// steps back through history to it rather than pushing it again, so drilling in and out never piles up entries.
// The entries behind are known from the state stored with each one pushed here (DrillState).

/** The top level, written when the scene's own opening view is deeper (a chapter step whose scene has a path). */
export const TOP = '~';

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The hash segments for `path` (instance names from the root); '' when it is the scene's opening view `home`. */
export function drillSegs(path: readonly string[], home: readonly string[] = []): string {
  if (same(path, home)) return '';
  if (!path.length) return `/${TOP}`;
  return path.map((n) => `/${encodeURIComponent(n)}`).join('');
}

/** The path the segments after the route's own name (undefined: none, the scene's opening view). */
export function parseDrill(segs: readonly string[]): string[] | undefined {
  if (!segs.length) return undefined;
  if (segs.length === 1 && segs[0] === TOP) return [];
  return segs.filter((x) => x !== TOP).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
}

/** Stored with an entry pushed here: the hashes of the entries just behind it, oldest first, all of the same page. */
export interface DrillState {
  drillBehind: string[];
}

function behindOf(state: unknown): string[] {
  const b = (state as Partial<DrillState> | null)?.drillBehind;
  return Array.isArray(b) && b.every((x) => typeof x === 'string') ? b : [];
}

export type DrillMove = { kind: 'none' } | { kind: 'back'; n: number } | { kind: 'push'; state: DrillState };

/** How to get from the entry `cur` (its history state `state`) to `want`: stay, step back n entries, or push. */
export function drillMove(cur: string, state: unknown, want: string): DrillMove {
  if (cur === want) return { kind: 'none' };
  const behind = behindOf(state);
  const i = behind.lastIndexOf(want);
  if (i >= 0) return { kind: 'back', n: behind.length - i };
  return { kind: 'push', state: { drillBehind: [...behind, cur] } };
}

/** A step back through history issued by syncDrill, on its way (history.go is asynchronous). */
let landing: { hash: string; at: number } | null = null;

/**
 * Bring the address bar to `want` after the learner opened a level. `fix`: the stage only settled where the hash
 * asked (a stale name in a link, Back to a path that no longer opens that far): correct the entry, no new one.
 * While a step back is still on its way nothing is written: the page syncs again once it lands (drillLanded).
 */
export function syncDrill(want: string, fix = false): void {
  if (landing && performance.now() - landing.at < 1500) return;
  landing = null;
  if (fix) {
    if (location.hash !== want) history.replaceState(history.state, '', want);
    return;
  }
  const m = drillMove(location.hash, history.state, want);
  if (m.kind === 'back') {
    landing = { hash: want, at: performance.now() };
    history.go(-m.n);
  } else if (m.kind === 'push') history.pushState(m.state, '', want);
}

/**
 * For the route, on a hash change: is it syncDrill's own step back landing? Then the stage is already there (or
 * has moved on since, which the page writes now); else it is the learner's Back / Forward or a link, to follow.
 */
export function drillLanded(): boolean {
  const ours = !!landing && landing.hash === location.hash;
  landing = null;
  return ours;
}
