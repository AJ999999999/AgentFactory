#!/usr/bin/env node
// sessionEnd hook: pins every artifact the session wrote to the basis versions the
// coordinator handed it, by writing <artifact>/context.lock.json. This is what lets the
// Observator find stale work later with a plain query.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const cwd = input.cwd || process.cwd();
const sessionFile = path.join(cwd, ".agents", "session.json");
if (!fs.existsSync(sessionFile)) process.exit(0);
const s = JSON.parse(fs.readFileSync(sessionFile, "utf8"));

let changed = [];
try {
  changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" })
    .split("\n").filter(Boolean).map((l) => l.slice(3));
} catch {}

for (const artifact of s.leasePaths ?? []) {
  const touched = changed.some((f) => f.startsWith(artifact.replace(/\/+$/, "") + "/") && !f.endsWith("context.lock.json"));
  if (!touched) continue;
  const lock = {
    artifact,
    task: s.task,
    builtBy: s.agent,
    config: s.config,
    basis: s.pins,
    inputs: s.inputs ?? [],
    builtAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(cwd, artifact), { recursive: true });
  fs.writeFileSync(path.join(cwd, artifact, "context.lock.json"), JSON.stringify(lock, null, 2) + "\n");
}

const logDir = path.join(cwd, ".agents", "logs");
fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(path.join(logDir, "sessions.log"), JSON.stringify({ event: "sessionEnd", task: s.task, agent: s.agent, reason: input.reason ?? null, at: new Date().toISOString() }) + "\n");
