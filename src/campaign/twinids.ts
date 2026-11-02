// Which campaign levels also have a Verilog twin (campaign/verilog.ts has the twins themselves). Kept apart so the map and the
// progress store know the ids without importing Yosys's side of the site. tests/verilog-twins.test.ts holds the two lists equal.

/** Level ids, in map order. */
export const TWIN_LEVELS: readonly string[] = ['g_dec', 'a_addsub16', 'a_slt', 's_reg4', 's_cnt4', 'c_imm', 'c_br'];

export const TWIN_PREFIX = 'vl_';

/** The twin's id in the campaign progress and in the route (#/campaign/play/vl_<level>). */
export const twinKey = (level: string): string => `${TWIN_PREFIX}${level}`;

export const hasTwin = (level: string): boolean => TWIN_LEVELS.includes(level);

export const isTwinKey = (id: string): boolean => id.startsWith(TWIN_PREFIX) && hasTwin(id.slice(TWIN_PREFIX.length));
