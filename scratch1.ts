import { dec6, dec4, decode8b10bTracking, type Rd } from './src/comm/linecode';
let bad=0;
for (let code=0; code<1024; code++) for (const rd of [0,1] as Rd[]) {
  const d6 = dec6(code>>4, rd), d4 = dec4(code&15, d6.rd1 as Rd, d6.k28, d6.xk, d6.xa0, d6.xa1);
  const m = decode8b10bTracking(code, rd);
  const err = d6.bad|d4.bad, k = d6.k28|d4.kseven, v = (d4.y<<5)|d6.x, rdo = d6.rd1 ^ d4.flip;
  const exp = m.err ? 1 : 0;
  if (err !== exp) { bad++; if (bad<8) console.log('err', code.toString(2), rd, err, m); }
  else if (!err && (k !== (m.k?1:0) || v !== m.v || rdo !== m.rd)) { bad++; if (bad<8) console.log('val', code.toString(2), rd, {k,v,rdo}, m); }
}
console.log('mismatches', bad);
