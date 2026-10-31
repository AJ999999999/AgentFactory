// What every turn is told about the JSON it ends with: the validator drops what doesn't
// fit, so the prompt says up front what each part needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { turnPrompt } from "../src/harness/agents.ts";
import type { TurnContext } from "../src/harness/agents.ts";

const ctx = (principals?: Record<string, string>): TurnContext => ({
  turn: "research-1-x", agent: "r1", now: 0, packet: "Your todo research", wtDir: ".",
  todo: { id: "research", goal: "game", lane: "research", text: "t" },
  state: { engagement: principals ? { principals } : null },
} as never);

test("the prompt says who an action can go to, and that a job or a wait needs its runner or source", () => {
  // The first rhythm-runner turn proposed a "job" with no spec for a pilot only the
  // parent could run; the validator dropped it.
  const p = turnPrompt(ctx({ partner: "you", parent: "the parent" }));
  assert.match(p, /"action" is something a person does or observes, with "assignee" one of: partner, parent\./);
  assert.match(p, /"job" \(an external run, with "job": \{"spec": \{\.\.\.\}\}\)/);
  assert.match(p, /only when the packet names a job runner or metric source; otherwise propose an action/);
  assert.match(p, /a page you couldn't open is no source, and the packet is not a file/);
  assert.match(turnPrompt(ctx()), /"assignee" one of: the engagement's people\./, "no engagement in view: still a usable sentence");
});
