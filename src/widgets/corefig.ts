// The Memory chapter's read-cycle figure for "A core plane, wired" (DOM-free: an HTML string for the step's body): the store's
// cycle as the simulation runs it, one clock edge per phase, and Whirlwind's in microseconds, redrawn from MIT Report R-221's text
// (its timing figure is a scan we could not read). In both the strobe falls inside the read current. Colours are classes on the
// theme's tokens (styles/app.css .cf-*), so the figure follows light and dark.

/** Whirlwind's storage timing as R-221 gives it (section 5): every number the second strip draws. */
export const R221 = {
  /** The read flip-flop's pulse, µs, and the current on each selected selection plane, A. */
  readUs: 1.5, readA: 0.45,
  /** The sense output: about 0.1 V and about 1.2 µs long. */
  senseV: 0.1, senseUs: 1.2,
  /** The strobe: a 0.1 µs pulse about 0.5 µs from the start of the sense pulse (the core test of Fig. 40). */
  strobeUs: 0.1, strobeAtUs: 0.5,
  /** Data available about 2 µs into the cycle; the cycle about 9 µs (later 8); the post-write disturb about 1 µs. */
  dataUs: 2, cycleUs: 9, disturbUs: 1,
} as const;

type Row =
  | { name: string; cls: string; pts: [number, number][]; notes?: [number, string][]; dashed?: [number, number][] }
  | { name: string; boxes: [number, number, string, string?][] };

const W = 520, LEFT = 74, RIGHT = 508, TOP = 30, ROW = 30;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function strip(rows: Row[], span: number, axis: string, grid: { t: number; label: string; end?: boolean }[], label: string): string {
  const T = (t: number) => LEFT + (t / span) * (RIGHT - LEFT);
  const H = TOP + rows.length * ROW + 22;
  const out: string[] = [];
  for (const g of grid) {
    out.push(`<line x1="${T(g.t)}" y1="${TOP - 8}" x2="${T(g.t)}" y2="${H - 22}" class="cf-grid"/>`);
    out.push(`<text x="${g.end ? T(g.t) - 3 : T(g.t) + 3}" y="${TOP - 12}" text-anchor="${g.end ? 'end' : 'start'}" class="cf-note">${esc(g.label)}</text>`);
  }
  rows.forEach((row, i) => {
    const y0 = TOP + i * ROW + ROW * 0.78, h = ROW * 0.55;
    out.push(`<text x="6" y="${y0 - h / 3}" class="cf-name">${esc(row.name)}</text>`);
    if ('boxes' in row) {
      for (const [a, b, txt, cls] of row.boxes) {
        out.push(`<rect x="${T(a)}" y="${y0 - h}" width="${T(b) - T(a)}" height="${h}" rx="2" class="cf-box ${cls ?? ''}"/>`);
        out.push(`<text x="${(T(a) + T(b)) / 2}" y="${y0 - h / 2 + 4}" text-anchor="middle" class="cf-boxtext">${esc(txt)}</text>`);
      }
      return;
    }
    const pts: string[] = [];
    let last = row.pts[0][1];
    pts.push(`${T(0)},${y0 - last * h}`);
    for (const [t, v] of row.pts) { pts.push(`${T(t)},${y0 - last * h}`, `${T(t)},${y0 - v * h}`); last = v; }
    pts.push(`${T(span)},${y0 - last * h}`);
    out.push(`<polyline points="${pts.join(' ')}" class="cf-wave ${row.cls}"/>`);
    for (const [a, b] of row.dashed ?? []) out.push(`<polyline points="${T(a)},${y0} ${T(a)},${y0 - h * 0.45} ${T(b)},${y0 - h * 0.45} ${T(b)},${y0}" class="cf-wave ${row.cls} cf-dash"/>`);
    for (const [t, txt] of row.notes ?? []) out.push(`<text x="${T(t)}" y="${y0 - h - 3}" class="cf-note">${esc(txt)}</text>`);
  });
  out.push(`<text x="${RIGHT}" y="${H - 4}" text-anchor="end" class="cf-note">${esc(axis)}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" class="core-fig-svg" role="img" aria-label="${esc(label)}">${out.join('')}</svg>`;
}

/** The store's cycle: reading a word whose bit is 1, then one whose bit is 0, two clocks each. */
export function simulatedStrip(): string {
  return strip([
    { name: 'clk', cls: 'cf-clk', pts: [[0, 0], [0.5, 1], [1, 0], [1.5, 1], [2, 0], [2.5, 1], [3, 0], [3.5, 1], [4, 0], [4.5, 1], [5, 0], [5.5, 1], [6, 0]] },
    { name: 'phase', boxes: [[0, 1, 'IDLE'], [1, 2, 'READ', 'cf-read'], [2, 3, 'WRITE', 'cf-write'], [3, 4, 'IDLE'], [4, 5, 'READ', 'cf-read'], [5, 6, 'WRITE', 'cf-write']] },
    { name: 'read', cls: 'cf-full', pts: [[0, 0], [1, 1], [2, 0], [4, 1], [5, 0]] },
    { name: 'sense', cls: 'cf-sense', pts: [[0, 0], [1, 1], [2, 0]], dashed: [[2, 3]], notes: [[1.05, 'a 1 switches'], [2.2, 'other way'], [4.05, 'quiet']] },
    { name: 'strobe', cls: 'cf-clk', pts: [[0, 0], [1.94, 1], [2.06, 0], [4.94, 1], [5.06, 0]], notes: [[1.25, 'edge ending READ']] },
    { name: 'buffer', boxes: [[0, 2, '?'], [2, 5, '1'], [5, 6, '0']] },
    { name: 'write', cls: 'cf-w', pts: [[0, 0], [2, 1], [3, 0], [5, 1], [6, 0]] },
    { name: 'inhibit', cls: 'cf-inh', pts: [[0, 0], [5, 1], [6, 0]], notes: [[5.05, 'for a 0']] },
    { name: 'core', boxes: [[0, 2, '1'], [2, 3, '0: read out', 'cf-lost'], [3, 4, '1'], [4, 6, 'a 0: stays 0']] },
  ], 6, 'clock cycles: two per access', [{ t: 3, label: 'next word' }],
  'The store\'s cycle as the simulation runs it: READ drives the core toward 0 and a 1 pulses the sense wire; the edge that ends READ is the strobe that loads the buffer; WRITE puts the bit back, the inhibit keeping a 0.');
}

/** Whirlwind's cycle in microseconds, from R-221's text; the write and inhibit pulses' lengths are not given and are drawn unlabelled. */
export function whirlwindStrip(): string {
  const r0 = 0.2, s0 = r0, st = s0 + R221.strobeAtUs;
  return strip([
    { name: 'read I', cls: 'cf-full', pts: [[0, 0], [r0, 1], [r0 + R221.readUs, 0]], notes: [[r0 + 0.05, `${R221.readUs} µs, ${R221.readA} A`]] },
    { name: 'sense 1', cls: 'cf-sense', pts: [[0, 0], [s0, 0.6], [s0 + 0.3, 1], [s0 + 0.6, 0.7], [s0 + 0.9, 0.35], [s0 + R221.senseUs, 0]], notes: [[s0 + R221.senseUs + 0.05, `≈ ${R221.senseV} V, ≈ ${R221.senseUs} µs`]] },
    { name: 'strobe', cls: 'cf-clk', pts: [[0, 0], [st, 1], [st + R221.strobeUs, 0]], notes: [[st + 0.15, `${R221.strobeUs} µs, inside the read`]] },
    { name: 'data out', boxes: [[R221.dataUs, R221.cycleUs, `available ≈ ${R221.dataUs} µs in`]] },
    { name: 'write I', cls: 'cf-w', pts: [[0, 0], [2.6, 1], [4.6, 0]] },
    { name: 'inhibit', cls: 'cf-inh', pts: [[0, 0], [2.4, 1], [4.8, 0]], notes: [[4.9, 'lengths not given']] },
    { name: 'disturb', cls: 'cf-clk', pts: [[0, 0], [5.2, 1], [5.2 + R221.disturbUs, 0]], notes: [[5.3 + R221.disturbUs, `≈ ${R221.disturbUs} µs`]] },
  ], 9.5, 'µs, redrawn from the text of MIT Report R-221 (1954)', [{ t: 0, label: '0' }, { t: R221.dataUs, label: String(R221.dataUs) }, { t: R221.cycleUs, label: `≈ ${R221.cycleUs} µs cycle`, end: true }],
  `Whirlwind's storage cycle: a ${R221.readUs} µs read current, the sense pulse of a 1 about ${R221.senseUs} µs long, a ${R221.strobeUs} µs strobe about ${R221.strobeAtUs} µs into it, data about ${R221.dataUs} µs into the cycle, the write and inhibit after, about ${R221.cycleUs} µs in all.`);
}

/** Both strips with their captions, for the step's body. */
export function readCycleFigure(): string {
  return `<figure class="core-fig">${simulatedStrip()}<figcaption>The store's cycle, one clock edge per phase: reading a 1 (left), then a 0. The strobe is the edge that ends READ, so it falls inside the read current; the write-back's pulse on the sense wire goes the other way and nothing strobes it.</figcaption></figure>
<figure class="core-fig">${whirlwindStrip()}<figcaption>Whirlwind's cycle, redrawn from the text of MIT Report R-221: a ${R221.readUs} µs read at ${R221.readA} A on each selected X and Y line, a sense pulse of about ${R221.senseV} V and ${R221.senseUs} µs, strobed by a ${R221.strobeUs} µs pulse about ${R221.strobeAtUs} µs into it, inside the read current; data about ${R221.dataUs} µs into the cycle, about ${R221.cycleUs} µs in all (later 8). The report gives no length for the write and inhibit pulses: drawn, not labelled.</figcaption></figure>`;
}
