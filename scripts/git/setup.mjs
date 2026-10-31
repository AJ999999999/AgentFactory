#!/usr/bin/env node
// Points this clone at the repo's merge drivers. Git doesn't take driver commands
// from a committed file (that would run code on clone), so each clone sets them
// once with `npm run setup`.
import { execFileSync } from "node:child_process";

const set = (key, value) => execFileSync("git", ["config", "--local", key, value], { stdio: "ignore" });
set("merge.jsonkeys.name", "three-way merge of JSON by key");
set("merge.jsonkeys.driver", "node scripts/git/json-merge.mjs %O %A %B");
console.log("merge driver jsonkeys set for this clone");
