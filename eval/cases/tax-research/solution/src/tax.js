// Sales tax rates in percent, as the client charges them (docs/vendor/). An invoice's
// rate is the one in force on its date.
const RATES = { QC: 14.975, AB: 5 };

export function taxRate(province, date = "2026-01-01") {
  if (province === "ON") return date >= "2026-07-01" ? 14 : 13;
  const r = RATES[province];
  if (r === undefined) throw new Error(`no tax rate for ${province}`);
  return r;
}
