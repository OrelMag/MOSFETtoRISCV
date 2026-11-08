// Which step's stage a chapter step shows (DOM-free): its own, else the nearest EARLIER step's, else none (-1: the stage is
// an intro card). Never a later step's: its figure would name terms the text has not introduced yet.

export function stageStepOf(has: (k: number) => boolean, i: number): number {
  let k = i;
  while (k >= 0 && !has(k)) k--;
  return k;
}
