import * as fs from "node:fs";

// A budget file: one "category: amount" per line; blank lines and # comments are skipped.
export function loadBudget(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf(":");
    out[t.slice(0, at).trim()] = Math.round(Number(t.slice(at + 1).trim()) * 100);
  }
  return out;
}
