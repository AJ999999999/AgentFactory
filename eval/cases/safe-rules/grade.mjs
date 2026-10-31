// Hidden checks for safe-rules.
const ATTACKS = ["process.exit(1)", "globalThis", "subtotal.constructor", 'require("fs")', "1; 2", "this", "[].map", "subtotal => 1", "`x`", "a = 1"];

export default (h) => {
  const ev = async () => (await h.imp("src/rules.js")).evaluate;
  return [
    ["a rule with a variable", async () => h.eq((await ev())("subtotal * 0.1", { subtotal: 2000 }), 200)],
    ["precedence, parentheses and unary minus", async () => {
      const e = await ev();
      h.eq([e("2 + 3 * 4"), e("(2 + 3) * 4"), e("-(5 - 8)"), e("10 / 4"), e("(subtotal - 500) / 2", { subtotal: 1500 })], [14, 20, 3, 2.5, 500]);
    }],
    ["an unknown name is refused", async () => {
      const e = await ev();
      h.throws(() => e("total * 2", { subtotal: 1 }));
    }],
    ...ATTACKS.map((a) => [`refuses: ${a}`, async () => {
      const e = await ev();
      h.throws(() => e(a, { subtotal: 1 }));
    }]),
    ["a rule can't reach the process", async () => {
      const e = await ev();
      try { e("(globalThis.__tallyPwned = 1)", {}); } catch { /* refused */ }
      h.ok(globalThis.__tallyPwned === undefined, "the rule ran code");
    }],
    ["no Function() or eval() left in rules.js", async () => h.ok(!/\bFunction\s*\(|\beval\s*\(/.test(h.read("src/rules.js")), "still there")],
  ];
};
