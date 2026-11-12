# The studio renderer: API, frozen (Rock, 2026-11-12)

The studio renderer and its kit replace box-and-cylinder for every 3D model on the site. This file is the API as
built and tested on `feat/studio3d`. **It is frozen.** A model is converted with what is listed here; a change to
it goes through Rock, so 34 conversions do not each grow their own engine.

Everything here is in the code with tests. Nothing in this file is proposed: §8 lists what is left out.

- Engine: `src/gl/studio.ts`. The stage: `src/widgets/studiostage.ts`. The kit, DOM-free and tested in Node: `src/gl/kit/`.
- Models on it:
  - the triode (`widgets/triode3dkit.ts` + `triode3dnext.ts`), shipped by default;
  - the relay (`widgets/relay3dkit.ts` + `relay3dgeom.ts`, driven by `relay3dview.ts`), shipped by default, moved by `phys/relay.ts`;
  - the other 32, unchanged in geometry, under `?studio3d` (phase 0, §6).
- Tests: `tests/gl-geo.test.ts`, `gl-kit-api.test.ts`, `triode3dkit.test.ts`, `relay3dkit.test.ts`, `model-relay.test.ts`, `models3dindex.test.ts`.

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
         lights?: GlowLight[], look?: { exposure?, keyDir? } }
Beat { title, text, view, frame?: string[], show?, hide?, explode?, cut? }
StudioAnchor { text, p, side, n, minor?, on?: string, under?: boolean }
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

Framing:
- `fitView(box, yaw, pitch, fov, aspect, margin)` puts every corner inside the view, tightly.
- `aspectOf(box, yaw, pitch)` is the model's width over its height from the home direction.

Other functions: `boundsOf`, `boundsOfNamed`, `pick(m, o, d, knobs, { moves, hidden, glass })` (a CPU ray against triangles), `itemMatrix`, `cutsAt`, `isCut`, `explodeOffset`.

## 5. The stage: `widgets/studiostage.ts`

`studioStage({ aria, home, fit?, limits, note, build })` returns `{ el, slot, chips, hint, refresh, instances, move, studio, isFlat, rgb, destroy }`.

**Layout, top to bottom:** the canvas, the numbered list, the tour caption, `slot` (the model's own controls), the bar (Cutaway, Explode, Back, Tour, Reset view), the hint.
- **Aspect:** the canvas takes the model's aspect from `aspectOf`, clamped to 0.62–1.9. Its width is held so a tall model fits about 78 % of the screen's height.
- **Home view:** refitted with `fitView` whenever the canvas size changes and the camera is home.
- **Corner tools:** turn, save image, full screen.

**Labels: picked by measured width, not by device.**
- **Gutter form:** the names sit in gutters beside the canvas, with leaders to the parts. The gutters are as wide as the longest name.
- **Badge form:** numbered badges sit at the canvas edges with leaders, and the names go in a list under it. This form is used when the canvas between the gutters would be under 260 px wide or under 240 px tall.
- The badges spread so they never clump. An anchor whose face turns away is dimmed.

**Hover and pick:**
- Hovering a part rims it and shows a card with its name, material, size, note and source. A click keeps the card.
- Tab walks the parts.

**Fallback:** with no WebGL2, or after a lost context, the same model is drawn flat in SVG, with moves, cuts and labels (`?flat3d` forces it).

**`?stats`:** an overlay with CPU ms, GPU ms (where a timer query exists), draws, triangles, megapixels and the quality tier. It is in the shipped code path.

## 6. The engine: `gl/studio.ts`

`createStudio(canvas, camera, opts)` returns a `Studio`:
- `setModel(model, resolve)`, `setKnobs({ explode, cut })`, `knobs()`.
- `move(moves)`, `moves()`, `setHidden(names)`.
- `setInstances(key, geo, mat, data, count?, casts?)`.
- `showParts(fromParts(parts, look), resolve)`.
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

**Phase 0.** `fromParts(parts, look)` maps today's box and cylinder parts to instance sets, grouped by finish (matte, satin, metal, chosen by `spec`). See-through parts become glass items.
- Each model's look is data in its own file: `look: LOOKS.machine | silicon | lab | field` in its `modelStage` call (`gl/kit/looks.ts`, a few numbers and no imports).
- A look holds the exposure, the key light's direction, and what each finish becomes.
- `lookOf(family, own)` adds a model's own adjustments to its family.
- All 32 render under `?studio3d` with no errors.

## 7. Costs (production build, gzip; this machine)

- **Triode, the first open:** about 48 KB.
  - studio 11.9 KB, stage 8.4, triode3dnext 9.9, triode3dview (shared physics and plots) 10.1, kit geometry 3.8, loader and CSS.
  - Today's close-up was 16 KB.
- **Relay, the first open:** about 40 KB (its view 13.4 KB with the kit, plus the shared studio, stage and geometry).
- **Frame time:** 0.2–0.6 ms CPU per frame for both models at home (`?stats`). The triode is 67 draws and 87k triangles, the relay 36 draws and 22k.
- **Rebuilds:**
  - model rebuild 0.08 ms;
  - geometry built once (the triode's 44 ms);
  - pick 0.4 ms;
  - shadow redraw about 1.4 ms, only after a change.
- **A real phone has not been measured.** `?stats` is how to read one.

## 8. Not in this API (and what to do instead)

- **Picking on instances:** particles are not pickable. Name the part they ride on.
- **Textures from images:** none, by choice. Lettering is geometry. Wood and metal grain is left out: on these sizes a roughness change carries the material, and grain would need a texture path the honesty rules would then have to police.
- **A second key light, or shadows from the glow lights:** use `GlowLight`s for fill.
- **Two independent views:** two stages, a WebGL context each. Browsers allow about 8–16 per page.
- **A ring or loop mode in `pick`:** one hit, the nearest.

## 9. Converting a model (the order that worked twice)

1. Move the model's constants and lever / physics arithmetic into a DOM-free module both views can import. For the relay this is `relay3dgeom.ts`; it avoids a cycle.
2. Write `<model>3dkit.ts`:
   - build its `Geo`s once per detail level;
   - `xModel(state, look) → Model3`, with names, `info.source` on what is measured, anchors and four to seven beats;
   - a `pose(state)` that returns `Moves` and refreshes what bends.
3. Write a test that holds the poses to the physics: the relay's stud gap and blade tip, the triode's electrodes.
4. Hand the view `studioStage({ build })`. Keep its controls in `slot`, its chips in `chips`, its side panel beside it.
5. Shoot dark, light and phone, and check: the labels' form, the tour's framing, the glow. Then delete the old drawing code.
