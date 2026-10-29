#!/usr/bin/env node
// sessionStart hook: refuses to let a coordinated session start on an expired or
// missing lease, and logs the start for audit. Output is not processed by the CLI,
// so a failed check is recorded and the preToolUse hook does the actual blocking.
import * as fs from "node:fs";
import * as path from "node:path";

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const cwd = input.cwd || process.cwd();
const sessionFile = path.join(cwd, ".agents", "session.json");
const logDir = path.join(cwd, ".agents", "logs");
fs.mkdirSync(logDir, { recursive: true });

let status = "uncoordinated";
if (fs.existsSync(sessionFile)) {
  const s = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  status = s.leaseExpiresAt && s.leaseExpiresAt < Date.now() ? "lease_expired" : "ok";
  if (status === "lease_expired") {
    // Make every write fail closed for the rest of this session.
    s.leasePaths = [];
    fs.writeFileSync(sessionFile, JSON.stringify(s, null, 2) + "\n");
  }
}
fs.appendFileSync(path.join(logDir, "sessions.log"), JSON.stringify({ event: "sessionStart", status, source: input.source ?? null, at: new Date().toISOString() }) + "\n");
