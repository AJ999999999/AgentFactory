"""Check a film's layout from the frames themselves, not by eye.

  python scripts/film/check_layout.py en|zh [--film launch|story] [--step 0.1]

It renders the film at every step, and records where each piece of text really lands: the canvas's fillText is
wrapped, so every box comes from the font that drew it, with the transform and transparency in force. Then it
reports, as time ranges:
  - overlap:  two pieces of text, both clearly visible, covering each other
  - outside:  text past the frame's safe area (3% at each edge)
  - small:    copy under 26 px tall, or anything under 16 px (window titles and logs may be 18 to 22 px)
It exits non-zero when it finds any, so a render can be gated on it. The idea follows Code2Video's anchor grid and
layout critic (showlab/Code2Video): layout problems found and named by position, before anyone watches the film."""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render

WRAP = r"""() => {
  if (window.__boxes) return;
  window.__boxes = [];
  const ctx = X, orig = ctx.fillText.bind(ctx);
  ctx.fillText = function (s, x, y, maxW) {
    const str = String(s);
    if (str.trim() && ctx.globalAlpha > 0.02) {
      const m = ctx.measureText(str), tf = ctx.getTransform();
      const l = x - m.actualBoundingBoxLeft, r = x + m.actualBoundingBoxRight, t = y - m.actualBoundingBoxAscent, b = y + m.actualBoundingBoxDescent;
      const pts = [[l, t], [r, t], [l, b], [r, b]].map(([px, py]) => [tf.a * px + tf.c * py + tf.e, tf.b * px + tf.d * py + tf.f]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), size = parseFloat((ctx.font.match(/(\d+(?:\.\d+)?)px/) || [0, 0])[1]) * Math.hypot(tf.a, tf.b);
      window.__boxes.push({ s: str.slice(0, 48), x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), a: ctx.globalAlpha, size, mono: /Mono/.test(ctx.font) });
    }
    return orig(s, x, y, maxW);
  };
}"""


def issues_at(boxes, W=1920, H=1080):
    out = []
    vis = [b for b in boxes if b['a'] >= .6 and b['x1'] - b['x0'] > 2]
    for i, p in enumerate(vis):
        for q in vis[i + 1:]:
            ix = min(p['x1'], q['x1']) - max(p['x0'], q['x0']); iy = min(p['y1'], q['y1']) - max(p['y0'], q['y0'])
            if ix > 3 and iy > 3:
                small = min((p['x1'] - p['x0']) * (p['y1'] - p['y0']), (q['x1'] - q['x0']) * (q['y1'] - q['y0']))
                if ix * iy > .15 * small: out.append(('overlap', f"{p['s']!r} × {q['s']!r}"))
        mx, my = W * .03, H * .03
        if p['x0'] < mx - 1 or p['x1'] > W - mx + 1 or p['y0'] < my - 1 or p['y1'] > H - my + 1: out.append(('outside', repr(p['s'])))
        if p['size'] < 16 or (not p['mono'] and p['size'] < 26 and len(p['s']) > 3): out.append(('small', f"{p['s']!r} at {p['size']:.0f}px"))
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('lang', choices=['zh', 'en']); ap.add_argument('--film', choices=list(render.FILMS), default='launch'); ap.add_argument('--step', type=float, default=.1)
    a = ap.parse_args(); render.build(a.lang, a.film)
    from playwright.sync_api import sync_playwright
    found = {}
    with sync_playwright() as p:
        b, pg, errs = render.page(p); pg.evaluate(WRAP); total = pg.evaluate('window.TOTAL')
        n = int(total / a.step)
        for i in range(n + 1):
            t = round(i * a.step, 3)
            boxes = pg.evaluate(f"() => {{ window.__boxes.length = 0; render({t}); return window.__boxes; }}")
            for kind, what in issues_at(boxes): found.setdefault((kind, what), []).append(t)
        b.close()
    if errs: print('page errors:', errs[:3])
    # A problem that lasts under 0.3 s is an element mid-move (a spring still small, two lines passing); a viewer
    # can't read it then anyway. What stays on screen is what counts.
    report = []
    for (kind, what), ts in sorted(found.items(), key=lambda kv: kv[1][0]):
        spans, s0, prev = [], ts[0], ts[0]
        for t in ts[1:] + [None]:
            if t is None or t - prev > a.step * 1.5:
                if prev - s0 >= .3 - 1e-9: spans.append(f'{s0:.1f}-{prev:.1f}')
                s0 = t
            prev = t if t is not None else prev
        if spans: report.append(f'{kind:8} {", ".join(spans):24} {what}')
    print('\n'.join(report)); print(f'{len(report)} issue(s) in {a.film}.{a.lang}'); sys.exit(1 if report else 0)


if __name__ == '__main__': main()
