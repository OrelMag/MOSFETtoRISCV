// The TCP ladder's labels never touch (widgets/tcp.ts placeLabels): every chapter configuration, with and without a lost segment.
import { describe, expect, it } from 'vitest';
import { runTcp } from '../src/net/tcpsim';
import { placeLabels } from '../src/widgets/tcp';
import { tcpFlagText } from '../src/comm/netframes';

describe('ladder labels', () => {
  for (const [bytes, close] of [[0, false], [0, true], [512, false], [512, true]] as const) {
    for (const lost of [[], [1], [3], [3, 6], [5]]) {
      it(`${bytes} bytes${close ? ' + close' : ''}, lost ${lost.join(',') || 'none'}`, () => {
        const r = runTcp({ bytes, lost: new Set(lost), close, isnA: 0x1000, isnB: 0x2000, delay: 12_000 });
        const segs = r.segs.slice(0, 48);
        const times = [...new Set(segs.flatMap((x) => [x.t, x.at]))].sort((a, b) => a - b);
        const rank = new Map(times.map((t, i) => [t, i]));
        const texts = segs.map((x) => `${tcpFlagText(x.seg.flags)} seq ${x.seg.data.length} bytes, ack 1000000`);
        const p = placeLabels(segs, texts, rank, 90, 470);
        expect(p.clash).toBe(0);
        expect(p.ROW).toBeLessThanOrEqual(44);
        expect(p.spots).toHaveLength(segs.length);
      });
    }
  }
});
