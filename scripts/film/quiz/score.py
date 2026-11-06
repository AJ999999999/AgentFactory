"""Score a viewer's answers to the film quiz.

  python scripts/film/quiz/score.py <answers.txt> [<baseline.txt>]

answers.txt holds the viewer's reply, one "Qn: X — ..." line per question (X is A-D or NULL). With a baseline (the
same quiz answered with no film), it also prints what the film itself taught: correct answers the baseline didn't
have. The idea is Code2Video's TeachQuiz (showlab/Code2Video): measure what a viewer who didn't know the subject
learned from watching, not whether the film looks good."""
import re, sys
KEY = 'BDCACDACCA'


def read(path):
    got = dict(re.findall(r'^Q(\d+):\s*(A|B|C|D|NULL)', open(path, encoding='utf-8').read(), re.M))
    return [got.get(str(i + 1), 'NULL') for i in range(len(KEY))]


ans = read(sys.argv[1]); right = [a == k for a, k in zip(ans, KEY)]
print(f'{sum(right)}/{len(KEY)} correct', ' '.join(f'Q{i + 1}:{"✓" if r else ("·" if a == "NULL" else "✗")}' for i, (a, r) in enumerate(zip(ans, right))))
if len(sys.argv) > 2:
    base = [b == k for b, k in zip(read(sys.argv[2]), KEY)]
    print(f'baseline {sum(base)}/{len(KEY)} · taught by the film {sum(r and not b for r, b in zip(right, base))}')
