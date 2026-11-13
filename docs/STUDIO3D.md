# The studio renderer: API (Rock; frozen 2026-11-12, brought up to date with batch 3, 2026-11-13)

The studio renderer and its kit draw every 3D model on the site. This file is the API as it ships. A change to it
goes through Rock, so the conversions do not each grow their own engine; the additions since the freeze are the ones
the conversions needed, each opt-in (marked *since the freeze*).

Everything here is in the code with tests. Nothing in this file is proposed: §8 lists what is left out.

- Engine: `src/gl/studio.ts`. The stage: `src/widgets/studiostage.ts`. The kit, DOM-free and tested in Node: `src/gl/kit/`.
- Models: every entry of `widgets/models3dindex.ts` (the codex's model index and the smoke's 3D routes read it). Each is
  `<name>3d.ts` (the tiny lazy entry a chapter imports, through `modelhost.ts` `lazyModel` / `withModel`), `<name>3dview.ts`
  (the stage and the model's controls) and `<name>3dkit.ts` (DOM-free: geometry, materials, `xModel(state) → Model3`), with
  `tests/model-<name>.test.ts` holding the drawing to its numbers. A `<name>3dparts.ts` / `3dgeom.ts` beside it is the
  model's measured data and arithmetic, shared by the kit and its tests.
- Phase 0 (`modelstage.ts`, `fromParts`, `looks.ts`, `?studio3d`) is gone: the last model on it was converted in batch 3.
- Tests: `tests/gl-geo.test.ts`, `gl-kit-api.test.ts`, `models3d.test.ts` (the flat view against the camera), `models3dindex.test.ts`, one `model-*.test.ts` per model.

## 1. How a model is written

A model is a function `(state, look) → Model3`. It is DOM-free: geometry from the kit, materials from `M`, items placed
in millimetres, plus labels, cuts and tour beats. Its view hands that function to `studioStage({ build })` and calls
`stage.refresh()` when the state changes. Rebuilding is cheap (0.08 ms): geometry is cached by identity, so build the
`Geo`s once (memoize per detail level) and make new items every time.

What moves each frame does **not** rebuild:
- rigid parts go through `stage.move(moves)`;
- bending parts through `refresh(geo, next)`;
- particles through `stage.instances(key, …)`.

```ts
const stage = studioStage({
  aria: 'A telephone relay in 3D', home: RELAY_HOME, limits: { minDist: 25, maxDist: 400 },
  note: 'Gaps drawn ×6 at the pole …',          // what the drawing exaggerates; the stage adds the controls' help
  build: (detail) => relayModel({ detail, i: shown.i, nc: ncClosed(shown), no: shown.closed }),
});
stage.slot.append(myControls); stage.chips.append(stateChip);
// per sample:
bendBlade('full', q); stage.move(relayPose(q)); stage.refresh();
```

## 2. Geometry: `gl/kit/geo.ts`

`Geo { name, positions, normals, indices: Uint32Array, min, max, colors?, uvs?, rev? }` (mm, y up).

| Function | What for |
|---|---|
| `lathe(profile [r, y][], { seg, crease, from, to })` | Bulbs, cans, cores, pins, domes, partial turns |
| `sweep(path, section, { bend, closed, caps })` | Any section along a path. Its frame is parallel-transported, so for a path starting along +x in the xy plane, u = +y and v = +z |
| `tube(path, r, { sides ≥ 3, bend, closed, caps })` | Wires, leads, coils, letters |
| `helix({ r \| rx, rz, pitch, from, to, at, perTurn, phase })` | Coil and grid paths for `tube` |
| `filletPath(pts, r, steps)` | Rounded corners on a path |
| `extrude(outline [x, z][], height)` | Plates and brackets (either winding) |
| `bentSheet(line, t, height)` | A sheet bent along a polyline (mitred) |
| `roundedBox(w, h, d, r, seg)` | Anything boxy, centred |
| `sphere`, `torus`, `plane(w, d)` (with UVs) | |
| `surface(fn(u, v) → Vec3, nu, nv)` | Parametric surfaces with UVs and outward normals: lobes, membranes, height fields |
| `ribbon(left[], right[], normals[])` | One-sided strips: ink, traces, flat cables |
| `transform(g, mat4)`, `merge(list, name)` | Place, then merge into one draw |
| `along(path, s)` | A point at fraction s by length: particles riding a wire |
| `refresh(g, next)` | **Live deform.** Copies `next` into `g` in place: positions, normals, colours and bounds; same counts or it throws; `rev` bumped, and the engine re-uploads with `bufferSubData` |
| `paint(g, fn(p) → rgb)` | **Per-vertex colour**, multiplied into the material's base; use with `heatRamp` / `divergingRamp` |
| `triangulate`, `circle`, `normalMatrix`, `triangles` | Helpers |

Lettering is in `gl/kit/text.ts`:
- `strokeGeo(text, surface, cx, cy, size, weight, lift, { flat })` sets the stroke font as real geometry on any `Surface`: `onCylinder(r, a0)` or `onPlane(o, right, up, n)`.
- `flat: true` lays flat ink in the surface, with the surface's normals and a tiny lift. Use it for a print on glass or a label.
- Without `flat`, the strokes are round, standing proud of the surface: engraved, cast or raised lettering.

## 3. Materials: `gl/kit/materials.ts`

```ts
Material { base, metal, rough, transmit?, tint?, emit?, glow?, bloom?, coat?, beam?, data?: DataTex, label? }
```
- A colour is RGB or a CSS token (`'--rl-glow'`), resolved in the page's theme.
- `transmit` ≥ 0.9: glass drawn over a copy of the frame (refraction-ish).
- 0.3 ≤ `transmit` < 0.9: a blended translucent layer, sorted far to near (`Item.order` breaks ties for nested layers). Mica, oxide, depletion layers and a print are drawn this way.
- `emit` × `glow` is the surface's own light. `bloom` (default 1) scales only what feeds the halo. Use it so a hot surface stays its colour with its turns shaded while the halo carries the brightness: the triode caps the surface at 1.1 and sets bloom to the rest.
- `beam: true` (or `M.beam(colour, k)`): additive, with no depth write. Use it for rays, glows and exposure light.
- `data: DataTex { w, h, pixels: Uint8Array, rev, mode: 'emit' | 'albedo' | 'mask', smooth? }`: **one dynamic data texture** on a surface with UVs (`plane`, `surface`).
  - Bump `rev` to re-upload.
  - `mask` discards pixels where the value is 0: holes in a card or a mask plate.
  - It is for data (a CRT's spot, a sensor's picture), not imagery.
  - No model uses it yet. It has been rendered on a page as emit and mask quads, with a `rev` change re-uploading, and as instances; that check found and fixed the instanced path dropping UVs and colours.

Presets in `M`:
- Metals: steel, nickel, nickelCarbonized, copper, brass, gold, aluminium, tungsten, solder, getterFlash, silver, nickelSilver, permalloy, mercury.
- Glass and translucent: glass, glassAmber, quartz, mica, oxide.
- Ceramics and plastics: cement, ceramic, porcelain, bakelite, phenolicPaper, enamel, rubber, plasticMatte, plasticGloss, epoxy.
- Semiconductor and coatings: silicon, polysilicon, silicide, silverEpoxy, cathodeOxide.
- Wood and card: oak, card.
- Functions:
  - `paint(colour, rough)`;
  - `beam(colour, k)`;
  - `oxideFilm(nm)`: SiO₂'s interference colour at that thickness;
  - `make({...})`;
  - `tint(m, base)`;
  - `glow(m, emit, k)`.

Heat:
- `heatColour(T)` is the black body's colour (a cathode at 1023 K is orange-red).
- `heatGlow(T)`: nothing below 700 K, rising steeply above it.
- Ramps: `heatRamp(x)`, `divergingRamp(x)`.

## 4. The model: `gl/kit/scene.ts`

```ts
Item { geo, mat, at?, rot?, scale?, name?, info?: { dim, source, note }, group?, explode?: Vec3,
       cut?: 'section' | 'open' | 'none', shadow?, order? }
Model3 { items, cuts?: { planes: Cut[]; open: number[] }, anchors?: StudioAnchor[], beats?: Beat[], floor?,
         lights?: GlowLight[], look?: { exposure?, keyDir?, haze? }, flatOrder?: 'faces' | 'items', cutLabels? }
Beat { title, text, view, frame?: string[], show?, hide?, explode?, cut?, labels?: boolean }
StudioAnchor { text, p, side, n, minor?, prio?, on?: string, under?: boolean, gutter?: 'l' | 'r', whenCut?: boolean }
GlowLight { p, colour, power, range, on? }        // up to 4: a hot part lighting its neighbours, no shadow
Moves = ReadonlyMap<nameOrGroup, Mat4>             // applied after the item's own placement
```
Items:
- **Names** are what a hover card shows. Items with the same name are one part.
- **Groups** drive explode, focus, the tour and moves.

Cuts:
- Each cut plane removes the side where n·p > d.
- Two planes remove only where both do (a wedge).
- `open` is where each plane sits when nothing is cut.
- Closed shells are capped on the cut. `cut: 'open'` leaves a thin shell uncapped; `'none'` is never cut.

Moves:
- `stage.move(moves)` per frame for rigid motion. The armature turns about its hinge with `turnAbout(HINGE, −θ)`.
- A non-uniform scale is allowed: the relay's spring stretches this way.
- Picking, labels (`anchorAt(m, a, k, moves)`: an anchor `on` a moved part rides with it), the shadow and the flat view all follow.

Beats:
- `frame` fits those parts to the canvas from the beat's view direction.
- `show` dims the rest. `hide` hides parts (a level of detail, or a second variant).
- `labels: false`: no names in that beat (a field of copies).

Labels (*since the freeze*):
- `gutter` forces the side a name goes to; otherwise the side its point is nearer.
- `prio`: which name gives way when two cannot both be shown.
- `Model3.cutLabels`: a name whose point the cut has taken away hides.
- `whenCut: true`: a name only while the model is cut more than half (a name on the section); `false`: only while it is not.
  Off-state names also leave the phone list.
- An anchor `on` a group hides with it (a beat's `hide`) and follows its explode.

`flatOrder: 'items'` (*since the freeze*): the flat fallback paints whole items back to front, for models of thin stacked layers.

Framing:
- `fitView(box, yaw, pitch, fov, aspect, margin)` puts every corner inside the view, tightly.
- `aspectOf(box, yaw, pitch)` is the model's width over its height from the home direction.

Other functions: `boundsOf`, `boundsOfNamed`, `pick(m, o, d, knobs, { moves, hidden, glass })` (a CPU ray against triangles), `itemMatrix`, `cutsAt`, `isCut`, `explodeOffset`.

## 5. The stage: `widgets/studiostage.ts`

`studioStage({ aria, home, build, fit?, homeFrame?, homeRadius?, aspect?, hidden?, scaleBar?, onBeat?, knobs?, onKnobs?, limits?, note? })`
returns `{ el, slot, chips, hint, refresh, goTo, look, instances, endTour, move, studio, isFlat, rgb, knobs, setKnobs, destroy }`.

Options beyond the freeze, each for a case the conversions met:
- `homeFrame` fits home to some parts (the subject, not its wiring); `homeRadius` to a sphere (a round model).
- `aspect` fixes the canvas's shape (a model whose own aspect would mislead, or a host that moves the camera with `goTo`).
- `hidden`: parts hidden outside the tour and in beats that do not say.
- `scaleBar(len)`: a 1-2-5 scale bar under the canvas following the zoom, labelled in the model's units.
- `onBeat(i)` is called before the beat is read, so a host can set its state for the beat (−1: the tour ended).
- `knobs` opens the stage at a cut or explode; `onKnobs` follows the sliders.

Methods beyond the freeze:
- `goTo(view)` eases to a view and makes it home: a resize keeps it (it is never refitted), and a `refresh()` during the ease does not undo it.
- `look(view)` puts the camera at a view now (a camera following a moving part).
- `endTour()` leaves the tour (a host whose model changes under it); `setKnobs` moves the sliders.

**Layout, top to bottom:** the canvas, the numbered list, the tour caption, `slot` (the model's own controls), the bar (Cutaway, Explode, Back, Tour, Reset view), the hint.
- **Aspect:** the canvas takes the model's aspect from `aspectOf`, clamped to 0.62–1.9, but is never under 240 px tall: a long, low model (the relay) gets room above and below rather than a strip. Its width is held so a tall model fits about 78 % of the screen's height.
- **Home view:** refitted with `fitView` whenever the canvas size changes and the camera is home.
- **Corner tools:** turn, save image, full screen.

**Labels: picked by measured width, not by device.**
- **Gutter form:** the names sit in gutters beside the canvas, with leaders to the parts. The gutters are as wide as the longest name.
- **Badge form:** numbered badges sit at the canvas edges with leaders, and the names go in a list under it. This form is used when the canvas between the gutters would be under 260 px wide.
- The badges spread so they never clump. An anchor whose face turns away is dimmed.

**Hover and pick:**
- Hovering a part rims it and shows a card with its name, material, size, note and source. A click keeps the card.
- Tab walks the parts.

**Fallback:** with no WebGL2, or after a lost context, the same model is drawn flat in SVG, with moves, cuts and labels (`?flat3d` forces it).
The flat view (`gl/parts.ts` `flatView`) looks from where `OrbitCamera.eye()` puts the eye: (sin yaw, cos yaw) in xz, right-hand
(cos yaw, 0, −sin yaw). Before batch 3 it was mirrored in yaw, so a flat drawing with a home yaw other than 0 showed the far side.

**`?stats`:** an overlay with CPU ms, GPU ms (where a timer query exists), draws, triangles, megapixels and the quality tier. It is in the shipped code path.

## 6. The engine: `gl/studio.ts`

`createStudio(canvas, camera, opts)` returns a `Studio`:
- `setModel(model, resolve)`, `setKnobs({ explode, cut })`, `knobs()`.
- `move(moves)`, `moves()`, `setHidden(names)`.
- `setInstances(key, geo, mat, data, count?, casts?)`.
- `setFocus`, `setHover`, `setEnv({ sky, ground, key, dir, exposure, accent })`, `setFlags(...)`.
- `invalidate`, `render`, `project`, `ray`, `last()` (the frame's stats), `destroy`.

What it draws: hand-written WebGL2.
- **Surfaces:** GGX with a clear coat, lit by a procedural studio environment and one key light (`env.dir` sets its direction).
- **Shadows:** a PCF shadow map fitted to the model and redrawn only when something moved.
- **Glass:** far sides blended and sorted far to near, near sides over a copy of the frame.
- **Anti-aliasing:** MSAA, with two render targets (colour, glow).
- **Bloom:** half- and quarter-resolution blurs of the glow.
- **Tone:** ACES.
- **Frames:** drawn on demand only.

**Adaptive quality.** While frames come back to back, if the median interval stays over 24 ms the engine steps down one tier at a time and never back within a page view. Each step and what it drops:

1. MSAA 4 → 2: edges a little rougher.
2. Shadow filter 3 × 3 → 2 × 2: harder shadow edges.
3. MSAA off: jagged edges at 1 device pixel per CSS pixel.
4. Refraction off: glass stops bending what is behind it.
5. Bloom off: the glow loses its halo; colours are unchanged.

## 7. Costs (production build, gzip; batch 3, 2026-11-13, this machine)

Measured by E:/audit/release/3d/integ/sweep.mjs over every model (the table: E:/audit/release/3d/INTEG.md).

- **Shared, paid once a page view:** the engine (studio.ts) 10.7 KB, the stage 7.9, geometry 4.3, scene 1.9, the lazy entry
  (modelhost) 2.2.
- **Each model's own chunks:** 8.1 to 22.3 KB, median 11.9 (44 models; Enigma the largest, with its wiring and stroke font).
- **Frame time while dragging (?stats, median):** 0.2 to 0.5 ms CPU and 0.1 to 0.3 ms GPU at 1440 px; 0.7 to 2.5 ms CPU at
  390 px with the CPU throttled 4× (GPU unchanged). Shadows are redrawn only after a change.
- **Rebuilds:** model rebuild about 0.1 ms (geometry cached by identity); pick 0.4 ms; a shadow redraw about 1.4 ms.
- **A real phone has not been measured.** ?stats is how to read one.

## 8. Not in this API (and what to do instead)

- **Picking on instances:** particles are not pickable. Name the part they ride on.
- **Textures from images:** none, by choice. Lettering is geometry. Wood and metal grain is left out: on these sizes a roughness change carries the material, and grain would need a texture path the honesty rules would then have to police.
- **A second key light, or shadows from the glow lights:** use `GlowLight`s for fill.
- **Two independent views:** two stages, a WebGL context each. Browsers allow about 8–16 per page.
- **A ring or loop mode in `pick`:** one hit, the nearest.
- **A cap exactly on the cut plane:** a cut solid's cap is shaded where the ray first meets an inner back face, not at the plane.
  Two solids sharing a face then z-fight on the section (a shelf look, patchy colour). Inset touching solids a hair
  (the NAND string uses 0.2 nm) where they show on a cut.

## 9. Converting a model (the order that worked twice)

1. Move the model's constants and lever / physics arithmetic into a DOM-free module both views can import. For the relay this is `relay3dgeom.ts`; it avoids a cycle.
2. Write `<model>3dkit.ts`:
   - build its `Geo`s once per detail level;
   - `xModel(state, look) → Model3`, with names, `info.source` on what is measured, anchors and four to seven beats;
   - a `pose(state)` that returns `Moves` and refreshes what bends.
3. Write a test that holds the poses to the physics: the relay's stud gap and blade tip, the triode's electrodes.
4. Hand the view `studioStage({ build })`. Keep its controls in `slot`, its chips in `chips`, its side panel beside it.
5. Shoot dark, light and phone, and check: the labels' form, the tour's framing, the glow. Then delete the old drawing code.
