// Hidden checks for paginate-issue.
const items = Array.from({ length: 12 }, (_, i) => i + 1);
const BUGGY = `export function paginate(items, page, size) {
  if (!(page >= 1) || !(size >= 1)) throw new Error("page and size start at 1");
  const start = page === 1 ? 0 : (page - 1) * size - 1;
  return { items: items.slice(start, start + size), page, pages: Math.max(1, Math.ceil(items.length / size)) };
}
`;

export default (h) => [
  ["page 1 is the first five", async () => h.eq((await h.imp("src/paginate.js")).paginate(items, 1, 5).items, [1, 2, 3, 4, 5])],
  ["page 2 starts after page 1", async () => h.eq((await h.imp("src/paginate.js")).paginate(items, 2, 5).items, [6, 7, 8, 9, 10])],
  ["the last page and the page count", async () => {
    const p = (await h.imp("src/paginate.js")).paginate(items, 3, 5);
    h.eq([p.items, p.pages], [[11, 12], 3]);
  }],
  ["the CLI's page 2 starts with February's groceries", async () => {
    const r = h.cli("list", "data/transactions.csv", "--page", "2", "--size", "5");
    h.eq(r.code, 0);
    h.ok(r.out.split(/\r?\n/)[0].startsWith("2026-02-02 groceries"), `first line was: ${r.out.split(/\r?\n/)[0]}`);
  }],
  ["a regression test passes on the fix and fails on the bug", async () => {
    const tests = h.testFiles((text) => text.includes("paginate"));
    h.ok(tests.length > 0, "no test mentions paginate");
    h.ok(h.nodeTest(h.repo, tests), "the regression test fails on the fixed code");
    h.ok(!h.withFile("src/paginate.js", BUGGY, (dir) => h.nodeTest(dir, tests)), "the regression test doesn't catch the bug");
  }],
];
