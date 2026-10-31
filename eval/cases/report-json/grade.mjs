// Hidden checks for report-json.
const EXPECTED = {
  byCategory: { groceries: "-102.23", housing: "-4350.00", income: "6400.00", education: "-62.15", transport: "-128.00", gifts: "-45.00", utilities: "-55.20" },
  byMonth: { "2026-01": "1541.45", "2026-02": "1621.17", "2026-03": "-1505.20" },
  total: "1657.42",
};
const TEXT = ["education: -62.15", "gifts: -45.00", "groceries: -102.23", "housing: -4350.00", "income: 6400.00", "transport: -128.00", "utilities: -55.20", "total: 1657.42"];
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export default (h) => {
  const json = () => {
    const r = h.cli("report", "data/transactions.csv", "--json");
    h.eq(r.code, 0, "exit code");
    return JSON.parse(r.out);
  };
  return [
    ["--json prints one JSON object", async () => h.ok(typeof json() === "object")],
    ["by category, formatted", async () => h.eq(sorted(json().byCategory ?? {}), sorted(EXPECTED.byCategory))],
    ["by month, formatted", async () => h.eq(sorted(json().byMonth ?? {}), sorted(EXPECTED.byMonth))],
    ["the total, formatted", async () => h.eq(json().total, EXPECTED.total)],
    ["the text report is unchanged", async () => {
      const r = h.cli("report", "data/transactions.csv");
      h.eq(r.out.trim().split(/\r?\n/), TEXT);
    }],
    ["the total command is unchanged", async () => h.eq(h.cli("total", "data/transactions.csv").out.trim(), "1657.42")],
  ];
};
