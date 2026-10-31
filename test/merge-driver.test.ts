// The JSON merge driver, through a real git merge in a scratch repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PROJECT_ROOT } from "../src/scenario.ts";

const DRIVER = path.join(PROJECT_ROOT, "scripts", "git", "json-merge.mjs");

function repo(initial: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-jsonmerge-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@x");
  git("config", "core.autocrlf", "false");
  git("config", "merge.jsonkeys.driver", `node "${DRIVER.replace(/\\/g, "/")}" %O %A %B`);
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.json merge=jsonkeys\n");
  fs.writeFileSync(path.join(dir, "p.json"), initial);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const branch = (name: string, text: string) => {
    git("checkout", "-q", "-b", name, "main");
    fs.writeFileSync(path.join(dir, "p.json"), text);
    git("commit", "-q", "-am", name);
  };
  const merge = (ours: string, theirs: string) => {
    git("checkout", "-q", ours);
    try {
      git("merge", "-q", "--no-edit", theirs);
      return { ok: true, text: fs.readFileSync(path.join(dir, "p.json"), "utf8") };
    } catch {
      return { ok: false, text: fs.readFileSync(path.join(dir, "p.json"), "utf8") };
    }
  };
  return { branch, merge };
}

// policy/harness.json as #10, #11 and #12 left it: each branch grew the end of the file.
const BASE = `{
  "version": 1,
  "evidence": {
    "safety": ["expert"]
  },
  "probation": {"promoteAfter": 3, "rejectStreak": 2},
  "team": {"library": "library.json", "catalog": "permission-catalog.json"}
}
`;

describe("JSON merge driver", () => {
  it("lands two branches that each add a different key at the end of the same file", () => {
    const r = repo(BASE);
    r.branch("capacity", BASE.replace(`  "team"`, `  "capacity": {"defaultBackoffMinutes": 30},\n  "team"`));
    r.branch("escalation", BASE.replace(`"permission-catalog.json"}\n`, `"permission-catalog.json"},\n  "escalation": {"missCostRatio": 10}\n`));
    const m = r.merge("capacity", "escalation");
    assert.ok(m.ok, m.text);
    assert.equal(m.text, `{
  "version": 1,
  "evidence": {
    "safety": ["expert"]
  },
  "probation": {"promoteAfter": 3, "rejectStreak": 2},
  "capacity": {"defaultBackoffMinutes": 30},
  "team": {"library": "library.json", "catalog": "permission-catalog.json"},
  "escalation": {"missCostRatio": 10}
}
`);
  });

  it("merges different keys inside the same object, and keeps a value one side changed", () => {
    const r = repo(BASE);
    r.branch("a", BASE.replace(`"rejectStreak": 2}`, `"rejectStreak": 2, "reviewers": 2}`));
    r.branch("b", BASE.replace(`"promoteAfter": 3`, `"promoteAfter": 5`).replace(`"version": 1`, `"version": 2`));
    const m = r.merge("a", "b");
    assert.ok(m.ok, m.text);
    assert.deepEqual(JSON.parse(m.text).probation, { promoteAfter: 5, rejectStreak: 2, reviewers: 2 });
    assert.equal(JSON.parse(m.text).version, 2);
  });

  it("still stops on two different values for the same key, with git's markers", () => {
    const r = repo(BASE);
    r.branch("a", BASE.replace(`"promoteAfter": 3`, `"promoteAfter": 4`));
    r.branch("b", BASE.replace(`"promoteAfter": 3`, `"promoteAfter": 5`));
    const m = r.merge("a", "b");
    assert.equal(m.ok, false);
    assert.match(m.text, /<<<<<<< ours/);
  });
});
