import { round } from "./money.js";

// Applies an invoice's discounts to its subtotal (cents), stacked as docs/discounts.md says.
export function applyDiscounts(subtotalCents, discounts = []) {
  const percents = discounts.filter((d) => d.type === "percent").map((d) => d.value);
  const fixed = discounts.filter((d) => d.type === "fixed").reduce((s, d) => s + d.cents, 0);
  const best = percents.length ? Math.max(...percents) : 0;
  const afterPercent = subtotalCents - round((subtotalCents * best) / 100);
  return Math.max(0, afterPercent - fixed);
}
