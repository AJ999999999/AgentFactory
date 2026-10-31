// Evaluates a discount rule from a client's config file, like "subtotal * 0.1" or
// "(subtotal - 500) / 2", with the given variables. Rules are data from outside: only
// numbers, variable names, + - * / and parentheses are allowed, and anything else throws.
export function evaluate(expr, vars = {}) {
  const tokens = (String(expr).match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|\S/g) ?? []);
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  function primary() {
    const t = take();
    if (t === undefined) throw new Error("the rule ends too soon");
    if (t === "(") {
      const v = sum();
      if (take() !== ")") throw new Error("missing )");
      return v;
    }
    if (t === "-") return -primary();
    if (/^\d/.test(t)) return Number(t);
    if (/^[A-Za-z_]\w*$/.test(t)) {
      if (!Object.hasOwn(vars, t)) throw new Error(`unknown name in rule: ${t}`);
      return Number(vars[t]);
    }
    throw new Error(`not allowed in a rule: ${t}`);
  }
  function product() {
    let v = primary();
    while (peek() === "*" || peek() === "/") {
      const op = take();
      const r = primary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  if (i < tokens.length) throw new Error(`not allowed in a rule: ${tokens[i]}`);
  return v;
}
