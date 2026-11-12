import { describe, expect, it } from 'vitest';
import { chTcp } from '../src/chapters/ch-comm-tcp';
import { ACK, RST, STATE_NAMES, ESTABLISHED } from '../src/net/tcp';
import { ADDR_BITS, EPHEMERAL_COUNT, EPHEMERAL_FROM, KEY_BITS, PORT_BITS, PORT_MAX, PROBES, runPortProbes } from '../src/net/tcpports';

const strip = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/(\d)[,\s   ](?=\d{3}(?!\d))/g, '$1');

describe('the ports step', () => {
  it('quotes the widths and the ephemeral range as computed', () => {
    expect([PORT_BITS, PORT_MAX, KEY_BITS, ADDR_BITS + PORT_BITS + ADDR_BITS + PORT_BITS, EPHEMERAL_FROM, EPHEMERAL_COUNT]).toEqual([16, 65535, 96, 96, 49152, 16384]);
    const step = chTcp.steps[2], t = strip(step.body);
    expect(step.title).toBe('Ports: which connection is this?');
    for (const x of ['16-bit', '0 to 65535', '49152 up', '16384 of them', '32 + 16 + 32 + 16 = 96 bits']) expect(t, x).toContain(x);
  });

  it('reads each outcome off the model', () => {
    const r = runPortProbes();
    expect([STATE_NAMES[r.server.state], r.server.lport, r.server.rport]).toEqual(['ESTABLISHED', 12000, 40000]);
    expect(r.outcomes.map((o) => o.kind)).toEqual(['taken', 'reset', 'reset', 'reset']);
    // 1: the four numbers match: its bytes are delivered and acknowledged
    const [a, b, c, d] = r.outcomes;
    expect(a.match).toEqual([true, true, true, true]);
    expect([a.rcvMoved, a.replies.length, a.replies[0].flags & ACK, a.replies[0].flags & RST]).toEqual([4, 1, ACK, 0]);
    // 2-4: a reset with the ports swapped back, and the connection untouched
    for (const o of [b, c, d]) {
      expect(o.replies.length).toBe(1);
      expect(o.replies[0].flags & RST).toBe(RST);
      expect([o.replies[0].sport, o.replies[0].dport]).toEqual([o.probe.dst.port, o.probe.src.port]);
      expect([o.state, o.rcvMoved]).toEqual([ESTABLISHED, 0]);
    }
    expect(b.match).toEqual([true, false, true, true]);
    expect(c.match).toEqual([true, true, true, false]);
    expect(d.match).toEqual([false, true, true, true]);
    expect(PROBES.length).toBe(4);
  });
});
