// Rectangle geometry shared by the standard-cell views (DOM-free).

/** The union of rectangles [x, y, w, h] as disjoint ones (row bands, runs merged down), so overlapping pieces of one
 *  drawn shape become solids that do not cut into each other. */
export function disjoint(rs: [number, number, number, number][]): [number, number, number, number][] {
  const xs = [...new Set(rs.flatMap(([x, , w]) => [x, x + w]))].sort((a, b) => a - b);
  const ys = [...new Set(rs.flatMap(([, y, , h]) => [y, y + h]))].sort((a, b) => a - b);
  const out: [number, number, number, number][] = [];
  let open = new Map<string, [number, number, number, number]>();
  for (let j = 0; j + 1 < ys.length; j++) {
    const y0 = ys[j], y1 = ys[j + 1], next = new Map<string, [number, number, number, number]>();
    for (let i = 0; i + 1 < xs.length;) {
      const inside = (k: number) => rs.some(([x, y, w, h]) => x <= xs[k] && xs[k + 1] <= x + w && y <= y0 && y1 <= y + h);
      if (!inside(i)) { i++; continue; }
      let k = i;
      while (k + 2 < xs.length && inside(k + 1)) k++;
      const key = `${xs[i]}:${xs[k + 1]}`, prev = open.get(key);
      if (prev) { prev[3] += y1 - y0; next.set(key, prev); open.delete(key); } else { const r: [number, number, number, number] = [xs[i], y0, xs[k + 1] - xs[i], y1 - y0]; out.push(r); next.set(key, r); }
      i = k + 1;
    }
    open = next;
  }
  return out;
}
