"""Build the English cut from film.js (the Chinese cut): copy and layout only; the story, camera and timing stay identical.
  python make_en.py <film.js> <out.js>"""
import sys, re
s = open(sys.argv[1], encoding='utf-8').read()

# The order matters: a longer string goes before any string it contains.
pairs = [
  ("[7.0, 170, '反馈 #88', CYAN], [8.0, 340, '告警 5xx', YELLOW]", "[7.0, 250, '反馈 #88', CYAN], [8.0, 500, '告警 5xx', YELLOW]"),
  ("pill('每件事只记一次', 170, 104,", "pill('每件事只记一次', 250, 104,"),
  ("'早上 8:15，一张工单进来了。'", "'8:15 AM. A P1 lands in Jira.'"),
  ("'每件事只记一次，写进 git 里的记录。'", "'Every event is written once, to a log in git.'"),
  ("'规则决定先做什么、交给谁。'", "'Rules decide what goes first, and who takes it.'"),
  ("'干活的和审查的，不是同一个模型。'", "'The worker and the reviewer never share a model.'"),
  ("'证据够硬才算数；该你拍板的，只问你。'", "'Only hard evidence counts. Only real calls reach you.'"),
  ("'开 PR，过检查，你批准了才合并。'", "'Open a PR. Pass the checks. Merged once you approve.'"),
  ("'这只是一千条线里的一条。'", "'This is one line out of a thousand.'"),
  ("'每个回答都被记住，它问你的越来越少。'", "'Every answer is remembered. It asks you less and less.'"),
  ("'一个人，经营一家 agent 公司。你只做决定。'", "'One person. A firm of agents. You make the calls.'"),
  ("'规则 +1 · 以后都这样'", "'Rule +1 · from now on'"),
  ("'规则：Jira bug → FIX'", "'Rule: Payments bug → FIX'"),
  ("'其余 1,000 个项目：在跑'", "'1,000 other engagements: running'"),
  ("'每件事只记一次'", "'Written once, never edited'"),
  ("'主线 · GIT 记录'", "'MAIN · GIT LOG'"),
  ("'JUDGE · 审查'", "'JUDGE · REVIEW'"),
  ("'只问你 · ASK'", "'ASK · ONLY YOU'"),
  ("'今天 · TODAY'", "'TODAY'"),
  ("'工位 · worker'", "'station · worker'"),
  ("'已合并 → main'", "'Merged → main'"),
  ("'#1 风险最高'", "'#1 · highest risk'"),
  ("'08:15 进来'", "'opened 08:15'"),
  ("'1 个决定等你'", "'1 decision needs you'"),
  ("'重试改成 3 次？'", "'Raise retries 3 → 5?'"),
  ("'支付回调超时'", "'Checkout webhooks time out (EU)'"),
  ("'改 retry.ts'", "'patch webhook_retry.ts'"),
  ("'3/3 通过'", "'214/214 pass'"),
  ("'跑测试'", "'run 214 tests'"),
  ("'✓ 你已批准'", "'✓ You approved'"),
  ("'✓ 通过'", "'✓ Passed review'"),
  ("'另一个模型'", "'a different model'"),
  ("'反馈 #88'", "'CS-2291 · refund late'"),
  ("'告警 5xx'", "'5xx · checkout-api'"),
  ("'证据等级'", "'EVIDENCE GRADE'"),
  ("'1  改'", "'1  Yes'"), ("'2  先不'", "'2  Not now'"),
  ("'以后都这样'", "'From now on'"),
  ("'批准'", "'Approve'"), ("'再看看'", "'Review'"),
  ("'PR #41 · af/pay-712'", "'PR #2318 · af/PAY-4127'"),
  ("'PAY-712'", "'PAY-4127'"),
  ("[27.2, 'test'], [28.0, 'lint'], [28.8, 'review']", "[27.2, 'unit'], [28.0, 'e2e'], [28.8, 'review']"),
  ("'你'", "'YOU'"),
  ("'意见', 'opinion'", "'Opinion', 'an agent says'"), ("'汇报', 'reported'", "'Reported', 'someone saw it'"), ("'实测', 'measured'", "'Measured', 'a metric shows'"),
  # lower-third sections
  ("'接入', ORANGE, ", "'INTAKE', ORANGE, "), ("'记录', BLUE, ", "'LOG', BLUE, "), ("'分派', BLUE, ", "'ROUTE', BLUE, "), ("'审查', VIOLET, ", "'REVIEW', VIOLET, "),
  ("'决策', PINK, ", "'DECIDE', PINK, "), ("'交付', GREEN, ", "'SHIP', GREEN, "), ("'规模', CYAN, ", "'SCALE', CYAN, "), ("'学习', PINK, ", "'LEARN', PINK, "),
  # end tags
  ("[['接入', ORANGE], ['分派', BLUE], ['审查', VIOLET], ['证据', CYAN], ['交付', GREEN], ['规模', YELLOW]]", "[['Intake', ORANGE], ['Route', BLUE], ['Review', VIOLET], ['Evidence', CYAN], ['Ship', GREEN], ['Scale', YELLOW]]"),
  ("let tx = W / 2 - 330;", "let tx = W / 2 - 427;"), ("tx += 112; });", "tx += 150; });"),
  # a second lane named for customer feedback
  ("'FDB'", "'CX'"), ("FDB: VIOLET", "CX: VIOLET"),
  # layout: wider section chip for English words, the ticket's time pill in the header band, smaller long lines
  ("rrect(x + slide, y, 190 + tw + 50, 84, 20)", "rrect(x + slide, y, 250 + tw + 50, 84, 20)"),
  ("rrect(x + slide, y, 170, 84, [20, 0, 0, 20])", "rrect(x + slide, y, 230, 84, [20, 0, 0, 20])"),
  ("X.fillText(s, x + slide + 196, y + 56)", "X.fillText(s, x + slide + 256, y + 56)"),
  ("X.translate(CARD0[0] + 200, CARD0[1] + 58)", "X.translate(CARD0[0] + 222, CARD0[1] - 91)"),
  ("font('900', 36, F.sans); X.fillText('Checkout", "font('900', 30, F.sans); X.fillText('Checkout"),
  ("label('Raise retries 3 → 5?', -186, -22, NAVY, ia * fade, 34,", "label('Raise retries 3 → 5?', -186, -22, NAVY, ia * fade, 30,"),
  ("label('1 decision needs you', -296, 20, NAVY, cl(ca), 54,", "label('1 decision needs you', -296, 20, NAVY, cl(ca), 48,"),
  ("label('station · worker', x, cy + 34, MUTE, cl(a) * fade, 15,", "label('station · worker', x, cy + 34, MUTE, cl(a) * fade, 14,"),
  ("label(en, x, BASE + 62, MUTE, ca0, 14,", "label(en, x, BASE + 62, MUTE, ca0, 13,"),
]
for a, b in pairs:
    if a not in s: sys.exit('missing: ' + a)
    s = s.replace(a, b)
# English copy reads best in Inter; the CJK face stays as a fallback
s = s.replace('F.sans', 'F.inter').replace("inter: 'Inter',", "inter: 'Inter, \"AF Sans\"',")
left = [w for w in re.findall(r"'[^']*[一-龥][^']*'", s) if w != "'字Aa1'"]
if left: sys.exit('untranslated: ' + ', '.join(sorted(set(left))))
open(sys.argv[2], 'w', encoding='utf-8').write(s)
