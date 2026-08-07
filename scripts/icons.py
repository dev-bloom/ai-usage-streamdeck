#!/usr/bin/env python3
"""
Generate the PNG assets the Stream Deck manifest requires.

Stream Deck wants each image at 1x and 2x, with the @2x suffix, and it looks
them up without an extension -- so `imgs/actions/meter/icon` must resolve to
both `icon.png` and `icon@2x.png`. Everything here is drawn from one ring-gauge
motif so the marketplace tile, the action list entry, and the default key face
read as the same plugin.
"""
import os
import math
import cairosvg

ROOT = os.path.join(os.path.dirname(__file__), "..", "com.alejo.claude-usage.sdPlugin", "imgs")
CORAL = "#d97757"
TRACK = "#3a3a46"
BG = "#0d0d11"


def arc(cx, cy, r, start_deg, sweep_deg):
    """Clockwise SVG arc path, angles measured from the positive x-axis."""
    sx = cx + r * math.cos(math.radians(start_deg))
    sy = cy + r * math.sin(math.radians(start_deg))
    ex = cx + r * math.cos(math.radians(start_deg + sweep_deg))
    ey = cy + r * math.sin(math.radians(start_deg + sweep_deg))
    large = 1 if sweep_deg > 180 else 0
    return f"M {sx:.2f} {sy:.2f} A {r} {r} 0 {large} 1 {ex:.2f} {ey:.2f}"


def gauge_svg(size, *, pct=72, stroke_ratio=0.14, bg=None, radius_ratio=0.34,
              track=TRACK, fill=CORAL, rounded=False):
    """A 270-degree ring gauge, opening at the bottom, filled to `pct`."""
    cx = cy = size / 2
    r = size * radius_ratio
    stroke = size * stroke_ratio
    start, sweep = 135, 270
    path = arc(cx, cy, r, start, sweep)
    length = (sweep / 360) * 2 * math.pi * r
    filled = length * pct / 100

    background = ""
    if bg:
        rx = size * 0.14 if rounded else 0
        background = f'<rect width="{size}" height="{size}" rx="{rx:.1f}" fill="{bg}"/>'

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  {background}
  <path d="{path}" fill="none" stroke="{track}" stroke-width="{stroke:.2f}" stroke-linecap="round"/>
  <path d="{path}" fill="none" stroke="{fill}" stroke-width="{stroke:.2f}" stroke-linecap="round"
        stroke-dasharray="{filled:.2f} {length - filled + 1:.2f}"/>
</svg>'''


def write(rel_path, svg, size):
    """Write `name.png` at `size` and `name@2x.png` at double resolution."""
    out = os.path.normpath(os.path.join(ROOT, rel_path))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{out}.png",
                     output_width=size, output_height=size)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{out}@2x.png",
                     output_width=size * 2, output_height=size * 2)
    print(f"  {rel_path}.png / @2x  ({size}px)")


# Marketplace tile: filled dark background, generous margins.
write("plugin/marketplace", gauge_svg(288, bg=BG, rounded=True, radius_ratio=0.30), 288)

# Category icon in the actions sidebar: no background, thick enough to survive 28px.
write("plugin/category-icon", gauge_svg(28, stroke_ratio=0.17, radius_ratio=0.32,
                                        track="#6f6f7a", fill="#ffffff"), 28)

# Action list entry: same treatment, smaller still.
write("actions/meter/icon", gauge_svg(20, stroke_ratio=0.19, radius_ratio=0.31,
                                      track="#6f6f7a", fill="#ffffff"), 20)

# Default key face, shown for the instant before the first render lands.
write("actions/meter/key", gauge_svg(72, bg=BG, rounded=True, pct=0,
                                     stroke_ratio=0.11, radius_ratio=0.33), 72)

print("icons written")
