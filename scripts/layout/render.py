# KLayout batch script: render the final GDS as a square tile pyramid (level z has 2^z x 2^z tiles).
# Run: klayout -zz -r render.py -rd gds=... -rd lyp=... -rd out=...
import os
import pya

lv = pya.LayoutView()
lv.load_layout(gds, 0)  # noqa: F821 (gds, lyp, out come from -rd)
if lyp and os.path.exists(lyp):  # noqa: F821
    lv.load_layer_props(lyp)  # noqa: F821
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
