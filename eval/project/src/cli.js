#!/usr/bin/env node
import { loadTransactions } from "./loader.js";
import { format } from "./money.js";
import { paginate } from "./paginate.js";
import { summarize } from "./report.js";

const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};

function main() {
  if (!cmd || !file) {
    console.error("usage: tally total|report|list <transactions.csv> [--page n --size n]");
    return 2;
  }
  const tx = loadTransactions(file);
  if (cmd === "total") {
    console.log(format(summarize(tx).total));
    return 0;
  }
  if (cmd === "report") {
    const s = summarize(tx);
    for (const [category, cents] of Object.entries(s.byCategory).sort(([a], [b]) => a.localeCompare(b))) console.log(`${category}: ${format(cents)}`);
    console.log(`total: ${format(s.total)}`);
    return 0;
  }
  if (cmd === "list") {
    const p = paginate(tx, Number(opt("page", 1)), Number(opt("size", 10)));
    for (const t of p.items) console.log(`${t.date} ${t.category} ${format(t.amountCents)} ${t.description}`);
    console.log(`page ${p.page} of ${p.pages}`);
    return 0;
  }
  console.error(`unknown command ${cmd}`);
  return 2;
}

process.exitCode = main();
