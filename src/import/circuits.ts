// The circuit readers the sandbox's Import takes (picked or dropped): each registered as a file importer with the
// summary dialog (importui.ts). Imported by editor/features.ts.

import { registerFileImporter } from '../editor/fileui';
import { testsOf } from '../editor/testtable';
import { importDigital, isDigitalFile } from './digital';
import { registerCircuitReader } from './importui';
import { importLogisim, isLogisimFile, logisimVectors } from './logisim';

const isVectors = (name: string) => /\.txt$/i.test(name);

// A Logisim test-vector file alone becomes a table on the open chip (picked or dropped with its .circ, the reader
// attaches it to the main circuit). Registered first: a lone .txt is not a circuit.
registerFileImporter({
  accept: ['.txt'],
  takes: (name) => isVectors(name),
  run: (ed, name, text) => {
    const v = logisimVectors(text);
    if ('error' in v) return void ed.toast(`${name}: ${v.error}`, 'err');
    const base = name.replace(/^.*[\/]/, '').replace(/\.txt$/i, '');
    ed.edit((d) => ({ ...d, tests: [...testsOf(d), { name: base, src: v.src }] }));
    ed.toast(`${name}: a test table on ${ed.doc.name} (Tests). Ctrl+Z undoes it`);
  },
});
registerCircuitReader({ tool: 'Digital', accept: ['.dig'], takes: isDigitalFile, read: importDigital });
registerCircuitReader({ tool: 'Logisim', accept: ['.circ'], takes: (name, text) => isLogisimFile(name, text) || isVectors(name), read: importLogisim });
