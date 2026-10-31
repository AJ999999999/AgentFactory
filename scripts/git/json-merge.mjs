#!/usr/bin/env node
// Git merge driver for JSON config: a three-way merge by key.
//
// Two branches that each add a key at the end of policy/harness.json touch the same
// lines (the last line and its comma), so git reports a conflict although the keys
// have nothing to do with each other. Merging by key lands both. Two changes to the
// same key that differ are still a conflict: then this hands the file to
// `git merge-file`, which writes the usual markers.
//
// Usage (set up by scripts/git/setup.mjs): node scripts/git/json-merge.mjs %O %A %B
// %A is ours and receives the result. Exit 0 = merged, 1 = conflict left in %A.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const [basePath, oursPath, theirsPath] = process.argv.slice(2);
const CONFLICT = Symbol("conflict");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Keys absent on one side are `undefined` there; deleting a key is a change too.
function merge3(base, ours, theirs) {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (!isObj(ours) || !isObj(theirs)) return CONFLICT;
  const b = isObj(base) ? base : {};
  const out = {};
  for (const k of keyOrder(ours, theirs)) {
    const v = merge3(b[k], ours[k], theirs[k]);
    if (v === CONFLICT) return CONFLICT;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Ours' order, with each key only theirs has placed after the key it follows there.
function keyOrder(ours, theirs) {
  const order = Object.keys(ours);
  let prev = -1;
  for (const k of Object.keys(theirs)) {
    const at = order.indexOf(k);
    if (at >= 0) prev = at;
    else order.splice(++prev, 0, k);
  }
  return order;
}

// The top level's members as written, so a key nobody changed keeps its layout.
function members(text) {
  const out = new Map();
  let depth = 0, inStr = false, start = -1, key = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      if (depth === 1 && key === null) {
        const end = text.indexOf('"', i + 1); // keys here have no escapes
        key = text.slice(i + 1, end);
        start = text.lastIndexOf("\n", i) + 1;
        i = end;
      } else inStr = true;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 1 && key !== null) out.set(key, text.slice(start, i).trimEnd());
      depth--;
    } else if (c === "," && depth === 1 && key !== null) {
      out.set(key, text.slice(start, i).trimEnd());
      key = null;
    }
  }
  return out;
}

// The repo's style for values written fresh: one line, a space after ':' and ','.
const inline = (v) =>
  Array.isArray(v) ? `[${v.map(inline).join(", ")}]`
  : isObj(v) ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")}}`
  : JSON.stringify(v);

function render(merged, sides) {
  const lines = Object.entries(merged).map(([k, v]) => {
    for (const { parsed, raw } of sides) if (same(parsed[k], v) && raw.has(k)) return raw.get(k);
    // A value laid out over several lines on our side stays over several lines.
    const multi = sides[0].raw.get(k)?.includes("\n");
    return `  ${JSON.stringify(k)}: ${multi ? JSON.stringify(v, null, 2).replace(/\n/g, "\n  ") : inline(v)}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

function fallback() {
  try {
    execFileSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], { stdio: "ignore" });
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

try {
  const read = (p) => fs.readFileSync(p, "utf8");
  const [baseText, oursText, theirsText] = [read(basePath), read(oursPath), read(theirsPath)];
  const base = baseText.trim() ? JSON.parse(baseText) : {};
  const ours = JSON.parse(oursText);
  const theirs = JSON.parse(theirsText);
  // Only plain top-level objects: anything else is left to git.
  if (!isObj(ours) || !isObj(theirs)) fallback();
  const merged = merge3(base, ours, theirs);
  if (merged === CONFLICT) fallback();
  const out = render(merged, [
    { parsed: ours, raw: members(oursText) },
    { parsed: theirs, raw: members(theirsText) },
  ]);
  JSON.parse(out); // never write something that doesn't parse
  fs.writeFileSync(oursPath, out);
  process.exit(0);
} catch {
  fallback();
}
