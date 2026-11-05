// AgentFactory launch film: 41 s. A typed hook, three punch cards, the title, five proof segments where a turn's
// log sits beside what it produced, a wall of a thousand engagements, and the end card. See LAUNCH-SPEC.md.
// Every frame is a pure function of t (render(t)); SOUND_EVENTS is the one timeline the music is built from.
const W = 1920, H = 1080, TOTAL = 41; window.TOTAL = TOTAL;
const cv = document.getElementById('out'); cv.width = W; cv.height = H; const X = cv.getContext('2d');
const LANG = window.LANG || 'en';
const F = { ui: 'Inter, "AF Sans"', mono: '"JetBrains Mono", "AF Sans", monospace', cjk: '"AF Sans", Inter' };
window.ready = Promise.all(['900 40px Inter', '800 40px Inter', '600 40px Inter', '500 40px "JetBrains Mono"', '700 40px "JetBrains Mono"', '900 40px "AF Sans"', '700 40px "AF Sans"'].map(s => document.fonts.load(s, '字Aa1')));

const C = { bg: '#070b16', ink: '#f2f5ff', ink2: '#9aa6c4', ink3: '#5d6a8a', blue: '#4d86ff', orange: '#ff7a1a', green: '#22d38b', violet: '#9b6dff', pink: '#ff3d7f', cyan: '#18c4e6', yellow: '#ffc21a', red: '#ff5a47' };
const cl = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)), lerp = (a, b, u) => a + (b - a) * u, seg = (t, a, b) => cl((t - a) / (b - a));
const sm = x => { x = cl(x); return x * x * (3 - 2 * x); }, eo = x => 1 - Math.pow(1 - cl(x), 3), eio = x => { x = cl(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
// damped spring 0→1 from t0 (from the code-video skill's motion grammar): a decisive move, an overshoot, a settle
function spring(t, t0, freq = 2.2, zeta = .55) { const x = Math.max(0, t - t0), w = 2 * Math.PI * freq, wd = w * Math.sqrt(1 - zeta * zeta); return x <= 0 ? 0 : 1 - Math.exp(-zeta * w * x) * (Math.cos(wd * x) + (zeta * w / wd) * Math.sin(wd * x)); }
function hash(i, j) { let h = Math.imul((i * 374761393 + j * 668265263) | 0, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const font = (w, s, f) => { X.font = `${w} ${s}px ${f}`; };
function rr(x, y, w, h, r) { X.beginPath(); X.roundRect(x, y, w, h, r); }
function text(s, x, y, color, size, w = '700', f = F.ui, align = 'left', a = 1) { if (a <= 0) return 0; X.globalAlpha = a; X.fillStyle = color; font(w, size, f); X.textAlign = align; X.fillText(s, x, y); const m = X.measureText(s).width; X.textAlign = 'left'; X.globalAlpha = 1; return m; }
function pill(s, x, y, bg, fg, a, size = 22, w = '800', f = F.ui, padX = 18, h = 44, stroke) {
  if (a <= 0) return 0; font(w, size, f); const tw = X.measureText(s).width + padX * 2; X.globalAlpha = a; rr(x - tw / 2, y - h / 2, tw, h, h / 2);
  if (bg) { X.fillStyle = bg; X.fill(); } if (stroke) { X.strokeStyle = stroke; X.lineWidth = 2.5; X.stroke(); }
  X.fillStyle = fg; X.textAlign = 'center'; X.textBaseline = 'middle'; X.fillText(s, x, y + 1); X.textBaseline = 'alphabetic'; X.textAlign = 'left'; X.globalAlpha = 1; return tw; }
function glow(x, y, r, color, a) { const g = X.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, color + Math.round(a * 255).toString(16).padStart(2, '0')); g.addColorStop(1, color + '00'); X.fillStyle = g; X.fillRect(x - r, y - r, 2 * r, 2 * r); }

// ---------- copy: the only strings on screen ----------
const COPY = {
  en: {
    hookCmd: '$ npm run harness -- loop',
    hook: [['wake 08:15 · 1 event · jira ORION-1427', C.ink], ['→ playbook jira-bug · triage on claude:opus', C.violet], ['→ job logs · 42 lines saved', C.cyan], ['→ ask reply-1427 · waiting on you', C.pink]],
    punch: [['No standups.', ''], ['No babysitting.', ''], ['Just ', 'your calls.']],
    title: 'A firm of agents that keeps working for months.',
    segs: ['Triage', 'Diagnose', 'Your call', 'Failing test first', 'Ship'],
    segSub: ['a strong model reads the ticket', 'logs and code, then a second read', 'one tap, kept as a rule', 'the red is the proof', 'a review on another model · merging is yours'],
    jira: { kind: 'JIRA · BUG · P1', title: 'Checkout webhooks time out (EU)', status: 'Status', open: 'Open', triaged: 'Triaged', comp: 'Component', none: '—', reporter: 'Reporter', who: 'support desk' },
    diag: { head: 'DIAGNOSIS', verdict: 'Verdict', bug: 'bug', evid: 'Evidence', e1: 'retry.ts:88 · one 30 s timeout for every try', e2: '42 log lines · eu-1 only', cond: 'CONDUCTOR · accept' },
    slack: { head: 'AgentFactory · orion', q: 'Reply to the reporter?', quote: '“Confirmed, the bug is on our side. A fix is on the way.”', b1: 'Send', b2: 'Edit', b3: "Don't send", keep: 'from now on' },
    test: { fail: 'FAILS ON THE BUG', pass: 'PASSES WITH THE FIX' },
    pr: { title: 'Retry EU webhooks with backoff per attempt', branch: 'af/ORION-1427 → main', c1: 'unit', c2: 'e2e', c3: 'review · a different model', merge: 'Merge pull request', merged: 'Merged', reply: 'Reply sent: fixed · ticket resolved' },
    wall1: 'One partner.', wall2: 'A thousand engagements.', wallCount: 'engagements', wallAsk: '1 question waiting on you',
    end: 'One person. A firm of agents. You make the calls.', endCn: '一个人，经营一家 agent 公司',
  },
  zh: {
    hookCmd: '$ npm run harness -- loop',
    hook: [['wake 08:15 · 1 event · jira ORION-1427', C.ink], ['→ playbook jira-bug · triage on claude:opus', C.violet], ['→ job logs · 42 lines saved', C.cyan], ['→ ask reply-1427 · waiting on you', C.pink]],
    punch: [['不开站会。', ''], ['不用盯着。', ''], ['只等', '你拍板。']],
    title: '一家 agent 公司，连续干上几个月。',
    segs: ['分诊', '诊断', '你来拍板', '先写失败的测试', '交付'],
    segSub: ['强模型先读工单', '日志和代码，再复读一遍', '点一下，以后都这样', '红色就是证据', '另一个模型审查 · 合并由你'],
    jira: { kind: 'JIRA · BUG · P1', title: '结账回调超时（欧洲区）', status: '状态', open: '待处理', triaged: '已分诊', comp: '服务', none: '—', reporter: '报告人', who: '客服台' },
    diag: { head: '诊断', verdict: '结论', bug: 'bug', evid: '证据', e1: 'retry.ts:88 · 每次重试共用 30 秒', e2: '42 行日志 · 只在 eu-1', cond: 'CONDUCTOR · 同意' },
    slack: { head: 'AgentFactory · orion', q: '回复报告人？', quote: '“确认是我们这边的 bug，修复正在路上。”', b1: '发送', b2: '我来改', b3: '不发', keep: '以后都这样' },
    test: { fail: '在 bug 上失败', pass: '修复后通过' },
    pr: { title: '欧洲区回调按次退避重试', branch: 'af/ORION-1427 → main', c1: 'unit', c2: 'e2e', c3: 'review · 另一个模型', merge: '合并 PR', merged: '已合并', reply: '已回复报告人：已修复 · 工单关闭' },
    wall1: '一个合伙人。', wall2: '一千个项目。', wallCount: '个项目', wallAsk: '今天 1 个问题等你',
    end: '一个人，经营一家 agent 公司。你只做决定。', endCn: 'One person. A firm of agents. You make the calls.',
  },
}[LANG];
const CJK = LANG === 'zh';
const UI = CJK ? F.cjk : F.ui;

// ---------- the sound timeline, exported for music_launch.py ----------
const EV = [];
COPY.hookCmd.split('').forEach((c, i) => { if (c !== ' ') EV.push({ t: .35 + i * .05, name: 'key' }); });
[1.9, 2.3, 2.7, 3.1].forEach(t => EV.push({ t, name: 'line' }));
[4, 6, 8].forEach(t => EV.push({ t, name: 'punch' }));
EV.push({ t: 10, name: 'boom' });
[12, 16, 20, 24, 28, 32].forEach(t => EV.push({ t: t - .05, name: 'whoosh' }));
EV.push({ t: 14.6, name: 'pop' }, { t: 18.6, name: 'stamp' }, { t: 22.0, name: 'tap' }, { t: 22.6, name: 'tick' }, { t: 25.0, name: 'fail' }, { t: 25.8, name: 'pass' }, { t: 26.8, name: 'pass2' });
EV.push({ t: 29.0, name: 'check' }, { t: 29.25, name: 'check' }, { t: 29.5, name: 'check' }, { t: 29.95, name: 'tap' }, { t: 30, name: 'merge' }, { t: 30.8, name: 'chime' }, { t: 32.2, name: 'shimmer' }, { t: 36, name: 'boom' });
window.SOUND_EVENTS = EV;

// ---------- pieces ----------
function backdrop(t) {
  X.setTransform(1, 0, 0, 1, 0, 0); X.globalAlpha = 1; X.fillStyle = C.bg; X.fillRect(0, 0, W, H);
  [[.18, .2, C.blue, .22], [.85, .75, C.violet, .18], [.75, .15, C.orange, .08], [.2, .9, C.cyan, .08]].forEach(([fx, fy, c, a], i) => glow(W * fx + Math.sin(t * .23 + i) * 80, H * fy + Math.cos(t * .19 + i) * 50, 900, c, a));
  X.fillStyle = 'rgba(154,166,196,.07)'; const off = (t * 6) % 48; for (let x = -48 + off; x < W; x += 48) for (let y = 0; y < H; y += 48) X.fillRect(x, y, 2, 2);
}
// a window like the reference's editor and preview panes: title bar, three dots, a file name, a readout on the right
function win(x, y, w, h, title, hud, a, accent) {
  if (a <= 0) return; X.save(); X.globalAlpha = a;
  X.shadowColor = 'rgba(0,0,0,.55)'; X.shadowBlur = 50; X.shadowOffsetY = 18; rr(x, y, w, h, 16); X.fillStyle = 'rgba(14,19,34,.96)'; X.fill(); X.shadowColor = 'transparent';
  X.strokeStyle = accent ? accent + '66' : 'rgba(255,255,255,.09)'; X.lineWidth = 1.5; X.stroke();
  rr(x, y, w, 46, [16, 16, 0, 0]); X.fillStyle = 'rgba(255,255,255,.04)'; X.fill();
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { X.fillStyle = c; X.beginPath(); X.arc(x + 24 + i * 20, y + 23, 6, 0, 7); X.fill(); });
  font('500', 19, F.mono); X.fillStyle = C.ink2; X.fillText(title, x + 92, y + 30);
  if (hud) { font('600', 18, F.mono); X.textAlign = 'right'; X.fillStyle = accent || C.ink3; X.fillText(hud, x + w - 22, y + 30); X.textAlign = 'left'; }
  X.restore();
}
// terminal lines: [text, color, at, typed?]; typed lines reveal at 34 characters a second
function term(x, y, lines, t, a, size = 22, lh = 36) {
  if (a <= 0) return; X.save(); X.globalAlpha = a; font('500', size, F.mono);
  let last = null;
  lines.forEach(([s, col, at, typed], i) => {
    if (t < at) return; const n = typed ? Math.min(s.length, Math.floor((t - at) * 34)) : s.length; const k = typed ? 1 : sm(seg(t, at, at + .18));
    X.globalAlpha = a * k; X.fillStyle = col; X.fillText(s.slice(0, n), x + (1 - k) * 14, y + i * lh); last = [x + X.measureText(s.slice(0, n)).width + 4, y + i * lh];
  });
  if (last && Math.floor(t * 2.4) % 2 === 0) { X.globalAlpha = a; X.fillStyle = C.ink; X.fillRect(last[0], last[1] - size + 3, 11, size); }
  X.restore();
}
function chk(x, y, r, col, a, kind = 'ok') { if (a <= 0) return; X.globalAlpha = a; X.fillStyle = col; X.beginPath(); X.arc(x, y, r, 0, 7); X.fill(); X.strokeStyle = '#fff'; X.lineWidth = r * .26; X.lineCap = 'round'; X.beginPath();
  if (kind === 'ok') { X.moveTo(x - r * .42, y + r * .02); X.lineTo(x - r * .1, y + r * .34); X.lineTo(x + r * .45, y - r * .3); } else { X.moveTo(x - r * .35, y - r * .35); X.lineTo(x + r * .35, y + r * .35); X.moveTo(x + r * .35, y - r * .35); X.lineTo(x - r * .35, y + r * .35); }
  X.stroke(); X.lineCap = 'butt'; X.globalAlpha = 1; }
function cursor(x, y, s, a) { if (a <= 0) return; X.save(); X.translate(x, y); X.scale(s, s); X.globalAlpha = a; X.shadowColor = 'rgba(0,0,0,.5)'; X.shadowBlur = 10; X.fillStyle = '#fff'; X.beginPath(); X.moveTo(0, 0); X.lineTo(0, 34); X.lineTo(9, 26); X.lineTo(16, 41); X.lineTo(22, 38); X.lineTo(15, 24); X.lineTo(27, 24); X.closePath(); X.fill(); X.restore(); }

// ---------- 0-4 s: the hook ----------
function hook(t) {
  if (t > 4.1) return; const a = sm(seg(t, 0, .3)) * (1 - sm(seg(t, 3.7, 4.05))), s = lerp(.94, 1, eo(seg(t, 0, 1.2))) * lerp(1, 1.08, sm(seg(t, 3.6, 4.05)));
  X.save(); X.translate(W / 2, H / 2); X.scale(s, s); X.translate(-W / 2, -H / 2);
  win(420, 330, 1080, 420, 'orion · harness', 'main', a, C.blue);
  term(460, 430, [[COPY.hookCmd, C.ink, .35, true], ...COPY.hook.map(([s, c], i) => [s, c, 1.9 + i * .4, false])], t, a, 26, 52);
  X.restore();
}
// ---------- 4-10 s: three punch cards ----------
function punch(t) {
  if (t < 3.9 || t > 10.1) return; const i = Math.max(0, Math.min(2, Math.floor((t - 4) / 2))), t0 = 4 + i * 2, [p1, p2] = COPY.punch[i];
  const k = spring(t, t0, 2.4, .5), out = sm(seg(t, t0 + 1.75, t0 + 2)), a = cl(k * 1.4) * (1 - out);
  const size = CJK ? 132 : 140; font('900', size, UI); const w1 = X.measureText(p1).width, w2 = p2 ? X.measureText(p2).width : 0, x0 = W / 2 - (w1 + w2) / 2, y = H / 2 + 46 + (1 - k) * 60 - out * 30;
  X.globalAlpha = .06 * a; font('900', 420, UI); X.strokeStyle = C.ink; X.lineWidth = 2; X.textAlign = 'center'; X.strokeText((p1 + p2).replace(/[.。]/g, ''), W / 2 + (t - t0) * -40, H / 2 + 150); X.textAlign = 'left'; X.globalAlpha = 1;
  text(p1, x0, y, C.ink, size, '900', UI, 'left', a); if (p2) { const g = X.createLinearGradient(x0 + w1, 0, x0 + w1 + w2, 0); g.addColorStop(0, C.pink); g.addColorStop(1, C.orange); text(p2, x0 + w1, y, g, size, '900', UI, 'left', a); }
}
// ---------- 10-12 s: the title ----------
// typed fast, so the line holds long enough to read before the cut
function title(t) {
  if (t < 9.9 || t > 12.2) return; const k = spring(t, 10, 1.8, .6), a = cl(k * 1.5) * (1 - sm(seg(t, 11.75, 12.05)));
  X.save(); X.translate(W / 2, H / 2 - 30); X.scale(lerp(.86, 1, k), lerp(.86, 1, k)); font('900', 180, F.ui); X.letterSpacing = '-7px'; const w = X.measureText('AgentFactory').width;
  const g = X.createLinearGradient(-w / 2, 0, w / 2, 0); g.addColorStop(0, C.blue); g.addColorStop(.55, C.violet); g.addColorStop(1, C.pink);
  X.globalAlpha = a; X.fillStyle = g; X.textAlign = 'center'; X.fillText('AgentFactory', 0, 50); X.letterSpacing = '0px'; X.fillStyle = C.orange; X.beginPath(); X.arc(w / 2 + 24, 36, 17, 0, 7); X.fill(); X.restore();
  const s = COPY.title, n = Math.floor(cl((t - 10.15) * 110, 0, s.length)); text(s.slice(0, n), W / 2, H / 2 + 110, C.ink2, CJK ? 40 : 38, '700', CJK ? F.cjk : F.mono, 'center', a);
}

// ---------- 12-32 s: five proof segments, a turn's log beside what it made ----------
const SEG0 = 12, SEGD = 4;
function segIn(t, i) { const t0 = SEG0 + i * SEGD; return { t0, k: spring(t, t0, 1.9, .62), out: sm(seg(t, t0 + SEGD - .32, t0 + SEGD)), lt: t - t0 }; }
function segFrame(t, i, termLines, termTitle, termHud, outcome, accent) {
  const { t0, k, out, lt } = segIn(t, i); if (t < t0 - .05 || t > t0 + SEGD + .05) return;
  const flip = i % 2 === 1, a = cl(k * 1.3) * (1 - out);
  // label, the way the reference names each kind of film above its panes
  const lx = flip ? 1810 : 110, al = flip ? 'right' : 'left';
  pill(String(i + 1).padStart(2, '0'), flip ? 1810 - 28 : 110 + 28, 176, accent, '#fff', a, 22, '900', F.ui, 14, 40);
  text(COPY.segs[i], flip ? 1810 - 70 : 110 + 70, 194, C.ink, 60, '900', UI, al, a * cl(k * 1.4));
  text(COPY.segSub[i], flip ? 1810 : 110, 248, C.ink2, CJK ? 30 : 28, '700', UI, al, a * sm(seg(lt, .25, .6)));
  const tx = flip ? 1030 : 110, ox = flip ? 110 : 960, dx = (1 - k) * (flip ? 160 : -160) + out * (flip ? 80 : -80);
  X.save(); X.translate(dx, 0); win(tx, 300, 780, 520, termTitle, termHud, a, null); term(tx + 34, 392, termLines, lt, a, 22, 40); X.restore();
  X.save(); X.translate(-dx, 0); outcome(ox, 270, lt, a); X.restore();
}
function card(x, y, w, h, a, head, headCol) { win(x, y, w, h, head, '', a, headCol); }
function field(x, y, k, v, vcol, a, size = 30) { text(k, x, y, C.ink3, 22, '700', UI, 'left', a); text(v, x, y + 40, vcol, size, '800', UI, 'left', a); }

function segTriage(t) {
  segFrame(t, 0, [
    ['turn 0141 · triage · claude:opus', C.violet, .1, false], ['> read ORION-1427', C.ink, .35, true], ['> outcome: route', C.ink, 1.0, true], ['  service   checkout-api', C.cyan, 1.5, false],
    ['  search    "webhook" "timeout" eu', C.cyan, 1.7, false], ['  window    07:40–08:15', C.cyan, 1.9, false], ['✓ done · the harness adds the next steps', C.green, 2.4, false],
  ], 'turn 0141.log', 'claude:opus', (x, y, lt, a) => {
    card(x, y, 850, 580, a, 'jira · ORION-1427', C.orange); pill(COPY.jira.kind, x + 40 + 120, y + 100, C.orange, '#fff', a, 20, '900', F.ui, 16, 40);
    text(COPY.jira.title, x + 40, y + 180, C.ink, CJK ? 44 : 42, '900', UI, 'left', a);
    const st = lt > 2.6; field(x + 40, y + 260, COPY.jira.status, st ? COPY.jira.triaged : COPY.jira.open, st ? C.green : C.ink2, a);
    field(x + 420, y + 260, COPY.jira.comp, lt > 2.6 ? 'checkout-api' : COPY.jira.none, lt > 2.6 ? C.cyan : C.ink2, a);
    field(x + 40, y + 380, COPY.jira.reporter, COPY.jira.who, C.ink2, a);
    const u = spring(lt, 2.6, 2.6, .5); if (u > 0) { X.save(); X.translate(x + 640, y + 470); X.scale(u, u); pill('playbook · jira-bug', 0, 0, null, C.violet, a, 22, '800', F.mono, 18, 46, C.violet); X.restore(); }
  }, C.violet);
}
function segDiagnose(t) {
  segFrame(t, 1, [
    ['job logs · checkout-api.log · 42 lines', C.cyan, .1, false], ['08:02:11 WARN  webhook POST eu-1 try=1', C.ink2, .4, false], ['08:02:41 ERROR webhook timeout 30000ms', C.red, .6, false],
    ['  at sendWebhook (retry.ts:88)', C.ink2, .8, false], ['  at retryLoop (retry.ts:61)', C.ink2, .95, false], ['08:03:11 ERROR webhook timeout 30000ms', C.red, 1.1, false], ['turn 0143 · diagnose → bug', C.blue, 1.6, false],
  ], 'logs/ORION-1427.txt', 'a job, not a turn', (x, y, lt, a) => {
    card(x, y, 850, 580, a, 'diagnose · ORION-1427', C.blue); text(COPY.diag.head, x + 40, y + 110, C.blue, 24, '900', UI, 'left', a);
    field(x + 40, y + 150, COPY.diag.verdict, lt > 1.6 ? COPY.diag.bug : '…', C.red, a, 48);
    text(COPY.diag.evid, x + 40, y + 300, C.ink3, 22, '700', UI, 'left', a);
    text('· ' + COPY.diag.e1, x + 40, y + 345, C.ink, CJK ? 30 : 28, '700', UI, 'left', a * sm(seg(lt, 1.8, 2.1)));
    text('· ' + COPY.diag.e2, x + 40, y + 395, C.ink, CJK ? 30 : 28, '700', UI, 'left', a * sm(seg(lt, 2.0, 2.3)));
    const u = spring(lt, 2.6, 2.4, .45); if (u > 0) { X.save(); X.translate(x + 425, y + 490); X.rotate(-.05 * (1 - cl(u))); X.scale(u, u); pill('✓ ' + COPY.diag.cond, 0, 0, C.violet, '#fff', a, 28, '900', UI, 24, 60); X.restore(); }
  }, C.blue);
}
function segCall(t) {
  segFrame(t, 2, [
    ['events/000143-answer.json', C.ink3, .1, false], ['{', C.ink2, 2.2, false], ['  "kind": "answer",', C.ink, 2.3, true], ['  "ask": "reply-1427",', C.ink, 2.55, true],
    ['  "choice": "send",', C.green, 2.8, true], ['  "by": "partner",', C.pink, 3.0, true], ['  "standing": true', C.pink, 3.2, true], ['}', C.ink2, 3.4, false],
  ], 'event log · git', 'append-only', (x, y, lt, a) => {
    card(x, y, 850, 580, a, 'slack · ' + COPY.slack.head, C.pink); text(COPY.slack.q, x + 40, y + 130, C.ink, CJK ? 46 : 44, '900', UI, 'left', a);
    text(COPY.slack.quote, x + 40, y + 200, C.ink2, CJK ? 30 : 27, '700', UI, 'left', a);
    const tap = lt > 2.0; const bx = [x + 40, x + 260, x + 480];
    [COPY.slack.b1, COPY.slack.b2, COPY.slack.b3].forEach((s, i) => { X.globalAlpha = a; rr(bx[i], y + 260, 200, 64, 14); if (!i) { X.fillStyle = tap ? C.pink : 'rgba(255,61,127,.18)'; X.fill(); } X.strokeStyle = i ? 'rgba(255,255,255,.2)' : C.pink; X.lineWidth = 2; X.stroke(); X.globalAlpha = 1; text(s, bx[i] + 100, y + 302, i ? C.ink2 : '#fff', 26, '800', UI, 'center', a); });
    const kp = lt > 2.6; X.globalAlpha = a; rr(x + 40, y + 370, 34, 34, 8); if (kp) { X.fillStyle = C.pink; X.fill(); } X.strokeStyle = C.pink; X.lineWidth = 2.5; X.stroke(); X.globalAlpha = 1; if (kp) chk(x + 57, y + 387, 13, C.pink, a);
    text(COPY.slack.keep, x + 92, y + 398, kp ? C.pink : C.ink2, 28, '800', UI, 'left', a);
    const cu = eio(seg(lt, 1.2, 1.9)), cs = lt > 1.95 && lt < 2.1 ? .85 : 1, ca = a * sm(seg(lt, 1.1, 1.3)) * (1 - sm(seg(lt, 3.0, 3.3)));
    const cx = lerp(x + 700, x + 140, cu) + (lt > 2.2 ? lerp(0, -80, eio(seg(lt, 2.2, 2.55))) : 0), cy = lerp(y + 520, y + 300, cu) + (lt > 2.2 ? lerp(0, 90, eio(seg(lt, 2.2, 2.55))) : 0);
    cursor(cx, cy, cs, ca); [2.0, 2.6].forEach(at => { const v = seg(lt, at, at + .5); if (v > 0 && v < 1) { X.globalAlpha = (1 - v) * a; X.strokeStyle = C.pink; X.lineWidth = 3; X.beginPath(); X.arc(at < 2.5 ? x + 140 : x + 57, at < 2.5 ? y + 292 : y + 387, 20 + 60 * eo(v), 0, 7); X.stroke(); X.globalAlpha = 1; } });
  }, C.pink);
}
function segTest(t) {
  segFrame(t, 3, [
    ['$ npm test        # with the new test', C.ink, .1, true], ['✗ retry.eu.test.ts', C.red, .95, false], ['  1 failing', C.red, 1.05, false], ['$ npm test        # on the base commit', C.ink, 1.3, true],
    ['✓ 213 passing', C.green, 1.8, false], ['-- fix: backoff per attempt --', C.ink3, 2.2, false], ['$ npm test', C.ink, 2.4, true], ['✓ 214 passing', C.green, 2.8, false],
  ], 'checkout-api · test', 'service suite', (x, y, lt, a) => {
    card(x, y, 850, 580, a, 'test/retry.eu.test.ts', lt > 2.8 ? C.green : C.red);
    const code = [['test("a timed-out EU webhook is retried", async () => {', C.ink], ['  const hook = await send(eu, { timeoutMs: 30000 });', C.ink2], ['  assert.equal(hook.attempts, 3);', C.yellow], ['});', C.ink]];
    font('500', 22, F.mono); code.forEach(([s, c], i) => { X.globalAlpha = a; X.fillStyle = C.ink3; X.fillText(String(i + 1), x + 34, y + 120 + i * 44); X.fillStyle = c; X.fillText(s, x + 70, y + 120 + i * 44); }); X.globalAlpha = 1;
    const red = lt > .95 && lt < 2.8, green = lt >= 2.8; const u = red ? spring(lt, .95, 2.4, .45) : spring(lt, 2.8, 2.4, .45);
    if (red || green) { X.save(); X.translate(x + 425, y + 400); X.scale(u, u); const col = green ? C.green : C.red; X.globalAlpha = a; rr(-330, -62, 660, 124, 24); X.fillStyle = col + '22'; X.fill(); X.strokeStyle = col; X.lineWidth = 3; X.stroke(); X.globalAlpha = 1;
      chk(-250, 0, 34, col, a, green ? 'ok' : 'x'); text(green ? COPY.test.pass : COPY.test.fail, 30, 14, col, CJK ? 44 : 40, '900', UI, 'center', a); X.restore(); }
  }, C.red);
}
function segShip(t) {
  segFrame(t, 4, [
    ['turn 0147 · review · claude:opus', C.violet, .1, false], ['verdict: accept', C.green, .5, true], ['note: the test reproduces the timeout;', C.ink, .9, true], ['      the fix is the smallest change', C.ink, 1.4, true],
    ['posted as a COMMENT, not an approval', C.ink2, 2.0, false], ['ship · waiting for your approval', C.pink, 2.4, false],
  ], 'turn 0147.log', 'a different model', (x, y, lt, a) => {
    card(x, y, 850, 580, a, 'pull request #2318', C.green); text(COPY.pr.title, x + 40, y + 120, C.ink, CJK ? 40 : 34, '900', UI, 'left', a); text(COPY.pr.branch, x + 40, y + 165, C.ink3, 22, '600', F.mono, 'left', a);
    [COPY.pr.c1, COPY.pr.c2, COPY.pr.c3].forEach((s, i) => { const at = 1.0 + i * .25, ok = lt > at; X.globalAlpha = a; rr(x + 40, y + 200 + i * 70, 770, 56, 12); X.fillStyle = 'rgba(255,255,255,.04)'; X.fill(); X.globalAlpha = 1;
      if (ok) chk(x + 72, y + 228 + i * 70, 16, C.green, a * spring(lt, at, 3, .5)); else { X.globalAlpha = a; X.strokeStyle = C.ink3; X.lineWidth = 3; X.beginPath(); X.arc(x + 72, y + 228 + i * 70, 14, 0, 7); X.stroke(); X.globalAlpha = 1; }
      text(s, x + 104, y + 238 + i * 70, ok ? C.ink : C.ink3, 26, '800', UI, 'left', a); });
    const merged = lt > 2.0; X.globalAlpha = a; rr(x + 40, y + 420, 380, 70, 14); X.fillStyle = merged ? C.violet : C.green; X.fill(); X.globalAlpha = 1;
    text(merged ? '✓ ' + COPY.pr.merged : COPY.pr.merge, x + 230, y + 466, '#fff', 28, '900', UI, 'center', a);
    const cu = eio(seg(lt, 1.3, 1.9)); cursor(lerp(x + 760, x + 300, cu), lerp(y + 560, y + 460, cu), lt > 1.93 && lt < 2.05 ? .85 : 1, a * sm(seg(lt, 1.2, 1.4)) * (1 - sm(seg(lt, 2.4, 2.7))));
    if (merged) for (let k = 0; k < 60; k++) { const v = seg(lt, 2.0, 3.4); if (v >= 1) break; const ang = hash(k, 3) * Math.PI * 2, d = (200 + hash(k, 4) * 400) * eo(v); X.save(); X.translate(x + 230 + Math.cos(ang) * d, y + 455 + Math.sin(ang) * d + 300 * v * v); X.rotate(v * 9 * hash(k, 5)); X.globalAlpha = a * (1 - v); X.fillStyle = [C.orange, C.blue, C.green, C.violet, C.pink, C.cyan, C.yellow][k % 7]; X.fillRect(-8, -4, 16, 8); X.restore(); }
    const rs = spring(lt, 2.8, 2.4, .55); if (rs > 0) { X.save(); X.translate(x + 425, y + 540); X.scale(rs, rs); pill(COPY.pr.reply, 0, 0, null, C.green, a, 24, '800', UI, 20, 48, C.green); X.restore(); }
  }, C.green);
}

// ---------- 32-36 s: a thousand engagements, one partner ----------
function wall(t) {
  if (t < 31.9 || t > 36.2) return; const lt = t - 32, gather = eio(seg(t, 35.4, 36)), a = sm(seg(lt, 0, .25)) * (1 - sm(seg(t, 35.8, 36.05)));
  const cols = 16, rows = 9, cw = 112, ch = 112, ox = W / 2 - (cols * cw) / 2, oy = H / 2 - (rows * ch) / 2;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const cx = ox + i * cw + cw / 2, cy = oy + j * ch + ch / 2, d = Math.hypot(cx - W / 2, cy - H / 2) / 1100, s = spring(lt, d * .7, 2.2, .6) * (1 - gather);
    if (s <= 0) continue; const h = hash(i, j), col = [C.blue, C.orange, C.green, C.violet, C.cyan][Math.floor(h * 5)], active = h < .6;
    const px = lerp(cx, W / 2, gather), py = lerp(cy, H / 2, gather);
    X.save(); X.translate(px, py); X.scale(s, s); X.globalAlpha = a * .95; rr(-48, -48, 96, 96, 14); X.fillStyle = 'rgba(18,24,42,.95)'; X.fill(); X.strokeStyle = active ? col + '88' : 'rgba(255,255,255,.08)'; X.lineWidth = 1.5; X.stroke();
    X.fillStyle = 'rgba(255,255,255,.12)'; X.fillRect(-34, 18, 68, 4); const p = active ? ((h * 9 + lt * (.3 + hash(j, i) * .4)) % 1) : .3; X.fillStyle = active ? col : C.ink3; X.beginPath(); X.arc(-34 + 68 * p, 20, 6, 0, 7); X.fill();
    X.fillStyle = active ? col : C.ink3; X.fillRect(-34, -28, 28 + 30 * hash(i * 2, j), 6); X.fillStyle = 'rgba(255,255,255,.15)'; X.fillRect(-34, -14, 50, 5); X.restore();
  }
  X.globalAlpha = 1; const n = Math.round(lerp(1, 1000, eo(seg(lt, .2, 2.4)))), plate = a * sm(seg(lt, .5, .9));
  if (plate > 0) { X.globalAlpha = plate; rr(W / 2 - 700, H / 2 - 120, 1400, 240, 28); X.fillStyle = 'rgba(7,11,22,.9)'; X.fill(); X.strokeStyle = 'rgba(255,255,255,.1)'; X.lineWidth = 1.5; X.stroke(); X.globalAlpha = 1;
    const w1 = (font('900', 64, UI), X.measureText(COPY.wall1).width), w2 = X.measureText(' ' + COPY.wall2).width, x0 = W / 2 - (w1 + w2) / 2;
    text(COPY.wall1, x0, H / 2 + 10, C.pink, 64, '900', UI, 'left', plate); text(' ' + COPY.wall2, x0 + w1, H / 2 + 10, C.ink, 64, '900', UI, 'left', plate);
    text(`${n.toLocaleString('en-US')} ${COPY.wallCount} · ${COPY.wallAsk}`, W / 2, H / 2 + 80, C.ink2, CJK ? 32 : 30, '700', UI, 'center', plate); }
}
// ---------- 36-41 s: the end card ----------
function endCard(t) {
  if (t < 35.9) return; const k = spring(t, 36, 1.7, .62), a = cl(k * 1.4) * (1 - sm(seg(t, 40.4, 41)));
  const fl = seg(t, 35.95, 36.6); if (fl < 1) { X.globalAlpha = (1 - fl) * .8; glow(W / 2, H / 2, 300 + 1200 * eo(fl), '#ffffff', .9); X.globalAlpha = 1; }
  X.save(); X.translate(W / 2, H / 2 - 120); X.scale(lerp(.9, 1, k), lerp(.9, 1, k)); X.globalAlpha = .05 * a; font('900', 330, F.ui); X.strokeStyle = C.ink; X.lineWidth = 2; X.textAlign = 'center'; X.strokeText('AgentFactory', (t - 36) * -30, 120);
  font('900', 170, F.ui); X.letterSpacing = '-7px'; const w = X.measureText('AgentFactory').width; const g = X.createLinearGradient(-w / 2, 0, w / 2, 0); g.addColorStop(0, C.blue); g.addColorStop(.55, C.violet); g.addColorStop(1, C.pink);
  X.globalAlpha = a; X.fillStyle = g; X.fillText('AgentFactory', 0, 50); X.letterSpacing = '0px'; X.fillStyle = C.orange; X.beginPath(); X.arc(w / 2 + 22, 36, 16, 0, 7); X.fill(); X.textAlign = 'left'; X.restore();
  text(COPY.end, W / 2, H / 2 + 30, C.ink, CJK ? 46 : 44, '800', UI, 'center', a * sm(seg(t, 36.3, 36.7)));
  text(COPY.endCn, W / 2, H / 2 + 90, C.ink2, 32, '700', CJK ? F.ui : F.cjk, 'center', a * sm(seg(t, 36.5, 36.9)));
  const b = spring(t, 36.8, 2, .55); if (b > 0) { X.save(); X.translate(W / 2, H / 2 + 190); X.scale(b, b); X.shadowColor = C.blue; X.shadowBlur = 30; pill('$ npm run demo:harness', 0, 0, 'rgba(77,134,255,.14)', C.ink, a, 30, '700', F.mono, 30, 70, C.blue); X.restore(); }
  text('github.com/AJ999999999/AgentFactory', W / 2, H / 2 + 290, C.ink3, 26, '600', F.mono, 'center', a * sm(seg(t, 37.1, 37.5)));
}
// the clock and a progress line, so a viewer always knows where they are
function hud(t) {
  const a = sm(seg(t, 4, 4.5)) * (1 - sm(seg(t, 31.7, 32.1))); if (a <= 0) return;
  font('800', 22, F.ui); X.globalAlpha = a; rr(60, 52, 40, 40, 10); X.fillStyle = C.blue; X.fill(); X.fillStyle = '#fff'; X.textAlign = 'center'; font('900', 17, F.ui); X.fillText('AF', 80, 78); X.textAlign = 'left'; X.fillStyle = C.orange; X.beginPath(); X.arc(94, 58, 5, 0, 7); X.fill();
  text('AgentFactory', 114, 80, C.ink, 24, '800', F.ui, 'left', a);
  const mins = 8 * 60 + 15 + Math.floor(cl((t - 12) / 20) * 167); text(t < 12 ? '' : `ORION-1427 · ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, W - 60, 80, C.ink2, 22, '700', F.mono, 'right', a);
  X.globalAlpha = a; X.fillStyle = 'rgba(255,255,255,.08)'; X.fillRect(60, H - 50, W - 120, 3); const g = X.createLinearGradient(60, 0, W - 60, 0); g.addColorStop(0, C.blue); g.addColorStop(.6, C.violet); g.addColorStop(1, C.pink); X.fillStyle = g; X.fillRect(60, H - 50, (W - 120) * t / TOTAL, 3); X.globalAlpha = 1;
}

window.render = function (t) {
  X.setTransform(1, 0, 0, 1, 0, 0); X.globalAlpha = 1; X.letterSpacing = '0px'; X.shadowColor = 'transparent';
  backdrop(t); hook(t); punch(t); title(t); segTriage(t); segDiagnose(t); segCall(t); segTest(t); segShip(t); wall(t); endCard(t); hud(t); return 'LAUNCH';
};
