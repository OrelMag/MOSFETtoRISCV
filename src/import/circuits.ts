// The circuit readers the sandbox's Import takes (picked or dropped): each registered as a file importer with the
// summary dialog (importui.ts). Imported by editor/features.ts.

import { importDigital, isDigitalFile } from './digital';
import { registerCircuitReader } from './importui';

registerCircuitReader({ tool: 'Digital', accept: ['.dig'], takes: isDigitalFile, read: importDigital });
