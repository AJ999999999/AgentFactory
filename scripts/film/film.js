// AgentFactory in 47 seconds, one shot: one Jira ticket goes through the firm, then the camera pulls back to a thousand engagements.
// Every frame is a pure function of t (render(t)), so frames can be rendered in any order and in parallel.
// This is the Chinese cut; make_en.py derives the English one from it. Render with scripts/film/render.py.
const W = 1920, H = 1080, TOTAL = 47; window.TOTAL = TOTAL;
const cv = document.getElementById('out'); cv.width = W; cv.height = H; const X = cv.getContext('2d');
const F = { sans: '"AF Sans", "WenQuanYi Zen Hei"', inter: 'Inter', disp: '"Inter Display"', mono: '"DejaVu Sans Mono"' };
const NAVY = '14,27,61', BLUE = '47,107,255', ORANGE = '255,122,26', GREEN = '18,191,120', VIOLET = '124,77,255', PINK = '255,51,119', CYAN = '0,184,217', YELLOW = '255,190,0', WHITE = '255,255,255', MUTE = '120,134,166';
window.ready = Promise.all(['500 40px "AF Sans"', '700 40px "AF Sans"', '900 40px "AF Sans"', '600 40px Inter', '800 40px Inter', '900 40px Inter', '700 40px Inter', '500 40px "DejaVu Sans Mono"'].map(s => document.fonts.load(s, '字Aa1')));
const cl = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)), lerp = (a, b, u) => a + (b - a) * u;
const sm = x => { x = cl(x); return x * x * (3 - 2 * x); }, eio = x => { x = cl(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const eo = x => 1 - Math.pow(1 - cl(x), 3), ei = x => { x = cl(x); return x * x * x; }, seg = (t, a, b) => cl((t - a) / (b - a));
const back = x => { x = cl(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const font = (w, s, f) => { X.font = `${w} ${s}px ${f}`; };
function hash(i, j) { let h = Math.imul((i * 374761393 + j * 668265263) | 0, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const bez = (a, b, c, d, u) => { const m = 1 - u; return [m * m * m * a[0] + 3 * m * m * u * b[0] + 3 * m * u * u * c[0] + u * u * u * d[0], m * m * m * a[1] + 3 * m * m * u * b[1] + 3 * m * u * u * c[1] + u * u * u * d[1]]; };
const arc = (a, b, u, bump) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u) - bump * 4 * u * (1 - u)];

// ---------- the ticket's path through the firm ----------
const CARD0 = [0, -260], LAND = [0, 0], RULE = [600, 0], SEATS = [[400, -330, 'OPS'], [600, -330, 'FDB'], [800, -330, 'FIX']], FIX = [800, -330], JUDGE = [1250, -330];
const STEPS = [[1560, -170, '意见', 'opinion'], [1760, -270, '汇报', 'reported'], [1960, -370, '实测', 'measured']], WAIT = [2115, -380], CARD = [2420, -380], CHIP = [2400, 0], BR0 = [2600, 0], MERGE = [3700, 0];
function branch(u) {
  if (u < .2) return bez([2600, 0], [2700, 0], [2750, -220], [2850, -220], u / .2);
  if (u < .8) return [lerp(2850, 3450, (u - .2) / .6), -220];
  return bez([3450, -220], [3550, -220], [3600, 0], [3700, 0], (u - .8) / .2);
}
const bu = t => { const l = seg(t, 26, 30); return l * .85 + eio(l) * .15; };
const CHECKS = [[27.2, 'test'], [28.0, 'lint'], [28.8, 'review']].map(([tt, n]) => ({ t: tt, n, p: branch(bu(tt)) }));
function P(t) {
  if (t < 5.4) { const bob = sm(seg(t, 3.4, 4)) * (1 - sm(seg(t, 4.9, 5.4))); return [0, -260 + Math.sin(t * 2.2) * 8 * bob]; }
  if (t < 6) return [0, lerp(-260, 0, ei(seg(t, 5.4, 6)))];
  if (t < 9) return LAND;
  if (t < 10.4) return [lerp(0, 600, eio(seg(t, 9, 10.4))), 0];
  if (t < 11.2) return RULE;
  if (t < 12) return arc(RULE, FIX, eio(seg(t, 11.2, 12)), 150);
  if (t < 15.5) return FIX;
  if (t < 16.5) return arc(FIX, JUDGE, eio(seg(t, 15.5, 16.5)), 70);
  if (t < 20) return JUDGE;
  if (t < 21.5) { const k = Math.min(2, Math.floor((t - 20) / .5)), a = k ? STEPS[k - 1] : JUDGE; return arc(a, STEPS[k], eio(seg(t, 20 + k * .5, 20.5 + k * .5)), 70); }
  if (t < 22.3) return arc(STEPS[2], WAIT, eio(seg(t, 21.5, 22.3)), 20);
  if (t < 25) return WAIT;
  if (t < 26) return arc(WAIT, BR0, eio(seg(t, 25, 26)), 90);
  if (t < 30) return branch(bu(t));
  return MERGE;
}
// The full journey as a template, reused (scaled down) by every other engagement in the zoom-out.
const TPL = []; for (let s = 5.4; s <= 30.001; s += .25) TPL.push(P(s));

// ---------- camera: one continuous move, then one zoom out ----------
const CK = [[0, 0, -230, 1.22], [3, 0, -230, 1.26], [5.2, 0, -170, 1.12], [6.4, 90, -100, 1.14], [9, 260, -120, 1.14], [10.6, 540, -160, 1.14], [12.4, 820, -210, 1.174], [15.4, 960, -230, 1.174], [17.6, 1240, -240, 1.22],
  [20.2, 1520, -250, 1.14], [22.2, 1980, -300, 1.14], [24.2, 2300, -320, 1.22], [26, 2640, -170, 1.083], [28.4, 3140, -120, 1.049], [30.6, 3620, -70, 1.049], [31.4, 3680, -60, 1.037], [32, 3700, -55, 1.03]];
function hermite(keys, t, idx) {
  let i = 0; while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const h = k2[0] - k1[0], u = cl((t - k1[0]) / h), v = k => idx === 3 ? Math.log(k[3]) : k[idx];
  const m1 = (v(k2) - v(k0)) / (k2[0] - k0[0]) * h, m2 = (v(k3) - v(k1)) / (k3[0] - k1[0]) * h;
  const u2 = u * u, u3 = u2 * u; const r = (2 * u3 - 3 * u2 + 1) * v(k1) + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * v(k2) + (u3 - u2) * m2;
  return idx === 3 ? Math.exp(r) : r;
}
const HOME = [1800, -190], ZEND = .026;
function cam(t) {
  let c;
  if (t <= 32) c = [hermite(CK, t, 1), hermite(CK, t, 2), hermite(CK, t, 3)];
  else {
    // Zoom about a point: the centre moves in step with 1/z, so it reads as pulling back, not panning.
    const u = seg(t, 32, 39.6), e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const z = Math.exp(lerp(Math.log(1.03), Math.log(.03), e)) * (1 - .13 * sm(seg(t, 38, 41)));
    const w = (1 / z - 1 / 1.03) / (1 / .03 - 1 / 1.03);
    c = [lerp(3700, HOME[0], cl(w)), lerp(-55, HOME[1] + 190, cl(w)), z];
  }
  c[0] += Math.sin(t * .7) * 5 / c[2]; c[1] += Math.sin(t * .53 + 1) * 4 / c[2]; return c;
}
let CAM = [0, 0, 1];
const S = (p) => [(p[0] - CAM[0]) * CAM[2] + W / 2, (p[1] - CAM[1]) * CAM[2] + H / 2];
const world = () => X.setTransform(CAM[2], 0, 0, CAM[2], W / 2 - CAM[0] * CAM[2], H / 2 - CAM[1] * CAM[2]);
const screen = () => X.setTransform(1, 0, 0, 1, 0, 0);

// ---------- drawing helpers ----------
// Night falls for the pull-back, so a thousand engagements read as city lights; the flash at 41 s brings the day back.
const night = t => sm(seg(t, 32.2, 34.4)) * (1 - sm(seg(t, 41.05, 41.3)));
const mix = (a, b, u) => a.split(',').map((v, i) => Math.round(lerp(+v, +b.split(',')[i], u))).join(',');
const rgba = (c, a = 1) => `rgba(${c},${a})`;
function rrect(x, y, w, h, r) { X.beginPath(); X.roundRect(x, y, w, h, r); }
function label(txt, x, y, rgb, a, size = 17, align = 'left', f = F.inter, w = '600') { if (a <= 0) return; X.globalAlpha = a; X.fillStyle = `rgb(${rgb})`; font(w, size, f); X.textAlign = align; X.fillText(txt, x, y); X.textAlign = 'left'; X.globalAlpha = 1; }
function shadow(on, blur = 26, dy = 10, a = .14) { if (on) { X.shadowColor = rgba(NAVY, a); X.shadowBlur = blur; X.shadowOffsetY = dy; } else { X.shadowColor = 'transparent'; X.shadowBlur = 0; X.shadowOffsetY = 0; } }
function ring(x, y, r, rgb, a, lw) { if (a <= 0) return; X.globalAlpha = a; X.strokeStyle = `rgb(${rgb})`; X.lineWidth = lw; X.beginPath(); X.arc(x, y, r, 0, Math.PI * 2); X.stroke(); X.globalAlpha = 1; }
const pulse = (t, at, dur = .9) => { const u = (t - at) / dur; return u < 0 || u > 1 ? null : u; };
function pill(txt, x, y, bg, fg, a, size = 18, f = F.inter, w = '700', padX = 16, hgt = 36) {
  if (a <= 0) return 0; font(w, size, f); const tw = X.measureText(txt).width + padX * 2; X.globalAlpha = a; rrect(x - tw / 2, y - hgt / 2, tw, hgt, hgt / 2); X.fillStyle = `rgb(${bg})`; X.fill();
  X.fillStyle = `rgb(${fg})`; X.textAlign = 'center'; X.textBaseline = 'middle'; X.fillText(txt, x, y + 1); X.textBaseline = 'alphabetic'; X.textAlign = 'left'; X.globalAlpha = 1; return tw; }
// a white card with a coloured header band
function card(x, y, w, h, band, title, a, s = 1, bandH = 40) {
  if (a <= 0) return; X.save(); X.translate(x, y); X.scale(s, s); X.globalAlpha = a; shadow(true, 30, 12, .16); rrect(-w / 2, -h / 2, w, h, 16); X.fillStyle = '#fff'; X.fill(); shadow(false);
  X.save(); rrect(-w / 2, -h / 2, w, h, 16); X.clip(); X.fillStyle = `rgb(${band})`; X.fillRect(-w / 2, -h / 2, w, bandH); X.restore();
  font('800', 16, F.inter); X.fillStyle = '#fff'; X.letterSpacing = '1.5px'; X.fillText(title, -w / 2 + 18, -h / 2 + bandH / 2 + 6); X.letterSpacing = '0px'; X.restore(); X.globalAlpha = 1; }
function check(x, y, r, rgb, a) { X.globalAlpha = a; X.fillStyle = `rgb(${rgb})`; X.beginPath(); X.arc(x, y, r, 0, 7); X.fill(); X.strokeStyle = '#fff'; X.lineWidth = r * .28; X.lineCap = 'round'; X.beginPath(); X.moveTo(x - r * .42, y + r * .02); X.lineTo(x - r * .1, y + r * .34); X.lineTo(x + r * .45, y - r * .3); X.stroke(); X.lineCap = 'butt'; X.globalAlpha = 1; }

function backdrop(t) {
  screen(); X.globalAlpha = 1; X.globalCompositeOperation = 'source-over'; const N = night(t); X.fillStyle = `rgb(${mix('242,245,251', '6,10,24', N)})`; X.fillRect(0, 0, W, H);
  // soft brand colour fields that drift slowly, so the light background never feels flat
  [[.12, .1, BLUE, .16], [.92, .9, ORANGE, .13], [.85, .08, VIOLET, .10], [.08, .95, CYAN, .10]].forEach(([fx, fy, c, a], i) => {
    const x = W * fx + Math.sin(t * .2 + i) * 60, y = H * fy + Math.cos(t * .17 + i) * 40, r = 900; const g = X.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(c, a * (1 + N * .6))); g.addColorStop(1, rgba(c, 0)); X.fillStyle = g; X.fillRect(0, 0, W, H); });
  // blueprint grid in world space: it moves with the camera
  const ga = sm(seg(CAM[2], .2, .7)); if (ga > .01) {
    const x0 = CAM[0] - W / 2 / CAM[2], x1 = CAM[0] + W / 2 / CAM[2], y0 = CAM[1] - H / 2 / CAM[2], y1 = CAM[1] + H / 2 / CAM[2];
    world(); X.lineWidth = 1 / CAM[2];
    for (const [sp, a] of [[80, .07], [400, .13]]) { X.strokeStyle = rgba(BLUE, a * ga); X.beginPath();
      for (let gx = Math.floor(x0 / sp) * sp; gx < x1; gx += sp) { X.moveTo(gx, y0); X.lineTo(gx, y1); }
      for (let gy = Math.floor(y0 / sp) * sp; gy < y1; gy += sp) { X.moveTo(x0, gy); X.lineTo(x1, gy); } X.stroke(); }
  }
}

// ---------- the one engagement, as a production line ----------
const BELT = 30;
function engagement(t, fade) {
  world(); const z = CAM[2];
  const rev = t < 4.2 ? 0 : t < 5.8 ? eio(seg(t, 4.2, 5.8)) : 1, xr = lerp(-800, 1100, rev) + (t > 5.8 ? 4000 : 0), xe = Math.min(4500, xr);
  // the main line: git history as a conveyor belt, always moving
  if (rev > 0) { X.globalAlpha = fade; shadow(true, 18, 6, .18); rrect(-820, -BELT / 2, xe + 820, BELT, BELT / 2); X.fillStyle = `rgb(${BLUE})`; X.fill(); shadow(false);
    X.save(); rrect(-820, -BELT / 2, xe + 820, BELT, BELT / 2); X.clip(); X.strokeStyle = rgba(WHITE, .35); X.lineWidth = 4; X.beginPath(); const off = (t * 90) % 60;
    for (let x = -820 + off; x < xe; x += 60) { X.moveTo(x - 6, -8); X.lineTo(x + 4, 0); X.lineTo(x - 6, 8); } X.stroke(); X.restore();
    for (let k = 1; k <= 5; k++) { const x = -800 + k * 140; if (x < xr) { X.fillStyle = '#fff'; rrect(x - 9, -9, 18, 18, 5); X.fill(); } }
    X.globalAlpha = 1; label('主线 · GIT 记录', -800, 50, BLUE, fade * sm(seg(t, 5, 5.8)), 16, 'left', F.sans, '700'); }
  // events written once
  const evs = [[6.0, 0, 'ORION-1427', ORANGE], [7.0, 170, '反馈 #88', CYAN], [8.0, 340, '告警 5xx', YELLOW]];
  evs.forEach(([at, x, txt, rgb], i) => {
    if (!i) { if (t >= at) { const u = pulse(t, at, .7); if (u !== null) ring(x, 0, 20 + 80 * eo(u), ORANGE, (1 - u) * fade, 4); } return; } // ours is drawn by hero()
    let y = 0; if (t < at - .5) return; if (t < at) y = lerp(-620, 0, ei(seg(t, at - .5, at)));
    const sq = t >= at ? 1 - .25 * (pulse(t, at, .25) !== null ? Math.sin(Math.PI * seg(t, at, at + .25)) : 0) : 1;
    X.save(); X.translate(x, y - 34 + 76 * eio(seg(t, 8.6, 9.1))); X.scale(1, sq); shadow(true, 14, 5, .18); pill(txt, 0, 0, rgb, rgb === YELLOW ? NAVY : WHITE, fade, 17, F.sans, '700', 14, 34); shadow(false); X.restore();
    if (t >= at) { const u = pulse(t, at, .6); if (u !== null) ring(x, 0, 16 + 60 * eo(u), rgb, (1 - u) * fade, 3); }
  });
  pill('每件事只记一次', 170, 104, NAVY, WHITE, fade * sm(seg(t, 8.2, 8.6)) * (1 - sm(seg(t, 11, 12))), 16, F.sans, '700', 14, 32);
  // the rule that routes it
  const ra = sm(seg(t, 10.3, 10.6)) * (1 - sm(seg(t, 12.5, 13.3)));
  if (ra > 0) { X.globalAlpha = ra * fade; X.strokeStyle = `rgb(${ORANGE})`; X.setLineDash([8, 8]); X.lineWidth = 3; X.beginPath(); X.moveTo(600, -22); X.lineTo(600, -260); X.stroke(); X.setLineDash([]); X.globalAlpha = 1;
    const txt = '规则：Jira bug → FIX'; X.save(); X.translate(700, -120); const tw = pill(txt.slice(0, Math.max(1, Math.ceil(txt.length * seg(t, 10.4, 10.9)))), 0, 0, WHITE, ORANGE, ra * fade, 18, F.sans, '700'); X.restore();
    X.globalAlpha = ra * fade; X.strokeStyle = `rgb(${ORANGE})`; X.lineWidth = 2; rrect(700 - tw / 2, -138, tw, 36, 18); X.stroke(); X.globalAlpha = 1; }
  // stations: one per lane
  const LANE = { OPS: CYAN, FDB: VIOLET, FIX: BLUE };
  SEATS.forEach(([x, y, n], i) => {
    const a = back(seg(t, 9.4 + i * .18, 10.1 + i * .18)); if (a <= 0) return; const on = n === 'FIX' && t > 12 && t < 16.5;
    const cy = y + 60; card(x, cy, 150, 104, LANE[n], n, cl(a) * fade, cl(a, 0, 1.2));
    X.globalAlpha = cl(a) * fade; if (on) { X.strokeStyle = `rgb(${ORANGE})`; X.lineWidth = 4; rrect(x - 79, cy - 56, 158, 112, 19); X.stroke(); }
    X.globalAlpha = 1; label('工位 · worker', x, cy + 34, MUTE, cl(a) * fade, 15, 'center', F.sans, '500');
    if (n !== 'FIX') for (let q = 0; q < 3 - i; q++) { X.globalAlpha = cl(a) * fade; X.fillStyle = `rgb(${LANE[n]})`; rrect(x - 30 + q * 22, cy - 82, 16, 16, 4); X.fill(); X.globalAlpha = 1; }
  });
  { const a = back(seg(t, 12, 12.35)) * (1 - sm(seg(t, 15, 15.5))); if (a > 0) { X.save(); X.translate(800, -440); X.scale(cl(a, 0, 1.2), cl(a, 0, 1.2)); pill('#1 风险最高', 0, 0, YELLOW, NAVY, cl(a) * fade, 17, F.sans, '900'); X.restore(); } }
  // the worker's turn: a progress bar and the steps it takes
  if (t > 12 && t < 16.6) { const u = seg(t, 12.2, 15.3), a = fade * (1 - sm(seg(t, 16, 16.6))); X.globalAlpha = a; rrect(740, -272, 120, 8, 4); X.fillStyle = rgba(BLUE, .15); X.fill(); rrect(740, -272, 120 * u, 8, 4); X.fillStyle = `rgb(${ORANGE})`; X.fill(); X.globalAlpha = 1; }
  [['改 retry.ts', 12.6, BLUE], ['跑测试', 13.5, BLUE], ['3/3 通过', 14.4, GREEN]].forEach(([s, at, c], i) => { const a = fade * sm(seg(t, at, at + .2)) * (1 - sm(seg(t, 16, 16.8))); if (a <= 0) return; X.save(); X.translate(800, -180 + i * 42); X.scale(.6 + .4 * back(seg(t, at, at + .3)), 1); pill(s, 0, 0, c, WHITE, a, 16, F.sans, '700', 12, 32); X.restore(); });
  // the judge, on another model
  const ja = back(seg(t, 13.6, 14.4));
  if (ja > 0) { card(1250, -270, 190, 110, VIOLET, 'JUDGE · 审查', cl(ja) * fade, cl(ja, 0, 1.2)); label('另一个模型', 1250, -246, VIOLET, cl(ja) * fade, 19, 'center', F.sans, '700');
    if (t > 16.5 && t < 18.2) { const u = seg(t, 16.5, 18); X.globalAlpha = fade; rrect(1180, -232, 140, 8, 4); X.fillStyle = rgba(VIOLET, .15); X.fill(); rrect(1180, -232, 140 * u, 8, 4); X.fillStyle = `rgb(${VIOLET})`; X.fill(); X.globalAlpha = 1; }
    const st = back(seg(t, 18, 18.35)) * (1 - sm(seg(t, 21, 21.8))); if (st > 0) { X.save(); X.translate(1250, -440); X.scale(cl(st, 0, 1.3), cl(st, 0, 1.3)); shadow(true, 16, 6, .2); pill('✓ 通过', 0, 0, GREEN, WHITE, cl(st) * fade, 22, F.sans, '900', 20, 44); shadow(false); X.restore(); } }
  // evidence: a bar chart, belief rises with the grade
  const BASE = -110; const ca0 = sm(seg(t, 19.3, 19.7)) * fade * (1 - .5 * sm(seg(t, 25, 26)));
  if (ca0 > 0) { X.globalAlpha = ca0; X.fillStyle = rgba(NAVY, .2); X.fillRect(1470, BASE, 580, 3); X.globalAlpha = 1;
    STEPS.forEach(([x, y, cn, en], i) => { const g = eo(seg(t, 19.4 + i * .15, 19.9 + i * .15)), top = lerp(BASE, y + 14, g), lit = t > 20.5 + i * .5; const col = [CYAN, BLUE, GREEN][i];
      X.globalAlpha = ca0; shadow(true, 14, 6, .14); rrect(x - 55, top, 110, BASE - top, [10, 10, 0, 0]); X.fillStyle = lit ? `rgb(${col})` : rgba(col, .3); X.fill(); shadow(false); X.globalAlpha = 1;
      label(cn, x, BASE + 38, NAVY, ca0, 21, 'center', F.sans, '900'); label(en, x, BASE + 62, MUTE, ca0, 14, 'center', F.inter, '600'); });
    label('证据等级', 1480, BASE - 300, NAVY, ca0 * .7, 16, 'left', F.sans, '700'); }
  // the one question for the partner
  const cA = back(seg(t, 22.0, 22.6)), shrink = eio(seg(t, 24.6, 25.4));
  if (cA > 0) {
    const cx = lerp(CARD[0], CHIP[0], shrink), cy = lerp(CARD[1], CHIP[1], shrink) - 40 * shrink, s = cl(cA, 0, 1.2) * lerp(1, .2, shrink), ia = 1 - sm(seg(t, 24.6, 24.9));
    if (t > 25.3) { X.save(); X.translate(CHIP[0], CHIP[1] - 40); pill('规则 +1 · 以后都这样', 0, 0, PINK, WHITE, fade * sm(seg(t, 25.3, 25.6)), 16, F.sans, '700'); X.restore(); }
    const gone = 1 - sm(seg(t, 25.2, 25.5)); // the card has become the rule chip
    card(cx, cy, 420, 240, PINK, '只问你 · ASK', fade * gone, s, 44);
    X.save(); X.translate(cx, cy); X.scale(s, s);
    label('重试改成 3 次？', -186, -22, NAVY, ia * fade, 34, 'left', F.sans, '900');
    const tap = t > 23.5; [['1  改', -126], ['2  先不', 14]].forEach(([s_, bx], i) => { X.globalAlpha = fade * ia; rrect(bx - 60, 6, 124, 46, 23); if (i === 0 && tap) { X.fillStyle = `rgb(${PINK})`; X.fill(); } else { X.strokeStyle = rgba(NAVY, .25); X.lineWidth = 2; X.stroke(); } X.globalAlpha = 1; label(s_, bx + 2, 37, i === 0 && tap ? WHITE : NAVY, ia * fade, 19, 'center', F.sans, '700'); });
    const ft = t > 24.0; X.globalAlpha = ia * fade; rrect(-186, 72, 22, 22, 6); if (ft) { X.fillStyle = `rgb(${PINK})`; X.fill(); } else { X.strokeStyle = `rgb(${PINK})`; X.lineWidth = 2; X.stroke(); } X.globalAlpha = 1;
    if (ft) check(-175, 83, 8, PINK, 0); label('以后都这样', -154, 90, ft ? PINK : NAVY, ia * fade, 18, 'left', F.sans, '700');
    X.restore();
    if (t > 22.9 && t < 24.4) { const u = eio(seg(t, 22.9, 23.45)); const px = lerp(CARD[0] + 260, CARD[0] - 120, u), py = lerp(CARD[1] + 200, CARD[1] + 36, u), pr = pulse(t, 23.5, .3) !== null ? .85 : 1, a = fade * sm(seg(t, 22.9, 23.1)) * (1 - sm(seg(t, 24.1, 24.4)));
      X.save(); X.translate(px, py); X.scale(pr, pr); X.globalAlpha = a; shadow(true, 10, 4, .3); X.fillStyle = `rgb(${NAVY})`; X.beginPath(); X.moveTo(0, 0); X.lineTo(0, 30); X.lineTo(8, 23); X.lineTo(14, 36); X.lineTo(19, 33); X.lineTo(13, 21); X.lineTo(23, 21); X.closePath(); X.fill(); shadow(false); X.restore(); X.globalAlpha = 1;
      const u2 = pulse(t, 23.5, .45); if (u2 !== null) ring(CARD[0] - 124, CARD[1] + 29, 20 + 50 * eo(u2), PINK, (1 - u2) * fade, 3); }
  }
  // ship: a green branch, checks, the merge
  const ba = seg(t, 25.9, 26.7);
  if (ba > 0) { X.globalAlpha = fade; shadow(true, 12, 5, .15); X.strokeStyle = `rgb(${GREEN})`; X.lineWidth = 14; X.lineCap = 'round'; X.lineJoin = 'round'; X.beginPath(); const n = Math.floor(60 * eio(ba)); for (let k = 0; k <= n; k++) { const p = branch(k / 60); k ? X.lineTo(p[0], p[1]) : X.moveTo(p[0], p[1]); } X.stroke(); shadow(false); X.lineCap = 'butt'; X.globalAlpha = 1;
    X.save(); X.translate(3000, -290); pill('PR #41 · af/orion-1427', 0, 0, NAVY, WHITE, fade * sm(seg(t, 26.4, 26.8)), 17, F.inter, '700'); X.restore();
    CHECKS.forEach(({ t: at, n, p }) => { const a = sm(seg(t, 26.4, 26.8)) * fade, ok = t > at; const s = ok ? back(seg(t, at, at + .3)) : 1;
      X.save(); X.translate(p[0], p[1]); X.scale(s, s); X.globalAlpha = a; shadow(true, 10, 4, .2); X.fillStyle = ok ? `rgb(${GREEN})` : '#fff'; X.beginPath(); X.arc(0, 0, 22, 0, 7); X.fill(); shadow(false); if (!ok) { X.strokeStyle = rgba(GREEN, .6); X.lineWidth = 3; X.stroke(); } X.restore(); X.globalAlpha = 1;
      if (ok) check(p[0], p[1], 22 * cl(s, 0, 1.3), GREEN, a); label(n, p[0], p[1] + 54, ok ? GREEN : MUTE, a, 17, 'center', F.inter, '800'); const u = pulse(t, at, .6); if (u !== null) ring(p[0], p[1], 24 + 40 * eo(u), GREEN, (1 - u) * fade, 3); });
  }
  { const ap = back(seg(t, 29.2, 29.55)) * (1 - sm(seg(t, 31.2, 31.8))); if (ap > 0) { X.save(); X.translate(MERGE[0] + 150, -110); X.scale(cl(ap, 0, 1.2), cl(ap, 0, 1.2)); shadow(true, 14, 6, .2); pill('✓ 你已批准', 0, 0, PINK, WHITE, cl(ap) * fade, 19, F.sans, '900', 18, 40); shadow(false); X.restore(); } }
  if (t > 30) { // merged: a burst of colour
    const u = seg(t, 30, 31.6), cols = [ORANGE, BLUE, GREEN, VIOLET, PINK, CYAN, YELLOW];
    if (u < 1) for (let k = 0; k < 70; k++) { const ang = hash(k, 1) * Math.PI * 2, sp = 180 + hash(k, 2) * 420, d = sp * eo(u), x = MERGE[0] + Math.cos(ang) * d, y = MERGE[1] + Math.sin(ang) * d + 260 * u * u; X.save(); X.translate(x, y); X.rotate(ang + u * 8 * hash(k, 3)); X.globalAlpha = fade * (1 - u); X.fillStyle = `rgb(${cols[k % 7]})`; X.fillRect(-7, -4, 14, 8); X.restore(); }
    X.globalAlpha = 1; for (let r = 0; r < 2; r++) { const v = pulse(t, 30 + r * .12, 1.1); if (v !== null) ring(MERGE[0], 0, 20 + (200 + r * 80) * eo(v), r ? ORANGE : GREEN, (1 - v) * fade, 6 - r * 2); }
    X.save(); X.translate(MERGE[0], 60); const s = back(seg(t, 30.05, 30.4)); X.scale(s, s); shadow(true, 14, 6, .2); pill('已合并 → main', 0, 0, GREEN, WHITE, fade * cl(s), 20, F.sans, '900', 18, 40); shadow(false); X.restore(); }
  // the path it took, kept
  if (t > 5.4) { X.globalAlpha = .9 * fade; X.strokeStyle = `rgb(${ORANGE})`; X.lineWidth = Math.max(5, 2.4 / z); X.lineJoin = 'round'; X.lineCap = 'round'; X.setLineDash([2, 12]); X.beginPath(); const end = Math.min(t, 30); for (let s = 5.4; s <= end + 1e-6; s += .01) { const p = P(Math.min(s, end)); s === 5.4 ? X.moveTo(p[0], p[1]) : X.lineTo(p[0], p[1]); } const p = P(end); X.lineTo(p[0], p[1]); X.stroke(); X.setLineDash([]); X.lineCap = 'butt'; X.globalAlpha = 1; }
}

// the opening card: a Jira ticket, the id on a split-flap
function ticketCard(t) {
  if (t > 3.9) return; world(); const coll = eio(seg(t, 3.0, 3.7)); const sx = 1 - coll, sy = 1 - eio(seg(t, 3.15, 3.8)), a = sm(seg(t, .15, .5)), pop = back(seg(t, .1, .6));
  X.save(); X.translate(CARD0[0], CARD0[1]); X.scale(Math.max(.001, sx * pop), Math.max(.001, sy * pop));
  card(0, 0, 620, 230, ORANGE, 'PROJECT ORION · BUG · P1', a, 1, 48);
  X.globalAlpha = a; const txt = 'ORION-1427', CH = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  for (let i = 0; i < txt.length; i++) { const x = -282 + i * 52, settle = .7 + i * .16; let ch = txt[i]; if (t < settle && ch !== '-') ch = CH[Math.floor(hash(i, Math.floor(t * 28)) * CH.length)];
    rrect(x, -56, 46, 64, 8); X.fillStyle = `rgb(${NAVY})`; X.fill(); X.fillStyle = 'rgba(255,255,255,.15)'; X.fillRect(x, -25, 46, 2); X.fillStyle = t < settle ? 'rgba(255,255,255,.75)' : '#fff'; font('800', 40, F.inter); X.textAlign = 'center'; X.fillText(ch, x + 23, -9); X.textAlign = 'left'; }
  X.globalAlpha = a * sm(seg(t, 1.9, 2.3)); X.fillStyle = `rgb(${NAVY})`; font('900', 36, F.sans); X.fillText('支付回调超时', -282, 70);
  X.restore(); X.globalAlpha = 1;
  if (t > 1.9) { X.save(); X.translate(CARD0[0] + 200, CARD0[1] + 58); X.scale(sx, sy); pill('08:15 进来', 0, 0, ORANGE, WHITE, a * sm(seg(t, 1.9, 2.3)), 16, F.sans, '700', 12, 30); X.restore(); }
}

// ---------- a thousand engagements ----------
const CW = 6000, CHH = 560, NI = 8, NJ = 48, FCOL = [BLUE, ORANGE, GREEN, VIOLET, CYAN];
const SPARKS = Array.from({ length: 40 }, (_, k) => ({ t: 35.5 + 4.2 * Math.pow(k / 40, 1.6), i: Math.floor(hash(k, 7) * 11) - 5, j: Math.floor(hash(k, 9) * 61) - 30 })).filter(s => s.i || s.j);
window.SPARK_TIMES = SPARKS.map(s => s.t);
function cellOffset(i, j, t) { const A = 2600 * sm(seg(t, 34.5, 38.5)); return [A * Math.sin(j * .21 + t * .9 + Math.sin(i * .7 + t * .3) * 1.5), A * .6 * Math.cos(i * .33 + t * .7 + j * .05)]; }
function conv(t, sx, sy) { const d = Math.hypot(sx - W / 2, sy - H / 2) / 1100, e = eio(seg(t, 40 + d * .5, 41.2 + d * .3)); return [lerp(sx, W / 2, e), lerp(sy, H / 2, e), e]; }
function field(t) {
  const fa = sm(seg(-Math.log(CAM[2]), -Math.log(.55), -Math.log(.12))); if (fa <= 0) return;
  const z = CAM[2], N = night(t); screen(); X.lineJoin = 'round'; X.lineCap = 'round'; const QUIET = mix(MUTE, '70,86,130', N);
  for (let i = -NI; i <= NI; i++) for (let j = -NJ; j <= NJ; j++) {
    if (!i && !j) continue; const o = cellOffset(i, j, t), wx = HOME[0] + i * CW + o[0], wy = HOME[1] + j * CHH + o[1];
    let [sx, sy] = S([wx, wy]); if (sx < -300 || sx > W + 300 || sy < -60 || sy > H + 60) continue; let e; [sx, sy, e] = conv(t, sx, sy); const k = z * (1 - e * .95);
    const hsh = hash(i, j), active = hsh < .5, col = FCOL[Math.floor(hash(j, i * 5) * 5)], prog = active ? (hsh * 7.3 + (t - 32) * (.05 + hash(j, i) * .08)) % 1 : .2 + hash(j, i) * .7;
    const n = Math.max(2, Math.floor(prog * (TPL.length - 1))), wake = !active && ((t * (.35 + hsh) + hash(i * 3, j)) % 1) < .07;
    X.globalAlpha = fa * (active ? .55 : .3) * (1 - e * .6); X.strokeStyle = `rgb(${active ? BLUE : QUIET})`; X.lineWidth = Math.max(1.2, BELT * k * .6); X.beginPath(); X.moveTo(sx + (-800 - HOME[0]) * k, sy + (0 - HOME[1]) * k); X.lineTo(sx + (4400 - HOME[0]) * k, sy + (0 - HOME[1]) * k); X.stroke();
    if (active) { X.globalAlpha = fa * .85 * (1 - e * .5); X.strokeStyle = `rgb(${col})`; X.lineWidth = 1.4; X.beginPath(); for (let q = 0; q <= n; q += 2) { const p = TPL[q]; const x = sx + (p[0] - HOME[0]) * k, y = sy + (p[1] - HOME[1]) * k; q ? X.lineTo(x, y) : X.moveTo(x, y); } X.stroke(); }
    const hp = TPL[n], hx = sx + (hp[0] - HOME[0]) * k, hy = sy + (hp[1] - HOME[1]) * k;
    X.globalAlpha = fa * (active || wake ? 1 : .45); X.fillStyle = `rgb(${active ? col : wake ? YELLOW : QUIET})`; X.beginPath(); X.arc(hx, hy, active ? 3 : wake ? 3.2 : 1.6, 0, 7); X.fill();
    if (N > .05 && (active || wake)) { X.globalCompositeOperation = 'lighter'; X.globalAlpha = fa * N * .35; X.beginPath(); X.arc(hx, hy, 9, 0, 7); X.fill(); X.globalCompositeOperation = 'source-over'; }
  }
  X.globalAlpha = 1; X.lineCap = 'butt';
  const pa = sm(seg(t, 35, 35.6)) * (1 - sm(seg(t, 40.6, 41.3)));
  if (pa > 0) { const pr = 1 + .12 * Math.sin(t * 8); X.globalAlpha = pa; shadow(true, 20, 6, .3); X.fillStyle = `rgb(${PINK})`; X.beginPath(); X.arc(W / 2, H / 2 - 6, 16 * pr, 0, 7); X.fill(); shadow(false); X.strokeStyle = '#fff'; X.lineWidth = 4; X.stroke(); X.globalAlpha = 1;
    X.save(); X.translate(W / 2, H / 2 - 52); pill('你', 0, 0, PINK, WHITE, pa, 18, F.sans, '900', 14, 32); X.restore(); }
  for (const s of SPARKS) { const u = (t - s.t) / 1.1; if (u < 0 || u > 1) continue; const o = cellOffset(s.i, s.j, t), a = S([HOME[0] + s.i * CW + o[0], HOME[1] + s.j * CHH + o[1]]);
    const m = [lerp(a[0], W / 2, .5) + (a[1] - H / 2) * .3, lerp(a[1], H / 2, .5) - (a[0] - W / 2) * .3];
    for (let r = 0; r < 7; r++) { const v = eio(cl(u - r * .03)); const p = bez(a, m, m, [W / 2, H / 2 - 6], v); X.globalAlpha = (1 - r / 7) * (1 - u * .3); X.fillStyle = `rgb(${PINK})`; X.beginPath(); X.arc(p[0], p[1], 4.5 - r * .5, 0, 7); X.fill(); } X.globalAlpha = 1; }
}

// ---------- the protagonist: the ticket as an orange token ----------
function hero(t) {
  if (t < 3.3 || t > 41.4) return; screen(); let [x, y] = S(P(t)), e = 0; if (t > 40) [x, y, e] = conv(t, x, y);
  const a = sm(seg(t, 3.3, 3.8)) * (1 - sm(seg(t, 40.8, 41.4))), z = CAM[2], big = cl((z - .25) / .6) * (1 - e);
  for (let k = 10; k >= 1; k--) { const p = S(P(Math.max(3.3, t - k * .025))); if (t > 40) continue; X.globalAlpha = a * (1 - k / 11) * .35; X.fillStyle = `rgb(${ORANGE})`; X.beginPath(); X.arc(p[0], p[1] - 0, 10 * (1 - k / 12), 0, 7); X.fill(); }
  const wait = t > 22.3 && t < 23.5 ? 1 + .08 * Math.sin(t * 12) : 1, land = pulse(t, 6, .3) !== null ? 1 - .2 * Math.sin(Math.PI * seg(t, 6, 6.3)) : 1;
  X.globalAlpha = a; shadow(true, 22, 8, .28);
  if (big > .02) { X.save(); X.translate(x, y - 34 * big * z); X.scale(z * wait * cl(big + .3, 0, 1), z * wait * land * cl(big + .3, 0, 1)); pill('ORION-1427', 0, 0, ORANGE, WHITE, a, 19, F.inter, '800', 16, 40); X.restore(); }
  shadow(false); X.globalAlpha = a; X.fillStyle = `rgb(${ORANGE})`; X.beginPath(); X.arc(x, y, 9, 0, 7); X.fill(); X.strokeStyle = '#fff'; X.lineWidth = 3.5; X.stroke(); X.globalAlpha = 1;
}

// ---------- the ending ----------
function ending(t) {
  if (t < 40.9) return; screen();
  const fl = pulse(t, 41.15, .9); if (fl !== null) { X.globalAlpha = (1 - fl) * .9; X.fillStyle = '#fff'; X.fillRect(0, 0, W, H); X.globalAlpha = 1; [PINK, ORANGE, BLUE].forEach((c, i) => ring(W / 2, H / 2, 40 + (500 + i * 220) * eo(fl), c, (1 - fl), 10 - i * 2)); }
  const ca = back(seg(t, 41.3, 41.85)) * (1 - sm(seg(t, 43.0, 43.35)));
  if (ca > 0) { const s = cl(ca, 0, 1.2); card(W / 2, H / 2, 660, 260, PINK, '今天 · TODAY', cl(ca), s, 46); X.save(); X.translate(W / 2, H / 2); X.scale(s, s); X.globalAlpha = cl(ca);
    label('1 个决定等你', -296, 20, NAVY, cl(ca), 54, 'left', F.sans, '900');
    [['批准', -236], ['再看看', -96]].forEach(([s_, bx], i) => { rrect(bx - 60, 46, 124, 48, 24); if (!i) { X.fillStyle = `rgb(${PINK})`; X.fill(); } else { X.strokeStyle = rgba(NAVY, .25); X.lineWidth = 2; X.stroke(); } label(s_, bx + 2, 78, i ? NAVY : WHITE, cl(ca), 20, 'center', F.sans, '700'); });
    label('其余 1,000 个项目：在跑', 300, 78, MUTE, cl(ca), 16, 'right', F.sans, '700'); X.restore(); X.globalAlpha = 1; }
  const ta = sm(seg(t, 43.15, 43.6)), dy = (1 - eo(seg(t, 43.15, 43.8))) * 40;
  if (ta > 0) { X.globalAlpha = ta; font('900', 150, F.inter); X.letterSpacing = '-6px'; X.textAlign = 'center'; const w = X.measureText('AgentFactory').width;
    const g = X.createLinearGradient(W / 2 - w / 2, 0, W / 2 + w / 2, 0); g.addColorStop(0, `rgb(${BLUE})`); g.addColorStop(.55, `rgb(${VIOLET})`); g.addColorStop(1, `rgb(${PINK})`); X.fillStyle = g; X.fillText('AgentFactory', W / 2, H / 2 + 20 + dy); X.letterSpacing = '0px';
    X.fillStyle = `rgb(${ORANGE})`; X.beginPath(); X.arc(W / 2 + w / 2 + 20, H / 2 + 8 + dy, 14, 0, 7); X.fill();
    X.globalAlpha = sm(seg(t, 43.45, 43.9)); X.fillStyle = `rgb(${NAVY})`; font('900', 46, F.sans); X.fillText('一个人，经营一家 agent 公司。你只做决定。', W / 2, H / 2 + 116); X.textAlign = 'left';
    const tags = [['接入', ORANGE], ['分派', BLUE], ['审查', VIOLET], ['证据', CYAN], ['交付', GREEN], ['规模', YELLOW]]; let tx = W / 2 - 330;
    tags.forEach(([s_, c], i) => { const b = back(seg(t, 43.6 + i * .06, 43.95 + i * .06)); if (b <= 0) return; X.save(); X.translate(tx + 52, H / 2 + 190); X.scale(cl(b, 0, 1.2), cl(b, 0, 1.2)); pill(s_, 0, 0, c, c === YELLOW ? NAVY : WHITE, cl(b), 18, F.sans, '700', 22, 38); X.restore(); tx += 112; });
    X.globalAlpha = 1; }
  const fo = sm(seg(t, 46.4, 47)); if (fo > 0) { X.globalAlpha = fo; X.fillStyle = '#F2F5FB'; X.fillRect(0, 0, W, H); X.globalAlpha = 1; }
}

// ---------- lower third: one numbered step at a time ----------
const SUBS = [[.6, 5.3, '01', '接入', ORANGE, '早上 8:15，一张工单进来了。'], [6.2, 9.7, '02', '记录', BLUE, '每件事只记一次，写进 git 里的记录。'], [10.2, 13.8, '03', '分派', BLUE, '规则决定先做什么、交给谁。'],
  [14.2, 19.8, '04', '审查', VIOLET, '干活的和审查的，不是同一个模型。'], [20.2, 25.8, '05', '决策', PINK, '证据够硬才算数；该你拍板的，只问你。'], [26.2, 31.7, '06', '交付', GREEN, '开 PR，过检查，你批准了才合并。'],
  [32.4, 35.8, '07', '规模', CYAN, '这只是一千条线里的一条。'], [36.2, 39.9, '08', '学习', PINK, '每个回答都被记住，它问你的越来越少。']];
function subs(t) {
  screen();
  for (const [a, b, no, sec, col, s] of SUBS) { const k = sm(seg(t, a, a + .3)) * (1 - sm(seg(t, b - .3, b))); if (k <= 0) return_(); else draw(); function return_() {} function draw() {
    const x = 96, y = H - 170, slide = (1 - eo(seg(t, a, a + .45))) * -40; font('900', 38, F.sans); const tw = X.measureText(s).width;
    X.globalAlpha = k; shadow(true, 30, 10, .16); rrect(x + slide, y, 190 + tw + 50, 84, 20); X.fillStyle = '#fff'; X.fill(); shadow(false);
    rrect(x + slide, y, 170, 84, [20, 0, 0, 20]); X.fillStyle = `rgb(${col})`; X.fill();
    font('900', 30, F.inter); X.fillStyle = col === YELLOW ? `rgb(${NAVY})` : '#fff'; X.fillText(no, x + slide + 24, y + 54); font('900', 28, F.sans); X.fillText(sec, x + slide + 76, y + 54);
    font('900', 38, F.sans); X.fillStyle = `rgb(${NAVY})`; X.fillText(s, x + slide + 196, y + 56); X.globalAlpha = 1; } }
}
function hud(t) {
  screen(); const fo = 1 - sm(seg(t, 46.3, 47));
  // logo mark
  X.globalAlpha = fo; const g = X.createLinearGradient(72, 52, 120, 100); g.addColorStop(0, `rgb(${BLUE})`); g.addColorStop(1, `rgb(${VIOLET})`); rrect(72, 52, 46, 46, 12); X.fillStyle = g; X.fill();
  X.fillStyle = `rgb(${ORANGE})`; X.beginPath(); X.arc(108, 62, 6, 0, 7); X.fill(); font('900', 19, F.inter); X.fillStyle = '#fff'; X.textAlign = 'center'; X.fillText('AF', 95, 82); X.textAlign = 'left';
  font('800', 24, F.inter); X.fillStyle = `rgb(${mix(NAVY, WHITE, night(t))})`; X.fillText('AgentFactory', 132, 84); X.globalAlpha = 1;
  const nx = t >= 32, mins = 8 * 60 + 15 + Math.floor(167 * t / 32), clock = !nx ? `TODAY  ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` : `NEXT  ·  DAY ${1 + Math.floor(179 * sm(seg(t, 32.5, 40)))}`;
  font('800', 18, F.inter); const cw = X.measureText(clock).width + 36; X.globalAlpha = fo; rrect(W - 72 - cw, 56, cw, 40, 20); X.fillStyle = nx ? `rgb(${PINK})` : `rgb(${NAVY})`; X.fill(); X.fillStyle = '#fff'; X.letterSpacing = '1px'; X.fillText(clock, W - 72 - cw + 18, 82); X.letterSpacing = '0px'; X.globalAlpha = 1;
  // progress: one segment per step, in the step's colour
  const y = H - 48, x0 = 96, x1 = W - 96; X.globalAlpha = fo * .9;
  const bounds = SUBS.map(s => s[0]).concat([TOTAL]); bounds[0] = 0;
  for (let i = 0; i < SUBS.length; i++) { const a = x0 + (x1 - x0) * bounds[i] / TOTAL + 3, b = x0 + (x1 - x0) * Math.min(bounds[i + 1], 40) / TOTAL - 3; rrect(a, y, b - a, 6, 3); X.fillStyle = rgba(mix(NAVY, WHITE, night(t)), .12); X.fill();
    const f = cl((t - bounds[i]) / (Math.min(bounds[i + 1], 40) - bounds[i])); if (f > 0) { rrect(a, y, (b - a) * f, 6, 3); X.fillStyle = `rgb(${SUBS[i][4]})`; X.fill(); } }
  X.globalAlpha = 1;
}

window.render = function (t) {
  X.setTransform(1, 0, 0, 1, 0, 0); X.globalAlpha = 1; X.globalCompositeOperation = 'source-over'; X.letterSpacing = '0px'; X.setLineDash([]); shadow(false);
  CAM = cam(t); backdrop(t);
  const fade = t < 40 ? 1 : 1 - sm(seg(t, 40, 41));
  if (t < 40) engagement(t, fade);
  else { const [sx, sy, e] = conv(t, ...S(HOME)); const k = CAM[2] * (1 - e * .95), sv = CAM; CAM = [HOME[0] - (sx - W / 2) / k, HOME[1] - (sy - H / 2) / k, k]; engagement(Math.min(t, 39.99), fade); CAM = sv; }
  field(t); ticketCard(t); hero(t); ending(t); subs(t); hud(t); return 'BIZ';
};
window.SCENE_TIMES = () => ({ total: TOTAL });
