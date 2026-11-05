"""Build the English cut from film.js (the Chinese cut): copy and layout only; the story, camera and timing stay identical.
  python make_en.py <film.js> <out.js>"""
import sys, re
s = open(sys.argv[1], encoding='utf-8').read()

# The order matters: a longer string goes before any string it contains.
pairs = [
  ("[7.0, 170, '反馈 #88', CYAN], [8.0, 340, '告警 5xx', YELLOW]", "[7.0, 250, '反馈 #88', CYAN], [8.0, 500, '告警 5xx', YELLOW]"),
  ("pill('每件事只记一次', 170, 104,", "pill('每件事只记一次', 250, 104,"),
  # the lower third
  ("'早上 8:15，一张 P1 进了 Jira。'", "'8:15 AM. A P1 lands in Jira.'"),
  ("'每件事只记一次，写进 git 里的记录。'", "'Every event is written once, to a log in git.'"),
  ("'处理流程接手：强模型先分诊。'", "'A playbook takes it. A strong model triages first.'"),
  ("'日志和代码一起查，诊断还要过强模型这一关。'", "'Logs and code, side by side. The diagnosis gets a second read.'"),
  ("'证据够硬才算数；回复报告人，等你点发送。'", "'Only hard evidence counts. The reply waits for your Send.'"),
  ("'先写失败的测试，再修；你批准了才合并。'", "'A failing test first, then the fix. Merged once you approve.'"),
  ("'这只是一千条线里的一条。'", "'This is one line out of a thousand.'"),
  ("'每张工单都在教它，它问你的越来越少。'", "'Every ticket teaches the playbook. It asks you less and less.'"),
  ("'一个人，经营一家 agent 公司。你只做决定。'", "'One person. A firm of agents. You make the calls.'"),
  # on the line
  ("'已回复报告人：已修复 · 工单关闭'", "'Reply sent: fixed · ticket resolved'"),
  ("'“确认是我们的 bug，正在修。”'", "'“Confirmed: a bug on our side. Fix coming.”'"),
  ("'✓ 是 bug · conductor 同意'", "'✓ A bug · the conductor agrees'"),
  ("'CONDUCTOR · 强模型在复读'", "'CONDUCTOR · a strong model reads it'"),
  ("'规则 +1 · 以后都这样'", "'Rule +1 · from now on'"),
  ("'处理流程：jira-bug'", "'Playbook: jira-bug'"),
  ("'其余 1,000 个项目：在跑'", "'1,000 other engagements: running'"),
  ("'每件事只记一次'", "'Written once, never edited'"),
  ("'主线 · GIT 记录'", "'MAIN · GIT LOG'"),
  ("'TRIAGE · 分诊'", "'TRIAGE'"), ("'DIAGNOSE · 诊断'", "'DIAGNOSE'"), ("'LOGS · 日志'", "'LOGS · a job'"), ("'CODE · 代码'", "'CODE'"),
  ("'一个 job：42 行'", "'42 lines saved'"), ("'retry.ts 第 88 行'", "'retry.ts, line 88'"),
  ("'强模型'", "'a strong model'"), ("'日志 + 代码'", "'logs + code'"),
  ("'只问你 · ASK'", "'ASK · ONLY YOU'"),
  ("'今天 · TODAY'", "'TODAY'"),
  ("'已合并 → main'", "'Merged → main'"),
  ("'08:15 进来'", "'opened 08:15'"),
  ("'1 个决定等你'", "'1 decision needs you'"),
  ("'回复报告人？'", "'Reply to the reporter?'"),
  ("'支付回调超时'", "'Checkout webhooks time out (EU)'"),
  ("'✓ 你已批准'", "'✓ You approved'"),
  ("'反馈 #88'", "'CS-2291 · refund late'"),
  ("'告警 5xx'", "'5xx · checkout-api'"),
  ("'证据等级'", "'EVIDENCE GRADE'"),
  ("'1  发送'", "'1  Send'"), ("'2  我来改'", "'2  Edit'"),
  ("'以后都这样'", "'From now on'"),
  ("'批准'", "'Approve'"), ("'再看看'", "'Review'"),
  ("'PR #41 · af/orion-1427'", "'PR #2318 · af/ORION-1427'"),
  ("[27.2, '测试先红'], [28.0, '修复变绿'], [28.8, '另一模型审查']", "[27.2, 'test fails first'], [28.0, 'fix: all green'], [28.8, 'review']"),
  ("'你'", "'YOU'"),
  ("'意见', 'opinion'", "'Opinion', 'an agent says'"), ("'汇报', 'reported'", "'Reported', 'someone saw it'"), ("'实测', 'measured'", "'Measured', 'a metric shows'"),
  # lower-third sections
  ("'接入', ORANGE, ", "'INTAKE', ORANGE, "), ("'记录', BLUE, ", "'LOG', BLUE, "), ("'分诊', VIOLET, ", "'TRIAGE', VIOLET, "), ("'诊断', BLUE, ", "'DIAGNOSE', BLUE, "),
  ("'决策', PINK, ", "'DECIDE', PINK, "), ("'交付', GREEN, ", "'SHIP', GREEN, "), ("'规模', CYAN, ", "'SCALE', CYAN, "), ("'学习', PINK, ", "'LEARN', PINK, "),
  # end tags
  ("[['接入', ORANGE], ['分诊', VIOLET], ['诊断', BLUE], ['证据', CYAN], ['交付', GREEN], ['规模', YELLOW]]", "[['Intake', ORANGE], ['Triage', VIOLET], ['Diagnose', BLUE], ['Evidence', CYAN], ['Ship', GREEN], ['Scale', YELLOW]]"),
  ("let tx = W / 2 - 330;", "let tx = W / 2 - 427;"), ("tx += 112; });", "tx += 150; });"),
  # layout: a wider section chip for English words, the ticket's time pill in the header band, smaller long lines
  ("rrect(x + slide, y, 190 + tw + 50, 84, 20)", "rrect(x + slide, y, 270 + tw + 50, 84, 20)"),
  ("rrect(x + slide, y, 170, 84, [20, 0, 0, 20])", "rrect(x + slide, y, 250, 84, [20, 0, 0, 20])"),
  ("X.fillText(s, x + slide + 196, y + 56)", "X.fillText(s, x + slide + 276, y + 56)"),
  ("X.translate(CARD0[0] + 200, CARD0[1] + 58)", "X.translate(CARD0[0] + 222, CARD0[1] - 91)"),
  ("font('900', 36, F.sans); X.fillText('Checkout", "font('900', 30, F.sans); X.fillText('Checkout"),
  ("label('1 decision needs you', -296, 20, NAVY, cl(ca), 54,", "label('1 decision needs you', -296, 20, NAVY, cl(ca), 48,"),
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
