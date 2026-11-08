// Where a warp core's lanes meet its memory (lib/warps.ts warpCoreDrawing, memPipe; lib/warpmem.ts lsuMemory): the
// memory sits under the lanes with each lane's ports on its top edge, so a lane's address and store data drop
// straight down into it and its returning load rises straight up beside it. Shared here so the memories' symbols and
// the top level's placement cannot drift apart (and warps.ts / warpmem.ts need not import each other for it).

/** Grid units from one lane's left edge to the next. */
export const LANE_PITCH = 36;
/** The memory's left edge, this far left of lane 0's. */
export const MEM_INSET = 6;
/** Per lane, x of each port from the lane's left edge: the load returning up its left side, aluY and rd2 down its right. */
export const LANE_TAP = { retData: -3, addr: 15, wd: 20 } as const;

/** The memory's top-edge ports for n lanes (x from its left edge), and a width that holds them. */
export function laneMemPorts(n: number): { portPos: Record<string, number>; w: number } {
  const portPos: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const x = MEM_INSET + LANE_PITCH * i;
    portPos[`retData${i}`] = x + LANE_TAP.retData;
    portPos[`addr${i}`] = x + LANE_TAP.addr;
    portPos[`wd${i}`] = x + LANE_TAP.wd;
  }
  return { portPos, w: MEM_INSET + LANE_PITCH * (n - 1) + LANE_TAP.wd + 6 };
}
