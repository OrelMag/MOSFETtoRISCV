// Directed programs for the yaAGC oracle (scripts/agc/oracle.ts): the corners random programs reach rarely. Each starts
// at 04000 with INHINT and halts in a loop on itself.

const wrap = (body: string, data = '') => `X       = 61
Y       = 62
Z1      = 63
Z2      = 64
        SETLOC 4000
        INHINT
${body}
DONE    TCF DONE
${data}`;

/** DV on every sign of A, L and the divisor, in range, at the edges (|A| = |K|), and out of range. */
function dvCases(as: number[]): string {
  const words = [0, 0o77777, 1, 0o77776, 5, 0o77772, 0o20000, 0o57777, 0o37777, 0o40000];
  const lines: string[] = [];
  const data: string[] = [];
  let n = 0;
  const k = (v: number) => { data.push(`C${n}      OCT ${v.toString(8)}`); return `C${n++}`; };
  for (const a of as) for (const l of [0, 0o77777, 7, 0o77770]) for (const d of words) {
    lines.push(`        CA ${k(d)}`, '        TS Z1', `        CA ${k(l)}`, '        TS L', `        CA ${k(a)}`, '        EXTEND', '        DV Z1', '        TS X', '        LXCH Y');
  }
  return wrap(lines.join('\n'), data.join('\n'));
}

/** MP over signs and zeros, SQUARE. */
function mpCases(): string {
  const words = [0, 0o77777, 1, 0o77776, 3, 0o77774, 0o37777, 0o40000, 0o12345];
  const lines: string[] = [], data: string[] = [];
  let n = 0;
  const k = (v: number) => { data.push(`C${n}      OCT ${v.toString(8)}`); return `C${n++}`; };
  for (const a of words) for (const b of words) lines.push(`        CA ${k(a)}`, '        EXTEND', `        MP ${k(b)}`, '        TS X', '        LXCH Y', '        EXTEND', '        SQUARE', '        TS Z1');
  return wrap(lines.join('\n'), data.join('\n'));
}

export const DIRECTED: Record<string, string> = {
  add: wrap('        CA K5\n        AD KM5\n        TS X', 'K5      DEC 5\nKM5     DEC -5'),
  overflow: wrap('        CA MAX\n        AD ONE\n        TS X\n        TC BAD\n        TS Y\n        CA MAX\n        DOUBLE\n        TS A\n        TC BAD\n        TS L\n        TS Q\n        CA MIN\n        AD MIN\n        TS Z1\n        TC BAD',
    'MAX     OCT 37777\nONE     OCT 1\nMIN     OCT 40000\nBAD     TCF BAD'),
  ccs: wrap(`        CA V1\n        TS X\n        CCS X\n        TCF A0\n        TCF A1\n        TCF A2\n        TCF A3
A0      CA MAX\n        AD MAX\n        CCS A\n        TCF B0\nA1      TCF B0\nA2      TCF B0\nA3      TCF B0
B0      CA MIN\n        AD MIN\n        CCS A\n        NOOP\n        NOOP\n        NOOP\n        NOOP\n        CA KM0\n        TS L\n        CCS L\n        NOOP\n        NOOP\n        NOOP\n        NOOP`,
    'V1      DEC -9\nMAX     OCT 37777\nMIN     OCT 40000\nKM0     OCT 77777'),
  index: wrap('        CA K2\n        TS X\n        INDEX X\n        CA TAB\n        TS Y\n        CA K1\n        TS L\n        INDEX L\n        CA TAB\n        TS Z1\n        EXTEND\n        INDEX X\n        MP TAB',
    'K1      DEC 1\nK2      DEC 2\nTAB     DEC 10\n        DEC 20\n        DEC 30'),
  editing: wrap('        CA K\n        TS CYR\n        CA K\n        TS SR\n        CA K\n        TS CYL\n        CA K\n        TS EDOP\n        CA CYR\n        CA CYL\n        AD SR\n        CS CYL\n        EXTEND\n        DCA CYR\n        EXTEND\n        MSU SR\n        EXTEND\n        SU CYL',
    'K       OCT 40003'),
  das: wrap('        CA K1\n        TS X\n        CA KMAX\n        TS Y\n        CA K2\n        TS L\n        CA K0\n        DAS X\n        CA KMAX\n        TS L\n        CA KMAX\n        DDOUBL\n        DXCH Z1\n        CA KMIN\n        TS L\n        CA KMIN\n        DAS Z1',
    'K0      DEC 0\nK1      DEC 1\nK2      DEC 2\nKMAX    OCT 37777\nKMIN    OCT 40000'),
  subroutine: wrap('        TC SUB\n        TS Y\n        TC SUB\n        TS Z1', 'SUB     CA K7\n        TS X\n        RETURN\nK7      DEC 7'),
  banks: wrap('        CA K3\n        TS EB\n        CA K9\n        TS 1400\n        CA KF\n        TS FB\n        CA 2000\n        TS X\n        CA KB\n        TS BB\n        CA 1400\n        TS Y\n        CA BB\n        TS Z1\n        CA KE0\n        TS EB',
    'K3      OCT 1400\nK9      DEC 9\nKF      OCT 6000\nKB      OCT 10002\nKE0     OCT 0'),
  augdim: wrap('        CA K5\n        TS X\n        CA KM5\n        TS Y\n        EXTEND\n        AUG X\n        EXTEND\n        AUG Y\n        EXTEND\n        DIM X\n        EXTEND\n        DIM Y\n        CA K0\n        TS Z1\n        EXTEND\n        DIM Z1\n        INCR Z1\n        EXTEND\n        AUG A\n        EXTEND\n        DIM L',
    'K0      DEC 0\nK5      DEC 5\nKM5     DEC -5'),
  branches: wrap('        CA K0\n        EXTEND\n        BZF L1\n        TC BAD\nL1      CA KM\n        EXTEND\n        BZF BAD\n        EXTEND\n        BZMF L2\n        TC BAD\nL2      CA K1\n        EXTEND\n        BZMF BAD\n        TS X',
    'K0      DEC 0\nK1      DEC 1\nKM      DEC -3\nBAD     TCF BAD'),
  msu: wrap('        CA K5\n        EXTEND\n        MSU X\n        TS Y\n        CA KM\n        TS X\n        CA K5\n        EXTEND\n        MSU X\n        TS Z1\n        CA K5\n        TS Q\n        CA KM\n        EXTEND\n        MSU Q\n        EXTEND\n        QXCH Z2\n        EXTEND\n        ZQ',
    'K5      DEC 5\nKM      OCT 70000'),
  dv0: dvCases([0, 0o77777]),
  dv1: dvCases([3, 0o77774]),
  dv2: dvCases([0o37776]),
  mp: mpCases(),
};
