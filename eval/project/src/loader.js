import * as fs from "node:fs";
import { parseCsv } from "./csv.js";
import { parse } from "./money.js";

// Transactions from a CSV with the columns date,description,category,amount.
export function loadTransactions(file) {
  return parseCsv(fs.readFileSync(file, "utf8")).map((r) => ({
    date: r.date,
    description: r.description,
    category: r.category,
    amountCents: parse(r.amount),
  }));
}
