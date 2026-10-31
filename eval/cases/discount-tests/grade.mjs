// Hidden checks for discount-tests: the agent's tests against the real code and four
// versions that each break one rule of docs/discounts.md.
const HEAD = `import { round } from "./money.js";\nexport function applyDiscounts(subtotalCents, discounts = []) {\n  const percents = discounts.filter((d) => d.type === "percent").map((d) => d.value);\n  const fixed = discounts.filter((d) => d.type === "fixed").reduce((s, d) => s + d.cents, 0);\n`;
const MUTANTS = {
  "every percentage applies": `${HEAD}  const best = percents.reduce((a, b) => a + b, 0);\n  const afterPercent = subtotalCents - round((subtotalCents * best) / 100);\n  return Math.max(0, afterPercent - fixed);\n}\n`,
  "fixed comes off first": `${HEAD}  const best = percents.length ? Math.max(...percents) : 0;\n  const afterFixed = subtotalCents - fixed;\n  return Math.max(0, afterFixed - round((afterFixed * best) / 100));\n}\n`,
  "can go below zero": `${HEAD}  const best = percents.length ? Math.max(...percents) : 0;\n  const afterPercent = subtotalCents - round((subtotalCents * best) / 100);\n  return afterPercent - fixed;\n}\n`,
  "the smallest percentage applies": `${HEAD}  const best = percents.length ? Math.min(...percents) : 0;\n  const afterPercent = subtotalCents - round((subtotalCents * best) / 100);\n  return Math.max(0, afterPercent - fixed);\n}\n`,
};

export default (h) => {
  const tests = () => h.testFiles((text) => text.includes("discount"));
  const passOnReal = () => {
    const t = tests();
    return t.length > 0 && h.nodeTest(h.repo, t);
  };
  return [
    ["the tests pass on the real code", async () => {
      h.ok(tests().length > 0, "no test file mentions discount");
      h.ok(h.nodeTest(h.repo, tests()), "the tests fail on the real code");
    }],
    ...Object.entries(MUTANTS).map(([rule, code]) => [`catches: ${rule}`, async () => {
      h.ok(passOnReal(), "the tests don't pass on the real code, so they can't tell");
      h.ok(!h.withFile("src/discount.js", code, (dir) => h.nodeTest(dir, tests())), "no test fails");
    }]),
  ];
};
