// Money is a whole number of cents. Amounts come in as text like "12.34", "-5",
// "1,234.50" or "$3.10" (docs/rules.md).
export function parse(text) {
  const s = String(text).trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`not an amount: ${text}`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function format(cents) {
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

// A fractional number of cents to whole cents, half to even (docs/rules.md).
export function round(x) {
  const f = Math.floor(x);
  if (Math.abs(x - f - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

export function percent(cents, rate) {
  return round((cents * rate) / 100);
}
