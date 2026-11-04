"""Turn a cinetty project into an MP4 and a GIF without a screen recorder (docs/demo-animation.md).

Asks cinetty's engine for every frame, draws each one the way a terminal would, and joins them
with ffmpeg. Run it with the Python in cinetty's .venv, which has Pillow:

  /path/to/cinetty/.venv/bin/python scripts/render-cinetty-clip.py /path/to/cinetty docs/cinetty/project.en.yaml

Writes <name>.mp4 and <name>.gif next to the project, where project.en.yaml gives agentfactory.en.
"""
import argparse, os, shutil, subprocess, sys, tempfile
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("cinetty"); ap.add_argument("project")
ap.add_argument("--name", default="agentfactory")
ap.add_argument("--fps", type=int, default=30); ap.add_argument("--tail", type=float, default=3.0)
a = ap.parse_args()
sys.path.insert(0, str(Path(a.cinetty).resolve()))

from PIL import Image, ImageDraw, ImageFont
from cinetty import template as T
from cinetty.engine import build
from cinetty.canvas import stamp_credit, steady_credit_spot, cw

spec = T.load(project=a.project)
S = build(spec)
spot = steady_credit_spot(S.render_frame, S.duration()) if spec["credit"] else None

CW, CH, PAD = 10, 21, 16
FONT = os.environ.get("CINETTY_FONT_DIR", "/usr/share/fonts/truetype/jetbrains-mono") + "/JetBrainsMono-"
reg = ImageFont.truetype(FONT + "Regular.ttf", 16)
bold = ImageFont.truetype(FONT + "Bold.ttf", 16)
cjk = ImageFont.truetype(os.environ.get("CINETTY_CJK_FONT", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"), 17)
BG = (0, 0, 0)


FALLBACK = [ImageFont.truetype(f, 16) for f in (
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    if os.path.exists(f)] + [cjk]
_cache = {}


def has(f, ch):
    # A missing glyph draws the font's .notdef box; compare with a code point no font has.
    key = (id(f), ch)
    if key not in _cache:
        _cache[key] = bytes(f.getmask(ch)) != bytes(f.getmask("\U0010fffd"))
    return _cache[key]


def font_for(ch, b):
    if cw(ch) == 2:
        return cjk
    for f in [bold if b else reg] + FALLBACK:
        if has(f, ch):
            return f
    return reg


def draw(c):
    im = Image.new("RGB", (c.cols * CW + 2 * PAD, c.rows * CH + 2 * PAD), BG)
    d = ImageDraw.Draw(im)
    # Backgrounds first: a wide character's second cell has its own background, which would
    # otherwise cover the right half of the glyph.
    for y, row in enumerate(c.cells):
        shaded, painted = c.bg.get(y, ()), c.paint.get(y, {})
        for x in range(c.cols):
            bgc = painted.get(x) or ((0, 0, 0) if x in shaded else None)
            if bgc:
                px, py = PAD + x * CW, PAD + y * CH
                d.rectangle([px, py, px + CW - 1, py + CH - 1], fill=bgc)
    for y, row in enumerate(c.cells):
        for x, (ch, fg, b) in enumerate(row):
            if not ch or ch == " ":
                continue
            px, py = PAD + x * CW, PAD + y * CH
            wide = cw(ch) == 2
            # Block glyphs as boxes, so bars stay seamless whatever the font has.
            if ch == "█":
                d.rectangle([px, py + 1, px + CW - 1, py + CH - 2], fill=fg); continue
            if ch == "▆":
                d.rectangle([px, py + 6, px + CW - 1, py + CH - 3], fill=fg); continue
            if ch in "▮▯":
                box = [px + 2, py + 5, px + CW - 3, py + CH - 6]
                d.rectangle(box, fill=fg) if ch == "▮" else d.rectangle(box, outline=fg)
                continue
            d.text((px + (CW * (2 if wide else 1)) / 2, py + CH / 2), ch, font=font_for(ch, b), fill=fg, anchor="mm")
    return im


project = Path(a.project)
lang = project.stem.split(".")[-1] if "." in project.stem else ""
stem = project.with_name(f"{a.name}.{lang}" if lang else a.name)
frames = Path(tempfile.mkdtemp(prefix="cinetty-frames-"))
total = S.duration()
n = int((total + a.tail) * a.fps)
try:
    for i in range(n):
        fr = S.render_frame(min(i / a.fps, total - 1e-3))
        if spot:
            stamp_credit(fr, spot)
        draw(fr.normalize()).save(frames / f"f{i:05d}.png")
    src = ["ffmpeg", "-v", "error", "-y", "-framerate", str(a.fps), "-i", str(frames / "f%05d.png")]
    subprocess.run(src + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
                          f"{stem}.mp4"], check=True)
    # 12 fps and a small palette keep the GIF under a megabyte; diff_mode redraws only what moved.
    subprocess.run(src + ["-vf", "fps=12,scale=720:-1:flags=lanczos,split[a][b];"
                          "[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
                          "-loop", "0", f"{stem}.gif"], check=True)
finally:
    shutil.rmtree(frames)
print(f"{stem}.mp4 and .gif: {n} frames, {total:.1f}s + {a.tail}s on the last frame")
