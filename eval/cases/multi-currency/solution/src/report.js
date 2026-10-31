// Totals in cents by category, by month (YYYY-MM), per currency and overall. The overall
// total is null when currencies are mixed: CAD and USD don't add up.
export function summarize(transactions) {
  const byCategory = {};
  const byMonth = {};
  const totals = {};
  for (const t of transactions) {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + t.amountCents;
    const month = t.date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + t.amountCents;
    const c = t.currency ?? "CAD";
    totals[c] = (totals[c] ?? 0) + t.amountCents;
  }
  const currencies = Object.keys(totals);
  const total = currencies.length > 1 ? null : (totals[currencies[0]] ?? 0);
  return { byCategory, byMonth, total, totals };
}
