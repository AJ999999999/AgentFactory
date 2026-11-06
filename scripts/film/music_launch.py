"""The launch film's music, synthesised from the film's own event list (window.SOUND_EVENTS in launch.js), so every
hit lands on the frame that caused it. 120 bpm, one bar = 2 s:
  0-4 s   typing and a riser       4-10 s  a kick under each punch card     10 s  the title hit
  12-32 s the groove under the proof segments, building into the merge at 30 s
  32-36 s the wall: half-time, a shimmer      36 s  the end card hit, then the last chord rings out
  python music_launch.py <out.wav> <seconds> <events.json>     (render.py runs it)
The drum, pad and effect voices are the ones in music.py, after motion-atlas (MIT, (c) 2026 Yun)."""
import numpy as np, scipy.io.wavfile as wf, json, sys
from scipy.signal import fftconvolve, butter, sosfilt
OUT, D, EVENTS = sys.argv[1], float(sys.argv[2]), json.load(open(sys.argv[3]))
SR = 44100; n = int(SR * D); t = np.arange(n) / SR; rng = np.random.default_rng(5); out = np.zeros((n, 2)); beat = .5
lp = lambda x, f: sosfilt(butter(2, f, 'low', fs=SR, output='sos'), x)
hp = lambda x, f: sosfilt(butter(2, f, 'high', fs=SR, output='sos'), x)
mt = lambda m: 440 * 2 ** ((m - 69) / 12)
def add(sig, at, pan=0., g=1.):
    i = int(round(at * SR))
    if i >= n or i < 0: return
    s = sig[: n - i] * g; out[i:i + len(s), 0] += s * np.sqrt(1 - pan * .5); out[i:i + len(s), 1] += s * np.sqrt(1 + pan * .5)
def env(L, a, d): x = np.arange(L) / SR; return np.minimum(1, x / a) * np.exp(-x * d)
def kick(g=1.): x = np.arange(int(.42 * SR)) / SR; f = 44 + 120 * np.exp(-x * 30); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 7.5) * g
HAT = hp(rng.standard_normal(int(.05 * SR)), 7000) * np.exp(-np.arange(int(.05 * SR)) / SR * 90)
def clap(): x = np.arange(int(.25 * SR)) / SR; return hp(lp(rng.standard_normal(len(x)), 5000), 900) * (np.exp(-x * 22) + .5 * np.exp(-np.maximum(0, x - .012) * 30) * (x > .012))
def saw(f, dur):
    x = np.arange(int(dur * SR)) / SR; s = np.zeros_like(x)
    for k in range(1, 24):
        if f * k > 14000: break
        s += np.sin(2 * np.pi * f * k * x) / k
    return s
def pad(ch, dur=2.1, g=.028, cut=2200): p = sum(lp(saw(mt(m), dur), cut) for m in ch) * g; return p * env(len(p), .06, .45)
def tone(m, dur=.18, d=20, g=1.): L = int(dur * SR); x = np.arange(L) / SR; return np.sin(2 * np.pi * np.cumsum(mt(m) * (1 + .5 * np.exp(-x * 40))) / SR) * np.exp(-x * d) * g
def key(g=1.): L = int(.04 * SR); x = np.arange(L) / SR; return (hp(rng.standard_normal(L), 2500) * np.exp(-x * 190) * .7 + np.sin(2 * np.pi * 2400 * x) * np.exp(-x * 150) * .3) * g
def thud(g=1.): L = int(.3 * SR); x = np.arange(L) / SR; return (np.sin(2 * np.pi * np.cumsum(80 + 120 * np.exp(-x * 40)) / SR) * np.exp(-x * 14) + lp(rng.standard_normal(L), 1500) * np.exp(-x * 40) * .5) * g
def whoosh(dur=.6, g=1.): w = rng.standard_normal(int(dur * SR)); return hp(lp(w, 6000), 500) * np.linspace(0, 1, len(w)) ** 3 * g
def riser(dur, g=1.): w = rng.standard_normal(int(dur * SR)); return hp(w, 1500) * np.linspace(0, 1, len(w)) ** 3 * g
def buzz(g=1.): L = int(.35 * SR); x = np.arange(L) / SR; return lp(np.sign(np.sin(2 * np.pi * 110 * x)) * .5 + np.sign(np.sin(2 * np.pi * 116.5 * x)) * .5, 1800) * env(L, .005, 8) * g
x2 = np.arange(int(2.8 * SR)) / SR; BIG = np.sin(2 * np.pi * np.cumsum(34 + 90 * np.exp(-x2 * 9)) / SR) * np.exp(-x2 * 1.5)
CRASH = hp(rng.standard_normal(int(2.2 * SR)), 5000) * np.exp(-np.arange(int(2.2 * SR)) / SR * 2.2)
def shimmer(g=1.):
    sh = np.zeros(int(3 * SR))
    for k in range(60):
        i0 = int(rng.random() * len(sh) * .8); Ls = int(.5 * SR); s_ = np.sin(2 * np.pi * mt(84 + [0, 4, 7, 11, 12, 16][rng.integers(0, 6)]) * np.arange(Ls) / SR) * np.exp(-np.arange(Ls) / SR * 7); sh[i0:i0 + Ls] += s_[: len(sh) - i0] * .03
    return sh * g
prog = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67]]; roots = [45, 41, 48, 43]  # Am7 F C G: a launch, with a little tension

# the bed, by section
add(pad([45, 52, 57, 60], 4.2, .02, 900) * np.minimum(1, np.arange(int(4.2 * SR)) / SR / 1.5), 0); add(riser(1.6, .22), 2.4)
for k, at in enumerate([4, 6, 8]):  # under each punch card: a low chord and a sub
    add(pad([roots[k % 4] - 12 + 12, *prog[k % 4]], 2.0, .02, 1400), at)
    for j in range(4): add(HAT, at + j * beat + beat / 2, .4, .08)
add(riser(1.2, .3), 8.8)
bar, tt = 0, 12.0
while tt < 32 - .01:  # the groove under the proof segments
    ch = prog[bar % 4]; add(pad(ch), tt, pan=(-.3 if bar % 2 else .3))
    for k in range(4):
        at = tt + k * beat; add(kick(.95), at); add(HAT, at + beat / 2, .4, .17); add(HAT, at, -.4, .06)
        if k % 2: add(clap(), at, g=.3)
        bl = np.arange(int(.45 * SR)) / SR; add(lp(saw(mt(roots[bar % 4] - 12), .45), 650) * np.exp(-bl * 5) * .17, at + beat / 2)
    for k in range(8):
        m = ch[(k * 3) % 4] + 12 + (12 if tt >= 24 and k % 4 == 3 else 0); L = int(.2 * SR); x = np.arange(L) / SR
        add(np.sin(2 * np.pi * mt(m) * x) * np.exp(-x * 15) * .045, tt + k * .25, pan=(-.6 if k % 2 else .6))
    tt += 2.0; bar += 1
add(riser(2.0, .3), 28.0)
for k in range(16): add(clap(), 29.0 + 1.0 * (1 - (1 - k / 16) ** 1.6), g=.06 + .16 * k / 16)
add(pad([45, 57, 60, 64, 71], 4.0, .03, 2600), 32)  # the wall: half-time under one long chord
for k in range(4): add(kick(.6), 32 + k * 1.0)
add(pad([48, 60, 64, 67, 74], 5.0, .05, 3200) * np.exp(-np.arange(int(5.0 * SR)) / SR * .3), 36)

# the hits, from the film's own events
ONE = {
    'key': lambda: key(.22), 'line': lambda: tone(79, .2, 18, .05), 'punch': lambda: kick(1.1),
    'whoosh': lambda: whoosh(.6, .22), 'pop': lambda: tone(84, .3, 10, .08), 'stamp': lambda: thud(.55), 'tap': lambda: key(.6), 'tick': lambda: tone(88, .25, 12, .06),
    'fail': lambda: buzz(.12), 'pass': lambda: tone(76, .35, 9, .08), 'pass2': lambda: tone(83, .5, 6, .09), 'check': lambda: tone(86, .2, 14, .06),
    'merge': lambda: BIG, 'chime': lambda: tone(88, .6, 5, .06), 'shimmer': lambda: shimmer(1.0), 'boom': lambda: BIG * .9,
}
for e in EVENTS:
    at, name = float(e['t']), e['name']
    if name == 'whoosh': add(ONE[name](), at - .55, pan=float(rng.uniform(-.5, .5)))
    else: add(ONE[name](), at, pan=float(rng.uniform(-.3, .3)) if name == 'key' else 0)
    if name in ('merge', 'boom'): add(CRASH * .22, at); add(clap(), at, g=.5)
    if name == 'punch': add(clap(), at, g=.35)

ir = rng.standard_normal(int(1.6 * SR)) * np.exp(-np.arange(int(1.6 * SR)) / SR * 3.2) * .02
wet = np.stack([fftconvolve(out[:, c], ir)[:n] for c in range(2)], 1); mix = out + wet * .45
mix *= np.clip((D - t) / 1.2, 0, 1)[:, None]; mix /= np.abs(mix).max() * 1.12
wf.write(OUT, SR, (mix * 32767).astype(np.int16))
