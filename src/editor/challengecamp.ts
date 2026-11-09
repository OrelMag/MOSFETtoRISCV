// What the sandbox's challenge strip and puzzle dialog use from the campaign, in one module loaded on demand
// (editor/campaignlink.ts loadCampaign): nothing of it is needed until a level's chip is open.

export { addBench, addLaneBench, addPongBench, failingTest } from '../campaign/bench';
export { measured } from '../campaign/grade';
export { isDone, nextAvailable } from '../campaign/graph';
export { levelChallenge, nodeOfChip } from '../campaign/levels';
export { actName, actTitle } from '../campaign/nodes';
export { tipsOf } from '../campaign/nudges';
export { progress } from '../campaign/progress';
