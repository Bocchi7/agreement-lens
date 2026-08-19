from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps" / "extension" / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def make_icon(size: int) -> None:
    scale = size / 128
    image = Image.new("RGBA", (size, size), (21, 60, 50, 255))
    draw = ImageDraw.Draw(image)

    margin = round(18 * scale)
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=round(17 * scale),
        fill=(244, 247, 244, 255),
    )
    draw.ellipse(
        (round(34 * scale), round(30 * scale), round(84 * scale), round(80 * scale)),
        outline=(21, 60, 50, 255),
        width=max(2, round(8 * scale)),
    )
    draw.line(
        (round(77 * scale), round(73 * scale), round(99 * scale), round(97 * scale)),
        fill=(196, 73, 46, 255),
        width=max(2, round(9 * scale)),
    )
    for y, width in ((49, 26), (60, 20)):
        draw.rounded_rectangle(
            (round(47 * scale), round(y * scale), round((47 + width) * scale), round((y + 4) * scale)),
            radius=max(1, round(2 * scale)),
            fill=(42, 104, 82, 255),
        )
    image.save(OUT / f"icon-{size}.png")


for icon_size in (16, 32, 48, 128):
    make_icon(icon_size)
