import { test } from "node:test";
import assert from "node:assert/strict";
import { format, parse } from "../src/money.js";

test("parses amounts written the usual ways", () => {
  assert.equal(parse("12.34"), 1234);
  assert.equal(parse("-5"), -500);
  assert.equal(parse("1,234.50"), 123450);
  assert.equal(parse("$3.10"), 310);
  assert.throws(() => parse("twelve"));
});

test("formats cents with two decimals", () => {
  assert.equal(format(1234), "12.34");
  assert.equal(format(-5), "-0.05");
  assert.equal(format(0), "0.00");
});
