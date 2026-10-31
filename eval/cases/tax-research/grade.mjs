// Hidden checks for tax-research.
export default (h) => {
  const rate = async () => (await h.imp("src/tax.js")).taxRate;
  return [
    ["the note names the rate, the date and the final table", async () => {
      h.ok(h.exists("notes/tax.md"), "notes/tax.md is missing");
      const t = h.read("notes/tax.md");
      h.ok(/\b14\s*%|\b14 per|rate[^\n]*\b14\b/i.test(t), "no 14%");
      h.ok(t.includes("2026-07-01"), "no start date 2026-07-01");
      h.ok(/tax-2026\.md/.test(t), "doesn't cite tax-2026.md");
    }],
    ["Ontario before July 2026 is 13% (the draft's April change didn't happen)", async () => {
      const r = await rate();
      h.eq(["2025-03-01", "2026-05-01", "2026-06-30"].map((d) => r("ON", d)), [13, 13, 13]);
    }],
    ["Ontario from 2026-07-01 is 14%", async () => {
      const r = await rate();
      h.eq(["2026-07-01", "2026-12-31"].map((d) => r("ON", d)), [14, 14]);
    }],
    ["invoices use the rate on their date", async () => {
      const { invoiceTotal } = await h.imp("src/invoice.js");
      const lines = [{ description: "x", qty: 1, unitCents: 10000 }];
      h.eq([invoiceTotal(lines, { province: "ON", date: "2026-06-15" }), invoiceTotal(lines, { province: "ON", date: "2026-07-15" })], [11300, 11400]);
    }],
    ["other provinces are unchanged", async () => {
      const r = await rate();
      h.eq([r("QC", "2026-08-01"), r("AB", "2026-08-01")], [14.975, 5]);
    }],
  ];
};
