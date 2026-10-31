"""Guess the main color of a shoe photo. Only a suggestion; users can correct it in the app."""
import colorsys
from collections import Counter

from PIL import Image

COLORS = ("black", "white", "grey", "beige", "brown", "red", "pink", "orange", "yellow", "green", "blue", "purple")
SAMPLE = 64  # analyse a SAMPLE x SAMPLE downscale, plenty for a dominant color


def name_rgb(r: int, g: int, b: int) -> str:
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    h *= 360
    if v < 0.25:
        return "black"
    if s < 0.15:
        return "white" if v > 0.8 else "grey"
    if 15 <= h < 45:  # warm hues: leather tones are far more common than real orange
        if s < 0.4 and v > 0.7:
            return "beige"
        return "orange" if v > 0.8 and s > 0.6 else "brown"
    if h < 15 or h >= 330:
        return "pink" if s < 0.5 and v > 0.7 else "red"
    if h < 70:
        return "yellow"
    if h < 165:
        return "green"
    if h < 255:
        return "blue"
    return "purple" if h < 290 else "pink"


def detect_color(img: Image.Image) -> str:
    """Most common color name in the middle of the photo, ignoring the floor color seen at the edges."""
    data = img.convert("RGB").resize((SAMPLE, SAMPLE)).tobytes()
    edge, lo, hi = SAMPLE // 8, SAMPLE // 4, SAMPLE * 3 // 4
    border, center = Counter(), Counter()
    for i in range(SAMPLE * SAMPLE):
        x, y = i % SAMPLE, i // SAMPLE
        name = name_rgb(*data[i * 3:i * 3 + 3])
        if min(x, y, SAMPLE - 1 - x, SAMPLE - 1 - y) < edge:
            border[name] += 1
        elif lo <= x < hi and lo <= y < hi:
            center[name] += 1

    floor = border.most_common(1)[0][0]
    shoe = Counter({n: c for n, c in center.items() if n != floor})
    # little else in the middle means the shoe has the floor's color (or fills the frame)
    if sum(shoe.values()) < 0.2 * sum(center.values()):
        return center.most_common(1)[0][0]
    return shoe.most_common(1)[0][0]


if __name__ == "__main__":  # self-check: python -m app.color
    def scene(floor, shoe):
        img = Image.new("RGB", (400, 300), floor)
        img.paste(shoe, (120, 90, 280, 210))
        return img

    assert detect_color(scene((128, 128, 128), (30, 80, 200))) == "blue"
    assert detect_color(scene((40, 40, 40), (245, 245, 245))) == "white"
    assert detect_color(scene((240, 240, 240), (200, 30, 40))) == "red"
    assert detect_color(scene((210, 180, 140), (110, 60, 30))) == "brown"
    assert detect_color(scene((20, 20, 20), (20, 20, 20))) == "black"
    assert detect_color(Image.new("RGB", (300, 300), (255, 182, 193))) == "pink"
    print("ok")
