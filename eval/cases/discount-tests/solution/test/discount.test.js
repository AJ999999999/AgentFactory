import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscounts } from "../src/discount.js";

const pct = (value) => ({ type: "percent", value });
const fixed = (cents) => ({ type: "fixed", cents });

test("only the largest percentage applies", () => {
  assert.equal(applyDiscounts(10000, [pct(10), pct(20)]), 8000);
});

test("the percentage comes off before fixed discounts", () => {
  assert.equal(applyDiscounts(10000, [fixed(1000), pct(10)]), 8000);
});

test("fixed discounts add up", () => {
  assert.equal(applyDiscounts(10000, [fixed(1000), fixed(500)]), 8500);
});

test("never below zero", () => {
  assert.equal(applyDiscounts(1000, [fixed(5000)]), 0);
});

test("the percentage rounds half to even", () => {
  assert.equal(applyDiscounts(25, [pct(10)]), 23);
});
