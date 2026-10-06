# KLayout batch script: render the final GDS as a square tile pyramid (level z has 2^z x 2^z tiles).
# Run: klayout -zz -r render.py -rd gds=... -rd lyp=... -rd out=...
# Only the layers that tell the story are drawn, with fixed colours (sky130 GDS layer numbers):
# diffusion and poly (the transistors), local interconnect, and the five metal layers.
import os
import pya

LAYERS = [
    # source, colour, dither pattern (0 solid, 1 hollow, 2 dotted, 3 coarse dots, 5 hatch, 9 cross)
    ("65/20", 0x22c55e, 3),   # diff
    ("66/20", 0xef4444, 2),   # poly
    ("67/20", 0xa78bfa, 3),   # li1
    ("68/20", 0x3b82f6, 2),   # met1
    ("69/20", 0xf472b6, 5),   # met2
    ("70/20", 0x22d3ee, 5),   # met3
    ("71/20", 0xfacc15, 9),   # met4
    ("72/20", 0xfb923c, 9),   # met5
]

lv = pya.LayoutView()
lv.load_layout(gds, 0)  # noqa: F821 (gds, out come from -rd)
lv.clear_layers()
for src, colour, dither in LAYERS:
    lp = pya.LayerPropertiesNode()
    lp.source = src
    lp.fill_color = colour
    lp.frame_color = colour
    lp.dither_pattern = dither
    lv.insert_layer(lv.end_layers(), lp)
lv.max_hier()
lv.set_config("background-color", "#0b0d12")
lv.set_config("grid-visible", "false")
lv.set_config("text-visible", "false")
top = lv.active_cellview().cell
bb = top.dbbox()
side = max(bb.width(), bb.height())
x0, y0 = bb.left, bb.bottom
LEVELS, TILE = 5, 512
for z in range(LEVELS):
    n = 2 ** z
    d = os.path.join(out, str(z))  # noqa: F821
    os.makedirs(d, exist_ok=True)
    for ix in range(n):
        for iy in range(n):
            # iy counts from the top, like screen coordinates
            box = pya.DBox(x0 + ix * side / n, y0 + side - (iy + 1) * side / n, x0 + (ix + 1) * side / n, y0 + side - iy * side / n)
            lv.zoom_box(box)
            lv.save_image(os.path.join(d, "%d_%d.png" % (ix, iy)), TILE, TILE)
with open(os.path.join(out, "tiles.json"), "w") as f:  # noqa: F821
    f.write('{"levels": %d, "tile": %d, "x0": %f, "y0": %f, "side": %f}' % (LEVELS, TILE, x0, y0, side))
print("rendered %d levels" % LEVELS)
