// The 1890 census tally, DOM-free: the fields a card punches, the seeded stack and what one pressed card does to the
// dials. widgets/cards.ts (censusWidget) and the 3D press (widgets/press3dparts.ts) share it, so both count alike.

export const FIELDS: { name: string; opts: string[] }[] = [
  { name: 'Sex', opts: ['M', 'F'] },
  { name: 'Age', opts: ['0–19', '20–39', '40–59', '60+'] },
  { name: 'Married', opts: ['yes', 'no'] },
  { name: 'Born', opts: ['US', 'abroad'] },
];
export const STACK = 60;

/** A deterministic LCG in [0, 1). */
export function lcg(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** The stack: per card, the punched option of each field. */
export function censusPeople(): number[][] {
  const rnd = lcg(1890);
  return Array.from({ length: STACK }, () => {
    const age = Math.floor(rnd() * 4);
    return [rnd() < 0.51 ? 0 : 1, age, age > 0 && rnd() < 0.62 ? 0 : 1, rnd() < 0.85 ? 0 : 1];
  });
}

export const newCounts = (): number[][] => FIELDS.map((f) => f.opts.map(() => 0));
/** A card with these punches counts as a married woman (the two-relay AND). */
export const marriedWoman = (p: readonly number[]): boolean => p[0] === 1 && p[2] === 0;
/** One pressed card steps one dial per field; returns 1 when the married-women dial steps too. */
export function tallyCard(counts: number[][], p: readonly number[]): number {
  p.forEach((v, i) => { counts[i][v]++; });
  return marriedWoman(p) ? 1 : 0;
}

/** The 3D press's relay pair: one relay per condition, energized through its hole's mercury cup (married: yes; born:
 *  abroad). Their make contacts in series drive a dial for AND, in parallel for OR (chapter P3's derive and quiz). */
export type Wiring = 'and' | 'or';
export const relayInputs = (p: readonly number[]): [boolean, boolean] => [p[2] === 0, p[3] === 1];
/** Whether the relay dial steps for this card under this wiring. */
export function relayDial(p: readonly number[], w: Wiring): boolean {
  const [a, b] = relayInputs(p);
  return w === 'and' ? a && b : a || b;
}
