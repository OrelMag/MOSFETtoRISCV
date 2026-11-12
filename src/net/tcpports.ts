// Chapter codes's "Ports" step: which connection is this segment for? Four probe segments are fed to the reference TcpModel (net/tcp.ts) of a server that has
// one ESTABLISHED connection, and what the figure says about each (taken, or answered with a reset) is read off the model: the segments it sent and its state.
// Nothing here is typed in as an outcome. DOM-free; tests/net-tcp-ports.test.ts.

import { ip4 } from '../comm/netframes';
import { TCP_CLIENT_PORT, TCP_PORT } from '../comm/stack/tcpapps';
import { ACK, ESTABLISHED, PSH, RST, SYN, TCP_K, TcpModel, segBytes, type Segment } from './tcp';

/** The widths of a connection's key: two addresses and two ports. */
export const ADDR_BITS = 32, PORT_BITS = 16;
export const KEY_BITS = 2 * ADDR_BITS + 2 * PORT_BITS;
/** Port numbers are 16 bits wide. */
export const PORT_MAX = 2 ** PORT_BITS - 1;
/** IANA's convention (RFC 6335) for the ports a program that starts a connection is given: 49152 up. */
export const EPHEMERAL_FROM = 49152;
export const EPHEMERAL_COUNT = PORT_MAX - EPHEMERAL_FROM + 1;

export const CLIENT_IP = ip4(10, 0, 1, 2), SERVER_IP = ip4(10, 0, 2, 2), OTHER_IP = ip4(10, 0, 3, 2);
export const SERVER_PORT = TCP_PORT, CLIENT_PORT = TCP_CLIENT_PORT, OTHER_PORT = 80;
export const ipText = (a: number): string => [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join('.');

export interface PortProbe {
  id: number;
  /** Where it comes from and where it is going. */
  src: { ip: number; port: number };
  dst: { ip: number; port: number };
  syn: boolean;
}
/** The four probes, against a server (SERVER_IP, port SERVER_PORT) that holds one connection with CLIENT_IP, port CLIENT_PORT. */
export const PROBES: PortProbe[] = [
  { id: 1, src: { ip: CLIENT_IP, port: CLIENT_PORT }, dst: { ip: SERVER_IP, port: SERVER_PORT }, syn: false },
  { id: 2, src: { ip: CLIENT_IP, port: CLIENT_PORT + 1 }, dst: { ip: SERVER_IP, port: SERVER_PORT }, syn: false },
  { id: 3, src: { ip: CLIENT_IP, port: CLIENT_PORT }, dst: { ip: SERVER_IP, port: OTHER_PORT }, syn: false },
  { id: 4, src: { ip: OTHER_IP, port: CLIENT_PORT }, dst: { ip: SERVER_IP, port: SERVER_PORT }, syn: true },
];

export type PortKind = 'taken' | 'reset';
export interface PortOutcome {
  probe: PortProbe;
  /** Which of the key's four fields (source address, source port, destination address, destination port) equal the connection's. */
  match: [boolean, boolean, boolean, boolean];
  kind: PortKind;
  /** Everything the server sent in answer. */
  replies: Segment[];
  /** The connection's state, and how far its receive side moved. */
  state: number;
  rcvMoved: number;
}
export interface PortsRun {
  server: { state: number; lip: number; lport: number; rip: number; rport: number };
  outcomes: PortOutcome[];
}

/** Two models joined back to back, driven to ESTABLISHED: the client connects from CLIENT_PORT, the server listens on SERVER_PORT. */
function connected(): { server: TcpModel; client: TcpModel; toServer: Segment[]; fromServer: Segment[] } {
  const toServer: Segment[] = [], fromServer: Segment[] = [];
  const server = new TcpModel({ ip: SERVER_IP, send: (s) => { fromServer.push(s); return true; } });
  const client = new TcpModel({ ip: CLIENT_IP, send: (s) => { toServer.push(s); return true; } });
  server.listen(SERVER_PORT);
  client.connect(SERVER_IP, CLIENT_PORT, SERVER_PORT, 0);
  for (let i = 0; i < 6 && !(server.st === ESTABLISHED && client.st === ESTABLISHED); i++) {
    for (const s of toServer.splice(0)) server.input(segBytes(s, CLIENT_IP, SERVER_IP), CLIENT_IP, 0);
    for (const s of fromServer.splice(0)) client.input(segBytes(s, SERVER_IP, CLIENT_IP), SERVER_IP, 0);
  }
  toServer.length = 0; fromServer.length = 0;
  return { server, client, toServer, fromServer };
}

/** Each probe against a freshly connected server; what comes back is what the model sent. */
export function runPortProbes(): PortsRun {
  const first = connected();
  const run = first.server;
  const outcomes = PROBES.map((p): PortOutcome => {
    const { server, client, fromServer } = connected();
    const data = p.syn ? [] : [0x68, 0x69, 0x21, 0x0a];
    const seg: Segment = p.syn
      ? { sport: p.src.port, dport: p.dst.port, seq: 0x5000, ack: 0, flags: SYN, wnd: TCP_K.RCV, mss: TCP_K.MSS, data }
      : { sport: p.src.port, dport: p.dst.port, seq: client.sndNxt, ack: client.rcvNxt, flags: ACK | PSH, wnd: TCP_K.RCV, data };
    const before = server.rcvNxt;
    server.input(segBytes(seg, p.src.ip, p.dst.ip), p.src.ip, 1);
    return {
      probe: p,
      match: [p.src.ip === CLIENT_IP, p.src.port === CLIENT_PORT, p.dst.ip === SERVER_IP, p.dst.port === SERVER_PORT],
      kind: fromServer.some((r) => r.flags & RST) ? 'reset' : 'taken',
      replies: fromServer.slice(),
      state: server.st,
      rcvMoved: (server.rcvNxt - before) | 0,
    };
  });
  return { server: { state: run.st, lip: SERVER_IP, lport: run.lport, rip: run.rip, rport: run.rport }, outcomes };
}

/** A reply as the figure words it: its flags and its ports. */
export const replyText = (s: Segment): string =>
  `${s.flags & RST ? 'RST' : ''}${s.flags & SYN ? 'SYN' : ''}${s.flags & ACK ? (s.flags & RST ? ', ACK' : 'ACK') : ''} from port ${s.sport} to port ${s.dport}`;

