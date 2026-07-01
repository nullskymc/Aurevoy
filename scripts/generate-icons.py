#!/usr/bin/env python3
"""
Generate all platform icon assets from a single high-resolution source PNG.
Place a 2048x2048 icon.png in apps/desktop/src-tauri/icons/ and run this script.
Requires: pip install Pillow
"""

from PIL import Image
import struct
import io
import os
import sys

ICONS_DIR = os.path.join(
    os.path.dirname(__file__),
    "..",
    "apps/desktop/src-tauri/icons",
)
SOURCE = "icon.png"

# PNG sizes for Windows Store / bundle
PNG_SIZES = {
    "32x32.png": (32, 32),
    "48x48.png": (48, 48),
    "64x64.png": (64, 64),
    "128x128.png": (128, 128),
    "128x128@2x.png": (256, 256),
    "256x256.png": (256, 256),
    "Square30x30Logo.png": (30, 30),
    "Square44x44Logo.png": (44, 44),
    "Square71x71Logo.png": (71, 71),
    "Square89x89Logo.png": (89, 89),
    "Square107x107Logo.png": (107, 107),
    "Square142x142Logo.png": (142, 142),
    "Square150x150Logo.png": (150, 150),
    "Square284x284Logo.png": (284, 284),
    "Square310x310Logo.png": (310, 310),
    "StoreLogo.png": (256, 256),
}

# Windows ICO sizes (must include 16-256 for all display contexts)
ICO_SIZES = [256, 128, 96, 64, 48, 32, 24, 16]


def generate_pngs(src: Image.Image):
    for name, size in PNG_SIZES.items():
        path = os.path.join(ICONS_DIR, name)
        resized = src.resize(size, Image.LANCZOS)
        resized.save(path, format="PNG")
        print(f"  PNG {name}: {size[0]}x{size[1]}")


def generate_ico(src: Image.Image):
    path = os.path.join(ICONS_DIR, "icon.ico")
    png_data_list = []
    for s in ICO_SIZES:
        resized = src.resize((s, s), Image.LANCZOS)
        buf = io.BytesIO()
        resized.save(buf, format="PNG")
        png_data_list.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    offset = 6 + len(ICO_SIZES) * 16

    entries = b""
    image_data = b""
    for s, png in zip(ICO_SIZES, png_data_list):
        size = len(png)
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entry = struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, size, offset)
        entries += entry
        image_data += png
        offset += size

    with open(path, "wb") as f:
        f.write(header + entries + image_data)
    print(f"  ICO icon.ico: {len(ICO_SIZES)} frames ({ICO_SIZES})")


def main():
    src_path = os.path.join(ICONS_DIR, SOURCE)
    if not os.path.exists(src_path):
        print(f"ERROR: {src_path} not found", file=sys.stderr)
        sys.exit(1)

    src = Image.open(src_path)
    if src.size != (2048, 2048):
        print(
            f"WARNING: source is {src.size[0]}x{src.size[1]}, expected 2048x2048",
            file=sys.stderr,
        )

    print(f"Generating icons from {src.size[0]}x{src.size[1]} source...")
    generate_pngs(src)
    generate_ico(src)
    print("Done.")


if __name__ == "__main__":
    main()
