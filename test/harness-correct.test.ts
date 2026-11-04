// Fixing an answer from the command line, through an engagement's real git repo, down
// to the handoff packet the next agent gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EngagementDef } from "../src/harness/types.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "harness", "cli.ts");

const def: EngagementDef = {
  id: "fix-note",
  title: "A game for him",
  principals: { partner: "you", parent: "whoever watches him play" },
  goals: [{
    id: "g", title: "Game", objective: "A game he enjoys", owner: "partner", scope: ["game"], budget: { turns: 5 }, assumptions: [],
    todos: [
      { id: "profile", kind: "action", lane: "intake", assignee: "parent", text: "Tell the team about him" },
      { id: "core", lane: "build", after: ["profile"], writeScope: ["game"], text: "Build the core" },
    ],
  }],
};

test("an answer's note can be corrected from the command line, a placeholder note is refused, and the next agent gets the correction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-correct-"));
  fs.writeFileSync(path.join(dir, "engagement.json"), JSON.stringify(def));
  const env = { ...process.env, AF_PANEL_FOLDERS: path.join(dir, "panel-folders.json") };
  const run = (...a: string[]) => execFileSync(process.execPath, ["--no-warnings", CLI, ...a], { cwd: dir, encoding: "utf8", stdio: "pipe", env });
  const fails = (...a: string[]) => {
    try {
      run(...a);
    } catch (e) {
      return String((e as { stderr?: string }).stderr);
    }
    assert.fail(`expected ${a.join(" ")} to fail`);
  };
  try {
    run("open", "engagement.json");
    const ask = "ask-action-profile";
    assert.match(fails("answer", ask, "--choice", "done", "--note", "..."), /has no words in it/);
    run("answer", ask, "--choice", "done", "--note", "Loves trains.");
    assert.match(fails("answer", ask, "--choice", "done", "--note", "Loves boats."), /already answered; to fix what its note says, run correct ask-action-profile --note/);
    assert.match(run("correct", ask, "--note", "Loves boats. Plays with the arrow keys."), /corrected ask-action-profile/);
    assert.match(run("correct", ask, "--note", "Loves boats. Plays with the arrow keys."), /already says that/);
    const packet = run("status", "--packet");
    assert.match(packet, /Your todo core/, "the build is next");
    assert.match(packet, /From partner \(ask-action-profile\): Loves boats\. Plays with the arrow keys\./);
    assert.doesNotMatch(packet, /Loves trains/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
