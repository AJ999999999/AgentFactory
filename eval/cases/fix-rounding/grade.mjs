// Hidden checks for fix-rounding. Each is [name, async () => throws if wrong].
export default (h) => [
  ["halves round to even (positive)", async () => {
    const { round } = await h.imp("src/money.js");
    h.eq([0.5, 1.5, 2.5, 3.5, 162.5].map(round), [0, 2, 2, 4, 162]);
  }],
  ["halves round to even (negative)", async () => {
    const { round } = await h.imp("src/money.js");
    h.eq([-0.5, -1.5, -2.5, -3.5].map(round), [0, -2, -2, -4]);
  }],
  ["other fractions round to nearest", async () => {
    const { round } = await h.imp("src/money.js");
    h.eq([2.4, 2.6, -2.4, -2.6, 7].map(round), [2, 3, -2, -3, 7]);
  }],
  ["tax on 12.50 at 13% is 1.62", async () => {
    const { percent } = await h.imp("src/money.js");
    h.eq(percent(1250, 13), 162);
  }],
  ["the invoice total is right to the cent", async () => {
    const { invoiceTotal } = await h.imp("src/invoice.js");
    h.eq(invoiceTotal([{ description: "x", qty: 1, unitCents: 1250 }], { province: "ON", date: "2026-01-01" }), 1412);
  }],
  ["the project's tests pass", async () => h.ok(h.nodeTest(h.repo, []), "node --test failed")],
];
