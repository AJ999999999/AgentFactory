"""The film's music, synthesised: three acts on a 120 bpm grid (one bar = 2 s).
Quiet ticking, a groove that builds, the drop on the merge at 30 s, then the pull-back and the title.
Every accent sits on something that happens on screen.
  python music.py <out.wav> <seconds> <sparks.json>     (render.py runs it)
The drum, pad and effect voices come from motion-atlas (MIT, (c) 2026 Yun); see LICENSE-motion-atlas."""
import numpy as np, scipy.io.wavfile as wf, json, sys
from scipy.signal import fftconvolve, butter, sosfilt
OUT, D, SPARKS = sys.argv[1], float(sys.argv[2]), json.load(open(sys.argv[3]))
SR = 44100; n = int(SR * D); t = np.arange(n) / SR; rng = np.random.default_rng(7); out = np.zeros((n, 2)); beat = .5
lp = lambda x, f: sosfilt(butter(2, f, 'low', fs=SR, output='sos'), x)
hp = lambda x, f: sosfilt(butter(2, f, 'high', fs=SR, output='sos'), x)
mt = lambda m: 440 * 2 ** ((m - 69) / 12)
def add(sig, at, pan=0., g=1.):
    i = int(at * SR)
    if i >= n or i < 0: return
    s = sig[: n - i] * g; out[i:i + len(s), 0] += s * np.sqrt(1 - pan * .5); out[i:i + len(s), 1] += s * np.sqrt(1 + pan * .5)
def env(L, a, d): x = np.arange(L) / SR; return np.minimum(1, x / a) * np.exp(-x * d)
def kick(g=1.):
    x = np.arange(int(.42 * SR)) / SR; f = 44 + 120 * np.exp(-x * 30); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 7.5) * g
HAT = hp(rng.standard_normal(int(.05 * SR)), 7000) * np.exp(-np.arange(int(.05 * SR)) / SR * 90)
def clap():
    x = np.arange(int(.25 * SR)) / SR; return hp(lp(rng.standard_normal(len(x)), 5000), 900) * (np.exp(-x * 22) + .5 * np.exp(-np.maximum(0, x - .012) * 30) * (x > .012))
def saw(f, dur):
    x = np.arange(int(dur * SR)) / SR; s = np.zeros_like(x)
    for k in range(1, 24):
        if f * k > 14000: break
        s += np.sin(2 * np.pi * f * k * x) / k
    return s
def pad(ch, dur=2.1, g=.028, cut=2200): p = sum(lp(saw(mt(m), dur), cut) for m in ch) * g; return p * env(len(p), .06, .45)
def tone(m, dur=.18, d=20, g=1.): L = int(dur * SR); x = np.arange(L) / SR; f = mt(m); return np.sin(2 * np.pi * np.cumsum(f * (1 + .5 * np.exp(-x * 40))) / SR) * np.exp(-x * d) * g
def click(g=1.): L = int(.05 * SR); x = np.arange(L) / SR; return (hp(rng.standard_normal(L), 1800) * np.exp(-x * 160) * .6 + np.sin(2 * np.pi * 1900 * x) * np.exp(-x * 120) * .4) * g
def flap(g=1.): L = int(.03 * SR); x = np.arange(L) / SR; return hp(rng.standard_normal(L), 2500) * np.exp(-x * 220) * g
def thud(g=1.): L = int(.3 * SR); x = np.arange(L) / SR; return (np.sin(2 * np.pi * np.cumsum(80 + 120 * np.exp(-x * 40)) / SR) * np.exp(-x * 14) + lp(rng.standard_normal(L), 1500) * np.exp(-x * 40) * .5) * g
def whoosh(dur=.7, g=1.): w = rng.standard_normal(int(dur * SR)); return hp(lp(w, 5000), 400) * np.linspace(0, 1, len(w)) ** 3 * g
def riser(dur, g=1.): w = rng.standard_normal(int(dur * SR)); r = np.linspace(0, 1, len(w)); return hp(w, 1500) * r ** 3 * g
x2 = np.arange(int(2.8 * SR)) / SR; BIG = np.sin(2 * np.pi * np.cumsum(34 + 90 * np.exp(-x2 * 9)) / SR) * np.exp(-x2 * 1.5)
CRASH = hp(rng.standard_normal(int(2.2 * SR)), 5000) * np.exp(-np.arange(int(2.2 * SR)) / SR * 2.2)
def shimmer(g=1.):
    sh = np.zeros(int(3 * SR))
    for k in range(50):
        i0 = int(rng.random() * len(sh) * .8); Ls = int(.5 * SR); s_ = np.sin(2 * np.pi * mt(84 + [0, 3, 7, 10, 12, 15][rng.integers(0, 6)]) * np.arange(Ls) / SR) * np.exp(-np.arange(Ls) / SR * 7); sh[i0:i0 + Ls] += s_[: len(sh) - i0] * .03
    return sh * g
prog = [[60, 64, 67, 71], [55, 59, 62, 67], [57, 60, 64, 69], [53, 57, 60, 65]]; roots = [48, 43, 45, 41]  # Cmaj7 G Am F: bright, major

# Act 1 (0-6): a low drone, the split-flap ticking, a riser into the landing
add(pad([48, 55, 60, 62], 6.2, .02, 1200) * np.minimum(1, np.arange(int(6.2 * SR)) / SR / 2), 0)
for k in range(46): add(flap(.25), .35 + k * (1.65 / 46) + rng.random() * .01, pan=float(rng.uniform(-.5, .5)))
for i in range(12): add(click(.35), .7 + i * .12, pan=-.5 + i / 12)
add(tone(76, .5, 6, .08), 2.1); add(whoosh(.8, .25), 2.9); add(tone(81, .4, 8, .06), 3.6)
add(whoosh(1.4, .35), 4.2); add(riser(1.6, .22), 4.4)

# Acts 2-3 (6-40): the groove; light until 14, full until 40
bar = 0; tt = 6.0
while tt < 40 - .01:
    full = tt >= 14; ch = prog[bar % 4]; add(pad(ch), tt, pan=(-.3 if bar % 2 else .3), g=1 if full else .8)
    for k in range(4):
        at = tt + k * beat; add(kick(.95 if full else .55), at)
        add(HAT, at + beat / 2, pan=.4, g=.18 if full else .1)
        if full:
            add(HAT, at, pan=-.4, g=.07)
            if k % 2: add(clap(), at, g=.32)
            bl = np.arange(int(.45 * SR)) / SR; add(lp(saw(mt(roots[bar % 4] - 12), .45), 600) * np.exp(-bl * 5) * .17, at + beat / 2)
    if tt >= 16:
        steps = 16 if tt >= 30 else 8
        for k in range(steps):
            m = ch[(k * 3) % 4] + 12 + (12 if tt >= 30 and k % 4 == 3 else 0); L = int(.2 * SR); x = np.arange(L) / SR
            add(np.sin(2 * np.pi * mt(m) * x) * np.exp(-x * 15) * .045, tt + k * 2 / steps, pan=(-.6 if k % 2 else .6))
    tt += 2.0; bar += 1

# events on screen
add(kick(1.), 6.0); add(tone(69, .5, 7, .12), 6.0); add(BIG * .4, 6.0)
add(tone(72, .3, 12, .07), 7.0, .4); add(tone(76, .3, 12, .07), 8.0, -.4)
for i in range(12): add(click(.18), 10.4 + i * .05)
add(whoosh(.5, .2), 11.3); add(tone(81, .35, 10, .09), 12.0)
for i, at in enumerate([12.6, 13.5, 14.4]): add(click(.3), at, pan=.3)
add(tone(76, .3, 10, .06), 13.6, .5)
add(whoosh(.6, .2), 15.6); add(riser(1.5, .1), 16.5); add(thud(.6), 18.0); add(clap(), 18.0, g=.45); add(tone(88, .6, 6, .05), 18.0)
for i, m in enumerate([72, 76, 79]): add(tone(m, .3, 10, .1), 20.5 + i * .5, pan=-.4 + i * .4)
add(tone(84, .3, 9, .08), 22.0); add(click(.5), 23.5); add(thud(.5), 24.0); add(tone(91, .5, 7, .05), 24.0); add(whoosh(.7, .22), 24.6); add(tone(67, .4, 8, .08), 25.4)
add(whoosh(.6, .2), 25.9)
for i, at in enumerate([27.2, 28.0, 28.8]): add(tone([79, 83, 86][i], .35, 9, .1), at); add(click(.25), at)
add(riser(2.0, .32), 28.0)
for k in range(16): add(clap(), 29.0 + 1.0 * (1 - (1 - k / 16) ** 1.6), g=.08 + .18 * k / 16)
add(BIG, 30.0); add(CRASH * .25, 30.0); add(clap(), 30.0, g=.6); add(kick(1.1), 30.0)
add(tone(84, .4, 8, .07), 30.85); add(tone(88, .4, 8, .05), 30.95)  # the 'fixed' reply goes out
add(whoosh(1.6, .3), 31.8); add(shimmer(.9), 33.0); add(shimmer(.8), 36.4)
for s in SPARKS: add(tone(int(88 + rng.integers(0, 6)), .15, 22, .035), s, pan=float(rng.uniform(-.7, .7)))

# Act 4 (40-45): the groove stops, everything flows in, the flash, the title
add(riser(1.2, .3), 39.95); add(BIG, 41.15); add(CRASH * .2, 41.15); add(clap(), 41.15, g=.5)
add(pad([48, 60, 64, 67, 74], 5.85, .05, 3200) * np.exp(-np.arange(int(5.85 * SR)) / SR * .25), 41.15)
add(tone(76, 1.2, 2.5, .06), 43.2); add(tone(83, 1.2, 2.5, .04), 43.25); add(BIG * .35, 43.2)

ir = rng.standard_normal(int(1.6 * SR)) * np.exp(-np.arange(int(1.6 * SR)) / SR * 3.2) * .02
wet = np.stack([fftconvolve(out[:, c], ir)[:n] for c in range(2)], 1); mix = out + wet * .45
mix *= np.clip((D - t) / 1.6, 0, 1)[:, None]; mix /= np.abs(mix).max() * 1.1
wf.write(OUT, SR, (mix * 32767).astype(np.int16))
