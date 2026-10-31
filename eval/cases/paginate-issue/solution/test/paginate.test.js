import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.js";

test("issue 12: page 2 starts right after the last item of page 1", () => {
  const items = Array.from({ length: 12 }, (_, i) => i + 1);
  assert.deepEqual(paginate(items, 1, 5).items, [1, 2, 3, 4, 5]);
  assert.deepEqual(paginate(items, 2, 5).items, [6, 7, 8, 9, 10]);
  assert.deepEqual(paginate(items, 3, 5).items, [11, 12]);
});
