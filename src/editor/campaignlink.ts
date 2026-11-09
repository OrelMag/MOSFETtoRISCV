// The sandbox's door to the campaign: a level's chip is known by its id alone, and the campaign's code (its levels, their
// checkers and reference answers, progress: a quarter of the sandbox's size) loads only when such a chip is open, the level
// screen starts, or a dialog needs a level (editor/challengecamp.ts).

/** A campaign level's chip: `u_ch_cp_<node>` (campaign/levels.ts levelChipId). */
export const isLevelChip = (chipId: string): boolean => chipId.startsWith('u_ch_cp_');

type Camp = typeof import('./challengecamp');
let camp: Camp | null = null;
let loading: Promise<Camp> | null = null;

/** The campaign's code if it has loaded. */
export const campaignNow = (): Camp | null => camp;

/** Loads the campaign's code (once). */
export function loadCampaign(): Promise<Camp> {
  return loading ??= import('./challengecamp').then((m) => (camp = m));
}

/** A page that imports the campaign anyway (the level screen) hands it over, so the strip has it from its first draw. */
export function provideCampaign(m: Camp): void {
  camp = m;
  loading ??= Promise.resolve(m);
}
