"""Render the AgentFactory film.

  python scripts/film/render.py zh|en [--film story|launch] [--workers 4] [--preview 3 12.5 30]

Two films: `story` (film.js, the one-shot of one ticket, the default) and `launch` (launch.js, the launch film; see
LAUNCH-SPEC.md). Without --preview it writes docs/film/agentfactory.<lang>.mp4 and .gif, or launch.<lang>. With --preview it writes one JPG per
second given to scripts/film/.cache/preview/, to check a change in seconds instead of minutes.
It needs Python 3.10+, ffmpeg, and `pip install playwright numpy scipy` then `playwright install chromium`
(or CHROME=<path to a Chromium>). The Chinese font is fetched once into scripts/film/.cache/.
The chunked, parallel render follows motion-atlas (MIT, (c) 2026 Yun); see LICENSE-motion-atlas."""
import argparse, json, os, subprocess, sys, urllib.request
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(HERE, '.cache'); BUILD = os.path.join(CACHE, 'build'); FPS, CHUNK = 30, 90
FONT = 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-sc@5.2.5/chinese-simplified-{w}-normal.woff2'  # SIL OFL
PAGE = '''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"AF Sans";font-weight:900;src:url(fonts/sc-900.woff2) format("woff2")}
@font-face{font-family:"AF Sans";font-weight:700;src:url(fonts/sc-700.woff2) format("woff2")}
@font-face{font-family:"AF Sans";font-weight:500;src:url(fonts/sc-500.woff2) format("woff2")}
html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="out"></canvas><script>window.LANG="@LANG@"</script><script src="film.js"></script></body></html>'''
# Each film: its source, the music script that reads its sound events, the output name, and the GIF's window (start, length).
FILMS = {
    'story': dict(src='film.js', music='music.py', out='agentfactory', events='window.SPARK_TIMES', gif=('23.5', '7.5')),
    'launch': dict(src='launch.js', music='music_launch.py', out='launch', events='window.SOUND_EVENTS', gif=('20', '8')),
}


def build(lang, film):
    os.makedirs(os.path.join(BUILD, 'fonts'), exist_ok=True)
    for w in (500, 700, 900):
        f = os.path.join(BUILD, 'fonts', f'sc-{w}.woff2')
        if not os.path.exists(f): urllib.request.urlretrieve(FONT.format(w=w), f)
    src, dst = os.path.join(HERE, FILMS[film]['src']), os.path.join(BUILD, 'film.js')
    if lang == 'en' and film == 'story': subprocess.run([sys.executable, os.path.join(HERE, 'make_en.py'), src, dst], check=True)
    else: open(dst, 'w', encoding='utf-8').write(open(src, encoding='utf-8').read())
    open(os.path.join(BUILD, 'page.html'), 'w', encoding='utf-8').write(PAGE.replace('@LANG@', lang))


def page(p):
    b = p.chromium.launch(executable_path=os.environ.get('CHROME') or None, args=['--allow-file-access-from-files'])
    pg = b.new_page(viewport={'width': 1920, 'height': 1080}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:400]))
    pg.goto('file://' + os.path.join(BUILD, 'page.html').replace(os.sep, '/')); pg.evaluate('window.ready'); return b, pg, errs


def chunks(ids):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b, pg, errs = page(p); nf = round(pg.evaluate('window.TOTAL') * FPS)
        for ci in ids:
            ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', str(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
                                   '-pix_fmt', 'yuv420p', os.path.join(CACHE, 'chunks', f'c{ci:03d}.mp4')], stdin=subprocess.PIPE)
            for f in range(ci * CHUNK, min(nf, ci * CHUNK + CHUNK)): pg.evaluate(f'render({f / FPS})'); ff.stdin.write(pg.screenshot(type='jpeg', quality=94))
            ff.stdin.close(); ff.wait(); print('chunk', ci, flush=True)
        b.close(); return errs


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('lang', choices=['zh', 'en']); ap.add_argument('--film', choices=list(FILMS), default='story'); ap.add_argument('--workers', type=int, default=4); ap.add_argument('--preview', type=float, nargs='*')
    a = ap.parse_args(); FM = FILMS[a.film]; build(a.lang, a.film)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b, pg, errs = page(p); total, sparks = pg.evaluate('window.TOTAL'), pg.evaluate(FM['events'])
        if a.preview is not None:
            d = os.path.join(CACHE, 'preview'); os.makedirs(d, exist_ok=True)
            for t in a.preview: pg.evaluate(f'render({t})'); pg.screenshot(path=os.path.join(d, f'{a.film}-{a.lang}-{t:05.2f}.jpg'), type='jpeg', quality=85)
            print('preview ->', d, 'errors:', errs); b.close(); return
        b.close()
    run = lambda *x: subprocess.run(['ffmpeg', '-v', 'error', '-y', *x], check=True)
    os.makedirs(os.path.join(CACHE, 'chunks'), exist_ok=True); sp = os.path.join(CACHE, 'sparks.json'); json.dump(sparks, open(sp, 'w'))
    wav = os.path.join(CACHE, 'music.wav'); subprocess.run([sys.executable, os.path.join(HERE, FM['music']), wav, str(total), sp], check=True)
    n = -(-round(total * FPS) // CHUNK); ids = list(range(n))
    with Pool(a.workers) as pool: errs = sum(pool.map(chunks, [ids[w::a.workers] for w in range(a.workers)]), [])
    if errs: sys.exit('page errors: ' + '; '.join(errs[:3]))
    lst = os.path.join(CACHE, 'chunks', 'list.txt'); open(lst, 'w').write(''.join(f"file 'c{i:03d}.mp4'\n" for i in ids))
    silent, out = os.path.join(CACHE, 'silent.mp4'), os.path.join(REPO, 'docs', 'film', f"{FM['out']}.{a.lang}")
    os.makedirs(os.path.dirname(out), exist_ok=True); run('-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent)
    # Kept small for the repository: flat graphics hold up well at this rate.
    # Loudness to about -15 LUFS with peaks under -1.5 dBTP, the target in the code-video skill's sound guide.
    run('-i', silent, '-i', wav, '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-ar', '48000', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-maxrate', '1400k', '-bufsize', '2800k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out + '.mp4')
    run('-ss', FM['gif'][0], '-t', FM['gif'][1], '-i', silent, '-vf', 'fps=8,scale=560:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', out + '.gif')
    print('done ->', out + '.mp4', out + '.gif')


if __name__ == '__main__': main()
