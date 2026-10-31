// Hidden checks for amount-parsing.
export default (h) => [
  ["transactions: thousands separators", async () => {
    const tx = (await h.imp("src/loader.js")).loadTransactions(`${h.repo}/data/transactions.csv`);
    h.eq([tx[1].amountCents, tx[2].amountCents], [-145000, 320000]);
  }],
  ["transactions: the whole report", async () => h.eq(h.cli("total", "data/transactions.csv").out.trim(), "1657.42")],
  ["budget: every amount", async () => {
    const b = (await h.imp("src/budget.js")).loadBudget(`${h.repo}/data/budget.txt`);
    h.eq(b, { groceries: 45000, housing: 145000, transport: 12800, gifts: 6050 });
  }],
  ["the transactions loader uses money's parse", async () => {
    const t = h.read("src/loader.js");
    h.ok(/from\s+["']\.\/money\.js["']/.test(t) && /\bparse\b/.test(t), "doesn't import parse from ./money.js");
    h.ok(!/parseFloat|Number\(/.test(t), "still parses amounts itself");
  }],
  ["the budget loader uses money's parse", async () => {
    const t = h.read("src/budget.js");
    h.ok(/from\s+["']\.\/money\.js["']/.test(t) && /\bparse\b/.test(t), "doesn't import parse from ./money.js");
    h.ok(!/parseFloat|Number\(/.test(t), "still parses amounts itself");
  }],
];
