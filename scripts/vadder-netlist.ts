// Rewrites src/hdl/vadder.net.json: the Verilog adder (src/hdl/vadder.ts) through Yosys onto NANDs. Needs @yowasp/yosys.
//   node node_modules/vite-node/vite-node.mjs scripts/vadder-netlist.ts
import { writeFileSync } from 'node:fs';
import { vadderFromYosys } from '../tests/vaddergen';

const net = await vadderFromYosys();
writeFileSync(new URL('../src/hdl/vadder.net.json', import.meta.url), JSON.stringify(net, null, 1) + '\n');
console.log(`${net.cells.length} cells`);
