// Hidden checks for multi-currency. The two-currency file is the grader's own copy.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MC = `date,description,category,amount,currency
2026-04-01,Salary,income,"3,200.00",CAD
2026-04-03,Software,work,-19.99,USD
2026-04-05,"Rent, April",housing,"-1,450.00",CAD
2026-04-09,Hosting,work,-7.50,USD
2026-04-12,Groceries,groceries,-88.10,CAD
`;

export default (h) => {
  const mc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tally-mc-")), "mc.csv");
  fs.writeFileSync(mc, MC);
  const base = `${h.repo}/data/transactions.csv`;
  const load = async (f) => (await h.imp("src/loader.js")).loadTransactions(f);
  const sum = async () => (await h.imp("src/report.js")).summarize;
  return [
    ["(1) each row keeps its currency", async () => h.eq((await load(mc)).map((t) => t.currency), ["CAD", "USD", "CAD", "USD", "CAD"])],
    ["(1) CAD when there's no currency column", async () => h.ok((await load(base)).every((t) => t.currency === "CAD"), "not all CAD")],
    ["(2) totals per currency, and no total when mixed", async () => {
      const s = (await sum())(await load(mc));
      h.eq([s.totals, s.total], [{ CAD: 166190, USD: -2749 }, null]);
    }],
    ["(2) one currency: the total as before", async () => {
      const s = (await sum())(await load(base));
      h.eq([s.total, s.totals], [165742, { CAD: 165742 }]);
    }],
    ["(3) tally total: a line per currency", async () => {
      const r = h.cli("total", mc);
      h.eq([r.code, r.out.trim().split(/\r?\n/)], [0, ["CAD 1661.90", "USD -27.49"]]);
    }],
    ["(3) tally total: one currency prints as before", async () => h.eq(h.cli("total", "data/transactions.csv").out.trim(), "1657.42")],
    ["(4) an invoice can't mix currencies", async () => {
      const { invoiceTotal } = await h.imp("src/invoice.js");
      h.throws(() => invoiceTotal([{ qty: 1, unitCents: 1000 }, { qty: 1, unitCents: 500, currency: "USD" }]), /currenc/i);
    }],
    ["(4) one currency still totals", async () => {
      const { invoiceTotal } = await h.imp("src/invoice.js");
      h.eq([invoiceTotal([{ qty: 1, unitCents: 1000, currency: "USD" }]), invoiceTotal([{ qty: 2, unitCents: 1000 }])], [1130, 2260]);
    }],
    ["the report is unchanged", async () => h.ok(h.cli("report", "data/transactions.csv").out.includes("total: 1657.42"), "report changed")],
  ];
};
