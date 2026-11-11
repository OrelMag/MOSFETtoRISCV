# Transparent boxes: design and prototype

Design only; nothing here is part of the site. Read `DESIGN.md`; `mockup.html` shows it with real renders.

The mockup reads its pictures from the SVGs next to it (`top-*.svg`, `alu-inside-*.svg`), which are not committed
(1.4 MB). The author's copy, with every SVG and measurement, is in `E:/audit/ship/transparent/`. To make them again:

```bash
node node_modules/vite-node/vite-node.mjs docs/transparent/route-levels.ts --json <dir>/route-levels.json   # routing, cold and warm
node node_modules/vite-node/vite-node.mjs docs/transparent/shape-ratios.ts                                   # symbol against inside
node node_modules/vite/bin/vite.js build --config docs/transparent/proto/vite.config.ts                      # the prototype page
node docs/transparent/proto/drive.mjs .proto-dist <dir>      # headless Chrome: draw-levels.json and the SVGs (serves itself)
node docs/transparent/proto/shot.mjs <dir> mockup.html <prefix> 1280,light 1280,dark 390,light            # screenshots
```

`proto/main.ts` uses the site's own SchematicView, ViewCtx and svgImage; its build goes to `.proto-dist/` (not committed).
