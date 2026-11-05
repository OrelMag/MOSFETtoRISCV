// Builds tests/crypto/vectors.json from the standards' own PDFs, so no test vector is typed or remembered:
//   node scripts/crypto-vectors.mjs <dir with the PDFs>
// Needed in <dir> (NIST downloads):
//   NIST.FIPS.197-upd1.pdf   https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.197-upd1.pdf              (Appendix B, the cipher example)
//   NIST.FIPS.180-4.pdf      https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf                (K constants, initial hash value)
//   nistspecialpublication800-38a.pdf  https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38a.pdf   (F.1.1 / F.1.2, ECB-AES128)
//   AES_Core128.pdf          https://csrc.nist.gov/csrc/media/projects/cryptographic-standards-and-guidelines/documents/examples/AES_Core128.pdf (round by round)
//   sha256.pdf               https://csrc.nist.gov/csrc/media/projects/cryptographic-standards-and-guidelines/documents/examples/sha256.pdf     (abc and the two-block message)
// The PDFs are inflated and their text operators read (no CMap handling: these files use plain encodings). Every parse is checked
// for its counts, so a layout surprise fails here instead of producing a short fixture.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/crypto-vectors.mjs <dir>');

function pdfText(file) {
  const buf = fs.readFileSync(path.join(dir, file)), s = buf.toString('latin1'), out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length, end = s.indexOf('endstream', start);
    if (end < 0) break;
    let txt;
    try { txt = zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); } catch { try { txt = zlib.inflateSync(buf.subarray(start, end - 1)).toString('latin1'); } catch { continue; } }
    if (!/BT/.test(txt)) continue;
    let page = '';
    const tok = /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj|(T\*|Td|TD|ET)/g;
    let t;
    while ((t = tok.exec(txt))) {
      if (t[1] !== undefined) {
        for (const p of t[1].matchAll(/\(((?:[^)\\]|\\.)*)\)|(-?\d+\.?\d*)/g)) { if (p[1] !== undefined) page += p[1].replace(/\\(.)/g, '$1'); else if (parseFloat(p[2]) < -200) page += ' '; }
      } else if (t[2] !== undefined) page += t[2].replace(/\\(.)/g, '$1');
      else page += '\n';
    }
    out.push(page);
  }
  return out.map((p, i) => `=== stream ${i}\n${p}`).join('\n');
}
const must = (c, msg) => { if (!c) throw new Error(msg); };
const hexBytes = (h) => { must(/^([0-9a-f]{2})+$/i.test(h), `not hex: ${h}`); return h.match(/../g).map((x) => parseInt(x, 16)); };
const wordsOf = (ws) => ws.map((w) => parseInt(w, 16) >>> 0);
const rowsToBytes = (t) => { const o = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o.push(t[4 * r + c]); return o; }; // a printed 4x4 matrix (rows) → bytes in input order

// ---- FIPS 197 Appendix B ----
// The diagram is two pages: rounds 1-5 (stream A) and rounds 6-10 with the output (stream B). The first page's text stops in the middle of
// round 5's key (its last row "34 5d b5 d5" is cut: "34 5"), so that one matrix is kept as null and the tests skip it; the key is
// checked in every other round and round 5's key is the one the NIST AES_Core128 example gives as well.
{
  const raw = pdfText('NIST.FIPS.197-upd1.pdf').split('=== stream').map((x) => x.replace(/\s+/g, ' ').replace(/^ \d+ /, ' '));
  const ia = raw.findIndex((x) => x.includes('The following diagram shows the values in the state array'));
  must(ia >= 0, 'App B page 1');
  const A = raw[ia], B = raw[ia + 1];
  const inp = /Input\s*=\s*((?:[0-9a-f]{2} ){16})/.exec(A), key = /Key\s*=\s*((?:[0-9a-f]{2} ){16})/.exec(A);
  must(inp && key, 'App B input/key');
  const toksA = A.slice(A.indexOf('input 1 2 3 4') + 'input 1 2 3 4'.length).match(/\b[0-9a-f]{2}\b/g);
  const toksB = B.replace(' 6 7 8 9 10 output ', ' ').match(/\b[0-9a-f]{2}\b/g);
  // page A: rounds 1-5, five 4x4 matrices each (the 25th is the cut key); page B: rounds 6-9 five each, round 10 four, then the output
  const mat = (toks, i) => (toks.length >= 16 * (i + 1) ? rowsToBytes(toks.slice(16 * i, 16 * i + 16).map((x) => parseInt(x, 16))) : null);
  const mats = [];
  for (let i = 0; i < 24; i++) mats.push(mat(toksA, i));
  mats.push(null); // round 5's key
  for (let i = 0; i < 25; i++) mats.push(mat(toksB, i));
  must(mats.slice(0, 24).every(Boolean) && mats.slice(25).every(Boolean), 'App B matrices');
  const rounds = [];
  for (let r = 0; r < 10; r++) {
    const k = r * 5;
    rounds.push(r < 9 ? { start: mats[k], sub: mats[k + 1], shift: mats[k + 2], mix: mats[k + 3], key: mats[k + 4] } : { start: mats[k], sub: mats[k + 1], shift: mats[k + 2], mix: null, key: mats[k + 3] });
  }
  const output = mats[9 * 5 + 4];
  var fips197 = { source: 'FIPS 197 (2023 update) Appendix B', input: hexBytes(inp[1].replace(/ /g, '')), key: hexBytes(key[1].replace(/ /g, '')), rounds, output };
}

// ---- SP 800-38A F.1 ----
{
  const t = pdfText('nistspecialpublication800-38a.pdf');
  const enc = t.slice(t.indexOf('F.1.1 ECB-AES128.Encrypt'), t.indexOf('F.1.2 ECB-AES128.Decrypt')).replace(/\s*\d+\s*(?=\n|$)/g, ' ');
  const key = /Key\s+([0-9a-f]{32})/.exec(enc)[1];
  const pt = [...enc.matchAll(/Plaintext\s+([0-9a-f]{32})/g)].map((m) => m[1]), ct = [...enc.matchAll(/Ciphertext\s+([0-9a-f]{32})/g)].map((m) => m[1]);
  must(pt.length === 4 && ct.length === 4, `F.1.1 counts ${pt.length} ${ct.length}`); // F.1.2 (decrypt) is the same four pairs read backwards; its page does not extract, so the tests decrypt F.1.1's ciphertexts
  var ecb = { source: 'SP 800-38A F.1.1 / F.1.2', key: hexBytes(key), plaintext: pt.map(hexBytes), ciphertext: ct.map(hexBytes) };
}

// ---- AES_Core128: round by round for F.1.1 block 1 ----
{
  const t = pdfText('AES_Core128.pdf').replace(/=== stream \d+/g, '');
  const head = t.slice(t.indexOf('ECB-AES128 (Encryption)'));
  const key = /Key is\s+([0-9A-F ]+?)\s*Plaintext is/.exec(head)[1].replace(/\s/g, '').toLowerCase();
  const first = head.indexOf('KeyAddition');
  const ws = (line) => hexBytes(line.replace(/\s/g, '').toLowerCase());
  const initial = ws(/KeyAddition\s+((?:[0-9A-F]{8}\s+){3}[0-9A-F]{8})/.exec(head.slice(first))[1]);
  const rounds = [];
  for (let r = 1; r <= 10; r++) {
    // round 10 has no "Round = 10" line in the document: it follows round 9's last KeyAddition
    const at = (n, from = 0) => head.indexOf(`Round = ${n}\n`, from);
    const k9 = head.indexOf('KeyAddition', at(9));
    const seg = r < 10 ? head.slice(at(r), at(r + 1)) : head.slice(k9 + 11, at(1, k9));
    const g = (name) => { const m = new RegExp(`${name}\\s+((?:[0-9A-F]{8}\\s+){3}[0-9A-F]{8})`).exec(seg); return m ? ws(m[1]) : null; };
    rounds.push({ sub: g('Substitution'), shift: g('ShiftRow'), mix: g('MixColumn'), key: g('KeyAddition') });
  }
  must(rounds.every((r, i) => r.sub && r.shift && r.key && (i === 9 ? !r.mix : r.mix)), 'AES_Core128 rounds');
  var core = { source: 'NIST AES_Core128 example (ECB-AES128 block 1)', key: hexBytes(key), initial, rounds };
}

// ---- FIPS 180-4 constants ----
{
  const t = pdfText('NIST.FIPS.180-4.pdf').split('\n');
  const i0 = t.findIndex((l) => l.startsWith('428a2f98')), i1 = t.findIndex((l, i) => i > i0 && l.includes('c67178f2'));
  const flat = t.slice(i0, i1 + 1).join('').replace(/\s/g, '');
  must(flat.length === 64 * 8, `K length ${flat.length}`);
  const K = wordsOf(flat.match(/.{8}/g));
  const iH = t.findIndex((l) => l.includes('6a09e667') && l.trim() === '6a09e667');
  const H = t.slice(iH, iH + 60).join(' ').match(/\b[0-9a-f]{8}\b/g).slice(0, 8);
  var sha = { source: 'FIPS 180-4 §4.2.2, §5.3.3', K, H0: wordsOf(H) };
}

// ---- NIST SHA-256 example (abc, the two-block message) ----
{
  const t = pdfText('sha256.pdf').replace(/=== stream \d+/g, '');
  // the PDF repeats its sections: take each sample's first appearance, cut at its first digest
  const parts = ['One', 'Two'].map((w) => { const i = t.indexOf(`${w} Block Message Sample`), j = t.indexOf('Message Digest is', i); return t.slice(i, j + 300); });
  must(parts.length === 2, 'sha example parts');
  const msgs = parts.map((p) => {
    const text = /Input Message:\s*"([^"]*)"/.exec(p)[1];
    const blocks = p.split('Block Contents:').slice(1).map((b) => {
      const w = [...b.matchAll(/W\[(\d+)\]\s*=\s*([0-9A-F]{8})/g)].filter((m) => +m[1] < 16).map((m) => m[2]);
      const rounds = [...b.matchAll(/t=\s*(\d+):((?:\s+[0-9A-F]{8}){8})/g)].map((m) => m[2].trim().split(/\s+/));
      const hs = [...b.matchAll(/H\[(\d)\]\s*=\s*([0-9A-F]{8})\s*\+\s*([0-9A-F]{8})\s*=\s*([0-9A-F]{8})/g)].slice(0, 8);
      must(w.length === 16 && rounds.length === 64 && hs.length === 8, `sha block counts ${w.length} ${rounds.length} ${hs.length}`);
      return { w: wordsOf(w), rounds: rounds.map(wordsOf), in: wordsOf(hs.map((h) => h[2])), out: wordsOf(hs.map((h) => h[4])) };
    });
    const digest = /Message Digest is\s+((?:[0-9A-F]{8}\s*){8})/.exec(p)[1].replace(/\s/g, '').toLowerCase();
    return { text, blocks, digest };
  });
  must(msgs[0].blocks.length === 1 && msgs[1].blocks.length === 2, 'sha example block counts');
  sha.messages = msgs;
}

fs.mkdirSync('tests/crypto', { recursive: true });
fs.writeFileSync('tests/crypto/vectors.json', JSON.stringify({ fips197, ecb, core, sha }, null, 1) + '\n');
console.log('wrote tests/crypto/vectors.json');
