// Verilog as highlighted HTML (the sandbox's Verilog pane, editor/hdlui.ts, and the campaign's Verilog twins). DOM-free.

const KEYWORDS = new Set(('module endmodule input output inout wire reg logic integer parameter localparam assign always always_ff ' +
  'always_comb always_latch initial begin end if else case casez casex endcase default for while posedge negedge or and not ' +
  'generate endgenerate genvar function endfunction task endtask signed unsigned typedef enum struct packed').split(' '));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Verilog as highlighted HTML, a string per line (block comments carried across lines). */
export function highlight(text: string): string[] {
  let inBlock = false;
  return text.split('\n').map((line) => {
    let out = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        const j = e < 0 ? line.length : e + 2;
        out += `<i class="cm">${esc(line.slice(i, j))}</i>`;
        if (e >= 0) inBlock = false;
        i = j;
        continue;
      }
      const rest = line.slice(i);
      let m: RegExpExecArray | null;
      if (rest.startsWith('//')) { out += `<i class="cm">${esc(rest)}</i>`; break; }
      if (rest.startsWith('/*')) { inBlock = true; out += '<i class="cm">/*</i>'; i += 2; continue; }
      if ((m = /^"(?:\\.|[^"\\])*"?/.exec(rest))) { out += `<i class="st">${esc(m[0])}</i>`; i += m[0].length; continue; }
      if ((m = /^(?:\d+)?'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|^\d[\d_]*(?:\.\d+)?/.exec(rest))) { out += `<i class="nm">${esc(m[0])}</i>`; i += m[0].length; continue; }
      if ((m = /^\$?[A-Za-z_][\w$]*/.exec(rest))) {
        const w = m[0];
        out += KEYWORDS.has(w) ? `<i class="kw">${w}</i>` : w.startsWith('$') ? `<i class="sys">${esc(w)}</i>` : esc(w);
        i += w.length;
        continue;
      }
      out += esc(line[i]);
      i++;
    }
    return out;
  });
}
