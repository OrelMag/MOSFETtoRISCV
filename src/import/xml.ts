// A small XML reader for the importers (Digital's .dig, Logisim's .circ): elements, attributes, text, CDATA,
// comments and the five predefined entities plus numeric ones. DOM-free (Node has no DOMParser) and strict
// enough to refuse what is not XML, lenient about what the other tools write (no DTDs, no namespaces).

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Character data directly inside this element, concatenated (entities decoded). */
  text: string;
  parent: XNode | null;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? m;
  });
}

/** The document's root element; throws an Error naming what is wrong. */
export function parseXml(src: string): XNode {
  let i = 0;
  const root: XNode = { name: '#document', attrs: {}, children: [], text: '', parent: null };
  let cur = root;
  const fail = (msg: string): never => {
    const line = src.slice(0, i).split('\n').length;
    throw new Error(`XML line ${line}: ${msg}`);
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { cur.text += decodeEntities(src.slice(i)); break; }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      if (e < 0) fail('unterminated comment');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      if (e < 0) fail('unterminated CDATA');
      cur.text += src.slice(i + 9, e);
      i = e + 3;
    } else if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i + 2);
      if (e < 0) fail('unterminated processing instruction');
      i = e + 2;
    } else if (src.startsWith('<!', i)) {
      const e = src.indexOf('>', i + 2);
      if (e < 0) fail('unterminated declaration');
      i = e + 1;
    } else if (src[i + 1] === '/') {
      const e = src.indexOf('>', i);
      if (e < 0) fail('unterminated end tag');
      const name = src.slice(i + 2, e).trim();
      if (name !== cur.name) fail(`</${name}> closes <${cur.name}>`);
      cur = cur.parent!;
      i = e + 1;
    } else {
      const m = /^<([A-Za-z_:][-\w.:]*)/.exec(src.slice(i, i + 200));
      if (!m) fail('bad tag');
      const node: XNode = { name: m![1], attrs: {}, children: [], text: '', parent: cur };
      i += m![0].length;
      for (;;) {
        while (/\s/.test(src[i] ?? '')) i++;
        if (src[i] === '/' && src[i + 1] === '>') { i += 2; cur.children.push(node); break; }
        if (src[i] === '>') { i++; cur.children.push(node); cur = node; break; }
        const a = /^([A-Za-z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(i, i + 4096));
        if (!a) fail(`bad attribute in <${node.name}>`);
        node.attrs[a![1]] = decodeEntities(a![3] ?? a![4] ?? '');
        i += a![0].length;
      }
    }
  }
  if (cur !== root) fail(`<${cur.name}> is not closed`);
  const top = root.children;
  if (top.length !== 1) fail(top.length ? 'more than one root element' : 'no root element');
  top[0].parent = null;
  return top[0];
}

export const child = (n: XNode | undefined, name: string): XNode | undefined => n?.children.find((c) => c.name === name);
export const childrenNamed = (n: XNode | undefined, name: string): XNode[] => n?.children.filter((c) => c.name === name) ?? [];

/**
 * XStream writes a repeated object once and later as `<tag reference="../../entry[2]/rotation"/>`: a path from the
 * referencing element. Follows it (null when it leads nowhere).
 */
export function deref(n: XNode): XNode | null {
  const ref = n.attrs.reference;
  if (ref === undefined) return n;
  let at: XNode | null = n;
  for (const step of ref.split('/')) {
    if (!at) return null;
    if (step === '' || step === '.') continue;
    if (step === '..') { at = at.parent; continue; }
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(step);
    if (!m) return null;
    at = childrenNamed(at, m[1])[(m[2] ? +m[2] : 1) - 1] ?? null;
  }
  return at && at.attrs.reference !== undefined ? null : at;
}
