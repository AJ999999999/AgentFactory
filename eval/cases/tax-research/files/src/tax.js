// Sales tax rates in percent, as the client charges them (docs/vendor/).
const RATES = { ON: 13, QC: 14.975, AB: 5 };

export function taxRate(province, date = "2026-01-01") {
  const r = RATES[province];
  if (r === undefined) throw new Error(`no tax rate for ${province}`);
  return r;
}
