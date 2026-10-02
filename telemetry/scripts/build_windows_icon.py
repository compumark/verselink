#!/usr/bin/env python3
"""Build a compact multi-resolution tray/application icon from VerseLink branding."""

from pathlib import Path

from PIL import Image, __version__ as pillow_version


REPOSITORY = Path(__file__).resolve().parents[1].parent
SOURCE = REPOSITORY / "public" / "favicon.png"
OUTPUT = REPOSITORY / "telemetry" / "cmd" / "verselink-telemetry-tray" / "verselink.ico"
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
PINNED_PILLOW_VERSION = "12.3.0"


def generate_icon(output: Path = OUTPUT) -> None:
    if pillow_version != PINNED_PILLOW_VERSION:
        raise SystemExit(
            f"Pillow {PINNED_PILLOW_VERSION} is required for reproducible icon generation; "
            f"found {pillow_version}"
        )
    image = Image.open(SOURCE).convert("RGB")
    # The existing favicon's blueprint/document-and-cube mark is centered.
    image = image.crop((320, 260, 960, 900)).resize((256, 256), Image.Resampling.LANCZOS)

    rgba = image.convert("RGBA")
    pixels = []
    for red, green, blue, _ in rgba.get_flattened_data():
        peak = max(red, green, blue)
        # Remove the favicon's dark canvas while retaining its cyan glow and
        # brighter strokes as soft alpha edges for tray-size downsampling.
        alpha = max(0, min(255, (peak - 68) * 2))
        pixels.append((red, green, blue, alpha))
    rgba.putdata(pixels)
    rgba.save(output, format="ICO", sizes=[(size, size) for size in SIZES])


def main() -> None:
    generate_icon()


if __name__ == "__main__":
    main()
