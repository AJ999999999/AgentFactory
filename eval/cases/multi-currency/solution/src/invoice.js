import { applyDiscounts } from "./discount.js";
import { percent } from "./money.js";
import { taxRate } from "./tax.js";

// lines: [{ description, qty, unitCents, currency? }] (currency is CAD unless it says otherwise)
export function subtotal(lines) {
  return lines.reduce((s, l) => s + l.qty * l.unitCents, 0);
}

export function invoiceTotal(lines, { province = "ON", date = "2026-01-01", discounts = [] } = {}) {
  const currencies = new Set(lines.map((l) => l.currency ?? "CAD"));
  if (currencies.size > 1) throw new Error(`an invoice can't mix currencies (${[...currencies].join(", ")})`);
  const net = applyDiscounts(subtotal(lines), discounts);
  return net + percent(net, taxRate(province, date));
}
