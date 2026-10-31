// Hidden checks for csv-quotes.
export default (h) => {
  const csv = async () => (await h.imp("src/csv.js")).parseCsv;
  return [
    ["plain rows", async () => h.eq((await csv())("a,b\n1,2\n3,4\n"), [{ a: "1", b: "2" }, { a: "3", b: "4" }])],
    ["a comma inside quotes", async () => h.eq((await csv())('a,b\n"x, y",z\n'), [{ a: "x, y", b: "z" }])],
    ["doubled quotes inside quotes", async () => h.eq((await csv())('a,b\n"He said ""hi""",2\n'), [{ a: 'He said "hi"', b: "2" }])],
    ["Windows line endings and empty fields", async () => h.eq((await csv())("a,b,c\r\n1,,3\r\n"), [{ a: "1", b: "", c: "3" }])],
    ["the transactions file reads row by row", async () => {
      const tx = (await h.imp("src/loader.js")).loadTransactions(`${h.repo}/data/transactions.csv`);
      h.eq(tx.length, 12, "rows");
      h.eq([tx[1].description, tx[1].category, tx[1].amountCents], ["Rent, January", "housing", -145000]);
      h.eq([tx[3].description, tx[3].amountCents], ['Books "Clean Code" and more', -6215]);
    }],
    ["the report has the right categories", async () => {
      const r = h.cli("report", "data/transactions.csv");
      h.eq(r.code, 0, "exit code");
      h.ok(r.out.includes("housing: -4350.00") && r.out.includes("education: -62.15") && r.out.includes("total: 1657.42"), r.out);
    }],
  ];
};
