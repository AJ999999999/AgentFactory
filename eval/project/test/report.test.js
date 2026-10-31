import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/report.js";

test("totals by category, by month and overall", () => {
  const s = summarize([
    { date: "2026-01-02", category: "food", amountCents: -500 },
    { date: "2026-01-20", category: "pay", amountCents: 10000 },
    { date: "2026-02-01", category: "food", amountCents: -250 },
  ]);
  assert.deepEqual(s.byCategory, { food: -750, pay: 10000 });
  assert.deepEqual(s.byMonth, { "2026-01": 9500, "2026-02": -250 });
  assert.equal(s.total, 9250);
});
