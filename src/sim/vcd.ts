// Value Change Dump (IEEE 1364 §18) of recorded traces, for GTKWave, Surfer and friends.
// One time unit is one NAND delay; we declare it as 1 ns, which is roughly right for a
// NAND2 with a fan-out of a few in an old process and keeps viewers' rulers sensible.

/**
 * A recorded signal: value v[i] holds from time t[i] (−1 = unknown / floating). A BigInt value
 * is exact at any width (signals past 53 bits).
 */
export interface TraceSignal {
  name: string;
  width: number;
  t: number[];
  v: (number | bigint)[];
}

/** VCD identifier codes: printable ASCII from '!' to '~', base 94. */
function code(i: number): string {
  let s = '';
  do {
    s += String.fromCharCode(33 + (i % 94));
    i = Math.floor(i / 94);
  } while (i > 0);
  return s;
}

function valueText(v: number | bigint, width: number, id: string): string {
  if (width === 1) return `${v < 0 ? 'x' : Number(v) & 1}${id}`;
  return `b${v < 0 ? 'x' : v.toString(2)} ${id}`;
}

export function toVcd(signals: TraceSignal[], opts: { date?: string; scope?: string } = {}): string {
  const out: string[] = [];
  if (opts.date) out.push(`$date ${opts.date} $end`);
  out.push('$version MOSFET → RISC-V logic analyzer $end');
  out.push('$comment 1 time unit = 1 NAND gate delay $end');
  out.push('$timescale 1ns $end');
  out.push(`$scope module ${(opts.scope ?? 'top').replace(/[^\w$]/g, '_')} $end`);
  const ids = signals.map((_, i) => code(i));
  signals.forEach((sg, i) => {
    const ref = sg.name.replace(/\s+/g, '_');
    out.push(`$var wire ${sg.width} ${ids[i]} ${ref}${sg.width > 1 ? ` [${sg.width - 1}:0]` : ''} $end`);
  });
  out.push('$upscope $end', '$enddefinitions $end');
  // Merge all changes in time order (stable within one instant: signal order).
  const ev: [number, number, number | bigint][] = [];
  signals.forEach((sg, i) => sg.t.forEach((t, k) => ev.push([t, i, sg.v[k]])));
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // The first instant holds the initial values ($dumpvars), later ones the changes.
  for (let k = 0; k < ev.length;) {
    const t = ev[k][0];
    out.push(`#${t}`);
    if (k === 0) out.push('$dumpvars');
    for (; k < ev.length && ev[k][0] === t; k++) out.push(valueText(ev[k][2], signals[ev[k][1]].width, ids[ev[k][1]]));
    if (t === ev[0][0]) out.push('$end');
  }
  return out.join('\n') + '\n';
}
