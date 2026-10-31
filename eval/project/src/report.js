// Totals in cents by category, by month (YYYY-MM) and overall.
export function summarize(transactions) {
  const byCategory = {};
  const byMonth = {};
  let total = 0;
  for (const t of transactions) {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + t.amountCents;
    const month = t.date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + t.amountCents;
    total += t.amountCents;
  }
  return { byCategory, byMonth, total };
}
