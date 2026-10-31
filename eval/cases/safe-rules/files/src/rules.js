// Evaluates a discount rule from a client's config file, like "subtotal * 0.1" or
// "(subtotal - 500) / 2", with the given variables.
export function evaluate(expr, vars = {}) {
  return Function(...Object.keys(vars), `return (${expr});`)(...Object.values(vars));
}
